const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// CheckCanOperate 预检查失败诊断（2026-09-28）：
// 真实导出的 checkCanOperateRemote + 模拟传输（require.cache 注入 network/
// proto/utils），验证：成功/服务端业务错误/传输错误各只发一次现有预检查请求、
// 返回语义不变、诊断只记固定事件名+类别+操作号+严格整数业务码、同签名只记
// 一次、不同签名分开记、签名表与日志总量有固定上限、日志不含错误原文与身份。
process.env.FARM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-diagnostic-'));
test.after(() => fs.rmSync(process.env.FARM_DATA_DIR, { recursive: true, force: true }));

const SYNTHETIC_GID = 987654321; // 合成好友 GID，仅用于验证不落日志

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

function businessError(code, text) {
  const err = new Error(`gamepb.plantpb.PlantService.CheckCanOperate 错误: code=${code} ${text}`);
  err.isServerBusinessError = true;
  err.serverErrorCode = code;
  return err;
}

const transportError = () => new Error(`请求超时: CheckCanOperate (seq=7, pending=0) 合成原文${SYNTHETIC_GID}`);

/** 注入 network/proto/utils 替身后加载全新 friend-api 实例，返回 API 与捕获状态。 */
function loadFriendApiWithMocks() {
  const networkPath = require.resolve('../src/utils/network');
  const utilsPath = require.resolve('../src/utils/utils');
  const protoPath = require.resolve('../src/utils/proto');
  const apiPath = require.resolve('../src/services/friend-api');
  const prev = {
    network: require.cache[networkPath],
    utils: require.cache[utilsPath],
    proto: require.cache[protoPath],
    api: require.cache[apiPath],
  };
  const realUtils = require('../src/utils/utils');
  const state = {
    calls: [],   // { serviceName, methodName, argCount }
    logs: [],    // log(...) 参数
    warns: [],   // logWarn(...) 参数
    behaviors: [], // 每次调用消费一项 { reject? }
    reply: { can_operate: true, can_steal_num: 0 },
    throwOnLog: false, // 置 true 模拟诊断记录器（log）抛错
  };
  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync: async (serviceName, methodName, ...rest) => {
      state.calls.push({ serviceName, methodName, argCount: 2 + rest.length });
      const behavior = state.behaviors.shift();
      if (behavior && behavior.reject) throw behavior.reject;
      return { body: Buffer.alloc(0) };
    },
  });
  require.cache[utilsPath] = mockModule(utilsPath, {
    ...realUtils,
    log: (...args) => {
      if (state.throwOnLog) throw new Error('合成 log 故障');
      state.logs.push(args);
    },
    logWarn: (...args) => { state.warns.push(args); },
  });
  require.cache[protoPath] = mockModule(protoPath, {
    types: {
      CheckCanOperateRequest: {
        create: (obj) => obj,
        encode: () => ({ finish: () => Buffer.alloc(0) }),
      },
      CheckCanOperateReply: { decode: () => state.reply },
    },
  });
  delete require.cache[apiPath];
  const api = require('../src/services/friend-api');
  state.restore = () => {
    delete require.cache[apiPath];
    for (const [p, entry] of [
      [apiPath, prev.api], [networkPath, prev.network], [utilsPath, prev.utils], [protoPath, prev.proto],
    ]) {
      if (entry) require.cache[p] = entry;
      else delete require.cache[p];
    }
  };
  return { api, state };
}

function diagnosticEntries(state) {
  return state.logs.filter(args => args[2] && args[2].event === 'friend_precheck_failure');
}

test('成功/业务错误/传输错误各只发一次预检查请求，返回语义不变', async () => {
  const { api, state } = loadFriendApiWithMocks();
  try {
    // 成功且允许：回包语义原样透出
    state.reply = { can_operate: true, can_steal_num: 2 };
    assert.deepEqual(await api.checkCanOperateRemote(SYNTHETIC_GID, 10003),
      { canOperate: true, canStealNum: 2 });
    // 成功但拒绝：同样原样透出（语义未因诊断改动）
    state.reply = { can_operate: false, can_steal_num: 0 };
    assert.deepEqual(await api.checkCanOperateRemote(SYNTHETIC_GID, 10003),
      { canOperate: false, canStealNum: 0 });
    assert.equal(state.calls.length, 2, '两次调用各发一次请求');
    assert.deepEqual(diagnosticEntries(state), [], '成功路径不产生诊断');

    // 服务端业务错误：仍只发一次请求，catch 兜底返回 + 一条诊断
    state.behaviors.push({ reject: businessError(1002003, '合成业务原文') });
    assert.deepEqual(await api.checkCanOperateRemote(SYNTHETIC_GID, 10003),
      { canOperate: true, canStealNum: 0 });

    // 传输错误：同样一次请求 + 一条诊断
    state.behaviors.push({ reject: transportError() });
    assert.deepEqual(await api.checkCanOperateRemote(SYNTHETIC_GID, 10003),
      { canOperate: true, canStealNum: 0 });

    assert.equal(state.calls.length, 4, '不新增重试或任何额外请求');
    assert.ok(state.calls.every(c =>
      c.serviceName === 'gamepb.plantpb.PlantService' && c.methodName === 'CheckCanOperate'),
    '只允许现有预检查请求');
    assert.ok(state.calls.every(c => c.argCount === 3), '不传任何新增选项参数（含治理豁免）');

    const entries = diagnosticEntries(state);
    assert.equal(entries.length, 2, '业务错误与传输错误各记一条');
    assert.deepEqual(
      entries.map(e => [e[2].category, e[2].serverCode, e[2].operationId]),
      [['business', 1002003, 10003], ['transport', 'unknown', 10003]],
    );
  } finally {
    state.restore();
  }
});

test('诊断脱敏：固定事件名，不含错误原文、好友身份与请求回包', async () => {
  const { api, state } = loadFriendApiWithMocks();
  try {
    state.behaviors.push({ reject: businessError(1002003, '合成业务繁忙') });
    state.behaviors.push({ reject: transportError() });
    await api.checkCanOperateRemote(SYNTHETIC_GID, 10004);
    await api.checkCanOperateRemote(SYNTHETIC_GID, 10004);

    const entries = diagnosticEntries(state);
    assert.equal(entries.length, 2);
    for (const entry of entries) {
      const meta = entry[2];
      assert.equal(meta.event, 'friend_precheck_failure');
      assert.deepEqual(Object.keys(meta).sort(),
        ['category', 'event', 'module', 'operationId', 'serverCode'],
        'meta 只允许固定字段');
      const rendered = JSON.stringify(entry);
      assert.doesNotMatch(rendered, new RegExp(String(SYNTHETIC_GID)), '日志不得出现好友 GID');
      assert.doesNotMatch(rendered, /合成业务繁忙|请求超时|错误/, '日志不得出现错误原文');
    }
  } finally {
    state.restore();
  }
});

test('同签名只记一次；不同类别/业务码/操作号分开记', async () => {
  const { api, state } = loadFriendApiWithMocks();
  try {
    const missingCode = new Error('gamepb.plantpb.PlantService.CheckCanOperate 错误: code=1 合成');
    missingCode.isServerBusinessError = true; // 缺 serverErrorCode -> unknown
    const calls = [
      { reject: businessError(1002003, '合成A') }, // business|1002003|10003
      { reject: businessError(1002003, '合成A') }, // 同签名重复
      { reject: businessError(1002004, '合成B') }, // 不同业务码
      { reject: missingCode },                     // business|unknown|10003
      { reject: transportError() },                // transport|unknown|10003
    ];
    for (const behavior of calls) {
      state.behaviors.push(behavior);
      assert.deepEqual(await api.checkCanOperateRemote(SYNTHETIC_GID, 10003),
        { canOperate: true, canStealNum: 0 });
    }
    // 不同操作号 = 不同签名
    state.behaviors.push({ reject: businessError(1002003, '合成A') });
    await api.checkCanOperateRemote(SYNTHETIC_GID, 10004);

    const entries = diagnosticEntries(state);
    assert.deepEqual(
      entries.map(e => [e[2].category, e[2].serverCode, e[2].operationId]),
      [
        ['business', 1002003, 10003],
        ['business', 1002004, 10003],
        ['business', 'unknown', 10003],
        ['transport', 'unknown', 10003],
        ['business', 1002003, 10004],
      ],
      '同签名只记一次，其余按签名分开记录');
  } finally {
    state.restore();
  }
});

test('签名表与日志总量都有固定上限，超限后静默', async () => {
  const { api, state } = loadFriendApiWithMocks();
  try {
    for (let i = 0; i < 40; i += 1) {
      state.behaviors.push({ reject: transportError() });
      await api.checkCanOperateRemote(SYNTHETIC_GID, 20000 + i); // 40 个不同签名
    }
    state.behaviors.push({ reject: businessError(1002003, '合成C') });
    await api.checkCanOperateRemote(SYNTHETIC_GID, 10003);      // 超限后的新签名

    assert.equal(state.calls.length, 41, '请求次数不受上限影响');
    assert.equal(diagnosticEntries(state).length, 16,
      '签名表固定上限 16：超出部分不再记录');
  } finally {
    state.restore();
  }
});

test('诊断记录器抛错不改变兜底语义：仍返回原兜底、只发一次请求、不产生拒绝', async () => {
  const { api, state } = loadFriendApiWithMocks();
  try {
    state.throwOnLog = true; // 模拟诊断记录器（log）在写入时抛错
    state.behaviors.push({ reject: businessError(1002003, '合成D') });
    assert.deepEqual(await api.checkCanOperateRemote(SYNTHETIC_GID, 10003),
      { canOperate: true, canStealNum: 0 },
      '记录器抛错必须维持原有兜底返回，不得把兜底变成 Promise 拒绝');
    assert.equal(state.calls.length, 1, '仍只发一次现有预检查请求');
    assert.deepEqual(diagnosticEntries(state), [], '诊断写入失败不落任何条目');
  } finally {
    state.restore();
  }
});

test('业务码只记录严格十进制整数；非严格整数输入一律记 unknown', async () => {
  const { api, state } = loadFriendApiWithMocks();
  try {
    // 覆盖旧实现宽松 toNum 会转成数值的输入（"0x10"→16、"1e2"→100、
    // " 42"→42、Long 形状对象→16），以及各类非正整数输入
    const badCodes = [
      '0x10', '1e2', '12.5', ' 42', '-7', 'abc', '', '0',
      '99999999999999999999', null, { low: 16, high: 0 }, 12.5,
    ];
    for (let i = 0; i < badCodes.length; i += 1) {
      state.behaviors.push({ reject: businessError(badCodes[i], '合成E') });
      assert.deepEqual(await api.checkCanOperateRemote(SYNTHETIC_GID, 30000 + i),
        { canOperate: true, canStealNum: 0 });
    }
    const entries = diagnosticEntries(state);
    assert.equal(entries.length, badCodes.length,
      '每个非严格整数码独立记录（操作号互异，不被签名去重掩盖）');
    assert.ok(entries.every(e =>
      e[2].category === 'business' && e[2].serverCode === 'unknown'),
    '非严格十进制整数码一律记 unknown，不得宽松转成数值');

    // 对照：严格十进制整数字符串与合法数值照常记录为整数码
    state.behaviors.push({ reject: businessError('1002003', '合成F') });
    state.behaviors.push({ reject: businessError(1002004, '合成G') });
    await api.checkCanOperateRemote(SYNTHETIC_GID, 40001);
    await api.checkCanOperateRemote(SYNTHETIC_GID, 40002);
    const strict = diagnosticEntries(state).slice(-2);
    assert.deepEqual(strict.map(e => e[2].serverCode), [1002003, 1002004],
      '严格整数码保留数值形态正常记录');
  } finally {
    state.restore();
  }
});
