import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('manifest.json'));

assert.equal(manifest.manifest_version, 3, 'manifest_version must be 3');
assert.equal(manifest.version, '4.0.0', 'manifest version must match the release');
assert.equal(manifest.chrome_url_overrides?.newtab, 'newtab.html', 'new-tab override is missing');
assert.ok(!manifest.host_permissions?.length, 'host permissions are not expected');

for (const size of ['16', '32', '48', '128']) {
  const icon = manifest.icons?.[size];
  assert.ok(icon, `missing ${size}px icon declaration`);
  assert.ok(fs.existsSync(path.join(root, icon)), `missing icon file: ${icon}`);
}

const html = read('newtab.html');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'newtab.html contains duplicate IDs');
assert.ok(!/<script(?![^>]+src=)/i.test(html), 'inline scripts are not allowed');
assert.ok(!/\son\w+=/i.test(html), 'inline event handlers are not allowed');
assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(html), 'remote fonts are not allowed');

execFileSync(process.execPath, ['--check', path.join(root, 'script.js')], { stdio: 'inherit' });
console.log(`Mindspace ${manifest.version}: manifest, assets, HTML, and JavaScript are valid.`);
