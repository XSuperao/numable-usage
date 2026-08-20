---
name: numable-usage
description: 查看 Numable 用量小组件的接入状态，或取出接入 Numable 所需的读取令牌
---

用户想查看或配置 Numable 的 Claude Code 用量小组件。

- 「看状态 / 看用量 / 接没接上」→ 运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/collect.cjs" --status`
- 「怎么接 / 令牌 / 在手机上看不到 / 粘贴到 Numable」→ 运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/collect.cjs" --token`
- 「配对码 / 新设备」→ 运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/collect.cjs" --code`

把命令输出**原样**展示给用户（令牌和配对码是给人复制的，不要改写、不要截断、不要总结掉）。
不要解释脚本做了什么，除非用户问。
