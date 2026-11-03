(function () {
    'use strict';

    angular.module('logDurationApp').service('FileUploadService', FileUploadService);

    FileUploadService.$inject = ['$q', '$rootScope', 'AppConfig'];

    /**
     * Owns the list of selected files and reads them as a stream of lines.
     *
     * A file is never loaded whole: it is read in byte slices (AppConfig.FILE_CHUNK_BYTES),
     * decoded with a streaming TextDecoder (so multi-byte characters split across slices
     * stay intact), and split into lines. Only a partial trailing line is carried over
     * between slices, so memory stays flat no matter how large the file is.
     */
    function FileUploadService($q, $rootScope, AppConfig) {
        var self = this;
        var nextId = 1;

        self.files = [];
        self.addFiles = addFiles;
        self.remove = remove;
        self.clear = clear;
        self.usableFiles = usableFiles;
        self.streamLines = streamLines;
        self.formatBytes = formatBytes;
        self.hasValidExtension = hasValidExtension;

        /** Adds File objects. Returns { added, rejected: [message] }. Nothing is dropped silently. */
        function addFiles(fileList) {
            var list = Array.prototype.slice.call(fileList || []);
            var added = 0, rejected = [];

            list.forEach(function (file) {
                if (!hasValidExtension(file.name)) {
                    rejected.push('"' + file.name + '" was not added. Supported file types: ' +
                        AppConfig.ACCEPTED_EXTENSIONS.join(', ') + '.');
                    return;
                }
                var fingerprint = file.name + '|' + file.size + '|' + file.lastModified;
                if (self.files.some(function (f) { return f.fingerprint === fingerprint; })) {
                    rejected.push('"' + file.name + '" is already in the list, so it was skipped.');
                    return;
                }
                var empty = file.size === 0;
                self.files.push({
                    id: nextId++, file: file, name: file.name, size: file.size,
                    sizeText: formatBytes(file.size), fingerprint: fingerprint,
                    status: empty ? 'empty' : 'queued', progress: 0, lines: 0, events: 0,
                    error: empty ? 'File is empty and will be ignored.' : ''
                });
                added++;
            });
            return { added: added, rejected: rejected };
        }

        function remove(id) {
            for (var i = 0; i < self.files.length; i++) {
                if (self.files[i].id === id) { self.files.splice(i, 1); return; }
            }
        }

        function clear() { self.files.length = 0; }

        function usableFiles() {
            return self.files.filter(function (f) { return f.status !== 'empty'; });
        }

        function hasValidExtension(name) {
            var n = String(name || '').toLowerCase();
            return AppConfig.ACCEPTED_EXTENSIONS.some(function (ext) {
                return n.length > ext.length && n.slice(-ext.length) === ext;
            });
        }

        function formatBytes(bytes) {
            if (!bytes) { return '0 B'; }
            var units = ['B', 'KB', 'MB', 'GB', 'TB'];
            var i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
            var v = bytes / Math.pow(1024, i);
            return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + units[i];
        }

        function readSlice(blob) {
            if (blob.arrayBuffer) { return blob.arrayBuffer(); }
            return new Promise(function (resolve, reject) {
                var reader = new FileReader();
                reader.onload = function () { resolve(reader.result); };
                reader.onerror = function () { reject(reader.error || new Error('Could not read the file.')); };
                reader.readAsArrayBuffer(blob);
            });
        }

        function stripCr(line) {
            return line.charCodeAt(line.length - 1) === 13 ? line.slice(0, -1) : line;
        }

        /**
         * Streams a file line by line.
         *   onLine(text, lineNumber)    called for every line (1-based numbering)
         *   onProgress(fraction, lines) called after each slice
         *   shouldStop()                return true to abort (promise rejects { cancelled: true })
         * Resolves with the total number of lines.
         */
        function streamLines(entry, onLine, onProgress, shouldStop) {
            var deferred = $q.defer();
            var file = entry.file, size = file.size, chunk = AppConfig.FILE_CHUNK_BYTES;
            var offset = 0, lineNo = 0, carry = '';
            var decoder = new TextDecoder('utf-8');

            function settle(fn) { $rootScope.$evalAsync(fn); }

            function next() {
                if (shouldStop()) {
                    settle(function () { deferred.reject({ cancelled: true }); });
                    return;
                }
                if (offset >= size) {
                    try {
                        carry += decoder.decode();               // flush the decoder
                        if (carry.length) { lineNo++; onLine(stripCr(carry), lineNo); }
                    } catch (err) {
                        settle(function () { deferred.reject(err); });
                        return;
                    }
                    settle(function () { deferred.resolve(lineNo); });
                    return;
                }
                var end = Math.min(offset + chunk, size);
                readSlice(file.slice(offset, end)).then(function (buffer) {
                    offset = end;
                    var text = carry + decoder.decode(buffer, { stream: true });
                    var start = 0, idx;
                    while ((idx = text.indexOf('\n', start)) !== -1) {
                        lineNo++;
                        onLine(stripCr(text.slice(start, idx)), lineNo);
                        start = idx + 1;
                    }
                    carry = text.slice(start);                   // incomplete last line waits for the next slice
                    if (onProgress) { onProgress(offset / size, lineNo); }
                    setTimeout(next, 0);                         // let the browser repaint between slices
                }).catch(function (err) {
                    settle(function () { deferred.reject(err || new Error('Could not read the file.')); });
                });
            }

            next();
            return deferred.promise;
        }
    }
})();
