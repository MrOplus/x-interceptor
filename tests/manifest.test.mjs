// Package-integrity tests: the manifest is well-formed, everything it references
// exists, the two content-script worlds are wired correctly, and the packaging
// scripts / package.json stay in sync with the manifest version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');
const exists = (rel) => existsSync(fileURLToPath(new URL(rel, root)));

const manifest = JSON.parse(read('manifest.json'));

test('manifest is MV3 with a semver version', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.name && manifest.description);
});

test('every file the manifest references exists', () => {
  const files = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap((c) => c.js),
  ];
  for (const f of files) assert.ok(exists(f), `missing referenced file: ${f}`);
});

test('content scripts run at document_start in MAIN and ISOLATED worlds', () => {
  const worlds = manifest.content_scripts.map((c) => c.world);
  assert.ok(worlds.includes('MAIN'), 'a MAIN-world content script exists');
  assert.ok(worlds.includes('ISOLATED'), 'an ISOLATED-world content script exists');
  for (const c of manifest.content_scripts) {
    assert.equal(c.run_at, 'document_start', 'must inject before the page bundle runs');
  }
});

test('rules.js loads before inject.js in the MAIN world', () => {
  const main = manifest.content_scripts.find((c) => c.world === 'MAIN');
  const rulesAt = main.js.findIndex((f) => f.endsWith('rules.js'));
  const injectAt = main.js.findIndex((f) => f.endsWith('inject.js'));
  assert.ok(rulesAt !== -1 && injectAt !== -1, 'both scripts present');
  assert.ok(rulesAt < injectAt, 'inject.js depends on globalThis.__XRules from rules.js');
});

test('host permissions and storage permission are declared', () => {
  assert.ok(manifest.permissions.includes('storage'));
  const hosts = manifest.host_permissions.join(' ');
  assert.match(hosts, /x\.com/);
  assert.match(hosts, /twitter\.com/);
});

test('package.json version matches the manifest version', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.version, manifest.version, 'bump both together');
});
