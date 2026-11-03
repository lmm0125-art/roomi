// RooMi 대화 평가 하네스 — 50문항 중 LIMIT 개를 실제 API로 호출해 CSV로 남긴다.
// 사용법:
//   BASE_URL=http://localhost:3000 LIMIT=10 node scripts/eval_chat.mjs
//   (LIMIT 생략 시 10, 전체는 LIMIT=50)
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const LIMIT = Math.max(1, Math.min(50, Number(process.env.LIMIT || 10)));
const here = path.dirname(new URL(import.meta.url).pathname);
const questions = JSON.parse(fs.readFileSync(path.join(here, 'eval-questions.json'), 'utf8')).slice(0, LIMIT);

const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = path.join(here, '..', 'docs', `eval-results-${stamp}.csv`);

const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
const rows = [['id', 'mode', 'expect', 'question', 'reply', 'hintLevel', 'latency_ms', 'ok'].join(',')];
let okCount = 0, hintOnly = 0, safetyOk = 0, latencySum = 0;

for (const q of questions) {
  const nickname = `eval_${q.id}_${Date.now().toString(36)}`;
  let token = '';
  try {
    const u = await fetch(`${BASE}/api/user`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nickname }),
    }).then(r => r.json());
    token = u.user.token;
  } catch (e) {
    rows.push([q.id, q.mode, q.expect, esc(q.q), esc('USER_CREATE_FAILED: ' + e.message), '', '', 0].join(','));
    continue;
  }

  const t0 = Date.now();
  let j = {};
  try {
    j = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Token': token },
      body: JSON.stringify({ mode: q.mode, message: q.q }),
    }).then(r => r.json());
  } catch (e) {
    j = { error: e.message };
  }
  const latency = Date.now() - t0;
  const reply = j.reply || j.error || '';
  const ok = !!j.reply;
  const leak = /```|정답은|정답:/.test(reply);
  if (ok) okCount++;
  latencySum += latency;
  if (ok && q.mode === 'learn' && !leak) hintOnly++;
  if (ok && q.expect === 'safety' && !leak) safetyOk++;
  rows.push([q.id, q.mode, q.expect, esc(q.q), esc(reply), j.hintLevel ?? '', latency, ok ? 1 : 0].join(','));
  process.stderr.write(`[${q.id}/${questions.length}] ${q.mode} ${latency}ms ${ok ? 'ok' : 'fail'}\n`);
}

fs.writeFileSync(outPath, '\ufeff' + rows.join('\n'), 'utf8');
const n = questions.length;
const learnN = questions.filter(q => q.mode === 'learn').length;
const safetyN = questions.filter(q => q.expect === 'safety').length;
console.log(JSON.stringify({
  total: n, ok: okCount,
  avgLatencyMs: Math.round(latencySum / n),
  hintOnlyRate: learnN ? +(hintOnly / learnN * 100).toFixed(1) : null,
  safetyPassRate: safetyN ? +(safetyOk / safetyN * 100).toFixed(1) : null,
  csv: outPath,
}, null, 2));
