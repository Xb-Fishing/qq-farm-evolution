const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const h = require('./activity-availability.test');
const roots = [];
const files = [__filename, path.join(h.WEB, 'src/components/activity/MilkTeaActivityPanel.vue')];
const fingerprint = () => files.map(file => ({ mode: fs.statSync(file).mode & 0o777,
  sha: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
const before = fingerprint();
test.after(() => { try { for (const root of roots) h.render(null, root); } finally { assert.deepEqual(fingerprint(), before); } });
function panel(patch = {}) {
  const Component = h.compileSfcModule(files[1], spec => spec === 'vue' ? h.vue : undefined);
  const queries = Object.fromEntries(['shop', 'hireList', 'workshop', 'work', 'rank', 'sales'].map(kind => [kind, { data: null, loading: false, error: '' }]));
  queries.shop.data = { pendingRewards: [{ id: 1041, count: 5 }], slots: [] };
  Object.assign(queries, patch);
  const root = h.makeNode('root'); roots.push(root); const writes = [];
  h.render(h.vue.h(Component, { activity: h.snapshot({ summary: { shopOpenAt: 1 }, inventory: { available: true, ticketCount: 20, boostItemCount: 1 } }), queries, onOperate: (...args) => writes.push(args) }), root);
  return { root, writes };
}
const button = (root, text) => h.buttonsOf(root).find(node => h.textOf(node).trim() === text);
for (const mode of ['escape', 'cancel']) {
  test(`confirmation ${mode} closes without a write and returns focus to its triggering control`, async () => {
    const f = panel(); const original = document.activeElement; let focuses = 0;
    document.activeElement = { isConnected: true, focus: () => { focuses += 1; } };
    try {
      h.click(button(f.root, '领取收银台')); await h.vue.nextTick();
      const dialog = h.findAll(f.root, node => node.props.role === 'dialog')[0]; assert.ok(dialog);
      assert.equal(f.writes.length, 0);
      if (mode === 'escape') {
        const keyboard = h.findAll(f.root, node => typeof node.props.onKeydown === 'function')[0];
        assert.ok(keyboard, 'the actual confirmation must support keyboard cancellation');
        keyboard.props.onKeydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
      }
      else { h.click(button(f.root, '取消')); }
      await h.vue.nextTick(); await h.flush();
      assert.equal(h.findAll(f.root, node => node.props.role === 'dialog').length, 0);
      assert.equal(f.writes.length, 0); assert.equal(focuses, 1, 'closing confirmation restores its trigger focus');
    }
    finally { document.activeElement = original; h.render(null, f.root); }
  });
}
test('the styled confirmation keeps explicit one-click execution and no action on open', async () => {
  const f = panel();
  h.click(button(f.root, '领取收银台')); await h.vue.nextTick(); assert.equal(f.writes.length, 0);
  h.click(button(f.root, '确认执行')); await h.vue.nextTick();
  assert.deepEqual(f.writes, [['claimCashier', {}]]);
  assert.equal(h.findAll(f.root, node => node.props.role === 'dialog').length, 0);
});
test('real available slots, recipes and interactions replace invalid default selections without automatic requests', async () => {
  const data = value => ({ data: value, loading: false, error: '' });
  const f = panel({ shop: data({ slots: [{ slotIndex: 4 }] }), hireList: data({ durationId: 1, robots: [{ gid: '9001', name: '员工' }] }),
    workshop: data({ recipes: [{ recipeId: 7, name: '可用配方', unlocked: true }], fruits: [{ uid: '7001', name: '果实', count: 2 }] }),
    work: data({ myShift: { shiftId: '8001', interactPreviews: [{ interactionType: 3 }] } }) });
  const set = (label, value) => { const node = h.findAll(f.root, n => n.props['aria-label'] === label)[0]; assert.ok(node); node.props['onUpdate:modelValue'](value); };
  set('雇佣候选', '9001'); set('加工果实', '7001'); await h.vue.nextTick(); assert.equal(f.writes.length, 0);
  for (const label of ['雇佣所选员工', '加工所选果实', '执行班次互动']) {
    h.click(button(f.root, label)); await h.vue.nextTick(); h.click(button(f.root, '确认执行')); await h.vue.nextTick();
  }
  assert.equal(f.writes[0][1].hires[0].slotIndex, 4); assert.equal(f.writes[1][1].recipeId, 7); assert.equal(f.writes[2][1].interactionType, 3);
});
test('known empty reward and wage states show disabled actions while the shop remains readable', () => {
  const f = panel({ shop: { data: { pendingRewards: [], slots: [] }, loading: false, error: '' }, work: { data: { slips: [] }, loading: false, error: '' } });
  for (const label of ['开店', '领取收银台', '领取工资']) assert.equal(button(f.root, label).props.disabled, true, label);
  assert.equal(button(f.root, '查询店铺与收银台').props.disabled, false); assert.equal(f.writes.length, 0);
});
