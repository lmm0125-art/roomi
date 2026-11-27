// RooMi 학습 규칙 — 순수 함수 모음(DB·네트워크 없음). server.js 가 가져다 쓰고, tests/ 가 직접 검증한다.
//   ★ 2026-11-27 (v1.82) 추출: 예전엔 server.js 안에 묻혀 있어 자동 테스트가 불가능했다.
//   여기 있는 함수는 입력만으로 결과가 정해진다(결정론). 호출부가 DB 값(이름·카드 등)을 넘겨준다.
'use strict';

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

// 검증 — deps.callLLM(prompt, opts) → { text } | null, deps.parseChatJSON(raw) → object | null.
//   LLM 이 없거나 실패하면 규칙 판정. 반환: { ok, reply, source:'llm'|'rule'|'nocard' }
//   카드의 정답 토큰(hint_l3·퀴즈 정답)은 프롬프트·규칙 어디에도 쓰지 않는다(analogy·hint_l2 까지만).
async function checkTeachBack(text, concept, card, deps){
  const d = deps || {};
  const t = String(text || '');
  const short = t.length > 38 ? t.slice(0, 38) + '…' : t;
  const replyOk = () => `«${short}» 라고 설명했구나. 그럼 만약 ${concept}에서 숫자가 하나 바뀌면 어떻게 될까?`;
  const replyGap = () => {
    const ana = card && card.analogy ? String(card.analogy).split(/[,.]/)[0].trim().slice(0, 30) : '';
    return ana
      ? `«${short}» 라고 생각했구나. 만약 ${concept}를 ${ana}처럼 생각하면 어떻게 될까?`
      : `«${short}» 라고 했구나. 만약 ${concept}가 다르게 움직이면 어떻게 될까?`;
  };
  if(!card) return { ok:false, reply: replyGap(), source:'nocard' };
  // 1) LLM 판정 — 출력 JSON {"ok":true|false,"reply":"..."}
  if(typeof d.callLLM === 'function'){
    try{
      const ref = [card.analogy, card.hint_l2].map(s => String(s || '').trim()).filter(Boolean).join(' ');
      const prompt = `너는 7-11세 아이의 학습 친구 '루미'다. 개념 «${concept}»의 핵심 정의(참고): ${ref}
[아이의 설명] ${t}
판정: 아이 설명의 핵심이 위 정의와 어긋나는 말이 없으면 ok=true, 어긋나는 말이 있으면 ok=false.
규칙: 1) 아이 표현을 «그대로» 한 번 되받아라. 칭찬·평가·점수는 금지. 2) 설명에서 한 군데만 골라 «만약 ~라면?» 질문 1개(어긋난 부분이 있으면 그곳을 겨냥). 3) 2문장, 80자 이내, 존댓말. 정답을 말하지 마라.
JSON만: {"ok":true 또는 false,"reply":"..."}`;
      const er = await d.callLLM(prompt, { temperature:0.2, maxTokens:220, json:true });
      const j = typeof d.parseChatJSON === 'function' ? d.parseChatJSON(er ? er.text : null) : null;
      if(j && typeof j.ok === 'boolean'){
        const ok = j.ok;
        return { ok, reply: String(j.reply || '').trim() || (ok ? replyOk() : replyGap()), source:'llm' };
      }
    }catch(e){ /* 폴백 */ }
  }
  // 2) 규칙 판정 — 핵심어 2개 이상 + 흔한 오개념 표지 없음
  const hits = teachKeywordsFor(card, concept, d.aliases).filter(k => t.includes(k)).length;
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
  teachKeywordsFor, hasMisconceptionMarker, checkTeachBack, MISCONCEPTION_MARKERS,
  TOWER_FLOOR_MAX, FOG_FLIP_PAIRS, fogFlipAt, fogDayHash, fogApplyStrategy, planFloor, planDeck, mixHash,
};
