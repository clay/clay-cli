'use strict';

const { getWebpackConfig } = require('../lib/cmd/pack');
const log = require('./log').setup({ file: __filename });
const webpack = require('webpack');

function builder(yargs) {
  return yargs
    .usage('Usage: $0 [entries..]')
    .example('$0 "./components/init.js" "global/index.js"', 'Compile entrypoints for components and globals.')
    .positional('entries', {
      array: true,
      alias: ['e'],
      default: [],
      description: 'list of glob patterns to compile',
      type: 'array'
    }).option('watch', {
      alias: ['w'],
      default: false,
      description: 'watch for changes and rebuild',
      type: 'boolean'
    }).option('environment', {
      alias: ['e', 'env'],
      choices: ['development', 'production'],
      default: 'development',
      description: 'webpack environment',
      requiresArg: true,
      type: 'string'
    });
}

/**
 * Run a one-off Webpack build.
 *
 * @param {webpack.Compiler} webpackCompiler - A configured Webpack compiler
 *    instance.
 * @returns {Promise} - A Promise that resolves when the compilation is
 *    complete.
 */
function handleAssetBuild(webpackCompiler) {
  return new Promise((resolve, reject) => {
    webpackCompiler.run((err, stats) => {
      if (err) {
        return reject(err);
      }

      if (stats.hasErrors()) {
        const msg = stats.toString('errors-only');

        return reject(new Error(msg));
      }

      resolve(webpackCompiler);
    });
  }).then(compiler => {
    compiler.close(error => {
      if (error) {
        throw error;
      }
    });
  }).catch(error => {
    log('error', 'Webpack compilation failed', {
      message: error.message,
      stack: error.stack
    });

    throw error;
  });
}

/**
 * Run a Webpack build.
 *
 * @param {webpack.Compiler} webpackCompiler - A configured Webpack compiler
 *    instance.
 * @returns {Promise} - A Promise that resolves when the live compilation is
 *    terminated.
 */
function handleAssetWatch(webpackCompiler) {
  return new Promise((resolve, reject) => {
    const watchingInstance = webpackCompiler.watch((err, stats) => {
      if (err) {
        return reject(err);
      }

      if (stats.hasErrors()) {
        const msg = stats.toString('errors-only');

        return reject(new Error(msg));
      }
    });

    resolve(watchingInstance);
  }).then(watching => {
    process.on('exit', () => {
      watching.close(error => {
        if (error) {
          throw error;
        }
      });
    });
  }).catch(error => {
    log('error', 'Webpack compilation failed', {
      message: error.message,
      stack: error.stack
    });

    throw error;
  });
}

function handler(argv) {
  const config = getWebpackConfig(argv).toConfig();
  const compiler = webpack(config);
  const builder = argv.watch ? handleAssetWatch.bind(null, compiler) : handleAssetBuild.bind(null, compiler);

  return builder()
    .catch(err => {
      log('error', 'Asset compilation failed', {
        message: err.message,
        stack: err.stack
      });

      throw err;
    });
}

exports.aliases = ['p'];
exports.builder = builder;
exports.command = 'pack';
exports.describe = 'Compile Webpack assets';
exports.handler = handler;
