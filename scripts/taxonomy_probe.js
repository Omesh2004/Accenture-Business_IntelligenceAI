/**
 * Runs the REAL enforceTaxonomy from eventTracker.ts against a list of names.
 *
 * It extracts and evaluates the function's own source rather than reimplementing it.
 * A Python port would drift, and a silently drifting taxonomy dialect is the exact
 * failure mode CLAUDE.md coupling point 2 warns about.
 *
 * Usage:  node scripts/taxonomy_probe.js <eventTracker.ts> <names-file>
 * Output: one "<input>\t<enforceTaxonomy output>" line per name, on stdout.
 */
const fs = require('fs');

const [trackerPath, namesPath] = process.argv.slice(2);
if (!trackerPath || !namesPath) {
  console.error('usage: node scripts/taxonomy_probe.js <eventTracker.ts> <names-file>');
  process.exit(2);
}

const src = fs.readFileSync(trackerPath, 'utf8');
const start = src.indexOf('function enforceTaxonomy');
if (start < 0) {
  console.error('enforceTaxonomy not found in ' + trackerPath);
  process.exit(2);
}

// Brace-match the function body so the extraction survives edits to it.
let depth = 0;
let end = -1;
for (let j = src.indexOf('{', start); j < src.length; j++) {
  if (src[j] === '{') depth++;
  else if (src[j] === '}') {
    depth--;
    if (depth === 0) { end = j + 1; break; }
  }
}
if (end < 0) {
  console.error('could not brace-match enforceTaxonomy');
  process.exit(2);
}

// Strip the TypeScript annotations; the body is otherwise plain JS.
const body = src.slice(start, end)
  .replace(/function enforceTaxonomy\(eventName: string\): string/, 'function enforceTaxonomy(eventName)')
  .replace(/\(part: string\): string/g, '(part)')
  .replace(/\(status: string\): string/g, '(status)')
  .replace(/\(token: string\): \{ feature: string; status: string \}/g, '(token)')
  .replace(/const suffixMap: Array<\[string, string\]>/, 'const suffixMap')
  .replace(/const LEGACY_MAP: Record<string, string>/, 'const LEGACY_MAP');

const realWarn = console.warn;
console.warn = () => {};
// eslint-disable-next-line no-eval
eval(body);
console.warn = realWarn;

const names = fs.readFileSync(namesPath, 'utf8').split(/\r?\n/).filter(Boolean);
for (const name of names) {
  process.stdout.write(name + '\t' + enforceTaxonomy(name) + '\n');
}
