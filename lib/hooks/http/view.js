/**
 * Module dependencies
 */

var path = require('path');
var glob = require('glob');
var isAbsolute = require('./utils').isAbsolute;



var globPath = function(viewPath) {
  // return glob.sync(path, {
  //  nocase: true
  // });
  return glob.sync(path.basename(viewPath), {
    cwd: path.dirname(viewPath),
    nocase: true
  });
};

/**
 * `exists()`
 *
 * Helper function to check existence of the specified path amongst the app's views.
 * @param  {String} viewPath
 * @return {Boolean}
 */
var exists = function(viewPath) {
  return globPath(viewPath).length > 0;
};


/**
 * @constructs {SailsView}
 *
 * A view (template file) located within the app's views directory.
 *
 * @param {String} name
 *        The relative path to the view (with or without a file extension).
 * @param {Dictionary} options
 *        @property {String} defaultEngine   the default file extension (e.g. "ejs")
 *        @property {String} root            the absolute path to the views directory
 *        @property {Dictionary} engines     map of file extensions (e.g. ".ejs") to rendering functions
 */
function SailsView (name, options) {
  var opts = options || {};

  this.defaultEngine = opts.defaultEngine;
  this.ext = path.extname(name);
  this.name = name;
  this.root = opts.root;

  if (!this.ext && !this.defaultEngine) {
    throw new Error('No default engine was specified and no extension was provided.');
  }

  var fileName = name;

  if (!this.ext) {
    this.ext = this.defaultEngine[0] !== '.' ? '.' + this.defaultEngine : this.defaultEngine;
    fileName += this.ext;
  }

  var engines = opts.engines || {};
  if (!engines[this.ext]) {
    throw new Error('No view engine is configured for files with the "'+this.ext+'" extension.');
  }

  this.engine = engines[this.ext];
  this.path = this.lookup(fileName);
}

SailsView.prototype.lookup = function(viewPath) {
  var viewExt = this.ext;
  var rootPath = this.root;

  // <path>.<engine>
  if (!isAbsolute(viewPath)) {
    viewPath = path.join(rootPath, viewPath);
  }
  if (exists(viewPath)) {
    return viewPath; //return globPath(viewPath)[0];
  }

  // <path>/index.<engine>
  viewPath = path.join(path.dirname(viewPath), path.basename(viewPath, viewExt), 'index' + viewExt);
  if (exists(viewPath)) {
    return viewPath; //return globPath(path)[0];
  }
};

/**
 * Render this view with the given options (locals).
 *
 * @param  {Dictionary} options
 * @param  {Function} callback
 */
SailsView.prototype.render = function(options, callback) {
  this.engine(this.path, options, callback);
};


module.exports = SailsView;
