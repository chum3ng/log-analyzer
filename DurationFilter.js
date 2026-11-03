(function () {
    'use strict';

    angular.module('logDurationApp')
        .filter('duration', DurationFilter)
        .filter('secs', SecsFilter);

    /** {{ ms | secs }} -> seconds with three decimals ("0.391"); "n/a" when the duration is unavailable. */
    function SecsFilter() {
        return function (ms) {
            return ms === null || ms === undefined || isNaN(ms) ? 'n/a' : (ms / 1000).toFixed(3);
        };
    }

    /**
     * Formats a duration given in MILLISECONDS (fractions allowed).
     *
     *   {{ ms | duration }}         3 seconds 324 milliseconds   (default, human readable)
     *   {{ ms | duration:'ms' }}    3324 ms
     *   {{ ms | duration:'s' }}     3.324 s
     *   {{ ms | duration:'ms-s' }}  0 min 3.324 s               (minutes and seconds)
     *   {{ ms | duration:'hms' }}   0 h 0 min 3.324 s
     *   {{ ms | duration:'dhms' }}  0 d 0 h 0 min 3.324 s
     *
     * Works on integer microseconds internally, so nothing is rounded early.
     */
    function DurationFilter() {
        var US_MS = 1000, US_S = 1e6, US_MIN = 6e7, US_H = 3.6e9, US_D = 8.64e10;

        return function (ms, mode) {
            if (ms === null || ms === undefined || ms === '' || isNaN(ms)) { return ''; }
            var neg = ms < 0;
            var us = Math.round(Math.abs(ms) * 1000);
            var out;

            switch (mode) {
                case 'ms':
                    out = trim(us / US_MS, 3) + ' ms';
                    break;
                case 's':
                    out = trim(us / US_S, 6) + ' s';
                    break;
                case 'ms-s':
                    out = Math.floor(us / US_MIN) + ' min ' + trim((us % US_MIN) / US_S, 6) + ' s';
                    break;
                case 'hms':
                    out = Math.floor(us / US_H) + ' h ' + Math.floor((us % US_H) / US_MIN) + ' min ' +
                          trim((us % US_MIN) / US_S, 6) + ' s';
                    break;
                case 'dhms':
                    out = Math.floor(us / US_D) + ' d ' + Math.floor((us % US_D) / US_H) + ' h ' +
                          Math.floor((us % US_H) / US_MIN) + ' min ' + trim((us % US_MIN) / US_S, 6) + ' s';
                    break;
                default:
                    out = human(us);
            }
            return (neg ? '-' : '') + out;
        };

        function human(us) {
            var parts = [];
            var d = Math.floor(us / US_D); us -= d * US_D;
            var h = Math.floor(us / US_H); us -= h * US_H;
            var m = Math.floor(us / US_MIN); us -= m * US_MIN;
            var s = Math.floor(us / US_S); us -= s * US_S;
            var msVal = us / US_MS; // may carry a microsecond fraction

            if (d) { parts.push(unit(d, 'day')); }
            if (h) { parts.push(unit(h, 'hour')); }
            if (m) { parts.push(unit(m, 'minute')); }
            if (s) { parts.push(unit(s, 'second')); }
            if (msVal || !parts.length) { parts.push(trim(msVal, 3) + (msVal === 1 ? ' millisecond' : ' milliseconds')); }
            return parts.join(' ');
        }

        function unit(n, name) { return n + ' ' + name + (n === 1 ? '' : 's'); }

        function trim(n, decimals) { return parseFloat(n.toFixed(decimals)).toString(); }
    }
})();
