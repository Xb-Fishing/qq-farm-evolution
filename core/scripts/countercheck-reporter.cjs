// Consume Node's structured test events. Never persist errors, stacks, or test output.
const { createHash } = require('node:crypto');

module.exports = async function* countercheckReporter(events) {
    let outputBytes = 0;
    const result = {
        total: 0, passed: 0, failed: 0, skipped: 0, todo: 0,
        behaviorFailures: 0, otherFailures: 0, propagatedFailures: 0,
        failures: [],
    };
    for await (const { type, data } of events) {
        if (type === 'test:stdout' || type === 'test:stderr') {
            outputBytes += Buffer.byteLength(String(data.message || ''));
            if (outputBytes > 512 * 1024) throw new Error('Countercheck test output exceeded its limit');
        }
        if (type !== 'test:pass' && type !== 'test:fail') continue;
        result.total += 1;
        if (data.skip) result.skipped += 1;
        if (data.todo) result.todo += 1;
        if (type === 'test:pass') {
            result.passed += 1;
            continue;
        }
        result.failed += 1;
        let error = data.details?.error;
        let classification = 'other';
        if (error?.code === 'ERR_TEST_FAILURE' && error.failureType === 'subtestsFailed') {
            classification = 'propagated';
        } else {
            for (let depth = 0; error && depth < 5; depth += 1) {
                if (error.code === 'ERR_ASSERTION') {
                    classification = 'behavior';
                    break;
                }
                if (error.code !== 'ERR_TEST_FAILURE' || error.failureType !== 'testCodeFailure') break;
                error = error.cause;
            }
        }
        result[`${classification}Failures`] += 1;
        if (result.failures.length < 100) {
            result.failures.push({
                test: `test-${createHash('sha256').update(String(data.name || '')).digest('hex').slice(0, 16)}`,
                classification,
            });
        }
    }
    yield `${JSON.stringify(result)}\n`;
};
