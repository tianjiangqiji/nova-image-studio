const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('deployment package includes every local backend module dependency', t => {
  const root = path.resolve(__dirname, '../..');
  const source = fs.readFileSync(path.join(root, 'scripts/pack.js'), 'utf8');
  const buildStart = source.indexOf('// 1. Build frontend');
  assert.ok(buildStart > 0, 'Cannot locate packaging manifest before build');
  const files = vm.runInNewContext(`${source.slice(0, buildStart)}\n({ files: BACKEND_FILES, dirs: BACKEND_DIRS })`, {
    require,
    __dirname: path.join(root, 'scripts'),
  });
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ccode-deploy-test-'));
  t.after(() => fs.rmSync(staging, { recursive: true, force: true }));
  for (const file of files.files) {
    if (fs.existsSync(file.src)) fs.copyFileSync(file.src, path.join(staging, file.dest));
  }

  for (const dir of files.dirs) fs.cpSync(dir.src, path.join(staging, dir.dest), { recursive: true });

  const pending = [path.join(staging, 'server.js')];
  const visited = new Set();
  while (pending.length > 0) {
    const filename = pending.pop();
    if (visited.has(filename)) continue;
    visited.add(filename);
    const moduleSource = fs.readFileSync(filename, 'utf8');
    for (const match of moduleSource.matchAll(/\brequire\(\s*(['"])(\.[^'"]+)\1\s*\)/g)) {
      let resolved;
      assert.doesNotThrow(() => {
        resolved = createRequire(filename).resolve(match[2]);
      }, `${path.basename(filename)} requires ${match[2]}, which is missing from the deployment package`);
      if (/\.[cm]?js$/.test(resolved)) pending.push(resolved);
    }
  }
  assert.ok(visited.size > 1, 'Expected local backend modules to be checked');
});
