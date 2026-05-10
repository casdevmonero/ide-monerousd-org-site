/* Monaco ESM shim — DO NOT IMPORT.
 * Monaco is loaded via the AMD path now (vs/loader.js). v1.2.182 fix.
 * The ESM bundle's CSS-imports broke under native browser ESM; the
 * AMD bundle handles CSS via injected <link> tags and is the canonical
 * bundler-free integration path. See scripts/vendor-monaco.sh + the
 * loadMonaco() function in components/editor.js for the actual flow.
 */
throw new Error('monaco.esm.js is a shim — load via vs/loader.js (AMD)');
