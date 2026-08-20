# numable-usage

把你的 **Claude Code 用量**做成手机与桌面小组件 —— 会话数、消息量、token 消耗、活跃热力图、按模型分布。

配套 [Numable](https://numable.app)（iOS / Android / HarmonyOS / Windows）。

## 装

```
/plugin install numable-usage
```

跑完一次会话后，终端会打印一个 **6 位配对码**。在 Numable 里打开「Claude Code 用量」信息源，输入这个码即可。

看状态或重新生成配对码：`/numable-usage`

## 它上传什么

**只有聚合数字。** 上传体里唯一的字符串是模型名与日期：

```json
{ "days":  [ { "date": "2026-08-20", "msgs": 2577, "sessions": 7,
               "out": 1342242, "in": 3088, "cacheCreate": 4157381 } ],
  "byModel": { "claude-opus-5": { "in": 564166, "out": 30313045, "msgs": 49366 } },
  "hours":  { "21": 3885 },
  "totals": { "sessions": 308, "msgs": 126623, "out": 73202757 } }
```

## 它不上传什么

- **不上传 `cwd`、`gitBranch`、项目名、文件路径**
- **不上传任何对话内容、代码、工具调用结果**
- **不上传 `sessionId`**（只在本机用于去重计数）
- **不上传主机名**（`device` 是主机名的 SHA-256 前 12 位）
- **不上传花费金额**
- 默认**不上报非 Claude 模型的名字**（并入 `other`，只保留 token 量）；
  想上报完整模型名：`NUMABLE_USAGE_MODELS=all`

这不是承诺而是结构：`scripts/collect.cjs` 的 `buildPayload()` 是**显式白名单构造**，
服务端 `sanitizeClaudeCode()` 再做一次白名单过滤 —— 没列出来的字段两道都过不去。

## 数据在哪

- **本机**：`~/.claude/numable-usage/history.json` —— 这是真相，服务端只是投递管道。
  服务端丢数据、换服务商、甚至停服，下次推送都会自动恢复。
- **服务端**：`usage.numable.app`，匿名空间（**没有账号**），90 天无推送自动回收。

## 环境变量

| 变量 | 作用 |
|---|---|
| `NUMABLE_USAGE_MODELS=all` | 上报完整模型名（默认非 Claude 模型并入 `other`） |
| `NUMABLE_USAGE_ENDPOINT` | 换服务端（自建时用） |
| `NUMABLE_USAGE_STATE_DIR` | 换本机状态目录 |
| `NUMABLE_USAGE_DEBUG=1` | 打印诊断到 stderr |

## 失败姿态

采集挂在 `SessionEnd` / `SessionStart` 上。**任何失败都静默吞掉**（退出码恒为 0，stdout 恒为空）——
断网、文件缺失、历史损坏都不会打断你的 Claude Code 会话。

## 性能

首次全量扫描约 10 秒（实测 1.4GB / 521 个会话文件），之后按文件 offset 增量，**通常 0.4 秒**。

## License

MIT
