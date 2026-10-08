const DOG_INFO_HTTP_TIMEOUT_MS = 11 * 60 * 1000;

function getAccountOrRespond(req, res, { getAccountIdFromRequest, canAccessAccount, includeMissingMessage = true }) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    const payload = { ok: false };
    if (includeMissingMessage) payload.error = "Missing x-account-id";
    res.status(400).json(payload);
    return null;
  }
  if (!canAccessAccount(req, accountId)) {
    res.status(403).json({ ok: false, error: "无权访问此账号" });
    return null;
  }
  return accountId;
}

async function getFriendMetaByGid(provider, accountId) {
  let friends = [];
  try {
    if (provider && typeof provider.getFriends === "function") {
      friends = (await provider.getFriends(accountId)) || [];
    }
  } catch {}

  const metaByGid = new Map();
  for (const friend of friends) {
    const gid = Number(friend && friend.gid);
    if (gid > 0) {
      metaByGid.set(gid, {
        name: friend.name || friend.remark || "",
        avatarUrl: friend.avatarUrl || friend.avatar_url || "",
      });
    }
  }
  return metaByGid;
}

function formatFriendBlacklist(gids, metaByGid) {
  return gids.map((gid) => {
    const meta = metaByGid.get(Number(gid)) || {};
    return {
      gid: Number(gid),
      name: meta.name || "",
      avatarUrl: meta.avatarUrl || "",
    };
  });
}

function getKnownFriendGidsData(store, accountId) {
  return {
    knownFriendGids: store.getKnownFriendGids
      ? store.getKnownFriendGids(accountId)
      : [],
  };
}

function broadcastConfig(provider, accountId) {
  if (provider && typeof provider.broadcastConfig === "function") {
    provider.broadcastConfig(accountId);
    return true;
  }
  return false;
}

// ===== 重点名单本地构建（2026-10-07 陈旧名单治理）=====
// 只从配置与暂停状态镜像构建响应：零 provider.getFriends 调用、零上游
// 游戏请求——Worker 停止/在线冷缓存时 GET 也必须立即可用。名称/头像缺失
// 返回空值，由前端与已加载好友列表拼接展示。
function buildWatchlistPayload(store, accountId) {
  const watchlist = store.getWatchlistFriendGids
    ? store.getWatchlistFriendGids(accountId)
    : [];
  const mirror = store.readWatchlistStateMirror
    ? store.readWatchlistStateMirror(accountId)
    : null;
  const rows = mirror && mirror.rows && typeof mirror.rows === "object"
    ? mirror.rows
    : {};
  const meta = store.getWatchlistResetMeta
    ? store.getWatchlistResetMeta(accountId)
    : null;

  const data = watchlist.map((gid) => {
    const row = rows[Number(gid)] || rows[String(gid)] || {};
    return {
      gid: Number(gid),
      name: "",
      avatarUrl: "",
      paused: row.paused === true,
      pausedAt: Number(row.pausedAt) || 0,
      trailingFailures: Number(row.trailingFailures) || 0,
    };
  });
  return {
    data,
    meta: {
      opSeq: meta ? Number(meta.opSeq) || 0 : 0,
      consumedOpSeq: mirror ? Number(mirror.consumedOpSeq) || 0 : 0,
    },
  };
}

/**
 * 保存重点名单并构建响应。保存失败回滚由 store.setWatchlistConfig 保证；
 * 此处只在成功保存后才尝试配置广播（notifyAttempted 只表示"尝试过通知"，
 * 不代表 Worker 已收到或已消费——面板据此展示三态）。
 */
function saveWatchlistAndRespond(store, provider, req, res, accountId, nextGids, intentGids) {
  let saved = false;
  try {
    if (store.setWatchlistConfig) {
      store.setWatchlistConfig(accountId, nextGids, intentGids);
      saved = true;
    }
  } catch {
    saved = false;
  }
  const notifyAttempted = saved ? broadcastConfig(provider, accountId) : false;
  const payload = buildWatchlistPayload(store, accountId);
  res.json({
    ok: saved,
    saved,
    notifyAttempted,
    data: payload.data,
    meta: payload.meta,
  });
}

function registerAdminFriendRoutes({
  app,
  provider,
  store,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  const access = { getAccountIdFromRequest, canAccessAccount };

  app.get("/api/friends", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, {
      ...access,
      includeMissingMessage: false,
    });
    if (!accountId) return;

    try {
      const forceSync = req.query.forceSync === "true";
      const data = await provider.getFriends(accountId, forceSync);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/friends/clear-cache", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      await provider.clearFriendsCache(accountId);
      res.json({ ok: true });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  // 只读探测：好友摘要字段在线漂移验证（2026-09-22）。gapMs 5-60s，默认 15s；
  // 两次全量摘要都走既有通道与请求治理预算，超时按最长间隔放宽。
  app.get("/api/friends/summary-drift-probe", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;
    const gapMs = Number(req.query.gapMs) || 15_000;

    req.setTimeout(90_000);
    res.setTimeout(90_000);
    try {
      if (typeof provider.probeFriendSummaryDrift !== "function") {
        throw new TypeError("当前运行版本未加载探测入口，请重启后再试");
      }
      const data = await provider.probeFriendSummaryDrift(accountId, gapMs);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/friends/fetch-dog-info", async (req, res) => {
    req.setTimeout(DOG_INFO_HTTP_TIMEOUT_MS);
    res.setTimeout(DOG_INFO_HTTP_TIMEOUT_MS);

    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      const result = await provider.fetchFriendsDogInfo(accountId);
      res.json(result);
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.get("/api/interact-records", async (req, res) => {
    const accountId = getAccountIdFromRequest(req);
    if (!accountId) {
      return res.status(400).json({ ok: false, error: "Missing x-account-id" });
    }

    try {
      const data = await provider.getInteractRecords(accountId);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.get("/api/friend/:gid/lands", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, {
      ...access,
      includeMissingMessage: false,
    });
    if (!accountId) return;

    try {
      const data = await provider.getFriendLands(accountId, req.params.gid);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/friend/:gid/op", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      const opType = String((req.body || {}).opType || "");
      const data = await provider.doFriendOp(accountId, req.params.gid, opType);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.get("/api/friend/:gid/dog", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      const data = await provider.getFriendDogInfo(accountId, req.params.gid);
      res.json({ ok: true, data });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/friend/:gid/delete", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      const gid = Number(req.params.gid);
      if (!gid) {
        return res.status(400).json({ ok: false, error: "无效的好友 GID" });
      }

      await provider.delFriend(accountId, gid);
      res.json({ ok: true, message: "删除好友成功" });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.get("/api/friend-blacklist", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const blacklist = store.getFriendBlacklist
      ? store.getFriendBlacklist(accountId)
      : [];
    const metaByGid = await getFriendMetaByGid(provider, accountId);
    res.json({
      ok: true,
      data: formatFriendBlacklist(blacklist, metaByGid),
    });
  });

  app.post("/api/friend-blacklist/toggle", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const gid = Number((req.body || {}).gid);
    if (!gid) {
      return res.status(400).json({ ok: false, error: "Missing gid" });
    }

    const blacklist = store.getFriendBlacklist
      ? store.getFriendBlacklist(accountId)
      : [];
    const nextBlacklist = blacklist.includes(gid)
      ? blacklist.filter((item) => item !== gid)
      : [...blacklist, gid];
    const saved = store.setFriendBlacklist
      ? store.setFriendBlacklist(accountId, nextBlacklist)
      : nextBlacklist;
    if (provider && typeof provider.broadcastConfig === "function") {
      provider.broadcastConfig(accountId);
    }

    const metaByGid = await getFriendMetaByGid(provider, accountId);
    res.json({
      ok: true,
      data: formatFriendBlacklist(saved, metaByGid),
    });
  });

  app.get("/api/friend-watchlist", (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const payload = buildWatchlistPayload(store, accountId);
    res.json({ ok: true, data: payload.data, meta: payload.meta });
  });

  app.post("/api/friend-watchlist/toggle", (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const gid = Number((req.body || {}).gid);
    if (!gid) {
      return res.status(400).json({ ok: false, error: "Missing gid" });
    }

    const watchlist = store.getWatchlistFriendGids
      ? store.getWatchlistFriendGids(accountId)
      : [];
    const nextWatchlist = watchlist.includes(gid)
      ? watchlist.filter((item) => item !== gid)
      : [...watchlist, gid];
    // 名单变更即意图：remove-re-add 不继承旧暂停状态（差集自动登记）
    saveWatchlistAndRespond(store, provider, req, res, accountId, nextWatchlist, undefined);
  });

  // 恢复某目标的普通基线巡田（用户意图，opSeq 单调递增；对旧暂停立即生效）
  app.post("/api/friend-watchlist/resume", (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const gid = Number((req.body || {}).gid);
    if (!gid) {
      return res.status(400).json({ ok: false, error: "Missing gid" });
    }
    const watchlist = store.getWatchlistFriendGids
      ? store.getWatchlistFriendGids(accountId)
      : [];
    if (!watchlist.includes(gid)) {
      return res.status(400).json({ ok: false, error: "该好友不在重点名单" });
    }
    saveWatchlistAndRespond(store, provider, req, res, accountId, watchlist, [gid]);
  });

  // 移出重点名单（显式移除意图：在途旧 Enter 结果不得污染新名单状态）
  app.post("/api/friend-watchlist/remove", (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const gid = Number((req.body || {}).gid);
    if (!gid) {
      return res.status(400).json({ ok: false, error: "Missing gid" });
    }
    const watchlist = store.getWatchlistFriendGids
      ? store.getWatchlistFriendGids(accountId)
      : [];
    const nextWatchlist = watchlist.filter((item) => item !== gid);
    saveWatchlistAndRespond(store, provider, req, res, accountId, nextWatchlist, [gid]);
  });

  // 在线自动捣乱：好友上线（活跃证据）时巡查顺带随机放虫/放草，名单独立于重点监控
  app.get("/api/friend-auto-bad", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const list = store.getAutoBadFriendGids
      ? store.getAutoBadFriendGids(accountId)
      : [];
    const metaByGid = await getFriendMetaByGid(provider, accountId);
    res.json({
      ok: true,
      data: formatFriendBlacklist(list, metaByGid),
    });
  });

  app.post("/api/friend-auto-bad/toggle", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const gid = Number((req.body || {}).gid);
    if (!gid) {
      return res.status(400).json({ ok: false, error: "Missing gid" });
    }

    // 旧配置可能残留字符串 gid：归一化数值并去重后再判断开/关
    const list = [...new Set(
      (store.getAutoBadFriendGids ? store.getAutoBadFriendGids(accountId) : [])
        .map(Number)
        .filter(Number.isFinite),
    )];
    const next = list.includes(gid)
      ? list.filter((item) => item !== gid)
      : [...list, gid]; // list 已归一化去重，不会写出重复/字符串 gid
    const saved = store.setAutoBadFriendGids
      ? store.setAutoBadFriendGids(accountId, next)
      : next;
    if (provider && typeof provider.broadcastConfig === "function") {
      provider.broadcastConfig(accountId);
    }

    const metaByGid = await getFriendMetaByGid(provider, accountId);
    res.json({
      ok: true,
      data: formatFriendBlacklist(saved, metaByGid),
    });
  });

  app.get("/api/friend-known-gids", (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      res.json({ ok: true, data: getKnownFriendGidsData(store, accountId) });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/friend-known-gids", (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      if (body.knownFriendGids !== undefined && store.setKnownFriendGids) {
        store.setKnownFriendGids(accountId, body.knownFriendGids);
      }
      broadcastConfig(provider, accountId);
      res.json({ ok: true, data: getKnownFriendGidsData(store, accountId) });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/friend-known-gids/remove", (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const gid = Number((req.body || {}).gid);
    if (!Number.isFinite(gid) || gid <= 0) {
      return res.status(400).json({ ok: false, error: "GID 无效" });
    }

    try {
      const knownGids = store.getKnownFriendGids
        ? store.getKnownFriendGids(accountId)
        : [];
      const nextKnownGids = Array.isArray(knownGids)
        ? knownGids.filter((item) => Number(item) !== gid)
        : [];
      if (store.setKnownFriendGids) {
        store.setKnownFriendGids(accountId, nextKnownGids);
      }
      broadcastConfig(provider, accountId);
      res.json({ ok: true, data: getKnownFriendGidsData(store, accountId) });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/friend-known-gids/batch-add", async (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const gids = (req.body || {}).gids;
    if (!Array.isArray(gids) || gids.length === 0) {
      return res.status(400).json({ ok: false, error: "GID 列表无效" });
    }

    try {
      const knownGids = store.getKnownFriendGids
        ? store.getKnownFriendGids(accountId)
        : [];
      const nextKnownGids = new Set(knownGids.map(Number));
      let addedCount = 0;
      for (const rawGid of gids) {
        const gid = Number(rawGid);
        if (!Number.isFinite(gid) || gid <= 0) continue;
        if (!nextKnownGids.has(gid)) {
          nextKnownGids.add(gid);
          addedCount++;
        }
      }

      if (store.setKnownFriendGids) {
        store.setKnownFriendGids(accountId, Array.from(nextKnownGids));
      }
      broadcastConfig(provider, accountId);
      res.json({
        ok: true,
        data: getKnownFriendGidsData(store, accountId),
        addedCount,
        message:
          addedCount > 0
            ? '已添加好友GID，请点击"刷新列表"获取好友信息，然后点击"获取狗信息"获取狗信息。处理中请勿频繁访问好友界面。'
            : "",
      });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/api/friend-known-gids/batch-remove", (req, res) => {
    const accountId = getAccountOrRespond(req, res, access);
    if (!accountId) return;

    const gids = (req.body || {}).gids;
    if (!Array.isArray(gids) || gids.length === 0) {
      return res.json({
        ok: true,
        data: getKnownFriendGidsData(store, accountId),
        removedCount: 0,
      });
    }

    try {
      const knownGids = store.getKnownFriendGids
        ? store.getKnownFriendGids(accountId)
        : [];
      const gidSet = new Set(
        gids.map(Number).filter((gid) => Number.isFinite(gid) && gid > 0),
      );
      const nextKnownGids = knownGids.filter(
        (gid) => !gidSet.has(Number(gid)),
      );
      const removedCount = knownGids.length - nextKnownGids.length;
      if (removedCount > 0 && store.setKnownFriendGids) {
        store.setKnownFriendGids(accountId, nextKnownGids);
      }
      res.json({
        ok: true,
        data: getKnownFriendGidsData(store, accountId),
        removedCount,
      });
    } catch (error) {
      sendProviderError(res, error);
    }
  });
}

module.exports = { registerAdminFriendRoutes };
