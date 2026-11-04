(function () {
    'use strict';

    angular.module('logDurationApp').service('TransactionExtractorService', TransactionExtractorService);

    TransactionExtractorService.$inject = ['DateTimeService'];

    /**
     * Recognises the three transaction events in a raw log line and extracts their data.
     *
     *   BATCH     "Send transfer batch to core size: N trxHash: [h1, h2, ...]"
     *   SIGNING   "Successfully signed the wallet-transfer: src:.. dst:.. asset:.. desc:.. amount:.. trxHash:.."
     *   CALLBACK  "Received business transaction list. Size: N trxHashes: [h1, h2, ...]"
     *
     * Event shape:
     *   { type, fileId, fileName, lineNo, raw, ts (epoch microseconds | null), tsText, tsError,
     *     size (declared list size | null), hashes [as written in the log], tx (signing only), warnings [] }
     */
    function TransactionExtractorService(DateTimeService) {
        var self = this;

        var MARKERS = [
            { type: 'BATCH', text: 'Send transfer batch to core size:' },
            { type: 'SIGNING', text: 'Successfully signed the wallet-transfer:' },
            { type: 'CALLBACK', text: 'Received business transaction list.' }
        ];
        var HEX = /^[0-9a-fA-F]+$/;
        var LIST_KEY = /trxHash(?:es)?\s*:/i;
        var SIGN_KEYS = /(?:^|\s)(src|dst|asset|desc|amount|trxHash):/g;

        // Timestamps are found anywhere in the line by the shared datetime parser.
        // These logs carry no timezone, so every event gets the same assumption and
        // the differences between events are unaffected.
        var timeParser = DateTimeService.createExtractor({ mode: 'auto', defaultTz: 'UTC', occurrence: 'first' });

        self.LABELS = { SIGNING: 'Signing', BATCH: 'Send', CALLBACK: 'Receive' };   // display names; the log text each one matches is listed above
        self.ORDER = { SIGNING: 0, BATCH: 1, CALLBACK: 2 };
        self.detectType = detectType;
        self.extract = extract;

        /** Cheap substring test, run on every line. Returns { type, end } or null. */
        function detectType(line) {
            for (var i = 0; i < MARKERS.length; i++) {
                var idx = line.indexOf(MARKERS[i].text);
                if (idx !== -1) { return { type: MARKERS[i].type, end: idx + MARKERS[i].text.length }; }
            }
            return null;
        }

        function extract(line, detected, ctx) {
            var ev = {
                type: detected.type, fileId: ctx.fileId, fileName: ctx.fileName, lineNo: ctx.lineNo,
                raw: line, ts: null, tsText: '', tsError: null,
                size: null, hashes: [], tx: null, warnings: []
            };
            readTimestamp(line, ev);
            var rest = line.slice(detected.end);
            if (detected.type === 'SIGNING') { parseSigning(rest, ev); }
            else { parseHashList(rest, detected.type, ev); }
            return ev;
        }

        function readTimestamp(line, ev) {
            var r = timeParser.extract(line);
            if (r.ok) {
                ev.ts = r.chosen.epochMicros;
                ev.tsText = r.chosen.text;
                r.warnings.forEach(function (w) {
                    if (w.indexOf('No timezone') !== 0) { ev.warnings.push(w); }
                });
            } else {
                ev.tsError = r.error;
            }
        }

        /**
         * Batch and callback lines: "<size> trxHash: [a, b, c]".
         * Hashes are taken from the text between the first "[" and the next "]",
         * split on commas and trimmed. Anything that is not a hexadecimal token is reported,
         * not guessed at. If the closing bracket is missing the line was probably truncated,
         * so the last (possibly cut-off) token is discarded to avoid a bogus partial hash.
         */
        function parseHashList(rest, type, ev) {
            var sizeMatch = type === 'BATCH' ? /^\s*(\d+)/.exec(rest) : /Size:\s*(\d+)/i.exec(rest);
            ev.size = sizeMatch ? parseInt(sizeMatch[1], 10) : null;
            if (ev.size === null) { ev.warnings.push('Declared list size not found.'); }

            var key = LIST_KEY.exec(rest);
            var open = key ? rest.indexOf('[', key.index + key[0].length) : -1;
            if (open === -1) {
                ev.warnings.push('No hash array found in this line.');
                return;
            }
            var close = rest.indexOf(']', open + 1);
            var body = close === -1 ? rest.slice(open + 1) : rest.slice(open + 1, close);
            var tokens = body.split(',');

            if (close === -1) {
                tokens.pop();
                ev.warnings.push('Hash array is not closed (line truncated?). The last token was ignored.');
            }
            var ignored = [];
            tokens.forEach(function (t) {
                t = t.trim().replace(/^["']|["']$/g, '');
                if (!t) { return; }
                if (HEX.test(t)) { ev.hashes.push(t); }
                else { ignored.push(t); }
            });
            if (ignored.length) {
                ev.warnings.push('Ignored ' + ignored.length + ' non-hash token(s), e.g. "' + ignored[0].slice(0, 40) + '".');
            }
            if (ev.size !== null && ev.size !== ev.hashes.length) {
                ev.sizeMismatch = true;
                ev.warnings.push('Declared size ' + ev.size + ' but ' + ev.hashes.length + ' hash(es) extracted.');
            }
        }

        /**
         * Signing lines hold key:value pairs. Each value runs from after its key to the start
         * of the next key, so a description that contains spaces still parses correctly.
         */
        function parseSigning(rest, ev) {
            var marks = [], m;
            SIGN_KEYS.lastIndex = 0;
            while ((m = SIGN_KEYS.exec(rest)) !== null) {
                marks.push({ key: m[1], from: m.index + m[0].length, tokenStart: m.index });
            }
            var tx = { hash: '', src: '', dst: '', asset: '', desc: '', amount: '', amountNum: null };
            marks.forEach(function (mark, i) {
                var to = i + 1 < marks.length ? marks[i + 1].tokenStart : rest.length;
                var value = rest.slice(mark.from, to).trim();
                if (mark.key === 'trxHash') { value = value.split(/\s+/)[0] || ''; }
                tx[mark.key === 'trxHash' ? 'hash' : mark.key] = value;
            });
            if (tx.amount !== '') {
                var n = Number(tx.amount.replace(/,/g, ''));
                tx.amountNum = isNaN(n) ? null : n;
            }
            ev.tx = tx;

            if (!tx.hash) {
                ev.warnings.push('No transaction hash found in this signing line.');
            } else if (!HEX.test(tx.hash)) {
                ev.warnings.push('Transaction hash "' + tx.hash.slice(0, 40) + '" is not hexadecimal and was ignored.');
            } else {
                ev.hashes.push(tx.hash);
            }
        }
    }
})();
