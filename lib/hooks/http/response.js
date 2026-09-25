/**
 * Module dependencies
 */

var http = require('http');
var path = require('path');
var contentDisposition = require('content-disposition');
var createError = require('http-errors');
var encodeUrl = require('encodeurl');
var escapeHtml = require('escape-html');
var onFinished = require('on-finished');
var statuses = require('statuses');
var sign = require('cookie-signature').sign;
var cookie = require('cookie');
var send = require('send');
var vary = require('vary');
var utils = require('./utils');

var extname = path.extname;
var resolve = path.resolve;
var mime = send.mime;
var charsetRegExp = /;\s*charset\s*=/;


/**
 * Base prototype for outgoing HTTP responses handled by Sails.
 *
 * Fastify hands the raw Node.js `http.ServerResponse` to Sails' request pipeline.
 * Sails' built-in responses (`res.ok()`, `res.view()`, `res.notFound()`, etc.), blueprints,
 * and connect-style middleware rely on the conventional `res` helpers (e.g. `res.status()`,
 * `res.json()`, `res.redirect()`), so they are provided here and mixed into each raw response.
 *
 * Adapted from the MIT-licensed implementation in Express 4
 * (Copyright(c) 2009-2013 TJ Holowaychuk, 2014-2015 Douglas Christopher Wilson),
 * with app settings read from `this._sailsHttpSettings` instead of an Express app.
 *
 * @type {Dictionary}
 */

var res = Object.create(http.ServerResponse.prototype);

module.exports = res;


res.status = function status(code) {
  this.statusCode = code;
  return this;
};


res.links = function(links){
  var link = this.get('Link') || '';
  if (link) { link += ', '; }
  return this.set('Link', link + Object.keys(links).map(function(rel){
    return '<' + links[rel] + '>; rel="' + rel + '"';
  }).join(', '));
};


/**
 * Send a response.
 *
 * @param {string|number|boolean|object|Buffer} body
 */
res.send = function send(body) {
  var chunk = body;
  var encoding;
  var req = this.req;
  var type;
  var settings = this._sailsHttpSettings;

  // allow status / body
  if (arguments.length === 2) {
    // res.send(body, status) backwards compat
    if (typeof arguments[0] !== 'number' && typeof arguments[1] === 'number') {
      this.statusCode = arguments[1];
    } else {
      this.statusCode = arguments[0];
      chunk = arguments[1];
    }
  }

  // disambiguate res.send(status) and res.send(status, num)
  if (typeof chunk === 'number' && arguments.length === 1) {
    // res.send(status) will set status message as text string
    if (!this.get('Content-Type')) {
      this.type('txt');
    }

    this.statusCode = chunk;
    chunk = statuses.message[chunk];
  }

  switch (typeof chunk) {
    // string defaulting to html
    case 'string':
      if (!this.get('Content-Type')) {
        this.type('html');
      }
      break;
    case 'boolean':
    case 'number':
    case 'object':
      if (chunk === null) {
        chunk = '';
      } else if (Buffer.isBuffer(chunk)) {
        if (!this.get('Content-Type')) {
          this.type('bin');
        }
      } else {
        return this.json(chunk);
      }
      break;
  }

  // write strings in utf-8
  if (typeof chunk === 'string') {
    encoding = 'utf8';
    type = this.get('Content-Type');

    // reflect this in content-type
    if (typeof type === 'string') {
      this.set('Content-Type', utils.setCharset(type, 'utf-8'));
    }
  }

  // determine if ETag should be generated
  var etagFn = settings.etagFn;
  var generateETag = !this.get('ETag') && typeof etagFn === 'function';

  // populate Content-Length
  var len;
  if (chunk !== undefined) {
    if (Buffer.isBuffer(chunk)) {
      len = chunk.length;
    } else if (!generateETag && chunk.length < 1000) {
      // just calculate length when no ETag + small chunk
      len = Buffer.byteLength(chunk, encoding);
    } else {
      // convert chunk to Buffer and calculate
      chunk = Buffer.from(chunk, encoding);
      encoding = undefined;
      len = chunk.length;
    }

    this.set('Content-Length', len);
  }

  // populate ETag
  var etag;
  if (generateETag && len !== undefined) {
    if ((etag = etagFn(chunk, encoding))) {
      this.set('ETag', etag);
    }
  }

  // freshness
  if (req.fresh) { this.statusCode = 304; }

  // strip irrelevant headers
  if (204 === this.statusCode || 304 === this.statusCode) {
    this.removeHeader('Content-Type');
    this.removeHeader('Content-Length');
    this.removeHeader('Transfer-Encoding');
    chunk = '';
  }

  // alter headers for 205
  if (this.statusCode === 205) {
    this.set('Content-Length', '0');
    this.removeHeader('Transfer-Encoding');
    chunk = '';
  }

  if (req.method === 'HEAD') {
    // skip body for HEAD
    this.end();
  } else {
    this.end(chunk, encoding);
  }

  return this;
};


/**
 * Send JSON response.
 *
 * @param {string|number|boolean|object} obj
 */
res.json = function json(obj) {
  var val = obj;

  // allow status / body
  if (arguments.length === 2) {
    if (typeof arguments[1] === 'number') {
      this.statusCode = arguments[1];
    } else {
      this.statusCode = arguments[0];
      val = arguments[1];
    }
  }

  var settings = this._sailsHttpSettings;
  var body = stringify(val, settings.jsonReplacer, settings.jsonSpaces, settings.jsonEscape);

  if (!this.get('Content-Type')) {
    this.set('Content-Type', 'application/json');
  }

  return this.send(body);
};


/**
 * Send JSON response with JSONP callback support.
 *
 * @param {string|number|boolean|object} obj
 */
res.jsonp = function jsonp(obj) {
  var val = obj;

  // allow status / body
  if (arguments.length === 2) {
    if (typeof arguments[1] === 'number') {
      this.statusCode = arguments[1];
    } else {
      this.statusCode = arguments[0];
      val = arguments[1];
    }
  }

  var settings = this._sailsHttpSettings;
  var body = stringify(val, settings.jsonReplacer, settings.jsonSpaces, settings.jsonEscape);
  var callback = this.req.query[settings.jsonpCallbackName];

  if (!this.get('Content-Type')) {
    this.set('X-Content-Type-Options', 'nosniff');
    this.set('Content-Type', 'application/json');
  }

  // fixup callback
  if (Array.isArray(callback)) {
    callback = callback[0];
  }

  if (typeof callback === 'string' && callback.length !== 0) {
    this.set('X-Content-Type-Options', 'nosniff');
    this.set('Content-Type', 'text/javascript');

    // restrict callback charset
    callback = callback.replace(/[^\[\]\w$.]/g, '');

    if (body === undefined) {
      body = '';
    } else if (typeof body === 'string') {
      // replace chars not allowed in JavaScript that are in JSON
      body = body
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    }

    // the /**/ is a specific security mitigation for "Rosetta Flash JSONP abuse"
    // the typeof check is just to reduce client error noise
    body = '/**/ typeof ' + callback + ' === \'function\' && ' + callback + '(' + body + ');';
  }

  return this.send(body);
};


res.sendStatus = function sendStatus(statusCode) {
  var body = statuses.message[statusCode] || String(statusCode);

  this.statusCode = statusCode;
  this.type('txt');

  return this.send(body);
};


/**
 * Transfer the file at the given `path`.
 */
res.sendFile = function sendFile(path, options, callback) {
  var done = callback;
  var req = this.req;
  var res = this;
  var next = req.next;
  var opts = options || {};

  if (!path) {
    throw new TypeError('path argument is required to res.sendFile');
  }

  if (typeof path !== 'string') {
    throw new TypeError('path must be a string to res.sendFile');
  }

  // support function as second arg
  if (typeof options === 'function') {
    done = options;
    opts = {};
  }

  if (!opts.root && !utils.isAbsolute(path)) {
    throw new TypeError('path must be absolute or specify root to res.sendFile');
  }

  var pathname = encodeURI(path);
  var file = send(req, pathname, opts);

  sendfile(res, file, opts, function (err) {
    if (done) { return done(err); }
    if (err && err.code === 'EISDIR') { return next(); }

    // next() all but write errors
    if (err && err.code !== 'ECONNABORTED' && err.syscall !== 'write') {
      return next(err);
    }
  });
};

res.sendfile = function (path, options, callback) {
  var done = callback;
  var req = this.req;
  var res = this;
  var next = req.next;
  var opts = options || {};

  if (typeof options === 'function') {
    done = options;
    opts = {};
  }

  var file = send(req, path, opts);

  sendfile(res, file, opts, function (err) {
    if (done) { return done(err); }
    if (err && err.code === 'EISDIR') { return next(); }

    if (err && err.code !== 'ECONNABORTED' && err.syscall !== 'write') {
      return next(err);
    }
  });
};


/**
 * Transfer the file at the given `path` as an attachment.
 */
res.download = function download (path, filename, options, callback) {
  var done = callback;
  var name = filename;
  var opts = options || null;

  // support function as second or third arg
  if (typeof filename === 'function') {
    done = filename;
    name = null;
    opts = null;
  } else if (typeof options === 'function') {
    done = options;
    opts = null;
  }

  // support optional filename, where options may be in it's place
  if (typeof filename === 'object' &&
    (typeof options === 'function' || options === undefined)) {
    name = null;
    opts = filename;
  }

  var headers = {
    'Content-Disposition': contentDisposition(name || path)
  };

  // merge user-provided headers
  if (opts && opts.headers) {
    var keys = Object.keys(opts.headers);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key.toLowerCase() !== 'content-disposition') {
        headers[key] = opts.headers[key];
      }
    }
  }

  // merge user-provided options
  opts = Object.create(opts);
  opts.headers = headers;

  var fullPath = !opts.root ? resolve(path) : path;

  return this.sendFile(fullPath, opts, done);
};


/**
 * Set _Content-Type_ response header with `type` through `mime.lookup()`
 * when it does not contain "/", or set the Content-Type to `type` otherwise.
 */
res.contentType =
res.type = function contentType(type) {
  var ct = type.indexOf('/') === -1 ? mime.lookup(type) : type;

  return this.set('Content-Type', ct);
};


/**
 * Respond to the Acceptable formats using an `obj` of mime-type callbacks.
 */
res.format = function(obj){
  var req = this.req;
  var next = req.next;

  var keys = Object.keys(obj)
    .filter(function (v) { return v !== 'default'; });

  var key = keys.length > 0 ? req.accepts(keys) : false;

  this.vary('Accept');

  if (key) {
    this.set('Content-Type', utils.normalizeType(key).value);
    obj[key](req, this, next);
  } else if (obj.default) {
    obj.default(req, this, next);
  } else {
    next(createError(406, {// eslint-disable-line callback-return
      types: utils.normalizeTypes(keys).map(function (o) { return o.value; })
    }));
  }

  return this;
};


res.attachment = function attachment(filename) {
  if (filename) {
    this.type(extname(filename));
  }

  this.set('Content-Disposition', contentDisposition(filename));

  return this;
};


res.append = function append(field, val) {
  var prev = this.get(field);
  var value = val;

  if (prev) {
    // concat the new and prev vals
    value = Array.isArray(prev) ? prev.concat(val)
      : Array.isArray(val) ? [prev].concat(val)
        : [prev, val];
  }

  return this.set(field, value);
};


/**
 * Set header `field` to `val`, or pass an object of header fields.
 */
res.set =
res.header = function header(field, val) {
  if (arguments.length === 2) {
    var value = Array.isArray(val) ? val.map(String) : String(val);

    // add charset to content-type
    if (field.toLowerCase() === 'content-type') {
      if (Array.isArray(value)) {
        throw new TypeError('Content-Type cannot be set to an Array');
      }
      if (!charsetRegExp.test(value)) {
        var charset = mime.charsets.lookup(value.split(';')[0]);
        if (charset) { value += '; charset=' + charset.toLowerCase(); }
      }
    }

    this.setHeader(field, value);
  } else {
    for (var key in field) {
      this.set(key, field[key]);
    }
  }
  return this;
};


res.get = function(field){
  return this.getHeader(field);
};


res.clearCookie = function clearCookie(name, options) {
  var opts = Object.assign({ expires: new Date(1), path: '/' }, options);

  return this.cookie(name, '', opts);
};


/**
 * Set cookie `name` to `value`, with the given `options`.
 */
res.cookie = function (name, value, options) {
  var opts = Object.assign({}, options);
  var secret = this.req.secret;
  var signed = opts.signed;

  if (signed && !secret) {
    throw new Error('cookieParser("secret") required for signed cookies');
  }

  var val = typeof value === 'object' ? 'j:' + JSON.stringify(value) : String(value);

  if (signed) {
    val = 's:' + sign(val, secret);
  }

  if (opts.maxAge !== null && opts.maxAge !== undefined) {
    var maxAge = opts.maxAge - 0;

    if (!isNaN(maxAge)) {
      opts.expires = new Date(Date.now() + maxAge);
      opts.maxAge = Math.floor(maxAge / 1000);
    }
  }

  if (opts.path === null || opts.path === undefined) {
    opts.path = '/';
  }

  this.append('Set-Cookie', cookie.serialize(name, String(val), opts));

  return this;
};


/**
 * Set the location header to `url`.  ("back" redirects to the referrer or "/".)
 */
res.location = function location(url) {
  var loc;

  if (url === 'back') {
    loc = this.req.get('Referrer') || '/';
  } else {
    loc = String(url);
  }

  return this.set('Location', encodeUrl(loc));
};


/**
 * Redirect to the given `url` with optional response `status` defaulting to 302.
 */
res.redirect = function redirect(url) {
  var address = url;
  var body;
  var status = 302;

  // allow status / url
  if (arguments.length === 2) {
    if (typeof arguments[0] === 'number') {
      status = arguments[0];
      address = arguments[1];
    } else {
      status = arguments[1];
    }
  }

  address = this.location(address).get('Location');

  // Support text/{plain,html} by default
  this.format({
    text: function(){
      body = statuses.message[status] + '. Redirecting to ' + address;
    },

    html: function(){
      var u = escapeHtml(address);
      body = '<p>' + statuses.message[status] + '. Redirecting to ' + u + '</p>';
    },

    default: function(){
      body = '';
    }
  });

  this.statusCode = status;
  this.set('Content-Length', Buffer.byteLength(body));

  if (this.req.method === 'HEAD') {
    this.end();
  } else {
    this.end(body);
  }
};


res.vary = function(field){
  if (!field || (Array.isArray(field) && !field.length)) {
    return this;
  }

  vary(this, field);

  return this;
};


/**
 * Render `view` with the given `options` and optional callback `fn`.
 * When a callback function is given a response will _not_ be made
 * automatically, otherwise a response of _200_ and _text/html_ is given.
 */
res.render = function render(view, options, callback) {
  var done = callback;
  var opts = options || {};
  var req = this.req;
  var self = this;
  var renderView = this._sailsHttpSettings.render;

  // support callback function as second arg
  if (typeof options === 'function') {
    done = options;
    opts = {};
  }

  // merge res.locals
  opts._locals = self.locals;

  // default callback to respond
  done = done || function (err, str) {
    if (err) { return req.next(err); }
    self.send(str);
  };

  if (typeof renderView !== 'function') {
    return done(new Error('No view engine is configured for this app (the `views` hook is disabled), so `res.render()` is not available.'));
  }

  renderView(view, opts, done);
};


// pipe the send file stream
function sendfile(res, file, options, callback) {
  var done = false;
  var streaming;

  function onaborted() {
    if (done) { return; }
    done = true;

    var err = new Error('Request aborted');
    err.code = 'ECONNABORTED';
    callback(err);
  }

  function ondirectory() {
    if (done) { return; }
    done = true;

    var err = new Error('EISDIR, read');
    err.code = 'EISDIR';
    callback(err);
  }

  function onerror(err) {
    if (done) { return; }
    done = true;
    callback(err);
  }

  function onend() {
    if (done) { return; }
    done = true;
    callback();
  }

  function onfile() {
    streaming = false;
  }

  function onfinish(err) {
    if (err && err.code === 'ECONNRESET') { return onaborted(); }
    if (err) { return onerror(err); }
    if (done) { return; }

    setImmediate(function () {
      if (streaming !== false && !done) {
        onaborted();
        return;
      }

      if (done) { return; }
      done = true;
      callback();
    });
  }

  function onstream() {
    streaming = true;
  }

  file.on('directory', ondirectory);
  file.on('end', onend);
  file.on('error', onerror);
  file.on('file', onfile);
  file.on('stream', onstream);
  onFinished(res, onfinish);

  if (options.headers) {
    // set headers on successful transfer
    file.on('headers', function headers(res) {
      var obj = options.headers;
      var keys = Object.keys(obj);

      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        res.setHeader(k, obj[k]);
      }
    });
  }

  file.pipe(res);
}


/**
 * Stringify JSON, with the ability to escape characters that can trigger HTML sniffing.
 */
function stringify (value, replacer, spaces, escape) {
  var json = replacer || spaces ? JSON.stringify(value, replacer, spaces) : JSON.stringify(value);

  if (escape && typeof json === 'string') {
    json = json.replace(/[<>&]/g, function (c) {
      switch (c.charCodeAt(0)) {
        case 0x3c:
          return '\\u003c';
        case 0x3e:
          return '\\u003e';
        case 0x26:
          return '\\u0026';
        default:
          return c;
      }
    });
  }

  return json;
}
