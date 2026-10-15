const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const tmp = fs.realpathSync(os.tmpdir()), prefix = path.resolve(tmp, 'farm-worker-milk-tea-');
assert.ok(prefix.startsWith(tmp + path.sep));
const dataDir = fs.mkdtempSync(prefix); process.env.FARM_DATA_DIR = dataDir;
test.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
const { loadProto, types } = require('../src/utils/proto');
const { createScheduler, getSchedulerRegistrySnapshot } = require('../src/services/scheduler');
const { createWorkerManager } = require('../src/runtime/worker-manager');
const { createDataProvider } = require('../src/runtime/data-provider');
const { registerAdminMilkTeaActivityRoutes } = require('../src/controllers/admin-milk-tea-activity-routes');
const { createActivityReadCache } = require('../src/controllers/activity-read-cache');
const workerSrc = fs.readFileSync(path.join(__dirname, '../src/core/worker.js'), 'utf8');
const rejectionOf = promise => promise.then(() => null, err => err);
function extractWorkerApiSource() {
  const start = workerSrc.indexOf('const FRIEND_PANEL_ENTRY_METHODS = new Set([');
  assert.ok(start >= 0, 'FRIEND_PANEL_ENTRY_METHODS exists in worker.js');
  const end = workerSrc.indexOf('// ==================== 每日礼包总览', start);
  assert.ok(end > start, 'handleApiCall end marker exists');
  return `${workerSrc.slice(start, end)}\n;({ handleApiCall, collectPetDiaryErrorMeta })`;
}

function createFakeProc() {
  const handlers = {};
  const sent = [];
  return {
    sent,
    on: (event, cb) => { handlers[event] = cb; },
    emitMessage: msg => handlers.message && handlers.message(msg),
    send: msg => sent.push(msg),
    kill: () => {},
    exitCode: null,
    signalCode: null,
  };
}

function buildManagerHarness() {
  const proc = createFakeProc();
  const workers = {};
  const globalLogs = [];
  const manager = createWorkerManager({
    fork: () => proc,
    WorkerThread: undefined,
    runtimeMode: 'fork',
    processRef: { pkg: false, env: {} },
    mainEntryPath: '',
    workerScriptPath: '',
    workers,
    globalLogs,
    log: () => {},
    addAccountLog: () => {},
    normalizeStatusForPanel: data => data,
    buildConfigSnapshotForAccount: () => ({}),
    getOfflineAutoDeleteMs: () => Infinity,
    triggerOfflineReminder: () => {},
    addOrUpdateAccount: () => {},
    getAccounts: () => ({ accounts: [{ id: 'acct-1', name: 'A', code: 'x', platform: 'qq' }] }),
    deleteAccount: () => {},
  });
  assert.equal(manager.startWorker({ id: 'acct-1', name: 'A', code: 'x', platform: 'qq' }), true);
  const cleanup = () => createScheduler('worker_manager').clearAll();
  return { manager, proc, cleanup };
}

test('元数据两种传输形态保留；畸形/超长/非标量不当业务拒绝；额外属性不透传', { timeout: 5000 }, async () => {
  const { manager, proc, cleanup } = buildManagerHarness();
  try {
    const cases = [
      {
        name: 'JSON 往返保留',
        meta: JSON.parse(JSON.stringify({ business: true, code: 'PET_DIARY_LIMIT' })),
        expectBusiness: true,
        expectCode: 'PET_DIARY_LIMIT',
      },
      {
        name: 'structuredClone 保留',
        meta: structuredClone({ business: true, code: 'PET_DIARY_ALREADY' }),
        expectBusiness: true,
        expectCode: 'PET_DIARY_ALREADY',
      },
      {
        name: '旧式仅 error 字符串',
        meta: undefined,
        expectBusiness: false,
      },
      {
        name: '缺失 business',
        meta: { code: 'PET_DIARY_LIMIT' },
        expectBusiness: false,
      },
      {
        name: 'business 非严格布尔',
        meta: { business: 'true', code: 'PET_DIARY_LIMIT' },
        expectBusiness: false,
      },
      {
        name: 'code 非字符串',
        meta: { business: true, code: 42 },
        expectBusiness: false,
      },
      {
        name: 'code 超长',
        meta: { business: true, code: `PET_DIARY_${'A'.repeat(200)}` },
        expectBusiness: false,
      },
      {
        name: 'code 前缀不符',
        meta: { business: true, code: 'SOMETHING_ELSE' },
        expectBusiness: false,
      },
      {
        name: '数组形态',
        meta: [{ business: true, code: 'PET_DIARY_LIMIT' }],
        expectBusiness: false,
      },
      {
        name: '额外属性不透传',
        meta: {
          business: true, code: 'PET_DIARY_LIMIT',
          stack: 'SECRET_STACK', cause: { secret: true }, extra: ['x'],
        },
        expectBusiness: true,
        expectCode: 'PET_DIARY_LIMIT',
      },
    ];
    for (const c of cases) {
      const promise = manager.callWorkerApi('acct-1', 'operatePetDiary', 'feed', {});
      const call = proc.sent.find(m => m.type === 'api_call');
      assert.ok(call, `api_call dispatched (${c.name})`);
      proc.sent.length = 0;
      proc.emitMessage({
        type: 'api_response', id: call.id, result: null,
        error: '业务拒绝', errorMeta: c.meta,
      });
      const err = await rejectionOf(promise);
      if (c.expectBusiness) {
        assert.equal(err.business, true, `business restored (${c.name})`);
        assert.equal(err.code, c.expectCode, `code restored (${c.name})`);
        assert.equal(err.stack.includes('SECRET_STACK'), false, `stack not passed through (${c.name})`);
        assert.equal('cause' in err, false, `cause not passed through (${c.name})`);
        assert.equal('extra' in err, false, `extra props not passed through (${c.name})`);
      } else {
        assert.notEqual(err.business, true, `not business (${c.name})`);
        assert.equal(err.code, undefined, `no code (${c.name})`);
      }
    }
  } finally {
    cleanup();
  }
});

// ==================== 5. 请求关联：并发、乱序、超时迟到、重复 ====================

test('并发/乱序/重复响应不串单；超时后迟到响应无副作用；成功响应原样返回', { timeout: 5000 }, async () => {
  const { manager, proc, cleanup } = buildManagerHarness();
  try {
    // 成功响应原样返回
    const ok = manager.callWorkerApi('acct-1', 'operatePetDiary', 'draw', {});
    const call1 = proc.sent.find(m => m.type === 'api_call');
    proc.sent.length = 0;
    proc.emitMessage({ type: 'api_response', id: call1.id, result: { action: 'draw', rewards: [1] } });
    assert.deepEqual(await ok, { action: 'draw', rewards: [1] });

    // 并发 + 乱序响应
    const pA = manager.callWorkerApi('acct-1', 'operatePetDiary', 'feed', {});
    const pB = manager.callWorkerApi('acct-1', 'operatePetDiary', 'seeds', {});
    const [callA, callB] = proc.sent.filter(m => m.type === 'api_call');
    proc.sent.length = 0;
    proc.emitMessage({ type: 'api_response', id: callB.id, result: { which: 'B' } });
    proc.emitMessage({ type: 'api_response', id: callA.id, result: { which: 'A' } });
    assert.deepEqual(await pB, { which: 'B' });
    assert.deepEqual(await pA, { which: 'A' });

    // 重复响应：第二次为 no-op，不重复完成、不抛错
    proc.emitMessage({ type: 'api_response', id: callA.id, result: { which: 'A-dup' } });
    proc.emitMessage({ type: 'api_response', id: callB.id, error: 'dup error' });

    // 超时后迟到响应
    const late = manager.callWorkerApi('acct-1', 'operatePetDiary', 'compensation', { _timeoutMs: 5 });
    const callLate = proc.sent.find(m => m.type === 'api_call');
    proc.sent.length = 0;
    await assert.rejects(late, /API Timeout/);
    await new Promise(resolve => setTimeout(resolve, 20));
    proc.emitMessage({ type: 'api_response', id: callLate.id, result: { late: true } });
    proc.emitMessage({ type: 'api_response', id: callLate.id, error: 'late error' });

    // 完成请求不遗留计时器
    const snapshot = getSchedulerRegistrySnapshot('worker_manager');
    const leftover = snapshot.schedulers[0].tasks
      .map(t => t.name).filter(name => name.startsWith('api_timeout_'));
    assert.deepEqual(leftover, []);
  } finally {
    cleanup();
  }
});

// ==================== 6. 旧式 error 字符串响应仍正常拒绝 ====================

test('旧式仅含 error 字符串的响应仍正常拒绝为普通 Error', { timeout: 5000 }, async () => {
  const { manager, proc, cleanup } = buildManagerHarness();
  try {
    const promise = manager.callWorkerApi('acct-1', 'operatePetDiary', 'story', { order: 1 });
    const call = proc.sent.find(m => m.type === 'api_call');
    proc.emitMessage({
      type: 'api_response', id: call.id, result: null, error: '账号未就绪（未登录或连接未打开），请稍后重试',
    });
    const err = await rejectionOf(promise);
    assert.match(err.message, /账号未就绪/);
    assert.notEqual(err.business, true);
    assert.equal(err.code, undefined);
  } finally {
    cleanup();
  }
});

// ==================== 7. 成功操作使读写路由共享的真实缓存失效 ====================


// 服务→真实Worker入口→真实消息序列化→管理器→provider→真实路由。
for (const wire of [value => JSON.parse(JSON.stringify(value)), value => structuredClone(value)]) {
  test('奶茶固定业务码跨完整消息链保持；普通读取错误无码；成功与结果未知失效缓存', async () => {
    await loadProto();
    const ws = { readyState: 1 }; const calls = []; let mode = 'ok'; let serverVersion = 0;
    const files = ['../src/utils/network','../src/services/activity','../src/services/milk-tea-activity'].map(require.resolve);
    const previous = files.map(file => [file, require.cache[file]]);
    const network = { getWs: () => ws, isConnected: () => true, sendMsgAsync: async (_service, method, payload) => {
      calls.push(method);
      if (mode === 'listError' && method === 'List') throw new Error('list failed');
      if (mode === 'groupError' && method === 'GetGroup') throw new Error('group failed');
      if (method === 'List') return { body: types.ActivityListReply.encode(types.ActivityListReply.create({ groups: [{ activity: { id: 2026110100, start_time: 1, end_time: 4102444800 } }] })).finish() };
      if (method === 'GetGroup') return { body: types.MilkTeaGetGroupReply.encode(types.MilkTeaGetGroupReply.create({ group: { head: { activity_id: 2026110100, begin_time: 1, end_time: 4102444800 }, children: [{ head: { activity_id: 2026110101 }, milk_tea: { summary: { shop_name: `版本${serverVersion}`, level: 1 } } }] } })).finish() };
      if (method === 'Bag') return { body: types.BagReply.encode(types.BagReply.create({ item_bag: { items: [{id:1041,count:500},{id:1042,count:10}] } })).finish() };
      if (mode === 'writeError') throw new Error('write failed');
      const req = types.MilkTeaOperateRequest.decode(payload); serverVersion++;
      return { body: types.MilkTeaOperateReply.encode(types.MilkTeaOperateReply.create({ activity_id: req.activity_id, operate_type: req.operate_type, milk_tea_boost: { cups: 40 } })).finish() };
    } };
    require.cache[files[0]] = { id:files[0],filename:files[0],loaded:true,exports:network };
    delete require.cache[files[1]]; delete require.cache[files[2]];
    const service = require('../src/services/milk-tea-activity');
    const { manager, proc, cleanup } = buildManagerHarness();
    let ready = true;
    const responses = [];
    const sandbox = { isRunning: true, loginReady: true, friendSyncPaused: false, getWs: () => ws, isConnected: () => ready, sendToMaster: message => responses.push(message), log: () => {}, require: request => {
      if (request === '../services/milk-tea-activity') return service;
      if (request === '../services/warehouse') return { getBag: async () => ({ items: [{ id: 1042, count: 10 }] }), getBagItems: bag => bag.items };
      throw new Error(`unexpected worker dependency: ${request}`);
    } };
    const entry = new vm.Script(extractWorkerApiSource()).runInContext(vm.createContext(sandbox));
    proc.send = msg => { proc.sent.push(msg); if(msg.type === 'api_call') Promise.resolve().then(async()=>{ await entry.handleApiCall(wire(msg)); proc.emitMessage(wire(responses.at(-1))); }); };
    const provider = createDataProvider({ getAccounts:()=>({accounts:[{id:'acct-1'}]}), callWorkerApi:manager.callWorkerApi });
    provider.getStatus = () => ({ connection: { connected: true } }); provider.isAccountRunning = async()=>true;
    const routes = new Map(); const reader = createActivityReadCache();
    registerAdminMilkTeaActivityRoutes({ app: { get:(url,fn)=>routes.set(url,fn), post:(url,fn)=>routes.set(url,fn) }, provider, activityReader:reader, getAccountIdFromRequest:()=> 'acct-1', canAccessAccount:()=>true, sendProviderError:(res,err)=>res.status(502).json({ok:false,error:err.message}) });
    async function invoke(url, body) { let status=200, data; const res={status:value=>{status=value;return res;},json:value=>{data=value;}}; await routes.get(url)({body},res); return {status,data}; }
    const operate = input => invoke('/api/activity/milk-tea/operate',{action:'boost',input});
    try {
      assert.equal(provider.operatePetDiary,undefined); assert.equal(provider.getBearActivity,undefined); assert.equal(provider.operateSeasonWish,undefined);
      let response = await operate({count:0}); assert.equal(response.status,400); assert.equal(response.data.code,'SEASON_WISH_MILK_TEA_INVALID_INPUT'); assert.deepEqual(calls,['List','GetGroup']);
      for(const failMode of ['listError','groupError']) {
        calls.length=0;mode=failMode;response=await operate({count:1,confirmedCosts:[{itemId:1042,count:'1'}]});
        assert.equal(response.status,502);assert.equal(response.data.code,undefined);assert.deepEqual(calls,failMode==='listError'?['List']:['List','GetGroup']);
      }
      calls.length=0;mode='ok';ready=false;ws.readyState=0; response=await operate({count:1});assert.equal(response.status,400);assert.equal(response.data.code,'SEASON_WISH_MILK_TEA_NOT_READY');assert.equal(calls.length,0);ready=true;ws.readyState=1;
      mode='ok';const snapshot=await invoke('/api/activity/milk-tea');assert.equal(snapshot.data.ok,true);assert.equal((await invoke('/api/activity/milk-tea')).data.upstreamCached,true);
      response=await operate({count:1,confirmedCosts:[{itemId:1042,count:'1'}]});assert.equal(response.data.ok,true);
      assert.equal((await invoke('/api/activity/milk-tea')).data.upstreamCached,false);
      mode='writeError';calls.length=0;response=await operate({count:1,confirmedCosts:[{itemId:1042,count:'1'}]});assert.equal(response.data.outcome,'unknown');assert.equal(calls.filter(m=>m==='Operate').length,1);
      mode='ok';assert.equal((await invoke('/api/activity/milk-tea')).data.upstreamCached,false);
      calls.length=0;await assert.rejects(provider.queryMilkTeaActivity('acct-1','rank',{page:0}),err=>err.code==='SEASON_WISH_MILK_TEA_INVALID_INPUT');
      assert.deepEqual(calls,['List','GetGroup']);
    } finally { cleanup(); for(const [file,entry] of previous) { if(entry)require.cache[file]=entry;else delete require.cache[file]; } }
  });
}
