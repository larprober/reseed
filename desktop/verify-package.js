'use strict';

/*
 * Asserts the packaged app actually contains what main.js requires.
 *
 * This exists because it did not once: chrome.js was added to the source but
 * never to the "files" list in package.json, so require('./chrome') threw on
 * startup and the app showed a JavaScript error dialog. The process still
 * lived, so a "is it running?" check said everything was fine.
 *
 * Run after electron-builder:  node verify-package.js
 */

const fs = require('fs');
const path = require('path');
const asarLib = require('@electron/asar');

const asar = path.join(__dirname, 'dist', 'win-unpacked', 'resources', 'app.asar');
if (!fs.existsSync(asar)) {
  console.error('verify-package: no app.asar at ' + asar);
  process.exit(1);
}

const present = new Set(
  asarLib.listPackage(asar).map((entry) =>
    entry.replace(/\\/g, '/').replace(/^\/+/, ''))
);

// Every local module main.js and its dependencies pull in, plus the UI.
const localRequires = (file) => {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  return [...src.matchAll(/require\(['"](\.\/[^'"]+)['"]\)/g)]
    .map((m) => m[1].replace(/^\.\//, '').replace(/\.js$/, '') + '.js');
};

const required = new Set(['main.js', 'preload.js', 'ui/index.html', 'ui/app.js',
  'ui/engine.js', 'ui/style.css']);
for (const entry of ['main.js', 'preload.js']) {
  for (const dep of localRequires(entry)) required.add(dep);
}

const missing = [...required].filter((f) => !present.has(f));

if (missing.length) {
  console.error('verify-package: MISSING from the package:');
  missing.forEach((f) => console.error('  - ' + f));
  console.error('Add it to build.files in package.json.');
  process.exit(1);
}

console.log('verify-package: ok — ' + required.size + ' required files present');
