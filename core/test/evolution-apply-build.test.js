const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-apply-'));
  const root = path.join(dir, 'repo');
  const bin = path.join(dir, 'bin');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(root); fs.mkdirSync(bin);
  const write = (name, content) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write('scripts/apply-evolution.sh', fs.readFileSync(path.join(__dirname, '../../scripts/apply-evolution.sh')));
  write('.gitignore', 'tmp/\ncore/data/\nweb/dist/\n');
  write('web/package.json', '{}');
  write('web/dist/index.html', 'existing UI');
  write('stop.sh', 'echo stop >> "$FARM_APPLY_TEST_TRACE"\n');
  const trace = path.join(dir, 'trace');
  fs.writeFileSync(trace, '');
  fs.writeFileSync(path.join(bin, 'tmux'), '#!/bin/sh\nif [ "$1" = display-message ]; then exit 0; fi\necho send >> "$FARM_APPLY_TEST_TRACE"\n', { mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh
 echo build >> "$FARM_APPLY_TEST_TRACE"
 if [ -f ../core/data/fail-build ]; then exit 1; fi
 while [ "$#" -gt 0 ]; do
   if [ "$1" = --outDir ]; then shift; output="$1"; fi
   shift
 done
 mkdir -p "$output"
 echo 'approved UI' > "$output/index.html"
 `, { mode: 0o700 });
  // 构建节点解析（2026-09-23 c9a2261）会在 NODE_BIN_DIR 的 node 不满足 vite 7
  // （>= 20.19）时改用本机 nvm 目录，那会让真 npm 覆盖上面的 mock npm。fixture
  // 提供一个通过版本检查的假 node，把 BUILD_NODE_DIR 固定在 mock bin 上。
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', ['fixture', 'users.noreply.github.com'].join('@')]);
  git(['add', '.']); git(['commit', '-qm', 'fixture']);
  const run = (extra = {}) => spawnSync('bash', ['scripts/apply-evolution.sh'], { cwd: root,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FARM_NODE_BIN_DIR: bin,
      FARM_TMUX_TARGET: 'fixture:0.0', FARM_DATA_DIR: path.join(root, 'core/data'), FARM_APPLY_TEST_TRACE: trace, ...extra },
    encoding: 'utf8', timeout: 10000 });
  return { root, write, git, run, trace: () => fs.readFileSync(trace, 'utf8') };
}

test('应用前端构建失败时保留当前页面，不停服、不向 pane 发启动命令', (t) => {
  const f = fixture(t);
  f.write('core/data/fail-build', '1');
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.readFileSync(path.join(f.root, 'web/dist/index.html'), 'utf8'), 'existing UI');
  assert.equal(f.trace(), 'build\n');
});

test('仅在已审提交构建成功后切换页面并在原 pane 重启', (t) => {
  const f = fixture(t);
  const result = f.run({ FARM_EVOLUTION_COMMIT: f.git(['rev-parse', 'HEAD']) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.root, 'web/dist/index.html'), 'utf8').trim(), 'approved UI');
  assert.equal(f.trace(), 'build\nstop\nsend\nsend\nsend\n');
  assert.equal(f.git(['status', '--porcelain']), '');
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'tmp')), []);
});

test('工作区或待应用提交变化时不构建也不部署', (t) => {
  const f = fixture(t);
  assert.notEqual(f.run({ FARM_EVOLUTION_COMMIT: '0'.repeat(40) }).status, 0);
  f.write('unreviewed.txt', 'local edit');
  assert.notEqual(f.run().status, 0);
  assert.equal(f.trace(), '');
  assert.equal(fs.readFileSync(path.join(f.root, 'web/dist/index.html'), 'utf8'), 'existing UI');
});
