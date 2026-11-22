'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const repo = path.resolve(__dirname, '../..');
const temporaryRoot = fs.realpathSync(os.tmpdir());
const prefix = path.resolve(temporaryRoot, 'farm-public-base-');
assert.equal(path.dirname(prefix), temporaryRoot);
const fixture = fs.mkdtempSync(prefix);
process.env.FARM_DATA_DIR = path.join(fixture, 'data');
process.env.FARM_PRIVATE_CONFIG_FILE = path.join(fixture, 'absent-private-config.json');
after(() => fs.rmSync(fixture, { recursive: true, force: true }));
function inside(relative) {
  const result = path.resolve(fixture, relative);
  assert.ok(result.startsWith(fixture + path.sep));
  return result;
}

test('a clean installation can load and start optional interfaces without files, timers, processes or network effects', () => {
  const files = ['src/services/activity-evolver.js', 'src/services/evolution-issue-inbox.js', 'src/services/evolution-knowledge.js',
    'src/services/private-config.js', 'src/config/runtime-paths.js', 'src/runtime/optional-module-provider.js',
    ...['announcement-context', 'autonomy', 'countercheck', 'github-feedback', 'github-issue-review', 'github-review', 'learning',
      'main-mcp', 'main-workflow', 'no-change-audit', 'references', 'sessions', 'team'].map(name => `src/services/evolution-${name}.js`)];
  for (const file of files) {
    const target = inside(`clean/core/${file}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(repo, 'core', file), target);
  }
  const clean = inside('clean');
  const script = String.raw`
    const assert = require('node:assert/strict'); const fs = require('node:fs');
    const cp = require('node:child_process'); const http = require('node:http'); const https = require('node:https'); const net = require('node:net');
    const effects = []; const deny = name => () => { effects.push(name); throw new Error(name); };
    for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) cp[name] = deny(name);
    for (const name of ['writeFileSync','mkdirSync','appendFileSync','renameSync']) fs[name] = deny(name);
    http.request = http.get = https.request = https.get = net.connect = deny('network');
    global.setTimeout = global.setInterval = deny('timer');
    const service = require('./core/src/services/activity-evolver');
    service.startActivityEvolver({}); service.checkAndMaybeEvolve({}); service.checkGameUpdateEvidence();
    assert.equal(service.getEvolveState().available, false); assert.equal(service.getEvolveState().running, false);
    assert.equal(require('./core/src/services/evolution-issue-inbox').recordRuntimeIssue('plant_failed', 'error'), false);
    assert.equal(typeof require('./core/src/services/evolution-knowledge').resolveKnowledgeDir({dataDir: process.env.FARM_DATA_DIR}), 'string');
    for (const name of ['announcement-context','autonomy','countercheck','github-feedback','github-issue-review','github-review',
      'learning','main-mcp','main-workflow','no-change-audit','references','sessions','team'])
      assert.deepEqual(require('./core/src/services/evolution-' + name), {available:false});
    assert.deepEqual(effects, []);
    assert.equal(fs.existsSync('HANDOFF.md'), false); assert.equal(fs.existsSync('docs/skills'), false);
  `;
  const result = cp.spawnSync(process.execPath, ['-e', script], { cwd: clean, encoding: 'utf8',
    env: { PATH: process.env.PATH, FARM_DATA_DIR: inside('uncreated-data'), FARM_PRIVATE_CONFIG_FILE: inside('absent-config.json') } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(inside('uncreated-data')), false);
  for (const file of ['run-evolution-team.js', 'run-evolution-main-mcp.js', 'evolution-knowledge.js']) {
    const result = cp.spawnSync(process.execPath, [path.join(repo, 'core/scripts', file)], { cwd: clean, encoding: 'utf8',
      env: { PATH: process.env.PATH, FARM_DATA_DIR: inside('uncreated-data') } });
    assert.equal(result.status, 1); assert.match(result.stderr, /unavailable/);
  }
});

test('real activity scan routes remain available and ordinary admins retain update permission without advanced endpoints', async t => {
  const express = require('express');
  const app = express(); app.use(express.json());
  const monitor = require('../src/services/activity-update-monitor');
  t.after(() => monitor.stopActivityUpdateMonitor());
  const routes = require('../src/controllers/admin-activity-update-routes');
  const authorize = (req, res, next) => {
    if (!req.headers['x-test-role']) return res.status(401).json({ ok: false });
    req.currentUser = { role: req.headers['x-test-role'] }; next();
  };
  routes.registerAdminActivityUpdateRoutes({ app, provider: { getAccounts: () => ({ accounts: [] }) }, requireAdminToken: authorize });
  const updater = require('../src/services/program-update');
  const original = { publicState: updater.publicState, check: updater.check, begin: updater.begin };
  let installations = 0;
  updater.publicState = () => ({ currentVersion: '2.3.5', phase: 'idle' });
  updater.check = async () => ({ phase: 'available' });
  updater.begin = () => { installations++; return { phase: 'preparing' }; };
  t.after(() => Object.assign(updater, original));
  require('../src/controllers/admin-super-admin-routes').registerAdminSuperAdminRoutes({ app, requireAdminToken: authorize,
    requireSuperAdminRole: (_req, res) => res.sendStatus(403) });
  const server = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(route, role = 'admin', method = 'GET') {
    return fetch(origin + route, { method, headers: role ? { 'x-test-role': role } : {} });
  }
  assert.equal((await request('/api/activity/update/status', '')).status, 401);
  const status = await (await request('/api/activity/update/status')).json();
  assert.equal(status.ok, true); assert.equal(Object.hasOwn(status, 'evolve'), false);
  const scan = await (await request('/api/activity/update/scan', 'admin', 'POST')).json();
  assert.equal(scan.ok, true); assert.equal(scan.report.online.available, false); assert.equal(Object.hasOwn(scan, 'evolve'), false);
  for (const route of ['evolve','evolve-retry','agent','agents','instruction','revise','evolution-enabled','autonomous-evolution','sync-head','apply'])
    assert.equal((await request(`/api/activity/update/${route}`, 'admin', 'POST')).status, 404);
  for (const role of ['user','viewer']) {
    assert.equal((await request('/api/admin/program-update', role)).status, 403);
    assert.equal((await request('/api/admin/program-update/install', role, 'POST')).status, 403);
  }
  assert.equal(installations, 0);
  for (const base of ['/api/admin/program-update','/api/super-admin/program-update']) {
    assert.equal((await request(base)).status, 200);
    assert.equal((await request(`${base  }/check`, 'admin', 'POST')).status, 200);
    assert.equal((await request(`${base  }/install`, 'admin', 'POST')).status, 200);
  }
  assert.equal(installations, 2);
});

test('the actual scanner reviews the established Muge root once and still discovers unknown child modules', async t => {
  const monitor = require('../src/services/activity-update-monitor');
  t.after(() => monitor.stopActivityUpdateMonitor());
  const { registerAdminActivityUpdateRoutes, selectKnownActivityReviewRoots } = require('../src/controllers/admin-activity-update-routes');
  const now = Math.floor(Date.now() / 1000);
  const rootId = 2026111700;
  const registered = [rootId, 2026111702, 2026111703, 2026111704, 2026111705];
  const active = registered.map(id => ({
    id, parentId: id === rootId ? 0 : rootId,
    startTime: now - 60, endTime: now + 600, visible: true, enabled: false,
  }));
  const newRoot = { ...active[0], id: 9099123100 };
  const newChild = { ...active[1], id: 9099123101 };
  let listed = [...active, newRoot];
  let groupResult = id => ({ id });
  const calls = [];
  const app = require('express')();
  registerAdminActivityUpdateRoutes({ app, requireAdminToken: (_req, _res, next) => next(), provider: {
    getAccounts: () => ({ accounts: [{ id: 'fixture', running: true }] }),
    isAccountRunning: () => true,
    getStatus: () => ({ connection: { connected: true } }),
    getActivityDiscoveryList: async () => { calls.push('List'); return listed; },
    getActivityGroupSnapshot: async (_id, id) => { calls.push(id); return groupResult(id); },
    getBag: async () => { calls.push('Bag'); return {}; },
  } });

  const current = await monitor.runActivityUpdateScan();
  assert.deepEqual(current.unknownActivityIds, [newRoot.id]);
  assert.deepEqual(current.online.checkedActivityIds, [rootId]);
  assert.deepEqual(current.online.groups, [
    { id: newRoot.id, reviewKind: 'candidate' }, { id: rootId, reviewKind: 'known-active' },
  ]);
  assert.deepEqual(calls.splice(0), ['List', newRoot.id, rootId, 'Bag']);

  listed = [...active, newChild];
  const newModule = await monitor.runActivityUpdateScan();
  assert.deepEqual(newModule.unknownActivityIds, [newChild.id]);
  assert.deepEqual(newModule.online.groups, [{ id: rootId, reviewKind: 'candidate' }]);
  assert.deepEqual(calls.splice(0), ['List', rootId, 'Bag']);

  for (const result of [null, {}, { id: newRoot.id }]) {
    groupResult = () => result;
    const failed = await monitor.runActivityUpdateScan();
    assert.deepEqual(failed.unknownActivityIds, [newChild.id]);
    assert.equal(failed.online.groups.length, 1);
    assert.equal(failed.online.groups[0].id, rootId);
    assert.equal(failed.online.groups[0].error, '活动详情与列表不匹配');
    assert.deepEqual(calls.splice(0), ['List', rootId, 'Bag']);
  }
  groupResult = () => { throw new Error('fixture read failed'); };
  const thrown = await monitor.runActivityUpdateScan();
  assert.equal(thrown.online.groups[0].error, 'fixture read failed');
  assert.deepEqual(calls.splice(0), ['List', rootId, 'Bag']);

  const cutoff = Math.floor(Date.now() / 1000);
  const ended = active.map(item => ({ ...item, endTime: cutoff }));
  assert.deepEqual(selectKnownActivityReviewRoots(ended, registered, cutoff), []);
  const orphan = { ...newChild, id: 9099123102, parentId: 9099123103 };
  listed = [...ended, newChild, orphan];
  const expired = await monitor.runActivityUpdateScan();
  assert.deepEqual(expired.unknownActivityIds, [orphan.id, newChild.id]);
  assert.equal(expired.endedActivities.find(item => item.id === rootId)?.reason, 'expired');
  assert.deepEqual(expired.online.checkedActivityIds, []);
  assert.deepEqual(expired.online.groups, []);
  assert.deepEqual(calls, ['List', 'Bag']);
});

test('the actual activity SFC compiles with ordinary gameplay and no optional control imports', () => {
  const compiler = require(path.join(repo, 'web/node_modules/vue/compiler-sfc'));
  const filename = path.join(repo, 'web/src/views/Activity.vue');
  const source = fs.readFileSync(filename, 'utf8');
  const parsed = compiler.parse(source, { filename }); assert.deepEqual(parsed.errors, []);
  const compiled = compiler.compileScript(parsed.descriptor, { id: 'public-base', inlineTemplate: true });
  assert.ok(compiled.content.length > 0);
  assert.doesNotMatch(compiled.content, /stores\/evolution|EvolutionAgentSettings|AdminActivityUpdatePanel/);
  assert.match(compiled.content, /FriendRecallActivityPanel/);
  assert.doesNotMatch(compiled.content, /MilkTeaActivityPanel/);
  assert.match(compiled.content, /FestivalSignInPanel/);
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'core/package.json'))).version;
  for (const file of ['package.json','core/package.json','web/package.json'])
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, file))).version, version);
});
