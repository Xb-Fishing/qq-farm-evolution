'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

test('workspace packages are private and have no desktop packaging entry point', () => {
    const root = path.resolve(__dirname, '../..');
    for (const file of ['package.json', 'core/package.json', 'web/package.json']) {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
        assert.equal(manifest.private, true, `${file} must be private`);
        assert.equal(manifest.pkg, undefined, `${file} must not configure a desktop package`);
        assert.equal(manifest.devDependencies?.pkg, undefined, `${file} must not include the desktop packager`);
        for (const name of Object.keys(manifest.scripts || {})) {
            assert.doesNotMatch(name, /^(?:package:|build:(?:release|win|linux|mac)$)/);
        }
    }
    for (const file of ['core/src/services/license.js', 'core/src/config/license-config.js']) {
        assert.equal(fs.existsSync(path.join(root, file)), false, `${file} must stay removed`);
    }
});
