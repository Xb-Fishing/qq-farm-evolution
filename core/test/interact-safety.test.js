const assert = require('node:assert/strict');
const test = require('node:test');

function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports, paths: [] };
}

function loadInteractService(sendMsgAsync) {
  const servicePath = require.resolve('../src/services/interact');
  const gameConfigPath = require.resolve('../src/config/gameConfig');
  const networkPath = require.resolve('../src/utils/network');
  const protoPath = require.resolve('../src/utils/proto');
  const utilsPath = require.resolve('../src/utils/utils');
  const paths = [servicePath, gameConfigPath, networkPath, protoPath, utilsPath];
  const previous = new Map(paths.map(file => [file, require.cache[file]]));

  require.cache[gameConfigPath] = mockModule(gameConfigPath, {
    getFruitName: () => '',
    getPlantByFruitId: () => null,
    getPlantById: () => null,
    getPlantName: () => '',
  });
  require.cache[networkPath] = mockModule(networkPath, { sendMsgAsync });
  require.cache[protoPath] = mockModule(protoPath, {
    types: {
      InteractRecordsRequest: {
        create: value => value,
        encode: () => ({ finish: () => Buffer.alloc(0) }),
      },
      InteractRecordsReply: { decode: value => value },
    },
  });
  require.cache[utilsPath] = mockModule(utilsPath, {
    logWarn: () => {},
    sleep: async () => {},
    toNum: value => Number(value) || 0,
    toTimeSec: value => Number(value) || 0,
  });
  delete require.cache[servicePath];

  return {
    service: require(servicePath),
    restore() {
      for (const file of paths) {
        if (previous.get(file)) require.cache[file] = previous.get(file);
        else delete require.cache[file];
      }
    },
  };
}

test('访客记录失败后停止请求，不改猜其他 RPC 路由', async () => {
  const calls = [];
  const fixture = loadInteractService(async (service, method) => {
    calls.push([service, method]);
    throw new Error('unknown upstream response');
  });

  try {
    await assert.rejects(fixture.service.getInteractRecords(), /已停止请求/);
    await assert.rejects(fixture.service.getInteractRecords(), /暂停请求/);
    assert.deepEqual(calls, [[
      'gamepb.interactpb.InteractService',
      'InteractRecords',
    ]]);
  } finally {
    fixture.restore();
  }
});

test('访客记录合并并发读取并复用一分钟本地缓存', async () => {
  let calls = 0;
  let finishRequest;
  const fixture = loadInteractService(() => {
    calls += 1;
    return new Promise(resolve => { finishRequest = resolve; });
  });

  try {
    const first = fixture.service.getInteractRecords();
    const concurrent = fixture.service.getInteractRecords();
    assert.equal(calls, 1);
    finishRequest({
      body: {
        records: [{ server_time: 10, action_type: 1, visitor_gid: 20 }],
      },
    });

    const [left, right] = await Promise.all([first, concurrent]);
    assert.equal(left.length, 1);
    assert.deepEqual(right, left);
    assert.deepEqual(await fixture.service.getInteractRecords(), left);
    assert.equal(calls, 1);
    assert.equal(fixture.service.INTERACT_RECORDS_CACHE_MS, 60_000);
  } finally {
    fixture.restore();
  }
});
