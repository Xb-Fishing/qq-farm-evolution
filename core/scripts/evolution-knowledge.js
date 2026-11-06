#!/usr/bin/env node
// Private local CLI: imported source text is stored as data and never executed.
const fs = require('node:fs');
const path = require('node:path');
function parse(argv) {
    const [command, ...rest] = argv;
    const values = {};
    for (let i = 0; i < rest.length; i += 2) {
        if (!/^--[a-z-]+$/.test(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error('expected --option value');
        values[rest[i].slice(2)] = rest[i + 1];
    }
    return { command, values };
}
async function main() {
    const { command, values } = parse(process.argv.slice(2));
    if (!values['data-dir']) throw new Error('--data-dir required');
    process.env.FARM_DATA_DIR = path.resolve(values['data-dir']);
    const knowledge = require('../src/services/evolution-knowledge');
    const options = { dataDir: process.env.FARM_DATA_DIR, knowledgeDir: values['knowledge-dir'] };
    let result;
    if (command === 'query') result = knowledge.queryKnowledge({ ...options, query: values.query, limit: Number(values.limit) || 8 });
    else if (command === 'status') result = knowledge.getKnowledgeSummary(options);
    else if (command === 'sync') result = await require('../src/services/evolution-references').collectPublicReferences(options);
    else if (command === 'import') {
        const input = JSON.parse(fs.readFileSync(values.file, 'utf8'));
        result = knowledge.ingestKnowledge({ ...options, documents: Array.isArray(input) ? input : input.documents });
    } else if (command === 'review') result = knowledge.recordKnowledgeReview({ ...options, id: values.id, sourceHash: values['source-hash'],
        disposition: values.disposition, localEvidence: values.evidence, conclusion: values.conclusion || '' });
    else throw new Error('expected sync, query, status, import or review');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
main().catch((error) => {
    process.stderr.write(`Knowledge operation failed: ${error.message}\n`);
    process.exitCode = 1;
});
