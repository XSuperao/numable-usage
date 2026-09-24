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
 *   GET  /s       Bearer<read>      → { updatedAt, sources }
 *   GET  /health
 */

const MAX_BODY = 64 * 1024;        // 单快照上限
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
const MODEL_RE = /^[a-zA-Z0-9._-]{1,64}$/;

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

  const t = s.totals && typeof s.totals === 'object' ? s.totals : {};
  return {
    v: 1,
    days,
    byModel,
    hours,
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

/** 多设备合并成一份（同一个人的多台机器应该看成一份用量）。 */
function mergeClaudeCode(list) {
  const dayMap = new Map(), byModel = {}, hours = {};
  const tot = { sessions: 0, msgs: 0, out: 0, in: 0, cacheCreate: 0, streak: 0, longestStreak: 0 };
  for (const s of list) {
    for (const d of s.days || []) {
      const cur = dayMap.get(d.date) || { date: d.date, msgs: 0, sessions: 0, out: 0, in: 0, cacheCreate: 0 };
      cur.msgs += d.msgs; cur.sessions += d.sessions; cur.out += d.out;
      cur.in += d.in; cur.cacheCreate += d.cacheCreate;
      dayMap.set(d.date, cur);
    }
    for (const [m, v] of Object.entries(s.byModel || {})) {
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
  const days = [...dayMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  tot.activeDays = days.length;
  // 模型按 output 降序，取前 6（卡上画不下更多，且服务端排好省得 RCN 里排）
  const totOut = Object.values(byModel).reduce((a, v) => a + v.out, 0) || 1;
  /* 短标签：卡片上画不下 `claude-haiku-4-5-20251001`。纯字符串处理，放这里省得四端各写一份。
     未知形态原样回落（宁可长一点，也不要猜错成别的模型名）。 */
  const label = (n) => {
    if (n === 'other') return 'Other';
    const m = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/.exec(n);
    if (!m) return n;
    const fam = m[1][0].toUpperCase() + m[1].slice(1);
    return `${fam} ${m[2]}${m[3] ? '.' + m[3] : ''}`;
  };
  const models = Object.entries(byModel).sort((a, b) => b[1].out - a[1].out).slice(0, 6)
    .map(([name, v]) => ({
      name, label: label(name), in: v.in, out: v.out, msgs: v.msgs,
      pct: Math.round((v.out / totOut) * 1000) / 10,
    }));
  const peak = Object.entries(hours).sort((a, b) => b[1] - a[1])[0];
  const today = days.length ? days[days.length - 1] : null;

  /* 热力网格：10 列 × 7 行，列=周、行=星期几，右下角是最后一天。
     ⚠️ 基准取「数据里的最后一天」而不是服务器今天 —— 服务端不知道采集机在哪个时区，
     以数据自身为锚就完全绕开了时区问题（用户几天没用，网格右端就停在几天前，这是诚实的）。
     ⚠️ 逐格算好 col/row/level 一并下发，RCN 侧只需一层 forEach 取 ${_it.c}/${_it.r}——
     VParser 没有 floor，让渲染层去算 i/7 会算不准（「派生序列优先在数据层预计算」）。*/
  const grid = [];
  if (days.length) {
    const DAY = 864e5;
    const parse = (d) => Date.parse(d + 'T00:00:00Z');     // 纯日期按 UTC 解析 = 确定性，不涉时区
    const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
    const lastMs = parse(today.date);
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
  };
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
    return json({ updatedAt, merged: mergeClaudeCode(sources['claude-code'] || []), sources });
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
