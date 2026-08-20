#!/usr/bin/env node
/**
 * numable-usage · 采集器
 *
 * 从 ~/.claude/projects/**\/*.jsonl 增量提取**纯数字**用量，累积到本机 history.json，
 * 再把全量快照推送到 usage.numable.app。
 *
 * 隐私硬承诺（可审计 —— 见 buildPayload 的显式白名单构造）：
 *   读取的字段只有 type / timestamp / sessionId / isSidechain / message.model / message.usage.*
 *   cwd、gitBranch、message.content、toolUseResult 一律不读取、不落盘、不上报。
 *   上报体里唯一的字符串是「模型名」与「日期」。主机名只以 hash 形式出现。
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

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const PROJECTS = path.join(CLAUDE_DIR, 'projects');
const STATE_DIR = process.env.NUMABLE_USAGE_STATE_DIR || path.join(CLAUDE_DIR, 'numable-usage');
const CONFIG = path.join(STATE_DIR, 'config.json');
const HISTORY = path.join(STATE_DIR, 'history.json');

const ENDPOINT = process.env.NUMABLE_USAGE_ENDPOINT || 'https://usage.numable.app';
const KEEP_DAYS = 90;
const DEBUG = !!process.env.NUMABLE_USAGE_DEBUG;
const ALL_MODELS = process.env.NUMABLE_USAGE_MODELS === 'all';

const log = (...a) => { if (DEBUG) console.error('[numable-usage]', ...a); };

// ---------- 小工具 ----------
const readJson = (p, fb) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } };
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
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

// ---------- 空历史 ----------
const emptyDay = () => ({ msgs: 0, sess: [], out: 0, in: 0, cr: 0, rd: 0, tools: 0, hours: {}, byModel: {} });

function loadHistory() {
  const h = readJson(HISTORY, null);
  if (!h || h.v !== 1 || typeof h.days !== 'object') return { v: 1, files: {}, days: {} };
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

/** 把一行的数字并进 history。返回是否计入。 */
function absorb(days, o) {
  const t = o.type;
  if (t !== 'user' && t !== 'assistant') return false;
  const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
  if (!Number.isFinite(ts)) return false;

  const date = localDay(new Date(ts));
  const day = days[date] || (days[date] = emptyDay());
  const side = !!o.isSidechain;

  // Messages / Sessions / Peak hour：排除 sidechain（subagent 内部往返不是「你的对话」）
  if (!side) {
    day.msgs++;
    if (typeof o.sessionId === 'string' && !day.sess.includes(o.sessionId)) day.sess.push(o.sessionId);
    if (t === 'user') {
      const h = String(new Date(ts).getHours());
      day.hours[h] = (day.hours[h] || 0) + 1;
    }
  }

  // Tokens：含 sidechain（subagent 也在真实消耗）
  const m = o.message;
  if (t === 'assistant' && m && typeof m === 'object' && m.usage && typeof m.usage === 'object') {
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

async function scan(history) {
  if (!fs.existsSync(PROJECTS)) { log('no projects dir'); return 0; }
  const files = listJsonl(PROJECTS);
  let touched = 0;

  for (const f of files) {
    let st; try { st = fs.statSync(f); } catch { continue; }
    const prev = history.files[f];
    let from = 0;
    if (prev && typeof prev.off === 'number') {
      if (st.size === prev.off) continue;                 // 没长，跳过
      if (st.size > prev.off) from = prev.off;            // append，只读新增
      // st.size < prev.off → 文件被重写，from 保持 0 全读
      if (st.size < prev.off) { log('rewound, rescan:', path.basename(f)); }
    }

    await new Promise((resolve) => {
      const rs = fs.createReadStream(f, { start: from, encoding: 'utf8' });
      const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
      let first = true;
      rl.on('line', (line) => {
        // 从 offset 续读时首行可能是半行（上次写到一半）—— JSON.parse 会失败并被丢弃，
        // 这是可接受的：下一轮该行已完整，但 offset 已越过它。故 offset 只在整行边界推进（见下）。
        if (!line) { first = false; return; }
        try { absorb(history.days, JSON.parse(line)); } catch { /* 半行或坏行，丢弃 */ }
        first = false;
      });
      rl.on('close', resolve);
      rs.on('error', () => resolve());
    });

    // offset 推进到「最后一个换行符」处，保证下次从整行开始，不会重复计入也不会腰斩。
    let off = st.size;
    try {
      const fd = fs.openSync(f, 'r');
      const tailLen = Math.min(65536, st.size);
      const buf = Buffer.alloc(tailLen);
      fs.readSync(fd, buf, 0, tailLen, st.size - tailLen);
      fs.closeSync(fd);
      const idx = buf.lastIndexOf(0x0a);
      if (idx >= 0) off = st.size - tailLen + idx + 1;
      else if (from > 0) off = from;                       // 整段无换行，不推进
    } catch { /* 拿不到就用 size */ }

    history.files[f] = { off, size: st.size };
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
  const res = await fetch(ENDPOINT + pathname, { method: 'POST', headers, body: JSON.stringify(body || {}) });
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
  console.log('\n要在新设备上看，用 --code 生成配对码。');
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

main().catch((e) => { log('fatal (swallowed)', e && e.message); });
