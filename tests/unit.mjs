// RooMi 순수 규칙 단위 테스트 (v1.82) — DB·서버 없이 lib/learning-rules.js 를 직접 검증한다.
//   실행: node tests/unit.mjs   (또는 npm run test:unit)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import * as R from '../lib/learning-rules.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push({ name, ok: true }); console.log('  PASS  ' + name); },
    (e) => { results.push({ name, ok: false, err: e.message }); console.log('  FAIL  ' + name + '\n        → ' + e.message.split('\n')[0]); },
  );
}

// ---------- 1. 조사 재선택 ----------
await test('조사: 받침 유무에 따라 은/는·이/가·을/를 고른다', async () => {
  assert.equal(R.koJosaFix('분수', '는'), '는');   // 수 — 받침 없음
  assert.equal(R.koJosaFix('빛', '는'), '은');     // 빛 — 받침 ㅊ
  assert.equal(R.koJosaFix('분모', '이'), '가');   // 모 — 받침 없음
  assert.equal(R.koJosaFix('물의 상태', '가'), '가'); // 태 — 받침 없음
  assert.equal(R.koJosaFix('온도', '을'), '를');   // 도 — 받침 없음
  assert.equal(R.koJosaFix('각도', '을'), '를');
  assert.equal(R.koJosaFix('소수', '를'), '를');
});
await test('조사: 짝이 아니거나 한글이 아니면 입력을 그대로 돌려준다', async () => {
  assert.equal(R.koJosaFix('분수', '에서'), '에서');
  assert.equal(R.koJosaFix('ABC', '은'), '는');  // 영문 끝 글자는 받침 없음 취급
});
await test('조사: 개념 교체(graft) 뒤 문장의 조사가 새 이름의 받침을 따른다', async () => {
  // 받침 있는 «빛» 으로 바꾸면 «은», 받침 없는 «온도» 면 «는» — 조사가 원래 단어(분수)에 묶이지 않는다.
  const fixed = (other) => R.planFloor({
    topic: '분수의 덧셈', original: '분수는 나눠진 조각을 더하는 거야.',
    others: [{ topic: other, concept: null }], names: ['분수'], seed: 0, boss: true,
  });
  const s = fixed('빛');
  assert.equal(s.strategy, 'graft');
  assert.ok(s.statement.startsWith('빛은 '), `기대 «빛은 …», 실제 «${s.statement}»`);
  const t = fixed('온도와 열');
  assert.equal(t.strategy, 'graft');
  // 열 은 받침 ㄹ 이 있으므로 «은» (원래 «분수는» 의 «는» 을 그대로 두면 틀린다)
  assert.ok(t.statement.startsWith('온도와 열은 '), `조사 재선택 실패: «${t.statement}»`);
});

// ---------- 2. L1 되묻기 회전 ----------
await test('L1: 세 줄이 번갈아 나오고 연속 두 턴이 같은 문장이 아니다', async () => {
  const card = { hint_l1: '카드 되묻기 문장?' };
  const lines = [0, 1, 2, 3].map(t => R.l1LineFor(card, '분수의 덧셈', t));
  assert.equal(new Set(lines.slice(0, 3)).size, 3, '세 줄이 서로 달라야 한다');
  for (let i = 1; i < lines.length; i++) assert.notEqual(lines[i], lines[i - 1]);
  assert.equal(lines[3], lines[0], '세 줄을 돌고 처음으로 돌아온다');
});
await test('L1: 카드가 없으면 개념명을 넣은 두 문장 중에서 고른다(빈 문장 없음)', async () => {
  const l = R.l1LineFor(null, '소수', 0);
  assert.ok(l.length > 0);
  assert.ok(l.includes('소수'), `개념명이 들어가야 함: ${l}`);
});

// ---------- 3. 이해 확인 판정 (버그 2) ----------
await test('gotIt: 확인 문장은 true, 질문·부정·모름은 false', async () => {
  const yes = ['알겠어 이제 알겠다', '다 했어', '풀었어', '이해했어', '맞았어'];
  const no = ['1/2+1/3=2/5 이거 맞아?', '못 풀었어', '안 풀렸어', '맞아 이거 맞아?', '모르겠어', '이거 알아?', '몰라'];
  for (const m of yes) assert.equal(R.isGotIt(m), true, `확인이어야 함: ${m}`);
  for (const m of no) assert.equal(R.isGotIt(m), false, `확인이 아니어야 함: ${m}`);
});

// ---------- 4. teach-back 검증 (버그 4) ----------
const CARD = { topic: '분수의 덧셈', concept: '분모가 같은 분수 더하기', analogy: '피자 조각을 같은 크기로 나눈 것을 더하는 것',
  hint_l2: '분모가 같으면 분자끼리 더해', tags: '분수,분모,분자', hint_l3: '정답 힌트(노출 금지)' };
const ALIASES = { '분수의 덧셈': ['분수', '분모', '분자', '더하기'] };
const noLLM = { aliases: ALIASES };

await test('teach-back(LLM 판정 ok=true): 모델이 맞다고 하면 ok, source=llm', async () => {
  let sent = null;
  const deps = { aliases: ALIASES,
    callLLM: async (prompt, opts) => { sent = { prompt, opts }; return { text: '{"ok":true,"reply":"맞게 말했구나. 만약 분모가 달라지면 어떻게 될까?"}' }; },
    parseChatJSON: (raw) => JSON.parse(raw) };
  const v = await R.checkTeachBack('분모가 같으면 분자끼리 더하면 돼요', '분수의 덧셈', CARD, deps);
  assert.equal(v.ok, true); assert.equal(v.source, 'llm');
  assert.ok(sent, 'LLM 이 호출되어야 함');
  assert.ok(!sent.prompt.includes('정답 힌트(노출 금지)'), 'hint_l3 은 프롬프트에 들어가면 안 된다');
});
await test('teach-back(LLM 판정 ok=false): 모델이 틀렸다고 하면 ok=false 이고 모델의 질문을 그대로 쓴다', async () => {
  const deps = { aliases: ALIASES,
    callLLM: async () => ({ text: '{"ok":false,"reply":"분모가 클수록이라고 했구나. 만약 분모가 더 커지면 조각은 어떻게 될까?"}' }),
    parseChatJSON: (raw) => JSON.parse(raw) };
  const v = await R.checkTeachBack('분모가 클수록 더 큰 수야', '분수의 덧셈', CARD, deps);
  assert.equal(v.ok, false); assert.equal(v.source, 'llm');
  assert.ok(v.reply.includes('만약'), '후속 질문이 있어야 함');
});
await test('teach-back(LLM 없음 → 키워드 폴백): LLM 이 null 이면 규칙으로 판정', async () => {
  const deps = { aliases: ALIASES, callLLM: async () => null, parseChatJSON: () => null };
  const v = await R.checkTeachBack('분모가 같으면 분자끼리 더하면 돼요', '분수의 덧셈', CARD, deps);
  assert.equal(v.ok, true); assert.equal(v.source, 'rule');
});
await test('teach-back(LLM 예외 → 키워드 폴백): LLM 이 던져도 대화는 멈추지 않는다', async () => {
  const deps = { aliases: ALIASES, callLLM: async () => { throw new Error('timeout'); }, parseChatJSON: () => null };
  const v = await R.checkTeachBack('분모가 같으면 분자끼리 더하면 돼요', '분수의 덧셈', CARD, deps);
  assert.equal(v.source, 'rule'); assert.equal(v.ok, true);
});
await test('teach-back(LLM 이 ok 를 빼먹음 → 폴백): 불완전한 JSON 은 믿지 않는다', async () => {
  const deps = { aliases: ALIASES, callLLM: async () => ({ text: '{"reply":"좋아"}' }), parseChatJSON: (raw) => JSON.parse(raw) };
  const v = await R.checkTeachBack('분모가 같으면 분자끼리 더하면 돼요', '분수의 덧셈', CARD, deps);
  assert.equal(v.source, 'rule');
});
await test('teach-back(키워드 폴백): 맞는 설명은 통과한다', async () => {
  const v = await R.checkTeachBack('분모가 같으면 분자끼리 더하면 돼요', '분수의 덧셈', CARD, noLLM);
  assert.equal(v.ok, true);
});
await test('teach-back(키워드 폴백): 핵심어가 하나뿐인 설명은 실패한다', async () => {
  const v = await R.checkTeachBack('분수는 어려워 보이지만 재미있어요', '분수의 덧셈', CARD, noLLM);
  assert.equal(v.ok, false);
});
await test('teach-back(키워드 폴백): 헐겁게 쓴 오개념 «분모 분자 다 크면 분수도 커져» 는 실패해야 한다', async () => {
  // 핵심어(분모·분자·분수)가 2개 이상 들어 있어 키워드만 보면 통과해 버린다 — 크기 방향 오개념 표지로 막는다.
  const v = await R.checkTeachBack('분모 분자 다 크면 분수도 커져', '분수의 덧셈', CARD, noLLM);
  assert.equal(v.ok, false, '오개념이 통과했다');
});
await test('teach-back(키워드 폴백): «분모가 클수록 더 큰 수야» 는 실패한다', async () => {
  const v = await R.checkTeachBack('분모가 클수록 더 큰 수야', '분수의 덧셈', CARD, noLLM);
  assert.equal(v.ok, false);
});
await test('teach-back: 카드가 없으면 검증하지 않고 nocard(실패)로 본다', async () => {
  const v = await R.checkTeachBack('아무 설명이나 길게 써 본다', '방금 배운 것', null, noLLM);
  assert.equal(v.ok, false); assert.equal(v.source, 'nocard');
});

// ---------- 5. 탑 층 설계 — 안개 예측 가능성 ----------
await test('탑: 「같으면」 문장도 층의 절반은 안개 없이 나온다(항상 안개면 «원래 말» 이 정답이 아님)', async () => {
  const original = '분모가 같으면 분자끼리 더하면 돼요';
  const others = [{ topic: '빛', concept: '물체가 반짝이는 것' }, { topic: '온도와 열', concept: '따뜻함이 옮겨 가는 것' }];
  let fogged = 0, n = 0;
  for (let uid = 1; uid <= 400; uid++) {
    const seed = (uid * 31 + R.fogDayHash('2026-11-27') + 0) >>> 0;   // server 의 시드 식과 같은 형태
    const p = R.planFloor({ topic: '분수의 덧셈', original, others, names: ['분수'], seed, boss: false });
    if (p.canFog) { n++; if (p.fogged) fogged++; }
  }
  const share = fogged / n;
  assert.ok(n > 300, `표본이 부족함 ${n}`);
  assert.ok(share > 0.3 && share < 0.7, `안개 비율 ${share.toFixed(2)} — 0.3~0.7 이어야 원래 말을 맞힐 수 있다`);
});
await test('탑: 주말 BOSS 층은 항상 안개(개념 이식)를 쓴다', async () => {
  for (let seed = 0; seed < 30; seed++) {
    const p = R.planFloor({ topic: 'A', original: '빛은 반짝여.', others: [{ topic: '온도', concept: '따뜻함' }], names: ['빛'], seed, boss: true });
    assert.equal(p.fogged, true, `seed ${seed} 에서 BOSS 층이 안개가 아님`);
  }
});

// ---------- 6. 버전 일관성 ----------
await test('버전: package.json · index.html · HANDOFF.md 가 같은 minor 버전(1.82)을 가리킨다', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const hand = fs.readFileSync(path.join(ROOT, 'HANDOFF.md'), 'utf8');
  const htmlV = (html.match(/<em class="ver">v([\d.]+)<\/em>/) || [])[1];
  const handV = (hand.match(/app version \*\*v([\d.]+)\*\*/) || [])[1];
  const pkgMinor = pkg.version.split('.').slice(0, 2).join('.');
  assert.ok(htmlV, 'index.html 버전 표시를 찾지 못함');
  assert.ok(handV, 'HANDOFF.md 버전 표시를 찾지 못함');
  assert.equal(htmlV, handV, `index.html(v${htmlV}) ≠ HANDOFF.md(v${handV})`);
  assert.equal(pkgMinor, htmlV, `package.json(${pkg.version}) ≠ index.html(v${htmlV})`);
  // ?v= 캐시 버스터는 세 곳이 같아야 한다(HANDOFF §10)
  const busters = [...html.matchAll(/\?v=([\w]+)/g)].map(m => m[1]);
  assert.ok(busters.length >= 3 && new Set(busters).size === 1, `?v= 불일치: ${busters}`);
});

// ---------- 결과 ----------
const failed = results.filter(r => !r.ok);
console.log(`\n단위 테스트: ${results.length - failed.length} PASS / ${failed.length} FAIL`);
for (const f of failed) console.log(' - ' + f.name + ' :: ' + f.err.split('\n')[0]);
process.exitCode = failed.length ? 1 : 0;
