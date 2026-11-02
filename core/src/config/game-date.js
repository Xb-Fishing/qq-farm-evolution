function gameDateKey(timestamp) {
  const time = Number(timestamp);
  if (!Number.isFinite(time) || time <= 0) return '';
  const date = new Date(time + 8 * 3600000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

module.exports = { gameDateKey };
