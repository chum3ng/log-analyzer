(function () {
    'use strict';

    angular.module('logDurationApp').service('ExportService', ExportService);

    ExportService.$inject = ['$q', '$window', '$document'];

    function ExportService($q, $window, $document) {
        var self = this;

        self.toCsv = toCsv;
        self.toJson = toJson;
        self.rowToText = rowToText;
        self.rowsToText = rowsToText;
        self.download = download;
        self.copy = copy;
        self.timestampForFile = timestampForFile;

        var CSV_HEADER = ['Match Text', 'Start Line', 'End Line', 'Start Datetime', 'End Datetime',
                          'Duration (ms)', 'Duration (seconds)', 'Status', 'Message'];

        function csvCell(v) {
            if (v === null || v === undefined) { return ''; }
            var s = String(v);
            return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }

        function rowMessage(r) {
            var msgs = [];
            if (r.error) { msgs.push(r.error); }
            return msgs.concat(r.warnings || []).join(' | ');
        }

        function toCsv(rows) {
            var lines = [CSV_HEADER.join(',')];
            rows.forEach(function (r) {
                lines.push([r.key, r.startLine, r.endLine, r.startTs, r.endTs,
                            r.durationMs, r.durationSec, r.status, rowMessage(r)].map(csvCell).join(','));
            });
            return '\uFEFF' + lines.join('\r\n'); // BOM so Excel reads UTF-8
        }

        /** Full detail: configuration, summary, every row with its original log lines, unmatched entries. */
        function toJson(result, config) {
            return JSON.stringify({
                generatedAt: new Date().toISOString(),
                configuration: config,
                summary: { totals: result.totals, statistics: result.stats },
                messages: result.messages,
                results: result.rows,
                unmatched: result.unmatched
            }, null, 2);
        }

        function rowToText(r) {
            return [
                'Match Text: ' + r.key,
                'Start: line ' + r.startLine + ' | ' + r.startTs,
                'End:   line ' + r.endLine + ' | ' + r.endTs,
                'Duration (ms): ' + r.durationMs,
                'Duration (s): ' + r.durationSec,
                'Status: ' + r.status + (r.error ? ' - ' + r.error : '')
            ].join('\n');
        }

        /** Tab-separated, pastes cleanly into Excel / Sheets. */
        function rowsToText(rows) {
            var out = [CSV_HEADER.join('\t')];
            rows.forEach(function (r) {
                out.push([r.key, r.startLine, r.endLine, r.startTs, r.endTs,
                          r.durationMs, r.durationSec, r.status, rowMessage(r)]
                    .map(function (v) { return v === null || v === undefined ? '' : String(v).replace(/[\t\r\n]+/g, ' '); })
                    .join('\t'));
            });
            return out.join('\n');
        }

        function download(filename, content, mime) {
            var blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
            var url = $window.URL.createObjectURL(blob);
            var a = $document[0].createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            $document[0].body.appendChild(a);
            a.click();
            $document[0].body.removeChild(a);
            $window.setTimeout(function () { $window.URL.revokeObjectURL(url); }, 1000);
        }

        /** Clipboard API when available, otherwise a hidden textarea + execCommand (works from file://). */
        function copy(text) {
            var nav = $window.navigator;
            if (nav.clipboard && nav.clipboard.writeText) {
                return $q.when(nav.clipboard.writeText(text)).catch(function () { return fallbackCopy(text); });
            }
            return fallbackCopy(text);
        }

        function fallbackCopy(text) {
            var doc = $document[0];
            var ta = doc.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            doc.body.appendChild(ta);
            ta.select();
            var ok = false;
            try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
            doc.body.removeChild(ta);
            return ok ? $q.when(true) : $q.reject('Copy failed. Select the text and copy it manually.');
        }

        function timestampForFile() {
            var d = new Date();
            function p(n) { return ('0' + n).slice(-2); }
            return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
        }
    }
})();
