// RooMi 설명 검증 뒤늦은 업그레이드 — 통합 테스트 (v1.83)
//   실행: node --experimental-sqlite tests/teach-upgrade.mjs   (regression 과 같이 npm test 에 포함)
//   LLM 은 tests/fixtures/llm-stub.cjs 가 흉내 낸다(실제 모델을 부르지 않는다). 모드는 파일로 바꾼다.
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3990 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = `${process.pid}-${Date.now()}`;
const DB_FILE = path.join(os.tmpdir(), `roomi-upgrade-${TAG}.db`);
const MODE_FILE = path.join(os.tmpdir(), `roomi-upgrade-mode-${TAG}.txt`);
const LOG_FILE = path.join(os.tmpdir(), `roomi-upgrade-log-${TAG}.jsonl`);
const CONCEPT = '분수의 덧셈';
const CORRECT = '분모가 같으면 분자끼리 더하면 돼요';
const WRONG = '분모가 클수록 더 큰 수야';

const env = {
  ...process.env,
  PORT: String(PORT), DB_PATH: DB_FILE, ADMIN_KEY: 'test-admin',
  ROOMI_TEST_NO_LLM: '1',                                  // 실제 LLM 은 어떤 경로로도 호출되지 않게
  ROOMI_TEST_LLM_STUB: path.join(ROOT, 'tests/fixtures/llm-stub.cjs'),
  STUB_MODE_FILE: MODE_FILE, STUB_LOG: LOG_FILE, STUB_DELAY_MS: '50',
  TEACH_VERIFY_TIMEOUT_MS: '10',      // 동기 판정은 50ms 스텁보다 먼저 끝나지 않게 → 시간 초과 경로
  TEACH_UPGRADE_TIMEOUT_MS: '300',    // 뒤늦은 업그레이드는 충분히 기다린다
  TEACH_UPGRADE_BACKOFF_MS: '30',     // 재시도 간격 30ms, 120ms
};
const server = spawn(process.execPath, ['--experimental-sqlite', 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log('  PASS  ' + name); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.log('  FAIL  ' + name + '\n        → ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(40); }
  return false;
}
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Token': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
const db = () => new DatabaseSync(DB_FILE);
let seq = 0;
async function newUser(tag) {
  const nickname = `up_${tag}_${Date.now().toString(36).slice(-5)}${seq++}`.slice(0, 20);
  const r = await api('/api/user', { method: 'POST', body: { nickname } });
  return { id: r.data.user.id, token: r.data.user.token };
}
function setMode(m) { fs.writeFileSync(MODE_FILE, m); }
function stubCallsFor(expl) {
  if (!fs.existsSync(LOG_FILE)) return 0;
  return fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((x) => x.expl === expl).length;
}
function memoryOf(uid) {
  const d = db();
  const r = d.prepare("SELECT value, source, confidence FROM user_memories WHERE user_id=? AND kind='taught'").get(uid);
  d.close();
  return r || null;
}
function masteryOf(uid) {
  const d = db();
  const r = d.prepare('SELECT score, attempts FROM concept_mastery WHERE user_id=? AND topic=?').get(uid, CONCEPT);
  d.close();
  return r || null;
}

async function waitServer() {
  for (let i = 0; i < 200; i++) { try { await fetch(BASE + "/"); return; } catch {} await sleep(150); }
  throw new Error('서버가 뜨지 않았어요:\n' + serverLog);
}

(async () => {
  let code = 0;
  try {
    setMode('ok-slow');
    await waitServer();
    console.log(`업그레이드 통합 테스트 · ${BASE}`);

    await test('성공 경로: 시간 초과로 미검증 저장 → 뒤늦게 LLM 이 맞다고 하면 검증으로 승격 + 마스터리 1회', async () => {
      setMode('ok-slow');
      const u = await newUser('s1');
      const r = await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: CORRECT } });
      assert(r.status === 200, `explain 실패 ${r.status}`);
      const first = memoryOf(u.id);
      assert(first && first.source === 'explain:unverified', `응답 직후에는 미검증이어야 함: ${first && first.source}`);
      const ok = await waitFor(async () => memoryOf(u.id).source === 'explain:verified');
      assert(ok, '뒤늦은 업그레이드가 검증으로 승격하지 않았다');
      const m = masteryOf(u.id);
      assert(m && Math.abs(m.score - 0.4) < 0.001 && m.attempts === 1, `마스터리 1회(0.40)여야 함: ${JSON.stringify(m)}`);
    });

    await test('동시성·멱등: 같은 설명을 연달아 두 번 보내도 마스터리는 한 번만 오른다(0.40)', async () => {
      setMode('ok-slow');
      const u = await newUser('s2');
      // 두 요청을 동시에 보낸다 → 두 개의 업그레이드 예약이 거의 같은 순간에 일어난다
      await Promise.all([1, 2].map(() => api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: CORRECT } })));
      const ok = await waitFor(async () => memoryOf(u.id).source === 'explain:verified');
      assert(ok, '승격되지 않았다');
      await sleep(400);   // 두 번째 업그레이드가 있다면 끝날 시간을 준다
      const m = masteryOf(u.id);
      assert(m && Math.abs(m.score - 0.4) < 0.001 && m.attempts === 1, `중복 가점 발생: ${JSON.stringify(m)}`);
    });

    await test('거절 경로: LLM 이 틀렸다고 하면 미검증 유지, 마스터리 없음, 재시도 없음', async () => {
      setMode('no-slow');
      const u = await newUser('s3');
      await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: WRONG } });
      await sleep(700);
      const mem = memoryOf(u.id);
      assert(mem && mem.source === 'explain:unverified', `미검증이어야 함: ${mem && mem.source}`);
      assert(masteryOf(u.id) === null, '거절된 설명에 마스터리가 생겼다');
      const calls = stubCallsFor(WRONG);
      assert(calls === 2, `동기 1회 + 업그레이드 1회여야 함(거절은 재시도하지 않음): ${calls}`);
    });

    await test('재시도 한도: LLM 이 응답하지 않으면 업그레이드는 최대 3회 시도하고 멈춘다', async () => {
      setMode('hang');
      const u = await newUser('s4');
      const text = '분모가 같으면 같은 칸끼리 더해';
      await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text } });
      const reached = await waitFor(async () => stubCallsFor(text) >= 4, 6000);
      assert(reached, `업그레이드 시도가 4회(동기 1 + 재시도 3)에 닿지 않았다: ${stubCallsFor(text)}`);
      await sleep(900);
      const calls = stubCallsFor(text);
      assert(calls === 4, `한도(3회)를 넘어 재시도했다: 총 ${calls}회 호출`);
      const mem = memoryOf(u.id);
      assert(mem && mem.source === 'explain:unverified', '판정이 없으면 미검증으로 남아야 함');
      assert(masteryOf(u.id) === null, '판정이 없는데 마스터리가 생겼다');
    });

    await test('보호: 이미 검증된 기억은 나중의 미검증 설명으로 내려가지 않는다', async () => {
      setMode('ok-slow');
      const u = await newUser('s5');
      await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: CORRECT } });
      const ok = await waitFor(async () => memoryOf(u.id).source === 'explain:verified');
      assert(ok, '먼저 검증되어야 한다');
      setMode('no-slow');
      await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: WRONG } });
      await sleep(700);
      const mem = memoryOf(u.id);
      assert(mem.source === 'explain:verified' && mem.value === CORRECT, `검증된 기억이 덮어써졌다: ${mem.source} / ${mem.value}`);
      const m = masteryOf(u.id);
      assert(m && Math.abs(m.score - 0.4) < 0.001, `마스터리가 바뀌었다: ${JSON.stringify(m)}`);
    });
  } catch (e) {
    console.log('\n[실행 오류] ' + e.message);
    code = 1;
  } finally {
    server.kill('SIGTERM');
    const failed = results.filter((r) => !r.ok);
    console.log(`\n업그레이드 통합: ${results.length - failed.length} PASS / ${failed.length} FAIL`);
    for (const f of failed) console.log(' - ' + f.name + ' :: ' + f.err);
    for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm', MODE_FILE, LOG_FILE]) { try { fs.unlinkSync(f); } catch {} }
    if (failed.length) code = 1;
    process.exitCode = code;
  }
})();
