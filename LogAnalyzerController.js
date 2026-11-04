(function () {
    'use strict';

    angular
        .module('logDurationApp')
        .controller('LogAnalyzerController', LogAnalyzerController)
        .directive('logFileInput', logFileInput)
        .directive('fileDropZone', fileDropZone);

    LogAnalyzerController.$inject = [
        '$timeout', '$rootScope', '$document', 'AppConfig', 'FileUploadService', 'LogParserService',
        'TransactionExtractorService', 'StatisticsService', 'TransactionCorrelationService', 'ExportService'
    ];

    /**
     * The controller only coordinates: services parse, correlate, measure and export;
     * this file holds UI state (selection, filters, paging, tabs, the detail dialog).
     */
    function LogAnalyzerController($timeout, $rootScope, $document, AppConfig, Upload, Parser, Extractor, Stats, Correlation, Exporter) {
        var vm = this;
        var toastTimer = null;
        var LABELS = Extractor.LABELS;

        // ------------------------------------------------------------------ state
        vm.files = Upload.files;
        vm.uploadMessages = [];
        vm.analyzing = false;
        vm.stage = '';
        vm.progress = { percent: 0, fileName: '' };
        vm.errors = [];

        vm.result = null;
        vm.summaryCards = [];
        vm.tab = 'transactions';
        vm.statuses = Correlation.STATUSES;
        vm.statusChips = [];
        vm.flagOptions = [];
        vm.metrics = [];
        vm.distMetric = 'signingToCallback';
        vm.statusBars = [];

        vm.filter = { text: '', status: '', flag: '' };
        vm.sort = { key: 'no', reverse: false };
        vm.page = 1;
        vm.pageCount = 1;
        vm.pageSize = AppConfig.PAGE_SIZE;
        vm.filteredCount = 0;
        vm.pageRows = [];
        vm.filteredRows = [];

        vm.batchView = { rows: [], page: 1, pageCount: 1, total: 0, onlyIssues: false };
        vm.callbackView = { rows: [], page: 1, pageCount: 1, total: 0, onlyIssues: false };
        vm.openEvents = {};

        vm.detail = null;
        vm.toast = null;

        // ---------------------------------------------------------------- actions
        vm.addFiles = addFiles;
        vm.removeFile = function (id) { Upload.remove(id); };
        vm.clearAll = clearAll;
        vm.canAnalyze = function () { return !vm.analyzing && Upload.usableFiles().length > 0; };
        vm.analyze = analyze;
        vm.cancel = cancel;

        vm.setStatus = function (status) { vm.filter.status = status; vm.page = 1; refreshView(); };
        vm.refreshView = function () { vm.page = 1; refreshView(); };
        vm.sortBy = sortBy;
        vm.sortSlowest = function () { vm.sort = { key: 'signingToCallback', reverse: true }; vm.page = 1; refreshView(); };
        vm.goToPage = function (p) { vm.page = p; refreshView(); };
        vm.statusClass = function (s) { return 'st-' + String(s).toLowerCase().replace(/_/g, '-'); };
        vm.rowNo = function (i) { return (vm.page - 1) * vm.pageSize + i + 1; };

        vm.refreshAnalysis = refreshAnalysis;
        vm.goToBatchPage = function (p) { vm.batchView.page = p; refreshAnalysis(); };
        vm.goToCallbackPage = function (p) { vm.callbackView.page = p; refreshAnalysis(); };
        vm.toggleEvent = function (id) { vm.openEvents[id] = !vm.openEvents[id]; };
        vm.selectMetric = function (id) { vm.distMetric = id; buildDistribution(); };

        vm.openDetail = function (rec) { vm.detail = buildDetail(rec); };
        vm.closeDetail = function () { vm.detail = null; };
        vm.copyText = copyText;
        vm.copyAllLines = function (d) {
            var all = d.rec.all.signings.concat(d.rec.all.batches, d.rec.all.callbacks).map(function (e) { return e.raw; });
            copyText(all.join('\n'), 'Log lines copied');
        };

        vm.exportCsv = function () { save('transactions.csv', Exporter.transactionsCsv(vm.result.records), 'text/csv;charset=utf-8', 'CSV downloaded'); };
        vm.exportJson = function () {
            var files = Upload.files.map(function (f) { return { name: f.name, size: f.size, lines: f.lines, status: f.status }; });
            save('transactions.json', Exporter.transactionsJson(vm.result, vm.result.records, files), 'application/json;charset=utf-8', 'JSON downloaded');
        };
        vm.exportUnmatched = function () {
            var rows = vm.result.records.filter(function (r) { return r.status !== 'COMPLETE'; });
            save('unmatched-transactions.csv', Exporter.transactionsCsv(rows), 'text/csv;charset=utf-8', rows.length + ' unmatched transaction(s) downloaded');
        };
        vm.exportAnalysis = function () { save('send-receive-analysis.csv', Exporter.analysisCsv(vm.result.batches, vm.result.callbacks), 'text/csv;charset=utf-8', 'Analysis downloaded'); };
        vm.exportLogLines = function () {
            var rows = filteredOrAll();
            save('transaction-log-lines.txt', Exporter.logLinesText(rows), 'text/plain;charset=utf-8', 'Log lines for ' + rows.length + ' transaction(s) downloaded');
        };

        vm.preview = function (text) {
            var n = AppConfig.LINE_PREVIEW;
            return text && text.length > n ? text.slice(0, n) + ' ... (' + (text.length - n) + ' more characters)' : text;
        };
        vm.barHeight = function (bin, max) { return max ? Math.max(4, Math.round(bin.count / max * 100)) : 0; };

        // Escape closes the detail dialog.
        $document.on('keydown', function (e) {
            if (e.key === 'Escape' && vm.detail) { $rootScope.$evalAsync(function () { vm.detail = null; }); }
        });

        // ------------------------------------------------------------ file handling
        function addFiles(files) {
            var res = Upload.addFiles(files);
            vm.uploadMessages = res.rejected;
            vm.result = null;
            vm.errors = [];
        }

        function clearAll() {
            Parser.cancel();
            Upload.clear();
            vm.analyzing = false;
            vm.uploadMessages = [];
            vm.errors = [];
            vm.result = null;
            vm.detail = null;
        }

        // ----------------------------------------------------------------- analyze
        function analyze() {
            if (!vm.canAnalyze()) { return; }
            var entries = Upload.usableFiles();
            vm.analyzing = true;
            vm.result = null;
            vm.detail = null;
            vm.errors = [];
            vm.uploadMessages = [];
            vm.stage = 'Reading log files';
            vm.progress = { percent: 0, fileName: '' };

            Parser.parseFiles(entries, function (p) { vm.progress = p; }).then(function (parsed) {
                vm.stage = 'Correlating transactions by hash';
                return $timeout(function () { return parsed; }, 30);      // let the UI repaint before the heavy build
            }).then(function (parsed) {
                var result = parsed.run.build();
                result.totals.files = parsed.files;
                result.totals.lines = parsed.lines;
                result.stats = Stats.summarize(result.records);
                vm.result = result;
                vm.errors = Upload.files.filter(function (f) { return f.status === 'error'; })
                    .map(function (f) { return f.name + ': ' + f.error; });
                prepareDashboard(result);
                vm.tab = 'transactions';
                vm.filter = { text: '', status: '', flag: '' };
                vm.sort = { key: 'no', reverse: false };
                vm.page = 1;
                refreshView();
                refreshAnalysis();
            }, function (err) {
                if (err && err.cancelled) { return; }
                vm.errors = ['Analysis failed: ' + ((err && err.message) || 'unknown error')];
            }).finally(function () { vm.analyzing = false; vm.stage = ''; });
        }

        function cancel() {
            Parser.cancel();
            vm.analyzing = false;
        }

        function prepareDashboard(res) {
            var t = res.totals;
            vm.summaryCards = [
                { label: 'Uploaded files', main: t.files },
                { label: 'Log lines processed', main: t.lines },
                { label: 'Send events', main: t.batchEvents },
                { label: 'Signing events', main: t.signingEvents },
                { label: 'Receive events', main: t.callbackEvents },
                { label: 'Unique transaction hashes', main: t.uniqueHashes },
                { label: 'Fully matched', main: t.fullyMatched, tone: t.fullyMatched ? 'ok' : '' },
                { label: 'With missing events', main: t.withMissing, tone: t.withMissing ? 'warn' : '' },
                { label: 'Duplicate or ambiguous', main: t.duplicateOrAmbiguous, tone: t.duplicateOrAmbiguous ? 'warn' : '' }
            ];
            if (t.negative || t.invalidTime) {
                vm.summaryCards.push({ label: 'Timing issues', main: t.negative + t.invalidTime, tone: 'bad' });
            }

            vm.statusChips = [{ id: '', label: 'All', count: res.records.length }].concat(
                vm.statuses.map(function (s) { return { id: s, label: s, count: res.statusCounts[s] }; }));

            var flagCounts = {};
            res.records.forEach(function (r) { r.flags.forEach(function (f) { flagCounts[f] = (flagCounts[f] || 0) + 1; }); });
            vm.flagOptions = Object.keys(flagCounts).sort().map(function (f) { return { id: f, label: f + ' (' + flagCounts[f] + ')' }; });

            vm.metrics = res.stats.metrics;
            var max = res.records.length || 1;
            vm.statusBars = vm.statuses.map(function (s) { return { status: s, count: res.statusCounts[s], width: res.statusCounts[s] ? Math.max(0.5, res.statusCounts[s] / max * 100) : 0 }; });
            buildDistribution();
        }

        function buildDistribution() {
            var m = vm.metrics.filter(function (x) { return x.id === vm.distMetric; })[0];
            vm.distribution = m ? m.distribution : [];
            vm.distMax = vm.distribution.reduce(function (mx, b) { return b.count > mx ? b.count : mx; }, 0);
        }

        // ---------------------------------------------------------- transactions view
        function sortBy(key) {
            if (vm.sort.key === key) { vm.sort.reverse = !vm.sort.reverse; }
            else { vm.sort = { key: key, reverse: false }; }
            vm.page = 1;
            refreshView();
        }

        function refreshView() {
            if (!vm.result) { return; }
            var q = String(vm.filter.text || '').trim().toLowerCase();
            var status = vm.filter.status, flag = vm.filter.flag;

            var rows = vm.result.records.filter(function (r) {
                if (status && r.status !== status) { return false; }
                if (flag && r.flags.indexOf(flag) === -1) { return false; }
                if (!q) { return true; }
                return r.key.indexOf(q) !== -1 || r.src.toLowerCase().indexOf(q) !== -1 || r.dst.toLowerCase().indexOf(q) !== -1 ||
                       r.asset.toLowerCase().indexOf(q) !== -1 || r.amount.indexOf(q) !== -1 || r.desc.toLowerCase().indexOf(q) !== -1;
            });

            if (vm.sort.key !== 'no') {
                var key = vm.sort.key, dir = vm.sort.reverse ? -1 : 1;
                rows.sort(function (a, b) {
                    var x = a[key], y = b[key];
                    var xn = x === null || x === undefined || x === '', yn = y === null || y === undefined || y === '';
                    if (xn || yn) { return xn && yn ? 0 : (xn ? 1 : -1); }   // unavailable values always last
                    if (typeof x === 'number' && typeof y === 'number') { return (x - y) * dir; }
                    return String(x).localeCompare(String(y)) * dir;
                });
            } else if (vm.sort.reverse) {
                rows.reverse();
            }

            vm.filteredRows = rows;
            vm.filteredCount = rows.length;
            vm.pageCount = Math.max(1, Math.ceil(rows.length / vm.pageSize));
            vm.page = Math.min(Math.max(1, vm.page), vm.pageCount);
            vm.pageRows = rows.slice((vm.page - 1) * vm.pageSize, vm.page * vm.pageSize);
        }

        function filteredOrAll() {
            return vm.filter.text || vm.filter.status || vm.filter.flag ? vm.filteredRows : vm.result.records;
        }

        // ---------------------------------------------------- batch / callback view
        function refreshAnalysis() {
            if (!vm.result) { return; }
            page(vm.batchView, vm.result.batches, function (b) { return b.missingFromCallback.length || b.withoutSigning.length || b.warnings.length; });
            page(vm.callbackView, vm.result.callbacks, function (c) { return c.notInBatch.length || c.warnings.length; });
        }

        function page(view, all, isIssue) {
            var list = view.onlyIssues ? all.filter(isIssue) : all;
            var size = AppConfig.ANALYSIS_PAGE_SIZE;
            view.total = list.length;
            view.pageCount = Math.max(1, Math.ceil(list.length / size));
            view.page = Math.min(Math.max(1, view.page), view.pageCount);
            view.rows = list.slice((view.page - 1) * size, view.page * size);
        }

        // -------------------------------------------------------------- detail view
        function cmpTs(a, b) { return a === null ? (b === null ? 0 : 1) : (b === null ? -1 : a - b); }

        function buildDetail(rec) {
            var chosen = [{ type: 'SIGNING', ev: rec.signing }, { type: 'BATCH', ev: rec.batch }, { type: 'CALLBACK', ev: rec.callback }];
            var timeline = chosen.filter(function (x) { return x.ev; }).map(function (x) {
                return { type: x.type, label: LABELS[x.type], ev: x.ev };
            });
            timeline.sort(function (a, b) { return cmpTs(a.ev.ts, b.ev.ts) || Extractor.ORDER[a.type] - Extractor.ORDER[b.type]; });

            var prev = null;
            timeline.forEach(function (item) {
                item.delta = prev !== null && item.ev.ts !== null ? (item.ev.ts - prev) / 1000 : null;
                if (item.ev.ts !== null) { prev = item.ev.ts; }
            });

            var shown = {};
            timeline.forEach(function (item) { shown[item.ev.id] = true; });
            var others = [];
            [rec.all.signings, rec.all.batches, rec.all.callbacks].forEach(function (list) {
                list.forEach(function (ev) { if (!shown[ev.id]) { others.push({ label: LABELS[ev.type], ev: ev }); } });
            });

            return {
                rec: rec,
                timeline: timeline,
                missing: chosen.filter(function (x) { return !x.ev; }).map(function (x) { return LABELS[x.type]; }),
                others: others,
                durations: [
                    { label: 'Signing to Send', ms: rec.signingToBatch },
                    { label: 'Send to Receive', ms: rec.batchToCallback },
                    { label: 'Signing to Receive', ms: rec.signingToCallback }
                ]
            };
        }

        // --------------------------------------------------------------- utilities
        function save(name, parts, mime, message) {
            Exporter.download(Exporter.timestampForFile() + '-' + name, parts, mime);
            showToast(message);
        }

        function copyText(text, message) {
            Exporter.copy(text).then(function () { showToast(message || 'Copied'); }, function (msg) { showToast(String(msg), 'error'); });
        }

        function showToast(text, kind) {
            vm.toast = { text: text, kind: kind || 'ok' };
            if (toastTimer) { $timeout.cancel(toastTimer); }
            toastTimer = $timeout(function () { vm.toast = null; }, 2600);
        }
    }

    /** <input type="file" multiple log-file-input="vm.addFiles(files)"> */
    function logFileInput() {
        return {
            restrict: 'A',
            scope: { onFiles: '&logFileInput' },
            link: function (scope, element) {
                element.on('change', function (e) {
                    var files = Array.prototype.slice.call(e.target.files || []);   // copy before the input is reset
                    if (!files.length) { return; }
                    scope.$apply(function () { scope.onFiles({ files: files }); });
                    e.target.value = '';
                });
                scope.$on('$destroy', function () { element.off('change'); });
            }
        };
    }

    /** <div file-drop-zone="vm.addFiles(files)"> adds the class "dragging" while files hover over it. */
    function fileDropZone() {
        return {
            restrict: 'A',
            scope: { onFiles: '&fileDropZone' },
            link: function (scope, element) {
                var depth = 0;
                element.on('dragenter', function (e) { e.preventDefault(); depth++; element.addClass('dragging'); });
                element.on('dragover', function (e) {
                    e.preventDefault();
                    if (e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; }
                });
                element.on('dragleave', function () {
                    depth = Math.max(0, depth - 1);
                    if (!depth) { element.removeClass('dragging'); }
                });
                element.on('drop', function (e) {
                    e.preventDefault();
                    depth = 0;
                    element.removeClass('dragging');
                    var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
                    if (files.length) { scope.$apply(function () { scope.onFiles({ files: files }); }); }
                });
                scope.$on('$destroy', function () { element.off('dragenter dragover dragleave drop'); });
            }
        };
    }
})();
