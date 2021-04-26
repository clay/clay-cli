'use strict';

/**
 * For client-side scripts that expose a function, require each script and pass
 * the function its element.
 *
 * @returns {Promise} A Promise that resolves when all async modules are loaded.
 */
function mountComponentModules() {
  const promises = Object.keys(__webpack_modules__)
    .filter(moduleName => /components/.test(moduleName))
    .reduce((p, moduleName) => {
      const nameExp = /components\/([-A-za-z]+)\//ig.exec(moduleName);

      if (!nameExp) return p;

      const name = nameExp[1];
      const instancesSelector = `[data-uri*="_components/${name}"]`;
      const instances = Array.from(document.querySelectorAll(instancesSelector));

      if (!instances.length) return p;

      const importedModule = __webpack_require__(moduleName);
      const mod = __webpack_require__.n(importedModule)();

      if (!mod) return p;

      const nextPromises = instances
        .map(el => {
          return Promise.resolve()
            .then(() => mod(el))
            .catch(err => {
              const elementTag = el.outerHTML.slice(0, el.outerHTML.indexOf(el.innerHTML));

              console.error(`Error initializing controller for "${name}" on "${elementTag}"`, err);
            });
        });

      return p.concat(nextPromises);
    }, []);

  return Promise.all(promises);
}

global.__webpack = {
  baseURI: __webpack_base_uri__,
  chunkLoad: __webpack_chunk_load__,
  exportsInfo: __webpack_exports_info__,
  hash: __webpack_hash__,
  modules: __webpack_modules__,
  publicPath: __webpack_public_path__,
  require: __webpack_require__,
  runtimeID: __webpack_runtime_id__,
}

mountComponentModules();