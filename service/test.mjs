const BASE = process.env.BASE || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.log('  ✗', m)); };
const J = async (p, o = {}) => {
  const r = await fetch(BASE + p, o);
  let j = null; try { j = await r.json(); } catch {}
  return { s: r.status, j };
};
const post = (p, body, tok) => J(p, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(tok ? { authorization: 'Bearer ' + tok } : {}) },
  body: JSON.stringify(body ?? {}),
});

console.log('\n── 建空间 ──');
const sp = await post('/space');
ok(sp.s === 200 && sp.j.spaceId && sp.j.writeToken && sp.j.readToken && sp.j.code, '返回 spaceId/write/read/code');
ok(/^[2-9A-HJ-NP-Z]{6}$/.test(sp.j.code || ''), `短码是 6 位 base32 去混淆字符 (${sp.j.code})`);
ok(sp.j.writeToken !== sp.j.readToken, 'write ≠ read');
const { spaceId, writeToken, readToken, code } = sp.j;

console.log('\n── 鉴权 ──');
ok((await post('/ingest', { source: 'claude-code', snapshot: { days: [] } })).s === 401, '无 token → 401');
ok((await post('/ingest', { source: 'claude-code', snapshot: { days: [] } }, 'garbage')).s === 401, '乱 token → 401');
ok((await post('/ingest', { source: 'claude-code', snapshot: { days: [] } }, readToken)).s === 401, '用 readToken 推 → 401（kind 隔离）');
ok((await J('/s', { headers: { authorization: 'Bearer ' + writeToken } })).s === 401, '用 writeToken 读 → 401（kind 隔离）');
ok((await post('/ingest', { source: 'claude-code', snapshot: { days: [] } }, spaceId + '.forged')).s === 401, '伪造签名 → 401');

console.log('\n── A3 schema 白名单：未知字段必须被丢弃 ──');
const dirty = {
  source: 'claude-code',
  device: 'aabbcc112233',
  snapshot: {
    v: 1,
    days: [{ date: '2026-08-20', msgs: 10, sessions: 2, out: 100, in: 5, cacheCreate: 1,
             cwd: '/Users/secret/project', gitBranch: 'feature/x', evil: 'DROP TABLE' }],
    byModel: { 'claude-opus-5': { in: 5, out: 100, msgs: 3, costUSD: 42 } },
    hours: { '19': 7, '99': 1, 'abc': 5 },
    totals: { sessions: 2, msgs: 10, out: 100, in: 5, cacheCreate: 1, activeDays: 1 },
    secretField: 'must not survive',
    conversation: 'hello world',
  },
};
ok((await post('/ingest', dirty, writeToken)).s === 200, '带脏字段的推送被接受');
const read1 = await J('/s', { headers: { authorization: 'Bearer ' + readToken } });
const blob = JSON.stringify(read1.j);
ok(read1.s === 200, 'readToken 可读');
ok(!blob.includes('secret') && !blob.includes('/Users/'), '✦ cwd / secretField 未落库');
ok(!blob.includes('gitBranch') && !blob.includes('feature/x'), '✦ gitBranch 未落库');
ok(!blob.includes('conversation') && !blob.includes('hello world'), '✦ 对话内容未落库');
ok(!blob.includes('costUSD') && !blob.includes('42'), '✦ costUSD 未落库');
ok(!blob.includes('DROP TABLE'), '✦ 注入串未落库');
const d0 = read1.j.sources['claude-code'][0];
ok(d0.days[0].date === '2026-08-20' && d0.days[0].msgs === 10, '白名单数字字段保留');
ok(d0.hours['19'] === 7 && !('99' in d0.hours) && !('abc' in d0.hours), '非法小时键被丢');

console.log('\n── A8 多设备分行 + 读取合并 ──');
await post('/ingest', { ...dirty, device: 'ddeeff445566' }, writeToken);
const read2 = await J('/s', { headers: { authorization: 'Bearer ' + readToken } });
const arr = read2.j.sources['claude-code'];
ok(arr.length === 2, `两个设备两行 (${arr.length})`);
ok(new Set(arr.map(x => x.device)).size === 2, 'device 区分正确');

console.log('\n── A9 短码多端 claim → 同一 readToken ──');
const c1 = await post('/claim', { code });
const c2 = await post('/claim', { code: code.toLowerCase() });
ok(c1.s === 200 && c1.j.readToken === readToken, '第一次 claim 得到同一 readToken');
ok(c2.s === 200 && c2.j.readToken === readToken, '✦ 第二次 claim 仍可用（多端各接一次）且同值');
ok((await post('/claim', { code: 'ZZZZZZ' })).s === 404, '错码 → 404');
ok((await post('/claim', { code: '111111' })).s === 400, '含混淆字符的码 → 400');

console.log('\n── /code 重新生成 ──');
const nc = await post('/code', {}, writeToken);
ok(nc.s === 200 && /^[2-9A-HJ-NP-Z]{6}$/.test(nc.j.code), '生成新短码');
ok((await post('/claim', { code: nc.j.code })).j.readToken === readToken, '新码换到同一 readToken');
ok((await post('/claim', { code })).s === 404, '✦ 旧码立即失效');

console.log('\n── A10 /claim 暴破限流 ──');
let limited = false;
for (let i = 0; i < 22; i++) {
  const r = await post('/claim', { code: 'ABCDEF' });
  if (r.s === 429) { limited = true; break; }
}
ok(limited, '连续错码被 429 限流');

console.log('\n── /forget 忘记设备 ──');
const fg = (body, tok) => post('/forget', body, tok);
ok((await fg({ source: 'claude-code', device: 'ddeeff445566' })).s === 401, '无 token → 401');
ok((await fg({ source: 'claude-code', device: 'ddeeff445566' }, readToken)).s === 401, '✦ readToken 不能删（手机上那枚只许读）');
ok((await fg({ source: 'nope', device: 'ddeeff445566' }, writeToken)).s === 400, '未知 source → 400');
ok((await fg({ source: 'claude-code', device: "x' OR 1=1 --" }, writeToken)).s === 400, '非法 device → 400');
// 别人的空间删不到这边：用另一个空间的 writeToken 删同名设备
const other = await post('/space');
const cross = await fg({ source: 'claude-code', device: 'ddeeff445566' }, other.j.writeToken);
ok(cross.s === 200 && cross.j.removed === 0, '✦ 别的空间的 writeToken 删不到本空间的行');
ok((await J('/s', { headers: { authorization: 'Bearer ' + readToken } })).j.sources['claude-code'].length === 2, '跨空间删除后本空间仍是两行');
const rm = await fg({ source: 'claude-code', device: 'ddeeff445566' }, writeToken);
ok(rm.s === 200 && rm.j.removed === 1, `删掉一行 (removed=${rm.j && rm.j.removed})`);
const read3 = await J('/s', { headers: { authorization: 'Bearer ' + readToken } });
const arr3 = read3.j.sources['claude-code'];
ok(arr3.length === 1 && arr3[0].device === 'aabbcc112233', '✦ 只删了指定设备，另一台还在');
ok(read3.j.merged.totals.msgs === 10, `✦ 合并结果不再含被删设备 (msgs=${read3.j.merged.totals.msgs})`);
ok((await fg({ source: 'claude-code', device: 'ddeeff445566' }, writeToken)).j.removed === 0, '再删一次 → removed=0（幂等）');

console.log('\n── ?today= 以看的人那天为锚 ──');
{
  const iso = (off) => new Date(Date.now() + off * 864e5).toISOString().slice(0, 10);
  const D0 = iso(0);
  const sp2 = await post('/space');
  const W2 = sp2.j.writeToken, R2 = sp2.j.readToken;
  const day = (date, extra = {}) => ({ date, msgs: 10, sessions: 1, out: 100, in: 1, cacheCreate: 0, ...extra });
  // 两台电脑轮流用：一台 D-3、D-1，另一台 D-2 —— 各自的连续天数都是 1
  await post('/ingest', { source: 'claude-code', device: 'aaaa0001', snapshot: {
    days: [day(iso(-3)), day(iso(-1))],
    byModel: { 'claude-opus-4-20250514': { in: 1, out: 100, msgs: 1 }, other: { in: 0, out: 0, msgs: 5 } },
    totals: { streak: 1, longestStreak: 1 } } }, W2);
  await post('/ingest', { source: 'claude-code', device: 'aaaa0002', snapshot: {
    days: [day(iso(-2))], totals: { streak: 1, longestStreak: 1 } } }, W2);
  const rd = (q) => J('/s' + q, { headers: { authorization: 'Bearer ' + R2 } });

  const a = (await rd('?today=' + D0)).j.merged;
  ok(a.today.date === D0 && a.today.msgs === 0, `✦ 今天没用 → today 是今天且为 0（${a.today.date} / ${a.today.msgs}）`);
  ok(a.gridEnd === D0, `✦ 热力网格右下角是今天（${a.gridEnd}）`);
  ok(a.totals.streak === 3, `✦ 两台电脑轮流用，连续天数按合并日期算 = 3（${a.totals.streak}）`);
  ok(a.totals.longestStreak === 3, `最长连续 = 3（${a.totals.longestStreak}）`);
  ok(a.models.length === 1 && a.models[0].label === 'Opus 4', `✦ 带发布日期的模型名标成「Opus 4」，零用量的 other 不列（${JSON.stringify(a.models.map((m) => m.label))}）`);

  const b = (await rd('')).j.merged;
  ok(b.today.date === iso(-1) && b.today.msgs === 10, '不带 ?today（老版本的包）→ 维持原行为：today = 数据里最后一天');
  ok(b.totals.streak === 1, '不带 ?today → 连续天数维持原行为（各设备取最大）');
  ok((await rd('?today=' + iso(-1))).j.merged.today.msgs === 10, '今天用过 → today 就是那天的数');
  ok((await rd('?today=2020-01-01')).j.merged.today.date === iso(-1), '离服务器时间太远的 ?today 不认');
  ok((await rd('?today=' + iso(-2))).j.merged.today.date === iso(-1), '看的人时区靠后（锚早于数据最后一天）→ 以数据为准');
  const e = (await rd('?today=' + iso(2))).j.merged;
  ok(e.totals.streak === 0 && e.today.msgs === 0, '隔了一天没用 → 连续天数归 0');
}

console.log('\n── v2 快照：费用 / 周期 / 打卡 / 工具 / 构成 / 窗口 / 项目 ──');
{
  const iso = (off) => new Date(Date.now() + off * 864e5).toISOString().slice(0, 10);
  const D0 = iso(0);
  const sp3 = await post('/space');
  const W3 = sp3.j.writeToken, R3 = sp3.j.readToken;
  const M = (o) => ({ in: 0, out: 0, c5: 0, c1: 0, rd: 0, n: 1, ...o });
  const now = Date.now();
  const snap = {
    v: 2,
    days: [
      { date: D0, msgs: 5, sessions: 1, out: 200000, in: 2000000, cacheCreate: 0, rd: 2000000, ws: 3, la: 40, lr: 7, am: 95,
        th: 50000, so: 20000, h: { '9': 3, '24': 9, x: 1 }, t: { Bash: 5, Edit: 2, 'bad name!': 9 },
        m: { 'claude-opus-5': M({ in: 1e6, out: 1e5, rd: 1e6 }), 'claude-opus-5@fast': M({ in: 1e6, out: 1e5, rd: 1e6 }),
             'claude-foo-9': M({ out: 7 }) } },
      { date: iso(-8), msgs: 1, sessions: 1, out: 1000, in: 0, cacheCreate: 0 },   // 老插件推的一天：没有 m
    ],
    window: { s: now - 30 * 60e3, e: now + 270 * 60e3, l: now - 60e3, n: 4, m: { 'claude-opus-5': M({ out: 1e5 }) } },
    sessStats: { n: 4, avgMin: 30, maxMin: 90 },
    projects: [{ id: 'abcdef1234', name: 'my\u0007app', out: 10, tok: 100, n: 1, d7out: 10, d7tok: 100 },
               { id: 'NOT-HEX', out: 99, tok: 999, n: 1 }],
  };
  const ing = await post('/ingest', { source: 'claude-code', device: 'cccc0001', snapshot: snap }, W3);
  ok(ing.s === 200, 'v2 快照被接受');
  const r = await J(`/s?today=${D0}&lite=1`, { headers: { authorization: 'Bearer ' + R3 } });
  const m = r.j.merged;
  ok(r.s === 200 && !('sources' in r.j), '✦ ?lite=1 不带各设备原样快照');
  ok(m.periods.today.usd === 24.03, `✦ 今天费用 = $8（Opus 5）+ $16（快速模式翻倍）+ $0.03（3 次搜索）= 24.03（${m.periods.today.usd}）`);
  ok(m.periods.today.unpriced === 7, `表外模型不猜价，记为未计价 token（${m.periods.today.unpriced}）`);
  ok(m.periods.d30.partial === true && m.periods.today.partial === false, '✦ 老插件推的日子标 partial（折算不了），新的不标');
  ok(m.periods.today.la === 40 && m.periods.today.am === 95, '改动行数 / 活跃分钟进周期汇总');
  ok(m.costModels[0].name === 'claude-opus-5' && m.costModels[0].usd === 24 && m.costModels[0].fastOut === 1e5,
    `✦ 按模型费用把快速模式并回同一模型（${JSON.stringify(m.costModels[0])}）`);
  ok(m.models.every((x) => !/@fast/.test(x.name)), '模型分布里没有 @fast 行');
  ok(JSON.stringify(m.tools.map(({ name, n, pct }) => ({ name, n, pct }))) === JSON.stringify([{ name: 'Bash', n: 5, pct: 71.4 }, { name: 'Edit', n: 2, pct: 28.6 }]),
    `✦ 工具排行（非法工具名被白名单丢掉）${JSON.stringify(m.tools)}`);
  const wd = new Date(D0 + 'T00:00:00Z').getUTCDay();
  ok(m.punch.length === 168 && m.punch[wd * 24 + 9] === 3 && m.punchMax === 3, '✦ 打卡图按日期推星期几，非法小时键被丢');
  ok(m.composition.hitRate === 50 && m.composition.thinkPct === 24.9, `token 构成：命中率 50%、思考占 24.9%（50000 / 201000）（${m.composition.hitRate} / ${m.composition.thinkPct}）`);
  ok(m.window && m.window.usd === 2.5 && m.window.projUsd >= 24.9 && m.window.projUsd <= 25, `✦ 5 小时窗口：已用 $2.5，开窗 30 分钟按速外推 $25（${JSON.stringify(m.window)}）`);
  ok(m.sessions.avgMin === 30 && m.sessions.maxMin === 90, '会话时长');
  ok(m.periods.today.usdS === '$24.03' && m.window.usdS === '$2.50' && m.periods.d7p.usdS === '$0', `美元显示串（${m.periods.today.usdS} / ${m.window.usdS} / ${m.periods.d7p.usdS}）`);
  ok(m.projects.length === 1 && m.projects[0].name === 'myapp', `✦ 项目：非法编号丢弃、名字去控制字符（${JSON.stringify(m.projects)}）`);
  ok(m.days.every((d) => !('x' in d)) && !('x' in m.today), '内部明细不下发到 days / today');
  const dd = m.days.find((d) => d.date === D0), od = m.days.find((d) => d.date === iso(-8));
  ok(dd.usd === 24.03 && dd.am === 95 && dd.la === 40 && od.usd === null, `✦ 逐日带费用 / 活跃 / 改动，老插件那天费用为 null（${dd.usd} / ${od.usd}）`);
  const old = (await J('/s', { headers: { authorization: 'Bearer ' + R3 } })).j;
  ok(Array.isArray(old.sources['claude-code']) && old.merged.today.date === D0, '不带 lite / today 的老调用照旧');
}

console.log('\n── 图表数据：逐日序列 / 迷你柱 / 变化值 ──');
{
  const iso = (off) => new Date(Date.now() + off * 864e5).toISOString().slice(0, 10);
  const D0 = iso(0);
  const sp4 = await post('/space');
  const W4 = sp4.j.writeToken, R4 = sp4.j.readToken;
  const M = (o) => ({ in: 0, out: 0, c5: 0, c1: 0, rd: 0, n: 1, ...o });
  const day = (date, m, extra = {}) => ({ date, msgs: 1, sessions: 1, out: 1, in: 0, cacheCreate: 0, m, t: {}, h: {}, ...extra });
  await post('/ingest', { source: 'claude-code', device: 'dddd0001', snapshot: { v: 2, days: [
    day(iso(-9), { 'claude-opus-5': M({ out: 1e5 }) }, { t: { Bash: 4 }, la: 10 }),         // 上一段：$2.5
    day(iso(-2), { 'claude-opus-5': M({ out: 2e5 }), 'claude-sonnet-5': M({ out: 1e5 }) }), // $5 + $1
    day(D0, { 'claude-opus-5': M({ out: 1e5 }) }, { t: { Bash: 6 }, la: 30 }),              // $2.5
  ] } }, W4);
  const m = (await J(`/s?today=${D0}&lite=1`, { headers: { authorization: 'Bearer ' + R4 } })).j.merged;
  ok(m.daily30.length === 30 && m.daily30[29].d === D0 && m.daily30[0].d === iso(-29), '✦ 逐日序列：连续 30 天，最后一天是今天');
  ok(m.daily30[28].usd === 0 && m.daily30[27].usd === 6, '没用的日子补 0；按天费用正确');
  ok(JSON.stringify(m.daily30[27].parts) === JSON.stringify({ 'claude-opus-5': 5, 'claude-sonnet-5': 1 }), `✦ 按模型拆费用（${JSON.stringify(m.daily30[27].parts)}）`);
  ok(m.daily30Models[0] === 'claude-opus-5', '模型顺序按 30 天费用');
  const cb = m.costBars;
  ok(cb.length === 14 && cb[13].t === 1 && cb[11].v === 1 && cb[11].u === 0 && cb[13].v === 0.417 && cb[12].v === 0,
    `✦ 迷你柱：14 根、峰值归一、今天标记、没用的日子高 0（${JSON.stringify(cb.slice(11))}）`);
  ok(m.deltas.d7.usd.s === '↑240%' && m.deltas.d7.usd.p === 240, `✦ 近 7 天费用 vs 前 7 天：8.5 vs 2.5 = ↑240%（${JSON.stringify(m.deltas.d7.usd)}）`);
  ok(m.deltas.d7.lines.s === '↑200%', `改动行变化（${m.deltas.d7.lines.s}）`);
  ok(m.deltas.d30.usd.s === '' && m.deltas.d30.usd.p === null, '✦ 上一段为 0 → 不给变化值（不出 +∞%）');
  const bash = m.tools.find((t) => t.name === 'Bash');
  ok(bash.n === 10 && bash.prev === 0, `工具带上一段次数（近 30 天 4+6=10，上一段 0）`);
  ok(m.compositionPrev && 'hitRate' in m.compositionPrev, '上一段的 token 构成');

  // 组件视图 w（2026-09-24）：一切都已是能直接画的样子
  const w = m.w;
  ok(w && w.trend && w.per && w.streak && w.punch && w.tools, '✦ 组件视图 w 存在');
  ok(w.trend.d7C === '↑3.4×' && w.trend.d7U === 1, `✦ 变化超过 +200% 改说倍数（${w.trend.d7C}）`);
  ok(w.per.r1.usdC === '↑3.4×' && w.per.r0.usdC === '' && w.per.r0.usdU === 2, '周期表：今天那行不给变化，方向 2 = 不画');
  const s27 = w.trend.segs.filter((x) => x.i === 27);
  ok(s27.length === 2 && s27[0].c === '#2a78d6|#3987e5' && Math.abs(s27[0].h + s27[1].h + s27[1].u - 1) < 0.002,
    `✦ 趋势堆叠：两段、Opus 5 钉第一槽、顶段 u = 1 − 累计高（${JSON.stringify(s27)}）`);
  ok(w.trend.maxS === '$6' && w.trend.segs.every((x) => x.u >= -0.001 && x.u <= 1), `纵轴顶按档位取整（${w.trend.maxS}）`);
  ok(w.streak.dots.length === 14 && w.streak.dots[13].on === 1 && w.streak.dots[12].on === 0 && w.streak.dots[11].on === 1,
    `✦ 打卡点阵：近 14 天，今天在最右（${w.streak.dots.map((d) => d.on).join('')}）`);
  ok(w.punch.cells.length === 168 && w.punch.cells.every((c) => c.l >= 0 && c.l <= 4), '打卡图 168 格、五档');
  ok(w.lines.add === '30' && w.lines.bars.length === 7 && w.lines.bars[6].t === 1, '代码改动：今天新增 + 7 根迷你柱');
  ok(w.tools[0].nz === 'Bash' && w.tools[0].v === 1 && w.tools[0].u === 2, '工具排行：首位满条、上一段为 0 不给方向');
  ok(w.vsAvg.fill >= 0 && w.vsAvg.fill <= 1 && w.vsAvg.mk >= 0 && w.vsAvg.mk <= 1, '今天 vs 日均：比例都在 0~1');
  ok(m.daily30[29].t.Bash === 6 && m.daily30[20].t.Bash === 4 && Object.keys(m.daily30[28].t).length === 0, '✦ 逐日带各工具调用次数（工具详情页用）');
  ok(m.composition.cost && m.composition.cost.out === 11 && m.composition.cost.saved === 0, `✦ 按 token 类别拆费用：输出 Opus 4e5 × $25/M + Sonnet 1e5 × $10/M = $11（${JSON.stringify(m.composition.cost)}）`);
}

console.log('\n── 体积与设备数上限 ──');
const big = { source: 'claude-code', device: 'aabbcc112233',
  snapshot: { days: [], byModel: {}, hours: {}, totals: {}, pad: 'x'.repeat(270000) } };
ok((await post('/ingest', big, writeToken)).s === 413, '超 256KB → 413');
ok((await post('/ingest', { source: 'nope', snapshot: {} }, writeToken)).s === 400, '未知 source → 400');

console.log(`\n${fail === 0 ? '✅' : '❌'}  pass ${pass} · fail ${fail}\n`);
process.exit(fail ? 1 : 0);
