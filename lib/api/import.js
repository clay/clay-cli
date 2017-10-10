const clayInput = require('../io/input-clay'),
  h = require('highland'),
  _ = require('lodash'),
  deepEqual = require('deep-equal'),
  urlUtil = require('../utils/urls'),
  chunksUtil = require('../io/agnostic-chunks'),
  clayUtils = require('clay-utils'),
  rest = require('../utils/rest'),
  files = require('../io/input-files'),
  {createStream} = require('../utils/stream-util'),
  lib = module.exports; // for stubbing internal functions

/**
* Stream Clay assets necessary for the import of URLs to a specified site, excluding
* assets based on specified overwrite rules. Assets are of the form
* {url: string, data: Object, isLayout: boolean, skip: boolean}
* @param {Stream|string[]|string} sourceUrls Stream or array of URLs or single URL
* @param {string} targetSite Prefix of target site
* @param {object} [opts]
* @param {number} [opts.concurrency]
* @param {string} [opts.key] Authorization key for target site
* @param {object} [opts.headers] Custom headers for requests to target site
* @param {string[]} [opts.overwrite] Array of resource types to overwrite
* @return {Stream}
**/
function streamAssetsForImport(sourceUrls, targetSite, {concurrency, headers, overwrite} = {}) {
  if (overwrite) assertValidOverwrite(overwrite);
  // stream Clay assets ({url, data, isLayout}) for each url
  return clayInput.streamAssets(sourceUrls, concurrency)
    // replace prefixes throughout assets
    .flatMap(chunksUtil.replacePrefixes(targetSite))
    // mark assets for skipping according to "overwrite" setting
    .flatMap(asset => filterOverwrite(asset, overwrite, {concurrency, headers}));
}

function putAssets({key, concurrency, headers}) {
  return (clayAsset) => clayAsset.skip ?
    h.of({url: clayAsset.url, status: 'skipped'}) :
    rest.put(clayAsset, {
      key,
      concurrency,
      headers,
      type: _.includes(clayAsset.url, '/uris') ? 'text' : 'json'
    });
}

/**
* Validate an overwrite value.
* @param {string[]} overwrite
*/
function assertValidOverwrite(overwrite) {
  const acceptedTypes = ['lists', 'components', 'pages', 'layouts', 'all', 'users', 'none'],
    unrecognized = overwrite.filter(i => !acceptedTypes.includes(i)).join(', ');

  if (unrecognized) {
    throw new Error(`filterOverwrite does not recognize these types: ${unrecognized}`);
  }
  if ((overwrite.includes('all') || overwrite.includes('none')) && overwrite.length > 1) {
    throw new Error('Over-specified: If "all" is passed to filterOverwrite, no other types may be passed');
  }
  if (overwrite.includes('layouts') && !overwrite.includes('components')) {
    throw new Error('Under-specified: If "layouts" is passed to filterOverwrite, "components" must also be passed; layouts are components');
  }
}

/**
* Flag the specified asset for skipping based on the specified overwrite mode
* @param {Object} asset Clay asset in the form {url, data, isLayout}
* @param {string[]} overwrite Can incl. "lists", "components", "pages", "layouts", "users" and "all"
* @param {Object} [opts]
* @param {number} [opts.concurrency]
* @param {Object} [opts.headers]
* @returns {Stream} With items removed
*/
function filterOverwrite(asset, overwrite = [], {concurrency} = {}) {

  // keep everything
  if (overwrite.includes('all')) {
    return h.of(asset);
  } else if (shouldCheckExisting(asset, overwrite)) {
    return checkExisting(asset, {concurrency});
  } else if (shouldMergeExisting(asset, overwrite)) {
    return mergeExisting(asset, {concurrency});
  }
  return h.of(asset);
}

/**
* Determine if we should check the asset with the specified URL for an existing
* asset before PUT-ting it.
* @param {Object} asset
* @param {Object} overwrite
* @return {boolean}
**/
function shouldCheckExisting(asset, overwrite) {
  const {url, isLayout} = asset;

  return clayUtils.isComponent(url) && !overwrite.includes('components') ||
    clayUtils.isPage(url) && !overwrite.includes('pages') ||
    isLayout && !overwrite.includes('layouts') ||
    clayUtils.isUser(url) && !overwrite.includes('users') ||
    overwrite.includes('none');
}

/**
* Determine if we should check the asset with the specified URL
* considering the specified overwrite mode
* @param {Object} asset
* @param {Object} overwrite
* @return {boolean}
**/
function shouldMergeExisting(asset, overwrite) {
  return clayUtils.isList(asset.url) && !overwrite.includes('lists') ||
    overwrite.includes('none');
}

/**
* Given a Clay asset {url, data} object, if the asset already exists,
* merge its current data into the asset object.
* @param {Object} item of the form {url: string, data: object}
* @param {Object} [opts]
* @param {number} [opts.concurrency]
* @return {Stream}
**/
function mergeExisting(item, {concurrency} = {}) {
  if (item.skip) return h.of(item);

  return rest.get(item.url, {concurrency, type: 'json'})
    .errors(rest.pass404(() => [])) // if list 404s, act as if empty
    .map(targetList => item.data.concat(targetList))
    .sequence() // (flatten only one level, in case there are lists of lists)
    .uniqBy(deepEqual) // remove dups between source and target
    .collect()
    .map(i => {
      item.data = i;
      return item;
    });
}

/**
 * Given a Clay asset {url, data} object, set "skip" property
 * to true if the asset already exists.
 * @param {Object} item of the form {url: string, data: object}
 * @param {Object} [opts]
 * @param {number} [opts.concurrency]
 * @return {Stream}
 */
function checkExisting(item, {concurrency} = {}) {
  if (item.skip) return h.of(item); // already marked for skipping
  return rest.get(item.url, {concurrency, type: 'json'})
    .errors(rest.pass404(() => 404))
    .map(i => {
      if (i !== 404) item.skip = true;
      return item;
    });
}

/**
 * Import data from a single Clay asset url into the target site.
 * @param {Stream|string[]|string} sourceUrl Stream or array of URLs, or single URL
 * @param {string} targetSite Prefix of target site
 * @param {object} [opts]
 * @param {number} [opts.concurrency]
 * @param {string} [opts.key] Authorization key for target site
 * @param {object} [opts.headers] Custom headers for requests to target site
 * @param {string[]} [opts.overwrite] Overwrite mode
 * @return {Stream}
 */
function importUrl(sourceUrl, targetSite, {concurrency, key, headers, overwrite} = {}) {
  return streamAssetsForImport(sourceUrl, targetSite, {concurrency, headers, overwrite})
    .flatMap(putAssets({key, concurrency, type: 'json', headers}));
}

/**
 * Import all or a subset of pages from one site to another.
 * @param {string} sourceSite Prefix of source site
 * @param {string} targetSite Prefix of target site
 * @param {object} [opts]
 * @param {number} [opts.limit] Number of pages to import
 * @param {number} [opts.offset] Number of pages in source site to skip
 * @param {number} [opts.concurrency]
 * @param {number} [opts.key] Authorization key of target site
 * @param {number} [opts.sourceKey] Authorization key of sour1ce site
 * @param {boolean} [opts.published] Include published pages
 * @param {string[]} [opts.overwrite] Overwrite mode
 * @return {Stream} of rest.put {status: string, url: string} objects
 */
function importPages(sourceSite, targetSite, {limit, offset, concurrency, key, sourceKey, published, overwrite, headers} = {}) {
  return clayInput.streamPageUris(sourceSite, {key: sourceKey, limit, offset})
    // unless published is set, filter out all published URIs
    .filter(pageUri => published || clayUtils.getPageVersion(pageUri) !== 'published')
    .map(pageUri => urlUtil.uriToUrl(sourceSite, pageUri))
    .through(urlStream => lib.importUrl(urlStream, targetSite, {concurrency, key, overwrite, headers}));
}

/**
 * Import lists from one site to another. Merge with existing lists unless opts.overwrite is true.
 * @param {string} sourceSite Prefix of source site
 * @param {string} targetSite Prefix of target site
 * @param {object} [opts]
 * @param {string} [opts.key] Authorization key of target site
 * @param {number} [opts.concurrency]
 * @param {boolean} [opts.overwrite] Overwrite lists instead of merging them
 * @param {Object} [opts.headers] Custom headers for PUT requests
 * @return {Stream} of rest.put results, i.e. {status: string, url: string} objects
 */
function importLists(sourceSite, targetSite, {key, concurrency, headers, overwrite} = {}) {
  return clayInput.streamListUris(sourceSite)
    .map(listUri => urlUtil.uriToUrl(sourceSite, listUri))
    .flatMap(listUrl => lib.importUrl(`${listUrl}`, targetSite, {key, concurrency, headers, overwrite}));
}

/**
 * Import lists from one site to another. Merge with existing lists unless opts.overwrite is true.
 * @param {string} sourceSite Prefix of source site
 * @param {string} targetSite Prefix of target site
 * @param {object} [opts]
 * @param {string} [opts.key] Authorization key of target site
 * @param {number} [opts.concurrency]
 * @param {boolean} [opts.overwrite] Overwrite lists instead of merging them
 * @param {Object} [opts.headers] Custom headers for PUT requests
 * @return {Stream} of rest.put results, i.e. {status: string, url: string} objects
 */
function importUsers(sourceSite, targetSite, {key, concurrency, headers, overwrite} = {}) {
  return clayInput.streamUserUris(sourceSite)
    .map(userUri => urlUtil.uriToUrl(sourceSite, userUri))
    .flatMap(userUrl => lib.importUrl(`${userUrl}`, targetSite, {key, concurrency, headers, overwrite}));
}

/**
 * Import users from one site to another. Merge with existing lists unless opts.overwrite is true.
 * @param {string} sourceSite Prefix of source site
 * @param {string} targetSite Prefix of target site
 * @param {object} [opts]
 * @param {string} [opts.key] Authorization key of target site
 * @param {number} [opts.concurrency]
 * @param {boolean} [opts.overwrite] Overwrite lists instead of merging them
 * @param {Object} [opts.headers] Custom headers for PUT requests
 * @return {Stream} of rest.put results, i.e. {status: string, url: string} objects
 */
function importLists(sourceSite, targetSite, {key, concurrency, headers, overwrite} = {}) {
  return clayInput.streamListUris(sourceSite)
    .map(listUri => urlUtil.uriToUrl(sourceSite, listUri))
    .flatMap(listUrl => lib.importUrl(`${listUrl}`, targetSite, {key, concurrency, headers, overwrite}));
}

/**
 * Import all pages, including their components, and (optionally) all lists from one Clay site to another.
 * @param {string} sourceSite Prefix of source site
 * @param {string} targetSite Prefix of target site
 * @param {object} [opts]
 * @param {number} [opts.limit] Number of pages to import
 * @param {number} [opts.offset] Number of pages in source site to skip
 * @param {number} [opts.concurrency]
 * @param {number} [opts.key] Authorization key of target site
 * @param {number} [opts.sourceKey] Authorization key of source site (needed to query _search endpoint for pages)
 * @param {string[]} [opts.overwrite] Overwrite mode
 * @param {boolean} [opts.published] Include published pages
 * @param {headers} [opts.headers] Custom headers for PUT requests
 * @return {Stream} of rest.put {status: string, url: string} objects
 */
function importSite(sourceSite, targetSite, {limit, offset, concurrency, key, sourceKey, overwrite, published, headers} = {}) {
  return h([
    lib.importPages(sourceSite, targetSite, {
      limit, offset, concurrency, key, sourceKey, overwrite, published, headers
    }),
    lib.importLists(sourceSite, targetSite, {concurrency, key, overwrite})
  ]).mergeWithLimit(concurrency);
}

/**
 * Import data from YAML/JSON files.
 * @param  {string} filepath
 * @param  {string} targetSite Prefix of target site
 * @param  {object} [opts]
 * @param {string} [opts.key] Key of target site
 * @param {Object} [opts.headers] Custom headers for PUT requests
 * @param {number} [opts.concurrency]
 * @return {Stream} of rest.put {status: string, url: string} objects
 */
function importFile(filepath, targetSite, {key, headers, concurrency} = {}) {
  return files.get(filepath)
    .filter(files.omitSchemas)
    .through(chunkStream => importChunk(chunkStream, targetSite, {key, headers, concurrency}));
}

/**
 * Convert chunks in the form {[baseUri]: data} into {url, data}
 * asset objects
 * @param  {string} prefix
 * @return {function}
 */
function mapChunksToAssets(prefix) {
  const uriPrefix = urlUtil.urlToUri(prefix);

  return (chunk) => {
    const withPrefix = chunksUtil.fromChunk(uriPrefix, chunk),
      uri = Object.keys(withPrefix)[0],
      val = withPrefix[uri],
      data = _.isString(val) ? val : JSON.stringify(val), // val might be data or uri string
      url = urlUtil.uriToUrl(prefix, uri);

    return {url, data};
  };
}

/**
 * Import data from a stream or array of chunks, or single chunk.
 * A chunk is a {[baseUri]: data} object.
 * @param  {Stream|Object[]|Object} chunks
 * @param {string} targetSite
 * @param {string} [opts.key] Key of target site
 * @param {Object} [opts.headers] Custom headers for PUT requests
 * @param {number} [opts.concurrency]
 * @return {Stream}
 */
function importChunk(chunks, targetSite, {key, headers, concurrency} = {}) {
  return createStream(chunks)
    .map(chunksUtil.validate)
    .map(mapChunksToAssets(targetSite))
    .flatMap(putAssets({key, headers, concurrency}));
}

module.exports.importUrl = importUrl;
module.exports.importChunk = importChunk;
module.exports.importPages = importPages;
module.exports.importLists = importLists;
module.exports.importUsers = importUsers;
module.exports.importSite = importSite;
module.exports.importFile = importFile;