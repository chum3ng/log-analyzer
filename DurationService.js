(function () {
    'use strict';

    angular.module('logDurationApp').service('DurationService', DurationService);

    DurationService.$inject = [];

    /**
     * Durations between the three pipeline events of one transaction.
     * Event timestamps are integer microseconds (see DateTimeService); results are in
     * MILLISECONDS (fractions allowed) and are never rounded or "fixed" when negative.
     */
    function DurationService() {
        var self = this;

        self.between = between;
        self.chain = chain;
        self.seconds = seconds;

        /** to - from in milliseconds, or null when either timestamp is missing. */
        function between(fromMicros, toMicros) {
            if (fromMicros === null || fromMicros === undefined || toMicros === null || toMicros === undefined) { return null; }
            return (toMicros - fromMicros) / 1000;
        }

        /**
         * chain(signing, batch, callback) -> {
         *   signingToBatch, batchToCallback, signingToCallback   (ms | null),
         *   negative  true if any duration is below zero (flagged for investigation, never altered),
         *   invalid   true if a selected event has no readable timestamp
         * }
         */
        function chain(signing, batch, callback) {
            var s = ts(signing), b = ts(batch), c = ts(callback);
            var out = {
                signingToBatch: between(s, b),
                batchToCallback: between(b, c),
                signingToCallback: between(s, c)
            };
            out.negative = [out.signingToBatch, out.batchToCallback, out.signingToCallback]
                .some(function (v) { return v !== null && v < 0; });
            out.invalid = !!((signing && s === null) || (batch && b === null) || (callback && c === null));
            return out;
        }

        function ts(ev) { return ev && ev.ts !== null && ev.ts !== undefined ? ev.ts : null; }

        /** Milliseconds to a seconds string with fixed decimals (default 3), '' when null. */
        function seconds(ms, decimals) {
            return ms === null || ms === undefined ? '' : (ms / 1000).toFixed(decimals === undefined ? 3 : decimals);
        }
    }
})();
