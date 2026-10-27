# QQ Farm Bot：AI 安装与仓库约定

本文件供能够操作终端和文件的 AI 助手使用。用户请求安装、部署或升级时，按下方流程实际完成工作；仅请求解释、修改代码或文档时，不在当前机器启动安装。

## AI 自动安装

目标是把公开仓库部署成可访问、可登录的管理面板。不要只列命令，也不要在后台任务刚启动时就声称完成；持续检查到构建、服务和登录验证结束。普通部署无需游戏客户端源码、资源缓存或额外的 AI CLI。

### 1. 识别环境与已有安装

- 确认操作系统、当前目录、仓库位置、端口和权限，先读 `README.md`、`package.json`、`docker-compose.yml`。尚未获取代码时，克隆用户指定的仓库并进入根目录。
- 已有实例优先复用其部署方式、配置和数据目录；更新前备份。不要因 Docker 可用就把源码部署切换成 Docker，也不要创建第二个服务覆盖已有管理员。
- 默认面板端口为 `3007`。被占用时先确认是否已有本项目在运行；其他程序占用则选空闲端口，按部署方式修改宿主机映射或 `ADMIN_PORT`，不停止无关进程。
- 没有既有安装或指定方式时：已有可用的 Docker Compose v2 和运行中的 Docker daemon 就优先 Docker；否则使用源码。缺少工具时按系统选择官方安装方式，优先用户级安装，不覆盖其他项目的工具链。确实需要系统权限或工具授权时，再说明具体操作并使用对应审批入口。

### 2. 准备管理员配置

- 程序没有默认管理员或密码。首次安装可使用用户名 `farm_admin`，并自动生成随机强密码；用户已指定时优先使用指定值。
- 用户名需为 3–32 位英文字母、数字或下划线；密码需 6–128 位且至少两类字符，并避开常见弱口令。保存前先校验，不能反复用不合格值启动。
- 将初始化变量存入根目录已被 Git 忽略的 `.env`，限制为当前用户可读（POSIX 权限 `0600`；Windows 使用对应文件权限）。不要打印明文密码、上传配置或把密码写进进程命令行。
- 已有 `.env` 或数据目录时先检查并复用，不能直接覆盖。已有管理员不会因改变环境变量而被重置；缺少原登录凭据时应向用户索取必要信息，并明确哪些登录检查尚未完成。

仅在确认是全新安装且尚无 `.env` 时，可以用下面的 Node.js 示例生成配置（POSIX 终端）：

```bash
node <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const password = 'Aa1_' + crypto.randomBytes(24).toString('base64url');
const env = `FARM_ADMIN_USERNAME=farm_admin\nFARM_ADMIN_PASSWORD=${password}\n`;
fs.writeFileSync('.env', env, { flag: 'wx', mode: 0o600 });
console.log('已生成本机 .env，请妥善保管。');
NODE
```

`flag: 'wx'` 会拒绝覆盖已有文件。用户名与密码从文件读取；交付时告诉用户保存位置即可。检查外部同名环境变量是否覆盖了文件配置，不要修改已有管理员数据来绕过登录。

### 3. 选择安装路线并执行

#### Docker 路线

确认 `docker compose version` 和 `docker info` 可用后，从仓库根目录执行：

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100
```

Compose 会读取根目录 `.env`。默认数据保存在仓库上级的 `data/`，挂载到容器 `/app/core/data`；复用已有挂载位置。修改环境后用 `docker compose up -d --build --force-recreate` 更新，仅 `restart` 不会更新环境。

不要用 `docker compose down -v` 清空数据。镜像拉取、构建或健康检查失败时，读取具体错误并修复后重试，不把容器存在或命令已返回当作安装成功。

#### 源码路线

推荐 Node.js 24 LTS 或 Node.js 22 LTS（22.13+）。已有 Node.js 20.19+ 时，先检查锁定依赖的兼容性；不要使用 Node.js 18 或过早的 Node.js 20。pnpm 版本遵循根目录 `packageManager`，当前为 `10.30.2`。

优先通过已有 Corepack 启用对应 pnpm；缺少 Corepack 时采用适合当前用户的 pnpm 安装方式。完成后执行：

```bash
pnpm install --frozen-lockfile
pnpm build:web
node --env-file=.env core/client.js
```

最后一行用于前台启动与排错，运行目录是仓库根目录。本指南显式使用 Node.js 的 `--env-file`；现有 `bash start.sh`、`pnpm dev:core` 不会自动读取 `.env`。已有进程管理器配置过环境时，继续沿用其配置。

服务验证后，优先复用已有进程管理器。没有管理器时，按系统配置用户级服务，或在已有的 tmux 中持久运行；记录准确的工作目录、Node.js 路径、进程和日志位置。AI 工具可能在命令结束时回收临时子进程，不能仅用 `nohup` 或 `&` 后就宣布完成。

例如，确认 tmux 可用且目标会话尚不存在后，可从仓库根目录启动：

```bash
FARM_TMUX_SESSION="${FARM_TMUX_SESSION:-qq-farm-bot}"
tmux new-session -d -s "$FARM_TMUX_SESSION" -c "$PWD" \
  "$(command -v node)" --env-file=.env core/client.js
```

执行前先结束本次排错用的前台实例并核对端口，不能重复启动；已存在的会话应先核对并复用。同样检查进程管理器中继承的环境变量，避免覆盖本项目 `.env`。在下一次独立命令中检查服务仍可访问，再交付相应的 tmux 或服务管理命令。

停止时确认会话、服务或 PID 确实属于本项目，再操作该实例；不要使用 `pkill node`。不要假定 `stop.sh` 能管理此直接启动方式，也不要把后台运行说成已配置开机自启。Windows 使用对应的用户级进程管理或系统服务方式。

### 4. 实际验证

必须从用户最终采用的部署方式验证：

1. 访问 `/api/health`，确认 HTTP `200` 且 JSON 中 `ok: true`。这是无需登录的服务探针；`/api/status` 依赖认证和游戏账号，不用于首次安装健康检查。
2. 打开面板根路径，确认是真正构建出的登录页面，而非“web build not found”占位内容；页面引用的 JS/CSS 返回正确资源与内容类型，不能只检查 HTTP `200`。
3. 使用本机保存的管理员凭据请求 `POST /api/login`，确认 `ok: true`、非空 `data.token`，且角色为 `admin` 或 `super_admin`。
4. 用该 Token 作为 `x-admin-token` 请求 `/api/user/me`，确认用户名和角色符合预期。只输出验证结论，不回显密码或 Token；优先用进程内脚本读取文件并发送请求，避免把凭据拼进命令行。
5. 确认服务在安装命令或临时终端结束后仍能访问，记录所用管理方式。需要开机自启时使用适合该系统的服务管理器，并验证实际配置。

出现失败就检查对应阶段的日志、端口、环境变量和资源路径，完成修正与复验。旧部署缺少有效登录凭据等需要用户提供的信息，准确说明缺什么，不能把未验证项标成成功。

安装验收止于管理面板可用。游戏账号需要用户在面板自行扫码或填码；不要代替用户完成授权，也不要为验证安装自动种植、购买或领取游戏奖励。

### 5. 交付给用户

用简短清单告知：

- 实际访问地址，以及是否仅在本机验证、远程访问还需要什么配置；不自动开放防火墙或新增公网入口。
- 管理员用户名与凭据保存位置，不贴明文密码。
- 实际数据目录及备份位置；源码默认 `core/data/`，也可由 `FARM_DATA_DIR` 指定。
- 启动、停止、重启、查看日志和以后更新的实际命令。
- 哪些检查已通过；还有哪些步骤确实需要用户完成，例如微信扫码。

源码更新前先备份并停止本项目的旧实例，再拉取、安装依赖、构建和使用原方式启动；Docker 更新保留挂载数据。不要删除数据库、重新初始化已有管理员或引入未公开的配置文件。

---

## 开发维护备注

以下约定只在分析官方资源或修改代码时使用，普通安装无需处理。

### QQ 农场官方源码位置（macOS）

Mac QQ 会把 QQ 小游戏源码自动展开到：

```text
~/Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX/miniapp/temps/miniapp_src/
```

QQ 农场 AppID：

```text
1112386029
```

农场源码版本目录匹配：

```text
1112386029_3_*
```

每次 QQ 农场更新后目录尾部哈希都会变化。不要把某一个哈希目录永久视为最新版；
应按其中 `tsdk/tsdk.wasm` 的修改时间选择最新且完整的目录：

```bash
QQ_MINIAPP_SRC="$HOME/Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX/miniapp/temps/miniapp_src"

find "$QQ_MINIAPP_SRC" -path '*/1112386029_3_*/tsdk/tsdk.wasm' \
  -exec stat -f '%m %Sm %z %N' -t '%Y-%m-%d %H:%M:%S' {} \; | sort -nr
```

候选目录至少应包含：

```text
game.js
game.json
tsdk/tsdk.wasm
assets/
```

当前曾确认的 2026-07-29 展开目录为：

```text
~/Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX/miniapp/temps/miniapp_src/1112386029_3_67b898be9fed43f96df1108d3f31f25b/
```

该路径仅作为已知样例；开始分析前仍需执行上面的时间排序。

### QQ 农场远程资源缓存（macOS）

活动界面、种子/作物贴图、Prefab、Spine 和其他远程 bundle 通常不全部位于
`miniapp_src`，而是在各 QQ 账号的运行资源缓存中：

```text
~/Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX/miniapp/fs/*/1112386029/usr/gamecaches/
```

资源 URL 与本地缓存文件的映射记录在：

```text
~/Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX/miniapp/fs/*/1112386029/usr/gamecaches/cacheList.json
```

常见 bundle：

```text
mainscene/
extraRes/
plant/
delayRes/
audio/
petdog/
```

分析官方文件时只读源目录，先复制到临时目录再处理，不要直接修改 QQ 容器缓存。
WASM 更新的完整发现、快照、比较、验证和回退流程见：

```text
core/docs/tsdk-update-runbook.md
```

### 活动植物占地大小

向 `core/src/gameConfig/EventPlants.json` 补充活动植物时，不要只填写 ID、名称和
资源映射。必须同时核实作物占地大小；四格（2x2）作物需要显式填写：

```json
{ "id": 1029003, "seed_id": 29003, "fruit_id": 49003, "name": "星语铃花", "size": 2 }
```

省略 `size: 2` 会使活动作物默认按单格作物处理，导致它无法进入 2x2 优先种植与
土地预留流程，甚至被背包单格种植策略选中。新增或更新该字段时还要确认
`core/src/config/gameConfig.js` 将 `size` 透传到植物配置，并用测试断言
`getPlantBySeedId(seedId).size === 2`；必要时同时检查背包接口返回的
`plantSize` 是否为 `2`。
