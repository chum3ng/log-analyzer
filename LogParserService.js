(function () {
    'use strict';

    angular.module('logDurationApp').service('LogParserService', LogParserService);

    LogParserService.$inject = ['$q', 'FileUploadService', 'TransactionExtractorService', 'TransactionCorrelationService'];

    /**
     * Streams every selected file, detects the three event types line by line and feeds
     * them into one correlation run. Lines that are not one of the three events are
     * discarded immediately, so memory only holds the events themselves.
     *
     * Files are processed one after another; all of them contribute to the same run,
     * so a transaction whose events are spread over several files still correlates.
     */
    function LogParserService($q, FileUploadService, Extractor, Correlation) {
        var self = this;
        var token = 0;

        self.parseFiles = parseFiles;
        self.cancel = function () { token++; };

        /**
         * parseFiles(entries, onProgress) -> promise of { run, lines, files }
         * onProgress({ fileName, percent })  percent is across all files, by bytes.
         * Rejects with { cancelled: true } when cancel() is called.
         */
        function parseFiles(entries, onProgress) {
            var mine = ++token;
            var run = Correlation.createRun();
            var totalBytes = entries.reduce(function (sum, e) { return sum + e.size; }, 0);
            var doneBytes = 0, totalLines = 0;

            entries.forEach(function (e) { e.status = 'queued'; e.progress = 0; e.lines = 0; e.events = 0; e.error = ''; });

            var chain = entries.reduce(function (p, entry) {
                return p.then(function () { return parseEntry(entry); });
            }, $q.when());

            return chain.then(function () { return { run: run, lines: totalLines, files: entries.length }; });

            function stopped() { return mine !== token; }

            function parseEntry(entry) {
                entry.status = 'reading';
                var ctx = { fileId: entry.id, fileName: entry.name, lineNo: 0 };

                function onLine(line, lineNo) {
                    var detected = Extractor.detectType(line);
                    if (!detected) { return; }
                    try {
                        ctx.lineNo = lineNo;
                        if (run.addEvent(Extractor.extract(line, detected, ctx))) { entry.events++; }
                    } catch (err) {
                        run.noteProblem(entry.name + ' line ' + lineNo + ': ' + err.message);
                    }
                }

                function onSlice(fraction, lines) {
                    entry.progress = Math.round(fraction * 100);
                    entry.lines = lines;
                    if (onProgress) {
                        onProgress({
                            fileName: entry.name,
                            percent: totalBytes ? Math.min(100, Math.round((doneBytes + fraction * entry.size) / totalBytes * 100)) : 100
                        });
                    }
                }

                return FileUploadService.streamLines(entry, onLine, onSlice, stopped).then(function (lines) {
                    entry.lines = lines;
                    entry.progress = 100;
                    entry.status = 'done';
                    totalLines += lines;
                    doneBytes += entry.size;
                }, function (err) {
                    if (err && err.cancelled) { return $q.reject(err); }
                    entry.status = 'error';
                    entry.error = (err && err.message) || 'Could not read this file.';
                    doneBytes += entry.size;   // keep going: other files are still analysed
                });
            }
        }
    }
})();
