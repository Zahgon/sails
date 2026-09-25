/**
 * Module dependencies
 */

var http = require('http');
var isIP = require('net').isIP;
var accepts = require('accepts');
var typeis = require('type-is');
var fresh = require('fresh');
var parseRange = require('range-parser');
var parseurl = require('parseurl');
var proxyaddr = require('proxy-addr');


/**
 * Base prototype for incoming HTTP requests handled by Sails.
 *
 * Fastify hands the raw Node.js `http.IncomingMessage` to Sails' request pipeline.
 * Since Sails apps, hooks, and connect-style middleware (`sails.config.http.middleware`)
 * rely on the conventional `req` helpers (e.g. `req.get()`, `req.ip`, `req.accepts()`),
 * those helpers are provided here and mixed into each raw request (see `./initialize.js`).
 *
 * The helpers below are adapted from the MIT-licensed implementation in Express 4
 * (Copyright(c) 2009-2013 TJ Holowaychuk, 2013 Roman Shtylman, 2014-2015 Douglas Christopher Wilson),
 * with app settings read from `this._sailsHttpSettings` instead of an Express app.
 *
 * @type {Dictionary}
 */

var req = Object.create(http.IncomingMessage.prototype);

module.exports = req;


/**
 * Return request header.  (`Referrer` and `Referer` are interchangeable.)
 *
 * @param {String} name
 * @return {String}
 */
req.get =
req.header = function header(name) {
  if (!name) {
    throw new TypeError('name argument is required to req.get');
  }

  if (typeof name !== 'string') {
    throw new TypeError('name must be a string to req.get');
  }

  var lc = name.toLowerCase();

  switch (lc) {
    case 'referer':
    case 'referrer':
      return this.headers.referrer || this.headers.referer;
    default:
      return this.headers[lc];
  }
};


/**
 * Content negotiation helpers.
 */
req.accepts = function(){
  var accept = accepts(this);
  return accept.types.apply(accept, arguments);
};

req.acceptsEncodings = function(){
  var accept = accepts(this);
  return accept.encodings.apply(accept, arguments);
};
req.acceptsEncoding = req.acceptsEncodings;

req.acceptsCharsets = function(){
  var accept = accepts(this);
  return accept.charsets.apply(accept, arguments);
};
req.acceptsCharset = req.acceptsCharsets;

req.acceptsLanguages = function(){
  var accept = accepts(this);
  return accept.languages.apply(accept, arguments);
};
req.acceptsLanguage = req.acceptsLanguages;


/**
 * Parse Range header field, capping to the given `size`.
 *
 * @param {number} size
 * @param {object} [options]
 * @return {number|array}
 */
req.range = function range(size, options) {
  var range = this.get('Range');
  if (!range) { return; }
  return parseRange(size, range, options);
};


/**
 * Return the value of param `name` when present or `defaultValue`.
 * (Checks route params, then body, then query string.)
 *
 * @param {String} name
 * @param {Mixed} [defaultValue]
 * @return {String}
 */
req.param = function param(name, defaultValue) {
  var params = this.params || {};
  var body = this.body || {};
  var query = this.query || {};

  if (null !== params[name] && undefined !== params[name] && Object.prototype.hasOwnProperty.call(params, name)) { return params[name]; }
  if (null !== body[name] && undefined !== body[name]) { return body[name]; }
  if (null !== query[name] && undefined !== query[name]) { return query[name]; }

  return defaultValue;
};


/**
 * Check if the incoming request contains the "Content-Type"
 * header field, and it contains the given mime `type`.
 *
 * @param {String|Array} types...
 * @return {String|false|null}
 */
req.is = function is(types) {
  var arr = types;

  // support flattened arguments
  if (!Array.isArray(types)) {
    arr = new Array(arguments.length);
    for (var i = 0; i < arr.length; i++) {
      arr[i] = arguments[i];
    }
  }

  return typeis(this, arr);
};


/**
 * Return the protocol string "http" or "https".
 * (When `sails.config.http.trustProxy` trusts the socket address,
 * the "X-Forwarded-Proto" header field will be used if present.)
 *
 * @return {String}
 */
defineGetter(req, 'protocol', function protocol(){
  var proto = this.connection.encrypted ? 'https' : 'http';
  var trust = this._sailsHttpSettings.trustProxyFn;

  if (!trust(this.connection.remoteAddress, 0)) {
    return proto;
  }

  // Note: X-Forwarded-Proto is normally only ever a
  //       single value, but this is to be safe.
  var header = this.get('X-Forwarded-Proto') || proto;
  var index = header.indexOf(',');

  return index !== -1 ? header.substring(0, index).trim() : header.trim();
});


defineGetter(req, 'secure', function secure(){
  return this.protocol === 'https';
});


/**
 * Return the remote address from the trusted proxy.
 *
 * @return {String}
 */
defineGetter(req, 'ip', function ip(){
  var trust = this._sailsHttpSettings.trustProxyFn;
  return proxyaddr(this, trust);
});


/**
 * When "trust proxy" is set, trusted proxy addresses + client.
 *
 * @return {Array}
 */
defineGetter(req, 'ips', function ips() {
  var trust = this._sailsHttpSettings.trustProxyFn;
  var addrs = proxyaddr.all(this, trust);

  // reverse the order (to farthest -> closest)
  // and remove socket address
  addrs.reverse().pop();

  return addrs;
});


/**
 * Return subdomains as an array.
 *
 * @return {Array}
 */
defineGetter(req, 'subdomains', function subdomains() {
  var hostname = this.hostname;

  if (!hostname) { return []; }

  var offset = this._sailsHttpSettings.subdomainOffset;
  var subdomains = !isIP(hostname) ? hostname.split('.').reverse() : [hostname];

  return subdomains.slice(offset);
});


/**
 * Short-hand for `url.parse(req.url).pathname`.
 *
 * @return {String}
 */
defineGetter(req, 'path', function path() {
  return parseurl(this).pathname;
});


/**
 * Parse the "Host" header field to a hostname.
 * (When the "trust proxy" setting trusts the socket address,
 * the "X-Forwarded-Host" header field will be trusted.)
 *
 * @return {String}
 */
defineGetter(req, 'hostname', function hostname(){
  var trust = this._sailsHttpSettings.trustProxyFn;
  var host = this.get('X-Forwarded-Host');

  if (!host || !trust(this.connection.remoteAddress, 0)) {
    host = this.get('Host');
  } else if (host.indexOf(',') !== -1) {
    // Note: X-Forwarded-Host is normally only ever a
    //       single value, but this is to be safe.
    host = host.substring(0, host.indexOf(',')).trimRight();
  }

  if (!host) { return; }

  // IPv6 literal support
  var offset = host[0] === '[' ? host.indexOf(']') + 1 : 0;
  var index = host.indexOf(':', offset);

  return index !== -1 ? host.substring(0, index) : host;
});

defineGetter(req, 'host', function host(){
  return this.hostname;
});


/**
 * Check if the request is fresh, aka Last-Modified and/or the ETag still match.
 *
 * @return {Boolean}
 */
defineGetter(req, 'fresh', function(){
  var method = this.method;
  var res = this.res;
  var status = res.statusCode;

  // GET or HEAD for weak freshness validation only
  if ('GET' !== method && 'HEAD' !== method) { return false; }

  // 2xx or 304 as per rfc2616 14.26
  if ((status >= 200 && status < 300) || 304 === status) {
    return fresh(this.headers, {
      'etag': res.get('ETag'),
      'last-modified': res.get('Last-Modified')
    });
  }

  return false;
});


defineGetter(req, 'stale', function stale(){
  return !this.fresh;
});


/**
 * Check if the request was an _XMLHttpRequest_.
 *
 * @return {Boolean}
 */
defineGetter(req, 'xhr', function xhr(){
  var val = this.get('X-Requested-With') || '';
  return val.toLowerCase() === 'xmlhttprequest';
});


function defineGetter(obj, name, getter) {
  Object.defineProperty(obj, name, {
    configurable: true,
    enumerable: true,
    get: getter
  });
}
