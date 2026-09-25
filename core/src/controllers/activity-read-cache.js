const ACTIVITY_UPSTREAM_CACHE_MS = 60 * 1000;

function createActivityReadCache(options = {}) {
  const ttlMs = Math.max(1_000, Number(options.ttlMs) || ACTIVITY_UPSTREAM_CACHE_MS);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const values = new Map();
  const failures = new Map();
  const inFlight = new Map();

  async function read(key, loader) {
    const cacheKey = String(key);
    const cached = values.get(cacheKey);
    if (cached && now() - cached.storedAt < ttlMs) {
      return { value: cached.value, upstreamCached: true };
    }
    const cachedFailure = failures.get(cacheKey);
    if (cachedFailure && now() - cachedFailure.storedAt < ttlMs) {
      throw cachedFailure.error;
    }
    if (inFlight.has(cacheKey)) {
      return { value: await inFlight.get(cacheKey), upstreamCached: true };
    }
    // loader 必须收到 cacheKey：调用方有两种写法（传 key 用参数 / 内联闭包），
    // 早期 `then(loader)` 以无参调用，参数风格的 loader 拿到 undefined →
    // resolveAccountId('') → 误报「账号未运行」（2026-09-25 活动面板事故）。
    const pending = Promise.resolve().then(() => loader(cacheKey));
    inFlight.set(cacheKey, pending);
    try {
      const value = await pending;
      if (inFlight.get(cacheKey) === pending) {
        values.set(cacheKey, { value, storedAt: now() });
        failures.delete(cacheKey);
      }
      return { value, upstreamCached: false };
    } catch (error) {
      if (inFlight.get(cacheKey) === pending) {
        failures.set(cacheKey, { error, storedAt: now() });
      }
      throw error;
    } finally {
      if (inFlight.get(cacheKey) === pending) {
        inFlight.delete(cacheKey);
      }
    }
  }

  function clear(key) {
    const cacheKey = String(key);
    // 键格式是 `route:accountId`；调用方手动操作后传裸 accountId 清全部面板。
    const suffix = `:${cacheKey}`;
    for (const store of [values, failures, inFlight]) {
      for (const k of store.keys()) {
        if (k === cacheKey || k.endsWith(suffix)) store.delete(k);
      }
    }
  }

  return { read, clear };
}

module.exports = { ACTIVITY_UPSTREAM_CACHE_MS, createActivityReadCache };
