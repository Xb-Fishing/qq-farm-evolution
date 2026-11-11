<div align="center">

<img src="web/public/icon.png" width="72" alt="QQ Farm Bot 嫩芽图标">

# QQ Farm Bot

**把日常农活交给小帮手，给每一次丰收留点期待。**

多账号管理 · 日常农活 · 作物图鉴 · Web 控制面板

<kbd>🌱 Node.js 20.19+</kbd> &nbsp; <kbd>📦 pnpm 10</kbd> &nbsp; <kbd>💚 Vue 3</kbd> &nbsp; <kbd>🐳 Docker Compose</kbd>

<br><br>
<img src="web/public/activity/star-festival/star-farm.png" width="340" alt="农场主题插画：绿植环绕的小屋与庭院">

[🌾 看看功能](#功能) · [🤖 AI 帮我安装](#ai安装) · [🚜 源码部署](#源码部署) · [🐳 Docker 部署](#docker-部署) · [🔑 账号登录](#账号登录) · [📖 使用文档](#文档)

</div>

> [!WARNING]
> 本项目仅供学习和研究。自动化操作可能违反游戏服务条款，账号限制、数据损失等风险由使用者自行承担。请勿用于商业运营、破坏游戏公平性或其他违法违规用途。

<a name="-能做什么"></a>

<a name="功能"></a>

## 🌾 能做什么

<table>
<tr>
<td align="center" width="33%">
<img src="core/src/gameConfig/seed_images_named/10007_浇水_icon_watering.png" height="64" alt="浇水壶图标">
<br><br><b>🌱 打理日常农活</b>
<p>收获、种植、浇水、除草、除虫<br>照看自己的田，也能拜访好友</p>
</td>
<td align="center" width="33%">
<img src="core/src/gameConfig/seed_images_named/42254_Crop_2254.png" height="64" alt="作物图鉴图标">
<br><br><b>🌻 认识每株作物</b>
<p>作物图鉴、土地状态与变异效果<br>看看田里长出了什么新惊喜</p>
</td>
<td align="center" width="33%">
<img src="web/public/activity/star-festival/star-token.png" height="64" alt="活动道具图标">
<br><br><b>🎉 看看任务与活动</b>
<p>任务、商城与已适配活动<br>查看奖励和当前可用的操作</p>
</td>
</tr>
</table>

- 👨‍🌾 **照看多座农场**：集中查看账号状态，为不同账号分别配置和启停。
- 🖥️ **随时看看田里**：Web 控制面板搭配实时日志与数据统计。
- 📱 **轻松添加账号**：内置微信扫码、手动填码和手机抓包登录。

活动支持随游戏更新而变化，部分活动仅提供只读展示；可用的兑换、抽奖和领取操作以面板为准。

<a name="ai安装"></a>

## 🤖 让 AI 帮你安装

不想逐项配置？把下面这段话发给能操作本机终端的 AI 助手，让它先阅读 [AGENTS.md 安装指南](AGENTS.md)，再完成安装和验证：

```text
请帮我在当前机器安装 GitHub 项目 Xb-Fishing/qq-farm-evolution。
先获取仓库并阅读根目录 AGENTS.md，按“AI 自动安装”完成环境检查、
依赖安装、管理员配置、构建和持久启动。没有指定选项时使用指南的默认方案，
自动生成强密码并妥善保存在本机。请实际验证面板、健康检查和管理员登录，
完成后告诉我访问地址、凭据保存位置、数据目录，以及启停和查看日志的方法。
```

指南会优先复用已有安装和数据；首次安装可自动生成管理员配置。微信扫码仍由你在面板完成。

<a name="-开始种田"></a>
<a name="把农场跑起来"></a>

<a name="源码部署"></a>

## 🚜 源码部署

需要 Node.js 20.19+、Git 和 pnpm 10，推荐使用 Node.js 24 LTS 或 22 LTS（22.13+）。本项目锁定 pnpm `10.30.2`。

```bash
git clone https://github.com/Xb-Fishing/qq-farm-evolution.git qq-farm-bot
cd qq-farm-bot

corepack enable
corepack prepare pnpm@10.30.2 --activate
pnpm install --frozen-lockfile
pnpm build:web

# 仅首次初始化：密码占位符需替换为自己的密码
export FARM_ADMIN_USERNAME='farm_admin'
export FARM_ADMIN_PASSWORD='<your-strong-password>'

bash start.sh
```

启动后在浏览器访问 `localhost:3007`，使用配置的管理员账号登录。

### 管理员初始化

全新数据目录没有默认管理员或默认密码。

- **用户名**：3–32 位英文字母、数字或下划线，例如 `farm_admin`；不能包含中文、空格或连字符 `-`。
- **密码**：6–128 位，包含大写字母、小写字母、数字、特殊符号中的至少两类；禁止使用 `password`、`123456`、`qwerty`、`abc123`、`111111`、`000000`，不区分大小写。
- 仅在数据目录没有管理员时创建；已有管理员不会因修改环境变量而被覆盖或重置密码。
- 源码启动不会自动读取根目录 `.env`，需先 `export`，或在进程管理器中配置环境变量。初始化失败时，日志会指出具体原因。

### 后台版本更新

超级管理员可在 **管理面板 → 系统配置 → 主程序版本更新** 检查新版本并点击“更新到最新版本”。仅使用本项目 `origin/main`，展示当前与最新提交；准备阶段会隔离安装锁定依赖、检查后端与前端、保留账号数据及已登记的本机定制，验证通过才应用。更新与自进化依次执行，失败可查看阶段记录，启动失败会尝试恢复旧版本。

此入口用于 Linux 源码部署，需要 Git、pnpm 和现有 tmux 服务窗格。Docker 或打包部署继续使用下方对应更新方式。在线常驻会话会核验原宿主、TCP 与登录代次，无法证明保留时不会标记更新成功。首次获得这个入口仍需按当前部署方式更新一次。

超级管理员还可在同页查看“待跟进调查”的实际复核结果与确切缺项；普通管理员无法访问版本更新及调查接口。

### 更新源码部署

先停止当前服务，再拉取代码、安装依赖并重新构建：

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm build:web
bash start.sh
```

<a name="-docker-部署"></a>

<a name="docker-部署"></a>

## 🐳 Docker 部署

需要 Git 和 Docker Compose。先克隆仓库并进入目录：

```bash
git clone https://github.com/Xb-Fishing/qq-farm-evolution.git qq-farm-bot
cd qq-farm-bot
```

首次部署时，在仓库根目录创建 `.env`，将密码占位符替换为自己的密码；用户名和密码遵循上面的初始化规则：

```dotenv
FARM_ADMIN_USERNAME='farm_admin'
FARM_ADMIN_PASSWORD='<your-strong-password>'
```

使用单引号包裹密码，避免 `$` 等字符被展开。已有管理员的部署可省略这一步。

构建并启动：

```bash
docker compose up -d --build
```

更新已有部署时，先执行 `git pull --ff-only`，再执行上述构建命令。

查看状态和日志：

```bash
docker compose ps
docker compose logs -f
```

修改 `.env` 后执行 `docker compose up -d --build --force-recreate`；仅执行 `docker compose restart` 不会更新容器环境。宿主机已导出的同名变量优先于 `.env`，如需改用 `.env`，先执行 `unset FARM_ADMIN_USERNAME FARM_ADMIN_PASSWORD`。

默认映射：

| 用途 | 端口或目录 |
| --- | --- |
| 管理面板 | `3007` |
| 手机抓包代理 | `18000–18999` |
| 持久化数据 | 仓库上级目录的 `data/`，挂载到容器 `/app/core/data` |

<a name="-登录方式"></a>

<a name="账号登录"></a>

## 🔑 账号登录

### 萌卡 NT

「添加账号 → 萌卡 NT」提供专用桥接地址。使用支持**面板账号密码和 Token**的 QQ 农场 Code 桥接插件，在萌卡里登录 Android QQ，将农场服务器地址填为页面显示的地址（以 `/mengka-nt` 结尾），使用本面板用户名和密码，然后推送一次。

首次新增账号会自动启动；已有在线账号只更新 Code，保持原连接。同一 Code 不重复处理，已有离线或手动停止的账号只保存 Code，需要在面板手动启动。原有账号权限和数量限制仍生效。此方式依赖萌卡宿主取码，不在面板保存 QQ 密码，也不兼容只支持访问 Code / Cookie 的插件。

<a name="-微信扫码登录"></a>

### 微信扫码

在「添加账号 → 微信扫码」获取二维码，用微信扫码并确认授权。登录流程已内置，无需单独部署扫码服务。

微信授权失效时需要重新扫码。用户设置中提供可选的微信重扫提醒，默认关闭；需配置自己的 Bark Key，并确保手机能访问面板地址。提醒不会代替微信授权。

### 手动填码

在「添加账号」选择对应平台，填写登录 Code，也可粘贴包含 Code 的游戏 WebSocket 地址。

### 手机抓包

1. 在系统设置中启用抓包登录。
2. 进入「添加账号 → 抓包登录」，按页面提示安装并信任证书、配置手机 Wi-Fi 代理。
3. 完全关闭并重新打开 QQ 农场，等待获取 Code。
4. 抓取完成后关闭手机 Wi-Fi 代理。

### 注册与卡密

- 管理员直接登录，无需注册卡密。
- 普通用户注册所需的时间卡密，由本部署管理员创建和提供；额度卡密用于登录后续费。
- 免费领取默认关闭，管理员创建可用时间卡密并开启领取后才可使用。

<a name="常用命令"></a>

## 📋 自动控制的日志与今日事件

首页的「运行日志」展示自动控制配置变化、查询内容、等待或跳过原因，以及执行进度和结果；事件筛选中可选任务/奖励、化肥、土地、出售、商城、好友互动和奶茶等分组。重复查询限频，实际动作和告警继续保留。

「今日事件」按功能分类，只新增已确认执行的操作结果；查询、等待、未执行的跳过及“已经领过”不算新动作。原有收菜、偷菜和重要异常仍保留，按北京时间切日，展示当天最近 200 条，可下载脱敏日志。

## 🛠️ 常用命令

| 命令 | 用途 |
| --- | --- |
| `pnpm dev:core` | 启动后端和已构建的面板 |
| `pnpm dev:web` | 启动前端开发服务器 |
| `pnpm build:web` | 构建前端 |
| `pnpm lint` | 检查前后端代码 |
| `pnpm -C core test` | 运行后端测试 |

<a name="数据备份"></a>

## 🧺 数据与备份

源码部署默认使用 `core/data/`；Docker 部署使用上表中的持久化目录。升级前请备份数据，妥善保管账号和登录凭据，不要将数据目录、`.env`、日志或密钥提交到公开仓库。

<a name="-使用文档"></a>

<a name="文档"></a>

## 📖 继续逛逛

- [AI 自动安装指南](AGENTS.md)
- [更新记录](docs/CHANGELOG.md)
- [活动适配说明](core/docs/activity-update-runbook.md)
- [TSDK/WASM 更新手册](core/docs/tsdk-update-runbook.md)

---

<div align="center">

<img src="core/src/gameConfig/seed_images_named/40021_Crop_21_Fruit.png" height="48" alt="活动作物图标"> &nbsp;
<img src="core/src/gameConfig/seed_images_named/41435_Crop_1435_Fruit.png" height="48" alt="作物果实图标"> &nbsp;
<img src="core/src/gameConfig/seed_images_named/42254_Crop_2254.png" height="48" alt="作物图标">

**一块小田，一点期待。🌿**

感谢上游开源项目和每一位参与贡献、反馈的使用者。

</div>
