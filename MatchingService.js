(function () {
    'use strict';

    angular.module('logDurationApp').service('MatchingService', MatchingService);

    MatchingService.$inject = [];

    /**
     * compile(config) validates the three mandatory inputs and returns
     *   { errors: [{field, message}], test: function(line) }
     * test(line) returns null when the line is neither a start nor an end line,
     * otherwise { isStart, isEnd, key }.
     *
     * A line is a start line only if it contains Start Text AND Match Text;
     * an end line only if it contains End Text AND the same Match Text.
     * `key` is the identifier used for pairing (never pair different keys).
     *
     * Modes:
     *   contains - plain substring search (default)
     *   exact    - whole-token search: the text must not be glued to other
     *              letters, digits or underscores (so a hash prefix never matches)
     *   regex    - the three inputs are regular expressions; for Match Text the
     *              first matched string on the line becomes the key
     */
    function MatchingService() {
        var self = this;

        self.compile = compile;

        function compile(cfg) {
            var errors = [];
            var s = String(cfg.startText || '').trim();
            var e = String(cfg.endText || '').trim();
            var m = String(cfg.matchText || '').trim();

            if (!s) { errors.push({ field: 'startText', message: 'Start Text is required.' }); }
            if (!e) { errors.push({ field: 'endText', message: 'End Text is required.' }); }
            if (!m) { errors.push({ field: 'matchText', message: 'Match Text is required.' }); }
            if (errors.length) { return { errors: errors, test: null }; }

            var cs = cfg.caseSensitive !== false;
            var test;
            if (cfg.matchMode === 'regex') {
                test = buildRegexMatcher(s, e, m, cs, errors);
            } else if (cfg.matchMode === 'exact') {
                test = buildTokenMatcher(s, e, m, cs);
            } else {
                test = buildContainsMatcher(s, e, m, cs);
            }
            return { errors: errors, test: errors.length ? null : test };
        }

        function buildContainsMatcher(s, e, m, cs) {
            var S = cs ? s : s.toLowerCase();
            var E = cs ? e : e.toLowerCase();
            var M = cs ? m : m.toLowerCase();
            return function (line) {
                var hay = cs ? line : line.toLowerCase();
                if (hay.indexOf(M) === -1) { return null; }
                var isStart = hay.indexOf(S) !== -1;
                var isEnd = hay.indexOf(E) !== -1;
                return (isStart || isEnd) ? { isStart: isStart, isEnd: isEnd, key: M } : null;
            };
        }

        function buildTokenMatcher(s, e, m, cs) {
            var S = cs ? s : s.toLowerCase();
            var E = cs ? e : e.toLowerCase();
            var M = cs ? m : m.toLowerCase();
            return function (line) {
                var hay = cs ? line : line.toLowerCase();
                if (!containsToken(hay, M)) { return null; }
                var isStart = containsToken(hay, S);
                var isEnd = containsToken(hay, E);
                return (isStart || isEnd) ? { isStart: isStart, isEnd: isEnd, key: M } : null;
            };
        }

        function buildRegexMatcher(s, e, m, cs, errors) {
            var flags = cs ? '' : 'i';
            var rs = compileRegex('Start Text', 'startText', s, flags, errors);
            var re = compileRegex('End Text', 'endText', e, flags, errors);
            var rm = compileRegex('Match Text', 'matchText', m, flags, errors);
            if (rm && rm.test('')) {
                errors.push({ field: 'matchText', message: 'Match Text pattern matches empty text, so it cannot identify a transaction.' });
            }
            if (errors.length) { return null; }
            return function (line) {
                var mm = rm.exec(line);
                if (!mm) { return null; }
                var isStart = rs.test(line);
                var isEnd = re.test(line);
                if (!isStart && !isEnd) { return null; }
                return { isStart: isStart, isEnd: isEnd, key: cs ? mm[0] : mm[0].toLowerCase() };
            };
        }

        function compileRegex(label, field, source, flags, errors) {
            try {
                return new RegExp(source, flags);
            } catch (err) {
                errors.push({ field: field, message: label + ' is not a valid regular expression: ' + err.message });
                return null;
            }
        }

        function isWordChar(code) {
            return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
                   (code >= 97 && code <= 122) || code === 95;
        }

        function containsToken(hay, needle) {
            var nl = needle.length;
            var checkLeft = isWordChar(needle.charCodeAt(0));
            var checkRight = isWordChar(needle.charCodeAt(nl - 1));
            var from = 0, idx;
            while ((idx = hay.indexOf(needle, from)) !== -1) {
                var okLeft = !checkLeft || idx === 0 || !isWordChar(hay.charCodeAt(idx - 1));
                var okRight = !checkRight || idx + nl >= hay.length || !isWordChar(hay.charCodeAt(idx + nl));
                if (okLeft && okRight) { return true; }
                from = idx + 1;
            }
            return false;
        }
    }
})();
