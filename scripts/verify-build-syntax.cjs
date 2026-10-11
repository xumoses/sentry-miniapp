#!/usr/bin/env node
// Parse shipped formats and execute the browser UMD entry before syncing examples.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

const dist = path.resolve(__dirname, '../dist');
try {
  const umd = fs.readFileSync(path.join(dist, 'sentry-miniapp.umd.js'), 'utf8');
  const cjs = fs.readFileSync(path.join(dist, 'sentry-miniapp.cjs.js'), 'utf8');
  const esm = fs.readFileSync(path.join(dist, 'sentry-miniapp.esm.js'), 'utf8');
  const browserEntry = new vm.Script(umd, { filename: 'sentry-miniapp.umd.js' });
  new vm.Script(cjs, { filename: 'sentry-miniapp.cjs.js' });
  const moduleCheck = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: esm,
    encoding: 'utf8',
  });
  assert.equal(moduleCheck.status, 0, 'ESM syntax check failed');
  const browser = vm.createContext({ console, setTimeout, clearTimeout });
  browserEntry.runInContext(browser, { timeout: 5000 });
  assert.equal(typeof browser.SentryMiniapp?.init, 'function', 'UMD init export is missing');
  assert.equal(typeof browser.SentryMiniapp?.startTaroDomReplayPoc, 'function', 'UMD Replay export is missing');
  console.log('Verified ESM/CJS/UMD syntax and browser UMD exports');
} catch (error) {
  // Do not dump the entire minified line on a parser failure.
  console.error(`Build output validation failed: ${error.message}`);
  process.exitCode = 1;
}
