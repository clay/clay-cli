/* eslint-env browser */

'use strict';

/**
 * A callback to pass to Webpack to mount the initial Clay components.
 * @callback mountComponentModulesCallback
 * @param {string} componentName - The name of the component to import.
 * @returns {Promise} - A Promise that resolves when the component has been imported.
 */

/**
 * Find all Clay components---DOM elements whose `data-uri` attribute
 * contains "_components/"---
 *
 * @param {mountComponentModulesCallback} callback
 * @returns {Promise} - A Promise that resolves when Webpack has finished
 *    initializing Clay components.
 */
function mountComponentModules(callback) {
  return Promise.resolve().then(() => {
    const componentSelector = '[data-uri*="_components/"]';
    const componentElements = Array.from(document.querySelectorAll(componentSelector));

    return componentElements;
  }).then(componentElements => {
    const componentPromises = componentElements.map(element => {
      const componentURI = element.dataset.uri;
      const [, name] = Array.from(/_components\/(.+?)(\/instances|$)/.exec(componentURI) || []);

      if (!name) {
        const err = new Error(`No component script found for ${ element } (at ${ componentURI }).`, {
          element,
          componentURI
        });

        console.error(err);

        return Promise.reject(err);
      };

      return Promise.resolve().then(() => {
        return callback(name);
      }).then(mod => mod && mod.default || mod)
        .then(mod => {
          if (typeof mod === 'function') {
            return mod(element);
          }
        }).then(() => {
          return `Mounted ${ componentURI } (${ name }).`;
        });
    });

    return Promise.allSettled(componentPromises);
  });
}

module.exports = mountComponentModules;
