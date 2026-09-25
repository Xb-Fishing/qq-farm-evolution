# 交接文档：qq-farm-bot（更新 2026-09-07，活动 Agent 负责道具、玩法与专属前端的端到端进化）

> **每日一轮与精简协作（2026-09-21）**：自动安全/活动合并为一天最多一次，失败/重启不重跑；主子执行器以页面选择为准。子 Agent 做初检、实现与自检，主 Agent 集中方案和最终验收。协调进程新增结构化旧基线反向对照；此前设置页候选的 19 项正向及 16 项旧码行为失败已补证，详见文末。

> **私有参考配置与更新活跃度（2026-09-20）**：固定参考名单迁入本机私有配置，公开文件用别名保留提交/路径定位；每日发现按最新更新排序并采样近期提交，完整候选清单交主子 Agent 评估。运行必需的公共地址和已有问题定位保留。详见文末本轮交接。

> **主 Agent 复盘与重点监控修复（2026-09-20）**：每日反馈改为 24 小时，完整验收后按采样水位清理；Codex 主 Agent 先做每日复盘并沉淀复用经验，Claude 子 Agent 执行。修复重点名单 Set/数组错配、持续降速反复延期及窗口内失败退慢档，详见文末本轮交接。

> **每日反馈与验证（2026-09-20）**：新增私有点击/请求/错误日流水、按逻辑内容指纹复用的完整离线回归，以及固定两个指定项目并发现新候选的六组公开查询。双 Agent 的 no_change 也需当前版本验证证据；每天仍审新增反馈，未覆盖路径不得算通过。详见文末交接。

> **验收失败处理修正（2026-09-19）**：本轮修正验收失败误报隐私拦截、恢复预算混用及未验收前端构建覆盖线上产物。执行恢复、验收返工、只读方案修订分别最多两次；详见文末最新交接，取代旧记录的全局两次说明。

> **双 Agent 自进化（2026-09-18）**：活动中心可配置双 Agent 开关、主 Agent 和子 Agent。推荐 Codex 主导方案确认/最终复核，Claude 承担 GitHub 广泛检索/本地巡查/实施；支持反选。旧状态默认保留单执行器。双 Agent 必须走独立协调进程的阶段审批和真实测试，完成凭据绑定本轮基线与最终 HEAD，缺失时绝不能沿用单 Agent 的“有提交就推送”逻辑。详见文末本轮交接。

> **微信接管阻断修正（2026-09-11）**：`40188/invalid scope` 有时在上游已翻译成“微信授权范围已失效”，不能只按英文错误或 token 关键词识别；同时刷新接口可能在失败前滚动 refresh token。自动接管必须在中文授权失效语义下立即阻断，并以失败返回时账号中的最新 token 作为阻断指纹，避免错误地继续排程第 2 次、第 3 次接管。只有成功获取 Code 或重新扫码写入新凭据后才恢复；临时网络错误仍按原有有界重试。

> **启动旧 Code 闸门（2026-09-11）**：启动账号时若微信 Code 获取失败，必须检查同一账号的明确凭据阻断状态；`40188/invalid scope` 下禁止用旧 Code 启动 Worker，否则会再次触发 WS 400 并进入普通重登计时。普通 `scheduleRelogin`、被踢接管和长凭据保活都要先检查该阻断状态；只有人工重新授权或成功刷新后才允许恢复。

> **种子识别纠错（2026-09-11，优先于下文旧记录）**：20516 是狗尾草种子；25995 是芦苇种子；29004 是泡泡棉花糖种子、占地 2×2；萌宠元气糕是 1028。此前“20516 是产出物”“29004 单格安全回退”“无名称等于没有 ItemShow”的结论均已推翻。详见文末“种子识别证据纠错与每日审计”。

给下一个会话用。先读本文件，再动 `worker.js` / `friend-orchestrator.js` / `farming-orchestrator.js`。

## 部署环境

| 项 | 值 |
|---|---|
| 位置 | 当前 Git 工作树根目录（用 `git rev-parse --show-toplevel` 获取，禁止把机器绝对路径写回仓库） |
| 面板 | `:3007` |
| 启动 | 只在既有 tmux `farm:0.0` 窗格内执行 `bash start.sh`（`start.sh` 可能没有 +x）；禁止另开 tmux 会话/窗口或改用 `nohup` 脱离用户窗格 |
| Node | Node.js 20+；使用当前进程的 `node`/`PATH`，禁止固化某台机器的 NVM 路径 |
| 日志 | `bot.log` + `core/data/logs/combined-*.log` |
| 测试 | `cd core && node --test test/*.test.js` |
| 代理 | 仅从本机 `HTTP_PROXY` / `HTTPS_PROXY` 环境读取；仓库和通知不得记录地址 |

改完 **必须重启 bot** 才生效（`node client.js` 不会热更）。杀进程不要用 `pkill -f`（会匹配到自己的 shell）。用：

```bash
bash stop.sh     # 杀主进程/worker/pnpm 包装层，验证 3007 释放
tmux send-keys -t farm:0.0 C-c
tmux send-keys -t farm:0.0 'cd "$(git rev-parse --show-toplevel)" && bash start.sh' C-m
```

`start.sh` 发现 3007 已被占用会认为「已在运行」并退出，所以必须先杀掉旧进程。

## 用户硬约束（不要再改回去）

- **防封号、偷菜速度、化肥识别率要同时保证，核心是成熟墙钟缓存 + 单次可疑即 trigger**：持续维护每个好友的成熟墙钟；任一可信可疑变化立即只对这个好友切到有时限的秒级追踪，不再做二次确认。不能把一个人的 trigger 扩散成全好友高频进门，也不能用 `is_nudged` 等不再变化的持久状态无限续盯。
- **普通偷菜与施肥监控必须解耦**：普通好友有已知成熟墙钟后只在成熟点唤醒，不得因为进入 66/122 分钟观察窗口就做 3–5 秒或 15–30 秒全好友摘要重查；完全没有任何成熟墙钟时只允许 5–8 分钟低频重新发现。重点好友窗口外 5–8 分钟基线、窗口内 45–75 秒单目标基线、施肥 HOT 秒级目标追踪和自然成熟 PREARM 继续走各自独立时钟，不能扩散成普通偷菜轮询。
- **优先级固定为：通信硬预算 / 明确免打扰 > 自己到点收获 > 好友偷菜 > 其他业务**。自己的成熟墙钟一旦已知，最后 10 秒停止启动好友巡查、重点巡田、帮助和普通务农；成熟点后 30–80ms 直接对缓存地块发 Harvest。异常失败阈值只触发普通巡查降速，不得冻结自己收获、好友到点抢收或施肥 HOT；成熟链仍受每分钟硬预算保护。
- **种菜延迟可以慢**：面板里的种植延迟、随机顺序可以留。
- **设备串一人一机、固定不变**：按农场账号 ID 分配并落盘，禁止每次登录重随机、禁止所有号共用同一个 iPhone 串。
- **不要做 TSDK / ACE / 协议伪装、指纹轮换**。节奏随机（`utils/behavior.js`）可以，协议层不要碰。
- **活动更新 / `farm_push` 不要饿死**：土地推送巡田走 `checkFarm({ fromPush: true })`，不被偷菜即将到期挡住。
- **HANDOFF 是回归约束，不是仅供参考的说明**：后续 Claude/Codex 启动后的**第一项操作必须是从头到尾完整读取本文件**；读完前禁止搜索源码、看日志/diff 或提出方案。随后提取本节、「踩过的坑」「不要做的」「风险待处理」和最近巡检记录，逐条确认不会复发。当前收菜、偷菜、重点用户施肥监控策略已经可用，禁止以“防封”“熔断”“异常收敛”为名重新收紧核心收益链；超过异常阈值只能放缓普通巡查，绝不能恢复整号熔断或让 `Enter cooldown` 阻断自己成熟收获、好友到点偷菜、重点用户 HOT/PREARM。
- **每轮改动必须同步更新 `docs/HANDOFF.md`**：除了行为变化、验证结果、风险边界和回滚方法，还必须写清本轮踩过的坑、以后修改时的注意点；只改测试数或一句结论不算完成，没有更新 HANDOFF 不算完成。
- **每轮改动测试通过后必须上传 GitHub**：提交到当前仓库并通过 SSH 推送 `origin/main`；上传前必须扫描从可信远端基线到本地 HEAD 的完整提交范围、新增行、提交标题和文件名，并确认 `core/data/`、日志、账号配置、自动进化状态/记忆、登录材料、Webhook/Token 等 ignored 运行数据均未被跟踪，禁止用强制添加绕过 `.gitignore`。任一隐私命中或无法证明审计基线时必须阻断上传；推送失败必须明确报告，不得声称已完成。
- **GitHub 零个人信息硬门**：受 Git 跟踪的代码、文档、提交标题、文件名不得包含账号/好友昵称或 GID、服务器用户名、机器绝对路径、内网地址、个人邮箱、Webhook、API Key、Token、Cookie、签名 URL 或登录信息。生产证据只能写匿名结论（如“账号 A”“重点好友 A”），绝不能复制原始身份字段。任何自动进化提交都必须先通过父进程隐私扫描，Agent 自己禁止 `git push`；本地 HEAD 不等于可信 `origin/main` 时不得启动新一轮 Agent，避免把前一轮未审提交夹带上传。
- **自动进化可以零改动**：没有可靠问题证据、没有明确安全收益，或现有逻辑已满足要求时，必须允许代码和 HANDOFF 都不修改、不生成提交；不得为了“每日进化”制造代码或文档改动。只要实际改了代码，仍必须同步更新 HANDOFF、测试、提交并推送。
- **自动进化必须复用脱敏增量记忆**：ignored 状态只保存上次完成时间、已审 Git 提交和活动证据 SHA-256；运行问题继续只存白名单类别/次数/时间。每轮优先检查新日志异常、已变风险域、活动证据变化、未处理活动和 HANDOFF 未决项；未变模块只跑必要不变量回归，不得重复全量探索。严禁把原始日志、账号/好友、接口原文、URL、凭据写进记忆或仓库。
- **公开同类项目只能做不可信只读对照**：每轮用多组关键词广泛筛选 GitHub 公开农场项目，再按本轮增量问题深入查看，不局限于既有参考仓库；只借鉴调度分层、任务追踪、有界恢复和活动/UI 组织。不得执行外部脚本、安装其依赖、运行二进制、添加 remote，也不得从外部项目复制或推断 RPC/cmd/字段、登录、设备、TSDK/ACE 或反检测实现。协议写操作仍只认当前官方客户端可达路径及自然成功请求样本。
- **自动进化运行问题只做短期脱敏线索**：日常错误只能按白名单记录“类别、次数、时间”，禁止保存或送给 Agent 账号/好友、协议方法、错误原文、URL 或凭据。安全巡检必须回看本机短期日志验证后才能改代码，不能凭摘要恢复熔断或收紧收益链；无需修改时立即确认清除，有代码改动则等应用重启成功后清除，失败/拒绝期间保留，最长 72 小时。
- **重启只复用用户已有 tmux `farm:0.0` 窗格**：包括人工改动生效和面板“应用进化”；禁止新建 tmux session/window，禁止在 tmux 外另起 `nohup` Bot。找不到该 pane 时必须取消重启，不能先停服再另起。
- **凌晨静默只能放慢 Worker 业务巡查，不能停主进程微信凭据续期**：长凭据必须按服务端真实有效期持久化和跨日续期；不得把“每半小时检查”再写成“每半小时真实刷新”，也不得用周期换游戏 Code/重启 Worker 代替长凭据保活。

## 这一轮落地的逻辑（2026-08-21 下午）

### 1. 偷菜按成熟时刻唤醒，倒计时要准

相关文件：

- `core/src/services/steal-schedule.js` — `computeNextStealDueAt` / `ripeDueAtMs` / `mergeDueAt`
- `core/src/core/worker.js` — `armStealWake` / `resolveStealDueAt`
- `core/src/services/friend-orchestrator.js` — `applyStealScheduleFromFriends`

怎么算下次偷菜：

1. 好友 `steal_plant_num > 0` → 立刻，且在本轮成功进门确认前仍必须保持为全局最小值；不能因为“正在偷”就预先跳到下一个更晚的成熟点
2. 好友 `ripe_time_sec`：可能是**倒计时秒**，也可能是**服务器绝对时间戳**（`>1e9`）。必须用 `utils.toNum`，protobuf `int64` 是 Long，`Number(long)` 会变成 0
3. **已经实际进门或收到 `LandsNotify` 的好友地块快照**（来自每块地 `phases` 的最早成熟墙钟）
4. **化肥盯梢**下次进门（见下）

好友侧“已知成熟” = 上面时刻的最小值，**不混入自己作物成熟时刻**。自己的菜由独立 `own_harvest_guard` 保护。面板偷菜行主值显示 `nextStealRunAt`：普通好友有已知时刻时它就是成熟点；施肥 HOT/PREARM 时它是该目标的独立下一次动作；完全未知时才是 5–8 分钟低频重新发现。已知成熟辅助值与主值相同时不重复展示。wx 摘要对部分普通好友不给 `ripe_time_sec`，界面必须明确提示部分好友时刻不可见。

**好友成熟墙钟缓存（2026-08-21 夜加，2026-08-25 降频）**：`ripeSnapshots` 按 GID 保存 `{ dueAt, previousDueAt, advanceMs, shock, at, name }`。普通偷菜不再按距成熟远近做 3–5 秒/15–30 秒摘要刷新；有墙钟直接等到点，没有墙钟才 5–8 分钟低频 `GetAll` 重新发现。每次由帮助、重点巡田、手动进门、推送或低频兜底拿到新摘要/地块时，仍把倒计时换算成绝对墙钟并检测提前变化；可信提前才只对目标切 HOT。`armStealWake` 合并目标 HOT/PREARM `nextVisitAt` 与普通成熟点，但不会把目标频率扩散给全好友。

**停止即停干净（2026-08-21 晚加，2026-08-25 补离线保活边界）**：`stopWorker` 会先调 `autoCodeRefresh.stopAccount` 清凭据保活/断线恢复/被踢接管定时器；如果停止原因是被踢或异常断线，随后对应的 `scheduleKickoutRelogin/scheduleRelogin` 会只重新挂载长凭据保活和接管倒计时。面板手动停止不会走重登排程，因此仍会彻底停干净。旧版的 60 分钟周期换 Code 已删除，不会再把在线账号人为拉掉重登。worker 内部所有 sleep 都是内存定时器，`stopBot` 已清全部调度器队列 + 进程/线程退出即清零，重启后无残留。

**踩过的坑：**

| 现象 | 原因 |
|---|---|
| 好友 6 小时成熟，界面显示 **24 小时** | 没读到 `ripe_time_sec`（Long 解析失败）后 `armStealWake` 用 `STEAL_IDLE_MS = 24h` 占位，展示又用了 `nextStealRunAt` |
| 一直显示 **检查中** | 旧面板把 remain=0 一律写成「检查中」，且一次失败会让旧成熟墙钟永久到期。现改为无 due 显示「暂无成熟时刻」，到期宽限内显示「正在抢收/抢收重试」；成功进门按 GID 清理，失败最多保留 90s 并指数退避 |
| 好友已成熟，面板“偷菜”却跳到更晚时间 | 旧逻辑在 `stealingNow=true` 时把 `steal_plant_num > 0` 从 due 计算里排除，进门失败/未处理完的目标会丢掉最小值。现在可偷目标在本轮也保持立即 due，只有成功进门后才按 GID 更新/清理；失败仍走现有 90s 宽限和退避，不增加普通扫描频率 |
| wx 某普通好友 3 分钟成熟，面板却显示 6 小时 | 线上确认 wx `GetAll` 对该好友成熟前没给 `ripe_time_sec`，而旧面板还把自己作物时钟混到“偷菜”里。当次好友成熟后 Bot 在 03:17:32 由摘要发现并成功偷 24 块。现在已读过的普通好友地块墙钟会并入最小值，自己时钟不再冒充好友成熟；有时刻就到点检查。完全未知好友只保留 5–8 分钟低频重新发现，不为了补显示或追普通好友恢复秒级/几十秒全量轮询 |
| 自己催熟后时间变了，但没有「盯梢」日志 | 盯梢只针对**好友**。自己家催熟只更新收获时刻，日志应是 `自己农场检测到催熟/化肥`（`noteOwnFarmNudge`） |

空闲 24h 仍是内部 rediscovery 上限，**不要再拿它当面板倒计时**。

### 2. 好友用化肥：盯梢，不要高频刷

`core/src/services/fertilizer-watch.js`

> **已改为趋势 trigger：无趋势时保守，有可信施肥趋势时只对目标好友压到秒级，并用短窗口、全局预算和冷却限制风险。自然成熟 PREARM 与化肥状态完全分开，不会再把成熟预布控误记为施肥。**

- **识别分两层**：好友列表同一人的成熟墙钟比上次提前 ≥25s；或进农场/收到地块推送后，同一地块、同一茬作物出现 `is_nudged`、`left_inorc_fert_times` 下降、成熟时刻提前 ≥20s
- **必须按地块比较**：不能取全场“最早成熟”和“最小剩余施肥次数”做前后比较。那会漏掉非最早地块施肥，也会被另一块剩余次数为 0 的土地遮住。当前基线是 `gid -> landId -> { plantId, firstBegin, matureAt, fertLeft, nudged }`。服务端会裁掉已完成的 `phases`，所以 `firstBegin` 不能单独标识同一茬；实现以“同植物且成熟终点没有向后换到下一茬”比较，避免把同种重种误判成施肥
- **增量推送不能当全量**：`LandsNotify.lands` 只包含变化地块。`worker.js` 必须以 `{ partial: true }` 调 `inspectFriendLands`，和既有地块基线合并；否则一块成熟地的通知会把仍在生长的其他土地抹掉，并错误结束盯梢
- **当前实现节奏（2026-08-21 夜再次提速）**：取消 SUSPECT 和二次确认，任一可信可疑信号直接 HOT；首次 0.4–0.8s、随后 0.7–1.2s，只对触发好友生效。连续 12s 没有新证据才视为不再可疑并降级，单段 HOT 最长 45s，COOLDOWN 30s。最多同时跟踪 6 人
- **全局进门预算**：盯梢入口一次只放行一个目标，相邻至少 400ms，最多 10 次/10s。自然成熟 PREARM 到点允许优先一次，但仍计入后续预算
- **结束**：完整农场状态确认没有在长的作物，或好友进了黑名单。`is_nudged` 在成熟后可能仍为 true，不能仅凭它把盯梢续 6 小时；反过来，首次收到的单块增量通知也不能证明全场已经结束
- **事件驱动入口（2026-08-21 晚加）**：协议没有专门的“好友施肥”通知，但 `LandsNotify` 带 `host_gid`——`network.js` 把 host_gid≠自己的推送 emit 成 `friendLandsChanged`，worker 合并增量、检测并 `armStealWake`。增量推送只提供证据，不算一次实际进门，也不推迟已安排的 HOT 访问。服务器若不下发，由好友成熟墙钟缓存刷新兜底，这是协议可见性的边界
- **日志**：所有可信可疑信号直接记录 `确认有施肥趋势，进入秒级盯梢`，其中 `reason=summary_ripe_shock_30m` 表示成熟墙钟一次提前至少 30 分钟；降级为 `施肥趋势停止，盯梢降频冷却`。自己催熟不会出这些好友日志
- 自己催熟日志：`自己农场检测到催熟/化肥，下次收获约 x小时x分后`（`farming-orchestrator.js` `noteOwnFarmNudge`）

帮助扫描仍约 30–35s 拉一次好友列表，列表上的 `ripe_time_sec` 若会更新，倒计时也会跟着改；盯梢是防「列表不更新 / 反复催熟」把第一次算的 6 小时睡穿。**帮助经验上限即全停（2026-08-23 改）**：当日帮助经验到上限后不再进任何好友农场帮忙（含护主犬，原来会保留护主犬），只留好友列表拉取降频；跨日自动恢复。

#### 已实现：施肥趋势 trigger 状态机

状态按好友隔离，不能用一个人的趋势提高所有好友的频率：

1. **NORMAL（缓存基线）**：没有可疑趋势。按 GID 持续刷新好友摘要成熟墙钟，同时由服务端推送/实际进门维护地块成熟时刻、剩余施肥次数和 `is_nudged` 基线；不高频进好友农场。
2. **HOT（单次可疑直接触发）**：摘要成熟墙钟提前 ≥25s、同一地块成熟终点提前、施肥次数下降、`is_nudged` 上升，或无基线但首次看到可疑催熟状态，均直接 HOT，不再二次确认。只对该好友开启秒级追踪并实时重排抢收。
3. **COOLDOWN（不再可疑）**：连续 12s 没有新的提前、完整快照确认无生长作物或达到 45s 热窗口上限后，退出秒级追踪并冷却 30s。全局预算不足时只顺延访问，不续热；新的可疑变化可以重新触发 HOT。
4. **PREARM（自然成熟）**：`ripeAt` 前 10s（重点好友 60s）建立预布控，成熟点优先进入；成功访问立即删除，失败仅在成熟后 90s 内受控重试，随后自动过期；不打印化肥趋势日志，也不续成 HOT。

**任一项均直接进 HOT：**

- 好友摘要缓存的绝对成熟墙钟提前 ≥25s；提前 ≥30 分钟额外标记为剧烈变化；
- 同一地块、同一茬作物的 `left_inorc_fert_times` 再次下降；
- 同一地块成熟终点再次提前 ≥20s；
- `is_nudged` 从 false 变为 true，而不是一直为 true；
- `LandsNotify` 与已有地块基线比较后得到上述任一变化；
- 没有可比较旧基线，但首次看到 `is_nudged=true` 等可疑催熟状态。

**趋势的定义必须是“发生了新的变化”**。同一个 `is_nudged=true`、同一个成熟时刻或同一个施肥次数被反复读到，不算趋势，不得刷新 HOT 的持续时间。只有成熟时刻继续前移、施肥次数继续下降或新的地块开始变化，才能续热。这样才能同时保住化肥识别率、秒级偷菜速度和请求安全。

### 5. 长睡 + 盯化肥窗口（分钟可配）

**静默（2026-08-22 加，2026-08-25 修时区，防封用）**：设置 → 策略时机 →「静默到」。`friendQuietHours.pauseUntil`（ISO 绝对时间）到点前 worker 统一 tick 直接短路——偷菜/农场/帮助/重点巡田/推送处理全部不做，WS 心跳保留不掉线，到点**自动恢复**。日志 `免打扰中，x分内不做任何检测`（10 分钟去重）。旁边「+1小时/+3小时/取消静默」快捷键；「立即重启」按钮 = `POST /api/accounts/:id/restart`（清 pauseUntil + restartAccount，把全部功能立刻拉起来）。改静默设置要保存并重启 bot 才生效（保存只落盘不下发）。旧前端曾把 `datetime-local` 的无时区字符串直接交给 UTC 服务器，导致北京时间点「+1小时」被服务端算成剩余 9 小时；现在前端只展示本地时间、保存时转 `toISOString()`，后端 `pause-until.js` 对旧无时区值按北京时间兼容并规范成 ISO。不要再把无时区字符串直接存入配置。

`friendQuietHours`：

- `maxSleepMinutes`：每次最长歇多久，默认 **120**
- `wakeBeforeMinutes`：还剩多久开始正常盯化肥窗口 / 不再长睡，默认 **66**

流程：

1. 成熟还早 → 农场/帮助按各自需求随机歇着；普通偷菜已经有独立绝对墙钟，不再靠农场 tick 醒来顺带刷新全好友摘要。长睡期间暂停 ACE 上报和土地推送巡田；WebSocket 心跳仍发，避免掉线。长睡日志：`没事做，先歇 x小时x分 再看`。
2. 普通好友有成熟墙钟 → `nextStealRunAt` 直接挂到成熟点，不因 `wakeBeforeMinutes` 进入几十秒或秒级摘要检查；无墙钟才 5–8 分钟低频重新发现。`wakeBeforeMinutes/watchlistWakeBeforeMinutes` 只服务重点施肥观察和既有空闲策略，不得再控制普通偷菜重查频率。
3. **检测到任一可信可疑 trigger 后**直接进入受控秒级 HOT，不做二次确认；只加速目标好友，不提高全好友进门频率。连续 12s 没有新变化才降级到 COOLDOWN。
4. 偷菜仍按成熟时刻 80–300ms 出手。未施肥时偷菜不会提前 66 分钟醒来刷门。

面板：设置 → 策略时机 →「最长歇多久」「还剩多久开始盯化肥」。改完要重启 bot；新输入框要 `corepack pnpm -C web build`。

### 3. 设备串：按账号固定分配

- `core/src/utils/device-fingerprint.js` — 账号 ID 的 sha256 → 机型池 + deviceId/MAC/IMEI
- `store.js` `accountDeviceProtocols[accountId]` 落盘，有 `deviceId` 就永不重算
- `getDeviceProtocolForAccount`：面板用户**显式启用且填了 deviceId** 的 `userDeviceProtocols` 优先；否则用账号自动分配（`enabled: true`）
- 登录日志：`使用自定义设备协议登录` + 品牌/型号/设备ID

不要改成每次登录换机。多账号必须是不同手机。

### 4. 调度结构（`worker.js` 统一 tick）

- **自己到点收获（全局业务最高）**：独立 `own_harvest_guard` 按绝对成熟墙钟长时间武装，不与好友偷菜哨兵共用 timer；到点后 30–80ms 直接 Harvest 缓存的同批地块，不先多发一次 AllLands。所有自己的收获路径共用在途 Promise，避免 farm tick / 推送 / 精确定时器重复请求；失败按 0.18s→0.5s→1.2s→3.5s→8s→20s 六档受控重试
- **自己的收获预留窗口**：成熟前 10s 不再启动好友扫描、重点好友进门、帮助或普通农场事务；同一时刻自己先收，确认完成后才允许偷好友。明确免打扰、断线和通信硬预算仍是安全约束；异常降速不是停机闸，不阻断毫秒级收获
- **偷菜到期 / `stealIsDue`**：本轮只偷，return
- **抢收竞速**：ripeAt 前 10s 自动布控（`DUE_PREARM_MS`）；到点的盯梢目标走**快路径**（checkFriends onlySteal 顶部，跳过 getAllFriends 直接进门偷，日志「抢收快路径」）；唤醒 jitter 30-120ms
- **过期成熟点收敛（2026-08-24）**：每个好友独立缓存摘要 due；成功进门且确认无菜/已处理后只更新或清除此人的 due；成功进门但 Harvest 失败会显式返回 `retryNeeded`，仍保留短时抢收。进门或 GetAll 失败时从第一次重试起按约 1s→2s→4s→…→30s 退避，成熟后最多保留 90s，避免旧 due 触发 100ms 的 GetAll 拦截风暴
- **偷菜 1.5s 内到期**：农场/帮助推迟
- **农场 tick**：8–12s 巡田；完整 AllLands 快照会缓存每块地成熟墙钟并重排独立自己收获钟；普通巡田内也先收获，再做务农 / 种植 / 施肥 / 升级
- **空闲歇息封顶 10 分钟**（`idleMaxSleepMs`，1–10 分钟随机）：不再出现睡 40–120 分钟的情况，每次醒来重估时刻表。**完全空闲（无任何已知成熟/可偷时刻）也进歇息**（2026-08-23 改，原来一直全速巡查 8–12s/30–35s）；土地推送（fromPush）、偷菜时刻表唤醒、重点监控 `watchlistPollTick` 都是独立通道，不受歇息影响
- **帮助 tick**：30–35s，顺带刷新好友摘要和盯梢
- **土地推送**：`checkFarm({ fromPush: true })`，不因偷菜即将到期而跳过

`behavior.js`：高斯抖动、好友 `markStealDueAt` / `stealIsDue` / `stealIsImminent`，以及独立的 `markOwnHarvestDueAt` / `ownHarvestIsDue` / `ownHarvestIsImminent`。偷菜路径不要调用 `maybeStretchDelay`。

## 重点监控好友（2026-08-22 加）

- 配置：`store.js` `watchlistFriendGids`（按账号 GID 数组），链路照抄 friendBlacklist：`GET/POST /api/friend-watchlist[/toggle]`（admin-friend-routes.js）→ `broadcastConfig` → worker 内存快照
- 面板：好友列表每行星标按钮（FriendsFriendList.vue），store `friend.ts` fetchWatchlist/toggleWatchlist
- 生效逻辑（worker）：
  - `fertilizer-watch.js` `setPriorityGids`（friend-orchestrator 每次列表刷新时同步）：重点好友摘要提前阈值 25s→5s、shock 30min→10min、地块提前 20s→10s
  - **主动巡田（2026-08-24 降频，2026-08-25 窗口内提速）**：wx 的 GetAll 好友摘要根本不带 `ripe_time_sec`（实测：好友有在长的作物摘要也显示「暂无成熟时刻」），所以仍需 `watchlistPollTick` 只对重点好友进门建立地块基线。但普通收菜、重种等变化无关紧要：>122 分钟/未知/无作物保持 **5-8 分钟一次**；进入可配置的 122 分钟观察范围后收紧为**单目标 45-75 秒一次**，并把窗口外定时器截断到窗口入口，不能再睡过边界；≤60 秒仍由 PREARM 成熟墙钟保护。只有 `fertilizer-watch` 确认施肥证据才切 0.4–1.2 秒 HOT。异常降速只给窗口外/未知的非 HOT 基线追加约 90-135 秒；窗口内重点基线、HOT 和 PREARM 不追加该延迟，但仍受通信硬预算约束。进门仍喂 `inspectFriendLands` 和精确 ripeAt（并入 `getNextWatchlistStealDueAtMs`）
  - `friend-orchestrator.js`：重点好友 PREARM 窗口 10s→60s（`DUE_PREARM_WATCHLIST_MS`）；stealTargets 排序重点最前
  - **122 分钟重点观察窗口**：化肥一次最多催熟约 2 小时，所以重点好友成熟前 122 分钟进入受控观察（普通好友仍 `wakeBeforeMinutes` 默认 66）。它只影响长睡唤醒和该目标的 45–75 秒基线检查，**不会放宽请求治理器的 Enter/AllLands 门限**；仅当成熟墙钟提前、施肥次数下降、`is_nudged` 上升等证据触发 HOT 时，治理器才在最长 45 秒的施肥窗口内临时放宽
  - 数量不限，仍受 `MAX_ACTIVE_WATCH=6` 和全局进门预算保护
  - 日志：重点好友的施肥 HOT/冷却/预布控/偷菜日志带 `[重点]` 前缀 + `meta.priority: true`；预布控日志（event `重点预布控`）只在进入 PREARM 时打一次。配置生效打 `重点监控已生效`，进 122 分钟范围打 `重点低频观察窗口`（每茬一次；**摘要没有成熟时刻不代表作物没了，清除 announced 状态要摘要明确出时刻且巡田没在跟踪，否则两条路径互相删状态会刷屏**）
- 面板日志筛选：事件值必须与后端 `meta.event` 一致；同一动作可能中英文两种事件名（如 `施肥`/`fertilize`），`filterLogs` 支持逗号分隔 OR 匹配
- 注意：`noteFriendSummaries` 在 `setPriorityGids` 之后调用才有新阈值

## 更早同一天还改过的（仍有效）

1. `client.js`：`autoStartAccounts: true`（重启后账号会自己起来）
1b. **账号「不登录」**：面板账号卡上点「不登录」→ 停下该号并写 `autoLogin: false`；重启 bot 也不会再拉起。点「立即登录」会清掉标记。只停一下仍用「停止」（下次重启还会自动上）。
2. 被踢接管：`auto-code-refresh.js` `scheduleKickoutRelogin()`（**退避递增：5min → 30min → 1h → 3h → 3h…按当日累计接管次数查表**，2026-08-22 改，原来是固定 5 分钟；**每日 5 次即熔断停止**，连续失败 3 次也停）。手动启动会清掉 `relogin_<id>`。`invalid scope [40188]` 是当前 OAuth 授权已明确失效：**当前游戏 WS 仍在线时不停号、不换 Code，也不高频重试**；保活层只做 6–6.5 小时低频复查。若真实断线后现有 loginBuffer 也无法换 Code，必须重扫一次，不得声称代码可以从已终止授权凭空恢复。**自定义重登延迟（2026-08-23 加）**：设置 → 自动控制，账号配置 `kickoutRelogin: { delayMinutes, validUntil }`（照 friendQuietHours 链路；`resolveKickoutDelayMs`/`isKickoutOverrideActive` 纯函数在 auto-code-refresh.js，有测试）。留空/0 = 默认退避；>0 且在有效期内 = 固定自定义延迟；有效期过自动回退默认。熔断（每日 5 次/连败 3 次）不受自定义影响
2b. **长凭据保活与换 Code 已拆开（2026-08-26 按真实有效期修正）**：游戏 WS 在线时仍按官方节拍 25s 心跳；微信 `loginBuffer/refreshtoken` 无论在线，还是被踢/异常断线后的等待接管期，都持久化服务端 `expires_in/expires_at`，只在到期前 35–45 分钟真实续期一次。临时失败按 5/10/20 分钟上限退避，明确失效只低频复查。保活成功只更新长凭据，绝不申请游戏 Code、启动或重启 Worker；真正到接管时才用最新 loginBuffer 申请一次 Code。只在 bot 冷启动、真实 WS400/被踢/重连失败或手动点击时才换 Code。面板旧字段 `autoCodeRefresh.intervalMinutes` 为了数据兼容保留，现语义是「真实断线后的重试间隔」，不再是在线周期刷新。
3. 会话 FIFO：`core/data/admin-sessions.json`，上限 20
4. 收菜/种菜拆开关：`harvest` / `plant` 独立于农场巡查
5. `friend-visit.js` 补过 `analyzeFriendLands` import（放虫放草曾崩）
6. 前端：日志新的在上；Socket.IO token 用回调；「立即登录」；飞书 webhook 贴 Token 框；农场巡查/收菜/种菜三个开关。改 web 后要 `corepack pnpm -C web build`
7. **背包种子优先漏活动种子（2026-08-23 修）**：三连因——① `store.js` `getConfigSnapshot` 缺 `bagSeedKnownIds`，写入了读不出，前端永远走迁移分支；② `useStrategySettings.ts` 迁移分支在优先列表非空时不把背包新种子补进列表；③ `bag_priority` 种植只认优先列表内的种子，列表外既不显示也不种。修了 ①②；③ 旧设计已于 2026-09-11 废弃（现在列表只决定顺序）。注意 2×2 种子（如星语铃花）1x1 种植必跳过，只有开「2x2 优先」才走四格预留路径

## 系统架构（当前状态）

```
┌────────────────────────── 主进程 (core/client.js) ──────────────────────────┐
│                                                                             │
│  Web 面板 :3007 (Express + Socket.IO)                                       │
│    controllers/admin-*.js  → REST 路由；实时推送 log:new / status:update     │
│    admin-session-manager   → 会话持久化 core/data/admin-sessions.json，      │
│                              FIFO 上限 20，重启不掉线                        │
│                                                                             │
│  runtime-engine.js                                                          │
│    ├─ worker-manager.js    → 每账号起一个 worker（thread/fork），             │
│    │                         看门狗 30s ping / 90s 超时重启，日限 8 次        │
│    ├─ auto-code-refresh.js → 在线只保活长凭据，不周期换 Code；断线/被踢才换   │
│    │                         (等待期保活长凭据；接管时才换 Code)             │
│    ├─ relogin-reminder.js  → 下线提醒（飞书/SMTP/…，pushoo 多渠道）           │
│    └─ data-provider.js     → 面板读写接口（startAccount 对微信=立即换code重登）│
│                                                                             │
│  登录入口:                                                                   │
│    微信: 面板扫码 → 应用宝 OAuth + 内置 MMTLS → 农场短时效 code               │
│    QQ:   内置 MITM 抓包 (capture/, 自签 CA, 代理口 18000-18999) → 提 code    │
└───────────────┬─────────────────────────────────────────────────────────────┘
                │ IPC（状态/日志/config_sync/RPC）
     ┌──────────▼──────────┐
     │ Worker × N（每账号）  │  core/src/core/worker.js
     │                     │
     │  统一 tick + 独立自己成熟保护器（安全闸门后，自己收获最高优先）:
     │   ├─ 自己到点 → own_harvest_guard 30-80ms 直发缓存地块 Harvest；失败分档重试
     │   │    · 成熟前 10s 预留通道；所有自己的收获入口共享一个在途 Promise
     │   ├─ 好友偷菜到期(stealIsDue) → 自己无临近成熟时本轮只偷；好友间隔 40-120ms
     │   ├─ 农场 tick 8-12s → checkFarm：收获→务农(水/草/虫)→种植→施肥→升级
     │   │    · 收获/种植 独立开关(harvest/plant)；种菜策略见面板(max_exp 等)
     │   │    · 最近成熟时刻早于间隔时提前唤醒(capDelayByMatureInMs)
     │   │    · 土地推送走 fromPush，不被偷菜挡住
     │   ├─ 帮助 tick 30-35s → 好友列表/帮忙/刷新偷菜时刻表(steal-schedule)
     │   └─ 每日例行：邮件/分享/月卡/VIP/免费礼包
     │
     │  关键服务:
     │   ├─ steal-schedule.js    好友偷菜时刻表(好友ripe_time_sec+盯梢)
     │   ├─ fertilizer-watch.js  成熟墙钟缓存 + NORMAL/HOT/COOLDOWN/PREARM + 全局预算
     │   ├─ behavior.js          高斯抖动/stealIsDue/stealIsImminent(仅节奏层)
     │   ├─ farming-orchestrator / friend-orchestrator / planting-service
     │   └─ network.js  WebSocket+protobuf 直连游戏服：心跳25s、断线指数退避重连、
     │        KickoutNotify→account_kicked；tsdk/ACE wasm 签名；
     │        device-fingerprint 按账号固定设备串(store 落盘)
     └─────────────────────┘

数据: core/data/ — accounts.json(账号凭证)、store.json(全部配置/策略/开关)、
      admin-sessions.json、stats/(每日统计)、logs/、login-assets/、known_friend_gids/

前端: web/ — Vue3 + Vite + Pinia + UnoCSS（pnpm workspace 成员）
      面板页: Dashboard(运行日志,新在上)/好友/图鉴/商店/活动/分析/设置
      实时: Socket.IO(token 回调取最新) + 10s REST 兜底；改后须 pnpm -C web build
```

模块依赖方向：`controllers → data-provider → runtime-engine → worker-manager → worker 进程`；worker 内部 `worker.js → orchestrators → farm-api/friend-api → network.js`。配置单向下发：`store.json → config_sync IPC → worker 内存`。

## 活动自动进化管线（2026-08-23 加；同日扩为双任务）

- **检测**：`activity-update-monitor.js` 每 30 分钟只读扫 `ActivityService.List`（+GetGroup 探测）→ `core/data/activity-update-report.json`；`analyzeReport` 同时识别**已结束活动**（`end_time` 过期或上次在列表现消失 → `endedActivityIds`）。日期 ID 兜底原来单轮枚举 40-50 个未发布 ID，2026-08-24 改成每轮最多 6 个、按半小时轮换覆盖；“活动不存在”这种明确服务端业务响应保留在请求画像但不触发异常降速，超时/断线/发送失败仍照常计入
- **双任务**（`activity-evolver.js`，共用「agent 改代码→测试门→提交→待确认」流程）：
  - `activity`：新活动/结束活动事件触发（每日一次）；**北京时间 00:00-01:00 窗口**当天没事件也跑一版轻量核对（「每天更新一版」）
  - `safety`：同窗口**每天必跑**防封审计——按「少请求→无规律→环境稳→快收敛」四杠杆审请求画像/日志错误/客户端版本/wasm 基线，能安全修的最小改动修，不能修的记 HANDOFF「风险待处理」
- **默认进化执行器可选（2026-08-25）**：「自动进化默认执行器」下拉框同时固定在「活动中心」页面顶部主栏和「活动分析」弹窗标题栏，可选 `Claude` 或 `Codex`；两个入口绑定同一状态。选择写入 ignored 的 `core/data/activity-evolve-state.json.defaultAgent`，每天自动 safety、随后自动 activity、手动触发均读取该值。CLI 只按显式 `*_BIN`、当前 `PATH` 和本机 NVM 目录动态解析；模型与登录配置只存在本机，仓库和通知不得记录具体路径、网关、账号或凭据。
- **权限与测试门不变**：两种执行器都拥有自动修改仓库所需的高权限，但只继承运行必需的环境变量白名单，Prompt 从 stdin 输入而不出现在进程参数。全量测试通过后 Agent 只创建本地提交；父进程扫描新增 URL、秘密、个人信息、提交标题和文件名，通过后才 SSH 推送 `origin/main`（**不重启**），失败或命中隐私规则则不推送并丢弃可安全回退的自动提交。
- **告诉 agent 怎么改 / 不满意重做（2026-08-25）**：「活动中心 → 自动进化 / 活动分析」的自动进化区不再依赖活动扫描报告，始终显示“给 Claude/Codex 的修改要求”和“拒绝本次并按要求重做”。没有 `pending_apply` 时拒绝按钮仍可见但置灰并标明“当前无待应用提交”，不再用 `v-if` 隐藏。点击“保存修改要求”后写入 ignored 的 `core/data/activity-evolve-state.json.userInstruction`，以后自动 safety、自动 activity 和手动任务都会把它原文加入提示词；清空后保存即可取消。若状态为 `pending_apply`，填写具体原因后点拒绝：服务端仅在待应用提交仍是当前 HEAD、工作区洁净时创建 `git revert`，先通过 SSH 推送回退提交，再携带要求重跑同类任务；不会先应用不满意代码，也不会用 `reset --hard` 覆盖后续人工提交。接口：`POST /api/activity/update/instruction`、`POST /api/activity/update/revise`
- **拒绝后连续上下文，不从零开始（2026-08-25）**：拒绝时把被拒提交、原任务类型、上一轮 `logFile / summary / changeSummary` 存为 `revisionContext`。重跑 prompt 的顺序固定为：完整读 HANDOFF → `git show --stat <被拒提交>` 和完整 diff → 读取上一轮 agent 日志 → 沿用已验证事实/日志结论，只重查用户否定和受影响部分。被拒代码只是上下文，不能整包重新应用；新一轮成功收口后清掉 `revisionContext`，失败则保留供再次续跑
- **进化提示词历史回归硬门（2026-08-25）**：活动和安全两个 prompt 共用 `buildEvolutionGuardrails()`，最前面是“先完整读取 HANDOFF”的执行顺序硬门，然后才允许查看源码/日志/diff；每轮还强制声明当前策略是可用基线、请求异常只能降速普通任务、整号熔断禁止恢复、自己 30–80ms 收获/好友到点偷菜/重点用户 HOT-PREARM 不得被 cooldown 阻断。涉及治理器、调度、成熟墙钟、登录保活或设备串时必须有真实日志证据，并补三条收益链不被阻断的回归测试；证据或测试不足只记 HANDOFF，不自动动代码
- **无可靠改动就零改动（2026-08-25）**：上述共用硬门和 activity/safety 两个任务 prompt 都明确允许代码、HANDOFF、Git 提交全部不变，agent 以 0 退出后由现有 `no_change` 状态正常收口。旧的“没有可修的就只更新 HANDOFF 并提交”已删除，不得为凑每日提交刷无意义记录。实际改代码时的 HANDOFF/测试/本地提交/父进程隐私扫描与推送硬门不变
- **短期运行问题收件箱（2026-08-26）**：`daily-events.js` 把白名单内的 warn/error 同步汇总到 ignored 的 `core/data/evolution-runtime-issues.json`，目前仅含普通巡查降速、自己的收获/务农/种植失败、被踢、重连失败、Code 刷新失败和微信长凭据保活失败；文件只存固定脱敏类别、首次/最近时间和次数，不接收账号 ID、好友名、错误原文、协议方法、URL 或凭据。下次 safety 启动时把快照送入 Prompt，并明确它只是线索，Agent 仍须回看本机 3 天日志取证。`no_change` 立即确认已复盘批次；产生提交时把批次留到“应用进化”重启成功再确认；失败、推送失败、隐私拦截和拒绝重做均不清除。同类别若在 Agent 运行后再次发生，只扣旧次数，保留新发生部分；未处理项也最多保留 72 小时。
- **调度可见性（2026-08-26）**：自动进化从未删除，`activity_evolver/daily_evolution` 仍在北京时间 00:00-01:00 随机调度。活动中心顶部直接显示“下次自动”和待复盘类别数，活动分析弹窗再显示准确时间及类别数/发生次数，不能再只靠“上次日期”猜任务是否存在。启动窗口与补跑规则不变。
- **本轮拒绝的错误方向**：自动巡检提交 `33beeb4（持久化熔断并收紧异常重试）` 尚未应用即被拒绝并整笔 revert。原因不是测试失败，而是方向违反用户确认的策略基线：把“异常收敛”理解成继续持久化/收紧熔断，容易再次演变为成熟后无法收菜、好友到点无法偷、重点用户 `Enter` 被 cooldown 拦截。以后即使日志里拦截量高，也必须先区分普通扫描与收益竞速链；不能只以“降低请求数”为目标跨模块扩大改动
- **工作区与推送硬门**：启动前检查 tracked + untracked（ignored 的 `core/data/`、日志、凭据仍不参与），有人工文件就记 `deferred`，不启动 agent。Agent 禁止自行推送；退出后父进程先审新增行、文件名和提交说明，任何新 URL、凭据、机器路径、内网地址或运行时身份字段都会进入 `privacy_blocked`，不会到达 GitHub。扫描通过后才异步推送并核对 `origin/main`；远端仍不一致时状态为 `push_failed`，10 分钟后只对同一安全提交重试一次。
- **调度与重试收口（2026-08-25 修）**：每日窗口先跑 safety，收口后再排 activity，已删除会让 activity 永远饿死的 `if safety ... else if activity`。若 safety 产生提交，则等面板应用并重启后再续跑 activity；失败/130/143/SIGTERM 会清当日闸门，10–15 分钟后最多自动重试 1 次，二次仍失败再放行轻量 activity，避免无限拉起 agent。Bot 因重启错过当天窗口时也会延迟 10–15 分钟补 safety。活动失败同样清闸门且不写入 `handledUnknownIds/handledEndedIds`，所以候选不会被误吞；只有 `pending_apply/no_change` 才算处理完成
- **半自动应用**：面板 → 活动更新 →「应用进化」→ `scripts/apply-evolution.sh` 重启生效；脚本必须先确认既有 `farm:0.0` pane 存在，再停服并用 `tmux send-keys` 把启动命令发回该 pane，不得新建 tmux 会话/窗口或用 `nohup` 脱离运行。新进程启动会把 `applying` 可靠收口成 `applied` 并通知。尚未应用但不满意时使用“拒绝本次并按要求重做”，由服务端创建可追溯的 revert；不要再让用户手工 `reset --hard`
- **通知**：飞书地址只从本机环境或 ignored 的 `core/data/private-config.json` 读取；源码没有默认地址。外发通知统一删除完整 URL、内网地址、机器用户路径和常见令牌。store 配了非飞书 webhook 则走 pushoo。待确认、推送失败/恢复以及应用完成仍附匿名化后的 `changeSummary`。
- **测试日志隔离（2026-08-25 安全巡检产出，人工收口）**：`logger.js` 识别 Node 测试进程的 `NODE_TEST_CONTEXT`，测试时只保留控制台 transport，不启动生产日志轮转/清理，也不写 fallback 文件。这样「肥佬/催熟党」等测试夹具不会混入 `core/data/logs/combined-*.log`，避免面板和下一轮安全巡检把夹具误当真实风险证据；生产进程无该环境变量，日志行为不变
- **状态/日志**：`core/data/activity-evolve-state.json`、`core/data/logs/evolve-<task>-<agent>-<date>.log`；手动触发、应用和测试通知仍走原有管理接口。状态新增 `privacyFindings / privacy_blocked / privacy_blocked_local`；运行数据目录为 `0700`、文件为 `0600`，进化日志只保留 3 天。退出码 130/143 或伴随 signal 记为 `interrupted`，不再误报“巡检失败”。
- **仓库**：通过 SSH 推送当前 `origin/main`。`core/data/`、日志、构建产物和 `.env` 均忽略；不要在 HANDOFF、提交说明或测试夹具中写真实凭据、身份、私有地址。

本轮验证（进化反馈闭环）：Node 20 全量测试 **265/265** 通过；本轮针对 HANDOFF 首读、连续 revision context、按钮常驻以及成熟收获/偷菜/施肥盯梢/请求治理的定向测试 **71/71** 通过。前端生产构建通过；相关后端/前端 ESLint 均 0 error（仅保留既有格式 warning）。`0d5dae4` 只负责回退错误巡检，后续提交只包含反馈闭环；若要撤反馈功能，只 revert 后续反馈提交，**绝不能 revert `0d5dae4` 或重新应用 `33beeb4`**。

本轮踩坑与注意点：自动进化提交已经推到 `origin/main` 但未点击应用时，运行中 Bot 仍是旧代码，不能因为远端 HEAD 变化就误判为已经生效；拒绝时必须验证 `state.commit === git HEAD` 且工作区洁净，再用 revert 留审计轨迹。拒绝按钮不能用 `v-if="status === pending_apply"`，也不能放在依赖活动报告的模板内，否则最需要解释状态时入口反而消失；应始终渲染、按状态置灰。用户修改要求和 `revisionContext` 属于 ignored 运行状态，不得写入提交日志或飞书正文，避免用户临时输入泄露；只把它们注入本机下一轮 agent prompt。

本轮验证：Node 20 全量测试 **262/262** 通过；新增 `defaultAgent` 优先/旧 `agent` 迁移、飞书提交说明/文件数/增删行数/二进制摘要，以及测试夹具不落生产日志断言。`npm run build`（web）通过，仅保留既有两个 UnoCSS 图标缺失警告；本轮相关后端 ESLint 通过，前端 ESLint 0 error（仅既有格式 warning）。回滚本轮默认执行器、飞书摘要与测试日志隔离：`git revert <本轮提交>` 后重启 Bot；不要回滚登录保活、成熟优先级或请求治理提交。

## 请求治理：通信层硬预算 + 分级降速（2026-08-24，防封核心护栏）

`core/src/services/request-governor.js`，`network.js` `sendMsgAsync` 唯一出口统一过闸（有 `test/request-governor.test.js`）：

- **硬预算**：常规滑动 60s 总请求 ≤80（`FARM_REQUEST_LIMIT_60S`）、单接口 ≤30（`FARM_REQUEST_METHOD_LIMIT_60S`）；仅施肥 HOT 短窗总量 ×1.5、`Enter/AllLands` 单项 ×3，超限静默丢弃非白名单请求（走正常错误路径，调用方自动跳过）。白名单：心跳/登录/ACE + `Harvest|Steal` 核心链
- **异常分级降速**：15 分钟内非竞速失败 ≥12 次 → 随机 5-10 分钟降速提示。请求出口不再返回 `cooldown`，不会整号暂停；普通农场/帮助 tick 放缓，窗口外/未知的非 HOT 重点巡田在原间隔上再追加约 90-135 秒；已经进入重点施肥观察窗口的 45–75 秒基线不叠加该延迟。自己收获、好友成熟抢收、施肥 HOT、心跳/登录继续运行，通信硬预算始终保留
- **成熟竞速与施肥 HOT 分层（2026-08-24）**：PREARM、立即可偷和唯一好友 `stealHarvest` API 只续 60 秒 `contentionMode`——窗口内 `Enter / AllLands / CheckCanOperate / Harvest / Leave` 的预期业务失败仍进入请求画像，但不累计异常降速；它**不提高请求预算**。只有可信施肥变化触发 HOT 才启用 `watchMode`，在最长 45 秒内对 `Enter / AllLands` 放宽单方法门限和总预算。这样普通重点用户成熟前 122 分钟不会长期占用宽限，窗口外或其他接口的连续失败只会让普通巡查进一步降速，不会冻结核心策略
- **画像**：`getRequestProfile()`（network.js 已导出）给安全巡检喂事实——worker 内在用，主进程拿不到 worker 内存态，巡检 agent 以日志证据为准
- 这是**保守护栏**，不做协议层伪装；60s 硬预算仍是最终请求闸门，异常阈值只负责调度降速

## 偷菜最早时钟与进化零改动收口（2026-08-25）

### 问题根因与修复

- `computeNextStealDueAt()` 旧实现在 `stealingNow=true` 时不把 `steal_plant_num > 0` 计入 due。这在只有一个全局时钟时是“避免本轮重入”的旧思路，但当前已是 `friendSummaryDueByGid` 按好友保存并由 `applyStealVisitResult()` 逐人收口。旧分支反而会在偷菜轮开始时预先丢掉“现在可偷”的最小值：后续若进门失败或请求预算未放行，面板和调度就会跳到另一个更晚成熟点。
- 现在摘要已确认可偷的好友在整个本轮都继续以 `now` 作为 due；成功进门后仍沿用现有逻辑只更新/清除该 GID，Harvest 失败或未成功进门则保持最小值，走现有约 1s→2s→4s→…→30s 退避和成熟后 90s 宽限。这只修正已发现目标的状态收口，**没有提高好友列表刷新、普通进门、HOT/PREARM 或任何协议请求频率**。
- `stealingNow` 已从 `friend-orchestrator` 的时钟重建接口移除，避免以后再把“执行中”错当成“已处理”。回归覆盖了有当前可偷好友与 40s/90s 未成熟好友并存时，全局最小值仍必须是 `now`。

### 进化与重启硬门

- `buildEvolutionGuardrails()`、activity prompt 和 safety prompt 都已删除“没有可修项也强制更新 HANDOFF 并提交”。没有可靠证据/安全收益时保持工作区不变、以 0 退出，现有 `no_change` 状态负责正常通知；只有实际修代码才触发 HANDOFF/全量测试/提交/推送硬门。ignored 的 `activity-evolve-state.json.userInstruction` 已同步追加这条，默认执行器仍是 Codex。
- `apply-evolution.sh` 不再 `nohup bash start.sh`。服务端和脚本都会在停服前验证既有 `farm:0.0`，只向该 pane 发送 Node 20 `start.sh` 命令；找不到 pane 直接取消，不会另开会话、窗口或后台 Bot。

### 验证、踩坑与回滚

- Node 20 定向回归 **40/40** 通过（偷菜时钟、成熟收益链、进化会话与 tmux 应用）；`cd core && node --test test/*.test.js` 全量 **274/274** 通过；`bash -n scripts/apply-evolution.sh` 通过。
- 排查时不能用 `combined-*.log` 里相邻两条“空闲歇息”horizon 直接证明单账号时钟跳变：合并日志同时包含多个 worker，旧测试夹具也曾污染生产日志。本次根因以用户实际现象 + 可确定复现的 `stealingNow` 分支 + 回归为准，没有根据跨账号日志误改调度频率。
- 不能为了面板永远显示更早而把到期 due 无限保留；必须保留“成功进门按 GID 清理 + 过期 90s 收敛”，否则会复发 100ms GetAll 风暴。tmux 应用脚本必须在 `stop.sh` **之前**验证 pane，否则 pane 配置错误会把 Bot 停掉却无法拉起。
- 回滚用 `git revert <本轮提交>` 后仍在现有 `farm:0.0` 重启；不得回退 `0d5dae4` 或重新应用 `33beeb4`。

## wx 普通好友精确地块时钟补源（2026-08-25）

### 线上证据与根因

- 03:14 面板和结构化日志同时显示“距下次成熟/可偷约 6 小时 39 分”；用户在官方农场内看到“普通好友 A”约 3 分钟成熟。Bot 随后于 **03:17:32** 成功偷到该好友 24 块勿忘我，证明“成熟后摘要发现→偷菜”没丢，错的是成熟前时钟覆盖率和面板语义。
- 该账号是 wx，其 `FriendService.GetAll` 对部分普通好友只在成熟后给 `steal_plant_num`，成熟前 `ripe_time_sec=0`。不逐个进好友农场就无法从协议中凭空获得这个墙钟；为了“面板全准”加全好友高频 Enter 会直接违反封号风险约束。
- 但现有 `inspectFriendLands()` 在帮忙、偷菜、捣乱、重点巡田和 `LandsNotify` 里早已读到每块地 `phases`，并存在 `landSnapshots`。旧逻辑只用它检测施肥，没有并入偷菜总时钟，这是可以在不新增 RPC 的前提下修复的确定丢数点。

### 本次改动

1. `fertilizer-watch.js` 新增 `getNextKnownFriendRipeEntry()`，在**已有**完整进门/增量推送地块快照中按 GID/地块取最早成熟墙钟；过滤自己、黑名单、快照建立时已成熟的地块和超过 90s 宽限的旧时钟。
2. `friend-orchestrator.js` 把上述已知精确时钟与好友摘要、HOT/PREARM 取最小值。普通好友只在最早时刻进入 10s 窗口时转 PREARM，重点好友仍是 60s；到点可按 GID 跳过不带 `ripe_time_sec` 的 wx 摘要直接进门。远期时钟不占 HOT/PREARM 活跃容量。
3. `visitFriendForHelp()` 和综合 `visitFriend()` 把已读到的 `ripeAtMs` 返回给统一时钟收口；这只复用本来就发生的进门，**没有增加好友列表刷新、普通好友 Enter、HOT 或重点巡田频率**。
4. `worker.js` 面板状态中的“偷菜”不再混入 `ownHarvestDueAt`；自己作物仍由原来的独立成熟保护器毫秒级收获，优先级和时序没有改。`Dashboard.vue` 对 wx 显示“已知最早”；没有任何已知时刻时显示“暂无已知时刻”，不再把一个晚时钟冒充全好友答案。

### 验证

- Node 20 定向回归 **49/49** 通过，覆盖已读地块 3 分钟/6 小时取最小值、黑名单/过期快照、近成熟 PREARM 直达、自己收获优先和无整号熔断。
- `cd core && node --test test/*.test.js` 全量 **278/278** 通过；本轮相关后端 ESLint **0 error**。前端生产构建通过，Dashboard ESLint **0 error**，仅保留该文件既有 8 条 UnoCSS 排序 warning；构建仍只有既有两个 UnoCSS 图标缺失警告。
- 首次 ESLint 误用系统 Node 18，ESLint 9 载入配置时报 `Invalid regular expression flags`；换回 HANDOFF 固定的 Node 20.20.2 后才得到有效 lint 结果。以后不得把 Node 18 的工具链失败当作源码回归。

### 踩坑、边界与回滚

- **不能把快照里“建立时已成熟”的地块反复并入 due**：偷菜前读到的成熟 phase 在 Harvest 后不会自动改写那份回包。若不检查 `snapshot.growing === true`，它会在 90s 宽限内反复 PREARM/进门。现在只接受快照建立时还在生长的墙钟；它到点后仍能受控重试，下次成功进门会把状态刷新为已成熟并停止重试。
- **“已知最早”不是“全好友最早”**：普通 wx 好友如从未被帮忙/访问且没有推送，成熟前仍可能未知。系统只保留 5–8 分钟低频摘要重新发现；需要成熟前精确墙钟/施肥识别的用户应加入重点监控。不得为了普通未知好友改回 30–60 秒、更不能改成全好友高频进门。
- **面板显示与自己成熟保护必须解耦**：删除 `resolveStealDueAt()` 里的自己 due 只改面板。不得借此删除 `own_harvest_guard`、最后 10s 通道预留或 30–80ms Harvest。
- 回滚本轮用 `git revert <本轮提交>`，然后仅在既有 `farm:0.0` 重启；不得恢复全号熔断或新增全好友进门扫描。

## 偷菜“下次检查”显示语义修正（2026-08-25，重点好友案例）

### 线上证据与根因

- 结构化日志确认重点好友 A 的成熟作物已成功偷取，偷菜本身没有漏；成功后日志里的全局已知成熟 horizon 约 2 小时 52 分。身份字段和原始 GID 只留在 ignored 的本机日志，不得写入仓库。
- 后续复用管理接口对重点好友 A 做一次定向只读核对：它下一块自然生长作物约 9911 秒成熟，其余多数地块约 16749–16844 秒；同时全局最早已知成熟约 8739 秒。全局值来自另一个好友，不能把无归属的全局值解释为“重点好友 A 偷完后的时间”，也没有证据证明该好友施肥导致时钟漂移。
- 真正的显示 bug 是语义错位：卡片标题固定为“下次检查倒计时”，后端却把好友**已知最早成熟墙钟**放在主值。当时 Bot 仍按 15–60 秒摘要重查并在成熟后偷到菜，所以会出现“没有漏偷，但界面看起来要几小时后才检查”的错觉；该高频重查已在后续“普通偷菜与施肥监控解耦”一节移除。

### 本次改动

1. `worker.js` 把 `nextChecks.stealRemainSec` 改为 `nextStealRunAt` 的真实下一动作倒计时，新增 `stealKnownRemainSec` 专门承载协议目前知道的最早好友成熟墙钟；后续普通偷菜已改为有墙钟直接到点，因此两者相同时前端不重复展示。
2. `Dashboard.vue` 主行显示真实下一动作；后续普通偷菜改成按成熟点唤醒后，主值通常就是成熟倒计时。只有 HOT/PREARM 或完全未知兜底使下一动作与成熟点不同时，才在下方另标“全局已知最早成熟”；wx 仍提示“部分好友成熟时刻不可见”。
3. 好友地块详情、手动好友操作和狗信息扫描本来就会成功 `Enter` 并拿到 lands；现在把这些**已经读到的回包**送入 `inspectFriendLands()`，API 返回后立即重排既有偷菜时钟。没有新增 RPC、没有增加普通好友进门或摘要刷新频率。

### 踩坑、注意点与回滚

- Node 20 偷菜/施肥/成熟定向回归 **51/51** 通过，`cd core && node --test test/*.test.js` 全量 **280/280** 通过；相关后端和 Dashboard ESLint 均 **0 error**（Dashboard 仅既有 8 条 UnoCSS 顺序 warning）。前端生产构建通过，仍只有既有两个 UnoCSS 图标缺失 warning。
- **不能把全局最早成熟时间归因于日志里最后一个被偷好友**：全局值是好友摘要、已读地块、HOT/PREARM 等多个来源按最小值合并，且面板没有好友归属。排查单个好友必须用同一 GID 的实际地块 phases 对照。
- **“下一动作”和“已知成熟”必须保持语义清楚**：普通有墙钟时下一动作本来就是成熟点，无需重复显示两行；HOT/PREARM 或未知重新发现时，两者才可能不同。不能再拿某个无归属成熟点解释为刚偷好友的下一检查。
- wx 的普通好友成熟前仍可能没有 `ripe_time_sec`；不允许为了补齐辅助显示而新增全好友高频 `Enter`。未知好友只由 5–8 分钟低频摘要重新发现，自己到点收获、好友到点偷菜、重点 HOT/PREARM 和现有请求治理策略均未改。
- 回滚用 `git revert <本轮提交>`，随后只在既有 `farm:0.0` 重启；禁止恢复整号熔断或收紧收益竞速链。

## 普通偷菜与施肥监控彻底解耦（2026-08-25）

### 根因与改动

- 用户从新面板看到偷菜主倒计时长期只有几秒/几十秒，反查 `armStealWake()` 确认不是显示误差：旧代码会把普通好友成熟墙钟与 `effectiveWakeBeforeMs()`（普通 66 分钟、重点 122 分钟施肥观察窗口）合并，再在窗口内每 3–5 秒、三小时内每 15–30 秒跑一次 `GetAll`。虽然没有逐个 `Enter`，但普通偷菜确实错误继承了施肥观察频率。
- `armStealWake()` 现在对未来 `dueAt` 只安排一次 `dueAt + 30–120ms` 唤醒，不再计算 `nextPreRipeScanAt`，也不再插入按 horizon 分档的摘要重查。成熟点到达后仍走原来的 `checkFriends({ onlySteal: true })`；已创建的 PREARM 或施肥 HOT `nextVisitAt` 仍通过 `getNextWatchDueAt()` 独立取最小值，所以重点收益链没有被降频。
- 完全没有任何已知好友成熟墙钟时，保留 **5–8 分钟高斯抖动**的轻量 `GetAll` 重新发现。它是 wx 普通未知好友的保底，不属于施肥监控；不得缩回几十秒。成熟后请求失败仍使用原 90 秒宽限与 1s→30s 受控退避，不能把失败重试也放到 5–8 分钟。
- 删除 `runFarmTick()` 为偷菜顺带调用 `refreshFriendRipeSchedule()` 的路径；普通农场检查不再额外制造好友摘要请求。重点好友的 2–8 分钟定向基线巡田、HOT 0.7–1.2 秒目标追踪、PREARM 到点直达和 `LandsNotify` 事件触发均保持独立。
- 面板在主倒计时与全局已知成熟相差不超过 2 秒时隐藏重复的辅助行；普通有时钟时只看到到点倒计时，HOT/未知兜底造成下一动作与成熟点不同时才分开展示。

### 踩坑、注意点与回滚

- Node 20 偷菜/施肥/成熟定向回归 **53/53** 通过，`cd core && node --test test/*.test.js` 全量 **282/282** 通过；相关后端和 Dashboard ESLint 均 **0 error**（Dashboard 仅既有 8 条 UnoCSS 顺序 warning）。前端生产构建通过，仍只有既有两个 UnoCSS 图标缺失 warning。
- **不能为了检测普通好友施肥而恢复 horizon 分档轮询**：普通好友不是施肥重点对象；需要施肥识别的用户加入重点监控，由独立的窗口内单目标基线和 HOT 负责。`wakeBeforeMinutes/watchlistWakeBeforeMinutes` 不得再次进入普通 `armStealWake()` 的重查间隔计算。
- **到点唤醒不等于删除低频未知兜底**：wx 对未访问普通好友可能完全不提供成熟前墙钟。若把未知 fallback 也删除，Bot 重启后会一直不知道这批好友已经成熟；5–8 分钟是当前安全与漏偷之间的明确保底边界。
- **不能把成熟后的短退避一起降频**：已经到期但进门/Harvest 未收口属于收益竞速链，仍需原有有界重试；本轮只删除成熟前的重复全好友摘要检查。
- 回滚用 `git revert <本轮提交>`，随后只在既有 `farm:0.0` 重启；不得恢复整号熔断，也不得把 HOT/PREARM 改成普通全好友轮询。

## 安全巡检记录（2026-08-25，每日例行去重与钓鱼推送观测）

### 证据与结论（最近 24h）

- 审计窗口为 `2026-08-23T19:00:00Z ~ 2026-08-24T19:00:00Z`，覆盖 7683 条结构化日志，JSON 解析失败 0 条；`bot.log` 只有 71 字节启动提示。精确关键字统计：**请求超时 1、发送失败 0、被踢下线 22 行（对应 11 次真实 Kickout）、请求被治理器拦截 1448**。
- 唯一超时是 `AntiData`，24h 仅 1 次、没有同接口错误率突增；未发现未知错误码、返回结构突变、未知字段或未文档 RPC 日志。11 次 Kickout 的服务端原因全部是“已在其他终端登录”，不是未知风控响应；本轮不据此改登录接管策略。
- 1448 次治理拦截的方法分布：`GetAll` 1314（`budget_method` 1227、旧 `cooldown` 82、`budget_total` 5）、`Enter` 87、`AllLands` 33、`GetActiveNPC` 12、`Bag` 2。1227 次 `GetAll` 方法预算拦截集中在旧过期 due 风暴，当前代码的 `stealOverdueBackoffMs` 已由 `1ea3c6d` 修复。旧 `cooldown` 最后出现于 16:00；当前进程 18:56 启动后截至 19:12，上述六类风险日志全部为 0。现行 `request-governor` 只返回 `budget_total/budget_method`，异常阈值仅给普通任务降速，不存在请求层整号 cooldown。
- 自己农场 24h 有 12 次成功收获、0 次收获失败；没有新版“到点保护收获”的实跑样本。因此本轮逐行核对 `runFarmTick/runStealTick/armStealWake`、独立 `own_harvest_guard`、`checkFarm/runFarmOperation/harvestOwnAtMaturity/getNextMatureInMs` 后确认接线闭合，但**不凭静态推断调整成熟墙钟或重试节奏**：快照变更会立即重排独立保护器，成熟前 10 秒预留，30–80ms 直发缓存地块，所有入口共享在途 Promise，成功后删除已收地块并重排下一批。
- 环境无漂移：客户端版本仍为 `1.13.0.5_20260723`，版本自动更新日志 0；实际加载的 `tsdk-v3.9.0.wasm` SHA-256 为 `98cc5301...75f0070`，与 `tsdk-ace-runtime.md` 基线一致。两账号持久设备协议均启用且 deviceId 互不相同（只核对唯一性，未输出值）。上游 HEAD 仍为 `1bc45d3ea658429743fcc2e3be503c86a4b7292a`，与 state 中 `upstreamHead` 相同，无新提交，跳过 diff/移植。
- 固定节奏复核：官方 25s 心跳和 ACE 属协议层，不动；星星活动 5min timer 当前所有相关开关均关闭，所以空转无 RPC。发现启用鹊桥自动驻建后同轮操作仍有固定 500ms 间隔，当前同样关闭，证据不足且属于活动路径，本轮只列风险，不预改。

### 本次改动（只减非竞速请求）

1. **每日例行完成态跨 worker 重启持久化**：24h 有 70 次 worker 启动、65 次登录；“邮箱无奖励 / 分享已领取 / 月卡无奖励 / 免费礼包无结果 / 非 QQ 会员”各重复 64 次。按现有调用链每次至少重复 6 个 RPC，保守约 **384 个可避免请求/24h**。新增 `daily-routine-state.js`，按账号和本地日期只落盘已经由原服务确认 `doneToday` 的项目；启动与跨日入口不再 `force=true`。失败或未完成项目不落盘，仍可在后续启动重试；持久化写失败只退化为本进程去重，不阻断后续任务。面板每日礼包总览同时合并持久完成态，避免重启后显示回“未完成”。
2. **非 QQ 会员是终态，不盲重查**：`RefreshVipInfo` 明确返回“非QQ会员”时标记当日无需再查；超时、未知错误码等仍不标记完成，不会被误吞。
3. **未知推送只留有界证据**：`network.js` 原来静默忽略未知推送，巡检无法发现服务端突然下发未文档 RPC。现在每进程最多记录 32 个首次类型，只记净化后的类型名和 body 字节数；**不解码未知 body、不响应、不调用新接口、不重试**。

这些改动不在 farm/help/steal/HOT/PREARM 执行路径。新增回归明确锁住：自己成熟保护器不调用每日例行且不受普通降速；好友到点仍走 `onlySteal` 与 80–300ms 唤醒上限；重点 HOT/PREARM 不被普通 slowdown/cooldown 阻断。Node 20 全量测试 **273/273** 通过；定向核心组合 **63/63** 通过。

### 本轮踩坑、注意点与回滚

- 第一次定向测试曾把“启动不 force”误写成“全文件禁止 `runDailyRoutines(true)`”，误伤面板手动立即执行入口；这是测试边界错误，不是实现失败。已把断言限定在 `startDailyRoutineTimer`，手动入口仍可显式 force，随后定向 63/63、全量 273/273 通过。以后不要为了启动去重删除手动执行能力。
- 持久态只记录原服务已经判定完成的项目；绝不能在一次网络失败后把整组每日任务标完成，也不能让该状态进入农场/好友调度优先级。运行文件位于 ignored 的 `core/data/daily-routine-<account>.json`，不得提交。
- 本轮未重启 Bot；提交推送后运行中进程仍是旧逻辑，需按现有“应用进化”流程由用户确认后才生效。回滚代码用 `git revert <本轮提交>`；回滚后旧持久文件无人读取，无需删除，也不会影响收菜/偷菜。若只撤未知推送观测，恢复 `network.js` 该日志块即可，不能改 TSDK/ACE 或对未知类型添加处理。

### 风险待处理（本轮有证据但不安全自动改）

| 项 | 证据/风险 | 不修理由与后续边界 |
|---|---|---|
| 11 次真人顶号 + 高频开发重启 | 全部明确为其他终端登录；主进程多次重启使日志里的“今日第 N 次”重新计数，全天实际接管超过单进程 5 次上限 | 登录接管属于高风险链，持久化上限可能让账号在成熟窗口离线；本轮不收紧。应先减少人工/进化重启，再单独评估跨主进程计数，禁止把它扩散成业务整号熔断 |
| 自己到点保护器对所有 Harvest 异常走重试梯 | 代码 catch 尚不能区分未来未知业务码；本窗口 Harvest 失败 0、未知错误码 0 | 核心收益链缺真实错误证据，贸然停手会造成成熟不收。若日志出现未知 Harvest 码，按“未知码只记录、不重试”单独设计并补实跑证据；当前只保留风险，不改成熟链 |
| 活动固定节奏 | `star_activity_claim_interval` 5min；鹊桥同轮建造 500ms。当前两账号所有相关开关均为 false，零自动请求 | 开关启用前必须改为有界抖动/每日上限；当前无真实运行证据，按调度硬门不预改 |
| 25s 心跳 / ACE | 官方节拍；本窗口 AntiData 单次超时，无突增 | 协议层硬禁区，继续只观察，不加伪装、不改变上报、不因一次超时加重试 |

## 安全巡检记录（2026-08-23 晚，防封四杠杆审计）

### 证据与结论（24h 日志 + 代码核查）

- **错误面干净**：combined 2026-08-22-18 ~ 08-23-18 共 3065 行，「请求超时」「发送失败」「治理器拦截」「熔断冷却」均为 **0 次**。治理器已接线 `network.js` `sendMsgAsync` 唯一出口，运行中进程（08-23 18:34 启动）已含该代码
- **被踢 5 次全是真人顶号**（`kickout:已在其他终端登录`，02:03/03:11/05:31/16:25/17:46），退避 5→30→60min 与每日 5 次熔断均按设计生效，不是风控信号；24h 内 17 次登录 = 5 次接管 + ~11 次 60min code 刷新 + 手动启动，符合预期
- **环境稳**：`tsdk-runtime.js` 实际加载 `tsdk-v3.9.0.wasm`（sha256 `98cc53…` 与 `tsdk-ace-runtime.md` 基线一致，且有启动校验）；`clientVersion 1.13.0.5_20260723` 全部历史日志零条「服务端版本信息已自动更新」= 服务端从未下发不同版本，同步机制（`applyServerVersionInfo`）在位未触发
- **业务节奏已全随机**：`worker.js` farm/help/偷菜/摘要刷新全部 `gaussianInt`/`randInt`/`idleNapMs`/`maybeStretchDelay`，无固定间隔
- **「图鉴可购买检查」×70/天**是面板用户打开图鉴页触发的 RPC，非 bot 循环，不处理

### 本次改动（最小改动，222 测试全过）

1. **神秘商人轮询加抖动**：双账号 `mystery_shop_auto_buy=true`，原固定 10min interval（~144 RPC/天/号，等间隔机器指纹）→ `mystery-shop.js` `nextAutoBuyCheckDelayMs()` 均匀 ±25%（7.5–12.5min，均值仍 10min）；`worker.js` 改自排程 timeout 链（串行天然不重叠，timer key 不变，stop 逻辑不动）
2. **活动更新扫描加抖动**：`activity-update-monitor.js` 原 `scheduleNextScan` 固定 `intervalMs`（30min 整周期，48 次/天）→ `nextScanDelayMs()` 均匀 ±20%（24–36min，均值不变）

两处都不在偷菜出手/HOT 盯梢/PREARM 抢收链上，均值未放慢，只打散间隔。回滚：`git revert <本次提交>`（或 `git reset --hard <提交前>`）后重启 bot。

### 风险待处理（评估后不修，理由如下）

| 项 | 风险 | 不修理由 |
|---|---|---|
| 心跳固定 25s | 等间隔 | 对齐官方客户端节拍，加抖动反而偏离官方行为；协议层不动 |
| 微信长凭据保活 | 过度刷新或丢失有效期会增加跨日失效 | 已改为持久化服务端有效期，只在到期前 35–45min 续期；40188 不停在线号、不换 Code、不高频重试 |
| ACE 上报 1788 次/24h（约 48s 一次） | 高频上报 | 协议层硬约束不碰（用户禁令） |
| 真人顶号拉锯（单日 5 次接管） | 登录行为密集 | 已有退避递增 + 每日 5 次熔断 + 连败 3 次即停；再收紧等于把号让给真人 |
| `star_activity_claim_interval` 固定 5min | 若打开开关会恢复固定节奏 | 当前所有活动领取开关为关，timer 空转零请求；**打开任一开关前先给它加抖动**（照抄 mystery-shop 的 `nextAutoBuyCheckDelayMs` 模式） |
| `tsdk.wasm`/`tsdk-legacy.wasm`/`tsdk-v3.8.x` 闲置文件 | 无（不被加载） | 留作 wasm 升级回滚物料，不删 |

## 运维坑

- 3007 被旧进程占着时 `start.sh` 不会拉起新代码
- 内存：Cursor fileWatcher 曾吃 121GB，bot 被 OOM 干掉（日志突然断、无堆栈）
- 微信在线会话只走 25s WS 心跳，不周期换 Code；只有冷启动/真实断线/被踢接管才发新 Code，长凭据在线及断线等待期间都另行按服务端有效期提前 35–45min 续期
- 夜间静默**不要默认打开**（会错过晚上偷菜）

## 测试入口

改调度/设备/盯梢时至少跑：

```bash
cd "$(git rev-parse --show-toplevel)/core"
node --test test/steal-schedule.test.js test/fertilizer-watch.test.js test/request-governor.test.js test/maturity-sentinel.test.js test/device-protocol.test.js test/behavior.test.js test/kickout-relogin.test.js test/wx-credential-lifetime.test.js
```

## 不要做的

- 不要恢复 3–5s、15–30s 或 30–60s 的全量偷菜摘要轮询；有墙钟直接等成熟点，完全未知只允许 5–8 分钟低频重新发现
- 不要在没有 trigger 时持续秒级进好友农场，也不要高频刷新普通全好友摘要。HOT 只能作用于触发的目标好友，并且必须保留热窗口、预算和冷却
- 不要把 24h idle 显示到面板
- 不要每次登录重随设备串

## GitHub 隐私清理与自动进化防泄露硬门（2026-08-25）

### 本轮改动

- 飞书 Webhook 和许可证种子已在改源码前无回显迁入 ignored 的 `core/data/private-config.json`，文件权限 `0600`；`feishu-notify.js` / `license.js` 只从本机环境或该文件读取，不再包含仓库默认秘密。不要把此文件、内容或完整地址复制到 issue、通知、测试和 HANDOFF。
- 删除源码内固定超级管理员身份与密码，以及首次启动的弱默认管理员。已有 `core/data/users.json` 正常管理员继续使用；全新部署必须通过本机 `FARM_ADMIN_USERNAME/FARM_ADMIN_PASSWORD` 首次初始化。
- 自动进化 Prompt 改走 stdin，避免用户要求出现在进程参数；子进程环境改为 HOME/PATH/locale/proxy/CLI 配置目录白名单，不再继承 IDE、Git AskPass、管理密码等无关环境变量。专用 `pre-push` hook 会拒绝 Agent 直接上传。
- 父进程在任何自动推送及重推前调用 `auditGitRange()`：检查新增 URL、Webhook/Token/API Key/私钥、内网地址、机器用户路径、个人邮箱、运行时账号/好友字段、提交标题和文件名；自动新增或修改二进制、符号链接也按无法可靠审阅处理；隐私控制文件本身禁止被自动进化修改。命中只返回规则与位置，不回显秘密；安全时用 `git reset --keep` 丢弃本轮自动提交，无法安全回退则进入阻塞状态等待人工处理。
- 外发飞书/pushoo 内容统一用 `redactExternalText()` 删除完整 URL、内网地址、机器用户路径和常见令牌。活动 payload、用户修改要求和 revision context 注入模型前也走相同处理；生产日志里的身份只允许形成匿名结论。
- Bot 启动先设置 `umask 077` 并递归收紧 `core/data`：目录 `0700`、文件 `0600`；进化日志同样 `0600` 且只保留 3 天。现有账号、登录凭据、管理会话、抓包 CA 和日志仍在原 ignored 路径，业务逻辑不变。
- GitHub 远端必须重写为清理后的单一干净根提交，不能只在最新提交删除文本；旧历史里出现过的 Webhook、固定凭据、机器路径和好友身份都视为已暴露。重写前只允许在 ignored 且 `0600` 的本机备份中保留恢复副本，禁止再推任何旧 ref/tag。

### 踩坑、注意点与回滚

- `.gitignore` 只能防止未来新增，不能删除 Git 历史；普通 `git revert` 同样保留旧对象。因此本轮必须 force-push 干净根历史，并从匿名远端重新核对 refs 和内容。
- 干净根历史上线后，HANDOFF 中早期的提交短哈希只保留为历史决策说明，在远端不再可解析；不得为恢复这些引用而重新推送旧分支、tag 或旧对象。
- “应用进化”按钮只保护运行时，挡不住已经发生的 GitHub 推送；隐私扫描必须位于 push 之前。仅靠提示词也不够，所以同时保留 Agent no-push hook 与父进程扫描，后续不得删掉其中任一层。
- URL 本身不一定是秘密，但自动进化没有可靠上下文判断公开/私有，因此对**新增 URL 一律阻断**；二进制和符号链接同样交给人工审查。需要新公开地址或资源时由人工确认后添加。测试要动态拼接假 URL/假令牌，避免仓库扫描把夹具误判成真实泄露。
- `private-config.json` 是保持飞书和旧许可证兼容的唯一迁移落点；删源码默认值前必须先确认本机文件存在且能加载。回滚代码也不得把旧秘密重新写回源码或 Git，只能继续使用本地配置。
- 隐私闸门只影响自动进化推送，不改变自己收获、好友偷菜、重点用户 HOT/PREARM、请求治理、Code 保活和设备串逻辑。任何后续“安全优化”仍不得借机收紧核心收益链。

本轮验证：Node 20 定向隐私/进化测试 **26/26** 通过；`cd core && node --test test/*.test.js` 全量 **291/291** 通过；本轮相关后端 ESLint **0 error**；`scripts/apply-evolution.sh` 和专用 pre-push hook 语法/权限检查通过。只允许在既有 `farm:0.0` 重启，远端必须在强制更新后重新核对只有干净 `main`。

## 被踢/断线等待期间保持微信长凭据（2026-08-25）

### 根因与改动

- 线上出现“被其他终端登录踢下线，30 分钟后接管”。核对调用链确认：`worker-manager.stopWorker()` 会调用 `autoCodeRefresh.stopAccount()`，旧逻辑把在线 `wx_keepalive_*` 一并清掉，随后 `scheduleKickoutRelogin()` 只挂 `relogin_*`。因此 30 分钟、1 小时或 3 小时等待期间没有滚动 `loginBuffer/refreshtoken`；到点才用旧 loginBuffer 申请 Code，失败后再拿可能已经过期的 refreshtoken 补救，长退避下会增加重新扫码概率。
- `auto-code-refresh.js` 抽出 `armCredentialKeepalive()`：在线与断线等待共用按服务端有效期的保活，只调用 `keepWxCredentialAlive()` 更新 `loginBuffer/refreshtoken/accesstoken` 及有效期元数据。`scheduleKickoutRelogin()` 和普通异常断线的 `scheduleRelogin()` 在挂接管倒计时后立即重新挂载离线保活。
- 离线保活**不申请游戏 Code、不启动或重启 Worker，也不缩短 5min→30min→1h→3h 接管退避**；只有 `relogin_*` 真正到点时才申请一次新 Code。面板手动停止没有后续重登排程，仍由 `stopAccount()` 清掉保活与接管任务，不能改成“手动停号也偷偷续期”。
- 接管写回改成只持久化 `{ id, code }`，再重新读取最新账号启动 Worker；不能继续把函数开头的整个旧 account 快照写回，否则离线保活恰好滚动 token 时可能被旧 loginBuffer/refreshtoken 覆盖。

### 踩坑、边界与验证

- 第一次定向测试仍要求 `scheduleAccount()` 函数体直接出现 `setTimeoutTask`，共用函数抽取后误报失败；已把断言改为检查 `armCredentialKeepalive()` 的定时器和“不换游戏 Code”边界。以后测试应锁行为边界，不要锁实现必须写在哪个函数体。
- Bot 主进程重启属于显式冷启动，当前仍会按冷启动流程立即申请 Code，不继承内存里的剩余接管倒计时；不要为了刷新凭据频繁重启。正常被踢但主进程不断时，离线保活与原接管退避会同时保留。
- Node 20 登录生命周期/被踢定向测试 **25/25** 通过，覆盖等待期同时存在 `wx_keepalive_*` 与 `relogin_*`、保活实际重复执行、接管到点前零账号 Code 写入/零 Worker 重启，以及手动停止后两个任务都清除。`cd core && node --test test/*.test.js` 全量 **292/292** 通过；相关 ESLint **0 error**。
- 本轮没有修改收菜、偷菜、重点用户 HOT/PREARM、请求治理、25s 游戏心跳、设备串或 TSDK/ACE。回滚只 revert 本轮提交并在既有 `farm:0.0` 重启；不得恢复在线周期换 Code，也不得用整号熔断代替离线保活。

## 今日事件脱敏日志下载（2026-08-25）

- Dashboard“今日事件”标题右侧新增“下载日志”。下载接口仍走登录态和账号访问权限校验，返回带 UTF-8 BOM 的 `farm-events-<北京时间日期>.txt`，并设置 `attachment`、`no-store` 和 `nosniff`；文件名不含账号 ID、昵称或服务器信息。
- 下载内容不是原始 `combined-*.log`，只导出当天最多 200 条结构化事件。`buildShareableDailyEventLog()` 会删除完整 URL、内网/机器路径、Webhook/Token 等常见秘密，再按本机账号/用户/重点好友 denylist 删除个人字段；偷菜事件无条件把好友昵称改为“好友”，同时清理 GID/openid/uin/wxid、邮箱和换行注入。该文件才适合直接交给别人排查，不能把 ignored 的原始日志或 `daily-events-*.json` 当作等价下载物。
- 原接口只向运行中的 Worker 请求事件，账号刚被踢时下载会失败。现在先走 Worker 获取最新内存事件，Worker 不存在或调用失败时回退读取它退出前同步落盘的当日事件；Dashboard 拉取也不再以 `account.running` 为前置条件。因此被踢/断线时仍能查看和下载已有记录，不会为了下载而启动账号或申请 Code。

### 踩坑、验证与回滚

- 好友昵称不一定已进入运行时 denylist，不能只依赖通用字符串脱敏；`steal` 类型必须按事件结构无条件去掉目标昵称。下载接口也不能直接返回前端当前数组，否则离线时页面缓存可能旧、并且服务端无法执行统一隐私门。
- 首版好友昵称解析用了可产生超线性回溯的宽泛正则，ESLint 已拦截；现改为先线性定位固定的“数量 + 个”片段再切片，不允许为了省代码恢复宽泛回溯表达式。
- Node 20 日志下载/离线回退/登录生命周期定向测试 **28/28** 通过；全量 `core/test/*.test.js` **295/295** 通过；自己收获、好友到点偷菜、重点 HOT/PREARM、请求治理、设备协议及被踢链定向 **89/89** 通过。相关后端和 Dashboard ESLint **0 error**（Dashboard 仅保留既有 8 条 UnoCSS 顺序 warning），前端生产构建通过，仍只有既有图标/字体构建提示。
- 回滚用 `git revert <本轮提交>` 后只在既有 `farm:0.0` 重启。本功能只读当日事件，不得在后续扩展为自动上传原始日志、账号配置、运行数据目录或任何外部地址。

## 偷菜/被偷专用日志下载（2026-08-25）

- Dashboard“今日事件”新增独立“偷菜/被偷日志”按钮，下载 `farm-steal-events-<北京时间日期>.txt`。它只合并两类信息：当日结构化事件中本 Bot 已执行的 `steal`，以及访客互动记录中 `actionType=1` 的“别人偷本账号”；收菜、播种、帮忙、捣乱和其他运行日志不进入附件。
- 专用日志按用户排查需要保留好友昵称、作物、数量、地块和时间；但这**不是取消安全处理**：仍不输出 GID、头像 URL、账号 ID/名称、凭据、Token、Webhook、邮箱、网址、内网或机器路径。互动记录昵称缺失且只剩 `GID:*` 时统一写“未知好友”，不能把数字身份当昵称输出。
- “被偷”数据不新增后台监控：只有用户点击下载时才调用现有 `getInteractRecords` 一次，不挂定时器、不改变好友扫描频率，也不进入偷菜/重点施肥调度。账号离线或互动接口不可用时，仍返回已落盘的主动偷菜事件，并在附件头标注本次未读取被偷记录；不得为了补齐附件而启动 Worker、换 Code 或循环重试 RPC。
- 原“下载日志”继续是适合外发的全事件脱敏版，并继续无条件移除好友昵称。两个按钮用途不同，后续不能把保留昵称的专用结果复用为通用分享日志，也不能把 ignored 的原始运行日志直接拼进专用附件。

### 踩坑、验证与回滚

- 访客互动记录不是 `daily-events` 的既有类型，单纯过滤 `type=steal` 只能看到本 Bot 偷别人、看不到别人偷本账号；本轮复用已有互动记录服务，在下载瞬间只读一次。以后若调整记录来源，仍必须保持“用户动作触发的一次读取”边界，禁止借排查功能新增常驻轮询。
- 好友互动对象还带 `visitorGid` 和 `avatarUrl`，排查虽需要昵称，但不需要这些身份/地址字段；构造器只选用 `nick` 和已经格式化的 `actionDetail`，禁止直接序列化整个 record。通用外发日志的昵称删除规则也不得因此放宽。
- Node 20 专用日志定向测试 **6/6**、全量 `core/test/*.test.js` **298/298**、自己收获/好友到点偷菜/重点 HOT-PREARM/请求治理等核心组合 **89/89** 通过；本轮相关后端 ESLint **0 error**，Dashboard ESLint **0 error**（仅既有 8 条 UnoCSS 顺序 warning），前端生产构建通过（仍有既有图标提示）。本轮没有修改收菜、偷菜、重点用户施肥监控、熔断/降速、登录保活、设备协议或 TSDK/ACE。
- 回滚用 `git revert <本轮提交>`，随后只在已存在的 `farm:0.0` 执行 `scripts/apply-evolution.sh`；不得另开 tmux，也不得因日志导出回滚或收紧当前收益策略。

## 重点好友施肥识别延迟收紧（2026-08-25）

### 证据、根因与改动

- 匿名核对最近 12 小时运行日志，未发现 `Enter`、`AllLands` 或 `GetAll` 被治理器拦截，说明当前识别慢不是 HOT 后被请求层阻断。代码中的确定延迟来自 HOT 前基线：重点好友进入观察窗口后仍要等 2–4 分钟；若上一次巡田发生在窗口外，已挂的 5–8 分钟定时器还不会在窗口入口重排，最坏会额外睡过窗口边界。异常降速若同时生效，还会再叠加约 90–135 秒。
- `nextWatchlistPollDelayMs()` 现在保持窗口外/未知/无作物 5–8 分钟不变，进入 `watchlistWakeBeforeMinutes`（默认 122 分钟）后只对该重点目标切为 **45–75 秒高斯抖动**。窗口外排程取“5–8 分钟随机值”和“距离窗口入口”的较小值，因此会自动在入口切档；临近成熟仍截断到 60 秒 PREARM 边界。
- `watchlistPollTick()` 把“已知成熟墙钟已经进入重点观察窗口”从普通异常降速的附加等待中剥离：窗口内不再额外加 90–135 秒；窗口外、未知或无作物仍会被普通降速放慢。通信层 60 秒总预算、单接口预算、自己成熟前 10 秒通道预留都没删除，观察窗口本身仍不调用 `setWatchMode()`；只有实际读到成熟时刻提前、施肥次数下降或 `is_nudged` 上升后才进入原有 HOT 放宽。
- 施肥证据阈值和 HOT 状态机没有盲目改动：重点摘要提前仍为 1–5 秒阈值、地块成熟提前仍为 10 秒，首次 HOT 0.4–0.8 秒、后续 0.7–1.2 秒、连续 12 秒无新证据退出、最长 45 秒。普通好友摘要/进门频率、普通偷菜到点时钟和自己收获逻辑完全不变。

### 踩坑、验证与回滚

- 只把常量从 2–4 分钟改小不够：窗口外已经挂好的 5–8 分钟 timeout 会跨过入口，必须在计算下一次延迟时显式截断到窗口边界。反过来，也不能把所有重点好友从未知状态开始就改成 45–75 秒，否则对方没作物或成熟还很远时会制造无收益 Enter。
- 观察窗口内不再叠加普通降速，不等于放宽通信硬预算，更不能提前调用治理器 `watchMode`。以后若继续提速，必须先看匿名化实际识别延迟和 60 秒请求画像；不得把 45–75 秒扩散到普通好友或窗口外，也不得恢复全好友 3–30 秒扫描。
- Node 20 化肥/调度/治理定向测试 **79/79**、HANDOFF 要求的核心收益组合 **90/90**、全量 `core/test/*.test.js` **299/299** 通过；相关后端 ESLint **0 error**。本轮没有前端代码，无需重建前端。
- 回滚用 `git revert <本轮提交>`，然后只在既有 `farm:0.0` 重启。回滚时不能连带撤销自己收获保护、普通偷菜按成熟点唤醒、HOT/PREARM 不受整号熔断影响等既有策略。

## 自动进化短期运行问题闭环（2026-08-26）

### 现场确认与本轮改动

- 通过已登录管理接口读取运行中调度器，确认 `activity_evolver/daily_evolution` 确实存在并在北京时间 00:00-01:00 窗口触发；本轮开始时 safety 已实际由默认 Codex 执行并以 `no_change` 收口，随后 activity 因人工工作区出现未提交文件而按既有保护进入 `deferred`。所以“没有自动进化”的根因是面板缺少下一次执行时间，不是定时器被删除。
- 新增 `evolution-issue-inbox.js`：多 Worker 与主进程共用一个 ignored、`0600` 的本机收件箱，写入前用短锁和原子替换避免并发破坏；只接受固定白名单类型，不接受 `daily-events.message`、账号 ID 或任意上下文字段。当前采集普通降速、自己的收获/务农/种植失败、被踢、多次重连失败、Code 刷新失败和微信长凭据保活失败；本轮冷启动实际发生的凭据失效可因此留给下一轮 safety，而不会复制具体错误或账号。
- safety 启动时快照待处理问题并把固定类别、次数、UTC 时间注入 Prompt，同时强制写明“只是线索、必须看本机日志验证、允许不改、不得恢复整号熔断或放慢收益链”。面板状态接口从真实 scheduler registry 读取最近任务时间，不重新随机计算一个假时间；活动中心顶部和活动分析弹窗都展示调度存在性及待复盘数量。
- 清理是按快照确认而不是清空整个文件：Agent 无改动正常完成时立即删除该批；有提交时等用户应用且新进程把 `applying` 收口为 `applied` 后删除；执行失败、中止、推送/隐私拦截及拒绝重做不删除。同类问题若在 Agent 启动后再次发生，只扣除旧批次数，新事件继续留给下一轮；无论状态如何，物理文件最长保留 72 小时。

### 踩坑、注意点、验证与回滚

- 不能把现有今日事件的 `message` 直接拼给 Agent：其中可能含好友名、错误详情、协议方法或网络地址，通用脱敏也无法保证理解所有未来文案。本轮刻意只以白名单 `type` 映射固定说明；后续新增类别必须先写固定匿名语义，不能为了“上下文更多”透传原文。
- 不能在 Agent 退出即删除所有记录：产生提交不代表代码已在运行，拒绝也不代表问题已解决。确认边界必须保持 `no_change` 或“应用后新进程启动”；批次之外的新发生记录不能被旧提交误删。
- 该文件由多个账号 Worker 写，普通 read-modify-write 会互相覆盖；锁竞争时宁可漏掉一条摘要也不能阻塞收获/偷菜主流程。收件箱是辅助线索，真实证据始终是短期运行日志。
- Node 20 收件箱/事件/进化定向测试 **32/32**、核心收益与设备/登录组合 **90/90**、全量 `core/test/*.test.js` **306/306** 通过；相关后端 ESLint **0 error**，前端生产构建通过。前端 ESLint **0 error**，仍有该历史组件既有的格式/UnoCSS warning；本轮新增区块已按修复建议格式化。
- 本轮没有修改收菜、偷菜、重点用户施肥 HOT/PREARM、请求治理预算/降速、Code 保活、设备协议或 TSDK/ACE。回滚用 `git revert <本轮提交>`，随后只在既有 `farm:0.0` 重启；ignored 的收件箱即使留在本机也无人读取并会自然过期，禁止为清理它递归删除 `core/data`。

## 微信登录长凭据跨日续期（2026-08-26）

### 现场证据与根因

- 匿名回看连续 3 天日志，长凭据保活白天持续成功，失效都集中在北京时间零点后第一轮。凌晨静默期间主进程定时器仍在运行，所以根因不是“静默把保活停了”。
- 旧实现把“每 25–35 分钟检查是否快到期”写成了“每 25–35 分钟真实请求刷新”，连续 3 天累计发生 116 次成功滚动；同时完全没有保存服务端返回的 `expires_in/expires_at`，进程重启后又从头猜测。这两点造成过度滚动、无法按真实到期点跨日续期。
- 农场 Code 不是“一天有效的长凭据”：它是建立游戏连接时临时换取、短时且通常一次性的登录材料，连上后由 25 秒 WS 心跳维持。跨日失效的是用于重建 `loginBuffer` 的 OAuth 长凭据，不能用周期换 Code 来“保活”它。

### 本轮改动

- 扫码确认和后台刷新现在都保存腾讯返回的有效秒数、绝对到期时间、最近成功时间及 refresh token 观测时间。这些字段只在 ignored 账号数据中持久化，管理 API 不返回，前端请求也不能注入覆盖。
- `auto-code-refresh.js` 只在真实到期前 35–45 分钟刷新；典型 2 小时凭据会在上次成功后约 75–85 分钟续期一次，不再每半小时真实打接口。旧账号首次升级时因没有有效期元数据，会在 2–8 秒后做唯一一次迁移续期，成功后就进入正常到期排程。
- 临时网络/服务失败改为 5/10/20 分钟上限的受控重试；`40188 invalid scope`、`42007` 等明确失效改为 6–6.5 小时低频复查，避免零点反复打接口。token 已成功滚动但后续 loginBuffer 请求失败时，也会先保存已返回的新 token，不再被旧快照覆盖。
- 在线、被踢等待、异常断线等待三种状态共用主进程长凭据排程。夜间静默、普通巡查降速和 Worker 睡眠都不会暂停它；保活仍不换游戏 Code、不重启 Worker，不会改变被踢接管退避。

### 边界、踩坑、验证与回滚

- 本轮修复不能恢复已经返回 `40188 invalid scope` 的存量授权；部署后需要最后重扫一次，让新凭据带着真实有效期进入新排程。单元测试只能证明调度和持久化边界，下一个北京时间零点后仍需用脱敏日志验证真实服务端行为；不得在验证前宣称永不失效。
- 以后禁止回退成固定 25–35 分钟真实刷新；禁止在每次冷启动、Code 换取或普通巡查时强制刷长凭据；禁止用函数入参中的旧 account 快照覆盖已滚动 token；禁止把静默开关接到主进程保活定时器。
- 日志和自动进化收件箱只能记脱敏类别、有效秒数和 token 是否滚动，不得输出凭据值、OAuth 回调、服务地址、完整错误或运行时身份。
- Node 20 凭据/会话/被踢定向测试 **34/34**、HANDOFF 要求的核心收益与登录组合 **116/116**、`core/test/*.test.js` 全量 **310/310** 通过；本轮相关后端 ESLint **0 error**，无前端改动。
- 本轮没有修改自己收获、普通偷菜到点、重点用户 HOT/PREARM、请求治理、25 秒游戏心跳、设备串或 TSDK/ACE。回滚用 `git revert <本轮提交>`，然后只在既有 `farm:0.0` 重启；注意回滚会恢复过度刷新和每日重扫风险。

## 活动进化“失败/联系管理员”误报（2026-08-26）

### 现场证据与根因

- 匿名核对本机管理会话后确认会话有效，没有被禁用或过期；最新活动进化 Agent 也是正常退出 0，状态为 `no_change`，不是 Agent 执行失败。
- 当时活动扫描报告为 `unavailable`：没有已连接的农场账号，所以无法调用在线活动列表。另一条现场路径是安全巡检已在执行时再点活动进化，后端会正常返回“已有进化任务在执行”。这两种都是可恢复业务状态，不是系统故障。
- 真正的误报位于 Dashboard 全局 Axios 拦截器：它把所有非 401、非 5xx 响应统一弹成“请求失败，请联系管理员”，丢掉了后端已经返回的安全原因。所以用户看到的“联系管理员”与实际进化结果不一致。

### 本轮改动

- `activity-evolver.js` 给手动启动结果增加结构化 `reason`：`busy/blocked/deferred/report_unavailable/no_candidates` 都是“本次未启动”；CLI 缺失等真实启动失败仍为 `missing_cli`。没有在线扫描证据或没有候选活动时不会为了按钮响应白白拉起 Agent。
- `/api/activity/update/evolve` 对上述可恢复状态返回 HTTP 200 + `{ ok: true, started: false, reason, message }`，前端显示黄色提示和真实原因，不再标记“执行失败”。只有 CLI 找不到等真失败才保留 400；Agent 实际非零退出、隐私拦截和 GitHub 推送失败的原有状态机完全不变。
- 全局 API 拦截器对 4xx 优先显示后端返回的原因（删除换行并限制 300 字符），没有原因时才显示状态码，删除没有诊断价值的统一“联系管理员”。手动扫描遇到无在线账号时也改为明确黄色等待提示，不假报“扫描完成”。

### 踩坑、验证与回滚

- 不能把所有 `runEvolutionNow()` 的 `ok:false` 都改成成功；本轮只对白名单的非故障原因返回 `started:false`。`missing_cli`、未知错误和 Agent 真失败必须继续可见，否则会把真问题吞成“无需处理”。
- 活动报告 `unavailable` 时不得用空列表判定活动结束，也不得消费 `handledUnknownIds/handledEndedIds`。连上农场账号后重新扫描即可恢复，不需要联系管理员。安全巡检与活动进化仍共用一个互斥锁，不得为了让按钮可点并发两个 Agent。
- 本轮在自动安全巡检正常以 `no_change` 收口、确认工作区干净后才开始写文件，没有把人工改动混入自动 Agent 提交。Node 20 进化/会话定向测试 **23/23**、HANDOFF 要求的核心收益与登录组合 **117/117**、`core/test/*.test.js` 全量 **311/311** 通过；相关后端与前端 ESLint **0 error**，前端生产构建通过，仍只有既有图标/格式 warning。
- 本轮没有修改收菜、偷菜、重点用户 HOT/PREARM、请求治理、微信凭据续期、25 秒游戏心跳、设备串或 TSDK/ACE。回滚用 `git revert <本轮提交>`，然后只在既有 `farm:0.0` 重启；回滚只会恢复面板误报，不应借机改动业务调度。

## “雨落成诗”新活动漏检（2026-08-26）

### 现场证据与根因

- 在线只读活动列表已经返回“雨落成诗”根节点 `2026070300` 和 5 个子节点，开放时间从 2026-08-26 开始；保存报告却是 `up-to-date` 且 `unknownActivityIds=[]`。这证明不是账号离线、列表缓存或活动尚未下发，而是列表返回后的候选过滤漏报。
- 旧过滤器要求未知 ID 必须大于代码中最大已知 ID。当前已有 `20260818xx`，而本次刚开放的活动使用较小的 `20260703xx`；活动 ID 是内容批次标识，不能当作严格递增的上线时间。日期探针同样无法可靠覆盖这种“旧批次 ID 后开放”活动，在线列表必须作为权威发现源。
- 当天凌晨的活动 Agent 在新活动开放前已经零候选运行并写入 `lastEvolveDate`。旧事件触发先检查“今天是否跑过”，导致当天稍后出现的真实未处理 ID 再次被吞；日期闸门不能替代 `handledUnknownIds/handledEndedIds` 的事件去重。
- 重启时活动监控与账号 Worker 同时启动，旧逻辑立即首扫，曾在账号登录成功前约十余秒写入 `unavailable`，随后要等待正常 30 分钟抖动周期。该竞态会让真实活动发现进一步延迟。

### 本轮修复、边界与踩坑

- 在线和本机辅助发现都改为“服务端/源码中存在且不在已知集合”即为候选，不再比较历史最大 ID；重复节点仍去重，非法 ID 仍丢弃。以后不得恢复 `id > newestKnownId`，也不得把 ID 前八位直接等同实际上线日期。
- 活动事件触发改由未处理集合决定：即使凌晨空跑过，只要后续扫描出现尚未进入 handled 集合的新活动或结束活动，仍会启动一次活动 Agent；完成后继续用 handled 集合防重。`unavailable` 仍绝不能触发 Agent或判定活动结束。
- 冷启动首扫延后 15–25 秒等待 Worker 登录；仍离线时仅每 60–90 秒检查一次连接状态，未连接时不会发活动协议请求。连接成功并完成一次在线扫描后恢复原 30 分钟 ±20% 周期，不能把离线补扫扩展成在线高频轮询。
- 新增回归覆盖“较小 ID 的新活动”“同日凌晨空跑后出现新活动”和“冷启动/离线重试抖动”。本轮只改活动发现与进化调度，没有修改自己收获、好友到点偷菜、重点用户 HOT/PREARM、请求治理、登录保活、设备协议或 TSDK/ACE。
- 验证结果：活动发现/进化定向测试 **30/30**、`core/test/*.test.js` 全量 **314/314** 通过；相关后端与测试 ESLint **0 error**，隐私回归包含在全量测试并在推送前再次执行提交范围审计。回滚用 `git revert <本轮提交>`，随后只能在既有 `farm:0.0` 重启；回滚会恢复新活动漏报和启动竞态，不能用手工写死本次 ID 代替通用发现修复。

- 不要改 TSDK / WASM / ACE / 登录 fingerprint 轮换
- 不要用盯梢节奏去刷所有好友
- 不要把「自己催熟」和「好友盯梢」日志混成一条

## 活动进化巡检（2026-08-26，“雨落成诗”待接入与旧开关停用）

### 在线证据与本轮改动

- 权威在线列表已返回“雨落成诗”根节点 `2026070300` 及子节点 `2026070301`—`2026070305`，活动期为 2026-08-26 至 2026-09-08。现有证据只说明 `2026070301` 带兑换商店结构、`2026070303` 带抽奖结构，以及规则文案描述天气采集瓶、雷雨召唤瓶、使坏天气瓶、气象研究和闪电变异；没有道具 ID、活动操作命令、请求参数、研究阶段字段或成功操作样本。
- **待接入活动：`2026070300`—`2026070305`。** `WeatherBottleUI` 只能确认客户端界面标识，不能据此猜测 `GetGroup` UID 或 `Operate` 命令；`exchangeShop/draw` feature 也只能证明回包含对应结构，不能证明旧活动命令可复用。因此本轮没有向 `activity.js`、管理活动路由或 Worker 添加常量、开关、处理器和每日调用。后续必须先取得完整 `GetGroup` 解码结果及官方成功操作样本，再按实际道具 ID、命令和参数接入。
- 规则只说明现有成长作物可能发生闪电变异，没有出现新种子、植物 ID、果实 ID 或占地信息，所以 `EventPlants.json` 保持不变；不得从活动标题、贴图路径或变异文案推造植物条目。
- 当前在线列表仍确认“千星同明”开放至 2026-08-27，`star_passport_claim/star_record_claim` 继续保留。青梅种子领取和酿造的既有硬截止时间已分别在 2026-08-15、2026-08-16 结束，当前在线列表也不再包含青梅或鹊桥分组；本轮从后端自动化默认值/允许键和前端设置中移除青梅、鹊桥自动化键及鹊桥好友优先名单。
- 因硬门禁止修改 `worker.js`，旧活动分支源码保留作为协议参考；配置规范化不再接受这些键，存量 ignored 配置在下次加载后也无法把它们传给 Worker，所以青梅/鹊桥自动调用分支不可达。活动服务与手动路由没有删除，当前改动不影响仍开放的千星领取，也没有改活动定时器或任何收菜、偷菜、施肥、调度、登录和设备链。

### 踩坑、验证、风险与回滚

- 不能把“新活动出现”直接等同“上一活动全部结束”：本轮按在线 `endTime` 保留仍开放的千星入口，只停用已有明确截止时间且已从权威列表消失的青梅/鹊桥自动化。以后同样要逐分组核对，不能按 ID 大小或新旧标题整批删除。
- 不能只隐藏前端开关而让旧持久值继续触发 Worker；后端允许键必须同步删除，并用回归断言旧键提交后不会出现在账号自动化快照。反过来，本轮也不能为了删除 Worker 内的死分支违反核心文件禁改门。
- 首次前端构建误用了 Node 18，Vite 因运行时能力不足退出；按仓库约束切回 Node 20 后生产构建通过。以后应先确认 Node 20，不能把旧 Node 的工具链失败当成源码回归。
- Node 20 配置定向测试 **6/6**、`core/test/*.test.js` 全量 **315/315** 通过；相关后端和前端 ESLint 均 **0 error**（前端保留历史组件既有 38 条格式/UnoCSS warning），前端类型检查与生产构建通过，仅保留既有图标和字体拉取提示。逐项确认自己成熟 30–80ms 收获、好友到点偷菜、重点 HOT/PREARM、请求治理硬预算、登录保活和设备协议回归均未改回历史错误。
- 本轮不重启 Bot、不推送远端。回滚使用 `git revert <本轮提交>`；如以后需要让回滚配置生效，也只能由用户确认后在既有 `farm:0.0` 应用，禁止另开 tmux 或在窗格外启动。

## 活动 Agent 端到端进化与重新分析（2026-08-26）

### 根因与本轮改动

- 上一轮“雨落成诗”只留下待接入记录，不是 Agent 本身不能改活动，而是输入与权限同时收得过窄：`describeActivity()` 把 payload 截到 500 字，在线快照只留下 `exchangeShop/draw=true` 布尔值，兑换商品、消耗货币、抽奖次数和奖池全部在归一化时丢失；Prompt 还整文件禁止修改 `core/src/core/worker.js`，使新增活动无法接入默认开关与每日例行入口。
- `getActivityGroupSnapshot()` 现在把每个活动节点的随机商店、兑换商店和抽奖信息标准化到 `details`，保留道具 ID/名称/数量、货币、价格、库存/次数和奖池。当前 proto 未声明的玩法不会保存原始响应，而只生成有界的 `protocolShape`：字段路径、wire type、出现次数和字节长度，不含字段值、原始字节、账号、好友或凭据；旧的 raw-body 商店/抽奖扫描结果也会作为只读 fallback 证据提供给 Agent。
- 活动 Prompt 不再只列一行候选摘要，而会注入完整脱敏活动树与道具/玩法证据。活动 Agent 的完成定义改为端到端核对：活动 ID/UID/proto、活动货币与种子/果实/礼包/装扮、各玩法读写边界、后端服务/API、默认开关/每日入口、运行日志，以及 `web/src/views/Activity.vue` 的专属卡片、道具库存、玩法状态和安全按钮。某个写操作尚无成功样本时可以暂缓该按钮，但已有证据支持的道具配置、只读状态和前端 UI 不能跟着全部跳过，也不能只刷 HANDOFF 待办。
- `worker.js` 的禁令改为窄权限：Agent 只能改活动 import、活动默认配置、活动每日任务和对应管理调用段；收菜、偷菜、施肥监控、成熟墙钟、请求调度、登录/Code 保活和设备串仍是硬禁区，相关模块仍整文件禁止修改。官方源码/资源缓存存在时按 `AGENTS.md` 选择最新版完整目录并复制到临时目录分析，禁止直接修改缓存；当前机器没有证据时不得猜测活动 cmd/参数，也不得新增或泄露 API、网址和凭据。
- 面板新增“重新进化当前活动”：只有人工点击才以 `force=1` 忽略 `handledUnknownIds/handledEndedIds`，重新使用当前报告候选；自动扫描仍严格按 handled 集合去重，避免每 30 分钟重复拉 Agent。活动扫描详情同时展示当前已解析的商品/奖池道具，方便人工判断 Agent 获得了哪些证据。

### 踩坑、验证、风险与回滚

- “允许改 `worker.js`”不是解除核心保护。后续 Prompt 或人工改动不得把允许范围扩展到活动段之外；尤其不能顺手调整收获优先级、好友到点偷菜、重点好友 HOT/PREARM、普通异常降速或登录保活。活动请求仍属于非竞速任务，不能挤占成熟点请求通道。
- protobuf 字段形状只能证明“有哪些结构”，不能证明 varint 的业务含义，更不能推导写操作 cmd。后续可以用它补未知字段的只读 proto，再结合官方源码或成功操作样本确认语义；禁止把字段编号相似当成旧活动命令可复用的证据。另一方面，通用 `ExchangeShopInfo/DrawInfo` 已经实际解码出的道具和奖池属于可用证据，不应继续降级成一个 feature 布尔值。
- 人工强制重新进化只绕过活动候选的处理标记，不绕过在线报告可用性、Agent 互斥锁、脏工作区保护、全量测试、隐私闸门、GitHub 推送确认或人工应用重启。没有当前候选时仍不启动 Agent；不得把 `force` 接到定时扫描或每日自动任务。
- Node 20 活动进化/协议形状/请求治理定向测试 **41/41**、`core/test/*.test.js` 全量 **318/318** 通过；相关后端 ESLint **0 error**。前端 Node 20 类型检查与生产构建通过（仅保留既有缺失图标提示），活动分析组件 ESLint **0 error**，仍有该历史组件已有的格式/UnoCSS warning。本轮没有修改收菜、偷菜、重点用户施肥监控、请求治理、登录保活、设备协议或 TSDK/ACE。
- 回滚使用 `git revert <本轮提交>`，然后只在既有 `farm:0.0` 应用；回滚会恢复“已处理活动无法重跑、Agent 看不到道具证据且不能接每日入口”的旧限制。实际新活动适配仍需单独形成进化提交并经用户确认，不能与本基础能力提交混为一次无法独立回滚的修改。

## 活动进化巡检（2026-08-26，“雨落成诗”端到端只读接入）

### 证据、改动与结束活动收口

- 本轮以在线 `ActivityService.List/GetGroup` 脱敏快照为权威证据：根节点 `2026070300`，子节点 `2026070301`—`2026070305`，活动期为 2026-08-26 至 2026-09-08。`2026070301` 的通用 field 102 已解出天气采集瓶（物品 5001，金豆豆 200，当前样本已拥有），`2026070303` 的通用 field 105 已解出免费 4/4、付费 1/10、天气采集瓶单价 1 和物品 5002 的 100% 奖池；field 114/117/118 只保留路径、wire type、次数和字节长度，不保存或展示原始值。
- 新增“雨落成诗”专属只读服务和管理读取接口：按根 ID 使用空活动组 UID 读取已被在线样本证明可用的 `GetGroup`，同时一次读取背包内物品 5001/5002 数量。返回值明确区分 `clientUiUid=WeatherBottleUI` 与尚未证实的活动组 UID，包含活动时间、5 个子节点的 type/状态、兑换商品、抽奖次数、奖池、规则文案、当前 protocolShape 和背包读取失败边界；只读刷新日志只记录活动 ID、启用态和汇总数量，不含账号或原始协议值。
- 活动页默认展示“雨落成诗”专属卡片：显示天气采集瓶和物品 5002 的背包数量、兑换价格/拥有状态、免费与付费剩余次数、奖池概率、全部子节点及已声明/未命名 protobuf 字段状态，并提供只发送读取请求的“刷新只读状态”按钮。没有图片证据时使用本地通用图标，没有向配置或仓库新增资源地址。
- 青梅与鹊桥已从权威在线列表消失且先前已停用配置键。本轮在允许的 `worker.js` 活动每日段中删除其残留死分支和保存后触发条件，并删除活动页鹊桥专属面板/请求；仍开放至 2026-08-27 的千星领取保持不变。鹊桥/青梅服务、proto 和管理解析保留作为历史协议证据，不恢复自动调用。
- 新活动没有任何已证实写命令，所以没有新增默认自动化开关、每日例行入口、兑换/抽奖/天气瓶/研究执行按钮，也没有调用 `ActivityService.Operate`。规则只描述现有作物发生闪电变异，没有新植物、种子、果实 ID 或占地证据，因此 `EventPlants.json` 和植物 `size` 透传均未修改。
- 首次应用后在线扫描仍把 5 个子节点显示成候选，原因是已知活动注册表只会收集导出的 `*_ACTIVITY_ID`，而初版只导出了根 ID、子 ID 仍内联在定义数组。现已给 `2026070301`—`2026070305` 分别建立并导出活动 ID 常量，归一化逻辑复用这些常量；下次扫描应为 `up-to-date`，不能靠 handled 集合掩盖“候选仍未知”的面板假阳性。

### 证据缺口、踩坑、验证与回滚

- 当前机器没有 AGENTS 指定的官方 QQ 小游戏展开源码和 `gamecaches`，所以无法从官方脚本、Prefab 或资源缓存补活动组 UID、图片、field 114/117/118 语义与写请求。以后取得缓存时仍须按 `tsdk.wasm` 修改时间选择最新完整目录并复制到临时目录分析，禁止直接修改缓存；在此之前不能把 `WeatherBottleUI` 当成 GetGroup UID，也不能从旧活动相同字段号推导 cmd。
- 通用 field 102/105 可证明兑换商品和抽奖状态结构，但不能证明兑换或抽奖命令；“付费剩余 9 次”也不等于允许自动消耗 9 个天气采集瓶。未知物品 5002 保持服务端可证实的“物品5002”，不得仅凭规则猜成雷雨召唤瓶。背包读取失败时 UI 明示数量不可用，不能把退化的 0 当成真实库存。
- `protocolShape` 必须继续保持只有字段路径、wire type、次数和字节长度；不要为了“只读解析更完整”把未命名 bytes、字符串或可能的地址值序列化进管理 API、扫描报告、日志或 HANDOFF。未知字段在有官方语义前只显示“已观测/未观测”。
- Node 20 新活动定向测试 **4/4**、`core/test/*.test.js` 串行全量 **322/322** 通过；前端 Node 20 类型检查与生产构建通过，仅保留既有的两个 UnoCSS 缺失图标提示。逐项确认未修改自己成熟前 10 秒预留与 30–80ms Harvest、好友到点偷菜、重点用户 HOT/PREARM、请求治理硬预算/普通降速、登录保活、设备协议、网络及 TSDK/ACE。
- 活动 Agent 只创建本地活动提交，父进程隐私闸门通过后已推送远端并在既有 `farm:0.0` 应用；子节点注册表修正同样经测试、隐私扫描和推送后在该窗格重启，不另开进程。回滚应按提交逆序使用 `git revert <提交>`；回滚活动提交会移除“雨落成诗”专属只读卡片并恢复过期鹊桥活动页/Worker 死分支，但不得借机恢复已停用的青梅/鹊桥配置键或改动核心收益链。

## 活动说明驱动 UI 与已登记活动复核（2026-08-26）

### 本轮改动与证据边界

- 活动说明是玩法名称、参与条件、玩家流程、奖励关系和温馨提示的有效 UI 证据，但**不是**写操作协议证据。后续活动适配必须把说明中的每一种玩法转换为专属信息架构、流程卡片、状态区或醒目提示，不能只原样堆一段长文，也不能用“未知 type / 未命名节点”代替说明已经明确命名的玩法；同时严禁从说明推测 cmd、请求参数或复用旧活动写命令。
- “雨落成诗”只读归一化现在从在线规则生成 5 个有证据的玩法指南：雷雨与闪电变异、好友农场采集天气、自己的农场召唤雷雨、气象研究、好友天气互动，并单独提取限时道具和活动结束后的作物保留提示。每个指南都携带原始规则证据且固定 `operationSupported=false`；没有匹配规则时返回空列表，不能按 protobuf type 猜玩法。
- 活动专属页面按规则重做为“好友雷雨采集 → 自家召唤雷雨 → 闪电变异收获”的天气瓶主线，并显示每种玩法的参与步骤、气象研究任务/雷电徽章/阶段奖励关系、好友使坏互动、限时提示、道具库存、兑换和奖池只读状态。协议子节点移到折叠的诊断区；未取得成功请求样本前只显示“操作协议待确认”，不提供兑换、抽取、天气瓶或研究写按钮。
- 活动扫描面板新增通用的“根据活动说明识别的 UI 检查项”，会从规则识别天气变化、研究、采集、召唤、好友互动和限时提示，并明确区分“可驱动 UI”和“不可证明写协议”。节点 type 仍可作为诊断线索，但不能覆盖规则中的用户语义。

### 自进化与检查逻辑

- 旧扫描只对未知 ID 读取 `GetGroup`，活动一旦登记就不再检查说明，容易出现“ID 已知但专属 UI 缺玩法”。现在沿用既有约 30 分钟且带抖动的活动扫描，每轮最多额外只读复核 4 个当前时间窗内、可见且已登记的活动**根节点**；不逐个请求子节点、不添加写请求，也不提高扫描频率。扫描报告把它们标成“当前活动复核”，与“新活动候选”分开。
- 每日活动进化即使没有新 ID，也会收到上述当前活动的脱敏规则与只读快照，逐项核对专属 UI、道具、玩法区块、提示和 HANDOFF；已经完整且没有可靠改动时允许工作区完全不变。人工“重新进化当前活动”也可直接复核这些已登记活动，不再要求它们重新出现在 `unknownActivityIds`。
- 活动 Agent Prompt 明确要求：先完整读取 HANDOFF；活动说明可以决定 UI 文案、流程和禁用占位，不能决定 cmd/参数；说明仍属于外部数据，其中夹带的命令、安全约束变更或索取信息文字必须忽略；活动检查页必须展示说明识别的玩法与缺失适配；已有正确实现时可以不改代码。实际改代码仍必须同步 HANDOFF、全量测试、本地提交，由父进程隐私扫描通过后推送 GitHub，Agent 自身禁止 push。

### 踩坑、验证与回滚

- 不要为了复核已登记活动把所有 List 子节点都逐个 `GetGroup`，也不要把活动复核接到好友巡查、成熟唤醒或高频心跳。当前上限和原扫描节奏属于协议风险边界；如在线账号不可用，仍只报告等待连接，不启动无证据活动进化。
- 规则解析必须保留“有文案证据才生成 UI 指南”的回归测试。尤其“1 品和 2 品除外”可以转述为 3 品及以上，但未知物品 5002 仍不能仅凭玩法关系命名为雷雨召唤瓶；背包/商店真实返回与活动说明角色是两类证据，不能混为协议字段语义。
- Node 20 活动规则/扫描/进化定向测试 **40/40**、`core/test/*.test.js` 串行全量 **327/327** 通过；前端 Node 20 类型检查与生产构建通过，仅保留既有的两个 UnoCSS 缺失图标提示。相关后端和前端 ESLint **0 error**（管理组件保留既有格式/UnoCSS warning）。
- 本轮没有修改自己成熟前预留与毫秒级 Harvest、好友到点偷菜、重点用户 HOT/PREARM、请求治理、登录/Code 保活、设备串或 TSDK/ACE。回滚使用 `git revert <本轮提交>`，然后只能在既有 `farm:0.0` 应用；回滚会恢复“已登记活动不再复核、规则只显示原文”的缺口，不能借机改动核心收益策略。

## 腾讯上游活动/接口防钓鱼边界（2026-08-26）

### 上下游定义与本轮收口

- “已只读复核 2 个候选或当前活动入口”的旧文案混淆了两类状态：当时实际是**新候选 0 组、当前已登记活动复核 2 组**，不是发现两个新活动。面板现已分别显示“本次新活动候选组”和“当前已登记活动复核”，活动根中只要含未知子节点也会正确归入候选组。
- 腾讯游戏服务是上游，管理 API/网页是下游。用户频繁打开或刷新下游页面本身不是封号风险，但每次刷新都穿透成腾讯协议请求就是风险。雨落成诗只读状态按账号缓存 60 秒且合并并发请求；活动更新手动扫描复用最近 120 秒的可用报告且合并正在执行的扫描。`unavailable`/离线报告不进入新鲜缓存，账号重新连接后可立即重新扫描；缓存只在内存保存标准化活动状态，不记录或返回账号凭据。
- 已删除按当前日期、相邻编号轮换枚举未发布活动 ID 的 `GetGroup` 兜底。活动发现现在只信 `ActivityService.List` 已实际下发的节点，并把未知子节点归并到其 List 中可追溯的根活动，只对根调用一次正常 `GetGroup`；禁止逐个试探子节点、未发布 ID 或未知 cmd。List 仍是发现源，不得因删除枚举而重新恢复“ID 必须大于历史最大 ID”的旧错误过滤。
- 当前活动复核继续沿用约 30 分钟带抖动的既有扫描，每轮最多 4 个当前、可见、已登记根活动；本轮没有提高自动扫描频率。管理面板会明确提示“未发布 ID 主动探测已关闭”和下游缓存时间。

### 自动进化与每日安全 Agent 硬约束

- 活动 ID/接口/字段可见、List 下发、回包成功或 bot 自己试调成功，都不能单独证明写操作安全。新增活动写操作至少同时具备两份独立证据：**当前官方客户端正常 UI 可达的调用路径**，以及**该官方客户端自然操作产生的成功请求样本与触发条件**。不得拿线上账号主动试探，也不得因旧活动字段相似而复用命令。
- 活动 Agent 必须把“只读 UI 适配”和“腾讯上游操作接入”分开：说明、商店和奖池证据足够时照常完成下游 UI；写协议证据不足时固定保持只读。Agent 禁止按日期/相邻 ID 枚举、逐个请求子节点、试探未知 cmd/字段或添加未知错误重试。
- 每日安全 Agent 的第一项固定审计是活动协议及其他接口的钓鱼/风控探针风险：检查未下发 ID 枚举、官方 UI 不可达接口、单一证据接入写操作、下游刷新穿透上游、异常错误码诱导重试和返回结构突变。可安全确认的风险应最小化收口为“只信官方 List/自然流量证据、未知错误停手、下游读取缓存复用”；拿不准时只匿名记录风险，不得在线试验新接口。
- 这些约束已放入活动与安全进化共用的历史回归硬门，并在安全 Prompt 中作为“每日必审第一条”。没有可靠风险证据、现有逻辑已经安全时，Agent 仍允许代码和 HANDOFF 完全不改；禁止为了每天产生提交而虚构钓鱼风险。

### 验证、踩坑与回滚

- 不要把“防钓鱼”实现成阻断所有活动读取或整号熔断。`ActivityService.List` 和 List 中根活动的正常只读详情仍可按低频缓存获取；保护对象是猜测性发现、写操作、盲目重试和下游放大，不得影响自己到点收获、好友到点偷菜或重点用户 HOT/PREARM。
- 不要仅在前端禁用按钮；上游缓存、并发合并和禁止枚举必须在后端生效。反过来，下游页面刷新不需要人为做成长时间静默，只要它不穿透上游即可。
- Node 20 上游缓存/活动发现/进化约束定向测试 **45/45**、`core/test/*.test.js` 串行全量 **331/331** 通过；前端 Node 20 类型检查与生产构建通过，仅保留既有的两个 UnoCSS 缺失图标提示。相关后端和前端 ESLint **0 error**，未提交差异隐私扫描 **0 命中**；提交范围隐私审计仍是推送前硬门。
- 本轮没有修改收菜、偷菜、重点用户施肥监控、请求治理预算、登录/Code 保活、设备串或 TSDK/ACE。回滚使用 `git revert <本轮提交>`，然后只在既有 `farm:0.0` 应用；回滚会恢复未发布 ID 枚举和下游请求直穿腾讯上游的风险，不能借机改动核心收益链。

## 活动进化巡检（2026-08-26，“心许千灯星垂野”说明 UI 与只读缓存收口）

### 证据、复核结论与本轮改动

- 本轮以在线 `ActivityService.List/GetGroup` 脱敏快照为权威证据复核两个已登记根活动。`2026070300`“雨落成诗”的天气瓶主线、气象研究、好友互动、限时提示、道具数量、兑换与奖池只读区已经覆盖完整，且仍无新植物 ID、种子/果实或占地证据，因此不改 `EventPlants.json`，不新增任何活动写操作。
- `2026072700`“心许千灯星垂野”仍在在线结束时间前；子节点 `2026072701` 的说明明确了“二十八星宿逐日开放、每日投放奖励、查看事件/奖励/可领取状态、一键领取全部已解锁奖励”，以及“活动结束后不再开放新奖励、只在当前游记周期生效、不跨活动继承、超出补领范围无法补领”。活动服务现在把这些说明标准化为两个流程区块和醒目的周期/补领边界；观星礼录专属卡片同时展示活动时间、开放/领取数量、根/子节点状态及 protobuf field 110/102 诊断信息。
- 活动扫描面板新增千星说明识别项，分别显示“星宿轮转与每日馈赠”“星宿状态与一键领取流程”“游记周期与补领边界”。它们只驱动信息架构与提示，不证明任何 cmd 或请求参数；没有说明文本时归一化结果保持为空，不能按 type 13 或字段 110 猜玩法。
- 旧的千星状态刷新在每次下游页面读取时直接穿透上游，并用一次 `Operate` 打开商店。现在先用 `List` 确认当前根/子节点，再按说明下发的 `SAIJI_MEGA_EVENT` UID 调正常 `GetGroup` 读取星宿和兑换商店；删除只为读取商店而发送的 `Operate`。`/api/activity/star` 按账号缓存 60 秒并合并并发读取，现有领取、兑换、游记和节令写操作完成后清除缓存；清除还会隔离旧的在途读取，避免它在写操作后重新覆盖新状态。
- 本轮没有新增或修改领取、兑换等写命令，也没有根据说明开放新按钮。已有观星领取与星砂兑换链保持原行为；规则归一化固定标记 `operationSupported=false`/`writeOperationsDerivedFromRules=false`，防止以后把 UI 文案误当协议证据。千星自动领取入口仍在活动期内，保持不变；已结束的青梅/鹊桥自动入口和专属 UI 继续维持停用状态。
- 当前机器没有 AGENTS 指定的 macOS QQ 小游戏展开源码与 `gamecaches`，无法补官方资源图片或新的自然操作样本；本轮没有新增资源地址、未知字段、写操作或植物配置。以后取得缓存时仍须按 `tsdk.wasm` 修改时间选最新完整目录并复制到临时目录分析，禁止直接修改 QQ 缓存。

### 踩坑、验证、风险边界与回滚

- 下游缓存清除不能只删除已完成值：如果旧 `GetGroup` 仍在途中，它可能在写操作之后重新写回旧状态。当前缓存同时解除对应在途引用，并只允许仍是当前请求的 Promise 落缓存；以后调整通用活动缓存时必须保留这一竞态边界。
- `List` 下发和 `GetGroup` 成功只证明只读路径；payload 中出现“一键领取”也只证明官方 UI 流程，不能据此发现或复用写命令。新增写操作仍必须同时具备当前官方客户端可达路径与该客户端自然操作的成功请求样本，bot 试调成功不算证据。
- 首次前端构建又命中系统 Node 18，Vite 因缺少运行时能力失败；切换仓库要求的 Node 20.20.2 后类型检查和生产构建通过，仅保留既有两个 UnoCSS 图标提示。不得把 Node 18 的工具链失败当成源码回归。
- Node 20 千星/雨落成诗定向测试 **11/11**、`core/test/*.test.js` 全量 **335/335** 通过；前端 Node 20 类型检查与生产构建通过。本轮逐项确认没有修改自己成熟前 10 秒预留与 30–80ms Harvest、好友到点偷菜、重点用户 HOT/PREARM、普通异常降速与通信硬预算、登录保活、设备协议、网络、TSDK/ACE 或 `worker.js` 活动以外区域。
- 回滚使用 `git revert <本轮提交>`；回滚会恢复观星说明缺失、扫描面板不识别千星玩法和下游刷新直穿上游/读取商店触发 `Operate` 的旧行为。若以后应用回滚，也只能在用户已有的 `farm:0.0` 完成；本轮 Agent 不重启 Bot、不推送远端。

## 安全巡检记录（2026-09-07，访客记录未知 RPC 试探收口）

### 证据与逻辑闭环复核

- 最近 24 小时本机只有 5 条结构化运行日志；「请求超时」「发送失败」「被踢下线」「请求被治理器拦截」均为 0，服务端业务错误、未知推送、版本自动更新和到点收获实跑样本也均为 0。样本量太低，不能据此收紧请求治理、成熟重试或登录接管。
- 客户端配置仍为 `1.13.0.5_20260723`，本窗口无服务端版本变更日志；实际加载的 `tsdk-v3.9.0.wasm` SHA-256 与 `tsdk-ace-runtime.md` 完整基线一致。两个账号的持久设备串均已启用、非空且互不重复（只核对结果，未输出值）。当前机器没有 AGENTS 指定的 macOS 官方源码/资源缓存，因此无法宣称客户端版本已与当日官方版本比对；不自行新增上游地址。已配置的无凭据 Git remote 与本地 HEAD 一致。
- 逐行复核 `worker.js` 的 `runFarmTick/runStealTick/armStealWake`，以及 `farming-orchestrator.js` 的 `checkFarm/runFarmOperation/harvestOwnAtMaturity/getNextMatureInMs`：完整快照会发布独立绝对成熟墙钟，guard 到点不先发 `AllLands` 而直接收缓存地块，失败保留 due 并分档重试，成功后按本次目标移除旧时钟并续接多季墙钟。本轮无“成熟了却没收”的日志或可复现状态漏洞，故不改调度和收获链。
- 活动发现仍只读 `List` 下发的根活动，不按日期/相邻编号枚举；未知推送只有界记录且不响应/不重试。本轮唯一确定的铓鱼面是 `interact.js` 显式维护 4 组候选 service/method，遇到超时或发送失败会切换下一组；代码和 proto 都没有其余 3 组路由的官方自然流量证据。

### 本次收口、踩坑与回滚

- 访客记录现在每轮最多只请求历史主路由 1 次；任何错误立即停手，不再改猜其他 service/method。本轮没有用线上账号验证该路由，也不把“历史主路由”宣称为当前官方证据；以后变更它必须先有当前官方客户端自然流量样本，不得因某个错误码尝试候选路由。
- 读取成功后在每账号 Worker 内缓存 60 秒，同时到达的下游请求共用一个在途 Promise；读取失败后同样冷却 60 秒，防止页面刷新将异常放大成上游请求。这不新增定时器、写操作、接口、字段或重试。
- 踩坑：只在服务端返回业务错误码时停止不够；假超时/假发送失败正可以诱导旧代码继续试探。并发合并也必须覆盖失败窗口，否则快速刷新仍会串行重发。
- 新增回归锁定“首次未知错误后不调用其他 RPC”和“并发/一分钟内复用本地结果”。到点收获、好友到点偷菜、重点 HOT/PREARM 和治理器定向组合 **69/69** 通过；`cd core && node --test test/*.test.js` 全量 **337/337** 通过。当前机器只有 Node `v18.20.8`，未找到 Node 20，所以上述结果不得写成“Node 20 已验证”；本轮变更没有使用 Node 18 失败来误判源码。
- 逐项确认本轮未修改 `worker.js`、自己成熟前 10 秒预留与 30–80ms Harvest、好友到点偷菜、重点用户 HOT/PREARM、请求治理硬预算/普通降速、登录保活、设备协议或 TSDK/ACE。回滚使用 `git revert <本轮提交>`；回滚会恢复 4 路由试探和下游重复读取放大风险，不得借回滚改动核心收益链。本轮 Agent 不重启 Bot、不推送远端。

### 风险待处理（证据不足，本轮不改）

| 项 | 证据/风险 | 不修理由与后续边界 |
|---|---|---|
| 历史已结束活动只读端点 | 仍有历史管理 GET 可直接进入上游，但当前专属页面已删除且 24 小时无调用/错误证据 | 没有运行放大证据，且旧活动协议整体已过期，不为巡检扩大改动；若重新暴露入口，先禁用或加后端缓存/并发合并，不试调旧写命令 |
| 治理器核心方法豁免匹配较宽 | 当前用方法名字符串匹配 `Harvest/Steal`，理论上可命中未来同名方法；本窗口治理拦截和未知 RPC 均为 0 | 修改请求治理必须先有真实日志问题并补齐三条核心收益回归；在没有命中证据前不收紧，更不把它改成 Enter 或整号 cooldown |
| 官方客户端版本时效性 | 本地配置与近日日志无漂移，但本机无官方 macOS 展开源码/缓存可核对当日版本 | 不猜版本、不新增地址、不用线上账号做协议发现；待取得 AGENTS 指定的官方缓存后按 runbook 进行只读快照比较 |

## 活动进化巡检（2026-09-07，停用已结束千星活动入口）

### 证据与本轮改动

- 已有在线证据和活动回归夹具都确认根活动 `2026072700`“心许千灯星垂野”结束于 2026-08-27；本轮日期已超过结束时间，但账号默认配置、设置页和 Worker 仍保留千星游记/观星礼录自动领取，并会在登录后 10 秒及每 5 分钟检查。这是确定的过期活动入口，不需要通过线上账号再次试调。
- 已从账号默认配置及前端设置模型、默认方案、活动控制区删除 `star_passport_claim` / `star_record_claim`。后端允许键由默认配置生成，所以 ignored 的存量配置在下次规范化时也不会再把旧键下发给 Worker。
- 已在 `worker.js` 仅删除千星活动自动领取函数、登录后定时器、配置保存后触发和停止清理调用；没有改该文件中的农场、好友、成熟墙钟、请求调度、登录、Code 保活或设备链路。
- 活动中心不再请求或展示已过期的千星游记、观星礼录、星砂兑换商店、节令小札及千星主题头图；当前仍保留 `2026070300`“雨落成诗”的完整只读玩法卡片，以及管理员活动扫描/自动进化入口。
- `activity.js` 中的千星 List/GetGroup 只读归一化、说明解析、proto 字段和既有管理服务继续保留为历史协议证据；活动扫描仍能用既有说明识别千星玩法。本轮不新增、不修改也不试调任何写命令。

### 证据缺口、踩坑、验证与回滚

- 本轮活动报告状态为 `unavailable`，原因是没有已连接账号；当前机器也没有 AGENTS 指定的官方 macOS 小游戏展开源码与 `gamecaches`。因此本轮不能宣称发现新活动，也没有新增活动 ID、UID、道具、图片、植物或 protobuf 字段；`EventPlants.json` 保持不变。“雨落成诗”已有说明驱动 UI 与只读道具/商店/奖池覆盖，仍缺成功自然操作样本，所以继续不提供写按钮。
- 删除 Worker 千星块后，一条每日例行静态测试仍用旧“活动自动控制”注释作为切片终点，首次全量测试因此把文件后部的手动 `runDailyRoutines(true)` 误算进启动定时器。现已把测试边界改到紧邻的神秘商人函数；这只修正测试定位，手动每日任务入口和启动时 `runDailyRoutines(false)` 均未改变。
- Node 20 活动定向测试 **12/12**、`cd core && node --test test/*.test.js` 全量 **338/338** 通过；`cd web && npm run build` 通过，仅保留既有两个 UnoCSS 缺失图标提示。回归逐项确认：自己成熟前 10 秒预留与到点 30–80ms Harvest、好友到点 `onlySteal` 与 80–300ms 唤醒、重点用户 HOT/PREARM、普通异常降速与通信硬预算均未被改动。
- 旧千星/荷风/青梅管理服务仍是历史兼容入口，但已无活动页或自动任务触发；本轮没有运行放大证据，不扩大到删除历史协议服务。以后若重新暴露专属页面，应先按已结束活动处理，不得重新启用旧写操作或拿旧协议推测新活动。
- 回滚使用 `git revert <本轮提交>`；回滚会恢复已结束千星的自动开关、5 分钟检查和过期专属页面，不能借机修改核心收益链。若以后应用或回滚，也只能在用户已有的 `farm:0.0` 窗格完成；本轮 Agent 不重启 Bot、不推送远端。

## 自动进化增量记忆、失联收口与旧活动接口退役（2026-09-07）

### 卡住根因与恢复闭环

- 本轮现场状态长期停在 `running`，但 Agent 日志已经完成测试并创建本地活动提交。根因不是 Agent 仍在分析，而是 Bot 主进程在 Agent 运行中重启：Agent 以 detached 子进程运行且只靠旧父进程内存中的 `exit` 监听收口，新父进程无法收到孤儿进程的退出事件，所以隐私扫描、推送和状态迁移均未发生。旧版“两小时后把 running 改失败”的兜底只能解除状态锁，无法安全接管已生成的提交；若随后直接启动新 Agent，还可能把前一轮未审提交夹在错误审计范围中。
- 每轮启动现在把脱敏 `activeRun` 写入 ignored 状态：只含任务类型、执行器、PID/启动时间、基线提交、日志文件位置、活动候选 ID、每日跟进标记和证据哈希，不保存 Prompt、日志正文、账号、接口原文、URL 或凭据。新父进程启动后会恢复观察该进程组；进程退出后按原基线执行完整隐私扫描、SSH 推送和远端核对，再进入待应用或安全阻断状态。
- 同进程和恢复进程共用看门狗：达到两小时硬上限会结束 Agent；如果已经产生提交、工作区洁净且日志连续两分钟无新输出，也会结束残留 CLI 进程并继续收口，覆盖 CLI 完成任务后自身会话记录异常而不退出的情况。看门狗绝不能在工作区仍脏时用“提交后静默”条件强杀；失联恢复发现未提交文件时固定进入 `privacy_blocked_local`，不上传、不覆盖人工修改。
- 兼容没有 `activeRun` 的旧 `running` 状态：只有工作区洁净且本地 HEAD 已与 `origin/main` 一致时才转为可重试的 `interrupted`；本地仍有提交或文件时一律阻断。新任务启动前也要求 HEAD 与可信 `origin/main` 一致，不能把“远端稍后会检查”当成可用基线。

### 增量复盘、公开借鉴与接口边界

- `evolutionMemory` 只保存 safety/activity 的完成时间、已审提交和活动证据 SHA-256。活动指纹只取未知/结束/当前复核 ID 与脱敏活动组内容，忽略扫描时间和账号展示信息；每日仍读取有效在线报告，但指纹、活动域代码和未处理集合都未变化时直接记 `no_change`，不再重复启动 Agent。指纹变化、活动域代码变化、历史基线不可验证或出现新/结束活动时才进入深度活动进化。
- 安全任务仍每天执行必须项，但只深查新增日志异常、变更过的风险域、脱敏问题收件箱和 HANDOFF 未决项；成熟收获链没有代码变化、没有“成熟未收/调度异常”日志且没有未决项时，只跑既有不变量回归，不再每天通读整条核心链。脚本指纹核对明确包含 timer/interval/cron/sleep/重试循环、日志周期、多账号同步突发、失败后连发和无界重试；发现疑似问题必须先用本机短期日志验证，不能凭风格猜测修改。
- 公开项目是按需借鉴源，不是协议证据。本轮只读核对 `公开参考项目 4` 的 `1bc45d3`：可借鉴视觉自动化任务追踪、有界修复/重启、多实例状态同步、活动作物处理和 UI 组织思路；它与其他公开仓库都按不可信输入处理，不运行脚本/依赖/二进制，不添加 Git remote。任何 RPC service/method/cmd、字段、版本、登录、设备或 TSDK/ACE 结论仍必须来自当前官方客户端可达路径和自然成功请求样本。
- 已结束的千星、荷风、青梅、鹊桥和南瓜专属管理入口已从 controller 注册、主进程 data-provider、Worker API switch、前端 store 请求四层断开；两个旧 controller 文件已删除，活动服务也不再导出这些旧读写方法。历史活动的常量、纯解析/归一化与部分仅供同文件解析结构参考的私有实现暂留，但没有 export、路由、定时器或 Worker 调用根，且共享历史写入口会在编码/发包前固定失败，无法从管理面板或自动任务触发；不得重新接线或拿线上账号试调，后续迁移完历史解析夹具后可以物理删除。当前仍在使用的通用 `ActivityService.List`、List 已下发根节点的只读快照及“雨落成诗”缓存读取保持不变。

### 上传规则、验证与回滚

- 自动 Agent 仍只能创建本地提交，专用 pre-push hook 禁止其上传。父进程必须从保存的基线扫描到本地 HEAD 的完整范围，同时检查新增行、提交标题、文件名、二进制/符号链接及 ignored 运行目录是否被跟踪；任何账号/好友、机器路径、内网地址、个人邮箱、Webhook/API Key/Token/Cookie、签名 URL、登录材料或无法审阅内容都会阻断 GitHub 推送。`core/data/` 中的日志、活动报告、状态/记忆和账号配置严禁强制加入 Git。
- 本轮只修改活动域与自动进化编排，没有修改自己的成熟墙钟/30–80ms Harvest、好友到点偷菜、重点用户 HOT/PREARM、请求治理硬预算、登录/Code 保活、设备串、网络、TSDK/ACE 或活动扫描的上游频率。Node 20 定向回归 **54/54**、`cd core && node --test test/*.test.js` 全量 **340/340** 通过；相关后端、测试和前端 store ESLint **0 error**，前端类型检查与生产构建通过，仅保留既有两个 UnoCSS 缺失图标提示。提交范围隐私审计必须在最终提交后另行执行，不能用测试内的模拟审计替代。
- 回滚应按提交逆序执行 `git revert <提交>`，然后只在既有 `farm:0.0` 应用。回滚自动进化提交会恢复主进程重启后永久 `running`、重复全量复盘和不安全审计基线风险；回滚前一轮活动提交会恢复已结束千星入口；回滚旧接口退役会重新暴露过期上游调用链，因此不得只为兼容旧页面恢复 controller/data-provider/Worker 任一层。

## 活动进化巡检（2026-09-07，“公益小红花”只读端到端接入）

### 在线证据与本轮改动

- 本轮以在线 `ActivityService.List/GetGroup` 脱敏快照和本机 ignored 活动报告为权威证据：根节点 `2026090900`、type 19 子节点 `2026090901`，活动期为 2026-09-01 至 2026-09-09；子节点 payload 的客户端 UI 标识为 `CharityRedFlower`，当前样本根/子节点均 `enabled=false/status=0`。field 116 只保留字段路径、wire type、次数和长度，未声明其业务语义。
- 新增“公益小红花”专属只读归一化与活动页卡片。活动说明被拆为“每日任务/分享领种子 → 种植收获小红花 → 获得并捐赠爱心值 → 用户送出公益金”四段流程；奖励区分别展示每日公益礼包、个人爱心值档位奖励和全服公益结算礼包，并完整列出说明已确认的化肥、点券、金豆豆与活动头像框数量。
- 小红花种子、小红花果实和爱心值只展示说明确认的名称与用途；当前证据没有道具 ID、图片、库存、爱心值进度、任务次数、奖励领取态、植物 ID 或占地大小，因此 UI 明确显示“待官方证据”，不会把缺失值伪装成 0，也不改 `EventPlants.json`。以后取得植物 ID 时必须按 AGENTS 再核实 `size`，四格作物必须显式 `size: 2` 并补配置透传测试。
- 活动规则明确要求用户确认公益平台授权和账号数据对接，并禁止机器人、爬虫、刷奖软件或其他自动方式参与。后端没有新增 `Operate`、cmd、请求字段、自动开关或每日例行；领取公益礼包、捐赠爱心值和送出公益金只作为禁用的官方客户端人工操作占位。没有把说明中的授权地址写入代码、页面、日志或 HANDOFF。
- 专属读取先调用 List 确认当前根节点确已下发，随后才以空活动组 UID 读取该根的正常 GetGroup；payload UID 只标记为客户端 UI 标识，不能冒充 GetGroup UID。管理 controller、主进程 data-provider、Worker API switch 和前端 store 已接通只读状态，成功、并发和失败读取均按账号复用 60 秒本地缓存，避免页面刷新放大腾讯上游请求。
- 活动扫描面板会从说明识别上述四段流程、三类奖励、公益金限制、授权边界和禁止自动参与提示，并把 type 19 子节点命名为“公益小红花玩法节点”，不再只显示候选 ID 或无语义 type。根/子节点常量均已导出，后续扫描会把两者视为已登记活动。
- 同期复核的 `2026070300`“雨落成诗”仍保留既有天气瓶主线、气象研究、好友互动、限时提示、道具/兑换/奖池只读区；在线说明与现有实现一致，本轮没有改它的玩法、请求或专属 UI。当前机器没有 AGENTS 指定的 macOS 官方小游戏展开源码与 `gamecaches`，因此没有补图片、植物配置、field 116 语义或写操作。

### 踩坑、验证、风险边界与回滚

- 奖励名称和数量不能只因活动标题或 type 19 存在就生成；当前实现要求说明同时出现对应礼包条件和奖励文本。移除说明的回归夹具会得到空流程、空奖励和空资源，但仍只保留 field 116 不透明诊断，防止以后把字段形状误当业务语义。
- 下游失败也必须缓存。若只合并并发成功请求，腾讯上游的一次超时或业务错误会被连续刷新串行放大；当前通用活动只读缓存会在 60 秒内复用同一失败，过期后才允许重新读取。该变化只影响活动管理读取，不进入农场、好友或成熟竞速调度。
- 首次 Node 20 全量测试在并行压力下有一条未改动的微信长凭据 60ms 定时断言偶发失败；该测试单独复跑 8/8 通过，未修改登录模块或测试，随后同一 Node 20 全量 **346/346** 通过。活动/扫描定向回归 **19/19** 通过；前端 Node 20 类型检查与生产构建通过，仅保留既有两个 UnoCSS 缺失图标提示。相关后端与前端 lint 均 **0 error**。
- 逐项确认本轮没有修改自己成熟前 10 秒预留与到点 30–80ms Harvest、好友到点偷菜、重点用户 HOT/PREARM、普通异常降速与通信硬预算、登录/Code 保活、设备串、网络或 TSDK/ACE；`worker.js` 仅新增活动管理读取 switch。
- 活动结束并经在线证据确认后，应删除专属 UI 与前端 store 请求，并在 controller 注册、data-provider 转发和 Worker API switch 三层断开读取链；不能只隐藏卡片保留可达上游请求。回滚本轮使用 `git revert <本轮提交>`；回滚会移除本次只读适配和失败缓存，不得借机修改核心收益链。若以后应用或回滚，也只能在用户已有的 `farm:0.0` 窗格完成；本轮 Agent 不重启 Bot、不推送远端。

## 活动植物 ID 补全与活动执行边界（2026-09-07）

### 在线证据与本轮修复

- 活动首次接入只检查了 `ActivityService.List/GetGroup`，因此虽能从说明确认“小红花种子/果实”，却把资源 `itemId` 留成 `null`，也没有补 `EventPlants.json`。本轮对当前在线农场做一次只读核对：匿名样本的 24 块独立土地均返回同一 `plant_id=1020883`，界面因配置缺失显示“植物1020883”且 `seedId=0`；每块土地的占地集合只有自身，确认它是单格作物，不是 2x2。
- 结合当前活动说明中的“小红花种子/小红花果实”和现有普通作物的植物/种子/果实编号关系，补齐 `plant_id=1020883`、`seed_id=20883`、`fruit_id=40883`、`asset_name=Crop_883`、`size=1`。重启后“我的农场”会显示“小红花”，土地数据会返回活动种子 ID `20883`；活动资源卡同时显示种子 `20883` 和果实 `40883`。
- 当前证据仍没有小红花专属图片、生长阶段时长、库存、爱心值 ID、任务进度和领取状态，所以不伪造图片、不填写 `grow_phases`，也不把缺失数量展示成 0。协议成熟判断继续使用服务端土地阶段，不改自己的成熟墙钟与 Harvest 链。
- “雨落成诗”页面原来的“操作协议待确认，当前不提供执行按钮”容易让人误以为只差打开一个开关。现在页面直接说明：目前只能在官方 QQ 农场活动页人工使用天气瓶、推进研究或抽取；只有取得**当前官方客户端自然成功操作样本**、确认活动仍允许操作并补齐命令/参数/次数限制/失败边界后，才可能提供面板按钮，禁止用线上账号试探未知写接口。
- “公益小红花”规则明确禁止机器人或其他自动方式参与，因此即使以后拿到写协议样本，Bot 也不能代执行领取、领奖、捐赠或送出公益金；页面改为明确的官方客户端人工参与说明。普通农场已有的收获行为不等于活动领取/捐赠写操作，不得借种子映射重新接入活动 `Operate`。

### 踩坑、后续硬门、验证与回滚

- **植物 ID 不是种子 ID**：土地回包的 `1020883` 只能作为植物 ID；必须通过配置/背包/收获等证据建立 `plant_id → seed_id → fruit_id`，不能把 `1020883` 直接塞进种植请求或活动种子卡。后续新活动说明出现种子时，活动 Agent 必须同时复核当前土地和背包，不能只看活动树后留下“植物 ID 裸显示 / seedId=0”。这条已写入自动进化 Prompt 并加回归断言。
- **占地大小不能靠默认值掩盖证据缺口**：本轮由 24 块独立土地确认 `size=1` 后仍显式写入；若未来出现主从四格土地，必须按 AGENTS 写 `size: 2`，并断言 `getPlantBySeedId(seedId).size === 2`。不能因为分析器默认回退 1 就宣称作物是单格。
- **说明文本和 protobuf 字段形状都不能开放写按钮**：说明只证明玩法和人工步骤，field 116 或只读商店/奖池结构也不能证明 `cmd` 与请求参数。Bot 自己试调成功仍不算官方自然样本；遇到规则明确禁止自动参与的活动，则写操作永久保持禁用。
- Node 22 活动植物/公益/天气/进化提示定向回归 **57/57** 通过，相关后端 ESLint **0 error**，活动前端 ESLint **0 error**；前端生产构建通过。首次与前端构建并行的核心全量测试在未修改的长凭据短定时断言上偶发失败，相关模块单独复跑 **8/8** 后，无并行负载的核心全量 **347/347** 通过；没有为此修改登录代码或放宽断言。
- 逐项确认本轮没有修改自己成熟前 10 秒预留与到点 30–80ms Harvest、好友到点偷菜、重点用户 HOT/PREARM、普通异常降速与通信硬预算、登录/Code 保活、设备串、网络或 TSDK/ACE。回滚使用 `git revert <本轮提交>`，会重新出现小红花裸植物 ID、活动种子 ID 缺失和不清楚的只读提示；应用或回滚仍只能复用既有 `farm:0.0`。

## 安全巡检记录（2026-09-08，结束活动只读入口再校验 List）

### 证据、审计结论与本轮改动

- 最近 72 小时 `combined-*.log` 共解析 1978 条、JSON 解析失败 0 条；请求超时、发送失败、治理器拦截和旧 `cooldown` 日志均为 0。未知推送风险共 38 条、仅记录 12 类净化类型且未触发解码、响应或重试；属于已有证据观察，不据此新增接口。
- 运行问题收件箱中的登录线索已回看：4 次 Code 失败集中在约 23 秒内，错误语义为授权范围失效；随后约 8 分钟后成功取 Code 并恢复。一次服务端下线在数百毫秒内挂载离线凭据保活、约 15 秒后成功重连。它们均属已知授权失效/外部终端冲突路径，没有未知错误码或重试风暴证据，因此不收紧登录接管、长凭据或业务调度。
- 到点保护收获日志 48 条全部 `result=ok`，没有成熟未收或调度异常；本轮没有修改 `worker.js`、`farming-orchestrator.js`、好友偷菜、重点 HOT/PREARM、请求治理、登录保活、设备串、网络或 TSDK/ACE。活动扫描报告在结束前最后一次为在线且无未知/结束候选；当前没有官方展开源码或资源缓存可供版本比对。
- 每日协议可达清单复核确认历史活动 controller、data-provider、Worker API 和前端请求均已断开，历史写实现仍由统一退役闸门在发包前拒绝；活动发现继续只信在线 `List` 根节点，不枚举日期/相邻 ID。雨落成诗原只读入口仍会直接对固定根 ID 请求 `GetGroup`，活动结束后仍可能由页面 GET 触发，这是确定的旧活动只读可达路径。
- 最小收口：`getWeatherActivity()` 现在先读取 `ActivityService.List`，仅当雨落成诗根节点当前由 List 下发时才使用空 UID 读取 `GetGroup`；未下发立即停止，不触发详情或背包上游请求。为测试注入读取器，不改变默认活动请求、写操作或核心收益链。

### 验证、边界与回滚

- 新增天气活动回归：List 缺少根节点时不发送 GetGroup；List 下发根节点时只使用空 UID。定向安全与收益组合 Node 20 **113/113** 通过；`cd core && node --test test/*.test.js`（Node 22.22.2）全量 **349/349** 通过。
- 这次 List 校验只保护活动只读入口；管理层 60 秒成功/失败缓存与并发合并仍保留，页面刷新不会放大腾讯请求。它不阻断自己成熟前 10 秒预留与 30–80ms Harvest、好友到点偷菜、重点 HOT/PREARM、心跳、登录或 ACE。
- 踩坑与后续注意：活动结束时间不能单凭本地旧报告判断，必须以当次在线 List 为准；不能为了校验而逐个探测子节点或恢复未知 ID 枚举。若活动被官方延长，List 下发即可继续只读；若再次消失，入口自动停手。以后新增活动只读入口必须同时保留 List 根校验、空 UID/已证实 UID 边界和失败缓存。
- 回滚使用 `git revert <本轮提交>`，随后仅在用户已有的 `farm:0.0` 应用；回滚会恢复固定根 GetGroup 在活动结束后仍可触发的旧路径，不得借机修改收菜、偷菜、施肥监控或请求治理。

### 风险待处理（本轮无安全证据自动修复）

| 项 | 证据/风险 | 不修理由与后续边界 |
|---|---|---|
| 治理器 `Harvest/Steal` 字符串豁免较宽 | 近 72 小时治理拦截为 0，核心方法未出现误匹配日志 | 修改需真实命中证据并补三条核心收益回归；当前不收紧、不引入 Enter 或整号 cooldown |
| 官方客户端当日版本无法用 AGENTS 指定缓存核对 | 本机无 macOS QQ 小游戏展开源码与 `gamecaches` | 不猜版本、不新增地址；取得缓存后按 `tsdk.wasm` 修改时间只读比对 |
| 历史活动解析私有函数保留候选 UID | 旧活动函数未导出、无 controller/data-provider/Worker 调用根，写操作有统一退役闸门 | 无运行放大证据不扩散删除；不得重新接线或拿线上账号试调 |

## 活动进化巡检（2026-09-10，S3 萌宠只读适配与旧活动退役）

### 在线证据与本轮改动

- 权威证据为本轮在线快照与 ignored 活动报告：根节点 `2026090100`，成长玩法 `2026090101`（type 18）、游记奖励记录 `2026090102`（type 13）、商城 `2026090103`（type 3）；起止时间使用下发的 `1789005600` / `1791820799`，当前根/子节点均可见但 `enabled=false/status=0`。`SEASON_BEAR_CAMPAIGN` 和奖励节点的 `SAIJI_MEGA_EVENT` 只作为客户端界面标识；专属读取先验证当次 List 根节点，再以空 UID 读取该根 GetGroup，不逐个探测子节点。
- 新增 S3 专属只读服务、管理 controller、data-provider、Worker 活动读取 switch、前端 store 与活动卡片。说明拆成 11 类玩法：领养投喂、看护变异、成年寻宝、宝藏护送、好友夺宝、骰子胜负与安慰礼、爪印手记、锦囊选择刷新、游记商城、幸运星排名、每日稀有种子礼包；同时展示参与条件、挑战书三档收益、每日次数上限、免费/付费刷新及赛季结束后的回收和结算规则。扫描面板同步识别这些玩法和缺失适配，并读取 `tips/tips1/tips2`，忽略图片对象和标签属性。
- 8 类资源分别展示名称、用途与库存证据边界。商城全部 13 项商品保留道具 ID、价格、拥有标记和原始状态码；一次背包读取按已知道具 ID 汇总库存，失败保持未知。新增 `EventItems.json` 只补幸运星 `1029`、9 件比熊乐园装饰及金币果/经验蘑菇种子的名称，不推断类型、图片、可使用/出售属性或种植映射。幸运星名称由该商城唯一兑换货币与说明中的兑换关系交叉确认；商城状态 50/100/130 等没有 S3 次数语义证据，不能套用旧活动“可兑换”判断。
- 本轮通过现有管理读取核对当前土地和背包：账号 A 的 24 块土地为已正确映射的普通单格作物，没有裸植物 ID 或 `seedId=0`；背包没有可建立 S3 植物、种子、果实和占地映射的新证据。元气糕、挑战书、待护送宝藏、礼包和稀有种子的 ID/图片仍未知，不根据未知背包道具的出现时间猜名称，不改 `EventPlants.json`。商城已知种子名称不等于植物映射；以后取得新植物证据仍须核对土地/背包和 `size`，四格必须显式 `size: 2`。
- field 102 沿用已声明商城解析；field 110 沿用现有 proto，仅新增安全的奖励记录标准化，不透传 graph、extra 或原始字节。配置和状态取 ID 并集，避免丢掉没有配置的奖励；只有配置但没有状态的记录，其解锁/领取态保持未知。field 115 只保留路径、wire、次数和长度，未解释业务字段；不能把 type 13/field 110 直接认定为爪印手记，更不能复用旧赛季领取命令。
- 页面明确列出 5 处说明差异：玩法/商城的护送初始总额 350/400、保底 50/100；每日锦囊 2/3 个；寻宝挑战书必定/随机产出；变异售价四倍/产量四倍；夺宝资金等于挑战书价值时的边界未说明清楚。流程卡采用玩法节点说明并显示差异，不能据此认定真实状态、计算自动收益或开放操作。
- 当前机器无 AGENTS 指定的 macOS 官方展开源码、gamecaches，也未找到本机自然操作抓包。缺少官方当前可达调用路径与自然成功写请求双证据，因此不新增写操作、自动开关、每日例行或排名探测；所有操作占位禁用并标明“操作协议待确认”。只读日志仅记录活动 ID、玩法/商品数量和库存可用性，不复制身份或协议正文。
- 最新有效在线 List 仅下发 S3；已超过原结束时间的雨落成诗和公益小红花均不在列表中。删除它们的专属组件、前端请求、controller 文件和注册、data-provider、Worker switch 及服务读取导出，保留纯解析、proto 和脱敏历史夹具。共享只读缓存移至独立模块，60 秒成功/失败缓存、并发合并和在途清除语义保持不变；通用 List 与已下发根节点快照读取不受影响。

### 踩坑、验证、风险边界与回滚

- 管理总路由注册会启动扫描及进化定时器，不能在单元测试中直接调用真实注册函数。首轮新增测试误触该副作用，断言结束后仍未退出，并将本机扫描报告覆盖为离线状态；已停止本轮测试进程，移除该调用，用隔离的 S3 路由行为测试和总接线断言替代，并通过现有只读扫描恢复有效在线报告。没有启动、停止或重启 Bot；后续测试禁止误挂生产扫描任务。
- 未知数值不能被背包失败的零值或 protobuf 默认值掩盖；仅确实读取成功且 ID 已知时，背包缺项才显示 0。前端切换账号会清状态并递增请求代次，旧响应不能回填；读取失败或活动不再下发也清除旧卡片，避免继续展示上一份可用状态。
- Node 20 活动/配置定向 **28/28** 通过。默认并行全量首轮触发一条新 UI 断言的换行问题及既有登录保活 60ms 定时断言偶发失败：UI 断言已修正，登录模块和断言均未修改；相关定向复跑通过。随后 `node --test --test-concurrency=1 test/*.test.js` 串行全量 **350/350** 通过；前端 `npm run build` 的类型检查和生产构建通过。后端相关 lint 无 error，前端新增组件/store 无 error；历史文件保留原有格式提示，不为 lint 扩大差异。
- 逐项确认：自己成熟前 10 秒预留及到点 30–80ms Harvest、好友到点偷菜及有界重试、重点 HOT/PREARM、普通降速与通信硬预算、明确免打扰、登录/Code 保活、设备串、网络和 TSDK/ACE 均未修改；Worker 活动块之外逐字保持原样。历史活动写操作退役闸门未改，新活动没有上游写调用。
- 回滚使用 `git revert <本轮提交>`；回滚会移除 S3 只读卡片/名称补丁，并恢复两个已结束活动入口，因此不得只为兼容旧页面单独恢复旧调用链。若以后应用或回滚，只能复用既有 `farm:0.0`。本轮仅创建本地活动提交，不重启、不推送；父进程仍须对可信基线到 HEAD 的完整范围、新增行、提交说明及文件名执行隐私扫描后再决定推送。

## 活动种子、贴图与好友时间复盘硬门（2026-09-11）

### 本轮发现与修复边界

- 土地 `PlantInfo.id` 不能固定当作植物 ID：部分活动/新作物回包会使用种子 ID。土地、好友土地和生长阶段解析现在先按植物 ID、再按种子 ID做双向解析；已登记活动作物的名称、占地和阶段贴图会继续使用官方本地资源，未知作物优先使用服务端名称，不能再显示“植物<ID>”。
- 活动商城明确命名为“……种子”的道具会进入运行时种子索引。背包详情、`/api/bag/seeds`、背包优先种植策略和种植日志共用这套索引；活动扫描/活动页面读到新道具名称后会即时注册，下一轮后台扫描会再次建立，不依赖手工刷新页面。
- 贴图解析顺序固定为：精确种子/资产 ID → 已导出的官方阶段图 → 按官方资源文件名中的作物名称匹配 → 游戏通用种子阶段贴图。缺少官方专属资源时只能明确回退到通用贴图，不能伪造活动图片或把数字 ID当作图片名称。
- 好友摘要缺少 `ripe_time_sec` 时，不能把 0 当成“没有成熟”，也不能用自己的农场时钟冒充好友时钟。已从好友地块 `phases` 读到的精确成熟墙钟会保留，不会被后续缺字段摘要覆盖；好友列表会区分已知摘要时间、已读地块时间和“尚未读取”。普通好友仍只按现有低频发现/进门证据更新，禁止为了让面板看起来完整而恢复全好友高频 Enter。
- README 的源码和 Docker 示例必须使用仓库真实地址并能从全新目录复现；克隆目录名、`pnpm`/Node 版本、前端构建、Docker 持久化目录和健康检查改动后要一起验证。

### 每日 Agent 巡检清单

- 从最近活动报告、背包和土地脱敏状态中找出所有活动种子/未知道具 ID；逐项确认名称、种子索引、植物 ID、果实 ID、占地大小、阶段图和前端展示是否闭环。
- 搜索日志中的“植物<ID>”“种子<ID>”“物品<ID>”、`seedId=0`、空 `plantImage`、背包优先漏种和活动种子回退；发现后先区分“服务端没有证据”与“代码丢失已有证据”，前者记录待证，后者补最小映射和回归测试。
- 检查好友偷菜面板的主值是否仍混淆下一次调度、已知成熟墙钟和未知状态；核对摘要缺 `ripe_time_sec` 后是否覆盖了 `fertilizer-watch` 的地块墙钟。
- 只有当前官方回包、土地/背包证据或仓库已导出的官方资源能证明的映射才可写入配置；没有专属贴图证据时保留通用贴图回退并在 HANDOFF 记录，不猜资源 URL。
- 本轮验证：Node 20 串行核心全量 **356/356** 通过；前端 Node 20 类型检查和生产构建通过，仅保留既有两个 UnoCSS 缺失图标提示。系统 Node 18 运行 Vite 会报运行时版本错误，不能把该环境错误当成代码回归。

### 回归与回滚

- 相关回归必须覆盖：服务端用 seed ID 回包仍显示活动作物名称和阶段图；活动商城种子进入背包优先列表；未知活动作物不显示裸 ID；缺少 `ripe_time_sec` 的好友摘要不覆盖已读地块成熟点；普通好友频率和自己收获/好友到点偷菜/HOT/PREARM 不被改变。
- 回滚使用 `git revert <本轮提交>`；不得单独回滚种子双向映射、好友时间保护或通用贴图回退而恢复裸 ID/错误时钟。应用或回滚仍只允许复用用户已有的 `farm:0.0` pane。

## S3 背包种子与活动商品图标早期尝试（已纠错，2026-09-11）

- 该次提交曾凭编号段与奖励数量把 20516 命名为元气糕、29004 命名为元气糕种子；这些推断没有配置依据，后续已证实错误，不能沿用。
- 曾使用其他装扮和收获手势图顶替活动专属图；后续已撤销。HTTP 200 只证明图片可访问，不证明图片属于该物品。
- 当时的测试只断言人为填写的名字和默认 size=1，因此测试通过也没有证明映射正确。今后要用独立客户端 ItemInfo/Plant 证据作对照，检查语义和占地。

## 背包种子全量识别与官方图标抓取管道（2026-09-11）

### 用户裁定与本轮根因

- **背包种子白名单设计已废弃（用户 2026-09-11 明确指示）**：旧 `plantFromBagSeeds()` 在优先列表非空时只种列表内种子，列表外的背包种子既不显示也不种（2026-08-23 曾把它标为“设计（列表即白名单）”）。背包回包 `corepb.Item` 只有 id/count/uid，识别全靠本地索引，白名单叠加索引缺口后新活动种子（如 29004 萌宠元气糕种子）直接消失。丢弃不是解决方案：**优先列表只决定顺序，全部背包种子都要识别、都可种**。
- 三个丢种子环节：①种植白名单（主根因，见上）；②前端自动把新种子补进优先列表只在用户打开设置页时执行，后台种植从不消费它；③ `getBagSeedsFromItems()` 对本地索引完全没有条目的未知物品静默 continue，连日志都没有。
- **跨物品顶替图是错误方案（用户同日裁定）**：上一轮给 S3 装饰商品（比熊小屋/街道/狗窝/木牌/仓库/栅栏/围栏/头像框/铭牌）和元气糕 20516 用了**别的道具**的官方图当“类别回退”。图标必须是真的官方专属图。

### 本轮修复

1. **种植不再丢弃任何种子**：`planting-service.js` `plantFromBagSeeds()` 删除 `customPrioritySeeds` 过滤分支，种植集=全部可用 1x1 背包种子，`sortBagSeedsForPlanting()` 的优先列表内排前/列表外按等级→ID 兜底排序真正生效；成功日志新增 `plantedSeedIds`/`outsidePrioritySeedIds` 审计字段。2x2 路径本就传全部 plantSize===2 种子，未改。此处旧版曾允许无映射种子按单格试种，现已修正：未知占地返回 0，待配置或既有自然土地证据确认后才进入对应种植路径；不得拿生产种子试验大小。
2. **未知物品不再静默**：`warehouse.js` `getBagSeedsFromItems()` 对本地索引无条目的背包物品记 `bag_unclassified_item` 日志（只记脱敏 item id/count，按 id 去重，上限 20/次）；已知果实/化肥/货币等非种子物品不记避免刷屏。每日巡检按该日志补 `EventItems.json` 映射（EventPlants 仍需土地证据，禁止猜测）。
3. **面板全量可见**：`BagSeedPriorityPanel.vue` 分两组渲染——优先列表有序组 + “未加入优先列表的背包种子”组（含「加入优先」「全部加入优先」按钮）；`useStrategySettings.ts` 新增 `unplannedBagSeeds` computed 与 `addBagSeedToPriority/addAllBagSeedsToPriority`；`DefaultPlanSettingsTab.vue` 同步。前端“迁移自动补列表”逻辑保留（只影响顺序显示，后端种植已不依赖它）。
4. **删除跨物品顶替图**：`gameConfig.js` `staticItemImageMap` 删除 201010/207010/205009/202009/206009/203010/208010/2161/401005/20516 的替代行（`EventItems.json` 里 20516 的 image 字段同删）；保留 29004/20522/20523 的**官方通用种子图**（`common/seed.png`，官方类别资产，语义诚实）并新增导出 `getGenericFallbackItemIds()`——这个集合非空=仍有图标缺口，是自进化闭环的可度量信号。缺图商品前端只显示名称（`v-if="item.image"` 优雅降级），不用别的道具图冒充。
5. **官方 CDN 地址发现机制**：`capture/mitm-proxy.js` 的 MITM 与明文 HTTP 请求头解析处新增 `recordResourceUrl()`——GET 且 path 匹配资源样式（png/jpg/webp/gif/astc/json/plist/atlas 或 import//native//config. 标记）时，把 `https://{host}{path}`（剥 query）经 `capture/resource-url-recorder.js`（去重、上限 2000、debounce 2s 落盘、0600）写入 ignored 的 `core/data/capture/resource-urls.json`。只记 URL 不存响应体，记录器异常静默绝不影响抓包转发/登录 code/GID 提取；`capture/index.js` 创建单例并在 stop 时同步 flush。
6. **官方图标抓取脚本**：`core/scripts/fetch-official-icons.js`（`npm run fetch:official-icons`）——Wanted=活动报告中带 `extra.res` 的道具；URL 池=①抓包记录 ②macOS gamecaches（不存在跳过）③`--cdn-base`/`FARM_RESOURCE_CDN_BASE`/ignored `private-config.json` 的 `resourceCdnBase`；解析复用 extract-plant-phase-images 的官方模式（bundle config → decodeUuid → import spriteFrame JSON 拿 texture uuid+rect → native ASTC/PNG → astcenc 解码 → ffmpeg 按 rect 裁剪），输出 `seed_images_named/{itemId}_{name}.png`（自动进 seedImageMap 索引，重启生效）。无 URL 证据时打印缺证据清单、退出码 0、零网络请求。
7. **自进化硬门接线**：`activity-evolver.js` guardrails 第 10 条扩展——图标闭环必须区分「官方专属图」与「通用回退」；`getGenericFallbackItemIds()` 非空或存在空图时必须运行 `cd core && npm run fetch:official-icons`；**抓到的 PNG 属于新增二进制，绝对禁止 git add**（父进程隐私扫描对新增二进制整笔阻断，夹带会连累同轮代码提交被丢弃），PNG 留工作区、总结写明“已抓取待人工提交”；人工提交图标后下一轮才可删对应回退行；任何情况不得用其他道具图片顶替。附 `bag_unclassified_item` 当日复盘硬门与“背包种植不是白名单，不得改回”约束；活动 prompt 任务段同步。

### 抓取管道首次使用（需要用户配合一次）

1. 下次需要抓包登录时，按现有流程开抓包会话；**登录后让游戏开着并进一下活动页/商城**，官方资源 URL 会自动记录到 `core/data/capture/resource-urls.json`（会上限 2000 条，足够）。
2. 之后随时 `cd core && npm run fetch:official-icons`（或 `--dry-run` 先看清单）。
3. 抓到的 PNG 落在 `core/src/gameConfig/seed_images_named/`：**人工审查内容后手动 `git add` 提交**（确认不是敏感内容；这些是官方公开资源）。自动进化 agent 碰到也会留着等你。
4. 提交后重启 bot 生效；下一轮自进化会删掉 `getGenericFallbackItemIds()` 里已补专属图的回退行。

### 踩坑与注意点

- `planting-service.js` 顶部解构 `sendMsgAsync`：测试 mock 必须在 `require` 服务**之前**注入 require.cache（`bag-seed-recognition.test.js` 有完整示例），事后替换无效。
- recorder 的 `stop()` 必须在置 `stopped=true` 之后仍执行最终 flush（首轮实现 `flush()` 里查 `stopped` 导致 stop 后永不落盘，已修并有回归）。
- “未知物品”日志只对本地索引无条目的物品生效：背包里正常存在的果实/化肥/金币都是已知非种子，全记会刷屏。
- 专属图必须优先于通用回退；getGenericFallbackItemIds() 现在按是否存在精确图动态返回，不能让静态回退遮住已下载图片。
- 20516 的替代图有两个来源（staticItemImageMap + EventItems.json 的 image 字段），只删一处会漏。

### 验证与回滚

- Node 20 串行核心全量 **376/376** 通过（其中一次并行运行的长凭据 60ms 定时断言偶发失败为 HANDOFF 既有已知项，单独复跑通过）；新增 `bag-seed-recognition` 4 条、`fetch-official-icons` 9 条、`capture-resource-url-recorder` 4 条，扩展 `game-config-supplement`/`season-bear-activity`/`session-lifecycle` 断言。
- Node 20 前端 `vue-tsc -b && vite build` 通过；改动文件 ESLint 0 error（仅保留既有 warning）。
- 本轮无 PNG 可提交（本机 Linux 无 gamecaches、无抓包 URL 证据，首次真实抓图由下次抓包会话触发，属预期）。
- 回滚 `git revert <本轮提交>` 后重启：会恢复种植白名单、静默丢弃、跨物品顶替图；不得只回滚一半（删了顶替图又回滚种植识别会让缺口更大）。收菜/偷菜/盯梢/登录/设备/请求治理链路本轮未触碰。

## 背包未知道具观察器的错误结论（已纠错，2026-09-11）

- a97faff/e860053 曾把未提取到名称统一记录成 no_show_field，并在交接中称为“确定性否定证据”。这是错误：现存原始 Bag 样本的 1027/5005/25995 均携带非空 field 100，101604 携带空 field 100；里面主要是出售条件或价格，没有已核实的名称字段。
- 原手写 varint 最多读到 56 位，不能完整跳过负 expire_time 的十字节编码；还只接受 Buffer，会漏掉 Uint8Array。现在使用 protobuf Reader，区分无字段、空字段、有字段但无已核实名称和畸形回包。
- 原“最长中文文本就是物品名称”的启发式已删除：出售条件、说明和玩家名也可以是中文。未经 schema 核实的字符串绝不能自动登记为种子。
- 旧观察器的人造测试用 field 1/2 填中文名字，只能证明测试自己构造的数据可读，不能证明真实服务端字段语义。新回归使用现场相同的 field 100 结构和十字节有效期，覆盖 Buffer/Uint8Array、空/缺失/畸形和文本误判。

## 种子识别证据纠错与每日审计（2026-09-11）

### 本轮纠正的实际漏种与证据

| 物品 ID | 正确名称 | 植物 / 果实 ID | 占地 | 旧错误 |
|---|---|---|---|---|
| 20516 | 狗尾草种子 | 1020516 / 40516 | 1×1 | 被错误登记为萌宠元气糕、按果实过滤，背包有 56 个也不种 |
| 25995 | 芦苇种子 | 1025995 / 45995 | 1×1 | 索引没有条目，背包 30 个被过滤 |
| 29004 | 泡泡棉花糖种子 | 1029004 / 49004 | 2×2 | 名称错误且默认单格，无法进入四格预留 |
| 20522 / 20523 | 金币果 / 经验蘑菇种子 | 1020522 / 40522、1020523 / 40523 | 1×1 | 只有物品名，缺植物映射 |
| 1028 | 萌宠元气糕 | 活动额外掉落物 | 不适用 | 被错误关联到 20516 的种子库存 |

- 本机没有官方客户端展开包。为补证据，只读对照了公开客户端配置快照：`公开参考项目 1` 的 `34505ac2ad19f259bca952d4ea369037dd087ecb` 与 `公开参考项目 2` 的 `6cd1e4e9006075448efa74accb088c99a2d055de`。仅使用数据线索，没有执行外部脚本或引入其 RPC、登录和设备实现。公开副本不等于本机最新版官方包，后续取得官方包仍需做版本核对。
- 用户现场确认漏识别的名称就是“芦苇种子”和“狗尾草种子”。两份快照的种子名称、类型、asset_name 和植物映射一致；当前真实 Bag 的三种出售价格分别为 1000/2000/12000，与 ItemInfo 行一致；从资源记录定位到腾讯 CDN 后直接下载五种种子的 PNG，核对 SHA-256 并逐张查看草穗、芦苇、棉花糖、金币果和蘑菇图。原始来源地址/配置快照只留 ignored 的 `core/data/client-config-evidence`；受跟踪的 `event-seed-sources.json` 只保存公开仓库/SHA、逻辑资源路径、文件名与图片哈希，不存私人数据或地址。
- Plant 配置明确给出泡泡棉花糖 `size=2`，其余四种单格；`special_fruit` 明确区分常规果实与 1028 额外掉落。只增补本轮五种植物，未整表覆盖旧配置。种植等级读取 `Plant.land_level_need=1`；不得把 `ItemInfo.level=200` 的展示等级当成“200 级才能种”，否则四格种子仍会被过滤。
- 同时按配置快照和 Bag 的出售条件补齐 1027 雷电徽章、5005 青蛙使坏瓶、101604 公益小红花结算礼包的名称。只补展示元数据，不启用活动使用/出售/领取能力。
- 已删除 season-bear-activity 的重复写死名称表；读活动页不能再把已纠正的种子覆盖回旧名字。背包优先和奖励记录展示专属种子图。通用图只在精确资源缺失时使用，缺专属阶段图仍是未决项，不能因已有种子图就宣称全阶段贴图完成。

### 今后识别新种子的具体方法

1. 从同一次 Bag 取物品列表与种子列表。先查当前 ItemInfo 的 type/interaction_type，再以 Plant.seed_id 精确关联植物、fruit.id、size、land_level_need；不仅查“物品<ID>”，还要查有名字但 type/name 与 Plant 冲突的条目。编号段、数量、礼品出现顺序和活动文案只能形成线索。
2. 有官方展开包时，按 AGENTS 选最新完整版本并复制后只读处理；读取 settings 的 assets.server 与 bundleVers，再按 bundle manifest 的 config/ItemInfo、config/Plant、UUID、import hash 定位配置。支持 JSON 表及同名 Cocos JsonAsset；TextAsset/编码格式不认识时停止并核对客户端读取实现，不能执行外部 game.js，也不能猜 config.index.json 或枚举 CDN 版本。
3. 没有本机包时，可按需读公开客户端配置副本，记录公开仓库与提交 SHA；仍须用当前背包/活动/已有土地证据和直接获取的官方资源核对。多个副本可能来自同源，不能把“两个仓库相同”当成两份独立官方证据。映射证据不足时保持待核实，不把疑似物品试种到生产土地。
4. 运行 `cd core && npm run audit:seed-catalog -- --ids 20516,25995,29004,20522,20523`。默认只读 ignored 的 client-config-evidence/ItemInfo.json 与 Plant.json；新快照可显式传 `--items <文件> --plants <文件>`。输出 aligned / gaps_found / evidence_missing；evidence_missing 不算通过。该脚本只出差异，不覆盖配置。全新复现没有快照时，要从上述证据链取得输入。
5. 合并后验证冷启动背包分类、优先列表排序、活动读取后再次获取背包、四格预留和等级过滤。不能只给错误映射写一条同值断言。新增植物必须补占地回归，未知占地用 0 明示待确认，不走 1×1 或 2×2 自动种植。

### 自进化闭环

- 既有约半小时活动扫描增加一次 Bag 读取；Worker 用同一份回包生成 seedRecognition（仅物品 ID、缺口类别、检查种类数），不保存账号、背包数量或原始正文。覆盖未分类、种子类型/名称冲突、优先列表漏种、未核实占地和缺专属种子图。
- seedRecognition 纳入活动证据指纹及 Prompt；有未决缺口或背包读取不可用时，每日活动复盘不能因为活动 ID/指纹不变而跳过 Agent。gameConfig、EventItems、warehouse、planting-service 等改动也纳入活动域差异判断。
- 每日 Prompt 要求运行配置审计，并明确上述三种种子、元气糕 ID、占地、展示等级与种植门槛的差别，以及 ItemShow 四种状态。缺证据可以暂缓映射，但必须保留缺口，不能把“没有新活动”写成“种子识别全部正常”。
- 本轮五张种子 PNG 已由当前维护会话核对内容/哈希；自动进化进程的二进制推送限制仍保留，后续无人审阅的新图片不能夹带上传。

### 验证与回滚

- Node 20 定向配置/背包/活动/证据解析回归 34/34 通过；串行核心全量 385/385 通过，前端类型检查及生产构建通过。核心改动 ESLint 0 error，仅保留既有 JSDoc warning。
- 线上在既有 farm:0.0 使用 Node 20 重启后，/api/bag/seeds 返回狗尾草 56、芦苇 30、泡泡棉花糖 3，size 分别 1/1/2；打开活动页后再读背包分类仍正确，seedRecognition 对 32 类物品报告零缺口（仅限物品/种子识别，不代表活动玩法或所有贴图完成）。
- 回滚使用对应提交的 git revert，再在既有 farm:0.0 重启。不得重新应用本文件已标注作废的映射或用单格默认值掩盖泡泡棉花糖的四格属性。

## 活动页与好友种子图片统一管道（2026-09-11）

### 这次图标问题的根因

- 活动商品、活动奖励、背包种子和好友土地曾各走一套图片来源：商城用 `getItemImageById`，奖励用活动归一化字段，好友土地用 `getSeedImageBySeedId` / `getPlantImageByPhase`。只补名称或只补种子 PNG 会导致活动页有名无图、好友页仍空图。
- `getItemImageById` 的静态图优先级会遮住精确资源；通用回退也可能让“可访问的图”看起来像“专属图”。HTTP 200、文件名相似或另一件商品的图片都不能证明资源属于目标道具。

### 以后新活动必须按这个顺序处理

1. 先建立统一物品证据：活动商品/奖励 `itemId` → `ItemInfo.type/name/asset_name` → `Plant.seed_id/fruit.id/size`。种子 ID 只能来自物品类型或 Plant.seed_id，不能由名称尾缀、编号段或奖励顺序猜出。
2. 为同一 ID 同时检查三条消费链：活动商城/奖励 `image`、背包 `/api/bag/seeds` 的 `image`、土地和好友土地的 `seedImage + plantImage`。只要任一链为空，就在 seedRecognition/活动复盘中留下缺口；不能只检查活动卡片。
3. 种子图和阶段图分别核验。种子 PNG 进入 `seed_images_named` 后由 ID 精确索引；阶段图必须进入 `plant_images/manifest.json`，覆盖 1（种子通用图）和 2–6 阶段，且 `getPlantImageByPhase` 能按 Plant.asset_name 找到。好友页显示的是阶段图，不会自动使用背包种子图替代成熟期图。
4. 资源只能来自当前官方客户端 `gamecaches`/展开包、抓包记录中的官方资源 URL，或人工审阅并记录 SHA-256 的客户端配置快照。需从 `settings.assets.server + bundleVers` 和 bundle config 的 UUID/import/native hash 定位，不得猜 CDN、枚举版本或把公开仓库代码当协议证据。
5. 目标资源下载后必须人工看图并校验 PNG 签名、SHA-256、逻辑资源路径和目标 ID。跨物品顶替图、通用图、占位图只能明确标记为 fallback，不能写入“专属图已完成”。自动 Agent 禁止把新增 PNG 夹带进代码提交；图片需人工审阅后单独提交。
6. 每日 Agent 运行 `cd core && npm run audit:seed-catalog -- --ids <当天 Bag/活动涉及 ID>`，同时检查 `getGenericFallbackItemIds()`、空 `image`、空 `seedImage`、空 `plantImage` 和 `bag_unclassified_item`。活动证据指纹不变但图片/种子审计仍有缺口时，不能 `no_change` 跳过。

### 本轮补齐

- 已补齐并审核狗尾草、芦苇、泡泡棉花糖、金币果、经验蘑菇的种子 PNG，并将 2–6 阶段图加入 manifest；1 阶段统一使用官方种子阶段图。
- 活动商城装饰图仍要求其各自的 `extra.res` 专属资源；没有对应资源证据时保留空图并显示名称，不能使用房屋/道路/手势等其他图片替代。
- 现有资源接口应在每次新增活动后验证 HTTP 200 只作为“文件能取到”的检查，真正的归属检查使用逻辑路径和 SHA-256；这条要进入自进化的每日报告。

## 施肥误触发与成熟抢收隔离（2026-09-11）

### 线上现象与根因

- 运行日志曾在好友多块泡泡棉花糖/芦苇同时成熟、偷菜和哨兵抢收的同一秒记录 `fertilizer_count_decreased`，随后进入 HOT。这个时间关系说明成熟/收获响应中的施肥计数重置或阶段裁剪被旧逻辑当成施肥；不能因为 HOT 后成功偷到菜就把误触发当成正常识别。
- PREARM 是自然成熟抢收，HOT 是施肥趋势；两者不能共享“成熟时间提前”或“计数变小”的无条件判断。`LandsNotify`/进门返回的 phases 可能只保留剩余阶段，成熟切换时同一个 plant id 仍可能出现。

### 当前判定硬门

- 同一好友、同一地块、同一作物基线才可比较。
- `fertilizer_count_decreased` 只有在前后两次快照都 `growing=true`、前后成熟墙钟都晚于本次观察时间、且 `left_inorc_fert_times` 严格下降时才成立。
- `land_ripe_advanced` 使用相同的“前后仍在生长 + 墙钟在未来”门；成熟/收获切换、阶段被裁到已成熟、重种后旧时钟过期都只能进入 PREARM/普通偷菜收口，不能进入 HOT。
- 保留原有施肥阈值、单目标 HOT 窗口、预算、冷却和 `is_nudged` 新变化规则；没有把普通好友频率调高，也没有修改自己收获、好友到点偷菜或重点 PREARM。

### 自进化每日检查

- 搜索 `化肥趋势触发`、`fertilizer_count_decreased`、`land_ripe_advanced`，逐条对照同一 GID/地块的前后 `growing`、成熟墙钟、作物 ID 和施肥次数；不能只看触发日志本身。
- 若触发时间与 `偷好友菜`、`哨兵抢收`、成熟到点日志重合，优先检查成熟切换误判；只有两次快照仍在生长且计数确实下降才保留 HOT。
- 禁止为压制误触发而删除施肥阈值、关闭 HOT、扩大全好友扫描或把 PREARM 合并进 HOT；修复必须是地块级证据门。

### 验证

- Node 20 施肥/种子/活动定向回归 **26/26** 通过，新增成熟切换计数重置回归；前端构建通过。完整核心测试需在本轮最终代码冻结后再跑。
- 若回滚，使用本轮提交的 `git revert`，随后只在既有 `farm:0.0` 重启；不得恢复成熟切换触发 HOT 的旧逻辑。

## 活动图片索引与施肥误触发收口（2026-09-11 后续）

- 活动商品图片现按各自官方 `extra.res` 逻辑路径登记：S3 兑换项 1–7、头像框和铭牌使用对应客户端资源；不能按“房屋/道路/手势”等类别复用另一物品图片。没有专属资源证据时保持空图并显示名称。
- 种子图和好友土地阶段图现在是同一资源链：五种已核对种子各有精确 ID PNG，`plant_images/manifest.json` 同时登记 1（通用种子阶段）和 2–6 阶段；好友页使用 `plantImage` 阶段图，背包/活动卡使用 `seedImage`/物品图。新增活动必须同时验证这两条 URL 都能 HTTP 200，且 SHA/逻辑 asset_path 与目标 ID 对应。
- `docs/images/` 下的私人微信/支付图片已从仓库删除，README 目录树同步移除，不得重新加入任何私人二维码。
- 施肥 HOT 现在要求两次同地块快照都仍在生长、成熟终点都在当前观察时间之后，并且施肥次数严格下降；成熟/收获阶段裁剪或抢先收菜引起的计数重置、成熟时间前移不会再触发 HOT。PREARM 仍按成熟点独立工作。

本轮新增成熟切换施肥回归；定向施肥/种子/活动回归 60 条全部通过，串行核心全量 386/386 通过，前端构建通过。线上应用仍只允许复用既有 `farm:0.0` 窗格。

- 重启后的 Bag 现场又发现 `1045995`，这是黄金·芦苇（type 17、gold/Crop_5995），不是新种子；已登记展示名称、出售类型和其官方图，避免黄金变异果实继续显示为物品 ID。每日审计要把这类“有名字但 type 不是种子”的活动/变异物品与真正种子分开。

## 活动与安全 Agent 固定职责扩展（2026-09-11）

### 活动 Agent 每日闭环

1. **图标归属**：逐个检查活动商品、奖励、货币、种子、果实、礼包在活动页、背包、自己土地和好友土地的图片字段；种子 PNG 与土地 1–6 阶段图分开核验。必须同时有逻辑资源路径、目标 ID 和 PNG SHA-256；HTTP 200 只能证明文件可访问，不能证明归属。专属图缺失时记录缺口，禁止跨物品顶替。
2. **玩法识别**：从当前 ActivityService.List/GetGroup 和说明文本提取玩法、状态、次数、库存、奖励刷新、活动结束边界；说明只能驱动只读 UI，不能推导 cmd 或写请求。新玩法缺状态时显示待确认并保留每日复核。
3. **种子/物品识别**：同一批 ItemInfo、Plant、Bag、Lands 交叉核对 `type/name/asset_name`、`seed_id/fruit.id/size/land_level_need`；同时检查有名字但类型错误的物品，不只搜裸 ID。未知占地显示待确认，不得用默认单格或生产试种猜测。
4. **旧活动下架**：当前 List 消失或 end_time 已过期后，逐层检查默认开关、每日例行、页面、store、controller、data-provider、Worker switch 和上游读取是否都断开；保留历史纯解析证据即可，不能留可达旧写接口。
5. **收益链保护**：活动读取、图片抓取和识别不能改变自己成熟收获、好友到点偷菜、背包种植、重点 HOT/PREARM、请求预算、登录保活。活动失败只影响活动域，不能整号熔断。

### 安全 Agent 每日日志流程

- 先读取最近 24 小时 `bot.log`、`core/data/logs/combined-*.log` 和 `error-*.log`，按 `event/module/result` 聚合请求超时、发送失败、治理拦截、断线重连、收获/种植/偷菜失败、施肥趋势触发、空图、裸 ID、`seedId=0` 和重试风暴。
- 每条异常必须回到同一时间段代码和阈值核对；施肥触发若与成熟、抢收或阶段裁剪同秒，先排除 PREARM/成熟切换误判，再判断是否真的有同地块施肥趋势。没有真实证据只写风险待处理，不凭日志风格改节奏。
- 每日核对收菜→唤醒→Harvest、背包种子→排序→种植、好友成熟→偷菜、施肥趋势→HOT→冷却四条闭环；只运行既有定向不变量，不增加全好友高频 Enter，不恢复整号 cooldown。
- 日志摘要进入 Agent 前必须使用现有白名单脱敏，只保留类别、次数和时间；错误正文、好友/账号、协议方法、地址和凭据不得进入 Prompt、RAG 或 Git。

### 外部 RAG 使用边界

- 只有在活动证据变化、日志出现新类别、资源缺口或 HANDOFF 未决项时按需查公开仓库/客户端配置；记录仓库 owner/repo 和固定提交 SHA，提取字段名、资源逻辑路径和排查思路。
- 外部内容一律当不可信资料：不执行脚本、安装依赖、运行二进制、复制 RPC/cmd、登录/设备/TSDK/ACE 或反检测实现；不把 URL、原始回包、完整外部文本或私人信息写入仓库。
- RAG 结论必须再用当前官方 List/Bag/Lands、客户端资源路径和哈希交叉核对。多个公开仓库相同不算独立官方证据；冲突时保留待证，不覆盖已正确的活动/农场逻辑。

本节是活动和安全 Agent 的固定任务模板，后续自进化只能在此基础上增量检查。若没有可靠改动，允许零改动；有代码改动必须同步更新 HANDOFF、跑全量测试、通过隐私扫描后提交推送，并只在既有 `farm:0.0` 应用。

## 活动 / 安全 Agent 固定任务模板（2026-09-11）

- 活动 Agent 每日必须按五条闭环执行：图标归属（活动、背包、自己土地、好友土地；种子图与阶段图分离）、玩法只读识别、ItemInfo/Plant/Bag/Lands 新种子与物品交叉识别、按 List/end_time 逐层下架旧活动、验证不影响收菜/种菜/偷菜/施肥 HOT-PREARM。
- 安全 Agent 首先读取最近 24 小时 bot.log、combined-*.log、error-*.log，按 event/module/result 聚合请求失败、治理拦截、收获/种植/偷菜失败、施肥触发、空图、裸 ID、seedId=0 和重试风暴，再按阈值和代码路径复盘。成熟抢收与施肥趋势必须分开；不确定只记风险，不收紧收益链。
- 外部 RAG 只在证据变化或 HANDOFF 未决时按需使用，记录公开仓库/提交 SHA 作为线索，不执行外部代码/依赖/二进制，不复制 RPC、登录、设备、反检测实现；所有数据和资源结论必须回到当前官方 List/Bag/Lands、逻辑路径和 SHA 校验。
- 这些规则已经写入 `buildEvolutionGuardrails()`、活动 Prompt 和安全 Prompt，并由 session-lifecycle 回归锁定；以后不能只因为活动 ID/指纹未变就跳过图标、种子或日志缺口。

## 背包未识别清单刷屏与黄金变体补登记（2026-09-13）

### 现场证据与根因

- 用户面板被 `bag_unclassified_item: 80102,1040516` 刷屏。两个 ID 的身份查明：`1040516 = 黄金·狗尾草`（104 段黄金变异规律，与已登记的 `1045995 黄金·芦苇` 同族同证据——Bag field 100 结构 + 客户端配置快照；当时只补了芦苇一个，狗尾草/泡泡棉花糖两个同族漏了，因为 9/12 起仓库开始收获这两种作物才出现）；`80102` 是 80xxx 化肥段新号（show 字段只有 7 字节数字，无名称文本），**名称无证据，保持待证不猜**。
- 刷屏根因：`bag_unclassified_item` 日志**没有按 ID 去重**——Bag 每个农场 tick 读一次，同一批未知物品每 20 分钟左右刷一条；`bag_item_show_evidence` 有去重（`BAG_SHOW_LOGGED_IDS`）而 unclassified 没有，是 9/11 实现时的疏漏。

### 本轮改动

1. `warehouse.js` `getBagSeedsFromItems()` 的 unclassified 日志改为**清单签名去重**：签名（ID 列表拼接）不变不打；变化时打一条并附 `addedItemIds`（本次新增的 ID）；清单清空后复位签名与已报集合，未来新未知物品可重新报告。
2. `EventItems.json` 按 104 段黄金规律补登记 `1040516 黄金·狗尾草`、`1049004 黄金·泡泡棉花糖`（type 17、asset `gold/Crop_516`、`gold/Crop_9004`、sells 1005:6，与 1045995 完全同模式）。两者无专属官方 PNG（`1045995.png` 是 Codex 从客户端配置快照人工提交的），保持空图由前端显示名称，**不伪造**、不进 genericFallback（那是种子类回退）。
3. `80102` 不登记：化肥段 80001-80014 是 1h/4h/8h/12h 化肥，80102 具体时长/名称无任何本地证据，`bag_item_show_evidence` 线上实测 `empty_show`（无 ItemShow 名称），按硬门待证。

### 验证与回滚

- Node 20 串行全量 **390/390** 通过（bag-seed-recognition 8 条，新增黄金登记断言 + 日志去重行为断言：同签名不打、新增 ID 打一条带 addedItemIds、清空后复位可再报）；ESLint 0 error。并行运行的长凭据 60ms 定时断言偶发失败为 HANDOFF 既有已知项，串行通过。
- 重启后预期：面板 `bag_unclassified_item` 只在 80102 首次出现时打一条，之后静默；1040516/1049004 从未识别清单消失（已登记）。
- 回滚 `git revert <本轮提交>`：恢复刷屏与两个黄金变体的未识别状态；1045995 登记不受影响。

## 挑战书登记与巡检延期收口（2026-09-13 第二轮）

### 安全巡检延期的原因与处理

- 用户面板报"安全巡检已延期：检测到未提交文件（含未跟踪文件）"。根因：`docs/CLAUDE_FROM_CODEX.md`（Codex 交接文档）自 9/11 起一直是 untracked 状态，`worktreeChanges()` 的 `git status --porcelain --untracked-files=normal` 把它当成人工未提交文件，每次自动巡检启动都按设计保护延期。**不是故障**。已隐私扫描（`~/.codex/` 为通用主目录引用，无用户名/凭据/内网地址）后提交（`60a4834`），工作区恢复干净；`deferred` 是可恢复状态，下次调度触发会自动补跑当天 safety（`lastSafetyEvolveDate` 未写入 + deferred 不在 BLOCKING_STATUSES）。

### 80102 = 中级挑战书（用户指出可找，证据已闭环）

- 用户要求自己找证据。**client-config-evidence 的 ItemInfo 快照直接命中**：`80101 初级挑战书 / 80102 中级挑战书 / 80103 高级挑战书`（type 19，`icon_res gui/texture/icon/icon_s3_book0/1/2`，desc 与活动说明一致）。
- 双源交叉：参考仓库的 pet-diary `ActivityPetTreasureHuntChalleng` 表同 ID 同名称（价值 50/150/300），与 S3 活动说明"中级挑战书(150幸运星)"三方一致。按证据登记三个挑战书到 `EventItems.json`。
- 80102 之前误判为"化肥段新号"：80xxx 段被化肥占用（80001-80014）不等于整段都是化肥——**编号段规律不能当身份证据**（这也是 guardrails 既有硬门，本轮教训再次验证：先查配置快照再下结论）。

### 官方 CDN 直连验证成功（重要基础设施结论）

- `cdn-resource.nqf.qq.com` 从本机**直连可达**（DNS 只黑洞了 `appservice.qq.com`/裸 `nqf.qq.com`，CDN 域名正常解析）。用 sources.json 已验证哈希的 URL 测试下载芦苇种子 PNG，**sha256 完全匹配**——官方 CDN 下载链路全通。
- 参考仓库（公开参考项目 1，按 HANDOFF 只读对照）的 `pet-diary-assets.json` 有 132 条已解 URL 资产。本轮拉取 yuanqigao 商城 7 张兑换商品图，全部 sha256 验证通过——**与 Codex 上一轮已提交的 `{itemId}_S3_img_exchange_itemN.png` 内容完全相同**（重复下载已删），证明该批图标本就是官方 CDN 原图。
- **解任意新图标的钥匙**：参考仓库 `cdn-resource-finder.js` 的方法——官方 miniapp 源码 `src/settings.json` 的 `assets.server + bundleVers` 给出每个 bundle 的 `config.{version}.json` 精确 URL → config.paths 里逻辑路径→uuid→native URL。本机无 miniapp 源码，settings 无法取得；**下次抓包会话或用户提供 settings.json 后可解全部图标**（含挑战书 icon_s3_book0/1/2、幸运星 1029 专属图）。
- 挑战书/幸运星图标本轮保持待证空图（名称已闭环，不影响识别）；1029 仍用星标官方图（属于跨活动同图标语义，非顶替错误）。

### 验证与回滚

- Node 20 串行全量 **390/390** 通过（bag-seed-recognition 挑战书断言更新：三本挑战书名称 + 非种子）；ESLint 0 error。
- 重启后预期：`bag_unclassified_item` 清单完全清空（80102 已登记），仅在未来新未知物品首现时打一条。
- 回滚 `git revert <本轮提交>`：挑战书回到未识别清单；巡检延期根因（untracked 文档）已独立提交，不受影响。

## 证据查找顺序固化为自进化硬门（2026-09-13 第三轮）

- 用户要求：时刻更新 HANDOFF，用 RAG 思路固化证据链，防止后续图标/识别问题重复踩坑。已把本轮实战验证的方法写入 guardrails 第 10g 条（activity-evolver.js，session-lifecycle 测试锁定断言）：
  1. `core/data/client-config-evidence/ItemInfo.json` 快照按 ID 直查名称/desc/icon_res——**第一步永远先查这里**（80102 教训：编号段规律不是身份证据，80xxx 被化肥占用不代表整段是化肥）；
  2. 官方 CDN `cdn-resource.nqf.qq.com` 直连可达，参考仓库（sources.json references 记录 owner/repo/SHA）的已解 URL 资产清单按逻辑路径查官方图，**下载后必须 sha256 验证**；
  3. 任意新图标需 miniapp 源码 settings.json 的 `assets.server + bundleVers` → bundle config → uuid → native URL；本机无源码时记待证，不猜；
  4. 抓包会话开着游戏进活动页/背包，URL 自动落盘 `core/data/capture/resource-urls.json`。
  找不到证据就记 HANDOFF 待证，禁止跳到猜测。
- **每日 HANDOFF 更新是硬门**：本轮发现的新证据链/新方法/新踩坑必须当日写入 docs/HANDOFF.md——这是给下轮 agent 和下一个 Claude/Codex 会话的 RAG 语料，不写等于丢知识。
- 验证：Node 20 全量通过（guardrails 新增 5 条断言锁定 10g 条）；ESLint 0 error。

## 活动进化巡检（2026-09-13 第四轮，审计假信号清除与挑战书库存传导）

### 最近 24h 日志审计（6b/10e 硬门）

- 2172 条结构化日志：请求超时、发送失败、治理拦截、收获/种植/偷菜失败、施肥趋势触发、`seedId=0`、`植物<ID>`、空图全部 **0**。
- `bag_unclassified_item` 202 条全部发生在 Bot 重启（17:06）之前：涉及 80102/1040516/1049004，三者已在昨日提交登记；重启后新进程零 unclassified 日志，活动报告 seedRecognition 34 类 `issues: []`——昨日去重与登记已生效，无需再修。日志中 1040516 在同一清单出现两次属正常背包多堆叠，非缺陷。
- 被踢 2 条 = 已知微信授权范围失效路径（07:49，`0a7293a` 行为一致）；重启后 warn 仅 TSDK Node 检查提示 + 4 种红点类未知推送（按设计仅记录不响应）。

### 本轮改动（两项最小修复，均有确定证据）

1. **种子目录审计比较器假信号修复**（`seed-catalog-audit.js`）：`compareClientSeedCatalog` 原来把源表 `size=null` 默认成 1、本地省略默认成 0，快照 Plant 表 251/270 种普通作物官方就不写 size，导致每次全量审计输出 **175 条假 size 差异**（总差异 193 条），真差异被淹没。现在源表 size/land_level_need 为 null/缺省（无证据）时不参与比较；源表声明数字时仍严格比对——四格作物（快照 19 种 size=2）本地漂移或缺失照报。修复后全量审计从 193 条降为 **21 条真实待证**。每日硬门 10b 的全量审计因此才可用。
2. **挑战书库存传导到 S3 活动卡**（`season-bear-activity.js` + `activity.js`）：昨日按 ItemInfo 快照三方证据登记的 80101/80102/80103 没有传导——S3 资源区三档挑战书仍是 `itemId: null`（显示“道具 ID / 专属图片待官方证据”、数量待确认），背包读取列表也不含这三个 ID。现在资源区带道具 ID 与真实库存（读取成功时；缺档按既有规则显示 0），`getBearActivity` 一次性背包读取列表加入三档挑战书（16→19 个 ID）。夺宝是“消耗 1 张挑战书”的核心玩法，库存可见性与幸运星/种子一致。专属图片仍待证（前端空图自动降级为礼物图标）。

### 图标闭环与参考仓库复查（10g 顺序）

- `getGenericFallbackItemIds()` 为空；空图道具 = 三档挑战书、黄金·狗尾草 1040516、黄金·泡泡棉花糖 1049004、雷电徽章 1027、幸运星专属图、4 个已结束活动道具（5001/5002/5005/101604）。已运行 `npm run fetch:official-icons`：本机无抓包 URL 证据（resource-urls.json 不存在）。
- 参考仓库 公开参考项目 1 出现 2 个新提交（`61ac4b5` UI 布局/webp 精简、`1db90a2` 宠物页布局修复），已核对：仅 UI/webp 转换与 pet-diary-assets.json 缩减，**无** icon_s3_book0/1/2、gold/Crop_516、gold/Crop_9004、1029 专属图新证据；132 条资产全为 S3 UI 纹理与已提交的 7 张商城图。挑战书/黄金变体/幸运星专属图维持待证（需 miniapp settings.json 或抓包会话）。
- 现有 PNG 537 张中 `1028_萌宠元气糕.png` 等已覆盖 S3 资源区；商城 9 件、种子 5 种、元气糕、幸运星（跨活动同图标语义）均有图。

### 全量审计剩余 21 条待证基线（下轮勿重复推导）

- **休眠未登记种子**（不在当前 Bag，出现时 `bag_unclassified_item` 会报警再登记）：29999=白萝卜种子变体（plant **2020002**，与本地已登记的 29998 变体同族模式）、21625=枸杞种子、21072=寒兰种子。
- **名称冲突**（本地与快照各执一词，无 Bag/土地/官方图证据仲裁，保持本地）：20264 红色郁金香/帝王血、26032 金盏花/月见草（plant_id 本地 1060032 vs 快照 1026032）、21251 紫玫瑰/紫茉莉、21050 卷丹百合/萱草、21404 白牵牛花/月光花、21353 粉樱花/紫薇、21380 米兰花/梧桐。
- 20883 小红花 `land_level_need` 本地 0 vs 快照 1（活动已结束休眠，无运行影响）。
- `source_plant_missing` 10 项（20136/20111/20118/20114/20165/20107/20130/20123/20219/20092）：ItemInfo type=5 但快照 Plant 无行，本地也无植物映射——无证据不动。

### 指纹变化与其他复核结论

- 活动证据指纹变化（dee74caf→e4c32e21）的原因是 2026090102 starRecord 的领取进度变化（记录 1-4 已领取、5 已解锁未领取），活动配置本身（tips/13 件商城/31 条记录/5 处说明差异）与已登记实现完全一致——进度属用户在官方客户端的人工操作，不触发适配。starRecord 记录 5 解锁未领取是用户人工领取事项，无写协议不代领。
- 旧活动（雨落成诗/公益小红花）在 List 中不存在，worker.js/data-provider/controllers 无任何残留调用（grep 验证）；好友偷菜时间语义日志无异常。

### 踩坑、验证与回滚

- **审计工具的默认值也是“证据语义”**：把“源表没写 size”默认成 1、把“本地没写 size”默认成 0，等于给两边各编了一个数再比较。无字段=无证据=不比较；有字段=严格比较。以后改比较器必须保持这个原则，否则每日全量审计重新变成噪声墙。
- 挑战书 ID 传导只改只读展示与一次背包读取的 ID 集合，不新增 Operate/cmd/写按钮/自动开关；`resources` 仍全部 `operationSupported` 不变。
- 验证：Node 20 串行全量 **391/391** 通过（新增 1 条“源表无 size 不伪造差异、源表声明数字本地缺失仍报缺口”回归；season-bear 断言更新挑战书 ID/库存/读取列表 19 项）；web `npm run build` 通过；改动文件 ESLint 0 error。系统默认 node 是 18.20.8，必须切到本机 nvm 的 Node 20（v20.20.2）跑测试与构建，不得把 Node 18 的工具链失败当源码回归，也不得把 nvm 绝对路径写进仓库。
- 回滚 `git revert <本轮提交>`：恢复审计 175 条假信号与挑战书“道具 ID 待官方证据”显示；不影响收菜/偷菜/重点 HOT/PREARM/请求治理/登录/设备链路（本轮未触碰这些文件）。应用或回滚只能在既有 `farm:0.0` 窗格完成；本轮 Agent 不重启 Bot、不推送远端。

## privacy_blocked 误杀修复：机器尾注域放行（2026-09-13 第四轮人工收口）

### 现场与根因

- 面板报"活动进化（Claude）被隐私闸门拦截，未向 GitHub 推送；本轮自动提交已安全丢弃，personal-email @ (commit-message):8"。根因：`privacy-guard.js` 的 `personal-email` 规则只放行 `@users.noreply.github.com`，**没放行 Claude Code `Co-Authored-By: Claude <noreply@anthropic.com>` 尾注**——该尾注是机器域（anthropic.com），不是个人信息。被误杀的活动提交本身完全干净。人工提交不走此闸门（同样尾注的 c5bb7b8 等早已推送），所以只有自动进化触发。
- 注意正则细节：尾注匹配的是 local part `noreply` + 域 `anthropic.com`——白名单必须排除**域**（`anthropic.com\b`），写成 `noreply.anthropic.com` 会被 local part 拆开而继续误杀（第一版修复就踩了这个）。

### 修复与恢复

1. `privacy-guard.js` personal-email 负前瞻加入 `anthropic.com`（与 `users.noreply.github.com` 同级机器域），附注释说明来历。
2. `privacy-guard.test.js` 新增回归：机器尾注（GitHub 匿名/Claude 尾注）不命中；真实邮箱（qq.com/163.com/公司域）仍命中。
3. 被丢弃的两个自动提交从 `git fsck` dangling 恢复：activity 提交（审计假信号清除+挑战书库存接入 S3 活动卡）已 cherry-pick 为 `54fd2e0`；safety 提交内容与 activity 提交是同一 agent 的连续近似实现（冲突解全部保留 activity 版更严谨的 null-不比较逻辑），不再重复引入。
4. `activity-evolve-state.json` 的 `privacy_blocked` 复核后复位 `idle`，下一轮自动进化正常调度。
5. **"后续自进化要学会自己找问题"（用户指示）**：guardrails 已含此模式——agent 遇到 privacy_blocked/失败收口时必须先复核规则误杀可能（用 scanTextForPrivacy 单测可疑行），不能只接受"被丢弃"。本次是人工复核完成；下轮 agent 的 10g/10e 硬门同样适用：失败原因要回查到代码与规则层，禁止盲目重试或直接放弃。

### 验证与回滚

- Node 20 串行全量 **392/392** 通过（含恢复提交的 12 条 + privacy 回归 2 条）；恢复的提交用修复后规则重扫：提交信息零命中。ESLint 0 error。
- 回滚 `git revert <本轮提交>`：恢复误杀状态（不推荐）；只回滚规则修复会重新拦截正常 Co-Authored-By 尾注。

## 安全巡检记录（2026-09-13 第五轮，面板读路径穿透上游收口）

### 最近 24h 日志审计（10e/1a 硬门）

- 2171 条结构化日志、JSON 解析失败 0；「请求超时」「发送失败」「治理器拦截」「收获/种植/偷菜失败」「施肥趋势触发」「seedId=0」「植物<ID>」「空图」全部 **0**。
- `bag_unclassified_item` 178 条全部发生在 09-13 17:06 重启前（旧进程无去重）：10s 精确链（09:00:36→09:01:36，.43x 结尾亚毫秒稳定）、15s 精确链（07:51:09→52:09）、60s 精确链（09:02:17→09:25:17，每分钟 :17.4）。17:06 新进程零条——昨日登记与去重已生效，无需再修。
- 被踢 2 + 长凭据保活失败 2 集中在 09-12 19:03 与 09-13 07:49，均为已知微信授权范围失效路径（账号 A 需人工重新扫码，代码行为与 `0a7293a`/`9b10fef` 设计一致，不收紧）。未知推送 7 类（红点/商城类）按设计仅记录不响应；当天 worker 重启 5 次（用户应用进化），接管计数重置为既有已知风险项。wasm SHA-256 与基线一致、clientVersion 无漂移、seed 目录审计 21 条与昨日基线完全一致、`getGenericFallbackItemIds()` 为空。

### 本轮根因发现与修复（三处同类，均有代码+日志证据）

- **面板前端三个固定定时器此前每次都穿透到腾讯上游**，违反硬门 7「下游刷新必须用缓存/并发合并」：
  1. Dashboard `useIntervalFn(refresh, 10000)` 无条件调 `refreshBag()` → `/api/bag` → worker RPC `getBag` → `warehouse.getBagDetail()` → 直发 `ItemService.Bag`（10 秒精确间隔 = 机器指纹）；
  2. Settings `bag_priority` 时 15s `setInterval` → `/api/bag/seeds` → `getBagSeeds()` → 同样直发（15 秒精确间隔）；
  3. Personal 页 BagPanel 60s / FarmPanel 60s（后台标签页时 Dashboard 10s 轮询被浏览器节流成 60s）→ `/api/bag`、`/api/lands`、`/api/dog/skill-gifts` → `AllLands`、`DogService.GetDogInfo` 直发。
- 修复全部落在 worker 侧服务层（与 interact.js 2026-09-07 收口同一模式）：`warehouse.getBagForPanel()`（60s 成功缓存 + 在途合并 + 60s 失败冷却）供 `getBagDetail`/新增 `getBagSeedsForPanel` 使用；`farm-land-analyzer.getLandsDetailForPanel()`（getLandsDetail 吞错误返回空结构，按普通值缓存，失败也缓存不放大重试）；`dog-skill-gifts.getDogInfoForPanel()`（含失败冷却）。worker RPC `getBag/getBagSeeds/getLands/getDogSkillGiftStatus` 全部改走缓存变体。
- **失效钩子只接面板触发的变更**（worker 管理 RPC switch 内）：`useItem/sellItems/batchUseItems` 成功后失效背包缓存；`doFarmOp/buyFertilizer/checkAndBuyFertilizer/fertilizeLand/removePlant/removeAllPlants` 后失效土地（收获/催熟/购买同时失效背包）；`claimDogSkillGifts` 后失效狗信息缓存。**内部收益链一律保持新鲜读取**：种植 `getBagSeeds()`、农场 tick `getAllLands()`、`runFarmOperation`、`harvestOwnAtMaturity`、`removeAllPlants` 决策读取、`checkAndClaimDogSkillGifts` 内部 `getDogInfo`、`useItem` 的 uid 查找——全部不走缓存。

### 踩坑、注意点与风险边界

- **不能缓存 `getBagSeeds()` 本身**：planting-service `plantFromBagSeeds` 用它决定种什么种多少，缓存会让种植吃到 60 秒前的背包数量；必须拆 `getBagSeedsForPanel` 只接面板 RPC。
- **不能把失效钩子放进 runFarmOperation 服务内部**：农场 tick 每 8–12s 调它，每次失效会让面板缓存形同虚设；失效只挂在 worker 管理 RPC 的面板入口 case 上。
- 面板显示最多滞后 60 秒（后台 tick 自动收获/自动出售后面板数字延迟刷新）；用户在面板点操作后立即失效、下一次读取即新鲜。土地快照在途竞态与活动读缓存同语义：invalidate 解除在途引用，旧 pending 完成体不再写缓存。
- useItem 在 uid=0 时先用无缓存 `getBag()` 查 UID，再发 Use——这是变更前的必要新鲜读取，测试断言链路时要把这次读取算进去。
- 好友地块 `/api/friend/:gid/lands` 只在用户展开卡片时触发（用户动作非定时器），且与施肥 HOT 证据采集共用 Enter——本轮明确不碰好友路径。Sidebar 60s 只读本地活动报告、Friends 30s 只读本地好友快照，均不穿透，不要误改。

### 验证与回滚

- Node 20 串行全量 **399/399** 通过（新增 bag-panel-cache 4 条、lands-panel-cache 2 条、dog-skill-gifts 面板缓存 1 条，覆盖并发合并/缓存命中/操作失效/失败冷却/种植与内部路径不缓存）；改动文件 ESLint 0 error。未改前端，无需 web build。
- 预期效果：面板开着时上游 Bag/AllLands/GetDogInfo 读取从每 10–15 秒一次收敛到每 60 秒最多一次，且消除亚毫秒稳定的固定间隔指纹；面板关闭时零请求（此前后台标签页仍 60s 打一次）。
- 本轮未触碰自己成熟 10 秒预留与 30–80ms Harvest、好友到点偷菜、重点 HOT/PREARM、请求治理预算、登录保活、设备串、TSDK/ACE、好友/盯梢调度。回滚 `git revert <本轮提交>` 后仅在既有 `farm:0.0` 应用；回滚会恢复面板轮询直穿上游与固定间隔指纹，不得借回滚改动核心收益链。本轮 Agent 不重启 Bot、不推送远端。

## 安全巡检记录（2026-09-14，1030 待护送宝藏登记与 24h 零异常收口）

### 最近 24h 日志审计（10e/1a 硬门）

- 审计窗口 2026-09-13 20:00 ~ 2026-09-14 20:05，2144 条结构化日志、JSON 解析失败 0；「请求超时」「发送失败」「治理器拦截」「收获/种植/偷菜失败」「熔断/cooldown」全部 **0**。
- 核心收益链全部成功：到点保护收获 **42/42 ok**、哨兵抢收 **16/16 ok**（成熟到点后 99–234ms 出手，均在 80–300ms 窗口内）、偷好友菜 **6/6 ok**。
- 化肥趋势触发 2 次（23:57、01:55）：触发时刻**先于**偷菜 4–5 秒、两次快照墙钟均在观察时间之后、12 秒无新证据即冷却——满足 2026-09-11 地块级证据门（误判签名是触发跟随偷菜之后）；盯梢目标为自家另一账号，HOT→抢收→冷却全链按设计运行，未误触发。
- 被踢 2 次（04:52/05:19，账号 A）：服务端原因均为「已在其他终端登录」真人顶号，退避 5min→30min 正确递增，断线等待保活先挂载；不据此改登录接管策略。微信授权链 08:17 保活失败 → 19:51 冷启动 Code 失败被启动闸门正确阻断（「微信授权已失效，等待重新扫码」）→ 19:53 凭据恢复后成功启动，**无重试风暴**，与收件箱三类线索一一对应，均属已知路径，不改代码。
- 环境基线无漂移：`tsdk-v3.9.0.wasm` SHA-256 与 `tsdk-ace-runtime.md` 完全一致；clientVersion 零条自动更新；未知推送 23 条全部为红点/商城/公告类已知家族，仅记录不响应；旧活动（雨落成诗/公益小红花）路由 grep 确认断开；活动报告 up-to-date、unknown/ended 均空；种子目录审计 **21 条与昨日基线完全一致**；`getGenericFallbackItemIds()` 为空；`npm run fetch:official-icons` 运行确认无抓包 URL 证据（7 项商城装饰待抓取，零网络请求）。
- 主进程 19:51 冷启动（用户操作），当前运行代码已含 846e21d 面板缓存收口；冷启动后日志无固定间隔 Bag/AllLands/GetDogInfo 读取。

### 本轮改动（一项，均有确定证据）

1. **`bag_unclassified_item: 1030` 当日复盘登记（硬门 10/10g）**：Bag 两次出现未知物品 1030（05:33、19:53，均为 worker 重启后首次读取，去重生效仅 2 条）。按 10g 顺序第①步查 `client-config-evidence/ItemInfo.json` 快照直接命中：**1030 = 待护送宝藏**（type 19、activity 2026090101、icon_res `gui/texture/icon/icon_s3_map/spriteFrame`、desc 与 S3 寻宝护送玩法说明一致）——这正是 HANDOFF 2026-09-10 记录的「待护送宝藏 ID 仍未知」缺口，现在 Bag 实际出现完成闭环。照抄 54fd2e0 挑战书模式传导：`EventItems.json` 登记（名称+类型+desc 快照逐字）、`season-bear-activity.js` treasure 资源行接 `BEAR_TREASURE_ITEM_ID = 1030` 并导出、`activity.js` 一次性背包读取列表 19→20 个 ID。专属图片仍待证空图（前端降级显示名称），不伪造、不顶替。

### 踩坑、验证与回滚

- **EventItems 的 desc 必须快照逐字**：第一版曾把 sell_cond 字段的「活动结束后可出售」推断混写进 desc（快照 desc 原文没有这句）——出售条件是独立字段证据，不能当文案拼接；已修正为逐字。登记字段多写一句推断与漏登记同罪，都是证据语义污染。
- 验证：Node 20 串行全量 **399/399** 通过（season-bear 资源区/read list 20 项/treasure itemId 断言、bag-seed-recognition 1030 名称+非种子断言）；改动文件 ESLint **0 error**；`getItemById(1030)` 返回「待护送宝藏」且 `isSeedItem(1030)=false`，重启后 `bag_unclassified_item` 将不再报 1030。
- 本轮未修改 worker.js、收菜/偷菜/重点 HOT/PREARM、请求治理、登录保活、设备串、TSDK/ACE、好友/盯梢调度。回滚 `git revert <本轮提交>` 后仅在既有 `farm:0.0` 应用；回滚会恢复 1030 未识别日志与 S3 资源区「道具 ID 待官方证据」显示，不得借回滚改动核心收益链。本轮 Agent 不重启 Bot、不推送远端。

## 活动进化巡检（2026-09-16，S3 作物变异显示闭环与指纹变化核对）

### 最近 24h 日志审计（10e/1a 硬门）

- 审计窗口 2026-09-15 18:00 ~ 2026-09-16 18:00 UTC，1670 条结构化日志、JSON 解析失败 0；「请求超时」「发送失败」「治理器拦截」「收获/种植/偷菜失败」「seedId=0」「bag_unclassified_item」「空图」「cooldown/熔断」「裸植物/物品/种子 ID」全部 **0**。
- 核心收益链正常：到点保护收获 32/32 ok；巡查（浇水/除草/除虫）全部成功。施肥趋势触发 2 次（14:27、15:50，同一目标）：触发时刻先于偷菜、12–13 秒无新证据即冷却，满足 2026-09-11 地块级证据门。
- 被踢 1 次（15:26，真人顶号「已在其他终端登录」）：离线保活先挂载、3 秒后一次已知授权失效报错、2.5 分钟后凭据恢复并成功重登——无重试风暴，与 0a7293a 设计一致，不改登录接管。
- 未知推送 7 类（红点/商城/成就）按设计仅记录不响应；ACE 上报约 48 秒节拍全部成功。
- 活动报告 up-to-date（17:40 扫描），unknown/ended 均空；seedRecognition 36 类零缺口；种子目录审计 21 条与 09-14 基线完全一致；`getGenericFallbackItemIds()` 为空；`npm run fetch:official-icons` 确认仍无抓包 URL 证据（7 项商城装饰待抓取，零网络请求）。

### 指纹变化原因（0f834b59 vs 上次已审 dee74caf）

- 在线快照 starRecord 记录 1-7 已领取、8 已解锁未领取（09-13 时为 1-4 已领取、5 已解锁）。`season-bear-activity.js` 无任何 `Operate`/`sendMsgAsync`/claim 写路径（grep 验证，`operationSupported: true` 为 0），记录 5-7 的领取只能是用户在官方客户端的人工操作，与 09-13 结论同模式：进度变化属人工事项，不触发适配、不代领。活动配置本身（tips/13 件商城/31 条记录/5 处说明差异）与已登记实现完全一致。

### 本轮改动（S3 萌宠作物变异显示闭环，四文件数据补丁）

**根因**：本地 `MutantEffect.json` 只有 10 种变异，`EventPlants.json` 的 S3 作物（狗尾草/芦苇/泡泡棉花糖）缺 `mutant_effect_plant` 映射。S3 活动说明明确比熊变异（售价×4）与泡泡棉花糖专属变异玩法，但土地回包 `mutant_config_ids=[15/16/5]` 时显示链解析不到变体植物——变异作物只显示基名、无变异标签（黄金变异线上实际发生过：bag 已出现 1040516/1045995/1049004，但土地一直显示基名）。

1. **`MutantEffect.json` +2 条**：15 比熊（`icon: bichon`，"比熊犬处于看护状态时概率触发"）、16 乐园（`icon: leyuan`，"种植泡泡棉花糖有概率出现"，fruit_name 比熊棉花糖）。证据：参考仓库 公开参考项目 1 @ 343d9463 的客户端配置快照，与 S3 活动说明文案逐字交叉核对。效果 12 闪电（雨落成诗已结束）、14 晶辉（紫晶土地、无线上触发证据）本轮不登记，维持待证；本地 `mutant/crystal.png` 已存在但效果 14 无 S3 关联。
2. **`EventPlants.json`**：狗尾草/芦苇/泡泡棉花糖补 `mutant_effect_plant`（快照逐字：`5:1120516:1`、`5:1125995:1`、`5:1129004:1;16:1028004:1`）；新增 5 个变体植物 1120516 黄金·狗尾草、1125995 黄金·芦苇、1129004 黄金·泡泡棉花糖、1028004 比熊棉花糖、1128004 黄金·比熊棉花糖（含组合映射 `5_16:1128004:1`）。
3. **`gameConfig.js` EventPlants 合并**（两处最小修复）：① 合并字段补 `mutant_effect_plant` 拷贝；② `seedToPlant/fruitToPlant` 改真值守卫（对齐 Plant.json loader——变体植物 seed_id 为空，否则全部落在 0 键互相覆盖）；③ 物品合成块跳过无 seed_id 条目，否则 `Number(null)=0` 会合成 id=0 假种子污染 itemInfoMap。
4. **`EventItems.json` +2 条**：204008 比熊棉花糖、204009 黄金·比熊棉花糖（type 18，快照逐字：sells/desc/rarity/icon_res）。乐园变异收获的果实进背包时不再触发 `bag_unclassified_item`。

### 踩坑与注意点

- **变体植物的 seed_id 为空是"变异展示植物"的判定信号**：它们只进 plantMap（名称/映射解析用），不进种子/果实索引、不合成种子物品。`getPlantBySeedId(0)`/`getItemById(0)` 必须保持 undefined——回归已锁定。
- **`mutant_effect_plant` 在 EventPlants 合并中原本根本不被拷贝**：即使 JSON 写了字段也会被丢弃（合并构造的白名单对象没有它）。以后给 EventPlants 加新字段必须同步检查合并字段清单。
- **比熊变异（15）没有植物映射**：快照 Plant 表无任何条目引用 `:15:`——它是纯售价变异（actions "3:4" = 售价×4），展示靠 mutantEffects 标签承载，返回原植物 ID 是正确行为，不是缺陷。
- **变异图标 bichon.png/leyuan.png 待证**：`seed_images_named/mutant/` 有 17 个既有图标（crystal/dark/desert/frozen/golden/haha/ice/lotus/love/lucky/luxury/mian/moist/moon/shinning/snow/tata）但无比熊/乐园；参考仓库 pet-diary-assets 129 条无此 URL 证据。前端 LandCard 对缺失图标按 alt 降级显示名称；下次抓包会话进有变异作物的农场页可自动记录 URL 后补抓。
- **变异阶段图回退是既有设计**：变体植物无 asset_name/manifest 条目时 `getPlantImageByPhase` 走通用阶段回退（`getMutantPlantImageByPhase` 的 `||` 短路），与全部既有黄金变异行为一致；名称+效果标签才是本轮闭环目标。
- 快照 mutant_effect_plant 解析（`getMutantDisplayPlantId`）本就支持多段组合映射（两段 `5_16:1128004:1`）与 visited 防环，代码无需改动——本轮是纯数据补丁。

### 验证与回滚

- 新增 `core/test/mutant-plant-display.test.js` 11 条：乐园/黄金/组合变异植物 ID 与名称解析、狗尾草/芦苇黄金变体、比熊无植物映射边界、效果 15/16 标签、索引无 0 键污染、204008/204009 非种子登记、基础种子映射不回归（29004 size=2）、土地/种子双回包解析链。
- Node 20（v20.20.2）串行全量 **410/410** 通过；`cd web && npm run build` 通过（类型检查+生产构建）；改动文件 ESLint **0 error**（gameConfig.js 保留既有 2 条 JSDoc warning）；种子目录审计 21 条基线与 `getGenericFallbackItemIds()` 未受扰动。
- 本轮未修改 worker.js、收菜/偷菜/重点 HOT/PREARM、请求治理、登录保活、设备串、TSDK/ACE、好友/盯梢调度；变异映射只影响显示层（farm/friend-land-analyzer 的名称与效果标签），不进入成熟墙钟、偷菜目标排序或收获计算。回滚 `git revert <本轮提交>` 后仅在既有 `farm:0.0` 应用；回滚会恢复变异作物显示基名、无变异标签，不得借回滚改动核心收益链。本轮 Agent 不重启 Bot、不推送远端。

## 活动进化巡检（2026-09-18，S3 指纹核对与 daily_share 解码异常登记，零代码改动）

### 最近 24h 日志审计（10e/1a 硬门）

- 审计窗口约 2026-09-16 16:35 ~ 2026-09-17 16:35 UTC，1712 条结构化日志、JSON 解析失败 0；「请求超时」「发送失败」「治理器拦截」「收获/种植/偷菜失败」「seedId=0」「bag_unclassified_item」「空图」「cooldown/熔断」「裸植物/物品/种子 ID」全部 **0**。
- 核心收益链正常：到点保护收获 **54/54 ok**、哨兵抢收 **11/11 ok**（80–300ms 窗口内）；种植 13 ok（含泡泡棉花糖 2x2 两次，预留→铲除→种植链全成功）、铲除 12 ok、催熟 9 ok；好友巡查 56 ok、帮助 52 ok。化肥趋势触发 1 次（land_ripe_advanced）：触发先于抢收、12 秒无新证据冷却，满足 2026-09-11 地块级证据门。error 级仅 1 条微信凭证保活失败（「授权范围已失效」= 已知 40188 路径，账号需人工重扫，WS 不重启、无重试风暴）；今日 safety 轮已先于本轮零改动收口（定向回归 92/92）。

### 指纹变化原因（0f834b59 → 589cd528）

- 在线快照 starRecord 记录 9 新解锁：现为 1-7 已领取、8/9 解锁未领取（09-16 为 1-7 已领取、仅 8 解锁）。活动配置本身（tips 45/19/37 行、13 件商城、31 条记录、状态码序列与 owned 均不变）与已登记实现完全一致——同 09-13/09-16 模式：用户在官方客户端的人工进度，不触发适配、不代领。

### 本轮新发现：daily_share 成功回包解码失败（登记证据，不改代码）

- 现象：连续 3 个可观测日（09-15/16/17）每天 00:00 档 daily_share 出现一条 info 级 result=error「领取失败: index out of range: 32 + 10 > 32」（protobufjs Reader 在 32 字节回包末尾跳过声明长度 10 的 wire-2 字段越界），每日仅 1 次、无重试风暴。
- 影响已闭环核实：同日稍后的重试（07:13/15:28/03:25）均走到 ClaimShareReward 并得到「今日分享奖励已领取」（code=1009001 已领取语义）——服务端在 00:00 已实际受理领取，**奖励没有丢失**；仅成功回包（含奖励内容的 32 字节 body）无法被现有 sharepb.proto 完整解码，被外层 catch 误记为「领取失败」。重试有界（当日 1 次）、当日自动收口。
- 不修理由：根因修复需要真实成功回包样本或官方 sharepb 语义（本机无抓包会话、无 miniapp 源码）；按硬门 7，凭 Reader 越界错误猜测 proto 字段属于禁止行为。当前「解码失败→不标完成→重启后重试→已领取→当日收口」是安全兜底，不得改成「解码失败即视为成功」。
- 后续取证路径：下次抓包会话顺带记录 ShareService 三方法回包样本后，才允许按证据修 proto/解码；在此之前该错误属已知项，不再深查。

### 踩坑与注意点（下轮必读）

- **info 级 result=error 会逃出 safety 白名单扫描**：daily_share 解码失败连续 3 天未进 safety 轮视野（今日 safety 仍报「error 仅 1 条」），因为它不在「收获/种植/偷菜失败」等白名单类别且 level=info。后续安全/活动巡检必须先全量聚合一次 `result:"error"`（不分 level、不限白名单），再对照本文件已知项归类，未匹配的才深查。
- **web 构建只显式调用 v20 的 npm 不够**：直接执行 v20.20.2 的 `npm run build` 仍会让 vite shim 从 PATH 解析到系统 Node 18 并报 `crypto.hash is not a function`；必须先 `export PATH=<node20>/bin:$PATH` 再构建。该失败是环境问题不是源码回归（既有硬门再验证 + 新增 PATH 细节）。
- 单条「领取失败」decode error 不能单独判定奖励丢失或被谁领取，必须看同日后续「今日分享奖励已领取」闭环。

### 五闭环复核与验证

- 图标：`getGenericFallbackItemIds()` 为空；`npm run fetch:official-icons` 已运行（无抓包 URL 证据，7 项商城装饰、bichon/leyuan 变异图标维持待证，零网络请求）；seed_images_named/mutant 仍 17 图、无新增未跟踪 PNG。
- 种子/物品：种子目录审计 **21 条与 09-14/09-16 基线完全一致**（同 ID 同类别）；seedRecognition 41 类零 issue（36→41 为 8837bd5 变异登记后新类别，无新缺口）。
- 旧活动：雨落成诗/公益小红花/千星在 worker.js/data-provider/controllers/前端 grep 均无可达调用；List 仅下发 S3 四节点。
- 玩法/UI：S3 十一类玩法、商城、starRecord 展示与已登记实现一致，无新说明、无字段形状变化。
- 本轮**零代码改动**（五闭环通过、指纹变化为纯人工进度、唯一新异常无安全修法），按硬门 8 代码保持不变，按硬门 10g 将上述新证据链当日写入本文件。未修改 worker.js、收菜/偷菜/重点 HOT/PREARM、请求治理、登录保活、设备串、网络或 TSDK/ACE。
- 验证：Node 20（v20.20.2）`node --test --test-concurrency=1 test/*.test.js` 串行全量 **410/410** 通过；web Node 20（PATH 前置）类型检查+生产构建通过。回滚：本提交仅文档，`git revert <本轮提交>` 无任何行为影响。本轮 Agent 不重启 Bot、不推送远端。
## README 状态说明与 GitHub 主动检索硬门（2026-09-13 第五轮，用户指示）

### README 更新（用户三项要求）

1. **扫码失活边界**：微信扫码登录段落新增 NOTE——凭证持久化+滚动续期已实现（重启/退出终端免扫码），但**微信服务端撤销授权（40188/invalid scope）必须重新扫码**，这是 OAuth 协议设计无法客户端绕过；Bot 检测失效后停止旧会话保活并阻断旧 Code 空转，等扫码恢复。
2. **活动玩法适配状态**：活动发现/说明解析/只读展示/自动进化已就绪；新活动玩法操作（兑换/抽奖/领取）需官方成功操作样本后逐步开放——当前部分活动只读，持续迭代。
3. **自进化公开项目借鉴**：新增"自动进化与公开项目借鉴"一节，说明只读对照 GitHub 农场项目、不可信输入边界、隐私闸门推送流程。

### guardrails 新增第 10h 条（GitHub 主动检索）

用户指示：自进化时要尽可能搜索 GitHub 上的农场/别人农场项目，读代码找借鉴点。已写入硬门并测试锁定（session-lifecycle 4 条新断言）：
- 每轮用 `api.github.com/search/repositories`（qq farm/QQ农场/farm bot/nqf 等关键词）广泛搜索候选仓库；
- 只读其代码结构/调度分层/任务追踪/活动适配/UI 组织/配置管理，评估借鉴点；
- 边界不变：不可信输入、不执行脚本/依赖/二进制、不添加 remote、不复制 RPC/登录/设备/TSDK/ACE；
- 参考的 owner/repo/SHA 记入 ignored 的 client-config-evidence/sources.json（受跟踪文件不写）；
- 无可靠借鉴允许零改动，禁止硬抄。

### 验证

- Node 20 串行全量 **410/410** 通过；ESLint 0 error。README 为文档改动无测试影响。
- 回滚 `git revert <本轮提交>`。

## 断线重连免扫码：安全决策与本地/GitHub 分流（2026-09-14 用户指示）

### 用户裁定（必须遵守）

- **断线重连免扫码不做，这是安全决策不是缺陷**：授权失效后的自动重连免扫码需要绕过微信授权生命周期（保存/复用被撤销凭据、伪造授权状态、模拟扫码），会显著抬高账号风控画像，与防封号原则冲突。Bot 对断线的处理固定为：检测失效 → 阻断旧凭据空转 → 等待人工重新扫码。
- **本地后续若有断线重连方向的更新，不推送到 GitHub**：这类改动只留本地，公开 main 不承载。本地开发不受此约束影响（本地照常更新运行）。
- 已写入 README（扫码登录 NOTE + 数据与安全 IMPORTANT）与本硬门。自动进化 agent 每轮提交前必须确认改动不涉及断线重连免扫码方向；涉及则按"本地改动不上传"处理（不提交、不推送，保留在工作区或本地分支）。

### 对自动进化的具体约束

- activity/safety agent 的隐私扫描之外，新增方向过滤：任何"绕过授权失效、免扫码重连、凭据复用撤销后重建"的实现不得进入 Git 提交。guardrails 已有"不做 Cookie 窃取/伪造设备/拦截授权/第三方永久 Token"条款，本条是其具体化。
- 判断标准：改动涉及 `auto-code-refresh.js`/`qrlogin.js`/`wx` 凭据链且目的是"授权失效后不扫码恢复"，即命中；正常的长凭据滚动续期（授权有效期内）不受影响。

### S3 萌宠玩法操作接入（同轮启动）

- 用户批准移植参考仓库的 S3 写操作链（官方小程序 1.14.0.1 编码器证据的命令字/选择器/请求结构），按"手动确认优先"两步走：第一步面板手动操作积累自有成功样本，第二步才评估自动化。

## S3 萌宠玩法手动操作接入（2026-09-18，官方编码器证据链）

### 证据与接入模式

- 用户批准移植 S3 写操作链。证据来源：参考仓库 公开参考项目 1 @34505ac 的 `activity-pet-diary.js`/`pet-diary.proto`——文件头声明"命令字与选择器来自官方小程序 1.14.0.1 编码器，不按响应长度或 UI 文案推断"，属官方编码器还原级证据（其 evidence-levels 中仅次于真机验证）。按 HANDOFF 外部借鉴边界只读移植，不执行其代码。
- **手动触发模式（两步走第一步）**：操作只由面板按钮触发，不接每日自动任务；每次操作前重读 GetGroup 做服务端前置校验（余额/次数/状态，与官方客户端一致），防本地状态过期重复扣费；钻石(1004)与零消耗一律拒绝；失败不自动重试。积累自有线上成功样本后再评估自动化（第二步）。

### 本轮改动

1. `core/src/proto/pet-diary.proto`：同源移植（GetGroup/Operate 请求响应、PetTreasureHunt 状态族、商城/种子礼包结构），注册进 `utils/proto.js`（三个类型）。
2. `core/src/services/pet-diary-operate.js`：命令字表（feed 29/draw 30/seeds 21/exchange 1/claimDog 48/initialize 27/story 32/compensation 46 等）+ `runManualPetDiaryAction` 前置校验链。**夺宝(43)/好友信息(47)/付费刷新(41)暂不开放**——涉及选择好友目标与点券扣费，等第一轮样本。
3. Worker `operatePetDiary` switch + data-provider 转发 + `admin-pet-diary-operate-routes.js`（POST /api/activity/pet-diary/operate，操作成功清只读缓存）。
4. 前端：BearActivityPanel 新增"玩法手动操作"区（7 个按钮+busy 状态），store 加 `operateBearPet`，成功后自动刷新只读状态。
5. 测试 `pet-diary-operate.test.js`：proto 往返、前置校验（成年才可寻宝/余额不足拒/未开放操作拒）、命令字白名单锁定、只走 GetGroup+Operate 不引入新接口。

### 验证与回滚

- Node 20 串行全量 **412/412** 通过；前端 vue-tsc + vite build 通过；ESLint 0 error。
- 线上首验路径：面板点"领取种子礼包"（无消耗操作最安全）→ 观察 `pet_diary_operate` 日志与服务端回包 → 再试投喂/寻宝。若 Operate 被服务端拒绝，错误会原样显示在面板，不会重试。
- 回滚 `git revert <本轮提交>`：恢复"只读+操作待确认"状态；proto 与命令字表保留无副作用。

## 双 Agent 自进化编排与主子角色选择（2026-09-18）

### 行为与接线

- 活动中心顶部和活动分析弹窗共用配置组件及 Pinia 状态，可保存 `dualAgentEnabled/mainAgent/subAgent`。旧 `defaultAgent/agent` 迁移为主 Agent 并继续作为兼容别名；旧数据默认关闭双 Agent，不擅自改变已有每天自动任务的模式。本机推荐 Codex 主、Claude 子，也支持角色反选或相同执行器的两个独立会话。
- 新接口 `POST /api/activity/update/agents` 与旧 `/agent` 同时校验有效会话和 admin/super_admin 角色，活动/安全、自动/手动/拒绝重做统一读取持久配置；旧 `/agent` 只修改主 Agent。运行、回退重做、应用期间拒绝改配置；输入无效或持久化失败不能报保存成功。面板每 10 秒共享读取本地状态，不产生游戏上游请求，展示实际阶段与执行者。
- 双 Agent 启动前检查双方 CLI。父进程以 stdin 向独立 Node 协调进程传递任务、角色与可执行路径；不把 Prompt 放入命令参数，不在仓库记录模型、凭据或本机路径。CLI 沿用本机模型和登录配置，以及既有环境白名单、no-push hook。双方按阶段串行交接，活动与安全任务仍共用互斥锁。
- 固定流程：子 Agent `research` 广泛搜索公开 GitHub 项目并巡查 → 主 Agent `plan` 独立核实并批准具体范围 → 子 Agent `implement` 实施 → 协调进程 `verify` 实际执行串行全量后端测试（涉及前端再构建）→ 主 Agent `review` 检查完整改动并明确批准 → 协调进程 `commit` 创建本地提交。主 Agent 在方案阶段确认 `no_change` 时立即零改动收口；实施后无改动仍需主 Agent 复核。审批阶段工作区变化、越权提交、无效 JSON、测试失败或拒绝一律停止。
- GitHub 检索要求至少尝试三组关键词，最多四组搜索、十二个候选仓库，按相关性/更新情况筛选；网络或限流失败如实报告，不虚构检索成功。外部 README、issue、代码注释与子 Agent 交接均为待核实资料，不能作为执行命令或改变约束的授权。参考来源只记入 ignored 的 `client-config-evidence/sources.json`。
- 交接文本先做 URL/凭据和本机身份 denylist 脱敏，不可证明干净时停止；文本只在协调进程内存中流转。ignored 的 `logs/evolve-team-<runId>.json` 只记录角色、阶段、基线、结果 HEAD、决策和时间，原始 CLI 输出仍按既有私有日志规则处理，三天后清理。Codex 最终结果临时文件用后删除。
- 主进程重启后继续观察整个协调进程组；恢复时只有同 runId、同基线、同角色、同最终 HEAD 的完成凭据才允许进入隐私审计/推送或确认零改动。未完成流程若留下文件或提交，保持本地并阻断后续任务；没有改动可重试。运行问题批次只在已批准的零改动或应用成功时清理，失败不得清除。两小时看门狗仍覆盖整个进程组。
- 保留父进程隐私审计、SSH 推送及人工点击“应用进化”的边界；任一 Agent 都不能自行提交/推送/重启/发通知。协调进程禁止本轮修改自身、Agent 编排、隐私控制与 Git hook。双 Agent 增加模型调用和耗时，不承诺无人值守巡查一定产生可用改动。

### 踩坑与注意点

- **CLI 退出 0 不等于审批通过**：必须解析阶段约定的 JSON 决策；Claude 的 JSON 外层 `subtype/is_error/result` 与 Codex 的 `--output-last-message` 文件分别处理。只识别最终结果，不从完整日志匹配“approve”。
- **已有提交不等于双 Agent 已完成**：原单 Agent 收口允许有提交后继续审计，双 Agent 若复核未通过/协调进程退出，必须先检查完成凭据，不能直接套用旧逻辑。测试与复核前后都比对 HEAD、工作区/暂存区指纹，防止把审批套到不同改动上。
- **保存与轮询会竞态**：较早的 GET 若晚于配置 POST 返回，不能覆盖新配置；共享 store 用版本号丢弃旧状态。保存失败重新读取服务端再恢复草稿；修改要求草稿不会被后台轮询覆盖。管理员状态改变或组件卸载必须减少轮询引用，最后一个消费者退出才清定时器。
- **测试要隔离运行数据与仓库**：配置写入测试使用临时 `FARM_DATA_DIR`；真实协调进程集成测试在独立临时 Git 仓库中以模拟 CLI 验证提交/拒绝，不调用生产管理路由注册、不启动扫描/进化定时器。生产 Claude 子进程只承担本轮指定前端实现，没有提交或重启。
- **失败重试必须有上限**：既有执行器临时错误分支曾在日常重试耗尽后继续排程，本轮补上同一重试上限；不能因双 Agent 子阶段失败产生无限 CLI 拉起。

### 验证与回滚

- Node 20 串行后端全量 **428/428** 通过，新增 16 项双 Agent 回归覆盖旧配置迁移、角色反选、零改动、阶段拒绝/中断、只读越权、验证后改动、恢复凭据、配置持久化/锁定、管理员角色校验及真实协调进程的完整测试/提交流程。
- 前端类型检查与生产构建通过；修改后端 ESLint 0 error，前端 0 error（保留历史文件 143 条格式 warning，新组件/store 无 warning）。另以实际 Pinia store 验证迟到 GET 不覆盖新配置、保存失败恢复、轮询引用清理。
- 本机 Claude/Codex 非交互 CLI 均实际返回有效约定 JSON；完整生产农场巡检留给配置后的手动/每日任务，未以模拟集成测试冒充真实巡检完成。
- 本轮只修改进化编排、管理配置接口及活动页进化控件，没有修改收菜/种菜/偷菜/HOT/PREARM、请求治理、登录、设备串、TSDK/ACE 或游戏协议。提交推送前扫描可信远端基线到 HEAD 的完整范围，应用只能复用已有 `farm:0.0`。
- 回滚用 `git revert <本轮提交>` 并在已有窗格重启。若双 Agent 正在运行，先等流程收口再回滚；旧版不识别双 Agent 完成凭据，不能在执行中切回旧版接管提交。ignored 中新增配置字段可保留，旧默认执行器别名仍兼容；不要删除整个运行数据目录。

## 公开仓库隐私复核与完整提交范围检查（2026-09-18）

- 用户要求本机 Codex/Claude API 凭据、模型网关、个人身份及会话信息均不得进入公开仓库。本轮检查当前受跟踪文件与远端 main 可达的 58 个历史提交，额外将本机配置中的实际敏感值只在本地内存中逐字比对；未发现这些现用凭据、飞书 Webhook 或私有运行文件被提交。通用协议 API 名称、变量引用和官方公共资源不是私人 API 凭据，不删除业务代码。
- 确认并清理了交接文档中的个人会话编号/会话文件定位、历史案例中的好友昵称，以及测试中的个人邮箱标识。公共交接改为通用协作要求；原始内容与历史清理规则只留 ignored 的本机私有备份。网络配置示例改用文档保留地址。不要把被删除的值复述到提交说明、审计报告、测试或通知中。
- `.gitignore` 增加 Agent 配置目录、认证文件、私有配置和密钥文件。`collectLocalPrivacyTerms()` 读取默认及显式配置目录中的 Codex/Claude 认证/配置、环境变量与私有运行配置，仅提取敏感字段作本机匹配；不执行配置命令、不读取会话正文、不输出匹配值。不可读或损坏的已存在配置会停止审计，不能视为“没有凭据”。
- `auditGitRange()` 改为审阅基线到 HEAD 的每一个新增提交，包括合并侧分支的提交、新增行、所有提交的作者/提交者及完整说明、每笔提交的文件树。曾写入随后删除的秘密与被强制跟踪后又删除的运行文件仍会拦截；不能再用最终净 diff 或最后一笔提交的说明代替完整历史。
- 新增模型环境密钥、JWT、Agent 会话导出位置规则；Claude 机器尾注只豁免固定 noreply 地址，不再放行整个公司域。机器目录匹配保持大小写语义，避免把普通管理接口里的 users 路径误判为 macOS 用户目录。发现位置带提交哈希，文件名本身敏感时只显示匿名占位。
- Agent 编排、协调进程及本机隐私词提取器纳入自动进化保护文件，自动 Agent 不能修改后自行上传。本轮维护会话对这些隐私控制变更作人工审阅；日常自动进化仍无豁免。
- 踩坑：忽略规则不清除已经存在的提交；删除当前文件中的内容也不会清除旧对象。完整历史清理必须在隔离副本中预先验证，保留私有备份，且替换远端历史前需明确确认；不能在普通推送完成后声称历史已清除。旧版本代码不应通过 revert 恢复这些个人信息。
- 验证：Node 20 全量后端 **436/436** 通过，隐私/双 Agent 定向回归覆盖中间提交删除、侧分支合并、作者信息、强制跟踪私有文件、无固定前缀的本机密钥、配置损坏、文件名脱敏与合法 API 路径；相关 ESLint 0 error。未改前端或游戏收益链，不需要重建前端。
- 回滚只回退不涉及数据恢复的逻辑差异；不得重新引入已匿名化内容、移除本地凭据存储或恢复旧秘密。当前树清理与历史重写分开报告，完整审计结果只保留匿名位置/类别，私有备份禁止上传。

## 双 Agent 失败诊断、修复与验收闭环（2026-09-19）

### 本次报错的确定原因

- 首个双 Agent 安全任务在子 Agent 的 research 阶段停止：Claude CLI 外层已报告成功，但最终 result 不是阶段要求的 JSON，协调进程在 parseStageResult 拒绝后直接退出。旧日志只有固定解析错误，原最终文本没有保存，因此不能推断它具体写了什么，更不能把退出 0 当成研究已被验收。
- 根因是调用只设置 `--output-format json`，约束了 CLI 外层包裹格式，没有约束模型最终答复。现在 Claude 同时传阶段 JSON Schema 并优先读取 structured_output；Codex 使用 `--output-schema` 与 `--output-last-message`。继续严格核验 decision/summary，诊断另核验 allowedFiles，不从任意文本中搜索 approve。

### 新行为与保护边界

- 可恢复的格式、执行器、测试或复核失败进入 `diagnose`（主 Agent 定位原因/批准文件范围）→ `repair`（子 Agent 按精确范围处理）→ 实际验证 → `repair_review`（主 Agent 验收）→ 重跑原失败阶段。正常最终 review 仍必须独立执行，修复验收不能代替最终批准。
- 每次任务全局最多两轮恢复，不按每个阶段分别无限追加。诊断选择 stop 时停止；隐私未通过、HEAD 改变、只读阶段越权、修复超范围或外部终止信号不会靠自动修复绕过。已处理过的失败不再额外安排无差别整轮自动重跑；显式重试会保留失败类别，先诊断后继续。配置问题解决后不会因上轮终止状态永久锁死。
- 已由当前版本修复的旧失败也可用 `repair + allowedFiles=[]` 只读验证恢复条件，无需制造代码改动。首版只留日志的 JSON 错误按固定模式迁移为安全类别，不向 Prompt 复制日志原文、会话定位、地址或凭据。
- 子 Agent 修复只能修改主 Agent 明确列出的相对路径。每个文件的内容、权限、暂存状态都生成哈希比较，CLI 自身失败时也要先检查越权；未授权文件变化直接停止。测试结果绑定工作区指纹，相同指纹复用已通过验证，变化后必须重测。
- 只有明确批准并最终验收的 `run-evolution-team.js` / `evolution-team.js` 自修复可在本轮完成凭据中携带许可；父进程只在 runId/基线/角色/最终 HEAD 校验通过后，把这两个精确路径传给提交审计。所有新增行、历史提交、凭据、二进制与私有文件检查照常执行；发布器 activity-evolver.js、privacy-guard、local-privacy-terms、private-config、通知、Git hooks 与忽略规则不可自动修改。单 Agent 无此许可。
- journal 和页面保留固定失败 code/label、阶段、执行者、退出码、恢复次数，界面新增主 Agent 诊断、子 Agent 修复和主 Agent 验收状态。原始错误正文、CLI 响应及本机敏感路径不进入这些字段；无证据的异常使用固定未知类别，不能编造诊断结论。
- 若确实修复编排文件，当前协调进程继续使用已加载的旧模块，不能边改审批逻辑边自证通过。此时以 `repairOnly` 独立验收修复补丁并进入待应用；原任务的处理标记、增量检查点与运行问题批次都保留，应用后重新诊断恢复条件再继续原巡检。不得把“修复已验收”当成“原巡检已完成”。
- Agent 仍不自行提交/推送/重启；协调进程负责实际测试和本地提交，父进程隐私审计后推送，人工应用后才加载改后的实现。本轮维护会话已人工审查发布器与隐私许可接线变更，自动任务仍不得修改这些保护文件。

### 踩坑与验证

- 输出格式参数和模型结果 Schema 是两层约束；Claude 的普通 result 可以是说明文字，必须优先结构化字段。Codex 每次启动前移除本轮旧结果文件，临时 schema/结果文件都用私有权限并在结束后删除，避免复用过期批准。
- 修复期间拒绝未知占地、协议猜测、恢复整号熔断或收紧收益链等既有硬门均保留；诊断复用失败上下文，不能重新做不相关的全量探索。只读研究不得执行会向项目抓取图片、更新 HANDOFF 或改代码的步骤。
- 全量后端 Node 20 **451/451** 通过；针对回归覆盖结构化外层普通文本、实际协调进程的失败→诊断→修复→验收→重试、测试失败、最终拒绝、两次上限、文件范围、旧日志迁移、停止后恢复以及已验收协作文件仍拦截密钥。Claude/Codex 原生 Schema 参数均通过真实非交互调用；改动文件 ESLint 0 error，前端类型检查与生产构建通过。
- 没有修改收菜、偷菜、HOT/PREARM、请求治理、登录或设备协议。回滚使用本轮提交的 `git revert`，但不得恢复个人信息或旧历史；正在执行的修复必须先收口。部署只复用现有 farm:0.0，实际生产重试的最终状态以运行记录为准，不能用模拟测试冒充巡检完成。

## 验收失败误报、分阶段返工与部署隔离（2026-09-19）

- 本次通知并非凭据扫描命中：主 Agent 拒绝了不足以证明行为的测试，工作区有改动时却被映射成 privacy_blocked_local。新增 review_blocked 状态和独立通知标题；只在没有隐私命中、没有提交且明确为复核拒绝时迁移旧状态，真实隐私检查保持阻断。
- 旧的全局两次预算被旧格式恢复和方案拒绝消耗，实际验收缺陷没有返工机会。现在执行恢复、验收返工、只读方案修订各限两次，保留整体看门狗；方案批准前只能修订方案。主 Agent 明确 allowedFiles 和可执行 acceptanceChecks 后才允许实施，最终按同一条件验收，拒绝意见脱敏保留并直接交给子 Agent 在批准范围内返工。修改文件指纹和总改动范围持续校验，不允许借返工绕过隐私或审批。
- 保留用户已经批准的 S3 萌宠手动操作；候选中擅自删除的功能已恢复。手动操作先验证 ActivityService.List 的 groups[].activity 中存在有效活动根，再走既有 GetGroup/Operate；未知操作在编码和请求前拒绝。读写路由共享 activityReader，操作成功使实际只读缓存失效。
- 好友面板启动就绪检查覆盖实际 Worker 调用；协议加载共享 Promise，全部加载成功才发布类型，失败唤醒全部等待者且仅显式重试。普通面板读请求合并并隔离缓存代次，狗信息合并也必须更新代次，防止旧请求覆盖新缓存。没有改成熟收获、到点偷菜、HOT/PREARM、请求治理、登录或设备策略。
- 测试执行真实 Worker 函数和服务调用，覆盖启动状态、失败恢复、缓存先后完成两种顺序、第三个并发调用、替换缓存，以及普通面板请求挂起时成熟链仍前进。反向暂停对照和移除就绪 return 的变异能被测试抓住；未知操作以编码与请求计数验证零副作用，不能只检查源码字符串。
- 协调进程前端验证构建写入私有临时目录并清理；集成测试证明线上 index.html 不变。应用脚本先核对已批准 HEAD、干净工作区和既有 pane，隔离构建成功后再次核对并替换产物，最后在原窗格重启；构建失败保留旧服务，状态恢复待应用。
- 验证：Node 20 串行全量后端 485/485，通过新增的构建隔离集成回归；ESLint 无新增错误（friend-api 的六处既有未使用变量报错与 HEAD 对照一致），前端类型检查和隔离生产构建通过。发布前复核完整新增提交范围及本机隐私匹配，私有备份和运行数据保持 ignored。维护修复发布不等于原自动巡检完成，运行问题批次保留，后续按新流程继续。
- 踩坑：不能把复核失败当成隐私泄漏，也不能通过放宽审批来解决测试不足；不得重新删除用户已批准功能。共享工作区禁止 stash/reset/checkout/restore/clean 来临时撤下他人改动，历史比较应使用只读 git show 或隔离副本。验收构建不能使用默认线上输出目录。
- 回滚应只回退本轮需要撤销的逻辑并在既有 pane 部署；不得恢复已清理的个人信息、旧 Git 历史或候选中的功能删除。活动和安全自动任务仍互斥，双 Agent 配置保留，未审修改不得直接推送或应用。

## S3 操作能力提示与安慰礼文案修正（2026-09-19）

### 确定缺陷与证据

- 主 Agent 复核发现（research 轮曾被误判零改动）：活动卡顶部 2026-09-18 已上线七个已批准手动操作按钮（领养/投喂/寻宝/领狗/种子礼包/夺宝补偿/手记），但下方 11 类玩法卡仍统一渲染禁用按钮「{action} · 操作协议待确认」，`season-bear-activity.js` 的 missingEvidence 也整段宣称「所有操作协议待确认，请在官方客户端人工操作」——与既有手动能力直接矛盾。补偿按钮提示把安慰礼写成「被夺宝后的安慰奖励（如有）」，而当前官方两处说明均为「连续 3 次夺宝失败后触发夺宝安慰礼，获胜一次重置计数」（攻击方连败语义）；`pet-diary-operate.js` 用 `plunder_compensation_count` 做前置校验的行为本身正确，本轮不改。管理检查项 bear-grow/bear-raid/bear-shop 存在同类过时描述（如把已具备的元气糕/挑战书库存读取笼统写成协议待确认）。
- 证据边界：顶部按钮命令字来自官方小程序编码器证据链（2026-09-18 已登记）；最近 24h 日志有一次种子礼包手动操作成功（两次寻宝成功与另一次种子礼包成功均在该窗口之外的历史日志），证明既有手动链实际执行过，但**不构成新增写操作证据**——本轮零新增命令、零新增按钮、零自动化、零每日例行。

### 本次改动（展示层 + 数据契约，7 个文件）

1. `season-bear-activity.js`：新增 `BEAR_GUIDE_MANUAL_ACTIONS` 展示映射（grow→initialize/feed/claimDog、treasure→draw、pity→compensation、album→story、gift→seeds；其余六类为空），`gameplayGuides` 每项新增 `manualActions: string[]`；`operationSupported/statusAvailable/writeOperationsSupported` 与商城条目标记全部保持 false。missingEvidence 第 4 条拆为三条准确边界：已开放面板手动能力（列出七项）、好友交互/实时状态待证、兑换能力已具备但面板无商品入口。
2. `activity.ts`：`BearActivityData.gameplayGuides` 内联类型补 `manualActions`（getBearActivity 原样透传，controller/store 链无需改动）。
3. `BearActivityPanel.vue`：五类玩法卡用提示行「手动操作已开放：{顶部按钮标签}（上方「玩法手动操作」区）」替换原禁用按钮——卡片不新增触发入口；raid 禁用后缀改「好友交互暂未开放」、shop 改「面板暂无兑换入口」且状态行说明「当前面板仅展示商品，暂无兑换入口；状态码语义待官方样本」；商城正文「不开放兑换」改为「当前面板未提供兑换入口」；补偿提示改「连续夺宝失败 3 次后触发的安慰礼（如有可领取）」；care/escort/tactics/rank 维持禁用「操作协议待确认」。顶部七按钮、operate 事件参数、手记 prompt 流程、busy 守卫零改动。
4. `AdminActivityUpdatePanel.vue`：bear-grow/treasure/raid/pity/album/shop/gift 检查项描述修正为准确边界（已开放手动操作、库存读取已具备、好友交互暂未开放、兑换能力已具备但面板无入口）；键名与既有断言关键词（bear-album.*爪印手记、bear-tactics.*锦囊）不变。
5. `core/test/season-bear-activity.test.js`：新增 manualActions 数据契约测试——五类精确映射、其余六类为空、并集恰为七个顶部动作且全部 ∈ 现有 OPERATIONS、显式排除 exchange/battle/markStories/skipBattle、只读标记不变、missingEvidence 不再含「所有操作协议待确认」；面板源码断言按新接线更新（/disabled.*操作协议待确认/s 仍通过，raid/shop/四类卡禁用后缀保留为模板内联三元）。
6. 新增 `core/test/bear-activity-panel.test.js`：真实 Vue 渲染回归——用 web 工作区**既有**依赖（vue、vue/compiler-sfc、typescript、vue-router）在内存中编译 BearActivityPanel.vue 与 BaseButton.vue 真实 SFC（compileScript inlineTemplate → ts.transpileModule 转 CJS → vm.compileFunction 求值 → createRenderer 自定义 nodeOps 渲染），断言实际渲染树与真实点击事件链；无新增任何依赖。

### 行为验收（对应主 Agent 批准的验收清单）

- 五类卡显示对应顶部按钮标签提示、不再标协议待确认、卡内零按钮零点击处理器（提示标签逐一验证存在于顶部按钮区）；六类卡保持禁用按钮——raid「发起夺宝 · 好友交互暂未开放」、shop「兑换商品 · 面板暂无兑换入口」+ 专属状态行、care/escort/tactics/rank 原禁用文案；禁用按钮点击零 operate 事件；按钮总数 14（1 刷新 + 7 顶部 + 6 卡）锁定无新增执行入口。
- 七个顶部按钮逐个点击各自且仅产生原有 operate 事件；手记输入传 order、取消输入不触发；operating 非空时全部禁用且零事件；activity 为 null 时不渲染手动操作区（仅剩刷新按钮）。
- 补偿提示逐字断言「连续夺宝失败 3 次」语义且不含「被夺宝」；官方说明差异提示、11 类玩法流程、赛季结束提示、奖励记录区全部保留。
- 背包不可用 → 8 项资源全部「数量待确认」+「本次背包读取不可用」提示；背包读取成功 → 资源区显示真实库存、夺宝卡不再把挑战书库存列为缺字段证据；记录 claimed=null →「领取状态未知」不显示已领取；11 类卡状态行按玩法区分——五类已开放手动操作的卡说明「实时状态当前快照未展示，点击手动操作时会重新校验」（成长进度明确未展示），看护/护送/锦囊/排名说明「当前快照未提供，待官方字段证据」，夺宝说明次数与目标状态待字段证据且挑战书库存见道具库存区，商城卡说明面板暂无兑换入口——均不按 0 处理、不因顶部入口开放伪造实时状态。
- 旧数据（无 manualActions 字段）11 卡全部回退禁用按钮（raid/shop 后缀按玩法键固定，不依赖 manualActions）、渲染无 undefined/NaN；未知动作值被过滤——不显示裸动作键、不新增可执行按钮、顶部 7 入口不变。
- 变异对照：把补偿提示改回旧文案时渲染测试立即 1 条失败、恢复后 5/5 通过——断言检查真实渲染输出，不是源码字符串匹配。

### 复核返工修正（2026-09-19，主 Agent review 三项缺陷，repair 阶段）

- **缺陷 1（状态与库存提示不准确）**：玩法卡状态行统一写「当前状态待官方字段证据」，missingEvidence 也把成长/寻宝/安慰礼等状态统称尚未确认——但这些字段（成年阶段、投喂/寻宝次数与消耗、手记与礼包领取态、夺宝补偿数量）已由 pet-diary-operate 解析用于操作前校验，缺的只是只读快照展示；夺宝卡还把挑战书库存列入待字段证据清单，与资源区背包读取的库存直接矛盾；管理检查项 bear-grow 更错误宣称「成长进度状态随背包读取展示」（归一化模型不返回成长进度，背包也不提供）。修复：`season-bear-activity.js` 的 raid missingState 移除挑战书库存（库存由资源区背包读取展示、失败保持未知不补零），missingEvidence 第 1 条改写为「已由操作服务解析并用于操作前校验，当前只读快照未展示 + 元气糕与三档挑战书库存随背包读取、失败不补零」的准确边界；`BearActivityPanel.vue` 新增 `stateNoteFor()` 按玩法区分三类状态行（已开放手动操作 → 快照未展示、点击操作时重新校验；夺宝 → 次数与目标状态待字段证据、挑战书库存见道具库存区；其余未开放 → 待字段证据），shop 卡沿用面板无兑换入口专属说明；管理检查项 bear-grow/treasure/pity/album 同步改为「由操作前校验读取、当前快照未展示」。零新增状态请求、零新增按钮/命令/自动化，七个顶部操作按钮行为不变。
- **缺陷 2（未知动作键原型属性漏过）**：`manualLabelsFor` 原实现直接索引 `MANUAL_ACTION_LABELS[key]` 再 `filter(Boolean)`，manualActions 含 `toString`/`constructor` 等原型属性键时会读出继承函数，join 后把「function toString() { [native code] }」当「手动操作已开放」提示展示。修复：过滤改为 `Object.prototype.hasOwnProperty.call(MANUAL_ACTION_LABELS, key)` 只接受标签表自有键（web tsconfig lib 为 ES2020，`Object.hasOwn` 不可用）；渲染测试加入 `['bogus_action','toString','feed','constructor']` 混合输入与纯原型键输入，断言不出现 native code 文本、不出现裸键与虚假开放提示、回退禁用按钮、顶部七入口不变。变异对照：旧实现经 node 复现确认会输出原生函数文本，新断言可捕获。
- **缺陷 3（HANDOFF 证据误述）**：本条目曾把窗口外的寻宝成功写成「最近 24h 内」，且「11 类卡状态行均说明当前快照未提供」与实际模板输出不符。已按明确时间窗口重新汇总修正（窗口内一次种子礼包手动成功；两次寻宝成功与另一次种子礼包成功在窗口外的历史日志），展示验收结论同步改为与返工后的真实组件输出一致。
- 返工行为验收（真实渲染）：库存成功与失败两种输入均覆盖——成功时资源区显示真实数量、夺宝卡不再把挑战书库存列为缺字段证据；失败时 8 项资源全部「数量待确认」+「背包读取不可用」提示；成长进度卡明确「当前快照未展示」不伪造；全部 11 类卡状态行不再出现旧文案「当前状态待官方字段证据」。

### 踩坑与注意点

- **展示层不得在协议已具备时宣称协议未知，也不得反向把文案当协议授权**：manualActions 只是镜像顶部已批准按钮的提示字段，不得据此新增命令或自动化；以后给它加新键必须同时存在于面板 MANUAL_ACTIONS 与 pet-diary-operate OPERATIONS 白名单，且不得含 exchange/battle 等未开放动作。
- **状态描述必须三态区分，不能统一写「待官方字段证据」**（2026-09-19 返工教训）：「操作服务已解析用于前置校验的字段（成年阶段、投喂/寻宝次数与消耗、手记/礼包领取态、补偿数量）」≠「协议未知」≠「快照已展示」。缺的是只读快照展示时，正确表述是「当前快照未展示、操作前会重新校验」；背包可读的库存（元气糕/挑战书）不得再列入玩法卡缺字段证据清单（库存归资源区，失败保持未知）；管理检查项也不得宣称归一化模型没有返回的状态「随背包读取展示」。
- **标签表查外部输入必须用自有属性判断**（同日返工）：`Object.fromEntries` 生成的对象仍继承 `Object.prototype`，直接索引 + `filter(Boolean)` 会让 `toString`/`constructor` 等原型键泄漏原生函数文本并误报「已开放」。用 `Object.prototype.hasOwnProperty.call`（web lib 为 ES2020，`Object.hasOwn` 类型不可用）；测试必须覆盖原型键与正常键混合输入。
- **卡片入口与顶部入口不重复接线**：玩法卡内不新增任何可点击执行入口，操作唯一入口仍是顶部「玩法手动操作」区（每次操作前重读状态做前置校验的语义不变）。
- **真实 Vue 渲染测试的实现要点**：① mountText 不调用 setText，初始文本经 `createText(text)` 传入——自定义 nodeOps 的 createText 必须接收参数，否则按钮文本恒为空；② ESM 编译产物用 typescript.transpileModule 转 CJS（模块对象需 `__esModule` + `default`；'vue'/'vue-router'/'@/…vue' 由测试加载器解析到 web 工作区真实包，vue 与 vue-router 经 .pnpm realpath 共享同一模块实例）；③ 动态求值用 `vm.compileFunction` 而非 `new Function`（antfu eslint 禁 no-new-func）；④ `vue-tsc -b` 只写 node_modules/.tmp（ignored），不会覆盖 web/dist 线上产物——验收生产构建必须写私有临时目录。
- **渲染测试 guideCard 必须按标题前缀匹配**：成年寻宝卡的步骤文本含「宝藏护送」字样，includes 会命中错误卡片。
- **如实记录操作测试覆盖率**：现有 pet-diary-operate 测试覆盖 draw 成功路径、battle 拒绝（零编码零请求）、feed 成年段拒绝、draw 余额不足、命令字白名单值与仅 List/GetGroup/Operate；initialize/claimDog/seeds/story/compensation/exchange 的完整前置校验路径未被现有测试覆盖。本轮不改操作服务，交接不得夸大覆盖率。
- 该渲染测试依赖 web/node_modules 的存在（本机为 pnpm 工作区）；CI/全新克隆需先安装依赖才能跑全量 core 测试。

### 验证与回滚

- Node 20（v20.20.2）`node --test --test-concurrency=1 test/*.test.js` 串行全量 **491/491** 通过（485 基线 + 1 后端契约 + 5 渲染；2026-09-19 返工扩展既有用例断言、未新增用例数）；S3/pet-diary/session 相关定向 **54/54**；web `vue-tsc -b` 类型检查通过（未运行 vite build——生产构建按批准由协调进程写入私有临时目录，线上 web/dist 未动）；改动文件 ESLint **0 error**（BearActivityPanel 仅剩既有 1 条 UnoCSS 顺序 warning，AdminActivityUpdatePanel 保留该历史组件既有格式 warning；core 改动文件零输出）。
- 本轮未修改 pet-diary-operate.js、pet-diary.proto、worker.js、请求治理、调度、成熟墙钟、登录、编排、隐私控制、EventItems/EventPlants/图标；未新增按钮、命令、自动任务或每日例行。工作区差异仅上述 7 个批准文件。
- 回滚 `git revert <本轮提交>`：恢复玩法卡统一「操作协议待确认」、missingEvidence 笼统宣称、补偿提示旧语义与管理检查项旧描述；不得借此删除顶部七个已批准手动按钮或 pet-diary 操作链（属 2026-09-18 的独立提交，须单独评估）。应用或回滚只能在既有 `farm:0.0` 窗格完成；本轮 Agent 不提交、不推送、不重启（本地提交由协调进程在主 Agent 复核后统一执行）。
- 遗留待证项不变：挑战书三档/幸运星/bichon/leyuan 专属图待抓包会话取证；种子目录 21 条历史待证基线维持；daily_share 成功回包解码待 ShareService 回包样本；商城状态码语义待官方样本。

## 每日交互反馈、按逻辑版本验证与扩大公开项目发现（2026-09-20）

### 行为与证据边界

- 用户要求把每天的面板点击和错误作为反馈，并在代码变化后重新完整验证。新增本机 `daily-feedback` 日流水：页面与控件类别、随机交互关联号、后续管理请求的路由模板、固定操作名、耗时、HTTP/业务结果、固定错误类别，以及运行告警/错误。字段全部白名单重建，不记录元素文字、输入值、请求/响应正文、账号/好友、动态路由参数、查询串、错误原文、堆栈、凭据或地址。
- 浏览器捕获交互，用短时随机关联号连接其后请求；这是交互时间窗口内的关联线索，不宣称所有背景请求都由该点击直接造成。无关联且成功的后台轮询不记录；所有写请求及失败读取均记录。业务 `ok:false` 即使 HTTP 200 也记失败，部分失败与 202/started 的「已接收」独立记录，连接中止记 aborted，finish/close 只记录一次。已有普通运行日志继续用于本机定位，不能把原文复制到模型交接或公开提交。
- 流水按 UTC 自然日切分，仅留最多 72 小时（整日文件清理可提前移除已超过 48 小时的部分记录），单日最多 12 MiB，内存缓冲有上限；最近 24 小时摘要持续更新并在每日巡检读取。文件仅在 ignored 运行目录，0700 目录/0600 文件；采集失败不改变业务结果，摘要显示丢弃或不可读记录数量。前端上报批次、队列和速率均有界，上报失败不递归弹错或循环重试，后续交互/恢复联网时再发送；关闭页面或长期断网可能丢失尚未送达的反馈，不能声称采集覆盖率为 100%。
- 完整回归记录由协调进程维护：源码、测试、配置、依赖锁、验证/部署脚本和 Node 版本共同生成内容指纹。首次运行或逻辑变化时执行全部已登记后端测试、前端类型检查和隔离生产构建，成功且执行前后指纹一致才缓存；未变指纹跨日复用，失败/中断/损坏记录不能当成功。即使方案最终 no_change，双 Agent 也先建立该版本的验证证据；基线验证失败进入主 Agent 诊断 → 子 Agent 修复 → 实际重验 → 主 Agent 验收。
- 「全部已登记测试通过」不等于全部业务路径已覆盖。每天仍须逐项分析新点击/错误、未观察到的路径和既有未决项；新增问题由子 Agent 用隔离行为测试复现，新增测试会改变指纹并触发重验。不得为遍历逻辑重放线上购买、领取、种植或其他消耗/写操作，不改收菜、偷菜、HOT/PREARM 的既有调度与优先级。
- 公开项目发现固定包含 `公开参考项目 1` 与 `公开参考项目 2`，每日至少尝试六组关键词并发现新候选，比较候选 SHA 变化；当日检索结果可复用，但次日仍重新发现新项目。查询有请求、响应大小、时间和候选上限，403/429、超时或部分失败如实保留状态。只记录合法仓库名、SHA、时间和固定状态，不保存任意 API 原文或外部描述，不携带本机认证。
- 元数据发现不等于审阅源码：子 Agent 根据新反馈、更新 SHA 和新候选继续只读深入对照，主 Agent 独立核实证据与适用性。外部代码不执行、不安装依赖、不新增 remote，也不充当协议写操作证据。验证缓存、检索与反馈脱敏控制纳入自动进化保护文件，本轮由维护会话人工审查，自动 Agent 不能改规则后自证通过。
- 面板展示最近 24 小时点击/相关请求/异常计数、回归状态及发现查询状态。原双 Agent 角色选择、阶段审批、隐私扫描、SSH 发布与人工应用边界保留。

### 踩坑、验证与回滚

- 不能用 HTTP 成功替代业务成功，也不能把 accepted 当已完成；原始错误应在本机已有日志按时间追查，每日摘要只留固定原因。非法关联号不能把成功轮询伪装成点击反馈。浏览器上报只允许 click/client_error，禁止伪造后台 request/runtime 结果；上报端点不记录自身，避免递归放大。
- 测试必须在独立 FARM_DATA_DIR 与临时 Git 仓库执行，不能污染生产反馈。缓存依据内容而非日期、mtime 或 HEAD；只改文档不会让已经验证的业务逻辑反复运行，修改测试或依赖则必须重验。验证构建只写私有临时目录，不替换线上 web/dist。
- 验证：Node 20 串行完整后端 531/531 通过，前端类型检查及隔离生产构建通过，修改文件 ESLint 无错误；真实运行验证器后再次调用确认同一指纹直接复用、零重复执行。新增行为覆盖真实 HTTP/点击与 Axios 链、失败分类/中断、隐私字段过滤、日轮转/容量、缓存失效/构建隔离，以及公开检索预算/限流/不完整响应/跨日变化。实际匿名公开发现拿到两个指定仓库的 SHA、23 个候选，其中 3 个新候选取得 SHA；六组查询成功四组，另两组超时，如实记 partial，不冒充完整检索或源码已审。回滚只撤销本轮采集/验证/发现接线，不删除账号数据、既有功能或待处理问题，私有日流水可留待自动过期。应用及回滚仍复用已有 farm:0.0 窗格，不能恢复旧隐私历史。

## 主 Agent 每日复盘、24 小时反馈与重点施肥监控修复（2026-09-20）

### 职责与反馈生命周期

- 用户明确希望实际每日运行成为生产验收样本，Codex 做诊断、方案、验收及提示词/经验复用，Claude 做检索、复现和实施。原流程虽有主 Agent 计划/复核，但研究先启动且没有明确经验沉淀。本轮新增只读 `triage` 阶段：当前配置的主 Agent 先核对每日反馈和历史经验，再给子 Agent 明确问题；保持角色选择功能，当前仍为 Codex 主、Claude 子。
- 主 Agent 的 no_change 计划或最终 approve 复核输出 `lessons`、`feedbackReviewed`。只有真实验证、完整批准且发布/零改动成功，父进程才接受主报告；拒绝、隐私阻断、推送失败、repairOnly、主角色或 HEAD 不匹配均不能写经验或清反馈。旧 journal 没有反馈确认字段时默认不清。经验只保存固定主题、脱敏规则、证据类别、时间和已审提交，最多 40 条；后续提示词引用最近 12 条，不能把历史经验当新授权或替代固定保护规则。
- 新增可复用 `docs/skills/farm-evolution-review/SKILL.md`，规定主/子职责、真实运行与离线测试的证据边界、监控故障的分层诊断、反馈清理及经验质量；本机 Codex 通过私有技能目录链接可发现它。没有新经验时允许空数组，不为每日记录制造文档或代码提交；需要改长期文档/skill 时由主 Agent 批准范围、子 Agent 实施、主 Agent 验收。
- 按用户最新要求，**每日反馈**由旧 72 小时改为 24 小时，跨 UTC 日期也按事件时间过滤，不能整天误删仍在 24 小时内的行。主进程每分钟维护，读取快照时再按当前时刻精确过滤。任务开始捕获时间水位，完整反馈验收成功后立即清理已处理范围；进化期间产生的新事件保留，未完成验收不主动清除，仍受 24 小时上限约束。发布成功待应用只说明离线修复通过，不冒充生产修复效果已观测；既有运行问题收件箱仍遵循应用后确认规则。
- 私有锁与持久水位防止清理/多进程追加竞态及迟到缓冲复活旧记录；争用不阻塞业务，保留队列并重试。确认持锁进程已退出才回收残锁，不能靠超时抢占活进程。坏锁或同宿主尚活的终止线程残锁保守等待检查/宿主退出，摘要明确不可读。文件保持 0700/0600，清理不触碰其它运行数据。
- 性能硬点：游戏 Worker 的 500ms 缓冲 flush 只读小水位和末尾一个字节并追加新行，不扫描/重写整天日志。全天清理/汇总在主进程维护及显式快照/验收时执行，快照缓存 10 秒；不能为增加可观测性拖慢成熟唤醒。

### 重点好友施肥没有提示的确定缺陷

1. `applyStealScheduleFromFriends` 实际传 `Set`，而 `setPriorityGids` 原来只接受数组，导致重点身份被清空。现兼容数组/Set，其余输入不作为 ID 迭代；实际调用链验证重点目标 6 秒成熟提前触发敏感阈值、普通目标不误触发，移出重点后身份消失。
2. 未知/窗口外目标在持续 slowdown 时，每到期都再次设置更晚时刻并 continue，连续四次到期可完全不访问。现先按已到期基线尝试，额外降速只追加到实际尝试后的下一间隔；观察窗与 HOT 不加延迟，实际入口仍受预算/免打扰/成熟收益优先级保护。
3. 原进门失败一律以未知成熟时刻排 5–8 分钟，导致已知观察窗内目标单次失败就退慢档。现基于仍可信的成熟墙钟维持原有 45–75 秒档，未知/窗口外继续慢档。保留用户实际配置的观察窗口，不把不同账号窗口统一改成默认值。

- 用户补充约三小时前完全没有施肥提示；所指时间附近的匿名日志没有重点触发记录，但旧日志不记录每次成功无变化的基线读，无法证明该次具体何时施肥或哪一次访问漏掉。以上三处均由真实源码函数/模拟时钟复现，不能把代码缺陷推断成已还原该次游戏全过程。
- 新增每次实际重点巡田的匿名健康日志与日反馈：只记成功/失败、基线/观察窗档位、下次等待，不含目标身份/回包。mode 按访问后得到的成熟时刻计算。该统计让每日主 Agent 区分「没有执行」「执行失败」「执行但没有新施肥证据」。首次部署没有自然施肥事件时，不能伪造 HOT 命中。
- 没有调整 HOT 首次/重查、PREARM、自己收菜/偷菜的既有时序、通信硬预算、登录、设备或游戏协议；也没有用线上账号主动触发施肥或枚举请求。直接催熟到已成熟的判定边界仍需自然证据，不能在本轮无回包证据时改掉防自然成熟误报的条件。

### 验证与回滚

- 验证：Node 20 串行全量后端 572/572 通过，前端类型检查与隔离生产构建通过，修改文件 ESLint 无错误；真实验证器再次调用确认同一指纹直接复用。独立行为回归覆盖真实配置→名单→施肥识别、真实巡田→访问→模拟预算门、多次降速到期、访问失败档位、自己成熟/偷菜/免打扰优先级，以及反馈跨日清理、并发/迟到写入和主报告身份/HEAD 绑定。技能通过官方 quick_validate 检查；它只是工作方法，不代表测试覆盖全部业务。
- 回滚用本轮提交的针对性 revert 并在既有 farm:0.0 应用，不恢复私有历史或删除账号数据；24 小时反馈清理本身不可回滚恢复，经验/水位保留在 ignored 运行目录。正在执行的自动任务必须先收口，旧协调器不能接管新版阶段状态。

## 私有参考名单、最新更新发现与活跃度采样（2026-09-20）

- 用户要求扩充参考并关注更新频率，同时明确只移除用于借鉴的 GitHub 地址/仓库名，保留代码路径、提交定位、问题说明和运行必需公共地址。本轮固定参考名单从源码迁到 ignored 私有配置 `evolutionReferenceRepositories`，本机别名映射保存在 `evolutionReferenceAliases`。公开说明、服务注释和图标来源清单用别名；原提交 SHA、资源路径、资源哈希及功能行为保留。依赖锁、官方资源与程序必需地址未作全量删除。
- 检索的六组关键词包含 qq-farm，全部按最近更新排序，最多保留并交接 40 个候选，避免只给模型前 12 个而遗漏其余候选。固定项目与最新候选读取最多 20 条近期提交，记录七天窗口内的样本提交数、活跃日期数和采样上限标志，不保存作者、邮箱、提交原文或外部描述。到达样本上限是下界，缺日期保持未知，不能把未知写成零更新。
- 完整候选要逐项初筛；优先深入已更新重点项目和新候选，结论区分有借鉴线索、已有等价实现、待证/未深读。每批深入比较仍有数量和总超时限制，未读部分留在本机待评估记录，不得冒称全覆盖；同 SHA 且有主 Agent 确认的旧比较才可复用。最多 24 次匿名发现请求、45 秒预算，限流立即停止，部分响应或超时明确标 partial，不带本机认证去访问外部项目。
- 私有配置/查询策略指纹参与当日缓存判定，新增参考或升级策略当天也会重新发现；旧记录仍用于来源和 SHA 去重，不以旧“见过”记录冒充源码已审。已配置及已发现的农场参考标识纳入公开新增行隐私匹配，防止以后又写回公开文档。参考身份是发布约束，不妨碍私有模型上下文中的实际只读检索。
- 本轮已对新增参考的三个近期改动做只读源码比较：成熟感知调度在本地已有更完整墙钟/HOT/PREARM 实现；移动端四格图片约束已有等价处理，均无证据需要重复移植。暂时没有分享资格是否应被视为当日完成值得继续核对，但官方回包语义仍待证，不据外部实现新增领取重试。具体来源映射仅存私有证据；可复查本地 `core/src/services/share.js` 与 `core/src/core/worker.js` 的完成态路径。没有改已批准的活动操作、监控、收益调度、登录或协议。
- 踩坑：只按星数/少量头部结果取样会漏掉新近更新；只知道仓库最后推送时间也不能证明持续维护。缓存策略变更不能等到次日才生效；提交列表中的作者/消息不能原样落到公开报告。参考匿名化不能删掉定位所需的源码路径和提交锚点。
- 验证：Node 20 全量后端 577/577 通过，前端类型检查与隔离生产构建通过，改动文件 ESLint 无错误，skill 校验通过；当前逻辑指纹的成功结果可复用。实际发现完成六组查询、获得 28 个候选，三个私有重点项目均取得最新提交，10 个候选有可用提交活跃度样本；部分详情请求超时，结果诚实保留 partial。已核对匿名化前后图标资源路径、提交锚点及哈希完全一致。回滚只撤销检索策略差异，不能把参考地址/仓库名写回公开文件，也不删除本机私有配置或历史映射；原运行反馈和未完成巡检继续保留其既定生命周期。部署复用已有 farm:0.0。

## 萌宠手动操作业务错误跨 Worker 传递修复（2026-09-20，双 Agent implement）

### 确定缺陷与证据边界

- 确定的代码级信息丢失链：萌宠手动操作服务抛出的业务前置拒绝带 `business: true` 与固定 `code`（PET_DIARY_* 前缀）；`worker.js` 的管理 RPC `handleApiCall` catch 后只回传 `err.message` 字符串；`worker-manager.js` 的 `api_response` 处理把它重建成普通 `Error`；活动路由按 `err.business` 区分 400（业务拒绝）与 502（服务故障）。因此既有业务拒绝一律被面板误报为 502/unknown，掩盖真实上游故障信号。
- 本轮反馈窗口内九次萌宠操作失败（投喂、领狗、种子礼包、补偿各 2 次、初始化 1 次，均为 58–99ms 快速失败）**具体拒绝条件未知**：当时日志没有保存各次业务拒绝原因，不能全部认定为限额/已领取类正常拒绝，也不能认定为上游 502。本修复只还原「业务拒绝可被正确分类」，不宣称已还原该九次的失败原因。
- 不修改反馈分类器、清理规则或活动操作服务本身；七项已批准手动按钮、List/时间校验、余额/次数/状态校验、失败不自动重试、活动读缓存全部保留。

### 本次改动（管理通道三处最小修复，非收益链）

1. `worker.js` 仅改 `handleApiCall` 错误收集与 `api_response` 构造：新增 `collectPetDiaryErrorMeta()`，只在 catch 到 `business === true` 且 `code` 匹配 `^PET_DIARY_[A-Z0-9_]{1,48}$` 的固定业务码时附加 `errorMeta: { business, code }`。不序列化整个 Error、堆栈、cause 或任意附加属性，不扩大到其他业务错误；成功响应与旧式 error 字符串响应格式不变（无 errorMeta 字段）。
2. `worker-manager.js` 仅改 `api_response` 错误重建：`normalizePetDiaryErrorMeta()` 用同一格式校验（严格布尔 + 限定码格式；数组/缺失/畸形/超长/非字符串一律不认），校验通过才给重建的 Error 恢复 `business`/`code`。请求关联、超时清理、成功返回、并发/乱序/重复/迟到响应与生命周期代码逐字不变。
3. `admin-pet-diary-operate-routes.js` 仅改 catch 分支：验证后的业务拒绝返回 HTTP 400、`ok:false`、原有提示和固定 `code`（新增字段）；普通传输失败或未知异常仍为 502 且不带业务码。不按错误文字猜业务类型、不改成成功、不加自动重试。权限校验、运行状态校验、成功缓存失效流程原样。

### 跨层行为回归（新增 `core/test/worker-api-error.test.js`，14 条）

真实调用链：真实活动服务（仅模拟游戏传输边界）→ 从 worker.js 提取的真实 `handleApiCall`（vm 沙箱，本地消息通道分别按 **JSON 序列化往返**与 **structuredClone** 两种 Worker 传输形态模拟）→ 真实 `createWorkerManager` 的 `api_response` 错误重建 → 真实活动路由。覆盖：

- 业务前置拒绝（feed 成年段拒绝）跨层得到 400 + `PET_DIARY_INVALID_STAGE` + 原有提示；前置拒绝只发生必要状态读取（List+GetGroup），操作编码与写请求为零，无自动重试。
- **传输失败三处分别覆盖（List / GetGroup / Operate 读取与发送失败，两种传输形态共 6 条）**：跨层仍为 HTTP 502、`ok:false`、无业务码、零重试，全部调用仍在原 `ActivityService` 接口（记录每次调用的 service 名断言不切换接口）；Operate 发送失败明确写请求已尝试恰好一次（List+GetGroup 前置读取 + 一次 Operate），不得描述为零写请求。
- 跨层成功返回原有结果与奖励结构，写请求恰好一次（List+GetGroup+Operate）。
- 元数据两种传输形态保留；缺失 business、business 非严格布尔、code 非字符串/超长/前缀不符、数组形态均不当业务拒绝；额外属性（stack/cause/extra）不透传。
- 并发、乱序响应、重复响应不串单不重复完成；超时后迟到响应无副作用且不遗留计时器；成功响应原样返回。
- 旧式仅含 error 字符串的响应仍正常拒绝为普通 Error（账号未就绪路径语义不变）。
- **跨层成功使读写路由共享的真实活动缓存失效（真实读写链）**：写路径为真实 `runManualPetDiaryAction`（经 handleApiCall/管理器/操作路由）；读路径为真实读路由 + 同一 Worker 管理通道的 `getBearActivity` → 真实 `readPetDiaryGroup`（同一上游传输边界读 List+GetGroup），两者共享同一 `activityReader`。断言一次写、原有结果与奖励字段、成功后新状态读取（`upstreamCached:false`）、失效前挂起的旧读取返回旧状态但不回写缓存、再读命中缓存中的新值不再打上游；上游调用序列精确锁定（3×List + 3×GetGroup + 1×Operate），无重试、无额外刷新。

### 前置校验与缓存行为扩展（`pet-diary-operate.test.js` +2、`pet-diary-cache.test.js` +1）

- 逐项覆盖 initialize（已领养）、feed（成年后拒绝、幼年次数已满、幼年空背包余额不足）、claimDog（未成年、已领取）、seeds（无可领礼包、已领取）、compensation（无可领补偿）、story（编号无效、未解锁、已领取、不存在）、exchange（商品编号无效、商品未下发、钻石成本、钻石货币成本、限购、余额不足）前置拒绝：全部携带 `business: true` + 固定 code + 原有提示，且零操作编码、零写请求。
- **逐场景精确读取计数**：每个前置拒绝断言恰好 `['List','GetGroup']`（重复读取任意次都会失败，不再是"调用名属于读取集合即通过"）；背包读取按场景精确断言（仅 feed 余额校验与 exchange 余额校验各读一次，其余拒绝零背包读取）；compensation/story/exchange 成功路径同样断言精确调用序列与背包读取次数（0/0/1）。
- 「写请求已发送后响应不匹配」：`PET_DIARY_REPLY_MISMATCH` 失败保留、写请求恰好一次、无自动重试——此类失败是发包后失败，不得描述为发包前拒绝或零写请求。
- 业务拒绝（400+code）、传输失败（502）、账号未运行（409）均不清除成功读缓存、不触发额外刷新或写请求；成功操作仍正常清缓存（既有行为）。权限拒绝零 Worker 调用由既有用例继续覆盖。

### 验证、边界与回滚

- Node 20（v20.20.2）`node --test --test-concurrency=1 test/*.test.js` 串行全量 **594/594** 通过（基线 577 + 新增 17：worker-api-error 14 条、pet-diary-operate 扩展 2 条、pet-diary-cache 扩展 1 条）；新增/扩展定向全部通过；`friends-panel-readiness` 的 vm 提取（worker.js 源码切片）不受本次新增段影响。本轮 repair 未改前端与源码业务逻辑（仅测试与文档），协调进程已完成前端类型检查与隔离生产构建（线上 web/dist 产物未动）；本轮差异后的新逻辑指纹由协调进程按登记流程重验。本轮不重启 Bot、不提交、不推送——本地提交由协调进程在主 Agent 复核后统一执行。
- **repair 轮修正（2026-09-20，主 Agent review 拒绝后返工）**：补齐三处传输失败（List/GetGroup/Operate）的真实跨层覆盖并把「Operate 发送失败 = 写请求已尝试一次」明确入断言；把原缓存用例从局部模拟 provider 升级为真实读写链共享 `activityReader`（此前用例只在路由层直接模拟 provider 增加版本，未经 handleApiCall/管理器，本文档曾将其误述为完整跨层验证）；pet-diary-operate 拒绝场景从"调用名属于读取集合"改为逐场景精确调用序列与背包读取计数；修正本文档此前文件数量误述。实施期间修正测试自身两处笔误（Operate 模拟路由返回结构、读路径版本取值少一层字段），服务实现零改动。
- 工作区差异仅涉及批准文件共七个路径：三个源码文件（`worker.js` 管理响应错误段、`worker-manager.js` 管理响应错误重建段、`admin-pet-diary-operate-routes.js` catch 分支）、三个测试文件（新增 `worker-api-error.test.js`，扩展 `pet-diary-operate.test.js`、`pet-diary-cache.test.js`）与本文件；其他调度、生命周期与游戏传输代码逐字不变。核心收益链（自己成熟前 10 秒预留与 30–80ms Harvest、好友到点偷菜、重点 HOT/PREARM、请求治理、登录保活、设备串、TSDK/ACE）零改动。
- 本轮未决反馈（仅记录待处理，不要求本轮代码修复）：前端离线窗口的种子列表轮询噪声（下游定时器未检查账号运行状态）、15:39 一次背包网络失败后的五次 unknown 归因待复现、三条无请求归属的客户端 network_error、七次无关联请求点击（含两次导航与五次按钮）的覆盖缺口。
- 待应用生产验证：修复未在运行中进程加载；下一轮反馈应观察萌宠操作业务拒绝是否返回 400+固定码而非 502/unknown，九次现场失败归因仍未知。
- 回滚 `git revert <本轮提交>`：恢复业务拒绝一律 502/unknown 的旧行为（跨层元数据丢失），不影响活动操作能力本身；不得借回滚删除七个手动按钮或修改 pet-diary 操作服务。应用或回滚只能在既有 `farm:0.0` 窗格完成。
- 遗留待证项不变：挑战书三档/幸运星/bichon/leyuan 专属图、种子目录 21 条历史待证基线、daily_share 成功回包解码、商城状态码语义。

## 设置页背包种子读取就绪守卫（2026-09-21，双 Agent implement）

### 确定缺陷与证据

- 设置页 `useStrategySettings.ts` 的种子首取（watchEffect）与 15 秒轮询（setInterval）只检查 `plantingStrategy==='bag_priority'` 与当前账号选择，不检查账号运行态。账号离线时后端对 `GET /api/bag/seeds` 固定返回 `ok:false`「账号未运行」JSON，Express ETag 使后续轮询变 304（连响应体都不重发），反馈中间件把它记成 failed/not_ready——最近 24h 的 416 项失败计数中 323 项（约 78%）是这一处噪声，间隔中位数约 15 秒。上游零请求（管理转发在 Worker 不存在时提前拒绝），但持续制造噪声并可能掩盖真实失败；这是 triage/research 两轮确认、主 Agent plan 批准的修复范围。
- 主 Agent plan 同时纠正了上轮交接中的四处误述，此处按证据重述：截止前最新版本的萌宠操作只有四次结果（投喂、领狗各一次 HTTP 400/rejected，寻宝、种子礼包各一次成功响应；没有「补偿」结果），旧版本九次 502 的具体业务原因仍不可还原；背包五次快速失败与「一次网络失败后 60 秒失败冷却」路径高度吻合，但缺少逐次响应与隔离跨层复现，现场归因未闭合（本轮未修，错误分类方案未获批准）；活动页一条 network_error 时间上接近「应用进化」重启，不能据此断定为重启瞬时错误，11 次无关联请求点击仍待分类；`getGenericFallbackItemIds()` 为空不能证明活动图标齐备（三档挑战书、待护送宝藏、部分变异果实仍缺专属图）。

### 本次改动（批准范围四个文件）

1. `web/src/views/Settings.vue`：从既有 `accounts` 列表与当前选择派生严格运行态 `currentAccountRunning`（`running === true` 才为 true；账号缺失、未运行、无选择均为 false），传入真实 `useStrategySettings`。复用账号列表既有约 3 秒轮询，不新增任何状态请求。账号 watch 源改为归一化标识（`String()`），同一选择的类型变化不触发重置/配置重载/种子重读。
2. `web/src/composables/settings/useStrategySettings.ts`：
   - 新增 `bagSeedFetchEligible` computed（`bag_priority` + 有选择 + 运行态 true）与 `invalidateBagSeedRequests()`（递增请求代次、放弃在途请求并清 loading）；
   - 三个触发入口（就绪 watcher / 15 秒周期 / 显式重置）统一走 `requestBagSeeds()` 守卫入口（详见 repair 轮修正）：不满足条件不读；当前选择已有在途请求不重复发起；同拍双触发也只读一次；
   - 旧 watchEffect 改为对运行态/策略的 watch（immediate，post flush）：满足条件立即读取一次，失格立即放弃在途请求；账号列表每 3 秒整体替换对象（running 不变）不触发首取；
   - `onScopeDispose` 清定时器并放弃在途请求；`resetStrategyState`（账号切换/应用默认方案）无条件递增代次并放弃全部在途请求（同一选择的在途请求也不得复用，其迟到成功/失败/finally 不得回填新草稿），条件仍满足时立即读取一次新代次（最终行为见下方「repair 二次返工」）；
   - 旧代次请求的迟到成功/失败/finally 按「在途代次 + 账号 + 当前选择」三重校验丢弃，不改当前种子数据、优先序、已知集合、错误与 loading。
3. `core/test/strategy-settings-readiness.test.js`（现为 19 条，见下方返工记录）：内存编译真实 composable 与真实 `Settings.vue`（复用 bear-activity-panel 的 SFC/TS 编译 + 自定义 nodeOps 渲染模式），`@/api` 为可控 mock、vue-router 与子组件 stub、假 setInterval 时钟按全局累计时间触发 deadline、真实账号 store 驱动选择切换。覆盖：未运行/无选择/非 bag_priority/运行态字段缺失四个截止零读取；恢复运行立即恰好一次后按 15 秒周期；在途跨三周期仍一次；失败无自动重试；在线转离线迟到成功/失败不回填且重新上线恢复；离线编辑保存不触发读取/不清优先序/无状态请求；账号切换旧代次不覆盖新代次与字符串/数字统一标识；同一选择挂起时重置形成新代次、旧迟到成功/失败/finally 均不回填；退出/返回策略、不满足条件的重置、卸载后零读取；迁移追加含四格种子与列表外展示语义；真实 Settings 接线（离线 bag_priority 切运行选择立即恰好一次、类型互换不重读、切走切回旧代次不覆盖）。

### 验证与边界

- 验证轮次须区分：implement 轮协调进程实际完成后端串行全量 **607/607**、web 类型检查与隔离生产构建；首次返工（repair 轮）后协调进程实际完成为后端 **612/612** 及同样的前端检查（线上 web/dist 未动）；本轮二次返工后的完整回归、隔离生产构建与新逻辑指纹由协调进程按登记流程重新执行，子 Agent 只跑过定向与类型检查/lint（见二次返工记录），不冒充全量。
- 本轮只改设置页读取与草稿隔离：背包优先列表仍只决定顺序、全部已识别种子继续参与原种植逻辑（含 2x2 预留路径）；上游 60 秒面板缓存与内部种植新鲜读取、种植/收菜/偷菜/重点 HOT/PREARM、请求治理、登录、设备串均零改动。`resetStrategyState` 条件满足时总会立即发起一次新代次真实 GET（同选择有在途请求时先放弃再发；显式用户操作触发，属预期）。
- 踩坑注意点：① `@vueuse/core` 的 `isClient` 在模块加载时求值，测试里 window/document 必须先就位；vue runtime-dom 加载需要 `document.createElement`，`useStorage` 需要全局 `Storage`/`CustomEvent` 与 window 事件 stub。② 假时钟必须在步进间清空微任务，否则在途请求未完成、loading 守卫会误判周期读取。③ eligibility 只能观察布尔值与策略变化：账号列表每 3 秒整体替换对象（running 不变）不触发首取（Vue 3.4+ computed 值不变不通知），不能把 accounts 数组本身作为 watch 源。④ 字符串/数字形式的同一账号 ID 必须用 `String()` 统一标识：类型变化不触发重新读取，在途请求仍被接受。

### repair 轮修正（2026-09-21，主 Agent review 拒绝后返工：读取触发统一与选择归一化）

- **缺陷 1（读取触发未统一，同拍双读）**：就绪 watcher 与 `resetStrategyState` 都直接调 `fetchBagSeeds`，后者无在途守卫。复现条件：离线选择的 bag_priority 草稿切到运行选择、目标配置与种子响应都挂起时，watcher 与重置各发一次请求。修复（`useStrategySettings.ts`，最终形态含二次返工修正）：
  - 三个触发入口（就绪 watcher / 15 秒周期 / 显式重置）统一走 `requestBagSeeds()`：不满足条件直接返回；当前选择已有在途请求（`bagSeedsActiveRequest = { 代次 id, 归一化账号 }`）时不再发起第二次——无论哪个入口先到，同拍双触发也只读一次。
  - `resetStrategyState` 无条件递增代次并放弃**全部**在途请求：同一选择的在途请求也不复用，其迟到成功/失败/finally 一律不回填重置后的新草稿；条件仍满足时立即读取一次新代次（首版返工曾写成「当前选择的在途请求保留复用、迟到成功正常回填」，被主 Agent 二次复核否决，已按验收要求反转，详见下方「repair 二次返工」）。
  - 迟到响应校验改为 `isBagSeedRequestCurrent`（在途代次 + 账号 + 当前选择三重匹配）；finally 只有仍是当前在途请求才清 loading，旧代次 finally 不得清新代次 loading。
- **缺陷 2（选择归一化未过真实 Settings 链）**：`Settings.vue` 的账号 watch 原观察原始值，字符串/数字互换的同一选择仍触发重置与重新读取。修复：watch 源改为归一化标识（`currentAccountId == null ? '' : String(...)`），类型变化不触发重置、配置重载或种子重读；与 composable 内 `String()` 归一化一致。
- **测试补齐**（首版返工 13→18 条，二次返工调整为 19 条）：新增 composable 级「同一选择挂起时主动重置」用例（首版曾断言「选择不变的重置不重复发起、保留在途请求正常回填」，二次复核认定与批准验收相反，已反转，见下）；真实 Settings 级「账号运行态字段缺失四个截止零读取」「离线 bag_priority 切到运行选择立即恰好一次读取（配置与种子响应均挂起）、挂起跨三周期不增加、迟到结果不覆盖」「同一选择字符串/数字互换不触发重置或额外读取且在途仍被接受（真实 store 写入路径）」「切走后切回同一选择，旧代次成功/失败/finally 均不覆盖新代次」。真实 Settings 测试通过包装 composable 模块导出记录控制句柄断言内部状态（inline 模板编译不暴露 setupState）。
- **隔离基线反向对照与变异证据（首版返工数字，执行者为子 Agent，在 /tmp 隔离副本执行且未撤下共享工作区改动；协调进程的独立反向对照证据始终未提供，验收清单第 11 项仍待补）**：① 把两个 web 文件恢复为 HEAD 基线后运行当版测试 → 15/18 失败，失败全部为行为断言，无导入/环境错误；② 变异 A/B/C 结果见首版返工交接。二次返工后已在同一隔离方法下重跑，数字更新见下节。
- 未决项：本轮 02:49:44 之后的**新**反馈事件未验收；**截止前仍未解决的反馈**同样保留——背包五次快速失败归因未闭合（缺逐次响应与隔离跨层复现）、三条无请求归属的客户端 network_error、11 次无关联请求点击待分类，feedbackReviewed=false 由这两类共同构成，不能只归因截止后新事件；错误分类方案（冷却 reason 分组、萌宠业务码 reason）未获主 Agent 批准，本轮未实施；施肥监控无自然 HOT/PREARM 样本未动作；种子目录 21 条历史待证基线、挑战书/宝藏/变异果实专属图、daily_share 解码等待证据不变。
- 回滚 `git revert <本轮提交>` 后仅在既有 `farm:0.0` 应用：恢复的是「账号离线时设置页仍每 15 秒打一次 /api/bag/seeds」的噪声行为，不影响任何收益链；不得借回滚改动种植白名单语义或缓存边界。本轮 Agent 不提交、不推送、不重启（本地提交由协调进程在主 Agent 复核后统一执行）。

### repair 二次返工（2026-09-21，主 Agent repair_review 拒绝后：显式重置代次隔离）

- **拒绝原因**：首版返工的 `resetStrategyState` 在同一选择存在挂起请求时保留该请求（迟到成功仍回填种子/优先序/已知集合、迟到失败仍写错误），且新增测试第 516 行把「旧请求正常回填」写成了通过条件——与批准计划的「主动重置后旧成功、失败和 finally 不影响新状态」相反；同时隔离基线反向对照只有子 Agent 的 /tmp 副本记录，缺协调进程证据。
- **最终行为**（`useStrategySettings.ts`）：
  - `resetStrategyState` 无条件 `invalidateBagSeedRequests()`：同一选择的在途请求一并放弃，其迟到成功/失败/finally 全部不回填重置后的新草稿；条件仍满足时立即读取一次**新代次**。统一入口 `requestBagSeeds()` 的在途去重原样保留（15 秒周期与挂起场景仍不双发）。
  - 就绪 watcher 由默认 pre flush 改为 `flush: 'post'`：Settings 的账号 watch（pre flush）在同一拍必然先执行显式重置、发起唯一的新代次请求，watcher 随后在 post 阶段经统一入口去重跳过——切换同拍立即**恰好读取一次**，且唯一请求是**重置后发起**的，不再靠「复用重置前的在途请求」消除双读。探针实测当前 Vue 版本下 pre flush 也是重置先触发（watcher 观察的是嵌套 computed，调度晚于直接观察 currentAccountId 的 Settings watch），但那是调度实现的偶得顺序；post flush 把「重置先于 watcher」变成结构性保证（同一拍 pre 作业恒先于 post 作业），不依赖该偶得。
- **测试改写**（18→19 条）：原「选择不变时主动重置不重复发起在途请求（旧请求正常回填）」按验收要求反转并拆为两条——①同一选择挂起→重置→旧迟到成功不得回填种子/优先序/已知集合、不得清新代次 loading、不得写错误，新代次数据正常生效；②同一选择挂起→重置→旧迟到失败不得写入错误、finally 不清新代次 loading，无在途时重置立即读取一次。切换同拍恰好一次读取的真实 Settings 覆盖原样保留并通过。
- **验证**（子 Agent 本轮实际执行，Node 20）：readiness 定向 19/19；相邻定向（readiness + bear-activity-panel + season-bear-activity + bag-seed-recognition + pet-diary-operate）46/46；web `vue-tsc -b` 类型检查通过（只写 ignored 的 node_modules/.tmp）；两个改动 web 文件 ESLint 0 error。完整后端回归、隔离生产构建与新逻辑指纹由协调进程按登记流程重新执行。
- **隔离基线反向对照与变异证据**（子 Agent 在 /tmp 隔离副本执行，未撤下共享工作区改动，副本已清理；**协调进程按验收清单第 11 项的独立反向对照证据仍缺，须补跑**）：① HEAD 基线（两个 web 文件恢复为 HEAD 版本）+ 本轮 19 条测试 → **16/19 失败**，失败全部为行为断言（离线持续轮询、重置旧响应回填等），无导入/环境错误；② 变异 B（重置恢复「仅账号不匹配才失效」=被拒绝行为）→ 测试 8/9 失败（精确捕获）；③ 变异 C（去掉统一入口在途去重）→ 测试 3/17/19 失败（含切换同拍双读复现）；④ 变异 D（watcher 回 pre flush，保留无条件重置）→ 19/19 全过：如实记录，post flush 是结构性保证而非当前测试可区分的唯一路径。
- HANDOFF 本轮同步修正（按二次复核要求）：删除「同一选择重置后旧响应回填视为正确行为」的结论；区分 implement 轮 607/607 与首次返工后协调进程 612/612 两轮验证；标注反向对照的执行者（子 Agent）与证据状态（协调进程证据未提供）。
- 未决项不变：截止前未结反馈（背包五次快速失败归因、三条客户端 network_error、11 次无关联点击）与截止后新事件待后续验收，feedbackReviewed=false；错误分类方案未获批准未实施；种子目录 21 条历史待证基线、专属图缺口、daily_share 解码等待证据不变。

## 协调反向对照补证、每天一轮与主子工作量调整（2026-09-21）

- 本次阻塞不是新业务失败或隐私泄漏：批准清单要求协调器独立执行旧基线反向对照，但协调器原来只能运行当前树完整回归；子 Agent 自报的负向结果无法替代该证据，因此两次返工仍停在同一验收项。现将此要求变成 `baselineChecks` 明确声明的 sourceFiles/testFiles/minFailures，由协调器固定基线并执行，不再只写在自然语言清单中。
- 新验证器把当前代码复制到私有隔离目录，先运行选定测试；再用同组当前测试、相同依赖和独立运行目录，仅把批准源文件替换为基线内容。Node 结构化测试事件区分行为断言、导入/环境错误、跳过及取消；只有当前全过、旧版满足最少断言失败且无其它错误时接受。工作区、基线、验证要求与 Node 版本绑定内容摘要；未改变逻辑可复用，期间源变化则拒绝。共享工作区无 stash/reset/checkout/restore 操作，测试进程组中断可清理，不覆盖线上前端。
- **设置页遗留候选已由维护会话独立补证并验收**：两个设置页源文件配合同一组 19 项行为测试，当前 19/19 通过；旧基线 3 项通过、16 项行为断言失败、其它失败/跳过为零。原先两项对 Vue 代理数组的空集合断言在 Node 测试事件传输中丢失错误元数据，已改为等价的种子 ID 投影空集合断言，使失败类型可靠保留；没有靠错误文字猜测或手写成功记录。上文“协调证据仍缺”是历史记录，本条补齐该缺口，不再作为待解决阻断。
- 主子职责跟随页面 `mainAgent/subAgent`，不绑定任何品牌。精简流程：子 Agent 初检/排查/检索/复现 → 主 Agent 确认文件范围、可执行验收条件 → 子 Agent 实现及自检 → 协调验证 → 主 Agent 最终验收。取消新任务中独立主复盘和同一修复结果的 repair_review→review 双重复核；批准范围内验证失败及明确拒绝意见直接交子 Agent，完成后仍须真实重验与最终批准。超范围或编排故障仍需主 Agent 授权；旧运行状态的阶段识别兼容保留。
- 自动进化改为北京时间每天最多一轮，安全与缓存活动增量合并给同一团队；扫描事件只登记待处理活动，不额外拉 Agent。自动尝试日期独立持久化，失败、主进程重启和后续手动执行都不能抹去当日名额，旧状态保守迁移防重复；跨日才开放下次自动机会。显式手动触发独立，普通 Git 推送重试不算新模型任务；仍保留单轮有界返工。运行中出现的新活动继续登记，旧批次收口只清已审 ID，不吞新事件。
- 原未结反馈仍未获清理授权：背包快速失败归因、客户端错误、无关联点击和资源/协议待证项继续依既有短期保留与未决记录处理，反馈确认不会因维护部署自动变成 true。当前候选的种植、背包策略语义、上游缓存、收菜/偷菜/HOT/PREARM、登录与设备协议未改。
- 验证：Node 20 全量后端 638/638 通过，前端类型检查和隔离生产构建通过，skill 校验通过；改动文件 ESLint 无错误（设置页保留既有格式 warning）。确定性反向验证当前 19/19、旧码 16/19 行为断言失败，环境错误/跳过零；旧失败候选已补证，本轮维护验收不伪造原自动流程完成。重点回归包括主子反选、主调用次数减少、协调器真实反向对照在最终审批前执行、环境错误拒绝、同日失败/重启不追加自动轮、手动不重置名额、跨北京时间午夜及活动增量保留。回滚只回退必要逻辑，不恢复地址/身份、旧私有历史或删除未审反馈；应用仍复用既有 farm:0.0。

## 安全巡检记录（2026-09-21 下午，零代码改动收口）

### 最近 24h 日志与反馈审计（10e/1a 硬门）

- 审计窗口 2026-09-20 17:00 ~ 2026-09-21 16:45 UTC，2594 条结构化日志、JSON 解析失败 0；「请求超时」「发送失败」「治理器拦截」「被踢下线」「熔断/cooldown」「bag_unclassified_item」「seedId=0」「植物/物品/种子裸 ID」「空图」全部 **0**。未知推送 21 条全部为红点/商城/成就/护主犬已知家族，仅记录不响应。
- 核心收益链全部健康：到点保护收获 **37/37 ok**、哨兵抢收 **12/12 ok**（成熟到点后 108–292ms，均在 80–300ms 窗口内）、偷好友菜 **6/6 ok**、巡查/帮助/种植/铲除/催熟全部成功、重点巡田健康日志 445 条全 ok（2026-09-20 修复在产线正常出数）。施肥趋势触发 1 次（05:59:53）：触发时刻先于偷菜 1.3 秒、12 秒无新证据即冷却，满足 2026-09-11 地块级证据门。
- 收件箱唯一线索（微信长凭据保活失败 1 次，09-21 09:02:57Z）已回查本机 error 日志：语义为微信授权范围已失效需重新扫码，即已知 40188 路径（与 09-13/09-16/09-18 同模式）；WS 不重启、无重试风暴、离线保活按设计低频复查。**账号 A 需人工重新扫码**，不据此改登录接管策略。同秒的 2 条 runtime_error/1 条 auth runtime_warn 反馈即该事件的下游投影。
- 其余反馈失败均为已知路径或瞬时突发：dashboard 页 11 条 network_error 集中在 04:26:06 同一秒（瞬时断连突发，非周期、无重试）；02:48/05:00 的 runtime_warn 簇与 worker 重启同刻（Socket.IO 重连期）；00:00 的 runtime_error 与 daily_share 解码失败同刻。
- **2026-09-20 萌宠业务码修复产线验证闭环（关闭该项「待应用生产验证」）**：05:00 应用进化重启后，当日 22 次萌宠手动操作中 17 次拒绝全部返回 **HTTP 400 + outcome=rejected**（此前一律 502/unknown），修复跨 worker 传递已生效。拒绝分布在 09:41 前后（用户手动点击 feed/compensation/claimDog/seeds/story/draw，各 1–5 次，95–126ms 快速失败、无自动重试），draw 一次 insufficient_resources 为正常业务拒绝。反馈 reason 字段仍显示 unknown：错误分类方案（reason 分组）未获主 Agent 批准、未实施，属既有未决项，不是回归。
- 环境基线无漂移：`tsdk-v3.9.0.wasm` SHA-256 与 `tsdk-ace-runtime.md` 基线一致；clientVersion `1.13.0.5_20260723` 零条服务端自动更新；设备串跨 5 次 worker 重启保持同一固定串；24h 零被踢。自上次已审提交 6d7e686 以来的全部变更（进化编排/测试/文档/设置页 UI）零新增游戏协议调用、零新增 URL、零新增固定间隔定时器。
- 活动域：现成报告 up-to-date，unknown/ended 均空，seedRecognition 38 类零缺口；种子目录审计 **21 条与 09-14 起基线完全一致**；`getGenericFallbackItemIds()` 为空；`npm run fetch:official-icons` 运行确认仍无抓包 URL 证据（7 项商城装饰待抓取，零网络请求）。指纹变化（6ae086ed…）原因核实为 S3 starRecord 人工领取进度推进（1–12 已领、13 解锁未领，前次为 1–7 已领），活动配置与已登记实现一致，按既有模式不触发适配、不代领。
- 公开对照：六组关键词检索完成；public-reference-2 自上次对照后新增 3 提交已只读比较——其 smart 模式多季补肥土地类型筛选修复本地无对应问题证据（24h 零施肥/种植失败），不移植；其 release 提交将游戏协议升至 1.14.1.10_20260916（延续 09-18 已记录的 1.14.0.4 线索），**本地登录回包 version_info 通道零条自动更新 = 服务端未下发新版本，按硬门不采纳外部配置值**，仅作风险待证。参考 SHA 已记 ignored sources.json。

### 结论与回滚

- 本轮**零代码改动**：无可靠问题证据、无安全收益、现有逻辑符合要求（核心收益链 55/55 成功、治理零拦截、修复项产线闭环），按硬门 8 代码保持不变；本条目仅按硬门 10g 记录新证据链（萌宠业务码产线闭环、账号 A 待扫码、外部版本线索），`git revert <本轮提交>` 无任何行为影响。本轮 Agent 不重启 Bot、不推送远端。
- 下轮注意：账号 A 重新扫码前，微信长凭据保活失败会继续按已知路径低频出现，不要当作新异常收紧；萌宠操作 400+rejected 已是正常业务拒绝形态，reason=unknown 分类方案仍待主 Agent 批准后才实施。

## 隐私闸门拦截根因修复：向 Agent 注入参考别名映射（2026-09-22，维护会话）

### 事件与根因

- 本轮安全巡检提交（零代码改动、仅 HANDOFF 18 行）在 HANDOFF「公开对照」行写出了外部参考仓库真实 `owner/repo`，被父进程隐私闸门按 runtime-personal-data 拦截，整轮提交按硬门 5 被回退丢弃。**根因不是 Agent 违规写敏感数据，而是 Prompt 只要求“公开文件用参考别名”，却从未提供仓库→别名映射**：映射只存在于 ignored 的 private-config.json（privacy-guard 读它构造拦截词表），Agent 无从落笔。
- 处置：维护会话把该提交内容恢复并将真实仓库名替换为既有别名 `public-reference-2`，经 auditGitRange 全量复检通过后以提交 91104eb 推送 GitHub（纯文档、零行为变化），并已把 activity-evolve-state.json 收口为 pending_apply。

### 本次改动

- `buildPublicReferenceGuidance()` 末尾动态注入 `buildReferenceAliasMap()`：从 private-config.json 的 `evolutionReferenceAliases` 生成「别名 = 真实仓库」清单并附硬性说明（引用参考仓库必须逐字用别名）；映射为空时不注入任何额外段落。别名本身不在隐私拦截词表中，写 `public-reference-N` 恒可过闸；真实仓库名仍是拦截词，写错必被丢弃——该闸门行为未放松。
- 新增测试：注入映射出现且含逐字别名要求、空映射不注入；session-lifecycle 36/36 通过。

### 踩坑、注意点与回滚

- 私有映射进入的是本地 Prompt（stdin），不会写入任何受跟踪文件；测试用 `options.file` 指向临时配置，不依赖本机真实 private-config。
- 闸门拦截词表同时收录真实仓库名与别名映射的值（privacy-guard `collectRuntimePrivacyTerms`），本改动只影响 Agent 能写对，不降低拦截强度。
- 回滚：revert 本次提交即可，Prompt 退回“要求别名但无映射”的旧行为（会重新出现同类拦截丢轮）。

## 隐私闸门拦截闭环：已推送提交不回滚 + 拦截轮可续接原会话重做（2026-09-22，维护会话 II）

### 事件与根因（第三次拦截，与前两次不同）

- 17:35 面板启动活动进化（基线 a85aa15）；17:39 Agent 仍在运行时，运维会话提交并推送了 560b11f（面板日期修复）。Agent 本轮零改动（日志 0 字节）。收尾逻辑把 `headAfter(560b11f) ≠ headBefore(a85aa15)` 误判为 Agent 产出，对其跑隐私闸门——范围内含受保护文件改动（运维修复，无双 Agent 验收凭据）→ 拦截 + `git reset --keep a85aa15` 回滚。但 560b11f **已在 GitHub 上**：闸门拦不住已公开内容，唯一效果是本地落后远端一个提交。飞书误报“本轮自动提交已安全丢弃”。
- 根因两条：①收尾无法区分“Agent 的提交”与“运行期间运维插入的提交”；②对已在远端的提交做审计+回滚，本身就是错误行为。

### 本次改动

- `ensureHeadPushed`：`remoteHead === head` 的判断移到审计**之前**——已在远端即视为已放行，返回 ok，不再审计、不再回滚。收尾回滚前二次确认提交不在远端（防竞态窗口）。
- **Agent 会话可续接**：单 Agent Claude 轮改用 `--output-format json`，stdout 落独立的 `*.session.json`；收尾解析 `session_id` 持久化到 `state.agentSessionId`，JSON 的 result 文本回写日志（审计链不变）。仅显式重做（`payload.resume === true`）时用 `--resume <id>` 续接原对话；每日常规轮始终全新会话，杜绝旧上下文污染。
- **隐私拦截轮可重做**：拦截时记录 `privacyBlockedCommit/privacyBlockedBase`（丢弃的提交对象保留在本地 git）；`reviseEvolution` 接受 privacy_blocked(_local) 状态——privacy_blocked_local 先 reset 回基线（旧提交不进推送范围，审计不再命中），revisionContext 携带闸门命中项，重做轮带 `--resume` 续接原会话修复。面板「拒绝本次并按要求重做」对拦截状态可用；飞书/状态文案改为指引重做而非只报丢弃。
- 测试：session-lifecycle 37/37（新增隐私重做上下文与状态字段校验；buildEvolutionAgentCommand 断言更新为含 --output-format json / --resume）。

### 踩坑、注意点与回滚

- `--output-format json` 只用于单 Agent Claude 轮；双 Agent 团队模式与 codex 路径不变（团队上下文由 journal 承载）。
- 隐私拦截的**自动改写推送**仍刻意不做：自动改写被拦截内容会掩盖真实泄密（如 token），fail-closed + 可续接重做是正确闭环；运维侧人工匿名化恢复（如 91104eb 先例）只在确认是别名/身份类误伤时使用。
- `agentSessionId` 等新字段经 normalizePersistedState 白名单校验（格式不符清空）；session 文件纳入 evolve 日志保留期清理。
- 回滚：revert 本次提交；已推送提交的保护（ensureHeadPushed 前置检查）独立于此提交，建议保留。

## 重点好友窗口外催熟检测盲区：偷菜唤醒摘要刷新下限（2026-09-22，维护会话 III）

### 问题根因（用户指出的隐藏 bug）

场景：重点监控好友自然成熟还在 2 小时以上（122 分钟观察窗口之外），好友使用催熟化肥使作物**立即成熟**，随后被秒偷。现有两层感知都盖不住：

- **窗口外巡田是 5-8 分钟一次**（enterFriendFarm 每好友）；设计假设“化肥一次最多催熟约 2 小时”只覆盖窗口内的常规加速，瞬熟从任意时刻直接可偷，5-8 分钟足够错失全部作物。
- **摘要刷新被饿死**：`armStealWake` 在有已知未来到期（如 2.5h 后）时把下一次偷菜唤醒直接设到到期点，期间 `getAllFriends` 完全不跑——`noteFriendSummaries` 的重点跳变检测（PRIORITY_SUMMARY_SHOCK 10min）从未有机会触发，事后连“发生过施肥”都无法识别。

### 本次改动

- `armStealWake`（worker.js）：当 `watchlistDue > now`（任一重点好友挂未来成熟墙钟）时，偷菜唤醒取 `min(真实到期, now + 60-120s 高斯抖动)`。每次下限唤醒走既有 `runStealTick → checkFriends({onlySteal:true})`：一次 getAllFriends 覆盖全部好友——瞬熟好友立即出现在摘要 `steal_plant_num` 走既有抢收链；常规施肥提前触发摘要跳变进 HOT 秒级盯梢；即便到时已被偷光，摘要成熟时刻跳变（advance ≥ 10min）仍会触发 HOT 并留下施肥趋势日志。真实到期更近时 min 自然取真实值，HOT（0.4-1.2s）与 PREARM（≤60s）到期不受影响；哨兵武装与空闲 horizon 展示仍按真实墙钟。
- 请求代价：空闲期每 60-120s 一次 getAllFriends（此前窗口外巡田本身 5-8 分钟一次且是每好友进门，摘要请求信息密度更高）。无重点好友时零变化。

### 踩坑、注意点与回滚

- 催熟+秒偷在 60s 内完成的极端竞速仍无解（需亚分钟级轮询 = 请求指纹，防封红线不做）；本修复把识别延迟从“最长 8 分钟/或彻底错过”压到 ≤2 分钟，且保证趋势至少被识别记录。
- LandsNotify 好友地块推送路径已存在（onFriendLandsChanged → inspectFriendLands partial → HOT）：若服务端对好友施肥主动下发推送，即为零成本瞬时通道，巡检时留意该事件是否实际到达。
- 下限值 60-120s 写死常量（PRIORITY_SUMMARY_FLOOR_MIN/MAX_MS）；需要更快捕获可收紧，代价是请求密度上升。
- 测试：maturity-sentinel 断言更新（min 结构 + 常量校验）30/30；全量 616/619（3 个环境预存失败与本次无关）。回滚：revert 本次提交即恢复“按真实到期一次性唤醒”。

## 抢收提速：哨兵预进门驻留 + 请求治理紧急通道（2026-09-22，维护会话 IV）

### 背景

用户否决均匀 60-120s 摘要下限方案（保留为兜底、暂不应用是后续讨论项），批准先落地外部调研（外部参考项目的蹲守模式）借鉴的两个纯收益技巧。调研结论同步记录：QQ 端 LandsNotify 好友推送不可信（另一外部参考源码注释：QQ 环境只有 ItemNotify），零轮询方案不成立；所有同类项目都保留 10-30s 摘要轮询；登录态检测无协议通道（GameFriend 无 online 字段）。

### 本次改动

1. **预进门驻留（worker.js armSentinelPreEnter）**：哨兵武装成立时（目标 gid 从 getDueWatchFriends 解析，仅 PREARM/HOT 目标有）提前 3 秒 Enter 目标农场驻留并把 Enter 回复存进 sentinelPreEnter；到点 runSentinelStrike 把会话传给 checkFriends({onlySteal, preEnter}) → visitFriendForSteal 复用 enterReply 跳过重复 Enter，省一个 RTT。预进门失败静默，Strike 走完整路径兜底；60s 未被消费的驻留标记自动丢弃；不主动 Leave（由成功路径的业务 Leave 收尾）。
2. **请求治理紧急通道（request-governor setUrgentMode）**：sentinel 预进门与到点 Strike 各打开 15s 紧急窗口，窗口内偷菜链路五方法（VisitService.Enter/Leave、PlantService.CheckCanOperate/Harvest/AllLands）不被 60s 总量/单方法硬预算丢弃（Harvest/Steal 本就白名单）；仍计入请求画像。非链路请求照常拦截——窗口不是全局限流旁路。

### 踩坑、注意点与回滚

- 普通好友摘要 due 无目标 gid（合并时钟拿不到归属），不预进门，只有 PREARM/HOT 盯梢目标走驻留——与“抢的是盯梢目标”的业务事实一致。
- 测试沙箱（maturity-sentinel vm context）无 require：setUrgentStrikeMode 用 globalThis.__setUrgentStrikeMode 惰性查找注入；armSentinelPreEnter 里的 friend-api require 只在真实 gid + 定时器触发时执行，沙箱 gid=0 早退不受影响。
- 预进门驻留 3 秒 + Enter 一次是额外请求，但发生在“到点必然要 Enter”的同一目标上，总量不变、时间提前；紧急窗口 15s 覆盖整次 Strike，不叠加油门。
- 测试：request-governor 14/14（新增紧急通道用例：链路放行/非链路拦截/窗口过期恢复）；maturity-sentinel 25/25（新增预进门+紧急通道源断言）；全量 619/621（2 个环境预存失败与本次无关）。回滚：revert 本次提交，哨兵回到“到点才 Enter”。

## 好友在线信号验证：摘要字段漂移探测（2026-09-22，维护会话 V）

### 背景

用户确认方向：检测重点好友「是否上线」的行为痕迹作为额外判断信号（行为时段画像被否决——无固定规律）。协议无好友 online 字段，唯一候选是「好友在线期间摘要字段会漂移」（gold/level/tags/plant 微态）。本条目先落只读探测工具，验证结论后再生检测逻辑。

### 本次改动

- worker 新增 `probeFriendSummaryDrift(gapMs)` API（handleApiCall 分发）：间隔 gapMs（5-60s，默认 15s）拉两次 force-refresh 全量好友摘要，逐好友 diff level/gold/tags/plant 子字段（steal/dry/weed/insect/ripe_time），返回漂移明细（好友名 + 字段变化），不带 gid。
- 暴露链路：data-provider `probeFriendSummaryDrift`（超时 90s）→ `GET /api/friends/summary-drift-probe?gapMs=15000`（管理员鉴权，走既有 worker API 通道与请求治理预算）。
- 两次摘要之间不加任何额外请求；probe 本身不进 FRIEND_PANEL_ENTRY_METHODS 就绪闸门（只读探测不暂停自动化）。

### 使用与判读

- curl 或浏览器带管理 token 调 `/api/friends/summary-drift-probe`，观察 `drifts` 数组：窗口内谁哪些字段变了。
- 判读要点：plant 微态变化大部分来自作物自然生长/被偷（离线也会变）；**gold/level/tags 变化才是在线行为痕迹**（消费/收菜/升级）。需在「已知好友在线」（如刚触发施肥 HOT）与「深夜无活动」两个时段各跑几次对照，才能确认字段有效性。
- 若 gold 精度足够（非整数档位），检测逻辑可做「重点好友 gold/tags 窗口内变化 → 该好友在线 → 收紧其巡田节奏」——具体阈值等验证结论。

### 踩坑与回滚

- getFriendsList(true) 强刷两次间隔 15s：两次都是全量摘要请求，计入治理画像（正常预算内）；探测频率由人工控制，不自动轮询。
- 回滚：revert 本次提交，探测入口移除，无任何调度/检测行为变化（纯只读工具）。

## 好友活跃证据：社交道具 + 状态隐时钟（2026-09-22，维护会话 VI）

### 调研背景（五路 fan-out 结论）

QQ 农场全生态（中英文社区）无人实现"施肥前兆"或"好友在线"检测；协议无 online 字段（GameFriend 只有 level/gold/tags/plant）。中文社区老版开心农场有消息盒子（api.php?mod=chat&act=getAllInfo）先例，但新版对应接口未逆向——用户明确否决抓包验证（钓鱼接口风险），只做零成本搭车信号。第一步审计（心跳 reply + 14 种未识别推送）结论：无白送的好友活跃信号（ItemUseDailyNotify 227B 道具使用、ActiviesChange 10.8KB 活动快照、BulletinListChangedNTF 125B 公告板、其余 0-4B 红点类；心跳 reply proto 只有 server_time+version_info）。

### 本次改动（第二步，用户批准）

- 新服务 `core/src/services/friend-activity.js`：per-gid 活跃证据表（30 分钟窗口、200 gid 有界淘汰最旧）。
  - **社交道具信号**（用户批准）：`PlantInfo.social_items[].owner_gid + created_at`——好友在我/目标地块放黄金虫/足球/鹊羽灵露的操作者+时间戳，字段一直在进门回包里，此前被丢弃。自家农场地块推送（farming-orchestrator onLandsChangedPush）和好友进门（fertilizer-watch inspectFriendLands）两处搭车提取，只认非我 owner 且 30 分钟内放置的条目。
  - **状态隐时钟**：`PlantPhaseInfo.dry_time / insect_time`（挂在当前阶段上）是未来变干/生虫时刻——只有主人浇水/除虫才重置后移。plantSnapshot 增加 dryAtMs/insectAtMs；同一茬内（sameCrop 已保证）倒计时后移 >5 分钟 → `owner_watered_recently`/`owner_derugged_recently`（weakReasons，不触发 HOT）→ 记录该 gid 隐时钟活跃。
- 消费：重点巡田 scheduleWatchlistPollNext/nextWatchlistPollDelayMs 在窗口外档位上，活跃证据命中的好友收紧到 45-75s（窗口档）而非 5-8 分钟；降速（breaker）期间活跃证据好友不被追加额外等待。注意 dry_time/insect_time 在 **PlantPhaseInfo**（phases 数组元素）不在 PlantInfo 上——读 last 阶段。
- getEvolveState 侧暴露 getActivityEvidenceSummary（面板可扩展展示）。

### 验证与边界

- 测试 friend-activity 5/5（社交道具过滤、过期、有界淘汰、inspectFriendLands 隐时钟集成）；priority-watchlist 沙箱补 isFriendActiveEvidence 桩后 6/6；全量 624/626（2 环境预存失败无关）。
- 信号语义边界：社交道具只覆盖"有人放道具"场景（低频但精确）；隐时钟只覆盖"主人浇水/除虫"（进自己农场大概率做）；都是低覆盖率精确信号，作为巡田节奏的加分项而非依赖项。证据记录失败一律静默不影响主流程。
- 心跳/未知推送审计结论如上，NewProtectLogNotify 0 字节纯事件戳且用户到点保护下无被偷场景，维持只记录不响应。
- 回滚：revert 本次提交；巡田节奏回到纯窗口档位。

## 好友在线感知补全：摘要漂移 + 访客记录（2026-09-22，维护会话 VII）

### 调研结论（四路 fan-out：本地协议盘点 / GitHub 生态 / 微信QQ外部接口 / 小游戏在线机制）

- **协议层不存在在线信号**：GameFriend 无 online/last_active（全网 90+ 同源 fork 一致）；服务端 Notify 全集只关于自己，无好友上线广播；QQ 平台连 LandsNotify 都不下发。
- **微信/QQ 外部接口全部不可用**：QQ webpresence 恒返 0（隐私设置挡死）、wpa 图片/临时会话已退役、QZone 说说需登录 cookie 且风控重、微信无好友在线概念、开放数据域状态服务只能真客户端调；且游戏 gid ≠ QQ 号，身份映射不成立。
- **公开生态最优实践**：InteractRecords 访客记录（唯一带精确 server_time 的好友行为流，一个外部参考项目用它做 72h 活跃画像）+ GetAll 摘要 diff（gold/level 归因最强，作物字段离线也会变不能信）。

### 本次改动（b5fe067）

- `friend-activity.noteSummaryDrift`：gold/level/tags 只有本人操作能变（收菜卖钱/消费/升级）——diff 既有 GetAll 摘要（refreshFriendRipeSchedule 路径），零新增请求。首次建基线不报，变化必报。
- `pullInteractActivity`：搭车摘要刷新拉 InteractRecords（5 分钟节流，上游 60s 缓存+退避），visitor_gid+server_time 直接进活跃表（30 分钟窗口）。此前该接口只喂面板。
- 消费端已就绪：isFriendActiveEvidence 命中 → 重点巡田自动收紧 45-75s（会话 VI 已接）。
- 偷菜事故修复见 53e4c31（进门期间成熟的催熟形态两处 ripeAt>now 边界丢弃 → PREARM 立即重访）；自己农场"检测到催熟"误报修复（同茬守卫，收种边界不再误报）。

### 验证与边界

- friend-activity 6/6（新增漂移用例）；fertilizer-watch 30/30；priority-watchlist 10/10；相关回归全绿。
- 漂移信号延迟上限 = 摘要轮询周期（实践 5-8 分钟）；访客记录只覆盖"来过我农场的人"。均为分钟级感知，非秒级在线——协议天花板如此。unknownNotifyTypes 记录器保持开启，隐藏推送若出现可发现。

## 安全巡检记录（2026-09-23，枸杞当日闭环 + 参考仓库名匿名化）

### 最近 24h 日志与反馈审计（10e/1a 硬门）

- 审计窗口约 2026-09-22 17:00 ~ 2026-09-23 17:00 UTC，5229 条结构化日志；「请求超时」「发送失败」「治理器拦截」「收获/种植/偷菜失败」「seedId=0」「裸植物/物品 ID」「空图」全部 **0**。`result:"error"` 全量聚合（不分 level）仅 1 条 = daily_share 解码失败（已知待证项）。
- 核心收益链全绿：到点保护收获 **72/72 ok**、哨兵抢收 **42/42 ok**（预进门驻留已投产）、偷好友菜 **6/6 ok**（含偷 1 枸杞）、施肥趋势触发 1 次+冷却 1 次（触发先于偷菜、60 秒无新证据即冷却，符合 2026-09-22 用户定标）。驻留推送通道持续存活：friend_lands_notify_rx **158 条**。
- 被踢 2 次（账号 A）：13:15 reason=kickout:未知、15:09 reason=已在其他终端登录（真人顶号），均按自定义 60 秒接管+退避，无重试风暴。40188 授权失效链（02:30/02:36 Code 失败、17:52 前一日保活失败）为已知路径，账号 A 需人工重新扫码。主进程 24h 内 7 次重启（02:30/02:35/11:56/16:34/16:45/16:49/16:53），重启前均为正常业务日志、无错误——人工/面板重启，非崩溃循环；每次重启会复位 worker 内存态（含 bag_unclassified 去重签名，属设计边界）。
- 反馈流水新增失败全部命中已知类别：not_ready ×4（离线窗口页面单次读取，09-21 修复后已无轮询风暴）、萌宠 operate rejected ×3（reason=unknown 分类方案仍待批准）、runtime_error ×5 全部对齐 daily_share 00:00 档/40188/踢号时刻。
- 环境基线无漂移：wasm SHA-256 与 `tsdk-ace-runtime.md` 基线一致；clientVersion 零条服务端自动更新；`getGenericFallbackItemIds()` 为空；`npm run fetch:official-icons` 仍无抓包 URL 证据（7 项商城装饰待抓取，零网络请求）；种子目录审计 21 条与 09-14 基线一致（本轮登记枸杞后降为 20 条）。

### 本次改动一：枸杞家族当日闭环（硬门 10/10g）

- `bag_unclassified_item` 出现 **21625**（多次，重启后复位属正常）与 **41625**（1 次，13:27）。按 10g 顺序第①步查 client-config-evidence 快照直接命中：21625=枸杞种子（type 5）、41625=枸杞（type 6 果实）；Plant 快照 1021625 完整映射（seed 21625、fruit 41625×48、land_level_need 1、special_fruit 2026090100:1028:35 挂 S3 元气糕、mutant_effect_plant 5:1121625:1）；13:18 实际从重点好友偷到 1 枸杞、Bag 双 ID 实际出现——三方证据闭环，非编号段推断。
- 登记：`EventItems.json` +21625 枸杞种子、+1041625 黄金·枸杞（快照 type 17/gold/Crop_1625/sells 1005:6，与 1045995 同族同模式）；`EventPlants.json` +1021625 枸杞（size 1）、+1121625 黄金·枸杞变体（seed_id 空）。果实 41625 按 40516 惯例由 EventPlants 合成命名，不进 EventItems。快照 size=null 按官方"仅非默认占地写 size"约定（19 种 2x2 均显式声明）+ 同族狗尾草/芦苇生产验证先例登记为 1。
- 新增回归：bag-seed-recognition 新增枸杞用例（种子进索引/植物映射/size/果实合成命名/黄金变体/无 0 键污染）。审计 21→20 条（休眠未登记种子剩 29999、21072）。

### 本次改动二：受跟踪文件中的真实参考仓库名匿名化（别名硬门）

- 巡检发现 2026-09-22 维护会话提交把真实外部仓库名写进了受跟踪文件（proto 注释、friend-activity/friend-visit/worker.js 注释、HANDOFF 两处），其中一处命中别名映射表（=public-reference-2 的 owner 名）。闸门按整词 `owner/repo` 匹配所以裸 owner 名未被自动拦截、已随维护会话推送公开——历史已暴露不回写（历史重写需用户确认），本轮把当前文件全部改为「公开参考项目 2 / 外部参考仓库」等匿名表述，共 8 处源码/文档注释，零行为变化。真实映射只留在本机 private-config 与 ignored sources.json。

### 新活动发现（List 权威下发，登记给活动 Agent）

- 在线 List 新下发两组活动（均 2026-09-24 00:00 北京时间开始）：**2026092500/01「快乐不独享」**（HappySharePanel，9/24-10/12，快乐值三途径：每日领取/每日分享/点好友分享链接，档位奖励）；**2026092400/01「秋祈良愿」**（WishSignMainUI，9/24-10/7，每日祈愿领奖，奖励含 **2 种限定种子**+烟花互动道具+盆栽装扮，错过存储 5 日、邮件补发）。enabled=false 尚未开放。活动 Agent 下轮按五闭环处理；安全侧确认无未下发 ID 枚举、无未知接口试探。

### 公开对照（增量，6 组查询 5 组成功）

- public-reference-1：09-16 后无新增；public-reference-2：与 09-21 轮相同 3 提交无新增（1.14.1.10 版本线索维持不采纳——服务端未下发）；public-reference-4：08-23 后无新增。**public-reference-3 新增 be7db5f0（09-21）已只读对照**：把 1x1/2x2 种子合并进同一优先列表并新增「排除」机制——与本仓库用户裁定（背包种植不是白名单、全部种子都可种）直接冲突，**不移植**。已查 SHA 记入 ignored sources.json。

### 风险待处理与观察项（本轮不改）

| 项 | 证据/风险 | 边界 |
|---|---|---|
| kickout:未知 ×1 | 13:15 踢号原因字段未解析出已知值 | 单次样本、同日后续踢号为真人顶号；无重试风暴不改登录接管；再出现需对照 KickoutNotify 原因枚举 |
| lands_push 回声 | 自己偷菜触发的推送也会记 lands_push 活跃证据（30 分钟窗口收紧巡田） | 记忆已登记的已知边界；回声只造成有界多余巡田（每次偷菜后约 30 分钟 45-75s 档），不影响正确性；用户定标优先灵敏度 |
| 60-120s 摘要下限仍在代码中生效 | HANDOFF 维护会话 IV 记录用户否决其作为主方案、保留为兜底 | 与「保留为兜底」的当前代码状态一致；是否撤除留用户后续定标，本轮不动 |
| 萌宠 reason=unknown | 3 次业务拒绝分类字段缺失 | 分类方案待主 Agent 批准，既有未决项 |
| daily_share 解码 | 00:00 档 1 次 Reader 越界 | 已知待证：等 ShareService 成功回包样本 |

### 验证与回滚

- 本轮改动仅数据登记（EventItems/EventPlants）、注释匿名化（3 proto + 3 js 注释 + HANDOFF 措辞）与测试（新增枸杞用例 + 修复一条过期断言），**零调度/协议/收益链改动**；未修改 worker.js 行为（仅注释）、登录、设备串、TSDK/ACE。
- **附带修复（bf961a2 遗留回归）**：全量首轮 660/661，唯一失败为 session-lifecycle「每日安全 Agent 固定审计…」——bf961a2 把安全 Prompt 第 2 条改写为 12 链触发规则后，测试仍断言旧措辞「只运行现有定向不变量回归」（在干净 HEAD 上复现 36/37，与本轮无关）。已把断言对齐新措辞（12 链表存在 + L7 链描述 +「只跑现有定向回归，不重复通读」），session-lifecycle 37/37。
- 验证：bag-seed-recognition 9/9；种子目录审计 21→20；`getItemById(21625)`=枸杞种子、`getPlantBySeedId(21625)`=枸杞 size 1、41625 合成命名枸杞、1041625 黄金·枸杞、`getGenericFallbackItemIds()` 仍为空；`node --test --test-concurrency=1 test/*.test.js`（Node 20）全量 **661/661 通过**。
- 回滚 `git revert <本轮提交>`：枸杞回到未识别清单（bag_unclassified_item 重新报警）、注释恢复真实仓库名（不建议）、断言回退后会重新报 bf961a2 的措辞漂移；不影响任何收益链。本轮 Agent 不重启 Bot、不推送远端。

## 活动进化巡检（2026-09-23，秋祈良愿/快乐不独享只读端到端接入 + 枸杞图标闭环）

### 最近 24h 日志与基线审计（10e/6b 硬门）

- 审计窗口约 2026-09-22 17:40 ~ 2026-09-23 17:39 UTC，4127 条结构化日志、解析失败 0；「请求超时」「发送失败」「治理器拦截」「收获/偷菜失败」「seedId=0」「bag_unclassified」「空图」「cooldown/熔断」全部 **0**。核心收益链全绿：到点保护收获 **72/72**、哨兵抢收 **42/42**、偷好友菜 **6/6**。`result:"error"` 全量聚合仅 1 条 = daily_share 解码失败（既有待证项）。种植 2 条 `fallback_ready/fallback_start` 是背包用尽转第二策略的正常状态标记，非失败。被踢 3 次（12:01/13:15/15:09）均为已知真人顶号/未知原因路径，13:15/15:09 已由 09-23 安全巡检记录。种子目录审计 20 条与 09-23 基线完全一致。
- **seedRecognition 报 21625 seed_icon_missing**：昨日已登记枸杞名称/植物映射但无专属图。本轮按 10g 顺序闭环（见下），`getGenericFallbackItemIds()` 保持为空。

### 本次改动一：两组新活动只读端到端接入（2026-09-24 开放）

**在线证据**：List 下发两组根活动——`2026092400/2026092401` 秋祈良愿（WishSignMainUI，9/24–10/7，type 21 子节点 status=20）、`2026092500/2026092501` 快乐不独享（HappySharePanel，9/24–10/12，type 24）。两组均 `enabled=false` 未开放；protocolShape 显示 ActivityNode 未声明字段 `1.2.119`（秋祈良愿，wire2 4B 含两个 varint）与 `1.2.120`（快乐不独享，wire2 83B 嵌套子消息）。

- **`core/src/services/season-wish-activities.js`（新）**：两组活动的说明驱动归一化。秋祈良愿从说明提取 4 个玩法指南（每日祈愿领奖 / 限定种子·烟花·盆栽奖励 / 5 日存储 / 邮件补发）+ 签文趣味提示；快乐不独享提取 4 个（每日领取 / 每日首次分享 / 好友快乐包链接 / 档位奖励稚萌熊熊）。无说明时返回空指南，不按 type/UID/字段形状编造玩法。field 119/120 只保留形状诊断（opaqueReadOnlyFields），不解释业务语义。
- **`activity.js`**：新增 `getSeasonRuleActivity()` 入口（照 getBearActivity 模式：List 确认根节点下发 → 空 UID GetGroup → 归一化 → 只读日志 `wish_activity_read`/`happy_share_activity_read`），导出 `getWishActivity`/`getHappyShareActivity` 与四个 `*_ACTIVITY_ID` 常量（含子节点，known 集合收集后不再报未知候选）。两组活动当前无已知道具 ID，不做背包读取——奖励道具 ID 待活动开放后的下发证据。
- **`admin-season-activity-routes.js`（新）**：`GET /api/activity/wish` + `GET /api/activity/happy-share`，走共享 60s 活动读缓存（成功/失败均缓存、并发合并），注册进 `admin-activity-routes.js`。
- **`data-provider.js`/`worker.js`**：活动段各 +2 行转发/case（getWishActivity/getHappyShareActivity）；`worker.js` 改动严格限于活动管理读取 switch，未触碰收菜/偷菜/施肥/调度/登录/设备段。
- **前端**：`SeasonRuleActivityPanel.vue`（新，两组共用说明驱动只读面板——状态行、玩法卡、提示、折叠诊断）；`activity.ts` store 新增 `SeasonRuleActivityData` 类型与两组状态/请求代次（账号切换旧响应不回填）；`Activity.vue` 挂两张新卡；`AdminActivityUpdatePanel.vue` 新增 wish-daily/wish-rewards/wish-storage/share-daily/share-tier 五个说明识别检查项与两个子节点命名（秋祈良愿玩法节点/快乐不独享玩法节点）。
- **写操作边界**：两组活动均无官方客户端可达路径与自然成功样本双证据 → 零写命令、零自动开关、零每日例行、零 Operate 调用；「每日首次分享」「点击好友链接」属官方社交传播玩法，Bot 不模拟分享、不伪造点击。秋祈良愿「2 种限定种子」无道具 ID/图片/植物/占地证据 → 不改 EventPlants.json，活动开放后按下发/背包/土地证据补齐并核对 size。

### 本次改动二：枸杞图标缺口闭环（硬门 10g ② 路径）

- 上轮 seedRecognition 报 21625 seed_icon_missing。ItemInfo 快照 icon_res 为 null（①无果）；`fetch:official-icons` 无抓包 URL 证据（零网络请求）；**②路径闭环**：发现 public-reference-1 的 `illustrated-fruit-sources.json`（同源 fork 的官方资产取证清单，09-10 b492fdb 引入）含枸杞三图的官方 CDN URL+assetPath+sha256。从官方 CDN 直连下载（21625/41625 共用 `model/v4/Crop_1625_Seed/spriteFrame`、1041625 用 `gold/Crop_1625_Seed`），**sha256 与清单记录完全匹配**（2529bf48…/58eb7c28…），PNG 规格 100×100 与现有种子图一致，像素分析确认红绿浆果系（普通）与金色系（黄金变体，与 1045995 同族）。
- 落盘：`21625_Crop_1625_Seed.png`、`41625_Crop_1625_Seed.png`、`1041625_gold_Crop_1625_Seed.png` 三张 PNG **留在工作区严禁 git add（待人工审阅提交）**；`event-seed-sources.json` 已登记三条目（只记 id/file/assetPath/sha256，不记 URL——沿既有惯例）。本机索引已生效（`getSeedImageBySeedId(21625)` 返回路径）；远端克隆在 PNG 人工提交前优雅降级显示名称，与 1040516 等空图道具行为一致。
- 注意：seed/fruit 共用同一 spriteFrame 是官方事实（21625 与 41625 同图同 sha256），非顶替。

### 本次改动三：evolution-apply-build 测试 fixture 对齐（预存失败修复）

- 全量首轮 668 测试 2 失败（evolution-apply-build），与本轮活动域改动零交集：c9a2261（同日运维修复）把构建 Node 解析改为「NODE_BIN_DIR 的 node 不满足 vite 7 时探测 nvm v20/v22」，而测试 fixture 的 mock bin 里没有 `node` 可执行文件 → 本机探测到真 nvm → 真 npm 覆盖 mock npm → trace 断言失败。修复 = fixture 补一个通过版本检查的假 node（`exit 0`），把 BUILD_NODE_DIR 固定在 mock bin。生产语义不变（生产路径 activity-evolver 传入的 Bot node 18 目录仍会正确触发 nvm 探测）。同类先例：09-23 bf961a2 断言对齐。

### 公开对照（增量，6 组查询全部成功，按 updated 倒序）

- 四个固定参考全部无新增提交（public-reference-1@343d9463、-2@3e7640b9、-3@be7db5f0、-4@1bc45d3e，与 09-23 sources.json 记录一致）。新候选：一个仅 README 更新的镜像类仓库（无实质内容）；public-reference-3 同 owner 的另一关联仓库有三个实质提交（自动夺宝接 friend API / 掉线后用存储 Code 重试 / timer stall 归因），分别命中「好友交互未开放」「断线重连免扫码禁区（2026-09-14 用户裁定）」「本机无此问题证据」，**均不移植**。真实仓库/SHA 已记 ignored sources.json（公开文件按别名硬门不写真实 owner/repo）。本轮无可靠借鉴。

### 踩坑与注意点

- **新活动 9/24 才开放（enabled=false/status=0，type 21 子节点 status=20 语义未知）**：面板状态显示「未开始」；开放后 enabled/status 变化、details 可能出现新结构（奖池/记录/进度），下轮活动 Agent 必须用新快照复核玩法状态与道具 ID，再决定是否补背包读取/EventPlants——本轮登记的 missingEvidence 已写明这些边界。
- **field 119/120 不可当语义证据**：119/120 都不在 ActivityNode 已声明字段（101/102/105/110/112/113）中；120 在 OperateReply 中是 star_record_claim，但这里路径是 `1.2.x`（ActivityNode），两者无关，不能混用。
- **同源 fork 的资产取证清单是 10g ② 的高效证据源**：`illustrated-fruit-sources.json`（公开参考项目 1）记录了图鉴果实的官方 CDN URL+sha256，配合官方 CDN 直连下载与 sha256 校验即可闭环，不需要 miniapp settings.json。后续图鉴类图标缺口优先查此清单（还有 pet-diary-sources.json 的 sourceVersion 可判断其配置版本新旧）。
- `npm run build` 前必须先 `export PATH=<node20>/bin:$PATH`；单独跑 eslint/vue-tsc 的命令同样要带 PATH 前置（本轮 eslint 又踩了一次 Node 18 `Invalid regular expression flags`）。
- store 的 eslint --fix 会重排 return 对象换行（antfu/consistent-list-newline），fix 后要重跑 vue-tsc 确认类型不变。

### 验证与回滚

- 验证：`season-wish-activities` 定向 **7/7**（说明→指南、空说明不编造、List 缺根不发详情、空 UID 读取、路由缓存接线、常量注册）；相邻活动域 31/31；`node --test --test-concurrency=1 test/*.test.js`（Node 20 v20.20.2）全量 **668/668 通过**；web `npm run build`（vue-tsc -b + vite build）通过；改动文件 ESLint **0 error**（AdminActivityUpdatePanel 等保留既有 143 条格式 warning）；种子目录审计 20 条不变；`getGenericFallbackItemIds()` 为空；枸杞三图索引生效。
- 本轮未修改收菜/偷菜/重点 HOT/PREARM、请求治理、登录保活、设备串、TSDK/ACE、好友/盯梢调度；`worker.js` 改动仅在活动管理读取 switch。未新增自动开关、每日例行、写命令或 Operate 调用。
- 回滚 `git revert <本轮提交>`：移除两组新活动只读卡片与路由（List 下次扫描会重新把四个 ID 报为未知候选）、恢复 apply-build 测试预存失败、event-seed-sources 去掉枸杞三条目（工作区 PNG 不受影响，仍待人工提交）。**三张枸杞 PNG 留在工作区待人工审阅 git add（本轮绝对未加入提交）**；人工提交后下轮可确认 seed_icon_missing 消除。本轮 Agent 不重启 Bot、不推送远端。

## 活动进化巡检（2026-09-24，秋祈良愿/快乐不独享手动操作接入 + 烟花桶 6001 登记）

### 最近 24h 日志审计（6b/10e 硬门）

- 审计窗口约 2026-09-23 06:00 ~ 09-24 06:00 UTC，3923 条结构化日志；「请求超时」「发送失败」「治理器拦截」「cooldown/熔断」「seedId=0」「空图」「收获/种植/偷菜失败」全部 **0**。核心收益链全绿：到点保护收获 **72/72**、哨兵抢收 **42/42**、偷好友菜 **6/6**、priority_poll_health 608 全 ok。`result=error` 全量聚合仅 1 条 = daily_share 解码失败（既有待证项）。被踢 2 次均为已知真人顶号/授权路径。
- `bag_unclassified`：21625/41625 的报警全部发生在昨日枸杞登记生效前的旧进程（主进程多次重启复位去重签名属设计边界）；今日 04:51 起新清单只剩 **6001**。
- 反馈 `not_ready` ×24（wish/happy-share/bear 各 8）：账号离线时用户打开活动页的并发单次读取（04:31/04:38/04:58 三簇，同秒三接口并发、无定时器轮询），"账号未运行"业务拒绝是正确行为，非回归。萌宠 operate rejected ×11 与 apply unknown ×3 属已知 reason 分类未决项。

### 本次改动一：6001 烟花桶当日闭环（硬门 10/10g）

- 秋祈良愿开放首日 Bag 出现 6001（04:51/04:56，两 worker 各首报一次）。按 10g 顺序第①步查 client-config-evidence/ItemInfo 快照直接命中：**6001 = 烟花桶**（type 23、icon_res `gui/texture/icon/icon_weather_goldenWood/spriteFrame`、desc"使用后在农场放置烟花筒…放置可获得30经验"），与活动说明"烟花互动道具"及开放时间三方吻合。`EventItems.json` 照 5005 先例登记（名称/类型/desc/icon_res 逐字），`isSeedItem(6001)=false`、`getGenericFallbackItemIds()` 保持为空。
- 专属图标：`fetch:official-icons` 无抓包 URL 证据（零网络请求）；参考仓库 132 条资产清单无 goldenWood——记待证（需 miniapp settings.json 或抓包会话），不伪造。注意对方最新客户端把 6001 名为"烟花·玉兔望月"（本机快照是 09-11 版），以本机快照"烟花桶"为准，下次快照更新时核对。

### 本次改动二：两组活动面板手动操作接入（两级写操作第①级 + 硬门 4 禁止"待确认"终态）

**证据链（skill activity-operate-confirmation 首次全流程实战）**：并行子 agent 检索 GitHub（7 组仓库搜索 + 8 组代码搜索全成功）全网唯一命中 **public-reference-1 @0ba48a1/9982736（2026-09-24 当天提交）**：秋祈良愿/快乐不独享的完整官方编码器重构实现（其协议恢复文档声明字段号经官方生成代码 create/encode sentinel 探测 + HAR 明文响应标签交叉验证，与已批准移植的 pet-diary 同源同级）。交叉验证：活动时间窗（1790179200~1791388799 / 1791820799）与本仓库 List 快照完全一致；秋祈良愿子节点 enabled=true status=20 已开放、Bag 出现烟花桶。四条请求编码在本仓库 proto 下**字节级复现官方 hex**（测试固化断言）。

- **proto**（activitypb.proto）：OperateRequest 选择器 `wish_sign_draw=151/wish_sign_claim=152/share_reward_claim_milestones=154/share_reward_claim_daily=157`；ActivityNode 声明 `wish_sign=119`（ActivityBodyWishSign: remaining_count/activity_day/pending）与 `share_reward=120`（ActivityBodyShareReward: 快乐值/每日状态/档位）；OperateReply 对应 Rsp。
- **`season-wish-operate.js`（新）**：手动操作服务，白名单 wishDraw(51)/wishClaim(52)/shareDaily(73)/shareMilestones(70)。每次操作前 List 确认根下发 → 空 UID GetGroup 重读状态做服务端前置校验（祈愿次数/pending 匹配/每日已领/档位 state===2 且分数达标），与官方客户端一致防本地过期重复请求；失败不自动重试；业务码 WISH_SIGN_*/HAPPY_SHARE_*/SEASON_WISH_*。
- **三层接线**：worker.js `operateSeasonWish` case + data-provider 转发 + `admin-season-wish-operate-routes.js`（照 pet-diary 路由：成功清 60s 只读缓存、业务拒绝 400+code、传输失败 502）。错误元数据跨 Worker 传递正则扩展四前缀（worker.js + worker-manager.js 同步，非捕获组）。
- **归一化**：activity.js 快照 details 新增 wishSign/shareReward 标准化；season-wish-activities.js 透传 operateState/choices/resources，readOnly=false writeOperationsSupported=true，missingEvidence 更新为"已按官方编码器重构证据接入手动操作"；wish 背包读取接 6001（库存展示，失败保持未知）。
- **前端**：SeasonRuleActivityPanel 加 kind prop 与"玩法手动操作"区（祈愿 prompt 选签 1-6/领取祈愿奖励/每日领取/领取档位奖励 + 实时状态行 + 档位列表）、道具库存区（烟花桶）、玩法卡"操作协议待确认"禁用按钮替换为三类准确提示（已开放→指向顶部操作区 / 分享类→不开放原因 / 系统 automatic→无需操作）；store 加 operateSeasonWish + seasonWishOperating；AdminActivityUpdatePanel 五个检查项描述对齐新状态。
- **分享（cmd 69）明确不开放**：面板按钮无法完成官方分享的用户流程（拉起 QQ 转发），直接发命令等于伪造分享状态骗奖励，且响应含敏感分享密钥（share_key/share_open_id）；这是语义边界不是证据缺口，与 S3 夺宝（好友目标选择）同类。烟花使用走 ItemService.Use（非 Operate），已有背包通用使用能力，未做活动专属入口。

### 踩坑与注意点

- **List 不下发活动体详情**：field 119/120 只在 GetGroup 回包。操作服务前置校验必须 List（确认根下发）→ GetGroup（读活动体），第一版只读 List 导致拿不到 wish_sign 状态（测试立即抓住）。
- **protobufjs 空 sub-message 会编码 tag+len0**：daily/milestones 官方请求体是 8 字节（仅 id+cmd，无选择器字段）——请求对象不能带 `share_reward_claim_daily: {}`，否则多 3 字节偏离官方编码。祈愿/领取带 choose_id 的 14 字节编码与官方 hex 完全一致。
- **烟花桶名称差异**：对方最新客户端名"烟花·玉兔望月"vs 本机 09-11 快照"烟花桶"——以本机快照为准，外部名仅记 HANDOFF 待下次快照核对（不能把外部名直接覆盖本机证据）。
- session-lifecycle 一条断言 /bot 自己试调成功不算证据/ 在 43b5d69（两级写操作策略改写）后已预存失败——按 09-23 bf961a2 先例对齐为新表述三条断言（试调不单独证明安全 + 写操作分两级 + 公开实现交叉验证）。
- web 构建 PATH 坑再验证：`nvm use 20` 后 vite 仍可能从 PATH 解析到 Node 18（crypto.hash 报错），必须显式 `export PATH=<node20>/bin:$PATH`。

### 验证与回滚

- 新增 `season-wish-operate.test.js` 2 条：四条官方 hex 字节级断言 + 白名单锁定（shareShare 不在）+ 全部前置校验拒绝路径（零 Operate）+ 成功链（List/GetGroup/Operate 各恰好一次、奖励名称含"烟花桶"）+ List 缺根零后续请求。season-wish-activities 7 条更新为手动操作已具备状态；bag-seed-recognition 补 6001 断言。
- `node --test --test-concurrency=1 test/*.test.js`（Node 20 v20.20.2）全量 **670/670 通过**；web `npm run build`（vue-tsc + vite）通过；后端改动文件 ESLint **0 error**；前端改动文件 0 error（AdminActivityUpdatePanel 保留 2 条 HEAD 预存 error 与 143 条既有格式 warning，不为 lint 扩大差异）。
- 本轮未修改收菜/偷菜/重点 HOT/PREARM、请求治理、登录保活、设备串、TSDK/ACE、好友/盯梢调度；`worker.js` 改动仅活动管理读取 switch + 活动错误码正则两处。未新增自动开关、每日例行；写操作只走面板手动路径（两级策略第①级）。
- 回滚 `git revert <本轮提交>`：恢复两组活动只读卡片与"操作协议待确认"占位、6001 回到未识别清单、四前缀错误码回退为 PET_DIARY 单前缀（萌宠操作不受影响）；不得借此回滚 43b5d69 的两级写操作策略本身。应用或回滚只能在既有 `farm:0.0` 窗格完成；本轮 Agent 不重启 Bot、不推送远端。

## 进化产出的前端/状态逻辑 bug 模式（2026-09-24 维护会话登记，自进化必须防范）

用户定调：**解决 bug 就是自进化需要的能力**。活动 Agent 已落地两轮真实功能（面板手动操作接入），但连续产出了两类本可避免的运行时 bug，维护会话修了两次。以后每轮进化的代码审查必须对照本节 + skill「进化产出代码自检清单」，外部 RAG/sources 与 skills 必须每轮回写，否则同类问题会一直复发。

### 已发生的两类模式

1. **空值不安全渲染**（2026-09-24 应用错误 toLocaleString）：活动接口缺省字段是 `undefined`，`=== null` 挡不住 → `.toLocaleString()` 渲染即崩。修法与规范见 skill 清单第 1 条（`== null` + `Number()` 包裹）。
2. **共享状态计数器毁掉并发请求**（2026-09-24 祈愿面板永远转圈）：两个活动的 fetch 共用一个递增 requestId，页面并发拉取时后发的自增作废先发的响应与 finally 清理 → loading 永不清、数据永不落地。修法：**按 key 独立计数器**（`Record<'a'|'b', number>`），或任何"共享可变状态 + 并发"设计必须逐一审。规范见 skill 清单第 2 条。

### 对自进化的硬要求（用户 2026-09-24 指示）

- 每轮有代码改动时，审查阶段必须跑 skill「进化产出代码自检清单」（core/docs/skills/agent-authored-code-checklist.md）逐条核对新增渲染点/状态逻辑。
- **外部 RAG 维护是每轮的正式产出**：本轮踩过的坑、新的检索模式、验证手法必须回写 skills 索引或 client-config-evidence/sources.json（ignored），下轮开始先读索引。RAG 不回写 = 本轮没闭环。
- 出现与已登记模式相同的新 bug 视为审计失败（清单已给而未执行），需在 HANDOFF 记原因。

## 推送直达偷菜 fast-lane（2026-09-24 方案C，用户批准：仅重点好友+仅在线）

对抗"好友在线施肥催熟秒收"的竞速（此前实测 56 秒只抢到 3/24 块——轮询形态出手周期 2-3s 拼不过 1s/块的手速）。worker 推送处理里：重点好友 + isFriendOnlineRecently（10 秒窗口）双闸门通过时，推送中"已成熟且还站着"的地块直接 PlantService.Harvest（协议自包含无需 Enter/CheckCanOperate，两份既有公开实现证据交叉核对；is_all:true 沿用现有 stealHarvest 实现），同好友串行去重、3 秒地块防回声、失败静默。自然成熟的常规偷收不变（PREARM 布防），1 秒档扫地保留兜底。若线上观察到 Harvest 失败率异常，收紧闸门（缩短在线窗口或加 CheckCanOperate 预检并行）。

## 安全巡检记录（2026-09-24，restart 脚本机器路径泄露修复 + 24h 全绿确认）

### 最近 24h 日志审计（10e/1a 硬门）

- 审计窗口约 2026-09-23 16:32 ~ 09-24 16:32 UTC，5376 条结构化日志、解析失败 0；「请求超时」（仅 1 条 ACE AntiData 单次超时后按 2s 受控重试成功）「发送失败」「熔断/cooldown」「bag_unclassified」「seedId=0」「裸植物/物品 ID」「空图」「收获/种植/偷菜失败」全部 **0**；窗口内被踢 **0 次**。
- 核心收益链全绿：到点保护收获 **40/40**、哨兵抢收 **60/60**、偷好友菜 **24/24**、帮助 72/72、重点巡田健康 **1187/1193**（99.5%）。**fast-lane 产线首证**：15:11/15:12 两次「快车道偷菜成功：1 块（推送直达，未进门）」——推送直达 Harvest 链实际生效。
- 错误级仅 2 条 = 账号 A 的 40188 授权失效链（保活失败 + Code 刷新失败，已知路径，需人工重扫码）；SMTP 未配置提示 1 条（09-23 15:09 踢号通知尝试，配置项非故障）。
- `result=error` 全量聚合仅 1 条 = daily_share 解码失败（既有待证项）。

### 唯一新症状：在线快档 × 60s 硬预算饱和（不改代码，记录边界）

- 02:11:08–29 重点好友 A 在线主动收菜（LandsNotify 推送爆发，02:11:16 有 27ms 内 15 条）期间，重点巡田按在线快档 700–1000ms + 推送拉近 300ms 连续进门，每次 Enter+AllLands ≈ 2 req/s，60 秒总预算（80）在 ~40 秒内饱和 → **6 次 Enter 被 budget_total 拦截**（约 4 秒间隔，对应反馈 priority_poll 6 次失败）；02:12:21 活跃证据刷新后自愈。
- 判定为设计内交互，不修：①Harvest/Steal 在治理白名单内，竞速出手全程未被阻断（当日偷菜 24/24）；②60s 硬预算是用户明确保留的最终闸门；③活跃证据命中时 scheduleWatchlistPollNext 不叠加降速延迟（2026-09-20 修复在位），档位不坍塌；④拦截不计入异常降速阈值（network.js 拦截路径不调 recordSent）。**下轮判读注意：在线好友持续活跃超 40 秒时 Enter 拦截是预算饱和的预期表现，不是风控信号，不要据此放宽预算或放慢在线档。**
- 收件箱「普通巡查降速 ×6」（72h）与账号 2 历史同模式（偷菜竞速 CheckCanOperate×12 累计触发）：只降速普通巡查 5–10 分钟，有界，不改。
- **daily-events 面板事件跨重启可丢**（观察项）：该文件是每进程内存态 + 整文件覆写，worker 频繁重启/日切时可丢失同日历史（账号 A 今日 00:00–15:21 的面板事件缺失，含 10:08 降速记录）。收件箱在 record 时同步落盘（durable），安全巡检以收件箱+combined 日志为准，**不得以 daily-events 文件缺记录断定事件未发生**。加锁修复无安全收益，不做。

### 未知推送新类型：HostAtHomeNotify（仅记录）

- 24h 出现 `gamepb.visitpb.HostAtHomeNotify` ×5，按设计仅记录不响应。语义疑似与访客/在家状态相关，若未来官方证据确认其为好友在线信号，可作零成本在线通道候选；**当前无官方语义证据，禁止实现消费逻辑**（既有 at_home/摘要漂移在线证据链已覆盖需求）。

### 本次改动：restart 脚本机器路径泄露修复（隐私硬门违规，含已推送历史）

- **事故**：维护会话提交 aaf2283（restart 脚本）把含服务器用户名的机器绝对路径硬编码进受跟踪的 `scripts/restart-bot.sh` 第 6 行并已推送 origin/main——违反「绝对路径/用户名不得写入受跟踪文件」硬门。该提交走运维直推通道，未经进化隐私闸门。本轮全树扫描确认泄露仅此一处。
- **修复**：REPO_ROOT 改为从脚本自身位置推导（`dirname BASH_SOURCE/..`），行为不变（本机推导结果同路径），仓库不再含机器路径；`git grep` 确认受跟踪树零残留。
- **遗留（需用户决策）**：aaf2283 历史提交对象中仍含该路径。按 2026-09-22 参考仓库名暴露先例「历史已暴露不回写（历史重写需用户确认）」处理；如需清除需仿 2026-08-25 干净根历史重写流程，由用户确认后执行。
- **预防**：后续维护会话直推提交同样受隐私硬门约束——新增 shell/脚本一律动态推导路径，禁止粘贴本机绝对路径。

### 沉淀审计（1a-pre）与活动域复核

- 基线 e1578c2 以来 12 个维护提交中，两个模式类 bug 修复（空值渲染 0cb60e9、共享计数器 3372264）沉淀在位：core/docs/skills/agent-authored-code-checklist.md（本机私有）+ 本文件「进化产出的前端/状态逻辑 bug 模式」一节，无需补登。
- 活动域：报告 up-to-date，unknown/ended 均空，seedRecognition 40 类零缺口；秋祈良愿 enabled=true status=20（祈愿 remainingCount=1、activityDay=2）、快乐不独享快乐值 10、档位奖励 80002/80013 图标本机在库；枸杞三 PNG 已人工提交进库、6001 仍无图标待证；旧活动（雨落成诗/公益小红花/千星）worker/data-provider/controllers/web 零可达调用；无未下发 ID 枚举、无未知接口试探。
- **6002 种子线索（待证不登记）**：公开参考项目 2 的 PR#82 新增 6002 图标与 ItemInfo/Plant 大表更新（秋祈良愿第二限定种子疑似）。本机 Bag 24h 零 6002 出现、bag_unclassified 零条——按硬门 10b 外部配置只是线索，待本机 Bag 实际出现后按 10g 闭环登记。
- 外部版本线索维持不采纳：PR#82 游戏版本 1.14.2.11_20260922、TSDK 1790160550；本机服务端 version_info 通道 24h 零下发，clientVersion 1.13.0.5_20260723 与 wasm 98cc5301 基线一致。

### 公开对照（增量，6 组查询全部成功，按 updated 倒序）

- public-reference-1：9982736 与 09-24 activity 轮已审提交相同，无新增；public-reference-3：384aa1b7 为镜像同步 public-reference-1（无实质内容）；public-reference-4：08-23 后无新增。**public-reference-2 新增 PR#82（9c30b059 合并）已只读对照**：秋日活动+SVIP 商城整合——活动 Operate 编码与本仓库已接入的官方编码器证据链同源同级（无新增可接入命令）；商城不限购/售罄修复无本机对应问题（24h 零商城失败），不移植；SVIP 分页非本仓库需求。
- 新候选扫描：qq-farm/QQ农场/qq farm bot/nqf farm/农场自动化/farm bot websocket 六组，新面孔均为 CDP/视觉/ADB 类浏览器自动化（架构不同、风险面不同、无可借鉴调度分层），同源 fork 其余无实质更新。参考 SHA 已记 ignored sources.json。

### 环境基线与验证

- `tsdk-v3.9.0.wasm` SHA-256 与 `tsdk-ace-runtime.md` 基线一致；clientVersion 零条服务端自动更新；两账号设备串启用且互不重复（仅核对唯一性）。
- 本轮改动仅 `scripts/restart-bot.sh` 一行（路径推导）+ 本文件；未修改 worker.js、收菜/偷菜/重点 HOT-PREARM、请求治理、登录保活、设备串、TSDK/ACE、好友/盯梢调度、活动代码。`bash -n` 通过；`cd core && node --test --test-concurrency=1 test/*.test.js`（Node 20 v20.20.2）全量 **671/671 通过**。
- 回滚 `git revert <本轮提交>`：恢复脚本硬编码路径（不建议——会重新暴露机器路径）；已推送历史中的路径清除需单独的用户确认流程，不在本提交范围。本轮 Agent 不重启 Bot、不推送远端。

## 安全巡检记录（2026-09-25，零代码改动收口）

### 最近 24h 日志与反馈审计（10e/1a 硬门）

- 审计窗口约 2026-09-24 16:15 ~ 09-25 16:15 UTC，4346 条结构化日志、解析失败 0；「请求超时」「发送失败」「被踢下线」「熔断/cooldown」「bag_unclassified」「seedId=0」「裸植物/物品/种子 ID」「空图」全部 **0**。窗口内被踢 0 次。
- 核心收益链全绿：到点保护收获 **62/62**、哨兵抢收 **43/43**（成熟到点后 125–170ms 出手，80–300ms 窗口内）、偷好友菜 **10/10**、重点巡田健康 **1035/1035**、帮助 56/56。快车道 0 次属正常（推送 94 条均未同时命中重点+在线双闸门）。
- `result=error` 全量聚合（不分 level）仅 2 条：daily_share 00:00 档解码失败（既有待证项，当日重试已收口模式）+ TaskInfo 治理拦截。治理拦截全天仅 2 次（20:53:36 AllLands+TaskInfo 同刻），前 4.5 秒为重点好友 PREARM 布控+巡田突发——即 09-24 已记录的「在线快档×60s 预算饱和」设计内边界，量级 6→2 衰减，不据此放宽预算或放慢在线档。
- 施肥趋势 1 次（09-24 16:55）：触发先于哨兵抢收约 5 秒、reason 为地块级证据、60 秒无新证据即冷却——符合 2026-09-11 证据门与 2026-09-22 定标，未误触发。
- 错误级仅 3 条 = 账号 A 40188 授权失效链（05:58 保活失败 + 14:25 Code 刷新失败 ×2），**账号 A 仍需人工重新扫码**，属已知路径不改代码。**relogin 按钮（a6076e3）首次产线使用闭环**：2 次点击各触发一次 Code 刷新、失败原样透出到面板（11 秒间隔、有界、无重试风暴）——新功能在授权失效路径上行为正确。
- 反馈 runtime_warn/error 簇全部对齐已知路径（daily_share 00:00 档、40188 时刻、worker 重启 Socket.IO 重连簇）；not_ready 7 次为账号离线时活动页单次读取（无定时器轮询，09-21 修复在位）。未知推送 16 类全部为已登记家族（HostAtHomeNotify 继续观察，本轮 +3 条，仍无官方语义证据不实现消费）。
- 沉淀审计（1a-pre）：上次巡检轮 24a2727 后仅 5dddd4e（push_failed 启动自愈），已有 `core/docs/skills/privacy-push-failure-resolution.md` 沉淀（本机私有，含 2026-09-24 案例与自愈接线），无需补登。

### 活动域复核（指纹变化按既有模式处理）

- 现成报告（扫描时间 09-25 16:17Z）up-to-date：unknown/ended 均空、candidateGroups 0；seedRecognition 45 类零缺口。种子目录审计 20 条 **ID 级与 09-23 基线完全一致**（休眠 29999/21072、名称冲突 7 项、20883 等级、source_plant_missing 10 项），无新证据不动。
- `getGenericFallbackItemIds()` 为空；`npm run fetch:official-icons` 已运行——本机仍无抓包 URL 证据，零网络请求，7 项商城装饰+bichon/leyuan 变异图标+6001 专属图维持待证（需抓包会话或 miniapp settings.json）。
- 活动证据指纹变化（f40b2ca4）按既有模式归因：三组在架活动（2026092400 秋祈良愿 / 2026092500 快乐不独享 / 2026090100 S3）均为面板手动操作 + 用户官方客户端人工进度推进（同 starRecord 先例），无新道具 ID、无新玩法结构、无适配触发；本轮未发起额外游戏请求核对。**下轮若 wish/happy-share 出现新道具 ID 或新 details 结构（如奖池/进度下发），须按 10g 从 Bag/土地证据闭环登记**。6002 种子线索维持待证（本机 Bag 24h 零出现）。

### 公开对照（增量，6 组查询 4 组有效返回，按 updated 倒序）

- public-reference-1（9982736）/public-reference-3（384aa1b7 镜像）/public-reference-4（1bc45d3e）均与 09-24 已审相同，无新增。
- **public-reference-2 新增 PR#84（2026-09-25，3 提交）已只读核对范围**：微信协议对齐——新增 wx 专用 tsdk wasm、改 TSDK/ACE/network/掉线诊断与 worker 连接管理。两个不采纳理由：①TSDK/ACE/协议实现属外部仓库禁复制域（硬禁令）；②掉线诊断方向命中 2026-09-14 用户裁定「断线重连免扫码不做」。本机无协议漂移证据（wasm 基线一致、clientVersion 零下发、24h 零 ACE 失败），维持待证线索不采纳。
- 新候选扫描：新面孔均为视觉/CDP/Go 异构架构（QQ农场关键词两组中文查询编码解析失败如实记 partial），无可借鉴调度分层，不深入。参考 SHA 已记 ignored sources.json。

### 环境基线与验证

- `tsdk-v3.9.0.wasm` SHA-256 与 `tsdk-ace-runtime.md` 基线一致；clientVersion `1.13.0.5_20260723` 零条服务端自动更新；两账号设备串启用且互不重复（仅核对唯一性哈希，未输出值）。
- 本轮**零代码改动**（核心收益链 55/55+10/10 全成功、治理零风暴、全部异常命中已知路径与在案待证项，按硬门 8 代码保持不变），本条目仅按硬门 10g 记录新证据（relogin 产线闭环、PR#84 外部线索、预算饱和边界量级衰减、指纹变化归因）。
- 验证：`cd core && node --test --test-concurrency=1 test/*.test.js`（Node 20 v20.20.2）全量 **671/671 通过**（纯文档改动，测试不受影响，按零改动轮惯例仍跑全量确认基线）。
- 回滚：本提交仅文档，`git revert <本轮提交>` 无任何行为影响。本轮 Agent 不重启 Bot、不推送远端。


## 微信扫码闭环、有效授权保活与跨页面导航修复（2026-09-25，维护会话）

### 本次用户现象与确定原因

- 用户报告授权失效、扫码确认后仍不能登录，以及概览/个人区域切换活动页一直不加载但刷新后可进入。最近运行记录确有授权范围失效；它代表旧授权不能继续使用，不等于新扫码也应失败。当天自动巡检的文档提交已在当前分支，本轮会随维护修复一并应用，不伪造旧反馈全部解决。
- 导航根因已通过真实 Vue renderer 复现：概览页新增账号弹窗后变成 Fragment，多根组件直接放进 `Transition mode=out-in` 无法完成离场，下一页不挂载。Layout 改为按路由 key 的固定单元素容器；补明确静态分包加载失败的一次同源恢复，普通接口/业务失败不会触发刷新循环。
- 扫码入口先设置 initialTab、随后又无条件改回 manual，使重新登录入口失效；同标签重新打开也不会触发 watcher。已保留显式标签并确保每次打开扫码入口只建立一个当前会话；隐藏弹窗不能清掉其它入口的会话。

### 登录/续期修复

- 前端扫码请求按会话代次隔离，关闭、换二维码、换账号时中止旧请求；旧响应及 finally 不污染新状态。HTTP 错误和原生 Success:false 不再被 legacy code:-1 当成等待。生成二维码/确认/换 Code 都有有界超时；已确认会话按服务端五分钟期限允许人工重试 Code，不沿用未确认二维码的自动刷新期限，不自动循环重试。
- OAuth 回调是一次性的：确认回调已成功后，凭据交换的临时失败只重试后续阶段，不重放旧 OAuth code；已完成确认重复读取不产生网络请求。回调结果未知时重新获取二维码，不能猜测它没有被消费。可选用户资料读取限制等待时间，不能拖住已成功授权。
- 扫码续期若 token 已轮换、后续阶段失败，新 token 保留在同一私有会话；临时网络错误与真正失效分开提示。旧账号续期与保存新扫码凭据共用账号锁，锁内重读待绑定会话。保存成功后、释放锁前失效旧凭据任务代次，防止旧异步失败又阻断新授权。离线账号重新扫码成功会启用保活并启动一次，普通编辑或改备注不会擅自启动。
- runtime 修复预续期 definitive 失败后仍继续申请 Code、定时保活失败未共享阻断、并发刷新重复重启、停止/重扫后旧异步完成继续回写或挂重登任务。阻断身份包含凭据及成功时间，新扫码即使复用 refresh token 也可解锁；临时失败保留受控退避及有效 loginBuffer 路径。保活按实际有效期提前执行，不为保活主动打断在线游戏连接。
- 真正被上游撤销的授权无法靠程序恢复；本轮让新授权能正确保存、启动和续期，并减少不必要的反复扫码，不承诺永久免扫码。未调用真实凭据试探登录，也未修改 TSDK/ACE、设备身份、游戏协议、收菜/偷菜/HOT/PREARM。

### 系统检查、沉淀与验证

- 由独立子 Agent 修复导航、前端扫码、runtime 生命周期并运行行为测试；Claude Code 只读交叉审查，用模拟 HTTP 独立复现 OAuth 重放，并指出扫码保存锁缺口。主维护会话核对逻辑和跨层验收。双 Agent 自进化的执行器仍按页面选择，现有 efficientMode=true、dailyBrain=false 保持；子 Agent 初检/实现/自检，主 Agent 主要方案与最终验收，无重复主复盘或同结果双复核。
- 已更新公共巡检 skill 与本机代码自检清单：真实跨页面导航、路由根节点形态、请求取消/代次、一次性授权、多阶段凭据写入，以及“API成功不等于账号已经运行”。当前代码中的参考身份继续只留本机映射，文档保留相对路径和提交定位。
- 回归覆盖导航连续切换/旧布局反向失败、旧分包只恢复一次、扫码并发与跨弹窗隔离、错误分类和人工重试、确认分阶段恢复、账号锁内保存/代次栅栏、离线重扫启动、真实授权阻断及新授权解锁。所有凭据均为隔离合成数据，测试不请求游戏服务器、不写生产会话。
- 验证：Node 20 全量后端 701/701 通过，前端类型检查和隔离构建通过，改动文件 ESLint 无错误；导航旧布局反向对照真实失败，新布局跨页面切换通过。公开文件新增行/完整提交范围须通过隐私审计，源码注释中的参考身份仅作匿名化，不改业务。部署仍只复用既有 farm:0.0，确认当天进化与本轮维护都在部署 HEAD 中；失败反馈不擅自清空。回滚只撤销必要差异，不恢复旧凭据、个人信息或已禁止的公开参考标识。

## 40188 授权范围专项补查（2026-09-25，维护会话）

- 用户要求重点解决持续登录中的授权范围失效。本机历史记录显示失效前存在多次成功续期，但旧日志已把上游错误翻译为统一提示，缺少失败阶段；不能据此断言所有 40188 都是用户撤销授权，也不能认定本次代码缺陷就是历史事件的直接原因。
- 确认并修复 `wx-login-adapter.js` 的凭据落盘缺口：刷新 token 与 loginBuffer 成功后，必须立即持久化完整检查点，再申请游戏 Code。此前第二次 Code 请求超时会跳过最终保存，下一次仍使用旧 token。存储异常现在明确失败且不回显本机路径或凭据，不再吞掉异常后报成功。
- 收窄永久失效判断：一般回包结构异常、HTTP/网络错误不再因同时含 refresh 与 invalid 就永久熔断；明确授权码仍停止无效重试。`service.js` 为错误保留固定阶段、整数上游码，以及 token 刷新是否已成功，适配层仅记录白名单诊断，不输出上游原始消息或令牌。可区分刷新 token 被拒绝与刷新成功后换 loginBuffer 被拒绝。
- Claude Code 只读核对公开官方说明，现有扫码 scope 组合符合 PC 小程序授权要求。公开材料不足以确认本次 40188 的触发原因、刷新后的权限保留策略或权限有效期；不得把合成的“刷新成功后 buffer 拒绝”测试写成线上实证。令牌续期与小程序授权范围不同，无法据现有证据承诺永久免扫码，亦不通过猜测增加 scope 或高频请求。
- 验证：新增适配层四项行为回归、服务层两项阶段与脱敏回归；协调进程在隔离旧基线独立运行当前四项适配层测试，4/4 因行为断言失败，无导入或环境错误。当前全量后端 707/707 通过；前端类型检查、隔离构建及改动文件 ESLint 通过。本次检查另确认 17:13 UTC 新凭据保存后约十秒出现真实游戏登录成功；它证明当前授权可以进入游戏，尚不能证明跨日持续续期，未标记相关反馈全部解决。
- 本轮不修改协议、设备身份、游戏调度或页面角色选择；保留现有在线连接不受保活失败主动打断的规则。回滚仅撤销本轮源码与测试差异，不恢复旧凭据。继续通过既有运行窗格部署。
