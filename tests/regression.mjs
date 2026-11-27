// RooMi 학습 루프 회귀 테스트 (v1.81)
//   실행: node tests/regression.mjs   (또는 npm test)
//   · 임시 DB 에 서버를 띄운다(DB_PATH=임시 파일). ROOMI_TEST_NO_LLM=1 → LLM 을 절대 부르지 않는다(규칙 폴백만).
//   · 실패가 하나라도 있으면 종료 코드 1.
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `roomi-regression-${process.pid}-${Date.now()}.db`);
const CONCEPT = '분수의 덧셈';   // knowledge_cards 에 있는 실제 개념명

// ---------- 서버 기동 ----------
const env = { ...process.env, PORT: String(PORT), DB_PATH: DB_FILE, ROOMI_TEST_NO_LLM: '1', ADMIN_KEY: 'test-admin' };
const nodeBin = process.execPath;
const server = spawn(nodeBin, ['--experimental-sqlite', 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/'); if (r.status) return; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('서버가 뜨지 않았어요:\n' + serverLog);
}

// ---------- 헬퍼 ----------
const db = () => new DatabaseSync(DB_FILE);
const kstDay = (offset = 0) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' })
  .format(new Date(Date.now() + offset * 86400000));
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
let seq = 0;
async function newUser(tag) {
  const nickname = `t_${tag}_${Date.now().toString(36)}_${seq++}`;
  const r = await api('/api/user', { method: 'POST', body: { nickname } });
  return { id: r.data.user.id, token: r.data.user.token, nickname };
}
// 학습 세션을 원하는 상태로 맞춘다(같은 날 learn 세션 행이 없으면 만든다)
function setLearnSession(uid, { stage = 'L1', stageTurns = 0, turns = 0, concept = CONCEPT } = {}) {
  const d = db();
  d.prepare("INSERT OR IGNORE INTO chat_sessions(user_id,day,mode) VALUES(?,?,?)").run(uid, kstDay(), 'learn');
  d.prepare("UPDATE chat_sessions SET stage=?, stage_turns=?, turns=?, concept=? WHERE user_id=? AND day=? AND mode='learn'")
    .run(stage, stageTurns, turns, concept, uid, kstDay());
  d.close();
}
function shiftLamp(uid, topic, days) {
  const d = db();
  d.prepare("UPDATE memory_lamps SET lit_day=date(lit_day, ?) WHERE user_id=? AND topic=?").run(`-${days} day`, uid, topic);
  d.close();
}
function lampRow(uid, topic) {
  const d = db();
  const r = d.prepare('SELECT * FROM memory_lamps WHERE user_id=? AND topic=?').get(uid, topic);
  d.close();
  return r;
}

// ---------- 테스트 러너 ----------
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, ok: true }); console.log('  PASS  ' + name); }
  catch (e) { results.push({ name, ok: false, err: e.message }); console.log('  FAIL  ' + name + '\n        → ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ============================================================
// 버그 1 — 간격 반복 재점등으로만 수정 구슬이 생긴다
// ============================================================
async function bug1() {
  await test('버그1: 서로 다른 날 3번 가르치면 reinforce 가 3 이 되고 수정 구슬이 된다', async () => {
    const u = await newUser('b1');
    const text = '분모가 같으면 분자끼리 더하면 돼요';
    for (let i = 0; i < 3; i++) {
      const r = await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text } });
      assert(r.status === 200, `explain 실패 ${r.status}`);
      if (i < 2) shiftLamp(u.id, CONCEPT, 1);   // 하루 지난 것처럼 lit_day 를 어제로
    }
    const row = lampRow(u.id, CONCEPT);
    assert(row, '등불이 없음');
    assert(row.reinforce === 3, `reinforce 기대 3, 실제 ${row.reinforce}`);
    assert(row.crystal === 1, `crystal 기대 1, 실제 ${row.crystal}`);
  });
  await test('버그1: 같은 날 3번 가르치면 reinforce 는 1 에 머물고 수정 구슬이 생기지 않는다', async () => {
    const u = await newUser('b1s');
    for (let i = 0; i < 3; i++) {
      await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: '분모가 같으면 분자끼리 더하면 돼요' } });
    }
    const row = lampRow(u.id, CONCEPT);
    assert(row.reinforce === 1, `reinforce 기대 1, 실제 ${row.reinforce}`);
    assert(row.crystal === 0, `같은 날 3번에 crystal 이 생기면 안 된다(실제 ${row.crystal})`);
  });
}

// ============================================================
// 버그 2 — «맞아?» 와 «못 풀었어» 는 이해 확인이 아니다
// ============================================================
async function bug2() {
  const stageAfter = async (msg) => {
    const u = await newUser('b2');
    setLearnSession(u.id, { stage: 'L2', stageTurns: 2, turns: 2 });
    const r = await api('/api/chat', { method: 'POST', token: u.token, body: { mode: 'learn', message: msg, style: 'auto' } });
    assert(r.status === 200, `chat 실패 ${r.status}`);
    return r.data.session && r.data.session.stage;
  };
  await test('버그2: «1/2+1/3=2/5 이거 맞아?» 는 confirm 으로 넘어가지 않는다', async () => {
    const st = await stageAfter('1/2+1/3=2/5 이거 맞아?');
    assert(st !== 'confirm', `질문형이 confirm 으로 넘어감(stage=${st})`);
  });
  await test('버그2: «못 풀었어» 는 confirm(다 했음) 으로 세지 않는다', async () => {
    const st = await stageAfter('못 풀었어');
    assert(st !== 'confirm', `부정형이 confirm 으로 넘어감(stage=${st})`);
  });
  await test('버그2 대조: «알겠어 이제 알겠다» 는 여전히 confirm 이다', async () => {
    const st = await stageAfter('알겠어 이제 알겠다');
    assert(st === 'confirm', `긍정 확인이 confirm 이 아님(stage=${st})`);
  });
}

// ============================================================
// 버그 3 — 「내가 해봤어요」 는 주간 토픽이 아니라 실제 개념에 귀속
// ============================================================
async function bug3() {
  await test('버그3: 「내가 해봤어요」 의 기록·마스터리가 실제 개념(분수의 덧셈)에 붙는다', async () => {
    const u = await newUser('b3');
    setLearnSession(u.id, { stage: 'L3', stageTurns: 3, turns: 3, concept: CONCEPT });
    const r = await api('/api/chat', { method: 'POST', token: u.token,
      body: { mode: 'learn', message: '내가 해봤어요! 스스로 해결했어요.', solved: true, style: 'auto' } });
    assert(r.status === 200 && r.data.solved === true, `solved 응답 이상: ${r.status} ${JSON.stringify(r.data).slice(0, 120)}`);
    const d = db();
    const log = d.prepare('SELECT subject FROM learning_help_logs WHERE user_id=? AND solved=1 ORDER BY id DESC LIMIT 1').get(u.id);
    const mastery = d.prepare('SELECT topic FROM concept_mastery WHERE user_id=?').all(u.id).map(x => x.topic);
    d.close();
    assert(log && log.subject === CONCEPT, `기록 과목이 개념이 아님: ${log && log.subject}`);
    assert(mastery.length === 1 && mastery[0] === CONCEPT, `마스터리 토픽이 개념이 아님: ${mastery.join(',')}`);
  });
  await test('버그3: 「내가 해봤어요」 를 같은 날 3번 눌러도 마스터리는 한 번만 오른다(0.3→0.38)', async () => {
    const u = await newUser('b3r');
    for (let i = 0; i < 3; i++) {
      setLearnSession(u.id, { stage: 'L3', stageTurns: 3, turns: 3 + i, concept: CONCEPT });
      await api('/api/chat', { method: 'POST', token: u.token, body: { mode: 'learn', message: '내가 해봤어요!', solved: true, style: 'auto' } });
    }
    const d = db();
    const m = d.prepare('SELECT score FROM concept_mastery WHERE user_id=? AND topic=?').get(u.id, CONCEPT);
    d.close();
    assert(m && Math.abs(m.score - 0.38) < 0.001, `점수 기대 0.38, 실제 ${m && m.score}`);
  });
}

// ============================================================
// 버그 4 — 검증 안 된 설명은 탑의 «원래 말» 이 되지 않는다
// ============================================================
async function bug4() {
  await test('버그4: 틀린 설명은 source=explain:unverified · 낮은 신뢰로만 저장된다', async () => {
    const u = await newUser('b4');
    await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: '분모가 클수록 더 큰 수야' } });
    const d = db();
    const m = d.prepare("SELECT source, confidence FROM user_memories WHERE user_id=? AND kind='taught'").get(u.id);
    d.close();
    assert(m && m.source === 'explain:unverified', `source 기대 explain:unverified, 실제 ${m && m.source}`);
    assert(m.confidence < 0.9, `신뢰도가 너무 높음: ${m.confidence}`);
  });
  await test('버그4: 맞는 설명은 source=explain:verified · 0.95 로 저장된다', async () => {
    const u = await newUser('b4v');
    await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: '분모가 같으면 분자끼리 더하면 돼요' } });
    const d = db();
    const m = d.prepare("SELECT source, confidence FROM user_memories WHERE user_id=? AND kind='taught'").get(u.id);
    d.close();
    assert(m && m.source === 'explain:verified' && Math.abs(m.confidence - 0.95) < 0.001, `검증 기록 이상: ${JSON.stringify(m)}`);
  });
  await test('버그4: 틀린 설명이 탑 응답(why)에 원문으로 새지 않는다', async () => {
    // 탑은 정답/오답에 따라 응답이 달라진다. 틀린 설명만 저장된 상태에서 여러 번 답해도 오개념 문장이 나오면 안 된다.
    const u = await newUser('b4t');
    await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: '분모가 클수록 더 큰 수야' } });
    const t = await api('/api/tower/today', { token: u.token });
    assert(t.status === 200, `탑 열기 실패 ${t.status}`);
    const a = await api('/api/tower/answer', { method: 'POST', token: u.token, body: { floor: 0, choice: 'original' } });
    const text = JSON.stringify(a.data);
    assert(!text.includes('분모가 클수록'), `오개념 문장이 탑 응답에 노출됨: ${text.slice(0, 160)}`);
  });
}

// ============================================================
// 버그 5 — 검증된 teach-back 은 마스터리 'lesson' 을 올린다 / 설명 제안은 실제 개념을 넘긴다
// ============================================================
async function bug5() {
  await test('버그5: 검증된 teach-back 은 concept_mastery 행을 만든다(0.3→0.40)', async () => {
    const u = await newUser('b5');
    await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: '분모가 같으면 분자끼리 더하면 돼요' } });
    const d = db();
    const m = d.prepare('SELECT score, attempts FROM concept_mastery WHERE user_id=? AND topic=?').get(u.id, CONCEPT);
    d.close();
    assert(m, 'concept_mastery 행이 없음(bumpMastery lesson 미호출)');
    assert(Math.abs(m.score - 0.40) < 0.001, `점수 기대 0.40, 실제 ${m.score}`);
  });
  await test('버그5: 틀린 teach-back 은 마스터리를 올리지 않는다', async () => {
    const u = await newUser('b5n');
    await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: '분모가 클수록 더 큰 수야' } });
    const d = db();
    const m = d.prepare('SELECT score FROM concept_mastery WHERE user_id=? AND topic=?').get(u.id, CONCEPT);
    d.close();
    assert(!m, `틀린 설명으로 마스터리가 생김: ${m && m.score}`);
  });
  await test('버그5: L3 에서 주는 설명 제안(explain.concept)은 «방금 배운 것» 이 아니라 실제 개념이다', async () => {
    const u = await newUser('b5c');
    setLearnSession(u.id, { stage: 'L3', stageTurns: 3, turns: 3, concept: CONCEPT });
    const r = await api('/api/chat', { method: 'POST', token: u.token, body: { mode: 'learn', message: '모르겠어', style: 'auto' } });
    assert(r.data.explain, `explain 제안이 없음(hintLevel=${r.data.hintLevel})`);
    assert(r.data.explain.concept === CONCEPT, `explain.concept 기대 ${CONCEPT}, 실제 ${r.data.explain.concept}`);
  });
}

// ============================================================
// 보조 — 간격 감쇠 · 탑 회상 · 구제 층 · 돌아온 아이 · 학습 한도 · PIN
// ============================================================
async function extras() {
  await test('감쇠: 재점등 2회(reinforce 2) 는 2일 뒤에도 1일치만 잊힌다(안정도 2)', async () => {
    const u = await newUser('dec');
    await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: '분모가 같으면 분자끼리 더하면 돼요' } });
    const d = db();
    d.prepare("UPDATE memory_lamps SET reinforce=2, lit_day=? WHERE user_id=? AND topic=?").run(kstDay(-2), u.id, CONCEPT);
    d.close();
    const r = await api('/api/lamps', { token: u.token });
    const lamp = r.data.lamps.find(l => l.topic === CONCEPT);
    assert(lamp && lamp.decay === 10, `감쇠 기대 10, 실제 ${lamp && lamp.decay}`);
  });
  await test('회상: 맞힌 탑 층은 등불의 안개 시계를 오늘로 되돌린다(lit_day=오늘)', async () => {
    // 맞힌 층을 확실히 얻으려고 최대 12명의 사용자로 시도한다(층의 원래/왜곡 여부는 uid 시드로 정해진다).
    let ok = false;
    for (let i = 0; i < 12 && !ok; i++) {
      const u = await newUser('rec');
      await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: '분모가 같으면 분자끼리 더하면 돼요' } });
      shiftLamp(u.id, CONCEPT, 3);
      const t = await api('/api/tower/today', { token: u.token });
      if (t.status !== 200) continue;
      const a = await api('/api/tower/answer', { method: 'POST', token: u.token, body: { floor: 0, choice: (i % 2 ? 'fogged' : 'original') } });
      if (a.data && a.data.correct === true) {
        const row = lampRow(u.id, CONCEPT);
        assert(row.lit_day === kstDay(), `lit_day 기대 ${kstDay()}, 실제 ${row.lit_day}`);
        assert(row.extra_decay === 0, `extra_decay 기대 0, 실제 ${row.extra_decay}`);
        ok = true;
      }
    }
    assert(ok, '12명 시도 중 맞힌 층이 없었다(테스트 자체 문제일 수 있음)');
  });
  await test('구제: 완전히 흐려진 등불만 있어도 탑은 404 가 아니라 열린다', async () => {
    const u = await newUser('rescue');
    await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: '분모가 같으면 분자끼리 더하면 돼요' } });
    shiftLamp(u.id, CONCEPT, 60);   // 60일 뒤 → decay 100
    const r = await api('/api/tower/today', { token: u.token });
    assert(r.status === 200, `구제 탑이 열리지 않음: ${r.status} ${JSON.stringify(r.data)}`);
    assert(Array.isArray(r.data.floors) && r.data.floors.length >= 1, '층이 없음');
  });
  await test('돌아온 아이: 3일 이상 떠났다 오면 welcome 인사를 한다', async () => {
    const u = await newUser('welcome');
    const d = db();
    d.prepare('INSERT INTO visits(user_id, entered_at) VALUES(?,?)').run(u.id, `${kstDay(-5)} 12:00:00`);
    d.close();
    const r = await api('/api/robot/hello', { token: u.token });
    assert(r.data.kind === 'welcome', `kind 기대 welcome, 실제 ${r.data.kind} (${r.data.line})`);
    const r2 = await api('/api/robot/hello', { token: u.token });
    assert(r2.data.kind !== 'welcome', '같은 날 두 번째 호출에서도 welcome 이 나옴');
  });
  await test('학습 한도: 모델 턴 10개 뒤 11번째는 429 이고, 이어하기 follow_up 이 저장된다', async () => {
    const u = await newUser('limit');
    const msgs = ['분모가 헷갈려', '분모 또 모르겠어', '분모 몰라', '분모가 어려워', '분모 다시', '분모 한번 더',
      '분모 어떻게', '분모 계속', '분모 또', '분모 마지막'];
    let last = null;
    for (const m of msgs) {
      last = await api('/api/chat', { method: 'POST', token: u.token, body: { mode: 'learn', message: m, style: 'auto' } });
      assert(last.status === 200, `10턴 안에서 막힘: ${last.status} (${m})`);
    }
    const over = await api('/api/chat', { method: 'POST', token: u.token, body: { mode: 'learn', message: '분모 한 번 더', style: 'auto' } });
    assert(over.status === 429, `11번째 기대 429, 실제 ${over.status}`);
    const d = db();
    const f = d.prepare("SELECT follow_up FROM chat_messages WHERE user_id=? AND follow_up IS NOT NULL").get(u.id);
    d.close();
    assert(f && f.follow_up && f.follow_up.includes('이어서'), `follow_up 이 저장되지 않음: ${JSON.stringify(f)}`);
  });
  await test('막힘 인사: 어제 막힌 개념은 하루 1번만 말하고, 그 개념을 해결하면 더 말하지 않는다', async () => {
    // 어제 막힌 기록(chat_analyses.stuck=1)을 직접 심는다
    const seedStuck = (uid) => {
      const d = db();
      const m = d.prepare("INSERT INTO chat_messages(user_id,role,content,mode,ts) VALUES(?,'user','어려워','learn',?)")
        .run(uid, `${kstDay(-1)} 12:00:00`);
      d.prepare(`INSERT INTO chat_analyses(user_id,user_msg_id,ai_msg_id,day,mode,topic,subject,stuck)
        VALUES(?,?,NULL,?,'learn',?,?,1)`).run(uid, Number(m.lastInsertRowid), kstDay(-1), CONCEPT, CONCEPT);
      d.close();
    };
    const u = await newUser('stuck');
    seedStuck(u.id);
    const first = await api('/api/robot/hello', { token: u.token });
    assert(first.data.kind === 'stuck', `첫 인사 기대 stuck, 실제 ${first.data.kind} (${first.data.line})`);
    const second = await api('/api/robot/hello', { token: u.token });
    assert(second.data.kind !== 'stuck', `같은 날 두 번째도 막힘 인사가 나왔다: ${second.data.line}`);

    // 해결한 개념은 더 이상 막힘 인사를 하지 않는다
    const v = await newUser('stuck2');
    seedStuck(v.id);
    const d = db();
    d.prepare("INSERT INTO learning_help_logs(user_id,day,subject,level,solved) VALUES(?,?,?,3,1)").run(v.id, kstDay(), CONCEPT);
    d.close();
    const solvedHello = await api('/api/robot/hello', { token: v.token });
    assert(solvedHello.data.kind !== 'stuck', `해결한 개념을 여전히 막혔다고 말함: ${solvedHello.data.line}`);
  });
  await test('편지 미리보기: 개념명 뒤 조사가 받침에 맞다(«분수의 덧셈» → 을)', async () => {
    const u = await newUser('letter');
    await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: '분모가 같으면 분자끼리 더하면 돼요' } });
    shiftLamp(u.id, CONCEPT, 5);   // 5일 전 → decay 65 → 편지 미리보기 대상
    const r = await api('/api/parent/dashboard', { token: u.token });
    const body = r.data && r.data.letterPreview && r.data.letterPreview.body;
    assert(body, '편지 미리보기가 없음');
    assert(body.includes(`«${CONCEPT}»을 한 번 다시`), `조사 오류: ${body.split('\n')[2]}`);
    assert(!body.includes(`«${CONCEPT}» 를`) && !body.includes(`«${CONCEPT}»를`), '하드코딩 조사가 남아 있음');
  });
  await test('설명 하루 한도: 설명 5번까지 허용, 6번째부터 429 (턴 행 2개씩 세던 버그)', async () => {
    const u = await newUser('explim');
    const codes = [];
    for (let i = 0; i < 6; i++) {
      const r = await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: `분모가 같으면 분자끼리 더하면 돼요 ${i}` } });
      codes.push(r.status);
    }
    assert(codes.slice(0, 5).every(c => c === 200), `5번까지 200 이어야 함: ${codes}`);
    assert(codes[5] === 429, `6번째는 429 이어야 함: ${codes}`);
  });
  await test('이어하기 중복: 한도에 막힌 요청을 여러 번 보내도 같은 날 이어하기 행은 하나', async () => {
    const u = await newUser('fudup');
    setLearnSession(u.id, { stage: 'L1', stageTurns: 0, turns: 0, concept: CONCEPT });
    const msgs = Array.from({ length: 10 }, (_, i) => `분모 질문 ${i}`);
    for (const m of msgs) await api('/api/chat', { method: 'POST', token: u.token, body: { mode: 'learn', message: m, style: 'auto' } });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await api('/api/chat', { method: 'POST', token: u.token, body: { mode: 'learn', message: `한 번 더 ${i}`, style: 'auto' } })).status);
    assert(codes.every(c => c === 429), `막힌 요청이 429 가 아님: ${codes}`);
    const d = db();
    const n = d.prepare("SELECT COUNT(*) c FROM chat_messages WHERE user_id=? AND follow_up IS NOT NULL").get(u.id).c;
    d.close();
    assert(n === 1, `이어하기 행이 ${n}개 — 1개여야 함`);
  });
  await test('개념 오탐: 「좋아 계속해」 는 수업 개념(분수의 덧셈)을 반복문으로 바꾸지 않는다', async () => {
    const u = await newUser('concept');
    setLearnSession(u.id, { stage: 'L2', stageTurns: 1, turns: 1, concept: CONCEPT });
    await api('/api/chat', { method: 'POST', token: u.token, body: { mode: 'learn', message: '좋아 계속해', style: 'auto' } });
    const d = db();
    const s = d.prepare("SELECT concept FROM chat_sessions WHERE user_id=? AND mode='learn' ORDER BY id DESC LIMIT 1").get(u.id);
    d.close();
    assert(s && s.concept === CONCEPT, `수업 개념이 «${s && s.concept}» 로 바뀌었다`);
  });
  await test('닉네임: 12자를 넘는 기존 닉네임도 잘리지 않고 로그인된다', async () => {
    const nick = 'longnick_' + Date.now().toString(36).slice(-4) + 'xy';   // 14자 이상
    assert(nick.length > 12, `테스트 닉네임이 짧다: ${nick.length}`);
    const r1 = await api('/api/user', { method: 'POST', body: { nickname: nick } });
    assert(r1.data.user.nickname === nick, `닉네임이 잘렸다: ${r1.data.user.nickname}`);
    const r2 = await api('/api/user', { method: 'POST', body: { nickname: nick } });
    assert(r2.data.user.id === r1.data.user.id, '같은 닉네임인데 다른 계정이 생겼다');
  });
  await test('PIN 로그인: 만든 PIN 으로 로그인할 수 있다(해시 비교 수정)', async () => {
    const u = await newUser('pin');
    const made = await api('/api/account/pin', { method: 'POST', token: u.token, body: { pin: '4321' } });
    assert(made.status === 200, `PIN 생성 실패 ${made.status}`);
    const r = await api('/api/account/pin/verify', { method: 'POST', body: { nickname: u.nickname, pin: '4321' } });
    assert(r.status === 200 && r.data.ok && r.data.token, `PIN 로그인 실패 ${r.status} ${JSON.stringify(r.data)}`);
  });
  await test('보호자 PIN 게이트: PIN 이 맞으면 통과, 틀리면 거절', async () => {
    const u = await newUser('gate');
    await api('/api/account/pin', { method: 'POST', token: u.token, body: { pin: '1357' } });
    const bad = await api('/api/parent/verify-pin', { method: 'POST', token: u.token, body: { pin: '0000' } });
    assert(bad.status === 400, `틀린 PIN 기대 400, 실제 ${bad.status}`);
    const ok = await api('/api/parent/verify-pin', { method: 'POST', token: u.token, body: { pin: '1357' } });
    assert(ok.status === 200 && ok.data.ok, `맞는 PIN 실패 ${ok.status} ${JSON.stringify(ok.data)}`);
    const st = await api('/api/parent/status', { token: u.token });
    assert(st.data.pinSet === true && st.data.parentOk === true, `status 이상: ${JSON.stringify(st.data)}`);
  });
  await test('보호자 대시보드: 검증된 가르침과 등불 수를 보여 주고, 공부한 날은 버튼 말고 학습 대화도 센다', async () => {
    const u = await newUser('dash');
    await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: CONCEPT, text: '분모가 같으면 분자끼리 더하면 돼요' } });
    await api('/api/chat/explain', { method: 'POST', token: u.token, body: { concept: '소수', text: '분모가 클수록 더 큰 수야' } });
    const r = await api('/api/parent/dashboard', { token: u.token });
    assert(r.status === 200, `대시보드 실패 ${r.status}`);
    const taught = (r.data.taughtThisWeek || []).map(x => x.topic);
    assert(taught.includes(CONCEPT), `검증된 가르침이 안 보임: ${taught}`);
    assert(!taught.includes('소수'), `미검증 가르침이 보호자 화면에 노출됨: ${taught}`);
    assert(r.data.lamps && r.data.lamps.total >= 2, `등불 수 이상: ${JSON.stringify(r.data.lamps)}`);
    assert(r.data.weekly && r.data.weekly.studyDays >= 1, `공부한 날이 0: ${JSON.stringify(r.data.weekly)}`);
  });
}

// ---------- 실행 ----------
(async () => {
  let code = 0;
  try {
    await waitReady();
    console.log(`RooMi 회귀 테스트 · 서버 ${BASE} · DB ${DB_FILE}`);
    await bug1(); await bug2(); await bug3(); await bug4(); await bug5(); await extras();
  } catch (e) {
    console.log('\n[실행 오류] ' + e.message);
    code = 1;
  } finally {
    server.kill('SIGTERM');
    const failed = results.filter(r => !r.ok);
    console.log(`\n결과: ${results.length - failed.length} PASS / ${failed.length} FAIL`);
    for (const f of failed) console.log(' - ' + f.name + ' :: ' + f.err);
    try { fs.unlinkSync(DB_FILE); } catch {}
    try { fs.unlinkSync(DB_FILE + '-wal'); } catch {}
    try { fs.unlinkSync(DB_FILE + '-shm'); } catch {}
    if (failed.length) code = 1;
    process.exitCode = code;
  }
})();
