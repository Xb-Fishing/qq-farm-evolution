function timestamp(value) {
  if (value == null || value === '' || !['number', 'string'].includes(typeof value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function unavailable(reason, endTime = null) {
  return { available: false, reason, endTime, personal: null };
}

module.exports = { timestamp, unavailable };
