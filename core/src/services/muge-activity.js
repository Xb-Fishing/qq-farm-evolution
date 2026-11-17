// Read only: the current List/GetGroup payload proves rules, not personal progress.
const MUGE_ROOT_ACTIVITY_ID = 2026111700;
const { timestamp, unavailable } = require('./friend-recall-activity');
const MODULES = ['兴牧庆典', '牧友同行', '成长手册', '牧场人格'];
function text(value) {
  return typeof value === 'string' ? value.slice(0, 16000).replace(/<br\s*(?:\/\s*)?>/gi, '\n').replace(/<[^>]*>/g, '').trim() : '';
}
function findRoot(list) {
  if (!Array.isArray(list)) throw new Error('活动列表格式异常');
  return list.find(node => node?.id === MUGE_ROOT_ACTIVITY_ID && node.parentId === 0) || null;
}
function normalizeMuge(root, now = Date.now() / 1000) {
  if (root?.id !== MUGE_ROOT_ACTIVITY_ID || root.parentId !== 0 || root.payload?.uid !== 'MugeMainUI') return unavailable('当前牧歌规则信息不可用');
  const endTime = timestamp(root.endTime);
  if (endTime != null && now >= endTime) return unavailable('活动已结束', endTime);
  const startTime = timestamp(root.startTime);
  const lines = Array.isArray(root.payload.tips?.txt) ? root.payload.tips.txt.slice(0, 80).map(text).filter(Boolean) : [];
  const sections = MODULES.map((title, index) => ({
    key: String(index), title, lines: lines.filter(line => new RegExp(`^\\d+[.、]\\s*${title}[：:]`).test(line)),
  }));
  if (sections.some(section => !section.lines.length)) return unavailable('当前牧歌规则内容缺失', endTime);
  return {
    available: true, title: text(root.title) || '牧歌初启', startTime, endTime, personal: null,
    phase: startTime != null && now < startTime ? 'upcoming' : 'open', sections,
    notes: lines.filter(line => /邮件|补发/.test(line)),
  };
}
module.exports = { MUGE_ROOT_ACTIVITY_ID, timestamp, unavailable, findRoot, normalizeMuge };
