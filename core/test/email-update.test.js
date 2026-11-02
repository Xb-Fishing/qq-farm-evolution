const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { harness } = require('./email-update-baseline.test');
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('mail read coalesces, retains per-box failures and never writes; offline cached data is rejected', async t => {
  const h = harness(t); h.add(1, 'same-id'); h.add(2, 'same-id'); h.state.fail.add(2);
  const [a, b] = await Promise.all([h.service.getEmailSnapshot(), h.service.getEmailSnapshot()]);
  assert.equal(a.partial, true); assert.equal(b.boxes[1].total, 1); assert.equal(a.boxes[2].ok, false);
  assert.equal(h.count('GetEmailList'), 2); assert.equal(h.count('BatchClaimEmail'), 0);
  assert.doesNotMatch(JSON.stringify(a), /same-id/);
  await h.service.getEmailSnapshot(); assert.equal(h.count('GetEmailList'), 2);
  const file = path.join(h.dir, 'email-snapshots', fs.readdirSync(path.join(h.dir, 'email-snapshots'))[0]);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  h.state.connected = false; await assert.rejects(h.service.getEmailSnapshot()); assert.equal(h.count('GetEmailList'), 2);
});
test('same id in two boxes remains distinct; concurrent claims issue one batch per box', async t => {
  const h = harness(t); h.add(1, 'same'); h.add(2, 'same');
  const result = await Promise.all([h.service.checkAndClaimEmails(), h.service.checkAndClaimEmails(true)]);
  assert.equal(h.count('BatchClaimEmail'), 2); assert.equal(result[0].claimed, 2); assert.equal(result[1].claimed, 2);
});
test('unknown batch survives later mail, restart and midnight; no individual fallback or overwritten reservation', async t => {
  const h = harness(t); h.add(1, 'pending');
  h.state.hook = async method => { if (method === 'BatchClaimEmail') throw new Error('synthetic timeout'); };
  await h.service.checkAndClaimEmails(); h.add(1, 'new'); h.state.now += 86400000;
  await h.service.checkAndClaimEmails(); assert.equal(h.count('BatchClaimEmail'), 1);
  const next = harness(t, { dir: h.dir }); next.state.boxes = h.state.boxes; next.state.now = h.state.now;
  await next.service.checkAndClaimEmails(); assert.equal(next.count('BatchClaimEmail'), 0);
  assert.equal(next.count('ClaimEmail'), 0); assert.equal(next.service.getEmailDailyState().doneToday, false);
});
test('only an explicit claimed marker resolves a reservation; disappearance alone cannot inflate claimed count', async t => {
  const h = harness(t); h.add(1, 'pending'); h.state.hook = async method => { if (method === 'BatchClaimEmail') throw new Error('unknown'); };
  await h.service.checkAndClaimEmails(); h.state.boxes[1] = []; h.state.now += 300001;
  let result = await h.service.checkAndClaimEmails(); assert.equal(result.claimed, 0); assert.equal(result.unknown, true);
  h.state.boxes[1] = [{ id: 'pending', has_reward: true, claimed: true }]; h.state.now += 300001;
  result = await h.service.checkAndClaimEmails(); assert.equal(result.claimed, 1); assert.equal(h.count('BatchClaimEmail'), 1);
  h.state.now += 300001; result = await h.service.checkAndClaimEmails(); assert.equal(result.claimed, 0);
});
test('corrupt journal and symlink paths block writes without changing the outside target', async t => {
  const h = harness(t); h.add(1, 'one'); const dir = path.join(h.dir, 'email-claim-declarations'); assert.ok(dir.startsWith(h.dir + path.sep));
  fs.mkdirSync(dir); const file = path.join(dir, `${crypto.createHash('sha256').update('fixture-mail').digest('hex').slice(0, 24)  }.json`);
  fs.writeFileSync(file, '{bad'); const result = await h.service.checkAndClaimEmails(); assert.equal(result.stateBlocked, true); assert.equal(h.count('BatchClaimEmail'), 0);
  const other = harness(t); other.add(1, 'two'); const target = path.join(other.dir, 'outside'); fs.writeFileSync(target, 'unchanged');
  fs.symlinkSync(target, path.join(other.dir, 'email-claim-declarations'));
  await other.service.checkAndClaimEmails(); assert.equal(other.count('BatchClaimEmail'), 0); assert.equal(fs.readFileSync(target, 'utf8'), 'unchanged');
});
test('connection replacement during a read discards late data and starts no remaining reads or writes', async t => {
  const h = harness(t); const gate = defer(); h.state.hook = async method => { if (method === 'GetEmailList') await gate.promise; };
  const read = h.service.getEmailSnapshot(); h.state.connection = {}; gate.resolve(); await assert.rejects(read);
  assert.equal(h.count('GetEmailList'), 1); assert.equal(h.count('BatchClaimEmail'), 0);
});
test('strict zero-send local budget rejection may release once; ordinary business refusal remains reserved', async t => {
  for (const strict of [true, false]) {
    const h = harness(t); h.add(1, 'one'); let reject = true;
    h.state.hook = async method => { if (method === 'BatchClaimEmail' && reject) {
      reject = false;
      throw Object.assign(new Error('synthetic rejection'), strict ? { isGovernedRejection: true, governedReason: 'budget_total' } : { isServerBusinessError: true, serverErrorCode: 71 });
    } };
    await h.service.checkAndClaimEmails(); h.state.now += 300001; await h.service.checkAndClaimEmails();
    assert.equal(h.count('BatchClaimEmail'), strict ? 2 : 1);
  }
});

test('actual mail claim log resolves official tickets separately from legacy experience aliases', async t => {
  const h = harness(t, { getItemById: id => id === 1002 ? { name: '点券' } : undefined }); h.add(1, 'currency');
  h.state.hook = async method => {
    if (method !== 'BatchClaimEmail') return;
    h.state.boxes[1][0].claimed = true;
    return { body: h.encode('BatchClaimEmailReply', { items: [{ id: 1002, count: 150 }, { id: 500002, count: 7 }] }) };
  };
  await h.service.checkAndClaimEmails(); const text = h.state.logs.map(row => row[1]).join('\n');
  assert.match(text, /点券150/); assert.match(text, /经验7/); assert.doesNotMatch(text, /经验150/);
});
test('read-only mailbox cache expires at Beijing day change and each box has a bounded read timeout', async t => {
  const h = harness(t); h.state.now = Date.parse('2026-11-02T15:59:50Z'); await h.service.getEmailSnapshot();
  h.state.now += 20000; await h.service.getEmailSnapshot(); assert.equal(h.count('GetEmailList'), 4);
  assert.ok(h.state.calls.filter(row => row.method === 'GetEmailList').every(row => row.timeoutMs === 10000));
});
test('read-only caller reports unknown busy state without waiting for a potentially long claim chain', async t => {
  const h = harness(t); const gate = defer(); h.add(1, 'busy'); h.state.hook = async method => { if (method === 'BatchClaimEmail') await gate.promise; };
  const claim = h.service.checkAndClaimEmails();
  for (let i = 0; i < 20 && h.count('BatchClaimEmail') === 0; i++) await Promise.resolve();
  const reads = h.count('GetEmailList'); const snapshot = await h.service.getEmailSnapshot();
  assert.equal(snapshot.busy, true); assert.equal(snapshot.boxes[1].ok, false); assert.equal(snapshot.boxes[1].errorClass, 'claim_busy');
  assert.equal(h.count('GetEmailList'), reads); gate.resolve(); await claim;
});
