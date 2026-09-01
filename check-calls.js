// Resolve every bare function call in the userscript against its definitions.
//
// `node --check` only proves the file parses. It happily accepts a call to a
// function that no longer exists — which happened: a block edit deleted tick()
// while setInterval(tick) remained, and the assistant sat silently inert in a
// live draft. This catches that before the file is loaded into a draft room.
const fs = require('fs');
const file = process.argv[2] || 'queue-manager.user.js';
const raw = fs.readFileSync(file, 'utf8');

// Definitions are collected from the raw source. Stripping first was eating real
// ones and reporting defined functions as unresolved. A definition picked up out
// of a comment can only cause a false negative, which is the safe direction.
// Comments and string literals contain prose and UI text that looks like calls.
let src = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/`(?:\\.|[^`\\])*`/g, '``')
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/'(?:\\.|[^'\\])*'/g, "''");

const defined = new Set([
  ...[...raw.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  ...[...raw.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]),
  ...[...raw.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)]
      .flatMap((m) => m[1].split(',').map((x) => x.trim().split(':').pop().trim())),
  ...[...raw.matchAll(/([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)].map((m) => m[1]),
  // function parameters, which are callable inside their body (pred, fn, ...)
  ...[...raw.matchAll(/(?:function[^(]*|=>\s*)?\(([^)]*)\)\s*(?:=>|\{)/g)]
      .flatMap((m) => m[1].split(',').map((x) => x.trim().replace(/[=:].*$/, '').trim()))
      .filter((x) => /^[A-Za-z_$][\w$]*$/.test(x)),
]);

const keywords = new Set(('if for while switch catch return typeof new function await ' +
  'async delete void in of do else try throw yield').split(' '));
// Browser globals: this runs in node, so they are absent from globalThis here.
const browser = new Set(('getComputedStyle fetch alert confirm prompt requestAnimationFrame ' +
  'setTimeout setInterval clearTimeout clearInterval atob btoa').split(' '));

const called = [...src.matchAll(/(?<![.\w$])([a-z][A-Za-z0-9_$]*)\s*\(/g)].map((m) => m[1]);
const missing = [...new Set(called)]
  .filter((c) => !defined.has(c) && !keywords.has(c) && !browser.has(c) && !(c in globalThis));

if (missing.length) {
  console.error('UNRESOLVED CALLS: ' + missing.join(', '));
  process.exit(1);
}
console.log('all bare calls resolve');
