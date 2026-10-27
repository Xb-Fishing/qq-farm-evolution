const v8 = require('node:v8');
const Long = require('long');

const ERROR_FIELDS = ['name', 'message', 'code', 'isServerBusinessError', 'serverErrorCode',
  'pauseRemainMs', 'isGovernedRejection', 'governedReason', 'business', 'reasonCode', 'isSessionAuthorityRejection'];

// Preserve message field presence, Longs, bytes, Map/Set and shared references.
// Functions, promises and timer handles are deliberately not transferable state.
function pack(value, options = {}) {
  const nodes = [];
  const seen = new Map();
  function visit(item) {
    if (item === null || typeof item !== 'object') {
      if (typeof item === 'function' || typeof item === 'symbol') throw new Error('Unsupported session state');
      return { value: item };
    }
    const special = options.special?.(item);
    if (special) return { special };
    if (seen.has(item)) return { ref: seen.get(item) };
    const index = nodes.length;
    seen.set(item, index); nodes.push(null);
    let node;
    if (Buffer.isBuffer(item) || item instanceof Uint8Array) node = { kind: 'bytes', data: Buffer.from(item) };
    else if (Long.isLong(item)) node = { kind: 'long', low: item.low, high: item.high, unsigned: item.unsigned };
    else if (item instanceof Date) node = { kind: 'date', value: item.getTime() };
    else if (item instanceof Map) node = { kind: 'map', entries: [...item].map(([k, v]) => [visit(k), visit(v)]) };
    else if (item instanceof Set) node = { kind: 'set', entries: [...item].map(visit) };
    else if (Array.isArray(item)) node = { kind: 'array', length: item.length,
      entries: Object.keys(item).map(key => [key, visit(item[key])]) };
    else if (item instanceof Error) node = { kind: 'error', entries: ERROR_FIELDS.filter(k => item[k] !== undefined).map(k => [k, visit(item[k])]) };
    else {
      const type = item.$type || item.constructor?.$type;
      const proto = Object.getPrototypeOf(item);
      if (!type && proto !== null && proto !== Object.prototype) throw new Error('Unsupported session state object');
      node = { kind: type ? 'protobuf' : 'object', type: type?.fullName, nullPrototype: proto === null,
        entries: Object.keys(item).map(key => [key, visit(item[key])]) };
    }
    nodes[index] = node;
    return { ref: index };
  }
  const root = visit(value);
  return { version: 1, root, nodes };
}

function unpack(graph, options = {}) {
  if (graph?.version !== 1 || !Array.isArray(graph.nodes) || graph.nodes.length > 200000)
    throw new Error('Invalid session state');
  const values = [];
  const constructing = new Set();
  function visit(edge) {
    if (!edge || typeof edge !== 'object') throw new Error('Invalid session state edge');
    if (Object.hasOwn(edge, 'value')) return edge.value;
    if (Object.hasOwn(edge, 'special')) {
      if (!options.special) throw new Error('Session state reference unavailable');
      return options.special(edge.special);
    }
    const index = edge.ref;
    if (!Number.isInteger(index) || !graph.nodes[index]) throw new Error('Invalid session state reference');
    if (Object.hasOwn(values, index)) return values[index];
    if (constructing.has(index)) throw new Error('Invalid session state cycle');
    constructing.add(index);
    const node = graph.nodes[index];
    let value;
    if (node.kind === 'bytes') value = Buffer.from(node.data);
    else if (node.kind === 'long') value = Long.fromBits(node.low, node.high, node.unsigned);
    else if (node.kind === 'date') value = new Date(node.value);
    else if (node.kind === 'map') value = new Map();
    else if (node.kind === 'set') value = new Set();
    else if (node.kind === 'array') {
      if (!Number.isSafeInteger(node.length) || node.length < 0 || node.length > 200000) throw new Error('Invalid session state array');
      value = []; value.length = node.length;
    }
    else if (node.kind === 'error') value = new Error('Session operation failed');
    else if (node.kind === 'protobuf') {
      const type = options.lookupType?.(node.type);
      if (!type) throw new Error('Session message type unavailable');
      value = type.create();
    } else if (node.kind === 'object') value = node.nullPrototype ? Object.create(null) : {};
    else throw new Error('Invalid session state kind');
    values[index] = value;
    if (node.kind === 'map') for (const [k, v] of node.entries) value.set(visit(k), visit(v));
    else if (node.kind === 'set') for (const edge of node.entries) value.add(visit(edge));
    else if (['array', 'object', 'protobuf', 'error'].includes(node.kind)) {
      for (const [key, edge] of node.entries) {
        if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('Invalid session state key');
        value[key] = visit(edge);
      }
    }
    constructing.delete(index);
    return value;
  }
  return visit(graph.root);
}

const encode = (value, options) => v8.serialize(pack(value, options));
const decode = (bytes, options) => unpack(v8.deserialize(Buffer.from(bytes)), options);
module.exports = { pack, unpack, encode, decode, ERROR_FIELDS };
