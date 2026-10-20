const capsules = new Map();
let gate = null;
let healthy = true;

function registerBusinessState(name, capsule) {
  if (capsules.has(name)) throw new Error('Duplicate business state domain');
  if (typeof name !== 'string' || !/^[a-z][\w./-]{0,120}$/i.test(name) || ['constructor', 'prototype'].includes(name)
    || typeof capsule?.capture !== 'function' || typeof capsule?.restore !== 'function')
    throw new Error('Invalid business state domain');
  const version = capsule.version ?? 1;
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid business state schema');
  capsules.set(name, { ...capsule, version });
}
function setBusinessGate(value) { gate = value; }
function businessTask(name, callback) {
  return gate ? gate.run(name, callback) : callback();
}
function businessProducer(name, callback) { return gate ? gate.runProducer(name, callback) : callback(); }
function wrapBusinessFunction(name, callback) {
  if (!gate) return callback;
  return function (...args) { return businessTask(name, () => callback.apply(this, args)); };
}
function snapshotBusinessState() {
  if (!healthy) throw new Error('Business checkpoint restore failed');
  const domains = {};
  for (const [name, capsule] of capsules) {
    if (capsule.idle && !capsule.idle()) throw new Error(`Business state still active: ${name}`);
    domains[name] = { version: capsule.version, value: capsule.capture() };
  }
  return { version: 1, domains };
}
function restoreBusinessState(snapshot) {
  if (!healthy) throw new Error('Business checkpoint restore failed; discard this instance');
  healthy = false;
  if (snapshot?.version !== 1 || !snapshot.domains || typeof snapshot.domains !== 'object' || Array.isArray(snapshot.domains))
    throw new Error('Business checkpoint version unsupported');
  if (Object.keys(snapshot.domains).length !== capsules.size || [...capsules.keys()].some(name => !Object.hasOwn(snapshot.domains, name)))
    throw new Error('Business checkpoint domains changed');
  for (const [name, entry] of Object.entries(snapshot.domains)) {
    const capsule = capsules.get(name);
    if (!capsule) throw new Error(`Business state domain unavailable: ${name}`);
    if (entry?.version !== capsule.version || !Object.hasOwn(entry, 'value')) throw new Error(`Business state schema changed: ${name}`);
    capsule.validate?.(entry.value);
  }
  // Any exception leaves this new instance unusable; the host must discard it.
  for (const [name, entry] of Object.entries(snapshot.domains)) capsules.get(name).restore(entry.value);
  healthy = true;
}
function bindBusinessState() {
  if (!healthy) throw new Error('Business checkpoint restore failed');
  for (const capsule of capsules.values()) capsule.bind?.();
}
function registerDataState(name, capture, restore, options = {}) {
  const keys = Object.keys(capture()).sort();
  registerBusinessState(name, { ...options, capture, restore, validate(value) {
    if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys)) throw new Error(`Business state fields changed: ${name}`);
    options.validate?.(value);
  } });
}
function restoreContainer(target, value) {
  const kind = item => item instanceof Map ? 'map' : item instanceof Set ? 'set' : Array.isArray(item) ? 'array'
    : item && (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null) ? 'object' : '';
  const type = kind(target);
  if (!type || type !== kind(value)) throw new Error('Business state container changed');
  if (type === 'map') { target.clear(); for (const [k, v] of value) target.set(k, v); }
  else if (type === 'set') { target.clear(); for (const v of value) target.add(v); }
  else if (type === 'array') {
    for (const key of Object.keys(target)) delete target[key];
    target.length = value.length;
    for (const key of Object.keys(value)) target[key] = value[key];
  } else {
    for (const key of Object.keys(target)) delete target[key]; Object.assign(target, value);
  }
}

module.exports = { registerBusinessState, registerDataState, bindBusinessState, snapshotBusinessState, restoreBusinessState,
  restoreContainer, setBusinessGate, businessTask, businessProducer, wrapBusinessFunction,
  getBusinessGate: () => gate, assertBusinessStateHealthy: () => { if (!healthy) throw new Error('Business checkpoint restore failed'); } };
