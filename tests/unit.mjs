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

await test('teach-back(화면 비공개): 모델 답에 «맞아/틀려» 같은 판정 말이 있으면 중립 문장으로 바꾼다', async () => {
  const deps = { aliases: ALIASES,
    callLLM: async () => ({ text: '{"ok":true,"reply":"맞아, 분모가 같으면 분자끼리 더하면 돼! 다음은?"}' }),
    parseChatJSON: (raw) => JSON.parse(raw) };
  const v = await R.checkTeachBack('분모가 같으면 분자끼리 더하면 돼요', '분수의 덧셈', CARD, deps);
  assert.equal(v.ok, true);
  assert.equal(R.hasEvalWord(v.reply), false, `판정 말이 화면에 새었다: ${v.reply}`);
});
await test('teach-back(화면 비공개): 틀린 설명에 대한 모델 답도 «틀렸어» 를 말하면 안 된다', async () => {
  const deps = { aliases: ALIASES,
    callLLM: async () => ({ text: '{"ok":false,"reply":"틀렸어. 분모가 클수록 더 큰 건 아니야."}' }),
    parseChatJSON: (raw) => JSON.parse(raw) };
  const v = await R.checkTeachBack('분모가 클수록 더 큰 수야', '분수의 덧셈', CARD, deps);
  assert.equal(v.ok, false);
  assert.equal(R.hasEvalWord(v.reply), false, `판정 말이 화면에 새었다: ${v.reply}`);
});

await test('검증 시간 예산: 제한 안에 답이 없으면 timeout(미검증 대기)으로 빠르게 돌아온다', async () => {
  const t0 = Date.now();
  const deps = { aliases: ALIASES, timeoutMs: 40,
    callLLM: () => new Promise(res => setTimeout(() => res({ text: '{"ok":true,"reply":"좋아"}' }), 400)),
    parseChatJSON: (raw) => JSON.parse(raw) };
  const v = await R.checkTeachBack('분모가 같으면 분자끼리 더하면 돼요', '분수의 덧셈', CARD, deps);
  const dt = Date.now() - t0;
  assert.equal(v.source, 'timeout');
  assert.equal(v.pending, true);
  assert.equal(v.ok, false, '시간 초과 시 검증 성공으로 저장되면 안 된다');
  assert.ok(dt < 250, `예산(40ms)을 넘겨 ${dt}ms 걸렸다`);
  assert.equal(R.hasEvalWord(v.reply), false);
});
await test('검증 폴백: LLM 이 실패(예외)하면 규칙으로 판정하고 timeout 이 아니다', async () => {
  const deps = { aliases: ALIASES, timeoutMs: 1000, callLLM: async () => { throw new Error('boom'); }, parseChatJSON: () => null };
  const v = await R.checkTeachBack('분모가 같으면 분자끼리 더하면 돼요', '분수의 덧셈', CARD, deps);
  assert.equal(v.source, 'rule'); assert.equal(v.ok, true);
});
await test('검증 예산 안에 LLM 이 답하면 source=llm 이다(예산이 있어도 정상 경로)', async () => {
  const deps = { aliases: ALIASES, timeoutMs: 1000,
    callLLM: async () => ({ text: '{"ok":true,"reply":"좋아, 다음은?"}' }), parseChatJSON: (raw) => JSON.parse(raw) };
  const v = await R.checkTeachBack('분모가 같으면 분자끼리 더하면 돼요', '분수의 덧셈', CARD, deps);
  assert.equal(v.source, 'llm'); assert.equal(v.ok, true);
});
await test('withBudget: 제한이 없으면(0) 원래 결과를 그대로 기다린다', async () => {
  assert.equal(await R.withBudget(Promise.resolve(7), 0), 7);
});
await test('저장 정책: 시간 초과는 항상 미검증으로 저장한다(기존 기억 없음)', async () => {
  const p = R.teachStoragePlan(null, { ok: false, source: 'timeout' });
  assert.equal(p.write, true); assert.equal(p.source, 'explain:unverified'); assert.equal(p.confidence, 0.4);
});
await test('저장 정책: 검증된 기억은 미검증 설명(시간 초과·LLM 불합격)으로 덮어쓰지 않는다', async () => {
  assert.equal(R.teachStoragePlan('explain:verified', { ok: false, source: 'timeout' }).write, false);
  assert.equal(R.teachStoragePlan('explain:verified', { ok: false, source: 'llm' }).write, false);
});
await test('저장 정책: 검증 성공 설명은 기존 미검증 기억을 교체한다', async () => {
  const p = R.teachStoragePlan('explain:unverified', { ok: true, source: 'llm' });
  assert.equal(p.write, true); assert.equal(p.source, 'explain:verified'); assert.equal(p.confidence, 0.95);
});

import { CARD_ALIASES, isGenericAlias } from '../lib/card-aliases.js';

await test('별칭: 표의 모든 별칭은 일반 단어 규칙을 통과한다(계속·좋아·다시 등은 없다)', async () => {
  const bad = [];
  for (const [card, list] of Object.entries(CARD_ALIASES)) for (const a of list) if (isGenericAlias(a)) bad.push(`${card}: ${a}`);
  assert.deepEqual(bad, [], `일반 단어 별칭이 남아 있다: ${bad.join(' | ')}`);
});
await test('별칭: 사용자가 든 예(계속, 계속해, 좋아, 다시, 해볼게)는 모두 일반 단어로 거른다', async () => {
  for (const w of ['계속', '계속해', '좋아', '다시', '해볼게', '해 볼게', '그냥', '몰라', '그러면', '만약']) {
    assert.equal(isGenericAlias(w), true, `«${w}» 가 일반 단어로 걸러지지 않는다`);
  }
  // 정상 별칭은 걸러지면 안 된다
  for (const w of ['분모', '반복', '램', '롬', '피자 조각', '0.']) assert.equal(isGenericAlias(w), false, `«${w}» 가 잘못 걸러졌다`);
});
await test('별칭: 카드마다 별칭이 하나 이상 있고, 같은 별칭이 두 카드에 걸치지 않는다(모호한 매칭 금지)', async () => {
  const seen = new Map(); const problems = [];
  for (const [card, list] of Object.entries(CARD_ALIASES)) {
    if (!list.length) problems.push(`${card}: 별칭 없음`);
    for (const a of list) {
      const t = a.trim().toLowerCase();
      if (seen.has(t) && seen.get(t) !== card) problems.push(`«${t}» 가 ${seen.get(t)} 와 ${card} 둘 다에 있다`);
      seen.set(t, card);
    }
  }
  assert.deepEqual(problems, []);
});

await test('검증 게이트: 「분자끼리 빼도 되고 더해도 돼」 는 LLM 을 부르기 전에 거절된다(source=gate)', async () => {
  let called = false;
  const deps = { aliases: ALIASES, callLLM: async () => { called = true; return { text: '{"ok":true}' }; }, parseChatJSON: (r) => JSON.parse(r) };
  const v = await R.checkTeachBack('분모가 같으면 분자끼리 빼도 되고 더해도 돼', '분수의 덧셈', CARD, deps);
  assert.equal(v.ok, false); assert.equal(v.source, 'gate'); assert.equal(called, false, '게이트 뒤에 LLM 이 불렸다');
});
await test('검증 게이트: 「분모를 같게 만든 다음 분자를 곱하면 돼」 도 거절된다', async () => {
  const v = await R.checkTeachBack('분모를 같게 만든 다음 분자를 곱하면 돼', '분수의 덧셈', CARD, noLLM);
  assert.equal(v.source, 'gate'); assert.equal(v.ok, false);
});
await test('검증 게이트: 올바른 설명은 게이트에서 걸리지 않는다(통과 목록)', async () => {
  const good = ['분모가 같으면 분자끼리 더하면 돼요', '분모가 같을 때는 위의 숫자끼리 더하고 아래 숫자는 그대로 둬',
    '분모가 같으면 분자만 더해서 답을 써', '분모가 같으니까 분자를 더하면 되고 분모는 안 바뀌어',
    '분모가 같으면 분자끼리 빼는 게 아니라 더하는 거야'];
  for (const g of good) assert.equal(R.contradictsCardOps(g, '분수의 덧셈'), null, `올바른 설명이 게이트에 걸림: ${g}`);
});
await test('검증 게이트: 「분자를 곱하지 마」 처럼 금지하는 말은 모순이 아니다', async () => {
  assert.equal(R.contradictsCardOps('분자를 곱하지 마, 더해야 해', '분수의 덧셈'), null);
});
await test('검증 게이트: 카드에 규칙이 없으면 게이트는 작동하지 않는다', async () => {
  assert.equal(R.contradictsCardOps('분자를 빼면 돼', '소수'), null);
});
await test('검증 항목 확인: 모델이 ok=true 라도 항목(연산)에서 false 면 거절한다', async () => {
  const deps = { aliases: ALIASES, callLLM: async () => ({ text: '{"checks":{"operation":false,"condition":true,"result":true},"ok":true,"reply":"좋아"}' }), parseChatJSON: (r) => JSON.parse(r) };
  const v = await R.checkTeachBack('분모가 같으면 분자끼리 더하면 돼요', '분수의 덧셈', CARD, deps);
  assert.equal(v.source, 'llm'); assert.equal(v.ok, false);
});
await test('검증 항목 확인: 세 항목이 모두 true 이고 ok 도 true 면 검증된다', async () => {
  const deps = { aliases: ALIASES, callLLM: async () => ({ text: '{"checks":{"operation":true,"condition":true,"result":true},"ok":true,"reply":"좋아"}' }), parseChatJSON: (r) => JSON.parse(r) };
  const v = await R.checkTeachBack('분모가 같으면 분자끼리 더하면 돼요', '분수의 덧셈', CARD, deps);
  assert.equal(v.ok, true);
});
import { aliasHit } from '../lib/card-aliases.js';
await test('별칭 경계: 영문 별칭 for 는 before·information·format 안에서 맞지 않는다', async () => {
  assert.equal(aliasHit('before the bell', 'for'), false);
  assert.equal(aliasHit('information', 'for'), false);
  assert.equal(aliasHit('format the disk', 'for'), false);
  assert.equal(aliasHit('for loop 을 써 볼까', 'for'), true);
  assert.equal(aliasHit('for문을 배웠어', 'for'), true);
});
await test('별칭 경계: 영문 별칭은 단어로 맞을 때만, 한글 별칭은 조사가 붙어도 맞는다', async () => {
  assert.equal(aliasHit('blueprint', 'print'), false);
  assert.equal(aliasHit('print 해줘', 'print'), true);
  assert.equal(aliasHit('분모가 커', '분모'), true);
  assert.equal(aliasHit('', '분모'), false);
  assert.equal(aliasHit('아무거나', ''), false);
});
// 카드별 게이트 규칙: 잘못된 설명은 거절, 올바른 설명은 통과(카드 26장 중 규칙이 있는 카드)
const GATE_CASES = [
  ['약분·통분', '분모와 분자에 같은 수를 더해도 약분된 값은 같아', '분모와 분자를 같은 수로 나누면 약분이 돼'],
  ['소수', '소수는 0.45 처럼 숫자가 길수록 더 큰 수야', '소수 0.5 는 0.45 보다 큰 수야'],
  ['도형 넓이', '넓이는 가로와 세로를 더해서 구해', '직사각형 넓이는 가로에 세로를 곱한 값이야'],
  ['리스트', '리스트의 첫 번째 원소는 1번이야', '리스트의 원소는 0번부터 번호가 붙어'],
  ['산술 연산', '나누면 항상 작아진다', '8을 2로 나누면 4가 돼'],
  ['변수', '변수는 한 번 넣은 값을 바꿀 수 없어', '변수는 값을 담아 두는 이름 붙은 상자야'],
  ['곱셈 순서', '곱셈은 항상 앞에서부터 계산해', '곱셈은 덧셈보다 먼저 계산해'],
  ['자석', '자석은 나무도 끌어당겨', '자석은 쇠를 끌어당겨'],
  ['지층', '위쪽에 있는 지층이 더 오래된 거야', '오래된 지층은 아래에 있어'],
  ['식물 광합성', '식물은 흙에서 양분을 먹어', '식물은 햇빛으로 양분을 만들어'],
  ['RAM·ROM', '램은 전원을 꺼도 내용이 남아', '램은 전원을 끄면 내용이 지워져'],
  ['함수', '함수는 항상 값을 돌려줘야 해', '함수는 정해진 일을 하는 묶음이야'],
  ['압축', '압축하면 정보가 늘어나', '압축하면 용량을 줄일 수 있어'],
  ['물의 상태', '얼음은 뜨거워서 녹는 거야', '얼음은 열을 받으면 녹아'],
  ['각도', '변이 길면 각이 커져', '각도는 두 선이 벌어진 정도야'],
  ['온도와 열', '차가움이 옮겨 가는 거야', '열은 뜨거운 곳에서 차가운 곳으로 옮겨 가'],
  ['빛의 반사', '거울은 빛을 흡수해', '거울은 빛을 반사해'],
  ['네트워크 패킷', '패킷은 데이터를 한 번에 통째로 보내', '패킷은 데이터를 잘라서 나눠 보내'],
];
for (const [card, bad, good] of GATE_CASES) {
  await test(`게이트(${card}): 잘못된 설명은 거절한다 — 「${bad}」`, async () => {
    assert.notEqual(R.contradictsCardOps(bad, card), null, '거절되지 않았다');
  });
  await test(`게이트(${card}): 올바른 설명은 통과한다 — 「${good}」`, async () => {
    assert.equal(R.contradictsCardOps(good, card), null, '올바른 설명이 거절됐다');
  });
}
await test('게이트: 금지·부정 표현은 통과시킨다(「자석은 나무도 끌어당기지 않아」)', async () => {
  assert.equal(R.contradictsCardOps('자석은 나무도 끌어당기지 않아', '자석'), null);
});
await test('게이트: 규칙이 없는 카드(입출력 등)는 아무 설명도 거르지 않는다', async () => {
  assert.equal(R.contradictsCardOps('아무 말이나 해도 돼', '입출력'), null);
});
await test('보류 세트 회귀: 「변수에 새 값을 넣으면 예전 값은 사라져」 는 게이트에 걸리지 않고, 판정이 맞다고 하면 받아들인다', async () => {
  const text = '변수에 새 값을 넣으면 예전 값은 사라져';
  assert.equal(R.contradictsCardOps(text, '변수'), null, '게이트가 올바른 설명을 거절했다');
  const deps = { aliases: ALIASES, callLLM: async () => ({ text: '{"checks":{"operation":true,"condition":true,"result":true},"ok":true,"reply":"좋아"}' }), parseChatJSON: (r) => JSON.parse(r) };
  const v = await R.checkTeachBack(text, '변수', { topic: '변수', concept: '변수', analogy: '값을 담아 두는 이름 붙은 상자', hint_l2: '' }, deps);
  assert.equal(v.ok, true, '모든 항목이 참인데 거절됐다');
});

await test('게이트(변수 자료형 오개념): 「숫자만 담을 수 있는 칸」·「글자는 넣을 수 없어」 는 거절된다', async () => {
  assert.notEqual(R.contradictsCardOps('변수는 숫자만 담을 수 있는 칸이야', '변수'), null);
  assert.notEqual(R.contradictsCardOps('변수는 숫자만 넣을 수 있고 글자는 넣을 수 없어', '변수'), null);
});
await test('게이트(변수): 정상 변수 설명(새 값을 넣으면 예전 값은 사라져)은 거절되지 않는다', async () => {
  assert.equal(R.contradictsCardOps('변수에 새 값을 넣으면 예전 값은 사라져', '변수'), null);
});

// ---------- 5. 탑 층 설계 — 한 번의 탑(run) 안의 안개 분포 ----------
// 한 탑 = 한 사용자 · 하루의 덱. 층마다 원래 말/안개 말이 섞여 있어야 하고, 층 번호나 고정 비트로 예측되면 안 된다.
const ORIG_A = '분모가 같으면 분자끼리 더하면 돼요';
const OTHERS = [{ topic: '빛', concept: '물체가 반짝이는 것' }, { topic: '온도와 열', concept: '따뜻함이 옮겨 가는 것' }];
const CONCEPTS = ['분수의 덧셈', '소수', '약분·통분', '도형 넓이', '각도', '자석'];
// server.js fogInputFor 와 같은 시드 식(uid*31 + 날짜해시 + 층)
function deckInputs(uid, day, n = 6) {
  const dh = R.fogDayHash(day);
  return Array.from({ length: n }, (_, i) => ({
    topic: CONCEPTS[i % CONCEPTS.length], original: ORIG_A, others: OTHERS, names: ['분수'],
    seed: (uid * 31 + dh + i) >>> 0, boss: false,
  }));
}
const pattern = (plans) => plans.map(p => (p.fogged ? 'F' : 'R')).join('');

await test('탑(한 번의 탑): 안개 가능한 일반 층이 2개 이상이면 한 덱 안에 안개 층과 원래 말 층이 함께 있다', async () => {
  let checked = 0;
  for (let uid = 1; uid <= 300; uid++) {
    const plans = R.planDeck(deckInputs(uid, '2026-11-27'), uid + '|2026-11-27');
    const ord = plans.filter(p => p.canFog && p.strategy !== 'none');
    if (ord.length < 2) continue;
    checked++;
    const f = ord.filter(p => p.fogged).length;
    assert.ok(f >= 1 && f <= ord.length - 1, `uid ${uid}: 한 덱이 한쪽으로만 몰림 (${pattern(plans)})`);
  }
  assert.ok(checked > 250, `표본 부족: ${checked}`);
});
await test('탑(한 번의 탑): 같은 사용자의 덱 패턴은 날마다 달라지고, 0번 층 상태가 날짜와 무관하게 고정되지 않는다', async () => {
  const uid = 42;
  const pats = new Set();
  for (let d = 1; d <= 30; d++) {
    const day = '2026-11-' + String(d).padStart(2, '0');
    pats.add(pattern(R.planDeck(deckInputs(uid, day), uid + '|' + day)));
  }
  assert.ok(pats.size >= 8, `30일 동안 덱 패턴이 ${pats.size}가지뿐이다`);
  const first = new Set([...pats].map(p => p[0]));
  assert.equal(first.size, 2, '0번 층이 항상 같은 상태다');
});
await test('탑(한 번의 탑): 사용자마다 패턴이 다양하다(고정 비트·층 번호 규칙이 아님)', async () => {
  const pats = new Map();
  for (let uid = 1; uid <= 300; uid++) {
    const p = pattern(R.planDeck(deckInputs(uid, '2026-11-27'), uid + '|2026-11-27'));
    pats.set(p, (pats.get(p) || 0) + 1);
  }
  assert.ok(pats.size >= 20, `서로 다른 패턴이 ${pats.size}개뿐이다`);
  const top = Math.max(...pats.values());
  assert.ok(top / 300 < 0.25, `가장 흔한 패턴이 ${((top / 300) * 100).toFixed(1)}% 를 차지한다`);
});
await test('탑: 안개가 가능한 덱은 안개 층이 최소 하나 있다(전부 원래 말인 덱 금지)', async () => {
  for (let uid = 1; uid <= 200; uid++) {
    const plans = R.planDeck(deckInputs(uid, '2026-11-27', 3), uid + '|2026-11-27');
    if (plans.some(p => p.canFog)) assert.ok(plans.some(p => p.fogged), `uid ${uid}: 안개 가능한데 안개 층 0`);
  }
});
await test('탑: 주말 BOSS 층은 reveal 을 무시하고 항상 안개다', async () => {
  for (let seed = 0; seed < 30; seed++) {
    const p = R.planFloor({ topic: 'A', original: '빛은 반짝여.', others: [{ topic: '온도', concept: '따뜻함' }], names: ['빛'], seed, boss: true, reveal: true });
    assert.equal(p.fogged, true, `seed ${seed}: BOSS 층이 안개가 아님`);
  }
});
await test('탑: 같은 입력이면 같은 덱(GET/POST 가 같은 문장을 본다)', async () => {
  const a = pattern(R.planDeck(deckInputs(7, '2026-11-27'), '7|2026-11-27'));
  const b = pattern(R.planDeck(deckInputs(7, '2026-11-27'), '7|2026-11-27'));
  assert.equal(a, b);
});

// ---------- 6. 버전 일관성 ----------
// 현재 릴리스 minor. 버전을 올릴 때 package.json · index.html · HANDOFF.md 와 함께 이 값도 올린다.
const CURRENT_MINOR = '1.83';
await test('버전: package.json · index.html · HANDOFF.md 가 현재 릴리스(1.83)를 가리키고 서로 같다', async () => {
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
  assert.equal(htmlV, CURRENT_MINOR, `현재 릴리스는 ${CURRENT_MINOR} 인데 index.html 은 v${htmlV}`);
  assert.equal(pkgMinor, CURRENT_MINOR, `package.json 이 ${CURRENT_MINOR} 이 아니다`);
  // ?v= 캐시 버스터는 세 곳이 같아야 한다(HANDOFF §10)
  const busters = [...html.matchAll(/\?v=([\w]+)/g)].map(m => m[1]);
  assert.ok(busters.length >= 3 && new Set(busters).size === 1, `?v= 불일치: ${busters}`);
});

// ---------- 결과 ----------
const failed = results.filter(r => !r.ok);
console.log(`\n단위 테스트: ${results.length - failed.length} PASS / ${failed.length} FAIL`);
for (const f of failed) console.log(' - ' + f.name + ' :: ' + f.err.split('\n')[0]);
process.exitCode = failed.length ? 1 : 0;
