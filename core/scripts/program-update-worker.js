#!/usr/bin/env node
'use strict';
const [dataDir, runId] = process.argv.slice(2);
if (!dataDir || !/^program-\d+-[a-f\d-]{36}$/.test(runId || '')) process.exitCode = 1;
else require('../src/services/program-update').runWorker(dataDir, runId).catch(() => { process.exitCode = 1; });
