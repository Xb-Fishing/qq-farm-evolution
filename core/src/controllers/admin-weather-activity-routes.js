const {
  getAuthorizedAccountId,
  requireConnectedAccount,
} = require('./admin-activity-route-helpers');

const WEATHER_ACTIVITY_UPSTREAM_CACHE_MS = 60 * 1000;

function createActivityReadCache(options = {}) {
  const ttlMs = Math.max(1_000, Number(options.ttlMs) || WEATHER_ACTIVITY_UPSTREAM_CACHE_MS);
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
    const pending = Promise.resolve().then(loader);
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
    values.delete(cacheKey);
    failures.delete(cacheKey);
    inFlight.delete(cacheKey);
  }

  return { read, clear };
}

function registerAdminWeatherActivityRoutes({
  app,
  provider,
  getAccountIdFromRequest,
  canAccessAccount,
  sendProviderError,
}) {
  const routeContext = {
    getAccountIdFromRequest,
    canAccessAccount,
  };
  const activityReader = createActivityReadCache();

  app.get('/api/activity/weather', async (req, res) => {
    const accountId = getAuthorizedAccountId(req, res, routeContext);
    if (!accountId) return;

    try {
      if (!requireConnectedAccount(res, provider, accountId, '获取雨落成诗失败: 账号未运行'))
        return;
      const result = await activityReader.read(
        accountId,
        () => provider.getWeatherActivity(accountId),
      );
      res.json({
        ok: true,
        activity: result.value,
        upstreamCached: result.upstreamCached,
        upstreamCacheMs: WEATHER_ACTIVITY_UPSTREAM_CACHE_MS,
      });
    } catch (err) {
      sendProviderError(res, err);
    }
  });
}

module.exports = {
  WEATHER_ACTIVITY_UPSTREAM_CACHE_MS,
  createActivityReadCache,
  registerAdminWeatherActivityRoutes,
};
