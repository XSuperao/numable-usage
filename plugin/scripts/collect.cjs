#!/usr/bin/env node
/**
 * numable-usage · 采集器
 *
 * 从 ~/.claude/projects/**\/*.jsonl 增量提取**纯数字**用量，累积到本机 history.json，
 * 再把全量快照推送到 usage.numable.app。
 *
 * 隐私硬承诺（可审计 —— 见 buildPayload 的显式白名单构造）：
 *   读取的字段只有 type / timestamp / sessionId / isSidechain / isMeta / origin.kind /
 *   message.id / requestId / message.model / message.usage.* / cwd，外加三处只取结构不取内容：
 *   - user 行的 message.content：数组各项的 type（有没有 tool_result）、正文开头是不是系统注入的固定标签
 *     —— 判断「这是不是你本人发的」（见 isHumanPrompt）；
 *   - assistant 行 tool_use 块的 name：映射进固定词表（MCP 一律并成 MCP），数调用次数；
 *   - toolUseResult 的补丁：只数行首 + / -（新建文件数行数），算代码改动行数。
 *   都是判断完 / 数完即丢，正文不落盘、不上报。
 *   cwd 只在本机用来区分项目：上报的是「本机随机盐 + 项目根目录」的哈希，服务端反推不出路径；
 *   用户显式 --projects on 后才附上项目文件夹名（只取最后一段）。gitBranch 不读。
 *   上报体里的字符串只有：模型名、日期、固定词表里的工具名、（打开开关时的）项目文件夹名。主机名只以 hash 形式出现。
 *
 * 计数口径（2026-09-24 修正，history v2）：
 *   - token：按 API 响应计。Claude Code 把一次回复的每个内容块各写一行，且每行带着同一份
 *     usage —— 必须按 message.id + requestId 去重，否则 token 虚高 2~3 倍。
 *   - 消息：真人发言 + Claude 回复（同样按响应去重），不含工具返回结果与系统注入。
 *   - 活跃时段：只看真人发言。工具返回结果的 type 也是 user，占 user 行九成。
 * 数据扩充（同日，history v3 / 快照 v2）：缓存读取与 1 小时写入、思考 token、子代理输出、联网次数、
 *   工具调用次数、改动行数、活跃分钟、会话活跃时长、5 小时窗口、按项目 —— 全是数字；费用由服务端按价目折算。
 *
 * 失败姿态：任何异常都必须静默吞掉 —— 这是挂在 SessionEnd 上的 hook，
 * 打断用户的 Claude Code 会话是最不可接受的失败。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const PROJECTS = path.join(CLAUDE_DIR, 'projects');
const STATE_DIR = process.env.NUMABLE_USAGE_STATE_DIR || path.join(CLAUDE_DIR, 'numable-usage');
const CONFIG = path.join(STATE_DIR, 'config.json');
const HISTORY = path.join(STATE_DIR, 'history.json');

const ENDPOINT = process.env.NUMABLE_USAGE_ENDPOINT || 'https://usage.numable.app';
const KEEP_DAYS = 90;
const POST_TIMEOUT_MS = 8000;
// 会话进行中（Stop 钩子）最多每 10 分钟推一次：「今日」组件在长会话里也能跟着动
const TICK_MS = 10 * 60 * 1000;
const DEBUG = !!process.env.NUMABLE_USAGE_DEBUG;
const ALL_MODELS = process.env.NUMABLE_USAGE_MODELS === 'all';

const log = (...a) => { if (DEBUG) console.error('[numable-usage]', ...a); };

// ---------- 小工具 ----------
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 临时文件名带 pid：多个会话同时触发 hook 时，共用一个 .tmp 会交错写出坏 JSON，
  // 坏了 loadHistory 只能退回空历史 —— 已被 Claude Code 清理掉的会话记录就永久丢了。
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, p);                     // 原子替换，防写一半被打断
};
const localDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 模型名归一：默认只保留 claude-*，其余并成 other（不暴露「我接了别家模型」）。 */
const normModel = (m) => {
  if (typeof m !== 'string' || !m) return null;
  if (ALL_MODELS) return m;
  return m.startsWith('claude-') ? m : 'other';
};

// ---------- 进程锁 ----------
// SessionStart / SessionEnd 在多个会话里会同时触发。读-改-写 history 必须串行，
// 否则后写的覆盖先写的（白扫一遍）、首次接入还会各建一个空间。
const LOCK = path.join(STATE_DIR, 'lock');
const LOCK_WAIT_MS = 20000;               // > 一次推送超时，排在后面的会话等得到
const LOCK_STALE_MS = 10 * 60 * 1000;

const pidAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

function tryLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    // 持锁进程已经不在了（被杀 / 崩溃）或锁太旧 → 清掉再试一次
    let stale;
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      const pid = parseInt(raw, 10);
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      // ⚠️ 对方是先 open('wx') 建出空文件、再写进程号 —— 读到空内容 = 对方正在写，不是死了。
      // 按「pid 不在」判过期会在这个缝里抢走一把活锁（两个进程同时持锁，首次接入建出两个空间）。
      stale = Number.isInteger(pid) && pid > 0 ? !pidAlive(pid) || age > LOCK_STALE_MS : age > 10000;
    } catch { stale = true; }                // 读不到 = 对方刚释放
    if (!stale) return false;
    try { fs.unlinkSync(lockPath); } catch { /* 别人先清了 */ }
  }
  return false;
}

async function acquireLock(lockPath = LOCK, waitMs = LOCK_WAIT_MS) {
  const until = Date.now() + waitMs;
  for (;;) {
    if (tryLock(lockPath)) return () => { try { fs.unlinkSync(lockPath); } catch { /* 已被清 */ } };
    if (Date.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ---------- 空历史 ----------
// v2 = 2026-09-24 口径修正（token 按响应去重 / 消息不含工具结果）。
// v3 = 同日数据扩充（缓存读取 / 思考 / 工具 / 改动行数 / 活跃分钟 / 项目 / 5 小时窗口）——
//      新字段只能从会话记录重扫得到，旧版本历史一律丢弃重算。
const HISTORY_V = 3;
const emptyDay = () => ({
  msgs: 0, sess: [], out: 0, in: 0, cr: 0, c1: 0, rd: 0, th: 0, so: 0, ws: 0, wf: 0, la: 0, lr: 0,
  hours: {}, byModel: {}, tools: {}, proj: {}, act: '',
});

function loadHistory(p = HISTORY) {
  const h = readJson(p, null);
  const fresh = () => ({
    v: HISTORY_V, files: {}, days: {},
    sessions: {},                                    // sessionId → [首条时刻, 末条时刻, 活跃毫秒]
    events: [],                                      // 近 12 小时的回复 [时刻, 模型, in, out, c5, c1, rd]，算 5 小时窗口
    salt: crypto.randomBytes(8).toString('hex'),     // 项目键的盐：只在本机，服务端反推不出路径
    projNames: {},                                   // 项目键 → 文件夹名：只在本机，开了开关才上传
  });
  if (!h || h.v !== HISTORY_V || !h.days || typeof h.days !== 'object') return fresh();
  const f = fresh();
  for (const k of ['files', 'sessions', 'projNames']) if (!h[k] || typeof h[k] !== 'object') h[k] = f[k];
  if (!Array.isArray(h.events)) h.events = [];
  if (typeof h.salt !== 'string' || !h.salt) h.salt = f.salt;
  return h;
}

// ---------- 活跃时长 ----------
// 两次往来间隔不超过 5 分钟算连续（在读输出、在想下一句）；更长就是离开了。
const GAP_MIN = 5;
const GAP_MS = GAP_MIN * 60000;
// 每天一张 1440 位的位图：这一分钟里有没有任何往来（你或 Claude）。
// 跨会话取并集 —— 两个会话同时开着，那段时间不会算两遍。
const ACT_BYTES = 180;
const actCache = new Map();                          // day 对象 → Buffer；扫描结束 flushAct 写回 base64
function markActive(day, ts) {
  let b = actCache.get(day);
  if (!b) {
    b = day.act ? Buffer.from(day.act, 'base64') : Buffer.alloc(ACT_BYTES);
    if (b.length !== ACT_BYTES) b = Buffer.alloc(ACT_BYTES);
    actCache.set(day, b);
  }
  const d = new Date(ts);
  const m = d.getHours() * 60 + d.getMinutes();
  b[m >> 3] |= 1 << (m & 7);
}
function flushAct() {
  for (const [day, b] of actCache) day.act = b.toString('base64');
  actCache.clear();
}
/** 活跃分钟 = 有往来的分钟 + 两次往来之间不超过 5 分钟的空档 */
function activeMinutes(act) {
  if (!act) return 0;
  const b = Buffer.from(act, 'base64');
  let total = 0, last = -1;
  for (let m = 0; m < 1440; m++) {
    if (!(b[m >> 3] & (1 << (m & 7)))) continue;
    total += last >= 0 && m - last <= GAP_MIN ? m - last : 1;
    last = m;
  }
  return total;
}
/** 会话的活跃时长：同上的「5 分钟内算连续」，按会话累加（桌面端的会话能挂好几天，首末时刻相减没有意义） */
function touchSession(sessions, sid, ts) {
  const s = sessions[sid];
  if (!s) { sessions[sid] = [ts, ts, 60000]; return; }
  if (ts > s[1]) { const g = ts - s[1]; s[2] += g <= GAP_MS ? g : 60000; s[1] = ts; }
  if (ts < s[0]) s[0] = ts;
}

// ---------- 增量扫描 ----------
function listJsonl(root) {
  const out = [];
  const walk = (d) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root);
  return out;
}

/**
 * 系统以 user 身份写进会话的行，正文开头是这些固定标签。
 * 只在没有 origin.kind 时才靠它判断（纯 CLI 的日志不带 origin）。
 */
const MACHINE_PREFIXES = [
  '<local-command-stdout>', '<local-command-stderr>', '<local-command-caveat>',
  '<bash-stdout>', '<bash-stderr>', '<task-notification>', '<system-reminder>',
  '<scheduled-task', '[Request interrupted',
];

/** 这一行 user 是不是你本人发的（含斜杠命令、贴图）。工具返回结果、系统注入都不算。 */
function isHumanPrompt(o) {
  if (o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return false;
  const c = o.message && o.message.content;
  let head;
  if (typeof c === 'string') head = c;
  else if (Array.isArray(c)) {
    if (c.some((x) => x && x.type === 'tool_result')) return false;
    const t = c.find((x) => x && x.type === 'text');
    head = t && typeof t.text === 'string' ? t.text : (c.length ? null : '');
  } else return false;
  // 新版（SDK / 桌面端）明确标了来源，以它为准
  const kind = o.origin && typeof o.origin === 'object' ? o.origin.kind : undefined;
  if (typeof kind === 'string') return kind === 'human';
  if (head === null) return true;            // 只有图片没有文字 = 你贴的图
  head = head.trimStart().slice(0, 32);
  if (!head) return false;
  return !MACHINE_PREFIXES.some((p) => head.startsWith(p));
}

/** 同一次 API 响应的去重键。拿不到 id 就不去重（宁可少去重，不可错合并）。 */
const responseKey = (o) => {
  const id = o.message && typeof o.message.id === 'string' ? o.message.id : '';
  if (!id) return null;
  return crypto.createHash('sha1').update(id + '|' + (typeof o.requestId === 'string' ? o.requestId : ''))
    .digest('hex').slice(0, 12);
};

/**
 * 同一响应的各行在同一个文件里、彼此相隔几行之内（实测 993 个文件跨文件重复 0 条）。
 * 所以只需每个文件记住最近 RECENT_KEYS 个响应键，不必维护全局集合。
 */
const RECENT_KEYS = 32;
const remember = (recent, k) => { recent.push(k); if (recent.length > RECENT_KEYS) recent.shift(); };

// 工具名：固定词表以外的一律 Other；MCP 工具统一并成 MCP —— 不暴露你装了哪些 MCP 服务。
// 同一件事的几个内置工具归成一类（待办清单一类、派代理 / 代理间通信一类），排行里才读得出「在干什么」。
const TOOL_GROUP = {
  Task: 'Agent', SendMessage: 'Agent', ListAgents: 'Agent', TaskStop: 'Agent', TaskOutput: 'Agent',
  TodoWrite: 'Todo', TaskCreate: 'Todo', TaskUpdate: 'Todo',
  MultiEdit: 'Edit', LS: 'Glob', BashOutput: 'Bash', KillShell: 'Bash',
};
const TOOL_NAMES = new Set([
  'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Agent', 'Todo',
  'NotebookEdit', 'Skill', 'ToolSearch', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode', 'SlashCommand',
]);
const normTool = (n) => {
  if (typeof n !== 'string' || !n) return null;
  if (n.startsWith('mcp__')) return 'MCP';
  const g = TOOL_GROUP[n] || n;
  return TOOL_NAMES.has(g) ? g : 'Other';
};

/** 代码改动行数：编辑结果的补丁只数行首 + / -，新建文件数内容行数。正文本身不留、不传。 */
function countLines(day, r) {
  if (!r || typeof r !== 'object') return;
  if (Array.isArray(r.structuredPatch) && r.structuredPatch.length) {
    for (const h of r.structuredPatch) {
      for (const l of (h && Array.isArray(h.lines) ? h.lines : [])) {
        if (typeof l !== 'string') continue;
        if (l[0] === '+') day.la++;
        else if (l[0] === '-') day.lr++;
      }
    }
  } else if (r.type === 'create' && typeof r.content === 'string' && r.content) {
    day.la += r.content.split('\n').length - (r.content.endsWith('\n') ? 1 : 0);
  }
}

/**
 * 项目键 = 本机随机盐 + 项目根目录的哈希。项目根 = 往上找到的第一个 git 仓库
 * （worktree 先归回它所属的项目）；找不到就用工作目录本身。
 */
const projMemo = new Map();
function projectOf(ext, cwd) {
  if (!ext || typeof cwd !== 'string' || !cwd) return null;
  let id = projMemo.get(cwd);
  if (id) return id;
  const stripped = cwd.replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+.*$/, '');
  let root = stripped;
  for (let d = stripped, i = 0; i < 12; i++) {
    try { if (fs.existsSync(path.join(d, '.git'))) { root = d; break; } } catch { break; }
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  id = crypto.createHash('sha256').update(ext.salt + '|' + root).digest('hex').slice(0, 10);
  if (!ext.projNames[id]) ext.projNames[id] = path.basename(root) || root;
  projMemo.set(cwd, id);
  return id;
}

const EVENT_KEEP_MS = 12 * 3600e3;                   // 5 小时窗口只看近 12 小时的回复

/**
 * 把一行的数字并进 history。
 * st  = 本文件的去重状态 { recent: 响应键, rt: 工具调用 id }（会被修改）
 * ext = history 本身（会话表 / 窗口事件 / 项目盐）；测试里可以不给
 */
function absorb(days, o, st, ext) {
  const t = o.type;
  if (t !== 'user' && t !== 'assistant') return false;
  const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
  if (!Number.isFinite(ts)) return false;

  const date = localDay(new Date(ts));
  const day = days[date] || (days[date] = emptyDay());
  const side = !!o.isSidechain;

  // 会话 / 活跃时长：排除 sidechain（subagent 内部往返不是「你的对话」）
  if (!side) {
    if (typeof o.sessionId === 'string') {
      if (!day.sess.includes(o.sessionId)) day.sess.push(o.sessionId);
      if (ext) touchSession(ext.sessions, o.sessionId, ts);
    }
    markActive(day, ts);
  }

  if (t === 'user') {
    countLines(day, o.toolUseResult);                // 含子代理：它改的也是你的代码
    // Messages / Peak hour：只数你本人发的，排除 sidechain
    if (!side && isHumanPrompt(o)) {
      day.msgs++;
      const h = String(new Date(ts).getHours());
      day.hours[h] = (day.hours[h] || 0) + 1;
    }
    return true;
  }

  const m = o.message;
  // Claude Code 在 API 报错 / 中断时写一条 model=<synthetic> 的占位回复，usage 全 0 ——
  // 不是模型真的回了话，不计消息、不进模型分布
  if (m && m.model === '<synthetic>') return true;

  // 工具调用：每行只带一个内容块，同一响应的各行内容各不相同 ——
  // 必须在「同一响应只计一次」之前逐行数；按调用 id 去重，防整行重复写入
  if (m && Array.isArray(m.content)) {
    for (const c of m.content) {
      if (!c || c.type !== 'tool_use') continue;
      const name = normTool(c.name);
      if (!name) continue;
      if (typeof c.id === 'string') {
        if (st.rt.includes(c.id)) continue;
        remember(st.rt, c.id);
      }
      day.tools[name] = (day.tools[name] || 0) + 1;
    }
  }

  // assistant：同一响应只计一次
  const k = responseKey(o);
  if (k) {
    if (st.recent.includes(k)) return true;
    remember(st.recent, k);
  }
  if (!side) day.msgs++;

  // Tokens：含 sidechain（subagent 也在真实消耗）
  if (m && typeof m === 'object' && m.usage && typeof m.usage === 'object') {
    const u = m.usage;
    const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
    const oi = n(u.input_tokens), oo = n(u.output_tokens);
    const ocr = n(u.cache_creation_input_tokens), ord = n(u.cache_read_input_tokens);
    const oc1 = Math.min(ocr, n(u.cache_creation && u.cache_creation.ephemeral_1h_input_tokens));
    const oc5 = ocr - oc1;
    const stu = u.server_tool_use && typeof u.server_tool_use === 'object' ? u.server_tool_use : {};
    day.in += oi; day.out += oo; day.cr += ocr; day.c1 += oc1; day.rd += ord;
    day.th += n(u.output_tokens_details && u.output_tokens_details.thinking_tokens);
    day.ws += n(stu.web_search_requests); day.wf += n(stu.web_fetch_requests);
    if (side) day.so += oo;
    // 快速模式单独记：同一个模型，单价翻倍
    const base = normModel(m.model);
    const mm = base && u.speed === 'fast' ? base + '@fast' : base;
    if (mm) {
      const b = day.byModel[mm] || (day.byModel[mm] = { in: 0, out: 0, c5: 0, c1: 0, rd: 0, msgs: 0 });
      b.in += oi; b.out += oo; b.c5 = (b.c5 || 0) + oc5; b.c1 = (b.c1 || 0) + oc1; b.rd = (b.rd || 0) + ord; b.msgs++;
      if (ext && ts > Date.now() - EVENT_KEEP_MS) ext.events.push([ts, mm, oi, oo, oc5, oc1, ord]);
    }
    const pid = projectOf(ext, o.cwd);
    if (pid) {
      const p = day.proj[pid] || (day.proj[pid] = { out: 0, tok: 0, n: 0 });
      p.out += oo; p.tok += oi + oo + ocr + ord; p.n++;
      // 0.6.0 起:项目按模型的输出(项目详情页的模型分布)。快速模式并回同一模型 —— 看的是「谁在干活」
      if (base) { p.m = p.m || {}; p.m[base] = (p.m[base] || 0) + oo; }
    }
  }
  return true;
}

/** 文件 [from, size) 区间里最后一个换行符之后的位置；区间里没有换行返回 from。 */
function lastLineEnd(f, from, size) {
  const CHUNK = 65536;
  let fd;
  try {
    fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(CHUNK);
    for (let end = size; end > from;) {
      const start = Math.max(from, end - CHUNK);
      const len = end - start;
      fs.readSync(fd, buf, 0, len, start);
      const idx = buf.subarray(0, len).lastIndexOf(0x0a);
      if (idx >= 0) return start + idx + 1;
      end = start;
    }
    return from;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// 超过这个时长没动过的文件不会再续写同一个响应，不必留去重键（history 保持小）
const RECENT_TTL_MS = 2 * 864e5;

async function scan(history, root = PROJECTS) {
  if (!fs.existsSync(root)) { log('no projects dir'); return 0; }
  const files = listJsonl(root);
  let touched = 0;

  for (const f of files) {
    let fst; try { fst = fs.statSync(f); } catch { continue; }
    const prev = history.files[f];
    let from = 0;
    const st = { recent: [], rt: [] };
    if (prev && typeof prev.off === 'number' && typeof prev.size === 'number') {
      if (fst.size === prev.size) continue;                // 没变，跳过
      if (fst.size > prev.size) {                          // append，从上次最后一个完整行之后续读
        from = prev.off;
        if (Array.isArray(prev.recent)) st.recent = prev.recent.slice(-RECENT_KEYS);
        if (Array.isArray(prev.rt)) st.rt = prev.rt.slice(-RECENT_KEYS);
      } else log('rewound, rescan:', path.basename(f));    // 被重写，从头读
    }

    // 只读到「最后一个完整行」为止：之后的半行等它写完下一轮再读。
    // 边界必须在读之前定死 —— 读的过程中文件还在被别的会话追加，
    // 不设 end 就会读进 stat 之后的行，而 offset 又停在它们之前 → 下一轮重复计入。
    let off;
    try { off = lastLineEnd(f, from, fst.size); } catch { continue; }

    if (off > from) {
      await new Promise((resolve) => {
        const rs = fs.createReadStream(f, { start: from, end: off - 1, encoding: 'utf8' });
        const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
        rl.on('line', (line) => {
          if (!line) return;
          try { absorb(history.days, JSON.parse(line), st, history); } catch { /* 坏行，丢弃 */ }
        });
        rl.on('close', resolve);
        rs.on('error', () => resolve());
      });
    }

    const entry = { off, size: fst.size };
    if (Date.now() - fst.mtimeMs < RECENT_TTL_MS) {
      if (st.recent.length) entry.recent = st.recent;
      if (st.rt.length) entry.rt = st.rt;
    }
    history.files[f] = entry;
    touched++;
  }
  flushAct();
  return touched;
}

// ---------- 5 小时窗口 ----------
const WIN_KEEP_MS = 14 * 864e5;                      // 窗口历史留 14 天(窗口详情页)
/**
 * 由近 12 小时的回复事件算窗口,并按开始时刻合并进 history.win(本机历史)。
 * ⚠️ 事件只留 12 小时,过期的窗口没法重算 —— 所以每次采集都把算出来的窗口存下来。
 * ⚠️ 已经存过的窗口是「锚」:事件落在某个已存窗口里,就归那个窗口,不从这条事件的整点重新开窗
 *    (否则最早那条留存事件在旧窗口中间时,后面整条窗口链都会错位)。
 * ⚠️ 只有开始时刻还在事件留存期内的窗口才用重算值覆盖 —— 更早的那些事件已经裁掉了一部分,重算会少算。
 * 返回按开始时刻排好的窗口列表。
 */
function foldWindows(history, now = Date.now()) {
  const win = history.win && typeof history.win === 'object' ? history.win : (history.win = {});
  const known = Object.values(win).filter((w) => w && w.e > w.s).sort((a, b) => a.s - b.s);
  const ev = (history.events || []).filter(Array.isArray).sort((a, b) => a[0] - b[0]);
  const fresh = {};
  let cur = null;
  for (const [ts, name, i, o, c5, c1, rd] of ev) {
    if (!cur || ts >= cur.e) {
      const hit = known.find((w) => ts >= w.s && ts < w.e);
      const s0 = hit ? hit.s : Math.floor(ts / 3600e3) * 3600e3;
      cur = fresh[s0] || (fresh[s0] = { s: s0, e: s0 + 5 * 3600e3, l: ts, n: 0, m: {} });
    }
    const b = cur.m[name] || (cur.m[name] = { in: 0, out: 0, c5: 0, c1: 0, rd: 0, n: 0 });
    b.in += i; b.out += o; b.c5 += c5; b.c1 += c1; b.rd += rd; b.n++;
    cur.n++; cur.l = Math.max(cur.l, ts);
  }
  const retainFrom = now - EVENT_KEEP_MS;
  for (const w of Object.values(fresh)) if (w.s >= retainFrom || !win[w.s]) win[w.s] = w;
  for (const k of Object.keys(win)) if (!(win[k] && win[k].s >= now - WIN_KEEP_MS)) delete win[k];
  return Object.values(win).sort((a, b) => a.s - b.s);
}

// ---------- 滚动裁剪 ----------
function prune(history) {
  const cutoff = localDay(new Date(Date.now() - KEEP_DAYS * 864e5));
  for (const d of Object.keys(history.days)) if (d < cutoff) delete history.days[d];
  const old = Date.now() - KEEP_DAYS * 864e5;
  for (const [sid, v] of Object.entries(history.sessions || {})) if (!Array.isArray(v) || v[1] < old) delete history.sessions[sid];
  const recentCut = Date.now() - EVENT_KEEP_MS;
  history.events = (history.events || []).filter((e) => Array.isArray(e) && e[0] >= recentCut);
  // 文件表：projects 里已消失的文件清掉，防无限增长
  for (const f of Object.keys(history.files)) if (!fs.existsSync(f)) delete history.files[f];
}

// ---------- 设备 ----------
/** 本机的设备标识：config 里钉住的那个；老 config 还没钉时按原公式算（与推送时写回的值相同）。 */
const deviceId = (cfg) => (cfg && typeof cfg.device === 'string' && cfg.device)
  || crypto.createHash('sha256')
    .update(os.hostname() + '|' + os.userInfo().username)   // 主机名常含真名 —— 只上报 hash
    .digest('hex').slice(0, 12);

/**
 * 另一个设备是不是「本机改名前留下的分身」：它与本机历史重叠 ≥ 3 天，
 * 且重叠日里至少八成的会话数逐日相同（留余量给分身停推那天 —— 那天它只推了半天）。
 * 真正的另一台电脑跑的是另一批会话，不会连续多天恰好一样多。
 */
function ghostOf(localDays, remoteDays) {
  let overlap = 0, same = 0;
  for (const d of remoteDays || []) {
    const mine = localDays[d.date];
    if (!mine) continue;
    const n = Array.isArray(mine.sess) ? mine.sess.length : 0;
    if (!n && !(d.sessions | 0)) continue;           // 两边都没会话的日子不算证据
    overlap++;
    if (n === (d.sessions | 0)) same++;
  }
  return { overlap, same, likely: overlap >= 3 && same >= overlap * 0.8 };
}

// ---------- 显式白名单构造 payload ----------
/** 只有这里列出的字段会离开本机。新增字段必须显式加在这里。 */
function buildPayload(history, device, opts = {}) {
  const days = [];
  const byModel = {};
  const hours = {};
  let tMsgs = 0, tOut = 0, tIn = 0, tCr = 0;
  const allSess = new Set();          // 跨午夜的会话在两天里各出现一次，总数按 id 去重

  for (const date of Object.keys(history.days).sort()) {
    const d = history.days[date];
    const sessions = Array.isArray(d.sess) ? d.sess.length : 0;
    const m = {};
    for (const [name, v] of Object.entries(d.byModel || {})) {
      m[name] = { in: v.in | 0, out: v.out | 0, c5: v.c5 | 0, c1: v.c1 | 0, rd: v.rd | 0, n: v.msgs | 0 };
    }
    days.push({
      date,                                   // 采集机本地日期字符串，全链路原样透传，不做时区转换
      msgs: d.msgs | 0,
      sessions,
      out: d.out | 0,
      in: d.in | 0,
      cacheCreate: d.cr | 0,
      // v2 起（插件 0.5.0）
      rd: d.rd || 0,                          // 缓存读取（量级常是输出的数百倍，不进「总量」，只算费用与命中率）
      c1: d.c1 | 0,                           // 缓存写入里 1 小时那档（单价是 5 分钟档的 1.6 倍）
      th: d.th | 0,                           // 思考 token（含在 out 里）
      so: d.so | 0,                           // 子代理产生的输出（含在 out 里）
      ws: d.ws | 0, wf: d.wf | 0,             // 联网搜索 / 抓取次数（搜索按次计费）
      la: d.la | 0, lr: d.lr | 0,             // 代码增 / 删行数
      am: activeMinutes(d.act),               // 活跃分钟
      h: d.hours || {},                       // 真人发言的小时分布（按天给，服务端据此出星期 × 小时）
      m,                                      // 按模型的 token 明细（服务端据此按价目折算费用）
      t: d.tools || {},                       // 工具调用次数
    });
    if (Array.isArray(d.sess)) for (const id of d.sess) allSess.add(id);
    tMsgs += d.msgs | 0; tOut += d.out | 0; tIn += d.in | 0; tCr += d.cr | 0;
    for (const [m, v] of Object.entries(d.byModel || {})) {
      const b = byModel[m] || (byModel[m] = { in: 0, out: 0, msgs: 0 });
      b.in += v.in | 0; b.out += v.out | 0; b.msgs += v.msgs | 0;
    }
    for (const [h, c] of Object.entries(d.hours || {})) hours[h] = (hours[h] || 0) + (c | 0);
  }

  // 连续活跃天数：只有本机 history 有完整日期集合，放这里算最自然。
  // ⚠️ 存的是「算出来的天数」而非锚点日期 —— 但每次推送都重算，不会像写死的滚动量那样过期。
  const dateSet = new Set(days.map((d) => d.date));
  const dayStr = (off) => {
    const t = new Date();
    t.setDate(t.getDate() - off);
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
  };
  let streak = 0;
  // 今天还没活动不算断（当天可能还没开始用）—— 从今天或昨天起往回数
  let base = dateSet.has(dayStr(0)) ? 0 : (dateSet.has(dayStr(1)) ? 1 : -1);
  if (base >= 0) { while (dateSet.has(dayStr(base + streak))) streak++; }
  let longest = 0, run = 0, prev = null;
  for (const d of days) {
    if (prev) {
      const gap = Math.round((Date.parse(d.date + 'T00:00:00') - Date.parse(prev + 'T00:00:00')) / 864e5);
      run = gap === 1 ? run + 1 : 1;
    } else run = 1;
    if (run > longest) longest = run;
    prev = d.date;
  }

  // 5 小时窗口：与社区 ccusage 同法 —— 窗口从一次往来所在的整点起算、持续 5 小时，
  // 窗口结束后的第一次往来开下一个窗口。只能算「用了多少」，官方的剩余额度拿不到。
  // 当前窗口与窗口历史(0.6.0 起,近 14 天)出自同一份 foldWindows,不会两边对不上
  const allWin = foldWindows(history);
  const last = allWin[allWin.length - 1];
  const window = last && last.e > Date.now() ? last : null;
  const windows = allWin.slice(-60).reverse();

  // 会话的活跃时长（近 30 天有动静的会话）
  const sessStats = { n: 0, avgMin: 0, maxMin: 0 };
  {
    const cut = Date.now() - 30 * 864e5;
    let sum = 0;
    for (const v of Object.values(history.sessions || {})) {
      if (!Array.isArray(v) || v[1] < cut) continue;
      const min = Math.round(v[2] / 60000);
      sessStats.n++; sum += min; sessStats.maxMin = Math.max(sessStats.maxMin, min);
    }
    sessStats.avgMin = sessStats.n ? Math.round(sum / sessStats.n) : 0;
  }

  // 按项目：只有匿名编号；本机打开开关（--projects on）才带文件夹名
  const projects = [];
  {
    const agg = {};
    const d7 = dayStr(6), d30 = dayStr(29), d60 = dayStr(59);
    for (const [date, d] of Object.entries(history.days)) {
      for (const [id, v] of Object.entries(d.proj || {})) {
        const a = agg[id] || (agg[id] = { id, out: 0, tok: 0, n: 0, d7out: 0, d7tok: 0, days: {}, p30: 0, m: {} });
        a.out += v.out | 0; a.tok += v.tok || 0; a.n += v.n | 0;
        if (date >= d7) { a.d7out += v.out | 0; a.d7tok += v.tok || 0; }
        // 0.6.0 起:近 30 天逐日输出、前 30 天合计、近 30 天按模型(项目详情页)
        if (date >= d30) {
          if (v.out) a.days[date] = (a.days[date] || 0) + (v.out | 0);
          for (const [mn, mo] of Object.entries(v.m || {})) a.m[mn] = (a.m[mn] || 0) + (mo | 0);
        } else if (date >= d60) a.p30 += v.out | 0;
      }
    }
    for (const a of Object.values(agg).sort((x, y) => y.tok - x.tok).slice(0, 12)) {
      if (opts.projectNames && history.projNames && history.projNames[a.id]) a.name = String(history.projNames[a.id]).slice(0, 40);
      projects.push(a);
    }
  }

  return {
    source: 'claude-code',
    device,
    snapshot: {
      v: 2,
      days,
      byModel,
      hours,
      window,
      windows,
      sessStats,
      projects,
      totals: { sessions: allSess.size, msgs: tMsgs, out: tOut, in: tIn, cacheCreate: tCr,
                activeDays: days.length, streak, longestStreak: longest },
    },
  };
}

// ---------- 网络 ----------
async function request(method, pathname, body, token) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  // 必须有超时：服务端挂住时 hook 会一直卡着，而且期间一直持锁
  const res = await fetch(ENDPOINT + pathname, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}
const post = (pathname, body, token) => request('POST', pathname, body || {}, token);
const get = (pathname, token) => request('GET', pathname, undefined, token);

// ---------- 子命令 ----------
const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M'
                 : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n | 0));

async function cmdStatus() {
  const cfg = readJson(CONFIG, null);
  if (!cfg || !cfg.spaceId) {
    console.log('尚未接入。在 Claude Code 里跑完一次会话，或执行:\n  node "$CLAUDE_PLUGIN_ROOT/scripts/collect.cjs"');
    return;
  }
  const h = loadHistory();
  const dates = Object.keys(h.days).sort();
  let msgs = 0, out = 0, sess = 0;
  for (const d of dates) {
    msgs += h.days[d].msgs | 0; out += h.days[d].out | 0;
    sess += Array.isArray(h.days[d].sess) ? h.days[d].sess.length : 0;
  }
  console.log(`已接入 · 空间 ${cfg.spaceId}`);
  console.log(`本机累积 ${dates.length} 天${dates.length ? `（${dates[0]} → ${dates[dates.length - 1]}）` : ''}`);
  console.log(`会话 ${sess} · 消息 ${fmt(msgs)} · 输出 token ${fmt(out)}`);
  console.log(`服务端 ${cfg.endpoint || ENDPOINT}`);
  console.log('\n把用量接到 Numable：--token 打印读取令牌（粘进 App 的凭证设置）。');
  console.log('还有别的电脑也在用 Claude Code？--link 生成加入串，让它们合并到同一个空间。');
  console.log('数字比实际偏大？--devices 看看有没有这台电脑改名前留下的旧记录。');
  console.log(`按项目：${cfg.projectNames === true ? '上传文件夹名' : '只传匿名编号'}（--projects on|off）`);
}

/**
 * 打印读取令牌本体。
 * ⚠️ 为什么需要它:短码(`--code`)要 App 端有「输入短码 → 调 /claim → 存令牌」的入口才用得上,
 * 而四端凭证面板目前是**通用 token 输入框**,没有对接短码。在 App 支持之前,
 * 接入路径就是把这一串粘进凭证面板。短码机制保留,是给 App 原生支持预留的。
 */
async function cmdToken() {
  const cfg = readJson(CONFIG, null);
  if (!cfg || !cfg.readToken) { console.log('尚未接入，先跑一次采集（或在 Claude Code 里开一个新会话）。'); return; }
  console.log('把下面这一整串粘贴到 Numable 的「我的 → 凭证 → Claude Code 用量」里：\n');
  console.log(cfg.readToken);
  console.log('\n它只能读你自己的用量数字，不能写、不能改、不能看别人的。');
}

// 配对码（服务端 /code + /claim）是给「App 里输入 6 位码」预留的，App 目前没有这个入口 ——
// 打印一个用户用不上的码只会让人卡住，所以 --code 与 --token 走同一条路。
const cmdCode = () => cmdToken();

async function cmdDevices() {
  const cfg = readJson(CONFIG, null);
  if (!cfg || !cfg.readToken) { console.log('尚未接入，先跑一次采集（或在 Claude Code 里开一个新会话）。'); return; }
  const me = deviceId(cfg);
  let r;
  try { r = await get('/s', cfg.readToken); } catch (e) { console.log('连不上服务端：', e && e.message); return; }
  if (!r.ok || !r.json) { console.log('读取失败：', r.status, r.text.slice(0, 200)); return; }
  const list = ((r.json.sources || {})['claude-code'] || []).slice()
    .sort((a, b) => (a.device === me ? -1 : b.device === me ? 1 : (b.updatedAt || 0) - (a.updatedAt || 0)));
  if (!list.length) { console.log('服务端还没有任何设备的数据。'); return; }

  const local = loadHistory().days;
  const ghosts = [];
  console.log(list.length === 1
    ? '你的空间里只有 1 台设备在推送用量：\n'
    : `你的空间里有 ${list.length} 台设备在推送用量（App 会把它们的数字加在一起）：\n`);
  for (const dev of list) {
    const days = (dev.days || []).map((d) => d.date).sort();
    const t = dev.totals || {};
    const when = dev.updatedAt ? new Date(dev.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '—';
    console.log(`  ${dev.device}${dev.device === me ? '（本机）' : ''}`);
    console.log(`    最近推送 ${when} · ${days.length ? `${days[0]} → ${days[days.length - 1]}，${days.length} 天` : '没有日数据'}` +
                ` · 消息 ${fmt(t.msgs | 0)} · 输出 token ${fmt(t.out | 0)}`);
    if (dev.device !== me) {
      const g = ghostOf(local, dev.days);
      if (g.likely) {
        ghosts.push(dev.device);
        console.log(`    ⚠ 与本机有 ${g.overlap} 天重叠，其中 ${g.same} 天的会话数完全相同——` +
                    '多半是这台电脑改名前留下的旧记录，这些天的用量被算了两遍。');
      }
    }
    console.log('');
  }
  if (ghosts.length) {
    console.log('删掉旧记录（只删服务端那一份，本机数据不受影响）：');
    for (const id of ghosts) console.log(`  --forget ${id}`);
  }
}

async function cmdForget(id) {
  const cfg = readJson(CONFIG, null);
  if (!cfg || !cfg.writeToken) { console.log('尚未接入，先跑一次采集。'); return; }
  if (typeof id !== 'string' || !/^[a-f0-9]{4,32}$/.test(id)) {
    console.log('用法：--forget <设备标识>（标识用 --devices 查看）'); return;
  }
  if (id === deviceId(cfg)) {
    console.log('这是本机。删掉之后，下一次会话开始或结束时又会重新推上去，不需要删。'); return;
  }
  let r;
  try { r = await post('/forget', { source: 'claude-code', device: id }, cfg.writeToken); }
  catch (e) { console.log('连不上服务端：', e && e.message); return; }
  if (!r.ok || !r.json) { console.log('删除失败：', r.status, r.text.slice(0, 200)); return; }
  console.log(r.json.removed
    ? `已删除设备 ${id}。Numable 下次刷新时就不再计入它。`
    : `服务端没有设备 ${id}（可能已经删过了）。`);
}

/** 「按项目」要不要带上项目文件夹名。默认关：只传匿名编号（本机加盐哈希）。 */
async function cmdProjects(v) {
  const cfg = readJson(CONFIG, null);
  if (!cfg || !cfg.spaceId) { console.log('尚未接入，先跑一次采集（或在 Claude Code 里开一个新会话）。'); return; }
  if (v !== 'on' && v !== 'off') {
    console.log(cfg.projectNames === true
      ? '现在：上传项目文件夹名（只取最后一段，不含完整路径）。关掉：--projects off'
      : '现在：只上传匿名编号（组件里显示成「项目 A / B / C」）。要显示文件夹名：--projects on');
    return;
  }
  const release = await acquireLock();
  if (!release) { console.log('采集正在进行，过几秒再试一次。'); return; }
  try {
    const cur = readJson(CONFIG, cfg);
    cur.projectNames = v === 'on';
    writeJson(CONFIG, cur);
    await collectAndPush({ force: true });           // 立刻推一次，让服务端那份跟着变（关掉时名字随即消失）
  } finally {
    release();
  }
  console.log(v === 'on'
    ? '已打开：会上传项目文件夹名（只取最后一段，不含完整路径）。随时可以 --projects off 关掉。'
    : '已关闭：只上传匿名编号，服务端那份里的文件夹名已被这次推送覆盖掉。');
}

/** 另一台电脑加入本空间用的一串：空间 id + 两枚令牌（+ 非默认服务端）。 */
function cmdLink() {
  const cfg = readJson(CONFIG, null);
  if (!cfg || !cfg.writeToken || !cfg.readToken) { console.log('尚未接入，先跑一次采集（或在 Claude Code 里开一个新会话）。'); return; }
  const o = { s: cfg.spaceId, w: cfg.writeToken, r: cfg.readToken };
  if ((cfg.endpoint || ENDPOINT) !== 'https://usage.numable.app') o.e = cfg.endpoint || ENDPOINT;
  const code = 'nu1.' + Buffer.from(JSON.stringify(o)).toString('base64url');
  console.log('在另一台电脑上装好插件后，在那边的 Claude Code 里运行 /numable-usage，说「加入用量空间」并贴上这一串：\n');
  console.log(code);
  console.log('\n加入后两台电脑的用量会合并显示在同一组组件里，Numable 里不用再绑第二个令牌。');
  console.log('⚠ 这一串能往你的空间写数据，只在你自己的电脑之间传，不要发给别人。');
}

async function cmdJoin(code) {
  let o = null;
  try {
    if (typeof code === 'string' && code.startsWith('nu1.')) o = JSON.parse(Buffer.from(code.slice(4), 'base64url').toString('utf8'));
  } catch { /* 下面统一报 */ }
  const tokOk = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{8,32}\.[A-Za-z0-9_-]{20,}$/.test(t);
  if (!o || !tokOk(o.w) || !tokOk(o.r) || typeof o.s !== 'string' || !o.w.startsWith(o.s + '.') || !o.r.startsWith(o.s + '.')) {
    console.log('这一串不对。请在原来那台电脑上运行 /numable-usage 重新生成（--link）。'); return;
  }
  const endpoint = typeof o.e === 'string' && /^https?:\/\//.test(o.e) ? o.e : 'https://usage.numable.app';
  if (endpoint !== ENDPOINT) {
    console.log(`这一串指向另一个服务端（${endpoint}）。请先设置 NUMABLE_USAGE_ENDPOINT=${endpoint} 再加入。`); return;
  }

  const release = await acquireLock();
  if (!release) { console.log('采集正在进行，过几秒再试一次。'); return; }
  try {
    const old = readJson(CONFIG, null) || {};
    if (old.spaceId === o.s) { console.log('这台电脑已经在这个空间里了。'); return; }
    let r;
    try { r = await get('/s', o.r); } catch (e) { console.log('连不上服务端：', e && e.message); return; }
    if (r.status === 401) { console.log('这一串已经失效。请在原来那台电脑上重新生成。'); return; }
    if (!r.ok) { console.log('加入失败：', r.status, r.text.slice(0, 200)); return; }

    const device = deviceId(old);
    // 这台电脑原先自己那个空间里的设备行顺手删掉（尽力而为）：不删也会在 90 天无推送后被回收
    if (old.spaceId && old.writeToken) {
      try { await post('/forget', { source: 'claude-code', device }, old.writeToken); } catch { /* 忽略 */ }
    }
    writeJson(CONFIG, {
      endpoint, spaceId: o.s, writeToken: o.w, readToken: o.r, device,
      createdAt: old.createdAt || new Date().toISOString(), joinedAt: new Date().toISOString(),
    });
    await collectAndPush({ force: true });
    console.log('已加入。这台电脑的用量会和原来那台合并显示；Numable 里不用改任何设置，下次刷新就能看到。');
  } finally {
    release();
  }
}

// ---------- 主流程 ----------
async function main() {
  const arg = process.argv[2];
  if (arg === '--status') return cmdStatus();
  if (arg === '--code') return cmdCode();
  if (arg === '--token') return cmdToken();
  if (arg === '--devices') return cmdDevices();
  if (arg === '--forget') return cmdForget(process.argv[3]);
  if (arg === '--projects') return cmdProjects(process.argv[3]);
  if (arg === '--link') return cmdLink();
  if (arg === '--join') return cmdJoin(process.argv[3]);
  if (arg === '--run' || DEBUG) return runCollect();

  // Stop 钩子（每轮回复结束都触发）：离上次起采集不到 TICK_MS 就什么都不做，连后台进程都不起。
  // 会话开始 / 结束不节流 —— 那两刻的数据最该准。
  const mark = path.join(STATE_DIR, 'last-spawn');
  if (arg === '--tick') {
    try { if (Date.now() - fs.statSync(mark).mtimeMs < TICK_MS) return; } catch { /* 没有标记 = 从没起过 */ }
  }
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(mark, ''); } catch { /* 标记写不了只是少节流 */ }

  // hook 入口：把采集甩给一个脱离会话的后台进程，自己立刻退出。
  // 首次（或 history 升级后）全量重扫要十几秒，挂在 SessionStart 上会让会话卡住等它。
  // ⚠️ stdio 必须 ignore：子进程只要还握着 hook 的输出管道，Claude Code 就会等它。
  // detached = 自成进程组，会话退出（SessionEnd 之后）不会连带杀掉它。
  try {
    spawn(process.execPath, [__filename, '--run'], {
      detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
    }).unref();
  } catch (e) {
    log('spawn failed, run inline', e && e.message);
    return runCollect();
  }
}

async function runCollect() {
  // 读-改-写 config / history 全程持锁；拿不到（别的会话正在采集）就放弃这一轮 ——
  // 它会顺带把本会话已写下的行也扫进去，漏掉的尾巴下一次 hook 触发时补上。
  const release = await acquireLock();
  if (!release) { log('another collector is running, skip'); return; }
  try {
    await collectAndPush();
  } finally {
    release();
  }
}

async function collectAndPush({ force = false } = {}) {
  let cfg = readJson(CONFIG, null);

  if (!cfg || !cfg.spaceId || !cfg.writeToken) {
    const r = await post('/space', {});
    if (!r.ok || !r.json || !r.json.spaceId) { log('create space failed', r.status, r.text); return; }
    cfg = {
      endpoint: ENDPOINT,
      spaceId: r.json.spaceId,
      writeToken: r.json.writeToken,
      readToken: r.json.readToken,
      createdAt: new Date().toISOString(),
    };
    writeJson(CONFIG, cfg);
    printOnboarding();
  }

  const history = loadHistory();
  const touched = await scan(history);
  foldWindows(history);                              // 必须在 prune 之前:prune 会裁掉 12 小时前的事件
  prune(history);
  writeJson(HISTORY, history);
  log('scanned files:', touched, 'days:', Object.keys(history.days).length);

  if (!touched && !force && !process.env.NUMABLE_USAGE_FORCE) { log('nothing changed, skip push'); return; }

  // 设备标识第一次算出后钉进 config，之后不再重算。
  // ⚠️ macOS 没设 HostName 时 os.hostname() 随网络变（DHCP / Bonjour 名），
  // 每变一次服务端就多出一行「设备」，App 按天合并各设备 → 同一台机器的日子被重复计算。
  if (!cfg.device) {
    cfg.device = deviceId(cfg);
    writeJson(CONFIG, cfg);
  }
  const device = cfg.device;

  const payload = buildPayload(history, device, { projectNames: cfg.projectNames === true });
  const r = await post('/ingest', payload, cfg.writeToken);
  if (!r.ok) { log('ingest failed', r.status, r.text); return; }
  log('pushed', payload.snapshot.days.length, 'days');
}

function printOnboarding() {
  const line = '─'.repeat(46);
  console.error(`\n${line}
  Numable · Claude Code 用量已开始采集
  ${line}
  在 Claude Code 里运行 /numable-usage 取出读取令牌，
  粘贴到 Numable 的「我的 → 凭证」里，就能在手机和桌面组件上看到用量。

  · 只上传聚合数字，你的代码与对话永不离开本机
${line}\n`);
}

if (require.main === module) {
  main().catch((e) => { log('fatal (swallowed)', e && e.message); });
}

// 供测试用（hook 直接执行本文件，走上面那条）
module.exports = { absorb, isHumanPrompt, scan, loadHistory, buildPayload, foldWindows, acquireLock, tryLock, emptyDay, ghostOf, activeMinutes, flushAct, touchSession, countLines };
