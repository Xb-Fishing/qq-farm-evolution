const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourceFile = process.env.FARM_MANUALAUTH_SOURCE || path.resolve(__dirname, '../src/services/wx-login/native-protocol.js');
const source = fs.readFileSync(sourceFile, 'utf8');
const sandbox = { exports: {}, Buffer, require: name => {
    if (name === 'node:crypto') return require(name);
    if (name === 'node:net') return { connect() { throw new Error('Network forbidden in layout test'); } };
    throw new Error('Unexpected dependency');
}, fetch() { throw new Error('HTTP forbidden in layout test'); } };
vm.runInNewContext(`${source}\nexports.fixtureManualRequest = manualRequest;`, sandbox, { filename: sourceFile });
const build = sandbox.exports.fixtureManualRequest;

// Independent strict decoder for the fixture: only wire0/wire2 are needed.
function fields(bytes) {
    let offset = 0;
    const result = new Map();
    function varint() {
        let value = 0;
        let shift = 0;
        while (offset < bytes.length && shift < 35) {
            const byte = bytes[offset++];
            value += (byte & 127) * 2 ** shift;
            if (!(byte & 128)) return value;
            shift += 7;
        }
        throw new Error('Malformed fixture varint');
    }
    while (offset < bytes.length) {
        const tag = varint();
        const number = Math.floor(tag / 8);
        const wire = tag & 7;
        assert.equal(result.has(number), false, 'fixture fields must not repeat');
        if (wire === 0) result.set(number, varint());
        else {
            assert.equal(wire, 2);
            const length = varint();
            assert.ok(offset + length <= bytes.length);
            result.set(number, bytes.subarray(offset, offset + length));
            offset += length;
        }
    }
    return result;
}
const input = Buffer.from('0a1073796e7468657469632d7469636b657412066465766963651a04686f7374', 'hex').toString('base64');
test('ManualAuth version is outer uint32 field2, with no version inside device AppBase', () => {
    const request = build(input, Buffer.from('0123456789abcdef'));
    const outer = fields(request.req);
    assert.equal(outer.get(2), 1901);
    const base = fields(outer.get(1));
    assert.deepEqual([...base.keys()], [1]);
    assert.equal(base.get(1).toString(), '0123456789abcdef');
    assert.equal(fields(outer.get(3)).get(1).toString(), 'synthetic-ticket');
    assert.deepEqual([...outer.keys()], [1, 2, 3, 4, 6, 7, 8]);
    assert.equal(outer.get(6).length, 0, 'preserve existing ThirdApp empty field6 branch');
    assert.equal(outer.get(4), 4); assert.equal(outer.get(7), 0); assert.equal(outer.get(8), 6);
    assert.equal(request.device.toString(), 'device'); assert.equal(request.host.toString(), 'host');
});
test('ManualAuth fixed synthetic wire retains ticket, device and context bytes', () => {
    // Device-only AppBase and outer version placement from a reviewed serializer;
    // keep this caller's existing empty field6 rather than switch SDK branches.
    assert.equal(build(input, Buffer.from('0123456789abcdef')).req.toString('hex'),
        '0a120a103031323334353637383961626364656610ed0e1a120a1073796e7468657469632d7469636b65742004320038004006');
});
test('invalid ticket/device inputs remain rejected without connecting or requesting a code', () => {
    assert.throws(() => build(Buffer.from('0a00', 'hex').toString('base64'), Buffer.from('synthetic-app')), /invalid login buffer/);
});
