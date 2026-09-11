const protobuf = require('protobufjs/minimal');

// 只观察既有 Bag 回包；CJK 文本可能是出售条件或玩家昵称，不作为种子证据。
function fields(bytes) {
  const reader = protobuf.Reader.create(bytes);
  const result = [];
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const field = tag >>> 3;
    const wire = tag & 7;
    if (!field) throw new Error('invalid field');
    if (wire === 2) result.push({ field, wire, bytes: Buffer.from(reader.bytes()) });
    else if (wire === 0) result.push({ field, wire, number: reader.uint64().toNumber() });
    else if (wire === 1 || wire === 5) reader.skipType(wire);
    else throw new Error('unsupported wire');
  }
  return result;
}

function inspectBagItemShows(rawBody, wantedIds) {
  const result = new Map();
  if (!(rawBody instanceof Uint8Array) || !(wantedIds instanceof Set)) return result;
  try {
    for (const bag of fields(Buffer.from(rawBody))) {
      if (bag.field !== 1 || bag.wire !== 2) continue;
      for (const entry of fields(bag.bytes)) {
        if (entry.field !== 1 || entry.wire !== 2) continue;
        const itemFields = fields(entry.bytes);
        const id = itemFields.find(row => row.field === 1 && row.wire === 0)?.number;
        if (!wantedIds.has(id)) continue;
        const show = itemFields.find(row => row.field === 100 && row.wire === 2);
        const evidence = { state: 'no_show_field', showBytes: 0, fields: [] };
        if (show) {
          evidence.showBytes = show.bytes.length;
          evidence.state = show.bytes.length ? 'show_without_verified_name' : 'empty_show';
          evidence.fields = fields(show.bytes).map(row => ({
            field: row.field, wire: row.wire, bytes: row.bytes?.length || 0,
          }));
        }
        // 同一 ID 可有多个 UID；不能让后面的空 show 覆盖已有非空结构。
        if (!result.has(id) || evidence.showBytes > result.get(id).showBytes) result.set(id, evidence);
      }
    }
  } catch {
    // 解析失败不能作为“服务器没下发字段”的否定证据。
    for (const id of wantedIds) result.set(id, { state: 'malformed', showBytes: 0, fields: [] });
  }
  return result;
}

module.exports = { inspectBagItemShows };
