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

module.exports = { ACTIVITY_UPSTREAM_CACHE_MS, createActivityReadCache };
