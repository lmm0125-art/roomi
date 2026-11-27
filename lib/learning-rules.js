// RooMi 학습 규칙 — 순수 함수 모음(DB·네트워크 없음). server.js 가 가져다 쓰고, tests/ 가 직접 검증한다.
//   ★ 2026-11-27 (v1.82) 추출: 예전엔 server.js 안에 묻혀 있어 자동 테스트가 불가능했다.
//   여기 있는 함수는 입력만으로 결과가 정해진다(결정론). 호출부가 DB 값(이름·카드 등)을 넘겨준다.
'use strict';
const { aliasHit } = require('./card-aliases.js');

// ---------- 날짜·기억 감쇠 ----------
// 두 KST 날짜(YYYY-MM-DD) 사이의 일수. b 가 a 보다 미래면 양수(0 = 같은 날).
function daysBetween(a, b){
  const ta = Date.parse(String(a) + 'T00:00:00Z');
  const tb = Date.parse(String(b) + 'T00:00:00Z');
  if(!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.floor((tb - ta) / 86400000);
}

// ★ 간격 반복: 잊히는 속도는 «기억의 안정도(stability)» 로 나눈다.
//   stability = 2^(reinforce-1) × (숙련도 ≥0.75 면 1.5), 상한 6. 처음 가르친 등불은 1(예전과 동일).
function fogStability(lamp){
  const r = Math.max(1, Math.min(3, Number(lamp.reinforce) || 1));
  const mastery = Number(lamp.mastery) || 0;
  const s = Math.pow(2, r - 1) * (mastery >= 0.75 ? 1.5 : 1);
  return Math.max(1, Math.min(6, s));
}

// 감쇠 순수 함수 — (등불 행, 오늘) 만으로 0~100 을 계산한다.
//   유효 경과일 = floor(d / stability). 단계표: 1일 10 · 2일 25 · 3일 45 · 이후 +10/일, 상한 100.
//   crystal=1 → 0. immune_day=오늘 → 0. 최종 = min(100, base + extra_decay).
function fogDecay(lamp, day){
  try{
    if(Number(lamp.crystal) === 1) return 0;
    if(lamp.immune_day && String(lamp.immune_day) === String(day)) return 0;
    const lit = String(lamp.lit_day || '');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(lit)) return 100;
    const d = daysBetween(lit, day);
    const eff = d > 0 ? Math.floor(d / fogStability(lamp)) : 0;
    let base = 0;
    if(eff === 1) base = 10;
    else if(eff === 2) base = 25;
    else if(eff >= 3) base = 45 + (eff - 3) * 10;
    const extra = Math.max(0, Math.min(50, Number(lamp.extra_decay) || 0));
    return Math.min(100, base + extra);
  }catch(e){ return 0; }
}

// ---------- 이해 확인 판정 (버그 2) ----------
// «이해했다» 는 말인지: 질문형·부정형은 확인이 아니다.
function isGotIt(msg){
  const m = String(msg || '').trim();
  if(!/(알겠|이해했|맞았|맞아|다 했|풀었)/.test(m)) return false;
  if(/[?？]/.test(m)) return false;                                  // 질문형 — «맞아?» 는 확인이 아님
  if(/(맞아|맞니|맞나|맞지|맞을까)\s*$/.test(m)) return false;      // 물음 어미 없이 끝나는 질문
  if(/(못|안|않|전혀)\s*(풀|알|이해|맞|했|해)|모르|몰라/.test(m)) return false;  // 부정형
  return true;
}

// ---------- 한국어 조사 ----------
// 받침 있는 말의 «이라는/라는» 선택 (기존 koIraNeun 과 같은 규칙).
function koIraNeun(word){
  const last = String(word || '').slice(-1);
  if(!/[가-힣]/.test(last)) return '이라는';
  return ((last.charCodeAt(0) - 0xAC00) % 28 === 0) ? '라는' : '이라는';
}
// 짝 조사 맞춤 — 단어 받침 유무로 은/는·이/가·을/를 고른다(v1.81 버그: 개념 교체 뒤 조사가 틀림).
const KO_JOSA_PAIRS = { '은':['은','는'], '는':['은','는'], '이':['이','가'], '가':['이','가'], '을':['을','를'], '를':['을','를'] };
function koJosaFix(word, josa){
  const pair = KO_JOSA_PAIRS[String(josa || '')];
  if(!pair) return String(josa || '');
  const last = String(word || '').slice(-1);
  if(!/[가-힣]/.test(last)) return pair[1];        // 한글이 아니면 받침 없음 취급
  const hasBatchim = ((last.charCodeAt(0) - 0xAC00) % 28) !== 0;
  return hasBatchim ? pair[0] : pair[1];
}
function fogEscapeRe(s){ return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------- L1 되묻기 회전 (v1.81) ----------
//   카드의 hint_l1 + 미리 쓴 2문장을 세션 턴 수로 돌려 쓴다(모델 호출 0). 접두사 «같이 생각해 보자.» 는 호출부가 붙인다.
function l1LineFor(card, concept, turns){
  const c = String(concept || '').trim() || '이것';
  const base = card && String(card.hint_l1 || '').trim();
  const pool = [base, `${c}${koJosaFix(c, '을')} 한 단계씩 같이 볼까, 아니면 예시부터 볼까?`,
    `${c}에서 어느 부분이 제일 헷갈려? 숫자야, 말이야?`].filter(Boolean);
  return pool[Math.abs(Number(turns) || 0) % pool.length];
}

// ---------- teach-back 검증 (v1.81 버그 4) ----------
//   핵심어: 카드의 개념명·주제·태그·별칭(2글자 이상). aliases = CARD_ALIASES 객체(서버에서 넘긴다).
function teachKeywordsFor(card, concept, aliases){
  const words = new Set();
  const add = (s) => String(s || '').split(/[\s,·/]+/).map(x => x.trim()).filter(x => x.length >= 2).forEach(x => words.add(x));
  if(card){
    add(card.concept); add(card.topic);
    add(String(card.tags || '').replace(/,/g, ' '));
    for(const a of ((aliases && aliases[card.topic]) || [])) if(a) add(a);
  }
  add(concept);
  return [...words];
}

// 규칙 폴백의 «흔한 오개념» 표지: 크기 방향을 잘못 묶은 말(«분모가 클수록…», «분자 다 크면…»).
//   키워드가 2개 이상 맞아도 이 표지가 있으면 틀린 설명으로 본다(키워드만으로는 통과해 버린다).
const MISCONCEPTION_MARKERS = [
  /(분모|분자|수|값|숫자)[^.!?]{0,8}(클수록|작을수록|크면|작으면|많을수록|적을수록)/,
  /(더 큰 수|더 작은 수)[이야다]?/,
];
function hasMisconceptionMarker(text){
  return MISCONCEPTION_MARKERS.some(re => re.test(String(text || '')));
}

// ★ 2026-11-27 (v1.83): 아이 화면에는 «맞다/틀리다» 를 드러내지 않는다. 모델 답에 판정 표현이 있으면 중립 문장으로 바꾼다.
//   (실제 검증에서 «맞아, 분모가 같으면…» 이 나와 판정이 아이에게 새는 것을 확인했다)
const EVAL_RE = /맞아|맞았|맞다|맞고|맞는|맞지|틀렸|틀려|틀린|틀리|아니야|아니에요|아니지|정답|잘했|잘 했|훌륭|대단|완벽|정확/;
function hasEvalWord(text){ return EVAL_RE.test(String(text || '')); }

// ★ 2026-11-27 (v1.85) 결정적 게이트 — LLM 을 부르기 전에 «카드와 모순되는 설명» 을 거른다.
//   카드별 규칙: anchors(이 중 하나가 같은 절에 있어야 함) · badOps(anchor 근처 14~24자 안의 금지 연산 어간) ·
//   phrases(절 안의 구체적 오개념 문구). 어느 것이든 맞으면 거절. 절에 부정·금지(아니·안·않·못·지 마) 가 있으면 통과.
//   좁게 둔다: 일반 단어(더하다·크다 등)는 단독으로 쓰지 않고, 긴 구절만 phrases 에 넣는다.
const FRACTION_ANCHORS = ['분자', '분모'];
const CARD_OP_RULES = {
  // 분수: 분자·분모에 빼기·곱하기·나누기를 하면 덧셈 설명과 모순(곱셈 설명은 다른 카드)
  '분수의 덧셈': { anchors: FRACTION_ANCHORS, badOps: ['빼', '뺄', '빼고', '빼서', '곱하', '곱해', '곱셈', '나누', '나눠'], phrases: [] },
  // 약분·통분: 분자·분모를 더하거나 빼서 약분·통분하지 않는다(곱·나눗셈만 쓴다)
  '약분·통분': { anchors: FRACTION_ANCHORS, badOps: ['더하', '더해', '빼', '뺄'], phrases: ['약분은 더', '통분은 더'] },
  // 소수: 자릿수가 많다고 더 큰 소수가 아니다
  '소수': { anchors: ['소수', '자릿수', '자리'], badOps: [], phrases: ['자릿수가 많을수록', '숫자가 길수록', '길면 더 큰', '자리가 많으면 그 소수가 더', '자리가 많을수록 큰'] },
  // 도형 넓이: 넓이는 가로와 세로를 곱한다(더하지 않는다). 둘레와 넓이는 같지 않다
  '도형 넓이': { anchors: ['넓이', '넓을수록', '둘레'], badOps: ['더하', '더해'], phrases: ['둘레와 넓이가 항상 같', '넓을수록 둘레도 항상', '둘레와 넓이는 같'] },
  '각도': { anchors: ['각도', '각이', '각은'], badOps: [], phrases: ['길수록 각도', '변이 길면 각', '길면 각이 커', '길수록 각이 커'] },
  // 리스트·배열: 번호는 0부터 시작한다(인덱스 1 시작 금지)
  '리스트': { anchors: ['리스트', '배열', '인덱스', 'index', '원소'], badOps: [], phrases: ['첫 번째는 1번', '첫 번째 원소는 1번', '1번부터 시작', '1번부터 세', '1부터 시작', '인덱스는 1부터', '인덱스가 1부터'] },
  // 산술: 나눗셈이 항상 작아지는 것은 아니다(1보다 큰 수로 나누면 작아진다)
  '산술 연산': { anchors: ['나누', '나눗셈'], badOps: [], phrases: ['나누면 항상 작아', '나누면 무조건 작아', '나눗셈은 항상 작아', '나누면 언제나 작아'] },
  // 변수: 변수 값은 바꿀 수 있다
  // 「숫자만 담는다」 류는 변수의 자료형 오개념(결과 확인은 모델보다 규칙이 먼저 본다)
  '변수': { anchors: ['변수'], badOps: [], phrases: ['바꿀 수 없', '바뀌지 않는 상자', '숫자만 담', '숫자만 넣', '숫자만 저장', '글자는 넣을 수 없', '글자는 담을 수 없'] },
  // 곱셈: 곱셈은 앞에서부터가 아니라 연산 순서를 따른다
  '곱셈 순서': { anchors: ['곱셈', '곱하'], badOps: [], phrases: ['앞에서부터 계산', '왼쪽부터 계산', '앞에서부터 차례로'] },
  '자석': { anchors: ['자석'], badOps: [], phrases: ['나무도 끌', '플라스틱도 끌', '플라스틱도 모두 끌', '종이도 끌', '모든 것을 끌', '모든 금속을 끌'] },
  '빛의 반사': { anchors: ['반사', '거울'], badOps: [], phrases: ['빛을 흡수', '빛을 만들'] },
  '식물 광합성': { anchors: ['광합성', '식물'], badOps: [], phrases: ['흙을 먹', '흙에서 먹', '흙에서 양분을 먹', '밤에 광합성', '밤에도 광합성'] },
  '지층': { anchors: ['지층'], badOps: [], phrases: ['위에 있는 지층이 더 오래', '위쪽에 있는 지층이 더 오래', '위쪽 지층이 더 오래', '바다에서만 만들', '산에는 없'] },
  '온도와 열': { anchors: ['온도', '열', '차가움', '추위', '냉기'], badOps: [], phrases: ['차가움이 옮겨', '추위가 옮겨', '냉기가 옮겨'] },
  '물의 상태': { anchors: ['물', '얼음', '수증기', '끓'], badOps: [], phrases: ['끓으면 물 분자가 사라', '끓으면 분자가 사라', '얼음은 뜨거워서'] },
  'RAM·ROM': { anchors: ['램', 'ram'], badOps: [], phrases: ['전원을 꺼도 남', '꺼도 기억이 남', '꺼도 내용이 남'] },
  'CPU 클록': { anchors: ['클록', '클럭', 'ghz'], badOps: [], phrases: ['무조건 빠르', '항상 빠르', '높으면 무조건', '높을수록 무조건'] },
  '압축': { anchors: ['압축'], badOps: [], phrases: ['정보가 늘어', '용량이 늘어나', '용량이 커지'] },
  '캐시': { anchors: ['캐시'], badOps: [], phrases: ['영구히 저장', '항상 남아'] },
  '운영체제 프로세스': { anchors: ['프로세스'], badOps: [], phrases: ['하나의 프로그램 파일', '프로그램 파일 하나'] },
  '네트워크 패킷': { anchors: ['패킷'], badOps: [], phrases: ['한 번에 통째로', '통째로 보내'] },
  '바이너리': { anchors: ['바이너리', '이진법', '0과 1'], badOps: [], phrases: ['0은 아무것도 없', '1은 아무것도 없'] },
  '함수': { anchors: ['함수'], badOps: [], phrases: ['항상 값을 돌려', '반드시 값을 돌려주'] },
  '반복문': { anchors: ['반복문', 'for', 'while'], badOps: [], phrases: ['한 번만 실행'] },
  'while 반복': { anchors: ['while'], badOps: [], phrases: ['횟수를 정해야', '횟수를 미리 정해'] },
  '조건문': { anchors: ['조건문', 'if'], badOps: [], phrases: ['거짓이어도 실행', '조건이 거짓이면 항상 실행'] },
  '문자열': { anchors: ['문자열', '글자'], badOps: ['빼', '뺄'], phrases: [] },
  'AI 윤리': { anchors: ['ai'], badOps: [], phrases: ['항상 공정', '완벽하게 공정'] },
};
const OP_NEGATION_RE = /(아니|안 |않|못 |지 마|지마|하지 말|하지마)/;   // 부정·금지 표현이 있으면 모순이 아니다(「분자를 곱하지 마」)
function contradictsCardOps(text, cardTopic){
  const rule = CARD_OP_RULES[String(cardTopic || '')];
  if(!rule) return null;
  const t = String(text || '').toLowerCase();
  // 소수점(0.45)에서는 끊지 않는다 — 마침표 뒤가 숫자이면 같은 절이다
  const clauses = t.split(/(?<!\d)[.!?。](?!\d)|그리고|하지만|그런데/);
  for(const cl of clauses){
    const at = rule.anchors.map(a => cl.indexOf(a)).filter(i => i >= 0);
    if(!at.length) continue;
    if(OP_NEGATION_RE.test(cl)) continue;
    for(const ph of rule.phrases){ if(cl.includes(ph)) return ph; }
    const first = Math.min(...at);
    for(const op of rule.badOps){
      const idx = cl.indexOf(op, first);
      if(idx < 0) continue;
      if(idx - first > 24) continue;                    // anchor 와 연산 사이가 24자 이내만
      return op;
    }
  }
  return null;
}

// 검증 — deps.callLLM(prompt, opts) → { text } | null, deps.parseChatJSON(raw) → object | null.
//   LLM 이 없거나 실패하면 규칙 판정. 반환: { ok, reply, source:'llm'|'rule'|'nocard' }
//   카드의 정답 토큰(hint_l3·퀴즈 정답)은 프롬프트·규칙 어디에도 쓰지 않는다(analogy·hint_l2 까지만).
// 시간 예산: 주어진 ms 안에 끝나지 않으면 code='TIMEOUT' 으로 거절한다. ms<=0 이면 제한 없음.
//   늦게 끝난 원 Promise 의 결과/오류는 버린다(처리되지 않은 거부가 새지 않게).
function withBudget(promise, ms){
  const p = Promise.resolve(promise);
  const limit = Number(ms) || 0;
  if(!(limit > 0)) return p;
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => { const e = new Error('teach-verify timeout'); e.code = 'TIMEOUT'; reject(e); }, limit);
  });
  p.catch(() => {});
  return Promise.race([p, guard]).finally(() => clearTimeout(timer));
}

// ★ 2026-11-27 (v1.83) 설명 저장 정책 — 순수 함수.
//   · 검증에 성공(LLM 또는 규칙이 맞다고 함)한 설명만 explain:verified(0.95).
//   · 시간 초과(source='timeout')는 아직 판정이 없으므로 항상 unverified 로 저장한다(나중에 업그레이드 가능).
//   · 이미 explain:verified 인 기억은 미검증 설명으로 덮어쓰지 않는다(감사 이력은 별도 결정 사항).
function teachStoragePlan(existingSource, verdict){
  const v = verdict || {};
  const verified = v.ok === true && v.source !== 'timeout' && v.source !== 'nocard';
  if(!verified && existingSource === 'explain:verified') return { write: false, source: null, confidence: null };
  return verified
    ? { write: true, source: 'explain:verified', confidence: 0.95 }
    : { write: true, source: 'explain:unverified', confidence: 0.4 };
}

async function checkTeachBack(text, concept, card, deps){
  const d = deps || {};
  const t = String(text || '');
  const short = t.length > 38 ? t.slice(0, 38) + '…' : t;
  const replyOk = () => `«${short}» 라고 설명했구나. 그럼 만약 ${concept}에서 숫자가 하나 바뀌면 어떻게 될까?`;
  const replyNeutral = () => `«${short}» 라고 했구나. 그럼 ${concept}를 다른 예로도 생각해 볼까?`;
  const replyGap = () => {
    const ana = card && card.analogy ? String(card.analogy).split(/[,.]/)[0].trim().slice(0, 30) : '';
    return ana
      ? `«${short}» 라고 생각했구나. 만약 ${concept}를 ${ana}처럼 생각하면 어떻게 될까?`
      : `«${short}» 라고 했구나. 만약 ${concept}가 다르게 움직이면 어떻게 될까?`;
  };
  if(!card) return { ok:false, reply: replyGap(), source:'nocard' };
  // 0) 결정적 게이트 — 카드와 모순되는 연산이면 LLM 을 부르지 않고 거절(미검증).
  const badOp = contradictsCardOps(t, card.topic);
  if(badOp){ return { ok:false, reply: replyGap(), source:'gate', reason: badOp }; }
  // 1) LLM 판정 — 출력 JSON {"ok":true|false,"reply":"..."}
  if(typeof d.callLLM === 'function'){
    try{
      const ref = [card.analogy, card.hint_l2].map(s => String(s || '').trim()).filter(Boolean).join(' ');
      const prompt = `너는 7-11세 아이의 학습 친구 '루미'다. 개념 «${concept}»의 핵심 정의(참고): ${ref}
[아이의 설명] ${t}
판정 순서(하나씩 확인하라). 각 항목은 «설명이 정의와 모순되는가» 만 본다. 빠뜨린 조건이나 짧은 설명은 모순이 아니다:
  ① operation: 설명이 말하는 연산(더하기·빼기·곱하기·나누기)이 정의의 연산과 다른가? 다르면 false. 특히 분수에서 분자와 분모를 «둘 다» 더하거나 빼거나 곱하라고 하면 정의와 다르므로 false.
  ② condition: 설명이 조건을 말했다면(예: 분모가 같다) 그 조건이 정의와 어긋나는가? 조건을 말하지 않은 것은 false 가 아니다.
  ③ result: 설명이 말하는 결과(무엇이 어떻게 되는가)가 정의와 «정면으로 반대»인가? 정의에 적혀 있지 않은 상식적인 결과(예: 새 값을 넣으면 예전 값이 사라진다)는 모순이 아니다. 정의를 뒤집을 때만 false.
  셋 중 모순이 하나도 없으면 ok=true. 모순이 있으면 ok=false.
규칙: 1) 아이 표현을 «그대로» 한 번 되받아라. 칭찬·평가·점수·«맞아/틀려/정답» 같은 판정 말은 절대 쓰지 마라(판정은 서버가 조용히 한다). 2) 설명에서 한 군데만 골라 «만약 ~라면?» 질문 1개(어긋난 부분이 있으면 그곳을 겨냥). 3) 2문장, 80자 이내, 존댓말. 정답을 말하지 마라.
JSON만: {"checks":{"operation":true 또는 false,"condition":true 또는 false,"result":true 또는 false},"ok":true 또는 false,"reply":"..."}`;
      // prefer:'fast' → DeepSeek 먼저(보통 1~2초). 1차 EXAONE 은 느려서 판정 예산 안에 못 끝나는 일이 잦다.
      const er = await withBudget(d.callLLM(prompt, { temperature:0.2, maxTokens:220, json:true, prefer:'fast' }), d.timeoutMs);
      const j = typeof d.parseChatJSON === 'function' ? d.parseChatJSON(er ? er.text : null) : null;
      if(j && typeof j.ok === 'boolean'){
        // 항목 확인(checks)이 하나라도 false 면 ok 와 상관없이 거절 — 모델이 «맞다» 고 해도 항목에서 걸리면 막는다.
        const checks = (j.checks && typeof j.checks === 'object') ? Object.values(j.checks) : [];
        const checksOk = checks.every(v => v !== false);
        const ok = j.ok === true && checksOk;
        const raw = String(j.reply || '').trim();
        // 판정 말이 섞였거나 비었으면 중립 문장(검증 결과가 화면에 새지 않게)
        const safe = raw && !hasEvalWord(raw) ? raw : replyNeutral();
        return { ok, reply: safe, source:'llm' };
      }
    }catch(e){
      // 시간 초과: 판정이 없다 → 규칙으로 답은 하되 저장은 미검증(나중에 LLM 으로 업그레이드할 수 있다)
      if(e && e.code === 'TIMEOUT'){
        const hits0 = teachKeywordsFor(card, concept, d.aliases).filter(k => aliasHit(t, k)).length;
        const ok0 = hits0 >= 2 && !hasMisconceptionMarker(t);
        return { ok:false, reply: ok0 ? replyOk() : replyGap(), source:'timeout', pending:true };
      }
    }
  }
  // 2) 규칙 판정 — 핵심어 2개 이상 + 흔한 오개념 표지 없음
  const hits = teachKeywordsFor(card, concept, d.aliases).filter(k => aliasHit(t, k)).length;
  const ok = hits >= 2 && !hasMisconceptionMarker(t);
  return { ok, reply: ok ? replyOk() : replyGap(), source:'rule' };
}

// ---------- 안개 속의 탑 — 층 문장 설계 (순수) ----------
const TOWER_FLOOR_MAX = 6;
// 안개 변형 쌍 — [원래 단어, 바뀔 단어, 조사 결합 허용 여부].
const FOG_FLIP_PAIRS = [
  ['모두', '일부', true], ['항상', '가끔'], ['있다', '없다'], ['먼저', '나중에'],
  ['더하면', '빼면'], ['나누면', '곱하면'], ['같으면', '다르면'], ['크다', '작다'],
];
// 단어 경계 문자(공백·문장부호) — 한글엔 \b 가 없어 «긴 단어 한복판» 교체를 막는다.
const FOG_EDGE_RE = /[\s.,!?…:;'"()«»\-]/;
const FOG_JOSA = '가을이는의로도만와과에서';

// 문장에서 from 을 «단어 경계에서만» to 로 바꾼다. 불가능하면 null.
function fogFlipAt(sentence, from, to, josaOk){
  const s = String(sentence);
  let idx = s.indexOf(from);
  while(idx >= 0){
    const before = idx === 0 ? '' : s[idx - 1];
    const afterCh = idx + from.length >= s.length ? '' : s[idx + from.length];
    const okBefore = before === '' || FOG_EDGE_RE.test(before);
    const okAfter = afterCh === '' || FOG_EDGE_RE.test(afterCh) || (!!josaOk && FOG_JOSA.includes(afterCh));
    if(okBefore && okAfter) return s.slice(0, idx) + to + s.slice(idx + from.length);
    idx = s.indexOf(from, idx + 1);
  }
  return null;
}

// 날짜 문자열 → 결정론적 해시(시드 재료)
function fogDayHash(day){
  return String(day).split('').reduce((a, ch) => (a * 131 + ch.charCodeAt(0)) >>> 0, 7);
}

// 왜곡 전략 1건 시행 — 불가능하면 null.
//   names: 문장에 실제 나오는 개념 이름 후보(서버가 DB 로 만들어 넘긴다). others: [{topic, concept}].
function fogApplyStrategy(name, topic, original, others, seed, names){
  if(name === 'flip'){
    for(let i = 0; i < FOG_FLIP_PAIRS.length; i++){
      const p = FOG_FLIP_PAIRS[(i + seed % FOG_FLIP_PAIRS.length) % FOG_FLIP_PAIRS.length];
      const out = fogFlipAt(original, p[0], p[1], !!p[2]);
      if(out && out !== original) return { strategy: 'flip', statement: out.slice(0, 80) };
    }
    return null;
  }
  if(name === 'graft'){
    if(!names || !names.length || !others.length) return null;
    const nm = names[seed % names.length];
    const other = others[seed % others.length];
    // 개념명 뒤 조사를 «새 이름의 받침» 에 맞춰 다시 고른다.
    const re = new RegExp(fogEscapeRe(nm) + '([은는이가을를])?');
    const out = String(original).replace(re, (m, josa) => other.topic + (josa ? koJosaFix(other.topic, josa) : ''));
    if(out !== original) return { strategy: 'graft', statement: out.slice(0, 80) };
    return null;
  }
  // swap — 개념 정의를 다른 카드 것으로 끼워 넣기
  const withConcept = others.find(o => o.concept && String(o.concept).trim());
  if(!withConcept) return null;
  const c = String(withConcept.concept).trim();
  return { strategy: 'swap', statement: `${topic}는 ${c}${koIraNeun(c)} 뜻이야.`.slice(0, 80) };
}

// 키 문자열 → 32비트 해시(FNV-1a + murmur 최종 혼합). 한 탑(uid|day) 안에서도 층마다 독립적으로 흩어진다.
function mixHash(key){
  let h = 0x811c9dc5;
  for(const ch of String(key)){ h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}

// 한 층 설계 — 순수 함수. input.reveal === true 이면 (일반 층에 한해) 안개 없이 원래 말을 보여 준다.
//   반환: { statement, fogged, canFog, original, strategy }
//   BOSS 층과 forceFog 는 reveal 을 무시하고 항상 안개다.
function planFloor(input){
  const { topic, original, others, names, seed, boss, forceFog, reveal } = input;
  const all = ['flip', 'graft', 'swap'];
  const st = seed % 3;
  const order = boss ? ['graft', 'swap', 'flip'] : [all[st], all[(st + 1) % 3], all[(st + 2) % 3]];
  let r = null;
  for(const nm of order){
    r = fogApplyStrategy(nm, topic, original, others, seed, names);
    if(r) break;
  }
  if(!r) return { statement: original, fogged: false, canFog: false, original, strategy: 'none' };
  if(!boss && !forceFog && reveal === true){
    return { statement: original, fogged: false, canFog: true, original, strategy: 'reveal' };
  }
  return { statement: r.statement, fogged: true, canFog: true, original, strategy: r.strategy };
}

// ★ 2026-11-27 (v1.83) 한 탑(한 사용자·하루) 전체 설계 — 층별 독립 해시 + 쏠림 보정.
//   · 일반 층의 reveal 은 mixHash(key|층번호) 로 정한다(층 번호나 고정 비트에 묶이지 않는다).
//   · 안개가 가능한 일반 층이 2개 이상인데 reveal 이 한쪽으로만 몰리면, 해시로 고른 한 층을 뒤집는다.
//     → 한 번의 탑 안에 «안개 층» 과 «원래 말 층» 이 함께 있다(해당 층이 2개 이상일 때 보장).
//   · 덱 전체에 안개 층이 하나도 없으면 안개가 가능한 첫 층을 강제로 안개로 만든다.
//   floors: [planFloor 입력(boss 제외)], key: 사용자·날짜 문자열. 반환: 층별 설계 배열.
function planDeck(floors, key){
  const list = floors || [];
  const probe = list.map(f => planFloor(Object.assign({}, f, { reveal: false })));
  const reveal = list.map((f, i) => (mixHash(String(key) + '|' + i) & 1) === 1);
  const ord = [];
  for(let i = 0; i < list.length; i++) if(!list[i].boss && probe[i].canFog) ord.push(i);
  if(ord.length >= 2){
    const n = ord.filter(i => reveal[i]).length;
    if(n === 0 || n === ord.length){
      const j = ord[mixHash(String(key) + '|flip') % ord.length];
      reveal[j] = !reveal[j];
    }
  }
  const plans = list.map((f, i) => planFloor(Object.assign({}, f, { reveal: reveal[i] })));
  if(list.length && !plans.some(p => p.fogged)){
    const idx = plans.findIndex(p => p.canFog);
    if(idx >= 0) plans[idx] = planFloor(Object.assign({}, list[idx], { forceFog: true }));
  }
  return plans;
}

module.exports = {
  daysBetween, fogStability, fogDecay,
  isGotIt,
  koIraNeun, koJosaFix, fogEscapeRe, KO_JOSA_PAIRS,
  l1LineFor,
  teachKeywordsFor, hasMisconceptionMarker, checkTeachBack, MISCONCEPTION_MARKERS, hasEvalWord, contradictsCardOps, CARD_OP_RULES,
  withBudget, teachStoragePlan,
  TOWER_FLOOR_MAX, FOG_FLIP_PAIRS, fogFlipAt, fogDayHash, fogApplyStrategy, planFloor, planDeck, mixHash,
};
