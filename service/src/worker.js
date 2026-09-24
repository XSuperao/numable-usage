/**
 * numable-usage · 投递服务
 *
 * 刻意封闭：只接受 §schema 白名单里的字段，未知字段直接丢弃。
 * 于是隐私承诺是「结构上就存不下别的东西」，而不是「我们保证不看」——
 * 前者机器可验，后者只是句话。
 *
 * 端点：
 *   POST /space                     → { spaceId, writeToken, readToken, code }
 *   POST /ingest  Bearer<write>     → { ok }
 *   POST /code    Bearer<write>     → { code }
 *   POST /forget  Bearer<write>     { source, device } → { ok, removed }   删掉一个设备行
 *   POST /claim   { code }          → { readToken }
 *   GET  /s       Bearer<read>      → { updatedAt, merged, sources }   ?today=YYYY-MM-DD 以看的人那天为锚
 *   GET  /health
 */

const MAX_BODY = 256 * 1024;       // 单快照上限（v2 快照带逐日按模型 / 工具 / 小时明细，实测 90 天 ≈ 40KB）
const MAX_ROWS_PER_SPACE = 20;     // source × device
const CODE_TTL_MS = 5 * 60 * 1000;
const KEEP_MS = 90 * 864e5;
// 去掉易混字符 I/L/O/U/0/1 —— 6 位 ≈ 7.3 亿组合（6 位纯数字只有 100 万，5 分钟内可暴破）
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
const err = (code, status = 400) => json({ error: code }, status);

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return b64url(d);
}
const randId = () => b64url(crypto.getRandomValues(new Uint8Array(12)));

/**
 * 令牌 = `<spaceId>.<HMAC(secret, kind:spaceId)>` —— 服务端**不存任何令牌**（连 hash 都不存）。
 * 好处：① claim 要返回 readToken 明文，派生方案随时可重算，不必落库明文；
 *       ② DB 泄露不等于令牌泄露；③ 验证无需查库。
 * 代价：不可单独吊销（换 TOKEN_SECRET 即全体失效）。本场景可接受。
 */
async function hmac(env, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.TOKEN_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
const mkToken = async (env, kind, spaceId) => `${spaceId}.${await hmac(env, kind + ':' + spaceId)}`;
/** 常数时间比较，防按前缀逐字节试探 */
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function verifyToken(env, kind, token) {
  if (typeof token !== 'string') return null;
  const i = token.indexOf('.');
  if (i <= 0) return null;
  const spaceId = token.slice(0, i);
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(spaceId)) return null;
  return safeEq(token, await mkToken(env, kind, spaceId)) ? spaceId : null;
}
function randCode() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  let s = '';
  for (const x of b) s += CODE_ALPHABET[x % CODE_ALPHABET.length];
  return s;
}
const bearer = (req) => {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
};

/** 限流：D1 计数窗口。返回 true = 放行。 */
async function allow(env, key, limit, windowMs = 60000) {
  const win = Math.floor(Date.now() / windowMs);
  try {
    await env.DB.prepare(
      `INSERT INTO rl(k, win, n) VALUES(?1, ?2, 1)
       ON CONFLICT(k) DO UPDATE SET
         n = CASE WHEN rl.win = ?2 THEN rl.n + 1 ELSE 1 END,
         win = ?2`
    ).bind(key, win).run();
    const row = await env.DB.prepare('SELECT n FROM rl WHERE k = ?1').bind(key).first();
    return !row || row.n <= limit;
  } catch {
    return true;   // 限流表故障不该拒服务
  }
}

// ─────────────────────────── schema 白名单 ───────────────────────────
const int = (v, max = 2 ** 53 - 1) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.floor(v), max) : 0;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MODEL_RE = /^[a-zA-Z0-9._-]{1,64}(@fast)?$/;   // @fast = 快速模式（同一模型，单价翻倍）
const TOOL_RE = /^[A-Za-z]{1,24}$/;
const PROJ_RE = /^[a-f0-9]{8,16}$/;
/** 逐项白名单构造的 {键: 非负整数} 表 */
const intMap = (o, keyOk, max = 64) => {
  const r = {};
  if (!o || typeof o !== 'object') return r;
  for (const [k, v] of Object.entries(o).slice(0, max)) if (keyOk(k)) r[k] = int(v);
  return r;
};
const hourKey = (k) => { const h = Number(k); return Number.isInteger(h) && h >= 0 && h <= 23 && String(h) === k; };
const modelTok = (v) => ({ in: int(v.in), out: int(v.out), c5: int(v.c5), c1: int(v.c1), rd: int(v.rd), n: int(v.n) });
const modelMap = (o, max = 16) => {
  const r = {};
  if (!o || typeof o !== 'object') return r;
  for (const [k, v] of Object.entries(o).slice(0, max)) if (MODEL_RE.test(k) && v && typeof v === 'object') r[k] = modelTok(v);
  return r;
};
/** 用户打开开关才会有的项目文件夹名：去控制字符、截 40 字 */
const cleanName = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40) : '');

/**
 * claude-code 快照白名单。**显式构造**（不是过滤）——
 * 只有这里写出来的字段能进库，输入里的任何其它东西都到不了 D1。
 */
function sanitizeClaudeCode(s) {
  if (!s || typeof s !== 'object') return null;

  const days = [];
  if (Array.isArray(s.days)) {
    for (const d of s.days.slice(0, 400)) {
      if (!d || typeof d !== 'object' || typeof d.date !== 'string' || !DATE_RE.test(d.date)) continue;
      days.push({
        date: d.date,                       // 采集机本地日期，原样透传，服务端绝不做时区转换
        msgs: int(d.msgs),
        sessions: int(d.sessions),
        out: int(d.out),
        in: int(d.in),
        cacheCreate: int(d.cacheCreate),
        // v2（插件 0.5.0 起）；老插件没有这些键 → 全 0 / 空表，服务端据 m 是否为空判断「这天能不能折算费用」
        rd: int(d.rd), c1: int(d.c1), th: int(d.th), so: int(d.so), ws: int(d.ws), wf: int(d.wf),
        la: int(d.la), lr: int(d.lr), am: int(d.am, 1440),
        h: intMap(d.h, hourKey, 24),
        m: modelMap(d.m),
        t: intMap(d.t, (k) => TOOL_RE.test(k), 32),
      });
    }
  }

  const byModel = {};
  if (s.byModel && typeof s.byModel === 'object') {
    for (const [k, v] of Object.entries(s.byModel).slice(0, 40)) {
      if (!MODEL_RE.test(k) || !v || typeof v !== 'object') continue;
      byModel[k] = { in: int(v.in), out: int(v.out), msgs: int(v.msgs) };
    }
  }

  const hours = {};
  if (s.hours && typeof s.hours === 'object') {
    for (const [k, v] of Object.entries(s.hours)) {
      const h = Number(k);
      if (Number.isInteger(h) && h >= 0 && h <= 23) hours[String(h)] = int(v);
    }
  }

  let window = null;
  const w = s.window;
  if (w && typeof w === 'object' && int(w.e) > int(w.s)) {
    window = { s: int(w.s), e: int(w.e), l: int(w.l), n: int(w.n), m: modelMap(w.m) };
  }
  const ss = s.sessStats && typeof s.sessStats === 'object' ? s.sessStats : {};
  const sessStats = { n: int(ss.n), avgMin: int(ss.avgMin), maxMin: int(ss.maxMin) };
  const projects = [];
  if (Array.isArray(s.projects)) {
    for (const p of s.projects.slice(0, 12)) {
      if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !PROJ_RE.test(p.id)) continue;
      const row = { id: p.id, out: int(p.out), tok: int(p.tok), n: int(p.n), d7out: int(p.d7out), d7tok: int(p.d7tok) };
      const name = cleanName(p.name);
      if (name) row.name = name;
      projects.push(row);
    }
  }

  const t = s.totals && typeof s.totals === 'object' ? s.totals : {};
  return {
    v: s.v === 2 ? 2 : 1,
    days,
    byModel,
    hours,
    window,
    sessStats,
    projects,
    totals: {
      sessions: int(t.sessions),
      msgs: int(t.msgs),
      out: int(t.out),
      in: int(t.in),
      cacheCreate: int(t.cacheCreate),
      activeDays: int(t.activeDays),
      streak: int(t.streak, 100000),
      longestStreak: int(t.longestStreak, 100000),
    },
  };
}

const SOURCES = { 'claude-code': sanitizeClaudeCode };   // 枚举，不是自由字段

// ─────────────────────────── API 标价 ───────────────────────────
/*
 * 每百万 token 美元：[输入, 5 分钟缓存写入, 1 小时缓存写入, 缓存读取, 输出]。
 * 真源 = https://platform.claude.com/docs/en/about-claude/pricing （2026-09-24 抄录）。
 * ⚠️ 这是「按 API 标价折算」—— 订阅（Pro / Max）用户并不按这个付钱，文案必须说成「值多少」而不是「花了多少」。
 * 表外的模型不猜价：那部分 token 记为「未计价」，由页面如实标出。
 * 快速模式（@fast）：Opus 5.5 / 5 / 4.8 的输入输出单价翻倍，缓存倍率叠在其上 → 整行 ×2。
 */
const PRICES = {
  'claude-fable-5-1': [10, 12.5, 20, 0.25, 50],
  'claude-mythos-5-1': [10, 12.5, 20, 0.25, 50],
  'claude-fable-5': [10, 12.5, 20, 1, 50],
  'claude-mythos-5': [10, 12.5, 20, 1, 50],
  'claude-opus-5-5': [4, 5, 8, 0.2, 20],
  'claude-opus-5': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-8': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-7': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-6': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-5': [5, 6.25, 10, 0.5, 25],
  'claude-opus-4-1': [15, 18.75, 30, 1.5, 75],
  'claude-opus-4': [15, 18.75, 30, 1.5, 75],
  'claude-sonnet-5': [2, 2.5, 4, 0.2, 10],
  'claude-sonnet-4-6': [3, 3.75, 6, 0.3, 15],
  'claude-sonnet-4-5': [3, 3.75, 6, 0.3, 15],
  'claude-sonnet-4': [3, 3.75, 6, 0.3, 15],
  'claude-haiku-4-5': [1, 1.25, 2, 0.1, 5],
  'claude-3-5-haiku': [0.8, 1, 1.6, 0.08, 4],
};
const WEB_SEARCH_USD = 0.01;                       // $10 / 1000 次；网页抓取不另收费
const baseModel = (name) => String(name).replace(/@fast$/, '');
/** 一个模型一份 token 明细的美元折算；表外模型返回 null */
function priceOf(name, v) {
  const key = baseModel(name).replace(/-\d{8}$/, '');   // 去掉发布日期后缀
  const p = PRICES[key];
  if (!p) return null;
  const k = /@fast$/.test(name) ? 2 : 1;
  return k * (v.in * p[0] + v.c5 * p[1] + v.c1 * p[2] + v.rd * p[3] + v.out * p[4]) / 1e6;
}
/** 一组按模型明细的总价：{ usd, unpriced: 表外模型的输出 token 数 } */
function costOfModels(m) {
  let usd = 0, unpriced = 0;
  for (const [name, v] of Object.entries(m || {})) {
    const c = priceOf(name, v);
    if (c === null) unpriced += v.out + v.in; else usd += c;
  }
  return { usd, unpriced };
}
const r2 = (x) => Math.round(x * 100) / 100;
/** 美元显示串。组件的取数流（VParser）没有取整 / 保留两位小数的方法，格式化只能在这儿做 ——
 *  与页面 usd() 同一套规则：不到一分钱写 <$0.01（别把「几乎没花」写成 $0.00），过百取整加千分位。 */
const usdS = (v) => (v == null || !isFinite(v) ? '--' : v === 0 ? '$0' : v < 0.01 ? '<$0.01'
  : '$' + (v < 100 ? v.toFixed(2) : Math.round(v).toLocaleString('en-US')));
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
/** 变化：{ p: 百分比整数 | null, s: '↑12%' / '↓8%' / '' }。上一段为 0 时 p = null、s = ''。 */
const chg = (cur, prev) => {
  if (!(prev > 0)) return { p: null, s: '' };
  const p = Math.round(((cur - prev) / prev) * 100);
  return { p, s: (p >= 0 ? '↑' : '↓') + Math.abs(p) + '%' };
};

/**
 * 多设备合并成一份（同一个人的多台机器应该看成一份用量）。
 * anchor = 看的人那边的「今天」（YYYY-MM-DD，由取数流带上来）。给了它：
 *   - today 就是那一天（没用过 = 全 0 的一行），不再拿「数据里最后一天」冒充今天；
 *   - 热力网格右下角落在那一天；
 *   - 连续天数按**合并后**的日期集合重算 —— 各设备各算再取最大，两台电脑轮流用就断了。
 * 不给（老版本的包）：维持原行为。
 */
function mergeClaudeCode(list, anchor) {
  const dayMap = new Map(), byModel = {}, hours = {};
  const tot = { sessions: 0, msgs: 0, out: 0, in: 0, cacheCreate: 0, streak: 0, longestStreak: 0 };
  for (const s of list) {
    for (const d of s.days || []) {
      const cur = dayMap.get(d.date) || { date: d.date, msgs: 0, sessions: 0, out: 0, in: 0, cacheCreate: 0 };
      cur.msgs += d.msgs; cur.sessions += d.sessions; cur.out += d.out;
      cur.in += d.in; cur.cacheCreate += d.cacheCreate;
      dayMap.set(d.date, cur);
      // v2 明细：放在不下发的 x 里，派生完再丢（days 列表下发给老包，不能长胖）
      const x = cur.x || (cur.x = { rd: 0, c1: 0, th: 0, so: 0, ws: 0, wf: 0, la: 0, lr: 0, am: 0, h: {}, m: {}, t: {}, v1: false });
      for (const k of ['rd', 'c1', 'th', 'so', 'ws', 'wf', 'la', 'lr', 'am']) x[k] += d[k] || 0;
      for (const [k, v] of Object.entries(d.h || {})) x.h[k] = (x.h[k] || 0) + v;
      for (const [k, v] of Object.entries(d.t || {})) x.t[k] = (x.t[k] || 0) + v;
      for (const [k, v] of Object.entries(d.m || {})) {
        const b = x.m[k] || (x.m[k] = { in: 0, out: 0, c5: 0, c1: 0, rd: 0, n: 0 });
        for (const f of ['in', 'out', 'c5', 'c1', 'rd', 'n']) b[f] += v[f] || 0;
      }
      // 这台设备这天有用量却没有按模型明细 = 老插件推的，折算不了费用
      if (d.out > 0 && !(d.m && Object.keys(d.m).length)) x.v1 = true;
    }
    for (const [m0, v] of Object.entries(s.byModel || {})) {
      const m = baseModel(m0);                    // 快速模式并回同一个模型：分布看的是「谁在干活」
      const b = byModel[m] || (byModel[m] = { in: 0, out: 0, msgs: 0 });
      b.in += v.in; b.out += v.out; b.msgs += v.msgs;
    }
    for (const [h, c] of Object.entries(s.hours || {})) hours[h] = (hours[h] || 0) + c;
    const t = s.totals || {};
    tot.sessions += t.sessions || 0; tot.msgs += t.msgs || 0; tot.out += t.out || 0;
    tot.in += t.in || 0; tot.cacheCreate += t.cacheCreate || 0;
    // streak 取最大而非相加（多设备是同一个人，连续性按最好的那台算）
    tot.streak = Math.max(tot.streak, t.streak || 0);
    tot.longestStreak = Math.max(tot.longestStreak, t.longestStreak || 0);
  }
  const full = [...dayMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  // 逐日下发只带四个小字段（详情页「这一天」要用）：费用（老插件推的日子折算不了 → null）/ 活跃分钟 / 改动行数
  const days = full.map(({ x, ...d }) => ({
    ...d,
    usd: x && !x.v1 ? r2(costOfModels(x.m).usd + x.ws * WEB_SEARCH_USD) : null,
    am: x ? x.am : 0, la: x ? x.la : 0, lr: x ? x.lr : 0,
  }));
  tot.activeDays = days.length;
  // 模型按 output 降序，取前 6（卡上画不下更多，且服务端排好省得 RCN 里排）
  const totOut = Object.values(byModel).reduce((a, v) => a + v.out, 0) || 1;
  /* 短标签：卡片上画不下 `claude-haiku-4-5-20251001`。纯字符串处理，放这里省得四端各写一份。
     未知形态原样回落（宁可长一点，也不要猜错成别的模型名）。 */
  const label = (n) => {
    if (n === 'other') return 'Other';
    // 小版本号只认 1~2 位：`claude-opus-4-20250514` 里那串是发布日期，不是「4.20250514」
    const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(n);
    if (!m) return n;
    const fam = m[1][0].toUpperCase() + m[1].slice(1);
    return `${fam} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
  };
  const models = Object.entries(byModel).filter(([, v]) => v.out > 0 || v.in > 0).sort((a, b) => b[1].out - a[1].out).slice(0, 6)
    .map(([name, v]) => ({
      name, label: label(name), in: v.in, out: v.out, msgs: v.msgs,
      pct: Math.round((v.out / totOut) * 1000) / 10,
    }));
  const peak = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];
  const lastDate = days.length ? days[days.length - 1].date : '';
  // 看的人比采集机的时区靠后时，数据里会有「他的明天」—— 那就以数据为准，不往回退
  const anchorDate = anchor && (!lastDate || anchor >= lastDate) ? anchor : lastDate;
  const zeroDay = (date) => ({ date, msgs: 0, sessions: 0, out: 0, in: 0, cacheCreate: 0, usd: 0, am: 0, la: 0, lr: 0 });
  const today = anchor
    ? (days.find((d) => d.date === anchorDate) || zeroDay(anchorDate))
    : (days.length ? days[days.length - 1] : null);

  if (anchor) {
    const DAY = 864e5;
    const ms = (d) => Date.parse(d + 'T00:00:00Z');
    const has = new Set(days.map((d) => d.date));
    const iso = (t) => new Date(t).toISOString().slice(0, 10);
    // 今天还没用不算断 —— 从今天或昨天起往回数
    let cur = has.has(anchorDate) ? ms(anchorDate) : has.has(iso(ms(anchorDate) - DAY)) ? ms(anchorDate) - DAY : NaN;
    let streak = 0;
    while (Number.isFinite(cur) && has.has(iso(cur))) { streak++; cur -= DAY; }
    let longest = 0, run = 0, prev = NaN;
    for (const d of days) {
      const t = ms(d.date);
      run = t - prev === DAY ? run + 1 : 1;
      longest = Math.max(longest, run);
      prev = t;
    }
    tot.streak = streak;
    tot.longestStreak = longest;
  }

  /* 热力网格：10 列 × 7 行，列=周、行=星期几，右下角是最后一天。
     ⚠️ 基准取「数据里的最后一天」而不是服务器今天 —— 服务端不知道采集机在哪个时区，
     以数据自身为锚就完全绕开了时区问题（用户几天没用，网格右端就停在几天前，这是诚实的）。
     ⚠️ 逐格算好 col/row/level 一并下发，RCN 侧只需一层 forEach 取 ${_it.c}/${_it.r}——
     VParser 没有 floor，让渲染层去算 i/7 会算不准（「派生序列优先在数据层预计算」）。*/
  const grid = [];
  if (days.length && anchorDate) {
    const DAY = 864e5;
    const parse = (d) => Date.parse(d + 'T00:00:00Z');     // 纯日期按 UTC 解析 = 确定性，不涉时区
    const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
    const lastMs = parse(anchorDate);
    const lastWd = new Date(lastMs).getUTCDay();
    const cells = 63 + lastWd + 1;                          // 恒 10 列，末列到 lastWd 为止
    const startMs = lastMs - (cells - 1) * DAY;
    const outByDate = new Map(days.map((d) => [d.date, d.out]));
    // 相对分档（跟 GitHub 一样按本人峰值折算）：绝对阈值会让轻用户整片同色、重用户整片饱和
    const mx = days.reduce((m, d) => Math.max(m, d.out), 0);
    const th = [Math.max(mx / 14, 1), Math.max(mx / 7, 2), Math.max(mx / 3, 3)];
    for (let i = 0; i < cells; i++) {
      const ms = startMs + i * DAY;
      const o = outByDate.get(fmt(ms)) || 0;
      grid.push({
        d: fmt(ms),
        o,
        l: o <= 0 ? 0 : o >= th[2] ? 4 : o >= th[1] ? 3 : o >= th[0] ? 2 : 1,
        c: Math.floor(i / 7),
        r: new Date(ms).getUTCDay(),
      });
    }
  }

  return {
    days, models, hours, totals: tot, grid,
    gridStart: grid.length ? grid[0].d : '',
    gridEnd: grid.length ? grid[grid.length - 1].d : '',
    today: today || { date: '', msgs: 0, sessions: 0, out: 0, in: 0, cacheCreate: 0 },
    peakHour: peak ? Number(peak[0]) : -1,
    modelTop: models.length ? models[0].name : '',
    outMax: days.reduce((m, d) => Math.max(m, d.out), 0),
    ...insights(full, list, anchorDate),
  };
}

/*
 * 派生视图（2026-09-24）：周期对比 / 月度 / 费用 / 打卡图 / 工具 / token 构成 / 5 小时窗口 / 会话 / 项目。
 * 全部以 anchorDate（看的人那天；老包 = 数据最后一天）为「今天」。日期都是采集机本地日期串，
 * 只做字符串比较与 UTC 纯日期运算，绝不按服务器时区换算。
 */
function insights(full, list, anchorDate) {
  const DAY = 864e5;
  const ms = (d) => Date.parse(d + 'T00:00:00Z');
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const back = (n) => iso(ms(anchorDate) - n * DAY);
  const x0 = { rd: 0, c1: 0, th: 0, so: 0, ws: 0, wf: 0, la: 0, lr: 0, am: 0, h: {}, m: {}, t: {}, v1: false };
  const X = (d) => d.x || x0;

  /** 一段日期 [from, to]（含两端）的汇总 */
  const agg = (from, to) => {
    const a = { out: 0, msgs: 0, sessions: 0, days: 0, am: 0, la: 0, lr: 0, ws: 0, usd: 0, unpriced: 0, partial: false };
    if (!anchorDate) return a;
    for (const d of full) {
      if (d.date < from || d.date > to) continue;
      const x = X(d);
      a.out += d.out; a.msgs += d.msgs; a.sessions += d.sessions; a.days += d.out > 0 || d.msgs > 0 ? 1 : 0;
      a.am += x.am; a.la += x.la; a.lr += x.lr; a.ws += x.ws;
      const c = costOfModels(x.m);
      a.usd += c.usd + x.ws * WEB_SEARCH_USD; a.unpriced += c.unpriced;
      if (x.v1) a.partial = true;                 // 老插件推的日子：有用量、没有按模型明细，折算不了
    }
    a.usd = r2(a.usd);
    a.usdS = usdS(a.usd);
    return a;
  };
  const periods = anchorDate ? {
    today: agg(anchorDate, anchorDate),
    d7: agg(back(6), anchorDate), d7p: agg(back(13), back(7)),
    d30: agg(back(29), anchorDate), d30p: agg(back(59), back(30)),
  } : null;

  // 自然月：本月（至今）/ 上月（整月）
  let months = null;
  if (anchorDate) {
    const [y, mo] = anchorDate.split('-').map(Number);
    const first = `${anchorDate.slice(0, 7)}-01`;
    const pm = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
    const pmLast = iso(ms(first) - DAY);
    months = { cur: { ym: anchorDate.slice(0, 7), ...agg(first, anchorDate) }, prev: { ym: pm, ...agg(`${pm}-01`, pmLast) } };
  }

  // 最高的一天（按输出 token）
  let best = null;
  for (const d of full) if (!best || d.out > best.out) best = d;
  best = best && best.out > 0 ? { date: best.date, out: best.out, usd: r2(costOfModels(X(best).m).usd) } : null;

  // 一段日期里：按模型的 token 明细 / 工具次数 / token 构成
  const window3 = (from, to) => {
    const m = {}, t = {};
    const comp = { out: 0, in: 0, c5: 0, c1: 0, rd: 0, th: 0, so: 0 };
    for (const d of full) {
      if (!anchorDate || d.date < from || d.date > to) continue;
      const x = X(d);
      for (const [k, v] of Object.entries(x.m)) {
        const b = m[k] || (m[k] = { in: 0, out: 0, c5: 0, c1: 0, rd: 0, n: 0 });
        for (const f of ['in', 'out', 'c5', 'c1', 'rd', 'n']) b[f] += v[f];
      }
      for (const [k, v] of Object.entries(x.t)) t[k] = (t[k] || 0) + v;
      comp.out += d.out; comp.in += d.in; comp.c1 += x.c1; comp.c5 += Math.max(0, d.cacheCreate - x.c1);
      comp.rd += x.rd; comp.th += x.th; comp.so += x.so;
    }
    return { m, t, comp };
  };
  const byBaseUsd = (m) => {
    const r = {};
    for (const [k, v] of Object.entries(m)) {
      const c = priceOf(k, v);
      const b = r[baseModel(k)] || (r[baseModel(k)] = { usd: 0, unpriced: false, fast: 0 });
      if (c === null) b.unpriced = true; else b.usd += c;
      if (/@fast$/.test(k)) b.fast += v.out;
    }
    return r;
  };
  const ratios = (c) => {
    const inputSide = c.in + c.c5 + c.c1 + c.rd;
    return { hitRate: pct(c.rd, inputSide), thinkPct: pct(c.th, c.out), sidePct: pct(c.so, c.out) };
  };
  const cur30 = window3(anchorDate ? back(29) : '', anchorDate);
  const prev30 = window3(anchorDate ? back(59) : '', anchorDate ? back(30) : '');

  const byBase = byBaseUsd(cur30.m), byBasePrev = byBaseUsd(prev30.m);
  const costSum = Object.values(byBase).reduce((a, b) => a + b.usd, 0);
  const costModels = Object.entries(byBase).sort((a, b) => b[1].usd - a[1].usd).slice(0, 6)
    .map(([name, b]) => {
      const prev = byBasePrev[name] ? byBasePrev[name].usd : 0;
      return { name, usd: r2(b.usd), pct: pct(b.usd, costSum), unpriced: b.unpriced, fastOut: b.fast,
        prevUsd: r2(prev), chg: chg(b.usd, prev) };
    });
  const toolSum = Object.values(cur30.t).reduce((a, b) => a + b, 0);
  const tools = Object.entries(cur30.t).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([name, n]) => ({ name, n, pct: pct(n, toolSum), prev: prev30.t[name] || 0, chg: chg(n, prev30.t[name] || 0) }));
  const composition = { ...cur30.comp, ...ratios(cur30.comp) };
  const compositionPrev = ratios(prev30.comp);

  // 近 30 天逐日（连续日期，没用的日子补 0）：每日图表 + 组件迷你柱。按模型拆费用，前 4 个模型单列、其余并成 other
  const daily30 = [];
  const daily30Models = [];
  if (anchorDate) {
    const byDate = new Map(full.map((d) => [d.date, d]));
    const partsAll = {};
    for (let i = 29; i >= 0; i--) {
      const date = back(i);
      const d = byDate.get(date);
      const x = d ? X(d) : x0;
      const parts = {};
      let usd = 0;
      for (const [k, v] of Object.entries(x.m)) {
        const c = priceOf(k, v);
        if (c === null) continue;
        parts[baseModel(k)] = (parts[baseModel(k)] || 0) + c;
        usd += c;
      }
      usd += x.ws * WEB_SEARCH_USD;
      for (const [k, v] of Object.entries(parts)) partsAll[k] = (partsAll[k] || 0) + v;
      daily30.push({ d: date, usd: r2(usd), out: d ? d.out : 0, am: x.am, la: x.la, lr: x.lr, msgs: d ? d.msgs : 0,
        v1: !!x.v1, parts });
    }
    daily30Models.push(...Object.entries(partsAll).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k));
    for (const row of daily30) {
      const p = {};
      let other = 0;
      for (const [k, v] of Object.entries(row.parts)) {
        if (daily30Models.includes(k)) p[k] = r2(v); else other += v;
      }
      if (other > 0) p.other = r2(other);
      row.parts = p;
    }
  }
  // 组件的 14 天迷你柱：高度按本段峰值归一。v = 柱高占比（有用量的日子至少 0.06，看得见），u = 1 - v（柱顶的留白）；
  // 给两份是因为 RCN 坐标里写不了「常量 − 数据变量」（memory rcn-dsl-pitfalls），只能乘加
  const last14 = daily30.slice(-14);
  const mx14 = Math.max(0, ...last14.map((r) => r.usd));
  const costBars = last14.map((r, i) => {
    const v = mx14 > 0 && r.usd > 0 ? Math.max(0.06, r.usd / mx14) : 0;
    return { i, v: Math.round(v * 1000) / 1000, u: Math.round((1 - v) * 1000) / 1000, t: i === last14.length - 1 ? 1 : 0 };
  });

  // 星期 × 小时（真人发言）：index = 星期(0=周日) × 24 + 小时；近 90 天
  const punch = new Array(168).fill(0);
  for (const d of full) {
    const wd = new Date(ms(d.date)).getUTCDay();
    for (const [h, c] of Object.entries(X(d).h)) punch[wd * 24 + Number(h)] += c;
  }
  const punchMax = Math.max(0, ...punch);

  // 5 小时窗口：各设备「还没结束」的窗口里，最早开始的那个就是账号的窗口，用量相加
  const now = Date.now();
  const live = list.map((s) => s.window).filter((w) => w && w.e > now);
  let window = null;
  if (live.length) {
    const first = live.reduce((a, b) => (b.s < a.s ? b : a));
    const m = {};
    let n = 0, last = 0;
    for (const w of live) {
      n += w.n; last = Math.max(last, w.l);
      for (const [k, v] of Object.entries(w.m)) {
        const b = m[k] || (m[k] = { in: 0, out: 0, c5: 0, c1: 0, rd: 0, n: 0 });
        for (const f of ['in', 'out', 'c5', 'c1', 'rd', 'n']) b[f] += v[f];
      }
    }
    const c = costOfModels(m);
    const out = Object.values(m).reduce((a, v) => a + v.out, 0);
    const elapsed = Math.max(0, Math.min(now, first.e) - first.s);
    // 按目前的速度到窗口结束：开窗不到 20 分钟不外推（样本太少，会报出吓人的数）
    const proj = elapsed >= 20 * 60e3 ? r2(c.usd * (first.e - first.s) / elapsed) : null;
    window = { start: first.s, end: first.e, last, n, out, usd: r2(c.usd), unpriced: c.unpriced, projUsd: proj,
      usdS: usdS(r2(c.usd)), projS: proj == null ? '' : usdS(proj) };
  }

  // 会话活跃时长：各设备加权平均 / 取最长
  let sn = 0, ssum = 0, smax = 0;
  for (const s of list) {
    const ss = s.sessStats;
    if (!ss || !ss.n) continue;
    sn += ss.n; ssum += ss.avgMin * ss.n; smax = Math.max(smax, ss.maxMin);
  }
  const sessions = { n: sn, avgMin: sn ? Math.round(ssum / sn) : 0, maxMin: smax };

  // 项目：各设备的项目编号互不相通（盐按设备），直接拼起来按用量排
  // 排序与占比都按**输出** token —— 与整页的主指标同一个量；按总量（含缓存读取）排，
  // 右边显示的输出数会和排序对不上（缓存读取常是输出的数百倍，完全淹没差异）
  const projects = list.flatMap((s) => s.projects || []).sort((a, b) => b.out - a.out).slice(0, 10)
    .map((p) => ({ id: p.id, name: p.name || null, out: p.out, tok: p.tok, n: p.n, d7out: p.d7out }));
  const projOut = projects.reduce((a, p) => a + p.out, 0);
  for (const p of projects) p.pct = pct(p.out, projOut);

  // 变化值：近 7 / 30 天与上一段等长的日子比。上一段是 0 → 不给（除以 0 出来的「+∞%」没有意义）
  const deltas = periods ? Object.fromEntries(['d7', 'd30'].map((k) => {
    const a = periods[k], b = periods[k + 'p'];
    return [k, { usd: chg(a.usd, b.usd), out: chg(a.out, b.out), am: chg(a.am, b.am),
      lines: chg(a.la + a.lr, b.la + b.lr), msgs: chg(a.msgs, b.msgs) }];
  })) : null;

  return { periods, months, best, costModels, tools, composition, compositionPrev, punch, punchMax, window, sessions,
    projects, daily30, daily30Models, costBars, deltas };
}

// ─────────────────────────── 路由 ───────────────────────────
async function handle(req, env, ctx) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';

  if (p === '/health') return json({ ok: true });

  // ---- 建空间 ----
  if (p === '/space' && req.method === 'POST') {
    if (!(await allow(env, `space:${ip}`, 5))) return err('rate_limited', 429);
    const spaceId = randId();
    const writeToken = await mkToken(env, 'w', spaceId);
    const readToken = await mkToken(env, 'r', spaceId);   // 派生 → 恒定，多端 claim 拿到同一个
    const code = randCode();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO spaces(space_id, code_hash, code_exp, created_at) VALUES(?1,?2,?3,?4)`
    ).bind(spaceId, await sha256(code), now + CODE_TTL_MS, now).run();
    return json({ spaceId, writeToken, readToken, code, codeExpiresIn: CODE_TTL_MS / 1000 });
  }

  // ---- 推快照 ----
  if (p === '/ingest' && req.method === 'POST') {
    const spaceId = await verifyToken(env, 'w', bearer(req));
    if (!spaceId) return err('unauthorized', 401);
    const space = await env.DB.prepare('SELECT space_id FROM spaces WHERE space_id = ?1')
      .bind(spaceId).first();
    if (!space) return err('unauthorized', 401);
    if (!(await allow(env, `ing:${spaceId}`, 10))) return err('rate_limited', 429);

    const raw = await req.text();
    if (raw.length > MAX_BODY) return err('payload_too_large', 413);
    let body; try { body = JSON.parse(raw); } catch { return err('bad_json'); }

    const fn = SOURCES[body && body.source];
    if (!fn) return err('unknown_source');
    const clean = fn(body.snapshot);
    if (!clean) return err('bad_snapshot');

    const device = typeof body.device === 'string' && /^[a-f0-9]{4,32}$/.test(body.device)
      ? body.device : 'default';

    const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM snapshots WHERE space_id = ?1')
      .bind(space.space_id).first();
    const exists = await env.DB.prepare(
      'SELECT 1 AS x FROM snapshots WHERE space_id=?1 AND source=?2 AND device=?3'
    ).bind(space.space_id, body.source, device).first();
    if (!exists && cnt && cnt.n >= MAX_ROWS_PER_SPACE) return err('too_many_devices', 409);

    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO snapshots(space_id, source, device, payload, updated_at) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(space_id, source, device) DO UPDATE SET payload=?4, updated_at=?5`
      ).bind(space.space_id, body.source, device, JSON.stringify(clean), now),
      env.DB.prepare('UPDATE spaces SET last_push_at = ?2 WHERE space_id = ?1')
        .bind(space.space_id, now),
    ]);
    return json({ ok: true, days: clean.days.length });
  }

  // ---- 忘记一个设备 ----
  // 同一台机器换了主机名（macOS 没设 HostName 时随网络变）会在这里留下「分身」行，
  // 而读取时按天相加 → 重复计算；分身攒多了还会撞 MAX_ROWS_PER_SPACE 让推送被拒。
  // 只能删自己空间里的行（spaceId 来自令牌），要写令牌 —— 读令牌在手机上，不许它删数据。
  if (p === '/forget' && req.method === 'POST') {
    const spaceId = await verifyToken(env, 'w', bearer(req));
    if (!spaceId) return err('unauthorized', 401);
    if (!(await allow(env, `fg:${spaceId}`, 10))) return err('rate_limited', 429);
    let body; try { body = await req.json(); } catch { return err('bad_json'); }
    if (!body || !SOURCES[body.source]) return err('unknown_source');
    const device = body.device;
    if (typeof device !== 'string' || !(/^[a-f0-9]{4,32}$/.test(device) || device === 'default')) {
      return err('bad_device');
    }
    const del = await env.DB.prepare('DELETE FROM snapshots WHERE space_id=?1 AND source=?2 AND device=?3')
      .bind(spaceId, body.source, device).run();
    return json({ ok: true, removed: (del.meta && del.meta.changes) || 0 });
  }

  // ---- 重新生成短码 ----
  if (p === '/code' && req.method === 'POST') {
    const spaceId = await verifyToken(env, 'w', bearer(req));
    if (!spaceId) return err('unauthorized', 401);
    if (!(await allow(env, `code:${spaceId}`, 5))) return err('rate_limited', 429);
    const code = randCode();
    const upd = await env.DB.prepare('UPDATE spaces SET code_hash = ?2, code_exp = ?3 WHERE space_id = ?1')
      .bind(spaceId, await sha256(code), Date.now() + CODE_TTL_MS).run();
    if (upd.meta && upd.meta.changes === 0) return err('unauthorized', 401);
    return json({ code, codeExpiresIn: CODE_TTL_MS / 1000 });
  }

  // ---- 短码换读令牌 ----
  if (p === '/claim' && req.method === 'POST') {
    // ⚠️ 本服务唯一未鉴权就能打的接口 —— 不限流的话短码的熵就白算了
    if (!(await allow(env, `claim:${ip}`, 10))) return err('rate_limited', 429);
    let body; try { body = await req.json(); } catch { return err('bad_json'); }
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    if (!/^[2-9A-HJ-NP-Z]{6}$/.test(code)) return err('bad_code');
    const row = await env.DB.prepare(
      'SELECT space_id, code_exp FROM spaces WHERE code_hash = ?1'
    ).bind(await sha256(code)).first();
    if (!row) return err('bad_code', 404);
    if (!row.code_exp || row.code_exp < Date.now()) return err('code_expired', 410);
    // 短码不消耗：多端各 claim 一次拿到同一个 readToken（派生的，见 mkToken）
    return json({ readToken: await mkToken(env, 'r', row.space_id) });
  }

  // ---- 读 ----
  if (p === '/s' && req.method === 'GET') {
    const spaceId = await verifyToken(env, 'r', bearer(req));
    if (!spaceId) return err('unauthorized', 401);
    const rows = await env.DB.prepare(
      'SELECT source, device, payload, updated_at FROM snapshots WHERE space_id = ?1'
    ).bind(spaceId).all();
    const sources = {};
    let updatedAt = 0;
    for (const r of (rows.results || [])) {
      updatedAt = Math.max(updatedAt, r.updated_at || 0);
      let pl = null; try { pl = JSON.parse(r.payload); } catch { continue; }
      (sources[r.source] || (sources[r.source] = [])).push({ device: r.device, updatedAt: r.updated_at, ...pl });
    }
    // 跨设备合并：纯加法，属于数据完整性而非展示逻辑，放服务端做比在 RCN/VParser 里拼简单一个量级。
    // ?today= 只在离服务器时间 3 天以内才认 —— 各时区的「今天」都落在这个窗里，再远就是参数写错了
    const q = url.searchParams.get('today') || '';
    const anchor = DATE_RE.test(q) && Math.abs(Date.parse(q + 'T12:00:00Z') - Date.now()) < 3 * 864e5 ? q : '';
    const merged = mergeClaudeCode(sources['claude-code'] || [], anchor);
    // ?lite=1：只要合并视图（组件 / 页面用）；各设备原样快照只有 --devices 这类工具才要
    return json(url.searchParams.get('lite') === '1' ? { updatedAt, merged } : { updatedAt, merged, sources });
  }

  return err('not_found', 404);
}

export default {
  async fetch(req, env, ctx) {
    try { return await handle(req, env, ctx); }
    catch (e) { return json({ error: 'server_error', detail: String(e && e.message || e) }, 500); }
  },
  async scheduled(_evt, env) {
    // 90 天无推送回收整个空间（客户端有全量兜底，回收无损）
    const cutoff = Date.now() - KEEP_MS;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM snapshots WHERE space_id IN (SELECT space_id FROM spaces WHERE COALESCE(last_push_at, created_at) < ?1)').bind(cutoff),
      env.DB.prepare('DELETE FROM spaces WHERE COALESCE(last_push_at, created_at) < ?1').bind(cutoff),
      // ⚠️ 限流行按**天**清,不跟空间回收的 90 天 —— 窗口只有 1 分钟,一行超过那一分钟就没用了;
      //    而 key 里含 IP(`space:<ip>` / `claim:<ip>`),每个访问过的 IP 都会留一行,
      //    留 90 天就是攒 90 天的垃圾。留一天是给时钟偏移和跨天边界的余量。
      env.DB.prepare('DELETE FROM rl WHERE win < ?1').bind(Math.floor((Date.now() - 864e5) / 60000)),
    ]);
  },
};
