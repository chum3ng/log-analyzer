(function () {
    'use strict';

    angular.module('logDurationApp').service('ExportService', ExportService);

    ExportService.$inject = ['$q', '$window', '$document', 'DurationService'];

    /**
     * Every builder returns an ARRAY OF STRING PARTS (not one giant string), so exports of
     * hundreds of thousands of transactions never need a single huge string; download()
     * hands the parts straight to a Blob.
     */
    function ExportService($q, $window, $document, DurationService) {
        var self = this;
        var sec = DurationService.seconds;

        self.transactionsCsv = transactionsCsv;
        self.transactionsJson = transactionsJson;
        self.logLinesText = logLinesText;
        self.analysisCsv = analysisCsv;
        self.recordText = recordText;
        self.download = download;
        self.copy = copy;
        self.timestampForFile = timestampForFile;

        var TX_HEADER = ['Transaction Hash', 'Source Account', 'Destination Account', 'Asset', 'Amount', 'Description',
            'Signing Time', 'Send Time', 'Receive Time', 'Signing to Send (s)', 'Send to Receive (s)', 'Signing to Receive (s)',
            'Status', 'Flags', 'Missing Events', 'Signing Line', 'Send Line', 'Receive Line'];

        function cell(v) {
            if (v === null || v === undefined) { return ''; }
            var s = String(v);
            return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        }
        function csvLine(values) { return values.map(cell).join(',') + '\r\n'; }
        function where(ev) { return ev ? ev.fileName + ':' + ev.lineNo : ''; }

        /** One transaction per row. */
        function transactionsCsv(records) {
            var parts = ['\uFEFF' + csvLine(TX_HEADER)];
            records.forEach(function (r) {
                parts.push(csvLine([r.hash, r.src, r.dst, r.asset, r.amount, r.desc, r.signingTime, r.batchTime, r.callbackTime,
                    sec(r.signingToBatch), sec(r.batchToCallback), sec(r.signingToCallback),
                    r.status, r.flags.join(' '), r.missing.join(' '), where(r.signing), where(r.batch), where(r.callback)]));
            });
            return parts;
        }

        /** Full detail including the original log lines of every occurrence. */
        function transactionsJson(result, records, files) {
            var parts = ['{\n"generatedAt": ' + JSON.stringify(new Date().toISOString()) +
                ',\n"files": ' + JSON.stringify(files) +
                ',\n"summary": ' + JSON.stringify({ totals: result.totals, statusCounts: result.statusCounts, statistics: result.stats }) +
                ',\n"transactions": [\n'];
            records.forEach(function (r, i) {
                parts.push((i ? ',\n' : '') + JSON.stringify({
                    hash: r.hash, source: r.src, destination: r.dst, asset: r.asset, amount: r.amount, description: r.desc,
                    status: r.status, flags: r.flags, missingEvents: r.missing, occurrences: r.counts,
                    durationsMs: { signingToSend: r.signingToBatch, sendToReceive: r.batchToCallback, signingToReceive: r.signingToCallback },
                    events: {
                        signing: eventJson(r.signing), send: eventJson(r.batch), receive: eventJson(r.callback),
                        allSignings: r.all.signings.map(eventJson), allSends: r.all.batches.map(eventJson), allReceives: r.all.callbacks.map(eventJson)
                    }
                }));
            });
            parts.push('\n]\n}\n');
            return parts;
        }

        function eventJson(ev) {
            return ev ? { file: ev.fileName, line: ev.lineNo, timestamp: ev.tsText, timestampError: ev.tsError, originalLine: ev.raw } : null;
        }

        /** Original matching log lines, grouped by transaction. */
        function logLinesText(records) {
            var parts = [];
            records.forEach(function (r) {
                parts.push('==== ' + r.hash + '  [' + r.status + (r.flags.length ? ' | ' + r.flags.join(' ') : '') + '] ====\n');
                [['SIGNING', r.all.signings], ['SEND', r.all.batches], ['RECEIVE', r.all.callbacks]].forEach(function (g) {
                    g[1].forEach(function (ev) { parts.push(g[0] + '  ' + where(ev) + '\n' + ev.raw + '\n'); });
                });
                if (r.missing.length) { parts.push('MISSING  ' + r.missing.join(', ') + '\n'); }
                parts.push('\n');
            });
            return parts;
        }

        /** Batch and callback analysis, one event per row, with the hashes that need attention. */
        function analysisCsv(batches, callbacks) {
            var parts = ['\uFEFF' + csvLine(['Event', 'File', 'Line', 'Timestamp', 'Declared Size', 'Hashes Extracted', 'Unique Hashes',
                'Matched With Signing', 'Found In Receive', 'Missing From Receive', 'Matched To Send', 'Not In Send', 'Hashes To Review'])];
            batches.forEach(function (b) {
                parts.push(csvLine(['Send', b.fileName, b.lineNo, b.tsText, b.declaredSize, b.extracted, b.unique,
                    b.matchedSigning, b.inCallback, b.missingFromCallback.length, '', '', b.missingFromCallback.join(' ')]));
            });
            callbacks.forEach(function (c) {
                parts.push(csvLine(['Receive', c.fileName, c.lineNo, c.tsText, c.declaredSize, c.extracted, c.unique,
                    '', '', '', c.matchedToBatch, c.notInBatch.length, c.notInBatch.join(' ')]));
            });
            return parts;
        }

        function recordText(r) {
            return [
                'Transaction: ' + r.hash, 'Status: ' + r.status,
                'Source: ' + r.src, 'Destination: ' + r.dst, 'Asset: ' + r.asset, 'Amount: ' + r.amount,
                'Signing: ' + r.signingTime, 'Send: ' + r.batchTime, 'Receive: ' + r.callbackTime,
                'Signing to Send (s): ' + sec(r.signingToBatch), 'Send to Receive (s): ' + sec(r.batchToCallback),
                'Signing to Receive (s): ' + sec(r.signingToCallback)
            ].join('\n');
        }

        function download(filename, parts, mime) {
            var blob = new Blob(angular.isArray(parts) ? parts : [parts], { type: mime || 'text/plain;charset=utf-8' });
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
