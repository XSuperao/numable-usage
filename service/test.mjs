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

console.log('\n── 体积与设备数上限 ──');
const big = { source: 'claude-code', device: 'aabbcc112233',
  snapshot: { days: [], byModel: {}, hours: {}, totals: {}, pad: 'x'.repeat(70000) } };
ok((await post('/ingest', big, writeToken)).s === 413, '超 64KB → 413');
ok((await post('/ingest', { source: 'nope', snapshot: {} }, writeToken)).s === 400, '未知 source → 400');

console.log(`\n${fail === 0 ? '✅' : '❌'}  pass ${pass} · fail ${fail}\n`);
process.exit(fail ? 1 : 0);
