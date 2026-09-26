const test = require('node:test');
const assert = require('node:assert/strict');

// 名册快照单调请求序号（2026-09-26 主审修正 1）：
// 执行真实 getAllFriends + 可控延迟 sendMsgAsync，验证共享快照不被
// 迟到的旧成功回包污染；API 返回语义与 QQ/微信调用协议均不改。
function mockModule(filename, exports) {
  return { id: filename, filename, loaded: true, exports };
}

test('getAllFriends 共享快照：新空表先成功后旧全表迟到不写回；最新失败保留旧快照', async () => {
  const networkPath = require.resolve('../src/utils/network');
  const protoPath = require.resolve('../src/utils/proto');
  const apiPath = require.resolve('../src/services/friend-api');
  const prev = {
    network: require.cache[networkPath],
    proto: require.cache[protoPath],
    api: require.cache[apiPath],
  };

  // 每次调用消费一项 { delay, reply?, reject? }；reply 在延迟结束后生效
  const behaviors = [];
  require.cache[networkPath] = mockModule(networkPath, {
    sendMsgAsync: async () => {
      const b = behaviors.shift();
      if (!b) throw new Error('测试未排队回包行为');
      await new Promise(r => setTimeout(r, b.delay));
      if (b.reject) throw new Error('网络失败(测试注入)');
      latestReply = b.reply;
      return { body: Buffer.alloc(0) };
    },
  });
  let latestReply = { game_friends: [] };
  require.cache[protoPath] = mockModule(protoPath, {
    types: {
      GetAllFriendsRequest: {
        create: () => ({}),
        encode: () => ({ finish: () => Buffer.alloc(0) }),
      },
      GetAllFriendsReply: { decode: () => latestReply },
    },
  });
  delete require.cache[apiPath];

  let prevPlatform;
  try {
    const friendApi = require('../src/services/friend-api');
    const { CONFIG } = require('../src/config/config');
    prevPlatform = CONFIG.platform;
    CONFIG.platform = 'wechat';

    // 场景 1：A(旧请求, 全表, 慢) 与 B(新请求, 空表=删好友, 快) 并发，
    // B 先成功、A 迟到成功——快照必须是 B 的权威空表，不得写回已删好友
    behaviors.push({ delay: 120, reply: { game_friends: [{ gid: 111 }, { gid: 222 }] } });
    const a = friendApi.getAllFriends();
    behaviors.push({ delay: 10, reply: { game_friends: [] } });
    const b = friendApi.getAllFriends();
    const replyA = await a;
    const replyB = await b;
    assert.deepEqual(replyA.game_friends.map(f => Number(f.gid)), [111, 222],
      '各调用自身返回值不受序号保护影响（API 语义不变）');
    assert.deepEqual(replyB.game_friends, [], 'B 返回空表');
    let snap = friendApi.getRosterSnapshot();
    assert.deepEqual(snap.gids, [], '旧全表迟到不得覆盖新空表');
    assert.ok(snap.at > 0, '快照带真实成功时刻');

    // 场景 2：C(旧请求, 全表, 成功但迟到) + D(最新请求, 失败)——
    // 最新失败不消耗成功序号：旧请求随后合法成功仍可发布快照
    behaviors.push({ delay: 120, reply: { game_friends: [{ gid: 111 }] } });
    const c = friendApi.getAllFriends();
    behaviors.push({ delay: 5, reject: true });
    const d = friendApi.getAllFriends();
    d.catch(() => { }); // 先挂 handler 防未处理拒绝告警
    await c;
    await assert.rejects(d, /网络失败/, '最新请求失败应原样抛出');
    snap = friendApi.getRosterSnapshot();
    assert.deepEqual(snap.gids, [111], '新请求失败不得阻止旧请求合法成功发布');
    assert.ok(snap.at > 0);
  } finally {
    if (prevPlatform !== undefined) {
      try { require('../src/config/config').CONFIG.platform = prevPlatform; } catch { /* ignore */ }
    }
    delete require.cache[apiPath];
    for (const [path, entry] of [
      [apiPath, prev.api], [networkPath, prev.network], [protoPath, prev.proto],
    ]) {
      if (entry) require.cache[path] = entry;
      else delete require.cache[path];
    }
  }
});
