/**
 * Module dependencies
 */

var contentType = require('content-type');
var mime = require('send').mime;
var etag = require('etag');
var proxyaddr = require('proxy-addr');
var qs = require('qs');


/**
 * Low-level HTTP helpers used by Sails' request/response prototypes
 * (see `./request.js` and `./response.js`).
 *
 * Adapted from the MIT-licensed implementation in Express 4
 * (Copyright(c) 2009-2013 TJ Holowaychuk, Copyright(c) 2014-2015 Douglas Christopher Wilson),
 * so that `req`/`res` keep behaving exactly the same way they did before
 * Sails' HTTP server was moved onto Fastify.
 */


/**
 * Return weak ETag for `body`.
 *
 * @param {String|Buffer} body
 * @param {String} [encoding]
 * @return {String}
 */

exports.wetag = function generateWeakETag(body, encoding) {
  var buf = !Buffer.isBuffer(body) ? Buffer.from(body, encoding) : body;
  return etag(buf, { weak: true });
};


/**
 * Check if `path` looks absolute.
 *
 * @param {String} path
 * @return {Boolean}
 */

exports.isAbsolute = function(path){
  if ('/' === path[0]) { return true; }
  if (':' === path[1] && ('\\' === path[2] || '/' === path[2])) { return true; } // Windows device path
  if ('\\\\' === path.substring(0, 2)) { return true; } // Microsoft Azure absolute path
  return false;
};


/**
 * Normalize the given `type`, for example "html" becomes "text/html".
 *
 * @param {String} type
 * @return {Object}
 */

exports.normalizeType = function(type){
  return ~type.indexOf('/') ? acceptParams(type) : { value: mime.lookup(type), params: {} };
};


/**
 * Normalize `types`, for example "html" becomes "text/html".
 *
 * @param {Array} types
 * @return {Array}
 */

exports.normalizeTypes = function(types){
  var ret = [];
  for (var i = 0; i < types.length; ++i) {
    ret.push(exports.normalizeType(types[i]));
  }
  return ret;
};


/**
 * Parse accept params `str` returning an
 * object with `.value`, `.quality` and `.params`.
 *
 * @param {String} str
 * @return {Object}
 */

function acceptParams (str) {
  var parts = str.split(/ *; */);
  var ret = { value: parts[0], quality: 1, params: {} };

  for (var i = 1; i < parts.length; ++i) {
    var pms = parts[i].split(/ *= */);
    if ('q' === pms[0]) {
      ret.quality = parseFloat(pms[1]);
    } else {
      ret.params[pms[0]] = pms[1];
    }
  }

  return ret;
}


/**
 * Compile the `sails.config.http.trustProxy` setting into a function
 * suitable for use with `proxy-addr`.
 *
 * @param  {Boolean|String|Number|Array|Function} val
 * @return {Function}
 */

exports.compileTrust = function(val) {
  if (typeof val === 'function') { return val; }

  if (val === true) {
    // Support plain true/false
    return function(){ return true; };
  }

  if (typeof val === 'number') {
    // Support trusting hop count
    return function(a, i){ return i < val; };
  }

  if (typeof val === 'string') {
    // Support comma-separated values
    val = val.split(',').map(function (v) { return v.trim(); });
  }

  return proxyaddr.compile(val || []);
};


/**
 * Set the charset in a given Content-Type string.
 *
 * @param {String} type
 * @param {String} charset
 * @return {String}
 */

exports.setCharset = function setCharset(type, charset) {
  if (!type || !charset) {
    return type;
  }

  // parse type
  var parsed = contentType.parse(type);

  // set charset
  parsed.parameters.charset = charset;

  // format type
  return contentType.format(parsed);
};


/**
 * Parse a query string using the "extended" (qs) syntax.
 *
 * @param {String} str
 * @return {Object}
 */

exports.parseExtendedQueryString = function parseExtendedQueryString(str) {
  return qs.parse(str, {
    allowPrototypes: true,
    arrayLimit: 1000
  });
};
