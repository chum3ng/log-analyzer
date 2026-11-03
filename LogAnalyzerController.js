(function () {
    'use strict';

    angular
        .module('logDurationApp')
        .controller('LogAnalyzerController', LogAnalyzerController)
        .directive('logFileInput', logFileInput);

    LogAnalyzerController.$inject = [
        '$timeout', '$filter', 'AppConfig', 'LogParserService', 'DateTimeService', 'DurationService', 'ExportService'
    ];

    var SAMPLE_MATCH = 'e1504e3edc8174dc346c74f76760c2d3cb4d5d453632d8a1fef84b5624a2aed7';

    var SAMPLE_LOG = [
        '2026-11-02 02:31:46.697|a1a5eb3|camel-1-148-rabbitmq://tps-trx|INFO|a7d98df9a906ad59|69f86071ace83ed3|CoreTransferListProcessor|57|Send transfer batch to core size: 10 trxHash: [e1504e3edc8174dc346c74f76760c2d3cb4d5d453632d8a1fef84b5624a2aed7, 63fe26f19ace34ff7a2bdba6f23f7130bf2ac0258c5027c6b8ff437c001e7b1d, 1f326573d1feb53252985adcd0645043cef8a66ae742879559e26dedd7770017, 0abbe22dea55a3c906579e5b664be421eb3b35198b1399e1b31ae411dba5cae8, e99c27d76c2ffc79d64015cae50a8498231823effcc89f992eb8e57b6dc12537, 2c404688eb716b46a7d0d9f9ae8d1ba486c50c83b18347ecc4ca3f2f7fd78c2b, 9f56e9e4745818abf8f306c481613cf39b74bde850cce2c5a16c84ab34491e8a, 000881015b99d56f4044de9db46dee53549dc65ed1bedb543245001e9e319bdc, 89b759f371a1d05fc3043885e56b542946831b626bc4aae7c263f5e624a83691, eea42040f7eb23cd4a20d013d89daebbc847505c740a7820002928490f96975f]',
        '2026-11-02 02:31:53.720|a1a5eb3|camel-1-146-rabbitmq://tps-trx|INFO|cd1b37530ac8e45a|8a01b528a8bba6bc|CoreTransferListProcessor|57|Send transfer batch to core size: 13 trxHash: [96fc669ad79b6ae4abd6006bd8e8068e1e8edd1c72c1b948bba7a3aeb5123853, ae75d3d3ce680757cbe04d94f516da29af3aa47caf87c6efbff41558e1dac6de, 6610465e511561ab06b8270ed97bb3e04f6c63ab4ac4de58d34d69ae99f277e6, d90bc312c1b152774cd88952b4dd4d82b50be4647cf774d5e0baafe44d3336ed, 4c536e40a154f9c4da18dc71007c17a9efbbc2370a0441673de260e36f3f0876, 721ed7757275eae74d2bb78925aa45155d96b784a90ec3c34ed225d7be182020, 735403081d8231d925dbcc6f13fff20201e53d88b552ffa1162418d226e1a36c, 9440741a29b5178cbea071f9cae59ba2edf8f2ce68f9fae29dfac7783d51e0a7, 5fbe0024b145cb05029c9010de8bfa38366555259ed22913b7c5814abbb5fa6e, 9cae4bb3ae310b66789afe8a15fa562d009fd7fa931fba95d599368650fe5948, 04bf4c492490f68e29b132920003f1e1929aee5f79ee4881ae9340e593dba72e, 262b006550a9462748a49a6f8c3b759675da892d38657c92ffa7f4adc3cad18a, 6cb9dcf94e67a41677920e668d60e64efd8c89d313db048a541ac97ff73d0510]',
        '2026-11-02 02:31:50.021|a1a5eb3|camel-1-36-rabbitmq://tee|INFO|8a88384b8bb3b011|3453da14afa1f060|CallbackServiceImpl|311|Received business transaction list. Size: 10 trxHashes: [89b759f371a1d05fc3043885e56b542946831b626bc4aae7c263f5e624a83691, eea42040f7eb23cd4a20d013d89daebbc847505c740a7820002928490f96975f, 000881015b99d56f4044de9db46dee53549dc65ed1bedb543245001e9e319bdc, 0abbe22dea55a3c906579e5b664be421eb3b35198b1399e1b31ae411dba5cae8, 1f326573d1feb53252985adcd0645043cef8a66ae742879559e26dedd7770017, 2c404688eb716b46a7d0d9f9ae8d1ba486c50c83b18347ecc4ca3f2f7fd78c2b, 63fe26f19ace34ff7a2bdba6f23f7130bf2ac0258c5027c6b8ff437c001e7b1d, 9f56e9e4745818abf8f306c481613cf39b74bde850cce2c5a16c84ab34491e8a, e1504e3edc8174dc346c74f76760c2d3cb4d5d453632d8a1fef84b5624a2aed7, e99c27d76c2ffc79d64015cae50a8498231823effcc89f992eb8e57b6dc12537]',
        '2026-11-02 02:31:57.500|a1a5eb3|camel-1-32-rabbitmq://tee|INFO|2fce53f5983bc85e|91b67e5b409e26f4|CallbackServiceImpl|311|Received business transaction list. Size: 3 trxHashes: [6610465e511561ab06b8270ed97bb3e04f6c63ab4ac4de58d34d69ae99f277e6, 96fc669ad79b6ae4abd6006bd8e8068e1e8edd1c72c1b948bba7a3aeb5123853, ae75d3d3ce680757cbe04d94f516da29af3aa47caf87c6efbff41558e1dac6de]'
    ].join('\n\n');

    function LogAnalyzerController($timeout, $filter, AppConfig, Parser, DateTime, Duration, Exporter) {
        var vm = this;
        var durationFmt = $filter('duration');
        var toastTimer = null;

        // ---------------------------------------------------------------- state
        vm.logText = '';
        vm.fileName = '';
        vm.fileSize = '';
        vm.fileError = '';
        vm.loadingFile = false;
        vm.lineCount = 0;

        vm.config = {
            startText: 'Send transfer batch to core size:',
            endText: 'Received business transaction list.',
            matchText: SAMPLE_MATCH,
            matchMode: 'contains',
            caseSensitive: true,
            pairing: 'firstFirst',
            allowEndReuse: false,
            dt: DateTime.defaultConfig()
        };

        vm.matchModes = [
            { id: 'contains', label: 'Contains' },
            { id: 'exact', label: 'Exact (whole token)' },
            { id: 'regex', label: 'Regular expression' }
        ];
        vm.pairingOptions = [
            { id: 'firstFirst', label: 'First start to first end', hint: 'Earliest start with earliest end for each Match Text.' },
            { id: 'firstLast', label: 'First start to last end', hint: 'Earliest start with latest end.' },
            { id: 'all', label: 'All matching entries', hint: 'Every start paired with every later end.' },
            { id: 'sequential', label: 'Sequential pairing', hint: 'Each start with the next unused end, in time order.' }
        ];
        vm.timezones = ['UTC', 'local', '+07:00', '+08:00', '+00:00', '-05:00'];
        vm.supportedFormats = DateTime.supportedFormats;
        vm.pageSize = AppConfig.PAGE_SIZE;

        vm.running = false;
        vm.progress = { processed: 0, total: 0, percent: 0 };
        vm.errors = [];
        vm.fieldErrors = {};
        vm.result = null;
        vm.summaryCards = [];
        vm.distMax = 0;
        vm.expanded = {};
        vm.toast = null;

        vm.filter = { text: '', status: '' };
        vm.sort = { key: 'no', reverse: false };
        vm.page = 1;
        vm.pageCount = 1;
        vm.filteredCount = 0;
        vm.pageRows = [];

        // -------------------------------------------------------------- actions
        vm.onFileChosen = onFileChosen;
        vm.onLogTextChange = updateLineCount;
        vm.loadSample = loadSample;
        vm.clearLog = clearLog;
        vm.analyze = analyze;
        vm.cancel = cancel;
        vm.sortBy = sortBy;
        vm.sortSlowest = function () { vm.sort = { key: 'durationMs', reverse: true }; vm.page = 1; refreshView(); };
        vm.refreshView = function () { vm.page = 1; refreshView(); };
        vm.goToPage = goToPage;
        vm.toggleRow = function (row) { vm.expanded[row.no] = !vm.expanded[row.no]; };
        vm.barWidth = barWidth;
        vm.preview = preview;
        vm.distHeight = function (bin) { return vm.distMax ? Math.max(4, Math.round(bin.count / vm.distMax * 100)) : 0; };
        vm.errorFor = function (field) { return vm.fieldErrors[field] || ''; };
        vm.exportCsv = exportCsv;
        vm.exportJson = exportJson;
        vm.copyRow = function (row) { copyText(Exporter.rowToText(row), 'Row copied'); };
        vm.copyAll = function () { copyText(Exporter.rowsToText(vm.result.rows), 'All results copied (tab-separated)'); };
        vm.fmt = durationFmt;

        loadSample();

        // ------------------------------------------------------------ log input
        function updateLineCount() {
            vm.lineCount = Parser.countLines(vm.logText);
        }

        function onFileChosen(file) {
            vm.fileError = '';
            vm.loadingFile = true;
            Parser.readFile(file).then(function (info) {
                vm.logText = info.text;
                vm.fileName = info.name;
                vm.fileSize = Parser.formatBytes(info.size);
                updateLineCount();
                resetResult();
            }, function (msg) {
                vm.fileError = String(msg);
            }).finally(function () { vm.loadingFile = false; });
        }

        function loadSample() {
            vm.logText = SAMPLE_LOG;
            vm.fileName = '';
            vm.fileSize = '';
            vm.fileError = '';
            vm.config.startText = 'Send transfer batch to core size:';
            vm.config.endText = 'Received business transaction list.';
            vm.config.matchText = SAMPLE_MATCH;
            updateLineCount();
            resetResult();
        }

        function clearLog() {
            Duration.cancel();
            vm.logText = '';
            vm.fileName = '';
            vm.fileSize = '';
            vm.fileError = '';
            vm.running = false;
            updateLineCount();
            resetResult();
        }

        function resetResult() {
            vm.result = null;
            vm.errors = [];
            vm.fieldErrors = {};
            vm.summaryCards = [];
            vm.expanded = {};
            vm.pageRows = [];
            vm.filteredCount = 0;
        }

        // -------------------------------------------------------------- analyze
        function buildConfig() {
            var c = angular.copy(vm.config);
            c.dt.group = Number(c.dt.group);
            return c;
        }

        function analyze() {
            if (vm.running) { return; }
            resetResult();
            vm.running = true;
            vm.progress = { processed: 0, total: vm.lineCount, percent: 0 };

            var lines = Parser.splitLines(vm.logText);
            Duration.analyze(lines, buildConfig(), function (p) { vm.progress = p; }).then(function (res) {
                vm.result = res;
                vm.sort = { key: 'no', reverse: false };
                vm.page = 1;
                buildSummary(res);
                refreshView();
            }, function (err) {
                if (err && err.cancelled) { return; }
                vm.errors = (err && err.errors) || [{ field: 'log', message: 'Analysis failed.' }];
                vm.errors.forEach(function (e) { vm.fieldErrors[e.field] = e.message; });
            }).finally(function () { vm.running = false; });
        }

        function cancel() {
            Duration.cancel();
            vm.running = false;
        }

        function buildSummary(res) {
            var t = res.totals, s = res.stats;
            function dur(ms) { return ms === null ? { main: '-', sub: '' } : { main: durationFmt(ms, 's'), sub: durationFmt(ms) }; }
            var cards = [
                { label: 'Start matches', main: t.startMatches },
                { label: 'End matches', main: t.endMatches },
                { label: 'Paired', main: t.paired, tone: t.paired ? 'ok' : '' },
                { label: 'Unmatched starts', main: t.unmatchedStarts, tone: t.unmatchedStarts ? 'warn' : '' },
                { label: 'Unmatched ends', main: t.unmatchedEnds, tone: t.unmatchedEnds ? 'warn' : '' }
            ];
            [['Average', s.average], ['Median', s.median], ['Minimum', s.min], ['Maximum', s.max],
             ['P90', s.p90], ['P95', s.p95], ['P99', s.p99]].forEach(function (x) {
                var d = dur(x[1]);
                cards.push({ label: x[0], main: d.main, sub: d.sub });
            });
            vm.summaryCards = cards;
            vm.distMax = res.distribution.reduce(function (m, b) { return b.count > m ? b.count : m; }, 0);
        }

        // ------------------------------------------------- results table (view)
        function sortBy(key) {
            if (vm.sort.key === key) { vm.sort.reverse = !vm.sort.reverse; }
            else { vm.sort = { key: key, reverse: false }; }
            vm.page = 1;
            refreshView();
        }

        function refreshView() {
            var rows = vm.result ? vm.result.rows : [];
            var q = String(vm.filter.text || '').trim().toLowerCase();
            var status = vm.filter.status;

            var out = rows.filter(function (r) {
                if (status && r.status !== status) { return false; }
                if (!q) { return true; }
                var hay = [r.key, r.startLine, r.endLine, r.startTs, r.endTs, r.status, r.error].join(' ').toLowerCase();
                return hay.indexOf(q) !== -1;
            });

            var key = vm.sort.key, dir = vm.sort.reverse ? -1 : 1;
            out.sort(function (a, b) {
                var x = a[key], y = b[key];
                var xn = x === null || x === undefined || x === '', yn = y === null || y === undefined || y === '';
                if (xn || yn) { return xn && yn ? 0 : (xn ? 1 : -1); }   // blanks always last
                if (typeof x === 'number' && typeof y === 'number') { return (x - y) * dir; }
                return String(x).localeCompare(String(y)) * dir;
            });

            vm.filteredCount = out.length;
            vm.pageCount = Math.max(1, Math.ceil(out.length / vm.pageSize));
            vm.page = Math.min(Math.max(1, vm.page), vm.pageCount);
            vm.pageRows = out.slice((vm.page - 1) * vm.pageSize, vm.page * vm.pageSize);
        }

        function goToPage(p) {
            vm.page = p;
            refreshView();
        }

        function barWidth(row) {
            var max = vm.result && vm.result.stats.max;
            if (row.status !== 'success' || !max) { return 0; }
            return Math.max(2, Math.round(row.durationMs / max * 100));
        }

        function preview(text) {
            var limit = AppConfig.SAMPLE_LINE_PREVIEW;
            return text && text.length > limit ? text.slice(0, limit) + ' ... (' + (text.length - limit) + ' more characters)' : text;
        }

        // --------------------------------------------------------------- export
        function exportCsv() {
            Exporter.download('log-durations-' + Exporter.timestampForFile() + '.csv', Exporter.toCsv(vm.result.rows), 'text/csv;charset=utf-8');
            showToast('CSV downloaded');
        }

        function exportJson() {
            Exporter.download('log-durations-' + Exporter.timestampForFile() + '.json', Exporter.toJson(vm.result, buildConfig()), 'application/json;charset=utf-8');
            showToast('JSON downloaded');
        }

        function copyText(text, okMessage) {
            Exporter.copy(text).then(function () { showToast(okMessage); }, function (msg) { showToast(String(msg), 'error'); });
        }

        function showToast(text, kind) {
            vm.toast = { text: text, kind: kind || 'ok' };
            if (toastTimer) { $timeout.cancel(toastTimer); }
            toastTimer = $timeout(function () { vm.toast = null; }, 2600);
        }
    }

    /** <input type="file" log-file-input="vm.onFileChosen(file)"> */
    function logFileInput() {
        return {
            restrict: 'A',
            scope: { onFile: '&logFileInput' },
            link: function (scope, element) {
                element.on('change', function (e) {
                    var file = e.target.files && e.target.files[0];
                    if (!file) { return; }
                    scope.$apply(function () { scope.onFile({ file: file }); });
                    e.target.value = ''; // allow re-selecting the same file
                });
                scope.$on('$destroy', function () { element.off('change'); });
            }
        };
    }
})();
