# 限时活动适配标准手册

本文用于把 QQ 农场新限时活动稳定接入项目。流程覆盖协议抓包、资源提取、静态配置、
后端服务、管理接口、前端页面和验收，避免只补页面或图片后仍出现裸 ID、按钮不可用等
半成品状态。

参考样本是 2026 年 7 月“心许千灯星垂野”，但流程不依赖该活动。

## 完成定义

一次活动更新同时满足以下条件才算完成：

- 活动入口、子活动顺序、标题、时间和状态正确。
- 展示协议与操作协议来自成功抓包或可验证的官方运行数据。
- 新种子、植物和果实建立完整 ID 映射。
- 活动、背包、土地和图鉴不显示“物品xxxx”“植物xxxx”或“果实xxxx”。
- 商品优先显示活动响应名称，静态物品表只作兜底。
- 官方缓存中可取得的活动图片已导入，并保留文本兜底。
- 改变状态的按钮具有前后端校验，成功后刷新活动数据。
- 后端测试、前端类型检查、构建和专用账号在线验收通过。

“活动页能打开”不等于适配完成。

## 安全边界

- 只分析自己账号、自己设备上的流量和客户端缓存。
- HAR 含登录 code、网关 Token、账号标识及签名，不得提交到 Git。
- 原始小程序包、HAR、日志和完整缓存不进入仓库。
- 从缓存复制文件后再处理，不直接修改微信或 QQ 容器。
- 在线领取、兑换、抽奖会改变账号状态，只使用专用测试账号。
- 没有成功操作样本时前端保持只读，不根据旧活动猜命令号。

## 1. 采集完整样本

每个活动至少抓取：

1. 首次打开活动中心。
2. 依次打开每个子活动。
3. 领取一项可领取奖励。
4. 每种操作执行一次最小数量，例如兑换 1 个、抽取 1 次。
5. 操作后停留数秒，让余额、背包和状态刷新进入 HAR。
6. 有新种子时，进入背包、种下一株并打开土地详情和图鉴。

建议命名：

```text
01_打开活动.har
02_领取奖励.har
03_商店兑换1个.har
04_种植新植物.har
```

文件名只记录动作，不记录账号、手机号或 Token。

## 2. 快速检查 HAR

在 `core` 目录执行：

```bash
npm run inspect:activity-har -- "/完整路径/03_商店兑换1个.har"
```

脚本读取 Charles/Proxyman HAR 的 `_webSocketMessages`，输出：

- 请求方向、时间和 client sequence；
- service、method 和正文长度；
- `ActivityService.Operate` 成功响应中的活动 ID、命令号和业务数据。

脚本不输出 `auth_token`。留档时只保存脱敏结果，不保存原 HAR。

QQ 农场的网关请求正文经过当前会话 TSDK 加密，HAR 请求正文不能直接按 protobuf 解码是
正常现象。用以下证据交叉确认：

- 相同 `client_seq` 的成功响应；
- 操作前后的活动状态；
- 紧随响应的 `ItemNotify`、余额或土地通知；
- 客户端 protobuf 定义；
- 专用账号的最小在线验证。

项目发送时会统一执行 protobuf 编码和 TSDK 加密。业务代码不得复制 HAR 密文字节。

## 3. 建立活动协议表

记录主活动和每个子活动：

| 字段 | 含义 |
| --- | --- |
| `uid` | 活动族或赛季标识 |
| `id` | 活动 ID |
| `parent_id` | 父活动 ID |
| `type` | 活动类型 |
| `title` | 服务端标题 |
| `start_time` / `end_time` | 生效时间 |
| `cmd` | 打开、领取、兑换等操作命令 |

活动 ID 和命令号写成具名常量，集中放在
`core/src/services/activity.js`，禁止在控制器和 Vue 组件中散落数字。

先检查 `core/src/proto/activitypb.proto`。新字段按抓包结构追加，并在
`core/src/utils/proto.js` 注册需要直接编解码的消息类型。

兑换商店常见结构：

```proto
message ExchangeShopOperateParams {
  int64 id = 1;       // 商品槽位 ID，不是物品 ID
  int64 count = 2;
}

message OperateRequest {
  int64 id = 1;       // 接收操作的子活动 ID
  int64 cmd = 2;
  ExchangeShopOperateParams exchange_shop_operate = 101;
}
```

必须区分：

- `slot.id`：活动商店槽位；
- `slot.item.id`：兑换所得物品；
- `slot.cost.id`：活动货币；
- `activity.id`：接收操作的子活动。

## 4. 名称和图片规则

活动商品及奖励名称优先级：

1. 当前活动响应的 `raw.name`；
2. `ItemInfo.json` 或活动增量配置；
3. `物品{id}` 兜底。

活动响应通常比静态表新。不能因为图片已经按 ID 映射成功，就让标题继续绑定旧
`ItemInfo.json`，否则会出现“图片正确、名称仍是物品201008”。

资源来源优先级：

1. 当前设备已下载的官方展开缓存；
2. 当前小程序包及分包；
3. HAR 中的官方静态资源 URL；
4. 纯文本或统一占位图。

不要用生成图片替代可取得的官方素材。

### macOS 微信缓存

常见位置：

```text
~/Library/Containers/com.tencent.xinWeChat/Data/.wxapplet/
~/Library/Containers/com.tencent.xinWeChat/Data/Documents/app_data/radium/users/*/applet/
```

先按 AppID 缩小范围：

```bash
find "$HOME/Library/Containers/com.tencent.xinWeChat/Data" \
  -path '*目标AppID*' -type f -mtime -3 -print
```

微信只能取得微信端实际加载的包和缓存，不能据此判断 QQ 包是否存在。

### macOS QQ 缓存

QQ 农场小程序的已确认展开目录：

```text
~/Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX/miniapp/temps/miniapp_src
```

QQ 端通常已有 `miniapp_src`，优先使用展开目录，不默认套用 `.wxapkg` 工具。两类目录
承担不同职责，不能只检查其中一个：

| 位置 | 主要内容 | 用途 |
| --- | --- | --- |
| `miniapp_src` | 活动代码、入口、`game.js`、基础资源索引 | 确认活动 ID、入口、模块名和 CDN 资源索引 |
| `gamecaches` | 启动后下载的界面、种子、作物、Spine、装扮 | 提取实际图片和运行时资源 |

定位当前农场展开包：

```bash
QQ_MINIAPP_SRC="$HOME/Library/Containers/com.tencent.qqexminiprogram/Data/Library/Application Support/QQEX/miniapp/temps/miniapp_src"

find "$QQ_MINIAPP_SRC" -maxdepth 1 -type d -name '1112386029_3_*' -print
```

按修改时间选择最新版本，再搜索活动 ID 和资源关键词：

```bash
rg -n -S \
  '2026072700|Season/S2|S2BigEvent|S2Shop|S2BattlePass|S2Jieqi|qianxing_entrance|xingsha' \
  "$QQ_MINIAPP_SRC/1112386029_3_最新目录/game.js"
```

`game.js` 能证明模块和资源索引存在，但不代表大图已经写入展开包。需要图片时继续查
`gamecaches`。

### 新旧缓存差分

识别新增作物时优先比较两个时间点的资源清单，不要只凭活动页面猜测：

```bash
find "/旧缓存/gamecaches/plant" -type f -print | sort > /tmp/plant-old.txt
find "/新缓存/gamecaches/plant" -type f -print | sort > /tmp/plant-new.txt
comm -13 /tmp/plant-old.txt /tmp/plant-new.txt
```

缓存文件名可能是哈希或时间戳，最终还要比较 JSON 中的逻辑路径，例如
`model/v4/Crop_9003`、`Crop_9003_Seed`。建议记录旧版本日期、最新版本日期、逻辑
路径、缓存文件和解码 PNG；只把最终配置与确认后的 PNG 提交到仓库。

### Cocos 与 ASTC

活动图片常在 `usr/gamecaches`。JSON 文件把逻辑路径映射到 `.astc` 文件：

1. 搜索 `Crop_`、`activity/`、`exchange`、活动拼音或已知物品 ID。
2. 根据 JSON 依赖找到 `.astc`。
3. 复制到临时目录并用 ASTC 工具解码为 PNG。
4. 人工确认内容和透明通道。
5. 用稳定 ID 命名后导入仓库。

项目已内置植物阶段图片提取工具。需要更新全部普通植物阶段资源时，在仓库根目录运行：

```bash
npm run extract:plant-phases -- \
  --install-tool \
  --download-missing \
  --all
```

`size: 2` 的作物均使用 Spine 资源。导出器会额外扫描本机 `mainscene` 缓存，
用 `ffmpeg` 从 atlas 中还原 `zhongzi`、`grow_02`～`grow_05` 和 `kuwei` 静态帧。

只更新指定植物时使用其官方资产名：

```bash
npm run extract:plant-phases -- \
  --install-tool \
  --download-missing \
  --assets Crop_1037,Crop_9003
```

参数说明：

- `--install-tool`：首次运行时下载 ARM 官方 macOS 通用版 `astcenc` 到被 Git 忽略的
  `core/data/tools/`，后续复用。
- `--download-missing`：本地QQ账号缓存缺少某阶段时，从QQ官方CDN下载到系统临时目录；
  不回写或修改QQ缓存。
- `--all`：根据 `Plant.json` 推导普通植物资产名，导出能够定位的全部阶段。
- `--assets`：仅更新逗号分隔的指定资产，适合新活动植物的增量验证。

工具会跨本机多个QQ账号的 `gamecaches` 查找资源，按最新 `plant/config.*.json` 解析
Cocos压缩UUID和阶段路径，将ASTC转换成透明PNG，并合并更新：

```text
core/src/gameConfig/plant_images/
├── Crop_1037/
│   ├── 1.png
│   ├── 2.png
│   └── ...
└── manifest.json
```

QQ源目录始终只读。提交前应抽查种子、发芽、开花、成熟阶段的透明通道、锚点和尺寸，
并运行后端测试与前端生产构建。特殊Spine植物若没有阶段静态纹理，会被跳过并由前端
回退到现有种子图片，不能用推测图片补齐。

种子图片命名：

```text
{seedId}_Crop_{assetId}_Seed.png
```

商店图片命名：

```text
{itemId}_{协议返回名称}.png
```

物品图放入 `core/src/gameConfig/seed_images_named/`；活动背景和标题放入
`web/public/activity/{activity-slug}/`。

### S2 活动资源检索基线

“心许千灯星垂野”已确认使用以下资源族。以后更新 S2 或相邻赛季时先搜索这些名称，
再寻找新增或替换项：

- `Season/S2/S2MainUI`
- `S2BigEvent`，包含 28 个星宿点位
- `S2Shop`
- `S2BattlePass`
- `S2Jieqi`
- `qianxing_entrance`
- `xingsha`

当前缓存还包含至少 14 张星砂商品图、8 个月相素材、星砂图标、星宿/流星/夜景效果，
以及 S2 头像、名牌和成套农场装扮。资源清单用于发现候选项；最终商品名称、物品 ID
和槽位仍以活动协议为准。

## 5. 新植物必须补全 ID 链

只复制种子图片不算完成。至少建立：

```text
seed item ID → plant ID → fruit item ID → asset_name → 名称 → 图片
```

活动数据早于全量静态表发布时，将增量写入
`core/src/gameConfig/EventPlants.json`，由
`core/src/config/gameConfig.js` 合并到现有 Map。

最小增量项：

```json
{
  "id": 1029003,
  "seed_id": 29003,
  "fruit_id": 49003,
  "asset_name": "Crop_9003",
  "name": "星语铃花"
}
```

名称证据优先级：

1. 服务端活动或背包响应；
2. 客户端资源路径、Spine 名称或配置文本；
3. 官方页面；
4. 人工识图临时名。

临时名必须在更新记录中标注，拿到正式名称后覆盖，不能把推测写成官方名称。

### 本次 plant 差分基线

相较 2026-07-22 的旧资源快照，最新 `plant` 资源包增加了以下 12 组。它们包含本期
新增植物和本期奖励引用的旧植物，不能把“缓存新增”全部等同于“游戏首次新增”：

| 作物资源 | 种子物品 ID | 当前项目名称 |
| --- | ---: | --- |
| `Crop_9003` | `29003` | 星语铃花 |
| `Crop_1353` | `21353` | 粉樱花 |
| `Crop_264` | `20264` | 红色郁金香 |
| `Crop_1404` | `21404` | 白牵牛花 |
| `Crop_108` | `20108` | 铃兰 |
| `Crop_1037` | `21037` | 粉花凤仙 |
| `Crop_6032` | `26032` | 金盏花 |
| `Crop_1050` | `21050` | 卷丹百合 |
| `Crop_1251` | `21251` | 紫玫瑰 |
| `Crop_1380` | `21380` | 米兰花 |
| `Crop_129` | `20129` | 勿忘我 |
| `Crop_375` | `20375` | 木槿 |

其中活动新增证据最明确的是：

- `29003 → Crop_9003_Seed → 星语铃花`
- `21353 → Crop_1353_Seed → 粉樱花`

已导入资源：

- `core/src/gameConfig/seed_images_named/29003_Crop_9003_Seed.png`
- `core/src/gameConfig/seed_images_named/21353_Crop_1353_Seed.png`
- `core/src/gameConfig/EventPlants.json`

星语铃花还存在以下稀有作物 Spine 路径：

```text
spine/v2/xiyouzhongzi/xingyulinghua/1028003
spine/v2/xiyouzhongzi/xingyulinghua/1029003
spine/v2/xiyouzhongzi/xingyulinghua/1128003
spine/v2/xiyouzhongzi/xingyulinghua/1129003
```

这些编号是资源变体或普通/稀有植物 ID 的候选证据，不可直接全部写入 `plantMap`。
必须结合土地响应中的真实 `plant.id`、种子 ID 和变异字段确认；当前土地抓包已确认
`29003 → 1029003`。

## 6. 代码接入顺序

按以下方向实现，避免前端先出现可点击但无协议的按钮：

```text
proto
  → core/src/services/activity.js
  → core/src/core/worker.js
  → core/src/runtime/data-provider.js
  → core/src/controllers/admin-helu-activity-routes.js
  → web/src/stores/activity.ts
  → web/src/views/Activity.vue 和 components/activity
```

每个改变状态的操作必须：

- 校验活动连接、槽位或奖励 ID；
- 校验数量为正整数；
- 校验货币类型、余额、拥有状态和兑换上限；
- 记录活动 ID、命令、槽位、物品、数量和价格；
- 不记录 Token 或完整账号凭据；
- 成功后重新获取活动状态；
- 将服务端业务错误转换成可理解提示。

前端绑定 store 的真实 loading 状态，避免重复点击。

## 7. 本次活动的已确认基线

| 功能 | 活动 ID | 命令 |
| --- | ---: | ---: |
| 心许千灯星垂野主活动 | `2026072700` | — |
| 观星礼录 | `2026072701` | 领取 `21` |
| 星砂商店 | `2026072702` | 打开 `7` |
| 星砂商店 | `2026072702` | 兑换 `1` |

星砂物品 ID 为 `1023`。兑换正文：

```text
exchange_shop_operate {
  id: 商品槽位ID
  count: 兑换数量
}
```

成功样本为槽位 `47`、数量 `1`，对应有机化肥。该样本用于确认协议，测试不得自动再次
兑换。

## 8. 验证门槛

后端：

```bash
cd core
node --check src/services/activity.js
node --check src/core/worker.js
node --check src/runtime/data-provider.js
node --test test/*.test.js
```

前端：

```bash
cd web
./node_modules/.bin/eslint \
  src/views/Activity.vue \
  src/stores/activity.ts \
  src/components/activity/*.vue
./node_modules/.bin/vue-tsc -b
./node_modules/.bin/vite build
```

仓库检查：

```bash
git diff --check
git status --short
```

Google Fonts 网络失败若只是 UnoCSS 警告且 Vite 最终成功，不视为代码失败。

### 数据验收

- [ ] 主活动和所有子活动都能读取。
- [ ] 子活动顺序符合客户端。
- [ ] 奖励名称、数量和状态正确。
- [ ] 商品使用协议名称，不显示裸物品 ID。
- [ ] 商品图片与物品一一对应。
- [ ] 活动货币余额与客户端一致。
- [ ] 余额不足、已拥有、达到上限提示正确。
- [ ] 新种子在活动、背包、土地和图鉴中名称一致。
- [ ] 土地不显示裸 plant ID，图鉴不显示裸 fruit ID。

### 在线验收

使用专用账号：

1. 打开全部子活动并刷新。
2. 领取一项最小奖励。
3. 兑换一项最便宜且可重复的商品。
4. 核对余额扣减、背包增加和兑换上限减少。
5. 刷新页面并重启账号，确认状态仍正确。

## 9. 提交前清单

- [ ] HAR、Token、账号数据和完整客户端缓存未进入 Git。
- [ ] 活动常量具名，无散落魔法数字。
- [ ] protobuf 字段与成功样本一致。
- [ ] 新植物补齐种子、植物、果实和图片映射。
- [ ] 商品优先使用响应名称。
- [ ] 只读按钮仅在缺少成功操作协议时保留。
- [ ] 后端测试全部通过。
- [ ] 前端类型检查与生产构建通过。
- [ ] 更新 `progress.md`，区分已确认数据和推测数据。

## 10. 故障定位速查

| 现象 | 优先检查 |
| --- | --- |
| 图片正确但显示“物品xxxxx” | `normalizeExchangeShopItem()` 是否以 `raw.name` 作为 `itemName` |
| 土地显示“植物xxxxxxx” | plant ID 是否进入 `plantMap` |
| 图鉴显示“果实xxxxx” | fruit ID 是否进入 `fruitToPlant` 和 `itemInfoMap` |
| 种子图片不显示 | 文件名前缀、`asset_name`、`seedImageMap` |
| 商品按钮一直只读 | 是否有成功操作样本、`shopReadOnly` 是否关闭 |
| 兑换报找不到槽位 | 是否误把 item ID 当成 slot ID |
| 兑换成功但余额未刷新 | 操作后是否重新读取活动详情和背包 |
| HAR 请求正文乱码 | TSDK 加密是正常现象，检查相同 sequence 的响应和通知 |
| QQ 找不到 `.wxapkg` | 优先查 QQ `miniapp_src`，不要套用微信缓存路径 |
