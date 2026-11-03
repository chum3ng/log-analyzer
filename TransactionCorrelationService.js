(function () {
    'use strict';

    angular.module('logDurationApp').service('TransactionCorrelationService', TransactionCorrelationService);

    TransactionCorrelationService.$inject = ['DurationService'];

    /**
     * Correlates events by EXACT transaction hash only (compared case-insensitively;
     * the hash is displayed as first written in the log). Position in the file, amount,
     * description, thread and logger are never used.
     *
     * Usage:   var run = createRun();  run.addEvent(ev) ... ;  var result = run.build();
     *
     * Status per unique hash (first matching rule wins):
     *   DUPLICATE        the hash was signed more than once
     *   AMBIGUOUS        one signing but several batch or callback occurrences
     *   COMPLETE         exactly one of each of the three events
     *   PARTIAL          only one of the three events exists
     *   MISSING_SIGNING / MISSING_BATCH / MISSING_CALLBACK   two events exist, this one does not
     * `missing` always lists every absent event, whatever the status.
     *
     * Deterministic pairing when a hash has several occurrences (all are preserved
     * in `all`, nothing is overwritten):
     *   signing  = earliest signing
     *   batch    = earliest batch at or after the signing; if none, the closest one before it
     *   callback = earliest callback at or after the batch (else the signing); if none, the closest before
     * "Closest before" produces a negative duration, which is flagged, never hidden.
     */
    function TransactionCorrelationService(DurationService) {
        var self = this;
        var STATUSES = ['COMPLETE', 'MISSING_SIGNING', 'MISSING_BATCH', 'MISSING_CALLBACK', 'PARTIAL', 'DUPLICATE', 'AMBIGUOUS'];

        self.STATUSES = STATUSES;
        self.createRun = createRun;

        function createRun() {
            var byHash = new Map();                 // lower-case hash -> { key, hash, signings[], batches[], callbacks[] }
            var seen = Object.create(null);         // raw line -> 1, drops exact duplicate lines (same file twice, overlapping files)
            var batchEvents = [], callbackEvents = [];
            var counts = { BATCH: 0, SIGNING: 0, CALLBACK: 0 };
            var nextId = 1, skipped = 0, unusable = 0, badTs = 0, sizeMismatch = 0;
            var problems = [], problemCount = 0;

            return { addEvent: addEvent, noteProblem: noteProblem, build: build };

            function noteProblem(text) {
                problemCount++;
                if (problems.length < 20) { problems.push(text); }
            }

            /** Registers an event under each of its distinct hashes. Returns false for a duplicate line. */
            function addEvent(ev) {
                if (seen[ev.raw] === 1) { skipped++; return false; }
                seen[ev.raw] = 1;
                ev.id = nextId++;
                counts[ev.type]++;
                if (ev.ts === null) { badTs++; }
                if (ev.sizeMismatch) { sizeMismatch++; }

                ev.unique = [];
                ev.duplicateHashes = 0;
                var local = Object.create(null);
                for (var i = 0; i < ev.hashes.length; i++) {
                    var h = ev.hashes[i], k = h.toLowerCase();
                    if (local[k] === 1) { ev.duplicateHashes++; continue; }
                    local[k] = 1;
                    ev.unique.push(h);
                    var rec = byHash.get(k);
                    if (!rec) { rec = { key: k, hash: h, signings: [], batches: [], callbacks: [] }; byHash.set(k, rec); }
                    (ev.type === 'SIGNING' ? rec.signings : ev.type === 'BATCH' ? rec.batches : rec.callbacks).push(ev);
                }
                if (!ev.unique.length) { unusable++; }
                if (ev.type === 'BATCH') { batchEvents.push(ev); }
                else if (ev.type === 'CALLBACK') { callbackEvents.push(ev); }
                return true;
            }

            function build() {
                var records = [];
                var statusCounts = {};
                STATUSES.forEach(function (s) { statusCounts[s] = 0; });
                var t = { uniqueHashes: byHash.size, fullyMatched: 0, withMissing: 0, duplicateOrAmbiguous: 0, negative: 0, invalidTime: 0 };

                byHash.forEach(function (rec) {
                    var r = buildRecord(rec);
                    records.push(r);
                    statusCounts[r.status]++;
                    if (r.status === 'COMPLETE') { t.fullyMatched++; }
                    if (r.missing.length) { t.withMissing++; }
                    if (r.status === 'DUPLICATE' || r.status === 'AMBIGUOUS') { t.duplicateOrAmbiguous++; }
                    if (r.flags.indexOf('NEGATIVE_DURATION') !== -1) { t.negative++; }
                    if (r.flags.indexOf('INVALID_TIMESTAMP') !== -1) { t.invalidTime++; }
                });

                records.sort(function (a, b) { return cmpTs(a.firstTs, b.firstTs) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); });

                var batches = batchEvents.map(analyzeBatch).sort(byTime);
                var callbacks = callbackEvents.map(analyzeCallback).sort(byTime);

                var messages = [];
                if (skipped) { messages.push({ level: 'info', text: skipped + ' duplicate log line(s) skipped because an identical line was already processed (same file added twice or overlapping files).' }); }
                if (unusable) { messages.push({ level: 'warning', text: unusable + ' event(s) had no usable transaction hash and could not be correlated.' }); }
                if (badTs) { messages.push({ level: 'warning', text: badTs + ' event(s) have no readable timestamp; their durations are shown as unavailable.' }); }
                if (sizeMismatch) { messages.push({ level: 'warning', text: sizeMismatch + ' batch/callback line(s) declare a size that differs from the number of hashes extracted.' }); }
                if (t.negative) { messages.push({ level: 'error', text: t.negative + ' transaction(s) have a negative duration (events out of expected order). Review them; timestamps were not altered.' }); }
                if (t.duplicateOrAmbiguous) { messages.push({ level: 'warning', text: t.duplicateOrAmbiguous + ' transaction(s) have repeated occurrences and need review (status DUPLICATE or AMBIGUOUS).' }); }
                if (problemCount) { messages.push({ level: 'error', text: problemCount + ' line(s) could not be parsed. First: ' + problems[0] }); }

                return {
                    records: records, batches: batches, callbacks: callbacks, statusCounts: statusCounts, messages: messages,
                    totals: {
                        batchEvents: counts.BATCH, signingEvents: counts.SIGNING, callbackEvents: counts.CALLBACK,
                        uniqueHashes: t.uniqueHashes, fullyMatched: t.fullyMatched, withMissing: t.withMissing,
                        duplicateOrAmbiguous: t.duplicateOrAmbiguous, negative: t.negative, invalidTime: t.invalidTime,
                        duplicateLinesSkipped: skipped
                    }
                };
            }

            // ------------------------------------------------------------ one transaction

            function buildRecord(rec) {
                rec.signings.sort(cmpEvent); rec.batches.sort(cmpEvent); rec.callbacks.sort(cmpEvent);

                var S = rec.signings[0] || null;
                var B = pick(rec.batches, S ? S.ts : null);
                var C = pick(rec.callbacks, B && B.ts !== null ? B.ts : (S ? S.ts : null));
                var d = DurationService.chain(S, B, C);

                var missing = [];
                if (!S) { missing.push('SIGNING'); }
                if (!B) { missing.push('BATCH'); }
                if (!C) { missing.push('CALLBACK'); }

                var flags = [];
                if (d.negative) { flags.push('NEGATIVE_DURATION'); }
                if (d.invalid) { flags.push('INVALID_TIMESTAMP'); }
                if (rec.signings.length > 1) { flags.push('MULTIPLE_SIGNINGS'); }
                if (rec.batches.length > 1) { flags.push('MULTIPLE_BATCHES'); }
                if (rec.callbacks.length > 1) { flags.push('MULTIPLE_CALLBACKS'); }
                if (rec.signings.length > 1 && conflicting(rec.signings)) { flags.push('CONFLICTING_DETAILS'); }

                var status;
                if (rec.signings.length > 1) { status = 'DUPLICATE'; }
                else if (rec.batches.length > 1 || rec.callbacks.length > 1) { status = 'AMBIGUOUS'; }
                else if (!missing.length) { status = 'COMPLETE'; }
                else if (missing.length === 2) { status = 'PARTIAL'; }
                else { status = 'MISSING_' + missing[0]; }

                var tx = S ? S.tx : null;
                var times = [S, B, C].map(function (e) { return e && e.ts !== null ? e.ts : null; });
                var firstTs = times.reduce(function (m, v) { return v !== null && (m === null || v < m) ? v : m; }, null);

                return {
                    hash: tx && tx.hash ? tx.hash : rec.hash, key: rec.key,   // prefer the spelling used by the signing line
                    src: tx ? tx.src : '', dst: tx ? tx.dst : '', asset: tx ? tx.asset : '',
                    desc: tx ? tx.desc : '', amount: tx ? tx.amount : '', amountNum: tx ? tx.amountNum : null,
                    signingTime: S ? S.tsText : '', batchTime: B ? B.tsText : '', callbackTime: C ? C.tsText : '',
                    signingTs: times[0], batchTs: times[1], callbackTs: times[2], firstTs: firstTs,
                    signingToBatch: d.signingToBatch, batchToCallback: d.batchToCallback, signingToCallback: d.signingToCallback,
                    status: status, flags: flags, missing: missing,
                    counts: { signing: rec.signings.length, batch: rec.batches.length, callback: rec.callbacks.length },
                    signing: S, batch: B, callback: C,
                    all: { signings: rec.signings, batches: rec.batches, callbacks: rec.callbacks }
                };
            }

            /** Earliest event at/after refTs; else the closest one before it (=> negative duration, flagged). */
            function pick(list, refTs) {
                if (!list.length) { return null; }
                var timed = list.filter(function (e) { return e.ts !== null; });
                if (refTs === null || !timed.length) { return list[0]; }
                for (var i = 0; i < timed.length; i++) { if (timed[i].ts >= refTs) { return timed[i]; } }
                return timed[timed.length - 1];
            }

            function conflicting(signings) {
                var a = signings[0].tx;
                return signings.some(function (e) {
                    var b = e.tx;
                    return b.src !== a.src || b.dst !== a.dst || b.asset !== a.asset || b.amount !== a.amount || b.desc !== a.desc;
                });
            }

            // ------------------------------------------------- batch / callback analysis

            function analyzeBatch(ev) {
                var withSigning = 0, inCallback = 0, missingCallback = [], noSigning = [];
                ev.unique.forEach(function (h) {
                    var rec = byHash.get(h.toLowerCase());
                    if (rec.signings.length) { withSigning++; } else { noSigning.push(h); }
                    if (rec.callbacks.length) { inCallback++; } else { missingCallback.push(h); }
                });
                return {
                    eventId: ev.id, fileName: ev.fileName, lineNo: ev.lineNo, ts: ev.ts, tsText: ev.tsText,
                    declaredSize: ev.size, extracted: ev.hashes.length, unique: ev.unique.length, duplicatesInside: ev.duplicateHashes,
                    matchedSigning: withSigning, withoutSigning: noSigning,
                    inCallback: inCallback, missingFromCallback: missingCallback,
                    warnings: ev.warnings, event: ev
                };
            }

            function analyzeCallback(ev) {
                var inBatch = 0, notInBatch = [];
                ev.unique.forEach(function (h) {
                    var rec = byHash.get(h.toLowerCase());
                    if (rec.batches.length) { inBatch++; } else { notInBatch.push(h); }
                });
                return {
                    eventId: ev.id, fileName: ev.fileName, lineNo: ev.lineNo, ts: ev.ts, tsText: ev.tsText,
                    declaredSize: ev.size, extracted: ev.hashes.length, unique: ev.unique.length, duplicatesInside: ev.duplicateHashes,
                    matchedToBatch: inBatch, notInBatch: notInBatch,
                    warnings: ev.warnings, event: ev
                };
            }
        }

        // ------------------------------------------------------------------ ordering

        /** Ascending, events without a timestamp last. */
        function cmpTs(a, b) {
            if (a === null && b === null) { return 0; }
            if (a === null) { return 1; }
            if (b === null) { return -1; }
            return a - b;
        }
        function cmpEvent(a, b) { return cmpTs(a.ts, b.ts) || a.id - b.id; }
        function byTime(a, b) { return cmpTs(a.ts, b.ts) || a.eventId - b.eventId; }
    }
})();
