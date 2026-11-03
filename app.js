(function () {
    'use strict';

    /**
     * Application module. Everything (controller, services, filters, directives)
     * is registered on this module; no third-party AngularJS modules are needed.
     */
    angular
        .module('logDurationApp', [])
        .constant('AppConfig', {
            ACCEPTED_EXTENSIONS: ['.log', '.txt', '.out'],
            FILE_CHUNK_BYTES: 4 * 1024 * 1024,  // bytes read per slice; the UI is released between slices
            PAGE_SIZE: 100,                      // transaction rows rendered per page
            ANALYSIS_PAGE_SIZE: 15,              // batch / callback rows rendered per page
            LINE_PREVIEW: 300                    // characters of a log line shown in collapsed views
        })
        .config(['$compileProvider', function ($compileProvider) {
            $compileProvider.debugInfoEnabled(false); // faster digests with large result sets
        }]);
})();
