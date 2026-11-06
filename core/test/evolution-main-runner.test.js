const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');

// A strict native CLI fixture uses the actual stdio MCP shim. The legacy branch
// lets old runner counterchecks finish normally before the architecture assertion.
const NATIVE_CLI = String.raw`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=process.cwd(),argv=process.argv.slice(2),provider=path.basename(process.argv[1]).includes('claude')?'claude':'codex';
const inside=file=>{const full=path.resolve(root,file);if(full!==root&&!full.startsWith(root+path.sep))throw Error('fixture_escape');return full;};
const write=(file,text)=>{const full=inside(file);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,text);};
const append=(file,text)=>{const full=inside(file);fs.mkdirSync(path.dirname(full),{recursive:true});fs.appendFileSync(full,text);};
const input=fs.readFileSync(0,'utf8');
let config={};
if(provider==='claude'){const at=argv.indexOf('--mcp-config');if(at>=0)config=JSON.parse(argv[at+1]).mcpServers||{};}
else{const at=argv.indexOf('-c');if(at>=0&&argv[at+1].includes('farm_evolution')){const value=argv[at+1];config.farm_evolution={command:JSON.parse(value.match(/command=("(?:[^"\\]|\\.)*")/)[1]),args:JSON.parse(value.match(/args=(\[[^\]]*\])/)[1])};}}
const main=!!config.farm_evolution,legacy=!main&&!argv.includes('--strict-mcp-config')&&!argv.includes('-c');
append('core/data/native-calls.jsonl',JSON.stringify({provider,kind:main?'main':legacy?'legacy':input.includes('本次是独立外部 issue')?'external':'worker',pid:process.pid,promptLength:input.length,autoCompact:process.env.DISABLE_AUTO_COMPACT,argv})+'\n');
const emit=value=>{if(provider==='claude')process.stdout.write(JSON.stringify({subtype:'success',is_error:false,structured_output:value}));else write(argv[argv.indexOf('--output-last-message')+1],JSON.stringify(value));};
if(legacy){
 const phase=input.match(/只完成 (\w+) 阶段/)[1];
 if(phase==='implement'){write('core/src/example.js','module.exports = 3;\n');append('docs/HANDOFF.md','Legacy implementation\n');}
 const decision={research:'researched',revise_plan:'researched',plan:'approve',implement:'implemented',review:'approve',diagnose:'repair',repair:'no_change',repair_review:'approve'}[phase];
 emit({decision,summary:'Legacy fixture evidence',...(phase==='plan'?{allowedFiles:['core/src/example.js','docs/HANDOFF.md'],acceptanceChecks:['example returns expected value'],baselineChecks:[]}:{}),...(phase==='diagnose'?{allowedFiles:[]}:{})});
}else if(!main&&input.includes('本次是独立外部 issue')){
 const evidence=input.match(/仅可将本任务证据写入 ([^\n。]+)。/)[1];
 write(path.relative(root,evidence),JSON.stringify({state:'unavailable',summary:'No external sources in isolated native fixture',findings:[],gaps:['Fixture has no external corpus']}));
 emit({decision:'no_change',summary:'Independent fixture reader recorded its exact missing evidence'});
}else if(!main){
 if(provider==='claude'&&!argv.includes('--strict-mcp-config'))throw Error('Worker MCP is not isolated');
 if(Object.keys(config).length)throw Error('Worker received the Main bridge');
 write('core/src/example.js','module.exports = 2;\n');append('docs/HANDOFF.md','Worker partial\n');
 process.stdout.write(JSON.stringify({subtype:'success',is_error:false,structured_output:{decision:'implemented',summary:'Partial fixture edit'}}));process.exitCode=1;
}else{
 const server=config.farm_evolution,child=cp.spawn(server.command,server.args,{stdio:['pipe','pipe','inherit']});
 let buffer='',sequence=0;const pending=new Map();
 child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;for(;;){const end=buffer.indexOf('\n');if(end<0)break;const line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!line.trim())continue;const packet=JSON.parse(line),entry=pending.get(packet.id);if(!entry)continue;pending.delete(packet.id);clearTimeout(entry.timer);packet.error?entry.reject(Error(packet.error.message)):entry.resolve(packet.result);}});
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>reject(Error('MCP timed out')),20000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 const tool=(name,args={})=>rpc('tools/call',{name,arguments:args});
 (async()=>{
  await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fixture-main',version:'1'}});
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  await rpc('tools/list',{});
  const plan=await tool('approve_plan',{summary:'One caller and its regression',allowedFiles:['core/src/example.js','docs/HANDOFF.md'],acceptanceChecks:['example returns expected value'],baselineChecks:[]});if(plan.isError)throw Error(plan.content[0].text);
  const worker=await tool('delegate_worker',{instruction:'Implement this one caller, retain partial changes on failure',allowedFiles:['core/src/example.js','docs/HANDOFF.md']});
  if(!worker.isError)throw Error('Fixture expected a worker exit failure');
  write('core/data/main-continued.json',JSON.stringify({pid:process.pid,workerFailed:true}));
  write('core/src/example.js','module.exports = 3;\n');append('docs/HANDOFF.md','Main repaired and inspected actual candidate\n');
  const external=await tool('delegate_worker',{instruction:'Inspect cached external issues',readOnly:true,purpose:'external_issues'});if(external.isError)throw Error(external.content[0].text);
  const verified=await tool('verify_candidate');if(verified.isError)throw Error(verified.content[0].text);
  const current=JSON.parse((await tool('status')).content[0].text);
  if(!current.changedFiles.length){const audit=await tool('review_no_change',{checks:['external_updates','interface_compatibility','retired_activities','planting','runtime_logs','problem_analysis','uncertain_incidents','usability'].map(area=>({area,status:area==='external_updates'?'monitoring':'checked',conclusion:'Isolated fixture condition checked',evidencePaths:[path.join(root,'core/src/example.js')],...(area==='external_updates'?{followup:{question:'Fixture external sources unavailable',ruledOut:['No external corpus in isolated fixture'],missing:'External sources',signal:'Existing daily research snapshot',resolveWhen:'Source available and compared',mechanism:'daily_log_review',nextCheckAt:Date.now()+86400000}}:{})}))});if(audit.isError)throw Error(audit.content[0].text);}
  const accepted=await tool('accept_result',{decision:'approve',summary:'Main verified and accepted actual behavior',lessons:[],feedbackReviewed:false,githubResolutions:[],externalReviewAcknowledged:true});if(accepted.isError)throw Error(accepted.content[0].text);
  emit({decision:JSON.parse(accepted.content[0].text).decision,summary:'Main completed the one continuous session'});
 })().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;}).finally(()=>{child.stdin.end();});
}
`;

// Both synthetic research CLIs require the other task's actual ready record.
// Serial delegation therefore fails through the real stdio MCP path.
const RESEARCH_NATIVE_CLI = NATIVE_CLI.replace("?'external':'worker'",
    "?'external':input.includes('只读研究工具')?'research':'worker'")
    .replace('}else if(!main){', String.raw`}else if(!main&&input.includes('只读研究工具')){
 if(provider==='claude'&&!argv.includes('--strict-mcp-config'))throw Error('Research MCP is not isolated');
 if(Object.keys(config).length)throw Error('Research received the Main bridge');
 const id=input.match(/research-\d+(?=-instruction\.txt)/)[0];
 const evidence=input.match(/仅可将本任务证据写入 ([^\n。]+)。/)[1];
 write('core/data/'+id+'-ready.json',JSON.stringify({id,pid:process.pid,source:fs.readFileSync('core/src/example.js','utf8')}));
 const cutoff=Date.now()+4000;
 const timer=setInterval(()=>{
  if(fs.existsSync('core/data/research-1-ready.json')&&fs.existsSync('core/data/research-2-ready.json')){
   clearInterval(timer);write(path.relative(root,evidence),JSON.stringify({version:'fixture-sha',files:['core/src/example.js'],conclusion:'Read-only source evidence'}));
   emit({decision:'no_change',summary:id+' inspected the fixed fixture source; no unverified changes'});
  }else if(Date.now()>cutoff){clearInterval(timer);process.stderr.write('missing parallel research ready record\n');process.exitCode=1;}
 },10);
}else if(!main){`)
    .replace("  await rpc('tools/list',{});", String.raw`  await rpc('tools/list',{});
  const research=await Promise.all([
   tool('delegate_worker',{instruction:'Read only source A within the shared budget',readOnly:true}),
   tool('delegate_worker',{instruction:'Read independent source B within the shared budget',readOnly:true})
  ]);
  for(const result of research)if(result.isError)throw Error(result.content[0].text);
  write('core/data/main-research-results.json',JSON.stringify({pid:process.pid,research}));`);

function createRunnerFixture(t, options = {}) {
    const tempRoot = path.resolve(os.tmpdir());
    const prefix = path.resolve(tempRoot, 'farm-main-runner-');
    assert.ok(prefix.startsWith(tempRoot + path.sep));
    const dir = fs.mkdtempSync(prefix);
    const sources = [__filename, '../scripts/run-evolution-team.js', '../src/services/evolution-main-workflow.js',
        '../src/services/evolution-team.js'].map(file => path.resolve(__dirname, file));
    const snapshot = () => sources.map(file => ({ file, mode: fs.statSync(file).mode & 0o777,
        hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
    const original = snapshot();
    const target = file => {
        const full = path.resolve(dir, file);
        if (full !== dir && !full.startsWith(dir + path.sep)) throw new Error('fixture_escape');
        return full;
    };
    const write = (file, value) => {
        const full = target(file);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, value);
    };
    const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const runner = options.runnerSource || fs.readFileSync(path.join(__dirname, '../scripts/run-evolution-team.js'));
    write('core/scripts/run-evolution-team.js', runner);
    write('core/scripts/evolution-apply-process.js', `module.exports=require(${JSON.stringify(require.resolve('../scripts/evolution-apply-process'))});`);
    for (const name of ['activity-evolver', 'privacy-guard', 'evolution-team', 'evolution-validation',
        'evolution-countercheck', 'evolution-knowledge', 'evolution-sessions', 'evolution-worktree', 'evolution-main-workflow', 'evolution-main-mcp']) {
        write(`core/src/services/${name}.js`, `module.exports=require(${JSON.stringify(require.resolve(`../src/services/${name}`))});`);
    }
    write('core/src/services/evolution-references.js', 'exports.collectPublicReferences=async()=>({state:"complete",discoveryComplete:true});');
    write('.gitignore', 'core/data/\nweb/dist/\nweb/node_modules/\ndocs/HANDOFF.md\n');
    write('docs/HANDOFF.md', '# Current policy\nMain owns the complete task.\n');
    write('core/src/example.js', 'module.exports = 1;\n');
    write('core/test/behavior.test.js', options.backendTest || 'require("node:test")("behavior",()=>require("node:assert/strict").ok([1,3].includes(require("../src/example"))));\n');
    write('web/src/example.js', 'export default 1;\n');
    write('web/package.json', JSON.stringify({ scripts: { build: 'node build.cjs' } }));
    write('web/build.cjs', 'const fs=require("node:fs"),p=require("node:path"),out=process.argv[process.argv.indexOf("--outDir")+1];if(!out)throw Error("missing isolated output");fs.mkdirSync(out,{recursive:true});fs.writeFileSync(p.join(out,"index.html"),"fixture UI");');
    write('web/node_modules/.bin/vue-tsc', '#!/usr/bin/env node\n');
    write('web/node_modules/.bin/vite', '#!/usr/bin/env node\nrequire("../../build.cjs");\n');
    for (const file of ['web/node_modules/.bin/vue-tsc', 'web/node_modules/.bin/vite']) fs.chmodSync(target(file), 0o700);
    for (const agent of ['codex', 'claude']) {
        write(`core/data/fake-${agent}`, options.nativeCliSource || NATIVE_CLI);
        fs.chmodSync(target(`core/data/fake-${agent}`), 0o700);
    }
    fs.mkdirSync(target('core/data/logs'), { recursive: true });
    git(['init', '-q']); git(['config', 'user.name', 'Fixture']);
    git(['config', 'user.email', ['fixture', 'users.noreply.github.com'].join('@')]);
    git(['add', '.']); git(['commit', '-qm', 'fixture baseline']);
    const baseCommit = git(['rev-parse', 'HEAD']);
    const run = (settings = { mainAgent: 'codex', subAgent: 'claude', dualAgentEnabled: true }, extra = {}) => spawnSync(process.execPath,
        [target('core/scripts/run-evolution-team.js')], { cwd: dir, encoding: 'utf8', timeout: 40000, maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, FARM_DATA_DIR: target('core/data'), FARM_PRIVATE_CONFIG_FILE: target('core/data/private-config.json') },
            input: JSON.stringify({ runId: 'main-run', baseCommit, settings, logDir: target('core/data/logs'),
                dataDir: target('core/data'), task: 'activity', prompt: `【原任务】\n${'bounded private fixture evidence\n'.repeat(4000)}`,
                bins: { codex: target('core/data/fake-codex'), claude: target('core/data/fake-claude') }, ...extra }),
        });
    const cleanup = () => {
        try { fs.rmSync(target('.'), { recursive: true, force: true }); }
        finally { assert.deepEqual(snapshot(), original, 'fixture success and failure preserve source bytes and modes'); }
    };
    t?.after(cleanup);
    return { dir, write, target, git, baseCommit, run, cleanup };
}

if (require.main === module) {
    for (const settings of [{ mainAgent: 'codex', subAgent: 'claude', dualAgentEnabled: true },
        { mainAgent: 'claude', subAgent: 'codex', dualAgentEnabled: true }]) {
        test(`real runner uses one ${settings.mainAgent} Main and a scoped ${settings.subAgent} tool through MCP`, t => {
            const f = createRunnerFixture(t);
            const result = f.run(settings);
            assert.equal(result.status, 0, result.stderr + result.stdout);
            const calls = fs.readFileSync(f.target('core/data/native-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
            assert.equal(calls.filter(call => call.kind === 'main').length, 1, 'only one native Main owns the workflow');
            assert.equal(calls.filter(call => call.kind === 'worker').length, 1, 'worker is called by the same Main tool loop');
            assert.equal(calls.filter(call => call.kind === 'external').length, 1, 'separate independent issue reader is actually invoked');
            assert.equal(calls.find(call => call.kind === 'main').provider, settings.mainAgent);
            assert.equal(calls.find(call => call.kind === 'worker').provider, settings.subAgent);
            const journal = JSON.parse(fs.readFileSync(f.target('core/data/logs/evolve-team-main-run.json')));
            assert.match(journal.mainSummary, /Main verified and accepted actual behavior/);
            assert.ok(calls.find(call => call.kind === 'main').promptLength <= 48 * 1024);
            assert.ok(calls.find(call => call.kind === 'worker').promptLength <= 6000);
            assert.equal(calls.find(call => call.kind === 'main').autoCompact, undefined);
            const continued = JSON.parse(fs.readFileSync(f.target('core/data/main-continued.json')));
            assert.equal(continued.pid, calls.find(call => call.kind === 'main').pid);
            assert.equal(continued.workerFailed, true);
            assert.equal(journal.status, 'completed'); assert.equal(journal.orchestration, 'main-owned');
            assert.notEqual(journal.head, f.baseCommit); assert.equal(f.git(['status', '--porcelain']), '');
            assert.equal(fs.readFileSync(f.target('core/src/example.js'), 'utf8'), 'module.exports = 3;\n');
            const workerArtifact = JSON.parse(fs.readFileSync(f.target('core/data/logs/main-main-run/worker-1.json')));
            assert.ok(fs.existsSync(workerArtifact.logFile));
            assert.equal(fs.statSync(workerArtifact.logFile).mode & 0o777, 0o600);
            assert.ok(fs.existsSync(journal.validation.logFile));
        });
        test(`real ${settings.mainAgent} Main runs parallel ${settings.subAgent} research then its unique implementation through MCP`, t => {
            assert.notEqual(RESEARCH_NATIVE_CLI, NATIVE_CLI);
            const f = createRunnerFixture(t, { nativeCliSource: RESEARCH_NATIVE_CLI });
            const result = f.run(settings);
            assert.equal(result.status, 0, result.stderr + result.stdout);
            const calls = fs.readFileSync(f.target('core/data/native-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
            assert.equal(calls.filter(call => call.kind === 'main').length, 1);
            assert.equal(calls.filter(call => call.kind === 'research').length, 2);
            assert.equal(calls.filter(call => call.kind === 'worker').length, 1);
            assert.ok(calls.filter(call => call.kind !== 'main').every(call => call.provider === settings.subAgent && call.promptLength <= 6000));
            const main = calls.find(call => call.kind === 'main');
            assert.equal(JSON.parse(fs.readFileSync(f.target('core/data/main-research-results.json'))).pid, main.pid);
            assert.equal(JSON.parse(fs.readFileSync(f.target('core/data/main-continued.json'))).pid, main.pid);
            for (const id of ['research-1', 'research-2']) {
                assert.equal(JSON.parse(fs.readFileSync(f.target(`core/data/${id}-ready.json`))).source, 'module.exports = 1;\n');
                const artifact = JSON.parse(fs.readFileSync(f.target(`core/data/logs/main-main-run/${id}.json`)));
                assert.ok(fs.existsSync(artifact.logFile));
                assert.equal(fs.statSync(artifact.logFile).mode & 0o777, 0o600);
                const scope = JSON.parse(fs.readFileSync(f.target(`core/data/logs/main-main-run/${id}-scope.json`)));
                assert.deepEqual(JSON.parse(fs.readFileSync(scope.evidenceFile)).files, ['core/src/example.js']);
            }
            const journal = JSON.parse(fs.readFileSync(f.target('core/data/logs/evolve-team-main-run.json')));
            assert.equal(journal.status, 'completed'); assert.equal(journal.checkpoint.mainWorkflow.workerInvocations, 1);
            assert.equal(journal.checkpoint.mainWorkflow.researchInvocations, 3);
            assert.equal(fs.readFileSync(f.target('core/src/example.js'), 'utf8'), 'module.exports = 3;\n');
            assert.equal(f.git(['status', '--porcelain']), '');
        });
    }
    test('cancellation waits for the owned CLI and grandchild; the owning Main stays alive', async t => {
        const f = createRunnerFixture(null);
        process.env.FARM_DATA_DIR = f.target('core/data');
        process.env.FARM_PRIVATE_CONFIG_FILE = f.target('core/data/private-config.json');
        const { executeStreaming } = require('../scripts/run-evolution-team');
        const { processStarttime, aliveNonZombie, signalGuarded } = require('../scripts/evolution-apply-process');
        f.write('grandchild.cjs', 'process.on("SIGTERM",()=>{});process.stdout.write(JSON.stringify({ready:"grandchild",pid:process.pid})+"\\n");setInterval(()=>{},1000);');
        f.write('owned-cli.cjs', 'const cp=require("node:child_process");process.on("SIGTERM",()=>{});cp.spawn(process.execPath,["grandchild.cjs"],{stdio:["ignore","inherit","inherit"]});process.stdout.write(JSON.stringify({ready:"child",pid:process.pid})+"\\n");setInterval(()=>process.stdout.write(JSON.stringify({tick:true})+"\\n"),50);');
        const identities = new Map();
        let readyResolve;
        const ready = new Promise(resolve => { readyResolve = resolve; });
        let cancelling = false;
        const abort = new AbortController();
        const running = executeStreaming(process.execPath, [f.target('owned-cli.cjs')], {
            cwd: f.dir, env: process.env, signal: abort.signal, eventLog: f.target('core/data/cancel-events.log'),
            onLine: line => {
                const event = JSON.parse(line);
                if (event.ready) {
                    identities.set(event.pid, processStarttime(event.pid));
                    if (identities.size === 2) readyResolve();
                }
                // Also triggers the legacy runner's existing failure entry, so its
                // counterexample is an observed orphan assertion, not a timeout.
                if (cancelling && event.tick) throw Object.assign(new Error('cancelled fixture'), { code: 'output_parse' });
            },
        });
        running.catch(() => {});
        t.after(() => {
            for (const [pid, start] of identities) signalGuarded(pid, start, 'SIGKILL');
            f.cleanup();
        });
        let timer;
        try {
            await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('missing child and grandchild ready evidence')), 5000); })]);
        } finally { clearTimeout(timer); }
        assert.equal(identities.size, 2);
        assert.ok([...identities.values()].every(Boolean));
        cancelling = true;
        abort.abort();
        await assert.rejects(running, error => ['cli_exit', 'output_parse'].includes(error.code));
        for (const [pid, start] of identities) assert.equal(aliveNonZombie(pid, start), false, 'all owned descendants must be gone before returning failure');
        assert.equal(process.kill(process.pid, 0), true, 'the Main process group was never signalled');
    });
    test('real verification errors return a private log and bounded failure details to the same Main', t => {
        const f = createRunnerFixture(t, { backendTest: 'require("node:test")("fails current candidate",()=>require("node:assert/strict").ok([1,4].includes(require("../src/example"))));\n' });
        const altered = NATIVE_CLI.replace("const verified=await tool('verify_candidate');if(verified.isError)throw Error(verified.content[0].text);",
            "const verified=await tool('verify_candidate');write('core/data/verify-error.json',JSON.stringify(verified));if(verified.isError){emit({decision:'no_change',summary:'Main stopped after the real backend check failed'});return;}");
        assert.notEqual(altered, NATIVE_CLI);
        f.write('core/data/fake-codex', altered);
        const result = f.run();
        assert.equal(result.status, 1);
        assert.ok(fs.existsSync(f.target('core/data/verify-error.json')), 'the native Main must receive its real verification failure');
        const reply = JSON.parse(fs.readFileSync(f.target('core/data/verify-error.json')));
        assert.equal(reply.isError, true); assert.ok(reply.content[0].text.length <= 6000);
        const details = JSON.parse(reply.content[0].text);
        assert.ok(details.summary.includes('backend'));
        assert.match(details.summary, /fails current candidate/);
        assert.ok(fs.existsSync(details.reportFile));
        const report = JSON.parse(fs.readFileSync(details.reportFile));
        assert.equal(report.counts.fail, 1);
        assert.deepEqual(report.failedTests, ['fails current candidate']);
        assert.ok(fs.existsSync(details.logFile));
        assert.ok(fs.readFileSync(details.logFile, 'utf8').includes('not ok'));
        const journal = JSON.parse(fs.readFileSync(f.target('core/data/logs/evolve-team-main-run.json')));
        assert.equal(journal.failure.code, 'verification_failed', 'the unresolved real check remains the primary cause');
        assert.equal(journal.lastFailure.code, 'verification_failed');
        const causes = JSON.parse(fs.readFileSync(f.target('core/data/logs/main-main-run/main-failure.json')));
        assert.equal(causes.nativeFailure.code, 'review_rejected', 'missing acceptance is retained separately from the actual check failure');
        assert.equal(f.git(['rev-parse', 'HEAD']), f.baseCommit);
        assert.equal(fs.readFileSync(f.target('core/src/example.js'), 'utf8'), 'module.exports = 3;\n');
    });
}

module.exports = { NATIVE_CLI, createRunnerFixture };
