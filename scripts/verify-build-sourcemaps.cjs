#!/usr/bin/env node
// Validate actual build output, including the bundled sourcesContent. No network access.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'dist')).filter((name) => name.endsWith('.js.map'));
assert.ok(files.length >= 3, 'Build the ESM, CJS and UMD outputs before checking sourcemaps');
let checkedSources = 0;
for (const name of files) {
  const mapPath = path.join(root, 'dist', name);
  const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
  assert.equal(map.version, 3, `${name}: expected source map v3`);
  assert.equal(map.sources.length, map.sourcesContent.length, `${name}: source content missing`);
  assert.ok(map.mappings.length > 0, `${name}: mappings must remain populated`);
  assert.ok(!map.sourceRoot, `${name}: sourceRoot must not reveal a machine path`);
  for (let index = 0; index < map.sources.length; index++) {
    const source = map.sources[index];
    assert.ok(!path.isAbsolute(source) && !/^[a-z]:[\\/]/i.test(source), `${name}: absolute source path`);
    assert.ok(!/(?:^|\/)(?:Users|home|private|tmp)\//i.test(source), `${name}: machine source path`);
    assert.equal(typeof map.sourcesContent[index], 'string', `${name}: source text missing`);
    if (source.startsWith('../node_modules/')) {
      assert.ok(!source.slice('../node_modules/'.length).split('/').includes('..'), `${name}: dependency traversal`);
    } else {
      const resolved = path.resolve(path.dirname(mapPath), source);
      assert.ok(resolved.startsWith(`${root}${path.sep}`), `${name}: source escapes checkout`);
      assert.equal(map.sourcesContent[index], fs.readFileSync(resolved, 'utf8'), `${name}: local source text changed`);
    }
    checkedSources++;
  }
}
const copied = path.join(root, 'examples/wxapp/lib/sentry-miniapp.js.map');
assert.equal(fs.readFileSync(copied, 'utf8'), fs.readFileSync(path.join(root, 'dist/sentry-miniapp.umd.js.map'), 'utf8'), 'Example sourcemap must match the verified UMD map');
console.log(`Verified ${files.length} built sourcemaps and ${checkedSources} portable source entries`);
