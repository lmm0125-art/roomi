// ============================================================
// 새 미니게임 4종 — 루미 훈련소 · 균형 공방 · 어림 항해 · 거꾸로 질문소 (2026-11-28)
//   · 셀은 주지 않는다(메모의 «신규 시스템 셀 지급 금지» 결정). 서버 grantMiniGame 이 XP·도감만 준다.
//   · 서버는 점수의 범위만 검사한다. 게임 로직은 전부 여기서 돈다.
//   · app.js 의 $, $$, esc, api, bubble, toast, setBalance, refreshGrowth, tryClaimQuest, closeGame 을 쓴다.
// ============================================================
(function(){
  'use strict';

  // 게임별 타이머 — 창을 닫으면 MiniGames.stop(id) 가 전부 지운다(유령 타이머 방지)
  const timers = {};
  function tick(id, fn, ms){ clearTick(id); timers[id] = setInterval(fn, ms); }
  function clearTick(id){ if(timers[id]){ clearInterval(timers[id]); timers[id] = null; } }
  function rand(n){ return Math.floor(Math.random() * n); }
  function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=rand(i+1); [a[i],a[j]]=[a[j],a[i]]; } return a; }
  function h(tag, cls, html){ const e = document.createElement(tag); if(cls) e.className = cls; if(html != null) e.innerHTML = html; return e; }

  // 결과 제출: 서버가 XP·도감을 준다. 같은 게임은 하루 한 번만 기록되고, 연습은 계속할 수 있다.
  async function submit(kind, score, box, unlockOk){
    box.innerHTML = '<p class="ng-note">결과를 루미에게 전하는 중…</p>';
    let r = null, msg = '';
    try{
      r = await api('/api/game/result', { kind, score }, 12000);
      if(r.balance != null && state.user){ state.user.cell_balance = r.balance; setBalance(r.balance); }
      if(r.growth){ state.growth = { ...state.growth, ...r.growth, partBonus: state.growth.partBonus || 0 }; await refreshGrowth(); }
      msg = `<b class="ng-big">+${(r.growth && r.growth.exp) || 0} XP</b>`;
      if(r.codexUnlocked) msg += `<span class="ng-codex">📖 지식 도감에 «${esc(r.codexUnlocked)}» 카드가 열렸어!</span>`;
      else if(unlockOk === false) msg += '<span class="ng-codex">조금만 더 하면 도감 카드가 열려요.</span>';
    }catch(e){
      // 오늘 이미 기록한 게임(400)이면 연습 결과로 안내한다
      msg = `<span class="ng-codex">${esc(e.message || '기록을 전하지 못했어요')}</span>`;
    }
    box.innerHTML = `<div class="ng-result"><span class="ng-score">${score}점</span>${msg}</div>`;
    try{ if(state.quest) await tryClaimQuest({ kind, score }); }catch(e){}
    return r;
  }

  // ───────────────────────── 1. 루미 훈련소 ─────────────────────────
  // 아이가 루미에게 «규칙» 을 예시로 가르친다. 루미는 가장 단순한 생각부터 맞춰 본다.
  // 예시가 한쪽으로 치우치면 루미는 엉뚱한 규칙을 고른다 — 그걸 보고 예시를 고치는 게 놀이다.
  const ROOMI_RULES = [
    { name:'짝수', test:n => n % 2 === 0 },
    { name:'3의 배수', test:n => n % 3 === 0 },
    { name:'10보다 큰 수', test:n => n > 10 }
  ];
  // 루미가 떠올리는 생각 후보(단순한 것부터). 정답 규칙이 뒤에 있어도 예시와 맞는 첫 후보를 고른다.
  const ROOMI_GUESSES = [
    { name:'짝수', test:n => n % 2 === 0 },
    { name:'홀수', test:n => n % 2 === 1 },
    { name:'10보다 큰 수', test:n => n > 10 },
    { name:'10보다 작은 수', test:n => n < 10 },
    { name:'3의 배수', test:n => n % 3 === 0 }
  ];
  const ROOMI_MAX_EX = 6;
  const roomi = { rule:null, cards:[], ex:new Map(), guess:null, box:null, done:false };

  function roomiStart(box){
    roomi.rule = ROOMI_RULES[rand(ROOMI_RULES.length)];
    const pool = shuffle(Array.from({ length: 24 }, (_, i) => i + 1));
    roomi.cards = pool.slice(0, 12).sort((a, b) => a - b);
    roomi.ex = new Map(); roomi.guess = null; roomi.done = false; roomi.box = box;
    roomiRender();
  }
  function roomiRender(){
    const box = roomi.box; if(!box) return;
    const n = roomi.ex.size;
    box.innerHTML = '';
    box.append(h('p', 'ng-goal', `목표 규칙: <b>${roomi.rule.name}</b> — 루미에게 예시를 보여 줘. 최대 ${ROOMI_MAX_EX}장`));
    const grid = h('div', 'ng-cards');
    roomi.cards.forEach(c => {
      const b = h('button', 'rm-card' + (roomi.ex.has(c) ? ' picked' : '') + (roomi.done && roomi.guess ? (roomi.guess.test(c) === roomi.rule.test(c) ? ' right' : ' wrong') : ''), String(c));
      b.type = 'button';
      b.disabled = roomi.done || (!roomi.ex.has(c) && n >= ROOMI_MAX_EX);
      if(roomi.ex.has(c)) b.insertAdjacentHTML('beforeend', `<i>${roomi.ex.get(c) ? '⭕' : '❌'}</i>`);
      if(roomi.done && roomi.guess) b.insertAdjacentHTML('beforeend', `<em>${roomi.guess.test(c) ? '루미 ○' : '루미 ✕'}</em>`);
      b.addEventListener('click', () => roomiPick(c));
      grid.appendChild(b);
    });
    box.appendChild(grid);
    box.appendChild(h('p', 'ng-status', `예시 ${n}/${ROOMI_MAX_EX}${roomi.guess ? ` · 루미는 「${roomi.guess.name}」 이라고 생각했어요` : ''}`));
    const go = h('button', 'btn primary big ng-go', roomi.guess ? '다시 가르치기' : '루미에게 가르치기');
    go.type = 'button'; go.disabled = roomi.done || n === 0;
    go.addEventListener('click', roomiTeach);
    box.appendChild(go);
  }
  function roomiPick(c){
    if(roomi.done || roomi.ex.has(c) || roomi.ex.size >= ROOMI_MAX_EX) return;
    roomi.ex.set(c, roomi.rule.test(c));   // 아이가 고른 카드에 정답(⭕/❌)이 붙는다
    roomi.guess = null;                    // 예시가 바뀌면 루미의 생각도 다시 본다
    roomiRender();
  }
  async function roomiTeach(){
    const exs = [...roomi.ex.entries()];
    const guess = ROOMI_GUESSES.find(g => exs.every(([c, ok]) => g.test(c) === ok)) || null;
    roomi.guess = guess;
    const wrong = roomi.cards.filter(c => !guess || guess.test(c) !== roomi.rule.test(c)).length;
    if(guess && wrong === 0){
      roomi.done = true;
      roomiRender();
      const n = roomi.ex.size;
      const score = Math.max(12, 60 - 8 * (n - 1));
      await submit('roomi', score, roomi.box, score >= 30);
      return;
    }
    if(roomi.ex.size >= ROOMI_MAX_EX){
      roomi.done = true;
      roomiRender();
      await submit('roomi', 10, roomi.box, false);
      return;
    }
    roomiRender();
    const note = h('p', 'ng-note', guess
      ? `루미가 「${guess.name}」 이라고 생각했어. 틀린 카드가 ${wrong}장 있어. 예시를 더 보여 줄래?`
      : '루미가 아직 감을 못 잡았어. 예시를 더 보여 줄래?');
    roomi.box.appendChild(note);
  }

  // ───────────────────────── 2. 균형 공방 ─────────────────────────
  // 저울의 한쪽에는 무게(분수·소수)가 있다. 블록을 올려 반대쪽을 똑같이 맞춘다. 단위: 1/8.
  const BAL_LEVELS = [
    { target:6, label:'3/4', min:2, tray:[{v:4,l:'1/2',n:2},{v:2,l:'1/4',n:3},{v:2,l:'0.25',n:2},{v:1,l:'1/8',n:4}] },
    { target:4, label:'0.5', min:1, tray:[{v:2,l:'1/4',n:2},{v:2,l:'0.25',n:2},{v:1,l:'1/8',n:4},{v:4,l:'1/2',n:1}] },
    { target:7, label:'0.875', min:3, tray:[{v:4,l:'1/2',n:1},{v:2,l:'1/4',n:2},{v:1,l:'1/8',n:3},{v:1,l:'0.125',n:1}] }
  ];
  const bal = { lv:0, placed:[], left:[], total:0, box:null, cleared:false };

  function balStart(box){
    bal.lv = 0; bal.total = 0; bal.box = box;
    balLevel();
  }
  function balSum(){ return bal.placed.reduce((s, b) => s + b.v, 0); }
  function balLevel(){
    const L = BAL_LEVELS[bal.lv];
    bal.placed = []; bal.cleared = false;
    bal.left = L.tray.map(t => ({ ...t }));
    balRender();
  }
  function balRender(){
    const box = bal.box; if(!box) return;
    const L = BAL_LEVELS[bal.lv];
    const sum = balSum();
    const tilt = Math.max(-22, Math.min(22, (sum - L.target) * 7));   // 오른쪽이 무거우면 +각도 → 오른쪽이 내려간다
    box.innerHTML = '';
    box.append(h('p', 'ng-goal', `${bal.lv + 1}단계 · 왼쪽 저울 <b>${L.label}</b> 과 똑같이 맞춰 줘`));
    const scale = h('div', 'bal-scale');
    scale.style.setProperty("--tilt", tilt.toFixed(1) + "deg");
    scale.innerHTML = `
      <div class="bal-beam">
        <div class="bal-pan left"><span>${L.label}</span></div>
        <div class="bal-pan right"><span>${bal.placed.map(b => b.l).join(' + ') || '빈 접시'}</span></div>
      </div>
      <div class="bal-post"></div>`;
    box.appendChild(scale);
    const tray = h('div', 'bal-tray');
    bal.left.forEach((t, i) => {
      const b = h('button', 'bal-block bal-v' + t.v, `<b>${t.l}</b><i>×${t.n}</i>`);
      b.type = 'button'; b.disabled = bal.cleared || t.n <= 0 || sum >= L.target + 4;
      b.addEventListener('click', () => balPut(i));
      tray.appendChild(b);
    });
    box.appendChild(tray);
    const row = h('div', 'ng-row');
    const undo = h('button', 'btn ghost', '되돌리기');
    undo.type = 'button'; undo.disabled = bal.cleared || bal.placed.length === 0;
    undo.addEventListener('click', balUndo);
    row.appendChild(undo);
    box.appendChild(row);
    if(sum === L.target && !bal.cleared) balClear();
  }
  function balPut(i){
    const t = bal.left[i]; if(!t || t.n <= 0 || bal.cleared) return;
    t.n--; bal.placed.push({ v:t.v, l:t.l, from:i });
    balRender();
  }
  function balUndo(){
    const b = bal.placed.pop(); if(!b) return;
    bal.left[b.from].n++;
    balRender();
  }
  async function balClear(){
    bal.cleared = true;
    const L = BAL_LEVELS[bal.lv];
    const extra = bal.placed.length - L.min;
    const pts = Math.max(10, 30 - 5 * extra);
    bal.total += pts;
    const note = h('p', 'ng-note ok', `균형이 맞았어! 블록 ${bal.placed.length}개 · +${pts}점`);
    bal.box.appendChild(note);
    setTimeout(async () => {
      if(bal.lv + 1 < BAL_LEVELS.length){ bal.lv++; balLevel(); return; }
      await submit('balance', bal.total, bal.box, bal.total >= 45);
    }, 1200);
  }

  // ───────────────────────── 3. 어림 항해 ─────────────────────────
  // 섬마다 답을 «대략» 맞힌다. 값을 고르고, 얼마나 확신하는지(좁게·보통·넓게) 함께 말한다.
  // 좁게 말했는데 빗나가면 점수가 없다 — 확신의 정도를 아는 것도 공부다.
  const EST_ISLANDS = [
    { q:'0.3 + 0.45 는 대략 얼마일까?', a:0.75, max:2, step:0.01 },
    { q:'1/2 + 1/3 은 대략 얼마일까?', a:0.83, max:2, step:0.01 },
    { q:'9 × 4.9 는 대략 얼마일까?', a:44.1, max:90, step:0.1 },
    { q:'0.8 ÷ 4 는 얼마일까?', a:0.2, max:1, step:0.01 },
    { q:'1.7 × 3 은 얼마일까?', a:5.1, max:10, step:0.1 },
    { q:'빨간 구슬 128개를 8명이 똑같이 나누면 한 명에게 몇 개?', a:16, max:40, step:1 }
  ];
  const EST_WIDTH = { narrow:{ pct:0.05, label:'좁게 ±5%', pts:30 }, mid:{ pct:0.15, label:'보통 ±15%', pts:20 }, wide:{ pct:0.40, label:'넓게 ±40%', pts:10 } };
  const est = { i:0, guess:null, width:null, pts:0, log:[], box:null };

  function estStart(box){
    est.i = 0; est.pts = 0; est.log = []; est.box = box;
    estRound();
  }
  function estRound(){
    const box = est.box; if(!box) return;
    const I = EST_ISLANDS[est.i];
    est.guess = 0;   // 시작은 0 — 아이가 직접 움직인다
    est.width = null;
    box.innerHTML = '';
    box.append(h('p', 'ng-goal', `섬 ${est.i + 1}/${EST_ISLANDS.length} · ${I.q}`));
    const val = h('div', 'est-value', `<b id="est-v">0</b>`);
    box.appendChild(val);
    const slider = h('input', 'est-slider');
    slider.type = 'range'; slider.min = '0'; slider.max = String(I.max); slider.step = String(I.step); slider.value = '0';
    slider.setAttribute('aria-label', '답 고르기');
    slider.addEventListener('input', () => { est.guess = Number(slider.value); box.querySelector('#est-v').textContent = fmt(est.guess); });
    box.appendChild(slider);
    const widths = h('div', 'est-widths');
    Object.keys(EST_WIDTH).forEach(k => {
      const b = h('button', 'est-w', EST_WIDTH[k].label);
      b.type = 'button';
      b.addEventListener('click', () => {
        est.width = k;
        widths.querySelectorAll('.est-w').forEach(x => x.classList.toggle('on', x === b));
        go.disabled = false;
      });
      widths.appendChild(b);
    });
    box.appendChild(widths);
    const go = h('button', 'btn primary big ng-go', '배 띄우기');
    go.type = 'button'; go.disabled = true;
    go.addEventListener('click', () => estReveal(I, slider));
    box.appendChild(go);
  }
  function fmt(v){ return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, '').replace(/\.$/, ''); }
  function estReveal(I, slider){
    const W = EST_WIDTH[est.width];
    const g = est.guess;
    const band = I.a * W.pct;
    const hit = Math.abs(I.a - g) <= band + 1e-9;
    const pts = hit ? W.pts : 0;
    est.pts += pts;
    est.log.push({ width:est.width, hit });
    const box = est.box;
    box.innerHTML = '';
    box.append(h('p', 'ng-goal', `정답은 <b>${fmt(I.a)}</b> · 배가 ${hit ? '섬에 닿았어!' : '빗나갔어'}`));
    const note = h('p', hit ? 'ng-note ok' : 'ng-note', hit ? `+${pts}점 (${W.label})` : `0점 (${W.label} 이었는데 바다에 떨어졌어)`);
    box.appendChild(note);
    const last = est.i + 1 >= EST_ISLANDS.length;
    const next = h('button', 'btn primary big ng-go', last ? '항해 끝내기' : '다음 섬');
    next.type = 'button';
    next.addEventListener('click', async () => {
      if(!last){ est.i++; estRound(); return; }
      await estFinish();
    });
    box.appendChild(next);
  }
  async function estFinish(){
    const narrow = est.log.filter(x => x.width === 'narrow');
    const wide = est.log.filter(x => x.width === 'wide');
    const nHit = narrow.filter(x => x.hit).length, wHit = wide.filter(x => x.hit).length;
    const cal = `좁게 말한 ${narrow.length}번 중 ${nHit}번 맞았어` + (wide.length ? ` · 넓게 말한 ${wide.length}번 중 ${wHit}번 맞았어` : '');
    est.box.insertAdjacentHTML('beforeend', `<p class="ng-note">🧭 확신 점검 — ${cal}</p>`);
    await submit('estimate', est.pts, est.box, est.pts >= 90);
  }

  // ───────────────────────── 4. 거꾸로 질문소 ─────────────────────────
  // 답(목표 수)을 먼저 보고, 그 답이 나오는 식 «하나» 를 1~9 타일로 만든다. 60초.
  // 같은 식(순서만 바뀐 덧셈·곱셈 포함)은 한 번만 세고, 처음 쓰는 연산에 보너스가 있다.
  const REV_TARGETS = [6, 8, 10, 12, 14, 15, 16, 18, 20, 24];
  const REV_TIME = 60;
  const rev = { target:12, a:null, op:null, b:null, made:new Map(), ops:new Set(), score:0, left:REV_TIME, box:null, lastTarget:null };
  const OP_SYM = { '+':'+', '-':'−', '*':'×', '/':'÷' };

  function revStart(box){
    Object.assign(rev, { a:null, op:null, b:null, made:new Map(), ops:new Set(), score:0, left:REV_TIME, box, lastTarget:null });
    revNewTarget();
    revRender();
    tick('reverse', revTick, 1000);
  }
  function revNewTarget(){
    let t; do { t = REV_TARGETS[rand(REV_TARGETS.length)]; } while(t === rev.lastTarget);
    rev.target = t; rev.lastTarget = t; rev.a = null; rev.op = null; rev.b = null;
  }
  function revTick(){
    rev.left--;
    if(rev.left <= 0){ clearTick('reverse'); revEnd(); return; }
    const t = document.getElementById('rev-time'); if(t) t.textContent = `${rev.left}초`;
  }
  function revRender(){
    const box = rev.box; if(!box) return;
    box.innerHTML = '';
    box.append(h('p', 'ng-goal', `이 답이 나오는 식을 만들어 봐 · <span id="rev-time">${rev.left}초</span>`));
    box.append(h('div', 'rev-target', String(rev.target)));
    const slot = h('div', 'rev-slot',
      `<span class="${rev.a == null ? 'empty' : ''}">${rev.a == null ? '□' : rev.a}</span>` +
      `<span class="${rev.op ? '' : 'empty'}">${rev.op ? OP_SYM[rev.op] : '?'}</span>` +
      `<span class="${rev.b == null ? 'empty' : ''}">${rev.b == null ? '□' : rev.b}</span>` +
      `<span>= ${rev.target}</span>`);
    box.append(slot);
    const ops = h('div', 'rev-ops');
    Object.keys(OP_SYM).forEach(op => {
      const b = h('button', 'rev-op' + (rev.op === op ? ' on' : ''), OP_SYM[op]);
      b.type = 'button';
      b.addEventListener('click', () => { rev.op = op; revRender(); });
      ops.appendChild(b);
    });
    box.append(ops);
    const tiles = h('div', 'rev-tiles');
    for(let n = 1; n <= 9; n++){
      const b = h('button', 'rev-tile' + (rev.a === n || rev.b === n ? ' used' : ''), String(n));
      b.type = 'button';
      b.addEventListener('click', () => revTile(n));
      tiles.appendChild(b);
    }
    box.append(tiles);
    const row = h('div', 'ng-row');
    const ok = h('button', 'btn primary', '이 식 확인');
    ok.type = 'button'; ok.disabled = rev.a == null || rev.op == null || rev.b == null;
    ok.addEventListener('click', revCheck);
    const clr = h('button', 'btn ghost', '지우기');
    clr.type = 'button'; clr.addEventListener('click', () => { rev.a = rev.op = rev.b = null; revRender(); });
    const stop = h('button', 'btn ghost', '여기까지');
    stop.type = 'button'; stop.addEventListener('click', revEnd);
    row.append(ok, clr, stop);
    box.append(row);
    box.append(h('p', 'ng-status', `만든 식 ${rev.made.size}개 · 점수 ${rev.score}`));
    const list = h('div', 'rev-list');
    [...rev.made.values()].slice(-6).forEach(x => list.append(h('span', 'rev-chip', x)));
    box.append(list);
  }
  function revTile(n){
    if(rev.a == null){ rev.a = n; }
    else if(rev.b == null){ rev.b = n; }
    else { rev.b = n; }
    revRender();
  }
  function revCheck(){
    const a = rev.a, b = rev.b, op = rev.op;
    let v = null;
    if(op === '+') v = a + b;
    else if(op === '-') v = a - b;
    else if(op === '*') v = a * b;
    else if(op === '/') v = b !== 0 && a % b === 0 ? a / b : null;
    const text = `${a} ${OP_SYM[op]} ${b}`;
    const key = (op === '+' || op === '*') ? `${op}${Math.min(a, b)},${Math.max(a, b)}` : `${op}${a},${b}`;
    if(v === null){ rev.a = rev.b = rev.op = null; revRender(); revSay(`${text} 은 딱 떨어지지 않아`); return; }
    if(v !== rev.target){ revSay(`${text} = ${v} 야. ${rev.target} 이 되려면 다른 짝을 골라 봐!`); return; }
    if(rev.made.has(key)){ revSay(`${text} 는 이미 만든 식이야. 다른 모양을 찾아봐!`); return; }
    const bonus = rev.ops.has(op) ? 0 : 5;
    rev.ops.add(op);
    rev.score += 15 + bonus;
    rev.made.set(key, `${text} = ${rev.target}`);
    const praise = `✓ ${text} = ${rev.target} · +${15 + bonus}${bonus ? ' (새 연산 보너스)' : ''}`;
    revNewTarget(); rev.a = rev.b = rev.op = null;
    revRender();
    revSay(praise);
  }
  function revSay(msg){
    const box = rev.box; if(!box) return;
    let p = box.querySelector('.ng-note');
    if(!p){ p = h('p', 'ng-note'); box.insertBefore(p, box.querySelector('.rev-tiles')); }
    p.textContent = msg;
  }
  async function revEnd(){
    clearTick('reverse');
    if(rev.box){ rev.box.innerHTML = ''; }
    await submit('reverse', rev.score, rev.box, rev.score >= 120);
  }

  // ───────────────────────── 공통 입구 ─────────────────────────
  const GAMES = {
    roomi:    { modal:'game-roomi',    stage:'ng-roomi-stage',    start: roomiStart },
    balance:  { modal:'game-balance',  stage:'ng-balance-stage',  start: balStart },
    estimate: { modal:'game-estimate', stage:'ng-estimate-stage', start: estStart },
    reverse:  { modal:'game-reverse',  stage:'ng-reverse-stage',  start: revStart }
  };
  function openMini(kind){
    const g = GAMES[kind]; if(!g) return;
    const modal = document.getElementById(g.modal);
    const box = document.getElementById(g.stage);
    if(!modal || !box) return;
    clearTick('reverse');
    modal.classList.remove('hidden');
    g.start(box);
  }
  // 창을 닫을 때 app.js 의 closeGame 이 부른다 — 타이머가 살아 있으면 감춰진 창에서 계속 돈다
  function stopMini(id){ if(id === GAMES.reverse.modal) clearTick('reverse'); }

  // 게임 카드 연결 — 라운지의 네 카드
  [['btn-roomi','roomi'],['btn-balance','balance'],['btn-estimate','estimate'],['btn-reverse','reverse']].forEach(([id, kind]) => {
    const b = document.getElementById(id);
    if(b) b.addEventListener('click', () => openMini(kind));
  });

  window.MiniGames = { open: openMini, stop: stopMini };
  // 세계 의뢰(우물·풍차)가 게임을 열 때도 같은 입구를 쓴다
  window.openEstimate = () => openMini('estimate');
  window.openBalance = () => openMini('balance');
})();
