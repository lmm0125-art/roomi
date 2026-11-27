// 설명 판정(teach-back verifier) 벤치마크 — 실제 서버(실제 키)에 설명을 보내 저장된 판정을 센다. (v1.85)
//   사용법: BASE_URL=http://127.0.0.1:3931 node scripts/verifier-bench.mjs [dataset.json]
//   · 데이터: scripts/verifier-dataset.json (카드·범주·문장). 범주: correct(검증돼야 함) · loose·wrong(검증되면 안 됨).
//   · 키는 서버가 프로젝트의 키 파일/환경변수로 읽는다. 이 스크립트는 키를 다루지 않고 출력하지도 않는다.
//   · 각 설명은 새 계정으로 보낸다(하루 설명 한도·기억 간섭을 피하려고).
//   · 판정 = 응답 직후 /api/memory 의 source. 응답 지연으로 게이트(≈0초) / LLM(≈1초) / 시간 초과(≥8초) 를 구분한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3931';
const here = path.dirname(fileURLToPath(import.meta.url));
const dataFile = process.argv[2] || path.join(here, 'verifier-dataset.json');
const items = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
const j = async (p, o = {}) => {
  const r = await fetch(BASE + p, { method: o.m || 'GET', headers: { 'Content-Type': 'application/json', ...(o.t ? { 'X-Token': o.t } : {}) }, body: o.b ? JSON.stringify(o.b) : undefined });
  return { s: r.status, d: await r.json().catch(() => null) };
};
const rows = [];
let i = 0;
for (const it of items) {
  i++;
  const u = (await j('/api/user', { m: 'POST', b: { nickname: 'vb' + Date.now().toString(36).slice(-6) + i } })).d.user;
  const t0 = Date.now();
  const r = await j('/api/chat/explain', { m: 'POST', t: u.token, b: { concept: it.card, text: it.text } });
  const sec = Number(((Date.now() - t0) / 1000).toFixed(2));
  const mem = await j('/api/memory', { t: u.token });
  const taught = ((mem.d && mem.d.memories) || []).find(m => m.kind === 'taught');
  const source = taught ? taught.source : '(none)';
  const verified = source === 'explain:verified';
  // ambiguous: 라벨이 불분명한 문장(채점 제외). 결과는 기록만 한다.
  const expected = it.cat === 'correct';
  const kind = it.cat === 'ambiguous' ? (verified ? 'ambiguous_verified' : 'ambiguous_unverified') : (verified === expected ? 'ok' : (expected ? 'FALSE_REJECT' : 'FALSE_ACCEPT'));
  rows.push({ card: it.card, cat: it.cat, text: it.text, http: r.s, sec, source, verified, kind });
  console.log(JSON.stringify({ card: it.card, cat: it.cat, sec, source, result: kind, text: it.text }));
}
// 카드별 요약
const byCard = {};
for (const r of rows) {
  const c = (byCard[r.card] = byCard[r.card] || { n: 0, false_accept: 0, false_reject: 0, secs: [] });
  c.n++; c.secs.push(r.sec);
  if (r.kind === 'FALSE_ACCEPT') c.false_accept++;
  if (r.kind === 'FALSE_REJECT') c.false_reject++;
}
for (const [card, c] of Object.entries(byCard)) {
  c.secs.sort((a, b) => a - b);
  c.median_sec = c.secs[Math.floor(c.secs.length / 2)];
  c.max_sec = c.secs[c.secs.length - 1];
  delete c.secs;
  console.log(JSON.stringify({ card, ...c }));
}
const total = {
  n: rows.length,
  false_accept: rows.filter(r => r.kind === 'FALSE_ACCEPT').length,
  false_reject: rows.filter(r => r.kind === 'FALSE_REJECT').length,
  median_sec: rows.map(r => r.sec).sort((a, b) => a - b)[Math.floor(rows.length / 2)],
  max_sec: Math.max(...rows.map(r => r.sec)),
  gated_under_0_1s: rows.filter(r => r.sec < 0.1).length,
};
console.log(JSON.stringify({ TOTAL: total }));
