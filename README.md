# numable-usage

把你的 **Claude Code 用量**做成手机与桌面小组件 —— 会话数、消息量、token 消耗、活跃热力图、按模型分布。

搭配 [Numable](https://numable.app)（iOS · Android · HarmonyOS · Windows）使用。

<!-- 截图位（发布后补） -->

## 安装

```
/plugin marketplace add XSuperao/numable-usage
/plugin install numable-usage@numable
```

跑完一次会话后，在 Claude Code 里运行 `/numable-usage` 取出**读取令牌**，
粘贴到 Numable 的「我的 → 凭证」里，然后在商店安装「Claude Code 用量」信息源即可。

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

- **不上传 `cwd`、`gitBranch`、项目名、文件路径**
- **不上传任何对话内容、代码、工具调用结果**
- **不上传 `sessionId`**（只在本机用于去重计数）
- **不上传主机名**（`device` 是主机名的 SHA-256 前 12 位）
- **不上传花费金额**
- 默认**不上报非 Claude 模型的名字**（并入 `other`，只保留 token 量）

这不是承诺，是结构：[`collect.cjs`](plugin/scripts/collect.cjs) 的 `buildPayload()` 是**显式白名单构造**，
[`worker.js`](service/src/worker.js) 的 `sanitizeClaudeCode()` 再做一次白名单过滤 ——
没列出来的字段两道都过不去。服务端结构上就存不下别的东西。
[测试](service/test.mjs)里有对应的可执行断言。

## 数据在哪

- **本机**：`~/.claude/numable-usage/history.json` —— 这是真相，服务端只是投递管道。
  服务端丢数据、换服务商、甚至停服，下次推送都会自动恢复。
- **服务端**：`usage.numable.app`，匿名空间（**没有账号**），90 天无推送自动回收。

## 仓库结构

| 目录 | 是什么 |
|---|---|
| [`plugin/`](plugin) | Claude Code 插件：hook + 采集脚本 + `/numable-usage` 命令 |
| [`service/`](service) | 投递服务：Cloudflare Worker + D1，封闭 schema |

想自建服务端？改 `service/wrangler.toml` 里的 `database_id` 为你自己的 D1，
`wrangler deploy` 后给插件设 `NUMABLE_USAGE_ENDPOINT` 指向它即可。

## License

MIT
