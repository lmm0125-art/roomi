// 설명 판정(teach-back verifier) 벤치마크 — 실제 서버(실제 키)에 설명을 보내 저장된 판정을 센다. (v1.83)
//   사용법: BASE_URL=http://127.0.0.1:3931 node scripts/verifier-bench.mjs
//   · 키는 서버가 프로젝트의 키 파일/환경변수로 읽는다. 이 스크립트는 키를 다루지 않고 출력하지도 않는다.
//   · 각 설명은 새 계정으로 보낸다(하루 설명 한도와 기억 간섭을 피하려고).
//   · 판정 = 응답 직후 /api/memory/list 의 source. 시간 초과(예산 초과)는 미검증으로 저장되므로
//     «응답 지연» 을 함께 적어 시간 초과와 실제 불합격을 구분할 수 있게 한다.
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3931';
const CONCEPT = '분수의 덧셈';
const SAMPLES = [
  // 맞는 설명 — 검증되어야 한다
  ['correct', '분모가 같으면 분자끼리 더하면 돼요'],
  ['correct', '분모가 같을 때는 위의 숫자끼리 더하고 아래 숫자는 그대로 둬'],
  ['correct', '분모가 같으면 분자만 더해서 답을 써'],
  ['correct', '피자를 같은 크기로 나눈 조각끼리 더하는 거야'],
  ['correct', '분모가 같으니까 분자를 더하면 되고 분모는 안 바뀌어'],
  // 헐겁게 쓴 오개념 — 검증되면 안 된다(핵심 항목)
  ['loose', '분모 분자 다 크면 분수도 커져'],
  ['loose', '위에 있는 수가 크면 분수는 더 큰 거지'],
  ['loose', '분모가 크면 조각도 커지니까 분수가 커져'],
  ['loose', '분자가 크면 분수가 커지고 분모는 상관없어'],
  ['loose', '큰 수에 큰 수를 더하면 분수도 커지는 거지'],
  ['loose', '분모랑 분자를 각각 더하면 분수 합이 돼'],
  // 분명한 오개념 — 검증되면 안 된다
  ['wrong', '분모가 클수록 더 큰 수야'],
  ['wrong', '분모랑 분자를 그냥 다 더하면 돼'],
  ['wrong', '분모끼리 더하면 돼'],
  ['wrong', '분자가 작을수록 분수가 커'],
];
const j = async (p, o = {}) => {
  const r = await fetch(BASE + p, { method: o.m || 'GET', headers: { 'Content-Type': 'application/json', ...(o.t ? { 'X-Token': o.t } : {}) }, body: o.b ? JSON.stringify(o.b) : undefined });
  return { s: r.status, d: await r.json().catch(() => null) };
};
const rows = [];
let i = 0;
// BENCH_SET=hard: 정답처럼 보이는 어휘로 쓴 오개념(키워드만으로는 가려내기 어려운 문장)
const HARD = [
  ['loose', '분모가 같을 때 분자를 더하는데 분모도 같이 더해야 해'],
  ['loose', '분모가 같으면 분자끼리 빼도 되고 더해도 돼'],
  ['loose', '분수는 분자가 크면 항상 더 큰 수야'],
  ['loose', '분모를 같게 만든 다음 분자를 곱하면 돼'],
  ['wrong', '1/2 + 1/3 은 분모끼리 더해서 2/5 야'],
  ['wrong', '분모가 같으면 답의 분모는 분모의 수를 더한 값이 돼'],
];
const SET = process.env.BENCH_SET === 'hard' ? HARD : SAMPLES;
for (const [cat, text] of SET) {
  i++;
  const u = (await j('/api/user', { m: 'POST', b: { nickname: 'vb' + Date.now().toString(36).slice(-6) + i } })).d.user;
  const t0 = Date.now();
  const r = await j('/api/chat/explain', { m: 'POST', t: u.token, b: { concept: CONCEPT, text } });
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  const mem = await j('/api/memory', { t: u.token });
  const taught = ((mem.d && mem.d.memories) || []).find(m => m.kind === 'taught');
  const source = taught ? taught.source : '(none)';
  const verified = source === 'explain:verified';
  const expected = cat === 'correct';
  rows.push({ cat, text, http: r.s, sec, source, verified, ok: verified === expected });
  console.log(JSON.stringify({ cat, http: r.s, sec, source, pass: verified === expected, text }));
}
const hit = (c) => rows.filter(r => r.cat === c);
const summary = {
  correct_verified: `${hit('correct').filter(r => r.verified).length}/${hit('correct').length}`,
  loose_stored_as_verified: hit('loose').filter(r => r.verified).length,
  loose_total: hit('loose').length,
  wrong_stored_as_verified: hit('wrong').filter(r => r.verified).length,
  wrong_total: hit('wrong').length,
  median_sec: rows.map(r => Number(r.sec)).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
  max_sec: Math.max(...rows.map(r => Number(r.sec))),
};
console.log(JSON.stringify(summary));
