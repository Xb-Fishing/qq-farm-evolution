const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./activity-availability.test');

test('current Activity page keeps Muge, ranch, festival and game updates usable throughout the account lifecycle', async () => {
  const api = h.apiMock();
  const pending = [];
  api.setGet((url, config) => {
    if (url === '/api/activity/muge') {
      const request = h.deferred();
      pending.push({ ...request, signal: config.signal });
      return request.promise;
    }
    return Promise.resolve({ data: { ok: true, calendar: { events: [] }, snapshot: { boxes: {} } } });
  });
  const muge = title => ({ data: { ok: true, activity: {
    available: true, title, endTime: null, personal: null, phase: 'open', sections: [], notes: [],
  } } });
  let page = h.mountActivityPage(api);
  const click = label => h.click(h.buttonsOf(page.root).find(button => h.textOf(button).trim() === label));
  const checkRetired = () => {
    assert.doesNotMatch(h.textOf(page.root), /故友重逢|正在读取规则|召回失败/);
    assert.deepEqual(h.findAll(page.root, node => node.props.id === 'friend-recall' || node.props.href === '#friend-recall'), []);
    assert.equal(page.pinia._s.has('friend-recall'), false);
    assert.deepEqual([...api.calls.get, ...api.calls.post].filter(call => /friend-recall|milk-tea/.test(call.url)), []);
  };
  try {
    await h.flush();
    assert.equal(pending.length, 1);
    assert.match(h.textOf(page.root), /正在读取牧歌活动/);
    checkRetired();
    pending[0].resolve(muge('牧歌测试 A'));
    await h.flush();
    assert.match(h.textOf(page.root), /牧歌测试 A/);
    const nav = h.findAll(page.root, node => node.props['aria-label'] === '活动快速导航')[0];
    assert.deepEqual(h.findAll(nav, node => node.tag === 'a').map(node => node.props.href),
      ['#ranch', '#muge', '#festival-sign-in']);
    click('刷新牧场');
    click('查询节日签到');
    click('查看更新与邮箱');
    await h.flush();
    for (const url of ['/api/ranch/state', '/api/activity/festival', '/api/activity/emails'])
      assert.ok(api.calls.get.some(call => call.url === url && call.accountId === 'acc-1'), url);

    click('刷新');
    pending[1].reject(new Error('牧歌普通读取失败'));
    await h.flush();
    assert.match(h.textOf(page.root), /牧歌普通读取失败/);
    checkRetired();
    click('刷新');
    page.accountRef.value = 'synthetic-b';
    await h.flush();
    assert.equal(pending.length, 4);
    assert.equal(pending[2].signal.aborted, true);
    pending[2].resolve(muge('已切走账号的旧响应'));
    await h.flush();
    assert.doesNotMatch(h.textOf(page.root), /已切走账号的旧响应|牧歌普通读取失败/);
    checkRetired();

    const pinia = page.pinia;
    h.render(null, page.root);
    assert.equal(pending[3].signal.aborted, true);
    pending[3].reject(new Error('卸载后到达的旧异常'));
    await h.flush();
    page = h.mountActivityPage(api, pinia);
    await h.flush();
    assert.equal(pending.length, 5);
    pending[4].resolve(muge('牧歌测试 B'));
    await h.flush();
    assert.match(h.textOf(page.root), /牧歌测试 B/);
    assert.doesNotMatch(h.textOf(page.root), /卸载后到达的旧异常/);
    assert.deepEqual(api.calls.get.filter(call => call.url === '/api/activity/muge').map(call => call.accountId),
      ['acc-1', 'acc-1', 'acc-1', 'synthetic-b', 'synthetic-b']);
    assert.equal(api.calls.post.length, 0);
    checkRetired();
  } finally {
    h.render(null, page.root);
  }
});

test('real Activity registry leaves retired requests unmatched and retains live routes and the shared scanner', async t => {
  const { registerAdminActivityRoutes } = require('../src/controllers/admin-activity-routes');
  const monitor = require('../src/services/activity-update-monitor');
  t.after(() => monitor.stopActivityUpdateMonitor());
  const app = require('express')();
  const id = 'synthetic-account';
  const root = { id: 2026111700, parentId: 0, visible: true, endTime: Math.floor(Date.now() / 1000) + 600 };
  const relisted = { ...root, id: 2026111800 };
  const relistedChild = { ...root, id: 2026111801, parentId: relisted.id };
  let list = [root];
  const calls = [];
  const provider = {
    getStatus: () => ({ connection: { connected: true } }),
    getGamePanelReadScope: () => 'synthetic-scope',
    isAccountRunning: () => true,
    getAccounts: () => ({ accounts: [{ id, running: true }] }),
    getMugeActivity: async () => { calls.push('Muge'); return { ok: true, activity: { available: true } }; },
    getRanchAutomation: async () => { calls.push('Ranch'); return { ok: true, data: {} }; },
    getSolarCalendar: async () => { calls.push('Calendar'); return { events: [] }; },
    getActivityDiscoveryList: async () => { calls.push('List'); return list; },
    getActivityGroupSnapshot: async (_account, activityId) => {
      calls.push(activityId);
      return list.find(node => node.id === activityId);
    },
    getBag: async () => { calls.push('Bag'); return {}; },
  };
  registerAdminActivityRoutes({
    app, provider, store: {}, getAccountIdFromRequest: req => req.headers['x-account-id'], canAccessAccount: () => true,
    sendProviderError: (res, error) => res.status(502).json({ ok: false, error: error.message }),
    requireAdminToken: (_req, _res, next) => next(),
  });
  app.use((_req, res) => res.status(404).json({ ok: false }));
  const request = (url, method = 'GET') => new Promise((resolve, reject) => {
    const req = { url, method, headers: { 'x-account-id': id } };
    const res = {
      statusCode: 200,
      setHeader() {},
      status(code) { this.statusCode = code; return this; },
      json(body) { resolve({ status: this.statusCode, ...body }); return this; },
    };
    app._router.handle(req, res, reject);
  });

  for (const method of ['GET', 'POST'])
    assert.deepEqual(await request('/api/activity/friend-recall', method), { status: 404, ok: false });
  assert.deepEqual(calls, []);
  assert.equal((await request('/api/activity/muge')).activity.available, true);
  assert.equal((await request('/api/ranch/automation')).ok, true);
  assert.deepEqual((await request('/api/activity/festival')).calendar, { events: [] });
  assert.deepEqual(calls.splice(0), ['Muge', 'Ranch', 'Calendar']);
  assert.equal((await request('/api/activity/update/status')).ok, true);
  const scan = await request('/api/activity/update/scan', 'POST');
  assert.equal(scan.ok, true);
  assert.deepEqual(scan.report.online.checkedActivityIds, [root.id]);
  assert.deepEqual(scan.report.unknownActivityIds, []);
  assert.deepEqual(calls, ['List', root.id, 'Bag', 'Calendar']);
  assert.deepEqual(await request('/api/activity/friend-recall'), { status: 404, ok: false });
  assert.deepEqual(calls.splice(0), ['List', root.id, 'Bag', 'Calendar']);

  // If the upstream ever advertises these identifiers again, re-review the
  // group as a candidate through shared discovery without restoring the route.
  list = [root, relisted, relistedChild];
  const relistScan = await monitor.runActivityUpdateScan();
  assert.deepEqual(relistScan.unknownActivityIds, [relistedChild.id, relisted.id]);
  assert.equal(relistScan.online.groups.find(group => group.id === relisted.id)?.reviewKind, 'candidate');
  assert.deepEqual(calls, ['List', relisted.id, root.id, 'Bag', 'Calendar']);
});
