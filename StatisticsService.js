(function () {
    'use strict';

    angular.module('logDurationApp').service('StatisticsService', StatisticsService);

    StatisticsService.$inject = [];

    function StatisticsService() {
        var self = this;

        var METRICS = [
            { id: 'signingToBatch', label: 'Signing to Batch' },
            { id: 'batchToCallback', label: 'Batch to Callback' },
            { id: 'signingToCallback', label: 'Signing to Callback' }
        ];

        self.METRICS = METRICS;
        self.summarize = summarize;
        self.computeStats = computeStats;
        self.distribution = distribution;
        self.isEligible = isEligible;

        /**
         * Only fully matched transactions take part: status COMPLETE, no negative durations,
         * no unreadable timestamps. Incomplete, duplicate and ambiguous ones are excluded.
         */
        function isEligible(r) {
            return r.status === 'COMPLETE' && r.flags.indexOf('NEGATIVE_DURATION') === -1 && r.flags.indexOf('INVALID_TIMESTAMP') === -1;
        }

        /** -> { eligible, metrics: [{ id, label, stats, distribution }] }  (durations in milliseconds) */
        function summarize(records) {
            var rows = records.filter(isEligible);
            return {
                eligible: rows.length,
                metrics: METRICS.map(function (m) {
                    var values = rows.map(function (r) { return r[m.id]; });
                    return { id: m.id, label: m.label, stats: computeStats(values), distribution: distribution(values) };
                })
            };
        }

        function computeStats(values) {
            var n = values.length;
            if (!n) { return { count: 0, average: null, median: null, min: null, max: null, p90: null, p95: null, p99: null }; }
            var v = values.slice().sort(function (a, b) { return a - b; });
            var sum = 0;
            for (var i = 0; i < n; i++) { sum += v[i]; }
            return {
                count: n, average: sum / n,
                median: n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2,
                min: v[0], max: v[n - 1],
                p90: percentile(v, 90), p95: percentile(v, 95), p99: percentile(v, 99)
            };
        }

        /** Nearest-rank percentile on an ascending array. */
        function percentile(sorted, p) {
            var rank = Math.ceil(p / 100 * sorted.length);
            return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
        }

        /** Up to 10 equal-width bins between the smallest and largest value. */
        function distribution(values) {
            var n = values.length;
            if (!n) { return []; }
            var min = values[0], max = values[0], i;
            for (i = 1; i < n; i++) { if (values[i] < min) { min = values[i]; } if (values[i] > max) { max = values[i]; } }
            if (min === max) { return [{ from: min, to: max, count: n }]; }
            var bins = Math.min(10, n), width = (max - min) / bins, out = [];
            for (i = 0; i < bins; i++) { out.push({ from: min + i * width, to: min + (i + 1) * width, count: 0 }); }
            values.forEach(function (x) { out[Math.min(bins - 1, Math.floor((x - min) / width))].count++; });
            return out;
        }
    }
})();
