# numable-usage

把你的 **Claude Code 用量**做成手机与桌面小组件 —— 会话数、消息量、token 消耗、费用估算、5 小时窗口、活跃热力图、按模型 / 工具 / 项目分布。

搭配 [Numable](https://numable.app)（iOS · Android · HarmonyOS · Windows）使用。

<!-- 截图位（发布后补） -->

## 安装

```
/plugin marketplace add XSuperao/numable-usage
/plugin install numable-usage@numable
```

装好后跑完一次 Claude Code 会话（插件会在会话开始、结束时采集，会话进行中每 10 分钟补一次），然后：

1. 在 Claude Code 里运行 `/numable-usage`，复制它给出的**读取令牌**
2. 打开 [Numable](https://numable.app) → 商店 → 装「Claude Code 用量」
3. 我的 → 凭证管理 → 在「包的凭证槽」里点这个包的**「绑定」** → **「+ 新建凭证」**
   → 粘贴令牌 → 保存（类型与域名已按包声明预填好，保存即完成绑定）
4. 仪表盘 → ＋ → 选「Claude Code 用量」→ 挑卡

> 第 3 步要从**槽位的「绑定」**进，不要从「+ 新建凭证」独立入口进 ——
> 后者不会自动绑定，还得手选类型。

## 它上传什么

**只有聚合数字。** 上传体里唯一的字符串是模型名与日期：

```json
{ "days":  [ { "date": "2026-08-20", "msgs": 2577, "sessions": 7,
               "out": 1342242, "in": 3088, "cacheCreate": 4157381 } ],
  "byModel": { "claude-opus-5": { "in": 564166, "out": 30313045, "msgs": 49366 } },
  "hours":  { "21": 3885 },
  "totals": { "sessions": 308, "msgs": 126623, "out": 73202757, "streak": 18 } }
```

## 它不上传什么

- **不上传 `cwd`、`gitBranch`、文件路径**；项目默认只上传匿名编号，你打开开关后才上传文件夹名
- **不上传任何对话内容、代码、工具调用结果**（工具只上传固定词表里的名字和次数，改动只上传行数）
- **不上传 `sessionId`**（只在本机用于去重计数）
- **不上传主机名**（`device` 是主机名的 SHA-256 前 12 位）
- **不上传花费金额**（费用估算是服务端按 token 数和公开价目表算的）
- 默认**不上报非 Claude 模型的名字**（并入 `other`，只保留 token 量）

这不是承诺，是结构：[`collect.cjs`](plugin/scripts/collect.cjs) 的 `buildPayload()` 是**显式白名单构造**，
[`worker.js`](service/src/worker.js) 的 `sanitizeClaudeCode()` 再做一次白名单过滤 ——
没列出来的字段两道都过不去。服务端结构上就存不下别的东西。
[测试](service/test.mjs)里有对应的可执行断言。

## 它读什么、怎么数

采集脚本逐行读本机的 `~/.claude/projects/**/*.jsonl`，只取计数需要的字段：
`type`、`timestamp`、`sessionId`、`isSidechain`、`isMeta`、`origin.kind`、`message.id`、`requestId`、
`message.model`、`message.usage`、`cwd`。另有三处**只看结构、不留内容**：

- 对话正文：user 行里有没有工具返回结果、开头是不是系统注入的固定标签（如 `<local-command-stdout>`）—— 判断这句是不是你本人说的；
- 工具调用的名字：映射进固定词表（Bash / Read / Edit…，MCP 工具一律并成「MCP」）后计次数；
- 编辑结果的补丁：只数行首的 `+` / `-`，算改动行数。

都是判断完、数完就丢，正文不落盘、不上传。`cwd` 只在本机用来区分项目：上传的是「本机随机盐 + 项目根目录」的哈希，
服务端反推不出路径；你运行 `/numable-usage` 打开「上传项目名」后，才会附上项目文件夹名（只取最后一段）。

| 指标 | 口径 |
|---|---|
| token | 按 API 响应计。Claude Code 把一次回复的每个内容块各写一行、每行带同一份用量，按 `message.id` + `requestId` 去重；含 subagent |
| 费用估算 | 服务端按 Anthropic API 标价折算（输入 / 5 分钟与 1 小时缓存写入 / 缓存读取 / 输出分别计价，快速模式翻倍，联网搜索每千次 $10）。订阅用户实际不按此计费 |
| 消息 | 你发的话 + Claude 的回复（同样按响应去重），不含工具返回结果、系统注入、subagent 内部往返 |
| 活跃时长 | 有往来（你或 Claude）的分钟数，两次往来间隔不超过 5 分钟算连续；几个会话同时开着不重复算 |
| 5 小时窗口 | 与社区 ccusage 同法：从一次对话所在的整点起算 5 小时。只能算用了多少，官方剩余额度拿不到 |
| 改动行数 | 编辑 / 新建文件的增删行数，含 subagent 的改动 |
| 活跃时段 | 只看你发的话 |
| 会话 | 有过对话的 `sessionId` 个数，不含 subagent |

## 多台电脑

每台电脑装好插件后，默认各自有一个独立的空间。要让几台电脑的用量合并到同一组组件里：

1. 在已经接入 Numable 的那台电脑上，对 Claude Code 说「生成加入其他电脑的串」（即 `/numable-usage`，背后是 `--link`）；
2. 在另一台电脑上对 Claude Code 说「加入用量空间」并贴上那一串（`--join`）。

加入后 Numable 里不用再绑第二个令牌，两台电脑的数字按天相加。那一串能往你的空间写数据，只在自己的电脑之间传。

## 数字偏大？可能是同一台电脑被算成了两台

每台电脑按「主机名 + 用户名」的哈希区分，App 会把各设备的数字按天相加。
macOS 没有设置固定主机名时，主机名会随网络变，同一台电脑就会被拆成两台、同一段日子被算两遍
（0.2.1 起设备标识首次算出后就固定，不会再拆；之前拆出来的旧记录要手动清一次）。

在 Claude Code 里说「看看用量有哪些设备」（即 `/numable-usage`），它会列出所有设备，
并标出与本机逐日会话数一致、多半是本机旧名的那一个；确认后让它删掉即可。
删除只影响服务端那一份，本机数据不受影响；本机自己删不掉（下次会话又会推上去）。

## 数据在哪

- **本机**：`~/.claude/numable-usage/history.json` —— 这是真相，服务端只是投递管道。
  服务端丢数据、换服务商、甚至停服，下次推送都会自动恢复。
- **服务端**：`usage.numable.app`，匿名空间（**没有账号**），90 天无推送自动回收。

## 仓库结构

| 目录 | 是什么 |
|---|---|
| [`plugin/`](plugin) | Claude Code 插件：hook + 采集脚本 + `/numable-usage` 命令 |
| [`service/`](service) | 投递服务：Cloudflare Worker + D1，封闭 schema |
| [`test/`](test) | 采集脚本的夹具测试：`node --test test/` |

想自建服务端？改 `service/wrangler.toml` 里的 `database_id` 为你自己的 D1，
`wrangler deploy` 后给插件设 `NUMABLE_USAGE_ENDPOINT` 指向它即可。

## License

MIT
