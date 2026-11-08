const test = require('node:test'); const assert = require('node:assert/strict'); const path = require('node:path');
const h = require('./activity-availability.test');
const { vue, WEB, compileSfcModule, render, makeNode, findAll, textOf, buttonsOf, click, flush, deferred } = h;
const roots = []; test.after(() => roots.forEach(root => render(null, root)));
const catalog = [{ id:20523,name:'经验蘑菇种子' },{ id:20525,name:'森野甜莓种子' },{ id:20002,name:'普通目录种子' }];
function snapshot(level = 12) { return { summary:{level}, timing:{phase:'open'}, exchangeShop:{items:[{id:310,rewards:[{id:20523,count:'1'}],costs:[{id:1041,count:'5000'}],purchaseLimit:150,purchasedCount:0,purchaseLimitKnown:true,purchasedCountKnown:true,automaticPurchaseDataComplete:true,condHints:[{params:'2026110101_奶茶店等级_13',target:13,current:level,satisfied:level>=13}]}]} }; }
function mount({ templateMode = false, selected = [], readCatalog = async () => catalog, readShop = async () => snapshot(12) } = {}) {
  const account = vue.ref(templateMode ? 'default-plan' : 'synthetic-a'); const calls = [];
  const model = vue.ref({milk_tea_auto_seeds:true,milk_tea_seed_policy:{targetSeedIds:selected,targetStock:24,coinReserve:'1000000',coinDailyLimit:'240000',ticketReserve:'8000',ticketDailyLimit:'0'}});
  const api={ async get(url,options){calls.push({url,options});return {data:url.endsWith('/seed-catalog')?{ok:true,seeds:await readCatalog()}:{ok:true,activity:await readShop(options?.headers?.['x-account-id'])}};} };
  const Panel=compileSfcModule(path.join(WEB,'src/components/settings/MilkTeaAutomationSettings.vue'),spec=>spec==='vue'?vue:spec==='@/api'?{__esModule:true,default:api}:undefined);
  const root=makeNode('root');roots.push(root);render(vue.h({setup:()=>()=>vue.h(Panel,{accountId:account.value,templateMode,automation:model.value,'onUpdate:automation':value=>{model.value=value;}})}),root);
  return {root,model,account,calls};
}
const input=(root,name)=>findAll(root,node=>node.tag==='input'&&node.props['aria-label']===name)[0];
const toggle=(node,value)=>node.props.onChange({target:{checked:value}});
test('complete catalog shows mushroom and unavailable seeds; actual shop level gates selection and refresh unlocks it',async()=>{
  let level=12;const f=mount({readShop:async()=>snapshot(level)});await flush();
  assert.match(textOf(f.root),/需奶茶店 13 级/);assert.equal(input(f.root,'经验蘑菇种子').props.disabled,true);
  assert.equal(input(f.root,'普通目录种子').props.disabled,true);
  toggle(input(f.root,'经验蘑菇种子'),true);assert.deepEqual(f.model.value.milk_tea_seed_policy.targetSeedIds,[]);
  level=13;click(buttonsOf(f.root).find(node=>textOf(node)==='刷新种子资格'));await flush();
  assert.equal(input(f.root,'经验蘑菇种子').props.disabled,false);toggle(input(f.root,'经验蘑菇种子'),true);await vue.nextTick();
  assert.deepEqual(f.model.value.milk_tea_seed_policy.targetSeedIds,[20523]);assert.equal(f.model.value.milk_tea_seed_policy.ticketDailyLimit,'0','selection never changes spending budget');
});
test('saved locked selections remain visible and removable; template mode loads only local catalog and never fake-account game state',async()=>{
  const locked=mount({selected:[20523]});await flush();assert.equal(input(locked.root,'经验蘑菇种子').props.disabled,false);toggle(input(locked.root,'经验蘑菇种子'),false);await vue.nextTick();assert.deepEqual(locked.model.value.milk_tea_seed_policy.targetSeedIds,[]);
  const template=mount({templateMode:true});await flush();assert.deepEqual(template.calls.map(row=>row.url),['/api/activity/milk-tea/seed-catalog']);
  assert.equal(input(template.root,'普通目录种子').props.disabled,false);assert.match(textOf(template.root),/默认方案不绑定当前账号等级/);
});
test('late prior-account response cannot enable seed selection for another account, and failed reads stay ineligible',async()=>{
  const late=deferred();const f=mount({readShop:id=>id==='synthetic-a'?late.promise:Promise.resolve(snapshot(12))});await flush();f.account.value='synthetic-b';await flush();late.resolve(snapshot(13));await flush();assert.equal(input(f.root,'经验蘑菇种子').props.disabled,true);
  const failed=mount({readShop:async()=>{throw Error('synthetic read failed');}});await flush();assert.equal(input(failed.root,'经验蘑菇种子').props.disabled,true);assert.match(textOf(failed.root),/synthetic read failed/);
});

test('missing or unknown activity phase never makes fully described goods selectable',async()=>{
  for(const phase of [undefined,'settle','ended','unknown']) {
    const f=mount({readShop:async()=>{const data=snapshot(13);data.timing=phase===undefined?undefined:{phase};return data;}});await flush();
    assert.equal(input(f.root,'经验蘑菇种子').props.disabled,true);
  }
});

test('search filters the full catalog locally without any additional read or purchase',async()=>{
  const f=mount({templateMode:true});await flush();const before=f.calls.length;
  input(f.root,'搜索购种目标').props['onUpdate:modelValue']('经验');await vue.nextTick();
  assert.ok(input(f.root,'经验蘑菇种子'));assert.equal(input(f.root,'普通目录种子'),undefined);assert.equal(f.calls.length,before);
});

test('a failed catalog read keeps saved targets visible and removable without enabling a new purchase target',async()=>{
  const f=mount({selected:[20523],readCatalog:async()=>{throw Error('synthetic catalog failure');}});await flush();
  const saved=input(f.root,'已保存种子（目录未读取）');assert.ok(saved);assert.equal(saved.props.disabled,false);
  toggle(saved,false);await vue.nextTick();assert.deepEqual(f.model.value.milk_tea_seed_policy.targetSeedIds,[]);assert.match(textOf(f.root),/synthetic catalog failure/);
});
