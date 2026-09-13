const test = require('node:test');
const assert = require('node:assert/strict');

const { loadProto, types } = require('../src/utils/proto');

test('dog skill gift protobuf preserves pending count and claimed item', async () => {
  await loadProto();
  const info = types.GetDogInfoReply.decode(types.GetDogInfoReply.encode({
    pending_gift_count: 3
  }).finish());
  assert.equal(Number(info.pending_gift_count), 3);

  const claim = types.ClaimSkillGiftsReply.decode(types.ClaimSkillGiftsReply.encode({
    item: { id: 101351, count: 3 },
    claimed_count: 3
  }).finish());
  assert.equal(Number(claim.item.id), 101351);
  assert.equal(Number(claim.claimed_count), 3);
});

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

test('dog gift claim uses the dedicated RPC once for concurrent callers', async () => {
  const servicePath = require.resolve('../src/services/dog-skill-gifts');
  const configPath = require.resolve('../src/config/gameConfig');
  const networkPath = require.resolve('../src/utils/network');
  const protoPath = require.resolve('../src/utils/proto');
  const utilsPath = require.resolve('../src/utils/utils');
  const loggerPath = require.resolve('../src/services/logger');
  const paths = [configPath, networkPath, protoPath, utilsPath, loggerPath];
  const previous = new Map(paths.map(path => [path, require.cache[path]]));
  const calls = [];
  const messageType = reply => ({
    create: value => value,
    encode: () => ({ finish: () => Buffer.alloc(0) }),
    decode: () => reply
  });

  require.cache[configPath] = mockModule(configPath, {
    getItemById: id => Number(id) === 101351 ? { name: '同气连枝礼包' } : null
  });
  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync: async (_service, method) => {
      calls.push(method);
      await new Promise(resolve => setImmediate(resolve));
      return { body: Buffer.alloc(0) };
    }
  });
  require.cache[protoPath] = mockModule(protoPath, {
    types: {
      GetDogInfoRequest: messageType({}),
      GetDogInfoReply: { decode: () => ({ pending_gift_count: 2 }) },
      ClaimSkillGiftsRequest: messageType({}),
      ClaimSkillGiftsReply: { decode: () => ({ item: { id: 101351, count: 2 }, claimed_count: 2 }) }
    }
  });
  require.cache[utilsPath] = mockModule(utilsPath, { toNum: value => Number(value) || 0 });
  require.cache[loggerPath] = mockModule(loggerPath, {
    createModuleLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
  });

  delete require.cache[servicePath];
  try {
    const service = require('../src/services/dog-skill-gifts');
    const [first, second] = await Promise.all([
      service.checkAndClaimDogSkillGifts(),
      service.checkAndClaimDogSkillGifts()
    ]);
    assert.equal(first.claimed, 2);
    assert.deepEqual(second, first);
    assert.deepEqual(calls, ['GetDogInfo', 'ClaimSkillGifts']);
  } finally {
    delete require.cache[servicePath];
    for (const path of paths) {
      if (previous.get(path)) require.cache[path] = previous.get(path);
      else delete require.cache[path];
    }
  }
});

test('面板狗信息读取合并并发并复用 60 秒缓存，领取后失效', async () => {
  const servicePath = require.resolve('../src/services/dog-skill-gifts');
  const configPath = require.resolve('../src/config/gameConfig');
  const networkPath = require.resolve('../src/utils/network');
  const protoPath = require.resolve('../src/utils/proto');
  const utilsPath = require.resolve('../src/utils/utils');
  const loggerPath = require.resolve('../src/services/logger');
  const paths = [configPath, networkPath, protoPath, utilsPath, loggerPath];
  const previous = new Map(paths.map(path => [path, require.cache[path]]));
  const calls = [];
  const replies = [
    { pending_gift_count: 2 },
    { pending_gift_count: 5 },
  ];
  const messageType = reply => ({
    create: value => value,
    encode: () => ({ finish: () => Buffer.alloc(0) }),
    decode: () => reply
  });

  require.cache[configPath] = mockModule(configPath, { getItemById: () => null });
  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync: async (_service, method) => {
      calls.push(method);
      return { body: Buffer.alloc(0) };
    }
  });
  require.cache[protoPath] = mockModule(protoPath, {
    types: {
      GetDogInfoRequest: messageType({}),
      GetDogInfoReply: { decode: () => replies[Math.min(calls.length - 1, replies.length - 1)] },
      ClaimSkillGiftsRequest: messageType({}),
      ClaimSkillGiftsReply: { decode: () => ({ item: null, claimed_count: 0 }) }
    }
  });
  require.cache[utilsPath] = mockModule(utilsPath, { toNum: value => Number(value) || 0 });
  require.cache[loggerPath] = mockModule(loggerPath, {
    createModuleLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} })
  });

  delete require.cache[servicePath];
  try {
    const service = require('../src/services/dog-skill-gifts');
    // 并发合并 + 缓存命中
    const [first, concurrent] = await Promise.all([
      service.getDogInfoForPanel(),
      service.getDogInfoForPanel()
    ]);
    assert.equal(service.getPendingGiftCount(first), 2);
    assert.deepEqual(concurrent, first);
    assert.equal(service.getPendingGiftCount(await service.getDogInfoForPanel()), 2);
    assert.deepEqual(calls, ['GetDogInfo']);

    // 领取后失效，下一次面板读取拿到新值
    service.invalidatePanelDogInfoCache();
    assert.equal(service.getPendingGiftCount(await service.getDogInfoForPanel()), 5);
    assert.deepEqual(calls, ['GetDogInfo', 'GetDogInfo']);

    // 领取路径内部仍走无缓存 getDogInfo
    await service.checkAndClaimDogSkillGifts();
    assert.deepEqual(calls, ['GetDogInfo', 'GetDogInfo', 'GetDogInfo', 'ClaimSkillGifts']);
  } finally {
    delete require.cache[servicePath];
    for (const path of paths) {
      if (previous.get(path)) require.cache[path] = previous.get(path);
      else delete require.cache[path];
    }
  }
});
