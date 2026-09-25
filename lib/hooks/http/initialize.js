/**
 * Module dependencies.
 */

var _ = require('@sailshq/lodash');
var finalhandler = require('finalhandler');
var parseUrl = require('parseurl');
var Router = require('@sailshq/router');
var getConfiguredHttpMiddlewareFns = require('./get-configured-http-middleware-fns');
var utils = require('./utils');



module.exports = function(sails) {

  /**
   * initialize()
   *
   * Configure the encapsulated Fastify server that will be used to serve actual HTTP requests
   */

  return function initialize(cb) {

    // Before proceeding, wait for the session hook--
    // or if it is disabled, then go ahead and proceed
    // (but change the middleware order config so we don't
    //  attempt to handle sessions).
    (function _waitForSessionHookIfApplicable(next){
      // If the session hook is available...
      if (sails.hooks.session) {
        // Then wait until after session hook has initialized
        // so that the proper session config is available for use
        // in the built-in "session" middleware.
        sails.after('hook:session:loaded', function () {
          return next();
        });
      }
      // Otherwise, the session hook is NOT available.
      else {
        // Then, if it present, rip out "session" from the configured
        // middleware order so we don't try to use the built-in session
        // middleware.
        _.pull(sails.config.http.middleware.order, 'session');
        return next();
      }
    })(function _afterLoadingSessionHookIfApplicable(err) {
      if (err) { return cb(err); }

      try {

        // Required to be here due to dynamic NODE_ENV settings via command line args
        // (i.e. if we `require` this above w/ everything else, the NODE_ENV might not be set properly yet)
        var fastify = require('fastify');

        var IS_NODE_ENV_PRODUCTION = (process.env.NODE_ENV === 'production');

        // Settings used by the request/response helpers (`req.ip`, `res.json()`, etc.)
        // and by `res.render()`.
        var httpSettings = {
          env: process.env.NODE_ENV || 'development',
          trustProxyFn: utils.compileTrust(sails.config.http.trustProxy || false),
          subdomainOffset: 2,
          // In non-production environments, format `res.json()` output nicely.
          jsonSpaces: IS_NODE_ENV_PRODUCTION ? undefined : 2,
          jsonReplacer: undefined,
          jsonEscape: undefined,
          jsonpCallbackName: 'callback',
          etagFn: utils.wetag,
          // (set below, once the views hook has loaded)
          render: undefined
        };

        // Build the prototypes that will be mixed in to incoming `req` and `res` objects.
        var reqProto = Object.create(require('./request'));
        reqProto._sailsHttpSettings = httpSettings;
        var resProto = Object.create(require('./response'));
        resProto._sailsHttpSettings = httpSettings;

        // Create the connect-style middleware pipeline that every incoming HTTP request
        // is dispatched into (after Fastify receives it).
        //
        // Sails binds, unbinds and resets routes at runtime (e.g. `sails.router.flush()`),
        // whereas Fastify's route table is immutable once the server is ready.  So Fastify
        // is configured below with a single catch-all route which hands each request over
        // to this pipeline.
        var sailsHttpPipeline = Router();

        // Create a new router object to handle routes bound in Sails apps.
        // We need direct access to the router object in order to do `unbind` and `reset`.
        //
        // Note that we don't add this router to the pipeline until right
        // before its time to add any "post-router" middleware (i.e. after
        // the "ready" event is received).
        var internalRouter = Router();

        // Determine whether or not to create an HTTPS server
        var isUsingSSL =
          (sails.config.ssl === true) ||
          (sails.config.ssl.key && sails.config.ssl.cert) ||
          sails.config.ssl.pfx;

        // Merge SSL into server options
        var serverOptions = sails.config.http.serverOptions || {};
        _.extend(serverOptions, sails.config.ssl);

        // Lodash 3's _.merge attempts to transform buffers into arrays;
        // so if we detect an array, then transform it back into a buffer.
        _.each(['key', 'cert', 'pfx'], function _eachSSLOption(sslOption) {
          if (_.isArray(serverOptions[sslOption])) {
            serverOptions[sslOption] = Buffer.from(serverOptions[sslOption]);
          }
        });
        // ^^^ The following is probably not relevant anymore, because `_.merge()`
        // is not being used above.  Leaving for compatibility reasons (just to be safe).

        // Get the appropriate server creation method for the protocol
        var createServer = isUsingSSL ?
          require('https').createServer :
          require('http').createServer;

        // Dispatch a raw Node.js request/response pair into the Sails middleware pipeline.
        var dispatchToSails = function (req, res) {
          sailsHttpPipeline.handle(req, res, finalhandler(req, res, {
            env: httpSettings.env,
            onerror: function _logError(err) {
              if (httpSettings.env !== 'test') {
                sails.log.error(err.stack || err.toString());
              }
            }
          }));
        };

        // Hand a request received by Fastify over to Sails.
        // (Fastify's own body parsing and reply handling are skipped on purpose:
        //  the configured `bodyParser` middleware (Skipper by default) reads the raw
        //  request stream, and responses are sent via `res`.)
        var handOverToSails = function (request, reply) {
          reply.hijack();
          dispatchToSails(request.raw, reply.raw);
        };

        // Create the Fastify app instance, using the appropriate HTTP or HTTPS server.
        var app = fastify({
          serverFactory: function (handler) {
            return createServer(serverOptions, handler);
          },
          logger: false,
          exposeHeadRoutes: false,
          return503OnClosing: false,
          forceCloseConnections: false,
          // Requests with URLs which Fastify's router cannot handle (e.g. malformed
          // percent-encoding) are still handed to Sails, so that they get the same
          // 404/500 handling as any other request.
          frameworkErrors: function (unusedErr, request, reply) {
            handOverToSails(request, reply);
          }
        });

        // Remove the built-in content type parsers so that request bodies are left
        // untouched for the configured `bodyParser` middleware.
        app.removeAllContentTypeParsers();
        app.addContentTypeParser('*', function (request, payload, done) { done(null); });

        // Route every request (regardless of verb or path) into Sails.
        app.route({
          method: app.supportedMethods,
          url: '*',
          onRequest: function (request, reply, done) {
            handOverToSails(request, reply);
            return done();
          },
          handler: function () {}
        });
        app.setNotFoundHandler({
          onRequest: function (request, reply, done) {
            handOverToSails(request, reply);
            return done();
          }
        }, function () {});

        // Allow `sails.config.http.customMiddleware` to attach connect-style
        // middleware via `app.use()`.
        app.decorate('use', function use() {
          sailsHttpPipeline.use.apply(sailsHttpPipeline, arguments);
          return this;
        });

        // Expose Fastify app as `sails.hooks.http.app` for use in other files
        // in this hook, and in other core hooks.
        sails.hooks.http.app = app;

        // Expose the underlying Node.js HTTP(S) server.
        sails.hooks.http.server = app.server;

        // Keep track of all openTcpConnections that come in,
        // so we can destroy them later if we want to.
        var openTcpConnections = {};

        // Listen for `connection` events on the raw HTTP server.
        sails.hooks.http.server.on('connection', function _onNewTCPConnection(tcpConnection) {
          var key = tcpConnection.remoteAddress + ':' + tcpConnection.remotePort;
          openTcpConnections[key] = tcpConnection;
          tcpConnection.on('close', function() {
            delete openTcpConnections[key];
          });
        });

        // Create a `destroy` method we can use to do a hard shutdown of the server.
        sails.hooks.http.destroy = function(done) {
          sails.log.verbose('Destroying http server...');
          sails.hooks.http.server.close(done);

          // FUTURE: consider moving this loop ABOVE `sails.hooks.http.server.close(done)`
          // for clarity (since at this point we've passed control via `done`)
          for (var key in openTcpConnections) {
            openTcpConnections[key].destroy();
          }

        };//</define `sails.hooks.http.destroy()`>

        // Configure views if hook enabled
        if (sails.hooks.views) {

          // FUTURE: explore handling this differently to avoid potential
          // timing issues with view engine configuration
          sails.after('hook:views:loaded', function() {
            // Use SailsView to allow case-insensitive view lookups
            var View = require('./view');

            // Set up location of server-side views and their engine
            var viewsDir = sails.config.paths.views;
            var viewEngineExt = sails.config.views.extension;
            var engines = {};
            engines[viewEngineExt[0] !== '.' ? '.' + viewEngineExt : viewEngineExt] = sails.hooks.views._renderFn;
            sails.log.silly('Setting default view engine to ' + viewEngineExt + '...');

            // App-wide settings exposed to view engines as `options.settings`.
            var viewSettings = {
              env: httpSettings.env,
              views: viewsDir,
              'view engine': viewEngineExt,
              'view cache': IS_NODE_ENV_PRODUCTION,
              'jsonp callback name': httpSettings.jsonpCallbackName,
              'subdomain offset': httpSettings.subdomainOffset,
              'trust proxy': sails.config.http.trustProxy || false,
              'x-powered-by': false
            };
            if (!_.isUndefined(httpSettings.jsonSpaces)) {
              viewSettings['json spaces'] = httpSettings.jsonSpaces;
            }

            // Cache of looked-up views (only used when view caching is enabled).
            var viewCache = {};

            // Render the view with the given name, then call `done(err, html)`.
            // (Used by `res.render()`.)
            httpSettings.render = function renderView(name, options, done) {
              var opts = options || {};
              var renderOptions = _.extend({ settings: viewSettings }, opts._locals || {}, opts);

              // set .cache unless explicitly provided
              if (renderOptions.cache === undefined || renderOptions.cache === null) {
                renderOptions.cache = viewSettings['view cache'];
              }

              var view = renderOptions.cache ? viewCache[name] : undefined;
              if (!view) {
                try {
                  view = new View(name, {
                    defaultEngine: viewEngineExt,
                    root: viewsDir,
                    engines: engines
                  });
                } catch (e) { return done(e); }

                if (!view.path) {
                  var lookupErr = new Error('Failed to lookup view "' + name + '" in views directory "' + view.root + '"');
                  lookupErr.view = view;
                  return done(lookupErr);
                }

                // prime the cache
                if (renderOptions.cache) {
                  viewCache[name] = view;
                }
              }

              try {
                view.render(renderOptions, done);
              } catch (e) { return done(e); }
            };

          });//</ after hook:views:loaded >

        }//>-

        // Whenever Sails binds a route, bind it to the internal router.
        sails.on('router:bind', function(route) {
          // Clone the route so that if a route handler messes with the options, the changes
          // don't get persisted and used in subsequent requests.
          route = _.cloneDeep(route);
          internalRouter[route.verb || 'all'](route.path || '/*', route.target);
        });

        // Whenever Sails unbinds a route, remove it from the internal router.
        sails.on('router:unbind', function(routeToRemove) {
          // Remove any route which matches the path and verb of the argument
          _.remove(internalRouter.stack, function(layer) {
            return (layer.route.path === routeToRemove.path && layer.route.methods[routeToRemove.verb] === true);
          });
        });

        // Whenever Sails resets its router, clear out the internal router.
        sails.on('router:reset', function() {
          internalRouter.stack = [];
        });

        // Initialize each incoming request/response pair: link them together,
        // mix in the request/response helpers (`req.ip`, `res.json()`, etc.),
        // and parse the query string into `req.query`.
        sailsHttpPipeline.use(function _initializeReqAndRes(req, res, next) {
          req.res = res;
          res.req = req;
          req.next = next;

          Object.setPrototypeOf(req, reqProto);
          Object.setPrototypeOf(res, resProto);

          res.locals = res.locals || Object.create(null);

          if (!req.query) {
            req.query = utils.parseExtendedQueryString(parseUrl(req).query);
          }

          return next();
        });

        // Now use an initial piece of middleware to bind
        // _core, mandatory properties_ to the incoming `req`.
        // This middleware cannot be disabled in userland configuration--
        // and that's done on purpose.
        sailsHttpPipeline.use(function _exposeSailsOnReq (req, res, next){
          // Expose req._sails on incoming HTTP request instances.
          //
          // This is also handled separately for virtual requests in `lib/router/`:
          // (see https://github.com/balderdashy/sails/pull/3599#issuecomment-195665040)
          req._sails = sails;

          // Wrap `req.param()` in a shim that normalizes the behavior of `req.param('length')`.
          // (see https://github.com/balderdashy/sails/issues/3738#issue-156095626)
          var origReqParam = req.param;
          req.param = function getValForParam (name){
            if (name === 'length') {
              // If `req.params.length` is a string, instead of a number, then we know this request
              // must have matched a route address like `/foo/bar/:length/baz`, so in that case, we'll
              // allow `req.param('length')` to return the runtime value of `length` as a string.
              if (_.isString(req.params.length)) {
                return req.params.length;
              }
              else if (!_.isArray(req.body) && _.isObject(req.body) && !_.isUndefined(req.body.length) && !_.isNull(req.body.length)) {
                // > In future versions of Sails, this shim will likely be modified to allow the `null` literal to be received
                // > as a value for a body parameter and accessed in `req.param()`.
                // > (This is because `null` and `undefined` are distinct and lossless when serializing and deserializing to
                // > and from JSON-- so it's really specifically for standard JSON response bodies.)
                // >
                // > However, this is a departure from the behavior of Express, and a breaking change- so it will
                // > not happen until the release of Sails v1 (or possibly in a pre v1.0 minor version.)
                return req.body.length;
              }
              else if (_.isObject(req.query) && !_.isUndefined(req.query.length) && !_.isNull(req.query.length)) {
                return req.query.length;
              }
              else { return undefined; }
            }
            return origReqParam.apply(req, Array.prototype.slice.call(arguments));
          };

          return next();
        });

        // If there's a `handleBodyParserError` middleware in the order, and there isn't
        // a custom definition for it (i.e. it's trying to use the default) log a
        // deprecation warning.
        if (_.contains(sails.config.http.middleware.order, 'handleBodyParserError') && !_.isFunction(sails.config.http.middleware.handleBodyParserError)) {
          sails.log.debug('The `handleBodyParserError` middleware has been removed in Sails 1.0.');
          sails.log.debug('To avoid this message, remove `handleBodyParserError` from ');
          sails.log.debug('the `order` array in `config/http.js`.');
          sails.log.debug('See http://sailsjs.com/upgrading for more info.\n');
        }

        // If there's a `methodOverride` middleware in the order, and there isn't
        // a custom definition for it (i.e. it's trying to use the default) log a
        // deprecation warning.
        if (_.contains(sails.config.http.middleware.order, 'methodOverride') && !_.isFunction(sails.config.http.middleware.methodOverride)) {
          sails.log.debug('The `methodOverride` middleware has been removed in Sails 1.0.');
          sails.log.debug('To avoid this message, remove `methodOverride` from ');
          sails.log.debug('the `order` array in `config/http.js`.');
          sails.log.debug('See http://sailsjs.com/upgrading for more info.\n');
        }


        // Ignore explicit declarations of `startRequestTimer`, `404` and `500` middleware.
        var removedHttpMiddleware = _.remove(sails.config.http.middleware.order, function(middleware) {
          return _.contains(['handleBodyParserError', 'startRequestTimer', '404', '500'], middleware);
        });

        // Warn about an explicit `startRequestTimer` in the order, or a custom middleware implementation of it.
        if (_.contains(removedHttpMiddleware, 'startRequestTimer') || sails.config.http.middleware.startRequestTimer) {
          sails.log.debug('The `startRequestTimer` middleware is added to your app automatically in Sails 1.0.');
          if (sails.config.http.middleware.startRequestTimer) {
            sails.log.debug('(ignoring custom implementation in `sails.config.http.middleware.startRequestTimer)');
          } else {
            sails.log.debug('(ignoring entry in the `sails.config.http.middleware.order` list)');
          }
          sails.log.debug('See http://sailsjs.com/documentation/reference/request-req/req-start-time for more info.\n');
        }

        // Warn about an explicit `404` in the order, or a custom middleware implementation of it.
        if (_.contains(removedHttpMiddleware, '404') || sails.config.http.middleware['404']) {
          sails.log.debug('The `404` middleware is added to your app automatically in Sails 1.0.');
          if (sails.config.http.middleware['404']) {
            sails.log.debug('(ignoring custom implementation in `sails.config.http.middleware[\'404\']`)');
          } else {
            sails.log.debug('(ignoring entry in the `sails.config.http.middleware.order` list)');
          }
          sails.log.debug('If you wish to customize the 404 functionality for your app, you can');
          sails.log.debug('do so by creating a custom `notFound` response as `api/responses/notFound.js`.');
          sails.log.debug('See http://sailsjs.com/documentation/concepts/custom-responses for more info.\n');
        }

        // Warn about an explicit `500` in the order.
        if (_.contains(removedHttpMiddleware, '500') || sails.config.http.middleware['500']) {
          sails.log.debug('The `500` middleware is added to your app automatically in Sails 1.0.');
          if (sails.config.http.middleware['500']) {
            sails.log.debug('(ignoring custom implementation in `sails.config.http.middleware[\'500\']`)');
          } else {
            sails.log.debug('(ignoring entry in the `sails.config.http.middleware.order` list)');
          }
          sails.log.debug('If you wish to customize the 500 functionality for your app, you can');
          sails.log.debug('do so by creating a custom `serverError` response as `api/responses/serverError.js`.');
          sails.log.debug('See http://sailsjs.com/documentation/concepts/custom-responses for more info.\n');
        }

        // Then build a dictionary of configured middleware functions, including
        // built-in middleware as well as any middleware provided in
        // `sails.config.http.middleware`.
        var configuredHttpMiddlewareFns = getConfiguredHttpMiddlewareFns(app, sails);

        // Add in the middleware to record the request start time.
        sailsHttpPipeline.use(function startRequestTimer(req, res, next) {
          req._startTime = new Date();
          next();
        });

        // Split the middleware order into "pre-router" and "post-router" middleware.
        // The internal "startRequestTimer" always comes first.
        var preRouterMiddleware = [];
        var postRouterMiddleware = null;
        _.each(sails.config.http.middleware.order, function(middlewareKey) {
          if (middlewareKey === 'router') { postRouterMiddleware = []; }
          else if ( _.isArray(postRouterMiddleware) ) {
            postRouterMiddleware.push(middlewareKey);
          }
          else {
            preRouterMiddleware.push(middlewareKey);
          }
        });

        // If a custom `loadMiddleware` function was configured, then call it to "use"
        // the configured middleware (instead of doing it automatically with the more
        // modern `sails.config.http.middleware.order` configuration).
        //
        // This is primarily for backwards compatibility for the undocumented
        // `express.loadMiddleware` config that is still in use in legacy apps
        // from the 2013-early 2014 time frame.
        //
        // It is no longer relevant in most cases thanks to `sails.config.http.middleware`,
        // and may be removed in an upcoming release.
        if (sails.config.http.loadMiddleware) {
          sails.config.http.loadMiddleware(app, configuredHttpMiddlewareFns, sails);
        }
        // Otherwise (i.e. the normal case) we `.use()` each of the configured
        // middleware functions in the configured order (`sails.config.http.middleware.order`).
        else {
          _.each(preRouterMiddleware, function (middlewareKey) {

            // `$custom` is a special entry in the middleware order config that exists
            // purely for compatibility.  When procesing `$custom`, we check to see if
            // `sails.config.http.customMiddleware`, was provided and if so, call it
            // with the app instance as an argument (rather than calling
            // `sails.config.http.middleware.$custom`).
            // If `customMiddleware` is not being used, we just ignore `$custom` altogether.
            if (middlewareKey === '$custom') {
              if (sails.config.http.customMiddleware) {
                // Allows for injecting a custom function to attach middleware.
                // (This is here for compatibility, and for situations where the
                //  app instance is necessary for configuring middleware).
                sails.config.http.customMiddleware(app);
              }
              // Either way, bail at this point (we don't want to do anything further with $custom)
              return;
            }

            // Look up the referenced middleware function.
            var referencedMwr = configuredHttpMiddlewareFns[middlewareKey];

            // If a middleware fn by this name is not configured (i.e. `undefined`),
            // then skip this entry & write a verbose log message.
            if (_.isUndefined(referencedMwr)) {
              sails.log.verbose('An entry (`%s`) in `sails.config.http.middleware.order` references an unrecognized middleware function-- that is, it was not provided as a key in the `sails.config.http.middleware` dictionary. Skipping...', middlewareKey);
              return;
            }
            // On the other hand, if the referenced middleware appears to be disabled
            // _on purpose_, or because _it is not compatible_, then just skip it and
            // don't log anything. (i.e. it is `null` or `false`)
            if (!referencedMwr) {
              return;
            }

            // Otherwise, we're good to go, so go ahead and use the referenced
            // middleware function.
            sailsHttpPipeline.use(referencedMwr);

          });//</each item in `sails.config.http.middleware.order`>
        }

        // www, favicon, 404 and 500 middleware should be attached at the very end.
        // Routes are bound to the internal router, which is only added to the
        // pipeline once the app is fully initialized, so we have to wait until
        // then to add the post-router middleware after it.
        sails.once('ready', function addPostRouterMiddleware() {

          sailsHttpPipeline.use(internalRouter);

          _.each(postRouterMiddleware, function (middlewareKey) {

            // Look up the referenced middleware function.
            var referencedMwr = configuredHttpMiddlewareFns[middlewareKey];

            // If a middleware fn by this name is not configured (i.e. `undefined`),
            // then skip this entry & write a verbose log message.
            if (_.isUndefined(referencedMwr)) {
              sails.log.verbose('An entry (`%s`) in `sails.config.http.middleware.order` references an unrecognized middleware function-- that is, it was not provided as a key in the `sails.config.http.middleware` dictionary. Skipping...', middlewareKey);
              return;
            }
            // On the other hand, if the referenced middleware appears to be disabled
            // _on purpose_, or because _it is not compatible_, then just skip it and
            // don't log anything. (i.e. it is `null` or `false`)
            if (!referencedMwr) {
              return;
            }

            // Otherwise, we're good to go, so go ahead and use the referenced
            // middleware function.
            sailsHttpPipeline.use(referencedMwr);

          });

          // Add the default 404 middleware.
          sailsHttpPipeline.use(function handleUnmatchedRequest(req, res) {
            // Explicitly ignore error arg to avoid inadvertently
            // turning this into an error handler
            sails.emit('router:request:404', req, res);
          });

          // Add the default 500 middleware.
          sailsHttpPipeline.use(function handleError(err, req, res, next) {// eslint-disable-line no-unused-vars
            // Note that we _need_ all four arguments in order for this function
            // to have special meaning as an error handler
            sails.emit('router:request:500', err, req, res);
          });

        });

        // All done!
        return cb();

      } catch (e) { return cb(e); }
      // ^ for improving the readability of any bugs in the above code,
      // or for unhandled errors from our dependencies, or for unexpected
      // configuration.

    });//</_afterLoadingSessionHookIfApplicable>
  };//</initialize()>
};
