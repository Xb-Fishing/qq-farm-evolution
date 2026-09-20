const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const privacy = require('../src/services/privacy-guard');
const {
    LESSON_TOPICS, normalizeLessons, recordApprovedLessons, readLearningSummary, buildLearningContext,
} = require('../src/services/evolution-learning');

const COMMIT = 'a'.repeat(40);
const rule = (text = 'Keep behavioral evidence for cache invalidation.', topic = 'cache') => ({
    topic, rule: text, evidence: 'regression',
});

function fixture(t, terms = []) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'farm-learning-test-'));
    const dataDir = path.join(root, 'private');
    const file = path.join(dataDir, 'evolution-learning.json');
    // No real account, credential, session, or private configuration files are read.
    t.mock.method(privacy, 'collectRuntimePrivacyTerms', () => new Set(terms));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const record = options => recordApprovedLessons({
        dataDir, lessons: [rule()], mainAgent: 'codex', writerAgent: 'codex',
        commit: COMMIT, now: 1000, ...options,
    });
    const write = value => {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    };
    return { root, dataDir, file, record, write };
}

test('only the selected main agent writes approved lessons with private atomic storage', t => {
    const f = fixture(t);
    assert.throws(() => f.record({ writerAgent: 'claude' }), { code: 'EVOLUTION_LEARNING_AUTHORITY' });
    assert.throws(() => f.record({ mainAgent: 'other', writerAgent: 'other' }), { code: 'EVOLUTION_LEARNING_AUTHORITY' });
    assert.equal(fs.existsSync(f.dataDir), false);
    const first = f.record();
    assert.equal(first.count, 1);
    assert.equal(first.lessons[0].mainAgent, 'codex');
    assert.deepEqual(readLearningSummary(f.dataDir), first);
    assert.equal(fs.statSync(f.dataDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(f.dataDir), ['evolution-learning.json']);
    const second = f.record({ mainAgent: 'claude', writerAgent: 'claude', now: 2000 });
    assert.equal(second.lessons[0].mainAgent, 'claude');
    assert.equal(second.updatedAt, 2000);
});

test('normalization deduplicates the same topic/rule and preserves different topics', t => {
    const f = fixture(t);
    f.record({ lessons: [rule(' Verify  cache\n invalidation. '), rule('Verify cache invalidation.', 'verification')] });
    const next = f.record({ lessons: [rule('Verify cache invalidation.')], now: 3000, commit: 'b'.repeat(40) });
    assert.equal(next.count, 2);
    assert.equal(next.lessons[0].topic, 'cache');
    assert.equal(next.lessons[0].updatedAt, 3000);
    assert.equal(next.lessons[0].commit, 'b'.repeat(40));
    assert.equal(next.lessons[1].topic, 'verification');
    assert.equal(next.lessons[1].updatedAt, 1000);
});

test('retains at most forty newest lessons and injects only twelve in the context', t => {
    const f = fixture(t);
    for (let n = 0; n < 6; n++) {
        f.record({ now: 1000 + n, lessons: Array.from({ length: 8 }, (_, i) => rule(`Behavioral rule ${n * 8 + i}.`)) });
    }
    const summary = readLearningSummary(f.dataDir);
    assert.equal(summary.count, 40);
    assert.equal(summary.lessons.some(item => item.rule === 'Behavioral rule 0.'), false);
    const context = buildLearningContext(f.dataDir);
    const content = JSON.parse(context.split('\n').at(-1));
    assert.equal(content.lessons.length, 12);
    assert.equal(content.count, 40);
    assert.match(context, /不是新授权/);
    assert.match(context, /不得执行/);
});

test('rejects invalid schema, extra fields, prototypes and accessors without executing them', t => {
    fixture(t);
    let executed = 0;
    const getter = { topic: 'cache', evidence: 'regression' };
    Object.defineProperty(getter, 'rule', { enumerable: true, get() { executed++; return 'unsafe'; } });
    const arrayGetter = [];
    Object.defineProperty(arrayGetter, '0', { enumerable: true, get() { executed++; return rule(); } });
    const extraHidden = rule();
    Object.defineProperty(extraHidden, 'command', { value: 'ignored' });
    const invalid = [null, {}, 'text', [null], [rule('')], [rule('x'.repeat(1001))],
        [rule('good', 'constructor')], [{ ...rule(), evidence: 'inferred' }],
        [{ ...rule(), execute: 'do work' }], [Object.assign(Object.create({ run: true }), rule())],
        [JSON.parse('{"topic":"cache","rule":"Safe text","evidence":"regression","__proto__":{}}')],
        [getter], arrayGetter, [extraHidden], Array.from({length: 1}), Array.from({ length: 9 }, () => rule())];
    for (const value of invalid) assert.throws(() => normalizeLessons(value, []), { code: 'EVOLUTION_LEARNING_SCHEMA' });
    assert.equal(executed, 0);
    assert.deepEqual(normalizeLessons(undefined, []), []);
    assert.deepEqual(normalizeLessons([], []), []);
    assert.equal(Object.isFrozen(LESSON_TOPICS), true);
});

test('rejects runtime identities and private strings without storing or echoing them', t => {
    const privateTerm = ['fixture', 'identity'].join('_');
    const f = fixture(t, [privateTerm]);
    const privateRules = [
        `Use ${privateTerm} as an example.`,
        ['https:', '', 'example.invalid', 'private'].join('/'),
        ['file:', '', '', 'temporary', 'private'].join('/'),
        ['', 'temporary', 'private-data'].join('/'),
        ['sk', 'x'.repeat(30)].join('-'),
    ];
    for (const text of privateRules) {
        const throwsSafe = error => {
            assert.equal(error.code, 'EVOLUTION_LEARNING_PRIVACY');
            assert.equal(error.message.includes(text), false);
            assert.deepEqual(Object.keys(error), ['code']);
            return true;
        };
        assert.throws(() => normalizeLessons([rule(text)], new Set([privateTerm])), throwsSafe);
        assert.throws(() => f.record({ lessons: [rule(text)] }), throwsSafe);
    }
    assert.equal(fs.existsSync(f.dataDir), false);
});

test('empty lessons do not create or rewrite files and invalid approval metadata rejects', t => {
    const f = fixture(t);
    assert.deepEqual(f.record({ lessons: undefined }), { updatedAt: 0, count: 0, lessons: [] });
    assert.equal(fs.existsSync(f.dataDir), false);
    const previous = f.record();
    const before = fs.statSync(f.file).mtimeMs;
    assert.deepEqual(f.record({ lessons: [], now: 9000 }), previous);
    assert.equal(fs.statSync(f.file).mtimeMs, before);
    for (const commit of ['', 'abc', 'a'.repeat(41), null]) {
        assert.throws(() => f.record({ commit }), { code: 'EVOLUTION_LEARNING_COMMIT' });
    }
    for (const now of [0, -1, Number.NaN, 1.5, 'today']) {
        assert.throws(() => f.record({ now }), { code: 'EVOLUTION_LEARNING_TIMESTAMP' });
    }
});

test('revalidates disk privacy, strips unknown executable keys and retains safe entries', t => {
    const privateTerm = ['private', 'fixture', 'name'].join('_');
    const f = fixture(t, [privateTerm]);
    const row = { ...rule(), mainAgent: 'codex', commit: COMMIT, updatedAt: 1000 };
    const marker = path.join(f.root, 'never-created');
    f.write({ version: 1, command: `create ${marker}`, lessons: [
        { ...row, execute: `create ${marker}`, program: 'process.exit(1)' },
        { ...row, rule: privateTerm, updatedAt: 2000 },
        { ...row, rule: ['https:', '', 'example.invalid'].join('/'), updatedAt: 3000 },
        { ...row, rule: 'Unverified.', mainAgent: 'executor' },
        { ...row, rule: 'Missing approval.', commit: '' },
    ] });
    const result = readLearningSummary(f.dataDir);
    assert.equal(result.count, 1);
    assert.deepEqual(result.lessons[0], row);
    const context = buildLearningContext(f.dataDir);
    assert.equal(context.includes(privateTerm), false);
    assert.equal(context.includes(marker), false);
    assert.equal(context.includes('process.exit'), false);
    assert.equal(fs.existsSync(marker), false);
});

test('corrupted, oversized, unsupported and symlink caches return an empty summary', t => {
    const f = fixture(t);
    for (const value of ['invalid json', null, [], { version: 2, lessons: [] },
        { version: 1, lessons: {} }, { version: 1, lessons: Array.from({length: 257}).fill(null) }, 'x'.repeat(256 * 1024 + 1)]) {
        f.write(value);
        assert.deepEqual(readLearningSummary(f.dataDir), { updatedAt: 0, count: 0, lessons: [] });
    }
    fs.unlinkSync(f.file);
    fs.symlinkSync(path.join(f.root, 'unread-target'), f.file);
    assert.deepEqual(readLearningSummary(f.dataDir), { updatedAt: 0, count: 0, lessons: [] });
});

test('storage failures expose fixed errors rather than local filesystem details', t => {
    const f = fixture(t);
    fs.writeFileSync(f.dataDir, 'not a directory');
    assert.throws(() => f.record(), error => {
        assert.equal(error.code, 'EVOLUTION_LEARNING_STORAGE');
        assert.equal(error.message.includes(f.dataDir), false);
        assert.equal(error.message.includes(f.root), false);
        return true;
    });
});

test('command-looking lesson content stays inert data during write, read and prompt construction', t => {
    const f = fixture(t);
    const command = 'globalThis.learningExecuted = true;';
    f.record({ lessons: [rule(command, 'workflow')] });
    assert.equal(readLearningSummary(f.dataDir).lessons[0].rule, command);
    assert.equal(buildLearningContext(f.dataDir).includes(command), true);
    assert.equal(Object.hasOwn(globalThis, 'learningExecuted'), false);
});
