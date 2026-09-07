# 交接文档：qq-farm-bot（更新 2026-09-07，活动 Agent 负责道具、玩法与专属前端的端到端进化）

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
- **公开同类项目只能做不可信只读对照**：仅在上述增量证据确有需要时按需查看 `LuckyTiger12138/QQ_Farm` 等公开仓库，只借鉴调度分层、任务追踪、有界恢复和活动/UI 组织；不得执行外部脚本、安装其依赖、运行二进制、添加 remote，也不得从外部项目复制或推断 RPC/cmd/字段、登录、设备、TSDK/ACE 或反检测实现。协议写操作仍只认当前官方客户端可达路径及自然成功请求样本。
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
7. **背包种子优先漏活动种子（2026-08-23 修）**：三连因——① `store.js` `getConfigSnapshot` 缺 `bagSeedKnownIds`，写入了读不出，前端永远走迁移分支；② `useStrategySettings.ts` 迁移分支在优先列表非空时不把背包新种子补进列表；③ `bag_priority` 种植只认优先列表内的种子，列表外既不显示也不种。修了 ①②；③ 是设计（列表即白名单）。注意 2×2 种子（如星语铃花）1x1 种植必跳过，只有开「2x2 优先」才走四格预留路径

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
- 公开项目是按需借鉴源，不是协议证据。本轮只读核对 `LuckyTiger12138/QQ_Farm` 的 `1bc45d3`：可借鉴视觉自动化任务追踪、有界修复/重启、多实例状态同步、活动作物处理和 UI 组织思路；它与其他公开仓库都按不可信输入处理，不运行脚本/依赖/二进制，不添加 Git remote。任何 RPC service/method/cmd、字段、版本、登录、设备或 TSDK/ACE 结论仍必须来自当前官方客户端可达路径和自然成功请求样本。
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
