// 采集器夹具测试：node --test test/
// 每条断言都挑「修之前会失败」的输入（重复行 / 工具结果 / 半行 / 并发），
// 否则测试绿在一条空路上。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const SCRIPT = path.join(__dirname, '..', 'plugin', 'scripts', 'collect.cjs');
const C = require(SCRIPT);

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nbu-'));
const TS = '2026-09-20T10:15:00.000Z';
const HOUR = String(new Date(TS).getHours());
const DAY = (() => { const d = new Date(TS); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();

const asst = (id, req, out, extra = {}) => ({
  type: 'assistant', timestamp: TS, sessionId: 's1', requestId: req,
  message: { id, model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  ...extra,
});
const user = (content, extra = {}) => ({ type: 'user', timestamp: TS, sessionId: 's1', message: { role: 'user', content }, ...extra });
const toolResult = () => user([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]);
const jsonl = (...rows) => rows.map((r) => JSON.stringify(r) + '\n').join('');

const run = (rows) => {
  const days = {};
  const st = { recent: [], rt: [] };
  for (const r of rows) C.absorb(days, r, st);
  C.flushAct();
  return days[DAY] || C.emptyDay();
};

test('同一响应的多行只计一次 token 与消息', () => {
  const d = run([asst('m1', 'r1', 100), asst('m1', 'r1', 100), asst('m1', 'r1', 100), asst('m2', 'r2', 7)]);
  assert.equal(d.out, 107);
  assert.equal(d.msgs, 2);
  assert.equal(d.byModel['claude-opus-5'].msgs, 2);
});

test('id 相同但 requestId 不同 = 两次响应；没有 id 的行不去重', () => {
  assert.equal(run([asst('m1', 'r1', 10), asst('m1', 'r2', 10)]).out, 20);
  assert.equal(run([asst(undefined, 'r1', 10), asst(undefined, 'r1', 10)]).out, 20);
});

test('子代理的回复计 token 不计消息', () => {
  const d = run([asst('m1', 'r1', 50, { isSidechain: true })]);
  assert.equal(d.out, 50);
  assert.equal(d.msgs, 0);
});

test('只有真人发言计入消息与活跃时段', () => {
  const d = run([
    user('帮我看看这个 bug'),                                           // ✓ 纯文本
    user([{ type: 'text', text: '看图' }, { type: 'image', source: {} }]), // ✓
    user([{ type: 'image', source: {} }]),                              // ✓ 只贴图
    user('<command-name>/model</command-name>'),                        // ✓ 斜杠命令是你敲的
    user('ok', { origin: { kind: 'human' } }),                          // ✓
    toolResult(), toolResult(), toolResult(),                           // ✗ 工具返回
    user('Caveat: ...', { isMeta: true }),                              // ✗
    user('<local-command-stdout>Set model</local-command-stdout>'),     // ✗
    user('[Request interrupted by user]'),                              // ✗
    user('<task-notification>done</task-notification>'),                // ✗ 无 origin
    user('whatever', { origin: { kind: 'task-notification' } }),        // ✗ 有 origin 以它为准
    user('summary', { isCompactSummary: true }),                        // ✗
    user('hi', { isSidechain: true }),                                  // ✗ 子代理
    user(''),                                                           // ✗ 空
  ]);
  assert.equal(d.msgs, 5);
  assert.deepEqual(d.hours, { [HOUR]: 5 });
});

test('会话仍按任意非子代理行计（含只有工具往返的会话）', () => {
  const d = run([toolResult(), { ...toolResult(), sessionId: 's2' }, { ...toolResult(), sessionId: 's3', isSidechain: true }]);
  assert.deepEqual(d.sess.sort(), ['s1', 's2']);
});

test('增量续读：同一响应跨两轮扫描仍只计一次', async () => {
  const root = tmp();
  const f = path.join(root, 'p', 'a.jsonl');
  fs.mkdirSync(path.dirname(f));
  fs.writeFileSync(f, jsonl(user('q'), asst('m1', 'r1', 100)));
  const h = C.loadHistory(path.join(root, 'none.json'));
  await C.scan(h, root);
  fs.appendFileSync(f, jsonl(asst('m1', 'r1', 100), toolResult(), asst('m1', 'r1', 100), asst('m2', 'r2', 3)));
  await C.scan(h, root);
  assert.equal(h.days[DAY].out, 103);
  assert.equal(h.days[DAY].msgs, 3);
});

test('没写完的末行不计入，等写完再计一次', async () => {
  const root = tmp();
  const f = path.join(root, 'a.jsonl');
  const line2 = JSON.stringify(user('第二句'));
  fs.writeFileSync(f, jsonl(user('第一句')) + line2.slice(0, 20));
  const h = C.loadHistory(path.join(root, 'none.json'));
  await C.scan(h, root);
  assert.equal(h.days[DAY].msgs, 1);

  // 完整 JSON 但还没有换行：仍不计（否则换行到来后这一行会被再读一遍）
  fs.writeFileSync(f, jsonl(user('第一句')) + line2);
  await C.scan(h, root);
  assert.equal(h.days[DAY].msgs, 1);

  fs.appendFileSync(f, '\n');
  await C.scan(h, root);
  assert.equal(h.days[DAY].msgs, 2);
  await C.scan(h, root);
  assert.equal(h.days[DAY].msgs, 2);
});

test('超过 64KB 的长行也能定位到行尾', async () => {
  const root = tmp();
  const f = path.join(root, 'a.jsonl');
  const big = user([{ type: 'tool_result', content: 'x'.repeat(200000) }]);
  fs.writeFileSync(f, jsonl(user('q'), big) + JSON.stringify(user('尾巴')).slice(0, 10));
  const h = C.loadHistory(path.join(root, 'none.json'));
  await C.scan(h, root);
  const size = fs.statSync(f).size;
  assert.equal(h.files[f].off, size - 10);
  assert.equal(h.days[DAY].msgs, 1);
});

test('读到旧版本历史直接丢弃（旧口径数字虚高，不与新口径混用）', () => {
  const p = path.join(tmp(), 'h.json');
  fs.writeFileSync(p, JSON.stringify({ v: 1, files: { x: { off: 5 } }, days: { [DAY]: { msgs: 999 } } }));
  const h = C.loadHistory(p);
  assert.equal(h.v, 3);
  assert.deepEqual(h.days, {});
  assert.deepEqual(h.files, {});
});

test('锁：持有期间别人拿不到；持锁进程已死则可抢', async () => {
  const lock = path.join(tmp(), 'lock');
  const release = await C.acquireLock(lock, 0);
  assert.ok(release);
  assert.equal(C.tryLock(lock), false);
  assert.equal(await C.acquireLock(lock, 300), null);
  release();
  assert.equal(C.tryLock(lock), true);
  fs.unlinkSync(lock);

  fs.writeFileSync(lock, '999999');            // 不存在的 pid
  assert.equal(C.tryLock(lock), true);
});

test('多个会话同时首次触发：只建一个空间、history 不写坏、数字不重不漏', async (t) => {
  const home = tmp();
  const state = path.join(home, 'state');
  const proj = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  for (let i = 0; i < 20; i++) {
    const rows = [];
    for (let j = 0; j < 200; j++) rows.push(user('q'), asst(`m${i}_${j}`, 'r', 10), asst(`m${i}_${j}`, 'r', 10), toolResult());
    fs.writeFileSync(path.join(proj, `s${i}.jsonl`), jsonl(...rows));
  }

  // 假服务端：数一数建了几次空间
  const calls = { space: 0, ingest: 0 };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const body = req.url === '/space'
        ? (calls.space++, { spaceId: 'sp' + calls.space, writeToken: 'w', readToken: 'r', code: 'ABCDEF' })
        : (calls.ingest++, { ok: true });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });  // 断言失败也要关，否则测试进程挂住
  const endpoint = `http://127.0.0.1:${server.address().port}`;

  const env = { ...process.env, HOME: home, NUMABLE_USAGE_STATE_DIR: state, NUMABLE_USAGE_ENDPOINT: endpoint };
  const once = () => new Promise((resolve) => spawn(process.execPath, [SCRIPT, '--run'], { env, stdio: 'ignore' }).on('exit', resolve));
  const codes = await Promise.all(Array.from({ length: 6 }, once));
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);

  assert.equal(calls.space, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'config.json'), 'utf8')).spaceId, 'sp1');
  assert.equal(calls.ingest, 1);                     // 后到的会话看到没有新内容，不再推
  const h = JSON.parse(fs.readFileSync(path.join(state, 'history.json'), 'utf8'));
  assert.equal(h.days[DAY].msgs, 20 * 200 * 2);
  assert.equal(h.days[DAY].out, 20 * 200 * 10);
  assert.deepEqual(fs.readdirSync(state).sort(), ['config.json', 'history.json']); // 无残留 tmp / lock
});

test('hook 入口立刻返回，采集在后台跑完', async (t) => {
  const home = tmp();
  const state = path.join(home, 'state');
  const proj = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ spaceId: 'x', writeToken: 'w', readToken: 'r' }));
  fs.writeFileSync(path.join(proj, 's.jsonl'), jsonl(user('q'), asst('m1', 'r1', 10), asst('m1', 'r1', 10)));

  // 推送故意慢 1.5s：前台实现下 hook 进程必然活过它
  let ingested = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => setTimeout(() => { ingested++; res.end('{"ok":true}'); }, 1500));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });  // 断言失败也要关，否则测试进程挂住
  const env = { ...process.env, HOME: home, NUMABLE_USAGE_STATE_DIR: state,
                NUMABLE_USAGE_ENDPOINT: `http://127.0.0.1:${server.address().port}` };
  delete env.NUMABLE_USAGE_DEBUG;

  // 用 pipe 而不是 ignore：'close' 要等所有持有管道的进程都放手 ——
  // 后台子进程若继承了 hook 的输出管道，这里会一直等到它跑完，正是 Claude Code 会卡住的情形
  const t0 = Date.now();
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdin.end('{"hook_event_name":"SessionStart"}');
    p.stdout.resume(); p.stderr.resume();
    p.on('close', resolve);
  });
  assert.equal(code, 0);
  assert.ok(Date.now() - t0 < 1000, `hook 用了 ${Date.now() - t0}ms`);
  assert.equal(ingested, 0);

  const until = Date.now() + 15000;
  while (ingested === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 200));        // 等它释放锁
  assert.equal(ingested, 1);
  const h = JSON.parse(fs.readFileSync(path.join(state, 'history.json'), 'utf8'));
  assert.equal(h.days[DAY].out, 10);
  assert.ok(!fs.existsSync(path.join(state, 'lock')));
});

test('设备标识首次写进 config，之后固定用它（主机名变了也不换）', async (t) => {
  const home = tmp();
  const state = path.join(home, 'state');
  const proj = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(state);
  const cfgPath = path.join(state, 'config.json');
  const f = path.join(proj, 's.jsonl');

  const seen = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { seen.push(JSON.parse(b).device); res.end('{"ok":true}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { ...process.env, HOME: home, NUMABLE_USAGE_STATE_DIR: state,
                NUMABLE_USAGE_ENDPOINT: `http://127.0.0.1:${server.address().port}` };
  const runOnce = () => new Promise((resolve) => spawn(process.execPath, [SCRIPT, '--run'], { env, stdio: 'ignore' }).on('exit', resolve));

  // 老 config 没有 device：算一次并写回
  fs.writeFileSync(cfgPath, JSON.stringify({ spaceId: 'x', writeToken: 'w', readToken: 'r' }));
  fs.writeFileSync(f, jsonl(user('a')));
  await runOnce();
  const pinned = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).device;
  assert.match(pinned, /^[a-f0-9]{12}$/);
  assert.equal(seen[0], pinned);

  // config 里已有的标识（模拟「主机名后来变了」：按主机名重算必然 ≠ 它）必须原样沿用
  fs.writeFileSync(cfgPath, JSON.stringify({ spaceId: 'x', writeToken: 'w', readToken: 'r', device: 'abc123abc123' }));
  fs.appendFileSync(f, jsonl(user('b')));
  await runOnce();
  assert.equal(seen[1], 'abc123abc123');
});

test('分身判据：重叠日会话数基本一致才算，真正的另一台电脑不算', () => {
  const local = {};
  for (let i = 1; i <= 10; i++) local[`2026-09-${String(i).padStart(2, '0')}`] = { sess: Array.from({ length: i % 4 + 1 }, (_, k) => `s${i}${k}`) };
  const days = (f) => Object.entries(local).map(([date, v]) => ({ date, sessions: f(v.sess.length) }));
  assert.equal(C.ghostOf(local, days((n) => n)).likely, true);
  // 分身停推那天只推了半天：10 天里错一天仍算
  const partial = days((n) => n); partial[9].sessions = 0;
  assert.equal(C.ghostOf(local, partial).likely, true);
  assert.equal(C.ghostOf(local, days((n) => n + 1)).likely, false);   // 另一台电脑
  assert.equal(C.ghostOf(local, days((n) => n).slice(0, 2)).likely, false); // 重叠太少不下结论
  assert.equal(C.ghostOf(local, [{ date: '2026-08-01', sessions: 3 }]).likely, false); // 没重叠
});

test('--devices 标出分身、--forget 拒删本机并只删点名的那个', async (t) => {
  const home = tmp();
  const state = path.join(home, 'state');
  fs.mkdirSync(state);
  const localDays = {};
  for (let i = 1; i <= 6; i++) localDays[`2026-09-0${i}`] = { ...C.emptyDay(), sess: Array.from({ length: i }, (_, k) => `s${i}${k}`) };
  fs.writeFileSync(path.join(state, 'history.json'), JSON.stringify({ v: 3, files: {}, days: localDays }));
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ spaceId: 'x', writeToken: 'W', readToken: 'R', device: 'aaaaaaaaaaaa' }));
  const mk = (device, f) => ({ device, updatedAt: 1, totals: { msgs: 1, out: 1 },
    days: Object.entries(localDays).map(([date, v]) => ({ date, sessions: f(v.sess.length) })) });

  const forgets = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'GET' && req.url === '/s') {
        assert.equal(req.headers.authorization, 'Bearer R');            // 列设备只用读令牌
        return res.end(JSON.stringify({ sources: { 'claude-code': [
          mk('aaaaaaaaaaaa', (n) => n), mk('bbbbbbbbbbbb', (n) => n), mk('cccccccccccc', (n) => n + 3)] } }));
      }
      if (req.method === 'POST' && req.url === '/forget') {
        forgets.push({ auth: req.headers.authorization, body: JSON.parse(b) });
        return res.end('{"ok":true,"removed":1}');
      }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { ...process.env, HOME: home, NUMABLE_USAGE_STATE_DIR: state,
                NUMABLE_USAGE_ENDPOINT: `http://127.0.0.1:${server.address().port}` };
  const cli = (...args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT, ...args], { env });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('close', () => resolve(out));
  });

  const list = await cli('--devices');
  assert.match(list, /aaaaaaaaaaaa（本机）/);
  assert.match(list, /--forget bbbbbbbbbbbb/);
  assert.doesNotMatch(list, /--forget cccccccccccc/);                   // 另一台电脑不建议删
  assert.doesNotMatch(list, /--forget aaaaaaaaaaaa/);

  assert.match(await cli('--forget', 'aaaaaaaaaaaa'), /这是本机/);
  assert.match(await cli('--forget', 'not-a-device'), /用法/);
  assert.equal(forgets.length, 0);                                       // 上面两次都不许发请求

  assert.match(await cli('--forget', 'bbbbbbbbbbbb'), /已删除设备 bbbbbbbbbbbb/);
  assert.deepEqual(forgets, [{ auth: 'Bearer W', body: { source: 'claude-code', device: 'bbbbbbbbbbbb' } }]);
});

test('<synthetic> 占位回复不计消息、不进模型分布', () => {
  const d = run([asst('m1', 'r1', 5), { ...asst('m2', 'r2', 0), message: { id: 'm2', model: '<synthetic>', usage: {} } }]);
  assert.equal(d.msgs, 1);
  assert.deepEqual(Object.keys(d.byModel), ['claude-opus-5']);
});

test('总会话数按 id 去重（跨午夜的会话只算一次）', () => {
  const days = {
    '2026-09-01': { ...C.emptyDay(), sess: ['a', 'b'] },
    '2026-09-02': { ...C.emptyDay(), sess: ['b', 'c'] },
  };
  const p = C.buildPayload({ days }, 'd');
  assert.equal(p.snapshot.totals.sessions, 3);
  assert.deepEqual(p.snapshot.days.map((d) => d.sessions), [2, 2]);  // 逐日仍是当天的会话数
});

// 起一个假服务端；handlers 按 "METHOD /path" 分派，返回 [status, body]
async function fakeServer(t, handlers) {
  const log = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const key = `${req.method} ${req.url}`;
      const entry = { key, auth: req.headers.authorization, body: b ? JSON.parse(b) : null };
      log.push(entry);
      const h = handlers[key];
      const [st, body] = h ? h(entry) : [404, {}];
      res.statusCode = st;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { log, endpoint: `http://127.0.0.1:${server.address().port}` };
}
const cliWith = (env) => (...args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [SCRIPT, ...args], { env });
  let out = '';
  p.stdout.on('data', (c) => { out += c; });
  p.stderr.resume();
  p.on('close', () => resolve(out));
});
const waitFor = async (fn, ms = 15000) => {
  const until = Date.now() + ms;
  while (!fn() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
};

test('Stop 钩子节流：10 分钟内只起一次采集；会话开始/结束不节流', async (t) => {
  const home = tmp();
  const state = path.join(home, 'state');
  const proj = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ spaceId: 'x', writeToken: 'w', readToken: 'r', device: 'abcdabcdabcd' }));
  const f = path.join(proj, 's.jsonl');
  fs.writeFileSync(f, jsonl(user('a')));
  const srv = await fakeServer(t, { 'POST /ingest': () => [200, { ok: true }] });
  const env = { ...process.env, HOME: home, NUMABLE_USAGE_STATE_DIR: state, NUMABLE_USAGE_ENDPOINT: srv.endpoint };
  delete env.NUMABLE_USAGE_DEBUG;
  const cli = cliWith(env);
  const ingests = () => srv.log.filter((x) => x.key === 'POST /ingest').length;
  const idle = () => !fs.existsSync(path.join(state, 'lock'));

  await cli('--tick');
  await waitFor(() => ingests() === 1);
  assert.equal(ingests(), 1);

  fs.appendFileSync(f, jsonl(user('b')));      // 有新内容：若真起了采集就一定会推
  await cli('--tick');
  await new Promise((r) => setTimeout(r, 1500));
  await waitFor(idle);
  assert.equal(ingests(), 1);                   // 被节流，没起

  await cli();                                  // SessionEnd：不节流
  await waitFor(() => ingests() === 2);
  assert.equal(ingests(), 2);
});

test('--link / --join：第二台电脑并进同一空间，保留自己的设备标识并清掉旧空间里的自己', async (t) => {
  const A = { spaceId: 'spaceAAAA', writeToken: 'spaceAAAA.' + 'w'.repeat(43), readToken: 'spaceAAAA.' + 'r'.repeat(43) };
  const srv = await fakeServer(t, {
    'GET /s': (e) => (e.auth === 'Bearer ' + A.readToken ? [200, { sources: {} }] : [401, { error: 'unauthorized' }]),
    'POST /forget': () => [200, { ok: true, removed: 1 }],
    'POST /ingest': () => [200, { ok: true }],
  });
  const mkEnv = (dir) => ({ ...process.env, HOME: dir, NUMABLE_USAGE_STATE_DIR: path.join(dir, 'state'), NUMABLE_USAGE_ENDPOINT: srv.endpoint });

  // 电脑 A 生成加入串
  const homeA = tmp();
  fs.mkdirSync(path.join(homeA, 'state'));
  fs.writeFileSync(path.join(homeA, 'state', 'config.json'), JSON.stringify({ ...A, endpoint: srv.endpoint }));
  const linkOut = await cliWith(mkEnv(homeA))('--link');
  const code = (linkOut.match(/nu1\.[A-Za-z0-9_-]+/) || [])[0];
  assert.ok(code, linkOut);

  // 电脑 B：原先自己有一个空间
  const homeB = tmp();
  const stB = path.join(homeB, 'state');
  fs.mkdirSync(stB);
  fs.mkdirSync(path.join(homeB, '.claude', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(homeB, '.claude', 'projects', 'p', 's.jsonl'), jsonl(user('b')));
  fs.writeFileSync(path.join(stB, 'config.json'), JSON.stringify({ spaceId: 'spaceBBBB', writeToken: 'spaceBBBB.oldw', readToken: 'spaceBBBB.oldr', device: 'bbbbbbbbbbbb' }));
  const cliB = cliWith(mkEnv(homeB));

  assert.match(await cliB('--join', 'garbage'), /这一串不对/);
  assert.equal(srv.log.length, 0);                                     // 坏串不发请求

  assert.match(await cliB('--join', code), /已加入/);
  const cfg = JSON.parse(fs.readFileSync(path.join(stB, 'config.json'), 'utf8'));
  assert.equal(cfg.spaceId, A.spaceId);
  assert.equal(cfg.writeToken, A.writeToken);
  assert.equal(cfg.device, 'bbbbbbbbbbbb');                            // 设备标识不变
  const fg = srv.log.find((x) => x.key === 'POST /forget');
  assert.deepEqual([fg.auth, fg.body], ['Bearer spaceBBBB.oldw', { source: 'claude-code', device: 'bbbbbbbbbbbb' }]);
  const ing = srv.log.find((x) => x.key === 'POST /ingest');
  assert.equal(ing.auth, 'Bearer ' + A.writeToken);                    // 立刻往新空间推了一次
  assert.equal(ing.body.device, 'bbbbbbbbbbbb');

  assert.match(await cliB('--join', code), /已经在这个空间里了/);
});

test('工具调用：逐行数（同一响应多行各带一个块），按调用 id 去重；MCP 并成 MCP、词表外并成 Other', () => {
  const tu = (id, name, extra = {}) => ({ ...asst('m1', 'r1', 5), message: { id: 'm1', model: 'claude-opus-5',
    usage: { input_tokens: 1, output_tokens: 5 }, content: [{ type: 'tool_use', id, name, input: {} }] }, ...extra });
  const d = run([tu('t1', 'Bash'), tu('t2', 'Bash'), tu('t2', 'Bash'), tu('t3', 'mcp__slack__post'), tu('t4', 'Task'), tu('t5', 'MyCustomThing')]);
  assert.deepEqual(d.tools, { Bash: 2, MCP: 1, Agent: 1, Other: 1 });
  assert.deepEqual(run([tu('a', 'TaskCreate'), tu('b', 'TodoWrite'), tu('c', 'SendMessage')]).tools, { Todo: 2, Agent: 1 });
  assert.equal(d.out, 5);                                  // 五行同一响应：token 仍只计一次
});

test('代码改动行数：补丁数 + / -，新建文件数行数，报错结果不算', () => {
  const tr = (r) => ({ ...toolResult(), toolUseResult: r });
  const d = run([
    tr({ structuredPatch: [{ lines: [' a', '-b', '+c', '+d'] }, { lines: ['-e'] }] }),
    tr({ type: 'create', content: 'x\ny\nz\n', structuredPatch: [] }),
    tr('Error: file not found'),
  ]);
  assert.deepEqual([d.la, d.lr], [5, 2]);
});

test('缓存 / 思考 / 子代理 / 联网 / 快速模式分项', () => {
  const a = (id, extra, u) => ({ ...asst(id, 'r', 0), ...extra, message: { id, model: 'claude-opus-5', usage: u } });
  const d = run([
    a('m1', {}, { input_tokens: 1, output_tokens: 100, cache_creation_input_tokens: 30, cache_read_input_tokens: 500,
      cache_creation: { ephemeral_1h_input_tokens: 10, ephemeral_5m_input_tokens: 20 },
      output_tokens_details: { thinking_tokens: 40 }, server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 } }),
    a('m2', { isSidechain: true }, { input_tokens: 0, output_tokens: 7 }),
    a('m3', {}, { input_tokens: 2, output_tokens: 9, speed: 'fast' }),
  ]);
  assert.deepEqual([d.cr, d.c1, d.rd, d.th, d.so, d.ws, d.wf], [30, 10, 500, 40, 7, 2, 1]);
  assert.deepEqual(d.byModel['claude-opus-5'], { in: 1, out: 107, c5: 20, c1: 10, rd: 500, msgs: 2 });
  assert.equal(d.byModel['claude-opus-5@fast'].out, 9);
});

test('活跃分钟：5 分钟内的空档算连续，两个会话同时开着不重复算', () => {
  const at = (hhmm, sid = 's1') => ({ ...user('x'), sessionId: sid, timestamp: new Date(`2026-09-20T${hhmm}:00`).toISOString() });
  const days = {};
  const st = { recent: [], rt: [] };
  const ext = C.loadHistory('/nonexistent');
  for (const r of [at('10:00'), at('10:03'), at('10:03', 's2'), at('10:20'), at('10:21', 's2')]) C.absorb(days, r, st, ext);
  C.flushAct();
  // 10:00–10:03 连续 4 分钟；10:20–10:21 连续 2 分钟（10:03→10:20 超过 5 分钟，断开）
  assert.equal(C.activeMinutes(days['2026-09-20'].act), 6);
  // 会话 s1：10:00→10:03 连续（+3 分钟），10:03→10:20 断开只记 1 分钟 → 1+3+1 = 5 分钟
  assert.equal(Math.round(ext.sessions.s1[2] / 60000), 5);
});

test('5 小时窗口：从整点起算、持续 5 小时；窗口过了就没有', () => {
  const now = Date.now();
  const h = C.loadHistory('/nonexistent');
  h.events = [[now - 2 * 3600e3, 'claude-opus-5', 1, 100, 0, 0, 50], [now - 60e3, 'claude-opus-5', 1, 50, 0, 0, 0]];
  const w = C.buildPayload(h, 'd').snapshot.window;
  assert.ok(w && w.s === Math.floor((now - 2 * 3600e3) / 3600e3) * 3600e3 && w.e === w.s + 5 * 3600e3);
  assert.equal(w.m['claude-opus-5'].out, 150);
  h.events = [[now - 7 * 3600e3, 'claude-opus-5', 1, 100, 0, 0, 0]];
  assert.equal(C.buildPayload(h, 'd').snapshot.window, null);
});

test('按项目：默认只有匿名编号，打开开关才带文件夹名；worktree 归回所属项目', () => {
  const days = {};
  const st = { recent: [], rt: [] };
  const ext = C.loadHistory('/nonexistent');
  C.absorb(days, { ...asst('m1', 'r', 10), cwd: '/tmp/nbu-proj-a' }, st, ext);
  C.absorb(days, { ...asst('m2', 'r', 20), cwd: '/tmp/nbu-proj-a/.claude/worktrees/feature-x' }, st, ext);
  C.absorb(days, { ...asst('m3', 'r', 5), cwd: '/tmp/nbu-proj-b' }, st, ext);
  C.flushAct();
  ext.days = days;
  const anon = C.buildPayload(ext, 'd').snapshot.projects;
  assert.equal(anon.length, 2);
  assert.ok(anon.every((p) => /^[a-f0-9]{10}$/.test(p.id) && !('name' in p)));
  assert.equal(anon[0].out, 30);                            // worktree 并进 proj-a
  assert.ok(!JSON.stringify(C.buildPayload(ext, 'd').snapshot).includes('nbu-proj'));
  const named = C.buildPayload(ext, 'd', { projectNames: true }).snapshot.projects;
  assert.deepEqual(named.map((p) => p.name), ['nbu-proj-a', 'nbu-proj-b']);
});

test('锁：对方刚建出锁文件、还没写进程号时不许抢（空内容 ≠ 持锁进程已死）', () => {
  const lock = path.join(tmp(), 'lock');
  fs.writeFileSync(lock, '');
  assert.equal(C.tryLock(lock), false);
  // 空内容且已很久没动过（对方写到一半就崩了）→ 可以抢
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  assert.equal(C.tryLock(lock), true);
});
