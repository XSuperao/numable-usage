#!/usr/bin/env node
/**
 * numable-usage · 采集器
 *
 * 从 ~/.claude/projects/**\/*.jsonl 增量提取**纯数字**用量，累积到本机 history.json，
 * 再把全量快照推送到 usage.numable.app。
 *
 * 隐私硬承诺（可审计 —— 见 buildPayload 的显式白名单构造）：
 *   读取的字段只有 type / timestamp / sessionId / isSidechain / isMeta / origin.kind /
 *   message.id / requestId / message.model / message.usage.*；
 *   另外 user 行的 message.content 只看两样东西来判断「这是不是你本人发的」（见 isHumanPrompt）：
 *   数组里各项的 type（有没有 tool_result）、正文开头是不是系统注入的固定标签。判断完即丢弃。
 *   cwd、gitBranch、对话正文、toolUseResult 一律不落盘、不上报。
 *   上报体里唯一的字符串是「模型名」与「日期」。主机名只以 hash 形式出现。
 *
 * 计数口径（2026-09-24 修正，history v2）：
 *   - token：按 API 响应计。Claude Code 把一次回复的每个内容块各写一行，且每行带着同一份
 *     usage —— 必须按 message.id + requestId 去重，否则 token 虚高 2~3 倍。
 *   - 消息：真人发言 + Claude 回复（同样按响应去重），不含工具返回结果与系统注入。
 *   - 活跃时段：只看真人发言。工具返回结果的 type 也是 user，占 user 行九成。
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
      const pid = parseInt(fs.readFileSync(lockPath, 'utf8'), 10);
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      stale = !pidAlive(pid) || age > LOCK_STALE_MS;
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
// v1 的数字虚高，不与 v2 混用：读到 v1 直接丢弃，从本机会话记录全量重算。
const HISTORY_V = 2;
const emptyDay = () => ({ msgs: 0, sess: [], out: 0, in: 0, cr: 0, rd: 0, hours: {}, byModel: {} });

function loadHistory(p = HISTORY) {
  const h = readJson(p, null);
  if (!h || h.v !== HISTORY_V || !h.days || typeof h.days !== 'object') return { v: HISTORY_V, files: {}, days: {} };
  if (!h.files || typeof h.files !== 'object') h.files = {};
  return h;
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

/** 把一行的数字并进 history。recent = 本文件最近的响应键（会被修改）。返回是否计入。 */
function absorb(days, o, recent) {
  const t = o.type;
  if (t !== 'user' && t !== 'assistant') return false;
  const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
  if (!Number.isFinite(ts)) return false;

  const date = localDay(new Date(ts));
  const day = days[date] || (days[date] = emptyDay());
  const side = !!o.isSidechain;

  // Sessions：排除 sidechain（subagent 内部往返不是「你的对话」）
  if (!side && typeof o.sessionId === 'string' && !day.sess.includes(o.sessionId)) day.sess.push(o.sessionId);

  if (t === 'user') {
    // Messages / Peak hour：只数你本人发的，排除 sidechain
    if (!side && isHumanPrompt(o)) {
      day.msgs++;
      const h = String(new Date(ts).getHours());
      day.hours[h] = (day.hours[h] || 0) + 1;
    }
    return true;
  }

  // assistant：同一响应只计一次
  const k = responseKey(o);
  if (k) {
    if (recent.includes(k)) return true;
    remember(recent, k);
  }
  if (!side) day.msgs++;

  // Tokens：含 sidechain（subagent 也在真实消耗）
  const m = o.message;
  if (m && typeof m === 'object' && m.usage && typeof m.usage === 'object') {
    const u = m.usage;
    const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
    const oi = n(u.input_tokens), oo = n(u.output_tokens);
    const ocr = n(u.cache_creation_input_tokens), ord = n(u.cache_read_input_tokens);
    day.in += oi; day.out += oo; day.cr += ocr; day.rd += ord;
    const mm = normModel(m.model);
    if (mm) {
      const b = day.byModel[mm] || (day.byModel[mm] = { in: 0, out: 0, msgs: 0 });
      b.in += oi; b.out += oo; b.msgs++;
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
    let st; try { st = fs.statSync(f); } catch { continue; }
    const prev = history.files[f];
    let from = 0;
    let recent = [];
    if (prev && typeof prev.off === 'number' && typeof prev.size === 'number') {
      if (st.size === prev.size) continue;                // 没变，跳过
      if (st.size > prev.size) {                          // append，从上次最后一个完整行之后续读
        from = prev.off;
        if (Array.isArray(prev.recent)) recent = prev.recent.slice(-RECENT_KEYS);
      } else log('rewound, rescan:', path.basename(f));    // 被重写，从头读
    }

    // 只读到「最后一个完整行」为止：之后的半行等它写完下一轮再读。
    // 边界必须在读之前定死 —— 读的过程中文件还在被别的会话追加，
    // 不设 end 就会读进 stat 之后的行，而 offset 又停在它们之前 → 下一轮重复计入。
    let off;
    try { off = lastLineEnd(f, from, st.size); } catch { continue; }

    if (off > from) {
      await new Promise((resolve) => {
        const rs = fs.createReadStream(f, { start: from, end: off - 1, encoding: 'utf8' });
        const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
        rl.on('line', (line) => {
          if (!line) return;
          try { absorb(history.days, JSON.parse(line), recent); } catch { /* 坏行，丢弃 */ }
        });
        rl.on('close', resolve);
        rs.on('error', () => resolve());
      });
    }

    const entry = { off, size: st.size };
    if (recent.length && Date.now() - st.mtimeMs < RECENT_TTL_MS) entry.recent = recent;
    history.files[f] = entry;
    touched++;
  }
  return touched;
}

// ---------- 滚动裁剪 ----------
function prune(history) {
  const cutoff = localDay(new Date(Date.now() - KEEP_DAYS * 864e5));
  for (const d of Object.keys(history.days)) if (d < cutoff) delete history.days[d];
  // 文件表：projects 里已消失的文件清掉，防无限增长
  for (const f of Object.keys(history.files)) if (!fs.existsSync(f)) delete history.files[f];
}

// ---------- 显式白名单构造 payload ----------
/** 只有这里列出的字段会离开本机。新增字段必须显式加在这里。 */
function buildPayload(history, device) {
  const days = [];
  const byModel = {};
  const hours = {};
  let tSess = 0, tMsgs = 0, tOut = 0, tIn = 0, tCr = 0;

  for (const date of Object.keys(history.days).sort()) {
    const d = history.days[date];
    const sessions = Array.isArray(d.sess) ? d.sess.length : 0;
    days.push({
      date,                                   // 采集机本地日期字符串，全链路原样透传，不做时区转换
      msgs: d.msgs | 0,
      sessions,
      out: d.out | 0,
      in: d.in | 0,
      cacheCreate: d.cr | 0,
    });
    tSess += sessions; tMsgs += d.msgs | 0; tOut += d.out | 0; tIn += d.in | 0; tCr += d.cr | 0;
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

  return {
    source: 'claude-code',
    device,
    snapshot: {
      v: 1,
      days,
      byModel,
      hours,
      totals: { sessions: tSess, msgs: tMsgs, out: tOut, in: tIn, cacheCreate: tCr,
                activeDays: days.length, streak, longestStreak: longest },
    },
  };
}

// ---------- 网络 ----------
async function post(pathname, body, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  // 必须有超时：服务端挂住时 hook 会一直卡着，而且期间一直持锁
  const res = await fetch(ENDPOINT + pathname, {
    method: 'POST', headers, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { ok: res.ok, status: res.status, json, text };
}

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

async function cmdCode() {
  const cfg = readJson(CONFIG, null);
  if (!cfg || !cfg.writeToken) { console.log('尚未接入，先跑一次采集。'); return; }
  const r = await post('/code', {}, cfg.writeToken);
  if (!r.ok || !r.json || !r.json.code) { console.log('生成失败:', r.status, r.text.slice(0, 200)); return; }
  printOnboarding(r.json.code, console.log);
}

// ---------- 主流程 ----------
async function main() {
  const arg = process.argv[2];
  if (arg === '--status') return cmdStatus();
  if (arg === '--code') return cmdCode();
  if (arg === '--token') return cmdToken();
  if (arg === '--run' || DEBUG) return runCollect();

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

async function collectAndPush() {
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
    printOnboarding(r.json.code);
  }

  const history = loadHistory();
  const touched = await scan(history);
  prune(history);
  writeJson(HISTORY, history);
  log('scanned files:', touched, 'days:', Object.keys(history.days).length);

  if (!touched && !process.env.NUMABLE_USAGE_FORCE) { log('nothing changed, skip push'); return; }

  const device = crypto.createHash('sha256')
    .update(os.hostname() + '|' + os.userInfo().username)   // 主机名常含真名 —— 只上报 hash
    .digest('hex').slice(0, 12);

  const payload = buildPayload(history, device);
  const r = await post('/ingest', payload, cfg.writeToken);
  if (!r.ok) { log('ingest failed', r.status, r.text); return; }
  log('pushed', payload.snapshot.days.length, 'days');
}

function printOnboarding(code, out) {
  const w = out || console.error;
  const line = '─'.repeat(46);
  w(`\n${line}
  Numable · Claude Code 用量小组件已就绪
  ${line}
  在手机 / 桌面的 Numable 里打开「Claude Code 用量」，
  输入这个配对码即可看到你的用量卡片：

        ${code}

  · 5 分钟内有效，可用 /numable-usage 重新生成
  · 只上传聚合数字，你的代码与对话永不离开本机
${line}\n`);
}

if (require.main === module) {
  main().catch((e) => { log('fatal (swallowed)', e && e.message); });
}

// 供测试用（hook 直接执行本文件，走上面那条）
module.exports = { absorb, isHumanPrompt, scan, loadHistory, buildPayload, acquireLock, tryLock, emptyDay };
