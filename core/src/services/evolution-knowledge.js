'use strict';
const path = require('node:path');
const { readPrivateConfig } = require('./private-config');

function resolveKnowledgeDir(options = {}) {
    const dataDir = path.resolve(options.dataDir || process.env.FARM_DATA_DIR || path.join(__dirname, '..', '..', 'data'));
    const config = readPrivateConfig({ file: process.env.FARM_PRIVATE_CONFIG_FILE || path.join(dataDir, 'private-config.json') });
    return path.resolve(options.knowledgeDir || process.env.FARM_EVOLUTION_KNOWLEDGE_DIR
        || config.evolutionKnowledgeDir || path.join(dataDir, 'evolution-knowledge'));
}
module.exports = { resolveKnowledgeDir };
