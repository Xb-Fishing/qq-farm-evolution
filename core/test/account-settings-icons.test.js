'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');

// The shared harness sets FARM_DATA_DIR and registers cleanup before loading business modules.
const {
  vue, WEB, compileSfcModule, render, makeNode, textOf, findAll, buttonsOf, fingerprintOf,
} = require('./activity-availability.test.js');

const accountTabPath = path.join(WEB, 'src/components/settings/AccountSettingsTab.vue');
const baseButtonPath = path.join(WEB, 'src/components/ui/BaseButton.vue');
const sources = [accountTabPath, baseButtonPath].map(file => [file, fingerprintOf(file)]);
const requireWeb = createRequire(path.join(WEB, 'package.json'));

test.after(() => {
  for (const [file, before] of sources)
    assert.deepEqual(fingerprintOf(file), before, `${path.basename(file)} content and mode`);
});

function actionButton(root, label) {
  const matches = buttonsOf(root).filter(button => textOf(button).trim() === label);
  assert.equal(matches.length, 1, `Expected one button labeled ${label}`);
  const [button] = matches;
  const icons = findAll(button, node => /\bi-carbon-/.test(node.props.class || ''));
  assert.equal(icons.length, 1, `Expected one Carbon icon for ${label}`);
  const token = icons[0].props.class.split(/\s+/).find(name => name.startsWith('i-carbon-'));
  return { button, token };
}

test('account toggle renders Carbon icons, emits once, and follows account and disabled props', async () => {
  const modalStub = { __esModule: true, default: { render: () => null } };
  const AccountSettingsTab = compileSfcModule(accountTabPath, (spec) => {
    if (spec === 'vue') return vue;
    if (spec === '@/components/AccountModal.vue' || spec === '@/components/ConfirmModal.vue') return modalStub;
    if (spec === '@/stores/account') return { getPlatformClass: () => '', getPlatformLabel: () => '' };
    return undefined;
  });
  const root = makeNode('root');
  const stopped = { id: 'synthetic-account', running: false };
  const running = { ...stopped, running: true };
  const toggles = [];
  const onToggle = account => toggles.push(account);
  const inactiveControls = {
    accountsLoading: false, currentAccountId: null, userIsAdmin: false,
    isAddAccountDisabled: false, addAccountDisabledReason: '',
    showModal: false, editingAccount: null, showDeleteConfirm: false, deleteLoading: false, accountToDelete: null,
    showClearStoppedConfirm: false, clearStoppedLoading: false, refreshWxCodesLoading: false, defaultPlanApplyingId: '',
  };
  function update(account, isAccountOpsDisabled = false) {
    render(vue.h(AccountSettingsTab, {
      ...inactiveControls, accounts: [account], isAccountOpsDisabled,
      stoppedAccountsCount: Number(!account.running), onToggle,
    }), root);
  }

  let loginToken;
  let stopToken;
  try {
    update(stopped);
    const login = actionButton(root, '立即登录');
    loginToken = login.token;
    assert.equal(login.button.props.disabled, false);
    let stoppedPropagation = 0;
    login.button.props.onClick({ stopPropagation: () => { stoppedPropagation++; } });
    assert.equal(stoppedPropagation, 1);
    assert.deepEqual(toggles, [stopped]);
    assert.equal(toggles[0], stopped);

    update(stopped, true);
    const disabledLogin = actionButton(root, '立即登录');
    assert.equal(disabledLogin.token, loginToken);
    assert.equal(disabledLogin.button.props.disabled, true);
    assert.equal(disabledLogin.button.props.title, '账号已到期，无法启动账号');
    disabledLogin.button.props.onClick({ stopPropagation: () => assert.fail('Disabled click was emitted') });
    assert.equal(toggles.length, 1);

    update(running, true);
    const stop = actionButton(root, '停止');
    stopToken = stop.token;
    assert.notEqual(stopToken, loginToken);
    assert.equal(stop.button.props.disabled, false);
    assert.equal(buttonsOf(root).some(button => textOf(button).trim() === '立即登录'), false);
    stop.button.props.onClick({ stopPropagation() {} });
    assert.deepEqual(toggles, [stopped, running]);
    assert.equal(toggles[1], running);
  }
  finally {
    render(null, root);
  }
  assert.deepEqual(root.children, []);

  const { createGenerator, presetIcons } = await import(pathToFileURL(requireWeb.resolve('unocss')).href);
  const carbon = requireWeb('@iconify-json/carbon/icons.json');
  const uno = await createGenerator({ presets: [presetIcons({ scale: 1.2, collections: { carbon: () => carbon } })] });
  for (const token of [loginToken, stopToken]) {
    const { matched, css } = await uno.generate(new Set([token]), { preflights: false });
    assert.ok(matched.has(token), `UnoCSS did not match the rendered icon ${token}`);
    assert.ok(css.trim().length > 0, `UnoCSS generated no CSS for ${token}`);
  }
  assert.equal(loginToken, 'i-carbon-login');
  assert.equal(stopToken, 'i-carbon-stop-filled');
});
