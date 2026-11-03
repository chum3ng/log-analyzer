(function () {
    'use strict';

    angular.module('logDurationApp').service('DateTimeService', DateTimeService);

    DateTimeService.$inject = [];

    /**
     * Extracts timestamps from arbitrary log lines (never assumes position).
     *
     * createExtractor(dtConfig) -> { error, extract(line) }
     * extract(line) -> { ok, chosen, candidates, warnings, error }
     *   chosen = { text, index, epochMicros, offsetMin, assumedTz, label, ambiguous }
     *
     * Time is held as integer MICROSECONDS since the Unix epoch
     * (epochMs * 1000 + micros; about 1.8e15, safely below 2^53),
     * so no precision is lost and Date.parse() is never used.
     */
    function DateTimeService() {
        var self = this;

        self.defaultConfig = defaultConfig;
        self.createExtractor = createExtractor;
        self.validateConfig = validateConfig;
        self.formatIsoUtc = formatIsoUtc;
        self.supportedFormats = [
            '2026-11-02 02:31:46.697', '2026-11-02T02:31:46.697', '2026-11-02T02:31:46.697+07:00',
            '2026-11-02T02:31:46.697Z', '02/11/2026 02:31:46', '03/Nov/2026:02:31:46 +0700',
            'Nov 02, 2026 02:31:46.697', '[2026-11-02 02:31:46.697]'
        ];

        var MONTHS = {};
        ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
         'september', 'october', 'november', 'december'].forEach(function (name, i) {
            MONTHS[name] = i + 1;
            MONTHS[name.slice(0, 3)] = i + 1;
        });
        MONTHS.sept = 9;

        var TZ = 'Z(?![A-Za-z])|[+-]\\d{2}(?::?\\d{2})?(?!\\d)';
        var TIME = '(\\d{2}):(\\d{2}):(\\d{2})(?:[.,](\\d{1,9}))?(?:\\s?(' + TZ + '))?';

        var AUTO_PATTERNS = [
            {   // 2026-11-02 02:31:46.697 | 2026-11-02T02:31:46,697+07:00 | ...Z
                label: 'ISO 8601 / Java',
                re: new RegExp('(\\d{4})-(\\d{2})-(\\d{2})[T ]' + TIME, 'g'),
                build: function (m) { return { y: m[1], mo: m[2], d: m[3], h: m[4], mi: m[5], s: m[6], frac: m[7], tz: m[8] }; }
            },
            {   // 03/Nov/2026:02:31:46 +0700
                label: 'Apache / CLF',
                re: new RegExp('(\\d{1,2})/([A-Za-z]{3,9})/(\\d{4}):(\\d{2}):(\\d{2}):(\\d{2})(?:[.,](\\d{1,9}))?(?:\\s?(Z(?![A-Za-z])|[+-]\\d{4}|[+-]\\d{2}:\\d{2}))?', 'g'),
                build: function (m) {
                    if (!monthNumber(m[2])) { return null; }
                    return { d: m[1], monName: m[2], y: m[3], h: m[4], mi: m[5], s: m[6], frac: m[7], tz: m[8] };
                }
            },
            {   // 02/11/2026 02:31:46 (day/month order decided by config)
                label: 'Numeric date',
                re: new RegExp('(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{4})[T ,]+' + TIME, 'g'),
                build: function (m, ctx) {
                    var a = parseInt(m[1], 10), b = parseInt(m[2], 10), day, month, ambiguous = false;
                    if (a > 12 && b <= 12) { day = a; month = b; }
                    else if (b > 12 && a <= 12) { day = b; month = a; }
                    else if (ctx.dateOrder === 'MDY') { month = a; day = b; ambiguous = a <= 12 && b <= 12 && a !== b; }
                    else { day = a; month = b; ambiguous = a <= 12 && b <= 12 && a !== b; }
                    return { y: m[3], mo: String(month), d: String(day), h: m[4], mi: m[5], s: m[6], frac: m[7], tz: m[8], ambiguous: ambiguous };
                }
            },
            {   // Nov 02, 2026 02:31:46.697
                label: 'Month name first',
                re: new RegExp('([A-Za-z]{3,9})\\.?\\s+(\\d{1,2}),?\\s+(\\d{4})[T ,]+' + TIME, 'g'),
                build: function (m) {
                    if (!monthNumber(m[1])) { return null; }
                    return { monName: m[1], d: m[2], y: m[3], h: m[4], mi: m[5], s: m[6], frac: m[7], tz: m[8] };
                }
            },
            {   // 02 Nov 2026 02:31:46
                label: 'Day then month name',
                re: new RegExp('(\\d{1,2})\\s+([A-Za-z]{3,9})\\.?,?\\s+(\\d{4})[T ,]+' + TIME, 'g'),
                build: function (m) {
                    if (!monthNumber(m[2])) { return null; }
                    return { d: m[1], monName: m[2], y: m[3], h: m[4], mi: m[5], s: m[6], frac: m[7], tz: m[8] };
                }
            }
        ];

        // ---------------------------------------------------------------- config

        function defaultConfig() {
            return { mode: 'auto', regex: '', group: 1, format: '', defaultTz: 'UTC', dateOrder: 'DMY', occurrence: 'first' };
        }

        function validateConfig(dt) {
            var cfg = angular.extend(defaultConfig(), dt || {});
            if (!parseDefaultTz(cfg.defaultTz)) {
                return 'Default timezone must be "local", "UTC" or an offset such as +07:00.';
            }
            try {
                if (cfg.mode === 'regex') {
                    if (!String(cfg.regex).trim()) { return 'Enter a custom datetime regular expression.'; }
                    var groups = new RegExp(cfg.regex + '|').exec('').length - 1;
                    var g = parseInt(cfg.group, 10);
                    if (isNaN(g) || g < 0 || g > groups) {
                        return 'Capture group ' + cfg.group + ' does not exist (your regex has ' + groups + ' group(s); use 0 for the whole match).';
                    }
                    if (String(cfg.format).trim()) { compileFormat(cfg.format); }
                } else if (cfg.mode === 'format') {
                    if (!String(cfg.format).trim()) { return 'Enter a datetime format, e.g. yyyy-MM-dd HH:mm:ss.SSS'; }
                    compileFormat(cfg.format);
                }
            } catch (err) {
                return 'Datetime configuration error: ' + err.message;
            }
            return null;
        }

        function parseDefaultTz(tz) {
            if (tz === 'local') { return { type: 'local' }; }
            if (tz === 'UTC' || tz === 'Z' || tz == null || tz === '') { return { type: 'offset', offsetMin: 0 }; }
            var off = parseOffset(tz);
            return off === null ? null : { type: 'offset', offsetMin: off };
        }

        function parseOffset(str) {
            if (str == null || str === '') { return null; }
            if (/^z$/i.test(str)) { return 0; }
            var m = /^([+-])(\d{2}):?(\d{2})?$/.exec(str);
            if (!m) { return null; }
            var mins = parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0);
            return m[1] === '-' ? -mins : mins;
        }

        // ------------------------------------------------------------- extractor

        function createExtractor(dt) {
            var cfg = angular.extend(defaultConfig(), dt || {});
            var error = validateConfig(cfg);
            if (error) { return { error: error, extract: null }; }

            var ctx = { dateOrder: cfg.dateOrder === 'MDY' ? 'MDY' : 'DMY' };
            var defaultTz = parseDefaultTz(cfg.defaultTz);
            var finder;

            if (cfg.mode === 'regex') {
                finder = regexFinder(cfg, ctx);
            } else if (cfg.mode === 'format') {
                finder = formatFinder(compileFormat(cfg.format));
            } else {
                finder = function (line) { return findAuto(line, ctx); };
            }

            return { error: null, extract: extract };

            function extract(line) {
                var raws = finder(line);
                var result = { ok: false, chosen: null, candidates: [], warnings: [], error: null };

                if (!raws.length) {
                    result.error = 'No timestamp found in line.';
                    return result;
                }
                result.candidates = raws.map(function (r) { return toCandidate(r, defaultTz); });
                var valid = result.candidates.filter(function (c) { return c.valid; });
                if (!valid.length) {
                    var first = result.candidates[0];
                    result.error = 'Invalid datetime "' + first.text + '": ' + first.error;
                    return result;
                }

                var useLast = cfg.occurrence === 'last';
                var chosen = useLast ? valid[valid.length - 1] : valid[0];
                result.chosen = chosen;
                result.ok = true;

                if (valid.length > 1) {
                    result.warnings.push('Multiple timestamps found (' + valid.length + '): ' +
                        valid.map(function (c) { return '"' + c.text + '"'; }).join(', ') +
                        '. Using the ' + (useLast ? 'last' : 'first') + ' one. Change "Occurrence" or use a custom regex to select another.');
                }
                if (chosen.assumedTz) {
                    result.warnings.push('No timezone in "' + chosen.text + '"; assumed ' + cfg.defaultTz + '.');
                }
                if (chosen.ambiguous) {
                    result.warnings.push('Date in "' + chosen.text + '" is ambiguous; read as ' + ctx.dateOrder + '.');
                }
                if (chosen.truncated) {
                    result.warnings.push('Fraction in "' + chosen.text + '" has more than 6 digits; truncated to microseconds.');
                }
                return result;
            }
        }

        // --------------------------------------------------------------- finders

        function findAuto(line, ctx) {
            var found = [], i, p, m;
            for (i = 0; i < AUTO_PATTERNS.length; i++) {
                p = AUTO_PATTERNS[i];
                p.re.lastIndex = 0;
                while ((m = p.re.exec(line)) !== null) {
                    if (m[0].length === 0) { p.re.lastIndex++; continue; }
                    var parts = p.build(m, ctx);
                    if (parts) {
                        found.push({ text: m[0], index: m.index, parts: parts, label: p.label, ambiguous: !!parts.ambiguous });
                    }
                }
            }
            found.sort(function (a, b) { return a.index - b.index || b.text.length - a.text.length; });
            var accepted = [], lastEnd = -1;
            found.forEach(function (f) {
                if (f.index >= lastEnd) { accepted.push(f); lastEnd = f.index + f.text.length; }
            });
            return accepted;
        }

        function regexFinder(cfg, ctx) {
            var re = new RegExp(cfg.regex, 'g');
            var group = parseInt(cfg.group, 10) || 0;
            var fmt = String(cfg.format).trim() ? compileFormat(cfg.format) : null;
            var fmtRe = fmt ? new RegExp(fmt.source) : null;

            return function (line) {
                var out = [], m;
                re.lastIndex = 0;
                while ((m = re.exec(line)) !== null) {
                    if (m[0].length === 0) { re.lastIndex++; continue; }
                    var text = m[group];
                    if (text == null || text === '') { continue; }
                    var index = m.index + (group === 0 ? 0 : Math.max(0, m[0].indexOf(text)));
                    var raw = null;
                    if (fmt) {
                        var fm = fmtRe.exec(text);
                        if (fm) { raw = { text: text, index: index, parts: partsFromFormat(fmt, fm), label: 'custom regex + format' }; }
                    } else {
                        var auto = findAuto(text, ctx);
                        if (auto.length) { raw = auto[0]; raw.text = text; raw.index = index; raw.label = 'custom regex'; }
                    }
                    out.push(raw || { text: text, index: index, parts: null, label: 'custom regex' });
                }
                return out;
            };
        }

        function formatFinder(fmt) {
            var re = new RegExp(fmt.source, 'g');
            return function (line) {
                var out = [], m;
                re.lastIndex = 0;
                while ((m = re.exec(line)) !== null) {
                    if (m[0].length === 0) { re.lastIndex++; continue; }
                    out.push({ text: m[0], index: m.index, parts: partsFromFormat(fmt, m), label: 'manual format' });
                }
                return out;
            };
        }

        // ---------------------------------------------------- manual format parser

        function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&'); }

        /** Supports yyyy yy MMM MM M dd d HH H hh h mm ss S.. a X XX XXX Z and 'quoted' text. */
        function compileFormat(format) {
            var src = '', names = [], i = 0, ch, j, run;
            var fmt = String(format);
            while (i < fmt.length) {
                ch = fmt.charAt(i);
                if (ch === "'") {
                    j = fmt.indexOf("'", i + 1);
                    if (j === -1) { throw new Error('Unterminated quote in format.'); }
                    src += j === i + 1 ? "'" : escapeRe(fmt.slice(i + 1, j));
                    i = j + 1;
                } else if (/\s/.test(ch)) {
                    while (i < fmt.length && /\s/.test(fmt.charAt(i))) { i++; }
                    src += '\\s+';
                } else if (ch === 'T') {
                    src += 'T'; i++;
                } else if (/[A-Za-z]/.test(ch)) {
                    j = i;
                    while (j < fmt.length && fmt.charAt(j) === ch) { j++; }
                    run = j - i;
                    src += formatToken(ch, run, names);
                    i = j;
                } else {
                    src += escapeRe(ch); i++;
                }
            }
            var hasYear = names.indexOf('y') !== -1 || names.indexOf('yy') !== -1;
            var hasMonth = names.indexOf('mo') !== -1 || names.indexOf('monName') !== -1;
            if (!hasYear || !hasMonth || names.indexOf('d') === -1 || names.indexOf('h') === -1 || names.indexOf('mi') === -1) {
                throw new Error('Format must include year, month, day, hour and minute (e.g. yyyy-MM-dd HH:mm:ss.SSS).');
            }
            return { source: src, names: names };
        }

        function formatToken(ch, run, names) {
            switch (ch) {
                case 'y': names.push(run === 2 ? 'yy' : 'y'); return run === 2 ? '(\\d{2})' : '(\\d{4})';
                case 'M':
                    if (run >= 3) { names.push('monName'); return '([A-Za-z]{3,9})'; }
                    names.push('mo'); return run === 2 ? '(\\d{2})' : '(\\d{1,2})';
                case 'd': names.push('d'); return run === 2 ? '(\\d{2})' : '(\\d{1,2})';
                case 'H': case 'h': names.push('h'); return run >= 2 ? '(\\d{2})' : '(\\d{1,2})';
                case 'm': names.push('mi'); return run >= 2 ? '(\\d{2})' : '(\\d{1,2})';
                case 's': names.push('s'); return run >= 2 ? '(\\d{2})' : '(\\d{1,2})';
                case 'S': names.push('frac'); return '(\\d{1,9})';
                case 'a': names.push('ampm'); return '([AaPp][Mm])';
                case 'X':
                    names.push('tz');
                    return run === 1 ? '(Z|[+-]\\d{2}(?::?\\d{2})?)' : run === 2 ? '(Z|[+-]\\d{4})' : '(Z|[+-]\\d{2}:\\d{2})';
                case 'Z': names.push('tz'); return '([+-]\\d{4})';
                default: throw new Error('Unsupported format letter "' + ch + '". Quote literal text with single quotes.');
            }
        }

        function partsFromFormat(fmt, m) {
            var parts = {};
            fmt.names.forEach(function (n, i) { parts[n] = m[i + 1]; });
            return parts;
        }

        // ------------------------------------------------------ field -> epoch

        function monthNumber(name) {
            return MONTHS[String(name).toLowerCase().replace('.', '')] || null;
        }

        function toCandidate(raw, defaultTz) {
            var base = { text: raw.text, index: raw.index, label: raw.label, ambiguous: !!raw.ambiguous, valid: false };
            if (!raw.parts) {
                base.error = 'could not be parsed. Provide a manual format or a different regex.';
                return base;
            }
            var p = raw.parts, f = {};
            f.y = p.y != null ? parseInt(p.y, 10) : (p.yy != null ? (parseInt(p.yy, 10) < 70 ? 2000 : 1900) + parseInt(p.yy, 10) : NaN);
            f.mo = p.mo != null ? parseInt(p.mo, 10) : monthNumber(p.monName);
            f.d = parseInt(p.d, 10);
            f.h = parseInt(p.h, 10);
            f.mi = parseInt(p.mi, 10);
            f.s = p.s != null ? parseInt(p.s, 10) : 0;
            if (p.ampm) { f.h = (f.h % 12) + (/^p/i.test(p.ampm) ? 12 : 0); }

            var frac = p.frac || '';
            f.micros = frac ? parseInt((frac + '000000').slice(0, 6), 10) : 0;
            base.truncated = frac.length > 6;

            var err = validateFields(f);
            if (err) { base.error = err; return base; }

            var offsetMin = parseOffset(p.tz);
            var ms;
            if (offsetMin !== null) {
                ms = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s) - offsetMin * 60000;
            } else if (defaultTz.type === 'local') {
                ms = new Date(f.y, f.mo - 1, f.d, f.h, f.mi, f.s).getTime();
            } else {
                ms = Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s) - defaultTz.offsetMin * 60000;
            }
            base.epochMicros = ms * 1000 + f.micros;
            base.offsetMin = offsetMin;
            base.assumedTz = offsetMin === null;
            base.valid = true;
            return base;
        }

        function validateFields(f) {
            var k;
            for (k in f) { if (f.hasOwnProperty(k) && (f[k] === null || isNaN(f[k]))) { return 'missing or non-numeric ' + k + '.'; } }
            if (f.mo < 1 || f.mo > 12) { return 'month ' + f.mo + ' is out of range.'; }
            var dim = new Date(Date.UTC(f.y, f.mo, 0)).getUTCDate();
            if (f.d < 1 || f.d > dim) { return 'day ' + f.d + ' is out of range for that month.'; }
            if (f.h > 23 || f.mi > 59 || f.s > 59) { return 'time ' + f.h + ':' + f.mi + ':' + f.s + ' is out of range.'; }
            return null;
        }

        // --------------------------------------------------------------- display

        function formatIsoUtc(epochMicros) {
            if (epochMicros == null || isNaN(epochMicros)) { return ''; }
            var ms = Math.floor(epochMicros / 1000);
            var rem = epochMicros - ms * 1000;
            var iso = new Date(ms).toISOString();
            return rem ? iso.replace('Z', ('00' + rem).slice(-3) + 'Z') : iso;
        }
    }
})();
