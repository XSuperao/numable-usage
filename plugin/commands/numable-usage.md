---
name: numable-usage
description: 查看 Numable 用量小组件的接入状态，或生成新设备的配对码
---

用户想查看或配置 Numable 的 Claude Code 用量小组件。

- 若用户没有特别说明，或想「看状态 / 看用量 / 接没接上」：
  运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/collect.cjs" --status`
- 若用户提到「配对码 / 新设备 / 手机上看不到 / 重新生成」：
  运行 `node "${CLAUDE_PLUGIN_ROOT}/scripts/collect.cjs" --code`

把命令输出**原样**展示给用户（配对码是给人抄的，不要改写、不要总结掉）。
不要解释脚本做了什么，除非用户问。
