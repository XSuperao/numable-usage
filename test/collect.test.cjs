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
  const recent = [];
  for (const r of rows) C.absorb(days, r, recent);
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

test('读到 v1 历史直接丢弃（旧口径数字虚高，不与新口径混用）', () => {
  const p = path.join(tmp(), 'h.json');
  fs.writeFileSync(p, JSON.stringify({ v: 1, files: { x: { off: 5 } }, days: { [DAY]: { msgs: 999 } } }));
  const h = C.loadHistory(p);
  assert.equal(h.v, 2);
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
