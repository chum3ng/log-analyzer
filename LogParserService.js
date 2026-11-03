(function () {
    'use strict';

    angular.module('logDurationApp').service('LogParserService', LogParserService);

    LogParserService.$inject = ['$q', '$rootScope', 'AppConfig'];

    function LogParserService($q, $rootScope, AppConfig) {
        var self = this;

        self.splitLines = splitLines;
        self.countLines = countLines;
        self.hasValidExtension = hasValidExtension;
        self.readFile = readFile;
        self.formatBytes = formatBytes;

        /** Splits on \r\n, \n or \r. Line N of the result is original line number N+1. */
        function splitLines(text) {
            if (!text) { return []; }
            var lines = String(text).split(/\r\n|\r|\n/);
            if (lines.length > 1 && lines[lines.length - 1] === '') {
                lines.pop(); // trailing newline does not create an extra line
            }
            return lines;
        }

        /** Counts lines without allocating an array (cheap enough to run on every edit). */
        function countLines(text) {
            if (!text) { return 0; }
            var n = 1, len = text.length;
            for (var i = 0; i < len; i++) {
                var c = text.charCodeAt(i);
                if (c === 13) {
                    if (text.charCodeAt(i + 1) === 10) { i++; }
                    n++;
                } else if (c === 10) {
                    n++;
                }
            }
            var last = text.charCodeAt(len - 1);
            if (n > 1 && (last === 10 || last === 13)) { n--; }
            return n;
        }

        function hasValidExtension(fileName) {
            var name = String(fileName || '').toLowerCase();
            return AppConfig.ACCEPTED_EXTENSIONS.some(function (ext) {
                return name.length > ext.length && name.slice(-ext.length) === ext;
            });
        }

        /** Reads a File with FileReader. Resolves { name, size, text }. */
        function readFile(file) {
            var deferred = $q.defer();

            if (!file) {
                deferred.reject('No file selected.');
                return deferred.promise;
            }
            if (!hasValidExtension(file.name)) {
                deferred.reject('Unsupported file type "' + file.name + '". Allowed: ' +
                    AppConfig.ACCEPTED_EXTENSIONS.join(', ') + '.');
                return deferred.promise;
            }

            var reader = new FileReader();
            reader.onload = function () {
                $rootScope.$evalAsync(function () {
                    deferred.resolve({ name: file.name, size: file.size, text: String(reader.result || '') });
                });
            };
            reader.onerror = function () {
                $rootScope.$evalAsync(function () {
                    deferred.reject('Could not read "' + file.name + '".');
                });
            };
            reader.onprogress = function (e) {
                if (e.lengthComputable) {
                    $rootScope.$evalAsync(function () { deferred.notify(e.loaded / e.total); });
                }
            };
            reader.readAsText(file);
            return deferred.promise;
        }

        function formatBytes(bytes) {
            if (!bytes) { return '0 B'; }
            var units = ['B', 'KB', 'MB', 'GB'];
            var i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
            var v = bytes / Math.pow(1024, i);
            return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)) + ' ' + units[i];
        }
    }
})();
