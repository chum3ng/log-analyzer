(function () {
    'use strict';

    angular.module('logDurationApp').service('DurationService', DurationService);

    DurationService.$inject = ['$q', '$timeout', '$rootScope', 'AppConfig', 'MatchingService', 'DateTimeService'];

    /**
     * analyze(lines, config, onProgress) -> promise
     *   resolves { rows, unmatched, messages, totals, stats, distribution, elapsedMs }
     *   rejects  { errors: [{field, message}] } for invalid configuration, or { cancelled: true }
     *
     * config = {
     *   startText, endText, matchText, matchMode, caseSensitive,
     *   dt: { ...DateTimeService config },
     *   pairing: 'firstFirst' | 'firstLast' | 'all' | 'sequential',
     *   allowEndReuse: boolean   (sequential only)
     * }
     *
     * Time is integer microseconds; durations are never rounded internally.
     * Lines are scanned once, in chunks, so the UI stays responsive.
     */
    function DurationService($q, $timeout, $rootScope, AppConfig, MatchingService, DateTimeService) {
        var self = this;
        var runId = 0;
        var MAX_ALL_ROWS_PER_KEY = 10000;

        self.analyze = analyze;
        self.cancel = function () { runId++; };
        self.computeStats = computeStats;

        function analyze(lines, cfg, onProgress) {
            var deferred = $q.defer();
            var token = ++runId;
            var errors = [];

            if (!lines || !lines.length) { errors.push({ field: 'log', message: 'Log content is empty.' }); }
            var compiled = MatchingService.compile(cfg);
            errors = errors.concat(compiled.errors);
            var extractor = DateTimeService.createExtractor(cfg.dt);
            if (extractor.error) { errors.push({ field: 'datetime', message: extractor.error }); }
            if (errors.length) {
                deferred.reject({ errors: errors });
                return deferred.promise;
            }

            var test = compiled.test, extract = extractor.extract;
            var starts = [], ends = [];
            var seenStart = Object.create(null), seenEnd = Object.create(null);
            var n = lines.length, i = 0, size = AppConfig.CHUNK_SIZE;
            var t0 = Date.now();

            step();
            return deferred.promise;

            function step() {
                if (token !== runId) { deferred.reject({ cancelled: true }); return; }
                var stop = Math.min(i + size, n);
                for (; i < stop; i++) {
                    var line = lines[i];
                    if (!line) { continue; }
                    var hit = test(line);
                    if (!hit) { continue; }
                    var ext = extract(line);
                    var base = { lineNo: i + 1, raw: line, key: hit.key, ext: ext, ts: ext.ok ? ext.chosen.epochMicros : null, used: false };
                    if (hit.isStart) { addEntry(starts, seenStart, angular.extend({}, base)); }
                    if (hit.isEnd) { addEntry(ends, seenEnd, angular.extend({}, base)); }
                }
                if (onProgress) {
                    var processed = i;
                    $rootScope.$evalAsync(function () { onProgress({ processed: processed, total: n, percent: Math.round(processed / n * 100) }); });
                }
                if (i < n) { $timeout(step, 0, false); }
                else { $rootScope.$evalAsync(function () { deferred.resolve(finish()); }); }
            }

            function addEntry(list, seen, entry) {
                if (seen[entry.raw] !== undefined) { entry.duplicateOf = seen[entry.raw]; }
                else { seen[entry.raw] = entry.lineNo; }
                list.push(entry);
            }

            function finish() {
                var rows = [], unmatched = [], messages = [], skippedCombos = 0;
                var groupS = groupByKey(starts), groupE = groupByKey(ends);
                var keys = Object.keys(groupS);
                Object.keys(groupE).forEach(function (k) { if (!groupS[k]) { keys.push(k); } });

                if (!starts.length) { messages.push({ level: 'error', text: 'Start entry not found: no line contains both Start Text and Match Text.' }); }
                if (!ends.length) { messages.push({ level: 'error', text: 'End entry not found: no line contains both End Text and Match Text.' }); }

                // Entries whose timestamp could not be read are reported, never dropped.
                starts.concat(ends).forEach(function (e) {
                    if (!e.ext.ok) { rows.push(errorRow(e, starts.indexOf(e) !== -1 ? 'start' : 'end')); }
                });

                keys.forEach(function (key) {
                    var S = (groupS[key] || { valid: [] }).valid.slice().sort(byTime);
                    var E = (groupE[key] || { valid: [] }).valid.slice().sort(byTime);

                    if (S.length && !E.length) { markUnmatched(S, 'start', 'Match Text found in a start entry but not in any end entry.'); return; }
                    if (E.length && !S.length) { markUnmatched(E, 'end', 'Match Text found in an end entry but not in any start entry.'); return; }
                    if (!S.length && !E.length) { return; }

                    var multi = S.length > 1 || E.length > 1;
                    if (cfg.pairing === 'firstFirst') {
                        rows.push(makeRow(key, S[0], E[0], multi ? ['Multiple start/end entries share this Match Text; earliest start paired with earliest end.'] : []));
                        S[0].used = E[0].used = true;
                    } else if (cfg.pairing === 'firstLast') {
                        rows.push(makeRow(key, S[0], E[E.length - 1], multi ? ['Multiple start/end entries share this Match Text; earliest start paired with latest end.'] : []));
                        S[0].used = E[E.length - 1].used = true;
                    } else if (cfg.pairing === 'all') {
                        var made = 0;
                        for (var a = 0; a < S.length; a++) {
                            for (var b = 0; b < E.length; b++) {
                                if (E[b].ts < S[a].ts) { skippedCombos++; continue; }
                                if (made >= MAX_ALL_ROWS_PER_KEY) { skippedCombos++; continue; }
                                rows.push(makeRow(key, S[a], E[b], []));
                                S[a].used = E[b].used = true;
                                made++;
                            }
                        }
                    } else {
                        sequential(key, S, E);
                    }

                    var reason = cfg.pairing === 'sequential'
                        ? 'No suitable counterpart in sequential pairing.'
                        : 'Not used by the selected pairing strategy.';
                    markUnmatched(S.filter(notUsed), 'start', reason);
                    markUnmatched(E.filter(notUsed), 'end', reason);
                });

                function sequential(key, S, E) {
                    var j = 0;
                    for (var s = 0; s < S.length; s++) {
                        while (j < E.length && E[j].ts < S[s].ts) { j++; }
                        if (j >= E.length) { break; }
                        rows.push(makeRow(key, S[s], E[j], []));
                        S[s].used = E[j].used = true;
                        if (!cfg.allowEndReuse) { j++; }
                    }
                }

                function markUnmatched(list, type, reason) {
                    list.forEach(function (e) {
                        unmatched.push({
                            type: type, lineNo: e.lineNo, key: e.key, raw: e.raw,
                            timestamp: e.ext.chosen.text, reason: reason, warnings: e.ext.warnings.slice()
                        });
                    });
                }

                rows.sort(function (x, y) {
                    return (x.startLine || x.endLine) - (y.startLine || y.endLine) || (x.endLine || 0) - (y.endLine || 0);
                });
                rows.forEach(function (r, idx) { r.no = idx + 1; });
                unmatched.sort(function (x, y) { return x.lineNo - y.lineNo; });

                var okRows = rows.filter(function (r) { return r.status === 'success'; });
                var negative = rows.filter(function (r) { return r.negative; }).length;
                var invalid = rows.filter(function (r) { return r.invalidEntry; }).length;
                var dupCount = starts.concat(ends).filter(function (e) { return e.duplicateOf !== undefined; }).length;
                var multiTs = starts.concat(ends).filter(function (e) { return e.ext.candidates.filter(function (c) { return c.valid; }).length > 1; }).length;
                var noTz = starts.concat(ends).filter(function (e) { return e.ext.ok && e.ext.chosen.assumedTz; }).length;

                if (invalid) { messages.push({ level: 'error', text: invalid + ' matching line(s) have an unreadable timestamp (see error rows).' }); }
                if (negative) { messages.push({ level: 'error', text: negative + ' pair(s) have a negative duration (end before start); excluded from statistics.' }); }
                if (dupCount) { messages.push({ level: 'warning', text: dupCount + ' duplicate matching log line(s) found (identical text appears more than once).' }); }
                if (multiTs) { messages.push({ level: 'warning', text: multiTs + ' matching line(s) contain more than one timestamp. Check "Occurrence" or use a custom regex.' }); }
                if (noTz) { messages.push({ level: 'warning', text: noTz + ' matching line(s) have no timezone; the default timezone was assumed.' }); }
                if (skippedCombos) { messages.push({ level: 'warning', text: skippedCombos + ' start/end combination(s) skipped (end before start, or per-key limit of ' + MAX_ALL_ROWS_PER_KEY + ' reached).' }); }

                var durations = okRows.map(function (r) { return r.durationMs; });
                var uStarts = unmatched.filter(function (u) { return u.type === 'start'; }).length;
                var uEnds = unmatched.length - uStarts;

                return {
                    rows: rows,
                    unmatched: unmatched,
                    messages: messages,
                    totals: {
                        lines: n, startMatches: starts.length, endMatches: ends.length, paired: okRows.length,
                        unmatchedStarts: uStarts, unmatchedEnds: uEnds, invalid: invalid, negative: negative
                    },
                    stats: computeStats(durations),
                    distribution: distribution(durations),
                    elapsedMs: Date.now() - t0
                };
            }

            function makeRow(key, s, e, extraWarnings) {
                var us = e.ts - s.ts;
                var warnings = extraWarnings.slice();
                // Both timestamps lacking a timezone does not affect the duration, so that case
                // stays a summary note only; a mixed pair gets a per-row warning.
                var bothNoTz = s.ext.chosen.assumedTz && e.ext.chosen.assumedTz;
                [s, e].forEach(function (x) {
                    x.ext.warnings.forEach(function (w) {
                        if (bothNoTz && w.indexOf('No timezone') === 0) { return; }
                        warnings.push('Line ' + x.lineNo + ': ' + w);
                    });
                    if (x.duplicateOf !== undefined) { warnings.push('Line ' + x.lineNo + ' duplicates line ' + x.duplicateOf + '.'); }
                });
                return {
                    key: key,
                    startLine: s.lineNo, endLine: e.lineNo,
                    startTs: s.ext.chosen.text, endTs: e.ext.chosen.text,
                    startIso: DateTimeService.formatIsoUtc(s.ts), endIso: DateTimeService.formatIsoUtc(e.ts),
                    durationUs: us, durationMs: us / 1000, durationSec: us / 1e6,
                    status: us < 0 ? 'error' : 'success',
                    negative: us < 0,
                    error: us < 0 ? 'Negative duration: end timestamp is earlier than start timestamp.' : null,
                    warnings: warnings,
                    startRaw: s.raw, endRaw: e.raw,
                    startDetail: detail(s), endDetail: detail(e)
                };
            }

            function errorRow(e, type) {
                var isStart = type === 'start';
                return {
                    key: e.key,
                    startLine: isStart ? e.lineNo : null, endLine: isStart ? null : e.lineNo,
                    startTs: '', endTs: '', startIso: '', endIso: '',
                    durationUs: null, durationMs: null, durationSec: null,
                    status: 'error', invalidEntry: true,
                    error: 'Line ' + e.lineNo + ' (' + type + '): ' + e.ext.error,
                    warnings: [],
                    startRaw: isStart ? e.raw : '', endRaw: isStart ? '' : e.raw,
                    startDetail: isStart ? detail(e) : null, endDetail: isStart ? null : detail(e)
                };
            }

            function detail(e) {
                var c = e.ext.chosen;
                return {
                    line: e.lineNo,
                    format: c ? c.label : null,
                    text: c ? c.text : null,
                    position: c ? c.index : null,
                    timezone: c ? (c.assumedTz ? 'assumed (' + (cfg.dt && cfg.dt.defaultTz || 'UTC') + ')' : 'from timestamp (' + formatOffset(c.offsetMin) + ')') : null,
                    candidates: e.ext.candidates.map(function (x) { return x.text; })
                };
            }
        }

        function formatOffset(min) {
            var sign = min < 0 ? '-' : '+', a = Math.abs(min);
            return sign + ('0' + Math.floor(a / 60)).slice(-2) + ':' + ('0' + (a % 60)).slice(-2);
        }

        function groupByKey(list) {
            var map = Object.create(null);
            list.forEach(function (e) {
                var g = map[e.key] || (map[e.key] = { valid: [] });
                if (e.ext.ok) { g.valid.push(e); }
            });
            return map;
        }

        function byTime(a, b) { return a.ts - b.ts || a.lineNo - b.lineNo; }
        function notUsed(e) { return !e.used; }

        // ------------------------------------------------------------ statistics

        function computeStats(values) {
            var n = values.length;
            if (!n) { return { count: 0, average: null, median: null, min: null, max: null, p90: null, p95: null, p99: null }; }
            var v = values.slice().sort(function (a, b) { return a - b; });
            var sum = 0;
            for (var i = 0; i < n; i++) { sum += v[i]; }
            return {
                count: n,
                average: sum / n,
                median: n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2,
                min: v[0],
                max: v[n - 1],
                p90: percentile(v, 90),
                p95: percentile(v, 95),
                p99: percentile(v, 99)
            };
        }

        /** Nearest-rank percentile on an ascending array. */
        function percentile(sorted, p) {
            var rank = Math.ceil(p / 100 * sorted.length);
            return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
        }

        function distribution(values) {
            var n = values.length;
            if (!n) { return []; }
            var min = values.reduce(function (a, b) { return a < b ? a : b; });
            var max = values.reduce(function (a, b) { return a > b ? a : b; });
            if (min === max) { return [{ from: min, to: max, count: n }]; }
            var bins = Math.min(10, n), width = (max - min) / bins, out = [], i;
            for (i = 0; i < bins; i++) { out.push({ from: min + i * width, to: min + (i + 1) * width, count: 0 }); }
            values.forEach(function (x) { out[Math.min(bins - 1, Math.floor((x - min) / width))].count++; });
            return out;
        }
    }
})();
