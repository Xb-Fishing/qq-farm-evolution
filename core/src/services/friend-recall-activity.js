// Pure management DTO: never forward payloads, player identities or resource paths.
const FRIEND_RECALL_ROOT_ACTIVITY_ID = 2026111800;
const FRIEND_RECALL_ACTIVITY_ID = 2026111801;
function text(value) {
  return typeof value === 'string' ? value.slice(0, 16000).replace(/<br\s*(?:\/\s*)?>/gi, '\n').replace(/<[^>]*>/g, '').trim() : '';
}
function timestamp(value) {
  if (value == null || value === '' || !['number', 'string'].includes(typeof value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
function findRoot(list) {
  if (!Array.isArray(list)) throw new Error('活动列表格式异常');
  return list.find(node => node?.id === FRIEND_RECALL_ROOT_ACTIVITY_ID && node.parentId === 0) || null;
}
function findChild(nodes) {
  return Array.isArray(nodes) ? nodes.find(node => node?.id === FRIEND_RECALL_ACTIVITY_ID
    && node.parentId === FRIEND_RECALL_ROOT_ACTIVITY_ID && node.type === 11
    && node.payload?.uid === 'FriendRecallUI') || null : null;
}
function unavailable(reason, endTime = null) {
  return { available: false, reason, endTime, personal: null };
}
function normalizeFriendRecall(root, now = Date.now() / 1000) {
  if (root?.id !== FRIEND_RECALL_ROOT_ACTIVITY_ID || root.parentId !== 0) return unavailable('活动根信息不匹配');
  const child = findChild(root.children);
  const ends = [timestamp(root.endTime), timestamp(child?.endTime)].filter(value => value != null);
  const endTime = ends.length ? Math.min(...ends) : null;
  if (endTime != null && now >= endTime) return unavailable('活动已结束', endTime);
  const payload = child?.payload;
  if (!payload || payload.uid !== 'FriendRecallUI') return unavailable('当前规则信息不可用', endTime);
  const lines = value => Array.isArray(value) ? value.slice(0, 80).map(text).filter(Boolean) : [];
  // Dates have their own display; section headings are not gameplay steps.
  const content = rows => rows.filter(line => !/^【|^\d{4}年|^\d+[、.].{0,18}$/.test(line));
  const recall = content(lines(payload.tips?.txt));
  const returning = content(lines(payload.buffTips?.txt));
  if (!recall.length || !returning.length) return unavailable('当前规则内容缺失', endTime);
  const interaction = line => /互动|礼包.*上限|上限.*礼包/.test(line);
  const mail = line => /邮件|补发/.test(line);
  const unique = rows => [...new Set(rows)];
  const starts = [timestamp(root.startTime), timestamp(child?.startTime)].filter(value => value != null);
  return {
    available: true, title: text(root.title) || '故友重逢', startTime: starts.length ? Math.max(...starts) : null, endTime,
    personal: null,
    sections: [
      { key: 'recall', title: '召回老友', lines: recall.filter(line => !interaction(line) && !mail(line)) },
      { key: 'return', title: '回归福利', lines: returning.filter(line => !interaction(line) && !mail(line)) },
      { key: 'interaction', title: '农场互动', lines: unique([...recall, ...returning].filter(interaction)) },
      { key: 'records', title: text(payload.recalledTips?.title) || '召回记录', lines: unique([text(payload.recalledTips?.desc), ...recall.filter(mail), ...returning.filter(mail)].filter(Boolean)) },
      { key: 'buffs', title: '回归增益', lines: Array.isArray(payload.buffList) ? payload.buffList.slice(0, 20).map(item => [text(item?.name), text(item?.desc)].filter(Boolean).join('：')).filter(Boolean) : [] },
    ],
    eligibility: '公告补充：连续7日未登录的农场主可参与回归；个人资格以官方游戏为准。',
  };
}
module.exports = { FRIEND_RECALL_ROOT_ACTIVITY_ID, FRIEND_RECALL_ACTIVITY_ID, findRoot, findChild, timestamp, unavailable, normalizeFriendRecall };
