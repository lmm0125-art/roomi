// ============================================================
// 발표 도우미 (2026-11-28) — 발표 이야기 모드 · 단축키 · 보호자 요약 패널 · 다음 할 일 · 게임 기록 표시
//   · 발표 보기가 켜졌을 때(또는 발표 이야기 중에) 주로 쓴다. 아이 화면에는 기본으로 나오지 않는다.
//   · 보호자 요약은 PIN 을 통과해야만 보인다(아이가 발표 보기를 켰다고 우회되지 않게).
//   · app.js 의 state, $, api, goNav, chatOpen, chatModeSet, sendChat, startExplain, sendExplain,
//     openParentGate, openParentDashboard, presenterOn, setPresenter, startPlanStep, toast, esc 를 쓴다.
// ============================================================
(function(){
  'use strict';

  const DEMO_NICK = '데모_루미';
  const isTyping = () => { const a = document.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable); };
  // 보호자 확인을 통과한 탭에만 서버가 준 보호자 세션 토큰이 있다(app.js verifyParent 가 저장)
  const pinOK = () => { try{ return !!sessionStorage.getItem('roomi_parent_tok'); }catch(e){ return false; } };
  const isDemoUser = () => !!(state.user && state.user.nickname === DEMO_NICK);
  const wait = ms => new Promise(r => setTimeout(r, ms));

  // ───────── 0. 보호자 게이트 콜백 — verifyParent 가 성공하면 이 함수를 한 번 부른다 ─────────
  function gateThen(fn){
    window.__gateAfter = fn;
    openParentGate();
  }

  // ───────── 1. LLM 예열 (데모 계정 전용, 기록에 남지 않음) ─────────
  let warmState = 'idle';
  async function warm(){
    if(!isDemoUser()) return;
    warmState = 'busy'; paintWarm();
    try{
      const r = await api('/api/demo/warm', {}, 15000);
      warmState = r && r.ok ? `ready · ${r.ms}ms` : 'slow';
    }catch(e){ warmState = 'slow'; }
    paintWarm();
  }
  function paintWarm(){
    document.querySelectorAll('.pst-warm').forEach(el => { el.textContent = warmState === 'busy' ? 'LLM 예열 중…' : warmState === 'idle' ? '' : (warmState === 'slow' ? 'LLM 응답이 느려요' : 'LLM 준비됨 · ' + warmState.replace('ready · ', '')); });
  }

  // ───────── 2. 발표 이야기 모드: 일곱 장면, 실제 화면을 움직인다 ─────────
  const STORY = [
    { title:'루미의 방', say:'아이가 앱을 열면 루미가 먼저 기억을 꺼내 말을 걸어요.',
      spot:'#btn-today-start',
      run: async () => { goNav('myroom'); } },
    { title:'같이 공부', say:'막힌 문제를 물으면 루미는 답 대신 한 단계씩 생각을 도와줘요.',
      spot:'#chat-panel',
      run: async () => {
        await chatOpen(); chatModeSet('learn');
        $('#chat-text').value = '1/3 + 1/4 는 어떻게 계산해?';
        await sendChat(false);
      } },
    { title:'힌트 단계', say:'같은 문제에 힌트를 한 단계 더 요청하면, 힌트가 점점 구체적으로 바뀌어요.',
      spot:'#chat-track',
      run: async () => {
        if(!$('#chat-panel') || $('#chat-panel').classList.contains('hidden')){ await chatOpen(); chatModeSet('learn'); }
        $('#chat-text').value = '힌트 한 단계 더 주세요';
        await sendChat(false);
      } },
    { title:'내 말로 설명하기', say:'아이가 설명하면 루미가 검증하고, 등불이 켜지고, 보호자 요약에도 반영돼요.',
      spot:'#chat-log',
      run: async () => {
        if(!$('#chat-panel') || $('#chat-panel').classList.contains('hidden')){ await chatOpen(); chatModeSet('learn'); }
        startExplain({ concept:'분수의 덧셈' });
        $('#chat-text').value = '분모가 같으면 분자끼리 더하면 돼요';
        await sendExplain();
      } },
    { title:'등불과 나의 방', say:'설명 한 번이 기억 등불을 밝혀요. 등불은 시간이 지나면 흐려져서 다시 가르치게 돼요.',
      spot:'#lamp-list',
      run: async () => { chatClose(); goNav('myroom'); const l = $('#lamp-list'); if(l) l.scrollIntoView({ block:'center', behavior:'smooth' }); } },
    { title:'루미 연습실', say:'짧은 연습은 XP와 지식 도감 카드를 줘요. 셀은 주지 않아요. 오늘 기록은 한 번만 저장돼요.',
      spot:'#btn-balance',
      run: async () => { goNav('games'); } },
    { title:'보호자 요약', say:'보호자는 PIN 으로만 볼 수 있어요. 데모 PIN 을 직접 입력해 보세요.',
      spot:'#present-panel',
      run: async () => { gateThen(() => { openParentDashboard(); refreshPanel(); }); } }
  ];
  let story = { on:false, i:0, busy:false, el:null, spotEl:null };

  function startStory(){
    if(story.on) return;
    story.on = true; story.i = 0;
    buildStoryUI();
    warm();
    showStep(0, true);
  }
  function endStory(){
    story.on = false;
    if(story.el){ story.el.remove(); story.el = null; }
    if(story.spotEl){ story.spotEl.remove(); story.spotEl = null; }
    document.removeEventListener('keydown', onKey, true);
  }
  function buildStoryUI(){
    if(story.el) return;
    const el = document.createElement('div');
    el.className = 'pst-card';
    el.innerHTML = `
      <div class="pst-head"><span class="pst-count"></span><span class="pst-warm"></span>
        <button class="pst-x" type="button" aria-label="발표 이야기 끝내기">✕</button></div>
      <h4 class="pst-title"></h4>
      <p class="pst-say"></p>
      <div class="pst-row">
        <button class="btn ghost pst-prev" type="button">◀ 이전</button>
        <button class="btn primary pst-next" type="button">다음 ▶</button>
      </div>
      <div class="pst-chips"></div>
      <p class="pst-keys">키: 1–7 장면 이동 · → 다음 · ← 이전 · R 다시 · P 발표 보기 · Esc 끝내기</p>`;
    document.body.appendChild(el);
    story.el = el;
    el.querySelector('.pst-x').addEventListener('click', endStory);
    el.querySelector('.pst-prev').addEventListener('click', () => showStep(story.i - 1, false));
    el.querySelector('.pst-next').addEventListener('click', () => showStep(story.i + 1, false));
    el.querySelector('.pst-chips').innerHTML = STORY.map((s, k) => `<button type="button" class="pst-chip" data-k="${k}">${k + 1}</button>`).join('');
    el.querySelectorAll('.pst-chip').forEach(b => b.addEventListener('click', () => showStep(Number(b.dataset.k), true)));
    spot = document.createElement('div'); spot.className = 'pst-spot hidden';
    document.body.appendChild(spot); story.spotEl = spot;
    document.addEventListener('keydown', onKey, true);
    paintWarm();
  }
  let spot = null;
  function paintSpot(sel){
    if(!spot) return;
    const t = sel ? document.querySelector(sel) : null;
    if(!t){ spot.classList.add('hidden'); return; }
    const r = t.getBoundingClientRect();
    if(r.width === 0 || r.height === 0){ spot.classList.add('hidden'); return; }
    spot.classList.remove('hidden');
    spot.style.left = (r.left - 6) + 'px'; spot.style.top = (r.top - 6) + 'px';
    spot.style.width = (r.width + 12) + 'px'; spot.style.height = (r.height + 12) + 'px';
  }
  function paintStep(){
    if(!story.el) return;
    const S = STORY[story.i];
    story.el.querySelector('.pst-count').textContent = `발표 ${story.i + 1}/${STORY.length}`;
    story.el.querySelector('.pst-title').textContent = S.title;
    story.el.querySelector('.pst-say').textContent = S.say;
    story.el.querySelector('.pst-prev').disabled = story.i === 0 || story.busy;
    const next = story.el.querySelector('.pst-next');
    next.disabled = story.busy;
    next.textContent = story.i + 1 >= STORY.length ? '처음으로 ↺' : '다음 ▶';
    story.el.querySelectorAll('.pst-chip').forEach((b, k) => b.classList.toggle('on', k === story.i));
    paintSpot(S.spot);
  }
  async function showStep(k, rerun){
    if(!story.on) return;
    if(k < 0) return;
    if(k >= STORY.length){ k = 0; }
    story.i = k;
    paintStep();
    story.busy = true; paintStep();
    try{ await STORY[k].run(); }catch(e){ toast('이 장면은 지금 못 보여 줘요 · ' + (e.message || '')); }
    story.busy = false; paintStep();
    setTimeout(() => paintSpot(STORY[story.i].spot), 350);
  }
  function onKey(e){
    if(!story.on || isTyping()) return;
    const k = e.key;
    if(k >= '1' && k <= '7'){ e.preventDefault(); showStep(Number(k) - 1, true); return; }
    if(k === 'ArrowRight' || k === 'n' || k === 'N'){ e.preventDefault(); showStep(story.i + 1, false); return; }
    if(k === 'ArrowLeft'){ e.preventDefault(); showStep(story.i - 1, false); return; }
    if(k === 'r' || k === 'R'){ e.preventDefault(); showStep(story.i, true); return; }
    if(k === 'p' || k === 'P'){ e.preventDefault(); setPresenter(!presenterOn()); return; }
  }
  // 발표 보기 단축키는 이야기 모드 밖에서도 P 로 켜고 끈다
  document.addEventListener('keydown', e => {
    if(story.on || isTyping()) return;
    if((e.key === 'p' || e.key === 'P') && !e.metaKey && !e.ctrlKey && !e.altKey){ setPresenter(!presenterOn()); }
  });
  window.addEventListener('resize', () => { if(story.on) paintSpot(STORY[story.i].spot); });

  // ───────── 3. 보호자 요약 패널 (발표 보기 + PIN 통과 후에만) ─────────
  let panel = null, panelTimer = null;
  function ensurePanel(){
    if(panel) return panel;
    panel = document.createElement('aside');
    panel.id = 'present-panel';
    panel.className = 'present-panel hidden';
    panel.innerHTML = `<div class="pp-head"><b>보호자 요약 (발표용)</b><button type="button" class="pp-close" aria-label="패널 접기">–</button></div>
      <div class="pp-body"></div>`;
    document.body.appendChild(panel);
    panel.querySelector('.pp-close').addEventListener('click', () => panel.classList.toggle('mini'));
    return panel;
  }
  async function refreshPanel(){
    if(!presenterOn()) return;
    const p = ensurePanel();
    const body = p.querySelector('.pp-body');
    if(!pinOK()){
      body.innerHTML = `<p class="pp-note">보호자 PIN 을 입력하면 요약이 보여요.</p><button type="button" class="btn ghost pp-unlock">보호자 PIN 으로 열기</button>`;
      body.querySelector('.pp-unlock').addEventListener('click', () => gateThen(refreshPanel));
      p.classList.remove('hidden');
      return;
    }
    try{
      const d = await api('/api/parent/dashboard', undefined, 8000, 'GET');
      const taught = (d.taughtThisWeek || []).map(t => t.topic).slice(0, 5);
      body.innerHTML = `
        <div class="pp-stat"><b>${(d.lamps && d.lamps.total) || 0}</b><span>등불</span></div>
        <div class="pp-stat"><b>${(d.weekly && d.weekly.studyDays) || 0}일</b><span>이번 주 공부한 날</span></div>
        <div class="pp-list"><span>이번 주 가르친 것</span><ul>${taught.length ? taught.map(t => `<li>${esc(t)}</li>`).join('') : '<li class="none">아직 없어요</li>'}</ul></div>
        <p class="pp-note">${esc((d.weekly && d.weekly.suggestion) || '')}</p>
        <button type="button" class="btn ghost pp-refresh">새로고침</button>`;
      body.querySelector('.pp-refresh').addEventListener('click', refreshPanel);
    }catch(e){
      body.innerHTML = `<p class="pp-note">요약을 불러오지 못했어요. 잠시 후 다시 눌러 주세요.</p>`;
    }
    p.classList.remove('hidden');
  }
  function syncPanel(){
    if(presenterOn()){
      refreshPanel();
      if(!panelTimer) panelTimer = setInterval(() => { if(presenterOn() && pinOK()) refreshPanel(); }, 15000);
    }else{
      if(panel) panel.classList.add('hidden');
      if(panelTimer){ clearInterval(panelTimer); panelTimer = null; }
    }
  }

  // ───────── 4. 설명 뒤의 연쇄: 저장 → 등불 → 보호자 요약 (발표 보기에서만) ─────────
  function chainCard(concept, r){
    const log = $('#chat-log'); if(!log) return;
    const v = (r && r.verdict) || {};
    const card = document.createElement('div');
    card.className = 'chain-card';
    const saved = v.saved ? (v.stored === 'explain:verified' ? '검증된 설명으로 저장' : '미검증 설명으로 저장') : '이번 설명은 저장하지 않음(검증된 기억 유지)';
    card.innerHTML = `
      <p class="chain-title">한 번의 설명이 여기까지 이어졌어요</p>
      <ol class="chain-steps">
        <li class="done"><b>설명 저장</b><span>${esc(saved)}</span></li>
        <li class="done"><b>등불 밝힘</b><span>«${esc(concept || '방금 배운 것')}» 등불이 켜졌어요</span></li>
        <li class="done"><b>보호자 요약</b><span>가르친 것에 추가됐어요</span></li>
      </ol>
      <button type="button" class="btn ghost chain-open">지금 보호자 요약 보기</button>`;
    card.querySelector('.chain-open').addEventListener('click', () => gateThen(() => { openParentDashboard(); refreshPanel(); }));
    log.appendChild(card);
    log.scrollTop = log.scrollHeight;
    refreshPanel();
  }

  // ───────── 5. 다음 할 일 (마이룸 버튼): 계획 → 흐려진 등불 → 오늘 안 한 연습 → 대화 ─────────
  async function nextTodo(){
    try{
      const p = state.plan && state.plan.plan;
      const idx = p && p.steps ? p.steps.findIndex(s => !s.done) : -1;
      if(idx >= 0){ startPlanStep(p.steps[idx].id); return; }
    }catch(e){}
    try{
      const l = await api('/api/lamps', undefined, 8000, 'GET');
      const dim = (l.lamps || []).filter(x => !x.crystal).sort((a, b) => (b.decay || 0) - (a.decay || 0))[0];
      if(dim && dim.topic){
        await chatOpen(); chatModeSet('learn');
        startExplain({ concept: dim.topic });
        toast(`🧠 «${dim.topic}» 을 루미에게 설명해 볼래?`);
        return;
      }
    }catch(e){}
    try{
      const g = await api('/api/game/today', undefined, 8000, 'GET');
      const left = GAME_KINDS.filter(k => !(g.kinds || []).includes(k));
      if(left.length){ goNav('games'); toast('오늘 연습 한 판 해 볼래? 아직 기록이 없어요.'); return; }
    }catch(e){}
    await chatOpen();
    toast('루미와 이야기해 볼래?');
  }

  // ───────── 6. 게임 카드의 기록 표시: 「오늘 기록 저장됨 · 연습 가능」 ─────────
  const GAME_KINDS = ['roomi', 'balance', 'estimate', 'reverse', 'repair'];
  const CARD_KIND = { 'btn-roomi':'roomi', 'btn-balance':'balance', 'btn-estimate':'estimate', 'btn-reverse':'reverse', 'btn-repair':'repair' };
  async function refreshGameBadges(){
    let kinds = [];
    try{
      const g = await api('/api/game/today', undefined, 8000, 'GET');
      kinds = g.kinds || [];
    }catch(e){ return; }
    Object.keys(CARD_KIND).forEach(id => {
      const card = document.getElementById(id); if(!card) return;
      let b = card.querySelector('.gl-state');
      if(!b){ b = document.createElement('span'); b.className = 'gl-state'; card.querySelector('.gl-card-body')?.appendChild(b); }
      const done = kinds.includes(CARD_KIND[id]);
      b.textContent = done ? '오늘 기록 저장됨 · 연습 가능' : '오늘 첫 기록을 남겨 보세요';
      b.classList.toggle('done', done);
    });
  }
  window.refreshGameBadges = refreshGameBadges;

  // ───────── 7. 마이룸의 「다음 할 일」 버튼 ─────────
  document.addEventListener('click', e => {
    const b = e.target && e.target.closest && e.target.closest('#btn-next-todo');
    if(b) nextTodo();
  });

  // ───────── 공개 훅 (app.js 가 부른다) ─────────
  window.PresentHooks = {
    startStory,
    closeStory(){ if(story.on){ endStory(); return true; } return false; },
    explained(concept, r){ chainCard(concept, r); },
    presenterChanged(){ syncPanel(); if(presenterOn()) warm(); },
    refreshPanel,
    gateThen,
    isDemoUser,
    stepCount: STORY.length
  };
  syncPanel();
  refreshGameBadges();
  // 데모 스위치(ROOMI_DEMO=1)가 꺼진 서버에서는 발표용 데모 버튼을 감춘다
  api('/api/demo/status', undefined, 6000, 'GET').then(st => {
    if(!st || !st.enabled){ const b = document.getElementById('btn-demo-tour'); if(b) b.classList.add('hidden'); }
  }).catch(() => {});
})();
