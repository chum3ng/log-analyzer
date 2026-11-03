(function () {
    'use strict';

    /**
     * Application module. No third-party AngularJS modules are required:
     * everything (controller, services, filter) is registered on this module.
     */
    angular
        .module('logDurationApp', [])
        .constant('AppConfig', {
            ACCEPTED_EXTENSIONS: ['.log', '.txt', '.out'],
            CHUNK_SIZE: 25000,          // lines scanned per slice before yielding to the UI
            PAGE_SIZE: 100,             // result rows rendered per page
            SAMPLE_LINE_PREVIEW: 400    // characters of a log line shown in collapsed views
        })
        .config(['$compileProvider', function ($compileProvider) {
            // Fewer debug bindings = faster digests with large result sets.
            $compileProvider.debugInfoEnabled(false);
        }]);
})();
