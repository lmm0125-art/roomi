// ============================================================
// 루미 연습실 — 새 미니게임 4종 (2026-11-28, 2차: 깊이 + 애니메이션)
//   루미 훈련소 · 균형 공방 · 어림 항해 · 거꾸로 질문소
//   · 셀은 주지 않는다. 서버 grantMiniGame 이 점수 범위를 검사하고 XP·도감 카드만 준다.
//   · app.js 의 $, esc, api, setBalance, refreshGrowth, tryClaimQuest, rumiPose, SFX 를 쓴다.
//   · 창을 닫으면 MiniGames.stop(모달 id) 가 그 게임의 타이머를 모두 끊는다(세대 번호로 낡은 콜백도 무시).
// ============================================================
(function(){
  'use strict';

  // ───────── 공통: 타이머 · 세대 번호 · 작은 도우미 ─────────
  const KINDS = ['roomi', 'balance', 'estimate', 'reverse'];
  const live = {}, gen = {};
  KINDS.forEach(k => { live[k] = new Set(); gen[k] = 0; });
  function later(kind, ms, fn){
    const g = gen[kind];
    const id = setTimeout(() => { live[kind].delete(id); if(gen[kind] === g) fn(); }, ms);
    live[kind].add(id); return id;
  }
  function every(kind, ms, fn){
    const g = gen[kind];
    const id = setInterval(() => { if(gen[kind] !== g){ clearInterval(id); live[kind].delete(id); return; } fn(); }, ms);
    live[kind].add(id); return id;
  }
  function halt(kind){
    live[kind].forEach(id => { clearTimeout(id); clearInterval(id); });
    live[kind].clear(); gen[kind]++;
  }
  const rand = n => Math.floor(Math.random() * n);
  const shuffle = a => { for(let i = a.length - 1; i > 0; i--){ const j = rand(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const range = (a, b) => { const r = []; for(let i = a; i <= b; i++) r.push(i); return r; };
  const h = (tag, cls, html) => { const e = document.createElement(tag); if(cls) e.className = cls; if(html != null) e.innerHTML = html; return e; };
  const fmt = v => Number.isInteger(v) ? String(v) : (Math.round(v * 100) / 100).toString();
  const OPSYM = { '+':'+', '-':'−', '*':'×', '/':'÷' };
  const OPNAME = { '+':'더하기', '-':'빼기', '*':'곱하기', '/':'나누기' };

  // 결과 화면 공통: 점수 올라가기 · 별 · 도감 카드 뒤집기 · 루미 표정 · XP
  async function submit(kind, score, box, opt){
    box.innerHTML = '<p class="ng-note">결과를 루미에게 전하는 중…</p>';
    let r = null, err = '';
    try{
      r = await api('/api/game/result', { kind, score }, 12000);
      if(r.balance != null && state.user){ state.user.cell_balance = r.balance; setBalance(r.balance); }
      if(r.growth){ state.growth = { ...state.growth, ...r.growth, partBonus: state.growth.partBonus || 0 }; await refreshGrowth(); }
    }catch(e){
      err = e.message || '기록을 전하지 못했어요';
    }
    const stars = score >= opt.max * 0.75 ? 3 : score >= opt.max * 0.45 ? 2 : score > 0 ? 1 : 0;
    const codex = r && r.codexUnlocked
      ? `<div class="ng-cc"><div class="ng-cc-inner"><div class="ng-cc-front">📖 도감</div><div class="ng-cc-back">«${esc(r.codexUnlocked)}» 카드 열림</div></div></div>`
      : (r ? `<span class="ng-codex">${opt.unlockHint || '조금만 더 하면 도감 카드가 열려요.'}</span>` : '');
    box.innerHTML = `<div class="ng-result">
        <span class="ng-pose">${rumiPose(stars >= 2 ? 'happy' : 'think', 64)}</span>
        <div class="ng-stars">${[0,1,2].map(i => `<i class="ng-star" data-i="${i}">★</i>`).join('')}</div>
        <div class="ng-scorebox"><span class="ng-score">0</span><span class="ng-max">/ ${opt.max}점</span></div>
        ${r ? `<span class="ng-xp">+${r.xp || 0} XP</span>` : ''}
        ${codex}
        ${err ? `<span class="ng-codex">${esc(err)}</span>` : ''}
        ${opt.extra || ''}
      </div>`;
    // 점수 올라가기
    const el = box.querySelector('.ng-score');
    const t0 = performance.now(), dur = 900;
    const step = (now) => {
      if(!el.isConnected) return;
      const k = Math.min(1, (now - t0) / dur);
      el.textContent = String(Math.round(score * (1 - Math.pow(1 - k, 3))));
      if(k < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    // 별 순서대로 튀어나오기
    box.querySelectorAll('.ng-star').forEach((s, i) => later(kind, 260 + i * 220, () => { if(i < stars) s.classList.add('on'); }));
    // 도감 카드 뒤집기
    const cc = box.querySelector('.ng-cc');
    if(cc) later(kind, 1100, () => cc.classList.add('flip'));
    try{ if(state.quest) await tryClaimQuest({ kind, score }); }catch(e){}
    if(window.refreshGameBadges) refreshGameBadges();
    return r;
  }

  // ───────── 1. 루미 훈련소: 규칙을 예시로 가르친다 (라운드 3개, 예시 9개 예산) ─────────
  // 루미는 후보 규칙을 단순한 것부터 맞춰 본다. 치우친 예시는 엉뚱한 규칙을 낳는다.
  const RM_ORDER = [
    { id:'even',    name:'짝수',                     test:n => n % 2 === 0 },
    { id:'odd',     name:'홀수',                     test:n => n % 2 === 1 },
    { id:'big10',   name:'10보다 큰 수',             test:n => n > 10 },
    { id:'small10', name:'10보다 작은 수',           test:n => n < 10 },
    { id:'mult5',   name:'5의 배수',                 test:n => n % 5 === 0 },
    { id:'mult3',   name:'3의 배수',                 test:n => n % 3 === 0 },
    { id:'evenBig', name:'짝수이면서 10보다 큰 수',   test:n => n % 2 === 0 && n > 10 }
  ];
  function rmPoolPlain(){ return shuffle(range(1, 24)).slice(0, 12).sort((a, b) => a - b); }
  function rmPoolTwo(){
    const cats = [
      range(12, 24).filter(n => n % 2 === 0),   // 짝수이면서 큼
      range(2, 10).filter(n => n % 2 === 0),    // 짝수이면서 작음
      range(11, 23).filter(n => n % 2 === 1),   // 홀수이면서 큼
      range(1, 9).filter(n => n % 2 === 1)      // 홀수이면서 작음
    ];
    return cats.flatMap(c => shuffle(c).slice(0, 3)).sort((a, b) => a - b);
  }
  function rmPoolTrap(){
    // 짝수처럼 보이는 함정(2·4·8…)과 진짜 3의 배수(홀수 3·9·15 포함)를 섞는다
    const cats = [
      [3, 9, 15, 21],          // 3의 배수 · 홀수
      [6, 12, 18, 24],         // 3의 배수 · 짝수
      [2, 4, 8, 10, 14, 16, 20, 22],   // 짝수 · 3의 배수 아님(함정)
      [1, 5, 7, 11, 13, 17, 19, 23]    // 홀수 · 3의 배수 아님
    ];
    return cats.flatMap(c => shuffle(c.slice()).slice(0, 3)).sort((a, b) => a - b);
  }
  const RM_ROUNDS = [
    { rule: RM_ORDER[0], make: rmPoolPlain, goal: '짝수' },
    { rule: RM_ORDER[6], make: rmPoolTwo,   goal: '짝수이면서 10보다 큰 수' },
    { rule: RM_ORDER[5], make: rmPoolTrap,  goal: '3의 배수' }
  ];
  const RM_BUDGET = 9, RM_ROUND_CAP = 6;
  const rm = { box:null, r:0, cards:[], ex:new Map(), budget:RM_BUDGET, roundUsed:0, busy:false,
               guess:null, total:0, roundPts:0, over:false, cleared:false, failed:false, msg:'', pose:'idle' };

  function rmStart(box){
    rm.box = box; rm.r = 0; rm.total = 0; rm.budget = RM_BUDGET;
    rmLoadRound();
  }
  function rmLoadRound(){
    const R = RM_ROUNDS[rm.r];
    rm.cards = R.make(); rm.ex = new Map(); rm.roundUsed = 0; rm.busy = false;
    rm.guess = null; rm.roundPts = 0; rm.cleared = false; rm.failed = false;
    rm.msg = `${rm.r + 1}라운드 시작! 「${R.goal}」 을(를) 가르쳐 줘.`; rm.pose = 'idle';
    // 예시가 이미 다 떨어졌으면 이 라운드는 가르칠 수 없다 — 0점으로 넘어가 멈추지 않게 한다
    if(rm.budget <= 0){ rm.failed = true; rm.pose = 'sad'; rm.msg = `예시가 모두 떨어졌어. ${rm.r + 1}라운드는 0점으로 넘어가요.`; }
    rmRender();
  }
  function rmBoardOf(exs){
    return RM_ORDER.map(hy => {
      const ok = exs.every(([c, v]) => hy.test(c) === v);
      return `<li class="${ok ? '' : 'cross'}">${hy.name}</li>`;
    }).join('');
  }
  function rmRender(){
    const box = rm.box; if(!box) return;
    const R = RM_ROUNDS[rm.r];
    const exs = [...rm.ex.entries()];
    const canPick = !rm.busy && !rm.cleared && !rm.failed && rm.budget > 0 && rm.roundUsed < RM_ROUND_CAP;
    box.innerHTML = '';
    const top = h('div', 'rm-top',
      `<span class="rm-round">라운드 ${rm.r + 1}/3</span><span class="rm-budget">예시 ${rm.budget}개 남음</span>`);
    box.appendChild(top);
    box.appendChild(h('p', 'ng-goal', `목표 규칙: <b>${R.goal}</b>`));
    const body = h('div', 'rm-body');
    const grid = h('div', 'rm-grid');
    rm.cards.forEach(c => {
      const picked = rm.ex.has(c);
      const b = h('button', 'rm-card' + (picked ? ' picked' : ''));
      b.type = 'button'; b.dataset.n = String(c);
      b.disabled = !(picked ? false : canPick);
      b.innerHTML = `<span class="rm-face rm-front">${c}</span>` +
        `<span class="rm-face rm-back">${picked ? (rm.ex.get(c) ? '⭕' : '❌') : ''}</span>`;
      if(!picked) b.addEventListener('click', () => rmPick(c));
      grid.appendChild(b);
    });
    body.appendChild(grid);
    const side = h('aside', 'rm-board');
    side.innerHTML = `<h5>루미의 생각</h5><ul>${rmBoardOf(exs)}</ul><p class="rm-hint">지워진 규칙은 예시와 맞지 않아요.</p>`;
    body.appendChild(side);
    box.appendChild(body);
    const baskets = h('div', 'rm-baskets',
      `<div class="rm-basket o"><b>⭕ 맞는 곳</b></div><div class="rm-basket x"><b>❌ 아닌 곳</b></div>`);
    box.appendChild(baskets);
    const bub = h('div', 'rm-bubble');
    bub.innerHTML = `<span class="rm-pose">${rumiPose(rm.pose, 44)}</span><span class="rm-msg">${esc(rm.msg)}</span>`;
    box.appendChild(bub);
    const row = h('div', 'ng-row');
    if(rm.cleared || rm.failed){
      const last = rm.r + 1 >= RM_ROUNDS.length;
      const next = h('button', 'btn primary big ng-go', last ? '결과 보기' : '다음 라운드');
      next.type = 'button';
      next.addEventListener('click', rmNext);
      row.appendChild(next);
    }else{
      const go = h('button', 'btn primary big ng-go', rm.guess ? '다시 가르치기' : '루미에게 가르치기');
      go.type = 'button'; go.disabled = rm.busy || exs.length === 0;
      go.addEventListener('click', rmTeach);
      row.appendChild(go);
    }
    box.appendChild(row);
    box.appendChild(h('p', 'ng-status', `이 라운드 예시 ${rm.roundUsed}/${RM_ROUND_CAP} · 누적 ${rm.total}점`));
  }
  function rmPick(c){
    if(rm.busy || rm.cleared || rm.failed || rm.budget <= 0 || rm.roundUsed >= RM_ROUND_CAP || rm.ex.has(c)) return;
    const R = RM_ROUNDS[rm.r];
    rm.ex.set(c, R.rule.test(c));
    rm.budget--; rm.roundUsed++;
    rm.guess = null;
    rm.msg = rm.ex.get(c) ? `⭕ ${c}: 맞는 예시를 보여 줬어.` : `❌ ${c}: 아닌 예시도 중요해!`;
    rm.pose = 'idle';
    rmRender();
    // 방금 고른 카드는 뒤집혀 나타난다
    const el = rm.box.querySelector(`[data-n="${c}"]`);
    if(el) el.classList.add('flipped');
  }
  function rmTeach(){
    if(rm.busy) return;
    const R = RM_ROUNDS[rm.r];
    const exs = [...rm.ex.entries()];
    const guess = RM_ORDER.find(hy => exs.every(([c, v]) => hy.test(c) === v)) || null;
    rm.guess = guess; rm.busy = true; rm.pose = 'think';
    rm.msg = '루미가 카드를 분류하는 중…';
    rmRender();
    const grid = rm.box.querySelector('.rm-grid');
    const baskets = { o: rm.box.querySelector('.rm-basket.o'), x: rm.box.querySelector('.rm-basket.x') };
    let wrong = 0;
    const order = rm.cards.slice();
    order.forEach((c, i) => later('roomi', 140 * i + 300, () => {
      const card = grid.querySelector(`[data-n="${c}"]`); if(!card) return;
      const says = guess ? guess.test(c) : false;
      const truth = R.rule.test(c);
      const ok = says === truth;
      if(!ok) wrong++;
      card.classList.add(ok ? 'ok' : 'bad');
      baskets[says ? 'o' : 'x'].appendChild(card);
      if(!ok) card.classList.add('shake');
      if((typeof SFX !== 'undefined' ? SFX : null)) (ok ? SFX.click() : SFX.wrong());
    }));
    later('roomi', 140 * order.length + 700, () => rmJudge(guess, wrong));
  }
  function rmJudge(guess, wrong){
    rm.busy = false;
    if(guess && wrong === 0){
      const pts = Math.max(6, 20 - 2 * (rm.roundUsed - 1));
      rm.roundPts = pts; rm.total += pts; rm.cleared = true; rm.pose = 'happy';
      rm.msg = `맞았어! 「${guess.name}」 이구나. +${pts}점`;
      if((typeof SFX !== 'undefined' ? SFX : null)) SFX.correct();
      rmRender();
      return;
    }
    if(rm.roundUsed >= RM_ROUND_CAP || rm.budget <= 0){
      rm.failed = true; rm.pose = 'sad';
      rm.msg = `예시를 다 썼어. 이번 라운드는 0점이에요. 루미는 「${guess ? guess.name : '잘 모르겠어'}」 이라고 생각했어.`;
      if((typeof SFX !== 'undefined' ? SFX : null)) SFX.wrong();
      rmRender();
      return;
    }
    rm.pose = 'think';
    rm.msg = guess
      ? `루미는 「${guess.name}」 이라고 생각했어. 틀린 카드가 ${wrong}장 있어. 예시를 더 보여 줄래?`
      : '루미가 아직 감을 못 잡았어. 예시를 더 보여 줄래?';
    rmRender();
  }
  async function rmNext(){
    if(rm.r + 1 < RM_ROUNDS.length){ rm.r++; rmLoadRound(); return; }
    const bonus = rm.budget * 2;
    await submit('roomi', rm.total + bonus, rm.box, {
      max: 90, unlockHint: '예시를 조금 아껴서 가르치면 도감 카드가 열려요.'
    });
  }

  // ───────── 2. 균형 공방: 다섯 단계 저울 (분수 · 같은 값 · 가려진 무게 · 두 접시 · 오른쪽에 이미 있는 것) ─────────
  // 단위는 1/24. 1/2=12, 1/3=8, 1/4=6, 1/6=4, 1/8=3, 2/3=16, 3/4=18, 3/8=9.
  const BL = [
    { title:'분수 맞추기', target:18, min:2, left:[{l:'3/4'}],
      tray:[{v:12,l:'1/2',n:2},{v:6,l:'1/4',n:3},{v:6,l:'0.25',n:2},{v:3,l:'1/8',n:4}] },
    { title:'같은 값 찾기', target:16, min:2, left:[{l:'2/3'}],
      tray:[{v:8,l:'1/3',n:3},{v:4,l:'1/6',n:3},{v:12,l:'1/2',n:1},{v:6,l:'1/4',n:2}] },
    { title:'가려진 무게', target:9, min:2, hidden:true, reveal:'1/4 + 1/8 (= 3/8)', left:[{l:'?'}],
      tray:[{v:6,l:'1/4',n:1},{v:3,l:'1/8',n:2},{v:3,l:'0.125',n:2},{v:4,l:'1/6',n:2}] },
    { title:'두 접시 맞추기', target:15, min:2, left:[{l:'1/2'},{l:'1/8'}],
      tray:[{v:6,l:'1/4',n:2},{v:3,l:'1/8',n:3},{v:4,l:'1/6',n:2},{v:12,l:'1/2',n:1}] },
    { title:'이미 있는 것 포함', target:16, min:2, left:[{l:'2/3'}], fixedRight:[{v:8,l:'1/3'}],
      tray:[{v:4,l:'1/6',n:3},{v:6,l:'1/4',n:1},{v:3,l:'1/8',n:2}] }
  ];
  const bl = { box:null, lv:0, total:0, placed:[], left:[], cleared:false, stars:[] };
  function blStart(box){ bl.box = box; bl.lv = 0; bl.total = 0; bl.stars = []; blLevel(); }
  function blL(){ return BL[bl.lv]; }
  function blFixed(){ return (blL().fixedRight || []).reduce((s, b) => s + b.v, 0); }
  function blSum(){ return blFixed() + bl.placed.reduce((s, b) => s + b.v, 0); }
  function blLevel(){
    bl.placed = []; bl.cleared = false;
    bl.left = blL().tray.map(t => ({ ...t }));
    blRender(true);
  }
  function blRender(fresh){
    const box = bl.box; if(!box) return;
    const L = blL();
    const sum = blSum();
    const tilt = Math.max(-22, Math.min(22, (sum - L.target) * 6));   // 오른쪽이 무거우면 +각도
    box.innerHTML = '';
    box.appendChild(h('p', 'ng-goal', `${bl.lv + 1}/${BL.length} · ${L.title}`));
    const scale = h('div', 'bal-scale');
    scale.style.setProperty('--tilt', tilt.toFixed(1) + 'deg');
    const leftChips = L.left.map(c => `<em class="bal-chip">${c.l}</em>`).join('');
    const fixedChips = (L.fixedRight || []).map(c => `<em class="bal-chip fixed">${c.l}🔒</em>`).join('');
    const placedChips = bl.placed.map((b, i) => `<em class="bal-chip b${b.v}${i === bl.placed.length - 1 && fresh !== true ? ' drop' : ''}">${b.l}</em>`).join('');
    scale.innerHTML = `
      <div class="bal-beam">
        <div class="bal-pan left"><span>${L.hidden ? '<em class="bal-chip q">?</em>' : leftChips}</span></div>
        <div class="bal-pan right"><span>${fixedChips}${placedChips || (fixedChips ? '' : '<em class="bal-empty">빈 접시</em>')}</span></div>
      </div>
      <div class="bal-post"></div>
      <div class="bal-base"></div>`;
    box.appendChild(scale);
    // 분수 막대: 24칸 중 오른쪽 접시가 차지하는 만큼 채운다
    const strip = h('div', 'bal-strip');
    let fill = [];
    (L.fixedRight || []).forEach(b => fill.push(...Array(b.v).fill('fx')));
    bl.placed.forEach(b => fill.push(...Array(b.v).fill('b' + b.v)));
    for(let i = 0; i < 24; i++){
      const cell = h('i', fill[i] ? 'on ' + fill[i] : '');
      strip.appendChild(cell);
    }
    if(!L.hidden){
      const mark = h('b', 'bal-target');
      mark.style.left = `${(L.target / 24) * 100}%`;
      strip.appendChild(mark);
    }
    box.appendChild(strip);
    const tray = h('div', 'bal-tray');
    bl.left.forEach((t, i) => {
      const b = h('button', 'bal-block bal-v' + t.v, `<b>${t.l}</b><i>×${t.n}</i>`);
      b.type = 'button';
      b.disabled = bl.cleared || t.n <= 0 || sum >= L.target + 4;
      b.addEventListener('click', () => blPut(i));
      tray.appendChild(b);
    });
    box.appendChild(tray);
    const row = h('div', 'ng-row');
    const undo = h('button', 'btn ghost', '되돌리기');
    undo.type = 'button'; undo.disabled = bl.cleared || bl.placed.length === 0;
    undo.addEventListener('click', blUndo);
    row.appendChild(undo);
    box.appendChild(row);
    box.appendChild(h('p', 'ng-status', `블록 ${bl.placed.length}개 · 누적 ${bl.total}점`));
    if(sum === L.target && !bl.cleared) blClear();
  }
  function blPut(i){
    const t = bl.left[i]; if(!t || t.n <= 0 || bl.cleared) return;
    t.n--; bl.placed.push({ v:t.v, l:t.l, from:i });
    if((typeof SFX !== 'undefined' ? SFX : null)) SFX.click();
    blRender(false);
  }
  function blUndo(){
    const b = bl.placed.pop(); if(!b) return;
    bl.left[b.from].n++;
    blRender(true);
  }
  function blClear(){
    bl.cleared = true;
    const L = blL();
    const used = bl.placed.length;
    const stars = used <= L.min ? 3 : used === L.min + 1 ? 2 : 1;
    const pts = stars * 10;
    bl.total += pts; bl.stars.push(stars);
    if((typeof SFX !== 'undefined' ? SFX : null)) SFX.levelup();
    // 반짝임 · 별 · 가려진 무게 공개
    const scale = bl.box.querySelector('.bal-scale');
    if(scale){
      for(let i = 0; i < 9; i++){
        const s = h('b', 'bal-sp', '✦');
        s.style.left = (10 + rand(80)) + '%'; s.style.top = (rand(70)) + '%';
        s.style.animationDelay = (rand(4) * 0.06) + 's';
        scale.appendChild(s);
      }
    }
    const note = h('p', 'ng-note ok', `균형이 맞았어! ${'★'.repeat(stars)} +${pts}점` +
      (L.reveal ? ` · 왼쪽은 ${L.reveal} 이었어` : ''));
    bl.box.appendChild(note);
    later('balance', 1500, async () => {
      if(bl.lv + 1 < BL.length){ bl.lv++; blLevel(); return; }
      await submit('balance', bl.total, bl.box, { max: 150, unlockHint: '조금만 더 맞추면 도감 카드가 열려요.' });
    });
  }

  // ───────── 3. 어림 항해: 주제는 아이의 등불에서, 폭풍 섬 · 바람 연속 · 확신 점검 ─────────
  const EST_POOL = [
    { topic:'소수', q:'0.3 + 0.45 는 대략 얼마일까?', a:0.75, max:2, step:0.01 },
    { topic:'소수', q:'1.7 × 3 은 얼마일까?', a:5.1, max:10, step:0.1 },
    { topic:'소수', q:'0.8 ÷ 4 는 얼마일까?', a:0.2, max:1, step:0.01 },
    { topic:'분수의 덧셈', q:'1/2 + 1/3 은 대략 얼마일까?', a:0.83, max:2, step:0.01 },
    { topic:'분수의 덧셈', q:'3/4 + 1/8 은 대략 얼마일까?', a:0.88, max:2, step:0.01 },
    { topic:'약분·통분', q:'2/3 을 소수로 나타내면 대략 얼마일까?', a:0.67, max:1, step:0.01 },
    { topic:'곱셈', q:'23 × 19 는 대략 얼마일까?', a:437, max:1000, step:5 },
    { topic:'곱셈', q:'48 × 6 은 얼마일까?', a:288, max:600, step:5 },
    { topic:'도형 넓이', q:'가로 7cm, 세로 9cm 직사각형의 넓이는?', a:63, max:120, step:1 },
    { topic:'산술 연산', q:'128 + 367 은 대략 얼마일까?', a:495, max:1000, step:5 }
  ];
  const EST_W = {
    narrow: { pct:0.05, label:'좁게 ±5%', pts:30 },
    mid:    { pct:0.15, label:'보통 ±15%', pts:20 },
    wide:   { pct:0.40, label:'넓게 ±40%', pts:10 }
  };
  const EST_TURN = [{x:4}, {x:22}, {x:40}, {x:58}, {x:76}, {x:94}];
  const est = { box:null, list:[], i:0, pts:0, streak:0, log:[], guess:0, width:null, phase:'pick' };

  function estPick(topics){
    const pool = shuffle(EST_POOL.slice());
    const picked = [], used = new Set();
    for(const t of topics){
      if(picked.length >= 6) break;
      const q = pool.find(x => x.topic === t && !used.has(x));
      if(q){ picked.push(q); used.add(q); }
    }
    for(const q of pool){
      if(picked.length >= 6) break;
      if(!used.has(q)){ picked.push(q); used.add(q); }
    }
    const storm = 2 + rand(3);
    return picked.map((q, i) => ({ ...q, storm: i === storm }));
  }
  async function estStart(box){
    est.box = box; est.i = 0; est.pts = 0; est.streak = 0; est.log = []; est.phase = 'pick';
    box.innerHTML = '<p class="ng-note">섬 지도를 그리는 중…</p>';
    const g = gen.estimate;
    let topics = [];
    try{
      const l = await api('/api/lamps', undefined, 8000, 'GET');
      topics = (l.lamps || []).map(x => x.topic).filter(Boolean);
    }catch(e){}
    if(gen.estimate !== g) return;
    est.list = estPick(topics);
    estRound();
  }
  function estRoute(){
    const nodes = est.list.map((I, i) => {
      const cls = i < est.i ? (est.log[i] && est.log[i].hit ? 'done' : 'miss') : (i === est.i ? 'now' : '');
      return `<span class="est-node ${cls}${I.storm ? ' storm' : ''}" style="left:${EST_TURN[i].x}%">${I.storm ? '⛈' : (i + 1)}</span>`;
    }).join('');
    const boatX = EST_TURN[Math.min(est.i, EST_TURN.length - 1)].x;
    return `<div class="est-route">
        <svg viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
          <path d="M4 15 Q 13 4 22 15 T 40 15 T 58 15 T 76 15 T 94 15" vector-effect="non-scaling-stroke"/>
        </svg>${nodes}<span class="est-boat" style="left:${boatX}%">⛵</span></div>`;
  }
  function estRound(){
    const box = est.box; if(!box) return;
    const I = est.list[est.i];
    est.guess = 0; est.width = null; est.phase = 'pick';
    box.innerHTML = '';
    box.appendChild(h('div', 'est-top', `섬 ${est.i + 1}/6 · ${I.topic}`));
    box.insertAdjacentHTML('beforeend', estRoute());
    box.appendChild(h('p', 'ng-goal', I.q));
    if(I.storm) box.appendChild(h('p', 'ng-note', '⛈ 폭풍 섬: 좁게 말하고 빗나가면 배가 흔들려 −10점이에요.'));
    box.appendChild(h('div', 'est-value', '<b id="est-v">0</b>'));
    const line = h('div', 'est-line');
    line.innerHTML = '<div class="est-band"></div><div class="est-guess"></div><div class="est-answer"></div>';
    box.appendChild(line);
    const slider = h('input', 'est-slider');
    slider.type = 'range'; slider.min = '0'; slider.max = String(I.max); slider.step = String(I.step); slider.value = '0';
    slider.setAttribute('aria-label', '답 고르기');
    const widths = h('div', 'est-widths');
    const go = h('button', 'btn primary big ng-go', '배 띄우기');
    go.type = 'button'; go.disabled = true;
    const paint = () => {
      est.guess = Number(slider.value);
      box.querySelector('#est-v').textContent = fmt(est.guess);
      const gp = (est.guess / I.max) * 100;
      box.querySelector('.est-guess').style.left = gp + '%';
      const band = est.width ? I.a * EST_W[est.width].pct : 0;
      const bandEl = box.querySelector('.est-band');
      bandEl.style.left = Math.max(0, ((est.guess - band) / I.max) * 100) + '%';
      bandEl.style.width = Math.min(100, (2 * band / I.max) * 100) + '%';
      bandEl.classList.toggle('show', !!est.width);
    };
    slider.addEventListener('input', paint);
    Object.keys(EST_W).forEach(k => {
      const b = h('button', 'est-w', EST_W[k].label);
      b.type = 'button';
      b.addEventListener('click', () => {
        est.width = k;
        widths.querySelectorAll('.est-w').forEach(x => x.classList.toggle('on', x === b));
        go.disabled = false;
        paint();
      });
      widths.appendChild(b);
    });
    go.addEventListener('click', () => { go.disabled = true; slider.disabled = true; widths.querySelectorAll('button').forEach(x => x.disabled = true); estReveal(I, go); });
    box.appendChild(slider);
    box.appendChild(widths);
    box.appendChild(go);
    paint();
    // 등장 애니메이션은 CSS 가 맡는다
    box.querySelector('.est-route').classList.add('in');
  }
  function estReveal(I, go){
    est.phase = 'reveal';
    const W = EST_W[est.width], g = est.guess;
    const band = I.a * W.pct;
    const hit = Math.abs(I.a - g) <= band + 1e-9;
    let delta = 0, note = '';
    if(hit){
      delta = W.pts + (I.storm && est.width === 'wide' ? 5 : 0);
      est.streak++;
      if(est.streak >= 3){ delta += 10; note = ' · 바람을 탔어! +10'; }
    }else{
      est.streak = 0;
      delta = I.storm && est.width === 'narrow' ? -10 : 0;
    }
    const before = est.pts;
    est.pts = Math.max(0, est.pts + delta);
    est.log.push({ width: est.width, hit, storm: I.storm, got: est.pts - before });
    // 정답 표시: 띠가 펼쳐지고 정답이 떨어진다
    const ans = est.box.querySelector('.est-answer');
    ans.style.left = (I.a / I.max) * 100 + '%';
    ans.classList.add('drop');
    est.box.querySelector('.est-band').classList.add('show');
    // 배가 섬까지 항해 → 맞으면 정박, 빗나가면 물보라
    const idx = est.i;
    const boat = est.box.querySelector('.est-boat');
    const from = EST_TURN[idx].x, to = EST_TURN[Math.min(idx + 1, EST_TURN.length - 1)].x;
    const boatSail = () => { if(boat) boat.style.left = (hit ? from : from + (to - from) * 0.5) + '%'; };
    boatSail();
    later('estimate', 250, () => {
      if(!hit){ const sp = h('span', 'est-splash', '💦'); sp.style.left = from + '%'; est.box.querySelector('.est-route').appendChild(sp); if((typeof SFX !== 'undefined' ? SFX : null)) SFX.wrong(); }
      else if((typeof SFX !== 'undefined' ? SFX : null)) SFX.correct();
    });
    const node = est.box.querySelectorAll('.est-node')[idx];
    later('estimate', 350, () => { if(node) node.classList.add(hit ? 'done' : 'miss'); });
    const summary = h('p', hit ? 'ng-note ok' : 'ng-note',
      `정답은 <b>${fmt(I.a)}</b> · ${hit ? `${W.label} 안에 들어왔어! +${delta}점${note}` : `빗나갔어. ${delta < 0 ? '배가 흔들려 −10점' : '0점'}`}`);
    est.box.appendChild(summary);
    go.remove();
    const last = idx + 1 >= est.list.length;
    const next = h('button', 'btn primary big ng-go', last ? '항해 끝내기' : '다음 섬');
    next.type = 'button';
    next.addEventListener('click', () => {
      if(!last){ est.i++; estRound(); return; }
      estFinish();
    });
    est.box.appendChild(next);
  }
  async function estFinish(){
    const box = est.box;
    const rate = w => {
      const all = est.log.filter(x => x.width === w);
      return { n: all.length, hit: all.filter(x => x.hit).length };
    };
    const cal = ['narrow', 'mid', 'wide'].map(w => ({ w, ...rate(w) }));
    const bars = cal.map(c => {
      const pct = c.n ? Math.round((c.hit / c.n) * 100) : 0;
      return `<div class="est-bar"><span>${EST_W[c.w].label.split(' ')[0]}</span><div class="est-track"><i style="width:${pct}%"></i></div><b>${c.n ? `${c.hit}/${c.n}` : '–'}</b></div>`;
    }).join('');
    const extra = `<div class="est-cal"><h5>🧭 확신 점검</h5>${bars}
      <p class="ng-note">좁게 말한 답이 자주 맞으면 확신이 알맞아요. 자주 빗나가면 넓게 말하는 연습을 해 봐요.</p></div>`;
    await submit('estimate', est.pts, box, { max: 240, unlockHint: '조금만 더 맞히면 도감 카드가 열려요.', extra });
  }

  // ───────── 4. 거꾸로 질문소: 타일 5개로 답을 만든다 (75초, 두 수 → 세 수, 연산 미션 · 힌트) ─────────
  const RV_TIME = 75;
  const RV_TIERS = [[6, 8, 10, 12], [15, 18, 20, 24]];
  const RV_OPS = ['+', '-', '*', '/'];
  const rv = { box:null, target:0, tiles:[], tok:[], made:new Map(), score:0, left:RV_TIME, accepted:0,
               mission:null, missionDone:false, hinted:false, ops:new Set(), last:null, msg:'', lastIdx:-1 };
  const RING_C = 2 * Math.PI * 44;

  function evalTokens(t){
    if(t.length % 2 === 0 || t.length < 1) return null;
    const vals = [t[0]], adds = [];
    for(let i = 1; i < t.length; i += 2){
      const op = t[i], n = t[i + 1];
      if(op === '*') vals[vals.length - 1] *= n;
      else if(op === '/'){
        if(n === 0) return null;
        const v = vals[vals.length - 1] / n;
        if(!Number.isInteger(v)) return null;
        vals[vals.length - 1] = v;
      }else{ vals.push(n); adds.push(op); }
    }
    let r = vals[0];
    for(let i = 0; i < adds.length; i++) r = adds[i] === '+' ? r + vals[i + 1] : r - vals[i + 1];
    return r;
  }
  // 타일로 만들 수 있는 식(두 수 또는 세 수, 한 타일은 식 안에서 한 번만)을 모두 찾는다 — 힌트와 출제 검사용
  function solutionsFor(tiles, target, maxNums){
    const out = [];
    const rec = (seq) => {
      if(seq.length >= 3 && seq.length % 2 === 1 && evalTokens(seq) === target) out.push(seq.slice());
      if(seq.length >= maxNums * 2 - 1) return;
      if(seq.length % 2 === 0){
        for(const n of tiles){
          if(seq.includes(n)) continue;
          rec([...seq, n]);
        }
      }else{
        for(const op of RV_OPS) rec([...seq, op]);
      }
    };
    rec([]);
    return out;
  }
  function rvMaxNums(){ return rv.accepted >= 3 ? 3 : 2; }
  function rvMakeTiles(target, tier){
    for(let k = 0; k < 80; k++){
      const t = shuffle(range(1, 9)).slice(0, 5);
      if(solutionsFor(t, target, tier === 0 ? 2 : 3).length) return t;
    }
    return [1, 2, 3, 4, 6];
  }
  function rvNewTarget(){
    const tier = rv.accepted >= 3 ? 1 : 0;
    const list = RV_TIERS[tier].filter(x => x !== rv.last);
    rv.target = list[rand(list.length)];
    rv.last = rv.target;
    rv.tiles = rvMakeTiles(rv.target, tier);
    rv.tok = []; rv.hinted = false; rv.lastIdx = -1;
    // 미션이 아직 안 끝났으면 그대로 두고, 끝났거나 처음이면 새 미션을 고른다
    if(!rv.mission || rv.missionDone){
      const ops = RV_OPS.filter(o => o !== rv.mission);
      rv.mission = ops[rand(ops.length)];
      rv.missionDone = false;
    }
    rv.msg = `이 답 ${rv.target} 을(를) 만들어 봐. 미션: ${OPNAME[rv.mission]} 를 써 보기 (+8)`;
  }
  function rvStart(box){
    rv.box = box; rv.score = 0; rv.left = RV_TIME; rv.accepted = 0; rv.made = new Map(); rv.ops = new Set();
    rv.mission = null; rv.missionDone = false;
    rvNewTarget();
    rvRender();
    every('reverse', 1000, rvTick);
  }
  function rvTick(){
    rv.left--;
    const fg = rv.box && rv.box.querySelector('.rv-ring-fg');
    if(fg) fg.style.strokeDashoffset = String(RING_C * (1 - rv.left / RV_TIME));
    const t = rv.box && rv.box.querySelector('#rv-time');
    if(t) t.textContent = String(Math.max(0, rv.left));
    const ring = rv.box && rv.box.querySelector('.rv-ring');
    if(ring) ring.classList.toggle('pulse', rv.left <= 10);
    if(rv.left <= 0){ rvEnd(); }
  }
  function rvText(t){ return t.map(x => typeof x === 'number' ? String(x) : OPSYM[x]).join(' '); }
  function rvCanon(t){
    if(t.length === 3 && (t[1] === '+' || t[1] === '*')){
      const a = Math.min(t[0], t[2]), b = Math.max(t[0], t[2]);
      return `${a}${t[1]}${b}`;
    }
    return t.join(' ');
  }
  function rvRender(){
    const box = rv.box; if(!box) return;
    const lastTok = rv.tok[rv.tok.length - 1];
    const nums = rv.tok.filter(x => typeof x === 'number').length;
    const canNum = typeof lastTok !== 'number' && nums < rvMaxNums();
    const canOp = rv.tok.length > 0 && typeof lastTok === 'number';
    box.innerHTML = '';
    const top = h('div', 'rv-top');
    top.innerHTML = `
      <div class="rv-ring-wrap">
        <svg class="rv-ring" viewBox="0 0 100 100" aria-hidden="true">
          <circle class="rv-ring-bg" cx="50" cy="50" r="44"/>
          <circle class="rv-ring-fg" cx="50" cy="50" r="44"
            style="stroke-dasharray:${RING_C.toFixed(1)};stroke-dashoffset:${(RING_C * (1 - rv.left / RV_TIME)).toFixed(1)}"/>
        </svg>
        <b id="rv-time">${rv.left}</b>
      </div>
      <div class="rv-target-wrap"><span class="rv-label">답 ${rv.accepted >= 3 ? '· 세 수 가능' : ''}</span>
        <div class="rv-target flipin" id="rv-target">${rv.target}</div></div>`;
    box.appendChild(top);
    box.appendChild(h('p', 'rv-mission' + (rv.missionDone ? ' done' : ''),
      `${rv.missionDone ? '✓ 미션 완료' : '미션'}: ${OPNAME[rv.mission]} (+8)`));
    // 타일 (한 식에서 한 번씩만 쓴다)
    const tiles = h('div', 'rv-tiles');
    rv.tiles.forEach(n => {
      const used = rv.tok.includes(n);
      const b = h('button', 'rv-tile' + (used ? ' used' : ''), String(n));
      b.type = 'button'; b.disabled = used || !canNum;
      b.addEventListener('click', () => rvTile(n));
      tiles.appendChild(b);
    });
    box.appendChild(tiles);
    // 식 줄
    const slot = h('div', 'rv-slot');
    if(rv.tok.length === 0) slot.appendChild(h('span', 'empty', '□'));
    rv.tok.forEach((x, i) => {
      const isNum = typeof x === 'number';
      const c = h('span', (isNum ? 'num' : 'op') + (i === rv.lastIdx ? ' snap' : ''), isNum ? String(x) : OPSYM[x]);
      slot.appendChild(c);
    });
    if(rv.tok.length && typeof lastTok === 'string') slot.appendChild(h('span', 'empty', '□'));
    slot.appendChild(h('span', 'eq', `= ${rv.target}`));
    box.appendChild(slot);
    // 연산 버튼
    const ops = h('div', 'rv-ops');
    RV_OPS.forEach(op => {
      const b = h('button', 'rv-op', OPSYM[op]);
      b.type = 'button'; b.disabled = !canOp;
      b.addEventListener('click', () => rvOp(op));
      ops.appendChild(b);
    });
    box.appendChild(ops);
    const bub = h('div', 'rv-bubble');
    bub.innerHTML = `<span class="rm-pose">${rumiPose(rv.hinted ? 'think' : 'idle', 40)}</span><span class="rm-msg">${esc(rv.msg)}</span>`;
    box.appendChild(bub);
    const row = h('div', 'ng-row');
    const ok = h('button', 'btn primary', '이 식 확인');
    ok.type = 'button'; ok.disabled = !(rv.tok.length >= 3 && typeof lastTok === 'number');
    ok.addEventListener('click', rvCheck);
    const undo = h('button', 'btn ghost', '지우기');
    undo.type = 'button'; undo.disabled = rv.tok.length === 0;
    undo.addEventListener('click', () => { rv.tok.pop(); rv.lastIdx = -1; rvRender(); });
    const hint = h('button', 'btn ghost', rv.hinted ? '힌트 사용함' : '루미 힌트 (−3점)');
    hint.type = 'button'; hint.disabled = rv.hinted;
    hint.addEventListener('click', rvHint);
    const stop = h('button', 'btn ghost', '여기까지');
    stop.type = 'button'; stop.addEventListener('click', rvEnd);
    row.append(ok, undo, hint, stop);
    box.appendChild(row);
    box.appendChild(h('p', 'ng-status', `만든 식 ${rv.made.size}개 · 점수 ${rv.score}`));
    const shelf = h('div', 'rv-shelf');
    [...rv.made.values()].slice(-6).forEach((t, i, arr) => {
      const c = h('span', 'rv-chip' + (i === arr.length - 1 ? ' slide' : ''), t);
      shelf.appendChild(c);
    });
    box.appendChild(shelf);
  }
  function rvTile(n){
    const last = rv.tok[rv.tok.length - 1];
    if(typeof last === 'number') return;
    if(rv.tok.includes(n)) return;
    rv.tok.push(n); rv.lastIdx = rv.tok.length - 1;
    if((typeof SFX !== 'undefined' ? SFX : null)) SFX.click();
    rvRender();
  }
  function rvOp(op){
    const last = rv.tok[rv.tok.length - 1];
    if(typeof last !== 'number') return;
    rv.tok.push(op); rv.lastIdx = rv.tok.length - 1;
    rvRender();
  }
  function rvSay(msg, pose){
    rv.msg = msg;
    const box = rv.box; if(!box) return;
    const m = box.querySelector('.rv-bubble .rm-msg'); if(m) m.textContent = msg;
  }
  function rvCheck(){
    const t = rv.tok;
    if(t.length < 3 || typeof t[t.length - 1] !== 'number'){ rvSay('식을 끝까지 만들어 봐!'); return; }
    const v = evalTokens(t);
    if(v === null){ rv.tok = []; rv.lastIdx = -1; rvRender(); rvSay('이 식은 딱 떨어지지 않아(나눗셈). 다시 해 봐!'); return; }
    if(v !== rv.target){
      rvSay(`${rvText(t)} = ${v} 야. ${rv.target} 이 되려면 다른 짝을 골라 봐!`);
      if((typeof SFX !== 'undefined' ? SFX : null)) SFX.wrong();
      return;
    }
    const key = rvCanon(t);
    if(rv.made.has(key)){ rvSay('같은 식이야. 다른 모양을 찾아봐!'); return; }
    // 점수: 기본 12 · 세 수 +6 · 처음 쓰는 연산 +4 · 미션 +8
    const nums = t.filter(x => typeof x === 'number').length;
    let pts = 12 + (nums === 3 ? 6 : 0);
    const notes = [];
    t.filter(x => typeof x === 'string').forEach(op => {
      if(!rv.ops.has(op)){ rv.ops.add(op); pts += 4; notes.push(`새 연산 ${OPSYM[op]} +4`); }
    });
    if(!rv.missionDone && t.includes(rv.mission)){ rv.missionDone = true; pts += 8; notes.push('미션 +8'); }
    rv.score += pts; rv.accepted++;
    rv.made.set(key, `${rvText(t)} = ${rv.target}`);
    if((typeof SFX !== 'undefined' ? SFX : null)) SFX.correct();
    // 맞힌 식은 빛나며 선반으로 미끄러진다
    const slot = rv.box.querySelector('.rv-slot');
    if(slot) slot.classList.add('glow');
    const praise = `✓ ${rvText(t)} = ${rv.target} · +${pts}${notes.length ? ' (' + notes.join(', ') + ')' : ''}`;
    later('reverse', 380, () => {
      rvNewTarget();
      rv.msg = praise + ' · ' + rv.msg;
      rvRender();
    });
  }
  function rvHint(){
    if(rv.hinted) return;
    rv.hinted = true;
    const tier = rv.accepted >= 3 ? 1 : 0;
    const sols = solutionsFor(rv.tiles, rv.target, tier === 0 ? 2 : 3);
    rv.score = Math.max(0, rv.score - 3);
    const op = sols.length ? sols[0][1] : null;
    rv.msg = op ? `루미: ${OPSYM[op]} 를 떠올려 봐! (−3점)` : '루미: 이 타일로는 식이 어려워. 다른 목표를 봐도 좋아. (−3점)';
    rvRender();
  }
  async function rvEnd(){
    if(!rv.box) return;
    halt('reverse');
    const box = rv.box;
    await submit('reverse', rv.score, box, { max: 400, unlockHint: '식을 조금 더 만들면 도감 카드가 열려요.' });
  }

  // ───────── 입구 · 창 닫기 ─────────
  const GAMES = {
    roomi:    { modal:'game-roomi',    stage:'ng-roomi-stage',    start: rmStart },
    balance:  { modal:'game-balance',  stage:'ng-balance-stage',  start: blStart },
    estimate: { modal:'game-estimate', stage:'ng-estimate-stage', start: estStart },
    reverse:  { modal:'game-reverse',  stage:'ng-reverse-stage',  start: rvStart }
  };
  function openMini(kind){
    const g = GAMES[kind]; if(!g) return;
    const modal = document.getElementById(g.modal);
    const box = document.getElementById(g.stage);
    if(!modal || !box) return;
    halt(kind);
    modal.classList.remove('hidden');
    if((typeof SFX !== 'undefined' ? SFX : null)) SFX.start();
    g.start(box);
    firstHint(kind, modal, box);
  }
  // ★ 2026-11-28 B11: 게임을 처음 열 때만 짧은 안내 한 줄(누르거나 6초가 지나면 사라진다). 한 번 본 게임은 다시 띄우지 않는다.
  const FIRST_HINT = {
    roomi:    '카드를 눌러 루미에게 예시를 보여 주세요',
    balance:  '블록을 눌러 오른쪽 접시에 올려 보세요',
    estimate: '슬라이더로 답을 고르고, 확신 정도를 골라 보세요',
    reverse:  '타일과 연산 버튼으로 식을 만들어 보세요'
  };
  function firstHint(kind, modal, box){
    const key = 'roomi_hint_' + kind;
    try{ if(localStorage.getItem(key)) return; localStorage.setItem(key, '1'); }catch(e){ return; }
    const card = modal.querySelector('.modal-card'); if(!card) return;
    const hint = h('div', 'ng-firsthint', `<span class="fh-hand" aria-hidden="true">👆</span><span>${FIRST_HINT[kind]}</span>`);
    card.insertBefore(hint, box);
    const off = () => { hint.remove(); card.removeEventListener('click', off, true); };
    card.addEventListener('click', off, true);
    later(kind, 6000, off);
  }
  // app.js 의 closeGame 이 창을 닫을 때 부른다: 그 게임의 타이머와 낡은 콜백을 모두 끊는다
  function stopMini(id){
    Object.keys(GAMES).forEach(k => { if(GAMES[k].modal === id) halt(k); });
  }

  [['btn-roomi','roomi'],['btn-balance','balance'],['btn-estimate','estimate'],['btn-reverse','reverse']].forEach(([id, kind]) => {
    const b = document.getElementById(id);
    if(b) b.addEventListener('click', () => openMini(kind));
  });

  window.MiniGames = { open: openMini, stop: stopMini };
  // 세계 의뢰(우물·풍차)가 게임을 열 때도 같은 입구를 쓴다
  window.openEstimate = () => openMini('estimate');
  window.openBalance = () => openMini('balance');
})();
