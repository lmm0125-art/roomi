// ============================================================
// 루미(RooMi) — frontend (vanilla JS)
// ============================================================
const API = '';
// ★ P1-5 quests 초기값을 실제 구조({list,done})와 일치시킨다.
//   예전에는 [] 였는데 renderQuests 가 state.quests.done 을 바로 읽어
//   네트워크가 느릴 때 TypeError 가 날 수 있었다.
let state = { user:null, robot:null, template:'roundy', palette:{}, color:'#e74c3c', recolor:false,
              quests:{ list:[], done:[] }, parts:[], decors:[], skins:[], shards:[],
              itemQty:{}, shardProgress:null, shardTargets:[], overLimit:false, playMinutes:0, overplayDismissed:false,
              warned30:false, shopFilter:'all', voiceAuto:false, voiceChat:false, voiceWarned:false,
              plan:null, planToastShown:false, lastPlanStep:null, nudgeOptIn:true, nudgeDismissed:false,
              goals:null, goalToastShown:false, prefs:null, friendsChatEnabled:true, memories:[],
              reviewDue:0, reviewCards:[], reviewIndex:0,
              growth:{ level:1, exp:0, expNeeded:100, stage:1, streak:0 },
              room:null, chatMode:'chat', chatBusy:false, pz:null, shooter:null, explainMode:null,
              // ★ 2026-11-21 (v1.71): 기억 등불(/api/lamps) 스냅샷 + 루미가 건넨 «오늘의 한 걸음».
              //   두 값 모두 overplay(40분 종료) 잠금 화면에서 «내일 약속» 문장을 조립할 때 쓰인다.
              //   lamps 는 성장 탭에서만 다시 불러오고, nextAction 은 넛지가 렌더될 때 기억한다.
              lamps:null, nextAction:null,
              // ★ 2026-11-21 (v1.74): 삼막 온보딩 · 자연 마무리 · 기억 보관함 보기 상태.
              //   obStep/playLimitDelta 는 /api/user 최상위 계약 필드, windDown/pendingLock 은 C2
              //   «40분에 바로 잠그지 않고 자연스러운 마무리 지점에서 잠근다» 의 상태다.
              obStep:0, playLimitDelta:0, windDown:false, pendingLock:false,
              lampView:'grid', lampSort:'recent', _lampBorn:false };

const COLORABLE = ['antenna','head','body','arms','legs'];
const PALETTE = ['#e74c3c','#ff8c42','#f1c40f','#ffd93d','#2ecc71','#8bc34a',
                 '#1abc9c','#3498db','#9b59b6','#c39bd3','#e91e8c','#34495e'];
// ★ P2-2 기본 팔레트를 단일 진실 공급원으로 정의(2D robotSVG / 3D effectiveColors 공용).
//   예전에는 DEFAULT_PAL 이 app.js 에 두 번 정의돼 한쪽만 고치면 2D/3D 색이 어긋났다.
// ★ V3 재수정: PAL_BASE 를 여기(모듈 최상단)로 옮긴다.
//   원래 robotSVG() 함수 안(L26)에 있었는데, 중복 정의를 지우며 effectiveColors()
//   쪽 사본만 남기고 원본을 그대로 두었다 → effectiveColors 가 함수 밖 변수를 참조해
//   ReferenceError: PAL_BASE is not defined → startBabylon 이 catch → 3D 방이 안 뜨고
//   2D SVG 로 강등됐다.
  // 교훈: 상수 정의 개수만 세지 말고 어느 스코프에 있는지도 확인한다.
const PAL_BASE = {
  doro:   {body:'#5cae7f', head:'#93d6bc', antenna:'#2e7d4f', arms:'#2e7d4f', legs:'#2e7d4f'},
  roundy: {body:'#f2a65a', head:'#ffd9a8', antenna:'#c77b3a', arms:'#c77b3a', legs:'#b06a30'},
  boxy:   {body:'#6f9fd8', head:'#a8c8ec', antenna:'#3f6ea5', arms:'#3f6ea5', legs:'#3f6ea5'},
  tally:  {body:'#b585d6', head:'#d9b8e8', antenna:'#8a54ad', arms:'#8a54ad', legs:'#7a4699'},
};
const DEFAULT_PAL = { antenna:'#ffb020', head:'#9fb7d8', body:'#5c86c7', belly:'#e8f0fb', arms:'#5c86c7', legs:'#44618f' };

// ---------- 세션 키(브랜드 변경에 맞춰 roomi_ 로 통일) ----------
const SK = { uid:'roomi_uid', nick:'roomi_nick', token:'roomi_token', consent:'roomi_consent' };

// ---------- SVG 로봇 (3종 템플릿, 부위별 data-part) ----------
function robotSVG(template, pal){
  // PAL_BASE / DEFAULT_PAL 은 파일 최상단(모듈 스코프)에 정의되어 있다.
  const c = Object.assign({}, DEFAULT_PAL, PAL_BASE[template]||{}, pal||{});
  const eye='#25324a', cheek='#f7b2c1';
  // 통일 카와이이 얼굴(루미과 같은 스타일): 큰 타원 눈+하이라이트 / 미소 / 볼터치
  const face = (cx, ey, gap, s=1)=>{
    return `<ellipse cx="${cx-gap}" cy="${ey}" rx="${5*s}" ry="${8*s}" fill="${eye}"/><circle cx="${cx-gap+2*s}" cy="${ey-3*s}" r="${1.8*s}" fill="#fff"/>
      <ellipse cx="${cx+gap}" cy="${ey}" rx="${5*s}" ry="${8*s}" fill="${eye}"/><circle cx="${cx+gap-2*s}" cy="${ey-3*s}" r="${1.8*s}" fill="#fff"/>
      <path d="M${cx-8*s} ${ey+13*s} Q${cx} ${ey+21*s} ${cx+8*s} ${ey+13*s}" stroke="${eye}" stroke-width="${3.2*s}" fill="none" stroke-linecap="round"/>
      <circle cx="${cx-gap-13*s}" cy="${ey+13*s}" r="${5.5*s}" fill="${cheek}" opacity="0.8"/>
      <circle cx="${cx+gap+13*s}" cy="${ey+13*s}" r="${5.5*s}" fill="${cheek}" opacity="0.8"/>`;
  };
  const shine = (cx,cy,rx,ry)=>`<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#fff" opacity="0.25"/>`;
  const groundShadow = (cy,rx)=>`<ellipse cx="100" cy="${cy}" rx="${rx}" ry="9" fill="#000" opacity="0.10"/>`;
  const antenna = `<g data-part="antenna"><line x1="100" y1="14" x2="100" y2="34" stroke="${c.antenna}" stroke-width="5" stroke-linecap="round"/>
    <circle cx="100" cy="12" r="9" fill="${c.antenna}"/><circle cx="97" cy="9" r="2.2" fill="#fff" opacity="0.7"/></g>`;
  const legs = (y)=>`<g data-part="legs"><rect x="74" y="${y}" width="18" height="22" rx="8" fill="${c.legs}"/>
    <rect x="108" y="${y}" width="18" height="22" rx="8" fill="${c.legs}"/></g>`;
  const arms = (x1,x2,y,h,w)=>`<g data-part="arms"><rect x="${x1}" y="${y}" width="${w}" height="${h}" rx="${w/2}" fill="${c.arms}"/>
    <rect x="${x2}" y="${y}" width="${w}" height="${h}" rx="${w/2}" fill="${c.arms}"/></g>`;

  let s='';
  if(template==='roundy'){
    // 둥근이: 2단 구조(밝은 주황 머리 + 어두운 주황 둥근 몸), 배 패널 없음, 같은 계열 안테나/팔다리
    s = `${groundShadow(234,52)}
      ${antenna}
      ${arms(28,156,148,44,18)}
      <ellipse data-part="body" cx="100" cy="174" rx="46" ry="42" fill="${c.body}"/>
      <ellipse cx="100" cy="202" rx="30" ry="9" fill="#000" opacity="0.06"/>
      <ellipse data-part="head" cx="100" cy="80" rx="56" ry="50" fill="${c.head}"/>
      ${shine(74,64,12,26)}
      ${face(100,72,22,1.15)}
      ${legs(214)}`;
  } else if(template==='boxy'){
    // 네모이: 2단 구조(밝은 파란 사각 머리 + 어두운 파란 둥근 모서리 몸), 배 패널 없음
    s = `${groundShadow(236,50)}
      ${antenna}
      ${arms(22,158,140,56,16)}
      <rect data-part="body" x="58" y="124" width="84" height="90" rx="24" fill="${c.body}"/>
      <ellipse cx="100" cy="204" rx="30" ry="9" fill="#000" opacity="0.06"/>
      <rect data-part="head" x="46" y="28" width="108" height="94" rx="28" fill="${c.head}"/>
      ${shine(70,50,10,22)}
      ${face(100,74,24,1.1)}
      ${legs(214)}`;
  } else if(template==='doro'){
    // 공식 스타일: 마이룸 3D로 살아난 콩나물 캐릭터 — 2단 캡슐 바디(위 밝게/아래 어둡게) + 가는 콩나물 안테나 + 어두운 짧은 팔다리
    s = `<ellipse cx="100" cy="234" rx="48" ry="8" fill="#000" opacity="0.10"/>
      ${arms(30,152,150,44,15)}
      ${legs(210)}
      <rect data-part="body" x="56" y="128" width="88" height="86" rx="30" fill="${c.body}"/>
      <ellipse cx="100" cy="206" rx="30" ry="9" fill="#000" opacity="0.06"/>
      <rect data-part="head" x="54" y="52" width="92" height="96" rx="44" fill="${c.head}"/>
      <path d="M60 132 Q100 142 140 132 L140 150 Q100 158 60 150 Z" fill="#000" opacity="0.05"/>
      <ellipse cx="74" cy="86" rx="9" ry="24" fill="#fff" opacity="0.28"/>
      <ellipse cx="84" cy="100" rx="5" ry="8" fill="${eye}"/><circle cx="86" cy="96" r="1.6" fill="#fff"/>
      <ellipse cx="116" cy="100" rx="5" ry="8" fill="${eye}"/><circle cx="114" cy="96" r="1.6" fill="#fff"/>
      <circle cx="70" cy="114" r="5.5" fill="${cheek}" opacity="0.8"/><circle cx="130" cy="114" r="5.5" fill="${cheek}" opacity="0.8"/>
      <path d="M95 120 Q100 125 105 120" stroke="${eye}" stroke-width="3" fill="none" stroke-linecap="round"/>
      <g data-part="antenna"><path d="M100 52 L100 18" stroke="${c.antenna}" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M88 52 Q100 44 112 52 L112 58 Q100 50 88 58 Z" fill="${c.antenna}"/>
      <circle cx="100" cy="14" r="7.5" fill="${c.antenna}"/><circle cx="97.5" cy="11.5" r="2" fill="#fff" opacity="0.7"/></g>`;
  } else { // tally
    // 키다리: 2단 구조(밝은 보라 둥근 머리 + 어두운 보라 긴 캡슐 몸), 배 패널 없음
    s = `${groundShadow(238,44)}
      ${antenna}
      ${arms(34,152,112,72,13)}
      <rect data-part="body" x="70" y="104" width="60" height="114" rx="26" fill="${c.body}"/>
      <ellipse cx="100" cy="208" rx="24" ry="8" fill="#000" opacity="0.06"/>
      <ellipse data-part="head" cx="100" cy="60" rx="46" ry="42" fill="${c.head}"/>
      ${shine(80,46,9,20)}
      ${face(100,54,19,1)}
      ${legs(216)}`;
  }
  return `<svg viewBox="0 0 200 250" xmlns="http://www.w3.org/2000/svg">${s}</svg>`;
}
// ★ v1.48 «작은 크기 전용» 배지 로봇. 200×250 전체 로봇을 54px 원에 넣으면
//   다리·팔·안테나가 뭉개져 «아이콘이 흐릿하다». 머리+몸통+큰 눈만 남긴 100×100 도형으로
//   다시 그려 44px 에서도 표정이 읽히게 한다(대화 버튼 · 헤더 아바타는 전체 로봇 유지).
let _badgeSeq = 0;
function botBadgeSVG(template, pal){
  const c = Object.assign({}, DEFAULT_PAL, PAL_BASE[template]||{}, pal||{});
  const eye = '#26324a', cheek = '#f2a0b4';
  const gid = 'bb' + (++_badgeSeq);
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
    <defs>
      <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffffff" stop-opacity=".38"/>
        <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <ellipse cx="50" cy="92" rx="21" ry="4.2" fill="#1d3a63" opacity=".10"/>
    <rect x="48.7" y="13" width="2.6" height="14" rx="1.3" fill="${c.antenna}"/>
    <circle cx="50" cy="11.5" r="5.2" fill="${c.antenna}"/>
    <circle cx="48.4" cy="9.9" r="1.6" fill="#fff" opacity=".85"/>
    <rect x="22" y="24" width="56" height="38" rx="19" fill="${c.head}"/>
    <rect x="27" y="29" width="20" height="9" rx="4.5" fill="#fff" opacity=".20"/>
    <ellipse cx="39" cy="44" rx="5" ry="6.4" fill="${eye}"/>
    <ellipse cx="61" cy="44" rx="5" ry="6.4" fill="${eye}"/>
    <circle cx="40.9" cy="41.6" r="1.9" fill="#fff"/>
    <circle cx="62.9" cy="41.6" r="1.9" fill="#fff"/>
    <circle cx="37.4" cy="46.8" r="1" fill="#fff" opacity=".55"/>
    <circle cx="59.4" cy="46.8" r="1" fill="#fff" opacity=".55"/>
    <path d="M44.6 54 Q50 58 55.4 54" stroke="${eye}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
    <ellipse cx="30.5" cy="51" rx="4.2" ry="2.6" fill="${cheek}" opacity=".5"/>
    <ellipse cx="69.5" cy="51" rx="4.2" ry="2.6" fill="${cheek}" opacity=".5"/>
    <rect x="32" y="61" width="36" height="26" rx="13" fill="${c.body}"/>
    <rect x="32" y="61" width="36" height="12" rx="12" fill="url(#${gid})"/>
    <rect x="25.5" y="64" width="6.8" height="15" rx="3.4" fill="${c.arms}"/>
    <rect x="67.7" y="64" width="6.8" height="15" rx="3.4" fill="${c.arms}"/>
    <circle cx="50" cy="74" r="4" fill="#fff" opacity=".55"/>
    <ellipse cx="43" cy="89" rx="6" ry="3.4" fill="${c.legs || c.arms}"/>
    <ellipse cx="57" cy="89" rx="6" ry="3.4" fill="${c.legs || c.arms}"/>
  </svg>`;
}

// ---------- 유틸 ----------
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ============================================================
// ★ 2026-11-20 (v1.72) «귀엽고 고급스럽게» — UI 아이콘 + 루미 포즈 시스템
//   · uiIcon(): 스티커 풍 인라인 SVG 아이콘(24 viewBox · 2.2px 라운드 스트로크 · 아이콘별 미세 그라디언트)
//   · rumiPose(): 브랜드 로봇(단일 바이저 + 큰 눈 + 둥근 몸)의 7가지 포즈 SVG
//   · 두 함수 모두 «문자열 상수» 만 조립한다 — 사용자 입력이 섞일 길이 없다(XSS 안전).
//   · 그라디언트 id 는 호출 때마다 새로 붙인다(같은 아이콘을 여러 번 꽂아도 id 충돌이 없게).
// ============================================================
let _uiSvgSeq = 0;

const UI_ICONS = {
  // 셀 — 육각 허니코인 + 별
  cell: { g1:'#ffe066', g2:'#f5a623', draw: g=>`
    <polygon points="20.4,12 16.2,19.4 7.8,19.4 3.6,12 7.8,4.6 16.2,4.6" fill="url(#${g})" stroke="#c77800" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M12 7 L13.3 10.4 L17 10.6 L14.1 12.9 L15.1 16.4 L12 14.4 L8.9 16.4 L9.9 12.9 L7 10.6 L10.7 10.4 Z" fill="#fff8e1" stroke="#c77800" stroke-width="1.4" stroke-linejoin="round"/>` },
  // 등불 — 따뜻한 전구 + 광원
  lamp: { g1:'#ffe27a', g2:'#ffb020', draw: g=>`
    <circle cx="12" cy="12" r="10" fill="#ffd43b" opacity="0.22"/>
    <circle cx="12" cy="10.6" r="6.1" fill="url(#${g})" stroke="#d97706" stroke-width="2.2"/>
    <path d="M9.9 9.9 a2.5 2.5 0 0 1 2 -1.7" fill="none" stroke="#fff" stroke-width="1.4" stroke-linecap="round" opacity="0.8"/>
    <path d="M9.6 17.5 h4.8 M10.4 20 h3.2" fill="none" stroke="#d97706" stroke-width="2.2" stroke-linecap="round"/>` },
  // 안개 — 잿빛 구름
  fog: { g1:'#c3d2e2', g2:'#8fa7c0', draw: g=>`
    <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" fill="url(#${g})" stroke="#5f7490" stroke-width="2.2" stroke-linejoin="round"/>` },
  // 수정 — 얼음빛 프리즘
  crystal: { g1:'#c9ecff', g2:'#7cc4f5', draw: g=>`
    <path d="M12 2.8 L19.2 9.8 L12 21.2 L4.8 9.8 Z" fill="url(#${g})" stroke="#3b82a0" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M4.8 9.8 h14.4 M12 2.8 L8.9 9.8 L12 21.2 M12 2.8 L15.1 9.8 L12 21.2" fill="none" stroke="#eaf7ff" stroke-width="1.3" stroke-linejoin="round" opacity="0.9"/>` },
  // 탑 — 돌탑 + 깃발
  tower: { g1:'#e3eaf2', g2:'#a9bccd', draw: g=>`
    <path d="M12 6.6 V3.2" fill="none" stroke="#55677e" stroke-width="1.8" stroke-linecap="round"/>
    <path d="M12 3.2 h4.6 l-1.5 1.7 1.5 1.7 H12 Z" fill="#ff8787" stroke="#c92a2a" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="M8 20.6 V9.6 L10.4 6.8 h3.2 L16 9.6 V20.6 Z" fill="url(#${g})" stroke="#55677e" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M10.8 20.6 v-2.4 a1.2 1.2 0 0 1 2.4 0 v2.4" fill="none" stroke="#55677e" stroke-width="1.6" stroke-linecap="round"/>` },
  // 별
  star: { g1:'#ffe27a', g2:'#ffb020', draw: g=>`
    <path d="M12 4 L14.1 9.8 L20.2 9.9 L15.3 13.7 L17.1 19.6 L12 16.1 L6.9 19.6 L8.7 13.7 L3.8 9.9 L9.9 9.8 Z" fill="url(#${g})" stroke="#c77800" stroke-width="2.2" stroke-linejoin="round"/>` },
  // 하트
  heart: { g1:'#ffb3c1', g2:'#f06595', draw: g=>`
    <path d="M12 20.2 C7.2 16.4 4 13.2 4 9.8 C4 7.4 5.9 5.6 8.2 5.6 C9.7 5.6 11.1 6.4 12 7.7 C12.9 6.4 14.3 5.6 15.8 5.6 C18.1 5.6 20 7.4 20 9.8 C20 13.2 16.8 16.4 12 20.2 Z" fill="url(#${g})" stroke="#c2255c" stroke-width="2.2" stroke-linejoin="round"/>` },
  // 선물 상자
  gift: { g1:'#ffc9d4', g2:'#f783ac', draw: g=>`
    <rect x="4.6" y="10.6" width="14.8" height="9.2" rx="1.6" fill="url(#${g})" stroke="#c2255c" stroke-width="2.2"/>
    <rect x="3.4" y="7.2" width="17.2" height="3.6" rx="1.4" fill="url(#${g})" stroke="#c2255c" stroke-width="2.2"/>
    <path d="M12 7.2 V19.8" fill="none" stroke="#c2255c" stroke-width="2.2"/>
    <path d="M12 7 C10.2 3.2 6.2 4.4 7.3 6.5 C7.9 7.6 10 7.3 12 7 Z" fill="url(#${g})" stroke="#c2255c" stroke-width="1.5" stroke-linejoin="round"/>
    <path d="M12 7 C13.8 3.2 17.8 4.4 16.7 6.5 C16.1 7.6 14 7.3 12 7 Z" fill="url(#${g})" stroke="#c2255c" stroke-width="1.5" stroke-linejoin="round"/>` },
  // 책
  book: { g1:'#a5d8ff', g2:'#4dabf7', draw: g=>`
    <path d="M6.8 3.6 H18.4 a1.9 1.9 0 0 1 1.9 1.9 V20.4 H6.8 A2.6 2.6 0 0 1 4.2 17.8 V6.2 A2.6 2.6 0 0 1 6.8 3.6 Z" fill="url(#${g})" stroke="#1971c2" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M4.2 17.8 A2.6 2.6 0 0 1 6.8 15.2 H20.3" fill="none" stroke="#1971c2" stroke-width="2.2" stroke-linecap="round"/>` },
  // 체크 배지
  check: { g1:'#b2f2bb', g2:'#69db7c', draw: g=>`
    <circle cx="12" cy="12" r="9" fill="url(#${g})" stroke="#2f9e44" stroke-width="2.2"/>
    <path d="M8 12.4 l2.7 2.8 L16.4 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>` },
  // 반짝 — 네갈래 별
  spark: { g1:'#ffe066', g2:'#fcc419', draw: g=>`
    <path d="M12 3 C12.9 8.1 15.9 11.1 21 12 C15.9 12.9 12.9 15.9 12 21 C11.1 15.9 8.1 12.9 3 12 C8.1 11.1 11.1 8.1 12 3 Z" fill="url(#${g})" stroke="#e67700" stroke-width="2.2" stroke-linejoin="round"/>` },
  // 방패
  shield: { g1:'#d0ebff', g2:'#74c0fc', draw: g=>`
    <path d="M12 2.9 L19.1 5.4 V11.1 C19.1 15.9 16.2 19.4 12 21.1 C7.8 19.4 4.9 15.9 4.9 11.1 V5.4 Z" fill="url(#${g})" stroke="#1864ab" stroke-width="2.2" stroke-linejoin="round"/>
    <path d="M9.3 11.6 l1.9 2 3.6 -3.8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` },
  // 달
  moon: { g1:'#d0bfff', g2:'#9775fa', draw: g=>`
    <path d="M21 12.8 A9 9 0 1 1 11.2 3 A7 7 0 0 0 21 12.8 Z" fill="url(#${g})" stroke="#6741d9" stroke-width="2.2" stroke-linejoin="round"/>` },
  // 친구 — 두 사람
  friend: { g1:'#ffd8a8', g2:'#ff922b', draw: g=>`
    <circle cx="16.4" cy="8.8" r="2.9" fill="url(#${g})" stroke="#e8590c" stroke-width="2"/>
    <path d="M15.4 15.3 c2.9 0.4 5.3 2.3 5.6 4.5" fill="none" stroke="#e8590c" stroke-width="2" stroke-linecap="round"/>
    <circle cx="8.6" cy="8.6" r="3.4" fill="url(#${g})" stroke="#e8590c" stroke-width="2.2"/>
    <path d="M2.9 19.8 c0-3.3 2.6-5.3 5.7-5.3 s5.7 2 5.7 5.3 Z" fill="url(#${g})" stroke="#e8590c" stroke-width="2.2" stroke-linejoin="round"/>` },
};

// 스티커 아이콘 한 개를 문자열로 만든다. name 은 UI_ICONS 의 키만 허용한다.
function uiIcon(name, size=18){
  const spec = UI_ICONS[name];
  if(!spec) return '';
  const g = `ui-grad-${++_uiSvgSeq}`;
  const s = Number(size) || 18;
  return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">` +
    `<defs><linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${spec.g1}"/><stop offset="1" stop-color="${spec.g2}"/>` +
    `</linearGradient></defs>${spec.draw(g)}</svg>`;
}

// ---------- 루미 포즈 (7가지) — 빈 화면·타이핑·모달 머리·잠금 화면 공용 ----------
function rumiPose(kind, size=64){
  const s = Number(size) || 64;
  const g = `rumi-grad-${++_uiSvgSeq}`;
  // 브랜드 팔레트: 바이저는 진청(#2e4b43 계열), 몸은 민트 콩나물 톤
  const B1='#d9f3e6', B2='#a9dfc3', ARM='#57a37f', EDGE='#3f8a6b', VIS='#2e4b43', VIS_EDGE='#1f332c', GLOW='#a7f3d0';
  const shadow = `<ellipse cx="32" cy="57.5" rx="15" ry="3" fill="#0b3d2c" opacity="0.10"/>`;
  const legs = `<rect x="22" y="49" width="8.5" height="7" rx="3.4" fill="${ARM}"/><rect x="33.5" y="49" width="8.5" height="7" rx="3.4" fill="${ARM}"/>`;
  const antenna = `<path d="M32 18.5 V13.5" fill="none" stroke="#e8590c" stroke-width="2.2" stroke-linecap="round"/><circle cx="32" cy="11" r="3.2" fill="#ffb020" stroke="#e8590c" stroke-width="1.8"/>`;
  const body = `<ellipse cx="32" cy="35" rx="19" ry="17.5" fill="url(#${g})" stroke="${EDGE}" stroke-width="2.2"/>`;
  const visor = `<rect x="16.5" y="25.5" width="31" height="15.5" rx="7.75" fill="${VIS}" stroke="${VIS_EDGE}" stroke-width="2"/>`;
  const armL = `<rect x="10.5" y="33.5" width="6" height="11.5" rx="3" fill="${ARM}"/>`;
  const armR = `<rect x="47.5" y="33.5" width="6" height="11.5" rx="3" fill="${ARM}"/>`;
  const eyes = (cy=33.2, r=2.7)=>`<circle cx="25.5" cy="${cy}" r="${r}" fill="${GLOW}"/><circle cx="26.3" cy="${cy-0.9}" r="0.9" fill="#fff"/><circle cx="38.5" cy="${cy}" r="${r}" fill="${GLOW}"/><circle cx="39.3" cy="${cy-0.9}" r="0.9" fill="#fff"/>`;
  const smile = `<path d="M29 44.5 Q32 46.8 35 44.5" fill="none" stroke="${EDGE}" stroke-width="1.9" stroke-linecap="round"/>`;
  const FACES = {
    // idle — 큰 눈 + 온화한 미소(기본 자세)
    idle: eyes() + smile,
    // sleep — 감은 눈 + zZ
    sleep: `<path d="M22.8 33.4 q2.7 2.6 5.4 0 M35.8 33.4 q2.7 2.6 5.4 0" fill="none" stroke="${GLOW}" stroke-width="2" stroke-linecap="round"/>` +
      `<path d="M45 12.5 h6 l-6 6 h6" fill="none" stroke="#8fb8d8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<path d="M53.5 22.5 h4 l-4 4 h4" fill="none" stroke="#b6cfe4" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
    // think — 눈을 올리고 «?» 말풍선
    think: eyes(31.6) + smile +
      `<circle cx="51.5" cy="11.5" r="6.8" fill="#fff" stroke="#9fb7d8" stroke-width="2"/>` +
      `<path d="M49.8 9.9 a1.9 1.9 0 1 1 3 1.6 c-0.8 0.5 -1.1 1 -1.1 1.8" fill="none" stroke="#6f9fd8" stroke-width="1.8" stroke-linecap="round"/>` +
      `<circle cx="51.7" cy="15.7" r="1" fill="#6f9fd8"/>`,
    // happy — 초승달 눈 + 볼터치
    happy: `<path d="M22.7 34.3 q2.8 -3.6 5.6 0 M35.7 34.3 q2.8 -3.6 5.6 0" fill="none" stroke="${GLOW}" stroke-width="2.2" stroke-linecap="round"/>` +
      `<circle cx="18.8" cy="41.5" r="3" fill="#ffb3c1" opacity="0.85"/><circle cx="45.2" cy="41.5" r="3" fill="#ffb3c1" opacity="0.85"/>` +
      `<path d="M28 44 Q32 48 36 44" fill="none" stroke="${EDGE}" stroke-width="2.2" stroke-linecap="round"/>`,
    // sad — 눈물 + 시무근 입
    sad: `<path d="M22.8 32.8 q2.7 2.9 5.4 0 M35.8 32.8 q2.7 2.9 5.4 0" fill="none" stroke="${GLOW}" stroke-width="2" stroke-linecap="round"/>` +
      `<ellipse cx="41.6" cy="38.6" rx="1.7" ry="2.4" fill="#74c0fc"/>` +
      `<path d="M29.5 46 Q32 43.8 34.5 46" fill="none" stroke="${EDGE}" stroke-width="1.9" stroke-linecap="round"/>`,
    // wave — 오른팔을 위로 흔든다
    wave: eyes() + `<ellipse cx="32" cy="45" rx="2.5" ry="1.9" fill="#35614d"/>`,
    // oops — 놀란 큰 눈 + 삐뚤진 입 + 식은땀
    oops: eyes(33, 3.1) +
      `<ellipse cx="32.5" cy="45.2" rx="2.1" ry="2.7" fill="#35614d" transform="rotate(12 32.5 45.2)"/>` +
      `<ellipse cx="48.5" cy="19.5" rx="1.9" ry="2.7" fill="#74c0fc"/>`,
  };
  const face = FACES[kind] || FACES.idle;
  // wave 포즈는 오른팔을 «위로 든 팔 + 흔적 선» 으로 교체한다
  const arms = kind === 'wave'
    ? armL +
      `<path d="M50.5 43 L53.5 31.5" fill="none" stroke="${ARM}" stroke-width="5" stroke-linecap="round"/>` +
      `<circle cx="54.2" cy="28.6" r="3.4" fill="${B1}" stroke="${EDGE}" stroke-width="2"/>` +
      `<path d="M58.6 24.6 l2.4 -1.6 M59.4 29.9 l2.9 0.3" fill="none" stroke="#f5a623" stroke-width="1.8" stroke-linecap="round"/>`
    : armL + armR;
  return `<svg viewBox="0 0 64 64" width="${s}" height="${s}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">` +
    `<defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${B1}"/><stop offset="1" stop-color="${B2}"/></linearGradient></defs>` +
    shadow + legs + arms + antenna + body + visor + face + `</svg>`;
}

// ---------- 빈 상태 카드 (루미 포즈 + 안내 문구) ----------
// msg 는 고정 문구/서버 에러 문구만 들어가므로 esc 로 한 번 더 막는다.
// ★ 2026-11-21 (v1.74) C4 «전역 다시 시도»: 세 번째 인자에 함수를 넘기면 «다시 시도» 버튼을
//   얹는다. HTML 문자열만 돌려받는 구조라 재시도 함수는 ES_RETRIES 토큰 표에 넣어 두고,
//   문서 하나에 단 하나의 위임 리스너가 토큰을 찾아 실행한다(중복 바인딩 0).
const ES_RETRIES = {};
let _esRetrySeq = 0;
function emptyState(kind, msg, retryFn){
  const poseSize = 64;
  let retryBtn = '';
  if(typeof retryFn === 'function'){
    const token = 'esr' + (++_esRetrySeq);
    ES_RETRIES[token] = retryFn;
    retryBtn = `<button type="button" class="btn ghost small" data-es-retry="${token}">다시 시도</button>`;
  }
  return `<div class="empty-state"><div class="empty-art">${rumiPose(kind, poseSize)}</div><p>${esc(msg)}</p>${retryBtn}</div>`;
}
// «다시 시도» 위임 — emptyState 로 그려진 모든 버튼이 이 한 줄로 동작한다
document.addEventListener('click', (e)=>{
  const b = e.target.closest ? e.target.closest('[data-es-retry]') : null;
  if(!b) return;
  const fn = ES_RETRIES[b.dataset.esRetry];
  if(typeof fn === 'function'){ delete ES_RETRIES[b.dataset.esRetry]; fn(); }
});

// ---------- 로딩 스켈레톤 (3~5개 선, 데이터 도착 시 통째로 교체된다) ----------
// ★ 스켈레톤에는 루미 포즈를 넣지 않는다(가짜 루미가 깜빡이면 오히려 수상해 보인다).
function fillSkeleton(el, n=4){
  if(!el) return;
  const w = ['w60','w80','w40','w60'];
  el.innerHTML = Array.from({ length: Math.max(3, Math.min(6, n|0)) },
    (_,i)=>`<div class="sk sk-line ${w[i % 4]}"></div>`).join('');
}

// ---------- [data-icon] 정적 아이콘 교체 ----------
// index.html 에 표시만 해 둔 자리를 uiIcon SVG 로 바꾼다.
//  · 요소가 «아이콘 이모지만» 담고 있으면 innerHTML 로 통째로 교체
//  · 다른 요소(숫자·문자)와 섞여 있으면 «첫 번째 비어있지 않은 텍스트 노드만» SVG 로 바꿔
//    뒤쪽 텍스트 구조를 그대로 보존한다(예: 셀 잔액 pill 의 «🪙 [숫자] 셀»).
function replaceStaticIcons(){
  $$('[data-icon]').forEach(el=>{
    if(el.dataset.iconDone) return;
    const name = String(el.dataset.icon || '').trim();
    if(!name || !UI_ICONS[name]){ return; }
    const size = Number(el.dataset.iconSize) || 18;
    if(el.children.length){
      const t = document.createElement('template');
      t.innerHTML = uiIcon(name, size);
      const svg = t.content.firstElementChild;
      const node = Array.from(el.childNodes).find(n=>n.nodeType===3 && n.textContent.trim());
      if(svg && node){ node.replaceWith(svg); el.dataset.iconDone = '1'; }
      return;
    }
    el.innerHTML = uiIcon(name, size);
    el.dataset.iconDone = '1';
  });
}

// ---------- 자주 쓰는 모달 제목 앞에 루미 얼굴 달기 ----------
// 잠금 화면(overplay)은 «단정한 화면» 으로 남겨 둔다 — 여기엔 절대 얼굴을 붙이지 않는다.
function injectModalFaces(){
  ['game-puzzle','game-tower','game-mole','game-sort','game-shooter','game-memory'].forEach(id=>{
    const m = document.getElementById(id);
    if(!m) return;
    const h = m.querySelector('.modal-card > h3');
    if(!h || h.querySelector('.modal-head-face')) return;
    const face = document.createElement('span');
    face.className = 'modal-head-face';
    face.innerHTML = rumiPose('idle', 26);
    h.insertBefore(face, h.firstChild);
  });
}

// ---------- «루미 모먼트» 1회 주입 (init 에서 한 번만) ----------
function injectRumiMoments(){
  // 기억 등불 «빈 상태»: p.hint 를 empty-state 로 승급시킨다.
  // id 를 그대로 유지하므로 renderLamps 의 hidden 토글은 그대로 동작한다.
  const le = document.getElementById('lamp-empty');
  if(le && !le.querySelector('.empty-state')){
    const div = document.createElement('div');
    div.id = 'lamp-empty';
    div.className = 'lamp-empty';
    div.innerHTML = emptyState('wave', '루미에게 가르친 게 아직 없어요. 대화에서 새로운 걸 가르쳐 주면 등불이 켜져요!');
    le.replaceWith(div);
  }
  injectModalFaces();
}

// ---------- 심야 잠금 화면 «밤 모드» ----------
// 20시~새벽 6시 사이에만 night 클래스 + 자는 루미를 얹는다.
// ★ 잠금·해제·제외 로직은 그대로 — «보여줄 때 꾸며 주는» 일만 한다.
function applyOverplayNight(){
  const ov = document.getElementById('overplay');
  if(!ov) return;
  const h = new Date().getHours();
  const night = (h >= 20 || h < 6);
  const card = ov.querySelector('.modal-card') || ov;
  const pose = card.querySelector(':scope > .rumi-pose');
  if(night){
    ov.classList.add('night');
    if(!pose){
      const p = document.createElement('div');
      p.className = 'rumi-pose';
      p.innerHTML = rumiPose('sleep', 72);
      card.appendChild(p);
    }
  } else {
    ov.classList.remove('night');
    if(pose) pose.remove();
  }
}

// ============================================================
// ★ V11 신규: 효과음 · 자랑하기 · 랭킹 · 온보딩 · 저사양 자동조정
// ============================================================

// ---------- 효과음 (WebAudio, 에셋 0바이트) ----------
// 초등 대상에서 청각 피드백은 재미의 큰 부분인데 지금까지 소리가 전혀 없었다.
// 오디오 파일을 받지 않고 오실레이터로 만들므로 로딩 지연이 0 이다.
// 브라우저 정책상 AudioContext 는 '사용자 제스처' 이후에만 열리므로 첫 클릭에 함께 열린다.
const SFX = (()=>{
  let ctx = null;
  let on = true;
  try{ on = localStorage.getItem('roomi_sfx') !== '0'; }catch(e){}
  const ac = ()=>{
    if(!on) return null;
    try{
      if(!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      if(ctx.state === 'suspended') ctx.resume();
      return ctx;
    }catch(e){ return null; }
  };
  // 짧은 음 하나 — 주파수·길이·파형·볼륨·지연
  const tone = (freq, dur, type, vol, delay)=>{
    const c = ac(); if(!c) return;
    try{
      const t0 = c.currentTime + (delay || 0);
      const osc = c.createOscillator(), g = c.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.07, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(c.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.03);
    }catch(e){}
  };
  const seq = notes => notes.forEach(n => tone(n[0], n[1], 'triangle', 0.06, n[2]));
  return {
    get on(){ return on; },
    toggle(){
      on = !on;
      try{ localStorage.setItem('roomi_sfx', on ? '1' : '0'); }catch(e){}
      if(on){ const c = ac(); if(c) tone(880, 0.12, 'triangle', 0.07); }
      return on;
    },
    click(){ tone(620, 0.06, 'square', 0.03); },
    coin(){ seq([[880,0.09,0],[1320,0.14,0.07]]); },       // 셀 획득
    levelup(){ seq([[660,0.10,0],[880,0.10,0.09],[1175,0.22,0.18]]); },
    correct(){ seq([[740,0.08,0],[988,0.12,0.06]]); },
    wrong(){ seq([[300,0.14,0],[220,0.20,0.10]]); },
    start(){ seq([[520,0.08,0],[700,0.10,0.07]]); },
  };
})();

// 모든 버튼 클릭에 가벼운 소리(캡처 단계라 기존 핸들러를 방해하지 않는다)
document.addEventListener('click', e=>{
  const t = e.target;
  const b = t && t.closest ? t.closest('.btn, .navbtn, .tpl, .sw, .pad, [data-close]') : null;
  if(b) SFX.click();
}, true);

$('#btn-sfx').addEventListener('click', ()=>{
  const on = SFX.toggle();
  $('#btn-sfx').textContent = on ? '🔊' : '🔇';
  $('#btn-sfx').title = on ? '소리 끄기' : '소리 켜기';
});
(function initSfxIcon(){
  const b = $('#btn-sfx'); if(!b) return;
  b.textContent = SFX.on ? '🔊' : '🔇';
  b.title = SFX.on ? '소리 끄기' : '소리 켜기';
})();

const SCREEN_META = {
  start:['',''], create:['로봇 만들기','나만의 친구를 만들어요'],
  myroom:['마이룸','로봇이 살아있는 나의 공간'],
  games:['미니게임','버그 두더지 · 퍼즐 · 슈터'],
  workshop:['공작소','다시 칠하고, 성격을 만들고, 물어보기'],
  shop:['상점','부품과 스킨을 구경해요'],
  mail:['우편함','선생님과 루미의 편지'],
  friends:['친구','코드로 연결하고 서로 응원해요'],
  board:['리포트','성장과 셀 기록'],
  settings:['설정','나 · 소리와 글자 · 가족']
};
function show(id){
  $$('.screen').forEach(e=>e.classList.add('hidden'));
  $('#screen-'+id).classList.remove('hidden');
  const guest = id==='start';
  $('#topbar')?.classList.toggle('hidden', guest);
  $('#sidebar')?.classList.toggle('hidden', guest);
  $('#content')?.classList.toggle('guest', guest);
  $('#chat-fab')?.classList.toggle('hidden', guest);
  if(guest) $('#chat-panel')?.classList.add('hidden');
  const meta = SCREEN_META[id];
  if(meta && !guest){
    const t = $('#topbar-title'), s = $('#topbar-sub');
    if(t) t.textContent = meta[0];
    if(s) s.textContent = meta[1];
  }
  if(id==='games'){
    // 요일별 추천 게임(주간 순환)
    const rec = ['btn-mole','btn-puzzle','btn-shooter'][new Date().getDay() % 3];
    $$('.mg-card').forEach(c=>c.classList.toggle('recommend', c.id===rec));
  }
  if(!guest) syncSidebar();
}
let _balAnim = null;   // ★ 2026-11-20 (v1.72): 진행 중 count-up 애니메이션(중복 호출 시 취소용)
function setBalance(v){
  // ★ V11: 셀이 '늘어난' 순간에만 보상음을 낸다(단일 지점이라 모든 보상 경로를 잡는다).
  //   로딩·화면 전환처럼 값이 그대로일 때는 울리지 않는다.
  // ★ 2026-11-20 (v1.72): 숫자가 500ms 동안 굴러가는 count-up(ease-out) + .bump 맥박.
  //   «.bump» 는 스타일 담당이 그리는 클래스 — JS 는 붙였다 뗐다만 한다.
  //   첫 로딩(prev 없음)·같은 값일 때는 애니메이션 없이 바로 그린다.
  const prev = state._lastBalance;
  state._lastBalance = v;
  const el = $('#cell-balance');
  if(_balAnim){ cancelAnimationFrame(_balAnim); _balAnim = null; }
  const changed = prev != null && Number(prev) !== Number(v);
  if(el && changed){
    const from = Number(prev) || 0, to = Number(v) || 0;
    el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
    const t0 = performance.now(), DUR = 500;
    const easeOut = t => 1 - Math.pow(1 - t, 3);
    const step = now=>{
      const p = Math.min(1, (now - t0) / DUR);
      el.textContent = Math.round(from + (to - from) * easeOut(p));
      if(p < 1){ _balAnim = requestAnimationFrame(step); }
      else { _balAnim = null; el.classList.remove('bump'); }
    };
    _balAnim = requestAnimationFrame(step);
  } else {
    if(el) el.textContent = v;
  }
  if(prev != null && v > prev){
    SFX.coin();
    cellGain(v - prev);
  }
}
// ★ 2026-10-30: 셀 획득 순간의 작은 축하 애니메이션(+N, 코인 파티클, 배지 팝)
function cellGain(delta){
  if(!(delta > 0)) return;
  const badge = $('#cellbadge');
  if(!badge) return;
  const r = badge.getBoundingClientRect();
  if(!r.width) return;
  badge.classList.remove('pop'); void badge.offsetWidth; badge.classList.add('pop');
  const x = r.left + r.width/2, y = r.top + r.height/2;
  const float = document.createElement('div');
  float.className = 'cell-gain'; float.textContent = `+${delta} 🪙`;
  float.style.left = `${x}px`; float.style.top = `${y}px`;
  document.body.appendChild(float);
  setTimeout(()=>float.remove(), 1200);
  for(let i=0;i<7;i++){
    const c = document.createElement('span');
    c.className = 'coin-fly'; c.textContent = '🪙';
    const angle = (Math.PI*2*i)/7 + Math.random()*.5;
    const dist = 32 + Math.random()*26;
    c.style.left = `${x}px`; c.style.top = `${y}px`;
    c.style.setProperty('--dx', `${Math.cos(angle)*dist}px`);
    c.style.setProperty('--dy', `${Math.sin(angle)*dist}px`);
    document.body.appendChild(c);
    setTimeout(()=>c.remove(), 900);
  }
  if(navigator.vibrate){ try{ navigator.vibrate(15); }catch(e){} }
}
// ai=true 이면 DeepSeek 생성 문장임을 작게 표기
// ★ 2026-11-21 (v1.74) A2: 세 번째 인자 act({label,fn}) — 말풍선 «아래에» 작은 버튼을 얹는다.
//   robot/hello 의 안개 분기(fog)에서 «루미 다시 가르쳐 주기» 로 바로 연결하는 용도.
//   버튼이 있으면 노출 시간을 9초로 늘린다(누를 시간을 준다). 텍스트는 textContent 경로 그대로.
function bubble(text, ai, act){
  const b=$('#bubble'); b.textContent=text;
  if(ai){
    const c=document.createElement('span');
    c.className='ai-credit bubble-credit';
    c.innerHTML='Powered by <b>DeepSeek</b>';
    b.appendChild(c);
  }
  if(act && typeof act.fn === 'function'){
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bubble-act';
    btn.textContent = String(act.label || '가기');
    btn.onclick = (e)=>{ e.stopPropagation(); b.classList.add('hidden'); act.fn(); };
    b.appendChild(btn);
  }
  b.classList.remove('hidden');
  clearTimeout(b._t); b._t=setTimeout(()=>b.classList.add('hidden'), act && act.fn ? 9000 : 4500); }
// ★ v1.58 «같이 공부하는 로봇» — 기능 안내가 아니라 «기억하는 것» 으로 먼저 말을 건다.
// ★ 2026-11-21 (v1.74) A2/계약: hello 응답의 fog(안개에 잊힌 개념) 분기에는 말풍선 아래
//   «루미 다시 가르쳐 주기» 버튼을 붙여 goTeach 로 바로 연결하고,
//   parentCheer(가족의 한 마디)가 오면 인사가 닫힌 뒤 💌 로 한 번 더 말한다.
async function loadRobotHello(){
  try{
    const h = await api('/api/robot/hello', undefined, 8000, 'GET');
    // 규칙으로 만든 «기억» 문장이라 AI 생성 표기를 붙이지 않는다(로봇이 직접 말하는 느낌).
    if(h && h.line){
      const fogTopic = h.fog ? String(h.fog) : '';
      bubble(h.line, false, fogTopic ? { label:'루미 다시 가르쳐 주기', fn:()=>goTeach(fogTopic) } : null);
      if(h.parentCheer) setTimeout(()=>bubble('💌 ' + String(h.parentCheer)), 4800);
      return;
    }
  }catch(e){}
  if(state.robot && state.robot.greeting) bubble(state.robot.greeting);
}
// ★ v1.63: 아이가 가르쳐 준 개념을 «다시 설명해 달라» 고 먼저 물어본다.
//   LLM 없이 서버 규칙(/api/robot/recall)이 문장을 만든다.
async function loadRobotRecall(){
  try{
    const r = await api('/api/robot/recall', undefined, 8000, 'GET');
    if(!r || !r.ask) return;
    bubble(r.line);
    robotGesture('tilt');
    state.recallConcept = r.concept;
  }catch(e){}
}
// ★ v1.61 «자리를 비웠다 돌아오면» — 로봇이 먼저 알아본다(하루 한 번, 5분 이상 비웠을 때만).
let _awayAt = 0, _backSaidDay = '';
function todayKey(){ const d = new Date(); return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`; }
function setupPresence(){
  try{ _backSaidDay = localStorage.getItem('roomi_back_day') || ''; }catch(e){}
  document.addEventListener('visibilitychange', ()=>{
    if(document.hidden){ _awayAt = Date.now(); return; }
    if(!_awayAt) return;
    const mins = Math.round((Date.now() - _awayAt) / 60000);
    _awayAt = 0;
    if(mins < 5) return;
    const day = todayKey();
    if(_backSaidDay === day) return;
    try{ _backSaidDay = day; localStorage.setItem('roomi_back_day', day); }catch(e){}
    if(mins >= 30){ bubble('다녀왔어? 나 여기 있었어.'); robotGesture('wave'); }
    else { bubble('다녀왔구나! 이어서 해 볼까?'); robotGesture('nod'); }
  });
  // 테스트용(무해): 자리를 비운 시간을 흉내 낸다
  window.__presenceAway = ms=>{ _awayAt = Date.now() - ms; };
}

// ★ v1.61 «조금 쉬었다 하자» — 15분 넘게 앉아 있으면 로봇이 먼저 권한다(15·30·45분).
let _studyTimer = null, _studyStart = 0, _studyNudges = 0;
function startStudyTimer(){
  stopStudyTimer();
  _studyStart = Date.now();
  _studyTimer = setInterval(checkStudy, 15000);
}
function stopStudyTimer(){
  if(_studyTimer){ clearInterval(_studyTimer); _studyTimer = null; }
  _studyStart = 0; _studyNudges = 0;
}
function checkStudy(){
  if(!_studyStart) return;
  const mins = (Date.now() - _studyStart) / 60000;
  const need = _studyNudges === 0 ? 15 : _studyNudges === 1 ? 30 : 45;
  if(mins < need) return;
  _studyNudges++;
  if(_studyNudges <= 2){
    bubble('조금 쉬었다 하자. 물 한 모금 마시고 와!');
    // ★ 몇 번째 권유인지에 따라 실제 «need» 분(15/30) 을 그대로 보여준다.
    //   예전엔 두 번째 권유(30분)인데도 «15분 넘게» 로 고정돼 있었다.
    toast(`${need}분 넘게 앉아 있었어요`, 4000);
  }else{
    bubble('오늘은 여기까지 하자. 내일 또 같이 하자!');
    toast('오늘 학습은 여기까지', 4000);
  }
  robotGesture('stretch');
}
function breakNow(){ checkStudy(); }   // 테스트용

// ★ 2026-10-28: 화면 어디서든 보이는 짧은 알림
function toast(text, ms=3500){
  const t=$('#toast'); if(!t) return;
  t.textContent=text; t.classList.remove('hidden');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.add('hidden'), ms);
}
// ★ 2026-10-28: 답변 읽어주기(TTS)
function koVoices(){
  try{
    return window.speechSynthesis.getVoices()
      .filter(v=>String(v.lang||'').toLowerCase().startsWith('ko'));
  }catch(e){ return []; }
}
function pickVoice(){
  const vs = koVoices();
  if(!vs.length) return null;
  const saved = localStorage.getItem('roomi_voice_name');
  if(saved){ const hit = vs.find(v=>v.name === saved); if(hit) return hit; }
  const prefs = [/google/i, /sora/i, /yuna/i, /nara/i, /heami/i, /premium/i, /enhanced/i, /neural/i];
  for(const p of prefs){ const hit = vs.find(v=>p.test(v.name)); if(hit) return hit; }
  return vs[0];
}
function splitSpeech(text){
  const clean = String(text||'')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu,'')
    .replace(/\s+/g,' ').trim();
  if(!clean) return [];
  const parts = clean.replace(/([.!?])\s*/g,'$1|').split('|').filter(Boolean);
  const chunks = []; let buf = '';
  for(const p of parts){
    if((buf + ' ' + p).trim().length > 80){ if(buf) chunks.push(buf.trim()); buf = p; }
    else buf = (buf ? buf + ' ' : '') + p;
  }
  if(buf.trim()) chunks.push(buf.trim());
  return chunks;
}
let _speakSeq = 0;
// ★ v1.51 «말 끊기(barge-in)» — 루미가 말하는 중에 아이가 입을 열면 루미가 먼저 멈춘다.
//   예전엔 TTS 가 끝나야 마이크가 열려서, 아이가 «아니 그게» 라고 말해도 들리지 않았다.
let _barge = null, _bargeSeq = 0;
async function startBargeIn(){
  if(_barge || !state.voiceChat) return;
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
  const seq = ++_bargeSeq;
  try{
    const stream = await navigator.mediaDevices.getUserMedia({
      audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true }
    });
    if(seq !== _bargeSeq){ stream.getTracks().forEach(t=>t.stop()); return; }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser(); an.fftSize = 512; src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const startedAt = Date.now();
    let hits = 0;
    const timer = setInterval(()=>{
      if(Date.now() - startedAt < 700) return;      // 시작 구간의 잡음·에코는 무시
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for(const v of buf){ const x = (v - 128) / 128; sum += x * x; }
      const rms = Math.sqrt(sum / buf.length);
      if(rms > 0.075){
        if(++hits >= 3){
          stopBargeIn();
          try{ window.speechSynthesis.cancel(); }catch(e){}
          setTimeout(()=>{ if(state.voiceChat) startMic(true); }, 260);
        }
      }else hits = 0;
    }, 90);
    _barge = { stream, ctx, timer };
  }catch(e){ stopBargeIn(); }
}
function stopBargeIn(){
  _bargeSeq++;
  if(!_barge) return;
  try{ clearInterval(_barge.timer); }catch(e){}
  try{ _barge.ctx.close(); }catch(e){}
  try{ _barge.stream.getTracks().forEach(t=>t.stop()); }catch(e){}
  _barge = null;
}
function speak(text, onend){
  if(!('speechSynthesis' in window)) return toast('이 브라우저는 읽어주기를 지원하지 않아요.');
  const seq = ++_speakSeq;
  try{ window.speechSynthesis.cancel(); }catch(e){}
  // ★ 빈 텍스트 검사를 반드시 startBargeIn() «앞» 에서 끝낸다.
  //   예전엔 마이크(바지인 감시)를 먼저 열어 놓고 빈 텍스트라 return 해서
  //   읽어줄 것도 없는데 마이크만 열린 채 남았다.
  const chunks = splitSpeech(text);
  if(!chunks.length) return;
  stopBargeIn();
  if(state.voiceChat) startBargeIn();
  const voice = pickVoice();
  if(!voice && !state.voiceWarned){
    state.voiceWarned = true;
    toast('한국어 음성을 찾지 못했어요. 설정에서 목소리를 선택해 주세요.');
  }
  const rate = Math.min(1.15, Math.max(0.7, Number(localStorage.getItem('roomi_voice_rate')) || 0.9));
  let i = 0;
  const next = ()=>{
    if(seq !== _speakSeq) return;
    if(i >= chunks.length){ stopBargeIn(); if(typeof onend === 'function') onend(); return; }
    const u = new SpeechSynthesisUtterance(chunks[i++]);
    u.lang = 'ko-KR';
    if(voice) u.voice = voice;
    u.rate = rate; u.pitch = 1.0; u.volume = 1;
    u.onend = next;
    u.onerror = (e)=>{
      if(e && (e.error === 'interrupted' || e.error === 'canceled')) return;
      next();
    };
    try{ window.speechSynthesis.speak(u); }catch(e){}
  };
  next();
}
async function loadVoiceOptions(){
  const sel = $('#set-voice-name'); if(!sel) return;
  const vs = koVoices();
  const cur = localStorage.getItem('roomi_voice_name') || '';
  const opts = ['<option value="">자동 (가장 선명한 한국어)</option>'];
  for(const v of vs){
    const name = String(v.name||'').replace(/"/g,'&quot;');
    opts.push(`<option value="${name}" ${v.name===cur?'selected':''}>${esc(v.name)} (${esc(v.lang)})</option>`);
  }
  sel.innerHTML = opts.join('');
  if(cur && !vs.some(v=>v.name===cur)) sel.value = '';
}
function setVoiceChat(on){
  state.voiceChat = !!on;
  localStorage.setItem('roomi_voice_chat', on ? '1' : '0');
  const cb = $('#set-voice-chat'); if(cb) cb.checked = !!on;
}
async function api(path, body, timeoutMs, method){
  const o = { headers:{} };
  if(body){ o.method='POST'; o.headers['Content-Type']='application/json'; o.body=JSON.stringify(body); }
  if(method) o.method = method;
  const tk = localStorage.getItem(SK.token); // 세션 토큰 — uid 위조 방지
  if(tk) o.headers['X-Token'] = tk;
  const ac = new AbortController(); o.signal = ac.signal;
  // ★ v1.43: 1차 LLM(EXAONE)은 추론 때문에 20초 이상 걸릴 수 있다.
  //   프론트가 먼저 끊으면 «모델은 답했는데 아이 화면엔 실패» 가 되므로 여유를 둔다.
  const t = setTimeout(()=>ac.abort(), timeoutMs||40000);
  try{
    const r = await fetch(API+path,o);
    const txt = await r.text();
    let j;
    try{ j = JSON.parse(txt); }
    catch{ // HTML이 온다 = 서버가 없는 페이지(미리보기 창)에서 실행한 경우
      throw new Error('서버에 연결할 수 없어요. 미리보기 창이 아니라 실제 주소(localhost:3000 또는 온라인 주소)에서 열어주세요'); }
    if(!r.ok) throw new Error(j.error||'오류');
    return j;
  }catch(e){
    if(e.name==='AbortError') throw new Error('서버 응답이 늦어요. 잠시 후 다시 시도해주세요');
    throw e;
  }finally{ clearTimeout(t); }
}

// ---------- 내비게이션 ----------
$$('.navbtn').forEach(b=>b.addEventListener('click',()=>goNav(b.dataset.nav)));

// ============================================================
// ★ V15 공작소 / 우편함 / 수업 출석 (실행방안 P0-1 · P0-4 · P0-3)
// ============================================================

// ----- 공작소 (P0-1) -----
async function loadWorkshop(){
  const box = $('#ws-robot');
  const list = $('#ws-owned-list');
  let j;
  try{ j = await api('/api/workshop/status'); }
  catch(e){ box.innerHTML = `<span class="hint">${esc(e.message)}</span>`; return; }
  // 로봇 미리보기(2D SVG — 3D 로딩 실패와 무관하게 항상 보이게 한다)
  if(j.hasRobot){
    const pal = (state.robot && state.robot.palette) || {};
    box.innerHTML = `<div class="ws-preview">${robotSVG(state.robot.template, effectiveColors(state.robot.template, state.robot.palette))}</div>
      <div class="ws-meta"><b>${esc(j.robot.name)}</b>
      <span class="pers">성격 · ${esc(j.robot.personality)}</span>
      <span class="greet">"${esc(j.robot.greeting||'')}"</span></div>`;
  } else {
    box.innerHTML = '<span class="hint">아직 로봇이 없어요. 먼저 로봇을 만들어주세요!</span>';
  }
  $('#ws-recolor-limit').textContent = j.canRecolor ? '오늘 1회 가능' : '오늘은 완료 · 내일 다시';
  $('#ws-regen-limit').textContent = j.canRegenerate ? '오늘 1회 가능' : '오늘은 완료 · 내일 다시';
  $('#ws-recolor').disabled = !j.canRecolor || !j.hasRobot;
  $('#ws-regen').disabled = !j.canRegenerate || !j.hasRobot;
  $('#ws-ask-left').textContent = `오늘 ${j.askLeft}번 더 물어볼 수 있어요 (하루 5번)`;
  $('#ws-ask-btn').disabled = j.askLeft <= 0;
  list.innerHTML = (j.owned && j.owned.length)
    ? j.owned.map(o=>`<span class="ws-own">${esc(o.name)} <b>×${o.qty}</b></span>`).join('')
    : '<span class="hint">아직 없어요. 상점에서 부품을 사보세요!</span>';
}

// 색칠 다시 하기 — 로봇 생성 화면(캔버스·팔레트)을 '수정 모드'로 그대로 재사용한다.
//   같은 UI 를 두 번 만들면 2D/3D 색이 어긋나는 사고가 재발하므로 흐름을 공유한다.
function openRecolor(){
  const r = state.robot;
  if(!r) return;
  state.recolor = true;                       // 완성 버튼을 '저장' 으로 분기
  state.template = r.template;                // 템플릿은 유지(색만 바꾼다)
  state.palette = Object.assign({}, effectiveColors(r.template, r.palette));
  renderPicker();
  // 수정 모드 안내 + 템플릿 선택 숨김(템플릿은 못 바꾸므로 오해 방지)
  const tp = $('#template-picker');
  if(tp){ tp.classList.add('hidden'); }
  const card = $('#screen-create .card') || $('#screen-create');
  if(card && !$('#recolor-note')){
    const n = document.createElement('p');
    n.id = 'recolor-note'; n.className = 'hint recolor-note';
    n.textContent = ' 색칠 고치기 — 마음에 들면 아래 저장 버튼을 눌러요!';
    card.insertBefore(n, card.firstChild);
  }
  $('#btn-done').textContent = '저장! ';
  show('create');
}
// 수정 모드 종료(원래 만들기 화면 상태로 되돌린다)
function exitRecolor(){
  state.recolor = false;
  const tp = $('#template-picker'); if(tp) tp.classList.remove('hidden');
  const n = $('#recolor-note'); if(n) n.remove();
  $('#btn-done').textContent = '완성! ';
}
async function submitRecolor(){
  // ★ 이중 클릭 방지: 서버는 «1일 1회» 제한이라 연타로 두 번째 요청이
  //   거절 alert 를 띄운다. 제출 동안 버튼을 잠그고 finally 에서 푼다.
  const btn = $('#btn-done');
  if(btn && btn.disabled) return;
  if(btn){ btn.disabled = true; btn.textContent = '저장 중…'; }
  try{
    await api('/api/workshop/recolor', { palette: state.palette });
    const jr = await api('/api/robots/me');
    absorbRobotMe(jr);
    if(bjs.ready && state.robot) rebuildRobot(state.robot);
    updateChatFab();          // 색칠한 로봇을 대화 버튼에도 즉시 반영
    exitRecolor();            // 이 안에서 버튼 문구가 «완성!» 으로 돌아간다
    bubble(' 색칠을 바꿨어요!');
    goNav('workshop');
    maybeAct1();              // ★ 2026-11-21 (v1.74) B1 삼막 1막: «색칠 완료» 직후 인도
  }catch(e){
    if(btn) btn.textContent = '저장! ';   // 실패 시에만 문구 복구
    alert(e.message);
  }finally{ if(btn) btn.disabled = false; }
}
// 탭 전환을 코드에서도 쓸 수 있게 한 곳에 모은다(버튼 클릭과 동일 동작)
function goNav(name){
  $$('.navbtn').forEach(x=>x.classList.toggle('on', x.dataset.nav===name));
  $('#side-user')?.classList.toggle('on', name==='board');
  show(name);
  if(name==='shop') loadShop();
  // ★ v1.46: 앱 시작 시 토큰이 갱신되므로, 초기화 시점에 진행도를 부르면 401 이 난다.
  //   «게임 화면에 들어올 때» 지연 로딩해야 현재 토큰으로 조회된다.
  if(name==='games'){ loadCampaign(); sortLoadProgress(); }
  if(name==='board'){ loadBoard(); loadChatAnalysis(); }
  if(name==='workshop') loadWorkshop();
  if(name==='mail') loadMailbox();
  if(name==='friends') loadFriends();
  // ★ 2026-11-21 (v1.74) C6: 설정 화면 — 들어올 때마다 스위치 상태·한국어 음성 목록을 다시 맞춘다.
  if(name==='settings'){ applySettings(); }
  if(name==='myroom'){ if(state.robot) renderMyroom(); }
}
async function regeneratePersonality(){
  const b = $('#ws-regen');
  b.disabled = true;
  try{
    const r = await api('/api/workshop/regenerate', {}, 40000);
    if(state.robot){ state.robot.personality = r.personality; state.robot.greeting = r.greeting; }
    bubble(` 새 성격: ${r.personality}`);
    loadWorkshop();
    if(state.robot) renderMyroom();
  }catch(e){ alert(e.message); }
  finally{ b.disabled = false; }
}
async function askRobot(){
  const q = $('#ws-q').value.trim();
  if(q.length <2) return alert('무엇이 궁금한지 한 줄로 적어줄래?');
  const b = $('#ws-ask-btn');
  b.disabled = true; b.textContent = '생각하는 중…';
  const ans = $('#ws-answer');
  ans.classList.remove('hidden');
  ans.textContent = ' ...';
  try{
    const r = await api('/api/workshop/ask', { question:q }, 30000);
    // ★ 서버가 ai:true(실제 LLM 생성)/ai:false(규칙 폴백 문장) 로 알려준다.
    //   규칙으로 만든 문장까지 «AI 생성» 으로 표기하면 오해를 부르므로,
    //   ai 플래그가 참일 때만 크레딧을 보여준다.
    ans.innerHTML = `<b> 로봇의 대답</b><br>${esc(r.answer)}` +
      (r.ai ? `<div class="ai-credit-row"><span class="ai-credit">Powered by <b>DeepSeek</b></span></div>` : '');
    $('#ws-q').value = '';
    $('#ws-ask-left').textContent = `오늘 ${r.left}번 더 물어볼 수 있어요 (하루 5번)`;
    if(r.left <= 0) b.disabled = true;
  }catch(e){
    ans.innerHTML = `<span style="color:#c92a2a">${esc(e.message)}</span>`;
  }finally{ b.textContent = '물어보기'; }
}

// 공작소 버튼 바인딩(로봇이 있을 때만 동작)
$('#ws-recolor').addEventListener('click', openRecolor);
$('#ws-regen').addEventListener('click', regeneratePersonality);
$('#ws-ask-btn').addEventListener('click', askRobot);
$('#ws-q').addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); askRobot(); } });
$('#mail-claim-all').addEventListener('click', async ()=>{
  try{
    const r = await api('/api/mailbox/claim-all', {});
    if(!r.count) return bubble('받을 선물이 없어요');
    setBalance(r.balance);
    bubble(` ${r.count}통에서 ${r.cell}셀${r.items.length?' + '+r.items.join(', '):''} 받았어요!`);
    loadMailbox();
  }catch(e){ alert(e.message); }
});

// ----- 우편함 (P0-4) -----
async function loadMailbox(){
  // ★ 2026-11-20 (v1.72): await 동안 스켈레톤 → 도착하면 정상 렌더가 통째로 교체한다.
  fillSkeleton($('#mail-list'), 3);
  let j;
  try{ j = await api('/api/mailbox'); }
  catch(e){
    // ★ 2026-11-21 (v1.74) C4: 실패해도 «다시 시도» 버튼으로 다시 부를 수 있다.
    $('#mail-list').innerHTML = emptyState('oops', e.message || '편지를 불러오지 못했어요. 잠시 후 다시 시도해 줄래?', ()=>loadMailbox());
    return;
  }
  setMailBadge(j.unread);
  const claimable = j.mails.filter(m=>!m.claimed && (m.cell>0 || m.item));
  $('#mail-summary').textContent = claimable.length ? `받을 선물 ${claimable.length}개` : '받을 선물이 없어요';
  $('#mail-claim-all').disabled = claimable.length === 0;
  // ★ 2026-11-20 (v1.72): 빈 우편함은 글자 한 줄 대신 «자고 있는 루미» 빈 화면으로
  $('#mail-list').innerHTML = j.mails.length ? j.mails.map(m=>{
    const gift = [m.cell?` ${m.cell}셀`:'', m.item?` ${esc(m.item)}`:''].filter(Boolean).join(' · ');
    const state_ = m.claimed ? '<span class="done"> 받음</span>'
      : (gift ? `<button class="btn primary sm" data-claim="${m.id}"> 받기</button>` : '<span class="read">읽음</span>');
    // ★ 2026-11-21 (v1.74) A2: tag 가 'fog:' 로 시작하는 «안개 SOS» 편지에는
    //   «루미 다시 가르쳐 주기» 버튼을 붙여 goTeach(topic) 로 바로 연결한다.
    //   (서버가 tag 를 주지 않는 낡은 응답이면 버튼이 그냥 안 보인다 — 우아한 하락.)
    const fogTopic = String(m.tag || '').startsWith('fog:') ? String(m.tag).slice(4) : '';
    const fogBtn = fogTopic ? `<button class="btn ghost sm" data-fogteach="${esc(fogTopic)}">루미 다시 가르쳐 주기</button>` : '';
    return `<div class="mail ${m.claimed?'is-done':''}">
      <div class="mail-head"><b>${esc(m.title)}</b><span class="ts">${esc(String(m.ts||'').slice(0,16))}</span></div>
      ${m.body?`<div class="mail-body">${esc(m.body)}</div>`:''}
      ${gift?`<div class="mail-gift">${gift}</div>`:''}
      ${fogBtn?`<div class="mail-act">${fogBtn}</div>`:''}
      <div class="mail-act">${state_}</div>
    </div>`;
  }).join('') : emptyState('sleep', '아직 편지가 없어요. 과제를 하면 선물 편지가 도착해요!');
  // ★ 2026-11-21 (v1.74) A2: 안개 편지 → goTeach 딥링크
  $$('#mail-list [data-fogteach]').forEach(b=>b.addEventListener('click', ()=>goTeach(b.dataset.fogteach)));
  $$('#mail-list [data-claim]').forEach(b=>b.addEventListener('click', async ()=>{
    b.disabled = true;
    try{
      const r = await api('/api/mailbox/claim', { id: Number(b.dataset.claim) });
      setBalance(r.balance);
      bubble(` ${r.cell?`+${r.cell}셀 `:''}${r.item?`[${r.item}] `:''}받았어요!`);
      loadMailbox();
    }catch(e){ alert(e.message); b.disabled = false; }
  }));
}
async function refreshMailBadge(){
  try{ const j = await api('/api/mailbox'); setMailBadge(j.unread); }catch(e){}
}
function setMailBadge(n){
  const el = $('#mail-badge');
  if(!el) return;
  el.textContent = n;
  el.classList.toggle('hidden', !n);
}

// ----- 수업 출석 (P0-3) -----
async function loadClassCard(){
  const box = $('#class-card');
  if(!box) return;
  let j;
  try{ j = await api('/api/class/status'); }catch(e){ return; }
  if(j.attended){
    box.innerHTML = `<span class="em"></span>
      <div class="cc-body"><b>이번 주 수업 출석 완료!</b>
      <span>${esc(j.weekLabel)} · +${j.reward}셀 받았어요</span></div>
      <span class="cc-done"></span>`;
    return;
  }
  box.innerHTML = `<span class="em"></span>
    <div class="cc-body"><b>이번 주 수업 출석하기</b>
    <span>${esc(j.hint)}</span></div>
    <div class="cc-act">
      <input id="class-code" inputmode="numeric" maxlength="4" placeholder="코드">
      <button class="btn primary sm" id="class-go">출석 (+${j.reward}셀)</button>
    </div>`;
  $('#class-go').addEventListener('click', async ()=>{
    const code = $('#class-code').value.trim();
    if(!code) return alert('선생님이 알려준 코드를 넣어주세요');
    const b = $('#class-go');
    b.disabled = true; b.textContent = '확인 중…';
    try{
      const r = await api('/api/class/attend', { code });
      setBalance(r.balance);
      if(r.growth && r.growth.leveledUp) bubble(` Lv.${r.growth.level} 달성!`);
      setTimeout(()=> bubble(` 수업 출석 완료! +${r.reward}셀`), 300);
      loadClassCard();
      if(state.user) state.user.cell_balance = r.balance;
    }catch(e){ alert(e.message); b.disabled = false; b.textContent = `출석 (+100셀)`; }
  });
}

// ---------- ★ V16 개인정보 · 보호자 동의 ----------
// 미성년자 대상 서비스이므로: (1) 수집 항목을 시작 화면에서 항상 볼 수 있게 하고,
// (2) 첫 이용 1회 보호자 동의를 받는다. 이미 동의한 브라우저는 다시 묻지 않는다.
function showPrivacy(){ $('#privacy-modal').classList.remove('hidden'); }
function checkConsent(){
  if(localStorage.getItem(SK.consent)) return true;
  $('#consent-modal').classList.remove('hidden');
  return false;
}
$('#link-privacy').addEventListener('click', e=>{ e.preventDefault(); showPrivacy(); });
$('#link-privacy-2').addEventListener('click', e=>{ e.preventDefault(); showPrivacy(); });
$('#consent-check').addEventListener('change', e=>{
  $('#consent-go').disabled = !e.target.checked;
});
// 동의 완료 → 저장 후 시작 화면으로
$('#consent-go').addEventListener('click', ()=>{
  localStorage.setItem(SK.consent, String(Date.now()));
  $('#consent-modal').classList.add('hidden');
  bubble('보호자 동의가 완료되었어요. 이제 시작해 볼까요?');
});
// 데모 버튼은 발표용이므로 동의 절차를 거치지 않는다(대신 시작 화면에 안내 링크는 항상 보인다)

// ---------- 시작 ----------
$('#btn-start').addEventListener('click', async ()=>{
  if(!checkConsent()) return;   // ★ V16 미동요 시 진입 차단
  const nick = $('#nickname').value.trim();
  if(!nick) return alert('닉네임을 입력해주세요!');
  try{
    const j = await api('/api/user',{nickname:nick});
    state.user = j.user; state.quests = j.quests;
    absorbUserMeta(j);   // ★ v1.74: ob_step · play_limit_delta 스냅샷
    if(j.revive && j.revive.available) setTimeout(()=>showRevive(j.revive), 900);
    localStorage.setItem(SK.uid, j.user.id);
    localStorage.setItem(SK.nick, nick);
    localStorage.setItem(SK.token, j.user.token);
    if(j.streakBonus) setTimeout(()=> bubble(` ${j.streakBonus}일 연속 방문 보상 +${j.streakBonus}셀!`), 800);
    // ★ P0-4 오버플레이: 서버가 오늘의 누적 플레이 시간을 알려준다.
    //   한도를 넘었으면 마이룸으로 보내지 않고 보호자 확인 화면을 띄운다.
    //   (서버가 play_minutes 를 직접 세므로 브라우저에서 조작할 수 없다)
    if(j.play && j.play.overLimit && !state.overplayDismissed){
      showOverplay({ minutes: j.play.minutes });
      return;
    }
    startPlayTimer();
    await enter();
  }catch(e){ alert(e.message); }
});
async function enter(){
  setBalance(state.user.cell_balance);
  // ★ V3: 예전에 이 api 호출이 실패하면(서버 일시 오류 등) enter() 가 그대로 reject 되어
  //   호출부에서 아무 처리를 하지 않으므로 화면이 시작 페이지에 멈췄다(무음 실패).
  //   이제는 실패를 화면에 알리고 다시 시도할 수 있게 한다.
  let j;
  try{ j = await api('/api/robots/me'); }
  catch(e){
    console.error('[enter]', e);
    bubble(e.message || '로봇 정보를 불러오지 못했어요');
    show('start');
    return;
  }
  state.robot = j.robot; state.quests = j.quests; state.parts = j.parts||[];
  state.decors = j.decors||[]; state.skins = j.skins||[]; state.shards = j.shards||[];
  state.itemQty = j.qty || state.itemQty || {};
  state.shardProgress = j.shardProgress || null;
  // ★ P0-2 성장 상태 로드(상단 Lv 표시용). 실패해도 나머지 흐름은 진행한다.
  try{ const g = await api('/api/growth/me'); state.growth = g; }catch(e){}
  if(state.robot){
    show('myroom'); renderMyroom();
    $('.navbtn[data-nav=myroom]').classList.add('on');
    // ★ P0-3 마이룸 진입 = 진짜 "접속 1회". 예전엔 로그인할 때마다 세어
    //   새로고침 횟수가 접속 횟수가 되어 재접속률이 왜곡됐다.
    markVisit();
  }
  else { renderPicker(); show('create'); }
}

// ---------- 부모 승인 게이트 + 오버플레이 방지 (P0-4) ----------
// ★ V2-6: 예전에 서버 엔드포인트만 있고 클라이언트 호출이 0건 이었다(죽은 코드).
//   이제 실제 화면에서 동작시킨다.
//   - 게이트: 곱셈 문제로 부모 확인(토큰은 서버 HMAC 이라 답을 볼 수 없다)
//   - 시간 초과: 하루 40분 초과 시 잠금, 부모 승인 시에만 추가 플레이 허용
let _gate = { a:0, b:0, token:null };
let _playTick = null;

async function openParentGate(){
  const modal = $('#parent-gate');
  const msg = $('#gate-msg');
  msg.textContent = '';
  msg.style.color = '#c92a2a';
  $('#gate-a').value = '';
  // 오버플레이 창이 깔려 있으면 먼저 닫는다(두 창이 겹쳐 보이지 않도록)
  const ov = $('#overplay');
  if(ov && !ov.classList.contains('hidden')) ov.classList.add('hidden');
  modal.classList.remove('hidden');
  // 문제 요청(실패하면 살리�� 않고 모달만 닫는다 — 게임을 못 하게 만들지 않는다)
  try{
    const q = await api('/api/parent/quiz', null, 8000);
    _gate = { a:q.a, b:q.b, token:q.token };
    $('#gate-q').textContent = `${q.a} × ${q.b} = ?`;
  }catch(e){
    // 서버가 잠깐 응답하지 않아도 아이를 막지 않는다(신중한 실패 처리)
    msg.textContent = '문제를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.';
    return;
  }
}
function closeParentGate(){
  $('#parent-gate').classList.add('hidden');
  $('#gate-a').value = '';
}
async function verifyParent(){
  const msg = $('#gate-msg');
  const ans = Number($('#gate-a').value);
  if(!ans){ msg.textContent = '정답을 입력해 주세요.'; return; }
  try{
    await api('/api/parent/verify', { a:_gate.a, b:_gate.b, token:_gate.token, answer:ans });
    msg.textContent = ''; msg.style.color = '#2b8a3e';
    closeParentGate();
    bubble('부모 승인 완료! 오늘도 조금 더 놀자 ');
    // 잠금 해제 → 계속 진행
    if($('#overplay').classList.contains('hidden') === false) $('#overplay').classList.add('hidden');
    state.overLimit = false;
    state.overplayDismissed = false;
    clearPendingLock();      // ★ v1.74 C2: 유예 상태도 함께 초기화
    state.windDown = false;
    startPlayTimer();
  }catch(e){
    msg.textContent = e.message || '정답이 아니에요.';
    // 시간 초과 상태였다면, 보호자가 틀렸을 때 다시 초과 창으로 돌아간다
    // (그래야 '내일 다시 올게요' 선택지가 사라지지 않는다)
    if(state.overLimit) showOverplay({ minutes: (state.playMinutes||0) });
  }
}
// 시간 초과 안내를 띄운다
function showOverplay(info){
  // ★ 2026-10-28: 한 세션에서 한 번만. '내일 다시' 후 재로그인해도 같은 세션에서는 반복하지 않는다.
  if(state.overplayDismissed) return;
  state.overLimit = true; state.playMinutes = info.minutes || 0;
  stopPlayTimer();
  const st = $('#overplay-stat');
  if(st) st.textContent = `오늘 ${info.minutes}분 플레이`;
  const m = $('#overplay-msg');
  if(m) m.innerHTML = '오늘 플레이 시간이 끝났어요.<br>눈이 피곤하니 쉬어가요!';
  fillOverplayRumi();
  // ★ 2026-11-20 (v1.72): 밤(20시~새벽 6시)이면 .night + 자는 루미 — 잠금 로직 자체는 그대로
  applyOverplayNight();
  $('#overplay').classList.remove('hidden');
}
// ★ 2026-11-21 (v1.71) 잠들기 전 루미의 «내일 약속» — 잠금 화면에 루미의 목소리를 한 줄 얹는다.
//   ★ 새 요청을 보내지 않는다. 잠금 시점엔 이미 네트워크가 끊겼을 수 있으므로
//     state 에 기억된 것만 조립한다.
// ★ 2026-11-21 (v1.74) C2: 문장을 «오늘 «X» 배웠어! 내일 «Y» 도전하자!» 로 격상한다.
//     X = 오늘 가장 최근에 켜진 등불(litDay 내림차순 1위 — C3 «최신» 정렬과 같은 규칙)
//     Y = next-action 제목/개념. 둘 다 없으면 예전 체인(계획 다음 단계 → 등불)으로,
//     그래도 없으면 «내일도 같이 놀자» 로 힘내주듯 마무리한다.
//   textContent 로만 넣는다(esc 불필요 — 사용자 문자열이 HTML 로 새는 길이 아예 없다).
function fillOverplayRumi(){
  const el = $('#overplay-rumi'); if(!el) return;
  // X — 오늘 배운 것: 최신 등불 우선
  let learned = '';
  const lamps = (state.lamps && Array.isArray(state.lamps.lamps)) ? state.lamps.lamps.filter(l=>l && l.topic) : [];
  if(lamps.length){
    const latest = lamps.slice().sort((a,b)=>String(b.litDay||'').localeCompare(String(a.litDay||'')))[0];
    if(latest) learned = String(latest.topic);
  }
  if(!learned){
    // 옛 체인: 계획의 다음 단계 → 흐림 없는 등불
    const steps = (state.plan && state.plan.plan && state.plan.plan.steps) || [];
    const nx = steps.find(s => s && !s.done && s.title);
    if(nx) learned = String(nx.title);
    else if(lamps.length){
      const lit = lamps.find(l => !l.crystal && (Number(l.decay)||0) < 30);
      if(lit) learned = String(lit.topic);
    }
  }
  // Y — 내일 도전: next-action(타탑 카드면 «안개 속의 탑» 으로 읽는다)
  const na = state.nextAction;
  let next = '';
  if(na){
    if(na.kind === 'tower') next = '안개 속의 탑';
    else if(na.title) next = String(na.title);
    else if(na.concept) next = String(na.concept);
  }
  if(learned && next) el.textContent = `오늘 «${learned}» 배웠어! 내일 «${next}» 도전하자!`;
  else if(learned) el.textContent = `오늘 «${learned}» 배웠어! 내일도 같이 놀자!`;
  else if(next) el.textContent = `내일은 «${next}» 에 도전해 보고 싶어! 그때 또 만나 줄래?`;
  else el.textContent = '내일도 같이 놀자! 나 기다릴게.';
}
// 실제 플레이 시간을 주기적으로 서버에 보고한다(시간 초과 판단 근거)
function startPlayTimer(){
  stopPlayTimer();
  if(state.overLimit) return;
  // 60초마다 60초 치를 보고 → 서버가 play_minutes 를 누적한다
  _playTick = setInterval(async ()=>{
    if(!state.user) return;
    try{
      const r = await api('/api/visit/playtime', { seconds:60 }, 8000);
      // ★ 2026-10-28: 30분에 한 번 미리 알려준다(차단 전 예고).
      if(r && !r.over && r.playMinutes >= 30 && !state.warned30){
        state.warned30 = true;
        toast('⏰ 30분 넘었어요! 10분 뒤엔 쉬어가요.');
      }
      if(r && r.playMinutes != null) state.playMinutes = r.playMinutes;
      // ★ 2026-11-21 (v1.74) C2 «자연스러운 마무리»: 30분 예고(state.windDown) 후에는
      //   한도(서버 판정 — 40분 + play_limit_delta)에 닿아도 «바로» 잠그지 않고
      //   pendingLock(4분 유예) 을 세운다. 유예 중에도 플레이타임 보고는 «그대로» 계속된다
      //   (위의 보고 코드를 건드리지 않았다 — 시간 조작 방지 로직 불변).
      if(r && !r.over && r.playMinutes >= 30) state.windDown = true;
      if(r && r.over && !state.overLimit && !state.pendingLock) armPendingLock();
    }catch(e){ /* 네트워크 실패는 무시 — 다음 주기에 다시 보낸다 */ }
  }, 60000);
}

// ============================================================
// ★ 2026-11-21 (v1.74) C2 «자연스러운 마무리» — 40분(서버 한도) 도달 직후의 4분 유예.
//   · 40분 도달 → armPendingLock(): 토스트로 미리 알리고 4분 타이머 시작(잠그지 않음)
//   · 자연스러운 마무리 지점(게임/퀴즈 창 닫기 · 대화 창 닫기 · 집중 끝)에서 그때 잠근다
//   · 4분 동안 마무리 지점이 없으면 강제로 잠근다
//   · 잠금 자체는 기존 showOverplay() 를 그대로 쓴다(제외 목록·부모 연장 로직 불변)
// ============================================================
let _pendingLockTimer = null;
function armPendingLock(){
  if(state.pendingLock || state.overLimit || state.overplayDismissed) return;
  state.pendingLock = true;
  bubble('슬슬 마무리하자! 하던 것만 끝내고 쉬어가자.');
  toast('오늘 시간이 거의 다 됐어요. 4분 안에 마무리해요! 🌙', 6000);
  clearTimeout(_pendingLockTimer);
  _pendingLockTimer = setTimeout(()=>forcePendingLock(), 4*60*1000);
}
function clearPendingLock(){
  state.pendingLock = false;
  if(_pendingLockTimer){ clearTimeout(_pendingLockTimer); _pendingLockTimer = null; }
}
function forcePendingLock(){
  clearPendingLock();
  if(state.overLimit || state.overplayDismissed) return;
  showOverplay({ minutes: state.playMinutes || 40 });
}
// 자연스러운 마무리 지점에서 부른다 — pendingLock 중일 때만 실제로 잠근다
function notifyNaturalBreak(){
  if(state.pendingLock && !state.overLimit) forcePendingLock();
}
function stopPlayTimer(){
  if(_playTick){ clearInterval(_playTick); _playTick = null; }
}

// ---------- 방문 기록 + 체류시간 (P0-3 효과 검증 데이터 소스) ----------
// 마이룸 진입 시 "접속 1회" 를 기록하고, 페이지가 닫힐 때 누적 시간을 보낸다.
let _sessionStart = Date.now();
function markVisit(){
  _sessionStart = Date.now();
  api('/api/visit', {}).catch(()=>{});
}
// sendBeacon 은 unload 시에도 요청이 확실히 전송된다(navigator.sendBeacon).
// fetch keepalive 도 보조로 시도한다.
// ★ 수정: 예전에 sendBeacon 과 fetch 를 둘 다 쏘고 pagehide/beforeunload 에도
//   둘 다 걸어 두었다. 한 세션이 최대 4회 기록되어 체류시간이 2~4배로 부풀었다
//   (실측 확인 — 100초가 200초로 누적됨).
//   ① 전송 1회만 하도록 _reported 가드로 막고
//   ② 전송 수단도 sendBeacon 우선, 실패 시에만 fetch 로 물러나게 한다.
let _durationReported = false;
function reportDuration(){
  if(_durationReported) return;                     // ★ 한 세션 1회만 전송
  const sec = Math.round((Date.now() - _sessionStart) / 1000);
  if(sec <3) return;                               // 3초 미만은 실측 오류
  _durationReported = true;
  const payload = Math.min(sec, 7200);
  const tk = localStorage.getItem(SK.token);
  let sent = false;
  try{
    if(navigator.sendBeacon){
      // sendBeacon 은 커스텀 헤더를 못 붙여 토큰을 본문에 함께 실어 보낸다
      sent = navigator.sendBeacon('/api/visit/duration',
        new Blob([JSON.stringify({ seconds:payload, token:tk })], {type:'application/json'}));
    }
  }catch(e){ sent = false; }
  // sendBeacon 이 실패했을 때만 보조로 시도한다(이중 전송 방지)
  if(!sent){
    try{ fetch('/api/visit/duration', { method:'POST', headers:{'Content-Type':'application/json','X-Token':tk},
      body: JSON.stringify({ seconds:payload }), keepalive:true }); }catch(e){}
  }
}
// pagehide 만 사용한다. beforeunload 를 함께 걸면 두 이벤트가 연달아 발화한다.
addEventListener('pagehide', reportDuration);

// ★ 2026-11-21 (v1.74) 계약: /api/user 최상위 += ob_step · teach_count · play_limit_delta.
//   삼막 인도(B)의 1막 판정(ob_step===0) 과 C2 의 잠금 한도(40+delta) 계산에 쓴다.
//   낡은 응답(필드 없음)이면 user 행의 값으로라도 채운다 — 없으면 0 유지.
function absorbUserMeta(j){
  if(!j) return;
  if(j.ob_step != null) state.obStep = Number(j.ob_step) || 0;
  else if(j.user && j.user.ob_step != null) state.obStep = Number(j.user.ob_step) || 0;
  if(j.play_limit_delta != null) state.playLimitDelta = Number(j.play_limit_delta) || 0;
  else if(j.user && j.user.play_limit_delta != null) state.playLimitDelta = Number(j.user.play_limit_delta) || 0;
}

// ---------- P1-5 상태 구조 보강 ----------
// robots/me 응답을 상태에 반영할 때 사용(parts + decors + 성장)
function absorbRobotMe(j){  state.robot = j.robot; state.quests = j.quests || { list:[], done:[] };
  state.parts = j.parts||[]; state.decors = j.decors||[];
  state.skins = j.skins||[]; state.shards = j.shards||[];
  // ★ 보유 수량 + 조각 교환 진행도(V2-1 / V2-10)
  state.itemQty = j.qty || {};
  state.shardProgress = j.shardProgress || null;
}

// ---------- 만들기 ----------
function renderPicker(){
  // ★ P1-6 세계관 연결: 템플릿명에 DOROLAND 세계관 캐릭터 이름을 부여
  const NAMES = { roundy:'코엑스', boxy:'네모이', tally:'리코', doro:'루미' };
  $('#template-picker').innerHTML = ['doro','roundy','boxy','tally'].map(t=>
    `<div class="tpl ${state.template===t?'on':''}" data-tpl="${t}">${robotSVG(t,{})}<br>${NAMES[t]}</div>`).join('');
  $$('#template-picker .tpl').forEach(el=>el.addEventListener('click',()=>{
    state.template = el.dataset.tpl; state.palette = {}; renderPicker(); renderCanvas();
  }));
  renderCanvas(); renderPalette();
}
function renderPalette(){
  $('#palette').innerHTML = PALETTE.map(c=>`<div class="sw ${c===state.color?'on':''}" data-c="${c}" style="background:${c}"></div>`).join('');
  $$('#palette .sw').forEach(el=>el.addEventListener('click',()=>{ state.color=el.dataset.c; renderPalette(); }));
}
function renderCanvas(){
  $('#paint-canvas').innerHTML = robotSVG(state.template, state.palette);
  $$('#paint-canvas [data-part]').forEach(el=>el.addEventListener('click',()=>{
    if(!COLORABLE.includes(el.dataset.part)) return;
    state.palette[el.dataset.part] = state.color;
    renderCanvas();
  }));
}
$('#btn-done').addEventListener('click', async ()=>{
  if($('#btn-done').disabled) return;
  // ★ V15 공작소 수정 모드: 새로 만들지 않고 색칠만 저장한다
  if(state.recolor) return submitRecolor();
  const name = $('#bot-name').value.trim();
  if(!name) return alert('로봇 이름을 지어주세요!');
  if(Object.keys(state.palette).length===0) return alert('색칠을 한 번 해보세요!');
  const btn = $('#btn-done');
  btn.disabled = true; btn.textContent = ' AI가 성격을 만드는 중...';
  try{
    const j = await api('/api/robots',{ name, template:state.template, palette:state.palette}, 45000);
    // ★ P0-2 레벨업 표시(첫 로봇 완성 = 가장 강한 " 성장" 신호)
    const up = j.growth && j.growth.leveledUp;
    $('#modal-body').innerHTML = `
      <h2>${esc(name)} 완성! </h2>
      <div style="margin:12px 0">${robotSVG(state.template, state.palette)}</div>
      <p><b style="color:var(--primary)">성격: ${esc(j.personality)}</b></p>
      <p class="desc">${esc(j.desc)}</p>
      <p class="desc">"${esc(j.greeting)}"</p>
      <div class="reward"> +${esc(j.reward.cell)} 셀 ·  부품 [${esc(j.reward.part)}] 획득!${up?` ·  Lv.${esc(j.growth.level)} 달성!`:''}</div>`;
    $('#modal').classList.remove('hidden');
    state.robot = { name, template:state.template, palette:state.palette, personality:j.personality, greeting:j.greeting };
    maybeAct1();   // ★ 2026-11-21 (v1.74) B1 삼막 1막: 첫 로봇 «완성!» 직후 — 대화로 부드럽게 인도
    // ★ P1-2 잔액은 서버가 준 실제 값을 사용(예전엔 +50 하드코딩이라 어긋났음)
    if(typeof j.balance === 'number'){ state.user.cell_balance = j.balance; setBalance(j.balance); }
    // ★ 성장 정보 병합: /api/robots 응답의 growth 에는 level/exp/stage 만 있으므로
    //   partBonus 등 나머지 필드는 기존 값을 유지해야 한다(덮어쓰면 보너스가 사라짐).
    if(j.growth) state.growth = { ...state.growth, ...j.growth, partBonus: state.growth.partBonus||0 };
    // 부품이 방금 지급되었으니 보너스를 다시 계산한다(0 이면 정상 — 아직 부품이 없을 수도)
    try{ state.growth = await api('/api/growth/me'); }catch(e){}
  }catch(e){ alert(e.message); }
  btn.disabled = false; btn.textContent = '완성! ';
});
$('#modal-ok').addEventListener('click', async ()=>{
  $('#modal').classList.add('hidden');
  try{ const j = await api('/api/robots/me'); absorbRobotMe(j); }catch(e){ /* 조회 실패해도 로컬 상태로 진입 */ }
  if(state.robot){ show('myroom'); renderMyroom(); markVisit(); }
});

// ---------- 마이룸 ----------
// ★ V9 연속 방문 달력 — '예고된 보상'으로 내일 다시 오게 만든다.
//   예전엔 7일 보상표가 서버에만 있어서 아이는 받고 나서야 얼마인지 알 수 있었다.
function renderStreakCal(){
  const el = $('#streak-cal');
  if(!el) return;
  const g = state.growth || {};
  const table = g.streakTable;
  if(!table){ el.innerHTML = ''; return; }
  const cyc = g.streakCycle || 7;
  const done = g.streakDoneSlot || 0;
  const next = g.streakNextSlot || 1;
  const cells = [];
  for(let i=1;i<=cyc;i++){
    const rew = table[i] || 0;
    // 7일을 다 채운 날에는 next(1일차)가 done 과 겹친다 → next 를 우선해
    // "내일부터 새 주기 시작"이 항상 보이도록 한다
    const isNext = (i === next);
    const cls = isNext ? 'next' : (i <= done ? 'done' : '');
    const mark = isNext ? '▲' : (i <= done ? '✓' : '');
    cells.push(`<span class="sc-cell ${cls}"><b>${rew}</b><i>${mark}</i></span>`);
  }
  const head = g.streak
    ? ` <b>${esc(g.streak)}일</b> 연속${g.streakNextReward ? ` · 내일 <b>+${esc(g.streakNextReward)}셀</b>` : ''}`
    : ` 오늘 시작! 내일 <b>+${esc(table[2]||0)}셀</b>`;
  el.innerHTML = `<div class="sc-head">${head}</div><div class="sc-row">${cells.join('')}</div>`;
}

// ★ V9 성장 수치를 다시 읽고, 단계가 바뀌었으면 3D 로봇을 다시 만든다.
//   라벨만 바뀌고 로봇은 그대로이던 것을 '눈앞에서 자라는' 경험으로 연결하는 지점.
async function refreshGrowth(){
  const prev = (state.growth && state.growth.stage) || 1;
  try{ state.growth = await api('/api/growth/me'); }catch(e){ return; }
  const now = state.growth.stage || 1;
  if(now !== prev && bjs.ready && state.robot){
    rebuildRobot(state.robot);
    setTimeout(()=>bubble(` ${({1:'아기',2:'청소년',3:'성체'})[now]} 로 자랐어!`), 700);
  }
  return state.growth;
}

// ★ V12 이번 주 주제 배너 — AI 과제가 수업/세계관과 이어져 있음을 화면으로 보여준다.
function renderTopic(){
  const el = $('#topic-banner');
  if(!el) return;
  const t = (state.growth && state.growth.topic) || null;
  if(!t){ el.innerHTML = ''; return; }
  el.innerHTML = `<span class="tp-ch">CH.${esc(t.chapter)}</span><span class="tp-name">${esc(t.topic)}</span>`;
  el.title = t.keywords ? `이번 주 주제: ${t.topic} (${t.keywords})` : `이번 주 주제: ${t.topic}`;
}

function renderMyroom(){
  if(!state.presenceReady){ state.presenceReady = true; setupPresence(); setupLayoutV167(); setupGuideV172(); }
  loadNudge();                    // ★ 2026-11-04: 루미가 먼저 말 걸기 (없으면 계획 다음 단계로 폴백)
  loadMood(); loadSeason(); loadFocusSummary();
  loadClassCard();          // ★ V15 수업 출석 카드(회사 기대효과 ②)
  refreshMailBadge();       // ★ V15 우편함 미수령 배지
  const r = state.robot; if(!r) return;
  const g = state.growth || {};
  // ★ P0-2 성장 표시(레벨/단계/스트릭) — "어제보다 나아졌다" 를 child's 눈으로 보이게
  const stageKo = { 1:'아기', 2:'청소년', 3:'성체' }[g.stage||1] || '아기';
  // ★ 부품 보너스 표시: 부품을 산 이유를 수치로 보여준다(내일 다시 켜게 만드는 핵심)
  const bonusLine = g.partBonus ? `<span class="pbonus" title="보유 부품이 오늘 과제 보상을 올려줘요"> 과제 +${esc(g.partBonus)}셀</span>` : '';
  const growthBar = g.level ? `
    <div class="growth">
      <span class="lv">Lv.${esc(g.level)}</span>
      <span class="stage">${esc(stageKo)}</span>
      ${g.streak?`<span class="streak"> ${esc(g.streak)}일 연속</span>`:''}
      ${bonusLine}
      <div class="expbar"><i style="width:${Math.min(100, Math.round((g.exp||0)/(g.expNeeded||100)*100))}%"></i></div>
    </div>` : '';
  // ★ P0-1 구입한 장식은 방에서 보이도록(최소한의 보상 안내)
  const decorLine = state.decors.length
    ? `<div class="owned-decor">보유 장식: ${state.decors.map(d=>esc(d)).join(' · ')}</div>` : '';
  $('#robot-info').innerHTML = `<b>${esc(r.name)}</b> · 성격 <b>${esc(r.personality)}</b><br><span style="color:var(--sub);font-size:13px">"${esc(r.greeting)}"</span>${growthBar}${decorLine}`;
  const hudLv = $('#hud-lv'); if(hudLv) hudLv.textContent = `Lv.${g.level||1}`;
  const hudSt = $('#hud-streak'); if(hudSt) hudSt.textContent = `🔥${g.streak||0}`;
  const tl = $('#top-level'); if(tl) tl.textContent = `Lv.${g.level||1}`;
  const ts = $('#top-streak'); if(ts) ts.textContent = `🔥${g.streak||0}`;
  updateChatFab();
  renderQuests(); setBalance(state.user.cell_balance);
  try{ renderStreakCal(); }catch(e){ console.error('[renderStreakCal]', e); }
  try{ renderTopic(); }catch(e){ console.error('[renderTopic]', e); }
  // 오늘의 진행 단계 표시 — 다른 렌더링이 실패해도 이건 반드시 뜨도록 try 로 감싼다
  try{ renderSteps(); }catch(e){ console.error('[renderSteps]', e); }
  try{ mountRoom3D(r); }catch(e){ console.error('[mountRoom3D]', e); }
  loadRoomState();                // ★ 2026-10-27: 이해도 → 방 조명/책장
  loadPlan();                     // ★ 2026-10-28: AI가 짠 오늘의 학습 계획
  loadGoals();                    // ★ 2026-10-28: 이번 주 목표
  try{ loadStoryChip(); }catch(e){ console.error('[loadStoryChip]', e); }  // ★ v1.39 정비사 수첩 배지

  setTimeout(()=>loadRoomState(), 1500);  // 3D 씬이 준비된 뒤 조명 한 번 더 반영
  // ★ v1.49 «같은 말 반복 줄이기»: 방에 들어올 때마다 같은 인사를 다시 하지 않는다(하루 1번).
  //   드래그 안내도 처음 한 번만 — 이제 아는 아이에게 매번 뜨는 문구는 소음이다.
  const _d = new Date();
  const _dayKey = `${_d.getFullYear()}-${_d.getMonth()+1}-${_d.getDate()}`;
  let _saidDay = '';
  try{ _saidDay = localStorage.getItem('roomi_room_greet_day') || ''; }catch(e){}
  try{ renderToday3(); }catch(e){}
  if(_saidDay !== _dayKey){
    // ★ v1.58: 첫 방문 팁(«드래그로 돌려 보세요»)이 먼저 뜨고, 그 뒤에 로봇이 «기억» 으로 말을 건다.
    setTimeout(loadRobotHello, 1300);
    setTimeout(loadRobotRecall, 6200);   // ★ v1.63: 인사가 사라진 뒤 «그때 그거» 를 물어본다
    try{ localStorage.setItem('roomi_room_greet_day', _dayKey); }catch(e){}
  }
  let _tipShown = '';
  try{ _tipShown = localStorage.getItem('roomi_room_tip') || ''; }catch(e){}
  if(!_tipShown){
    // 예약 시점에 «봤음» 으로 표시한다. 4.6초 안에 나갔다 들어와도 타이머가 두 번 걸리지 않게.
    try{ localStorage.setItem('roomi_room_tip', '1'); }catch(e){}
    setTimeout(()=>{
      // ★ v1.58: 로봇의 «기억 인사» 를 가리지 않도록 조작 팁은 토스트로 내린다.
      if(bjs.ready) toast('드래그로 돌려 보고, 휠로 확대해 보세요', 4200);
    }, 4600);
  }
}

// ============================================================
// 3D 마이룸 (Babylon.js) — 아이가 칠한 색을 입체 로봇으로 매핑
// ============================================================
let bjs = { engine:null, scene:null, root:null, bob:null, model:null, ready:false, _t:0, wanderTimer:null };
let boosterFlames = null;   // 로켓 부스터 화염 메시(재빌드 때마다 교체됨)

// robotSVG 와 동일한 색 병합 규칙 (2D 미리보기와 3D 가 일치하도록)
// ★ 색칠 스킨: 구매하면 실제 로봇 색이 바뀐다 (V2-2).
//   예전에는 상점에서 파는 스킨이 renderOwned 에서 이름만 출력되고
//   어떤 렌더 경로에도 참여하지 않았다 = 돈을 내도 보이지 않는 구조였다.
//   스킨 = '정해진 팔레트 한 벌'이라 robot.palette 위에 덮어 쓰는 방식으로 구현한다.
//   사용자가 직접 고른 색(바디)을 skin 이 덮어쓰므로, 살 때마다 다른 인상.
const SKIN_PALETTES = {
  '파란 포커 스킨': { body:'#5c86c7', head:'#9fb7d8', antenna:'#ffb020', arms:'#44618f', legs:'#2f4a6b' },
  '핑크 포커 스킨': { body:'#e88fb0', head:'#f7c9d8', antenna:'#ffd54f', arms:'#c96b8c', legs:'#a85170' },
  '민트 포커 스킨': { body:'#5cc9a7', head:'#a8e6d0', antenna:'#ff9f43', arms:'#3d9e80', legs:'#2a7a63' },
  '노랑 포커 스킨': { body:'#f2c94c', head:'#fae08a', antenna:'#eb5757', arms:'#d1a53a', legs:'#a8842b' },
  '보라 포커 스킨': { body:'#9b7fe0', head:'#cbbaf2', antenna:'#56ccf2', arms:'#7a5fc0', legs:'#5d4795' },
  // ★ v1.64: 한정 판매 스킨 + «무지개 스킨» 팔레트(그전엔 팔레트가 없어 사도 색이 그대로였다).
  '하늘 스킨':   { body:'#6fb7e8', head:'#bfe0f7', antenna:'#ffd54f', arms:'#4f93c4', legs:'#356f99' },
  '복숭아 스킨': { body:'#f3a683', head:'#fbd7c4', antenna:'#ff7b7b', arms:'#d98763', legs:'#b06a4b' },
  '무지개 스킨': { body:'#8e7cf0', head:'#b9d6ff', antenna:'#ffd54f', arms:'#f08fb0', legs:'#5cc9a7' },
};
// 스킨 적용 대상: 사용자가 '팔레트'로 고른 색만 건드린다.
// 고르지 않은 부위(팔/다리/안테나)는 원래 공용 색을 유지한다.
function skinOf(robot){
  if(!robot) return null;
  const list = (state.skins||[]).filter(n=>SKIN_PALETTES[n]);
  if(!list.length) return null;
  return SKIN_PALETTES[list[list.length-1]];   // 최근 구매한 스킨이 우선
}
function effectiveColors(template, palette){
  // ★ V3 수정: PAL_BASE / DEFAULT_PAL 의 두 번째 정의를 제거했다.
  //   파일 상단(L26/L18)이 유일한 진실 공급원이며, 여기에도 동일 내용을
  //   다시 적어 두면 언젠가 한쪽만 고쳐 두 렌더링(2D/3D)이 어긋난다.
  const base = Object.assign({}, DEFAULT_PAL, PAL_BASE[template]||{}, palette||{});
  // 스킨이 있으면 '사용자가 직접 칠한 부위'만 스킨 색으로 덮는다
  const sk = skinOf(state.robot);
  if(sk && palette){
    ['body','head','antenna','arms','legs'].forEach(part=>{
      if(palette[part] && sk[part]) base[part] = sk[part];
    });
  }
  return base;
}

// 상점 부품 → 이름/설명 매핑 (3D 클릭 설명 + 미리보기 설명에 사용)
const PART_INFO = {
  '안테나 리본': { emoji:'', desc:'머리끝에 매달린 분홍 리본. 로봇이 한층 귀여워져요!' },
  '로켓 부스터': { emoji:'', desc:'등 뒤에 달린 추진기! "최고 속도"를 자랑해요.' },
  '나사 장식':   { emoji:'', desc:'몸판에 박힌 은색 나사 4개. 튼튼한 로봇 느낌!' },
  '별 스티커':   { emoji:'', desc:'방을 꾸미는 별 스티커예요 (로봇에 직접 입히진 않아요).' },
  '선물 상자':   { emoji:'', desc:'특별한 선물 상자예요 (장식품).' },
};
const ITEM_EMOJI = {'안테나 리본':'💗','로켓 부스터':'🚀','나사 장식':'🔩','별 스티커':'⭐','선물 상자':'🎁',
  '파란 포커 스킨':'🔵','핑크 포커 스킨':'🌸','민트 포커 스킨':'🍃','노랑 포커 스킨':'🌻','보라 포커 스킨':'🟣',
  '하늘 스킨':'🌤️','복숭아 스킨':'🍑','무지개 스킨':'🌈','부품 조각':'🔧'};

// 미세 입자(점토 질감) 노멀맵 — 씬마다 1장만 만들고 모든 재질이 공유 (순색 플라스틱 느낌 제거)
// 주의: 구/캡슐 메시에 일반 UV 로 붙이면 UV 늘림으로 세로 줄무늬가 생긴다
//       → triplanar(u/v/y 축 3벌)을 씌워 어느 각도에서도 늘림이 없다
function getGrainNormalMap(scene){
  if(scene.__grainTex) return scene.__grainTex;
  const size = 128;
  const dt = new BABYLON.DynamicTexture('grainN', {width:size, height:size}, scene, true);
  const g = dt.getContext();
  const img = g.createImageData(size, size);
  for(let i=0;i<img.data.length;i+=4){
    const v = 128 + Math.floor(Math.random()*18);   // 0.5 부근의 미세 그레인(플랫 노멀맵)
    img.data[i] = img.data[i+1] = img.data[i+2] = v; img.data[i+3] = 255;
  }
  g.putImageData(img,0,0);
  dt.update(false);
  dt.uScale = dt.vScale = 9;                        // 반복
  scene.__grainTex = dt;
  return dt;
}
// 재질 팩토리: PBR(점토 질감 + 클리어코트) 또는 Standard(폴백)
function makeMatFactory(scene, usePBR){
  let n=0;
  return hex=>{
    const col = BABYLON.Color3.FromHexString(hex);
    let m;
    if(usePBR && BABYLON.PBRMaterial){
      m = new BABYLON.PBRMaterial('m'+(++n), scene);
      m.albedoColor = col; m.metallic = 0; m.roughness = 0.66;
      // ★ 2026-11-05: 자기발광을 낮춰 과노출을 줄인다. 대신 범프/클리어코트를 올려
      //   표면 디테일(미세 요철·은은한 니스 반사)로 입체감을 보존한다.
      m.emissiveColor = col.scale(0.11); m.environmentIntensity = 0.30;
      const nm = getGrainNormalMap(scene);
      m.bumpTexture = nm; m.bumpTexture.level = 0.13;             // 미세 표면 요철(형태 인지 강화)
      m.bumpTexture.coordinatesIndex = 1;                        // triplanar → 구면 늘림 방지
      m.invertNormalMapX = m.invertNormalMapY = false;
      m.clearCoat.isEnabled = true; m.clearCoat.intensity = 0.20; m.clearCoat.roughness = 0.3; // 은은한 니스 질감
    } else {
      m = new BABYLON.StandardMaterial('m'+(++n), scene);
      m.diffuseColor = col; m.specularColor = new BABYLON.Color3(0.08,0.08,0.08);
      m.emissiveColor = col.scale(0.13);
      const nm = getGrainNormalMap(scene);
      m.bumpTexture = nm; m.bumpTexture.level = 0.055;
      m.bumpTexture.coordinatesIndex = 1;
    }
    return m;
  };
}
// Babylon 공식 환경 텍스처 로드 (2.5초 제한, 실패 시 Standard 폴백)
function tryLoadEnvironment(scene){
  return new Promise(res=>{
    let done=false;
    const finish = ok=>{ if(done) return; done=true; window.__envOk=ok; res(ok); };
    const t = setTimeout(()=>finish(false), 2500);
    try{
      const env = BABYLON.CubeTexture.CreateFromPrefilteredData(
        'https://assets.babylonjs.com/environments/environmentSpecular.env', scene);
      if(env.onLoadObservable) env.onLoadObservable.addOnce(()=>{ clearTimeout(t); finish(true); });
      if(env.onErrorObservable) env.onErrorObservable.addOnce(()=>{ clearTimeout(t); finish(false); });
      env.onError = ()=>{ clearTimeout(t); finish(false); };
    }catch(e){ clearTimeout(t); finish(false); }
  });
}
// 카툰 잉크 외곽선 — 박스(각진 면)에만 적용 (구면은 UV 봉합선이 드러나므로 제외)
function applyOutlines(meshes){
  meshes.forEach(m=>{
    m.enableEdgesRendering(0.95);
    m.edgesWidth = 3.0;
    m.edgesColor = new BABYLON.Color4(0.15,0.2,0.3,0.55);
  });
}

// 3D 로봇 본체 생성 (매핑 색 + 귀여운 얼굴)
// 현재 성장 단계(1 아기 / 2 청소년 / 3 성체) — 3D 외형에 반영된다
function curStage(){ return (state.growth && state.growth.stage) || 1; }

// 3D 로봇 본체 — v1.30 전면 재설계 (2026-11-05)
// 설계 원칙:
//   ① «공 두 개를 쌓은 눈사람» 실루엣을 버린다. 납작하고 넓은 머리 + 길쭉한 몸,
//      머리를 몸에 깊이 앉혀 가는 목·가로 이음선을 없앤다.
//   ② 얼굴은 «어두운 스크린 1장» + 큰 눈 2개 + 미소 1줄로만 구성한다.
//      금색 홍채·두꺼운 눈테두리·볼·이마 센서·봉제선 등 시각 소음 전부 삭제.
//   ③ 가슴 에너지 코어는 «매입형»(소켓 + 가는 링 + 구)으로만. 떠 있던 반원 장갑/눈금 삭제.
//   ④ 관절 링·어깨 갑개·나사·방열 그릴 등 부착물 제거 → 어깨/손/발은 몸과 같은 색의 둥근 덩어리.
//   ⑤ 모든 좌표는 ROBOT_SHAPE 표 + 타원면 식에서 파생 → 4 템플릿이 같은 코드 경로를 탄다.
//   ⑥ 지름 2(반경 1) 구를 쓰므로 scaling 값이 곧 «반경» 이 되어 곡면 계산식과 1:1 로 일치한다.
function buildRobotModel(scene, parent, c, template, extraParts, matFactory, stage){
  const mat = matFactory || makeMatFactory(scene, false);
  const ROBOT_SHAPE = {
    doro:   { hw:1.30, hh:1.06, hd:0.98, bw:1.04, bh:1.16, bd:0.90, hy:1.78, by:0.80 },
    roundy: { hw:1.42, hh:1.26, hd:1.08, bw:1.18, bh:1.10, bd:1.00, hy:1.80, by:0.74 },
    boxy:   { hw:1.24, hh:1.02, hd:0.94, bw:1.00, bh:1.24, bd:0.88, hy:1.80, by:0.80, box:true },
    tally:  { hw:1.10, hh:0.94, hd:0.88, bw:0.82, bh:1.42, bd:0.78, hy:1.92, by:0.86 }
  };
  const S = ROBOT_SHAPE[template] || ROBOT_SHAPE.doro;
  // 기존(v1.29) 로봇과 화면상 크기를 맞춘다 — 카메라/방 구도를 그대로 유지하기 위함
  const MODEL_SCALE = 1.18;
  const HX=S.hw/2, HY=S.hh/2, HZ=S.hd/2;
  const BX=S.bw/2, BY=S.bh/2, BZ=S.bd/2;
  const hy=S.hy, by=S.by;

  const lift = (hex,k)=> BABYLON.Color3.Lerp(
      BABYLON.Color3.FromHexString(hex), new BABYLON.Color3(1,1,1), k).toHexString();
  const dark = (hex,k)=> BABYLON.Color3.FromHexString(hex).scale(k).toHexString();

  // ── v1.31 얼굴 톤 ──
  //   v1.30 은 4종 템플릿이 모두 #3b5064(차가운 청회색) 화면 한 장을 공유해서
  //   로봇 몸 색과 얼굴이 따로 놀고, «아이 방» 의 크림·복숭아 톤과도 어울리지 않았다.
  //   → 템플릿 계열의 «부드러운 짙은 화면» + 온기 있는 볼터치 + 크림 화이트 눈/미소로 통일.
  const FACE_TONE = {
    doro:   { screen:'#2e4b43', pupil:'#17332c', blush:'#ff9db0', ring:'#7fc9ae' },
    roundy: { screen:'#4d3a34', pupil:'#33231e', blush:'#ffab86', ring:'#f3bd8a' },
    boxy:   { screen:'#33465e', pupil:'#1b2d40', blush:'#ff9fb6', ring:'#8fb8e6' },
    tally:  { screen:'#413550', pupil:'#281f35', blush:'#f2a6d6', ring:'#c9a3e8' }
  };
  const F = FACE_TONE[template] || FACE_TONE.doro;

  const shellMat = mat(lift(c.head, 0.12));        // 머리
  const torsoMat = mat(lift(c.body, 0.10));        // 몸
  const limbMat  = mat(lift(c.arms || c.body, 0.06));
  const accentMat= mat(c.antenna);
  const accentLo = mat(dark(c.antenna, 0.72));
  const bezelMat = mat(lift(c.head, 0.22));        // 화면을 감싸는 옅은 테두리
  const visorMat = mat(F.screen);                  // 템플릿 계열의 부드러운 짙은 화면
  // 화면은 «플라스틱» 이 아니라 «살짝 빛나는 유리» 로 — 자기발광만 소폭 올리고 반사는 죽인다
  visorMat.emissiveColor = BABYLON.Color3.FromHexString(F.screen).scale(0.26);
  if(visorMat.specularColor) visorMat.specularColor = new BABYLON.Color3(0.02,0.02,0.02);
  if(visorMat.roughness != null) visorMat.roughness = 0.82;

  const add=(mesh,material)=>{
    mesh.material=material; mesh.metadata={robot:true};
    mesh.parent=parent; mesh.applyFog=false; return mesh;
  };
  // 지름 2(반경 1) 구 → scaling 이 곧 «반경» 이 되어 곡면 계산식과 일치한다
  const ell=(name,rx,ry,rz,material,segments)=>{
    const m=add(BABYLON.MeshBuilder.CreateSphere(name,{diameter:2,segments:segments||40},scene),material);
    m.scaling.set(rx,ry,rz); return m;
  };
  // boxy 만 «각진 로봇» 으로 유지(얼굴 스크린도 사각) — 나머지는 매끈한 알 형
  const box=(name,rx,ry,rz,material)=> add(
    BABYLON.MeshBuilder.CreateBox(name,{width:rx*2,height:ry*2,depth:rz*2},scene),material);
  const blob=(name,rx,ry,rz,material,seg)=> S.box ? box(name,rx,ry,rz,material) : ell(name,rx,ry,rz,material,seg);
  const outlineMeshes=[];

  // ── ① 몸 · 머리 (가는 목 없이 머리가 몸에 깊이 앉는다) ──
  const body = blob('body', BX, BY, BZ, torsoMat);
  body.position.y = by;
  const head = blob('head', HX, HY, HZ, shellMat);
  head.position.y = hy;
  if(S.box) outlineMeshes.push(body, head);

  // ── ② 얼굴: «매입형 스크린» 1장 + 가는 베젤 ──
  const VX=HX*0.78, VY=HY*0.70, VZ=HZ*0.34;
  const vZ = HZ - VZ + 0.02;                       // 스크린 중심 z
  const visorZ=(dx,dy)=> S.box
    ? vZ + VZ
    : vZ + VZ*Math.sqrt(Math.max(0.02, 1-(dx/VX)**2-(dy/VY)**2));
  const bezel = blob('visorBezel', VX+0.030, VY+0.030, VZ, bezelMat, 48);
  bezel.position.set(0, hy, vZ-0.014);
  const visor = blob('faceScreen', VX, VY, VZ, visorMat, 48);
  visor.position.set(0, hy, vZ);

  // ── v1.31 눈: «흰자 레이어 + 동공 레이어» 2장 분리 ──
  //   동공을 독립 평면으로 빼야 «시선 이동(lookX)» 이 가능해진다.
  //   두 레이어를 updateIdle 에서 같은 eyeS 로 눌러 깜빡임도 그대로 맞춘다.
  //   (자식 메시로 붙이지 않는 이유: rebuildRobot 의 getChildMeshes 일괄 dispose 순서와 충돌 방지)
  const eyeWhiteTex = key=>{
    const N=256, dt=new BABYLON.DynamicTexture('eyeWhite_'+key,{width:N,height:N},scene,false);
    const g=dt.getContext();
    g.clearRect(0,0,N,N);
    const grd=g.createRadialGradient(N*0.5,N*0.42,N*0.05,N*0.5,N*0.5,N*0.48);
    grd.addColorStop(0,'#ffffff'); grd.addColorStop(0.70,'#fffaf0'); grd.addColorStop(1,'#f3e4d6');
    g.fillStyle=grd; g.beginPath(); g.ellipse(N*0.5,N*0.5,N*0.40,N*0.46,0,0,Math.PI*2); g.fill();
    g.strokeStyle='rgba(120,110,105,0.18)'; g.lineWidth=5;
    g.beginPath(); g.ellipse(N*0.5,N*0.5,N*0.40,N*0.46,0,0,Math.PI*2); g.stroke();
    dt.hasAlpha=true; dt.update(true); return dt;
  };
  const pupilTex = key=>{
    const N=256, dt=new BABYLON.DynamicTexture('pupil_'+key,{width:N,height:N},scene,false);
    const g=dt.getContext();
    g.clearRect(0,0,N,N);
    g.fillStyle=F.pupil; g.beginPath(); g.ellipse(N*0.5,N*0.56,N*0.205,N*0.245,0,0,Math.PI*2); g.fill();
    g.strokeStyle=F.ring; g.globalAlpha=0.30; g.lineWidth=7;
    g.beginPath(); g.ellipse(N*0.5,N*0.56,N*0.205,N*0.245,0,0,Math.PI*2); g.stroke();
    g.globalAlpha=1;
    g.fillStyle='#ffffff'; g.beginPath(); g.ellipse(N*0.425,N*0.435,N*0.078,N*0.098,-0.3,0,Math.PI*2); g.fill();
    g.fillStyle='rgba(255,255,255,0.82)'; g.beginPath(); g.ellipse(N*0.585,N*0.665,N*0.034,N*0.044,-0.3,0,Math.PI*2); g.fill();
    dt.hasAlpha=true; dt.update(true); return dt;
  };
  //   주의: disableLighting 만 쓰면 텍스처 색이 diffuseBase=0 에 묻혀 «검은 타원» 이 된다.
  //   → 색은 emissiveTexture 로 원본 그대로 출력하고, diffuseTexture 는 alpha 만 담당한다.
  const layerMat = (name,tex)=>{
    const m=new BABYLON.StandardMaterial(name,scene);
    m.diffuseTexture=tex; m.diffuseTexture.hasAlpha=true;
    m.useAlphaFromDiffuseTexture=true;
    // ★ v1.77: 0.30 회색 diffuse + 0.94 emissive 가 겹쳐 «흰자» 가 회색으로 죽었다.
    //   눈은 화면(visor) 위의 «빛» 이므로 diffuse/emissive 둘 다 1 로 올린다.
    m.diffuseColor=new BABYLON.Color3(1,1,1);
    m.emissiveTexture=tex;
    m.emissiveColor=new BABYLON.Color3(1,1,1);
    m.ambientColor=new BABYLON.Color3(1,1,1);
    m.specularColor=new BABYLON.Color3(0,0,0);
    m.backFaceCulling=false;
    return m;
  };
  const EYE_X=0.235, EYE_Y=0.045, EYE_W=0.215, EYE_H=0.275;
  const eyeBaseY = hy+EYE_Y;
  const eyeL = add(BABYLON.MeshBuilder.CreatePlane('eyeL',{width:EYE_W,height:EYE_H},scene), layerMat('eyeWhite_L',eyeWhiteTex('L')));
  eyeL.position.set(-EYE_X, eyeBaseY, visorZ(-EYE_X,EYE_Y)+0.016);
  const eyeR = add(BABYLON.MeshBuilder.CreatePlane('eyeR',{width:EYE_W,height:EYE_H},scene), layerMat('eyeWhite_R',eyeWhiteTex('R')));
  eyeR.position.set(EYE_X, eyeBaseY, visorZ(EYE_X,EYE_Y)+0.016);
  const pupilL = add(BABYLON.MeshBuilder.CreatePlane('pupilL',{width:EYE_W,height:EYE_H},scene), layerMat('pupilMat_L',pupilTex('L')));
  pupilL.position.set(-EYE_X, eyeBaseY, visorZ(-EYE_X,EYE_Y)+0.022);
  const pupilR = add(BABYLON.MeshBuilder.CreatePlane('pupilR',{width:EYE_W,height:EYE_H},scene), layerMat('pupilMat_R',pupilTex('R')));
  pupilR.position.set(EYE_X, eyeBaseY, visorZ(EYE_X,EYE_Y)+0.022);

  // ── v1.31 볼터치: 화면 아래 양옆에 «아주 옅은 온기»만 ──
  //   점 찍힌 스티커가 아니라 화면 속 빛 번짐처럼 보이도록 방사형 알파 그라디언트.
  const blushTex = key=>{
    const N=128, dt=new BABYLON.DynamicTexture('blush_'+key,{width:N,height:N},scene,false);
    const g=dt.getContext(); g.clearRect(0,0,N,N);
    const h=F.blush, r=parseInt(h.slice(1,3),16), gg=parseInt(h.slice(3,5),16), b=parseInt(h.slice(5,7),16);
    const grd=g.createRadialGradient(N*0.5,N*0.5,0,N*0.5,N*0.5,N*0.5);
    grd.addColorStop(0,`rgba(${r},${gg},${b},0.42)`);
    grd.addColorStop(0.55,`rgba(${r},${gg},${b},0.16)`);
    grd.addColorStop(1,`rgba(${r},${gg},${b},0)`);
    g.fillStyle=grd; g.fillRect(0,0,N,N);
    dt.hasAlpha=true; dt.update(true); return dt;
  };
  const blushMat = key=>{
    const m=new BABYLON.StandardMaterial('blushMat_'+key,scene);
    const tex=blushTex(key);
    m.diffuseTexture=tex; m.diffuseTexture.hasAlpha=true;
    m.useAlphaFromDiffuseTexture=true;
    m.diffuseColor=new BABYLON.Color3(0,0,0);
    m.emissiveTexture=tex;
    m.emissiveColor=new BABYLON.Color3(1,1,1);
    m.disableLighting=true; m.specularColor=new BABYLON.Color3(0,0,0);
    m.backFaceCulling=false;
    return m;
  };
  [-1,1].forEach(side=>{
    const bx=side*VX*0.66, byb=-VY*0.52;
    const bl=add(BABYLON.MeshBuilder.CreatePlane('blush'+side,{width:0.20,height:0.12},scene),blushMat(String(side)));
    bl.position.set(bx, hy+byb, visorZ(bx,byb)+0.020);
  });

  // 미소: 정점 y 를 «입 중심 기준 상대값» 으로 두고 mesh 를 입 중심에 놓는다.
  //   updateIdle 의 scaling.y 가 입을 위로 튕기지 않고 제자리에서 벌어지게 하기 위함.
  const mouthMat = new BABYLON.StandardMaterial('mouthM',scene);
  mouthMat.diffuseColor=new BABYLON.Color3(0.34,0.31,0.28);
  mouthMat.emissiveColor=new BABYLON.Color3(1.00,0.94,0.85);   // v1.31 크림 화이트(찬 파랑 → 온기)
  mouthMat.specularColor=new BABYLON.Color3(0,0,0);
  const MOUTH_Y=-0.180;
  const mPts=[];
  for(let i=0;i<=12;i++){
    const a=i/6-1, dx=a*0.125, dy=MOUTH_Y+0.055*a*a;
    mPts.push(new BABYLON.Vector3(dx, dy-MOUTH_Y, visorZ(dx,dy)+0.016));
  }
  const smile=BABYLON.MeshBuilder.CreateTube('smile',{path:mPts,radius:0.013,tessellation:12,cap:BABYLON.Mesh.CAP_ALL},scene);
  smile.material=mouthMat; smile.metadata={robot:true}; smile.parent=parent; smile.applyFog=false;
  smile.position.y = hy + MOUTH_Y;

  // ── ③ 귀 포드 · 안테나 (딱 이 정도만) ──
  const earX = HX + 0.004;
  [-1,1].forEach(side=>{
    const pod=add(BABYLON.MeshBuilder.CreateCylinder('earPod'+side,{height:0.10,diameter:0.25,tessellation:28},scene),accentMat);
    pod.rotation.z=Math.PI/2; pod.position.set(side*earX, hy-0.01, 0);
    const dot=add(BABYLON.MeshBuilder.CreateCylinder('earDot'+side,{height:0.105,diameter:0.125,tessellation:20},scene),bezelMat);
    dot.rotation.z=Math.PI/2; dot.position.set(side*(earX+0.006), hy-0.01, 0);
  });
  const rodBase=add(BABYLON.MeshBuilder.CreateCylinder('antBase',{height:0.055,diameter:0.17,tessellation:20},scene),accentLo);
  rodBase.position.y=hy+HY+0.015;
  const antRod=add(BABYLON.MeshBuilder.CreateCylinder('ant',{height:0.30,diameterTop:0.038,diameterBottom:0.072,tessellation:20},scene),accentMat);
  antRod.position.y=hy+HY+0.15;
  const ballMat=mat(c.antenna);
  ballMat.emissiveColor=BABYLON.Color3.FromHexString(c.antenna).scale(0.55);
  const antBall=add(BABYLON.MeshBuilder.CreateSphere('antb',{diameter:0.16,segments:24},scene),ballMat);
  antBall.position.y=hy+HY+0.34;
  const antHalo=add(BABYLON.MeshBuilder.CreateTorus('antHalo',{diameter:0.235,thickness:0.014,tessellation:26},scene),accentMat);
  antHalo.position.set(0,antBall.position.y,0); antHalo.rotation.x=0.16;

  // ── ④ 가슴 에너지 코어 (매입형 3부품) ──
  const bodySurfZ=(x,dy)=> S.box ? BZ
    : BZ*Math.sqrt(Math.max(0.02,1-(x/BX)**2-(dy/BY)**2));
  const coreY=by+0.06;
  const cZ=bodySurfZ(0,coreY-by);
  const socket=ell('coreSocket',0.19,0.19,0.028,accentLo,28);
  socket.position.set(0,coreY,cZ+0.004);
  const coreRing=add(BABYLON.MeshBuilder.CreateTorus('coreRing',{diameter:0.30,thickness:0.018,tessellation:32},scene),accentMat);
  coreRing.rotation.x=Math.PI/2; coreRing.position.set(0,coreY,cZ+0.020);
  const coreMat=mat(c.antenna);
  coreMat.emissiveColor=BABYLON.Color3.FromHexString(c.antenna).scale(0.70);
  const core=add(BABYLON.MeshBuilder.CreateSphere('core',{diameter:0.155,segments:24},scene),coreMat);
  core.position.set(0,coreY,cZ+0.034);
  const hatch=ell('backHatch',0.20,0.22,0.022,bezelMat,24);
  hatch.position.set(0,by+0.02,-(BZ+0.006));

  // ── ⑤ 팔 · 손 · 다리 · 발 (v1.32 «어깨 피벗» 재설계) ──
  //   v1.31 버그: 캡슐을 «자기 중심» 으로 회전시켜 어깨에서 떨어져 허공에서 돌았고,
  //   손은 독립 정적 메시라 팔만 올라가고 손은 양옆에 그대로 남았다. 각도 부호도 반대였다.
  //   → 어깨 (side*armX, armTop) 를 피벗으로 두고, 팔 각도 a 하나에서
  //     방향 d=(side*sin a, -cos a) → 캡슐 중심·회전·손 위치를 «동시에» 유도한다.
  //     a=0 이면 수직 하강, a 가 커지면 몸 «바깥 위» 로 올라간다(몸을 가로지르지 않음).
  //   부모-자식 메시를 쓰지 않는 이유: rebuildRobot 의 getChildMeshes 일괄 dispose 순서와 충돌 방지.
  const armX=BX+0.005, armTop=by+0.26, armLen=0.60, armRest=0.13;
  const armPose=(o,a)=>{
    const s=o.side, dx=s*Math.sin(a), dy=-Math.cos(a);
    o.cap.rotation.z = s*a;                                  // 캡슐 +Y 끝이 어깨(-d)를 향한다
    o.cap.position.set(s*armX + dx*armLen*0.5, armTop + dy*armLen*0.5, 0);
    o.hand.position.set(s*armX + dx*(armLen+0.045), armTop + dy*(armLen+0.045), 0.012);
  };
  const mkArm=(capName,handName,side)=>{
    const cap=add(BABYLON.MeshBuilder.CreateCapsule(capName,{radius:0.125,height:armLen,tessellation:28,capSubdivisions:10},scene),limbMat);
    const hand=ell(handName,0.145,0.145,0.145,limbMat,24);
    const o={cap,hand,side}; armPose(o,armRest); return o;
  };
  const armL=mkArm('armL','handL',-1), armR=mkArm('armR','handR',1);
  [-1,1].forEach(side=>{
    const sh=ell('shoulder'+side,0.165,0.155,0.155,torsoMat,24);
    sh.position.set(side*(BX-0.03),armTop-0.02,0);         // 관절은 «고정» — 팔 각도와 무관하게 어깨를 덮는다
  });
  [-1,1].forEach(side=>{
    const leg=ell('leg'+side,0.145,0.20,0.145,limbMat,24);
    leg.position.set(side*0.25,0.28,0);
    const foot=ell('foot'+side,0.18,0.095,0.245,limbMat,24);
    foot.position.set(side*0.25,0.095,0.085);
  });

  // ── ⑥ 성장 단계 · 상점 부품 · 애니메이션 refs ──
  const G = { 1:{s:0.86,eye:1.18,ant:0.62}, 2:{s:1.00,eye:1.00,ant:1.00}, 3:{s:1.10,eye:0.92,ant:1.38} }[stage]
         || { s:1, eye:1, ant:1 };
  const GS = G.s * MODEL_SCALE;
  parent.scaling.x=parent.scaling.y=parent.scaling.z=GS;
  antRod.scaling.y=G.ant;
  antBall.position.y=hy+HY+0.15+0.15*G.ant+0.04;
  antHalo.position.y=antBall.position.y;
  eyeL.scaling.x=eyeR.scaling.x=G.eye;

  attachParts(scene,parent,(extraParts||state.parts),
    { topY:antBall.position.y+0.10, bodyY:by, frontZ:BZ, backZ:BZ,
      bodyRx:BX, bodyRy:BY, bodyCy:by, bodySurfZ }, matFactory);
  if(outlineMeshes.length) applyOutlines(outlineMeshes);

  return { model:parent, eyeL, eyeR, pupilL, pupilR,
           eyeBaseX:EYE_X, eyeBaseY, antBall, mouth:smile,
           armL, armR, armRest, armPose, armTop, armX, armLen,
           core, coreBase:BABYLON.Color3.FromHexString(c.antenna).scale(0.70),
           antHalo, visor, growthScale:GS,
           antBase:BABYLON.Color3.FromHexString(c.antenna).scale(0.55) };
}

// 디버그 훅: 네 템플릿을 한 장면에서 비교 렌더할 때만 사용 (동작 영향 없음)
window.__buildRobotModel = buildRobotModel;
window.__makeMatFactory = typeof makeMatFactory === "function" ? makeMatFactory : null;

// 대기 모션 + 자율 동작 (v1.31)
//   «기본값 계산 → 동작 오버레이 → 대입» 순서로 매 프레임 처음부터 다시 쓰므로
//   동작이 끝나면 자동으로 원래 자세로 돌아오고 값이 누적 드리프트하지 않는다.
//   동작 상태는 refs 마다 독립(_act) → 마이룸 / 미리보기 장면이 서로 간섭하지 않는다.
const ROBOT_ACTS = ['wave','nod','tilt','look','bounce','stretch'];
const ACT_DUR = { wave:2.0, nod:1.5, tilt:1.8, look:2.4, bounce:1.3, stretch:2.2 };
function updateIdle(refs, t, talk){
  if(!refs) return;
  const A = refs._act || (refs._act = { cur:'none', t0:0, dur:0, next:1.8, first:true });
  const busy = !!refs._busy;     // 산책/점프 중에는 새 동작을 시작하지 않는다(렌더 루프가 세팅)

  // ── ① 동작 스케줄: 처음 1.8초에 «손 인사», 이후 3~5.5초 간격으로 랜덤 ──
  if(A.cur==='none' && !busy && talk<0.08 && t>=A.next){
    A.cur   = A.first ? 'wave' : ROBOT_ACTS[Math.floor(Math.random()*ROBOT_ACTS.length)];
    A.first = false;
    A.dur   = ACT_DUR[A.cur] || 1.8;
    A.t0    = t;
    A.next  = t + A.dur + 3.0 + Math.random()*2.5;
  }
  let u=0;
  if(A.cur!=='none'){
    u = (t-A.t0)/A.dur;
    if(u>=1){ A.cur='none'; u=0; }
    else if(busy){ A.cur='none'; u=0; A.next=t+1.2; }   // 산책이 끼어들면 즉시 중단
  }
  const S = k=>Math.sin(Math.PI*Math.min(1,Math.max(0,k)));     // 0→1→0 포락선
  const W = k=>Math.sin(Math.PI*2*Math.min(1,Math.max(0,k)));   // 왕복 1회
  // v1.32: armL/armR 은 «회전 오프셋» 이 아니라 «어깨 피벗 기준 최종 팔 각도(라디안)».
  //   양수 = 몸 바깥 위로 들어 올림. 음수를 쓰면 팔이 몸을 가로질러 반대편으로 꺾인다(v1.31 버그).
  const A0 = refs.armRest || 0.13;
  let rotX=0, rotZ=0, rotY=0, posY=0, armL=A0, armR=A0, stretchY=0, lookX=0, lookY=0;
  if(A.cur!=='none') switch(A.cur){
    case 'wave':    // 오른팔을 머리 옆으로 들어 좌우로 흔들기
      { const e=S(u); armR=A0 + 2.35*e + Math.sin(u*Math.PI*8)*0.22*e;
        armL=A0 + 0.10*e; rotZ=0.045*e; lookX=0.012*e; } break;
    case 'nod':     // 끄덕끄덕 — 팔은 기본 자세 유지
      rotX=0.085*Math.sin(u*Math.PI*3); break;
    case 'tilt':    // 고개 갸웃 + 팔 살짝 비대칭
      { const w=W(u)*(1-0.3*u); rotZ=0.13*w; armL=A0+0.09*w; armR=A0-0.06*w; } break;
    case 'look':    // 두리번 + 시선 이동
      lookX=0.038*W(u); lookY=0.012*Math.sin(u*Math.PI); rotY=0.10*W(u); break;
    case 'bounce':  // 제자리 통통 — 양팔이 같이 벌어진다
      posY=Math.abs(Math.sin(u*Math.PI*3))*0.13*(1-u*0.4); armL=armR=A0+0.52*S(u); break;
    case 'stretch': // 기지개 — 양팔 V 자로 높이
      { const e=S(u); armL=armR=A0 + 2.55*e; stretchY=0.055*e; rotX=-0.05*e; } break;
  }

  // ★ v1.58: «같이 앉아 공부하는» 자세 — 앞으로 살짝, 팔은 무릎 위로 모은다.
  // ★ v1.62: 시선 추종 — lookX 에만 부드럽게 더한다(y 는 절대 금지).
  _gazeCur += (_gazeX * 0.030 - _gazeCur) * 0.12;
  lookX = Math.max(-0.055, Math.min(0.055, lookX + _gazeCur));

  if(state.robotMode === 'focus'){
    // ★ v1.60: 0.09rad 는 정면에서 보이지 않는다. 10도 이상 기울이고,
    //   두 손을 앞으로 들어 «책을 받쳐 든» 모양으로 만든다.
    rotX += 0.18;
    armL = 0.82; armR = 0.82;
    // ★ v1.60 버그 수정: lookY 를 건드리면 pupil 이 사라진다(원인 불명, 아래 2차 점검).
    //   «아래를 보는» 느낌은 rotX 만으로도 충분하다.
  }

  // ── ② 기본 자세 + 동작 오버레이(매 프레임 재대입 → 드리프트 없음) ──
  if(refs.model){
    refs.model.scaling.y = (refs.growthScale||1) * (1 + Math.sin(t*1.6)*0.013 + stretchY);
    refs.model.rotation.x=rotX; refs.model.rotation.y=rotY; refs.model.rotation.z=rotZ;
    refs.model.position.y=posY;
  }
  const cycle=4.2, p=(t%cycle)/cycle;
  let blink = p<0.045 ? Math.abs(Math.sin(p/0.045*Math.PI)) : 0;
  // 3번에 1번은 «두 번 깜빡» → 기계적인 규칙감을 깬다
  if(p>=0.075 && p<0.115 && Math.floor(t/cycle)%3===0)
    blink = Math.max(blink, Math.abs(Math.sin((p-0.075)/0.04*Math.PI)));
  const eyeS = 1 - 0.88*blink;
  if(refs.eyeL) refs.eyeL.scaling.y=eyeS;
  if(refs.eyeR) refs.eyeR.scaling.y=eyeS;
  if(refs.pupilL){
    refs.pupilL.scaling.y=eyeS;
    refs.pupilL.position.x=-(refs.eyeBaseX||0.235)+lookX;
    refs.pupilL.position.y=(refs.eyeBaseY||0)+lookY;
  }
  if(refs.pupilR){
    refs.pupilR.scaling.y=eyeS;
    refs.pupilR.position.x=(refs.eyeBaseX||0.235)+lookX;
    refs.pupilR.position.y=(refs.eyeBaseY||0)+lookY;
  }
  if(refs.antBall && refs.antBall.material){                             // 안테나 에너지 펄스
    // ★ v1.60: «같이 공부» 중에는 안테나가 주황색으로 바뀐다 — 모드가 눈에 보이는 신호.
    if(state.robotMode === 'focus'){
      refs.antBall.material.emissiveColor = new BABYLON.Color3(1,0.55,0.12).scale(0.55 + 0.3*Math.sin(t*4));
    } else {
      refs.antBall.material.emissiveColor = refs.antBase.scale(0.42 + 0.26*Math.sin(t*3));
    }
  }
  if(refs.core && refs.core.material && refs.coreBase){
    refs.core.material.emissiveColor = refs.coreBase.scale(0.55 + 0.30*Math.sin(t*2.6));
  }
  if(refs.antHalo) refs.antHalo.rotation.z = Math.sin(t*0.65)*0.14;
  // v1.32: 팔 각도 하나로 «캡슐 + 손» 을 같은 프레임에 함께 배치 → 손이 절대 떨어지지 않는다.
  const sway = Math.sin(t*1.1)*0.035;
  if(refs.armPose){
    if(refs.armL) refs.armPose(refs.armL, armL + sway);
    if(refs.armR) refs.armPose(refs.armR, armR - sway);
  }
  if(refs.mouth){ refs.mouth.scaling.y = 1 + talk*0.95; refs.mouth.scaling.x = 1 + talk*0.22; }
  // 추진기 화염 맥동 — 절대 시간 t 기준이라 프레임레이트가 변해도 속도/위상이 동일하다.
  // flames 가 Owned scene 과 다르면(미리보기 등) 건너뛴다 → 다른 장면 메시를 건드려 생기는 흔들림 방지.
  const fl = boosterFlames;
  if(fl && fl.length && fl[0] && !fl[0].isDisposed()){
    // 두 화염에 위상 차를 주어 동시에 켜지지 않게 한다(동기화 깜빡임 방지)
    fl.forEach((f,i)=>{
      if(!f || f.isDisposed()) return;
      const pulse = 0.72 + 0.28*Math.sin(t*7.5 + i*1.9);
      f.scaling.y = pulse;                                // 화염 길이 맥동
      f.scaling.x = f.scaling.z = 0.9 + 0.1*pulse;        // 폭도 미세하게 연동
    });
  }
}

// 상점 부품 → 3D 액세서리 매핑 (안테나 리본 / 로켓 부스터 / 나사 장식)
function attachParts(scene, parent, parts, refs, matFactory){
  boosterFlames = null;   //_parts 없으면 애니메이션 참조가 남지 않도록 먼저 초기화
  if(!parts || !parts.length) return;
  const mkMat = matFactory || (hex=>{ const m=new BABYLON.StandardMaterial('pm'+Math.random().toString(36).slice(2),scene);
    m.diffuseColor=BABYLON.Color3.FromHexString(hex); m.specularColor=new BABYLON.Color3(0.1,0.1,0.1);
    m.emissiveColor=BABYLON.Color3.FromHexString(hex).scale(0.15); return m; });
  // partName 을 metadata 에 태그 → 3D 에서 클릭하면 부품 설명 표시
  const add=(mesh,material,partName)=>{ mesh.material=material; mesh.metadata={robot:true, part:partName||undefined}; mesh.parent=parent; mesh.applyFog=false; return mesh; };
  const has = n => parts.includes(n);
  const fzP = refs.frontZ!=null ? refs.frontZ : 0.525;   // 몸 앞면 z (템플릿별)
  const bzP = refs.backZ!=null ? refs.backZ : 0.525;    // 몸 뒷면 z

  // 안테나 리본: 실크 리본 (접힌 날개 4장 + 가운데 매듭 + 짧은 꼬리 2가닥)
  if(has('안테나 리본')){
    const bowMat = mkMat('#ff5fa2'), knotMat = mkMat('#e64b8d');
    // 좌우 날개: ��접힌 겹겹 2장씩
    [-1,1].forEach(side=>{
      const outer = add(BABYLON.MeshBuilder.CreateSphere('bow'+side,{diameter:0.19,segments:14},scene), bowMat,'안테나 리본');
      outer.position.set(side*0.115, refs.topY, 0);
      outer.scaling.set(1.45,0.8,0.55); outer.rotation.z = side*0.52;
      const inner = add(BABYLON.MeshBuilder.CreateSphere('bowIn'+side,{diameter:0.13,segments:12},scene), knotMat,'안테나 리본');
      inner.position.set(side*0.072, refs.topY-0.022, 0.022);
      inner.scaling.set(1.3,0.62,0.45); inner.rotation.z = side*0.72;
    });
    add(BABYLON.MeshBuilder.CreateSphere('bowKnot',{diameter:0.085,segments:12},scene), knotMat,'안테나 리본')
      .position.set(0, refs.topY-0.012, 0.01);
    // 아래로 늘어진 꼬리 2가닥
    [-1,1].forEach(side=>{
      const tail = add(BABYLON.MeshBuilder.CreateCylinder('bowTail'+side,{height:0.13,diameterTop:0.05,diameterBottom:0.085,tessellation:10},scene), bowMat,'안테나 리본');
      tail.position.set(side*0.045, refs.topY-0.085, 0.01);
      tail.rotation.z = side*0.42;
    });
  }
  // 로켓 부스터: 등 뒤 추진기 2개 (몸 실루엣 안쪽 · 표면 z 정확 계산)
  // 로켓 부스터: 등 뒤 추진기 2개 (몸 실루엣 안쪽 · 표면 z 정확 계산)
  // 이전 버그: bx = bodyRx + 0.14 로 두어 팔(x≈0.6)과 거의 같은 선 → 항상 충돌.
  //           또한 |x| 가 bodyRx 에 가까우면 구면 z 가 0 으로 수렴해 옆면에 붙어버림.
  // 수정: 추진기는 배면(x 가 몸 반폭 이내)에 두고, 해당 x 의 실제 표면 z 에 밀착.
  if(has('로켓 부스터')){
    const rMat = mkMat('#e05a3a'), darkMat = mkMat('#8a3a22'), tipMat = mkMat('#ffd54f');
    const bRx = refs.bodyRx || 0.5, bRy = refs.bodyRy || 0.55, bCy = refs.bodyCy != null ? refs.bodyCy : 1.0;
    const bSurf = refs.bodySurfZ || ((x,dy)=> Math.sqrt(Math.max(0.02, bRx*bRx*(1-(dy/bRy)**2) - x*x )));
    // 팔 반경(0.12) 을 피해 몸 안쪽으로 — 팔 축보다 확실히 안쪽
    const bx = Math.max(0.12, bRx*0.5);
    const dy = bRy*0.12;                                  // 몸 중심보다 약간 위
    const surfZ = bSurf(bx, dy);                          // 이 x 에서 몸 표면 z
    const bz = -(surfZ + 0.03);                           // 표면 바로 뒤에 밀착
    const yc = bCy + dy;                                   // 추진기 축 높이
    const flames = [];
    [-bx,bx].forEach((x,side)=>{
      // 본체(위쪽 둥근 통)
      const th = add(BABYLON.MeshBuilder.CreateCylinder('boost'+side,{height:0.34,diameter:0.19,tessellation:20},scene), rMat,'로켓 부스터');
      th.position.set(x, yc+0.12, bz);
      // 강화환(본체 아래)
      const ring = add(BABYLON.MeshBuilder.CreateTorus('boostRing'+side,{diameter:0.22,thickness:0.04,tessellation:18},scene), darkMat,'로켓 부스터');
      ring.position.set(x, yc-0.04, bz); ring.rotation.x = Math.PI/2;
      // 노즐(아래쪽 넓어지는 깔때기)
      const tip = add(BABYLON.MeshBuilder.CreateCylinder('boostTip'+side,{height:0.14,diameterTop:0.19,diameterBottom:0.09,tessellation:20},scene), darkMat,'로켓 부스터');
      tip.position.set(x, yc-0.13, bz);
      // 화염(노즐 아래 발광)
      const flame = add(BABYLON.MeshBuilder.CreateCylinder('boostFlame'+side,{height:0.1,diameterTop:0.02,diameterBottom:0.1,tessellation:16},scene), tipMat,'로켓 부스터');
      flame.position.set(x, yc-0.24, bz);
      flames.push(flame);
      // 몸쪽 연결 브래킷(표면과 추진기 사이를 가로로 잇는 어깨)
      const armLen = Math.max(0.08, bx*0.9);
      const arm = add(BABYLON.MeshBuilder.CreateBox('boostArm'+side,{width:armLen,height:0.08,depth:0.1},scene), darkMat,'로켓 부스터');
      arm.position.set(x - Math.sign(x)*armLen*0.5, yc+0.12, bz);
    });
    // 화염은 매 프레임 갱신(updateBoosterFlame)
    boosterFlames = flames;
  }
  // 나사 장식: 몸 패널 나사 4개 (몸 표면 위, 몸 크기 비례, 십자 홈 표현)
  if(has('나사 장식')){
    const sMat = mkMat('#b9c4d2'), slotMat = mkMat('#7d8898');
    const bRx = refs.bodyRx || 0.5, bRy = refs.bodyRy || 0.55, bCy = refs.bodyCy != null ? refs.bodyCy : 1.0;
    const bSurf = refs.bodySurfZ || ((x,dy)=> Math.sqrt(Math.max(0.02, bRx*bRx*(1-(dy/bRy)**2) - x*x )));
    [[-0.55,0.3],[0.55,0.3],[-0.55,-0.28],[0.55,-0.28]].forEach(([fx,fy],i)=>{
      const x = fx*bRx, dy = fy*bRy;
      const z = bSurf(x,dy)+0.012;
      // 머리(살짝 돌출) + 십자 홈 2줄
      // 주의: Babylon 옵션 키는 diameterTop/diameterBottom 이다 (topDiameter 는 무시되어 기본값 1.0 이 됨)
      const head = add(BABYLON.MeshBuilder.CreateCylinder('screw'+i,{height:0.04,diameterTop:0.056,diameterBottom:0.072,tessellation:16},scene), sMat,'나사 장식');
      head.position.set(x, bCy+dy, z); head.rotation.x = Math.PI/2;
      const slotA = add(BABYLON.MeshBuilder.CreateBox('screwSlotA'+i,{width:0.05,height:0.011,depth:0.014},scene), slotMat,'나사 장식');
      slotA.position.set(x, bCy+dy, z+0.03);
      const slotB = add(BABYLON.MeshBuilder.CreateBox('screwSlotB'+i,{width:0.011,height:0.05,depth:0.014},scene), slotMat,'나사 장식');
      slotB.position.set(x, bCy+dy, z+0.03);
    });
  }
  // 별 스티커: 발광 5각 별(테두리 5개 조합) + 작은 위성 별 2개 (공중 부유)
  if(has('별 스티커')){
    const starMat = mkMat('#ffd54f'); starMat.emissiveColor = BABYLON.Color3.FromHexString('#ffd54f').scale(0.5);
    // 다면체(3D) 는 정면이 어둡고 옆면만 보여 단독 전시에 부적합 →
    // 테두리 실린더 5개로 5각 별 모양을 구성(earcut 없이 오려낸 효과)
    const makeStar = (name, cx, cy, cz, R, thick, fill)=>{
      // 꼭짓점 5개(중심에서 R, 각도 -90°부터 72° 간격)
      const P = [];
      for(let i=0;i<5;i++){ const a = -Math.PI/2 + i*Math.PI*2/5; P.push(new BABYLON.Vector3(cx+Math.cos(a)*R, cy+Math.sin(a)*R, cz)); }
      const lay = (a,b,dn,dv)=>{
        const len = BABYLON.Vector3.Distance(a,b);
        const bar = add(BABYLON.MeshBuilder.CreateCylinder(name+'_'+dn,{height:len, diameter:dv, tessellation:8},scene), starMat,'별 스티커');
        bar.position = BABYLON.Vector3.Center(a,b);
        const dir = b.subtract(a).normalize();
        const axis = BABYLON.Vector3.Cross(BABYLON.Axis.Y, dir);
        const ang = Math.acos(Math.max(-1, Math.min(1, BABYLON.Vector3.Dot(BABYLON.Axis.Y, dir))));
        bar.rotationQuaternion = axis.length()<0.001 ? BABYLON.Quaternion.Identity()
          : BABYLON.Quaternion.RotationAxis(axis.normalize(), ang);
      };
      for(let i=0;i<5;i++) lay(P[i], P[(i+1)%5], 'b'+i, thick);
      if(fill){                                   // 내부가 비어 보이면 방사형+중앙 원판으로 채운다
        const C=new BABYLON.Vector3(cx,cy,cz);
        for(let i=0;i<5;i++) lay(C, P[i], 's'+i, thick*2.1);
        const core=add(BABYLON.MeshBuilder.CreateSphere(name+'_core',{diameter:R*0.85,segments:12},scene), starMat,'별 스티커');
        core.position.set(cx,cy,cz); core.scaling.z=0.42;
      }
    };
    makeStar('star', 1.02, 1.95, 0.1, 0.2, 0.05, true);
    // 반사광(십자 광선)
    [[0,0.46],[1,0.28]].forEach(([ri,len])=>{
      const ray = add(BABYLON.MeshBuilder.CreateBox('starRay'+ri,{width:0.016,height:len,depth:0.012},scene), starMat,'별 스티커');
      ray.position.set(1.02, 1.95, 0.06); ray.rotation.z = ri? Math.PI/4 : 0;
      const ray2 = add(BABYLON.MeshBuilder.CreateBox('starRay2_'+ri,{width:len,height:0.016,depth:0.012},scene), starMat,'별 스티커');
      ray2.position.set(1.02, 1.95, 0.06); ray2.rotation.z = ri? Math.PI/4 : 0;
    });
    // 작은 위성 별
    makeStar('starS0', 0.78, 2.32, 0.24, 0.075, 0.028);
    makeStar('starS1', 1.3, 1.6, 0.16, 0.05, 0.022);
  }
  // 선물 상자: 종이 상자 + 크로스 리본 + 리본 매듭 + 뚜껑 경계선
  if(has('선물 상자')){
    const boxMat = mkMat('#e05a5a'), ribMat = mkMat('#ffd54f'), edgeMat = mkMat('#b84646');
    const gx=0.92, gy=0.17, gz=0.55;
    const gift = add(BABYLON.MeshBuilder.CreateBox('gift',{width:0.44,height:0.34,depth:0.44},scene), boxMat,'선물 상자');
    gift.position.set(gx,gy,gz);
    // 뚜껑 분할선
    const lid = add(BABYLON.MeshBuilder.CreateBox('giftLid',{width:0.46,height:0.05,depth:0.46},scene), edgeMat,'선물 상자');
    lid.position.set(gx, gy+0.19, gz);
    // 크로스 리본 2줄
    const rib1 = add(BABYLON.MeshBuilder.CreateBox('rib1',{width:0.11,height:0.4,depth:0.46},scene), ribMat,'선물 상자');
    rib1.position.set(gx, gy, gz);
    const rib2 = add(BABYLON.MeshBuilder.CreateBox('rib2',{width:0.46,height:0.4,depth:0.11},scene), ribMat,'선물 상자');
    rib2.position.set(gx, gy, gz);
    // 매듭 + 2갈래 노리
    const knot = add(BABYLON.MeshBuilder.CreateSphere('giftKnot',{diameter:0.13,segments:12},scene), ribMat,'선물 상자');
    knot.position.set(gx, gy+0.24, gz); knot.scaling.y = 0.8;
    [[-1,0.5],[1,-0.5]].forEach(([s,r],i)=>{
      const loop = add(BABYLON.MeshBuilder.CreateTorus('giftLoop'+i,{diameter:0.17,thickness:0.05,tessellation:14},scene), ribMat,'선물 상자');
      loop.position.set(gx + s*0.1, gy+0.26, gz);
      loop.rotation.set(Math.PI/2, 0, r);
    });
  }
}

// 점프 애니메이션
// 점프 애니메이션
// ★ 수정: 예전에 root.position.y 를 애니메이션했다. 그런데 root.position.y 는
//   updateWalk 가 매 프레임 직접 대입하는 값이라 서로 덮어써서
  //   몸통과 입이 서로 다른 높이에 있는 깨짐이 생겼다.
//   root 는 '걸어다니는 위치' 전용으로 두고, 점프는 그 아래 bob 에 건다.
//   root 의 y 를 건드리지 않으므로 이동과 점프가 완전히 독립된다.
function jumpRobot(){
  if(!bjs.ready || !bjs.root || !bjs.bob) return;
  const bob = bjs.bob, fps=30, f=24;
  const y0 = bob.position.y || 0;
  const a=new BABYLON.Animation('jump','position.y',fps,BABYLON.Animation.ANIMATIONTYPE_FLOAT,BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
  a.setKeys([{frame:0,value:y0},{frame:7,value:y0+0.5},{frame:14,value:y0},{frame:24,value:y0}]);
  // stopAnimation 을 먼저 호출해 앞선 점프 애니메이션이 겹치지 않게 한다
  // V3 수정: 예전에 `bob.animation && bob.animation.stop()` 였는데
  //   TransformNode 에는 .animation 속성이 없어서(Animator 가 아니라) 항상 undefined →
  //   연속 점프 시 애니메이션이 쌓이는 것을 막지 못했다.
  //   정석 API 인 scene.stopAnimation(노드) 을 쓴다.
  try{ bjs.scene.stopAnimation(bob); }catch(e){}
  bjs._jumping = true;            // 렌더 루프가 숨 흔들림을 멈추도록 플래그
  bjs.scene.beginDirectAnimation(bob,[a],0,f,false,()=>{ bjs._jumping = false; });
}

// ★ v1.58 «같이 공부하는 자세» — 학습 중에는 로봇이 살짝 앞으로 기울고 팔을 모은다.
//   'cheer' 는 한 번만: 점프하고 잠시 뒤 idle 로 돌아온다(완료·정답 순간).
function setRobotMode(mode){
  const next = (mode === 'focus' || mode === 'cheer') ? mode : 'idle';
  state.robotMode = next;
  if(next === 'cheer'){
    jumpRobot();
    setTimeout(()=>{ if(state.robotMode === 'cheer') state.robotMode = 'idle'; }, 1600);
  }
}
// ★ v1.62 «시선 추종» — 마우스를 따라 눈동자가 움직인다.
//   반드시 x 만! lookY 를 건드리면 pupil 이 사라진다(v1.60.1 에서 확인).
let _gazeX = 0, _gazeCur = 0;

// ★ v1.61: «지금 이 동작을 해라» — 인사·기지개 등 로봇의 의도를 즉시 보이게 한다.
function robotGesture(name){
  if(!bjs || !bjs.ready || !bjs.refs) return;
  const A = bjs.refs._act || (bjs.refs._act = { cur:'none', t0:0, dur:0, next:1.8, first:true });
  A.cur = name; A.t0 = bjs._t; A.dur = ACT_DUR[name] || 1.8;
  A.next = bjs._t + A.dur + 8;   // 직후에 다른 랜덤 동작이 끼어들지 않게
}

// 로봇 클릭 → 말하기 + 점프 (입 벌림 애니메이션 포함)
  function talkToRobot(robot){
  bjs.talkUntil = Date.now() + 1100;
  walkTo([0, -0.2], 0.55);      // 대화하러 카메라 앞으로 이동
  // ★ v1.63: «그때 네가 가르쳐 준 거» 를 물어본 직후라면, 클릭으로 바로 이어서 설명하게 한다.
  if(state.recallConcept){
    const c = state.recallConcept; state.recallConcept = null;
    bubble(`«${c}» 이야기, 같이 해 볼까?`);
    jumpRobot();
    setTimeout(()=>{
      chatOpen(); chatModeSet('learn');
      const i = $('#chat-text'); if(i){ i.value = `${c}에 대해 설명해 볼게`; i.focus(); }
    }, 900);
    return;
  }
  bubble(robot.greeting); jumpRobot();
  }

  // ── 3Dsimple 이동 (격자 탐색 + 부드러운 회전) ──
  // 방 안을 몇 걸음 걸어다니는 로봇 = '살아 있는' 느낌의 핵심.
  // 단순히 좌표를 lerp 하지 않고, '목표 지점 → 회전 → 보행' 3단으로 처리한다.
  // 방 크기는 createRoomBase 의 HW=5.6, HD=5.0 과 맞춘다(소품과 겹치지 않게 약간 안쪽).
  // ★ V17 산책 범위 축소: 예전엔 ±3.6 까지 걸어가 카메라 프레임 밖으로 나갔다.
  //   이제 러그 주변(±1.3)만 돌아다녀 "방 한가운데 사는 로봇" 느낌을 유지한다.
  const WALK = { X:1.3, ZB:-0.7, ZF:0.9, SPEED:1.15, TURN:6.5 };
  let _walk = { active:false, tx:0, tz:0, face:0, timer:0, walking:false };
  // 목표 지점으로 걷기(faceR: 도착 후 바라볼 각도, null 이면 현재 방향 유지)
  function walkTo(p, faceR){
    if(!bjs.ready || !bjs.root) return;
    _walk.tx = Math.max(-WALK.X, Math.min(WALK.X, p[0]));
    _walk.tz = Math.max(WALK.ZB, Math.min(WALK.ZF, p[1]));
    _walk.face = (faceR==null) ? _walk.face : faceR;
    _walk.active = true; _walk.walking = true;
    clearTimeout(_walk.timer);
    // 12초 안에 못 가면 그만 둔다(전봇줄처럼 영원히 걷는 것 방지)
    _walk.timer = setTimeout(()=>{ _walk.active=false; _walk.walking=false; }, 12000);
  }
  // 대기 중 랜덤 산책(아이가 지켜볼 만한 장면)
  bjs.walkTo = walkTo;          // ★ v1.60: 밖에서 «아이 곁으로 걸어오기» 를 부를 수 있게
  function idleWander(){
    if(!bjs.ready) return;
    if(state.robotMode === 'focus') return;   // 같이 공부하는 중에는 자리를 비우지 않는다
    const x = (Math.random()*2-1) * WALK.X;
    const z = WALK.ZB + Math.random()*(WALK.ZF - WALK.ZB);
    // ★ V17 도착 시 70% 확률로 카메라(+z)를 바라본다 → 화면에 얼굴이 보이는 시간이 길어진다.
    walkTo([x, z], Math.random() <0.7 ? 0 : Math.PI*0.5*(Math.random()<0.5?-1:1));
  }
  // 매 프레임 호출: 이동/회전 보간
  function updateWalk(dt){
    if(!bjs.ready || !bjs.root) return;
    const r = bjs.root;
    // ★ v1.60 «같이 공부하는 자리» — focus 동안에는 스스로 아이 곁(정면 앞쪽)으로 돌아온다.
    //   밖에서 walkTo 를 호출하면 bjs 재생성 시점에 참조가 깨지므로, 루프 안에서 판단한다.
    if(state.robotMode === 'focus' && !_walk.active && r.position.z < 0.7){
      _walk.tx = 0; _walk.tz = 0.85; _walk.face = 0;
      _walk.active = true; _walk.walking = true;
      clearTimeout(_walk.timer);
    }
    // 1) 도착까지 이동
    if(_walk.active){
      const dx = _walk.tx - r.position.x, dz = _walk.tz - r.position.z;
      const dist = Math.hypot(dx, dz);
      if(dist <0.08){
        _walk.active = false; _walk.walking = false;
        // 도착 후엔 바라보는 각도만 살짝 맞는다
        if(_walk.face) r.rotation.y = _walk.face;
      }else{
        const step = Math.min(dist, WALK.SPEED * dt);
        r.position.x += dx/dist*step;
        r.position.z += dz/dist*step;
        // 이동 방향을 향해 자연스럽게 회전
        const want = Math.atan2(dx, dz);
        r.rotation.y = angleLerp(r.rotation.y, want, 1 - Math.exp(-WALK.TURN*dt));
      }
    }
    // 2) 걸을 때 살짝 통통 튀기 + 몸 흔들림
    if(_walk.walking){
      r.position.y = Math.abs(Math.sin(bjs._t*9)) * 0.055;
      bjs.bob.rotation.z = Math.sin(bjs._t*9) * 0.03;
    }else{
      r.position.y = 0;
      bjs.bob.rotation.z *= 0.9;
    }
  }
  // 각도 보간(최단 경로로 회전)
  function angleLerp(cur, want, k){
    let d = want - cur;
    while(d>  Math.PI) d -= Math.PI*2;
    while(d <-Math.PI) d += Math.PI*2;
    return cur + d*k;
  }

function rebuildRobot(robot){
  if(!bjs.model || !bjs.scene) return;
  boosterFlames = null;   // 아래에서 dispose 되므로 참조를 먼저 끊는다(잔여 참조 방지)
  bjs.model.getChildMeshes(false).forEach(m=>{
    if(m.material){
      // ★ 얼굴 레이어 재질(눈 흰자/동공/볼터치)은 buildRobotModel 이 매번 새
      //   DynamicTexture 를 6장 만든다. material.dispose() 는 기본으로 텍스처를
      //   끌어내리지 않아 재구색(스킨 교체) 때마다 GPU 메모리가 새었다.
      //   재질 이름으로 골라서만 forceDisposeTextures — 몸통 재질이 공유하는
      //   노멀맵(scene.__grainTex, getGrainNormalMap 캐시)을 지우지 않도록 주의.
      const mn = m.material.name || '';
      if(mn.indexOf('eyeWhite')===0 || mn.indexOf('pupilMat')===0 || mn.indexOf('blushMat')===0){
        m.material.dispose(false, true);
      }else{
        m.material.dispose();
      }
    }
    m.dispose();
  });
  bjs.refs = buildRobotModel(bjs.scene, bjs.model, effectiveColors(robot.template, robot.palette), robot.template, null, bjs.matFactory, curStage());
  if(bjs.scene.__shadow){
    const list = bjs.model.getChildMeshes(false);
    bjs.scene.meshes.forEach(m=>{ if(m.castShadow) list.push(m); });
    bjs.scene.__shadow.getShadowMap().renderList = list;
  }
}

// ★ 장식 구매 후 방을 다시 만든다.
//   방 소품(장식)은 createRoomBase 안에서 만들어지므로, 이미 만들어진 씬에서는
//   로봇만 갱신(rebuildRobot)해서는 반영되지 않는다. 여기서는 장식 mesh 를
//   지운 뒤 buildOwnedDecors 로 다시 만든다(엔진/씬/바닥 재사용 → 저비용).
let _roomGen = 0;
function rebuildRoomDecor(){
  const scene = bjs.scene;
  if(!scene) return;
  _roomGen++;
  // 1) 이전 장식 제거(이름은 buildOwnedDecors 가 붙이는 접두사로 식별)
  scene.meshes.slice().forEach(m=>{
    if(/^dsBar|^dsRay|^dsTape|^giftBox|^giftLid|^giftRib|^giftKnot|^giftLoop/.test(m.name)) m.dispose();
  });
  // 2) 같은 재질(M) 재사용으로 다시 배치. M 은 createRoomBase 가 씬에 캐시해 둔다.
  if(!scene.__propM){ console.warn('[rebuildRoomDecor] 재질 캐시 없음 — 장식 재배치 생략'); return; }
  try{
    const placed = buildOwnedDecors(scene, scene.__propM, state.decors||[]);
    scene.__placedDecors = placed;
  }catch(e){ console.error('[rebuildRoomDecor]', e); }
}

// ---------- 방 텍스처(장면 단위 캐시: 같은 장면에서 한 번만 생성) ----------
// 마루 바닥: 엇갈린 판재 + 나뭇결 + 옹이 + 판 상단 하이라이트 (2026-11-04 정밀화)
//   ★ 대비를 충분히 줘야 원근이 심한 바닥에서도 판재 이음선이 실제로 보인다.
function texWood(scene){
  if(scene.__woodTex) return scene.__woodTex;
  const S=1024, dt=new BABYLON.DynamicTexture('woodT',{width:S,height:S},scene,true);
  const g=dt.getContext();
  // ★ 2026-11-04 아동 톤: 짙은 고동색 마루 → «꿀빛 크림 우드». 판재 대비는 남기되 전체 명도를 올린다.
  g.fillStyle='#e7cda8'; g.fillRect(0,0,S,S);      // 판 사이 줄눈 바탕
  const rows=9, ph=S/rows, cols=3, pw=S/cols;
  for(let i=0;i<rows;i++){
    const y=i*ph, shift=(i%2)?pw*0.5:0;
    for(let j=-1;j<=cols;j++){
      const bx=j*pw+shift;
      const t=232+Math.floor(Math.random()*18);
      g.fillStyle='rgb('+Math.min(255,t+18)+','+Math.min(255,t+4)+','+Math.max(0,t-30)+')';
      g.fillRect(bx+2,y+2,pw-4,ph-4);
      // 나뭇결 곡선 — 진한 갈색 대신 연한 꿀빛으로
      g.strokeStyle='rgba(183,141,98,0.20)'; g.lineWidth=1.7;
      for(let k=0;k<6;k++){
        const yy=y+10+k*(ph-22)/6;
        g.beginPath(); g.moveTo(bx+3,yy);
        for(let xx=3;xx<=pw-3;xx+=18) g.lineTo(bx+xx, yy+Math.sin(xx/48+i*1.7+k*1.3+j)*2.4);
        g.stroke();
      }
      // 판 상단 하이라이트 / 하단·우측 그림자 → 입체감
      const hg=g.createLinearGradient(0,y+2,0,y+13);
      hg.addColorStop(0,'rgba(255,253,240,0.62)'); hg.addColorStop(1,'rgba(255,253,240,0)');
      g.fillStyle=hg; g.fillRect(bx+2,y+2,pw-4,11);
      g.fillStyle='rgba(176,132,90,0.28)'; g.fillRect(bx+2,y+ph-6,pw-4,5);
      g.fillStyle='rgba(176,132,90,0.24)'; g.fillRect(bx+pw-5,y+2,5,ph-4);
      if(Math.random()<0.30){
        const ox=bx+34+Math.random()*(pw-80), oy=y+16+Math.random()*(ph-38);
        g.strokeStyle='rgba(168,124,84,0.30)'; g.lineWidth=2;
        g.beginPath(); g.ellipse(ox,oy,11,5,0.25,0,Math.PI*2); g.stroke();
        g.beginPath(); g.ellipse(ox,oy,5,2.4,0.25,0,Math.PI*2); g.stroke();
      }
    }
  }
  dt.update(false);
  // ★ 2026-11-04: DynamicTexture 기본 wrap 은 CLAMP(0) 이라 uScale>1 을 주면
  //   나머지 영역이 텍스처 끝 픽셀로 눌려 단색/어두운 띠가 생겼다. 반드시 WRAP 으로.
  dt.wrapU = dt.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
  dt.uScale=dt.vScale=2.2;
  scene.__woodTex=dt; return dt;
}
// 둥근 모서리 러그: 테두리 + 안쪽 + 마름모 문양(alpha 포함 → 네 모서리 투명)
function texRug(scene){
  if(scene.__rugTex) return scene.__rugTex;
  const S=512, dt=new BABYLON.DynamicTexture('rugT',{width:S,height:S},scene,true);
  const g=dt.getContext();
  const rr=(x,y,w,h,r)=>{ g.beginPath(); g.moveTo(x+r,y);
    g.arcTo(x+w,y,x+w,y+h,r); g.arcTo(x+w,y+h,x,y+h,r); g.arcTo(x,y+h,x,y,r); g.arcTo(x,y,x+w,y,r); g.closePath(); };
  g.clearRect(0,0,S,S);
  // ★ 2026-11-04 아동 톤: 피치 → 크림 → 민트 마카롱 배색
  rr(8,8,S-16,S-16,60); g.fillStyle='#ffd9c4'; g.fill();
  rr(30,30,S-60,S-60,48); g.fillStyle='#fff1de'; g.fill();
  rr(58,58,S-116,S-116,40); g.fillStyle='#c3ebda'; g.fill();
  g.fillStyle='rgba(255,247,214,0.92)';                              // 중앙 마름모(버터 옐로)
  g.beginPath(); g.moveTo(S/2,96); g.lineTo(S-96,S/2); g.lineTo(S/2,S-96); g.lineTo(96,S/2); g.closePath(); g.fill();
  g.strokeStyle='rgba(255,255,255,0.62)'; g.lineWidth=5;
  for(let i=0;i<3;i++){ rr(80+i*14,80+i*14,S-160-i*28,S-160-i*28,34); g.stroke(); }
  g.fillStyle='rgba(255,255,255,0.60)';
  [[132,132],[S-132,132],[132,S-132],[S-132,S-132]].forEach(function(p){
    g.beginPath(); g.arc(p[0],p[1],9,0,Math.PI*2); g.fill();
  });
  dt.update(false); dt.hasAlpha=true;
  scene.__rugTex=dt; return dt;
}
// 창밖 풍경: 하늘 그라디언트 + 구름 + 먼 산
function texSky(scene){
  if(scene.__skyTex) return scene.__skyTex;
  const W=512,H=384, dt=new BABYLON.DynamicTexture('skyT',{width:W,height:H},scene,true);
  const g=dt.getContext();
  const gr=g.createLinearGradient(0,0,0,H);
  // ★ 2026-11-04 아동 톤: 차가운 회청색 하늘 → «솜사탕» 파스텔 하늘(하단 살구빛 노을)
  gr.addColorStop(0,'#bfe4ff'); gr.addColorStop(0.5,'#e6f2ff'); gr.addColorStop(1,'#ffeede');
  g.fillStyle=gr; g.fillRect(0,0,W,H);
  // 옅은 무지개(동화 느낌, 창이 작아도 튀지 않게 연하게)
  ['rgba(255,168,168,0.26)','rgba(255,211,150,0.26)','rgba(255,244,158,0.26)',
   'rgba(166,228,178,0.26)','rgba(158,204,255,0.26)','rgba(203,175,245,0.26)'].forEach(function(c,i){
    g.strokeStyle=c; g.lineWidth=7; g.beginPath();
    g.arc(W*0.62,H*0.99, 138+i*9, Math.PI*1.10, Math.PI*1.90); g.stroke();
  });
  g.fillStyle='rgba(255,255,255,0.94)';
  [[110,86,44],[196,64,34],[338,104,40],[428,74,28]].forEach(function(c){
    g.beginPath(); g.arc(c[0],c[1],c[2],0,Math.PI*2);
    g.arc(c[0]+c[2]*0.85,c[1]+7,c[2]*0.68,0,Math.PI*2);
    g.arc(c[0]-c[2]*0.85,c[1]+9,c[2]*0.62,0,Math.PI*2); g.fill();
  });
  g.fillStyle='#d3efc6'; g.beginPath(); g.moveTo(0,H);
  g.quadraticCurveTo(W*0.26,H-74,W*0.52,H-42); g.quadraticCurveTo(W*0.76,H-84,W,H-52); g.lineTo(W,H); g.closePath(); g.fill();
  g.fillStyle='#b7e3a9'; g.beginPath(); g.moveTo(0,H);
  g.quadraticCurveTo(W*0.42,H-52,W*0.76,H-30); g.quadraticCurveTo(W*0.9,H-24,W,H-28); g.lineTo(W,H); g.closePath(); g.fill();
  dt.update(false);
  scene.__skyTex=dt; return dt;
}
// 접촉 그림자 blob: 소품이 바닥에 밀착된 무게감 표현
function texBlob(scene){
  if(scene.__blobTex) return scene.__blobTex;
  const S=128, dt=new BABYLON.DynamicTexture('blobT',{width:S,height:S},scene,true);
  const g=dt.getContext();
  g.clearRect(0,0,S,S);
  const gr=g.createRadialGradient(S/2,S/2,2,S/2,S/2,S/2);
  // ★ 2026-11-04 아동 톤: 청회색 얼룩 → 따뜻하고 연한 코코아 그림자(바닥이 더러워 보이지 않게)
  gr.addColorStop(0,'rgba(150,110,96,0.42)'); gr.addColorStop(0.62,'rgba(160,120,104,0.16)'); gr.addColorStop(1,'rgba(168,126,108,0)');
  g.fillStyle=gr; g.beginPath(); g.arc(S/2,S/2,S/2,0,Math.PI*2); g.fill();
  dt.update(false); dt.hasAlpha=true;
  scene.__blobTex=dt; return dt;
}
// 벽지: 옅은 플라스터 결 + 은은한 세로 스트라이프 (2026-11-04 정밀화)
//   단색 벽의 '플라스틱판' 느낌을 없애고 빛을 부드럽게 받게 한다.
function texWall(scene){
  if(scene.__wallTex) return scene.__wallTex;
  const S=512, dt=new BABYLON.DynamicTexture('wallT',{width:S,height:S},scene,true);
  const g=dt.getContext();
  const gr=g.createLinearGradient(0,0,0,S);
  // ★ 2026-11-04 아동 톤: 회백 벽 → «크림+복숭아» 온벽. 차가운 기를 빼고 포근하게.
  gr.addColorStop(0,'#fffaf2'); gr.addColorStop(0.52,'#fff0e0'); gr.addColorStop(1,'#ffe0d0');
  g.fillStyle=gr; g.fillRect(0,0,S,S);
  g.fillStyle='rgba(255,183,155,0.028)';
  for(let x=0;x<S;x+=64) g.fillRect(x,0,2,S);
  for(let i=0;i<2400;i++){
    const a=Math.random()*0.026;
    g.fillStyle=Math.random()<0.5?('rgba(198,158,130,'+a+')'):('rgba(255,255,255,'+(a*1.5)+')');
    g.fillRect(Math.random()*S,Math.random()*S,2,2);
  }
  dt.update(false); scene.__wallTex=dt; return dt;
}
// 창가 바닥에 떨어지는 따뜻한 빛 얼룩 (2026-11-04 정밀화)
function texSunPatch(scene){
  if(scene.__sunTex) return scene.__sunTex;
  const S=256, dt=new BABYLON.DynamicTexture('sunT',{width:S,height:S},scene,true);
  const g=dt.getContext(); g.clearRect(0,0,S,S);
  const gr=g.createRadialGradient(S/2,S/2,8,S/2,S/2,S/2);
  gr.addColorStop(0,'rgba(255,238,202,0.62)');
  gr.addColorStop(0.55,'rgba(255,234,190,0.26)');
  gr.addColorStop(1,'rgba(255,232,188,0)');
  g.fillStyle=gr; g.beginPath(); g.arc(S/2,S/2,S/2,0,Math.PI*2); g.fill();
  dt.update(false); dt.hasAlpha=true; scene.__sunTex=dt; return dt;
}

// 소품 전용 무조명 재질(가벼움, PBR 미사용)
function propMat(scene, name, hex, glow){
  const m=new BABYLON.StandardMaterial(name, scene);
  const c=BABYLON.Color3.FromHexString(hex);
  m.diffuseColor=c; m.specularColor=new BABYLON.Color3(0.05,0.05,0.05);
  m.emissiveColor=c.scale(glow||0.12);
  m.backFaceCulling=false;
  return m;
}
// 부드러운 접촉 그림자(그림자 맵 대신 가벼운 blob 으로 접지감 표현)
function addBlobShadow(scene, x, z, r, alpha){
  const m=new BABYLON.StandardMaterial('bsm'+r+'_'+x, scene);
  m.diffuseTexture=texBlob(scene); m.diffuseTexture.hasAlpha=true;
  m.useAlphaFromDiffuseTexture=true; m.diffuseColor=new BABYLON.Color3(0,0,0);
  m.emissiveColor=new BABYLON.Color3(0,0,0); m.specularColor=new BABYLON.Color3(0,0,0);
  m.disableLighting=true; m.alpha=(alpha==null?0.55:alpha); m.backFaceCulling=false;
  const d=BABYLON.MeshBuilder.CreateDisc('blob',{radius:r,tessellation:28},scene);
  d.rotation.x=Math.PI/2; d.position.set(x,0.008,z);
  d.material=m; d.isPickable=false; d.receiveShadows=false;
  return d;
}
// 창빛 속 부유 먼지 — 방에 공기감 부여
function addDustMotes(scene){
  const S=16, dt=new BABYLON.DynamicTexture('dustT',{width:S,height:S},scene,true);
  const g=dt.getContext(); g.clearRect(0,0,S,S);
  const gr=g.createRadialGradient(8,8,0,8,8,8);
  gr.addColorStop(0,'rgba(255,255,255,0.95)'); gr.addColorStop(1,'rgba(255,255,255,0)');
  g.fillStyle=gr; g.fillRect(0,0,S,S); dt.update(false); dt.hasAlpha=true;
  const ps=new BABYLON.ParticleSystem('dust',70,scene);
  ps.particleTexture=dt;
  ps.emitter=new BABYLON.Vector3(-2.6,2.0,-3.2);
  ps.minEmitBox=new BABYLON.Vector3(-0.5,-1.5,-0.6);
  ps.maxEmitBox=new BABYLON.Vector3(0.5,1.5,0.6);
  ps.color1=new BABYLON.Color4(1,1,0.97,0.5);
  ps.color2=new BABYLON.Color4(0.92,0.97,1,0.34);
  ps.colorDead=new BABYLON.Color4(1,1,1,0);
  ps.minSize=0.018; ps.maxSize=0.05;
  ps.minLifeTime=4; ps.maxLifeTime=8; ps.emitRate=10;
  ps.blendMode=BABYLON.ParticleSystem.BLENDMODE_ADD;
  ps.direction1=new BABYLON.Vector3(-0.06,-0.03,0.06);
  ps.direction2=new BABYLON.Vector3(0.06,0.05,0.1);
  ps.minEmitPower=0.02; ps.maxEmitPower=0.09;
  ps.gravity=new BABYLON.Vector3(0,-0.012,0);
  ps.start();
}
// ── 벽 하단 입체 웨인스코팅 (2026-11-04 정밀화) ─────────────────────
//   띠몰딩 + 세로 기둥 + 크림 테두리/민트·복숭아 음각 패널로 벽에 깊이와 리듬을 준다.
//   드로우콜을 줄이려 재질별로 병합하고, 병합 실패 시 개별 메시를 남긴다.
function addWainscot(scene, opt, HD, HW){
  if(opt.bare) return;
  const mk=function(n,r,g,b,e){
    const m=new BABYLON.StandardMaterial(n,scene);
    m.diffuseColor=new BABYLON.Color3(r,g,b);
    m.specularColor=new BABYLON.Color3(0.035,0.035,0.035);
    m.emissiveColor=new BABYLON.Color3(e,e,e*1.1);
    m.backFaceCulling=false; m.twoSidedLighting=true; return m;
  };
  // ★ 2026-11-04 아동 톤: 크림 몰딩 + 민트/복숭아 패널을 한 칸씩 번갈아 «사탕 줄무늬» 벽으로
  const rail=mk('wainRail',1,0.985,0.955,0.065);
  const fA=mk('wainFaceA',0.66,0.89,0.78,0.065);   // 민트(좀 더 또렷하게)
  const fB=mk('wainFaceB',1.0,0.78,0.72,0.065);    // 복숭아
  const rails=[], facesA=[], facesB=[];
  const put=function(tag,w,h,d,x,y,z,ry,mat){
    const b=BABYLON.MeshBuilder.CreateBox(tag,{width:w,height:h,depth:d},scene);
    b.position.set(x,y,z); if(ry) b.rotation.y=ry;
    b.isPickable=false; b.receiveShadows=true;
    (mat===rail?rails:(mat===fB?facesB:facesA)).push(b); return b;
  };
  // 뒷벽(z=-HD): 7칸
  const zb=o=>-HD+o, L=HW*2, n=7, pw=L/n;
  put('wrTop',L,0.09,0.075, 0,1.005,zb(0.055),0,rail);
  put('wrBot',L,0.07,0.062, 0,0.115, zb(0.050),0,rail);
  for(let i=0;i<=n;i++)
    put('wrSt'+i,0.055,0.86,0.052, -HW+i*pw,0.55,zb(0.050),0,rail);
  for(let i=0;i<n;i++){
    const cx=-HW+pw*(i+0.5);
    put('wrFr'+i, pw-0.14,0.70,0.024, cx,0.55,zb(0.034),0,rail);
    put('wrPa'+i, pw-0.26,0.58,0.032, cx,0.55,zb(0.048),0, i%2?fB:fA);
  }
  // 양 옆벽: 카메라에 보이는 구간(z=-4.6~4.4)만 시공
  [-1,1].forEach(function(sgn,si){
    const off=o=>sgn*(HW-o), z0=-4.6, z1=4.4, L2=z1-z0, n2=5, q=L2/n2;
    const ry=Math.PI/2, cz=(z0+z1)/2;
    put('wsTop'+si,L2,0.09,0.075, off(0.055),1.005,cz,ry,rail);
    put('wsBot'+si,L2,0.07,0.062, off(0.050),0.115, cz,ry,rail);
    for(let i=0;i<=n2;i++)
      put('wsSt'+si+'_'+i,0.055,0.86,0.052, off(0.050),0.55,z0+i*q,ry,rail);
    for(let i=0;i<n2;i++){
      const pz=z0+q*(i+0.5);
      put('wsFr'+si+'_'+i, q-0.14,0.70,0.024, off(0.034),0.55,pz,ry,rail);
      put('wsPa'+si+'_'+i, q-0.26,0.58,0.032, off(0.048),0.55,pz,ry, (i+si)%2?fB:fA);
    }
  });
  const merge=function(list,name,mat){
    if(list.length<2) return;
    let m=null;
    try{ m=BABYLON.Mesh.MergeMeshes(list,false,true,undefined,false,false); }catch(e){}
    if(m){ list.forEach(x=>x.dispose()); m.name=name; m.material=mat; m.isPickable=false; m.receiveShadows=true; }
  };
  merge(rails,'wainscotRail',rail);
  merge(facesA,'wainscotPanelMint',fA);
  merge(facesB,'wainscotPanelPeach',fB);
}
// ── 생활감 소품 (2026-11-04 정밀화) ─────────────────────
//   책 더미 · 곰 인형 · 슬리퍼 · 벽 선반 · 탁상 머그/연필 · 창바닥 빛얼룩.
//   바닥/벽 기준 좌표만 써서 가구 키트 유무와 무관하게 안전하게 놓인다.
function addRoomDetails(scene, M, opt){
  if(opt.bare) return;
  const mk=(n,hex,glow)=>propMat(scene,n,hex,glow==null?0.10:glow);
  const bx=function(nm,w,h,d,x,y,z,m,ry){
    const b=BABYLON.MeshBuilder.CreateBox(nm,{width:w,height:h,depth:d},scene);
    b.position.set(x,y,z); if(ry) b.rotation.y=ry;
    b.material=m; b.isPickable=false; b.receiveShadows=true; return b;
  };
  const cy=function(nm,o,x,y,z,m){
    const c=BABYLON.MeshBuilder.CreateCylinder(nm,o,scene);
    c.position.set(x,y,z); c.material=m; c.isPickable=false; c.receiveShadows=true; return c;
  };
  const sp=function(nm,d,x,y,z,m,sx,sy,sz){
    const s=BABYLON.MeshBuilder.CreateSphere(nm,{diameter:d,segments:14},scene);
    s.position.set(x,y,z); if(sx) s.scaling.set(sx,sy,sz);
    s.material=m; s.isPickable=false; s.receiveShadows=true; return s;
  };
  const bk=(M&&M.book&&M.book.length)?M.book:['#ef8f7c','#ffd36e','#7fc8f8','#9ad9b0','#c9a6ee','#f7a5c4'].map((c,i)=>mk('dtBk'+i,c));

  // 1) 침대 옆 바닥에 아무렇게나 쌓인 책
  const px=-2.15, pz=-2.05;
  [[0.52,0.10,0.38,0.06],[0.48,0.09,0.35,-0.09],[0.50,0.08,0.36,0.13]].forEach(function(b,i){
    bx('pile'+i,b[0],b[1],b[2], px+(i%2?0.03:-0.02), 0.015+i*0.095+b[1]/2, pz+(i?0.02:0), bk[i%bk.length], b[3]);
  });
  addBlobShadow(scene,px,pz,0.48,0.34);

  // 2) 러그 옆 곰 인형(아이 방의 '사는 느낌')
  const fur=mk('teddyFur','#ecc39c',0.07), ear=mk('teddyEar','#dba981',0.07);
  const eye=mk('teddyEye','#4b3a34',0.04), snout=mk('teddySnout','#f5e6d2',0.08);
  const tx=2.45, tz=1.15;
  sp('teddyBody',0.62, tx,0.33,tz, fur, 1,0.92,0.86);
  sp('teddyHead',0.50, tx,0.75,tz, fur);
  sp('teddyEarL',0.20, tx-0.19,0.96,tz-0.03, ear);
  sp('teddyEarR',0.20, tx+0.19,0.96,tz-0.03, ear);
  sp('teddySnout',0.22, tx,0.67,tz+0.20, snout, 1,0.78,0.62);
  sp('teddyEyeL',0.07, tx-0.10,0.80,tz+0.22, eye);
  sp('teddyEyeR',0.07, tx+0.10,0.80,tz+0.22, eye);
  sp('teddyNose',0.06, tx,0.71,tz+0.31, eye);
  sp('teddyArmL',0.22, tx-0.27,0.36,tz+0.05, fur, 0.85,1,1.25);
  sp('teddyArmR',0.22, tx+0.27,0.36,tz+0.05, fur, 0.85,1,1.25);
  sp('teddyLegL',0.24, tx-0.15,0.13,tz+0.16, fur, 1,0.8,1.2);
  sp('teddyLegR',0.24, tx+0.15,0.13,tz+0.16, fur, 1,0.8,1.2);
  addBlobShadow(scene,tx,tz,0.44,0.40);

  // 3) 침대 앞 슬리퍼 두 짝
  const slip=mk('slipper','#f3b7c8',0.08);
  [[-3.05,-1.45,-0.20],[-2.72,-1.40,0.16]].forEach(function(s,i){
    const p=sp('slip'+i,0.44, s[0],0.09,s[1], slip, 1.30,0.40,0.72);
    p.rotation.y=s[2];
  });

  // 4) 창 아래 벽 선반 + 미니 책 + 작은 화분
  const shelf=mk('shelfM','#f7dfb8',0.06);
  bx('shelf',1.75,0.07,0.30, -3.20,1.30,-4.78, shelf);
  bx('shelfBr1',0.06,0.16,0.22, -3.85,1.19,-4.80, shelf);
  bx('shelfBr2',0.06,0.16,0.22, -2.55,1.19,-4.80, shelf);
  [[-3.62,'#ef8f7c',0.22],[-3.52,'#ffd36e',0.26],[-3.44,'#7fc8f8',0.20]].forEach(function(b,i){
    bx('shBk'+i,0.065,b[2],0.20, b[0],1.34+b[2]/2,-4.78, mk('shBkM'+i,b[1],0.12));
  });
  cy('shPot',{height:0.13,diameterTop:0.15,diameterBottom:0.11,tessellation:14}, -2.72,1.40,-4.78, mk('shPotM','#e79a86',0.08));
  [-0.05,0.05].forEach(function(dx,i){
    sp('shLeaf'+i,0.16, -2.72+dx,1.53,-4.78, mk('shLeafM','#6fbb7a',0.10), 0.7,1.3,0.55);
  });

  // 5) 원형 탁자 위 머그·연필꽂이·책(실물 가구 키트일 때만 — 상판 높이 0.74)
  if(opt.kit){
    const mug=mk('mugM','#ffffff',0.05);
    cy('mugCup',{height:0.17,diameter:0.16,tessellation:20}, 2.48,0.835,-3.90, mug);
    cy('mugCoffee',{height:0.012,diameter:0.135,tessellation:20}, 2.48,0.921,-3.90, mk('mugCoffeeM','#c98a63',0.04));
    try{
      const h=BABYLON.MeshBuilder.CreateTorus('mugHandle',{diameter:0.13,thickness:0.028,tessellation:14},scene);
      h.position.set(2.575,0.835,-3.90); h.rotation.z=Math.PI/2; h.material=mug; h.isPickable=false;
    }catch(e){}
    cy('penCup',{height:0.16,diameterTop:0.13,diameterBottom:0.11,tessellation:16}, 3.02,0.82,-4.02, mk('penCupM','#c2e8f5',0.08));
    ['#ff8f7a','#ffd15c','#7fc8f8'].forEach(function(c,i){
      const p=cy('pencil'+i,{height:0.28,diameter:0.018,tessellation:8}, 3.02+(i-1)*0.032,0.96,-4.02, mk('penM'+i,c,0.12));
      p.rotation.z=(i-1)*0.10;
    });
    bx('tableBook',0.34,0.045,0.26, 2.74,0.765,-3.72, bk[2], 0.18);
  }

  // 6) 창가 바닥에 떨어진 따뜻한 빛 얼룩(알파 텍스처를 그대로 쓰는 반투명 발광)
  try{
    const tex=texSunPatch(scene);
    const sm=new BABYLON.StandardMaterial('sunPatchM',scene);
    sm.diffuseTexture=tex; sm.diffuseColor=new BABYLON.Color3(1,0.96,0.86);
    sm.emissiveTexture=tex; sm.emissiveColor=new BABYLON.Color3(0.42,0.35,0.22);
    sm.useAlphaFromDiffuseTexture=true;
    sm.specularColor=new BABYLON.Color3(0,0,0);
    sm.backFaceCulling=false; sm.alpha=0.55;
    const patch=BABYLON.MeshBuilder.CreateGround('sunPatch',{width:3.6,height:2.6},scene);
    patch.position.set(-2.2,0.012,-3.05); patch.rotation.y=0.22;
    patch.material=sm; patch.isPickable=false; patch.applyFog=false;
  }catch(e){}
}
// ── 3D 마이룸 가구 키트 (2026-11-04 리팩터) ─────────────────────
//   Quaternius house_interior_pack (CC0) 실물 모델을 그대로 쓴다.
const ROOM_KIT_FILES = ['Bed_Single', 'NightStand_1', 'Bookshelf', 'Shelf_2',
  'Table_RoundSmall2', 'Chair_2', 'Drawer_2', 'Carpet_Round',
  'Houseplant_1', 'Houseplant_5', 'Light_Desk', 'Light_Floor2',
  'Curtains_Double', 'Stool', 'Trashcan_Small1'];

async function loadRoomKit(scene){
  const kit = {};
  await Promise.all(ROOM_KIT_FILES.map(async function(name){
    try{
      const c = await BABYLON.SceneLoader.LoadAssetContainerAsync('assets/room/', name + '.glb', scene);
      c.addAllToScene();
      const node = new BABYLON.TransformNode('rk_' + name, scene);
      c.rootNodes.forEach(function(nd){ nd.parent = node; });
      node.computeWorldMatrix(true);
      const b = node.getHierarchyBoundingVectors(true);
      c.meshes.forEach(function(m){
        if(!m.getTotalVertices || !m.getTotalVertices()) return;
        m.isPickable = false; m.receiveShadows = true; m.castShadow = true;
        const mats = m.material && m.material.subMaterials ? m.material.subMaterials : [m.material];
        mats.forEach(function(mm){
          if(!mm) return;
          if(mm.albedoColor){ mm.metallic = 0; mm.roughness = 0.88; mm.environmentIntensity = 0.55; }
          else if(mm.diffuseColor){ mm.specularColor = new BABYLON.Color3(0.05,0.05,0.05); }
        });
      });
      node.setEnabled(false);
      kit[name] = { node: node, container: c,
        min: b.min.clone(), size: { x: b.max.x-b.min.x, y: b.max.y-b.min.y, z: b.max.z-b.min.z } };
    }catch(e){ console.warn('[roomKit]', name, e && e.message); }
  }));
  return kit;
}
// ── 아동 친화 가구 톤 매핑 (2026-11-04) ─────────────────────
//   원본 Quaternius GLB 는 전부 무채색·고동색 순색 재질(0.02~0.44)이라
//   그대로 쓰면 «어른 카페» 처럼 어둡다. 텍스처가 없으므로 알베도만 다시 칠하면 된다.
//   · 원 색의 명암(대비)은 유지 → 형태가 뭉개지지 않음
//   · 무채색 부품에는 지정한 파스텔 톤을 입히고, 채색 부품(예: 잎)은 색상을 보존
//   · 최종 명도를 0.78~0.96 밴드로 끌어올려 전체가 밝고 포근해진다
function pastelizeMaterial(mm, toneHex, force){
  if(!mm || mm.__kidToned) return;                 // 같은 키트를 두 번 배치해도 이중 톤닝 방지
  const src = mm.albedoColor || mm.diffuseColor;
  if(!src) return;
  const r=src.r, g=src.g, b=src.b;
  const mx=Math.max(r,g,b), mn=Math.min(r,g,b);
  const lum=0.299*r+0.587*g+0.114*b;
  const tone = toneHex ? BABYLON.Color3.FromHexString(toneHex) : null;
  let base;
  if(tone && (force || mx-mn < 0.055)){
    base = tone;                                   // 지정 마카롱 색을 «기본 색» 으로 그대로 사용
  }else{
    const m=mx||1;                                 // 채색 부품(잎 등)은 색상 보존 + 파스텔하게 연하게
    base = new BABYLON.Color3(r/m*0.65+0.35, g/m*0.65+0.35, b/m*0.65+0.35);
  }
  // ★ 흰색에 섞지 않고 «밝은 파스텔 × 원 명암» 으로 → 색이 씻기지 않고 또렷해진다
  const k = 0.74+Math.min(1,lum*1.7)*0.26;
  const col = base.scale(k);
  if(mm.albedoColor) mm.albedoColor=col; else mm.diffuseColor=col;
  mm.__kidToned=true;
}
// 키트 모델을 지정 위치(바닥 기준)로 옮긴다. y0 를 주면 그 높이에 «아래변»을 맞춘다.
function placeKit(kit, name, x, z, ry, y0, opt){
  const k = kit && kit[name];
  if(!k) return null;
  const n = k.node;
  n.setEnabled(true);
  n.rotation.y = ry || 0;
  const sc = (opt && opt.scale) || 1;
  n.scaling.setAll(sc);
  n.position.set(x, (y0 || 0) - k.min.y * sc, z);
  // ★ 2026-11-04 아동 톤: 어두운 원본 가구를 파스텔로 다시 칠한다(색은 opt.tone)
  k.container.meshes.forEach(function(m){
    if(!m.material) return;
    const mats = m.material.subMaterials ? m.material.subMaterials : [m.material];
    mats.forEach(function(mm){ pastelizeMaterial(mm, opt && opt.tone, opt && opt.forceTone); });
  });
  return n;
}

// 실내 소품: 책장 / 화분 / 스탠드 조명 / 액자 / 벽시계 / 삼각 플래그 / 블록
function buildRoomProps(scene, M, kit){
  // 키트가 없으면(로드 실패) 예전 절차형 방으로 폴백
  if(!kit || !kit.Bed_Single){ buildRoomPropsLegacy(scene, M); return; }

  const box=function(n,w,h,d,x,y,z,m){ const b=BABYLON.MeshBuilder.CreateBox(n,{width:w,height:h,depth:d},scene);
    b.position.set(x,y,z); b.material=m; b.isPickable=false; b.receiveShadows=true; b.castShadow=true; return b; };

  // ── 실물 가구 배치 (Quaternius house_interior_pack) ──
  // ★ 2026-11-04 아동 톤: 가구마다 마카롱 색을 달리 준다(민트/복숭아/버터/스카이/라벤더)
  placeKit(kit, 'Bed_Single',      -3.55, -3.00, 0, 0, { tone: '#ffd3c4' });
  placeKit(kit, 'NightStand_1',    -1.80, -4.30, 0, 0, { tone: '#ffe1b8' });
  placeKit(kit, 'Table_RoundSmall2', 2.80, -3.95, 0, 0, { tone: '#ffe6c6' });
  placeKit(kit, 'Chair_2',           2.80, -2.75, Math.PI, 0, { tone: '#c6e9db' });
  placeKit(kit, 'Bookshelf',         4.75, -4.55, -Math.PI/2, 0, { tone: '#ffeec2' });
  placeKit(kit, 'Drawer_2',          4.75, -2.15, -Math.PI/2, 0, { tone: '#ffd9cf' });
  placeKit(kit, 'Carpet_Round',      0.40, -1.40, 0, 0.012, { scale: 1.75, tone: '#ffc4dc', forceTone: true });
  placeKit(kit, 'Houseplant_1',     -5.05, -1.05, 0, 0, { tone: '#cdeed8' });
  placeKit(kit, 'Houseplant_5',      0.95, -4.60, 0, 0, { tone: '#cdeed8' });
  placeKit(kit, 'Light_Floor2',     -5.00,  1.15, 0, 0, { tone: '#ffe9c9' });
  placeKit(kit, 'Stool',             1.25, -1.10, 0, 0, { tone: '#cfe8ff' });
  placeKit(kit, 'Trashcan_Small1',   5.05, -0.50, 0, 0, { tone: '#e2d9ff' });
  placeKit(kit, 'Light_Desk',        3.30, -3.95, 0, 0.74, { tone: '#ffe2c0' });
  // 커튼은 절차형(얇고 밝은 천)으로 — GLB 커튼은 어두운 텍스처라 창을 가린다
  (function(){
    const cyl3=function(n,o,x,y,z,m){ const c=BABYLON.MeshBuilder.CreateCylinder(n,o,scene);
      c.position.set(x,y,z); c.material=m; c.isPickable=false; return c; };
    const rod = cyl3('curtainRod',{height:2.75,diameter:0.055,tessellation:14}, -3.20,4.02,-4.74, M.metal);
    rod.rotation.z = Math.PI/2;
    // ★ 2026-11-04 아동 톤: 양쪽 커튼을 복숭아/민트로 달리 → 리듬감
    const curtainMats=[propMat(scene,'curtainPeach','#ffd9d2',0.06), propMat(scene,'curtainMint','#ccebdd',0.06)];
    curtainMats.forEach(function(m){ m.alpha=0.94; });
    [-4.53,-1.87].forEach(function(cx,ci){
      for(let k=0;k<3;k++){
        const c = cyl3('curtain'+ci+'_'+k,{height:2.18,diameter:0.14,tessellation:14}, cx+(k-1)*0.11,2.86,-4.71, curtainMats[ci]);
        c.scaling.z = 0.55;
      }
    });
  })();

  // 접촉 음영 — 가구가 바닥에 붙어 보이게
  [[-3.55,-3.00,1.55],[-1.80,-4.30,0.55],[2.80,-3.95,0.95],[4.95,-4.30,0.75],
   [-5.05,-1.05,0.55],[0.95,-4.60,0.5],[1.25,-1.10,0.45]].forEach(function(b){
    addBlobShadow(scene, b[0], b[1], b[2], 0.42);
  });

  // ── 벽 액자 2개 ──
  [[3.35,2.30,0.82,0.64,0],[1.35,2.62,0.7,0.8,1]].forEach(function(f){
    box('fr'+f[4], f[2]+0.12, f[3]+0.12, 0.07, f[0], f[1], -4.93, M.frame);
    box('frC'+f[4], f[2], f[3], 0.05, f[0], f[1], -4.88, M.frameCol[f[4]]);
    const s=BABYLON.MeshBuilder.CreateSphere('frS'+f[4],{diameter:0.2,segments:10},scene);
    s.position.set(f[0]-0.02, f[1]+0.02, -4.83); s.scaling.set(1,1,0.35);
    s.material=M.sticker; s.isPickable=false;
  });

  // ── 벽시계 ──
  const ck=BABYLON.MeshBuilder.CreateCylinder('clock',{height:0.08,diameter:0.72,tessellation:26},scene);
  ck.rotation.x=Math.PI/2; ck.position.set(2.55,2.72,-4.92); ck.material=M.frame; ck.isPickable=false;
  const cf=BABYLON.MeshBuilder.CreateCylinder('clockFace',{height:0.09,diameter:0.6,tessellation:26},scene);
  cf.rotation.x=Math.PI/2; cf.position.set(2.55,2.72,-4.86); cf.material=M.clockFace; cf.isPickable=false;
  const ch1=box('clockH1',0.045,0.2,0.03, 2.55,2.81,-4.81, M.metalDark); ch1.rotation.z=0.5;
  const ch2=box('clockH2',0.04,0.26,0.03, 2.61,2.70,-4.81, M.metalDark); ch2.rotation.z=-0.7;

  // 벽 구름 데칼
  const cloudMat = propMat(scene,'cloudMat','#ffffff',0.20);
  [[-3.95,2.52,0.95],[-2.85,2.90,0.62]].forEach(function(c,ci){
    for(let k=0;k<3;k++){
      const p=BABYLON.MeshBuilder.CreateSphere('cloud'+ci+'_'+k,{diameter:0.30*(1-k*0.16),segments:16},scene);
      p.position.set(c[0]+(k-1)*0.20*c[2], c[1]+(k===1?0.09:0), -4.92);
      p.scaling.set(1.7,0.62,0.22); p.material=cloudMat; p.isPickable=false;
    }
  });

  // ── 삼각 깃발 ──
  box('cord',10.8,0.035,0.035, 0,2.95,-4.85, M.cord);
  for(let i=0;i<9;i++){
    const t=i/8, sag=Math.sin(t*Math.PI)*0.34;
    const f=BABYLON.MeshBuilder.CreateDisc('flag'+i,{radius:0.19,tessellation:3},scene);
    f.position.set(-4.9+t*9.8, 2.95-sag-0.2, -4.83); f.rotation.z=Math.PI;
    f.material=M.flag[i%5]; f.isPickable=false;
  }

  // ── 펜던트 조명 ──
  const pendMat = propMat(scene,'pendMat','#e8cfae',0.05);
  const cyl2=function(n,o,x,y,z,m){ const c=BABYLON.MeshBuilder.CreateCylinder(n,o,scene);
    c.position.set(x,y,z); c.material=m; c.isPickable=false; return c; };
  cyl2('pendCord',{height:1.55,diameter:0.03,tessellation:8}, 1.85,4.20,-2.10, M.cord);
  cyl2('pendRose',{height:0.06,diameter:0.26,tessellation:18}, 1.85,4.96,-2.10, M.metal);
  const pendShade = BABYLON.MeshBuilder.CreateCylinder('pendShade',{height:0.42,diameterTop:0.16,diameterBottom:0.74,tessellation:26},scene);
  pendShade.position.set(1.85,3.32,-2.10); pendShade.material=pendMat; pendShade.isPickable=false;
  const pendBulb = BABYLON.MeshBuilder.CreateSphere('pendBulb',{diameter:0.18,segments:18},scene);
  pendBulb.position.set(1.85,3.16,-2.10); pendBulb.material=M.bulb; pendBulb.isPickable=false;
  try{
    const pl = new BABYLON.PointLight('pendantLight', new BABYLON.Vector3(1.85,3.1,-2.10), scene);
    pl.diffuse = new BABYLON.Color3(1.0,0.86,0.68); pl.intensity = 0.40; pl.range = 6.8;
  }catch(e){}

  // ── 벽 전구 줄 ──
  const strPts=[];
  for(let i=0;i<=26;i++){
    const t=i/26;
    strPts.push(new BABYLON.Vector3(-4.75+t*9.5, 3.58-Math.sin(t*Math.PI)*0.20, -4.80));
  }
  const strCord = BABYLON.MeshBuilder.CreateTube('strCord',{path:strPts,radius:0.012,tessellation:6},scene);
  strCord.material = propMat(scene,'strCord','#b9c2cf',0.02); strCord.isPickable=false;
  const strBulbMat = propMat(scene,'strBulb','#ffd9a0',1.0);
  for(let i=0;i<14;i++){
    const t=(i+0.5)/14;
    const b=BABYLON.MeshBuilder.CreateSphere('strBulb'+i,{diameter:0.115,segments:12},scene);
    b.position.set(-4.75+t*9.5, 3.58-Math.sin(t*Math.PI)*0.20-0.09, -4.78);
    b.material=strBulbMat; b.isPickable=false;
  }

  // ── 로봇 발밑 접촉 그림자 ──
  const rShadow = addBlobShadow(scene, 0, 0, 0.82, 0.5);
  scene.__footShadow = rShadow;
}

function buildRoomPropsLegacy(scene, M){
  const box=function(n,w,h,d,x,y,z,m){ const b=BABYLON.MeshBuilder.CreateBox(n,{width:w,height:h,depth:d},scene);
    b.position.set(x,y,z); b.material=m; b.isPickable=false; b.receiveShadows=true; b.castShadow=true; return b; };
  const cyl=function(n,o,x,y,z,m){ const c=BABYLON.MeshBuilder.CreateCylinder(n,o,scene);
    c.position.set(x,y,z); c.material=m; c.isPickable=false; c.receiveShadows=true; c.castShadow=true; return c; };

  // ── 책장(오른쪽) ──
  const sx=4.35, sz=-4.2;
  box('shBack',2.3,1.55,0.12, sx,0.78,sz-0.24, M.woodDark);
  box('shL',0.12,1.55,0.55, sx-1.09,0.78,sz, M.woodDark);
  box('shR',0.12,1.55,0.55, sx+1.09,0.78,sz, M.woodDark);
  box('shTop',2.3,0.1,0.55, sx,1.53,sz, M.wood);
  box('shMid',2.16,0.08,0.52, sx,0.82,sz, M.wood);
  box('shBot',2.16,0.1,0.52, sx,0.06,sz, M.wood);
  [[0,0.34,0.42],[1,0.26,0.34],[2,0.40,0.36],[3,0.30,0.44]].forEach(function(row){
    for(let i=0;i<4;i++){
      const h=row[1]*(0.82+((i+row[0])%3)*0.09);
      box('bk'+row[0]+'_'+i, row[1]*0.8, h, row[2], sx-0.86+i*0.34, (row[0]?0.87:0.11)+h/2, sz+0.03, M.book[(i+row[0])%M.book.length]);
    }
  });
  addBlobShadow(scene, sx, sz+0.05, 1.35, 0.5);

  // ── 화분(왼쪽) ──
  const px=-2.35, pz=-3.85;
  cyl('pot',{height:0.44,diameterTop:0.54,diameterBottom:0.38,tessellation:20}, px,0.22,pz, M.pot);
  cyl('potRim',{height:0.07,diameter:0.58,tessellation:20}, px,0.44,pz, M.potRim);
  cyl('stem',{height:0.62,diameter:0.055,tessellation:10}, px,0.75,pz, M.stem);
  [[0,0.95,0.06],[0.2,0.80,-0.10],[-0.19,0.72,0.12],[0.05,1.18,0.14]].forEach(function(L,i){
    const l=BABYLON.MeshBuilder.CreateSphere('leaf'+i,{diameter:0.34,segments:12},scene);
    l.position.set(px+L[0], L[1], pz+L[2]); l.scaling.set(1,0.22,0.66);
    l.rotation.set(0.5*L[2]+0.3, i*0.9, -0.5*L[0]+0.4);
    l.material=M.leaf[i%2]; l.isPickable=false;
  });
  addBlobShadow(scene, px, pz, 0.5, 0.5);

  // ── 스탠드 조명(오른쪽 앞) ──
  const lx=4.45, lz=-3.15;
  cyl('lampBase',{height:0.07,diameterTop:0.62,diameterBottom:0.7,tessellation:20}, lx,0.035,lz, M.metal);
  cyl('lampPole',{height:1.72,diameter:0.075,tessellation:12}, lx,0.9,lz, M.metal);
  const shade=BABYLON.MeshBuilder.CreateCylinder('lampShade',{height:0.46,diameterTop:0.34,diameterBottom:0.78,tessellation:22},scene);
  shade.position.set(lx,1.93,lz); shade.material=M.shade; shade.isPickable=false;
  cyl('lampGlow',{height:0.05,diameter:0.5,tessellation:18}, lx,1.72,lz, M.bulb);
  addBlobShadow(scene, lx, lz, 0.5, 0.5);

  // ── 벽 액자 2개 ──
  [[3.35,2.30,0.82,0.64,0],[1.35,2.62,0.7,0.8,1]].forEach(function(f){
    box('fr'+f[4], f[2]+0.12, f[3]+0.12, 0.07, f[0], f[1], -4.93, M.frame);
    box('frC'+f[4], f[2], f[3], 0.05, f[0], f[1], -4.88, M.frameCol[f[4]]);
    const s=BABYLON.MeshBuilder.CreateSphere('frS'+f[4],{diameter:0.2,segments:10},scene);
    s.position.set(f[0]-0.02, f[1]+0.02, -4.83); s.scaling.set(1,1,0.35);
    s.material=M.sticker; s.isPickable=false;
  });

  // ── 벽시계 ──
  const ck=BABYLON.MeshBuilder.CreateCylinder('clock',{height:0.08,diameter:0.72,tessellation:26},scene);
  ck.rotation.x=Math.PI/2; ck.position.set(2.55,2.72,-4.92); ck.material=M.frame; ck.isPickable=false;
  const cf=BABYLON.MeshBuilder.CreateCylinder('clockFace',{height:0.09,diameter:0.6,tessellation:26},scene);
  cf.rotation.x=Math.PI/2; cf.position.set(2.55,2.72,-4.86); cf.material=M.clockFace; cf.isPickable=false;
  const ch1=box('clockH1',0.045,0.2,0.03, 2.55,2.81,-4.81, M.metalDark); ch1.rotation.z=0.5;
  const ch2=box('clockH2',0.04,0.26,0.03, 2.61,2.70,-4.81, M.metalDark); ch2.rotation.z=-0.7;

  // 벽 구름 데칼(침대 위) — 빈 벽을 부드럽게 채운다
  const cloudMat = propMat(scene,'cloudMat','#ffffff',0.20);
  [[-3.95,2.52,0.95],[-2.85,2.90,0.62]].forEach(function(c,ci){
    for(let k=0;k<3;k++){
      const p=BABYLON.MeshBuilder.CreateSphere('cloud'+ci+'_'+k,{diameter:0.30*(1-k*0.16),segments:16},scene);
      p.position.set(c[0]+(k-1)*0.20*c[2], c[1]+(k===1?0.09:0), -4.92);
      p.scaling.set(1.7,0.62,0.22); p.material=cloudMat; p.isPickable=false;
    }
  });

  // ── 삼각 플래그(빵빵이) ──
  box('cord',10.8,0.035,0.035, 0,2.95,-4.85, M.cord);
  for(let i=0;i<9;i++){
    const t=i/8, sag=Math.sin(t*Math.PI)*0.34;   //  깃줄은 중앙이 자연스럽게 처짐
    const f=BABYLON.MeshBuilder.CreateDisc('flag'+i,{radius:0.19,tessellation:3},scene);
    f.position.set(-4.9+t*9.8, 2.95-sag-0.2, -4.83); f.rotation.z=Math.PI;
    f.material=M.flag[i%5]; f.isPickable=false;
  }

  // ── 장난감 블록(책장 아래 작은 탑) ──
  const blocks=[[2.02,0.085,-3.45,0.17,0],[2.24,0.075,-3.40,0.15,1],[2.04,0.25,-3.45,0.14,2]];
  blocks.forEach(function(b){
    const o=box('blk'+b[4], b[3],b[3],b[3], b[0],b[1],b[2], M.block[b[4]]);
    o.rotation.y=b[4]*0.5;
  });
  addBlobShadow(scene, 2.05, -3.35, 0.22, 0.4);

  // ── 책상 + 의자 (왼쪽 앞, 빈 공간 채우기) ──
  const dkWood = propMat(scene, 'dkWood', '#C08A5A', 0.06);
  const dkLeg  = propMat(scene, 'dkLeg',  '#8A6239', 0.05);
  const dkPad  = propMat(scene, 'dkPad',  '#5C6E86', 0.05);
  const DX = 3.30, DZ = -0.05;
  const deskTop = box('deskTop', 0.92, 0.09, 2.10, DX, 1.02, DZ, dkWood);
  [[-0.38,-0.92],[-0.38,0.92],[0.38,-0.92],[0.38,0.92]].forEach(function(q,i){
    box('deskLeg'+i, 0.09, 0.98, 0.09, DX+q[0], 0.49, DZ+q[1], dkLeg);
  });
  box('chairPad', 0.46, 0.05, 0.48, DX-0.70, 0.635, DZ, dkPad);
  box('deskDrawer', 0.03, 0.22, 0.55, DX+0.44, 0.88, DZ+0.55, dkLeg);
  // 노트북(열린 상태) — 방에 '공부하는 자리'가 생긴다
  box('lapBase', 0.42, 0.03, 0.60, DX-0.10, 1.08, DZ-0.45, dkPad);
  const lapScr = box('lapScr', 0.42, 0.38, 0.03, DX-0.10, 1.27, DZ-0.72, dkPad);
  lapScr.rotation.x = -0.24;
  cyl('mugDesk', {height:0.15, diameter:0.13, tessellation:14}, DX+0.02, 1.15, DZ+0.55, M.bulb);
  // 의자
  box('chairSeat', 0.54, 0.06, 0.56, DX-0.70, 0.58, DZ, dkWood);
  box('chairBack', 0.06, 0.42, 0.50, DX-0.94, 0.82, DZ, dkWood);
  [[-0.24,-0.24],[-0.24,0.24],[0.24,-0.24],[0.24,0.24]].forEach(function(q,i){
    box('chairLeg'+i, 0.055, 0.56, 0.055, DX-0.70+q[0], 0.28, DZ+q[1], dkLeg);
  });
  addBlobShadow(scene, DX-0.35, DZ, 1.30, 0.30);

  // ── 침대(왼쪽 벽) ── 아이 방의 중심 소품
  const bdWood = propMat(scene,'bdWood','#c99a6b',0.04);
  const bdMatt = propMat(scene,'bdMatt','#f6ead9',0.06);
  const bdBlanket = propMat(scene,'bdBlanket','#9bcfee',0.05);
  const bdPillow = propMat(scene,'bdPillow','#fff7ec',0.08);
  const BX=-3.72, BZ=-1.10;
  box('bedBase',1.58,0.38,2.18, BX,0.19,BZ, bdWood);
  box('bedMattress',1.46,0.24,2.02, BX,0.48,BZ, bdMatt);
  box('bedHead',1.58,0.82,0.12, BX,0.61,BZ-1.05, bdWood);
  box('bedFoot',1.58,0.36,0.10, BX,0.40,BZ+1.06, bdWood);
  [[-0.67,-0.88],[-0.67,0.88],[0.67,-0.88],[0.67,0.88]].forEach(function(q,i){
    box('bedLeg'+i,0.10,0.30,0.10, BX+q[0],0.15,BZ+q[1], bdWood);
  });
  box('bedPillow1',0.55,0.14,0.34, BX-0.32,0.63,BZ-0.72, bdPillow);
  box('bedPillow2',0.52,0.13,0.32, BX+0.28,0.625,BZ-0.70, bdPillow);
  const blanket=box('bedBlanket',1.28,0.07,1.10, BX,0.63,BZ+0.30, bdBlanket);
  box('bedFold',1.30,0.035,0.20, BX,0.675,BZ-0.28, bdBlanket);
  // 베개 위 작은 별 쿠션
  const starC = propMat(scene,'bdStar','#ffd36e',0.22);
  const star = BABYLON.MeshBuilder.CreateSphere('bedStar',{diameter:0.26,segments:18},scene);
  star.position.set(BX+0.02,0.77,BZ-0.72); star.scaling.set(1,0.55,1); star.material=starC; star.isPickable=false;
  addBlobShadow(scene, BX, BZ, 1.18, 0.42);

  // 침대 옆 협탁 + 작은 스탠드 + 책
  const nsX=-2.55, nsZ=-2.18;
  box('nightstand',0.44,0.48,0.44, nsX,0.24,nsZ, bdWood);
  box('nightBook',0.22,0.05,0.16, nsX-0.06,0.505,nsZ+0.02, propMat(scene,'nsBook','#9bcfee',0.12));
  const nlBase=cyl('nightLampBase',{height:0.06,diameter:0.20,tessellation:18}, nsX+0.06,0.51,nsZ-0.10, M.metal);
  cyl('nightLampPole',{height:0.24,diameter:0.035,tessellation:10}, nsX+0.06,0.64,nsZ-0.10, M.metal);
  const nlShade=BABYLON.MeshBuilder.CreateCylinder('nightShade',{height:0.18,diameterTop:0.12,diameterBottom:0.26,tessellation:18},scene);
  nlShade.position.set(nsX+0.06,0.83,nsZ-0.10); nlShade.material=M.shade; nlShade.isPickable=false;
  const nlBulb=BABYLON.MeshBuilder.CreateSphere('nightBulb',{diameter:0.09,segments:14},scene);
  nlBulb.position.set(nsX+0.06,0.74,nsZ-0.10); nlBulb.material=M.bulb; nlBulb.isPickable=false;

  // 침대 위 벽 액자(해/언덕)
  box('bedFrame',1.02,0.74,0.06, BX,2.92,-4.93, M.frame);
  box('bedArt',0.86,0.58,0.04, BX,2.92,-4.89, propMat(scene,'bedArt','#d9efff',0.18));
  const artSun=BABYLON.MeshBuilder.CreateSphere('artSun',{diameter:0.18,segments:16},scene);
  artSun.position.set(BX-0.18,3.05,-4.86); artSun.scaling.set(1,1,0.18); artSun.material=propMat(scene,'artSun','#ffd36e',0.4); artSun.isPickable=false;
  const artHill=BABYLON.MeshBuilder.CreateSphere('artHill',{diameter:0.52,segments:16},scene);
  artHill.position.set(BX+0.14,2.72,-4.86); artHill.scaling.set(1.7,0.55,0.18); artHill.material=propMat(scene,'artHill','#9ad9b0',0.18); artHill.isPickable=false;

  // ── 커튼 + 커튼봉 ──
  const curtainMat = propMat(scene,'curtain','#ffdfd6',0.03);
  const rod = cyl('curtainRod',{height:2.75,diameter:0.055,tessellation:14}, -3.20,4.02,-4.74, M.metal);
  rod.rotation.z = Math.PI/2;
  [-4.53,-1.87].forEach(function(cx,ci){
    for(let k=0;k<3;k++){
      const c = cyl('curtain'+ci+'_'+k,{height:2.18,diameter:0.14,tessellation:14}, cx+(k-1)*0.11,2.86,-4.71, curtainMat);
      c.scaling.z = 0.55;
    }
  });

  // ── 펜던트 조명 ──
  const pendMat = propMat(scene,'pendMat','#e8cfae',0.05);
  cyl('pendCord',{height:3.75,diameter:0.03,tessellation:8}, 1.85,7.05,-2.10, M.cord);
  cyl('pendRose',{height:0.06,diameter:0.26,tessellation:18}, 1.85,8.86,-2.10, M.metal);
  const pendShade = BABYLON.MeshBuilder.CreateCylinder('pendShade',{height:0.42,diameterTop:0.16,diameterBottom:0.74,tessellation:26},scene);
  pendShade.position.set(1.85,5.05,-2.10); pendShade.material=pendMat; pendShade.isPickable=false;
  const pendBulb = BABYLON.MeshBuilder.CreateSphere('pendBulb',{diameter:0.18,segments:18},scene);
  pendBulb.position.set(1.85,4.88,-2.10); pendBulb.material=M.bulb; pendBulb.isPickable=false;
  try{
    const pl = new BABYLON.PointLight('pendantLight', new BABYLON.Vector3(1.85,4.8,-2.10), scene);
    pl.diffuse = new BABYLON.Color3(1.0,0.86,0.68); pl.intensity = 0.40; pl.range = 6.8;
  }catch(e){}

  // ── 벽 전구 줄(따뜻한 포인트) ──
  const strPts=[];
  for(let i=0;i<=26;i++){
    const t=i/26;
    strPts.push(new BABYLON.Vector3(-4.75+t*9.5, 3.58-Math.sin(t*Math.PI)*0.20, -4.80));
  }
  const strCord = BABYLON.MeshBuilder.CreateTube('strCord',{path:strPts,radius:0.012,tessellation:6},scene);
  strCord.material = propMat(scene,'strCord','#b9c2cf',0.02); strCord.isPickable=false;
  const strBulbMat = propMat(scene,'strBulb','#ffd9a0',1.0);
  for(let i=0;i<14;i++){
    const t=(i+0.5)/14;
    const b=BABYLON.MeshBuilder.CreateSphere('strBulb'+i,{diameter:0.115,segments:12},scene);
    b.position.set(-4.75+t*9.5, 3.58-Math.sin(t*Math.PI)*0.20-0.09, -4.78);
    b.material=strBulbMat; b.isPickable=false;
  }

  // ── 러그 술 (양쪽 긴 변) ──
  const fringe = propMat(scene, 'fringe', '#EFE6D8', 0.08);
  for (let i=0;i<11;i++){
    const z = -1.42 + i*0.284;
    box('frL'+i, 0.07, 0.012, 0.04, -1.98, 0.012, z, fringe);
    box('frR'+i, 0.07, 0.012, 0.04,  1.98, 0.012, z, fringe);
  }

  // ── 로봇 발밑 접촉 그림자(실제 그림자와 보완 → 더 단단한 접지감) ──
  // ★ 로봇이 걸어다니면 그림자도 따라가야 한다. 방에 고정해 두면
  //   '로봇만 움직이고 그림자는 원지에 남는' 상태가 된다.
  //   아직 root 가 없을 수 있으므로(아래 startBabylon 에서 나중에 만든다) 여기서는
  //   만들어 두기만 하고, root 생성 뒤에 거기로 붙인다.
  const rShadow = addBlobShadow(scene, 0, 0, 0.82, 0.5);   // ★ V17 접지감 강화
  scene.__footShadow = rShadow;
}

// ★ 구입한 장식을 실제 3D 오브젝트로 배치(남은 위험 1)
//   예전에는 상점에서 산 장식이 목록 텍스트로만 보여서 "돈을 냈는데 보이지 않는" 문제가 있었다.
//   여기서 실제 3D 오브젝트를 방 안에 배치해 구매가 공간으로 드러나게 한다.
function buildOwnedDecors(scene, M, decors){
  if(!decors || !decors.length) return [];
  const placed = [];
  const box=(n,w,h,d,x,y,z,m)=>{ const b=BABYLON.MeshBuilder.CreateBox(n,{width:w,height:h,depth:d},scene);
    b.position.set(x,y,z); b.material=m; b.isPickable=false; b.receiveShadows=true; return b; };
  const cyl=(n,o,x,y,z,m)=>{ const c=BABYLON.MeshBuilder.CreateCylinder(n,o,scene);
    c.position.set(x,y,z); c.material=m; c.isPickable=false; c.receiveShadows=true; return c; };

  // 별 스티커: 벽면(뒷벽)에 붙는 발광 5각 별 — 이미 상점 미리보기에서 사용한 조립 방식
  if(decors.includes('별 스티커')){
    const mx=-0.55, my=2.72, mz=-4.88;
    const starMat = M.sticker;
    const P=[];
    for(let i=0;i<5;i++){ const a=-Math.PI/2+i*Math.PI*2/5; P.push(new BABYLON.Vector3(mx+Math.cos(a)*0.3, my+Math.sin(a)*0.3, mz)); }
    for(let i=0;i<5;i++){
      const a=P[i], b=P[(i+1)%5];
      const len=BABYLON.Vector3.Distance(a,b);
      const bar=BABYLON.MeshBuilder.CreateCylinder('dsBar'+i,{height:len,diameter:0.085,tessellation:8},scene);
      bar.position=BABYLON.Vector3.Center(a,b);
      const dir=b.subtract(a).normalize();
      const axis=BABYLON.Vector3.Cross(BABYLON.Axis.Y, dir);
      const ang=Math.acos(Math.max(-1,Math.min(1,BABYLON.Vector3.Dot(BABYLON.Axis.Y,dir))));
      bar.rotationQuaternion = axis.length()<0.001 ? BABYLON.Quaternion.Identity()
        : BABYLON.Quaternion.RotationAxis(axis.normalize(), ang);
      bar.material=starMat; bar.isPickable=false;
    }
    // 십자 광선
    [[0,0.52,0.028],[0.31,0.31,0.02]].forEach(([rx,ry,th],i)=>{
      const r1=BABYLON.MeshBuilder.CreateBox('dsRayV'+i,{width:0.035,height:ry,depth:0.025},scene);
      r1.position.set(mx, my, mz); r1.material=starMat; r1.isPickable=false;
      const r2=BABYLON.MeshBuilder.CreateBox('dsRayH'+i,{width:rx||ry,height:0.035,depth:0.025},scene);
      r2.position.set(mx+(i?0.22:0), my+(i?0.22:0), mz); r2.material=starMat; r2.isPickable=false;
    });
    // 뒷벽 액자 자리에 붙은 별이라 앵커(작은 테이프) 추가
    const tape=box('dsTape',0.12,0.05,0.02, mx, my+0.3, mz+0.01, M.frame);
    placed.push('별 스티커');
  }

  // 선물 상자: 책장 아래 바닥에 놓인 상자 + 리본 매듭
  if(decors.includes('선물 상자')){
    const gx=1.85, gy=0, gz=-2.95;
    const g=box('giftBox',0.52,0.42,0.52, gx, gy+0.21, gz, M.giftBox);
    const lid=box('giftLid',0.56,0.1,0.56, gx, gy+0.44, gz, M.giftRibbon);
    // 크로스 리본 2줄
    box('giftRib1',0.11,0.53,0.545, gx, gy+0.24, gz, M.giftRibbon);
    box('giftRib2',0.545,0.53,0.11, gx, gy+0.24, gz, M.giftRibbon);
    // 매듭 구
    const knot=BABYLON.MeshBuilder.CreateSphere('giftKnot',{diameter:0.15,segments:12},scene);
    knot.position.set(gx, gy+0.5, gz); knot.scaling.set(1,0.75,1);
    knot.material=M.giftRibbon; knot.isPickable=false;
    // 리본 양 갈래(루프 2개)
    [0,1].forEach(i=>{
      const loop=BABYLON.MeshBuilder.CreateTorus('giftLoop'+i,{diameter:0.2,thickness:0.045,tessellation:14},scene);
      loop.position.set(gx+(i?0.09:-0.09), gy+0.55, gz);
      loop.rotation.x=Math.PI/2.6; loop.rotation.z=i?0.5:-0.5;
      loop.material=M.giftRibbon; loop.isPickable=false;
    });
    addBlobShadow(scene, gx, gz, 0.42, 0.5);
    placed.push('선물 상자');
  }

  // 장식 종류를 늘릴 때는 여기에 분기를 하나 더 추가하면 된다(이름 확인 → 메시 생성)
  return placed;
}

// 방 베이스(바닥/벽/창/러그/조명/소품) — 마이룸과 미리보기 공용
// opt: { props:false → 소품 생략, dust:false → 먼지 입자 생략 }
function createRoomBase(scene, opt){
  opt = opt||{};
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
  // ★ 2026-11-04 아동 톤: 차가운 푸른 안개 → 따뜻한 크림 안개(창가와 방이 포근하게 이어짐)
  scene.fogColor = new BABYLON.Color3(1.0,0.957,0.925);
  scene.fogDensity = 0.0052;  // ★ 2026-11-05: 0.006 → 0.0052, 크림 안개로 화면이 밀키하게 뜨는 현상 완화

  // ★ 2026-11-05 과노출 보정: «밝지만 평평한» 방의 원인은 6개 광원 합산 + groundColor≈흰색 +
  //   전 표면 자기발광이었다. 방향성 있는 키라이트를 남기고 아래쪽 채움광을 낮춰 명암을 되살린다.
  //   톤 자체는 아동 친화(크림·복숭아)를 유지하며, 채도는 건드리지 않는다.
  const hemi = new BABYLON.HemisphericLight('h', new BABYLON.Vector3(0,1,0), scene);
  hemi.intensity = 0.46; hemi.diffuse = new BABYLON.Color3(1,0.985,0.965);
  hemi.groundColor = new BABYLON.Color3(0.80,0.76,0.71);   // 아래면을 살짝 어둡게 → 로봇·가구에 음영 생성
  const dir = new BABYLON.DirectionalLight('d', new BABYLON.Vector3(-0.42,-0.9,-0.62), scene);
  dir.intensity = 0.82; dir.position = new BABYLON.Vector3(3.6,7.6,5.4);
  dir.autoCalcShadowZBounds = false; dir.shadowMinZ = 2; dir.shadowMaxZ = 18;
  // 림 라이트(역광): 로봇 윤곽을 배경에서 분리해 입체감↑
  const rimLight = new BABYLON.DirectionalLight('rimLight', new BABYLON.Vector3(0,-0.45,1), scene);
  rimLight.intensity = 0.24; rimLight.position = new BABYLON.Vector3(-2.4,5,-7);
  // ★ 2026-11-04 정밀화 + 아동 톤: 창가 Warm Key + 정면 Fill + 기분 등(3점 조명)
  //   필을 찬 파랑에서 «복숭아 크림» 으로 바꿔 방 전체가 차갑게 죽지 않게 한다.
  const windowLight = new BABYLON.PointLight('windowLight', new BABYLON.Vector3(-3.2,3.4,-3.9), scene);
  windowLight.diffuse = new BABYLON.Color3(1.0,0.93,0.80);
  windowLight.specular = new BABYLON.Color3(1.0,0.97,0.90);
  windowLight.intensity = 0.48; windowLight.range = 13;
  const fillLight = new BABYLON.PointLight('fillLight', new BABYLON.Vector3(2.6,2.4,3.4), scene);
  fillLight.diffuse = new BABYLON.Color3(1.0,0.93,0.95);
  fillLight.intensity = 0.22; fillLight.range = 12;
  const moodLight = new BABYLON.PointLight('moodLight', new BABYLON.Vector3(0,3.5,-1.4), scene);
  moodLight.diffuse = new BABYLON.Color3(1.0,0.96,0.90);
  moodLight.intensity = 0.18; moodLight.range = 10;
  scene.__moodLight = moodLight;   // 기분 체크 결과가 이 빛의 색을 바꾼다

  const flat = m=>{ m.specularColor=new BABYLON.Color3(0,0,0); return m; };
  const HW=5.6, HD=5.0, WH=9.0;                       // 벽 반너비 / 뒷벽 z / 벽 높이
  const WIN={x0:-4.4, x1:-2.0, y0:1.7, y1:3.9};       // 창 개구부

  // ── 마루 바닥 ──
  const floor = BABYLON.MeshBuilder.CreateGround('floor',{width:26,height:26,subdivisions:1},scene);
  const fm=flat(new BABYLON.StandardMaterial('fm',scene));
  fm.diffuseTexture=texWood(scene); fm.diffuseColor=new BABYLON.Color3(1,1,1);
  floor.material=fm; floor.isPickable=false; floor.receiveShadows=true;

  // ── 벽(뒷벽을 창 개구부 기준으로 4조각 분할 → 실제 구멍) ──
  const wallMat=flat(new BABYLON.StandardMaterial('wallM',scene));
  wallMat.diffuseTexture=texWall(scene);                       // ★ 2026-11-04 정밀화: 단색 → 플라스터 결 벽지
  wallMat.diffuseColor=new BABYLON.Color3(1,1,1);
  wallMat.emissiveColor=new BABYLON.Color3(0.07,0.066,0.060); // ★ 2026-11-05: 0.10 → 0.07, 벽이 백지처럼 떠오르던 원인 완화
  wallMat.backFaceCulling=false;
  wallMat.twoSidedLighting=true;   // ★ 평면 뒷면도 빛을 받도록 (벽이 검게 죽던 원인)
  const wainMat=flat(new BABYLON.StandardMaterial('wainM',scene)); wainMat.diffuseColor=new BABYLON.Color3(0.88,0.94,0.90);
  wainMat.emissiveColor=new BABYLON.Color3(0.06,0.06,0.052);
  wainMat.backFaceCulling=false;
  wainMat.twoSidedLighting=true;
  const baseMat=flat(new BABYLON.StandardMaterial('baseM',scene)); baseMat.diffuseColor=new BABYLON.Color3(1,1,1);
  baseMat.backFaceCulling=false; baseMat.twoSidedLighting=true;
  const plane=function(n,w,h,x,y,z,m){ const p=BABYLON.MeshBuilder.CreatePlane(n,{width:w,height:h},scene);
    p.position.set(x,y,z); p.material=m; p.isPickable=false; p.receiveShadows=true; return p; };
  const wcx=(WIN.x0+WIN.x1)/2, wcy=(WIN.y0+WIN.y1)/2, ww=WIN.x1-WIN.x0, wh=WIN.y1-WIN.y0;
  if(!opt.bare) plane('wL', WIN.x0+HW, WH, (-HW+WIN.x0)/2, WH/2, -HD, wallMat);
  if(!opt.bare) plane('wR', HW-WIN.x1, WH, (HW+WIN.x1)/2, WH/2, -HD, wallMat);
  if(!opt.bare) plane('wB', ww, WIN.y0, wcx, WIN.y0/2, -HD, wallMat);
  if(!opt.bare) plane('wT', ww, WH-WIN.y1, wcx, (WH+WIN.y1)/2, -HD, wallMat);
  if(!opt.bare) plane('sideL', 18, WH, -HW, WH/2, 2, wallMat).rotation.y=Math.PI/2;
  if(!opt.bare) plane('sideR', 18, WH,  HW, WH/2, 2, wallMat).rotation.y=Math.PI/2;
  // 걸레받이 + 걸레받이 몰딩(벽과 바닥의 경계가 자연스럽고, 이전의 딱딱한 경계 사라짐)
  if(!opt.bare) plane('wainB', HW*2, 1.0, 0, 0.5, -HD+0.02, wainMat);
  if(!opt.bare) plane('wainL', 18, 1.0, -HW+0.02, 0.5, 2, wainMat).rotation.y=Math.PI/2;
  if(!opt.bare) plane('wainR', 18, 1.0,  HW-0.02, 0.5, 2, wainMat).rotation.y=Math.PI/2;
  const skirt=function(n,w,d,x,z,ry){ const b=BABYLON.MeshBuilder.CreateBox(n,{width:w,height:0.15,depth:d},scene);
    b.position.set(x,0.075,z); if(ry) b.rotation.y=ry; b.material=baseMat; b.isPickable=false; return b; };
  if(!opt.bare){ skirt('skB',HW*2,0.07, 0,-HD+0.05, 0);
  skirt('skL',18,0.07, -HW+0.05,2, Math.PI/2);
  skirt('skR',18,0.07,  HW-0.05,2, Math.PI/2); }
  // ★ 2026-11-04 정밀화: 평면 띠 위에 입체 패널 몰딩을 얹어 벽에 깊이감 부여
  try{ addWainscot(scene, opt, HD, HW); }catch(e){ console.warn('[wainscot]', e); }
  // 천장(위쪽 빈 공간을 막아 시선이 자연스럽게 닫히도록)
  const ceilMat=flat(new BABYLON.StandardMaterial('ceilM',scene)); ceilMat.diffuseColor=new BABYLON.Color3(1.0,0.985,0.96);
  ceilMat.backFaceCulling=false; ceilMat.twoSidedLighting=true;
  ceilMat.emissiveColor=new BABYLON.Color3(0.05,0.047,0.040);  // 천장이 새까맣게 죽지 않도록(온기, 과노출 방지로 하향)
  if(!opt.bare){ const ceil=BABYLON.MeshBuilder.CreateGround('ceiling',{width:HW*2.4,height:20,subdivisions:1},scene);
  ceil.position.set(0, WH-0.02, 2); ceil.rotation.x=Math.PI;   // 아래를 향하도록 뒤집음
  ceil.material=ceilMat; ceil.isPickable=false;
  // 천장 가장자리 몰딩(벽과 천장 사이 경계 정리)
  const crown=function(n,w,d,x,z,ry){ const b=BABYLON.MeshBuilder.CreateBox(n,{width:w,height:0.12,depth:d},scene);
    b.position.set(x,WH-0.06,z); if(ry) b.rotation.y=ry; b.material=baseMat; b.isPickable=false; return b; };
  crown('crB',HW*2,0.08, 0,-HD+0.04, 0);
  crown('crL',18,0.08, -HW+0.04,2, Math.PI/2);
  crown('crR',18,0.08,  HW-0.04,2, Math.PI/2); }

  // ── 창(틀 + 십자 창살 + 창대 + 창밖 풍경) ──
  const frameMat=flat(new BABYLON.StandardMaterial('frmM',scene)); frameMat.diffuseColor=new BABYLON.Color3(1,0.98,0.94);
  frameMat.backFaceCulling=false; frameMat.twoSidedLighting=true;
  const fbox=function(n,w,h,d,x,y,z){ const b=BABYLON.MeshBuilder.CreateBox(n,{width:w,height:h,depth:d},scene);
    b.position.set(x,y,z); b.material=frameMat; b.isPickable=false; return b; };
  if(!opt.bare){
  fbox('wfT',ww+0.24,0.14,0.16, wcx,WIN.y1+0.05,-HD+0.02);
  fbox('wfB',ww+0.24,0.16,0.22, wcx,WIN.y0-0.05,-HD+0.03);
  fbox('wfL',0.14,wh+0.2,0.16, WIN.x0-0.05,wcy,-HD+0.02);
  fbox('wfR',0.14,wh+0.2,0.16, WIN.x1+0.05,wcy,-HD+0.02);
  fbox('wfV',0.08,wh,0.10, wcx,wcy,-HD+0.04);
  fbox('wfH',ww,0.08,0.10, wcx,wcy,-HD+0.04);
  fbox('sill',ww+0.4,0.09,0.34, wcx,WIN.y0-0.14,-HD+0.16);
  const skyMat=new BABYLON.StandardMaterial('skyM',scene);
  skyMat.diffuseTexture=texSky(scene); skyMat.emissiveColor=new BABYLON.Color3(0.70,0.68,0.65); // ★ 2026-11-05: 창밖 백화 완화
  skyMat.specularColor=new BABYLON.Color3(0,0,0); skyMat.disableLighting=true; skyMat.backFaceCulling=false;
  const sky=BABYLON.MeshBuilder.CreatePlane('skyView',{width:10,height:7},scene);
  sky.position.set(wcx+0.5, wcy+0.6, -HD-3.0); sky.material=skyMat; sky.isPickable=false; sky.applyFog=false;
  scene.__skyMesh = sky;
  }

  // ── 창빛 기둥(additive 위장 볼륨광, 공기감 표현) ──
  const beam=BABYLON.MeshBuilder.CreateCylinder('beam',{height:5.2,diameterTop:1.0,diameterBottom:2.6,tessellation:20},scene);
  const bFrom=new BABYLON.Vector3(wcx,WIN.y1,-HD+0.15), bTo=new BABYLON.Vector3(wcx+1.6,0.06,-HD+3.8);
  const dv=bTo.subtract(bFrom), dN=dv.scale(1/dv.length());
  beam.position.copyFrom(bFrom.add(dv.scale(0.5)));
  const ax=BABYLON.Vector3.Cross(BABYLON.Axis.Y, dN);
  beam.rotationQuaternion = ax.length()<0.001 ? BABYLON.Quaternion.Identity()
    : BABYLON.Quaternion.RotationAxis(ax.normalize(), Math.acos(Math.max(-1,Math.min(1,BABYLON.Vector3.Dot(BABYLON.Axis.Y,dN)))));
  const bm=new BABYLON.StandardMaterial('beamM',scene);
  bm.emissiveColor=new BABYLON.Color3(1,0.98,0.92); bm.diffuseColor=new BABYLON.Color3(0,0,0);
  bm.specularColor=new BABYLON.Color3(0,0,0); bm.disableLighting=true; bm.backFaceCulling=false;
  bm.alpha=0.032; bm.alphaMode=BABYLON.Engine.ALPHA_ADD;   // ★ V18 0.06→0.032 (창가 백화 완화)
  beam.material=bm; beam.isPickable=false; beam.applyFog=false;
  if(opt.bare) beam.dispose();

  // ──  러그(둥근 모서리 + 문양) ──
  if(!opt.bare && !opt.kit){ const rug=BABYLON.MeshBuilder.CreateGround('rug',{width:3.9,height:3.1,subdivisions:1},scene);
  rug.position.y=0.014;
  const rugMat=flat(new BABYLON.StandardMaterial('rugM',scene));
  rugMat.diffuseTexture=texRug(scene); rugMat.diffuseTexture.hasAlpha=true;
  rugMat.useAlphaFromDiffuseTexture=true; rugMat.backFaceCulling=false;
  rug.material=rugMat; rug.isPickable=false; rug.receiveShadows=true; }

  // ── 소품 ──
  if(opt.props !== false){
    const palette=['#ef8f7c','#ffd36e','#7fc8f8','#9ad9b0','#c9a6ee','#f7a5c4'];
    const M={
      wood:propMat(scene,'mWood','#d9b98c'), woodDark:propMat(scene,'mWoodD','#b98f5f'),
      pot:propMat(scene,'mPot','#e79a86'), potRim:propMat(scene,'mPotR','#f6bfae'),
      stem:propMat(scene,'mStem','#5f9e6a'),
      leaf:[propMat(scene,'mLf1','#6fbb7a'), propMat(scene,'mLf2','#57a566')],
      metal:propMat(scene,'mMet','#c3ccd8'), metalDark:propMat(scene,'mMetD','#8b95a3'),
      shade:propMat(scene,'mShade','#ffe0a8',0.42), bulb:propMat(scene,'mBulb','#fff4d2',0.85),
      frame:propMat(scene,'mFrame','#c9a273'),
      frameCol:[propMat(scene,'mFc1','#ffd9e2'), propMat(scene,'mFc2','#cdeafd')],
      sticker:propMat(scene,'mStk','#ff8fa3',0.3), clockFace:propMat(scene,'mClk','#fdfdff'),
      cord:propMat(scene,'mCord','#b9c2cf'),
      flag:['#ff9aa2','#ffd93d','#8fd3ff','#b5e48c','#d5b3ff'].map(function(c,i){ return propMat(scene,'mFlg'+i,c,0.3); }),
      book:palette.map(function(c,i){ return propMat(scene,'mBk'+i,c,0.16); }),
      block:[propMat(scene,'mBl0','#7fc8f8'), propMat(scene,'mBl1','#ffd36e'), propMat(scene,'mBl2','#9ad9b0')],
      // ★ 소유 장식용 재질(선물 상자)
      giftBox:propMat(scene,'mGiftB','#e05a5a'),
      giftRibbon:propMat(scene,'mGiftR','#ffd54f',0.28)
    };
    buildRoomProps(scene, M, opt.kit);
    // ★ 2026-11-04 정밀화: 생활감 소품(키트/레거시 공통)
    try{ addRoomDetails(scene, M, opt); }catch(e){ console.warn('[roomDetails]', e); }
    scene.__propM = M;   // 장식 재생성 시 재사용(재질 중복 생성 방지)
    // ★ 이미 구매한 장식을 실제 3D 오브젝트로 배치(돈을 낸 만큼 보이게)
    try{ scene.__placedDecors = buildOwnedDecors(scene, M, opt.decors||[]); }catch(e){ console.error('[decors]', e); }
  }
  // 단품 전시대(장식 미리보기 전용) — 상품이 공중에 뜨지 않도록 받침대
  if(opt.bare){
    const ped=BABYLON.MeshBuilder.CreateCylinder('pedestal',{height:0.1,diameter:1.15,tessellation:44},scene);
    ped.position.y=0.05; ped.isPickable=false; ped.receiveShadows=true;
    const pm=flat(new BABYLON.StandardMaterial('pedM',scene)); pm.diffuseColor=new BABYLON.Color3(1,1,1);
    const pt=new BABYLON.DynamicTexture('pedT',{width:256,height:256},scene,true);
    const pc=pt.getContext(); const pgr=pc.createRadialGradient(128,128,20,128,128,128);
    pgr.addColorStop(0,'#ffffff'); pgr.addColorStop(0.7,'#f3f8ff'); pgr.addColorStop(1,'#dfeaf7');
    pc.fillStyle=pgr; pc.fillRect(0,0,256,256); pt.update(false);
    pm.diffuseTexture=pt; ped.material=pm;
  }
  if(opt.dust !== false && BABYLON.ParticleSystem) addDustMotes(scene);
  return { dir, hemi };
}
// 부드러운 그림자 (rebuild 후 다시 호출해 캐스터 갱신)
function applyShadow(scene, dir, meshRoot){
  if(!scene.__shadow){
    // ★ V17: 1024→2048 + 하이필터. 바닥이 26×26 으로 넓어 해상도가 부족했다.
    //   bias/normalBias 를 줘서 그림자가 얼굴에 붙는 '아크네'를 막는다.
    const sh = new BABYLON.ShadowGenerator(1536, dir);
    sh.usePercentageCloserFiltering = true;
    sh.filteringQuality = BABYLON.ShadowGenerator.QUALITY_MEDIUM;
    sh.darkness = 0.34; sh.bias = 0.002; sh.normalBias = 0.02;
    scene.__shadow = sh;
  }
  const casters = meshRoot.getChildMeshes(false);
  try{ scene.meshes.forEach(m=>{ if(m.castShadow && m.isEnabled && m.isEnabled()) casters.push(m); }); }catch(e){}
  scene.__shadow.getShadowMap().renderList = casters;
}

// ★ V11 저사양 기기 자동 조정 — 학교 태블릿·크롬북에서도 끊기지 않게.
//   아이는 '버벅임'을 화질보다 훨씬 크게 느낀다 → 부드러움을 우선한다.
//   시작 후 2.5초간 실제 FPS 를 재서 낮으면 해상도·그림자·후처리를 포기한다.
function autoTuneQuality(engine, scene){
  if(bjs._tuned) return;
  bjs._tuned = true;
  // ★ V17: 예전에는 시작 2.5초를 그대로 쟀는데, 그 구간이 정확히 환경 텍스처 로딩과
  //   셰이더 컴파일 구간이라 어떤 기기든 FPS 가 낮게 나왔다 → 그림자가 무조건 꺼졌다.
  //   워밍업 1.2초를 버리고, 그 뒤 2.5초만 측정한다. 그림자는 정말 느릴 때만 포기.
  let frames = 0;
  let t0 = 0;
  let obs = null;
  setTimeout(()=>{
    t0 = performance.now();
    obs = scene.onAfterRenderObservable.add(()=>{ frames++; });
    setTimeout(()=>{
      try{ scene.onAfterRenderObservable.remove(obs); }catch(e){}
      const fps = frames / Math.max(0.5, (performance.now() - t0) / 1000);
      bjs.fps = Math.round(fps);
      if(fps>= 18) return;                             // 18fps 이상이면 화질 유지
      bjs.lowPerf = true;
      // ★ 2026-11-04: 해상도는 절대 낮추지 않는다(레티나에서 0.8배 → 심하게 흐려짐).
      //   대신 그림자·후처리·글로우만 단계적으로 끈다.
      if(fps <14){
        try{ if(scene.__shadow){ scene.__shadow.dispose(); scene.__shadow = null; } }catch(e){}
        try{ if(bjs.pipeline){ bjs.pipeline.dispose(); bjs.pipeline = null; } }catch(e){}        // 3차: 후처리
        try{ if(bjs.glow){ bjs.glow.dispose(); bjs.glow = null; } }catch(e){}                   // 3-B: Glow
        try{ if(bjs.ssao){ bjs.ssao.dispose(); bjs.ssao = null; } }catch(e){}                   // 3-C: SSAO
        try{ scene.particleSystems.slice().forEach(p=>p.dispose()); }catch(e){}                 // 4차: 먼지
      }
      console.log('[성능] FPS', Math.round(fps), '→ 저사양 모드(해상도' + (fps <18 ? '·그림자·후처리·먼지' : '') + ' 해제)');
    }, 2500);
  }, 1200);
}

async function startBabylon(canvas, robot, fallback){
  if(bjs._starting || bjs.ready) return; // 중복 시작 방지 (환경 로드 대기 중 재진입)
  bjs._starting = true;
  try{
    const engine = new BABYLON.Engine(canvas, true, {preserveDrawingBuffer:true, stencil:true, adaptToDeviceRatio:true});
    // ★ V18: 방이 숨겨진 상태에서 엔진이 만들어지면 캔버스가 300×150 으로 굳는다.
    //   크기가 바뀔 때마다(탭 전환·화면 전환·창 크기) 다시 맞춘다.
    try{
      if(window.ResizeObserver){
        const ro = new ResizeObserver(()=>{ try{ engine.resize(); }catch(e){} });
        ro.observe(canvas);
      }
    }catch(e){}
    const scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0.995,0.960,0.932,1); // #fff4ed 크림(아동 톤)

    // 카메라: +z 쪽에서 로봇 정면을 바라봄 (alpha=π/2 → z 양수, 벽이 로봇 뒤에 위치)
    const cam = new BABYLON.ArcRotateCamera('cam', Math.PI/2, 1.30, 6.8, new BABYLON.Vector3(0,1.05,0), scene);
    // ★ V17 프레이밍: 캔버스 비율이 세로로 길면 같은 거리에서 로봇만 크게 보인다.
    //   비율을 읽어 거리를 자동 보정하고, 리사이즈 때마다 다시 맞춘다.
    const fitRoomCamera = ()=>{
      const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
      const ar = w / h;
      const r = Math.max(5.15, Math.min(8.8, 5.55 + (1.35 - ar) * 2.4));
      cam.radius = r;
      cam.lowerRadiusLimit = Math.max(4.0, r * 0.72);
      cam.upperRadiusLimit = r * 1.55;
      cam.beta = ar <0.9 ? 1.20 : 1.26;
    };
    fitRoomCamera();
    // ★ 2026-11-05: 수평 회전을 정면 ±70° 로 제한한다.
    //   제한이 없으면 180° 로 돌렸을 때 카메라가 방 뒤편 벽 밖으로 나가 «빈 화면» 이 보였다.
    cam.lowerAlphaLimit = Math.PI/2 - 1.22;
    cam.upperAlphaLimit = Math.PI/2 + 1.22;
    // 줌 한계 설정 (휠로 확대/축소)
    cam.lowerRadiusLimit = cam.lowerRadiusLimit || 4.2; cam.upperRadiusLimit = cam.upperRadiusLimit || 11;
    cam.wheelDeltaPercentage = 0.02;
    if(!canvas.__zoomBound){
      canvas.__zoomBound = true;
      canvas.addEventListener('wheel', (e)=>{
        e.preventDefault();
        cam.radius = Math.max(cam.lowerRadiusLimit, Math.min(cam.upperRadiusLimit, cam.radius + e.deltaY*0.012));
      }, {passive:false});
    }
    // 조명·바닥·러그·안개 (미리보기 창과 공용)
    // ★ decors 전달 → 구매한 장식이 방 안에 실제 3D 오브젝트로 놓인다
    // ★ 2026-11-04: 실물 가구 키트 로드(실패하면 절차형 방으로 폴백)
    let roomKit = null;
    try{ roomKit = await loadRoomKit(scene); }catch(e){ console.warn('[roomKit]', e); }
    const { dir, hemi } = createRoomBase(scene, { decors: state.decors||[], kit: roomKit });
    // ★ 2026-10-31: 발광 파츠(눈/코어/안테나/전구)를 부드럽게 번지게 하는 Glow
    let roomGlow = null;
    try{
      if(BABYLON.GlowLayer){
        roomGlow = new BABYLON.GlowLayer('glow', scene, {mainTextureFixedSize:512, blurKernelSize:32});
        roomGlow.intensity = 0.18;   // ★ 2026-11-05: 0.24 → 0.18, 발광 번짐으로 하이라이트가 뭉개지는 현상 완화
        if(scene.__skyMesh) roomGlow.addExcludedMesh(scene.__skyMesh);
      }
    }catch(e){}

    // ★ 2026-10-31: 접촉 음영(SSAO)으로 가구/로봇의 깊이를 살린다.
    let roomSSAO = null;
    try{
      if(BABYLON.SSAO2RenderingPipeline && engine.webGLVersion > 1){
        roomSSAO = new BABYLON.SSAO2RenderingPipeline('ssao', scene,
          { ssaoRatio:0.5, blurRatio:0.5 }, [cam]);
        roomSSAO.radius = 1.05;
        roomSSAO.totalStrength = 0.95;
        roomSSAO.samples = 16;
        roomSSAO.expensiveBlur = false;
      }
    }catch(e){}

    const root = new BABYLON.TransformNode('robotRoot', scene);
    root.rotation.y = 0;   // ★ V17 시작 자세는 카메라 정면
    const bob  = new BABYLON.TransformNode('bob', scene); bob.parent = root;
    const model= new BABYLON.TransformNode('model', scene); model.parent = bob;
    // 발밑 그림자를 root 에 붙여 로봇과 함께 움직이게 한다
    if(scene.__footShadow){ scene.__footShadow.parent = root; scene.__footShadow.position.y = 0.008; }
// ★ V3 수정: bjs 를 다시 만들 때 _starting:true 를 반드시 함께 넣는다.
    //   원래는 자꾸 때 _starting 이 사라져서, 환경 텍스처 로딩(~2.5초) 동안
    //   마이룸이 다시 호출되면 가드를 통과해 같은 canvas 에 두 번째 Engine 이 생겼다
    //   (렌더 루프 2개, 호흡 2배, wanderTimer 누수).
    bjs = { engine, scene, root, bob, model, canvas, cam, glow:roomGlow, ssao:roomSSAO, ready:false, _t:0, wanderTimer:null, _starting:true };

    // PBR 환경광 로드(최대 2.5초) → 성공 시 점토 질감, 실패 시 Standard 로봇 생성
    tryLoadEnvironment(scene).then(async ok=>{
      try{
        const factory = makeMatFactory(scene, ok);
        bjs.matFactory = factory;
        // ★ V17: 환경광이 성공해도 키 라이트를 예전 값(0.6)으로 되돌리지 않는다.
        //   되돌리면 PBR 반사가 있는 기기에서만 장면이 다시 평평해진다.
        if(ok){ hemi.intensity = 0.38; dir.intensity = 0.88; }   // ★ 2026-11-05: 환경광 성공 시에도 과노출되지 않게 상한을 낮춤
        // ★ 2026-11-05: ACES 톤매핑은 유지하되 노출을 1.06→0.94 로 내리고 대비를 살짝 올려
        //   마카롱 색이 하이라이트에서 하얗게 날아가는 현상을 막는다.
        try{
          const pipe = new BABYLON.DefaultRenderingPipeline('dpr', true, scene, [cam]);
          bjs.pipeline = pipe;   // ★ V11 저사양 모드에서 해제할 수 있게 보관
          pipe.fxaaEnabled = true;
          try{ pipe.samples = 4; }catch(e){}   // MSAA 4x (가장자리 선명)
          pipe.imageProcessing.toneMappingEnabled = true;
          try{ pipe.imageProcessing.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES; }catch(e){}
          pipe.imageProcessing.exposure = 1.01;
          pipe.imageProcessing.contrast = 1.05;
          pipe.imageProcessing.vignetteEnabled = true;
          pipe.imageProcessing.vignetteWeight = 1.1;
          pipe.imageProcessing.vignetteStretch = 0.4;
        }catch(e){ new BABYLON.FxaaPostProcess('fxaa', 1.0, cam); } // 폴백
        bjs.refs = buildRobotModel(scene, model, effectiveColors(robot.template, robot.palette), robot.template, null, factory, curStage());
        applyShadow(scene, dir, model); // 로봇 그림자를 바닥에

        // 대기 모션: 위아래 흔들림 + 호흡/깜빡임/안테나 펄스 + v1.31 자율 동작
        scene.onBeforeRenderObservable.add(()=>{
          const dt=engine.getDeltaTime()/1000; bjs._t+=dt;
          // 이동 갱신(루트 위치/회전 조작) → 그 다음 원래 애니메이션
          updateWalk(dt);
          // 점프 애니메이션 중이면 숨의 흔들림이 값을 덮어쓰므로 멈춘다
          if(!_walk.walking && !bjs._jumping) bob.position.y=Math.sin(bjs._t*2)*0.03;
          const talk = Math.max(0, 1-(Date.now()-(bjs.talkUntil||0))/900);
          // 산책·점프 중에는 자율 동작을 멈춰 서로 덮어쓰지 않게 한다
          if(bjs.refs) bjs.refs._busy = !!(_walk.walking || bjs._jumping);
          updateIdle(bjs.refs, bjs._t, talk);
        });
        // 아이가 가만히 있으면 로봇이 스스로 몇 걸음 걸어다닌다(무한 반복 예약)
        // ★ v1.31: 첫 9초 정지 + 11초 간격은 «가만히 서 있는 것» 처럼 보여 3.5초 / 7초로 앞당겼다.
        //   첫 1.8초에 손 인사 동작이 먼저 나오므로 첫인상은 여전히 얼굴 중심이다.
        setTimeout(()=>{
          if(!bjs.ready) return;
          bjs.wanderTimer = setInterval(()=>{ if(bjs.ready && !_walk.active && !bjs._userDragging) idleWander(); }, 7000);
        }, 3500);

        // 왼쪽 드래그=회전 / 오른쪽 드래그=카메라 이동(팬) / 클릭=말하기·부품 설명
        canvas.addEventListener('contextmenu', e=>e.preventDefault());
        // ★ v1.62: 마우스가 방 안을 움직이면 눈동자가 따라간다(터치는 무시).
        canvas.addEventListener('pointermove', e=>{
          if(e.pointerType && e.pointerType !== 'mouse') return;
          const r = canvas.getBoundingClientRect();
          if(!r.width) return;
          _gazeX = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
        });
        canvas.addEventListener('pointerleave', ()=>{ _gazeX = 0; });
        let dragging=false, lastX=0, moved=0;
        bjs._userDragging=false;   // 사용자가 회전 중이면 산책을 멈춘다
        let panning=false, panX=0, panY=0;
        scene.onPointerObservable.add(p=>{
          if(p.type===BABYLON.PointerEventTypes.POINTERDOWN){
            if(p.event.button===2){ panning=true; panX=p.event.clientX; panY=p.event.clientY; }
            else { dragging=true; bjs._userDragging=true; lastX=p.event.clientX; moved=0; }
          } else if(p.type===BABYLON.PointerEventTypes.POINTERMOVE){
            if(panning){
              const dx=p.event.clientX-panX, dy=p.event.clientY-panY; panX=p.event.clientX; panY=p.event.clientY;
              const f = cam.radius*0.0016;
              cam.target.x = Math.max(-2.2, Math.min(2.2, cam.target.x - dx*f));
              cam.target.y = Math.max(-0.4, Math.min(3.2, cam.target.y + dy*f));
            } else if(dragging){
              const dx=p.event.clientX-lastX; lastX=p.event.clientX; moved+=Math.abs(dx); root.rotation.y += dx*0.012;
            }
          } else if(p.type===BABYLON.PointerEventTypes.POINTERUP){
            if(panning){ panning=false; return; } // 오른쪽 버튼 놓음 → 말하기 없음
            dragging=false; bjs._userDragging=false;
            if(moved<6){ const pick=scene.pick(scene.pointerX, scene.pointerY);
              if(pick.hit && pick.pickedMesh && pick.pickedMesh.metadata){
                const md = pick.pickedMesh.metadata;
                if(md.part){ const info=PART_INFO[md.part]||{emoji:'',desc:''}; bubble(`${info.emoji} ${md.part} — ${info.desc}`); }
                else if(md.robot){ talkToRobot(robot); }
              }
            }
          }
        });

        // ★ 2026-11-04: 기기 픽셀 비율 그대로 렌더 (레티나에서 선명하게)
        try{ engine.setHardwareScalingLevel(1 / (window.devicePixelRatio || 1)); }catch(e){}
        engine.runRenderLoop(()=>scene.render());
        window.addEventListener('resize', ()=>{ engine.resize(); try{ fitRoomCamera(); }catch(e){} });
        bjs.ready = true; bjs._starting = false;
        canvas.classList.remove('hidden'); $('#room-robot').classList.add('hidden');
        autoTuneQuality(engine, scene);   // ★ V11: 실제 FPS 를 보고 필요하면 화질을 낮춘다
        setTimeout(()=>engine.resize(), 60); // 화면 전환 후 사이즈 보정
      }catch(e){
        bjs._starting = false;
        window.__bjsError = (e && e.message) || String(e); console.error('[Babylon]', e); fallback();
      }
    });
  }catch(e){ bjs._starting = false; window.__bjsError = (e && e.message) || String(e); console.error('[Babylon]', e); fallback(); }
}

// 3D 마운트 (CDN 실패 시 SVG 폴백)
function mountRoom3D(robot){
  const canvas = $('#room3d');
  const fallback = ()=>{ bjs.ready=false; canvas.classList.add('hidden'); $('#room-robot').classList.remove('hidden');
    $('#room-robot').innerHTML = robotSVG(robot.template, robot.palette); };
  // 최초 진입일 때만 SVG 를 로딩 플레이스홀더로 먼저 보여줌 (이미 3D 살아있으면 플래시 방지)
  if(!bjs.ready){
    $('#room-robot').classList.remove('hidden'); canvas.classList.add('hidden');
    $('#room-robot').innerHTML = robotSVG(robot.template, robot.palette);
  }
  const wait = (n=0)=>{
    if(bjs.ready && bjs.scene){ rebuildRobot(robot); setTimeout(()=>bjs.engine.resize(),30); return; }
    if(window.__bjsFailed){ fallback(); return; }
    if(window.BABYLON){ startBabylon(canvas, robot, fallback); return; }
    if(n>70){ fallback(); return; } // ~7초 대기 후 폴백
    setTimeout(()=>wait(n+1), 100);
  };
  wait();
}
function renderQuests(){
  const doneIds = (state.quests.done||[]).map(Number);
  $('#quest-list').innerHTML = state.quests.list.map(q=>{
    const done = doneIds.includes(q.id);
    const title = esc(q.title);
    if(q.type==='ai_mission' && !done){
      const tp = (state.growth && state.growth.topic) || null;
      const chip = tp ? `<div class="aim-topic"> 이번 주 주제 · ${esc(tp.topic)}</div>` : '';
      return `<div class="quest-item aim">${chip}<div style="margin-bottom:6px"> ${title}</div>
        <textarea id="ai-answer" rows="2" maxlength="120" placeholder="로봇에게 이야기해주세요!"></textarea>
        <button class="btn primary" id="ai-submit" data-qid="${q.id}" style="width:100%;margin-top:6px">답하기  +${q.reward}</button></div>`;
    }
    return `<div class="quest-item ${done?'done':''}"><span>${done?'':''} ${title}</span><span> +${q.reward}</span></div>`;
  }).join('');
  const btn = $('#ai-submit');
  if(btn) btn.addEventListener('click', submitAiMission);
}
async function submitAiMission(){
  const btn = $('#ai-submit'); if(btn.disabled) return;
  const answer = ($('#ai-answer')?$('#ai-answer').value:'').trim();
  if(!answer) return alert('로봇에게 이야기를 적어주세요!');
  btn.disabled = true; btn.textContent = ' 로봇이 듣는 중...';
  try{
    const r = await api('/api/quest/answer',{answer});
    state.user.cell_balance = r.balance; setBalance(r.balance);
    state.quests.done.push(String(btn.dataset.qid)); renderQuests();
    // ★ 서버 ai 플래그가 참일 때만 «AI 생성» 크레딧을 붙인다(규칙 폴백 문장 제외).
    bubble(r.reaction, !!r.ai);
    setTimeout(()=>bubble(r.bonus? ` +${r.baseReward}셀 (부품 +${r.bonus}) = +${r.reward}셀!` : ` +${r.reward}셀 획득!`), 4500);
  }catch(e){ alert(e.message); btn.disabled=false; btn.textContent='답하기  +30'; }
}
// ★ P1-8 이중 클릭 방지: 요청 중 버튼을 잠가 LLM 을 두 번 소모하지 않게 한다
$$('.interact-row .btn, .room-dock [data-act]').forEach(b=>b.addEventListener('click', async ()=>{
  if(b.disabled) return;
  const act = b.dataset.act;
  b.disabled = true;
  try{
    const j = await api('/api/interact',{situation:act});
    // ★ 반응하기 전에 로봇이 카메라 쪽으로 걸어와야 '같이 놀는' 느낌이 난다
    walkTo([0, -0.2], 0);
    // ★ 서버가 LLM 성공 시에만 ai:true 를 준다(프리셋 대사는 ai 플래그 없음).
    //   규칙/프리셋 문장을 «AI 생성» 으로 표기하지 않게 ai 플래그를 따른다.
    bubble(j.line, !!j.ai); jumpRobot();
    // ★ P1-1 일일 한도 초과 안내
    if(j.limited) setTimeout(()=>bubble('오늘은 정말 많이 했어! 내일 또 놀자 '), 1200);
    const q = state.quests.list.find(x=>x.type===act);
    const doneIds = (state.quests.done||[]).map(Number);
    if(q && !doneIds.includes(q.id)){
      const r = await api('/api/quest/complete',{questId:q.id});
      state.user.cell_balance = r.balance; setBalance(r.balance);
      state.quests.done.push(String(q.id)); renderQuests();
      // ★ P0-2 레벨업 시 성장 알림
      if(r.growth && r.growth.leveledUp){
        SFX.levelup();
        setTimeout(()=>bubble(` 레벨 업! Lv.${r.growth.level} 달성!`), 500);
        await refreshGrowth();     // ★ V9: 단계가 바뀌면 3D 가 눈앞에서 자란다
      }
      setTimeout(()=>bubble(r.bonus? ` +${r.baseReward}셀 (부품 +${r.bonus}) = +${r.reward}셀!` : ` +${r.reward}셀 획득!`), 500);
    }
  }catch(e){ alert(e.message); }
  finally{ b.disabled = false; }
}));

// ---------- 미니게임: 반사 속도 + 기억 순서 (남은 위험 3: 난이도 커브) ----------
// 두 게임 모두 '클라이언트에서 플레이 → 서버로 성적 제출 → 서버가 보상 지급'.
// 보상 계산은 전부 서버가 하므로 클라이언트를 조작해 셀을 늘릴 수 없다.
// 12색(9단계 11칸까지 커버). 8색이었을 때 6단계에서 상한에 걸려
// 7~9단계가 같은 난이도로 반복되고, 수열 길이만 커져 클리어가 불가능해졌다.
const MEM_COLORS = ['#ff6b6b','#ffa94d','#ffe066','#63e6be','#74c0fc','#b197fc','#ffa8d5','#8ce99a','#ffc078','#a5d8ff','#d0bfff','#99e9f2'];
// ★ v5-b: 모양 12개(최대 칸 수) — 예전엔 memShow 함수 «안쪽» 에 선언돼 있었다.
//   memShow 위쪽의 팔레트 크기 계산이 MEM_SHAPES 를 이 선언 «앞» 에서 참조했기 때문에
//   TDZ(Temporal Dead Zone) 로 ReferenceError 가 나, «시작하기» 를 누르는 순간
//   게임이 통째로 죽었다. 어떤 참조 지점보다 먼저 초기화되도록 모듈 최상위로 옮긴다.
const MEM_SHAPES = ['●','▲','■','◆','★','','▶','◀','◉','△','▽',''];
const MEM_MAX_LEVEL = 9;   // 클리어 가능한 최종 단계(서버 보상 상한과 동일)
let _rxTimer = null, _rxNext = null, _mmTimer = null;
function closeGame(id){
  clearTimeout(_rxTimer); clearTimeout(_rxNext); clearTimeout(_mmTimer);
  _rxTimer = _rxNext = _mmTimer = null;
  // ★ 닫을 때 게임 상태도 반드시 초기화한다.
  //   rx.running 이 true 로 남으면 다음에 다시 열었을 때
  //   "진행 중" 인 척하며 타이머만 도는 유령 상태가 된다.
  rx.running = false; mm.running = false;
  // ★ 2026-10-27: 슈터는 rAF 루프라 닫을 때 반드시 취소한다.
  if(id==='game-shooter') stopShooter();
  // ★ 2026-10-28: 두더지도 interval 을 반드시 정리한다.
  if(id==='game-mole') stopMole();
  // ★ v1.41: 고장 탐정은 interval(전체 시계) + setTimeout(관찰/다음 기계) 두 종류를 쓴다.
  //   창을 중간에 닫아도 타이머가 살아 있으면 «유령 판» 이 계속 점수를 만든다.
  if(id==='game-repair') rpStop();
  // ★ v1.46: 꾹 누르기 interval 이 창을 닫아도 살아 있으면 «유령 충전» 이 돈다.
  // ★ v1.48: 도전 모드 시계까지 함께 멈춘다(닫았는데 시간이 흐르면 기록이 망가진다).
  if(id==='game-sort') sortHalt();
  // ★ 2026-11-21 (v1.71): 안개 속의 탑 — «다음 층» 예약 타이머를 정리한다.
  //   답을 고른 뒤 0.8s/1.5s 뒤에 화면을 넘기는 setTimeout 이 창 닫힘 뒤에도 살아 있으면
  //   감춰진 모달 안에서 혼자 다음 층을 그리는 «유령 탑» 이 된다.
  //   세션(_tw)도 함께 지운다 — 진행 중 요청이 늦게 도착해도 아무것도 그리지 않게.
  if(id==='game-tower'){ twClearTimers(); _tw = null; }
  // ★ 2026-10-29: 친구 채팅 폴링 정리 + 읽음 배지 갱신
  if(id==='friend-chat'){ stopFriendChat(); loadFriends(); }
  // 버튼 복구(다음 실행에서 '계속하기' 등으로 굳지 않도록)
  const rg = $('#reflex-go'); if(rg){ rg.disabled = false; }
  const mg = $('#memory-go'); if(mg){ mg.disabled = false; }
  $('#'+id).classList.add('hidden');
  // ★ 2026-11-21 (v1.74) C2: «자연스러운 마무리 지점» — 게임/퀴즈/타탑 창을 닫는 행위.
  //   pendingLock(4분 유예) 중이면 바로 여기서 잠근다. 아니면 아무 일도 없다.
  notifyNaturalBreak();
}
// 공통: 게임 결과 제출 + 보상 안내
// ★ 어떤 경우에도 버튼이 '제출 중' 으로 굳지 않도록 finally 에서 반드시 복구한다.
//   (예전에는 catch 에서 bubble 만 띄우고 버튼을 돌려주지 않아 화면이 영구히 멈췄다)
// ── v1.37 «대세계 의뢰» 브리지: 세계 → 게임 → 세계 ──
const QUEST_KIND = { well:'mole', mill:'shooter', bell:'puzzle' };
try{ state.quest = JSON.parse(sessionStorage.getItem('roomi_quest') || 'null'); }
catch(e){ state.quest = null; }

function startWorldQuest(key){
  if(!QUEST_KIND[key]) return;
  state.quest = { key, startedAt: Date.now() };
  try{ sessionStorage.setItem('roomi_quest', JSON.stringify(state.quest)); }catch(e){ }
  if(window.World && window.World.close) window.World.close();
  // closeWorld() 가 씬을 dispose 할 시간을 0.18초 벌어준다
  setTimeout(()=>{
    if(key === 'well') openMole();
    else if(key === 'mill') openShooter();
    else openPuzzle();
  }, 180);
}
window.startWorldQuest = startWorldQuest;

async function tryClaimQuest(payload){
  const q = state.quest;
  if(!q || !q.key || QUEST_KIND[q.key] !== payload.kind) return;
  try{
    const r = await api('/api/world/quest/claim', {
      quest:q.key,
      score:Number(payload.score) || 0,
      lives:Number(payload.lives) || 0,
      firstTry:Number(payload.firstTry) || 0
    }, 10000);
    if(r && r.ok && !r.already){
      toast(r.reward ? `🛠 의뢰 완료! +${r.reward}셀` : '🛠 의뢰 완료!');
      state.quest = null;
      try{ sessionStorage.removeItem('roomi_quest'); }catch(e){ }
      if(window.World && window.World.refresh) window.World.refresh();
    } else if(r && r.ok === false && r.need){
      toast(`아쉬워! ${r.need} 까지 조금만 더!`);
    }
  }catch(e){ /* 네트워크 실패는 조용히 — 의뢰는 유지되어 다시 도전할 수 있다 */ }
}

async function submitGameResult(kind, payload, btn){
  const btnRef = btn || null;
  try{
    // 서버가 LLM 을 거치지 않더라도 응답이 늦을 수 있으므로 12초_TIMEOUT 을 건다
    const r = await api('/api/game/result', Object.assign({ kind }, payload), 12000);
    state.user.cell_balance = r.balance; setBalance(r.balance);
    if(r.growth) state.growth = { ...state.growth, ...r.growth, partBonus: state.growth.partBonus||0 };
    await refreshGrowth();     // ★ V9: 단계가 바뀌면 3D 가 눈앞에서 자란다
    const detail = r.ms != null ? `${r.ms}ms`
                 : (r.level != null ? `${r.level}단계`
                 : (r.score != null ? `${r.score}점` : '완료'));
    const stageMap = { reaction:'#reflex-stage', memory:'#memory-stage', shooter:'#sh-overlay', puzzle:'#pz-hint', mole:'#mole-overlay', repair:'#repair-result' };
    const modalMap = { reaction:'game-reflex', memory:'game-memory', shooter:'game-shooter', puzzle:'game-puzzle', mole:'game-mole', repair:'game-repair' };
    const stage = $(stageMap[kind] || '#reflex-stage');
    if(stage) stage.innerHTML = `🎉 보상 받음!<br>+${r.reward}셀 · +${r.growth.exp}XP`;
    bubble(`${r.label} ${detail}! +${r.reward}셀 +${r.growth.exp}XP`);
    // 1.6초 뒤에 창을 스스로 닫아 다음 판으로 이어지게 한다
    setTimeout(()=>{
      closeGame(modalMap[kind] || 'game-reflex');
      if(state.robot) renderMyroom();
    }, 1600);
  }catch(e){
    // 실패: 사유를 화면에 분명히 남기고 버튼을 되살린다(재시도 가능)
    const stageMap = { reaction:'#reflex-stage', memory:'#memory-stage', shooter:'#sh-overlay', puzzle:'#pz-hint', mole:'#mole-overlay', repair:'#repair-result' };
    const stage = $(stageMap[kind] || '#reflex-stage');
    if(stage) stage.innerHTML = `<span style="color:#c92a2a">${esc(e.message)}</span>`;
    bubble(e.message);
    if(btnRef){
      btnRef.disabled = false;
      btnRef.textContent = kind==='reaction' ? '다시 시작' : '다시 시작';
    }
    const other = kind==='reaction' ? $('#memory-go') : $('#reflex-go');
    if(other) other.disabled = false;
  }finally{
    // ★ v1.37: 오늘 이미 이 게임 보상을 받았으면 /api/game/result 가 400 이지만,
    //   «두 번째 판» 에서 의뢰 조건을 달성할 수 있다. 판정은 try 가 아니라 finally.
    if(state.quest) await tryClaimQuest(Object.assign({ kind }, payload));
  }
}
// ── 반사 속도 ──
const rx = { tries:0, best:null, armedAt:0, running:false, skipped:0 };
function openReflex(){
  rx.tries = 0; rx.best = null; rx.running = false; rx.skipped = 0;
  clearTimeout(_rxNext); _rxNext = null;
  $('#reflex-tries').textContent = '시도 0/3';
  $('#reflex-best').textContent = '';
  $('#reflex-stage').textContent = '초록불이 되면 아래 버튼을 눌러요!';
  $('#reflex-stage').className = 'game-stage';
  $('#reflex-go').textContent = '시작하기';
  $('#reflex-go').disabled = false;
  $('#game-reflex').classList.remove('hidden');
}
function reflexArm(){
  const stage = $('#reflex-stage'), btn = $('#reflex-go');
  clearTimeout(_rxNext); _rxNext = null;   // 예약된 다음 판이 있으면 취소(중복 발동 방지)
  stage.className = 'game-stage wait'; stage.textContent = '빨간불… 기다려요!';
  btn.textContent = '기다리는 중…';
  const delay = 1200 + Math.random()*3200;
  _rxTimer = setTimeout(()=>{
    stage.className = 'game-stage go'; stage.textContent = ' 지금!';
    rx.armedAt = performance.now();
    btn.textContent = '지금 누르기!';
  }, delay);
}
// 반사 속도 종료 처리(유효 기록이 있을 때만 서버에 제출)
// 세 판을 모두 실수/이동으로 흘렸다면 best 가 null 이므로 제출하지 않고 되돌린다.
function finishReflex(){
  const stage = $('#reflex-stage'), btn = $('#reflex-go');
  rx.running = false;
  clearTimeout(_rxNext); _rxNext = null;
  btn.disabled = false; btn.textContent = '시작하기';
  if(rx.best == null){
    stage.className = 'game-stage';
    stage.textContent = '아이번엔 한 번도 성공하지 못했어요  다시 도전해 볼래요?';
    return;
  }
  btn.disabled = true; btn.textContent = '결과 제출 중...';
  stage.className = 'game-stage';
  stage.textContent = `최고 기록 ${rx.best}ms!`;
  submitGameResult('reaction', { ms: rx.best }, btn);
}
function reflexClick(){
  if(!rx.running) return;
  const stage = $('#reflex-stage'), btn = $('#reflex-go');
  if(stage.classList.contains('wait')){          // 빨간불에 눌림 = 실수
    SFX.wrong();
    clearTimeout(_rxTimer);
    // ★ 실수도 한 판만 버리고 다음 판으로 진행(게임 전체를 초기화하지 않는다)
    stage.className = 'game-stage next';
    stage.textContent = '아직 빨간불이야!  이 판은 넘어갈게요';
    rx.skipped++; rx.tries++; $('#reflex-tries').textContent = `시도 ${rx.tries}/3`;
    btn.textContent = '계속하기'; btn.disabled = false;
    if(rx.tries>= 3){ finishReflex(); return; }
    _rxNext = setTimeout(()=>{ if(rx.running) reflexArm(); }, 1000);
    return;
  }
  if(!stage.classList.contains('go')) return;
  const ms = Math.round(performance.now() - rx.armedAt);
  // 방어: 비정상적으로 큰 값(비보호 상태에서의 클릭 등)은 기록하지 않는다.
  // 서버도 99999ms 상한과 '너무 빨랐어' 하한 검증을 함께 쓰므로 이중 안전장치다.
  // ★ 이때 게임을 끝내지 않는다 — 한 판만 건너뛰고 다음 판으로 진행시킨다.
  //   (이전처럼 rx.running=false 로 두면 시도 횟수까지 초기화되어 아이가 좌절한다)
  if(ms <0 || ms> 9000){
    stage.className = 'game-stage next';
    stage.textContent = '아까 누른 것 같아! 이 판은 넘어갈게요';
    rx.skipped++; rx.tries++; $('#reflex-tries').textContent = `시도 ${rx.tries}/3`;
    btn.textContent = '계속하기'; btn.disabled = false;
    if(rx.tries>= 3){ finishReflex(); return; }
    _rxNext = setTimeout(()=>{ if(rx.running) reflexArm(); }, 1000);
    return;
  }
  rx.tries++;
  $('#reflex-tries').textContent = `시도 ${rx.tries}/3`;
  if(rx.best == null || ms <rx.best){ rx.best = ms; $('#reflex-best').textContent = `최고 ${ms}ms`; }
  if(rx.tries>= 3){
    finishReflex();
    return;
  }else{
    // ★ 이전 버전의 버그: 여기서 stage 에 'go' 클래스를 제거한 뒤
    //   rx.running 을 true 로 남겨 두었는데, '계속하기' 를 누르면
    //   reflexClick() 이 'go' 가 아니라는 이유로 즉시 return 하여
    //   버튼이 완전히 죽었다(아무 반응 없음).
    //   해결: 잠시 결과를 보여준 뒤 다음 판을 자동으로 시작하고,
    //   '계속하기' 버튼은 그 대기 중 눌러 즉시 다음 판을 진행시킨다.
    stage.className = 'game-stage next';
    stage.textContent = `${ms}ms! ${1000}ms 후에 다음 판…`;
    btn.textContent = '계속하기'; btn.disabled = false;
    _rxNext = setTimeout(()=>{ if(rx.running) reflexArm(); }, 1000);
  }
}
// ── 기억 순서 ──
// ★ 1단계부터 '기억할 만한' 개수(3개)로 시작해야 한다.
//   1개만 보여주면 기억 게임이 아니라 운 게임이 되어 게임이 성립하지 않는다.
const MEM_BASE_PAD = 2;      // 단계 1 에 보여줄 개수 = 1 + 2 = 3
const MEM_SHOW_MS  = 700;     // 칸 하나를 보여주는 시간(너무 짧으면 따라갈 수 없다)
const mm = { seq:[], input:[], colorOf:[], level:1, running:false };
function openMemory(){
  mm.level = 1; mm.seq = []; mm.input = []; mm.running = false;
  $('#memory-level').textContent = '단계 1';
  $('#memory-best').textContent = '';
  $('#memory-stage').className = 'game-stage seq';
  $('#memory-stage').textContent = '준비...';
  $('#memory-go').textContent = '시작하기';
  $('#memory-go').disabled = false;
  $('#game-memory').classList.remove('hidden');
}
function memShow(){
  const stage = $('#memory-stage');
  // ★ 칸 수는 팔레트 크기를 넘을 수 없다.
  //   show 가 팔레트보다 크면 화면에는 8칸만 나오는데
  //   수열에는 8번 인덱스까지 들어가고, 그 칸은 존재하지 않아
  //   영영 꺼지지 않는다 → 7단계부터 수학적으로 클리어 불가(실측 확인된 버그).
  // ★ 칸 수는 (색 수, 모양 수) 둘 다 넘을 수 없다.
  //   색/모양 중 하나라도 부족하면 구별이 불가능해진다(색각 보조가 무의미해짐).
  const show = Math.min(MEM_COLORS.length, MEM_SHAPES.length, mm.level + MEM_BASE_PAD);
  // ★ 아래 두 가지가 치명적이었다:
  //   (a) 수열이 0,1,2 오름차순 고정 → 아이가 '왼쪽부터 차례로' 누르면 끝
  //   (b) 모든 칸을 한 번에 칠함 → '차례대로 켜지는' 동작 자체가 없음
  //   → 기억 게임이 아니었다.
  // 이제: 칸마다 서로 다른 색을 섞어 배정하고, 0..show-1 을 임의 순서로 섞은 뒤
  //       한 칸씩 MEM_SHOW_MS 동안 켜고 다음 칸으로 넘어간다.
  const palette = MEM_COLORS.slice(0, show);
  for(let i=palette.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [palette[i],palette[j]]=[palette[j],palette[i]];
  }
  mm.colorOf = palette;
  mm.seq = [];
  for(let i=0;i<show;i++) mm.seq.push(i);
  for(let i=mm.seq.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [mm.seq[i],mm.seq[j]]=[mm.seq[j],mm.seq[i]];
  }
  // ★ V5: 색각 보조(색만으로 구분할 때 필요한 도형 단서).
//   색만 구분하면 적록색약이 있는 아이(남학생 약 8%)는 이 게임을 못 한다.
//   그래서 각 칸에 '모양'을 함께 입힌다. 색 + 모양 이중 단서이므로
//   어느 한쪽을 못 알아도 나머지로 구별할 수 있다.
//   (모양은 유니코드 기호 문자열 — 이미지 에셋 없이 CSS 없이 동작한다)
// ★ V5-b: 모양은 '칸 수'보다 적으면 안 된다.
//   예전엔 8개짜리 배열을 % 8 로 돌려 써서, 7단계(9칸)부터 ●가 두 번 등장했다.
//   색각 보조의 목적이 '색 못 보는 아이가 구분하는 것' 인데,
//   같은 모양이 겹치면 그 아이에게 오히려 더 혼란 → 접근성 기능이 무의미해진다.
//   그래서 12개(최대 칸 수)를 확보하고, 그래도 부족하면 칸 수 자체를 줄인다.
//   (MEM_SHAPES 는 모듈 최상위에서 선언 — 이 함수 안에 두면 위쪽 참조가 TDZ 에 걸린다)
  // 칸마다 서로 다른 모양 배정(색과 같은 방식으로 섞는다)
  mm.shapeOf = mm.colorOf.map((_, i)=>MEM_SHAPES[i % MEM_SHAPES.length]);
  // 각 칸 안에 모양 span 을 넣는다. 'showing' 동안만 보이며, 입력 단계에서는 숨겨진다
  // → 아이가 '몇 번째 칸인지' 를 위치로 외우는 것을 막는다.
  stage.innerHTML = mm.colorOf.map((c,i)=>
    `<i class="pad"><b class="sym">${mm.shapeOf[i]}</b></i>`).join('');
  stage.classList.remove('input');
  stage.classList.add('showing');
  $('#memory-level').textContent = `단계 ${mm.level} · ${show}칸`;
  const pads = [...stage.querySelectorAll('.pad')];
  let k = 0;
  const step = ()=>{
    if(k> 0){ const prev = pads[mm.seq[k-1]]; if(prev){ prev.style.background = ''; prev.classList.remove('lit'); } }
    if(k>= mm.seq.length){
      stage.classList.remove('showing');
      stage.classList.add('input');
      mm.input = [];
      return;
    }
    const cur = pads[mm.seq[k]];
    if(cur){ cur.style.background = mm.colorOf[mm.seq[k]]; cur.classList.add('lit'); }
    k++;
    _mmTimer = setTimeout(step, MEM_SHOW_MS);
  };
  _mmTimer = setTimeout(step, MEM_SHOW_MS);
}
function memPick(i){
  if(!mm.running) return;
  const stage = $('#memory-stage');
  if(stage.classList.contains('showing')) return;    // 보여주는 중엔 입력 불가
  // ★ 이미 이번 판을 다 맞힌 상태면 더 받지 않는다.
  //   정답 후 620ms 안에 연타하면 mm.input 이 길어져
  //   mm.seq[나머지] === undefined 비교가 항상 실패 → 방금 이긴 판이 실패로 바뀐다.
  //   아이들은 연타가 많으므로 반드시 막아야 한다.
  if(mm.input.length>= mm.seq.length) return;
  const pads = stage.querySelectorAll('.pad');
  // V5: 클릭한 칸은 색뿐 아니라 모양도 함께 보여준다(색각 보조)
  if(pads[i]){ pads[i].style.background = mm.colorOf[i]; pads[i].classList.add('lit'); }
  mm.input.push(i);
  const n = mm.input.length;
  // 즉시 판정(위치와 위치 비교 → 값 범위가 일치하므로 반드시 성립한다)
  if(mm.input[n-1] !== mm.seq[n-1]){ memFail(n-1); return; }
  if(n === mm.seq.length){
    // 다음 판이 시작되기 전에 입력을 비운다(연타 대비)
    mm.input = [];
    mm.level++;
    if(mm.level>= MEM_MAX_LEVEL){
      mm.running = false;
      stage.classList.remove('input');
      stage.innerHTML = ' 완성!';
      $('#memory-level').textContent = `${MEM_MAX_LEVEL}단계 도달!`;
      $('#memory-go').textContent = '결과 제출 중...'; $('#memory-go').disabled = true;
      submitGameResult('memory', { level: MEM_MAX_LEVEL }, $('#memory-go'));
      return;
    }
    $('#memory-level').textContent = `단계 ${mm.level}`;
    setTimeout(memShow, 620);
  }
}
function memFail(i){
  SFX.wrong();
  mm.running = false;
  const stage = $('#memory-stage');
  stage.classList.add('input');
  stage.classList.remove('showing');
  const pads = stage.querySelectorAll('.pad');
  if(pads[i]) pads[i].style.background = '#ff8787';
  // ★ 정답을 함께 보여준다 — '틀렸다' 만으로는 아이가 배우지 못한다.
  //   틀린 칸은 빨강 테두리, 나머지는 실제 색으로 잠깐 공개해 주어 답을 기억하게 한다.
  //   V5: 모양도 함께 표시(색 못 보는 아이가 '기억한 순서' 를 확인하게 해준다)
  const answer = mm.seq.map((_, k)=>
    `<i class="pad${k===i?' wrong':''} lit" style="background:${mm.colorOf[k]}"><b class="sym">${mm.shapeOf[k]||''}</b></i>`).join('');
  stage.innerHTML = answer +
    `<div class="fail">앗! ${i+1}번째부터 달라요 <br>` +
    `도달 단계 ${mm.level} · 다음에 다시 도전해 볼래요?</div>`;
  $('#memory-go').textContent = '다시 도전'; $('#memory-go').disabled = false;
  if(mm.level>= 3) submitGameResult('memory', { level: mm.level }, $('#memory-go'));
}

// 미니게임 버튼 연결
$("#btn-shooter")?.addEventListener("click", openShooter);
$("#btn-puzzle")?.addEventListener("click", openPuzzle);
$("#reflex-go").addEventListener("click", ()=>{
  const stage = $('#reflex-stage'), btn = $('#reflex-go');
  if(!rx.running){
    // 게임 시작(또는 '아직 빨간불'/'기록 이상' 후 재시작)
    rx.running = true; rx.tries = 0;
    $('#reflex-tries').textContent = '시도 0/3';
    btn.textContent = '지금 누르기!';
    reflexArm();
    return;
  }
  // 다음 판 대기 중이면 예약된 타이머를 취소하고 즉시 시작한다
  if(stage.classList.contains('next')){
    clearTimeout(_rxNext); _rxNext = null;
    btn.textContent = '지금 누르기!';
    reflexArm();
    return;
  }
  reflexClick();
});
$("#memory-go").addEventListener("click", ()=>{
  if(!mm.running){ mm.running=true; mm.level=1; $("#memory-level").textContent="단계 1"; memShow(); }
  else { mm.running=false; $("#memory-go").textContent="시작하기"; $("#memory-go").disabled=false; memShow(); }
});
// 반사 속도: 스테이지 클릭으로도 눌러볼 수 있게 한다(버튼만 보면 못 알아듣는 아이용)
$('#reflex-stage').addEventListener('click', ()=>{ if(!$('#reflex-go').disabled) $('#reflex-go').click(); });
// 기억 게임 패드 클릭 위임
$("#memory-stage").addEventListener("click", (e)=>{
  const pad = e.target.closest(".pad"); if(!pad) return;
  const all = [...$("#memory-stage").querySelectorAll(".pad")];
  memPick(all.indexOf(pad));
});
// 부모 승인 게이트 버튼 (P0-4)
$("#gate-ok").addEventListener("click", verifyParent);
$("#gate-a").addEventListener("keydown", e=>{ if(e.key==="Enter"){ e.preventDefault(); verifyParent(); } });
$("#overplay-parent").addEventListener("click", openParentGate);
$("#overplay-ok").addEventListener("click", ()=>{
  // 오늘은 여기서 끝내되, 데이터는 지우지 않는다(내일 이어서 놀 수 있게)
  stopPlayTimer();
  state.overplayDismissed = true;
  state.overLimit = true;
  $('#overplay').classList.add('hidden');
  show('start');
});
// 닫기 버튼 + ESC
// ★ 반드시 쿼리SelectorAll 을 써야 한다. querySelector 는 첫 요소 하나만
//   반환하므로 .forEach 에서 TypeError 가 나고 바인딩이 아예 실행되지 않아
//   두 게임의 닫기 버튼이 모두 먹통이 된다.
$$("[data-close]").forEach(b=>b.addEventListener("click", ()=>closeGame(b.dataset.close)));
// 안전망: 모달 배경(바깥 영역)을 클릭해도 닫히도록 — ✕ 를 못 찾거나 못 눌러도 탈출 가능
$$('.modal').forEach(m=>{
  // ★ #overplay(하루 40분 사용 종료 잠금) 는 배경 클릭으로 닫히면 안 된다.
  //   아이가 바깥을 한 번 눌러 잠금을 우회하면, 그 뒤로 사용 시간 보고도 멈춘다.
  if(m.id === 'preview-modal' || m.id === 'modal' || m.id === 'overplay') return;   // 기존 모달은 별도 처리
  m.addEventListener('click', e=>{ if(e.target === m) closeGame(m.id); });
});
document.addEventListener("keydown", e=>{ if(e.key==="Escape"){ closeGame("game-reflex"); closeGame("game-memory"); closeGame("game-shooter"); closeGame("game-puzzle"); closeGame("game-tower"); closeGame("game-mole"); closeGame("game-repair"); closeGame("game-sort"); } });
// ---------- 상점 ----------
const ITEM_KIND = { part:'로봇 부품', decor:'방 장식', skin:'색칠 스킨', shard:'부품 조각' };
async function loadShop(){
  // ★ 네트워크 실패 시 조용한 빈 화면 + unhandled rejection 이 남지 않게 한다.
  // ★ 2026-11-20 (v1.72): await 동안 스켈레톤 → 실패하면 «놀란 루미» 빈 화면으로 바꿔 준다.
  fillSkeleton($('#shop-list'), 4);
  let allItems;
  try{ allItems = await api('/api/items'); }
  catch(e){
    // ★ 2026-11-21 (v1.74) C4: «다시 시도» 버튼이 붙은 빈 화면 — 자기 자신을 재호출한다.
    $('#shop-list').innerHTML = emptyState('oops', e.message || '상점을 불러오지 못했어요. 잠시 후 다시 시도해 줄래?', ()=>loadShop());
    return;
  }
  const items = state.shopFilter === 'all' ? allItems : allItems.filter(it=>it.type === state.shopFilter);
  // 등급: 가격대별 표시(아이에게 "레벨"처럼 보이게) + 보유 여부 배지
  const tier = p => p>=100 ? { label:'EPIC', cls:'t-epic' } : p>=70 ? { label:'RARE', cls:'t-rare' } : { label:'NORMAL', cls:'t-normal' };
  // ★ 2026-11-20 (v1.72): 필터 결과가 비면 «생각 중인 루미» 빈 화면 — 글자만 있는 빈 칸 대신
  $('#shop-list').innerHTML = items.length ? items.map(it=>{
    const t = tier(it.price);
    // ★ P1-4 소비 가능 아이템(skin/shard)은 반복 구매 가능 → '보유 중' 으로 잠그지 않는다
    const repeatable = !!it.consumable;
    const owned = !repeatable && (state.parts.includes(it.name) || state.decors.includes(it.name));
    const kind = ITEM_KIND[it.type] || '아이템';
    // ★ V11 주말 한정: 오늘이 판매일이 아니면 '잠금' 상태로 보여준다.
    //   숨기지 않고 보여줘야 "주말에 다시 오자"는 예고가 된다.
    const locked = it.available === false;
    // ★ v1.64: «한정 D-N»(기간 한정) 과 «주말 한정» 을 구분해서 보여준다.
    const ended = locked && it.limited === 'time';
    const timeLeft = it.limited === 'time' && !ended ? `한정 D-${it.remainingDays}` : '';
    // ★ v1.65: 이번 주 특가(8할) — 서버가 고른 2개. 원가와 함께 보여준다.
    const weekly = !!it.weekly && !ended;
    const weeklyBadge = weekly ? `<span class="owned-badge weekly">이번 주 특가 D-${it.weeklyDays}</span>` : '';
    const badge = ended ? '<span class="owned-badge weekend">판매 종료</span>'
      : (weeklyBadge || (timeLeft ? `<span class="owned-badge time">${timeLeft}</span>`
      : (locked ? '<span class="owned-badge weekend">주말 한정</span>'
      : (repeatable ? '<span class="owned-badge repeat">반복 구매 가능</span>' : ''))));
    return `<div class="item-card ${t.cls}${owned?' owned':''}${locked?' locked':''}">
      <div class="em">${ITEM_EMOJI[it.name]||''}</div>
      ${owned?'<span class="owned-badge">보유 </span>':''}
      ${badge}
      <span class="tier ${t.cls}">${t.label}</span>
      <div class="nm">${esc(it.name)}</div>
      <div class="kind">${esc(kind)}</div>
      <div class="price"> ${weekly ? it.weeklyPrice : it.price}${weekly ? ` <s>${it.price}</s>` : ''}</div>
      ${ended?'<div class="lock-hint">판매가 끝났어요</div>':(locked?'<div class="lock-hint">토·일요일에만 살 수 있어요</div>':'')}
      <div class="btn-row">
        ${(it.type==='skin'||it.type==='shard'||locked)?'':`<button class="btn ghost" data-preview="${it.id}">미리보기</button>`}
        <button class="btn primary" data-buy="${it.id}" ${(owned||locked)?'disabled':''}>${ended?'판매 종료':(locked?'주말 한정':(owned?'보유 중':'구매'))}</button>
      </div></div>`;
  }).join('') : emptyState('think', '이 칸에는 아직 상품이 없어요. 다른 칸도 구경해 볼래?');
  $$('#shop-list [data-buy]').forEach(b=>b.addEventListener('click', async ()=>{
    // ★ 진행 중 방어(V2-10): 소지품은 서버가 409 로 막지만
    //   소비품(skin/shard)은 연속 클릭이 그대로 두 번 결제된다.
    if(b.disabled) return;
    b.disabled = true;
    const old = b.textContent;
    b.textContent = '구매 중…';
    try{ await buyItem(b.dataset.buy); }
    catch(e){ alert(e.message); }
    finally{ b.disabled = false; b.textContent = old; }
  }));
  $$('#shop-list [data-preview]').forEach(b=>b.addEventListener('click', ()=>{
    const it = items.find(x=>x.id==b.dataset.preview); if(it) openPreview(it);
  }));
  await loadShardTargets();   // 교환 목표(부품별 필요 조각 수) 로드
  renderOwned();   // 하단 '내 부품함' 갱신
}
// 구매 공통 처리 (상점 + 미리보기에서 재사용)
async function buyItem(itemId){
  const r = await api('/api/shop/buy',{itemId});
  state.user.cell_balance = r.balance; setBalance(r.balance);
  // ★ P0-1 장식/스킨도 즉시 상태에 반영(마이룸 '보유 장식' 목록이 곧바로 갱신되도록)
  try{
    const jr = await api('/api/robots/me');
    const beforeDecors = (state.decors||[]).join(',');
    const beforeSkins  = (state.skins||[]).join(',');
    absorbRobotMe(jr);
    const decorChanged = beforeDecors !== (state.decors||[]).join(',');
    // ★ 스킨은 effectiveColors 를 통해 로봇 색에 반영된다 → 재빌드 대상
    const skinChanged  = beforeSkins  !== (state.skins||[]).join(',');
    if(bjs.ready && state.robot){
      // 장식은 방(소품) 레벨 오브젝트라 로봇만 갱신하면 안 된다 → 방 장식만 재배치
      if(decorChanged) rebuildRoomDecor();
      if(decorChanged || skinChanged) rebuildRobot(state.robot);
    }
    // ★ V9: 부품을 사면 과제 보너스가 오른다 → 수치를 다시 읽어 배지에 즉시 반영
    await refreshGrowth();
    if($('#screen-myroom') && !$('#screen-myroom').classList.contains('hidden')) renderMyroom();
    renderOwned();   // 구매 즉시 '내 부품함' 갱신
    if($('#screen-shop') && !$('#screen-shop').classList.contains('hidden')) loadShop();
  }catch(e){}
  return r;
}

// ---------- 부품 미리보기 (mini 3D) ----------
let previewEngine = null;
function closePreview(){
  $('#preview-modal').classList.add('hidden');
  if(previewEngine){ previewEngine.dispose(); previewEngine=null; }
}
function openPreview(item){
  const robot = state.robot || { template:'doro', palette:{} };
  const info = PART_INFO[item.name];
  $('#preview-title').textContent = `${ITEM_EMOJI[item.name]||''} ${item.name}`;
  $('#preview-desc').textContent = info ? info.desc : (item.type==='decor' ? '방을 꾸미는 장식품이에요.' : '');
  const owned = state.parts.includes(item.name);
  const buy = $('#preview-buy');
  buy.dataset.buy = item.id;
  if(owned){ buy.textContent='보유 중 '; buy.disabled=true; }
  else { buy.textContent=`구매하기  ${item.price}`; buy.disabled=false; }
  $('#preview-modal').classList.remove('hidden');
  // 장식은 로봇 없이 상품만 크게 전시(무엇을 사는지 명확히)
  const solo = item.type==='decor';
  setTimeout(()=>{
    // ★ 60ms 안에 모달을 닫았다면 그리기를 중단한다. 예전엔 닫힌 뒤에도
    //   Engine 을 새로 만들어 렌더 루프가 계속 도는(누수) 경합이 있었다.
    if($('#preview-modal').classList.contains('hidden')) return;
    try{ buildPreviewScene($('#preview-canvas'), robot, [item.name], solo); }catch(e){ console.error('[preview]', e); }
  }, 60);
}
function buildPreviewScene(canvas, robot, parts, solo){
  if(previewEngine){ previewEngine.dispose(); previewEngine=null; }
  const engine = new BABYLON.Engine(canvas, true, {preserveDrawingBuffer:true, adaptToDeviceRatio:true});
  previewEngine = engine;
  const scene = new BABYLON.Scene(engine);
  scene.clearColor = new BABYLON.Color4(0.995,0.960,0.932,1);
  const cam = new BABYLON.ArcRotateCamera('pcam', Math.PI/2, Math.PI/2.6, 6.5, new BABYLON.Vector3(0,1.3,0), scene);
  cam.lowerRadiusLimit=4.5; cam.upperRadiusLimit=10;
  if(solo){ cam.radius = 3.2; cam.beta = Math.PI/3.1; cam.lowerRadiusLimit = 1.8; cam.upperRadiusLimit = 6.5; }
  const { dir, hemi } = createRoomBase(scene, solo
    ? { props:false, dust:false, bare:true }     // 장식 단독 전시: 벽·러그 없이 깔끔한 배경
    : { props:false, dust:false });              // 부품: 방 골격 유지(착용감)
  const root = new BABYLON.TransformNode('proot', scene);
  const bob = new BABYLON.TransformNode('pbob', scene); bob.parent=root;
  // solo(장식)에서는 model 을 bob 아래에 두지 않고 root 직속에 붙인다
  // → 상품이 원점에서 떨어져 있어도 root 회전 시 공전하지 않음
  const model = new BABYLON.TransformNode('pmodel', scene); model.parent = solo ? root : bob;
  tryLoadEnvironment(scene).then(ok=>{
    if(previewEngine !== engine) return; // 닫힌 후 늦게 도착 → 무시
    const factory = makeMatFactory(scene, ok);
    if(ok){ hemi.intensity = 0.3; dir.intensity = 0.6; }
    try{
      const pipe = new BABYLON.DefaultRenderingPipeline('ppr', true, scene, [cam]);
      pipe.fxaaEnabled = true;
      pipe.imageProcessing.toneMappingEnabled = false;   // 색 왜곡 방지
      pipe.imageProcessing.exposure = 1.0; pipe.imageProcessing.contrast = 1.0;
    }catch(e){ new BABYLON.FxaaPostProcess('fxaa', 1.0, cam); }
    const refs = buildRobotModel(scene, model, effectiveColors(robot.template, robot.palette), robot.template, parts, factory, curStage());
    // solo(장식): 로봇 몸통·얼굴을 숨기고 부품만 남겨 상품에 집중
    const shown = [];
    model.getChildMeshes(false).forEach(m=>{
      const isPart = !!(m.metadata && m.metadata.part);
      m.isVisible = solo ? isPart : true;
      if(solo && isPart) shown.push(m);
    });
    if(solo && shown.length){
      // 부품별로 좌표가 박혀 있으므로, 로컬 좌표를 직접 보정해 원점 기준으로 recenter
      // (월드 행렬이 아직 갱신되지 않았으므로 position 값을 그대로 계산한다)
      let mnx=1e9,mnz=1e9,mny=1e9,mxx=-1e9,mxz=-1e9,mxy=-1e9;
      shown.forEach(m=>{
        const bi=m.getBoundingInfo().boundingBox;
        // 로컬 위치 + 로컬 반경(월드 스케일 1 가정)으로 대략적인 로컬 경계 계산
        const ext=bi.maximum.subtract(bi.minimum);
        mnx=Math.min(mnx,m.position.x-ext.x); mxx=Math.max(mxx,m.position.x+ext.x);
        mny=Math.min(mny,m.position.y-ext.y); mxy=Math.max(mxy,m.position.y+ext.y);
        mnz=Math.min(mnz,m.position.z-ext.z); mxz=Math.max(mxz,m.position.z+ext.z);
      });
      const ox=(mnx+mxx)/2, oz=(mnz+mxz)/2;
      const rad=Math.max(0.42, Math.max(mxx-mnx, mxy-mny, mxz-mnz)/2);
      // 원점 recenter + 바닥 장식은 받침대 위(y=0.1)로
      // 공중 장식(별)은 떠 있는 상품 → 받침대 숨김
      const isFloat = shown.some(m=>m.name.indexOf('star')===0);
      const ped = scene.getMeshByName('pedestal');
      if(isFloat && ped) ped.setEnabled(false);
      let lift = 0;
      if(mny <0.3) lift = 0.1 - mny;              // 바닥 장식 → 받침대 위
      else if(mny> 0.6) lift = 0.42 - mny;          // 공중 장식(별) → 눈높이 중앙
      shown.forEach(m=>{ m.position.x -= ox; m.position.z -= oz; m.position.y += lift; });
      // 별 스티커는 납작한 다면체라 recenter 후 옆면이 카메라를 향할 수 있다 → 정면으로 회전
      const cy = (mny+mxy)/2 + lift;
      cam.setTarget(new BABYLON.Vector3(0, cy, 0));
      cam.radius = rad*4.6 + 1.0;
      cam.lowerRadiusLimit = cam.radius*0.5; cam.upperRadiusLimit = cam.radius*2.5;
    }
    applyShadow(scene, dir, model);
    // 드래그 회전
    let drag=false, lx=0;
    scene.onPointerObservable.add(p=>{
      if(p.type===BABYLON.PointerEventTypes.POINTERDOWN){ drag=true; lx=p.event.clientX; }
      else if(p.type===BABYLON.PointerEventTypes.POINTERMOVE && drag){ const dx=p.event.clientX-lx; lx=p.event.clientX; root.rotation.y += dx*0.012; }
      else if(p.type===BABYLON.PointerEventTypes.POINTERUP){ drag=false; }
    });
    scene.onBeforeRenderObservable.add(()=>{
      const t = performance.now()*0.001;
      if(solo){
        // 납작한 장식(별 등)은 자동 회전 시 옆면만 보여 곤란 → 정면 고정 + 미세 흔들림만
        root.rotation.y = 0.18 + Math.sin(performance.now()*0.0006)*0.06;
        bob.position.y = 0;
        return;
      }
      bob.position.y=Math.sin(t*2)*0.03;
      updateIdle(refs, t, 0);
    });
  });
  engine.runRenderLoop(()=>scene.render());
  setTimeout(()=>engine.resize(), 60);
}
// 미리보기 모달 바인딩 (1회)
$('#preview-close').addEventListener('click', closePreview);
$('#preview-modal').addEventListener('click', e=>{ if(e.target.id==='preview-modal') closePreview(); });
// ★ contextmenu 차단은 «1회» 만 붙인다. 예전엔 buildPreviewScene 이 열릴 때마다
//   같은 canvas 에 리스너를 계속 쌓았다(중복 바인딩).
$('#preview-canvas').addEventListener('contextmenu', e=>e.preventDefault());
$('#preview-buy').addEventListener('click', async ()=>{
  if($('#preview-buy').disabled) return;
  try{ await buyItem($('#preview-buy').dataset.buy);
    $('#preview-buy').textContent='보유 중 '; $('#preview-buy').disabled=true;
  }catch(e){ alert(e.message); }
});

// ---------- 리포트 ----------
// ★ v1.40 «대화 저장 → 분석» — 리포트에서 «저장 N건 = 분석 N건» 을 바로 보여준다.
//   DDL 뷰어는 sqlite_master 의 실제 SQL 을 그대로 출력하므로 발표 자료와 코드가 어긋나지 않는다.
let _caData = null;

async function loadChatAnalysis(){
  const box = $('#ca-kpis');
  if(!box) return;
  try{
    const r = await api('/api/chat/analysis', undefined, 12000);
    _caData = r;
    renderChatAnalysis(r);
  }catch(e){
    const s = $('#ca-summary');
    if(s) s.textContent = '대화 분석을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.';
  }
}

function renderChatAnalysis(r){
  const cov = r.coverage || {}, t = r.totals || {};
  const covEl = $('#ca-coverage');
  if(covEl) covEl.textContent = `저장 ${cov.user_msgs || 0}건 · 분석 ${cov.analyzed || 0}건 · 보관 ${r.retainedDays || 30}일`;
  const sum = $('#ca-summary');
  if(sum) sum.textContent = (r.today && r.today.summary) || '아직 오늘 나눈 대화가 없어요. 루미에게 먼저 말을 걸어 보세요.';
  const kpis = [
    ['총 대화', t.turns || 0, '턴'],
    ['막힌 순간', t.stuck || 0, '번'],
    ['스스로 푼 횟수', t.solved || 0, '번'],
    ['아이가 한 질문', t.questions || 0, '개'],
    ['평균 글자 수', t.avg_words || 0, '자'],
    ['루미가 준 힌트', t.hints || 0, '번']
  ];
  const box = $('#ca-kpis');
  if(box) box.innerHTML = kpis.map(([label, val, unit]) =>
    `<div><b>${esc(val)}<small>${esc(unit)}</small></b><span>${esc(label)}</span></div>`).join('');

  const week = r.week || [];
  const max = Math.max(1, ...week.map(w => w.turns || 0));
  const weekEl = $('#ca-week');
  if(weekEl) weekEl.innerHTML = week.length
    ? `<div class="ca-week-head">최근 7일 대화 <span>막대 = 대화 턴 수</span></div>` +
      `<div class="ca-bars">${week.map(w => `
        <div class="ca-day" title="${esc(w.day)} · ${esc(w.turns)}턴">
          <div class="ca-bar-wrap"><i style="height:${Math.round((w.turns || 0) / max * 100)}%"></i></div>
          <span>${esc(String(w.day || '').slice(5))}</span>
        </div>`).join('')}</div>`
    : '<div class="ca-week-head">최근 7일 대화 <span>아직 기록이 없어요</span></div>';

  const subs = r.subjects || [];
  const subEl = $('#ca-subjects');
  if(subEl) subEl.innerHTML = subs.length
    ? `<span class="ca-sub-label">자주 나온 주제</span>` + subs.map(s =>
        `<span class="ca-chip">${esc(s.subject)} <b>${esc(s.turns)}</b>${s.stuck_count ? `<i>막힘 ${esc(s.stuck_count)}</i>` : ''}</span>`).join('')
    : '';
}

async function openChatAnalysis(){
  const m = $('#chat-analysis-modal');
  if(!m) return;
  m.classList.remove('hidden');
  const list = $('#ca-list');
  if(list) list.innerHTML = '<div class="story-empty">대화 기록을 불러오는 중…</div>';
  try{
    const r = await api('/api/chat/analysis/messages?limit=50', undefined, 12000);
    const rows = r.messages || [];
    if(!list) return;
    list.innerHTML = rows.length
      ? rows.map(x => `<div class="ca-row">
          <div class="ca-row-top">
            <b>${esc(x.day)}</b>
            <span>${esc(x.subject || '일상')} · ${esc(x.intent || '이야기')} · ${esc(x.sentiment || '보통')}</span>
          </div>
          <p>${esc(x.content || '')}</p>
          <div class="ca-tags">
            ${x.stuck ? '<span class="ca-tag stuck">막힘</span>' : ''}
            ${x.solved ? '<span class="ca-tag solved">스스로 풀었어요</span>' : ''}
            ${x.keywords ? `<span class="ca-tag">${esc(x.keywords)}</span>` : ''}
          </div>
        </div>`).join('')
      : '<div class="story-empty">아직 저장된 대화가 없어요.<br>루미에게 말을 걸면 여기에 한 줄씩 쌓여요.</div>';
  }catch(e){
    if(list) list.innerHTML = `<div class="story-empty">${esc(e.message)}</div>`;
  }
}

async function toggleChatSchema(){
  const pre = $('#ca-ddl');
  if(!pre) return;
  if(!pre.classList.contains('hidden')){ pre.classList.add('hidden'); return; }
  try{
    const r = await api('/api/chat/analysis/schema', undefined, 12000);
    const parts = (r.objects || []).map(o => `-- ${String(o.type || '').toUpperCase()} · ${o.name}\n${o.sql};`);
    const idx = (r.indexes || []).map(i => `-- INDEX · ${i.name}\n${i.sql};`);
    pre.textContent = [...parts, ...idx].join('\n\n');
    pre.classList.remove('hidden');
  }catch(e){ toast(e.message); }
}

(function bindChatAnalysisUI(){
  const d = $('#btn-ca-detail'); if(d) d.addEventListener('click', openChatAnalysis);
  const s = $('#btn-ca-schema'); if(s) s.addEventListener('click', toggleChatSchema);
  const c = $('#ca-close'); if(c) c.addEventListener('click', () => $('#chat-analysis-modal').classList.add('hidden'));
  const m = $('#chat-analysis-modal');
  if(m) m.addEventListener('click', e => { if(e.target === m) m.classList.add('hidden'); });
})();

async function loadBoard(){
  // ★ 네트워크 실패 시 조용한 빈 화면 + unhandled rejection 이 남지 않게 한다.
  // ★ 2026-11-20 (v1.72): await 동안 스켈레톤 → 실패/빈 데이터는 «루미 포즈» 빈 화면으로
  fillSkeleton($('#board-stats'), 4);
  let j;
  try{ j = await api('/api/board/me'); }
  catch(e){
    const box = $('#board-stats');
    // ★ 2026-11-21 (v1.74) C4: «다시 시도» 버튼으로 재호출(loadBoard 자신)
    if(box) box.innerHTML = emptyState('oops', e.message || '리포트를 불러오지 못했어요. 잠시 후 다시 시도해 줄래?', ()=>loadBoard());
    return;
  }
  const s = j.stats;
  // ★ 2026-11-20 (v1.72): stats 자체가 없으면(비정상 응답) 빈 리포트 취급 — 기본 루미로 안내
  if(!s){
    const box = $('#board-stats');
    if(box) box.innerHTML = emptyState('idle', '아직 만들어진 리포트가 없어요. 며칠 더 함께 하면 채워질 거야!');
    return;
  }
  const srcMap = {welcome:'가입 보너스', robot_create:'로봇 제작 보상', daily_quest:'오늘의 과제',
                  shop:'부품 구매', streak:'연속 방문 보상', game:'미니게임 보상'};
  // ★ 각 지표에 '실시간/누적/평균' 라벨을 붙인다.
  //   수치만 나열되면 사용자가(=기업 심사자가) 지표를 해석할 수 없다.
  $('#board-stats').innerHTML = `
    <div class="stat hi"><b>${esc(s.returnRate)}%</b><span>재접속률</span>
      <span class="tagline">누적 ${esc(s.activeDays)}일 중 ${esc(Math.max(0,s.activeDays-1))}일 재방문</span></div>
    ${s.streak?`<div class="stat"><b> ${esc(s.streak)}일</b><span>현재 연속</span>
      <span class="tagline">최대 기록은 계속 쌓여요</span></div>`:''}
    <div class="stat"><b>Lv.${esc(s.level)}</b><span>현재 레벨</span>
      <span class="tagline">${esc(s.exp)}/${esc(s.expNeeded)} XP</span></div>
    <div class="stat"><b>${esc(s.balance)}</b><span>셀 잔액</span>
      <span class="tagline">지금 가진 재화</span></div>
    <div class="stat"><b>${esc(s.activeDays)}일</b><span>활동 일수</span>
      <span class="tagline">기간 중 접속한 날</span></div>
    <div class="stat"><b>${esc(s.playMinutes)}분</b><span>총 체류시간</span>
      <span class="tagline">누적 ${esc(s.returnSpanDays)}일 기준</span></div>
    <div class="stat"><b>${esc(s.avgMinutes)}분</b><span>일당 평균</span>
      <span class="tagline">평균 체류시간</span></div>
    <div class="stat"><b>${esc(s.visitCount)}회</b><span>총 접속 횟수</span>
      <span class="tagline">마이룸 방문 누적</span></div>
    <div class="stat"><b>${esc(s.questDone)}개</b><span>과제 완료</span>
      <span class="tagline">오늘의 과제 포함</span></div>
    <div class="stat"><b>+${esc(s.txIn)}</b><span>획득한 셀</span>
      <span class="tagline">재화 유입</span></div>
    <div class="stat"><b>-${esc(Math.abs(s.txOut))}</b><span>사용한 셀</span>
      <span class="tagline">재화 유출</span></div>`;
  // 최근 7일 접속 추이(막대 그래프) — 기록 없는 날도 0으로 채워 7칸을 유지한다
  const daily = j.daily || [];
  const byDay = Object.fromEntries(daily.map(d=>[d.d, d]));
  const days = [];
  const baseKst = new Date(Date.now() + 9*3600*1000);
  for(let i=6;i>=0;i--){
    const dt = new Date(baseKst); dt.setUTCDate(dt.getUTCDate() - i);
    const key = dt.toISOString().slice(0,10);
    days.push(byDay[key] || { d:key, visits:0, secs:0 });
  }
  const maxV = Math.max(1, ...days.map(d=>d.visits));
  $('#board-trend').innerHTML = days.map(d=>{
    const h = Math.round(d.visits / maxV * 62) + 3;
    const min = Math.round((d.secs||0)/60);
    const wd = ['일','월','화','수','목','금','토'][(new Date(d.d+'T00:00:00+09:00').getDay())];
    return `<div class="col" title="${esc(d.d)} · ${min}분 체류">
      <span class="cnt">${esc(d.visits)}</span>
      <div class="bar${d.visits?'':' empty'}" style="height:${h}px"></div>
      <span class="lbl">${esc(String(new Date(d.d+'T00:00:00+09:00').getDate()))}일(${wd})</span>
    </div>`;
  }).join('');
  $('#tx-table tbody').innerHTML = j.txs.map(t=>
    `<tr><td>${esc(srcMap[t.source]||t.source)}</td>
     <td class="${t.amount>=0?'plus':'minus'}">${t.amount>=0?'+':''}${esc(t.amount)}</td>
     <td>${esc(t.ts)}</td></tr>`).join('') || '<tr><td colspan="3" class="tx-empty">아직 기록이 없어요</td></tr>';
}

// ★ 마이룸 하단 '오늘의 진행 단계' — 아이가 지금 무엇을 해야 하는지 한눈에 알 수 있게 한다.
//   4단계(간식 → 칭찬 → 과제 → 게임) 중 어디까지 했는지 표시한다.
function renderSteps(){
  const box = $('#room-steps');
  if(!box) return;
  const done = new Set((state.quests.done||[]).map(Number));
  const st = [];
  state.quests.list.forEach(q=>{ if(q.type==='feed')   st.push({k:'feed',   t:'간식 주기', d:done.has(q.id)}); });
  state.quests.list.forEach(q=>{ if(q.type==='praise') st.push({k:'praise', t:'칭찬하기', d:done.has(q.id)}); });
  state.quests.list.forEach(q=>{ if(q.type==='ai_mission') st.push({k:'quest', t:'AI 과제', d:done.has(q.id)}); });
  st.push({k:'game', t:'미니게임', d:false});
  const cur = st.findIndex(x=>!x.d);
  const tip = cur === -1 ? '오늘 할 일을 다 했어요! ' : null;
  box.innerHTML = st.map((x,i)=>
    `<span class="st ${x.d?'done':(i===cur?'now':'')}">
       <span class="dot">${x.d?'✓':i+1}</span>${esc(x.t)}
     </span>${i<st.length-1?'<span class="arrow">›</span>':''}`).join('')
    + (tip ? `<span class="tip">${esc(tip)}</span>` : '');
}

// ★ 상점 하단 '내 부품함' — 규격(wireframe)에 있는 인벤토리 영역
function renderOwned(){
  const box = $('#shop-owned');
  if(!box) return;
  const qty = state.itemQty || {};
  const list = [
    ...state.parts.map(n=>({ n, kind:'로봇 부품' })),
    ...state.decors.map(n=>({ n, kind:'방 장식' })),
    ...state.skins.map(n=>({ n, kind:'색칠 스킨' })),
    ...state.shards.map(n=>({ n, kind:'부품 조각' })),
  ];
  if(!list.length){ box.innerHTML = '<div class="none">아직 구매한 부품이 없어요. 과제를 완료하면 셀을 모을 수 있어요!</div>'; return; }
  box.innerHTML = list.map(o=>{
    const q = qty[o.n] || 1;
    // 수량이 2개 이상이면 배지로 표시한다(V2-10).
    // 소비품을 여러 번 사도 '몇 개나 갖고 있는지' 가 안 보이면
    // 두 번 결제된 사실을 아이가 알아채기 어렵다.
    const qtyBadge = q> 1 ? `<span class="qty">×${q}</span>` : '';
    return `<div class="own"><span class="em">${ITEM_EMOJI[o.n]||''}</span>
      <span class="nm">${esc(o.n)}</span><span class="kind">${esc(o.kind)}</span>${qtyBadge}</div>`;
  }).join('');
  // 부품 조각 교환 진행도 + 교환 UI(V2-1)
  // ★ V4: 부품마다 필요한 조각 수가 다르다(가격 비례).
  //   예전엔 '3개면 아무 부품이나 교환' 이라 로켓 부스터를 절반 값에 살 수 있었다.
  const sp = state.shardProgress;
  if(sp && sp.have> 0){
    const targets = (state.shardTargets||[]);
    // 현재 조각 수로 교환 가능한 부품만 고른다
    const affordable = targets.filter(t=>sp.have>= t.need);
    box.insertAdjacentHTML('beforeend', `
      <div class="own shard-box">
        <span class="em"></span>
        <span class="nm">부품 조각 ${sp.have}개</span>
        <div class="ex-list">
          ${targets.length ? targets.map(t=>{
            const ok = sp.have>= t.need;
            return `<button class="ex-item ${ok?'':'off'}" data-ex="${t.id}" ${ok?'':'disabled'}>
              <span class="nm">${esc(t.name)}</span>
              <span class="cost">조각 ${t.need}개</span>
              <span class="org">정가 ${t.price}셀</span>
            </button>`;
          }).join('') : `<span class="ex-hint">${sp.have}/${sp.need} 개 모으면 부품으로 교환</span>`}
        </div>
      </div>`);
  }
  $$('#shop-owned .ex-item').forEach(b=>b.addEventListener('click', async ()=>{
    if(b.disabled) return;
    b.disabled = true;
    try{
      const r = await api('/api/shop/exchange', { partId:Number(b.dataset.ex) });
      bubble(` 조각 ${r.used}개로 [${r.part}] 을 만들었어!`);
      const jr = await api('/api/robots/me');
      absorbRobotMe(jr);
      await api('/api/shop/exchange-info').then(info=>{
        state.shardTargets = info.targets||[];
        if(info.need) state.shardProgress = { have: info.have, need: info.need };
      }).catch(()=>{});
      await refreshGrowth();     // ★ V9: 교환으로 늘어난 부품도 보너스에 반영
      if(bjs.ready && state.robot) rebuildRobot(state.robot);
      renderOwned();
      setBalance(r.balance);
    }catch(e){ alert(e.message); b.disabled = false; }
  }));
  const ex = $('#btn-exchange');
  if(ex) ex.addEventListener('click', async ()=>{
    // V4: 개별 부품 버튼(#shop-owned .ex-item)으로 대체되었다.
    // 이 단일 버튼 경로는 '가장 싼 부품' 교환용으로만 남겨 둔다.
    if(ex.disabled) return;
    ex.disabled = true; ex.textContent = '교환 중…';
    try{
      const r = await api('/api/shop/exchange', { partId: 0 });
      bubble(` 조각 ${r.used}개로 [${r.part}] 을 만들었어!`);
      const jr = await api('/api/robots/me');
      absorbRobotMe(jr);
      await loadShardTargets();
      await refreshGrowth();     // ★ V9: 교환으로 늘어난 부품도 보너스에 반영
      if(bjs.ready && state.robot) rebuildRobot(state.robot);
      renderOwned();
      setBalance(r.balance);
    }catch(e){ alert(e.message); ex.disabled=false; ex.textContent='다시 시도'; }
  });
}
// 부품 조각 교환 목표 목록(가격 비례 필요 개수)을 서버에서 가져온다
async function loadShardTargets(){
  try{
    const info = await api('/api/shop/exchange-info');
    state.shardTargets = info.targets || [];
    if(info.need) state.shardProgress = { have: info.have, need: info.need };
  }catch(e){ state.shardTargets = []; }
}

// 초기화: 계정 지우고 처음 화면으로 (데모/재시작용)
// ★ P0-4 서버에서도 내 계정 데이터를 실제로 삭제한다(개인정보 리셋).
// ---------- 3D 리소스 해제 ----------
// ★ V3: 주 엔진(마이룸)이 한 번도 dispose 된 적이 없었다.
//   재접속으로 canvas 를 다시 만들면 이전 Engine/장면/타이머가 남는다.
//   previewEngine 처럼 여기도 명시적으로 정리한다.
function disposeRoom3D(){
  if(bjs.wanderTimer){ clearInterval(bjs.wanderTimer); bjs.wanderTimer = null; }
  if(bjs.engine){
    try{ bjs.engine.stopRenderLoop(); }catch(e){}
    try{ bjs.engine.dispose(); }catch(e){}
  }
  if(bjs.scene){ try{ bjs.scene.dispose(); }catch(e){} }
  bjs = { engine:null, scene:null, root:null, bob:null, model:null, ready:false, _t:0, wanderTimer:null, _starting:false };
}
// 페이지를 벗어날 때(새로고침/탭 종료 전) 남은 자원을 정리
// ★ bfcache 대응: pagehide 에서 장면을 통째로 파괴하지 않는다.
//   모바일 브라우저는 페이지를 bfcache 에 넣고 «뒤로» 하면 그대로 복원하는데,
//   이전엔 복원 시점에 Engine/장면이 이미 dispose 돼 3D 방이 검게 남았다.
//   렌더 루프만 멈춰 장면을 보존하고, 돌아오면(pageshow) 루프를 재개한다.
addEventListener('pagehide', ()=>{ try{ if(bjs.engine) bjs.engine.stopRenderLoop(); }catch(e){} });
addEventListener('pageshow', ()=>{
  try{
    if(bjs.engine && bjs.scene && bjs.ready){
      bjs.engine.runRenderLoop(()=>bjs.scene.render());
      setTimeout(()=>{ try{ bjs.engine.resize(); }catch(e){} }, 60);
    }
  }catch(e){}
});
addEventListener('beforeunload', ()=>{ try{ if(bjs.wanderTimer) clearInterval(bjs.wanderTimer); }catch(e){} });

$('#btn-reset').addEventListener('click', async ()=>{
  if(!confirm('처음부터 다시 시작할까요? (현재 계정 정보가 DB에서도 지워져요)')) return;
  try{ await api('/api/user/delete', {}); }catch(e){ /* 서버 삭제 실패해도 로컬은 정리 */ }
  localStorage.removeItem(SK.uid); localStorage.removeItem(SK.nick); localStorage.removeItem(SK.token);
  location.reload();
});

// ★ V4 데모 계정 버튼: 7일치 성장 데이터가 채워진 계정으로 즉시 전환(발표용)
$('#btn-demo').addEventListener('click', async ()=>{
  const b = $('#btn-demo');
  b.disabled = true; b.textContent = '데모 계정 만드는 중…';
  try{
    // ★ V5-b: 고정 닉네임 하나만 쓴다.
    //   예전엔 '시연_' + Date.now() 로 매번 새 계정을 만들었는데,
    //   그 계정들은 아무도 다시 쓰지 않으면서 통계 분모를 늘리고
    //   (재접속률 86% → 17%), /api/admin/stats 가 쓰레기 데이터로 가득 찼다.
    //   seed 가 '데모_루미' 를 멱등하게 재사용하므로 여기도 같은 이름만 쓴다.
    const DEMO_NICK = '데모_루미';
    const j = await api('/api/user', { nickname: DEMO_NICK });
    state.user = j.user; state.quests = j.quests;
    if(j.user.token) localStorage.setItem(SK.token, j.user.token);
    localStorage.setItem(SK.uid, j.user.id);
    localStorage.setItem(SK.nick, DEMO_NICK);
    // 시드 생성 → 새 토큰 반환
    const r = await api('/api/demo/seed', {});
    localStorage.setItem(SK.token, r.token);
    localStorage.setItem(SK.nick, r.nickname);
    // 시드가 만든 계정 정보를 다시 읽어 화면에 반영
    const u2 = await api('/api/user', { nickname: r.nickname });
    state.user = u2.user; state.quests = u2.quests || state.quests;
    absorbUserMeta(u2);   // ★ v1.74: ob_step · play_limit_delta 스냅샷
    if(u2.user.token) localStorage.setItem(SK.token, u2.user.token);
    if(j.streakBonus) setTimeout(()=> bubble(` ${j.streakBonus}일 연속 방문 보상 +${j.streakBonus}셀!`), 800);
    startPlayTimer();
    await enter();
    setTimeout(()=> bubble('지난 7일 기록을 불러왔어. 오늘은 뭐부터 할까?'), 1400);
  }catch(e){ alert(e.message); }
  finally{ b.disabled = false; b.textContent = ' 데모 계정으로 바로 보기'; }
});

// ---------- 자랑하기 (3D 화면을 그림으로 저장) ----------
// 자체 2-셀흐름도에 '전시·자랑' 단계가 있는데 구현이 없었다.
// 아이가 자기 로봇을 부모님·친구에게 보여줄 수 있게 한다(서버 불필요).
$('#btn-share').addEventListener('click', ()=>{
  const cv = $('#room3d');
  if(!bjs.ready || !cv || !bjs.scene){ alert('3D 로봇이 다 만들어지면 자랑할 수 있어요!'); return; }
  try{
    bjs.scene.render();                                  // 방금 그린 프레임 보장
    const url = cv.toDataURL('image/png');                // preserveDrawingBuffer:true 라 가능
    const r = state.robot || {};
    const g = state.growth || {};
    $('#share-img').src = url;
    $('#share-save').href = url;
    $('#share-save').download = `루미_${r.name || '로봇'}.png`;
    $('#share-title').textContent = `${r.name || '내 로봇'} · Lv.${g.level || 1} ${g.stageLabel || ''}`;
    $('#share-desc').textContent = `${r.personality || ''} · ${(state.parts || []).length}개 부품`;
    $('#share-modal').classList.remove('hidden');
    SFX.correct();
  }catch(e){ console.error('[share]', e); alert('자랑 카드를 만들지 못했어요 '); }
});
$('#share-close').addEventListener('click', ()=> $('#share-modal').classList.add('hidden'));
$('#share-modal').addEventListener('click', e=>{ if(e.target.id==='share-modal') $('#share-modal').classList.add('hidden'); });

// ---------- 오늘의 랭킹 ----------
// '1등'이라는 목표와 '자랑하고 싶다'는 동기를 만든다(실제 플랫폼도 타자게임 1등 보상이 있다).
async function openRank(){
  $('#rank-modal').classList.remove('hidden');
  $('#rank-body').innerHTML = '<div class="none">불러오는 중…</div>';
  try{
    const [r, w] = await Promise.all([api('/api/rank/daily'), api('/api/rank/weekly').catch(()=>null)]);
    const block = (title, emoji, data, fmt)=>{
      const rows = (data.rows || []).map(x=>
        `<div class="rk-row${x.me?' me':''}"><b>${x.rank}</b><span class="rk-name">${esc(x.name)}</span><span class="rk-score">${esc(fmt(x.score))}</span></div>`
      ).join('') || '<div class="none">아직 기록이 없어요. 첫 1등이 되어보세요!</div>';
      const mine = (data.myScore != null)
        ? `<div class="rk-mine">내 기록 ${esc(fmt(data.myScore))}${data.myRank?` · ${data.myRank}위`:''}</div>`
        : `<div class="rk-mine">오늘은 아직 안 했어요 — 도전해 볼까요?</div>`;
      return `<div class="rk-block"><h4>${emoji} ${title}</h4>${rows}${mine}</div>`;
    };
    const week = (rows, title, emoji)=>{
      const list = (rows || []).map(x=>
        `<div class="rk-row"><b>${x.rank}</b><span class="rk-name">${esc(x.name)}</span><span class="rk-score">${x.score}점</span></div>`
      ).join('') || '<div class="none">아직 기록이 없어요</div>';
      return `<div class="rk-block"><h4>${emoji} ${title} · 주간</h4>${list}</div>`;
    };
    $('#rank-body').innerHTML =
      block('버그 두더지', '🐞', r.mole, s=>`${s}점`) +
      block('버그 슈터', '🚀', r.shooter, s=>`${s}점`) +
      (w ? week(w.mole, '버그 두더지', '🐞') + week(w.shooter, '버그 슈터', '🚀') : '') +
      `<div class="rk-note">${esc(r.note || '')}</div>`;
  }catch(e){ $('#rank-body').innerHTML = '<div class="none">랭킹을 불러오지 못했어요</div>'; }
}
$('#btn-rank').addEventListener('click', openRank);
$('#rank-close').addEventListener('click', ()=> $('#rank-modal').classList.add('hidden'));
$('#rank-modal').addEventListener('click', e=>{ if(e.target.id==='rank-modal') $('#rank-modal').classList.add('hidden'); });

// ---------- 첫 실행 온보딩 ----------
// 실제 DOROBUS 는 첫 로그인 5단계 가이드가 있다. 여기선 3단계로 같은 역할을 한다.
const OB_STEPS = [
  { emoji:'', title:'로봇을 만들어요', desc:'마음에 드는 로봇을 고르고, 색을 칠하고, 이름을 지어주세요.' },
  { emoji:'', title:'매일 과제로 셀을 모아요', desc:'간식 주기 · 칭찬하기 · AI 과제 — 하루 3가지! 연속으로 오면 보상이 커져요.' },
  { emoji:'', title:'부품으로 꾸며요', desc:'모은 셀로 부품을 사서 로봇과 마이룸을 꾸밀 수 있어요.' },
];
let obIdx = 0;
function renderOnboard(){
  const s = OB_STEPS[obIdx];
  $('#ob-emoji').textContent = s.emoji;
  $('#ob-title').textContent = s.title;
  $('#ob-desc').textContent = s.desc;
  $('#ob-dots').innerHTML = OB_STEPS.map((_,i)=>`<i class="${i===obIdx?'on':''}"></i>`).join('');
  $('#ob-next').textContent = (obIdx === OB_STEPS.length - 1) ? '시작하기 ' : '다음';
}
function closeOnboard(){
  $('#onboard').classList.add('hidden');
  try{ localStorage.setItem('roomi_onboard', '1'); }catch(e){}
}
$('#ob-next').addEventListener('click', ()=>{
  if(obIdx <OB_STEPS.length - 1){ obIdx++; renderOnboard(); SFX.click(); }
  else { closeOnboard(); SFX.start(); }
});
$('#ob-skip').addEventListener('click', closeOnboard);
(function maybeShowOnboard(){
  let seen = false;
  try{ seen = localStorage.getItem('roomi_onboard') === '1'; }catch(e){}
  if(!seen){ renderOnboard(); $('#onboard').classList.remove('hidden'); }
})();

// ---------- 자동 로그인 ----------
(async function init(){
  // ★ 2026-11-20 (v1.72): «귀엽고 고급스럽게» 정적 장식 1회 주입 — 스크립트가 body 끝에서
  //   실행되므로 DOM 이 이미 준비돼 있고, 인증 흐름(early return)과 무관하게 반드시 한 번 돈다.
  //   실패해도 로그인 흐름을 막지 않는다(장식은 장식일 뿐).
  try{ replaceStaticIcons(); injectRumiMoments(); }
  catch(e){ console.error('[v1.72 ui]', e); }
  const uid = localStorage.getItem(SK.uid), nick = localStorage.getItem(SK.nick);
  if(uid && nick){
    try{
      const j = await api('/api/user',{nickname:nick});
      state.user=j.user; state.quests=j.quests||{list:[],done:[]};
      absorbUserMeta(j);   // ★ v1.74: ob_step · play_limit_delta 스냅샷
      if(j.revive && j.revive.available) setTimeout(()=>showRevive(j.revive), 900);
      if(j.user.token) localStorage.setItem(SK.token, j.user.token);
      if(j.streakBonus) setTimeout(()=> bubble(` ${j.streakBonus}일 연속 방문 보상 +${j.streakBonus}셀!`), 1200);
      // ★ 오버플레이 차단은 자동 로그인 경로에도 반드시 적용한다.
      //   여기를 빠뜨리면 새로고침만으로 시간 제한을 우회할 수 있다.
      if(j.play && j.play.overLimit && !state.overplayDismissed){
        show('start');
        showOverplay({ minutes: j.play.minutes });
        return;
      }
      startPlayTimer();
      await enter(); return;
    }catch(e){}
  }
  show('start');
})();

// ============================================================
// ★ 2026-10-27 — 방 학습 상태 / 루미 대화 / 버그 슈터 / 오늘의 퍼즐
// ============================================================

// ---- 방 조명/책장: 이해도가 오르면 방이 밝아진다 ----
async function loadRoomState(){
  try{
    const r = await api('/api/room/state');
    state.room = r;
    const el = $('#room-learning');
    if(el){
      const lit = r.lit > 0.05 ? ` · 💡 방이 ${Math.round(r.lit*100)}% 밝아졌어요` : ' · 💡 학습하면 방이 밝아져요';
      const bookRow = Array.from({length:12},(_,i)=>`<span class="${i<r.books?'on':''}">📕</span>`).join('');
      el.innerHTML = `📚 이해도 <b>${r.understanding}</b> · 책 <b>${r.books}</b>권${lit}<div class="room-books">${bookRow}</div>`;
    }
    const hb = $('#hud-books'); if(hb) hb.textContent = `📚${r.books||0}`;
    if(bjs.scene){
      const hemi = bjs.scene.getLightByName('h');
      // ★ 2026-11-05: 학습 밝기 보정치 상한을 1.00 → 0.70 로 제한(과노출 재발 방지)
      if(hemi) hemi.intensity = 0.34 + (r.lit||0) * 0.36;
    }
  }catch(e){ /* 조용히 무시 — 방 렌더를 막지 않는다 */ }
  // ★ 2026-11-21 (v1.71): 성장 탭 데이터 로딩의 일부로 «기억 등불» 을 함께 읽는다.
  //   실패하면 판넬이 감춰진 채로 남는다(조용히 — 방 렌더를 막지 않는다).
  try{ loadLamps(); }catch(e){ console.error('[loadLamps]', e); }
}

// ---- 친구 시스템 (2026-10-29) ----
async function loadFriends(){
  const list = $('#friend-list');
  if(!list) return;
  try{
    const r = await api('/api/friends');
    $('#friend-code').textContent = r.code || '------';
    $('#friend-count').textContent = `${(r.friends||[]).length}명`;
    const requests = r.requests || [];
    $('#friend-requests').innerHTML = requests.length ? requests.map(q=>`
      <div class="friend-item">
        <div class="friend-info"><b>${esc(displayName(q.nickname))}</b><span>Lv.${q.level||1}</span></div>
        <div class="friend-actions">
          <button class="btn primary" data-faccept="${q.id}">수락</button>
          <button class="btn ghost" data-fdecline="${q.id}">거절</button>
        </div>
      </div>`).join('') : '<div class="hint">받은 요청이 없어요.</div>';
    const friends = r.friends || [];
    state.friends = friends;
    state.friendsChatEnabled = r.chatEnabled !== false;
    const chatNote = $('#friend-chat-note');
    if(chatNote) chatNote.textContent = state.friendsChatEnabled
      ? '친구와 텍스트로 대화할 수 있어요. 개인정보/링크/전화번호는 보내지 마세요.'
      : '보호자가 친구 채팅을 꺼 두었어요. 응원은 보낼 수 있어요.';
    const offNote = r.chatEnabled === false
      ? '<div class="hint" style="margin-bottom:8px">보호자가 친구 채팅을 꺼 두었어요.</div>' : '';
    list.innerHTML = offNote + (friends.length ? friends.map(f=>{
      const tpl = (f.robot && f.robot.template) || 'doro';
      const pal = (f.robot && f.robot.palette) || {};
      const svg = robotSVG(tpl, effectiveColors(tpl, pal));
      const chatBtn = state.friendsChatEnabled
        ? `<button class="btn primary" data-fchat="${f.id}">채팅</button>` : '';
      return `<div class="friend-item">
        <div class="friend-avatar">${svg}</div>
        <div class="friend-info"><b>${esc(displayName(f.nickname))}${f.unread?`<span class="friend-unread">${f.unread}</span>`:''}${f.inWorld?'<span class="friend-online">🌍 마을에 있음</span>':''}</b><span>Lv.${f.level} · 🔥${f.streak}</span></div>
        <div class="friend-actions">
          ${chatBtn}
          ${f.inWorld?`<button class="btn primary" data-fplay="1">같이 놀기</button>`:''}
          <button class="btn ghost" data-fgb="${f.id}">마을</button>
          <button class="btn ghost" data-fcheer="${f.friendshipId}" ${f.cheeredToday?'disabled':''}>${f.cheeredToday?'응원 완료':'응원'}</button>
          <button class="btn ghost" data-fremove="${f.friendshipId}">삭제</button>
        </div>
      </div>`;
    }).join('') : '<div class="hint">아직 친구가 없어요. 위 코드로 친구를 추가해 보세요!</div>');
    $$('#friend-requests [data-faccept]').forEach(b=>b.addEventListener('click', ()=>friendAction('/api/friends/accept', b.dataset.faccept, '친구가 됐어요!')));
    $$('#friend-requests [data-fdecline]').forEach(b=>b.addEventListener('click', ()=>friendAction('/api/friends/decline', b.dataset.fdecline, '요청을 거절했어요.')));
    $$('#friend-list [data-fchat]').forEach(b=>b.addEventListener('click', ()=>openFriendChat(Number(b.dataset.fchat))));
    $$('#friend-list [data-fgb]').forEach(b=>b.addEventListener('click', ()=>openGuestbook(Number(b.dataset.fgb))));
    // ★ v1.35 친구가 마을에 있으면 «같이 놀기» — 눌러서 바로 대세계로 들어간다
    $$('#friend-list [data-fplay]').forEach(b=>b.addEventListener('click', ()=>{
      toast('AI 마을로 들어가요! 친구를 찾아보세요 🌍');
      const wb = $('#btn-world'); if (wb) wb.click();
    }));
    $$('#friend-list [data-fcheer]').forEach(b=>b.addEventListener('click', ()=>friendAction('/api/friends/cheer', b.dataset.fcheer, '응원을 보냈어요!')));
    $$('#friend-list [data-fremove]').forEach(b=>b.addEventListener('click', ()=>{
      if(confirm('친구를 삭제할까요?')) friendAction('/api/friends/remove', b.dataset.fremove, '친구를 삭제했어요.');
    }));
  }catch(e){
    list.innerHTML = `<div class="hint">${esc(e.message)}</div>`;
  }
}
async function friendAction(path, id, msg){
  try{
    const r = await api(path, { id });
    toast(msg + (r && r.nickname ? ` (${displayName(r.nickname)})` : ''));
    loadFriends();
  }catch(e){ toast(e.message); }
}
async function addFriendByCode(){
  const input = $('#friend-code-input');
  const code = ((input && input.value) || '').trim().toUpperCase();
  if(!code) return toast('친구 코드를 입력해 주세요');
  try{
    const r = await api('/api/friends/request', { code });
    toast(r.auto ? `${displayName(r.nickname)}님과 친구가 됐어요!` : `${displayName(r.nickname)}님에게 요청을 보냈어요`);
    if(input) input.value = '';
    loadFriends();
  }catch(e){ toast(e.message); }
}

// ---- 친구 채팅 (2026-10-29) ----
let _fcTimer = null, _fcFriend = null;
// ★ 이미 그린 메시지 수 — 폴링 때 «새 것만» 덧붙이기 위한 기준(아래 loadFriendChat)
let _fcRendered = { fid:null, count:0 };
function fcMsgHTML(m){
  const mine = m.from_user === state.user.id;
  const t = (m.created_at||'').slice(11,16);
  return `<div class="fc-msg ${mine?'me':''}"><span>${esc(m.body)}</span><small>${t}</small></div>`;
}
async function openFriendChat(fid){
  if(state.friendsChatEnabled === false) return toast('보호자가 친구 채팅을 꺼 두었어요');
  const f = (state.friends||[]).find(x=>x.id === fid);
  if(!f) return;
  _fcFriend = fid;
  $('#friend-chat').classList.remove('hidden');
  $('#fc-name').textContent = displayName(f.nickname);
  const tpl = (f.robot && f.robot.template) || 'doro';
  const pal = (f.robot && f.robot.palette) || {};
  $('#fc-avatar').innerHTML = robotSVG(tpl, effectiveColors(tpl, pal));
  await loadFriendChat(fid, false);
  clearInterval(_fcTimer);
  _fcTimer = setInterval(()=>{
    if($('#friend-chat').classList.contains('hidden')){ stopFriendChat(); return; }
    loadFriendChat(fid, true);
  }, 5000);
}
async function loadFriendChat(fid, quiet){
  try{
    const r = await api(`/api/friends/chat?friendId=${fid}`);
    if(!quiet && r.friend) $('#fc-name').textContent = displayName(r.friend.nickname);
    const log = $('#fc-log'); if(!log) return;
    const msgs = r.messages||[];
    // ★ 5초 폴링마다 log.innerHTML 을 통째로 다시 그리면, 위로 스크롤해 과거
    //   대화를 읽는 아이가 5초마다 맨 아래로 끌려 내려갔다.
    //   → 처음 열 때(또는 친구가 바뀌었을 때)만 전체를 그리고, 이후엔
    //     새로 도착한 메시지 «만» 덧붙인다. 자동 스크롤은 바닥 근처일 때만.
    if(_fcRendered.fid !== fid || _fcRendered.count > msgs.length){
      log.innerHTML = msgs.map(fcMsgHTML).join('') || '<div class="hint" style="text-align:center;padding:20px">첫 메시지를 보내 보세요!</div>';
      _fcRendered = { fid, count: msgs.length };
      if(!quiet) log.scrollTop = log.scrollHeight;
      return;
    }
    if(msgs.length === _fcRendered.count){
      // 새 메시지가 없어도 «같은 친구 채팅을 다시 열었을 때» 는 바닥으로 보내준다.
      if(!quiet) log.scrollTop = log.scrollHeight;
      return;
    }
    for(let i=_fcRendered.count; i<msgs.length; i++) log.insertAdjacentHTML('beforeend', fcMsgHTML(msgs[i]));
    _fcRendered.count = msgs.length;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    if(nearBottom) log.scrollTop = log.scrollHeight;
  }catch(e){ if(!quiet) toast(e.message); }
}
function stopFriendChat(){
  if(_fcTimer){ clearInterval(_fcTimer); _fcTimer = null; }
  _fcFriend = null;
}
async function sendFriendChat(){
  const input = $('#fc-text');
  const msg = ((input && input.value) || '').trim();
  if(!msg || !_fcFriend) return;
  // ★ Enter 연타로 같은 메시지가 여러 번 전송되지 않게 잠근다.
  const send = $('#fc-send');
  if(send && send.disabled) return;
  if(send) send.disabled = true;
  try{
    await api('/api/friends/chat', { friendId:_fcFriend, message:msg });
    if(input) input.value = '';
    loadFriendChat(_fcFriend, true);
  }catch(e){ toast(e.message); }
  finally{ if(send) send.disabled = false; }
}
async function reportFriend(){
  if(!_fcFriend) return;
  if(!confirm('신고할까요? 선생님이 확인해요.')) return;
  try{
    await api('/api/friends/report', { friendId:_fcFriend, reason:'불편한 말/행동' });
    toast('신고했어요. 선생님이 확인할게요.');
  }catch(e){ toast(e.message); }
}
async function blockFriend(){
  if(!_fcFriend) return;
  if(!confirm('차단하면 친구가 삭제되고 다시 요청할 수 없어요. 차단할까요?')) return;
  try{
    await api('/api/friends/block', { friendId:_fcFriend });
    toast('차단했어요.');
    closeGame('friend-chat');
  }catch(e){ toast(e.message); }
}

// ---- AI가 짜 주는 오늘의 학습 계획 (2026-10-28) ----
async function loadPlan(){
  const box = $('#plan-list');
  if(box && !state.plan) box.innerHTML = '<div class="hint">루미가 계획을 짜고 있어요…</div>';
  try{
    const r = await api('/api/plan/today');
    state.plan = r;
    renderPlan();
    if($('#chat-panel') && !$('#chat-panel').classList.contains('hidden')) renderChatChips();
    // 오후 4시 이후, 아직 시작 전이면 한 번만 살짝 알려준다.
    if(!state.planToastShown && state.nudgeOptIn && !r.allDone && (r.done||0) === 0 && new Date().getHours() >= 16){
      state.planToastShown = true;
      setTimeout(()=>toast('오늘의 학습 계획이 준비됐어! 1단계부터 시작해 볼까?'), 2500);
    }
  }catch(e){
    if(box) box.innerHTML = '<div class="hint">계획을 불러오지 못했어요.</div>';
  }
}
function renderPlan(){
  const r = state.plan, box = $('#plan-list');
  if(!box || !r || !r.plan) return;
  const steps = r.plan.steps || [];
  box.innerHTML = steps.map(s=>`
    <div class="plan-step ${s.done?'done':''}">
      <input type="checkbox" class="plan-check" data-plan-done="${s.id}" ${s.done?'checked':''} title="완료">
      <div class="plan-body"><b>${esc(s.title)}</b><span>${esc(s.desc||'')} · ${s.minutes}분</span></div>
      <button class="btn primary" data-plan-start="${s.id}">${s.done?'완료':'시작'}</button>
    </div>`).join('');
  const src = $('#plan-source'); if(src) src.textContent = r.source === 'ai' ? '루미' : '기본';
  // ★ v1.50: 왜 이 계획인지 한 줄. «루미가 어제 막힌 곳을 기억한다» 를 눈으로 보게 한다.
  const pf = $('#plan-focus');
  if(pf){
    if(r.focus && r.focus.label){
      pf.textContent = `🧠 ${r.focus.reason} · ${r.focus.label}`;
      pf.className = 'plan-focus' + (r.focus.kind === 'mood' ? ' mood' : '');
    }else{ pf.className = 'plan-focus hidden'; pf.textContent = ''; }
  }
  const prog = $('#plan-progress'); if(prog) prog.textContent = `${r.done||0}/${steps.length} 완료`;
  $$('#plan-list [data-plan-done]').forEach(cb=>cb.addEventListener('change', ()=>togglePlanStep(cb.dataset.planDone, cb.checked)));
  $$('#plan-list [data-plan-start]').forEach(b=>b.addEventListener('click', ()=>startPlanStep(b.dataset.planStart)));
  try{ showPlanNudge(); }catch(e){}
  try{ renderToday3(); }catch(e){}
}
async function togglePlanStep(id, done){
  try{
    const r = await api('/api/plan/step', { stepId:id, done });
    state.plan = r;
    renderPlan();
    if(r.balance != null){ state.user.cell_balance = r.balance; setBalance(r.balance); }
    if(r.reward) toast(`🎉 오늘의 계획 완료! +${r.reward}셀`);
  }catch(e){ toast(e.message); }
}
async function startPlanStep(id){
  const s = state.plan && state.plan.plan && state.plan.plan.steps.find(x=>x.id === id);
  if(!s) return;
  state.lastPlanStep = id;
  if(s.type === 'puzzle'){ openPuzzle(); return; }
  if(s.type === 'game'){ goNav('games'); return; }
  await chatOpen();
  // ★ v1.50: 기분이 가라앉은 날의 «3분 이야기» 는 학습 모드가 아니라 수다 모드로 연다.
  chatModeSet(s.type === 'chat' ? 'chat' : 'learn');
  const input = $('#chat-text');
  if(input) input.value = s.message || `${s.title} 같이 볼까?`;
  sendChat(false);
}

// ---- 주간 목표 + 학습 설정 (2026-10-28) ----
async function loadGoals(){
  const box = $('#goals-list');
  if(box && !state.goals) box.innerHTML = '<div class="hint">이번 주 목표를 준비하고 있어요…</div>';
  try{
    const r = await api('/api/goals/week');
    state.goals = r;
    renderGoals();
    if(!state.goalToastShown && r.allDone){ state.goalToastShown = true; toast('🎉 이번 주 목표를 모두 달성했어!'); }
  }catch(e){
    if(box) box.innerHTML = '<div class="hint">목표를 불러오지 못했어요.</div>';
  }
}
function renderGoals(){
  const r = state.goals, box = $('#goals-list');
  if(!box || !r) return;
  const rows = (r.goals||[]).map(g=>{
    const pct = Math.round((g.progress / Math.max(1, g.target)) * 100);
    return `<div class="goal-row ${g.done?'done':''}">
      <div class="goal-top"><b>${esc(g.title)}</b><span>${g.progress}/${g.target}${esc(g.unit||'')}</span></div>
      <div class="goal-bar"><i style="width:${Math.min(100,pct)}%"></i></div>
    </div>`;
  }).join('');
  // ★ v1.59: 보상 문장은 패널 하단(#week-reward) 한 곳에만 — 통합 패널에서 중복 노출을 막는다.
  let extra = '';
  if(r.allDone && !r.claimed) extra = '<button id="goal-claim" class="btn primary goal-claim">🎁 주간 보상 +30셀</button>';
  else if(r.claimed) extra = '<div class="goal-done">🎉 이번 주 목표 달성! 보상 받았어요</div>';
  box.innerHTML = rows + extra;
  const src = $('#goals-source'); if(src) src.textContent = r.source === 'ai' ? '루미' : '기본';
  const prog = $('#goals-progress'); if(prog) prog.textContent = `${r.done||0}/${(r.goals||[]).length} 달성`;
  // ★ v1.59: 통합 패널의 보상 문장도 함께 갱신한다.
  const wr = $('#week-reward');
  if(wr) wr.textContent = r.claimed ? '🎉 주간 목표 달성! 보상 받았어요'
    : (r.allDone ? '🎉 모두 달성했어! 보상을 받아 줘' : '3개 모두 달성하면 +30셀');
  $('#goal-claim')?.addEventListener('click', claimGoals);
  try{ renderToday3(); }catch(e){}
}
async function claimGoals(){
  try{
    const r = await api('/api/goals/claim', {});
    if(r.balance != null){ state.user.cell_balance = r.balance; setBalance(r.balance); }
    toast(r.already ? '이미 보상을 받았어요' : `🎉 주간 보상 +${r.reward}셀!`);
    loadGoals();
  }catch(e){ toast(e.message); }
}
async function openPrefs(){
  $('#prefs-modal').classList.remove('hidden');
  loadLLMUsage();
  try{
    const p = await api('/api/prefs');
    state.prefs = p;
    renderPrefs();
  }catch(e){ toast(e.message); }
}
// ★ v1.67 «오늘의 3가지» — 흩어져 있던 «오늘 뭘 하지» 를 한 카드로 모은다.
function renderToday3(){
  const box = $('#today3'); if(!box) return;
  const steps = (state.plan && state.plan.plan && state.plan.plan.steps) || [];
  const nextStep = steps.find(s => !s.done);
  const goals = (state.goals && state.goals.goals) || [];
  const nextGoal = goals.find(g => !g.done);
  const rows = [];
  // ★ v1.71.2: «기억 등불 / 안개 탑» 을 첫 화면으로 — 1.71 의 새 주 루프를 아이가 바로 본다.
  // ★ 2026-11-21 (v1.74) A3 계약: /api/next-action 이 { kind:'tower', fogCount } 를 내주면
  //   «오늘 할 일» 첫 칸을 탑 타일(uiIcon('tower') + 안개 속의 탑 + 흐린 등불 N개)로 대체한다.
  //   탑을 다 깬 뒤에는 서버 next-action 이 다른 걸 내주므로 자연히 원래 로직으로 돌아온다.
  const na = state.nextAction;
  const lamps = (state.lamps && state.lamps.lamps) || [];
  if(na && na.kind === 'tower'){
    const fogN = (na.fogCount != null) ? Number(na.fogCount)
      : lamps.filter(l=>(Number(l.decay)||0) >= 30).length;
    rows.push({ n:'1', title:'안개 속의 탑', meta:`흐린 등불 ${fogN}개`, icon: uiIcon('tower', 18),
      act: ()=>openTower() });
  }else if(!lamps.length){
    rows.push({ n:'1', title:'루미에게 오늘 배운 걸 가르쳐 주기', meta:'가르치면 «기억 등불» 이 켜져요',
      act: ()=>{ chatOpen(); chatModeSet('learn'); } });
  }else{
    const worst = lamps.reduce((a,b)=>Number(b.decay) > Number(a.decay) ? b : a, lamps[0]);
    rows.push({ n:'1', title:'안개 속의 탑 도전', meta:`기억 등불 ${lamps.length}개 · «${worst.topic}» ${Number(worst.decay)||0}% 흐림`,
      act: ()=>openTower() });
  }
  if(nextStep) rows.push({ n:'2', title: nextStep.title, meta: `${nextStep.minutes}분 · 계획`, act: ()=>startPlanStep(nextStep.id) });
  if(state.reviewDue > 0) rows.push({ n:'3', title: `복습 카드 ${state.reviewDue}장`, meta: '3일 전 틀린 문제', act: ()=>openReview() });
  if(nextGoal) rows.push({ n:'4', title: nextGoal.title, meta: `이번 주 ${nextGoal.progress}/${nextGoal.target}`, act: ()=>{
    const tab = document.querySelector('[data-room-tab="today"]'); if(tab) tab.click();
    setTimeout(()=>{ const w=$('.week-panel'); if(w) w.scrollIntoView({behavior:'smooth', block:'center'}); }, 140);
  }});
  if(!rows.length){ box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = `<div class="t3-head"><h3>오늘 할 일</h3><span class="t3-count">${Math.min(4, rows.length)}개</span></div>
    <div class="t3-list">${rows.slice(0,4).map((r,i)=>`
      <button class="t3-row" data-t3="${i}">
        ${r.icon ? `<span class="t3-num t3-ico">${r.icon}</span>` : `<span class="t3-num">${i+1}</span>`}
        <span class="t3-text"><b>${esc(r.title)}</b><span>${esc(r.meta||'')}</span></span>
        <span class="t3-go">→</span>
      </button>`).join('')}</div>`;
  $$('#today3 [data-t3]').forEach(b=>b.addEventListener('click', ()=>rows[Number(b.dataset.t3)].act()));
}

/* v1.67: 상단 기능 6개를 «⋯» 로 접고, 좁은 화면에서는 오늘 패널을 드로어로 */
// ★ v1.72 «사용법 + 바로 체험» — 발표 때 5분 걸리던 흐름을 10초로.
function setupGuideV172(){
  const close = ()=>{ const m = $('#guide-modal'); if(m) m.classList.add('hidden'); };
  $('#btn-guide')?.addEventListener('click', ()=>{ const m = $('#guide-modal'); if(m) m.classList.remove('hidden'); });
  $('#guide-close')?.addEventListener('click', close);
  $('#guide-demo')?.addEventListener('click', async ()=>{
    try{
      await api('/api/demo/lamps', {});
      close();
      await loadLamps(true);
      await openTower();
    }catch(e){ toast(e.message || '체험을 시작하지 못했어요'); }
  });
}

function setupLayoutV167(){
  const more = $('#btn-more'), menu = $('#actions-menu');
  if(more && menu){
    more.addEventListener('click', e=>{
      e.stopPropagation();
      const open = menu.classList.toggle('hidden') === false;
      more.setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', e=>{
      if(!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== more){
        menu.classList.add('hidden'); more.setAttribute('aria-expanded','false');
      }
    });
  }
  const start = $('#btn-today-start');
  if(start) start.addEventListener('click', async ()=>{ await chatOpen(); chatModeSet('learn'); });
  const handle = $('#side-handle');
  if(handle) handle.addEventListener('click', ()=>document.body.classList.toggle('side-open'));
}

// ★ v1.66: «얼마나 아꼈나» 를 설정 화면에 숫자로 보여준다.
async function loadLLMUsage(){
  const box = $('#llm-usage'); if(!box) return;
  try{
    const r = await api('/api/llm/usage');
    const t = r.today || {};
    const n = v => Number(v || 0).toLocaleString('ko-KR');
    box.innerHTML = `<b>LLM 사용량</b>
      <div class="llm-row"><span>오늘</span><span>${n(t.calls)}회 · ${n(t.totalTokens)}토큰</span></div>
      <div class="llm-row"><span>턴당 평균</span><span>${n(r.avgPerTurn)}토큰</span></div>
      <div class="llm-row"><span>이번 주</span><span>${n(r.weekTotal)}토큰</span></div>
      <div class="llm-save">v1.51 대비 -${n(r.savedPct)}% 절약 (기준 ${n(r.baselinePerTurn)}토큰/턴)</div>`;
  }catch(e){
    box.innerHTML = '<span class="hint">LLM 사용량을 불러오지 못했어요.</span>';
  }
}
function renderPrefs(){
  const p = state.prefs || { minutes:10, time:'afternoon', subjects:[], difficulty:'normal' };
  $$('#pref-minutes button').forEach(b=>b.classList.toggle('on', Number(b.dataset.min) === Number(p.minutes)));
  $$('#pref-time button').forEach(b=>b.classList.toggle('on', b.dataset.time === p.time));
  $$('#pref-diff button').forEach(b=>b.classList.toggle('on', b.dataset.diff === p.difficulty));
  $$('#pref-subjects button').forEach(b=>b.classList.toggle('on', (p.subjects||[]).includes(b.dataset.subject)));
}
async function savePrefs(){
  const p = state.prefs; if(!p) return;
  try{
    const r = await api('/api/prefs', { minutes:p.minutes, time:p.time, subjects:p.subjects||[], difficulty:p.difficulty });
    state.prefs = r;
    $('#prefs-modal').classList.add('hidden');
    state.plan = null; state.goals = null;
    toast('학습 설정을 저장했어요. 계획을 다시 질게요!');
    // ★ 2026-11-21 (v1.74) C7 «루미 생각 중»: 계획을 새로 짜는 동안(서버 LLM 시간) 상단에
    //   생각 중 바를 띄운다 — 모달·입력을 막지 않는 상단横条 방식(채팅 스트리밍에는 미적용).
    withThinking(Promise.all([loadPlan(), loadGoals()]), { label:'루미가 새 계획을 짜고 있어…' });
  }catch(e){ toast(e.message); }
}

// ---- AI 전용 기억 (2026-10-31) ----
const MEM_LABELS = { fact:'사실', preference:'선호', learning:'학습', goal:'목표', event:'일정' };
async function refreshMemoryChips(){
  try{
    const r = await api('/api/memory');
    state.memories = r.memories || [];
    renderChatChips();
  }catch(e){}
}
async function refreshReviewChip(){
  try{
    const r = await api('/api/review/due');
    state.reviewDue = r.count || 0;
    if(r.cards) state.reviewCards = r.cards;
    renderChatChips();
  }catch(e){}
}
async function openReview(){
  try{
    const r = await api('/api/review/due');
    const cards = r.cards || [];
    if(!cards.length) return toast('지금 복습할 문제가 없어요');
    state.reviewCards = cards;
    state.reviewIndex = 0;
    $('#review-modal').classList.remove('hidden');
    renderReview();
  }catch(e){ toast(e.message); }
}
function renderReview(){
  const c = state.reviewCards[state.reviewIndex];
  if(!c){ $('#review-modal').classList.add('hidden'); return; }
  $('#review-topic').textContent = c.topic ? `${c.topic} · ${c.wrongCount}번 틀림` : `${c.wrongCount}번 틀린 문제`;
  $('#review-question').textContent = c.question;
  $('#review-options').innerHTML = (c.options||[]).map((o,i)=>
    `<button class="review-opt" data-opt="${i}">${esc(o)}</button>`).join('');
  $('#review-feedback').className = 'review-feedback';
  $('#review-feedback').textContent = '';
  $('#review-next').disabled = true;
  $$('#review-options [data-opt]').forEach(b=>b.addEventListener('click', ()=>answerReview(Number(b.dataset.opt))));
}
async function answerReview(choice){
  const c = state.reviewCards[state.reviewIndex];
  if(!c) return;
  try{
    const r = await api('/api/review/answer', { id:c.id, choice });
    if(r.correct){
      $$('#review-options .review-opt').forEach(b=>{
        b.disabled = true;
        if(Number(b.dataset.opt) === Number(choice)) b.classList.add('correct');
      });
      $('#review-feedback').className = 'review-feedback ok';
      $('#review-feedback').textContent = `정답! +${r.reward||5}셀${r.explain ? ' · ' + r.explain : ''}`;
      if(r.balance != null){ state.user.cell_balance = r.balance; setBalance(r.balance); }
      $('#review-next').disabled = false;
    } else {
      const b = $(`#review-options [data-opt="${choice}"]`);
      if(b) b.classList.add('wrong');
      $('#review-feedback').className = 'review-feedback bad';
      $('#review-feedback').textContent = '💡 ' + (r.hint || '한 번 더 생각해 보자.');
    }
  }catch(e){ toast(e.message); }
}
function nextReview(){
  state.reviewIndex++;
  if(state.reviewIndex >= state.reviewCards.length){
    $('#review-modal').classList.add('hidden');
    refreshReviewChip();
    return;
  }
  renderReview();
}
async function loadMemories(){
  $('#memory-modal').classList.remove('hidden');
  const box = $('#memory-list');
  box.innerHTML = '<div class="hint">불러오는 중…</div>';
  try{
    const r = await api('/api/memory');
    state.memories = r.memories || [];
    renderMemories();
  }catch(e){ box.innerHTML = `<div class="hint">${esc(e.message)}</div>`; }
}
function renderMemories(){
  const box = $('#memory-list');
  const list = state.memories || [];
  if(!list.length){
    box.innerHTML = '<div class="hint" style="text-align:center;padding:20px">아직 기억이 없어요. 대화를 하면 루미가 기억해요.</div>';
    return;
  }
  box.innerHTML = list.map(m=>`
    <div class="mem-item">
      <span class="mem-kind ${esc(m.kind)}">${MEM_LABELS[m.kind]||esc(m.kind)}</span>
      <div class="mem-body"><b>${esc(m.value)}</b><span>${esc(m.key)} · ${Math.round((Number(m.confidence)||0)*100)}%</span></div>
      <button class="mem-del" data-mem-del="${m.id}" title="삭제">✕</button>
    </div>`).join('');
  $$('#memory-list [data-mem-del]').forEach(b=>b.addEventListener('click', ()=>deleteMemory(Number(b.dataset.memDel))));
}
async function deleteMemory(id){
  try{
    const r = await api(`/api/memory/${id}`, null, 10000, 'DELETE');
    state.memories = r.memories || [];
    renderMemories();
    toast('기억을 지웠어요');
  }catch(e){ toast(e.message); }
}
async function addMemory(){
  const input = $('#memory-input');
  const value = ((input && input.value) || '').trim();
  if(!value) return toast('기억할 내용을 적어 주세요');
  const kind = ($('#memory-kind') && $('#memory-kind').value) || 'fact';
  try{
    const r = await api('/api/memory', { kind, key:'manual_'+Date.now(), value, confidence:0.9 });
    state.memories = r.memories || [];
    if(input) input.value = '';
    renderMemories();
    toast('루미가 기억했어요!');
  }catch(e){ toast(e.message); }
}
async function clearMemories(){
  if(!confirm('루미의 기억을 모두 지울까요?')) return;
  try{
    await api('/api/memory', null, 10000, 'DELETE');
    state.memories = [];
    renderMemories();
    toast('모든 기억을 지웠어요');
  }catch(e){ toast(e.message); }
}

// ---- 아이가 칠한 로봇을 대화 버튼/아바타에 표시 ----
function robotPalette(){
  const p = state.robot && state.robot.palette;
  if(!p) return {};
  if(typeof p === 'string'){ try{ return JSON.parse(p); }catch(e){ return {}; } }
  return p;
}
function updateChatFab(){
  const r = state.robot;
  if(!r) return;
  const pal = effectiveColors(r.template, robotPalette());
  const full = robotSVG(r.template, pal);
  // ★ v1.73: 38px 상자에는 전신 SVG 가 아니라 전용 «배지» 를 넣는다(찌그러짐·흰 여백 버그).
  const badge = botBadgeSVG(r.template, pal);
  ['#chat-head-avatar','#side-avatar'].forEach(sel=>{
    const el = $(sel); if(el) el.innerHTML = badge;
  });
  // 대화 버튼만 «작은 크기 전용 배지» 를 쓴다(54px 원에서도 표정이 읽히게).
  const fabBot = $('#chat-fab-bot'); if(fabBot) fabBot.innerHTML = badge;
  const sl = $('#side-level');
  if(sl) sl.textContent = `Lv.${(state.growth && state.growth.level) || 1}`;
}
function renderHeroBot(){
  const svg = robotSVG('doro', PAL_BASE.doro);
  const el = $('#hero-bot'); if(el) el.innerHTML = svg;
  if(!state.robot){
    const fab = $('#chat-fab-bot'); if(fab) fab.innerHTML = botBadgeSVG('doro', PAL_BASE.doro);
    const sa = $('#side-avatar'); if(sa) sa.innerHTML = svg;
  }
}
function displayName(n){ return String(n||'').replace(/^데모_/, ''); }
function syncSidebar(){
  if(state.user && state.user.nickname){
    const sn = $('#side-name'); if(sn) sn.textContent = displayName(state.user.nickname);
  }
  const sl = $('#side-level');
  if(sl) sl.textContent = `Lv.${(state.growth && state.growth.level) || 1}`;
  const tn = $('#tomorrow-note');
  if(tn){
    const st = (state.user && state.user.streak) || 0;
    tn.textContent = st > 0 ? `내일 오면 🔥${st+1}일 · 새 계획이 기다려` : '내일 오면 새 계획이 기다려';
  }
}
function showRevive(r){
  if(!r || !r.available) return;
  const el = $('#revive-streak'); if(el) el.textContent = `🔥${r.streak}`;
  $('#revive-modal').classList.remove('hidden');
}
async function acceptRevive(){
  try{
    const r = await api('/api/streak/revive', {});
    if(r.balance != null){ state.user.cell_balance = r.balance; setBalance(r.balance); }
    if(state.user) state.user.streak = r.streak;
    const ts = $('#top-streak'); if(ts) ts.textContent = `🔥${r.streak}`;
    const hs = $('#hud-streak'); if(hs) hs.textContent = `🔥${r.streak}`;
    $('#revive-modal').classList.add('hidden');
    syncSidebar();
    toast(`🔥 ${r.streak}일 연속을 되살렸어!`);
  }catch(e){ toast(e.message); }
}

// ---- 대화 패널 ----
async function chatOpen(){
  // v1.34: AI 마을이 열려 있으면 «세계를 나가지 않고» 그 위에서 대화한다(in-world 레이어).
  const ws = $('#world-screen');
  const inWorld = !!(ws && !ws.classList.contains('hidden'));
  const panel = $('#chat-panel');
  panel.classList.remove('hidden');
  panel.classList.toggle('in-world', inWorld);
  // ★ v1.48: 대화가 열리면 버튼은 «한 걸음 물러난» 상태가 된다(중복 클릭·가림 방지).
  const fab = $('#chat-fab');
  if(fab){ fab.classList.add('is-open'); fab.setAttribute('aria-expanded','true'); }
  if (ws) ws.classList.toggle('chatting', inWorld);
  // world.js 의 걷기 입력 잠금 상태를 맞춘다
  if (window.__worldState) window.__worldState.chatOpen = inWorld;
  $('#chat-text').focus();
  await loadChatHistory();
  refreshMemoryChips();
  refreshReviewChip();
  loadRoomState();
  setRobotMode('focus');   // ★ v1.60: focus 동안 로봇이 스스로 아이 곁으로 걸어와 기울어진다
}
function chatClose(){
  // ★ v1.51: 창을 닫으면 읽어주기와 «말 끊기» 감시도 함께 멈춘다(마이크가 남아 있지 않게).
  try{ window.speechSynthesis.cancel(); }catch(e){}
  stopBargeIn();
  const panel = $('#chat-panel');
  panel.classList.add('hidden');
  panel.classList.remove('in-world');
  const fab = $('#chat-fab');
  if(fab){ fab.classList.remove('is-open'); fab.setAttribute('aria-expanded','false'); }
  const ws = $('#world-screen'); if (ws) ws.classList.remove('chatting');
  if (window.__worldState) window.__worldState.chatOpen = false;
  setRobotMode('idle');    // ★ v1.58: 대화가 닫히면 다시 자유롭게
  stopStudyTimer();        // ★ v1.61: 학습 시간도 멈춘다
  // ★ 2026-11-21 (v1.74) C2: 대화 창을 «스스로 닫는» 것도 자연스러운 마무리 지점이다.
  notifyNaturalBreak();
}
function chatModeSet(mode){
  state.chatMode = mode;
  // ★ v1.61: «같이 공부» 모드에서만 학습 시간을 잰다.
  const panel = $('#chat-panel');
  const open = panel && !panel.classList.contains('hidden');
  if(open && mode === 'learn') startStudyTimer(); else stopStudyTimer();
  $$('.chat-modes .chip').forEach(b=>b.classList.toggle('on', b.dataset.mode===mode));
  // ★ v1.80: «답하는 방식» 은 같이 공부 모드에서만 의미가 있다.
  $('#chat-style')?.classList.toggle('hidden', mode !== 'learn');
  $('#chat-solved').classList.toggle('hidden', mode!=='learn');
  const hint = $('#chat-mode-hint');
  if(hint) hint.textContent = mode==='learn' ? '정답 대신 한 단계씩 같이 생각해요'
    : mode==='reflect' ? '판단 없이 마음을 들어요' : '편하게 이야기해요';
  renderChatChips();
}
function chatAdd(role, text, hint){
  const log = $('#chat-log');
  const d = document.createElement('div');
  d.className = 'msg ' + (role==='user' ? 'user' : (hint ? 'hint' : 'bot'));
  const span = document.createElement('span');
  span.textContent = text;
  d.appendChild(span);
  if(role !== 'user'){
    const sp = document.createElement('button');
    sp.className = 'msg-speak'; sp.title = '읽어주기'; sp.textContent = '🔊';
    sp.onclick = ()=>speak(text);
    d.appendChild(sp);
  }
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}
// ★ v1.51 «한 문장씩» — 20초를 기다렸다가 한 덩어리로 쏟아내면 읽을 엄두가 안 난다.
//   서버는 한 번에 만들지만 화면에는 문장 단위로 흘려보낸다(첫 문장이 먼저 도착한 것처럼 보인다).
function chatAddStream(role, text, hint){
  const d = chatAdd(role, '', hint);
  const span = d.querySelector('span');
  const full = String(text || '');
  const parts = full.match(/[^.!?\n]+[.!?]?/g) || [full];
  let i = 0;
  d.classList.add('streaming');
  const tick = ()=>{
    if(i >= parts.length){ d.classList.remove('streaming'); return; }
    span.textContent += (i ? ' ' : '') + parts[i++].trim();
    const log = $('#chat-log'); if(log) log.scrollTop = log.scrollHeight;
    setTimeout(tick, 85);
  };
  tick();
  const sp = d.querySelector('.msg-speak');
  if(sp) sp.onclick = ()=>speak(full);
  return d;
}
// ★ v1.54 «진짜 토큰 스트리밍» — SSE 의 delta 를 받는 즉시 화면에 붙인다.
//   기존 chatAddStream 은 «다 만든 뒤 85ms 간격으로 흉내» 였고, 이건 모델이 쓰는 대로 나온다.
function chatAddLive(role, hint){
  const d = chatAdd(role, '', hint);
  const span = d.querySelector('span');
  d.classList.add('streaming');
  return {
    el: d, span,
    push(t){
      span.textContent += t;
      const log = $('#chat-log'); if(log) log.scrollTop = log.scrollHeight;
    },
    end(full){
      d.classList.remove('streaming');
      const sp = d.querySelector('.msg-speak');
      if(sp && full) sp.onclick = ()=>speak(full);
    }
  };
}
async function chatStreamRequest(body, onDelta){
  const headers = { 'Content-Type':'application/json' };
  const tk = localStorage.getItem(SK.token);
  if(tk) headers['X-Token'] = tk;
  // ★ 60초 타임아웃 — SSE 가 멈추면 fetch/reader.read() 가 영원히 돌아오지 않아
  //   chatBusy 가 true 인 채로 남아 채팅 전체가 잠기는(말고 누르지도 못하는) 사고가 있었다.
  //   데이터가 도착할 때마다 타이머를 되돌려 «정상적으로 흐르는 중» 이면 끊지 않는다.
  const ac = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  let timer = null;
  const arm = ()=>{
    if(timer) clearTimeout(timer);
    if(ac) timer = setTimeout(()=>{ try{ ac.abort(); }catch(e){} }, 60000);
  };
  arm();
  try{
    const res = await fetch(API + '/api/chat/stream', { method:'POST', headers, body: JSON.stringify(body), signal: ac ? ac.signal : undefined });
    if(!res.ok || !res.body) throw new Error('stream ' + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', donePayload = null;
    while(true){
      const { done, value } = await reader.read();
      if(done) break;
      arm();
      buf += dec.decode(value, { stream:true });
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for(const part of parts){
        const line = part.trim();
        if(!line.startsWith('data:')) continue;
        let j = null;
        try{ j = JSON.parse(line.slice(5).trim()); }catch(e){ continue; }
        if(j.type === 'delta' && j.text) onDelta(j.text);
        else if(j.type === 'done') donePayload = j;
      }
    }
    if(!donePayload) throw new Error('stream no done');
    return donePayload;
  }finally{
    if(timer) clearTimeout(timer);
  }
}
// 반환: 'ok' | 'partial' | 'fail' — fail 은 «재전송 없이» 안내 문구만 보여준다(sendChat 참조).
async function chatStreamOnce(text, solved){
  let live = null, partial = '';
  let r = null;
  try{
    r = await chatStreamRequest({ mode: state.chatMode, message: text, solved: !!solved, style: state.answerStyle || 'auto' }, (d)=>{
      if(!live){ chatTyping(false); live = chatAddLive('assistant', false); }
      partial += d; live.push(d);
    });
  }catch(e){
    if(live){ live.end(partial); return 'partial'; }
    return 'fail';
  }
  chatTyping(false);
  const lvl = Number(r.hintLevel) || 0;
  if(!live) chatAdd('assistant', r.reply, lvl > 1);
  else live.end(r.reply || partial);
  // ★ 비스트리밍 경로와 같이 onend 를 넘긴다. 없으면 TTS 를 다 읽어도
  //   마이크가 다시 열리지 않아 «음성 대화가 한 번 하고 끊긴다».
  if(state.voiceAuto || state.voiceChat){
    speak(r.reply, ()=>{ if(state.voiceChat && !state.chatBusy) startMic(true); });
  }
  if(state.chatMode === 'learn' && lvl){
    const meta = document.createElement('div'); meta.className = 'msg-meta';
    const badge = document.createElement('span'); badge.className = 'hint-badge';
    // ★ 2026-11-20 (v1.72): 단계 표시를 «텍스트 + 3칸 등» 으로 — L1 은 1칸, L2 는 2칸, L3 은 모두 on.
    //   라벨 문구는 그대로 유지한다(서버·UI 어디서도 문구를 파싱하지 않지만, 아이에겐 익숙한 말).
    const lvlLabel = lvl === 1 ? 'L1 · 되묻기' : lvl === 2 ? 'L2 · 비유' : 'L3 · 다음 단계';
    badge.innerHTML = esc(lvlLabel) +
      `<i class="hb-dot${lvl >= 1 ? ' on' : ''}"></i><i class="hb-dot${lvl >= 2 ? ' on' : ''}"></i><i class="hb-dot${lvl >= 3 ? ' on' : ''}"></i>`;
    meta.appendChild(badge);
    if(lvl < 3){
      const more = document.createElement('button'); more.className = 'msg-more'; more.textContent = '힌트 한 단계 더';
      // ★ 서버 화이트리스트 의존: 이 고정 문구의 «한 단계 더» 를 보면 서버가
      //   힌트 단계를 바로 올려준다(모르겠/몰라 키워드만으로는 한 번에 안 올라감).
      //   → 버튼 문구를 바꿀 때 «한 단계 더» 를 반드시 포함시킬 것!
      more.onclick = ()=>{ const i=$('#chat-text'); if(i) i.value='힌트 한 단계 더 주세요'; sendChat(false); };
      meta.appendChild(more);
    }
    // 개념명이 비어도(카드 미매칭) 버튼은 보여 준다 — 화면이 «방금 배운 것» 으로 부른다.
    if(lvl >= 3 && r.explain){
      const ex = document.createElement('button'); ex.className = 'msg-more explain'; ex.textContent = '내 말로 설명하기';
      ex.onclick = ()=>startExplain(r.explain);
      meta.appendChild(ex);
      // ★ 2026-11-20 (v1.70): «루미가 틀려볼게» — 루미가 일부러 틀린 말을 하고 아이가 찾아내는 도전 놀이.
      //   «내 말로 설명하기» 옆에 나란히 놓는다. 설명할 개념(r.explain)이 있을 때만 —
      //   도전 카드의 재료가 될 «방금 배운 개념» 이 필요하기 때문.
      const tc = document.createElement('button'); tc.className = 'msg-more'; tc.textContent = '루미가 틀려볼게';
      tc.onclick = ()=>openTeachChallenge();
      meta.appendChild(tc);
    }
    const quiz = document.createElement('button'); quiz.className = 'msg-more'; quiz.textContent = '문제로 확인';
    quiz.onclick = ()=>openPuzzle();
    meta.appendChild(quiz);
    (live ? live.el : $('#chat-log')).appendChild(meta);
  }
  if(r.solved) setRobotMode('cheer');   // ★ v1.58: 스스로 해결한 순간 로봇이 같이 기뻐한다
  if(r.wrapUp) chatAdd('assistant', '⏳ ' + r.wrapUp, true);
  // ★ 2026-11-20 (v1.70): 좌절 감지 — 서버가 learn 모드에서만 보내는 신호.
  //   모드를 한 번 더 확인해 chat/reflect 모드에서는 절대 반응하지 않게 이중으로 막는다.
  //   로봇은 부드럽게 끄덕이고(존재하는 제스처: wave/nod/tilt/look/bounce/stretch 중 nod),
  //   쉬어가라는 다정한 알림을 띄운다. 판단 문구는 절대 붙이지 않는다.
  if(state.chatMode === 'learn' && r.frustration){
    robotGesture('nod');
    toast('루미: 잠깐 쉬어가자! 물 한 모금 마시고 올래?');
  }
  const und = $('#chat-und'); if(und) und.textContent = `이해도 ${r.understanding||0}`;
  const left = $('#chat-left');
  if(left) left.textContent = r.left > 0 ? `오늘 ${r.left}번 더 이야기할 수 있어요` : '오늘은 여기까지!';
  if(r.balance != null){ state.user.cell_balance = r.balance; setBalance(r.balance); }
  return 'ok';
}
function chatTyping(on){
  let t = $('#chat-typing');
  if(on && !t){
    t = document.createElement('div'); t.id='chat-typing'; t.className='typing';
    // ★ 2026-11-20 (v1.72): 점 세개 옆에 미니 루미(idle) — «누가 생각 중인지» 얼굴로 보여 준다.
    //   크기는 인라인으로 고정(CSS 는 .rumi-pose 클래스만 손봐도 된다).
    t.innerHTML = `<span class="rumi-pose" style="width:22px;height:22px;flex:0 0 auto">${rumiPose('idle',22)}</span>루미가 생각 중 <span class="dots"><i></i><i></i><i></i></span>`;
    $('#chat-log').appendChild(t); $('#chat-log').scrollTop = $('#chat-log').scrollHeight;
  } else if(!on && t){ t.remove(); }
}
async function loadChatHistory(){
  const log = $('#chat-log'); log.innerHTML='';
  try{
    const r = await api('/api/chat/history');
    (r.messages||[]).forEach(m=> chatAdd(m.role, m.content, Number(m.hint_level)>1));
    if(!(r.messages||[]).length){
      const p = state.plan && state.plan.plan;
      const idx = p && p.steps ? p.steps.findIndex(s=>!s.done) : -1;
      const first = idx >= 0 ? p.steps[idx] : null;
      if(first) chatAdd('assistant', `오늘의 계획 ${idx+1}단계: ${first.title}. 같이 시작해 볼까? 궁금한 게 있으면 언제든 말해!`);
      else chatAdd('assistant','안녕! 나는 루미야. 오늘 뭐 하고 놀았어? 공부에서 막히면 같이 생각해 보자!');
    }
  }catch(e){ chatAdd('assistant','안녕! 나는 루미야. 같이 이야기해 보자!'); }
  chatModeSet(state.chatMode);
}
function renderChatChips(){
  const chips = $('#chat-chips'); if(!chips) return; chips.innerHTML='';
  const base = state.chatMode==='learn'
    ? ['이거 어떻게 해?', '개념을 모르겠어', '내가 해봤어요']
    : state.chatMode==='reflect'
      ? ['오늘 기분이 이상해', '시험 때문에 속상해']
      : ['오늘 뭐 했어?', '같이 놀자', '칭찬해 줘'];
  const weak = (state.memories||[]).find(m=>m.kind==='learning' && String(m.key||'').startsWith('weak:'));
  const like = (state.memories||[]).find(m=>m.kind==='fact' && (String(m.key||'').startsWith('like:') || m.key==='like'));
  const extras = [];
  if(state.reviewDue > 0) extras.push('3일 전 틀린 문제');
  if(like) extras.push('내가 좋아하는 것');
  if(weak){
    const topic = String(weak.key).replace(/^weak:/,'');
    if(topic) extras.push(`${topic} 다시 보기`);
  }
  const list = [...extras, ...base];
  if(state.plan && state.plan.plan && !state.plan.allDone && !list.includes('오늘의 계획')) list.unshift('오늘의 계획');
  list.slice(0,6).forEach(t=>{
    const b=document.createElement('button'); b.textContent=t;
    b.onclick=()=>{
      if(t==='오늘의 계획'){
        const p = state.plan.plan;
        chatAdd('assistant', '오늘의 계획: ' + p.steps.map((s,i)=>`${i+1}. ${s.title}`).join(' / '));
        return;
      }
      if(t==='3일 전 틀린 문제'){
        openReview();
        return;
      }
      if(t==='내가 좋아하는 것'){
        chatModeSet('chat');
        $('#chat-text').value = '내가 좋아하는 것 기억나?';
        sendChat(false);
        return;
      }
      if(t.endsWith(' 다시 보기')){
        const topic = t.replace(' 다시 보기','');
        chatModeSet('learn');
        $('#chat-text').value = `${topic} 다시 알려줘`;
        sendChat(false);
        return;
      }
      if(t==='내가 해봤어요'){ chatSolved(); } else { $('#chat-text').value=t; sendChat(false); }
    };
    chips.appendChild(b);
  });
}
async function sendChat(solved){
  if(state.chatBusy) return;
  const input = $('#chat-text');
  const msg = (input.value||'').trim();
  if(!msg && !solved) return;
  // ★ v1.50: «내 말로 설명하기» 가 켜져 있으면 학습 질문이 아니라 설명으로 보낸다.
  if(state.explainMode && !solved){ return sendExplain(); }
  const text = solved ? '내가 해봤어요! 스스로 해결했어요.' : msg;
  if(!solved) input.value='';
  state.chatBusy = true;
  chatAdd('user', text);
  chatTyping(true);
  $('#chat-send').disabled = true;
  // ★ v1.54: 진짜 스트리밍을 먼저 시도한다.
  // ★ 2026-11-20: 스트리밍 실패 시 /api/chat 으로 «같은 메시지를 재전송» 하지 않는다.
  //   첫 delta 도 못 받고 실패했을 때 예전 폴백은 같은 메시지를 비스트리밍 경로로
  //   다시 보내 서버가 한 말을 두 번 처리했고(중복 과금), «오늘 대화 횟수» 도
  //   이중으로 깎였다. 이제 친절한 안내를 보여 주고 busy 를 풀어
  //   아이가 직접 다시 누르게 한다. 일부라도 받았으면(partial) 기존 처리를 유지한다.
  let streamState = 'fail';
  try{ streamState = await chatStreamOnce(text, solved); }catch(e){ streamState = 'fail'; }
  chatTyping(false);
  if(streamState === 'fail'){
    chatAdd('assistant', '잠깐 문제가 생겼어요. 다시 눌러줄래?');
    // ★ 2026-11-21 (v1.74) A1 «흘려보내기 실패 시 원문 복귀»: 첫 delta 도 못 받고 실패하면
    //   아이가 방금 쓴 메시지를 입력창에 «그대로 돌려놓는다» — 지워진 글자를 다시 치게 하지 않는다.
    //   «내가 해봤어요» 같은 자동 문장(solved) 은 아이가 친 게 아니므로 돌려놓지 않는다.
    //   일부라도 받았으면(partial) 화면에 나온 말이 있으므로 역시 건드리지 않는다.
    if(!solved){
      input.value = text;
      const end = input.value.length;
      try{ input.setSelectionRange(end, end); }catch(e){}
    }
  }
  state.chatBusy = false; $('#chat-send').disabled = false; input.focus();
  // ★ v1.74 A1: 커서를 문장 «끝» 으로 — focus 직후 타이핑이 뒤에 붙게 한다.
  if(streamState === 'fail' && !solved){
    const end = input.value.length;
    try{ input.setSelectionRange(end, end); }catch(e){}
  }
}
function chatSolved(){
  if(state.chatMode!=='learn') chatModeSet('learn');
  sendChat(true);
}
// ★ v1.50 «아이가 루미를 가르친다» — 설명은 채점하지 않는다.
//   루미는 아이가 쓴 표현을 그대로 되받고 한 가지만 묻는다. 그 설명은 taught 기억으로 남는다.
function startExplain(ex){
  state.explainMode = ex || {};
  const input = $('#chat-text'); if(!input) return;
  const concept = state.explainMode.concept || '방금 배운 것';
  input.value = '';
  input.placeholder = `${concept} 이야기를 네 말로 설명해 줘`;
  input.focus();
  chatAdd('assistant', `${concept} 이야기를 네 말로 설명해 줄래? 루미가 들을게.`, true);
}
async function sendExplain(){
  if(state.chatBusy) return;
  const ex = state.explainMode || {};
  const input = $('#chat-text');
  const text = (input.value || '').trim();
  if(text.length < 8){ toast('조금만 더 자세히 설명해 줄래?'); return; }
  state.chatBusy = true;
  input.value = '';
  chatAdd('user', text);
  chatTyping(true);
  $('#chat-send').disabled = true;
  try{
    const r = await api('/api/chat/explain', { concept: ex.concept, text }, 35000);
    chatTyping(false);
    chatAdd('assistant', r.reply, true);
    // ★ 2026-11-21 (v1.71) «함께 가르친 친구» — explain 응답에 coTaught 가 오면 루미가 축하 한 줄을 덧붙인다.
    //   chatAdd 는 내부에서 textContent 로 넣으므로 닉네임이 HTML 로 새지 않는다.
    if(r && r.coTaught){
      chatAdd('assistant', `«${r.coTaught}» 도 이 개념을 가르쳐 줬어! 너희 둘 다 «${ex.concept || '이 개념'}» 선생님이네 👯`, true);
    }
    // ★ 2026-11-21 (v1.74) B1 삼막 1막: 계약 필드 firstLamp:true — 첫 기억 등불의 탄생 순간.
    //   전체 화면 축하 + 등불 판넬 자동 열기 + 첫 등불 탄생 애니메이션.
    if(r && r.firstLamp) celebrateFirstLamp();
    if(state.voiceAuto || state.voiceChat) speak(r.reply);
    state.explainMode = null;
    input.placeholder = '루미에게 말을 걸어 보세요';
    toast('🧠 네 설명을 루미가 기억했어');
  }catch(e){
    chatTyping(false);
    chatAdd('assistant', e.message || '설명을 받지 못했어. 다시 해 볼까?');
  }finally{
    state.chatBusy = false;
    $('#chat-send').disabled = false;
    input.focus();
  }
}

// ★ 2026-11-20 (v1.70) «루미가 틀려볼게» — 루미가 방금 배운 개념으로 두 말을 하고,
//   한 개는 일부러 틀렸다. 아이가 틀린 말을 골라내면 «가르친 사람» 이 된 기분을 맛본다.
//   정답이면 서버가 mastery 를 올려 준다(bumpMastery 는 서버 몫 — 화면은 결과만 보여 준다).
async function openTeachChallenge(){
  let c = null;
  try{
    // 404(아직 배운 개념이 없음) / 429(오늘 도전 3번 소진) → 서버 error 문구를 그대로 채팅에 보여 준다.
    // ★ 2026-11-21 (v1.74) C7 «루미 생각 중»: GET 이 도는 동안 상단에 생각 중 바가 떠 있다
    //   (입력은 막지 않는다 — 채팅 스트리밍에는 절대 쓰지 않는다).
    c = await withThinking(api('/api/teach/challenge', null, 15000), { label:'루미가 도전을 준비 중…' });
  }catch(e){
    chatAdd('assistant', e.message || '도전을 시작하지 못했어. 잠시 후 다시 해 볼래?', true);
    return;
  }
  // ★ 낡은 서버 응답(필드가 비어 있음)에서도 조용히 넘어간다 — 화면이 깨지면 안 된다.
  const st = (c && Array.isArray(c.statements)) ? c.statements.filter(s=>s && s.text) : [];
  if(!c || !c.concept || st.length < 2){
    chatAdd('assistant', '지금은 도전 준비 중이에요. 조금 뒤에 다시 눌러 줄래?', true);
    return;
  }
  // 채팅 말풍선 스타일 그대로(assistant) + 안에 보기 블록을 얹는다. 읽어주기(🔊) 버튼도 같이 생긴다.
  const card = chatAdd('assistant', `루미가 «${c.concept}» 에 대해 두 말을 할게. 한 개는 틀렸어 — 어떤 게 틀렸을까?`);
  // ★ 2026-11-21 (v1.71): 정답 카드가 «함께 가르친 친구» 를 보여 주려면 개념명이 필요하다.
  //   answerTeachChallenge 는 이 카드 DOM 만 받으므로 dataset 에 슬쩍 붙여 둔다.
  card.dataset.concept = c.concept;
  const opts = document.createElement('div');
  opts.className = 'pz-options';   // ★ 오늘의 퍼즐 보기 스타일 재사용 — correct/wrong 색까지 그대로
  const btns = {};
  st.forEach(s=>{
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = s.text;
    b.onclick = ()=>answerTeachChallenge(card, btns, s.id);
    btns[s.id] = b;
    opts.appendChild(b);
  });
  card.appendChild(opts);
  const log = $('#chat-log'); if(log) log.scrollTop = log.scrollHeight;
}
async function answerTeachChallenge(card, btns, choice){
  // 카드는 한 번만 쓴다 — 답한 뒤에는 버튼이 눌리지 않게 잠근다.
  if(!card || card.dataset.done === '1') return;
  card.dataset.done = '1';
  Object.keys(btns).forEach(k=>{ if(btns[k]) btns[k].disabled = true; });
  let r = null;
  try{
    r = await api('/api/teach/challenge/answer', { choice });
  }catch(e){
    // 서버 사정(429 등)이면 버튼을 다시 열어 곧바로 재시도하게 한다.
    delete card.dataset.done;
    Object.keys(btns).forEach(k=>{ if(btns[k]) btns[k].disabled = false; });
    chatAdd('assistant', e.message || '도전을 확인하지 못했어. 다시 눌러 볼래?', true);
    return;
  }
  const pick = btns[choice];
  const isOk  = !!(r && r.correct === true);   // ★ 필드가 없는(낡은) 응답이면 색을 칠하지 않는다
  const isNo  = !!(r && r.correct === false);
  if(isOk){
    if(pick) pick.classList.add('correct');
    // robotGesture('cheer') 는 없는 제스처다(wave/nod/tilt/look/bounce/stretch 만 있음).
    // → 통통 뛰는 bounce 를 제스처로 쓰고, «정답 순간» 관례인 setRobotMode('cheer')(점프)를 함께 부른다.
    robotGesture('bounce');
    setRobotMode('cheer');
  }else if(isNo){
    if(pick) pick.classList.add('wrong');
    const ok = (r && r.correctChoice) ? btns[r.correctChoice] : null;
    if(ok) ok.classList.add('correct');
    robotGesture('nod');   // 혼내는 게 아니라 «괜찮아» 하고 끄덕여 준다
  }
  const fb = document.createElement('div');
  fb.className = 'pz-hint';   // ★ 퍼즐 힌트 상자 스타일 재사용
  const why = (r && r.why) ? String(r.why) : '';
  fb.textContent = isOk ? `정답! 👏 ${why}`
    : isNo ? `${why} 틀린 걸 찾은 것도 공부야! 다음엔 더 빨리 볼 수 있을 거야.`
    : (why || '루미가 다시 생각해 볼게!');
  card.appendChild(fb);
  // ★ 2026-11-21 (v1.71) «함께 가르친 친구» — 서버가 coTaught(친구 닉네임)를 보내주면
  //   한 줄을 더 얹는다. 필드가 없는(낡은) 응답이면 아무것도 추가하지 않는다(우아한 하락).
  //   칭찬은 정답·오답 무관하게 — «가르친 사람» 이 둘이라는 사실 자체가 선물이니까.
  const coTaught = (r && r.coTaught) ? String(r.coTaught) : '';
  if(coTaught){
    const co = document.createElement('div');
    co.className = 'co-taught';
    co.textContent = `«${coTaught}» 도 이 개념을 가르쳐 줬어! 너희 둘 다 «${card.dataset.concept || ''}» 선생님이네 👯`;
    card.appendChild(co);
  }
  // ★ 2026-11-21 (v1.74) B1 삼막: 계약 필드 firstLamp(첫 등불) / crystalNow(첫 수정화).
  //   3막은 ««X» 가 수정 구슬이 됐어!» 축하 + «마을에서 구슬 보기» 제안까지 이어진다.
  const conceptName = String(card.dataset.concept || '');
  if(r && r.firstLamp) celebrateFirstLamp();
  if(r && r.crystalNow){
    showCelebrate(`«${conceptName || '이 개념'}» 가 수정 구슬이 됐어! 이제 안개도 못 잊게 해.`,
      null, { label:'마을에서 구슬 보기', go:()=>{ const b = $('#btn-world'); if(b) b.click(); } });
    obMark('act3');
  }
  const log = $('#chat-log'); if(log) log.scrollTop = log.scrollHeight;
}

// ============================================================
// ★ 2026-11-21 (v1.71) «기억의 수호자» — 기억 등불 · 안개 속의 탑 · 루미 NPC 루틴
//   루미는 아이가 «가르쳐 준 것» 을 등불로 밤새 켜 둔다. 그러나 매일 밤 안개가 등불을 흐리게 하고,
//   아이는 «안개 속의 탑» 에 올라 안개가 왜곡한 말을 골라내며 등불을 지킨다.
//   3번 다지기가 끝난 개념은 «수정 구슬» 이 되어 안개에 영원히 면역이다(서버가 판정).
// ============================================================

// ---------- ① 기억 등불 판넬 (성장 탭) ----------
let _lampsAt = 0;   // 마지막 /api/lamps 호출 시각 — loadRoomState 와 setRoomTab 이 겹쳐 부르는 것을 막는다

async function loadLamps(force){
  // 2초 안에 다시 불리면 건너뛴다(마이룸 진입 + 탭 전환이 같은 순간에 겹칠 때)
  if(!force && Date.now() - _lampsAt < 2000) return;
  _lampsAt = Date.now();
  const panel = $('#lamp-panel'); if(!panel) return;
  // ★ 2026-11-20 (v1.72): await 동안 스켈레톤 — 판넬이 열리기 전에 미리 자리를 잡아 둔다.
  //   실패 시에는 v1.71 의 «조용히 물러남» 을 그대로 존중한다(빈 화면을 억지로 얹지 않는다).
  //   ★ v1.74 C4: loadLamps 는 조용한 실패를 «의도» 로 유지한다 — retryFn 을 넘기지 않는다.
  fillSkeleton($('#lamp-list'), 3);
  let r = null;
  try{ r = await api('/api/lamps', undefined, 9000, 'GET'); }
  catch(e){ return; }   // 실패는 조용히 — 판넬은 감춰진 채, 성장 탭의 나머지가 막히지 않는다
  if(!r || !Array.isArray(r.lamps)) return;
  // overplay «내일 약속» 문장도 이 스냅샷을 쓴다 — 잠금 시점엔 다시 요청할 수 없으므로
  state.lamps = r;
  renderLamps(r);
  // ★ 2026-11-21 (v1.74) B1 삼막 2막: 계약 필드 sosFirst(«안개를 처음 겪음» 1회 전달).
  //   안개와 탑을 소개하는 액트 바를 세운 뒤 탑을 «자동으로» 열어 준다.
  if(r.sosFirst && obMark('act2')){
    showAct(2, ['루미의 기억이 안개에 잊혀져 가…', '안개 속의 탑으로 되찾아 줘!'],
      { label:'탑으로 가기', go:()=>openTower() });
    setTimeout(()=>{ try{ openTower(); }catch(e){} }, 1500);
  }
}

// ── ①-1 보관함 통계 바 (계약: teachCount · nextBadge) ──
function renderLampStats(r, lamps){
  const box = $('#lamp-stats'); if(!box) return;
  const teach = Number(r.teachCount) || 0;
  const crystals = lamps.filter(l=>Number(l.crystal)).length;
  const nb = r.nextBadge || null;
  const have = nb ? Math.min(Number(nb.have)||0, Number(nb.at)||10) : 0;
  const at = nb ? Number(nb.at)||10 : 0;
  const pct = nb ? Math.min(100, Math.round((have/at)*100)) : 100;
  box.classList.remove('hidden');
  box.innerHTML =
    `<span class="ls-item">총 <b>${teach}</b>개 가르침</span>` +
    `<span class="ls-item">${uiIcon('crystal',13)} <b>${crystals}</b>개</span>` +
    `<span class="ls-badge">${nb ? `다음 배지 ${have}/${at}` : '배지 모두 완료 🏆'}</span>` +
    `<span class="ls-bar"><i style="width:${pct}%"></i></span>`;
}

// ── ①-2 격자(기존 등불 행) — blockedBy 표시 + «다시 가르쳐 주기» 클릭(A2 ②) ──
function lampFlameClass(l){
  const d = (Number(l.decay) != null && isFinite(Number(l.decay))) ? Number(l.decay) : 0;
  return l.crystal ? 'is-crystal' : (d >= 70 ? 'is-dim' : (d >= 30 ? 'is-fog' : 'is-bright'));
}
function lampDecayOf(l){
  return (Number(l.decay) != null && isFinite(Number(l.decay))) ? Number(l.decay) : 0;
}
function renderLampGrid(lamps){
  const list = $('#lamp-list'); if(!list) return;
  list.innerHTML = lamps.map((l, i)=>{
    // ★ 2026-11-20 (v1.72): 이모지 아이콘(💎💡🌫️😢) → «불꽃 DOM» 으로 교체.
    //   스타일 담당이 그리는 클래스: is-crystal(수정) · is-bright(0~29) · is-fog(30~69) · is-dim(70+)
    const d = lampDecayOf(l);
    const flameCls = lampFlameClass(l);
    // «수정 구슬» 배지 — 3번 다지기를 마쳐 안개에 면역이 된 등불
    const badge = l.crystal ? '<span class="lamp-badge">수정 구슬</span>' : '';
    // 🛡️ — 오늘 탑에서 이미 안개를 견뎠다(immune) 는 표시
    const shield = l.immune ? '<span class="lamp-shield" title="오늘 안개를 견뎠어요">🛡️</span>' : '';
    // ★ 2026-11-21 (v1.74) A2 ②: blockedBy(선수개념이 안개에 잠김) 가 있으면 «먼저 «X» 부터!»
    //   작은 글자를 보여 주고 «누를 수 없다». 흐릿한(is-fog 30~69 · is-dim 70+) 등불 행은
    //   행 전체가 goTeach 버튼이 된다(밝은 등불·수정 구슬은 다시 가르칠 필요가 적어 제외).
    const blocked = l.blockedBy ? String(l.blockedBy) : '';
    const teachable = !l.crystal && !blocked && d >= 30;
    // B1 첫 등불 탄생 애니메이션 — celebrateFirstLamp 이 남긴 플래그를 첫 행의 불꽃이 소비한다
    const born = (state._lampBorn && i === 0) ? ' is-born' : '';
    return `<div class="lamp-row${l.crystal ? ' crystal' : ''}${teachable ? ' teachable' : ''}"` +
        `${teachable ? ` data-topic="${esc(l.topic)}" title="눌러서 루미에게 다시 가르쳐 주기"` : ''}>` +
      `<span class="lamp-flame ${flameCls}${born}"></span>` +
      `<span class="lamp-topic">${esc(l.topic)}</span>${badge}${shield}` +
      `${blocked ? `<span class="lamp-blocked">먼저 «${esc(blocked)}» 부터!</span>` : ''}</div>`;
  }).join('');
}

// ── ①-3 목록 보기 (C3) — 아이콘 + 주제 + 재교 n/3 + 상태 칩 + blockedBy + 클릭 goTeach ──
function renderLampList(lamps){
  const box = $('#lamp-listview'); if(!box) return;
  box.innerHTML = lamps.map(l=>{
    const d = lampDecayOf(l);
    const flameCls = lampFlameClass(l);
    const blocked = l.blockedBy ? String(l.blockedBy) : '';
    const teachable = !blocked;   // 목록에선 수정 구슬도 «다지기» 로 다시 가르칠 수 있다
    const chip = l.crystal ? '<span class="lamp-state st-crystal">수정</span>'
      : d >= 70 ? '<span class="lamp-state st-dim">위험</span>'
      : d >= 30 ? '<span class="lamp-state st-fog">흐림</span>'
      : '<span class="lamp-state st-bright">밝음</span>';
    return `<div class="lamp-li${teachable ? ' teachable' : ''}"` +
        `${teachable ? ` data-topic="${esc(l.topic)}" title="눌러서 루미에게 다시 가르쳐 주기"` : ''}>` +
      `<span class="lamp-flame ${flameCls}"></span>` +
      `<span class="lamp-li-topic">${esc(l.topic)}</span>` +
      `<span class="lamp-li-meta">재교 ${Math.min(3, Number(l.reinforce)||0)}/3</span>${chip}` +
      `${blocked ? `<span class="lamp-blocked">먼저 «${esc(blocked)}» 부터!</span>` : ''}</div>`;
  }).join('');
}

function renderLamps(r){
  const panel = $('#lamp-panel'); if(!panel) return;
  panel.classList.remove('hidden');
  const lampsAll = (r.lamps || []).filter(l => l && l.topic);
  const cnt = $('#lamp-count'); if(cnt) cnt.textContent = `${lampsAll.length}개`;
  // ★ 2026-11-21 (v1.74) C3 «기억 보관함»: 정렬 칩 — 최신(litDay 내림) / 위험(decay 내림) / 수정 먼저.
  //   서버가 주는 decay 내림 기본 정렬은 «최신» 선택 시 litDay 로 다시 정렬한다.
  const sort = state.lampSort || 'recent';
  const lamps = lampsAll.slice().sort((a,b)=>{
    if(sort === 'risk') return lampDecayOf(b) - lampDecayOf(a);
    if(sort === 'crystal') return (Number(b.crystal)||0) - (Number(a.crystal)||0) || lampDecayOf(b) - lampDecayOf(a);
    return String(b.litDay||'').localeCompare(String(a.litDay||''));
  });
  // 보기 전환 — 격자/목록 중 한쪽만 보인다
  const view = state.lampView || 'grid';
  const grid = $('#lamp-list'), listbox = $('#lamp-listview');
  if(grid) grid.classList.toggle('hidden', view !== 'grid');
  if(listbox) listbox.classList.toggle('hidden', view !== 'list');
  renderLampStats(r, lampsAll);
  renderLampGrid(lamps);
  renderLampList(lamps);
  state._lampBorn = false;   // 탄생 애니메이션은 1회만
  const sos = $('#lamp-sos');
  if(sos){
    const s = (r.sos && r.sos.topic) ? String(r.sos.topic) : '';
    if(s){ sos.textContent = `🌫️ 안개가 «${s}» 등불을 가장 많이 흐리고 있어요!`; sos.classList.remove('hidden'); }
    else { sos.textContent = ''; sos.classList.add('hidden'); }
  }
  const has = lampsAll.length > 0;
  const empty = $('#lamp-empty'); if(empty) empty.classList.toggle('hidden', has);
  const btn = $('#btn-tower');
  if(btn){
    btn.disabled = !has;
    btn.title = has ? '하루 한 번, 오늘의 안개를 물리쳐 보자!' : '루미에게 가르친 게 아직 없어요';
  }
  try{ renderToday3(); }catch(e){}
}

// ---------- ② 안개 속의 탑 (하루 한 번) ----------
let _tw = null;               // 열려 있는 탑 세션 { data, idx, busy }
let _twTimers = [];           // «다음 층» 예약 setTimeout 들 — 창을 닫으면 반드시 비운다
let _twIntroShown = false;    // «구별해 줘!» 안내는 처음 들어올 때 한 줄만

function twClearTimers(){
  _twTimers.forEach(t => clearTimeout(t));
  _twTimers = [];
}
// clearedMask 비트 세기 — «n층 클리어» 표시용
function twCleared(n){
  let m = Number(n) || 0, c = 0;
  while(m > 0){ c += (m & 1); m >>= 1; }
  return c;
}
// 모든 층을 다 통과했는지 — ended 만 믿지 않고 마스크로도 확인한다(낡은 응답 대비)
function twAllDone(t){
  if(!t || !Array.isArray(t.floors) || !t.floors.length) return false;
  const all = (1 << t.floors.length) - 1;
  return ((Number(t.clearedMask) || 0) & all) === all;
}

async function openTower(){
  const modal = $('#game-tower'); if(!modal) return;
  twClearTimers();
  _tw = null;
  modal.classList.remove('hidden');
  // «구별해 줘!» 안내 — 처음 들어올 때 한 번만 보인다
  if(!_twIntroShown){ _twIntroShown = true; const hw = $('#tw-howto'); if(hw) hw.hidden = false; }
  const fl = $('#tw-floor'), body = $('#tw-question'), fb = $('#tw-feedback');
  if(fb) fb.classList.add('hidden');
  if(fl) fl.innerHTML = '';
  if(body) body.innerHTML = '<div class="tw-loading">🗼 탑을 불러오는 중…</div>';
  let t = null;
  try{ t = await api('/api/tower/today', undefined, 12000, 'GET'); }
  catch(e){
    // 기다리는 사이 창이 닫혔으면 조용히 물러난다(감춰진 모달에 그리지 않는다)
    if(modal.classList.contains('hidden')) return;
    // 404(아직 등불이 없다) · 429(오늘 도전 소진) — 서버 error 문구를 그대로 보여 준다
    twShowError(e.message);
    return;
  }
  if(modal.classList.contains('hidden')) return;   // 닫힌 뒤 도착한 응답은 무시한다
  if(!t || !Array.isArray(t.floors) || !t.floors.length){
    twShowError('지금은 탑이 준비되지 않았어요. 조금 뒤에 다시 올래?');
    return;
  }
  _tw = { data:t, idx:0, busy:false };
  // 이미 끝난 탑 — 전부 통과면 축하 화면, 중간에 끝났으면 «여기까지» 화면부터 시작한다
  if(twAllDone(t)) twShowVictory();
  else if(t.ended) twShowResult();
  else twRenderFloor();
}

function twShowError(msg){
  const body = $('#tw-question'); if(!body) return;
  body.innerHTML = `<div class="tw-error">🌫️ ${esc(msg || '탑을 불러오지 못했어요')}</div>`;
}

function twRenderFloor(){
  const t = _tw && _tw.data; if(!t) return;
  const fl = $('#tw-floor'), body = $('#tw-question'), fb = $('#tw-feedback');
  const total = t.floors.length;
  const cur = t.floors[Math.min(_tw.idx, total - 1)] || t.floors[total - 1];
  const mask = Number(t.clearedMask) || 0;
  // 층 표시 — 통과한 층 ✅, 지금 층은 번호로 강조, 주말이면 «안개 BOSS» 배지
  const dots = t.floors.map((f, i)=>{
    const done = (mask & (1 << i)) !== 0;
    const now = i === _tw.idx;
    return `<span class="tw-dot${done ? ' done' : ''}${now ? ' now' : ''}">${done ? '✅' : (now ? (i + 1) : '·')}</span>`;
  }).join('');
  if(fl) fl.innerHTML = `<span class="tw-count">${t.boss ? '<span class="tw-boss-badge">🌊 안개 BOSS</span>' : ''}<b>${(cur.floor || 0) + 1}층</b> / 총 ${total}층 · 하루 한 번</span><span class="tw-dots">${dots}</span>`;
  if(fb) fb.classList.add('hidden');
  if(!body) return;
  // 한 층 = «루미가 배운 말» 인지 «안개가 왜곡한 말» 인지 맞히기.
  // 보기 버튼은 퍼즐의 .pz-options 스타일을 그대로 재사용(correct/wrong 색까지).
  body.innerHTML = `
    <p class="tw-concept">«${esc(cur.concept || '')}» 에 대해 루미가 말하는 문장이야</p>
    <div class="tw-bubble">💬 ${esc(cur.statement || '')}</div>
    <div class="pz-options">
      <button type="button" class="tw-choose" data-choice="original">루미가 배운 말이다</button>
      <button type="button" class="tw-choose" data-choice="fogged">안개가 왜곡했어</button>
    </div>`;
  body.querySelectorAll('.tw-choose').forEach(b => b.addEventListener('click', () => twAnswer(b.dataset.choice)));
}

function twFeedbackShow(html){
  const fb = $('#tw-feedback'); if(!fb) return;
  fb.innerHTML = html;
  fb.classList.remove('hidden');
}

async function twAnswer(choice){
  const t = _tw && _tw.data;
  if(!t || !_tw || _tw.busy) return;
  const cur = t.floors[_tw.idx];
  if(!cur) return;
  _tw.busy = true;
  const body = $('#tw-question');
  const btns = body ? [...body.querySelectorAll('.tw-choose')] : [];
  btns.forEach(b => { b.disabled = true; });
  let r = null;
  try{ r = await api('/api/tower/answer', { floor: cur.floor, choice }, 12000); }
  catch(e){
    // 창이 닫혔으면 조용히 — 아니면 통신 실패는 «오답» 이 아니므로 버튼을 되살려 재시도하게 한다
    if(!_tw) return;
    _tw.busy = false;
    btns.forEach(b => { b.disabled = false; });
    twFeedbackShow(`🌫️ ${esc(e.message)}`);
    return;
  }
  if(!_tw) return;   // 기다리는 사이 창이 닫혔다면 아무것도 그리지 않는다
  if(r && r.clearedMask != null) t.clearedMask = r.clearedMask;
  const concept = (r && r.concept) || cur.concept || '';
  const pick = btns.find(b => b.dataset.choice === choice);
  if(r && r.correct === true){
    // 정답 — 이 층의 등불이 오늘의 안개를 견뎠다. 0.8초 뒤 다음 층.
    if(pick) pick.classList.add('correct');
    // ★ v1.72: 정답이면 탑의 안개가 걷힌다.
    { const card = document.querySelector('.tower-card');
      if(card){ card.classList.add('fog-clear'); _twTimers.push(setTimeout(()=>card.classList.remove('fog-clear'), 1600)); } }
    try{ robotGesture('bounce'); }catch(e){}
    twFeedbackShow(`루미의 «${esc(concept)}» 등불이 오늘 안개를 견뎠어! 🛡️`);
    _twTimers.push(setTimeout(()=>{
      if(!_tw) return;              // 창이 닫혀 있으면 아무것도 하지 않는다(유령 탑 방지)
      _tw.busy = false;
      if(r.done) twShowVictory();
      else { _tw.idx += 1; twRenderFloor(); }
    }, 800));
    return;
  }
  // 오답 — 고른 쪽 빨강, 진짜 배운 말 초록. 1.5초 뒤 «여기까지» 결과 화면.
  if(pick) pick.classList.add('wrong');
  // ★ v1.72: 오답이면 안개가 짙어진다(실패가 «보이게»).
  { const card = document.querySelector('.tower-card');
    if(card){ card.classList.add('fog-heavy'); _twTimers.push(setTimeout(()=>card.classList.remove('fog-heavy'), 2100)); } }
  const okBtn = (r && r.expected) ? btns.find(b => b.dataset.choice === r.expected) : null;
  if(okBtn) okBtn.classList.add('correct');
  try{ robotGesture('nod'); }catch(e){}
  const why = (r && r.why) ? `<span class="tw-why">${esc(r.why)}</span>` : '';
  twFeedbackShow(`앗, 안개가 «${esc(concept)}» 을 더 흐리게 했어…${why}`);
  if(r && r.ended) t.ended = true;
  _twTimers.push(setTimeout(()=>{
    if(!_tw) return;
    _tw.busy = false;
    twShowResult();
  }, 1500));
}

function twShowVictory(){
  const t = _tw && _tw.data; if(!t) return;
  const body = $('#tw-question'), fb = $('#tw-feedback');
  if(fb) fb.classList.add('hidden');
  if(body) body.innerHTML = `
    <div class="tw-result">
      <div class="tw-result-emoji">✨🗼</div>
      <p class="tw-result-main">안개를 다 물리쳤어! 루미의 기억이 빛나요 ✨</p>
      ${t.boss ? '<p class="tw-result-boss">안개 BOSS 를 물리쳤어! 🌊→✨</p>' : ''}
      <p class="hint">${twCleared(t.clearedMask)}층 클리어</p>
    </div>`;
  try{ setRobotMode('cheer'); }catch(e){}
}
function twShowResult(){
  const t = _tw && _tw.data; if(!t) return;
  const body = $('#tw-question'), fb = $('#tw-feedback');
  if(fb) fb.classList.add('hidden');
  if(body) body.innerHTML = `
    <div class="tw-result">
      <div class="tw-result-emoji">🌫️🗼</div>
      <p class="tw-result-main">오늘의 탑은 여기까지… 내일 또 와!</p>
      <p class="hint">${twCleared(t.clearedMask)}층 클리어</p>
    </div>`;
}

// ---------- ③ 마을의 루미 NPC 루틴 (world.js ↔ app.js 창구) ----------
// world.js 가 «루미 NPC 에 다가가 상호작용» 하면 window.__rmiRoutine(spot) 을 부른다.
// spot: 'well'(지혜의 샘) · 'mill'(풍차) · 'bell'(종) — 마을 시설마다 루미의 인사가 다르다.
// 이 창구는 «정의만» 해 두고, world.js 가 부르기 전까지는 어떤 부작용도 일으키지 않는다.
window.__rmiRoutine = async (spot)=>{
  if(spot !== 'well' && spot !== 'mill' && spot !== 'bell') return;
  let r = null;
  try{ r = await api('/api/robot/routine', { spot }, 15000); }
  catch(e){ toast('루미가 지금은 말할 수 없어요'); return; }
  if(!r || !r.opener){ toast('루미가 지금은 말할 수 없어요'); return; }
  // v1.34 in-world 채팅 — world.js 의 openWorldChat() 은 IIFE 안에 있어 window 로 노출되지 않는다.
  //   chatOpen() 은 world-screen 이 열려 있으면 «같은 in-world 레이어» 를 그대로 켠다
  //   (W.chatOpen 도 window.__worldState 로 같은 객체를 공유해 함께 맞춰진다).
  if(window.__worldState && window.__worldState.keys) window.__worldState.keys = {};   // 걷기 입력 해제
  await chatOpen();
  // chatOpen 이 대화 기록을 다시 그린 «뒤에» 인사를 얹는다 — 앞에 넣으면 loadChatHistory 에 지워진다
  chatAdd('assistant', String(r.opener), true);
  const input = $('#chat-text'); if(input) input.focus();
};

// «안개 속의 탑» 열기 버튼 — 기억 등불 판넬 아래
$('#btn-tower')?.addEventListener('click', openTower);

// ★ 2026-10-28: 음성 입력(Web Speech API). 지원 브라우저에서만 동작.
let _rec = null;
function startMic(auto){
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SR) return toast('이 브라우저는 음성 입력을 지원하지 않아요. Chrome/Safari를 사용해 주세요.');
  if(_rec){ try{ _rec.stop(); }catch(e){} _rec = null; return; }
  try{
    _rec = new SR();
    _rec.lang = 'ko-KR'; _rec.interimResults = false; _rec.maxAlternatives = 1;
    _rec.onresult = e => {
      const text = e.results[0][0].transcript || '';
      const input = $('#chat-text');
      if(input){ input.value = text; input.focus(); }
      if(auto || state.voiceChat){
        toast('🎤 ' + text);
        setTimeout(()=>{ if(!state.chatBusy && String(text).trim()) sendChat(false); }, 250);
      } else {
        toast('🎤 ' + text);
      }
    };
    // ★ 오류 종류별로 안내를 다르게 한다. 예전엔 모든 오류가 «못 들었어요» 였다.
    _rec.onerror = (e) => {
      const err = e && e.error;
      _rec = null;
      if(err === 'no-speech') toast('조용하네요. 말해줄래?');
      else if(err === 'aborted'){ /* 사용자/코드가 중단한 것 — 조용히 넘어간다 */ }
      else toast('음성을 듣지 못했어요. 다시 시도해 주세요.');
    };
    _rec.onend = () => { _rec = null; };
    _rec.start();
    toast('🎤 듣고 있어요… 말해 보세요.');
  }catch(e){ _rec = null; toast('마이크를 시작하지 못했어요.'); }
}

// ---- 버그 슈터 (Canvas 2D) ----
const SH_TIPS = [
  '반복문 = 같은 일을 여러 번 시키는 명령',
  '변수 = 값을 담아 두는 이름 붙은 상자',
  '조건문 = 만약 ~이면 이렇게 해',
  '함수 = 이름 붙인 명령 묶음',
  '디버깅 = 틀린 조각을 하나씩 찾는 일',
  '리스트 = 여러 값을 순서대로 담는 그릇',
];
const sh = { raf:null, running:false, submitted:false, last:0, time:60, score:0, combo:1, comboT:0,
  kills:0, tips:0, tip:'', tipT:0, lastTip:'',
  // v1.37 «생존» 축 — 목숨 3 + 피격 무적 1.5초 + 보스 1회 제한
  lives:3, invuln:0, bossSpawned:false, over:false,
  player:{x:180,y:430,r:14}, bullets:[], enemies:[], parts:[], pops:[], fireT:0, spawnT:0, boss:null, keys:{}, pointer:null };
const SH_W=360, SH_H=480;
const SH_LIVES = 3, SH_INVULN = 1.5;
function shReset(){
  sh.running=false; sh.submitted=false; sh.last=0; sh.time=60; sh.score=0; sh.combo=1; sh.comboT=0;
  sh.lives=SH_LIVES; sh.invuln=0; sh.bossSpawned=false; sh.over=false;
  sh.player={x:SH_W/2,y:SH_H-50,r:14}; sh.bullets=[]; sh.enemies=[]; sh.parts=[]; sh.pops=[]; sh.fireT=0; sh.spawnT=0; sh.boss=null; sh.keys={};
  sh.kills=0; sh.tips=0; sh.tip=''; sh.tipT=0; sh.lastTip='';
  shDraw();
}
function openShooter(){
  $('#game-shooter').classList.remove('hidden');
  shReset();
  $('#sh-overlay').classList.remove('hidden'); $('#sh-overlay').textContent='START';
  $('#shooter-go').textContent='시작하기';
}
function stopShooter(){
  sh.running=false;
  if(sh.raf){ cancelAnimationFrame(sh.raf); sh.raf=null; }
}
function shStart(){
  stopShooter();
  shReset(); sh.running=true;
  $('#sh-overlay').classList.add('hidden');
  $('#shooter-go').textContent='다시 시작';
  sh.last = performance.now();
  sh.raf = requestAnimationFrame(shLoop);
}
function shLoop(ts){
  if(!sh.running) return;
  const dt = Math.min(0.05, (ts - sh.last)/1000 || 0.016); sh.last = ts;
  shUpdate(dt);
  if(!sh.running) return;      // v1.37: shUpdate 안에서 목숨 0 → shEnd('dead') 됐을 수 있다
  shDraw();
  if(sh.time <= 0){ shEnd('time'); return; }
  sh.raf = requestAnimationFrame(shLoop);
}
function shUpdate(dt){
  sh.time -= dt;
  if(sh.invuln > 0) sh.invuln -= dt;
  const p = sh.player;
  if(sh.keys.ArrowLeft) p.x -= 260*dt;
  if(sh.keys.ArrowRight) p.x += 260*dt;
  if(sh.pointer != null) p.x += (sh.pointer - p.x) * Math.min(1, dt*12);
  p.x = Math.max(18, Math.min(SH_W-18, p.x));

  // 자동 사격
  sh.fireT -= dt;
  if(sh.fireT <= 0){ sh.fireT = 0.16; sh.bullets.push({x:p.x, y:p.y-18, vy:-430}); }

  // 적 생성 — 진행도가 오르면 «방벽형 / 분열형» 비율이 올라간다
  sh.spawnT -= dt;
  if(sh.spawnT <= 0 && sh.time > 2){
    sh.spawnT = Math.max(0.34, 0.8 - (60-sh.time)*0.007);
    const prog = Math.max(0, Math.min(1, 1 - sh.time/60));
    const r = Math.random();
    let type = 1;                                   // 1=추격
    if(r < 0.06 + prog*0.06) type = 4;              // 4=방벽형(총알을 막는다)
    else if(r < 0.16 + prog*0.14) type = 2;         // 2=분열형(죽으면 2마리)
    const spec = type===4 ? {r:18, hp:5} : type===2 ? {r:15, hp:3} : {r:12, hp:1};
    sh.enemies.push({x:24+Math.random()*(SH_W-48), y:-20, vy:60+Math.random()*50+(60-sh.time)*0.7,
      r:spec.r, hp:spec.hp, maxHp:spec.hp, type, hitT:0});
  }
  // 보스 — «한 판에 한 번만» (v1.37: 무한 재소환 제거)
  if(!sh.bossSpawned && sh.time <= 30){
    sh.bossSpawned = true;
    sh.boss = {x:SH_W/2, y:-50, vy:28, r:38, hp:48, maxHp:48, hitT:0, boss:true, shootT:1.2, phase:1};
    sh.enemies.push(sh.boss);
  }

  // 탄 이동/충돌
  for(let i=sh.bullets.length-1;i>=0;i--){
    const b=sh.bullets[i]; b.y += b.vy*dt;
    if(b.y < -10){ sh.bullets.splice(i,1); continue; }
    for(let j=sh.enemies.length-1;j>=0;j--){
      const e=sh.enemies[j];
      if(Math.hypot(b.x-e.x, b.y-e.y) < e.r+3){
        sh.bullets.splice(i,1); e.hp--; e.hitT=0.08;
        if(e.hp<=0){
          sh.enemies.splice(j,1);
          if(e.boss){
            sh.boss=null; sh.score += 200;
            shBurst(e.x,e.y,36,'#ff6b6b'); shPop(e.x,e.y,'+200','#ffd43b');
          } else {
            // type: 1 추격 / 2 분열 / 0 분열 자식 / 4 방벽
            const base = e.type===4 ? 30 : e.type===2 ? 20 : e.type===0 ? 5 : 10;
            const total = base * sh.combo;
            sh.score += total;
            const col = e.type===4 ? '#ffa94d' : (e.type===2 ? '#b197fc' : '#63e6be');
            shBurst(e.x,e.y, e.type===4?16:10, col);
            shPop(e.x,e.y,`+${total}`, '#ffe066');
            sh.kills++;
            // 분열형은 죽으면 자식 2마리 — «한 번에 쓸어담기» 를 막아 우선순위를 만든다
            if(e.type===2 && e.r > 10){
              for(const dx of [-15, 15]){
                sh.enemies.push({x:Math.max(16,Math.min(SH_W-16,e.x+dx)), y:e.y, vy:e.vy*1.15,
                  r:9, hp:1, maxHp:1, type:0, hitT:0});
              }
            }
            if(sh.kills % 10 === 0){
              sh.tip = SH_TIPS[sh.tips % SH_TIPS.length]; sh.tips++;
              sh.tipT = 2.4; sh.lastTip = sh.tip;
            }
          }
          sh.combo = Math.min(5, sh.combo + 1); sh.comboT = 2.2;
        } else if(e.boss && e.phase === 1 && e.hp <= e.maxHp*0.5){
          e.phase = 2;                              // 2페이즈: 3방향탄 + 이동 가속
          shBurst(e.x,e.y,24,'#ffd43b'); shPop(e.x,e.y-30,'PHASE 2','#ffd43b');
        }
        break;
      }
    }
  }
  // 적 이동 / 플레이어 충돌
  for(let i=sh.enemies.length-1;i>=0;i--){
    const e=sh.enemies[i];
    e.y += e.vy*dt;
    if(e.vx){ e.x += e.vx*dt; if(e.x < 6 || e.x > SH_W-6) e.vx = -e.vx; }
    if(e.hitT>0) e.hitT-=dt;
    if(e.boss){
      const sp = e.phase===2 ? 1.3 : 1;
      e.x += Math.sin(performance.now()/700)*40*dt*sp;
      e.x = Math.max(50, Math.min(SH_W-50, e.x));
      e.shootT -= dt;
      if(e.shootT <= 0){
        e.shootT = e.phase===2 ? 1.0 : 1.4;
        if(e.phase===2){
          for(const ang of [-0.38, 0, 0.38]){
            sh.enemies.push({x:e.x, y:e.y+30, vy:150, vx:Math.sin(ang)*95, r:7, hp:1, type:3, hitT:0, bullet:true});
          }
        } else {
          sh.enemies.push({x:e.x, y:e.y+30, vy:150, r:7, hp:1, type:3, hitT:0, bullet:true});
        }
      }
    }
    if(e.y > SH_H+40){ sh.enemies.splice(i,1); continue; }

    // ★ v1.37: 피격 = «목숨 −1 + 연쇄 초기화» 하나로 통일 (−30점 삭제)
    if(Math.hypot(e.x-p.x, e.y-p.y) < e.r+p.r-4){
      if(sh.invuln > 0) continue;                   // 무적 중엔 적도 사라지지 않는다
      sh.lives--; sh.invuln = SH_INVULN; sh.combo = 1;
      shBurst(p.x,p.y,18,'#ff6b6b'); shPop(p.x,p.y-18,'-1','#ff6b6b');
      if(!e.boss) sh.enemies.splice(i,1);
      if(sh.lives <= 0){ shEnd('dead'); return; }
    }
  }
  // 콤보 타이머
  if(sh.comboT>0){ sh.comboT-=dt; if(sh.comboT<=0) sh.combo=1; }
  if(sh.tipT>0) sh.tipT -= dt;
  // 파티클
  for(let i=sh.parts.length-1;i>=0;i--){
    const q=sh.parts[i]; q.x+=q.vx*dt; q.y+=q.vy*dt; q.life-=dt;
    if(q.life<=0) sh.parts.splice(i,1);
  }
  // 점수 팝업
  for(let i=sh.pops.length-1;i>=0;i--){
    const q=sh.pops[i]; q.y -= 28*dt; q.life -= dt;
    if(q.life<=0) sh.pops.splice(i,1);
  }
  $('#sh-score').textContent = sh.score;
  $('#sh-combo').textContent = 'x'+sh.combo;
  $('#sh-time').textContent = Math.max(0, Math.ceil(sh.time));
}
function shBurst(x,y,n,col='#ffd43b'){
  for(let i=0;i<n;i++){
    const a=Math.random()*Math.PI*2, s=40+Math.random()*160;
    sh.parts.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,life:0.4+Math.random()*0.4,
      col, size:1.5+Math.random()*2.5});
  }
}
function shPop(x,y,text,col='#ffe066'){
  sh.pops.push({x,y,text,col,life:0.75});
}
function shDraw(){
  const cv = $('#shooter-canvas'); if(!cv) return;
  const g = cv.getContext('2d');
  const t = performance.now()/1000;
  // 깊은 우주 배경
  const grd = g.createLinearGradient(0,0,0,SH_H);
  grd.addColorStop(0,'#070b18'); grd.addColorStop(.45,'#0d1630'); grd.addColorStop(1,'#151034');
  g.fillStyle=grd; g.fillRect(0,0,SH_W,SH_H);
  // 성운
  const neb1 = g.createRadialGradient(280,110,10,280,110,170);
  neb1.addColorStop(0,'rgba(126,224,192,.18)'); neb1.addColorStop(1,'rgba(126,224,192,0)');
  g.fillStyle=neb1; g.fillRect(0,0,SH_W,SH_H);
  const neb2 = g.createRadialGradient(60,360,10,60,360,180);
  neb2.addColorStop(0,'rgba(177,151,252,.16)'); neb2.addColorStop(1,'rgba(177,151,252,0)');
  g.fillStyle=neb2; g.fillRect(0,0,SH_W,SH_H);
  // 행성
  g.save(); g.translate(74,96); g.rotate(-.22);
  g.fillStyle='#24345f'; g.beginPath(); g.arc(0,0,34,0,Math.PI*2); g.fill();
  g.fillStyle='rgba(126,224,192,.18)'; g.beginPath(); g.arc(-8,-8,20,0,Math.PI*2); g.fill();
  g.strokeStyle='rgba(126,224,192,.28)'; g.lineWidth=5;
  g.beginPath(); g.ellipse(0,0,54,15,0,0,Math.PI*2); g.stroke();
  g.restore();
  // 별
  for(let i=0;i<70;i++){
    const x=(i*83)%SH_W;
    const y=((i*47)+t*(10+(i%4)*9))%SH_H;
    const sz=(i%7===0)?2:1;
    g.globalAlpha=.25+(i%5)*.13;
    g.fillStyle='#fff'; g.fillRect(x,y,sz,sz);
  }
  g.globalAlpha=1;
  // 속도선
  g.strokeStyle='rgba(126,224,192,.08)'; g.lineWidth=1;
  for(let i=0;i<5;i++){ const y=((i*97)+t*40)%SH_H; g.beginPath(); g.moveTo(0,y); g.lineTo(SH_W,y); g.stroke(); }
  // 플레이어 로켓
  const p=sh.player;
  g.save(); g.translate(p.x,p.y);
  const flame=10+Math.sin(t*28)*3;
  const fg=g.createLinearGradient(0,10,0,12+flame);
  fg.addColorStop(0,'rgba(255,224,102,.95)'); fg.addColorStop(.5,'rgba(255,107,107,.7)'); fg.addColorStop(1,'rgba(255,107,107,0)');
  g.fillStyle=fg; g.beginPath(); g.moveTo(-5,10); g.quadraticCurveTo(0,14+flame,5,10); g.closePath(); g.fill();
  g.fillStyle='#2f6fed';
  g.beginPath(); g.moveTo(-10,4); g.lineTo(-19,16); g.lineTo(-7,12); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(10,4); g.lineTo(19,16); g.lineTo(7,12); g.closePath(); g.fill();
  g.shadowColor='#7ee0c0'; g.shadowBlur=16;
  g.fillStyle='#e9f7f2';
  g.beginPath(); g.moveTo(0,-21); g.bezierCurveTo(14,-12,14,8,0,14); g.bezierCurveTo(-14,8,-14,-12,0,-21); g.fill();
  g.shadowBlur=0;
  g.fillStyle='#2f6fed'; g.beginPath(); g.arc(0,-5,6.2,0,Math.PI*2); g.fill();
  g.fillStyle='rgba(255,255,255,.85)'; g.beginPath(); g.arc(-2,-7,1.8,0,Math.PI*2); g.fill();
  g.strokeStyle='#9adfff'; g.lineWidth=1; g.beginPath(); g.arc(0,-3,2.4,.15*Math.PI,.85*Math.PI); g.stroke();
  g.restore();
  // 탄환
  g.save(); g.shadowColor='#ffe066'; g.shadowBlur=14; g.fillStyle='#ffe066';
  sh.bullets.forEach(b=>{
    g.beginPath(); g.ellipse(b.x,b.y,2.4,7,0,0,Math.PI*2); g.fill();
    g.globalAlpha=.28; g.fillRect(b.x-1.5,b.y+4,3,10); g.globalAlpha=1;
  });
  g.restore();
  // 적
  sh.enemies.forEach(e=>{
    if(e.type===3 && e.bullet){
      g.save(); g.shadowColor='#ff922b'; g.shadowBlur=14; g.fillStyle='#ff922b';
      g.beginPath(); g.arc(e.x,e.y,e.r,0,Math.PI*2); g.fill();
      g.fillStyle='#fff3bf'; g.beginPath(); g.arc(e.x-2,e.y-2,e.r*.35,0,Math.PI*2); g.fill();
      g.restore(); return;
    }
    g.save(); g.translate(e.x,e.y);
    const col = e.hitT>0 ? '#ffffff' : (e.boss ? '#ff6b6b' : (e.type===2 ? '#b197fc' : '#63e6be'));
    g.shadowColor=col; g.shadowBlur=14;
    if(e.boss){
      g.fillStyle=col; g.beginPath(); g.ellipse(0,0,e.r,e.r*.82,0,0,Math.PI*2); g.fill();
      g.fillStyle='rgba(255,255,255,.18)'; g.beginPath(); g.ellipse(-10,-10,e.r*.45,e.r*.3,-.4,0,Math.PI*2); g.fill();
      g.strokeStyle=col; g.lineWidth=4; g.lineCap='round';
      g.beginPath(); g.moveTo(-18,-20); g.lineTo(-30,-38); g.stroke();
      g.beginPath(); g.moveTo(18,-20); g.lineTo(30,-38); g.stroke();
      g.fillStyle='#1a1a1a'; g.beginPath(); g.arc(-12,-4,5,0,Math.PI*2); g.fill();
      g.beginPath(); g.arc(12,-4,5,0,Math.PI*2); g.fill();
      g.fillStyle='#fff'; g.beginPath(); g.arc(-13,-6,2,0,Math.PI*2); g.fill();
      g.beginPath(); g.arc(11,-6,2,0,Math.PI*2); g.fill();
      g.strokeStyle='#4a1010'; g.lineWidth=2; g.beginPath(); g.arc(0,10,8,.1*Math.PI,.9*Math.PI); g.stroke();
    } else {
      g.fillStyle='rgba(255,255,255,.16)';
      g.beginPath(); g.ellipse(-e.r*.9,0,e.r*.55,e.r*.28,-.5,0,Math.PI*2); g.fill();
      g.beginPath(); g.ellipse(e.r*.9,0,e.r*.55,e.r*.28,.5,0,Math.PI*2); g.fill();
      g.fillStyle=col; g.beginPath(); g.arc(0,0,e.r,0,Math.PI*2); g.fill();
      g.strokeStyle=col; g.lineWidth=2; g.lineCap='round';
      g.beginPath(); g.moveTo(-4,-e.r+1); g.lineTo(-8,-e.r-6); g.stroke();
      g.beginPath(); g.moveTo(4,-e.r+1); g.lineTo(8,-e.r-6); g.stroke();
      g.fillStyle='#0b1220'; g.beginPath(); g.arc(-4,-2,2.2,0,Math.PI*2); g.fill();
      g.beginPath(); g.arc(4,-2,2.2,0,Math.PI*2); g.fill();
      g.fillStyle='#fff'; g.beginPath(); g.arc(-4.5,-2.8,.8,0,Math.PI*2); g.fill();
      g.beginPath(); g.arc(3.5,-2.8,.8,0,Math.PI*2); g.fill();
    }
    g.restore();
  });
  // 파티클
  sh.parts.forEach(q=>{
    g.globalAlpha=Math.max(0,q.life*1.6);
    g.fillStyle=q.col||'#ffd43b';
    g.beginPath(); g.arc(q.x,q.y,q.size||2,0,Math.PI*2); g.fill();
  });
  g.globalAlpha=1;
  // 점수 팝업
  sh.pops.forEach(q=>{
    g.globalAlpha=Math.max(0,q.life);
    g.fillStyle=q.col||'#ffe066'; g.font='bold 14px sans-serif'; g.textAlign='center';
    g.fillText(q.text,q.x,q.y);
  });
  g.globalAlpha=1;
  // 보스 HP
  if(sh.boss){
    const w=SH_W-90, hp=Math.max(0,sh.boss.hp/sh.boss.maxHp);
    g.fillStyle='rgba(4,10,20,.72)'; g.fillRect(45,40,w,9);
    g.fillStyle='#ff6b6b'; g.fillRect(45,40,w*hp,9);
    g.strokeStyle='rgba(255,255,255,.25)'; g.lineWidth=1; g.strokeRect(45,40,w,9);
    g.fillStyle='#fff'; g.font='9px sans-serif'; g.textAlign='center'; g.fillText('BUG BOSS',SH_W/2,37);
  }
  // v1.37: 목숨 3개 — canvas 로 직접 그린다(이모지·폰트 의존 없이 크기가 일정)
  for(let i=0;i<SH_LIVES;i++){
    const on = i < sh.lives;
    g.save(); g.translate(15 + i*17, 20); g.scale(.9,.9);
    g.beginPath();
    g.moveTo(0,4);
    g.bezierCurveTo(-9,-2,-9,-9,0,-5.5);
    g.bezierCurveTo(9,-9,9,-2,0,4);
    g.closePath();
    g.fillStyle = on ? '#ff6b6b' : 'rgba(255,255,255,.16)';
    if(on){ g.shadowColor='#ff6b6b'; g.shadowBlur=9; }
    g.fill(); g.restore();
  }
  // 비네트
  const vg=g.createRadialGradient(SH_W/2,SH_H/2,SH_H*.32,SH_W/2,SH_H/2,SH_H*.78);
  vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(0,0,0,.4)');
  g.fillStyle=vg; g.fillRect(0,0,SH_W,SH_H);
  // 팁 카드
  if(sh.tipT>0 && sh.tip){
    g.fillStyle='rgba(4,10,20,.82)'; g.beginPath();
    if(g.roundRect) g.roundRect(10,SH_H-66,SH_W-20,50,10); else g.rect(10,SH_H-66,SH_W-20,50);
    g.fill();
    g.fillStyle='#ffe066'; g.font='11px sans-serif'; g.textAlign='left';
    g.fillText('📘 ' + sh.tip, 20, SH_H-38);
  }
}
function shEnd(reason){
  stopShooter();
  sh.over = true;
  $('#sh-overlay').classList.remove('hidden');
  const tipLine = sh.lastTip ? `<br><small style="font-size:12px;font-weight:600;opacity:.9">📘 ${sh.lastTip}</small>` : '';
  const head = reason === 'dead'
    ? `GAME OVER · 쓰러졌어! ${sh.score}점`
    : (sh.score >= 50 ? `GAME OVER · ${sh.score}점` : 'GAME OVER');
  $('#sh-overlay').innerHTML = head + tipLine;
  // P3: 실패해도 «이미 얻은 점수» 는 몰수하지 않는다
  if(sh.score >= 50 && !sh.submitted){
    sh.submitted = true;
    setTimeout(()=>submitGameResult('shooter',{score:sh.score, lives:sh.lives}, $('#shooter-go')), sh.lastTip ? 1800 : 800);
  }
}

// ---- 버그 두더지 (30초 «우선순위» 게임) — v1.37 ----
//   v1.37: «반응 테스트» → «0.3초 안에 무엇을 먼저 칠지» 결정하는 게임.
//   단일 슬롯(active)을 slots[] 로 바꾸고, 금벌레·폭탄을 섞어 «먼저 칠 대상» 을 만든다.
//   ※ active / activeT / next / bomb 같은 옛 필드는 «남기지 않는다» — 두 벌 상태가 서로 싸운다.
const mole = {
  running:false, submitted:false,
  score:0, combo:1, comboGrace:0,
  time:30, spawnT:0, lastTick:0,
  slots:[],                       // [{hole:0..8, kind:'bug'|'gold'|'bomb', life}]
  lastHole:-1,
  timer:null, holes:[]
};
// §4-3 상수표 — 조정은 여기서만
const MOLE_DURATION = 30;
const MOLE_CAP_EARLY = 2, MOLE_CAP_RUSH = 3, MOLE_RUSH_FROM = 22;
const MOLE_LIFE = { bug:0.85, gold:0.50, bomb:0.95 };
const MOLE_P_GOLD = 0.10, MOLE_P_BOMB = 0.16;
const MOLE_PENALTY_BOMB = 40, MOLE_COMBO_GRACE = 1.4;
const MOLE_GAP = () => 0.45 + Math.random() * 0.25;

function initMoleGrid(){
  const grid = $('#mole-grid'); if(!grid) return;
  if(grid.dataset.ready === '1'){ mole.holes = [...grid.children]; return; }
  grid.innerHTML = '';
  for(let i=0;i<9;i++){
    const b = document.createElement('button');
    b.className = 'mole-hole'; b.dataset.i = i;
    b.innerHTML = '<span class="mole-bug"><svg viewBox="0 0 64 64"><use href="#mole-char"/></svg></span><span class="mole-pop"></span>';
    b.addEventListener('click', ()=>moleHit(i));
    grid.appendChild(b);
  }
  grid.dataset.ready = '1';
  mole.holes = [...grid.children];
}
function moleReset(){
  stopMole();
  mole.running = false; mole.submitted = false; mole.score = 0; mole.combo = 1;
  mole.comboGrace = 0; mole.time = MOLE_DURATION; mole.spawnT = 0; mole.lastTick = 0;
  mole.slots = []; mole.lastHole = -1;
  mole.holes.forEach(h => {
    h.classList.remove('show','gold','bomb','hit');
    const use = h.querySelector('.mole-bug use');
    if(use) use.setAttribute('href','#mole-char');
  });
  const s = $('#mole-score'); if(s) s.textContent = '0';
  const c = $('#mole-combo'); if(c) c.textContent = 'x1';
  const t = $('#mole-time'); if(t) t.textContent = String(MOLE_DURATION);
}
function stopMole(){
  mole.running = false;
  if(mole.timer){ clearInterval(mole.timer); mole.timer = null; }
  // §3-2 DOM 찌꺼기 클래스 정리: 창을 중간에 닫아도 «보이던 두더지» 가 남지 않게
  if(mole.holes && mole.holes.length){
    mole.holes.forEach(h => h.classList.remove('show','gold','bomb','hit'));
  }
  mole.slots = [];
}
function openMole(){
  $('#game-mole').classList.remove('hidden');
  initMoleGrid();
  moleReset();
  $('#mole-overlay').classList.remove('hidden');
  $('#mole-overlay').textContent = 'START';
  $('#mole-go').textContent = '시작하기';
}
function moleStart(){
  initMoleGrid();
  moleReset();
  mole.running = true;
  $('#mole-overlay').classList.add('hidden');
  $('#mole-go').textContent = '다시 시작';
  mole.lastTick = Date.now();
  mole.timer = setInterval(moleTick, 100);
}
function moleCap(){
  // 마지막 8초에만 3마리 — «압박 구간» 이 생겨 한 판 안에 난이도 곡선이 생긴다
  return mole.time <= MOLE_DURATION - MOLE_RUSH_FROM ? MOLE_CAP_RUSH : MOLE_CAP_EARLY;
}
function moleTick(){
  if(!mole.running) return;
  // v1.37 §12-1 권고(a): 백그라운드 탭에서 setInterval 이 1초로 스로틀돼도
  //   «한 판이 늘어나지 않도록» 실제 경과 시간으로 보정한다.
  //   단 한 번에 최대 1초만 소모시켜, 탭 복귀 직후 30초가 한꺼번에 날아가지 않게 한다.
  const now = Date.now();
  const dt = mole.lastTick ? Math.max(0, Math.min(1.0, (now - mole.lastTick) / 1000)) : 0.1;
  mole.lastTick = now;

  // ① 시간
  mole.time = Math.max(0, mole.time - dt);
  const tEl = $('#mole-time'); if(tEl) tEl.textContent = String(Math.ceil(mole.time));
  if(mole.time <= 0){ moleEnd(); return; }

  // ② 수명이 다한 슬롯 정리 (뒤에서부터 splice)
  for(let i=mole.slots.length-1; i>=0; i--){
    mole.slots[i].life -= dt;
    if(mole.slots[i].life <= 0) moleExpire(i);
  }

  // ③ 생성 — cap 이어도 spawnT 는 리셋해 «해제 순간 연쇄 폭발» 을 막는다
  mole.spawnT -= dt;
  if(mole.spawnT <= 0){
    if(mole.slots.length < moleCap()) moleSpawn();
    mole.spawnT = MOLE_GAP();
  }

  // ④ 콤보 유예
  if(mole.comboGrace > 0){
    mole.comboGrace -= dt;
    if(mole.comboGrace <= 0){
      mole.comboGrace = 0;
      if(mole.combo > 1){ mole.combo = 1; const c=$('#mole-combo'); if(c) c.textContent='x1'; }
    }
  }
}
function moleSpawn(){
  const used = new Set(mole.slots.map(s => s.hole));
  const free = [];
  for(let i=0;i<9;i++){ if(!used.has(i) && i !== mole.lastHole) free.push(i); }
  if(!free.length) return;
  const hole = free[Math.floor(Math.random()*free.length)];
  const roll = Math.random();
  const kind = roll < MOLE_P_GOLD ? 'gold' : (roll < MOLE_P_GOLD + MOLE_P_BOMB ? 'bomb' : 'bug');
  mole.slots.push({ hole, kind, life: MOLE_LIFE[kind] });
  mole.lastHole = hole;

  const h = mole.holes[hole];
  if(!h) return;
  h.classList.add('show');
  h.classList.toggle('gold', kind === 'gold');
  h.classList.toggle('bomb', kind === 'bomb');
  const use = h.querySelector('.mole-bug use');
  if(use) use.setAttribute('href', kind === 'gold' ? '#mole-gold' : (kind === 'bomb' ? '#mole-bomb' : '#mole-char'));
}
function moleExpire(index){
  const slot = mole.slots[index];
  if(!slot) return;
  mole.slots.splice(index, 1);
  const h = mole.holes[slot.hole];
  if(h) h.classList.remove('show','gold','bomb');
  // «놓침» 은 즉시 콤보 0 이 아니라 1.4초 유예 — 폭탄을 피하려다 놓친 것을 벌하지 않는다
  if(slot.kind !== 'bomb') mole.comboGrace = MOLE_COMBO_GRACE;
}
function moleHit(i){
  if(!mole.running) return;
  const idx = mole.slots.findIndex(s => s.hole === i);
  if(idx < 0) return;                       // 빈 구멍은 벌하지 않는다(8~15세의 오터치)
  const slot = mole.slots[idx];
  mole.slots.splice(idx, 1);

  let gain = 0;
  if(slot.kind === 'bomb'){
    gain = -MOLE_PENALTY_BOMB;
    mole.score = Math.max(0, mole.score - MOLE_PENALTY_BOMB);
    mole.combo = 1; mole.comboGrace = 0;
  } else if(slot.kind === 'gold'){
    gain = 25;                              // 금벌레는 콤보 배율을 받지 않는다 → «지금 25 vs 지키는 40»
    mole.score += gain;
    mole.combo = Math.min(5, mole.combo + 1); mole.comboGrace = 0;
  } else {
    gain = 10 * mole.combo;
    mole.score += gain;
    mole.combo = Math.min(5, mole.combo + 1); mole.comboGrace = 0;
  }

  const h = mole.holes[i];
  if(h){
    h.classList.remove('show','gold','bomb');
    h.classList.add('hit');
    setTimeout(()=>{ if(h) h.classList.remove('hit'); }, 120);
    const pop = h.querySelector('.mole-pop');
    if(pop){
      pop.textContent = (gain > 0 ? '+' : '') + gain;
      pop.classList.remove('show');
      void pop.offsetWidth;
      pop.classList.add('show');
    }
  }
  const s = $('#mole-score'); if(s) s.textContent = String(mole.score);
  const c = $('#mole-combo'); if(c) c.textContent = 'x' + mole.combo;
}
function moleEnd(){
  stopMole();
  $('#mole-overlay').classList.remove('hidden');
  $('#mole-overlay').textContent = mole.score >= 20 ? `GAME OVER · ${mole.score}점` : 'GAME OVER · 조금만 더!';
  if(mole.score >= 20 && !mole.submitted){
    mole.submitted = true;
    setTimeout(()=>submitGameResult('mole', { score:mole.score }, $('#mole-go')), 800);
  }
}

// ---- 오늘의 퍼즐 (3문제 세트) ----
function pzRender(){
  const pz = state.pz;
  if(!pz) return;
  const q = pz.questions[pz.index];
  if(!q){ $('#pz-question').textContent='문제를 불러오지 못했어요.'; return; }
  $('#pz-topic').textContent = `문제 ${pz.index+1}/${pz.questions.length} · ${q.topic}`;
  $('#pz-question').textContent = q.question;
  $('#pz-hint').classList.add('hidden'); $('#pz-hint').textContent='';
  pz.hintIdx = 0;
  $('#pz-hints').textContent = `힌트 ${pz.hintsLeft}개`;
  // v1.37: 보상이 «정확도» 에 따라 20~45 로 달라진다
  $('#pz-reward').textContent = pz.practice ? '연습' : '+20~45셀';
  const box=$('#pz-options'); box.innerHTML='';
  (q.options||[]).forEach((opt,i)=>{
    const btn=document.createElement('button'); btn.textContent=`${i+1}. ${opt}`;
    btn.onclick=()=>answerPuzzle(i,btn); box.appendChild(btn);
  });
}
async function openPuzzle(practice=false){
  $('#game-puzzle').classList.remove('hidden');
  $('#pz-options').innerHTML=''; $('#pz-hint').classList.add('hidden');
  $('#pz-question').textContent='불러오는 중…';
  try{
    const r = await api('/api/puzzle/today' + (practice ? '?practice=1' : ''));
    state.pz = { questions:r.questions||[], index:0, hintsLeft:3, hintIdx:0,
                 reward: practice ? 0 : (r.reward||30), done: practice ? false : !!r.done, practice:!!practice,
                 firstTryCount:0, wrong:{} };   // v1.37 «첫 시도 정답» 카운트 + 오답 기록
    if(state.pz.done){
      $('#pz-topic').textContent='오늘의 퍼즐';
      $('#pz-question').textContent='오늘은 이미 풀었어요! 내일 또 만나요.';
      $('#pz-hints').textContent='힌트 0개';
      $('#pz-reward').textContent=`+${state.pz.reward}셀`;
      $('#pz-options').innerHTML='';
      return;
    }
    if(!state.pz.questions.length) throw new Error('문제를 준비 중이에요. 잠시 후 다시 시도해 주세요.');
    pzRender();
  }catch(e){ $('#pz-question').textContent=e.message; }
}
async function answerPuzzle(choice, btn){
  if(!state.pz || state.pz.done) return;
  const q = state.pz.questions[state.pz.index];
  if(!q) return;
  const isPractice = !!state.pz.practice;
  const isFinal = !isPractice && state.pz.index === state.pz.questions.length - 1;
  try{
    const r = await api('/api/puzzle/answer', {
      cardId:q.cardId, choice, final:isFinal,
      firstTryCount: state.pz.firstTryCount,     // v1.37: «첫 시도 정답» 수(0~3)
      hintsLeft: state.pz.hintsLeft
    });
    $('#pz-hint').classList.remove('hidden');
    if(!r.correct){
      btn.classList.add('wrong');
      state.pz.wrong = state.pz.wrong || {};
      const n = (state.pz.wrong[q.cardId] || 0) + 1;
      state.pz.wrong[q.cardId] = n;
      // v1.37: «추측» 에 가격을 매긴다 — 오답마다 힌트 1개 소모
      if(state.pz.hintsLeft > 0) state.pz.hintsLeft--;
      $('#pz-hints').textContent = `힌트 ${state.pz.hintsLeft}개`;
      $('#pz-hint').textContent = `💡 ${r.hint}`;
      if(r.next){
        // 힌트 소진 + 또 오답 → 정답 공개. 마지막 문제면 여기서 종료(보상 없음)
        const ans = Number(r.reveal);
        const opts = $('#pz-options').children;
        if(opts[ans]) opts[ans].classList.add('correct');
        $('#pz-hint').textContent = `정답은 ${ans+1}번이야!`;
        setTimeout(()=>{
          if(isFinal){ state.pz.done = true; closeGame('game-puzzle'); }
          else { state.pz.index++; pzRender(); }
        }, 2000);
        return;
      }
      if(n >= 2) toast('루미에게 물어볼까? «루미에게 묻기»를 눌러봐.');
      return;
    }
    btn.classList.add('correct');
    // 이 문제를 «한 번도 안 틀리고» 맞혔는가 — 정확도 축의 핵심
    const wrongN = (state.pz.wrong && state.pz.wrong[q.cardId]) || 0;
    if(wrongN === 0) state.pz.firstTryCount++;
    if(!isFinal){
      state.pz.index++;
      if(isPractice && state.pz.index >= state.pz.questions.length){
        state.pz.done = true;
        $('#pz-hint').textContent = '🎉 연습 완료! 수고했어요.';
        setTimeout(()=>closeGame('game-puzzle'), 1200);
        return;
      }
      $('#pz-hint').textContent = '🎉 정답! 다음 문제로 갈게요.';
      setTimeout(pzRender, 700);
      return;
    }
    state.pz.done = true;
    $('#pz-hint').textContent = `🎉 3문제 완료! +${r.reward}셀 (첫 시도 ${r.firstTry}/3)`;
    // v1.37: 퍼즐은 /api/game/result 를 안 거치므로 여기서 의뢰를 판정한다
    if(state.quest) tryClaimQuest({ kind:'puzzle', firstTry:r.firstTry });
    state.user.cell_balance = r.balance; setBalance(r.balance);
    if(!state.pz.practice && state.plan && state.plan.plan){
      const ps = state.plan.plan.steps.find(s=>s.type==='puzzle' && !s.done);
      if(ps) togglePlanStep(ps.id, true);
    }
    setTimeout(()=>{ closeGame('game-puzzle'); if(state.robot) renderMyroom(); }, 1500);
  }catch(e){ $('#pz-hint').classList.remove('hidden'); $('#pz-hint').textContent=e.message; }
}
async function askPuzzle(){
  const q = state.pz && state.pz.questions && state.pz.questions[state.pz.index];
  closeGame('game-puzzle');
  await chatOpen();
  chatModeSet('learn');
  const input = $('#chat-text');
  if(input) input.value = q ? `${q.topic}이 헷갈려. 같이 볼까?` : '같이 공부하고 싶어';
  sendChat(false);
}
async function showPzHint(){
  const pz = state.pz;
  if(!pz || pz.done) return;
  if(pz.hintsLeft<=0){
    $('#pz-hint').classList.remove('hidden');
    $('#pz-hint').textContent='힌트를 모두 썼어요. 다시 생각해 보자!';
    return;
  }
  const q = pz.questions[pz.index];
  // ★ L1/L2 힌트는 today 응답에 들어 있어 즉시 보여 주고, L3 힌트는
  //   네트워크 탭에서 미리 훔쳐보지 못하도록 서버에서 필요할 때만 내려받는다.
  if(q && pz.hintIdx >= (q.hints||[]).length){
    pz.hintIdx++; pz.hintsLeft--;
    $('#pz-hint').classList.remove('hidden');
    $('#pz-hint').textContent='💡 루미가 힌트를 준비하는 중…';
    $('#pz-hints').textContent=`힌트 ${pz.hintsLeft}개`;
    try{
      const r = await api('/api/puzzle/hint', { cardId:q.cardId, level:3 });
      $('#pz-hint').textContent=`💡 ${r.text || '한 번 더 생각해 보자.'}`;
    }catch(e){
      $('#pz-hint').textContent='💡 한 번 더 생각해 보자.';
    }
    return;
  }
  const h = (q && (q.hints||[])[pz.hintIdx]) || '한 번 더 생각해 보자.';
  pz.hintIdx++; pz.hintsLeft--;
  $('#pz-hint').classList.remove('hidden'); $('#pz-hint').textContent=`💡 ${h}`;
  $('#pz-hints').textContent=`힌트 ${pz.hintsLeft}개`;
}

// ---- 보호자 대시보드 / 접근성 설정 (2026-10-28) ----
function applySettings(){
  const font = localStorage.getItem('roomi_font_lg') === '1';
  const cb = localStorage.getItem('roomi_cb') === '1';
  state.voiceAuto = localStorage.getItem('roomi_voice_auto') === '1';
  state.voiceChat = localStorage.getItem('roomi_voice_chat') === '1';
  state.nudgeOptIn = localStorage.getItem('roomi_nudge') !== '0';
  document.body.classList.toggle('font-lg', font);
  document.body.classList.toggle('cb', cb);
  const f = $('#set-font'), c = $('#set-cb'), v = $('#set-voice'), n = $('#set-nudge');
  if(f) f.checked = font;
  if(c) c.checked = cb;
  if(v) v.checked = state.voiceAuto;
  if(n) n.checked = state.nudgeOptIn;
  const vc = $('#set-voice-chat'); if(vc) vc.checked = state.voiceChat;
  const rate = Math.min(1.15, Math.max(0.7, Number(localStorage.getItem('roomi_voice_rate')) || 0.9));
  const rr = $('#set-voice-rate'); if(rr) rr.value = rate;
  const rv = $('#voice-rate-val'); if(rv) rv.textContent = rate.toFixed(2);
  loadVoiceOptions();
}
async function openParentDashboard(){
  $('#parent-dashboard').classList.remove('hidden');
  const box = $('#pd-body');
  box.innerHTML = '<div class="pd-stat pd-wide"><span>불러오는 중…</span></div>';
  try{
    const r = await api('/api/parent/dashboard');
    const g = Object.fromEntries((r.games||[]).map(x=>[x.kind, x]));
    const byDay = Object.fromEntries((r.last7||[]).map(x=>[x.d, x]));
    const days = [];
    const base = new Date(Date.now() + 9*3600*1000);
    for(let i=6;i>=0;i--){
      const dt = new Date(base); dt.setUTCDate(dt.getUTCDate() - i);
      const key = dt.toISOString().slice(0,10);
      days.push(byDay[key] || { d:key, c:0 });
    }
    const maxV = Math.max(1, ...days.map(x=>x.c));
    const bars = days.map(x=>
      `<div class="pb" style="height:${Math.round(x.c/maxV*60)+3}px" title="${x.d} · ${x.c}회"></div>`
    ).join('');
    box.innerHTML = `
      <div class="pd-stat"><b>${r.playMinutes}분</b><span>오늘 플레이 · 한도 ${r.limit}분</span></div>
      <div class="pd-stat"><b>${r.understanding}</b><span>이해도</span></div>
      <div class="pd-stat"><b>${r.solved}개</b><span>스스로 해결</span></div>
      <div class="pd-stat"><b>${r.chats}회</b><span>루미와 대화</span></div>
      <div class="pd-stat"><b>${(g.mole && g.mole.best) || 0}점</b><span>두더지 최고</span></div>
      <div class="pd-stat"><b>${(g.shooter && g.shooter.best) || 0}점</b><span>슈터 최고</span></div>
      <div class="pd-stat pd-wide pd-switch-row">
        <div><b>친구 채팅</b><span>끄면 친구 채팅을 막을 수 있어요</span></div>
        <label class="switch"><input type="checkbox" id="pd-fchat" ${r.friendChatEnabled?'checked':''}><i></i></label>
      </div>
      <div class="pd-stat pd-wide" style="display:flex;justify-content:center">
        <button id="pd-memory" class="btn ghost">🧠 AI 기억 보기</button>
      </div>
      <div class="pd-stat pd-wide pd-weekly">
        <b>이번 주</b>
        <span>${(r.weekly&&r.weekly.studyDays)||0}일 공부 · ${(r.weekly&&r.weekly.solved)||0}개 해결 · ${(r.weekly&&r.weekly.chats)||0}회 대화 · ${(r.weekly&&r.weekly.games)||0}회 게임</span>
        <span class="hint">다음 주: ${(r.weekly&&r.weekly.suggestion)||'새 주제 1개 읽기'}</span>
      </div>
      ${(r.conversationStarters && r.conversationStarters.length) ? `
      <div class="pd-stat pd-wide pd-talk">
        <b>오늘 아이와 나눌 말</b>
        <ul>${r.conversationStarters.map(s=>`<li>${esc(s)}</li>`).join('')}</ul>
      </div>` : ''}
      ${(r.errorPatterns && r.errorPatterns.length) ? `
      <div class="pd-stat pd-wide pd-talk pd-errors">
        <b>이번 주 막힘 패턴</b>
        <ul>${r.errorPatterns.map(p=>{
          // ★ 2026-11-20 (v1.70): 추세 표시 — 잃어버리면 up, 회복되면 down, 그대로면 same.
          //    tip 은 «정답 대신 어떻게 도울까» 힌트라서 아이 눈에 안 보이는 부모 화면에만 나온다.
          const ico = p.trend === 'up' ? '🔺' : p.trend === 'down' ? '🔻' : '〰️';
          return `<li><b>${esc(p.topic)} — 이번 주 ${esc(p.count)}번 ${ico}</b><span class="hint">${esc(p.tip)}</span></li>`;
        }).join('')}</ul>
      </div>` : ''}
      <div class="pd-stat pd-wide"><span>최근 7일 접속</span><div class="pd-bars">${bars}</div></div>
      <!-- ★ 2026-11-21 (v1.74) 계약: playLimit · cheerSentToday · parentEmail · optin 표시 +
           POST /api/parent/cheer · playtime · optin 세 행동을 부모 화면에 놓는다. -->
      <div class="pd-stat pd-wide pd-family">
        <b>가족과 함께</b>
        <div class="pd-cheer-row">
          <input id="pd-cheer-text" maxlength="80" placeholder="아이 우편함에 한 마디 (예: 오늘도 멋졌어!)">
          <button id="pd-cheer-send" class="btn primary small" ${r.cheerSentToday ? 'disabled' : ''}>보내기</button>
        </div>
        <span class="hint">하루 한 번 응원을 보낼 수 있어요.${r.cheerSentToday ? ' 오늘은 이미 보냈어요.' : ''}</span>
        <div class="pd-limit-row">
          <span>하루 플레이 한도 <b id="pd-limit-val">${Number(r.playLimit)||40}분</b></span>
          <button id="pd-limit-minus" class="btn ghost small">-10분</button>
          <button id="pd-limit-plus" class="btn ghost small">+10분</button>
        </div>
        <div class="pd-optin-row">
          <span>루미 편지 받기${r.parentEmail ? ` <i class="hint">(${esc(r.parentEmail)})</i>` : ''}</span>
          <label class="switch"><input type="checkbox" id="pd-optin" ${Number(r.optin)?'checked':''}><i></i></label>
          <input id="pd-optin-email" maxlength="120" placeholder="이메일 주소" class="${Number(r.optin)?'hidden':''}">
        </div>
        <span class="hint">이메일은 마스킹해서만 보여요(예: ab***@naver.com).</span>
      </div>`;
    const fc = $('#pd-fchat');
    if(fc) fc.addEventListener('change', async ()=>{
      try{
        const s = await api('/api/parent/friend-chat', { enabled: fc.checked });
        toast(s.enabled ? '친구 채팅을 허용했어요' : '친구 채팅을 막았어요');
      }catch(e){ fc.checked = !fc.checked; toast(e.message); }
    });
    // ── ★ v1.74 가족 행동 ① 응원 편지 ──
    $('#pd-cheer-send')?.addEventListener('click', async ()=>{
      const inp = $('#pd-cheer-text');
      const text = ((inp && inp.value) || '').trim();
      if(!text) return toast('한 마디를 적어 볼래요?');
      const btn = $('#pd-cheer-send');
      if(btn) btn.disabled = true;
      try{
        await api('/api/parent/cheer', { text });
        if(inp) inp.value = '';
        toast('💌 아이 우편함에 응원을 넣었어요');
        try{ loadMailbox(); }catch(e){}   // 아이가 열려 있으면 배지·목록을 바로 갱신
      }catch(e){ toast(e.message); if(btn && !r.cheerSentToday) btn.disabled = false; }
    });
    // ── ★ v1.74 가족 행동 ② 플레이 한도 조절(delta -10/0/+10) ──
    const changeLimit = async (delta)=>{
      try{
        const s = await api('/api/parent/playtime', { delta });
        const v = $('#pd-limit-val'); if(v) v.textContent = `${s.playLimit}분`;
        toast(`하루 한도가 ${s.playLimit}분이 됐어요`);
      }catch(e){ toast(e.message); }
    };
    $('#pd-limit-minus')?.addEventListener('click', ()=>changeLimit(-10));
    $('#pd-limit-plus')?.addEventListener('click', ()=>changeLimit(10));
    // ── ★ v1.74 가족 행동 ③ 루미 편지 수신 동의(opt-in) ──
    $('#pd-optin')?.addEventListener('change', async (e)=>{
      const email = (($('#pd-optin-email') && $('#pd-optin-email').value) || '').trim();
      try{
        const s = await api('/api/parent/optin', { email, optin: e.target.checked ? 1 : 0 });
        const em = $('#pd-optin-email');
        if(em) em.classList.toggle('hidden', !!s.optin);
        toast(s.optin ? '루미의 편지를 받기로 했어요' : '루미의 편지를 잠시 쉬어요');
      }catch(err){ e.target.checked = !e.target.checked; toast(err.message); }
    });
    $('#pd-memory')?.addEventListener('click', loadMemories);
    loadWeeklyLetter();
  }catch(e){ box.innerHTML = `<div class="pd-stat pd-wide"><span>${e.message}</span></div>`; }
}

// ---------- ★ v1.44 정비단 본부 : «멈춘 마을을 다시 켜기» ----------
//   한 판 게임이 아니라 날짜가 넘어가도 이어지는 마을 상태를 화면에 보여 준다.
//   - 어제 고친 시설은 «오늘 고침» 으로 남고, 안 고친 시설은 상태 바가 더 줄어든다.
//   - 정비는 기존 «인과 사슬» 진단을 그대로 재사용한다( rpStart({campaign:true}) ).
//   - 셀 은 주지 않는다. 대신 등급·기록·별빛·세계 변화·내일 예고가 남는다.
const camp = { state:null, busy:false, key:null, level:1 };

async function loadCampaign(){
  const box = $('#camp-facilities');
  if(!box) return;
  try{
    const r = await api('/api/campaign/state', undefined, 15000);
    camp.state = r;
    renderCampaign(r);
  }catch(e){
    box.innerHTML = `<div class="camp-empty">마을 상태를 불러오지 못했어요. ${esc(e.message)}</div>`;
  }
}
function renderCampaign(r){
  const g = r.grade;
  const GRADE_AT = [0, 3, 8, 15, 25];
  const prev = g.index === 1 ? 0 : GRADE_AT[g.index-2];
  const pct = g.nextAt ? Math.min(100, Math.round((g.repairs-prev)/(g.nextAt-prev)*100)) : 100;
  const badge = $('#camp-badge'); if(badge) badge.textContent = g.badge;
  const fill = $('#camp-grade-fill'); if(fill) fill.style.width = pct + '%';
  const note = $('#camp-grade-note');
  if(note) note.textContent = g.nextAt
    ? `정비 ${g.repairs}회 · 다음 등급까지 ${Math.max(0, g.nextAt-g.repairs)}회`
    : `정비 ${g.repairs}회 · 최고 등급이에요!`;

  const tn = $('#camp-tomorrow-note'); if(tn) tn.textContent = r.tomorrowNote;
  const tc = $('#camp-today-count');
  if(tc) tc.textContent = `오늘 정비 ${r.todayCount} / ${r.dailyLimit}회 · ${r.day}`;

  const at = $('#camp-act-title'); if(at) at.textContent = r.act.title;
  const ch = $('#camp-chapter'); if(ch) ch.textContent = `CH.${r.chapter.chapter} · ${r.chapter.topic}`;
  const ab = $('#camp-act-body'); if(ab) ab.textContent = `${r.chapter.line} ${r.act.body}`;

  const box = $('#camp-facilities');
  if(box){
    box.innerHTML = r.facilities.map(f => {
      const cls = f.condition >= 70 ? 'good' : (f.condition >= 40 ? 'mid' : 'bad');
      const canFix = f.abnormal && r.todayCount < r.dailyLimit;
      const tag = f.solvedToday ? '<span class="camp-tag done">오늘 고침 ✓</span>'
                : f.abnormal ? '<span class="camp-tag warn">이상 발견!</span>' : '';
      const label = f.solvedToday ? '오늘 완료'
                  : f.abnormal ? (r.todayCount >= r.dailyLimit ? '내일 또 고치자' : '정비 시작 →')
                  : '이상 없음';
      const blurb = f.solvedToday ? '오늘은 다시 켜졌어! 내일도 돌고 있을 거야.'
                  : f.abnormal ? f.blurb : '지금은 잘 돌고 있어요.';
      return `<div class="camp-card ${f.abnormal ? 'abnormal' : ''} ${f.solvedToday ? 'solved' : ''}">
        ${tag}
        <div class="camp-card-top"><span class="ic">${f.icon}</span><b>${esc(f.name)}</b>
          <span class="camp-lv">Lv.${f.level}</span></div>
        <div class="camp-cond"><i class="${cls}" style="width:${f.condition}%"></i></div>
        <div class="camp-meta"><span>상태 ${f.condition}%</span><span>정비 ${f.repairs}회</span></div>
        <p class="camp-blurb">${esc(blurb)}</p>
        <button class="btn primary small camp-btn" data-key="${f.key}" ${canFix ? '' : 'disabled'}>${label}</button>
      </div>`;
    }).join('');
    $$('#camp-facilities .camp-btn').forEach(btn => btn.addEventListener('click', ()=>{
      if(!btn.disabled) openCampaignRepair(btn.dataset.key);
    }));
  }

  const list = $('#camp-journal-list');
  if(list) list.innerHTML = r.journal.length
    ? r.journal.map(j => `<div class="camp-row"><b>${esc(String(j.day).slice(5))}</b>
        <span>${esc(j.title || '')} · ${esc(j.body || '')}</span><i>${j.lamps}등 · ${j.score}점</i></div>`).join('')
    : '<div class="camp-empty">아직 정비 기록이 없어요. 오늘 한 곳부터 고쳐 보세요.</div>';
  const jc = $('#camp-journal-count'); if(jc) jc.textContent = r.journal.length + '건';

  const sh = $('#camp-shards'); if(sh) sh.textContent = `${r.shards} / 8`;
  const lamps = $('#camp-lamps');
  if(lamps) lamps.innerHTML = Array.from({length:8}, (_,i)=>
    `<span class="camp-lamp ${i < r.shards ? 'on' : ''}">${i < r.shards ? '✦' : ''}</span>`).join('');
}

async function openCampaignRepair(key){
  if(camp.busy) return;
  camp.busy = true;
  try{
    const r = await api('/api/campaign/facility?key=' + encodeURIComponent(key), undefined, 15000);
    camp.key = key;
    camp.level = r.level;
    const title = $('#repair-title');
    if(title) title.textContent = `🛠️ ${r.facility.name} 정비 · Lv.${r.level}`;
    const hint = $('#repair-hint');
    if(hint) hint.textContent = '가장 위에서 멈춘 부품부터 바꿔요. 고치면 마을이 다시 켜져요.';
    const modal = $('#game-repair');
    if(modal) modal.classList.remove('hidden');
    rpStart({ campaign:true, key, level:r.level });
  }catch(e){ toast(e.message); }
  finally{ camp.busy = false; }
}

async function submitCampaignRepair(){
  const lamps = rp.lit ? rp.lit.size : 0;
  const score = rp.score;
  const spares = rp.spares;
  const rr = $('#repair-result');
  try{
    const r = await api('/api/campaign/repair',
      { key:camp.key, score, lamps, spares: 0 }, 15000);
    rpBanner(`✓ 정비 완료 · 상태 ${r.condition}% (Lv.${r.level})`, 'ok');
    rpNote(r.gradeUp ? `등급이 올랐어요! ${r.grade.badge}` : '정비 기록에 남겼어요. 내일도 그대로 돌고 있을 거예요.');
    if(rr) rr.textContent = `✓ ${r.levelUp ? '레벨 업! ' : ''}${r.gradeUp ? '등급 승급! ' : ''}마을이 다시 켜졌어요`;
    bubble(r.gradeUp ? `등급 승급! ${r.grade.badge}` : '마을이 다시 켜졌어요!');
    await loadCampaign();
    if(window.World && typeof window.World.refreshVillage === 'function') window.World.refreshVillage();
    setTimeout(()=>closeGame('game-repair'), 1900);
  }catch(e){
    if(rr) rr.innerHTML = `<span style="color:#c92a2a">${esc(e.message)}</span>`;
    rpNote(e.message);
  }
}

// ---------- ★ v1.42 고장 탐정 · 멈춘 기계의 사슬 ----------
//   피드백 «여전히 기억력 게임» → «관찰 3초 → 기억 → 점 선택» 을 버리고 «인과 진단» 으로 바꿨다.
//   전기는 왼쪽(발전기)에서 오른쪽(램프)으로 흐르고, 고장 부품은 그 자리에서 길을 막아
//   뒤쪽을 모두 세운다. 아이는 «가장 위에서 멈춘 부품» 을 찾고, 새 부품은 고장 수보다 적어
//   «어느 가지를 살릴지» 선택해야 한다. 화면의 정보는 사라지지 않으므로 기억력은 쓰이지 않는다.
const RP_TOTAL = 90;
const RP_LAMP_SCORE = 150, RP_CLEAR_SCORE = 120, RP_SPARE_SCORE = 60, RP_TIME_SCORE = 2;

// ★ v1.46 난이도: «초록 구간» 안에서 손을 떼야 성공. 레벨이 오를수록 구간이 좁고 빨라진다.
//   speed = 100ms 당 충전량(6 = 초당 60) · heat = 초당 과열 · power = 전력 상한
const RP_ZONES = [
  { lo:55, hi:95, speed:6,  heat:5,  power:100 },   // Lv.1 — 넓고 느림(학습)
  { lo:68, hi:92, speed:8,  heat:8,  power:85  },   // Lv.2 — 좁아지고 빨라짐
  { lo:75, hi:90, speed:10, heat:12, power:70  }    // Lv.3 — 좁고 빠르고 뜨거움
];
function rpCfg(){ return RP_ZONES[Math.max(0, Math.min(2, rp.idx))] || RP_ZONES[0]; }

const RP_MACHINES = [
  {
    name: '오래된 세탁기', spares: 2, faults: ['b'],
    nodes: [
      { id:'p',  x:8,  y:50, kind:'power', icon:'⚡', label:'전원' },
      { id:'a',  x:26, y:50, kind:'gear',  icon:'⚙️', label:'기어' },
      { id:'b',  x:47, y:24, kind:'gear',  icon:'⚙️', label:'기어' },
      { id:'c',  x:47, y:76, kind:'pump',  icon:'💧', label:'펌프' },
      { id:'L1', x:77, y:24, kind:'lamp',  icon:'💡', label:'램프' },
      { id:'L2', x:77, y:76, kind:'lamp',  icon:'💡', label:'램프' }
    ],
    edges: [['p','a'],['a','b'],['a','c'],['b','L1'],['c','L2']]
  },
  {
    name: '마을 시계탑', spares: 2, faults: ['c','d'],
    nodes: [
      { id:'p',  x:7,  y:50, kind:'power', icon:'⚡', label:'전원' },
      { id:'a',  x:22, y:50, kind:'gear',  icon:'⚙️', label:'기어' },
      { id:'b',  x:42, y:20, kind:'gear',  icon:'⚙️', label:'기어' },
      { id:'c',  x:42, y:50, kind:'valve', icon:'🔧', label:'밸브' },
      { id:'d',  x:58, y:50, kind:'gear',  icon:'⚙️', label:'기어' },
      { id:'e',  x:42, y:80, kind:'pump',  icon:'💧', label:'펌프' },
      { id:'L1', x:74, y:20, kind:'lamp',  icon:'💡', label:'종' },
      { id:'L2', x:83, y:50, kind:'lamp',  icon:'💡', label:'램프' },
      { id:'L3', x:74, y:80, kind:'lamp',  icon:'💡', label:'램프' }
    ],
    edges: [['p','a'],['a','b'],['a','c'],['a','e'],['b','L1'],['c','d'],['d','L2'],['e','L3']]
  },
  {
    name: '별빛 발전기', spares: 2, faults: ['b','d','e'],
    nodes: [
      { id:'p',  x:6,  y:50, kind:'power', icon:'⚡', label:'전원' },
      { id:'a',  x:19, y:50, kind:'gear',  icon:'⚙️', label:'기어' },
      { id:'b',  x:37, y:15, kind:'gear',  icon:'⚙️', label:'기어' },
      { id:'c',  x:37, y:50, kind:'valve', icon:'🔧', label:'밸브' },
      { id:'d',  x:53, y:50, kind:'pump',  icon:'💧', label:'펌프' },
      { id:'e',  x:37, y:85, kind:'gear',  icon:'⚙️', label:'기어' },
      { id:'f',  x:53, y:85, kind:'gear',  icon:'⚙️', label:'기어' },
      { id:'g',  x:67, y:85, kind:'valve', icon:'🔧', label:'밸브' },
      { id:'L1', x:72, y:15, kind:'lamp',  icon:'💡', label:'램프' },
      { id:'L2', x:80, y:50, kind:'lamp',  icon:'💡', label:'램프' },
      { id:'L3', x:88, y:85, kind:'lamp',  icon:'💡', label:'램프' }
    ],
    edges: [['p','a'],['a','b'],['a','c'],['a','e'],['b','L1'],['c','d'],['d','L2'],
            ['e','f'],['f','g'],['g','L3']]
  }
];

const rp = {
  idx: 0, score: 0, time: RP_TOTAL, spares: 0, litCount: 0,
  // training = 3대 90초 연습 / campaign = 본부에서 호출한 «한 대» 정비 임무
  phase: 'idle', mode: 'training', campKey: null,
  fixed: new Set(), lit: new Set(),
  // v1.45 «손으로 고치기»: 점선택이 아니라 «꾹 눌러 충전» + 전력/과열 관리
  power: 100, powerMax: 100, heat: {}, locked: new Set(), repair: null,
  clock: null, timers: [], submitted: false
};

function rpMachine() { return RP_MACHINES[rp.idx] || RP_MACHINES[0]; }
function rpNode(id) { return rpMachine().nodes.find(n => n.id === id) || null; }
function rpLabelOf(id) { const n = rpNode(id); return n ? n.label : id; }
// 검증용 상태 — 대세계의 window.__worldState 와 같은 방식
function rpSym() {
  try {
    const m = rpMachine();
    const s = rpSolve(m);
    window.__repairState = {
      phase: rp.phase, idx: rp.idx, score: rp.score, spares: rp.spares,
      mode: rp.mode, campKey: rp.campKey,
      power: Math.round(rp.power), heat: Object.assign({}, rp.heat),
      locked: [...rp.locked],
      repair: rp.repair ? { id: rp.repair.id, p: Math.round(rp.repair.p), holding: rp.repair.holding } : null,
      time: Math.round(rp.time * 10) / 10,
      faults: m.faults.slice(), fixed: [...rp.fixed], lit: [...rp.lit],
      live: [...s.live], faultSet: [...s.faultSet],
      parts: m.nodes.length, lamps: m.nodes.filter(n => n.kind === 'lamp').length,
      litCount: rp.litCount
    };
  } catch (e) { }
}
function rpBanner(text, kind) {
  const el = $('#repair-banner');
  if (!el) return;
  el.className = 'repair-banner' + (kind ? ' ' + kind : '');
  el.textContent = text;
}
function rpNote(text) {
  const el = $('#repair-note');
  if (el) el.textContent = text;
}
let _rpAudio = null;
function rpBeep(freq, dur, type) {
  // 소리는 «보상 피드백» 일 뿐이다. 무음/차단 환경에서도 게임은 그대로 돈다.
  try {
    if (!_rpAudio) _rpAudio = new (window.AudioContext || window.webkitAudioContext)();
    const o = _rpAudio.createOscillator(), g = _rpAudio.createGain();
    o.type = type || 'sine';
    o.frequency.value = freq;
    g.gain.value = 0.045;
    o.connect(g); g.connect(_rpAudio.destination);
    o.start(); o.stop(_rpAudio.currentTime + (dur || 0.09));
  } catch (e) { }
}
function rpChime() {
  [523, 659, 784].forEach((f, i) => setTimeout(() => rpBeep(f, 0.12, 'triangle'), i * 110));
}
function rpUpdateHud() {
  const s = $('#rp-score'); if (s) s.textContent = String(rp.score);
  const t = $('#rp-time'); if (t) t.textContent = String(Math.ceil(rp.time));
  const p = $('#rp-power'); if (p) p.textContent = String(Math.round(rp.power));
  const pf = $('#rp-powerfill'); if (pf) pf.style.width = Math.round(rp.power) + '%';
  const m = $('#rp-machines'); if (m) m.textContent = `${rp.idx + 1}/${RP_MACHINES.length}`;
}
function rpStopClock() { if (rp.clock) { clearInterval(rp.clock); rp.clock = null; } }
function rpStopTimers() {
  (rp.timers || []).forEach(t => clearTimeout(t));
  rp.timers = [];
}
function rpStop() {
  rpStopClock(); rpStopTimers();
  rp.phase = 'idle';
  rp.time = RP_TOTAL;
  rp.power = 100; rp.heat = {}; rp.locked = new Set(); rp.repair = null;
  rpSym();
}
// 전원에서 시작해 «고장 부품을 만나면 멈추는» BFS.
// 고장 부품 자신은 live 에 들어간다(전기는 들어오지만 통과는 못 한다) → 빨간색으로 표시된다.
function rpSolve(m) {
  const faultSet = new Set(m.faults.filter(id => !rp.fixed.has(id)));
  const adj = {};
  m.edges.forEach(([a, b]) => { (adj[a] = adj[a] || []).push(b); });
  const live = new Set(['p']);
  const q = ['p'];
  while (q.length) {
    const cur = q.shift();
    if (faultSet.has(cur)) continue;
    for (const nx of adj[cur] || []) {
      if (!live.has(nx)) { live.add(nx); q.push(nx); }
    }
  }
  return { live, faultSet };
}
function rpUpstreamFaulty(id, m, faultSet) {
  const rev = {};
  m.edges.forEach(([a, b]) => { (rev[b] = rev[b] || []).push(a); });
  const seen = new Set();
  const q = [...(rev[id] || [])];
  while (q.length) {
    const cur = q.shift();
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (faultSet.has(cur)) return cur;
    (rev[cur] || []).forEach(x => q.push(x));
  }
  return null;
}
function rpFlash(id) {
  const el = $(`.rp-node[data-id="${id}"]`);
  if (!el) return;
  el.classList.add('rp-flash');
  rp.timers.push(setTimeout(() => el.classList.remove('rp-flash'), 700));
}
// 100ms 마다: 전력 회복 → 과열 → 수리 진행 → 화면 갱신
function rpTick(){
  if(rp.phase !== 'play') return;
  const m = rpMachine();
  const { faultSet } = rpSolve(m);
  const holding = !!(rp.repair && rp.repair.holding);
  // 전력을 쓰는 동안에는 회복하지 않는다 → «쉬어 가며 고치기» 가 생긴다
  if(!holding) rp.power = Math.min(100, rp.power + 1.2);
  const rate = [5, 7, 9][Math.max(0, Math.min(2, rp.idx))] || 5;
  faultSet.forEach(id => {
    const h = Math.min(100, (rp.heat[id] || 0) + rate * 0.1);
    rp.heat[id] = h;
    if(h >= 100) rp.locked.add(id);
  });
  if(rp.repair){
    if(rp.repair.holding){
      if(rp.power <= 0){
        rp.repair.holding = false;
        rpNote('전력이 떨어졌어요. 잠깐 쉬었다가 다시 눌러요.');
      } else {
        rp.power = Math.max(0, rp.power - 1.2);
        // 과열로 «잠긴» 부품은 손이 두 배 더 든다 — 늦게 발견한 대가
        rp.repair.p += rp.locked.has(rp.repair.id) ? 3 : 6;
      }
    } else {
      rp.repair.p -= 9;
    }
    if(rp.repair.p >= 100){
      const id = rp.repair.id;
      rp.fixed.add(id);
      rp.heat[id] = 0;
      rp.locked.delete(id);
      rp.repair = null;
      rpBeep(760, 0.1, 'triangle');
      const res = rpPaint();
      rpNote(`«${rpLabelOf(id)}» 을 고쳤어요!`);
      if(res.allLit) rpMachineClear();
    } else if(rp.repair.p <= 0){
      rp.repair = null;
    }
  }
  rpPaintStatus();
  rpUpdateHud();
}
function rpPaintStatus(){
  const host = $('#repair-machine');
  if(!host) return;
  host.querySelectorAll('.rp-node').forEach(el => {
    const id = el.dataset.id;
    const ring = el.querySelector('.rp-ring');
    if(ring) ring.style.setProperty('--p', String(rp.repair && rp.repair.id === id ? Math.round(rp.repair.p) : 0));
    const heat = el.querySelector('.rp-heat');
    if(heat) heat.style.setProperty('--h', String(Math.round(rp.heat[id] || 0)));
    el.classList.toggle('locked', rp.locked.has(id));
    el.classList.toggle('fixing', !!(rp.repair && rp.repair.id === id && rp.repair.holding));
  });
  rpSym();   // 100ms 마다 갱신되는 실제 상태를 검증/디버그에서도 볼 수 있게
}
function rpPressStart(id){
  if(rp.phase !== 'play') return;
  const n = rpNode(id);
  if(!n) return;
  if(n.kind === 'power') return rpNote('전원은 그대로예요.');
  if(n.kind === 'lamp') return rpNote('램프는 고칠 수 없어요. 전기가 오는 길을 찾아보세요.');
  if(rp.fixed.has(id)) return rpNote('이미 고친 부품이에요.');
  const m = rpMachine();
  const { faultSet } = rpSolve(m);
  if(!faultSet.has(id)){
    const up = rpUpstreamFaulty(id, m, faultSet);
    if(up){ rpNote(`«${rpLabelOf(up)}» 이 먼저예요. 위에서 길이 막혀 있어요.`); rpFlash(up); }
    else rpNote('여기는 전기가 지나가고 있어요. 다른 곳을 보세요.');
    return;
  }
  const up = rpUpstreamFaulty(id, m, faultSet);
  if(up){ rpNote(`«${rpLabelOf(up)}» 이 먼저예요. 그곳이 막고 있어요.`); rpFlash(up); return; }
  if(rp.power < 10) return rpNote('전력이 부족해요. 잠깐 기다려요.');
  if(rp.repair && rp.repair.id !== id) rp.repair = null;
  rp.repair = { id, p: (rp.repair && rp.repair.id === id) ? rp.repair.p : 0, holding: true };
  rpNote('꾹 누르고 있어요… 초록 테두리가 가득 차면 손을 떼요.');
  rpPaintStatus();
}
function rpPressEnd(){
  if(rp.repair) rp.repair.holding = false;
}
function rpBuild() {
  const m = rpMachine();
  const host = $('#repair-machine');
  if (!host) return;
  host.innerHTML = '';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'rp-links');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  m.edges.forEach(([a, b]) => {
    const na = rpNode(a), nb = rpNode(b);
    if (!na || !nb) return;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', na.x); line.setAttribute('y1', na.y);
    line.setAttribute('x2', nb.x); line.setAttribute('y2', nb.y);
    line.dataset.edge = a + '>' + b;
    svg.appendChild(line);
  });
  host.appendChild(svg);
  m.nodes.forEach(n => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rp-node';
    btn.dataset.id = n.id;
    btn.style.left = n.x + '%';
    btn.style.top = n.y + '%';
    btn.setAttribute('aria-label', n.label);
    if (n.kind === 'lamp') btn.classList.add('lamp');
    if (n.kind === 'power') btn.classList.add('power');
    btn.innerHTML = `<span aria-hidden="true">${n.icon}</span><small>${n.label}</small>
      <i class="rp-ring" aria-hidden="true"></i><i class="rp-heat" aria-hidden="true"></i>`;
    // v1.45: «꾹 누르기» — 누르고 있는 동안만 수리가 차오른다(손을 떼면 되돌아간다).
    btn.addEventListener('pointerdown', e => { e.preventDefault(); rpPressStart(n.id); });
    btn.addEventListener('pointerup', e => { e.preventDefault(); rpPressEnd(); });
    btn.addEventListener('pointerleave', rpPressEnd);
    btn.addEventListener('pointercancel', rpPressEnd);
    host.appendChild(btn);
  });
}
// 상태를 칠하고, 새로 켜진 등을 점수로 바꾼다. 반환값은 이번 판정 결과.
function rpPaint() {
  const m = rpMachine();
  const { live, faultSet } = rpSolve(m);
  const host = $('#repair-machine');
  if (!host) return { lamps: [], allLit: false };
  host.querySelectorAll('.rp-node').forEach(el => {
    const id = el.dataset.id;
    const n = rpNode(id);
    if (!n) return;
    el.classList.remove('live', 'dead', 'faulty', 'fixed', 'overload');
    if (n.kind === 'power') { el.classList.add('live'); return; }
    if (faultSet.has(id)) { el.classList.add('faulty'); return; }
    if (rp.fixed.has(id)) { el.classList.add('fixed', 'live'); return; }
    if (live.has(id)) { el.classList.add('live'); return; }
    el.classList.add(n.kind === 'lamp' ? 'dead' : 'overload');
  });
  host.querySelectorAll('line').forEach(line => {
    const [a, b] = String(line.dataset.edge || '').split('>');
    // 선은 «양끝에 전기가 있고, 앞쪽이 고장이 아닐 때» 흐른다.
    const on = live.has(a) && live.has(b) && !faultSet.has(a);
    line.classList.toggle('live', on);
  });
  const lamps = m.nodes.filter(n => n.kind === 'lamp');
  const litNow = lamps.filter(n => live.has(n.id)).map(n => n.id);
  litNow.forEach(id => {
    if (!rp.lit.has(id)) {
      rp.lit.add(id);
      rp.litCount++;
      rp.score += RP_LAMP_SCORE;
    }
  });
  rpUpdateHud(); rpPaintStatus(); rpSym();
  return { lamps, allLit: litNow.length === lamps.length };
}
function openRepair() {
  const modal = $('#game-repair');
  if (!modal) return;
  rpStop();
  rp.mode = 'training'; rp.campKey = null;
  rp.idx = 0; rp.score = 0; rp.spares = 0; rp.litCount = 0;
  rp.fixed = new Set(); rp.lit = new Set(); rp.submitted = false;
  const title = $('#repair-title'); if (title) title.textContent = '🛠️ 고장 탐정 · 멈춘 기계의 사슬';
  const hint = $('#repair-hint');
  if (hint) hint.textContent = '전기가 지나가는 길을 따라가며 «가장 위에서 멈춘 부품» 을 찾아요. 위를 고치면 아래도 함께 살아나요. 대신 새 부품은 한정되어 있어요.';
  const host = $('#repair-machine'); if (host) host.innerHTML = '';
  const rr = $('#repair-result'); if (rr) rr.innerHTML = '';
  const btn = $('#repair-go'); if (btn) { btn.textContent = '시작하기'; btn.disabled = false; }
  rpBanner('준비되면 «시작하기» 를 눌러요');
  rpNote('빨간 부품이 «멈춘 곳» 이에요. 전원에서 램프까지 길을 따라가 보세요.');
  rpUpdateHud();
  rpSym();
  modal.classList.remove('hidden');
}
function rpStart(opts) {
  // 본부 임무는 «한 대만» 고친다. 90초 시계도, 3대 연속도 없다.
  const isCamp = !!(opts && opts.campaign);
  rpStopTimers();
  rp.mode = isCamp ? 'campaign' : 'training';
  rp.campKey = isCamp ? opts.key : null;
  rp.idx = isCamp
    ? Math.max(0, Math.min(RP_MACHINES.length - 1, (Number(opts.level) || 1) - 1))
    : 0;
  rp.score = 0; rp.time = isCamp ? 60 : RP_TOTAL; rp.litCount = 0;
  rp.power = 100; rp.heat = {}; rp.locked = new Set(); rp.repair = null;
  rp.fixed = new Set(); rp.lit = new Set(); rp.submitted = false;
  const btn = $('#repair-go');
  if (btn) { btn.textContent = '진행 중…'; btn.disabled = true; }
  const rr = $('#repair-result'); if (rr) rr.innerHTML = '';
  rpLoadMachine();
  rpStopClock();
  if (isCamp) {
    const fac = ((camp.state && camp.state.facilities) || []).find(f => f.key === rp.campKey);
    if (fac) rpBanner(`🔧 ${fac.name} 정비 · Lv.${rp.idx + 1}`, 'warn');
  }
  rp.clock = setInterval(() => {
    if (rp.phase !== 'play') return;
    rp.time = Math.max(0, rp.time - 0.1);
    const t = $('#rp-time'); if (t) t.textContent = String(Math.ceil(rp.time));
    rpTick();
    if (rp.time <= 0) { rpStopClock(); rpEnd(); }
  }, 100);
}
function rpLoadMachine() {
  const m = rpMachine();
  rp.phase = 'play';
  rp.fixed = new Set();
  rp.lit = new Set();
  rp.spares = m.spares;
  rp.power = 100; rp.heat = {}; rp.locked = new Set(); rp.repair = null;
  rpBuild();
  const res = rpPaint();
  rpBanner(`① ${m.name} — 어디서 멈췄나요?`, 'warn');
  rpNote(`전력 100 · 등 ${res.lamps.length}개 · 빨간 부품을 «꾹 눌러» 고쳐요.`);
  rpSym();
}
// v1.45: 예전 «한 번 클릭» 호출과의 호환용. 실제 수리는 «꾹 누르기» 로만 진행된다.
function rpTap(id) { rpPressStart(id); }
function rpMachineClear() {
  if (rp.phase !== 'play') return;
  rp.phase = 'machineDone';
  rp.score += RP_CLEAR_SCORE;
  rpBanner(`✓ ${rpMachine().name} 복구 완료`, 'ok');
  rpNote(`남은 전력 ${Math.round(rp.power)} · 다음 기계도 «꾹 눌러» 고쳐요.`);
  rpUpdateHud(); rpSym();
  rpChime();
  rp.timers.push(setTimeout(rpNext, 1600));
}
function rpMachineGiveUp() {
  if (rp.phase !== 'play') return;
  rp.phase = 'machineDone';
  rpBanner(`전력이 바닥났어요 · ${rpMachine().name}`, 'warn');
  rpNote('다음 기계에서는 «가장 위» 부품부터, 전력을 아끼며 고쳐 보세요.');
  rpUpdateHud(); rpSym();
  rp.timers.push(setTimeout(rpNext, 1600));
}
function rpNext() {
  if (rp.mode === 'campaign') return rpEnd();
  if (rp.idx + 1 < RP_MACHINES.length) {
    rp.idx++;
    rpLoadMachine();
  } else {
    rpEnd();
  }
}
function rpEnd() {
  if (rp.phase === 'over') return;
  rpStopClock(); rpStopTimers();
  rp.phase = 'over';
  const isCamp = rp.mode === 'campaign';
  const bonus = isCamp ? 0 : Math.max(0, Math.round(rp.time)) * RP_TIME_SCORE;
  rp.score += bonus;
  const totalLamps = isCamp
    ? rpMachine().nodes.filter(n => n.kind === 'lamp').length
    : RP_MACHINES.reduce((a, m) => a + m.nodes.filter(n => n.kind === 'lamp').length, 0);
  if (!isCamp) rpBanner(`정산 · ${rp.score}점 (남은 시간 +${bonus})`, 'ok');
  rpNote(`켠 등 ${rp.litCount}/${totalLamps} · 남은 전력 ${Math.round(rp.power)}`);
  rpUpdateHud(); rpSym();
  const btn = $('#repair-go');
  if (btn) { btn.disabled = false; btn.textContent = '다시 시작'; }
  if (isCamp) {
    // 본부 임무는 /api/game/result 가 아니라 «마을 상태» 를 갱신한다.
    rp.submitted = true;
    submitCampaignRepair();
    return;
  }
  if (!rp.submitted && rp.score >= 100) {
    rp.submitted = true;
    submitGameResult('repair', { score: rp.score }, btn);
  }
}
// ══════════════════════════════════════════════════════════════════════════
// ★ v1.46 «빛의 병 정리» — 참고 이미지(레벨 16 · 색 층 병 · 되돌리기/섞기/빈 병 추가)
//   의 «물병 색 맞추기» 규칙을 도로랜드로 가져온 레벨형 퍼즐.
//
//   그대로 가져온 규칙: 위쪽 같은 색 덩어리만 / 빈 병 또는 같은 색 위로 / 병 4층 / 색 모으면 완성.
//   우리 규칙(복제가 되지 않게 얹은 두 가지):
//     1) «고장 난 병»  : 빈 병 하나가 금이 가 있다. 꾹 눌러 고쳐야 열린다(v1.45 손으로 고치기 계승, 전력 30).
//     2) «헤맨 부음»   : 판을 더 섞는 붓기는 감점 없이 기록되고, 3번마다 힌트 1개가 된다(v1.39 오답을 자산으로).
//   난이도: 레벨이 오를수록 색 3→8, 빈 병 2→1, 고장 난 병 등장. 도구는 레벨마다 2/3/3/3.
//   경제: 셀을 주지 않는다(일 상한 393 < 일회성 상품 400). 보상은 레벨·별·기록 자체다.
//   ★ 무작위로 섞으면 «풀 수 없는 판» 이 나온다. 그래서 «이미 완성된 상태에서 역방향으로 붓기» 로
//     판을 만들고, 매 판을 solver 로 다시 검증한 뒤에만 시작한다.
// ══════════════════════════════════════════════════════════════════════════
const SORT_CAP = 4;
const SORT_VAULT_CAP = 2;                 // «보관 병» 은 어떤 색이든 2층까지만 잠시 담는다
const SORT_TOOL_COST = { undo:4, shuffle:6, bottle:8, hint:5, charge:6 };
const SORT_COLORS = [
  { c:'#7ed957', sym:'●', name:'풀빛' }, { c:'#3b82f6', sym:'▲', name:'물빛' },
  { c:'#ffd43b', sym:'■', name:'해빛' }, { c:'#fb5b78', sym:'◆', name:'불빛' },
  { c:'#ff8c32', sym:'★', name:'노을빛' }, { c:'#9b6cf0', sym:'✿', name:'보라빛' },
  { c:'#ff7ac6', sym:'⬟', name:'분홍빛' }, { c:'#8ea6d6', sym:'✦', name:'구름빛' }
];
const SORT_STORE = 'roomi_sort_progress_v1';
const sort = {
  phase:'idle', level:1, colors:3, bottles:[], locked:new Set(), broken:-1,
  vault:-1,                                    // ★ v1.47 보관 병 index (L2+)
  sel:null, moves:0, par:0, solution:[], guaranteed:[], stars:0,
  tools:{ undo:1, shuffle:1, bottle:1, hint:1, charge:1 }, power:100,
  shards:0, toolUses:0,                        // ★ 빛 조각 · 제작소
  pressure:0, surges:0, blackout:0,           // ★ 서지 압력 · 정전(조각 획득 정지 수)
  orders:[], order:null, orderDone:false, orderFailed:false, firstColor:-1, missions:0,
  mode:'level', timeLeft:0, streak:0, bestStreak:0, clock:null,   // ★ v1.48 도전 모드
  wanders:0, earnedHints:0, history:[], hintCells:[], pourTarget:-1,
  repairing:null, timer:null, justRepaired:false, submitted:false,
  serverProgress:null, note:''
};

function sortCfg(lv){
  return {
    colors: Math.min(8, 2 + Math.ceil(lv/2)),   // L1~2:3색, L3~4:4색 … L11~:8색
    free: lv >= 9 ? 1 : 2,                     // 고레벨은 자유 빈 병이 하나 줄어든다
    broken: lv >= 4 ? 1 : 0                    // L4부터 «금이 간 병» 등장
  };
}
function sortPressureStep(lv){ return lv>=9 ? 12 : lv>=4 ? 10 : 8; }
// 한 병 안의 «색 덩어리» 수.
function sortRuns(b){ let r=0, p=-1; for(const c of b){ if(c!==p){ r++; p=c; } } return r; }
// ★ 합법적인 붓기는 색 덩어리 수를 «절대 늘리지 않는다»(덩어리가 합쳐지거나 빈 병에 생길 뿐).
//   그래서 «늘어남» 을 헤맨 부음으로 잡으면 영원히 발생하지 않는다. 대신
//   «덩어리 수도 줄지 않고 병도 완성되지 않은 붓기» = 판이 나아지지 않은 한 수 로 정의한다.
function sortBoardScore(b, vault=-1){
  let runs=0, done=0;
  b.forEach((x,i)=>{ runs+=sortRuns(x); if(i!==vault && sortComplete(x)) done++; });
  // 보관 병에 무언가 남아 있으면 «아직 정리가 덜 됐다» 는 신호를 준다.
  return runs*2 - done + (vault>=0 && b[vault] && b[vault].length ? 2 : 0);
}
// ★ 보관 병은 «비워야» 승리다. 일반 병은 4층 한 색으로 차야 한다.
function sortWon(b, vault=-1){
  if(vault>=0 && b[vault] && b[vault].length) return false;
  return b.every((x,i)=> i===vault ? true
    : (x.length===0 || (x.length===SORT_CAP && x.every(c=>c===x[0]))));
}
function sortComplete(b){ return b.length===SORT_CAP && b.every(c=>c===b[0]); }
// ★ v1.47: vault 가 있으면 «어떤 색이든 1층 보관 / 1층 꺼내기» 수가 추가된다.
//   이 수는 선택 사항이라 기존 «보장 경로» 를 절대 무효화하지 않는다.
function sortMovesAll(b, locked, vault=-1){
  const out=[];
  const capOf = i => i===vault ? SORT_VAULT_CAP : SORT_CAP;
  for(let i=0;i<b.length;i++){
    if(locked && locked.has(i)) continue;
    const s=b[i]; if(!s.length) continue;
    if(i!==vault && sortComplete(s)) continue;
    const c=s[s.length-1];
    let run=1; for(let k=s.length-2;k>=0&&s[k]===c;k--) run++;
    for(let j=0;j<b.length;j++){
      if(i===j || (locked && locked.has(j))) continue;
      const t=b[j], room=capOf(j)-t.length;
      if(room<=0) continue;
      if(j===vault){ out.push([i,j,1]); continue; }              // 보관: 아무 색 1층
      if(t.length && t[t.length-1]!==c) continue;
      if(!t.length && run===s.length && i!==vault) continue;    // 통째로 빈 병 이동은 무의미
      out.push([i,j,i===vault ? 1 : Math.min(run,room)]);        // 꺼내기도 1층씩
    }
  }
  return out;
}
// DFS + 방문 상태 정규화. 보관 병은 «특수 병» 이라 정렬 키에서 분리한다.
function sortSolve(b, locked, limit, vault=-1){
  const seen=new Set(); let nodes=0, answer=null;
  const keyOf = st => (vault>=0 ? 'V'+st[vault].join('-')+'|' : '')
    + st.filter((_,i)=>i!==vault).map(x=>x.join('-')).sort().join('|');
  const gain = (m, st) => {
    const [i,j,n]=m, s=st[i], t=st[j];
    let v=n*2;
    if(t.length) v+=6;
    if(j!==vault && t.length && t.length+n===SORT_CAP && t.every(c=>c===s[s.length-1])) v+=14;
    if(s.length===n) v+=2;
    if(!t.length) v-=1;
    if(j===vault) v-=9;          // 보관은 «우회» 다. solver 가 남용하지 않게 낮춘다.
    if(i===vault) v+=3;
    return v;
  };
  function dfs(st, path, depth){
    if(answer) return true;
    if(++nodes>limit) return false;
    if(sortWon(st,vault)){ answer=path.slice(); return true; }
    if(depth>72) return false;
    const k=keyOf(st); if(seen.has(k)) return false; seen.add(k);
    const mv=sortMovesAll(st,locked,vault).sort((a,z)=>gain(z,st)-gain(a,st));
    for(const m of mv){
      const nx=st.map(x=>x.slice());
      for(let q=0;q<m[2];q++) nx[m[1]].push(nx[m[0]].pop());
      path.push(m);
      if(dfs(nx,path,depth+1)) return true;
      path.pop();
    }
    return false;
  }
  dfs(b.map(x=>x.slice()),[],0);
  return answer;
}
// «완성된 상태 → 역방향 붓기» 로 판을 만든다.
//   정방향으로 되돌릴 수 있는 수만 고르므로 결과 판은 구조상 반드시 풀린다.
//   steps 배열을 뒤집으면 그대로 «정답 경로» 가 된다(solver 실패 시에도 par 를 잃지 않는다).
function sortBuild(lv){
  const cfg=sortCfg(lv);
  const b=[];
  for(let c=0;c<cfg.colors;c++) b.push(Array(SORT_CAP).fill(c));
  for(let e=0;e<cfg.free;e++) b.push([]);
  const broken = cfg.broken ? b.length : -1;
  if(cfg.broken) b.push([]);
  const steps=[];
  const totalSteps=12+cfg.colors*6;
  for(let s=0;s<totalSteps;s++){
    const cand=[];
    for(let j=0;j<b.length;j++){
      const t=b[j]; if(!t.length) continue;
      const c=t[t.length-1];
      let r=1; for(let k=t.length-2;k>=0&&t[k]===c;k--) r++;
      for(let n=1;n<=r;n++){
        const rest=r-n;
        // j' 위에 다른 색이 남으면 정방향으로 다시 부을 수 없다.
        if(rest===0 && t.length-n>0) continue;
        for(let i=0;i<b.length;i++){
          if(i===j) continue;
          const src=b[i];
          if(src.length+n>SORT_CAP) continue;
          if(src.length && src[src.length-1]===c) continue;         // 덩어리 합쳐지면 역추적이 어긋난다
          if(src.length===0 && rest===0) continue;                   // 통째 이동은 규칙상 막혀 있다
          if(src.length+n===SORT_CAP && src.every(x=>x===c)) continue; // 완성 병은 규칙상 못 옮긴다
          cand.push([j,i,n,c]);
        }
      }
    }
    if(!cand.length) break;
    const pick=cand[Math.floor(Math.random()*cand.length)];
    const [j,i,n,c]=pick;
    for(let k=0;k<n;k++) b[i].push(c);
    for(let k=0;k<n;k++) b[j].pop();
    steps.push([i,j,n]);
  }
  if(steps.length<4) return null;
  const guaranteed=steps.slice().reverse();
  // 역방향 생성은 «이론상» 항상 풀리지만, 실제 규칙 구현과 한 번 더 맞대본다.
  const solved=sortSolve(b,new Set(),24000);
  if(!solved) return null;
  return { cfg, bottles:b, broken, guaranteed, solved };
}
// ─────────── ★ v1.47 «주문서» : 한 판의 목표를 아이가 고른다 ───────────
//   실패해도 감점·재시작 없이 «주문서만 놓친다». 다른 목표로 다시 올 수 있게 2택1.
function sortMakeOrders(colors, par){
  const first = Math.floor(Math.random()*colors);
  const pool=[
    { type:'speed', target:par+2, tag:'SPEED', label:`${par+2}수 안에 끝내기`,
      desc:`기준 ${par}수보다 조금 여유가 있어요. 헤맨 부음을 줄이면 좋아요.` },
    { type:'thrifty', target:2, tag:'SAVE', label:'도구 2개 이하로 끝내기',
      desc:'되돌리기·힌트·빈 병·충전을 합쳐 2번만 써요. 조각을 아끼는 판이에요.' },
    { type:'order', target:first, tag:'ORDER', label:`${SORT_COLORS[first].name}을 가장 먼저 완성`,
      desc:'다른 색보다 먼저 이 빛을 한 병에 4층 모아요. 순서를 정하는 재미!' }
  ];
  const a=Math.floor(Math.random()*pool.length);
  const b=(a+1+Math.floor(Math.random()*(pool.length-1)))%pool.length;
  return [pool[a],pool[b]];
}
function sortOrderText(){
  const o=sort.order; if(!o) return '';
  const tail=sort.orderDone?'✓ 완료':sort.orderFailed?'· 놓쳤어요(괜찮아요!)':
    o.type==='speed'?`${sort.moves}/${o.target}수`:
    o.type==='thrifty'?`도구 ${sort.toolUses}/${o.target}개`:
    (sort.firstColor<0?'첫 완성 대기 중':`첫 완성 ${SORT_COLORS[sort.firstColor].name}`);
  return `📜 ${o.label} — ${tail}`;
}
function sortOrderCheck(){
  const o=sort.order; if(!o||sort.orderDone||sort.orderFailed) return;
  if(o.type==='speed' && sort.moves>o.target) sort.orderFailed=true;
  if(o.type==='thrifty' && sort.toolUses>o.target) sort.orderFailed=true;
  if(o.type==='order' && sort.firstColor>=0){
    if(sort.firstColor===o.target) sort.orderDone=true; else sort.orderFailed=true;
  }
}
function sortOrderFinish(){
  const o=sort.order; if(!o||sort.orderDone||sort.orderFailed) return;
  if(o.type==='speed' && sort.moves<=o.target) sort.orderDone=true;
  if(o.type==='thrifty' && sort.toolUses<=o.target) sort.orderDone=true;
  if(o.type==='order' && sort.firstColor===o.target) sort.orderDone=true;
  if(sort.orderDone){ sort.shards+=5; sort.missions++; }
}
// ─────────── ★ v1.47 «빛 조각 제작소» : 도구는 공짜가 아니다 ───────────
function sortSpend(key){
  const cost=SORT_TOOL_COST[key];
  const label={undo:'되돌리기',shuffle:'다시 섞기',bottle:'빈 병 추가',hint:'길 알려줘',charge:'전력 충전'}[key];
  if(sort.tools[key]>0){ sort.tools[key]--; sort.toolUses++; return true; }
  if(sort.shards>=cost){
    sort.shards-=cost; sort.toolUses++;
    sortNote(`🔨 ${label} 을 ${cost}조각으로 만들었어요!`);
    return true;
  }
  sortNote(`${label} 이 없어요. 좋은 붓기로 조각 ${cost}개를 모으거나 다른 길을 찾아봐요.`);
  return false;
}
function sortCanUse(key){
  return sort.tools[key]>0 || sort.shards>=SORT_TOOL_COST[key];
}
// ★ 서지 : 판 상태를 절대 건드리지 않는다(«보장 경로» 불변).
//   전력 -20 + 3수 동안 조각 획득 정지. 병을 «완성» 하면 압력이 20씩 내려간다.
function sortSurge(){
  sort.surges++; sort.pressure=0; sort.blackout=3;
  sort.power=Math.max(0,sort.power-20);
  sortNote('⚡ 서지! 전력 -20, 3수 동안 조각이 안 모여요. 병을 빨리 완성하면 압력이 내려가요.');
  const wrap=document.querySelector('.sort-board-wrap');
  if(wrap){ wrap.classList.remove('surge'); void wrap.offsetWidth; wrap.classList.add('surge');
    setTimeout(()=>wrap.classList.remove('surge'),650); }
  if(typeof rpBeep==='function') rpBeep(180,0.18,'sawtooth');
}
// ─────────── ★ v1.48 «도전 모드» : 90초 연속 정리 ───────────
//   레벨 모드가 «한 판을 어떻게 풀까» 라면, 도전 모드는 «얼마나 오래 버티나» 다.
//   한 단계 끝나면 +12초, 단계가 오를수록 색이 늘어난다. 시간이 0이 되면 조용히 끝난다
//   (벌점·재시작 없음). 주문서·조각·압력은 도전 모드에서 끈다 — 규칙이 가벼워야 속도가 산다.
const SORT_ENDLESS_TIME = 90;
const SORT_ENDLESS_BONUS = 12;
function sortEndlessClock(on){
  clearInterval(sort.clock); sort.clock=null;
  if(!on) return;
  sort.clock=setInterval(()=>{
    if(sort.phase!=='play' && sort.phase!=='won') return;
    sort.timeLeft=Math.max(0,sort.timeLeft-1);
    sortRenderTimer();
    if(sort.timeLeft<=0) sortEndlessEnd();
  },1000);
}
function sortRenderTimer(){
  const endless=sort.mode==='endless';
  const box=$('#sort-timer'), bar=$('#sort-timebar');
  if(box) box.classList.toggle('hidden',!endless);
  if(bar) bar.classList.toggle('hidden',!endless);
  if(!endless){ sortSym(); return; }
  const set=(id,v)=>{ const el=$(id); if(el) el.textContent=v; };
  set('#sort-time',sort.timeLeft); set('#sort-streak',sort.streak); set('#sort-best-streak',sort.bestStreak);
  const fill=$('#sort-timefill');
  if(fill) fill.style.width=Math.max(0,Math.min(100,sort.timeLeft/SORT_ENDLESS_TIME*100))+'%';
  const low=sort.timeLeft<=15;
  if(box) box.classList.toggle('low',low);
  if(bar) bar.classList.toggle('low',low);
  // ★ 시계는 sortRender 를 거치지 않고 1초마다 직접 부른다 → 여기서 상태를 동기화하지 않으면
  //   화면은 88초인데 __sortState 는 90초로 남는다(v1.45 __repairState 교훈).
  sortSym();
}
function sortStartEndless(){
  sortStop();
  sort.mode='endless'; sort.streak=0; sort.timeLeft=SORT_ENDLESS_TIME;
  sort.bestStreak=Number((sortLocal()||{}).bestStreak||sort.bestStreak||0);
  const card=$('.sort-card'); if(card) card.classList.add('endless');
  document.querySelectorAll('.sort-mode').forEach(b=>b.classList.toggle('on',b.dataset.mode==='endless'));
  sortStartLevel(1,{endless:true});
  sortEndlessClock(true);
  sortRenderTimer();
  sortNote(`⚡ 도전 모드! ${SORT_ENDLESS_TIME}초 안에 최대한 많이 정리해요. 한 단계 끝나면 +${SORT_ENDLESS_BONUS}초.`);
}
function sortSetMode(mode){
  if(mode===sort.mode && sort.phase==='play') return;
  if(mode==='endless'){ sortStartEndless(); return; }
  sortEndlessClock(false);
  sort.mode='level';
  const card=$('.sort-card'); if(card) card.classList.remove('endless');
  document.querySelectorAll('.sort-mode').forEach(b=>b.classList.toggle('on',b.dataset.mode==='level'));
  sortStartLevel(sort.level);
  sortRenderTimer();
}
function sortEndlessWin(){
  sort.phase='won'; sortStop();
  sort.streak++; sort.timeLeft=Math.min(180,sort.timeLeft+SORT_ENDLESS_BONUS);
  if(sort.streak>sort.bestStreak){
    sort.bestStreak=sort.streak;
    const l=sortLocal()||{}; l.bestStreak=sort.bestStreak; sortSaveLocal(l);
  }
  const res=$('#sort-result');
  if(res) res.innerHTML=`⚡ <b>${sort.streak}단계</b> 연속! +${SORT_ENDLESS_BONUS}초 (남은 ${sort.timeLeft}초)`;
  sortNote('다음 병 준비…');
  sortRenderTimer(); sortRender();
  if(typeof rpBeep==='function') rpBeep(940,0.09,'triangle');
  setTimeout(()=>{
    if(sort.mode==='endless' && sort.phase==='won') sortStartLevel(Math.min(14,1+sort.streak),{endless:true});
  },850);
}
function sortEndlessEnd(){
  sortEndlessClock(false);
  if(sort.phase==='over') return;
  sort.phase='over'; sortStop();
  const best=Math.max(sort.bestStreak,sort.streak);
  sort.bestStreak=best;
  const l=sortLocal()||{}; l.bestStreak=best; sortSaveLocal(l);
  const res=$('#sort-result');
  if(res) res.innerHTML=`⏱ 시간 끝! <b>${sort.streak}단계</b> · 최고 ${best}단계`;
  const go=$('#sort-go'); if(go){ go.textContent='다시 도전'; go.disabled=false; }
  sortNote('수고했어요! «다시 도전» 으로 최고 기록을 넘어봐요.');
  sortRender(); sortRenderTimer();
  if(typeof bubble==='function') bubble(`도전 모드 ${sort.streak}단계! 최고 ${best}단계`);
  api('/api/sort/progress',{mode:'endless',streak:sort.streak,won:false,level:sort.level,
    stars:0,moves:sort.moves,par:sort.par,missions:0,shards:0,surges:0},9000)
    .then(r=>{ sort.serverProgress=r; sortUpdateEntry(); })
    .catch(()=>{ sortUpdateEntry(); });
}
function sortHalt(){ sortStop(); sortEndlessClock(false); }
function sortLocal(){ try{ return JSON.parse(localStorage.getItem(SORT_STORE)||'null'); }catch(e){ return null; } }
function sortSaveLocal(o){ try{ localStorage.setItem(SORT_STORE,JSON.stringify(o)); }catch(e){} }
function sortNote(msg){ sort.note=msg; const n=$('#sort-note'); if(n) n.textContent=msg; }
function sortSym(){
  // ★ 브라우저 검증은 이 값만 읽는다. 렌더 때마다 갱신해야 «화면은 바뀌었는데 상태는 옛값» 이 안 생긴다.
  window.__sortState={
    ready:true, phase:sort.phase, level:sort.level, colors:sort.colors, cap:SORT_CAP,
    bottles:sort.bottles.map(x=>x.slice()), locked:[...sort.locked], broken:sort.broken,
    sel:sort.sel, moves:sort.moves, par:sort.par, stars:sort.stars,
    solution:sort.solution.length, guaranteed:sort.guaranteed.length,
    solvable:sort.solution.length>0 || sort.guaranteed.length>0,
    tools:Object.assign({},sort.tools), toolCost:Object.assign({},SORT_TOOL_COST),
    power:sort.power, shards:sort.shards, toolUses:sort.toolUses,
    pressure:sort.pressure, surges:sort.surges, blackout:sort.blackout,
    vault:sort.vault, vaultCap:SORT_VAULT_CAP,
    orders:sort.orders.map(o=>o.type), order:sort.order?sort.order.type:null,
    orderDone:sort.orderDone, orderFailed:sort.orderFailed, firstColor:sort.firstColor,
    missions:sort.missions,
    mode:sort.mode, timeLeft:sort.timeLeft, streak:sort.streak,
    bestStreak:sort.bestStreak, clockOn:!!sort.clock,
    wanders:sort.wanders, earnedHints:sort.earnedHints,
    hintCells:sort.hintCells.slice(), repairing:sort.repairing?sort.repairing.p:0,
    won:sort.phase==='won', note:sort.note
  };
}
function sortRender(){
  const board=$('#sort-board');
  if(board){
    board.innerHTML=sort.bottles.map((b,i)=>{
      const cls=[
        'sort-bottle',
        sort.sel===i?'selected':'',
        sort.locked.has(i)?'broken':'',
        i===sort.vault?'vault':'',
        i!==sort.vault && sortComplete(b)?'complete':'',
        sort.hintCells.includes(i)?'hintcell':'',
        sort.repairing && sort.repairing.i===i?'fixing':'',
        sort.pourTarget===i?'pour-in':''
      ].filter(Boolean).join(' ');
      const layers=b.map(c=>`<i class="sort-layer" style="--c:${SORT_COLORS[c].c}">${SORT_COLORS[c].sym}</i>`).join('');
      return `<div class="${cls}" data-i="${i}" role="button" tabindex="0" aria-label="${i===sort.vault?'보관 병':i+1+'번 병'}">
        <div class="sort-neck"></div>
        <div class="sort-glass"><div class="sort-stack">${layers}</div><div class="sort-shine"></div></div>
        ${sort.locked.has(i)?'<div class="sort-crack">🔧</div>':''}
        ${i===sort.vault?'<div class="sort-vault-tag">보관</div>':''}
        <div class="sort-ring" style="--p:${sort.repairing&&sort.repairing.i===i?sort.repairing.p:0}"></div>
        <span class="sort-num">${i===sort.vault?'보관':i+1}</span></div>`;
    }).join('');
  }
  const set=(id,v)=>{ const el=$(id); if(el) el.textContent=v; };
  set('#sort-level',sort.level); set('#sort-moves',sort.moves); set('#sort-par',sort.par);
  set('#sort-stars',sort.stars?'★'.repeat(sort.stars)+'☆'.repeat(3-sort.stars):'☆☆☆');
  set('#sort-power',Math.round(sort.power)); set('#sort-shards',sort.shards);
  set('#sort-undo-n',sort.tools.undo); set('#sort-shuffle-n',sort.tools.shuffle);
  set('#sort-bottle-n',sort.tools.bottle); set('#sort-hint-n',sort.tools.hint);
  set('#sort-charge-n',sort.tools.charge);
  const pf=$('#sort-pressurefill'); if(pf) pf.style.width=Math.min(100,sort.pressure)+'%';
  set('#sort-pressure-label',`압력 ${Math.round(sort.pressure)}%${sort.blackout?' · 정전 '+sort.blackout+'수':''}`);
  // 주문서 : 고르기 전에는 2장, 고른 뒤에는 진행 줄 하나
  const ow=$('#sort-orders'), on=$('#sort-order-now');
  if(ow){
    if(sort.phase==='play' && !sort.order && sort.mode!=='endless'){
      ow.innerHTML=sort.orders.map((o,k)=>
        `<button class="sort-order" type="button" data-order="${k}"><i>${o.tag}</i><b>${o.label}</b><small>${o.desc}</small></button>`).join('');
      ow.classList.remove('hidden');
    }else{ ow.innerHTML=''; ow.classList.add('hidden'); }
  }
  if(on){
    if(sort.order){
      on.textContent=sortOrderText()+(sort.orderDone?'  ·  조각 +5':'');
      on.className='sort-order-now'+(sort.orderDone?' done':sort.orderFailed?' fail':'');
    }else{ on.textContent=''; on.className='sort-order-now hidden'; }
  }
  const dis=(id,off)=>{ const el=$(id); if(el) el.disabled=!!off; };
  const over=sort.phase!=='play';
  dis('#sort-undo',over||!sort.history.length||!sortCanUse('undo'));
  dis('#sort-shuffle',over||!sortCanUse('shuffle'));
  dis('#sort-bottle',over||sort.power<20||!sortCanUse('bottle'));
  dis('#sort-hint',over||!sortCanUse('hint'));
  dis('#sort-charge',over||sort.power>=100||!sortCanUse('charge'));
  sortRenderTimer();
  sortSym();
}
function sortUpdateEntry(){
  const p=sort.serverProgress||{}, l=sortLocal()||{};
  const best=Math.max(1,Number(p.level)||1,Number(l.level)||1);
  const stars=Number(p.totalStars)||Object.values(l.bestStars||{}).reduce((a,v)=>a+(Number(v)||0),0);
  const missions=Number(p.missions)||Number(l.missions)||0;
  const el=(id,v)=>{ const n=$(id); if(n) n.textContent=v; };
  el('#sort-entry-level',`레벨 ${best}`); el('#sort-entry-stars',stars); el('#sort-entry-best',best);
  el('#sort-entry-missions',missions);
}
function sortSnapshot(){
  sort.history.push({
    bottles:sort.bottles.map(x=>x.slice()), locked:[...sort.locked], vault:sort.vault,
    moves:sort.moves, wanders:sort.wanders, power:sort.power, shards:sort.shards,
    pressure:sort.pressure, blackout:sort.blackout, surges:sort.surges,
    toolUses:sort.toolUses, firstColor:sort.firstColor,
    orderDone:sort.orderDone, orderFailed:sort.orderFailed,
    tools:Object.assign({},sort.tools)
  });
  if(sort.history.length>80) sort.history.shift();
}
function sortPourInfo(from,to){
  const s=sort.bottles[from], t=sort.bottles[to];
  if(!s.length) return {ok:false,msg:'빈 병에서는 옮길 빛이 없어요.'};
  if(sort.locked.has(to)||sort.locked.has(from)) return {ok:false,msg:'금이 간 병이에요. 꾹 눌러 먼저 고쳐요.'};
  const c=s[s.length-1];
  // ★ 보관 병 : 아무 색이나 1층 «보관», 꺼낼 때는 1층만 «같은 색/빈 병» 으로.
  if(to===sort.vault && from!==sort.vault){
    if(t.length>=SORT_VAULT_CAP) return {ok:false,msg:'보관 병은 2층까지만 담을 수 있어요.'};
    if(sortComplete(s)) return {ok:false,msg:'이미 완성된 병은 보관할 필요가 없어요.'};
    return {ok:true,n:1,c};
  }
  if(from===sort.vault){
    if(t.length>=SORT_CAP) return {ok:false,msg:'이 병은 가득 찼어요.'};
    if(t.length && t[t.length-1]!==c) return {ok:false,msg:'위쪽 색이 달라요. 같은 빛끼리 모아요.'};
    return {ok:true,n:1,c};
  }
  // ★ 완성된 병은 옮기는 «원» 이 될 수 없다 — 힌트 풀이(sortMovesAll)도 완성 병은
  //   건드리지 않는다. 예전엔 화면쪽에서만 완성 병을 흐트러뜨릴 수 있어
  //   힌트와 실제 플레이 규칙이 어긋났다.
  //   보관 병(vault) 은 2층이라 완성될 수 없으므로 위 분기에서 이미 처리된다.
  if(sortComplete(s)) return {ok:false,msg:'완성된 병은 그대로 둘래요. 다른 병을 골라요.'};
  if(t.length>=SORT_CAP) return {ok:false,msg:'이 병은 가득 찼어요.'};
  if(t.length && t[t.length-1]!==c) return {ok:false,msg:'위쪽 색이 달라요. 같은 빛끼리 모아요.'};
  let run=1; for(let k=s.length-2;k>=0&&s[k]===c;k--) run++;
  const n=Math.min(run,SORT_CAP-t.length);
  if(n<=0) return {ok:false,msg:'자리가 없어요.'};
  if(!t.length && run===s.length) return {ok:false,msg:'통째로 옮기면 그대로예요. 다른 병을 골라요.'};
  return {ok:true,n,c};
}
function sortPour(from,to){
  const info=sortPourInfo(from,to);
  if(!info.ok){ sortNote(info.msg); sort.hintCells=[]; sortRender(); return false; }
  const before=sortBoardScore(sort.bottles,sort.vault);
  const doneBefore=sort.bottles.map((x,i)=> i!==sort.vault && sortComplete(x));
  const tWasEmpty=to!==sort.vault && sort.bottles[to].length===0;
  const blackoutNow=sort.blackout>0;
  sortSnapshot();
  for(let k=0;k<info.n;k++) sort.bottles[to].push(sort.bottles[from].pop());
  sort.moves++;
  sort.sel=null; sort.hintCells=[]; sort.pourTarget=to;
  const after=sortBoardScore(sort.bottles,sort.vault);
  const doneAfter=sort.bottles.map((x,i)=> i!==sort.vault && sortComplete(x));
  const newly=doneAfter.filter((v,i)=>v&&!doneBefore[i]).length;
  // ★ 조각 경제 : 판이 나아진 붓기(+2) · 빈 병에 «자리 만들기»(+1) · 병 완성(+3).
  //   물병 퍼즐은 빈 병으로 덩어리를 옮기는 수가 반드시 필요하므로, 그 수를
  //   «헤맨 부음» 으로 오판해 조각을 0 주면 제작소가 사실상 잠긴다.
  const econ=sort.mode==='level';
  const madeRoom=tWasEmpty && from!==sort.vault && sort.bottles[from].length>0;
  let gained=0;
  if(econ && !blackoutNow){ if(after<before) gained+=2; else if(madeRoom) gained+=1; gained+=newly*3; }
  sort.shards+=gained;
  if(blackoutNow) sort.blackout--;
  let didSurge=false;
  if(econ){
    // ★ 압력 : 붓기마다 오르고, 병을 완성하면 20씩 내려간다 → «빨리 합칠까» 결정.
    sort.pressure+=sortPressureStep(sort.level);
    if(newly>0) sort.pressure=Math.max(0,sort.pressure-newly*20);
    if(sort.pressure>=100){ sortSurge(); didSurge=true; }
    if(sort.firstColor<0){
      const idx=doneAfter.findIndex((v,i)=>v&&!doneBefore[i]);
      if(idx>=0) sort.firstColor=sort.bottles[idx][0];
    }
    sortOrderCheck();
  }
  if(!econ){
    sortNote(newly>0?'한 병 완성! 다음 병으로.':'좋아요, 계속 정리해요.');
  }else if(didSurge){
    // 서지 안내가 다른 메시지에 덮이지 않게 그대로 둔다.
  }else if(after>=before && !madeRoom){
    sort.wanders++;
    if(sort.wanders%3===0 && sort.tools.hint<6){
      sort.tools.hint++; sort.earnedHints++;
      sortNote('헤맨 부음 3번 → 힌트 1개! 틀린 길도 길이 남아요.');
    }else sortNote(`판이 그대로예요. 헤맨 부음 ${sort.wanders}번 — 3번마다 힌트가 돼요.`);
  }else sortNote(gained>0?`좋아요! 빛 조각 +${gained}`:'좋아요! 같은 빛이 모였어요.');
  sortRender();
  setTimeout(()=>{ if(sort.pourTarget===to){ sort.pourTarget=-1; sortRender(); } },380);
  if(typeof rpBeep==='function') rpBeep(620,0.06,'sine');
  if(sortWon(sort.bottles,sort.vault)) sortWin();
  return true;
}
function sortTap(i){
  if(sort.phase!=='play') return;
  if(sort.justRepaired){ sort.justRepaired=false; return; }
  if(sort.locked.has(i)){ sortNote('금이 간 병이에요. 🔧 를 «꾹 누르고» 있으면 고쳐져요.'); return; }
  if(sort.sel===null){
    if(!sort.bottles[i].length){ sortNote('빈 병이에요. 먼저 옮길 빛이 있는 병을 골라요.'); return; }
    sort.sel=i; sort.hintCells=[];
    sortNote(`${i+1}번 병을 골랐어요. 옮길 병을 눌러요.`);
    sortRender(); return;
  }
  if(sort.sel===i){ sort.sel=null; sortNote('선택을 취소했어요.'); sortRender(); return; }
  sortPour(sort.sel,i);
}
function sortUndo(){
  if(sort.phase!=='play') return;
  if(!sort.history.length){ sortNote('아직 되돌릴 붓기가 없어요.'); return; }
  if(!sortCanUse('undo')){ sortNote('되돌리기가 없어요. 좋은 붓기로 조각 4개를 모아 만들어요.'); return; }
  const h=sort.history.pop();
  sort.bottles=h.bottles.map(x=>x.slice()); sort.locked=new Set(h.locked); sort.vault=h.vault;
  sort.moves=h.moves; sort.wanders=h.wanders; sort.power=h.power; sort.shards=h.shards;
  sort.pressure=h.pressure; sort.blackout=h.blackout; sort.surges=h.surges;
  sort.toolUses=h.toolUses; sort.firstColor=h.firstColor;
  sort.orderDone=h.orderDone; sort.orderFailed=h.orderFailed; sort.tools=h.tools;
  sortSpend('undo');                       // 복원된 자원에서 «한 번» 차감한다
  sort.sel=null; sort.hintCells=[];
  sortNote('한 수 되돌렸어요. 조각·압력·주문서 진행도 같이 돌아갔어요.');
  sortRender();
}
function sortChooseOrder(k){
  if(sort.phase!=='play'||sort.order) return;
  const o=sort.orders[Number(k)]; if(!o) return;
  sort.order=o;
  sortNote(`📜 «${o.label}» 를 골랐어요. 못 지켜도 괜찮아요!`);
  sortRender();
}
function sortShuffle(){
  if(sort.phase!=='play') return;
  if(!sortCanUse('shuffle')){ sortNote('다시 섞기가 없어요. 조각 6개가 필요해요.'); return; }
  if(!sortSpend('shuffle')) return;
  const carry={ tools:Object.assign({},sort.tools), shards:sort.shards, toolUses:sort.toolUses,
    pressure:sort.pressure, blackout:sort.blackout, surges:sort.surges,
    orders:sort.orders, order:sort.order, orderDone:sort.orderDone,
    orderFailed:sort.orderFailed, firstColor:sort.firstColor, missions:sort.missions };
  sortStartLevel(sort.level,carry);
  sortNote('새 배열이에요. 이번에도 반드시 풀리는 판만 나와요.');
  sortRender();
}
function sortAddBottle(){
  if(sort.phase!=='play') return;
  if(sort.power<20){ sortNote('전력이 부족해요. «전력 충전» 이나 다른 길을 찾아봐요.'); return; }
  if(!sortCanUse('bottle')){ sortNote('빈 병 추가가 없어요. 조각 8개가 필요해요.'); return; }
  sortSnapshot();
  if(!sortSpend('bottle')) return;
  sort.power-=20;
  sort.bottles.push([]); sort.sel=null; sort.hintCells=[];
  sortNote('빈 병 하나를 열었어요! 전력 20을 썼어요.');
  sortRender();
}
function sortCharge(){
  if(sort.phase!=='play') return;
  if(sort.power>=100){ sortNote('전력이 이미 가득해요.'); return; }
  if(!sortCanUse('charge')){ sortNote('전력 충전이 없어요. 조각 6개가 필요해요.'); return; }
  sortSnapshot();
  if(!sortSpend('charge')) return;
  sort.power=Math.min(100,sort.power+30);
  sortNote('⚡ 전력 +30! 금이 간 병을 고칠 수 있어요.');
  sortRender();
}
function sortHint(){
  if(sort.phase!=='play') return;
  // 지금 잠긴 병을 «그대로 둔 채» 푸는 길을 먼저 찾고, 없으면 «고친 뒤» 의 길을 찾는다.
  let path=sortSolve(sort.bottles,sort.locked,18000,sort.vault);
  let needRepair=false;
  if(!path && sort.locked.size){
    path=sortSolve(sort.bottles,new Set(),18000,sort.vault); needRepair=!!path;
  }
  if(!path||!path.length){ sortNote('지금은 길이 막혔어요. 되돌리기나 «다시 섞기» 를 써 봐요.'); sortRender(); return; }
  if(!sortCanUse('hint')){ sortNote('길 알려줘 가 없어요. 조각 5개가 필요해요.'); return; }
  sortSpend('hint');
  if(needRepair){
    sort.hintCells=[...sort.locked];
    sortNote('금이 간 병을 먼저 «꾹 눌러» 고치면 길이 열려요!');
  }else{
    const [i,j]=path[0];
    sort.hintCells=[i,j];
    sortNote(`💡 ${i===sort.vault?'보관 병':i+1+'번'} → ${j===sort.vault?'보관 병':j+1+'번'} 으로 옮겨 봐요.`);
  }
  sortRender();
}
function sortHoldStart(i,e){
  if(sort.phase!=='play'||!sort.locked.has(i)) return;
  if(sort.power<30){ sortNote('전력이 부족해요. «전력 충전» 도구를 쓰거나 다른 길을 찾아봐요.'); return; }
  if(e && e.preventDefault) e.preventDefault();
  if(sort.repairing) return;
  sort.repairing={i,p:0};
  sortNote('꾹 누르는 중… 초록 테두리가 다 차면 병이 열려요.');
  clearInterval(sort.timer);
  sort.timer=setInterval(()=>{
    if(!sort.repairing) return clearInterval(sort.timer);
    sort.repairing.p=Math.min(100,sort.repairing.p+4);
    if(sort.repairing.p>=100){
      const idx=sort.repairing.i;
      sort.repairing=null; clearInterval(sort.timer); sort.timer=null;
      sort.power-=30; sort.locked.delete(idx); sort.justRepaired=true;
      sort.hintCells=[]; sort.sel=null;
      sortNote('🔧 고쳤어요! 빈 병이 하나 열렸어요. (전력 -30)');
      if(typeof rpBeep==='function') rpBeep(820,0.12,'triangle');
      setTimeout(()=>{ sort.justRepaired=false; },400);
      sortRender();
      return;
    }
    // 충전 중에는 DOM 을 다시 만들지 않는다. 노드를 지우면 브라우저가 pointercancel 을
    // 보내 «손을 뗀 것» 으로 오해할 수 있다(v1.45 교훈). 링만 직접 갱신한다.
    const ring=document.querySelector('.sort-bottle.fixing .sort-ring');
    if(ring) ring.style.setProperty('--p',sort.repairing.p);
    sortSym();
  },52);
  sortRender();
}
function sortHoldEnd(){
  if(!sort.repairing) return;
  clearInterval(sort.timer); sort.timer=null;
  sort.repairing=null;
  sortNote('손을 떼서 충전이 멈췄어요. 다시 꾹 눌러 볼까요?');
  sortRender();
}
function sortStop(){
  clearInterval(sort.timer); sort.timer=null; sort.repairing=null;
  sort.pourTarget=-1;
}
function sortWin(){
  if(sort.mode==='endless'){ sortEndlessWin(); return; }
  sort.phase='won'; sortStop(); sort.hintCells=[]; sort.sel=null;
  sortOrderFinish();
  sort.stars=sort.moves<=sort.par?3:sort.moves<=Math.ceil(sort.par*1.5)?2:1;
  const l=sortLocal()||{level:1,bestStars:{}};
  l.bestStars=l.bestStars||{};
  l.bestStars[String(sort.level)]=Math.max(Number(l.bestStars[String(sort.level)])||0,sort.stars);
  l.level=Math.max(Number(l.level)||1,sort.level+1);
  l.missions=Number(l.missions||0)+(sort.orderDone?1:0);
  sortSaveLocal(l);
  const res=$('#sort-result');
  if(res) res.innerHTML=`🎉 <b>${'★'.repeat(sort.stars)}${'☆'.repeat(3-sort.stars)}</b> · ${sort.moves}번 옮김 (기준 ${sort.par})`
    +` · 조각 ${sort.shards} · 주문서 ${sort.orderDone?'완료 ✓':'미완료'} · 서지 ${sort.surges}번`;
  const go=$('#sort-go'); if(go){ go.textContent='다음 레벨 →'; go.disabled=false; }
  sortNote('다 빛났어요! 셀 대신 레벨·별·주문서 기록이 남았어요.');
  sortRender();
  if(typeof bubble==='function') bubble(`빛의 병 레벨 ${sort.level} 클리어! 별 ${sort.stars}개${sort.orderDone?' · 주문서 완료':''}`);
  // 서버 진행도는 «보상» 이 아니라 «기록» 이다. 실패해도 게임 플레이는 막지 않는다.
  if(!sort.submitted){
    sort.submitted=true;
    api('/api/sort/progress',{level:sort.level,stars:sort.stars,moves:sort.moves,par:sort.par,
      wanders:sort.wanders,hintsEarned:sort.earnedHints,won:true,
      missions:sort.orderDone?1:0,shards:sort.shards,surges:sort.surges,
      orderType:sort.order?sort.order.type:null},9000)
      .then(r=>{ sort.serverProgress=r; sortUpdateEntry(); })
      .catch(()=>{ sortUpdateEntry(); });
  }
}
function sortStartLevel(lv,carry){
  sortStop();
  const endless=sort.mode==='endless';
  let built=null;
  for(let k=0;k<10&&!built;k++) built=sortBuild(lv);
  if(!built) built=sortBuild(Math.max(1,lv-1))||sortBuild(1);
  if(!built){ sortNote('판을 만들지 못했어요. 다시 열어 주세요.'); return; }
  // ★ 도전 모드의 «단계» 는 연속 기록일 뿐, 정식 레벨을 오염시키면 안 된다.
  sort.phase='play'; if(!endless) sort.level=lv; sort.colors=built.cfg.colors;
  sort.bottles=built.bottles.map(x=>x.slice());
  sort.broken=built.broken;
  sort.locked=new Set(built.broken>=0?[built.broken]:[]);
  // ★ «보관 병» 은 맨 뒤에 붙인다. 기존 병 index 가 밀리지 않아 보장 경로가 그대로 유효하다.
  //   도전 모드에서는 2단계부터 열어 «처음 두 판은 규칙만» 으로 시작한다.
  const useVault = endless ? sort.streak>=2 : lv>=2;
  sort.vault = useVault ? sort.bottles.length : -1;
  if(sort.vault>=0) sort.bottles.push([]);
  sort.solution=built.solved||[];
  sort.guaranteed=built.guaranteed||[];
  // solver 첫 해와 역방향 보장해 중 «짧은 쪽» 을 기준으로 잡아야 별이 의미가 있다.
  const ref=Math.min(sort.solution.length||9999,sort.guaranteed.length||9999);
  sort.par=Math.max(sort.colors+2,Math.min(ref+4,sort.colors*8+12));
  sort.sel=null; sort.moves=0; sort.stars=0; sort.wanders=0; sort.earnedHints=0;
  sort.power=100; sort.history=[]; sort.hintCells=[]; sort.justRepaired=false;
  sort.submitted=false; sort.pourTarget=-1; sort.missions=0;
  sort.shards=0; sort.pressure=0; sort.surges=0; sort.blackout=0;
  sort.toolUses=0; sort.firstColor=-1; sort.orderDone=false; sort.orderFailed=false;
  sort.tools={undo:1,shuffle:1,bottle:1,hint:1,charge:1};
  // 도전 모드는 주문서를 쓰지 않는다(규칙이 가벼워야 «속도» 가 산다).
  sort.orders=endless?[]:sortMakeOrders(sort.colors,sort.par);
  sort.order=null;
  if(carry && !endless){
    sort.tools=Object.assign({},sort.tools,carry.tools||{});
    sort.shards=carry.shards||0; sort.pressure=carry.pressure||0;
    sort.blackout=carry.blackout||0; sort.surges=carry.surges||0;
    sort.toolUses=carry.toolUses||0;
    if(carry.orders) sort.orders=carry.orders;
    if(carry.order!==undefined) sort.order=carry.order;
    sort.orderDone=!!carry.orderDone; sort.orderFailed=!!carry.orderFailed;
    if(carry.firstColor!=null) sort.firstColor=carry.firstColor;
  }
  const res=$('#sort-result'); if(res) res.textContent='';
  const go=$('#sort-go'); if(go){ go.textContent='처음부터 다시'; go.disabled=false; }
  sortNote(endless
    ? `⚡ ${sort.streak>0?`${sort.streak}단계 연속! `:''}${sort.timeLeft}초 남았어요. 같은 빛끼리 빠르게!`
    : (sort.vault>=0
      ? '주문서를 고르고, 빛 조각을 모으세요. «보관» 병엔 아무 색 1층을 잠시 넣을 수 있어요!'
      : '주문서를 하나 골라요. 같은 빛끼리 모으면 조각이 생겨요.'));
  sortRender();
}
async function sortLoadProgress(){
  try{
    const r=await api('/api/sort/progress',undefined,9000,'GET');
    sort.serverProgress=r;
    if(r&&Number(r.level)>sort.level) sort.level=Math.min(99,Number(r.level));
    if(r&&Number(r.bestStreak)>sort.bestStreak) sort.bestStreak=Number(r.bestStreak);
  }catch(e){
    const l=sortLocal();
    if(l&&Number(l.level)>sort.level) sort.level=Math.min(99,Number(l.level));
  }
  sortUpdateEntry();
}
async function openSort(){
  const m=$('#game-sort'); if(m) m.classList.remove('hidden');   // ★ v1.44 교훈: 명시적으로 열기
  // 열 때는 항상 레벨 모드에서 시작한다(지난번 도전 모드의 타이머가 남지 않게).
  sortEndlessClock(false); sort.mode='level';
  const card=$('.sort-card'); if(card) card.classList.remove('endless');
  document.querySelectorAll('.sort-mode').forEach(b=>b.classList.toggle('on',b.dataset.mode==='level'));
  sortNote('판을 준비하는 중… (풀 수 있는 판만 골라요)');
  await sortLoadProgress();
  sortStartLevel(sort.level);
}
function sortGo(){
  if(sort.mode==='endless'){ sortStartEndless(); return; }
  if(sort.phase==='won') sort.level=Math.min(99,sort.level+1);
  sortStartLevel(sort.level);
}

// ---- 이벤트 바인딩 ----
// 부품 밖에서 손을 떼도 «충전» 이 멈추게 한다.
window.addEventListener('pointerup', rpPressEnd);
window.addEventListener('blur', rpPressEnd);
$('#chat-fab')?.addEventListener('click', chatOpen);
$('#chat-close')?.addEventListener('click', chatClose);
$('#chat-send')?.addEventListener('click', ()=>sendChat(false));
$('#chat-text')?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); sendChat(false); } });
$$('.chat-modes .chip').forEach(b=>b.addEventListener('click', ()=>chatModeSet(b.dataset.mode)));
$('#chat-solved')?.addEventListener('click', chatSolved);
$('#shooter-go')?.addEventListener('click', shStart);
$('#pz-hint-btn')?.addEventListener('click', showPzHint);
$('#btn-games')?.addEventListener('click', ()=>goNav('games'));
$('#btn-mole')?.addEventListener('click', openMole);
$('#mole-go')?.addEventListener('click', moleStart);
$('#btn-repair')?.addEventListener('click', openRepair);
$('#repair-go')?.addEventListener('click', rpStart);
// ★ v1.46 빛의 병 정리
$('#btn-sort')?.addEventListener('click', openSort);
$('#sort-go')?.addEventListener('click', sortGo);
$('#sort-undo')?.addEventListener('click', sortUndo);
$('#sort-shuffle')?.addEventListener('click', sortShuffle);
$('#sort-bottle')?.addEventListener('click', sortAddBottle);
$('#sort-hint')?.addEventListener('click', sortHint);
$('#sort-charge')?.addEventListener('click', sortCharge);
$('#sort-orders')?.addEventListener('click', e=>{
  const el=e.target.closest && e.target.closest('.sort-order');
  if(el) sortChooseOrder(el.dataset.order);
});
$$('.sort-mode').forEach(b=>b.addEventListener('click', ()=>sortSetMode(b.dataset.mode)));
$('#sort-board')?.addEventListener('click', e=>{
  const el=e.target.closest && e.target.closest('.sort-bottle');
  if(el) sortTap(Number(el.dataset.i));
});
$('#sort-board')?.addEventListener('pointerdown', e=>{
  const el=e.target.closest && e.target.closest('.sort-bottle');
  if(el && sort.locked.has(Number(el.dataset.i))) sortHoldStart(Number(el.dataset.i),e);
});
window.addEventListener('pointerup', sortHoldEnd);
window.addEventListener('pointercancel', sortHoldEnd);
window.addEventListener('blur', sortHoldEnd);
$('#pz-practice')?.addEventListener('click', ()=>openPuzzle(true));
$('#pz-ask')?.addEventListener('click', askPuzzle);
// ★ click 이벤트 객체가 startMic 의 auto 로 들어가 «항상 250ms 후 자동 전송» 이 됐었다.
//   마이크 버튼은 수동 입력이므로 auto=false — 결과를 입력창에만 채운다.
$('#chat-mic')?.addEventListener('click', ()=>startMic(false));
$('#btn-parent')?.addEventListener('click', openParentDashboard);
$('#side-user')?.addEventListener('click', ()=>goNav('board'));
$('#btn-report')?.addEventListener('click', ()=>goNav('board'));
// ★ 2026-11-21 (v1.74) C6: 설정은 모달이 아니라 «설정 화면» 으로 — 상단 ⚙ · 사이드바 ⚙️ 두 진입점 모두 goNav.
$('#btn-settings')?.addEventListener('click', ()=>goNav('settings'));
$('#btn-settings-side')?.addEventListener('click', ()=>goNav('settings'));
$('#btn-parent-nav')?.addEventListener('click', openParentDashboard);
$('#set-font')?.addEventListener('change', e=>{ localStorage.setItem('roomi_font_lg', e.target.checked?'1':'0'); applySettings(); });
$('#set-cb')?.addEventListener('change', e=>{ localStorage.setItem('roomi_cb', e.target.checked?'1':'0'); applySettings(); });
$('#set-voice')?.addEventListener('change', e=>{ localStorage.setItem('roomi_voice_auto', e.target.checked?'1':'0'); applySettings(); });
$('#set-voice-chat')?.addEventListener('change', e=>{ setVoiceChat(e.target.checked); toast(e.target.checked?'🎧 음성 대화를 켰어요':'음성 대화를 껐어요'); });
$('#set-voice-name')?.addEventListener('change', e=>{ localStorage.setItem('roomi_voice_name', e.target.value); toast('읽어주는 목소리를 저장했어요'); });
$('#set-voice-rate')?.addEventListener('input', e=>{
  const r = Math.min(1.15, Math.max(0.7, Number(e.target.value)||0.9));
  localStorage.setItem('roomi_voice_rate', r.toFixed(2));
  const v = $('#voice-rate-val'); if(v) v.textContent = r.toFixed(2);
});
$('#voice-test')?.addEventListener('click', ()=> speak('안녕! 나는 루미야. 오늘도 같이 공부해 보자!'));
$('#review-next')?.addEventListener('click', nextReview);
$('#revive-accept')?.addEventListener('click', acceptRevive);
$('#revive-skip')?.addEventListener('click', ()=> $('#revive-modal').classList.add('hidden'));
if('speechSynthesis' in window) window.speechSynthesis.onvoiceschanged = loadVoiceOptions;
$('#set-nudge')?.addEventListener('change', e=>{ localStorage.setItem('roomi_nudge', e.target.checked?'1':'0'); applySettings(); });
$('#btn-prefs')?.addEventListener('click', openPrefs);
$$('#pref-minutes button').forEach(b=>b.addEventListener('click', ()=>{ if(!state.prefs) return; state.prefs.minutes = Number(b.dataset.min); renderPrefs(); }));
$$('#pref-time button').forEach(b=>b.addEventListener('click', ()=>{ if(!state.prefs) return; state.prefs.time = b.dataset.time; renderPrefs(); }));
$$('#pref-diff button').forEach(b=>b.addEventListener('click', ()=>{ if(!state.prefs) return; state.prefs.difficulty = b.dataset.diff; renderPrefs(); }));
$$('#pref-subjects button').forEach(b=>b.addEventListener('click', ()=>{
  if(!state.prefs) return;
  const s = b.dataset.subject;
  const arr = state.prefs.subjects || [];
  const i = arr.indexOf(s);
  if(i >= 0) arr.splice(i,1); else arr.push(s);
  state.prefs.subjects = arr;
  renderPrefs();
}));
$('#prefs-save')?.addEventListener('click', savePrefs);
$('#friend-add-btn')?.addEventListener('click', addFriendByCode);
$('#friend-code-input')?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); addFriendByCode(); } });
$('#chat-memory')?.addEventListener('click', loadMemories);
$('#memory-add-btn')?.addEventListener('click', addMemory);
$('#memory-input')?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); addMemory(); } });
$('#memory-clear')?.addEventListener('click', clearMemories);
$('#fc-send')?.addEventListener('click', sendFriendChat);
$('#fc-text')?.addEventListener('keydown', e=>{ if(e.key==='Enter'){ e.preventDefault(); sendFriendChat(); } });
$('#fc-report')?.addEventListener('click', reportFriend);
$('#fc-block')?.addEventListener('click', blockFriend);
function setRoomTab(name){
  $$('#room-tabs .room-tab').forEach(x=>x.classList.toggle('on', x.dataset.roomTab===name));
  $$('.room-pane').forEach(p=>p.classList.toggle('on', p.dataset.roomPane===name));
  // ★ 2026-11-21 (v1.71): «성장» 탭에 들어올 때마다 기억 등불을 새로 읽는다.
  //   로그인 전(state.user 없음)에는 부르지 않는다 — 탭 복원이 시작 시점에 실행될 수 있어서다.
  if(name === 'growth' && state.user) try{ loadLamps(); }catch(e){ console.error('[loadLamps]', e); }
  try{ localStorage.setItem('roomi_room_tab', name); }catch(e){}
}
$$('#room-tabs .room-tab').forEach(b=>b.addEventListener('click', ()=>setRoomTab(b.dataset.roomTab)));
setRoomTab(localStorage.getItem('roomi_room_tab') || 'today');
$('#friend-code')?.addEventListener('click', async ()=>{
  const code = $('#friend-code').textContent.trim();
  try{ await navigator.clipboard.writeText(code); toast('친구 코드를 복사했어요!'); }
  catch(e){ toast(`친구 코드: ${code}`); }
});
$$('#shop-filters .fchip').forEach(b=>b.addEventListener('click', ()=>{
  state.shopFilter = b.dataset.shop;
  $$('#shop-filters .fchip').forEach(x=>x.classList.toggle('on', x===b));
  loadShop();
}));
applySettings();

(function bindShooterInputs(){
  const cv = $('#shooter-canvas'); if(!cv) return;
  const toX = (clientX)=>{ const r=cv.getBoundingClientRect(); return (clientX-r.left)/r.width*SH_W; };
  cv.addEventListener('pointerdown', e=>{ sh.pointer=toX(e.clientX); cv.setPointerCapture?.(e.pointerId); });
  cv.addEventListener('pointermove', e=>{ if(e.buttons || e.pointerType==='touch') sh.pointer=toX(e.clientX); });
  cv.addEventListener('pointerup', ()=>{ sh.pointer=null; });
  document.addEventListener('keydown', e=>{
    if(e.key==='ArrowLeft'||e.key==='ArrowRight'){ sh.keys[e.key]=true; if(sh.running) e.preventDefault(); }
  });
  document.addEventListener('keyup', e=>{ if(e.key==='ArrowLeft'||e.key==='ArrowRight') sh.keys[e.key]=false; });
})();

// 시작 화면의 대표 로봇을 그린다(로그인 전 장식).
renderHeroBot();

// ★ v1.39 «자기 생각 × 도로랜드» — 공작소 · 정비사 수첩
//   이 화면의 주인공은 «숫자» 가 아니라 «처음 생각 → 고쳐 쓴 생각» 두 문장이다.
//   서버는 정답을 채점하지 않는다. 아이가 «다시 써 봤는지» 만 본다.
let _story = null;
const _storyPick = {};          // shardId → 아이가 고른 성찰 질문 key

async function openStoryBook(){
  const m = $('#story-modal');
  if(!m) return;
  m.classList.remove('hidden');
  await loadStoryBook();
}

async function loadStoryBook(){
  const list = $('#story-list');
  if(list && !_story) list.innerHTML = '<div class="story-empty">생각 조각을 불러오는 중…</div>';
  try{
    const r = await api('/api/story', undefined, 12000);
    _story = r;
    renderStoryBook(r);
  }catch(e){
    if(list) list.innerHTML = `<div class="story-empty">${esc(e.message)}</div>`;
  }
}

function shardHTML(it, prompts, cell){
  const day = String(it.day || '').slice(5).replace('-', '/');
  if(it.status === 'fixed'){
    const reward = it.cell_reward
      ? `<span class="shard-reward">🏮 별빛 셀 +${esc(it.cell_reward)}</span>`
      : `<span class="shard-reward">🏮 오늘은 셀 없이 불만 켰어</span>`;
    return `<div class="shard fixed" data-id="${esc(it.id)}">
      <div class="shard-top"><span class="shard-chip">고쳤어!</span><span class="shard-day">${esc(day)}</span></div>
      <p class="shard-stuck">막힌 곳 · <b>${esc(it.stuck)}</b></p>
      <div class="shard-diff">
        <div><span>처음 생각</span><p>${esc(it.guess)}</p></div>
        <div><span>고쳐 쓴 생각</span><p>${esc(it.revised || '')}</p></div>
      </div>
      ${reward}
    </div>`;
  }
  const sel = _storyPick[it.id] || 'where';
  const btns = prompts.map(p =>
    `<button data-pk="${esc(p.key)}" class="${sel === p.key ? 'on' : ''}" title="${esc(p.hint || '')}">${esc(p.q)}</button>`
  ).join('');
  return `<div class="shard open" data-id="${esc(it.id)}">
    <div class="shard-top"><span class="shard-chip">고치는 중</span><span class="shard-day">${esc(day)}</span></div>
    <p class="shard-stuck">막힌 곳 · <b>${esc(it.stuck)}</b></p>
    <div class="shard-diff"><div><span>처음 생각</span><p>${esc(it.guess)}</p></div></div>
    <div class="shard-prompts">${btns}</div>
    <textarea class="shard-input" maxlength="120" placeholder="지금은 어떻게 생각해? 고쳐 쓴 생각을 적어 봐"></textarea>
    <button class="btn primary small shard-fix">고쳐 쓰기 · 별빛 셀 +${esc(cell)}</button>
  </div>`;
}

function renderStoryBook(r){
  const st = r.stats || {};
  const badge = $('#story-badge'); if(badge) badge.textContent = r.badge || '새내기 정비사';
  const ch = $('#story-ch');
  if(ch) ch.textContent = `CH.${r.chapter} · ${r.topic || ''}${r.keywords ? ` (${r.keywords})` : ''}`;
  const line = $('#story-line'); if(line) line.textContent = r.line || '';
  const vow = $('#story-vow'); if(vow) vow.textContent = r.vow || '';
  const stats = $('#story-stats');
  if(stats){
    stats.innerHTML = `
      <div><b>${esc(st.fixed || 0)}</b><span>고쳐 쓴 생각</span></div>
      <div><b>${esc(st.starCell || 0)}</b><span>모은 별빛 셀</span></div>
      <div><b>${esc(st.lit || 0)} / ${esc(st.lights || 8)}</b><span>켜진 등</span></div>`;
  }
  const cnt = $('#story-list-count');
  if(cnt) cnt.textContent = `고치는 중 ${st.open || 0} · 다 고침 ${st.fixed || 0}`;
  const list = $('#story-list');
  if(!list) return;
  const items = r.items || [];
  list.innerHTML = items.length
    ? items.map(it => shardHTML(it, r.prompts || [], r.stats ? r.stats.cell : 6)).join('')
    : `<div class="story-empty">아직 생각 조각이 없어요.<br>문제를 풀다가 «막혔다» 싶을 때, 그때 든 생각을 적어 두면 나중에 고쳐 쓸 수 있어요.</div>`;
}

async function saveThought(){
  const stuckEl = $('#thought-stuck'), guessEl = $('#thought-guess');
  const stuck = (stuckEl && stuckEl.value || '').trim();
  const guess = (guessEl && guessEl.value || '').trim();
  if(stuck.length < 2 || guess.length < 2){ toast('어디가 막혔는지, 처음엔 뭐라고 생각했는지 둘 다 적어 줘'); return; }
  const btn = $('#thought-save');
  if(btn) btn.disabled = true;
  try{
    await api('/api/thoughts', { stuck, guess });
    if(stuckEl) stuckEl.value = '';
    if(guessEl) guessEl.value = '';
    toast('생각 조각을 남겼어! 나중에 다시 와서 고쳐 쓰자');
    try{ SFX.correct(); }catch(e){ }
    await loadStoryBook();
  }catch(e){ toast(e.message); }
  finally{ if(btn) btn.disabled = false; }
}

async function fixThought(id, revised, btn){
  const text = String(revised || '').trim();
  if(text.length < 4){ toast('고쳐 쓴 생각을 조금 더 길게 적어 줘'); return; }
  if(btn) btn.disabled = true;
  try{
    const r = await api('/api/thoughts/fix', { id, revised: text, promptKey: _storyPick[id] || 'where' }, 12000);
    if(r.already) toast('이미 고쳐 쓴 조각이야');
    else if(r.reward){
      toast(`🏮 별빛 셀 +${r.reward}! 저장고 등이 켜졌어`);
      try{ SFX.coin(); }catch(e){ }
    }else toast('고쳤어! 오늘 셀은 다 받았지만 저장고 불은 켜졌어');
    if(r.balance != null && state.user){ state.user.cell_balance = r.balance; setBalance(r.balance); }
    await loadStoryBook();
    if(window.World && window.World.refreshThoughts) window.World.refreshThoughts();
  }catch(e){
    toast(e.message);
    if(btn) btn.disabled = false;
  }
}

// 마이룸 버튼에 «고치는 중» 개수를 조용히 표시한다(열지 않아도 할 일이 보이게)
async function loadStoryChip(){
  const b = $('#btn-story');
  if(!b) return;
  try{
    const r = await api('/api/thoughts/summary', undefined, 8000);
    const s = (r && r.stats) || null;
    if(s) b.textContent = s.open ? `🪛 정비사 수첩 · ${s.open}` : '🪛 정비사 수첩';
  }catch(e){ /* 비로그인·오프라인은 조용히 기본 문구 유지 */ }
}

(function bindStoryUI(){
  const open = $('#btn-story'); if(open) open.addEventListener('click', openStoryBook);
  const close = $('#story-close'); if(close) close.addEventListener('click', () => $('#story-modal').classList.add('hidden'));
  const modal = $('#story-modal'); if(modal) modal.addEventListener('click', e => { if(e.target === modal) modal.classList.add('hidden'); });
  const save = $('#thought-save'); if(save) save.addEventListener('click', saveThought);
  const list = $('#story-list');
  if(list){
    // 성찰 질문 선택 — 같은 조각 안에서 하나만 켠다
    list.addEventListener('click', e => {
      const pk = e.target.closest('[data-pk]');
      if(pk){
        const shard = pk.closest('.shard'); if(!shard) return;
        _storyPick[shard.dataset.id] = pk.dataset.pk;
        shard.querySelectorAll('[data-pk]').forEach(b => b.classList.toggle('on', b === pk));
        return;
      }
      const fix = e.target.closest('.shard-fix');
      if(fix){
        const shard = fix.closest('.shard'); if(!shard) return;
        const input = shard.querySelector('.shard-input');
        fixThought(shard.dataset.id, input && input.value, fix);
      }
    });
  }
  // 대세계 «별빛 저장고» → 수첩으로 이동하는 다리
  window.openStoryBook = openStoryBook;
  window.goStoryBook = () => {
    const w = $('#world-vault'); if(w) w.classList.add('hidden');
    if(window.World && window.World.close) window.World.close();
    setTimeout(openStoryBook, 200);
  };
})();

async function openCodex(){
  const m = $('#codex-modal');
  if(!m) return;
  try{
    const r = await api('/api/codex');
    const cards = (r && r.cards) || [];
    const cnt = $('#codex-count');
    if(cnt) cnt.textContent = `${r.unlocked||0} / ${r.total||cards.length}`;
    const pct = r.total ? Math.round((r.unlocked||0) / r.total * 100) : 0;
    const fill = $('#codex-bar-fill'); if(fill) fill.style.width = pct + '%';
    const grid = $('#codex-grid');
    if(grid) grid.innerHTML = cards.map(c=> c.unlocked
      ? `<div class="codex-cell"><b>${esc(c.topic)}</b><span>${esc(c.analogy || c.concept || '')}</span></div>`
      : `<div class="codex-cell locked"><b>???</b><span>지혜의 샘에서 열려요</span></div>`).join('');
    m.classList.remove('hidden');
  }catch(e){ toast(e.message); }
}

let _gbFriend = 0;
async function openGuestbook(fid){
  const m = $('#gb-modal');
  if(!m) return;
  _gbFriend = fid;
  try{
    const r = await api('/api/guestbook?friendId=' + fid);
    $('#gb-name').textContent = displayName(r.friend.nickname) + '의 마을';
    $('#gb-sub').textContent = `Lv.${r.friend.level} · 🔥 ${r.friend.streak}일 연속`;
    const st = r.stats || { solved:0, codex:0, streak:0 };
    $('#gb-stats').innerHTML = `<span>🌳 나무 ${st.solved}</span><span>📖 도감 ${st.codex}</span><span>🔥 연속 ${st.streak}</span>`;
    const msgs = r.messages || [];
    $('#gb-list').innerHTML = msgs.length
      ? msgs.map(g=>`<div class="gb-item"><b>${esc(displayName(g.nickname))}</b><span>${esc(g.message)}</span></div>`).join('')
      : '<div class="gb-empty">아직 방명록이 없어요. 첫 한 줄을 남겨 볼까요?</div>';
    m.classList.remove('hidden');
  }catch(e){ toast(e.message); }
}
async function sendGuestbook(){
  const input = $('#gb-text');
  const msg = (input && input.value || '').trim();
  if(!msg) return;
  try{
    await api('/api/guestbook', { friendId:_gbFriend, message:msg });
    input.value = '';
    toast('방명록을 남겼어요');
    openGuestbook(_gbFriend);
  }catch(e){ toast(e.message); }
}

(function bindGrowthUI(){
  const b1 = $('#btn-codex');   if(b1) b1.addEventListener('click', openCodex);
  const b2 = $('#codex-close'); if(b2) b2.addEventListener('click', ()=>$('#codex-modal').classList.add('hidden'));
  const b3 = $('#codex-modal'); if(b3) b3.addEventListener('click', e=>{ if(e.target.id === 'codex-modal') b3.classList.add('hidden'); });
  const b4 = $('#gb-close');    if(b4) b4.addEventListener('click', ()=>$('#gb-modal').classList.add('hidden'));
  const b5 = $('#gb-send');     if(b5) b5.addEventListener('click', sendGuestbook);
  const b6 = $('#gb-text');     if(b6) b6.addEventListener('keydown', e=>{ if(e.key === 'Enter') sendGuestbook(); });
  const b7 = $('#gb-modal');    if(b7) b7.addEventListener('click', e=>{ if(e.target.id === 'gb-modal') b7.classList.add('hidden'); });
})();

// ============================================================
// ★ 2026-11-04 학습 동행 2.0 — 능동 넛지 · 성장 지도 · 기분 · 집중 · 시즌
//   서버는 기존 로그를 규칙으로 읽는다. 새 LLM 호출 없음(DeepSeek 크레딧은 UI 표기).
// ============================================================

// ── ① 루미가 먼저 말 걸기 ──
let _nudgeId = 0;
function nudgeGo(t){
  if(t === 'review') openReview();
  else if(t === 'world'){ const b = $('#btn-world'); if(b) b.click(); }
  else if(t === 'plan'){
    const s = state.plan && state.plan.plan && state.plan.plan.steps.find(x=>!x.done);
    if(s) startPlanStep(s.id); else goNav('myroom');
  }
  else chatOpen();
}
async function loadNudge(){
  const box = $('#nudge-bubble');
  if(!box) return;
  if(state.nudgeDismissed){ state.nudgeActive = false; box.classList.add('hidden'); return; }
  if(!state.nudgeOptIn){ state.nudgeActive = false; box.classList.add('hidden'); return; }
  // ★ v1.50 «오늘 딱 하나»: 계획·복습·기분을 모두 읽어 한 걸음만 제안한다.
  //   없을 때만 예전의 능동 넛지 → 계획 다음 단계 순으로 내려간다.
  try{
    const a = await api('/api/next-action', undefined, 8000, 'GET');
    if(a && a.action){ renderNextAction(a.action); return; }
  }catch(e){}
  try{
    const n = await api('/api/nudge/today');
    if(!n || !n.text){ state.nudgeActive = false; box.classList.add('hidden'); showPlanNudge(); return; }
    _nudgeId = n.id || 0;
    const speech = String(n.text).replace(/^[^:]+:\s*/, '');
    $('#nb-text').textContent = speech;
    const nm = $('#nb-name'); if(nm) nm.textContent = (state.robot && state.robot.name) || '루미';
    const av = $('#nb-avatar');
    if(av && state.robot){
      try{ av.innerHTML = robotSVG(state.robot.template, effectiveColors(state.robot.template, robotPalette())); }catch(e){}
    }
    const cta = $('#nb-cta');
    cta.textContent = n.cta || '가기';
    cta.onclick = ()=>{
      api('/api/nudge/click', { id:_nudgeId }).catch(()=>{});
      box.classList.add('hidden');
      nudgeGo(n.target);
    };
    state.nudgeActive = true;
    box.classList.remove('hidden');
  }catch(e){ state.nudgeActive = false; box.classList.add('hidden'); showPlanNudge(); }
}
// ★ v1.50 «오늘 딱 하나» — 첫 화면은 기능 목록이 아니라 한 걸음.
//   서버(/api/next-action)가 «기분 → 막힌 개념 → 복습 → 계획» 순으로 하나만 골라 준다.
function renderNextAction(act){
  const box = $('#nudge-bubble'); if(!box) return;
  state.nudgeActive = true;
  // ★ 2026-11-21 (v1.71): «오늘의 한 걸음» 을 state 에 기억해 둔다.
  //   40분 잠금(overplay) 때 서버 요청 없이 «내일은 «X» 에 도전해 보고 싶어» 문장을 만들기 위함.
  if(act) state.nextAction = act;
  // ★ 2026-11-21 (v1.74) A3 계약: kind:'tower' 카드 — 제목/cta 가 없는 응답이라 여기서 조립한다.
  //   말풍선을 채운 뒤 «오늘 할 일» 카드도 탑 타일로 갱신한다.
  if(act && act.kind === 'tower'){
    // fogCount 계약 필드가 없는(낡은) 응답이면 로컬 램프에서 흐린 등불 수를 센다
    const fogN = (act.fogCount != null) ? Number(act.fogCount)
      : ((state.lamps && Array.isArray(state.lamps.lamps)) ? state.lamps.lamps.filter(l=>(Number(l.decay)||0) >= 30).length : 0);
    const nm = $('#nb-name'); if(nm) nm.textContent = (state.robot && state.robot.name) || '루미';
    const av = $('#nb-avatar');
    if(av && state.robot){
      try{ av.innerHTML = robotSVG(state.robot.template, effectiveColors(state.robot.template, robotPalette())); }catch(e){}
    }
    const txt = $('#nb-text'); if(txt) txt.textContent = `루미의 기억이 안개에 잊혀져 가 — 흐린 등불 ${fogN}개를 탑으로 되찾아 줘!`;
    const cta = $('#nb-cta');
    if(cta){
      cta.textContent = '탑으로 가기';
      cta.onclick = ()=>{ box.classList.add('hidden'); openTower(); };
    }
    box.classList.remove('hidden');
    try{ renderToday3(); }catch(e){}
    return;
  }
  const nm = $('#nb-name'); if(nm) nm.textContent = (state.robot && state.robot.name) || '루미';
  const av = $('#nb-avatar');
  if(av && state.robot){
    try{ av.innerHTML = robotSVG(state.robot.template, effectiveColors(state.robot.template, robotPalette())); }catch(e){}
  }
  const txt = $('#nb-text'); if(txt) txt.textContent = act.title;
  const cta = $('#nb-cta');
  if(cta){
    cta.textContent = act.cta || '시작하기';
    cta.onclick = ()=>{ box.classList.add('hidden'); runNextAction(act); };
  }
  box.classList.remove('hidden');
  try{ renderToday3(); }catch(e){}   // ★ v1.74: next-action 이 바뀌면 «오늘 할 일» 도 맞춰 간다
}
async function runNextAction(act){
  if(!act) return;
  try{
    // ★ 2026-11-21 (v1.74) A3: 탑 카드의 실행 경로
    if(act.kind === 'tower' || act.target === 'tower'){ openTower(); return; }
    if(act.target === 'chat'){ await chatOpen(); chatModeSet('chat'); return; }
    if(act.target === 'learn'){
      await chatOpen();
      chatModeSet('learn');
      const input = $('#chat-text');
      if(input) input.value = `${act.concept}이 아직 헷갈려. 같이 볼까?`;
      sendChat(false);
      return;
    }
    if(act.target === 'review'){ openReview(); return; }
    if(act.target === 'plan' && act.stepId){ startPlanStep(act.stepId); return; }
  }catch(e){ toast(e.message); }
}
// ★ v1.49 «말 걸기는 한 줄만»: 예전에는 comeback-card(계획 다음 단계)와 nudge-bubble(능동 넛지)이
//   같은 자리에서 서로를 숨기며 경쟁했고, 오른쪽 «오늘의 학습 계획» 패널과 내용도 겹쳤다.
//   이제 말풍선은 하나만 남기고, 넛지가 없을 때만 계획의 다음 단계를 같은 말풍선에 담는다.
function showPlanNudge(){
  if(state.nudgeActive) return;                    // 능동 넛지가 이미 말을 걸었으면 비켜준다
  if(state.nudgeDismissed) return;                 // 아이가 닫았으면 다시 띄우지 않는다
  const box = $('#nudge-bubble'); if(!box) return;
  if(!state.nudgeOptIn){ box.classList.add('hidden'); return; }
  const steps = (state.plan && state.plan.plan && state.plan.plan.steps) || [];
  const next = steps.find(s => !s.done);
  if(!next){ box.classList.add('hidden'); return; }   // 오늘 할 일이 없으면 조용히 있는다
  const idx = steps.indexOf(next) + 1;
  const nm = $('#nb-name'); if(nm) nm.textContent = (state.robot && state.robot.name) || '루미';
  const av = $('#nb-avatar');
  if(av && state.robot){
    try{ av.innerHTML = robotSVG(state.robot.template, effectiveColors(state.robot.template, robotPalette())); }catch(e){}
  }
  const txt = $('#nb-text'); if(txt) txt.textContent = `오늘 ${idx}단계 · ${next.title}`;
  const cta = $('#nb-cta');
  if(cta){
    cta.textContent = '시작하기';
    cta.onclick = ()=>{ box.classList.add('hidden'); startPlanStep(next.id); };
  }
  box.classList.remove('hidden');
}

// ── ④ 오늘 기분 → 루미 말투 + 방 분위기 등 ──
function setMoodLight(rgb){
  try{
    const s = bjs && bjs.scene; if(!s || !window.BABYLON) return;
    let l = s.getLightByName('moodLight');
    if(!l){
      l = new BABYLON.PointLight('moodLight', new BABYLON.Vector3(0, 3.5, -1.4), s);
      l.range = 10;
    }
    l.diffuse = new BABYLON.Color3(rgb[0], rgb[1], rgb[2]);
    l.intensity = 0.40;   // ★ 2026-11-05: 0.62 → 0.40, 기분 등이 켜질 때 방 전체가 백화되는 현상 완화
    s.__moodLight = l;
  }catch(e){}
}
function applyMood(m){
  state.mood = m.mood || null;
  try{ document.body.dataset.mood = state.mood || ''; }catch(e){}
  if(m.light) setMoodLight(m.light);
  $$('.mood-opts button').forEach(b=>b.classList.toggle('on', b.dataset.mood === state.mood));
}
async function loadMood(){
  const box = $('#mood-card'); if(!box) return;
  try{
    const m = await api('/api/mood/today');
    if(m.asked){ box.classList.add('hidden'); applyMood(m); return; }
    box.classList.remove('hidden');
  }catch(e){ box.classList.add('hidden'); }
}
async function sendMood(mood){
  try{
    const m = await api('/api/mood', { mood });
    const box = $('#mood-card'); if(box) box.classList.add('hidden');
    applyMood(m);
    bubble(m.greeting || '고마워, 알겠어!');
    toast(m.greeting || '기분을 알려줘서 고마워!');
  }catch(e){ toast(e.message); }
}

// ── ② 성장 지도 (최근 6주 추세) ──
function growthSparkline(weeks){
  if(!weeks.length) return '';
  const W = 560, H = 112, pad = 10, base = H - pad - 12;
  const max = Math.max(20, ...weeks.map(w=>w.index||0));
  const pts = weeks.map((w,i)=>{
    const x = pad + i*(W-pad*2)/Math.max(1, weeks.length-1);
    const y = base - ((w.index||0)/max)*(base-pad);
    return [x,y];
  });
  const line = pts.map((p,i)=>(i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1)).join(' ');
  const area = line + ` L${pts[pts.length-1][0].toFixed(1)} ${base} L${pts[0][0].toFixed(1)} ${base} Z`;
  const dots = pts.map(p=>`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.4" fill="#2f6fed" stroke="#fff" stroke-width="1.6"/>`).join('');
  const labels = weeks.map((w,i)=>`<text x="${pts[i][0].toFixed(1)}" y="${H-2}" text-anchor="middle" font-size="9" fill="#8a99ad">${esc(w.label)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="100%">
    <defs><linearGradient id="gArea" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2f6fed" stop-opacity=".26"/><stop offset="1" stop-color="#2f6fed" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#gArea)"/>
    <path d="${line}" fill="none" stroke="#2f6fed" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}${labels}</svg>`;
}
async function openGrowth(){
  const m = $('#growth-modal'); if(!m) return;
  m.classList.remove('hidden');
  const s = $('#growth-summary'), c = $('#growth-chart');
  if(s) s.innerHTML = '<div class="hint">불러오는 중…</div>';
  if(c) c.innerHTML = '';
  try{
    const r = await api('/api/growth/timeline');
    const su = r.summary || {};
    if(s) s.innerHTML = `
      <div class="gs"><b>${esc(su.understanding||0)}</b><span>이해도</span></div>
      <div class="gs"><b>${esc(su.mastered||0)}</b><span>연 카드 / ${esc(su.totalCards||0)}</span></div>
      <div class="gs"><b>${esc(su.streak||0)}</b><span>연속 방문</span></div>
      <div class="gs"><b>Lv.${esc(su.level||1)}</b><span>레벨</span></div>`;
    if(c) c.innerHTML = growthSparkline(r.weeks || []);
    const w = $('#growth-weak');
    if(w){
      const weak = su.weakTopics || [];
      w.innerHTML = '<b>조금 더 연습하면 좋은 것</b>' +
        (weak.length ? weak.map(x=>`<span>${esc(x)}</span>`).join('') : '<em>아직 없어요. 잘하고 있어요!</em>');
    }
  }catch(e){ if(s) s.innerHTML = `<div class="hint">${esc(e.message)}</div>`; }
}

// ── ③ 보호자 주간 레터 ──
async function loadWeeklyLetter(){
  const box = $('#pd-letter'); if(!box) return;
  box.classList.add('hidden');
  try{
    const r = await api('/api/parent/weekly');
    const st = r.stats || {};
    box.innerHTML = `
      <div class="pl-head"><b>✉️ 이번 주 루미가 전하는 편지</b>
        <span class="ai-credit">Powered by <b>DeepSeek</b></span></div>
      <p>${esc(r.letter)}</p>
      <div class="pl-stat">
        <span>공부 ${esc(st.studyDays||0)}일</span><span>해결 ${esc(st.solved||0)}개</span>
        <span>지혜의 샘 ${esc(st.lessons||0)}개</span><span>대화 ${esc(st.chats||0)}회</span>
        <span>집중 ${esc(st.focusMin||0)}분</span><span>연속 ${esc(st.streak||0)}일</span>
      </div>`;
    box.classList.remove('hidden');
  }catch(e){}
}

// ── ⑤ 루미랑 같이 집중 ──
let _focus = { min:10, timer:null, left:600, sessionId:0, running:false };
function renderFocusClock(sec){
  const el = $('#focus-clock'); if(!el) return;
  const m = Math.floor(Math.max(0,sec)/60), s = Math.max(0,sec)%60;
  el.textContent = `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function setFocusBot(t){ const el = $('#focus-bot-text'); if(el) el.textContent = t; }
async function loadFocusSummary(){
  try{
    const r = await api('/api/focus/summary');
    const el = $('#focus-summary');
    if(el) el.textContent = `오늘 집중 ${r.today}회 · 누적 ${r.total}회 / ${r.totalMin}분`;
  }catch(e){}
}
function openFocus(){
  const m = $('#focus-modal'); if(!m) return;
  m.classList.remove('hidden');
  if(!_focus.running){ renderFocusClock(_focus.min*60); setFocusBot('준비됐어? 시작하자!'); }
  loadFocusSummary();
}
async function startFocus(){
  if(_focus.running) return;
  try{
    const r = await api('/api/focus/start', { minutes:_focus.min });
    _focus.sessionId = r.sessionId;
    _focus.min = r.minutes;
    _focus.left = r.resumed ? Math.max(1, _focus.left || r.minutes*60) : r.minutes*60;
    _focus.running = true;
    // ★ 2026-11-21 (v1.74) C5 «집중 + 대화 공존»: 집중이 진행 중인 동안엔
    //   대화 패널과 대화 버튼이 집중 모달 «위» 로 떠오른다(z-index 105 > 100).
    //   이때 채팅을 열어도 집중 타이머는 «끝까지» 돈다(타이머 코드는 한 줄도 건드리지 않았다).
    //   게임·퀴즈 모달은 그대로 대화를 가린다 — 공존은 «같이 집중» 만.
    document.body.classList.add('focus-live');
    $$('#focus-pick button').forEach(b=>b.disabled = true);
    $('#focus-start').classList.add('hidden');
    $('#focus-stop').classList.remove('hidden');
    setFocusBot('루미가 옆에서 지켜볼게. 천천히 해도 돼!');
    renderFocusClock(_focus.left);
    clearInterval(_focus.timer);
    _focus.timer = setInterval(()=>{
      _focus.left--;
      renderFocusClock(_focus.left);
      if(_focus.left === Math.floor(_focus.min*30)) setFocusBot('절반 왔어! 잘하고 있어');
      if(_focus.left <= 0) finishFocus();
    }, 1000);
  }catch(e){ toast(e.message); }
}
async function finishFocus(){
  clearInterval(_focus.timer);
  _focus.timer = null; _focus.running = false;
  document.body.classList.remove('focus-live');   // ★ v1.74 C5: 대화를 다시 모달 아래로
  notifyNaturalBreak();                            // ★ v1.74 C2: 집중 끝 = 자연스러운 마무리 지점
  try{
    const r = await api('/api/focus/finish', { sessionId:_focus.sessionId, minutes:_focus.min });
    if(r.balance != null){ setBalance(r.balance); state.user.cell_balance = r.balance; }
    setFocusBot(r.note || '잘했어!');
    toast(r.reward ? `집중 완료! +${r.reward}셀` : '집중 완료! 잘했어');
  }catch(e){ setFocusBot(e.message || '다음에 다시 해 보자!'); }
  $$('#focus-pick button').forEach(b=>b.disabled = false);
  $('#focus-start').classList.remove('hidden');
  $('#focus-stop').classList.add('hidden');
  renderFocusClock(_focus.min*60);
  loadFocusSummary(); loadSeason();
}
function stopFocus(){
  clearInterval(_focus.timer);
  _focus.timer = null; _focus.running = false;
  document.body.classList.remove('focus-live');   // ★ v1.74 C5: 그만두면 대화를 다시 가린다
  $$('#focus-pick button').forEach(b=>b.disabled = false);
  $('#focus-start').classList.remove('hidden');
  $('#focus-stop').classList.add('hidden');
  setFocusBot('괜찮아, 언제든 다시 시작할 수 있어!');
  renderFocusClock(_focus.min*60);
}

// ── ⑥ 시즌 보드 ──
async function loadSeason(){
  const box = $('#season-tasks'); if(!box) return;
  try{
    const r = await api('/api/season/board');
    const nm = $('#season-name'); if(nm) nm.textContent = r.name || '시즌';
    box.innerHTML = (r.tasks||[]).map(t=>`
      <div class="season-task ${t.done?'done':''}">
        <span class="st-ico">${t.icon}</span>
        <span class="st-title">${esc(t.title)}</span>
        <span class="st-state">${t.done?'완료':(t.count||0)+'회'}</span>
      </div>`).join('');
    const f = $('#season-bar-fill'); if(f) f.style.width = Math.round((r.done/r.total)*100)+'%';
    $('#season-progress').textContent = `${r.done} / ${r.total}`;
    const btn = $('#season-claim');
    if(btn){
      if(r.claimed){ btn.textContent = '이번 주 완료'; btn.disabled = true; }
      else if(r.done < r.total){ btn.textContent = '미션 진행 중'; btn.disabled = true; }
      else { btn.textContent = `보상 받기 +${r.reward}셀`; btn.disabled = false; }
    }
  }catch(e){}
}
async function claimSeason(){
  try{
    const r = await api('/api/season/claim', {});
    if(r.balance != null){ setBalance(r.balance); state.user.cell_balance = r.balance; }
    toast(`시즌 보상 +${r.reward}셀!`);
    loadSeason(); refreshMailBadge();
  }catch(e){ toast(e.message); }
}

// ── 이벤트 바인딩 ──
(function bindCompanionUI(){
  // ★ v1.80: 답변 방식 — 자동(의도 판단) / 단계로(유도) / 바로 설명
  state.answerStyle = localStorage.getItem('roomi_answer_style') || 'auto';
  $$('#chat-style .cs-btn').forEach(b=>{
    b.classList.toggle('on', b.dataset.style === state.answerStyle);
    b.addEventListener('click', ()=>{
      state.answerStyle = b.dataset.style;
      try{ localStorage.setItem('roomi_answer_style', state.answerStyle); }catch(e){}
      $$('#chat-style .cs-btn').forEach(x=>x.classList.toggle('on', x === b));
      toast(state.answerStyle === 'direct' ? '이제 바로 설명해 줄게'
        : state.answerStyle === 'guide' ? '한 단계씩 같이 생각해 볼게' : '상황에 맞게 답할게');
    });
  });
  const on = (sel, fn)=>{ const el = $(sel); if(el) el.addEventListener('click', fn); };
  // ★ v1.49: 한 번 닫은 말풍선은 이번 세션 동안 다시 띄우지 않는다
  //   (예전에는 닫아도 renderPlan/renderMyroom 때마다 같은 카드가 다시 나타났다).
  on('#nb-close', ()=>{ state.nudgeDismissed=true; const b=$('#nudge-bubble'); if(b) b.classList.add('hidden'); });
  $$('.mood-opts button').forEach(b=>b.addEventListener('click', ()=>sendMood(b.dataset.mood)));
  on('#mood-skip', ()=>{ const b=$('#mood-card'); if(b) b.classList.add('hidden'); });
  on('#btn-growth', openGrowth);
  on('#growth-close', ()=>{ const m=$('#growth-modal'); if(m) m.classList.add('hidden'); });
  const gm = $('#growth-modal');
  if(gm) gm.addEventListener('click', e=>{ if(e.target.id === 'growth-modal') gm.classList.add('hidden'); });
  on('#btn-focus', openFocus);
  on('#focus-start', startFocus);
  on('#focus-stop', stopFocus);
  $$('#focus-pick button').forEach(b=>b.addEventListener('click', ()=>{
    if(_focus.running) return;
    _focus.min = Number(b.dataset.min) || 10;
    $$('#focus-pick button').forEach(x=>x.classList.toggle('on', x === b));
    renderFocusClock(_focus.min*60);
  }));
  on('#season-claim', claimSeason);
})();

// ════════════════════════════════════════════════════════════
// v1.38 «주인공» 이스터에그
//   아이가 먼저 찾으면 즐겁고, 어른이 나중에 알아도 좋다.
//   ① 로고를 1.2초 누르기   ② ↑↑↓↓←→←→BA
//   ③ 마을 남서쪽 끝 이정표   ④ 개발자 도구 콘솔
//   어느 것도 화면에 «안내» 를 띄우지 않는다.
// ════════════════════════════════════════════════════════════
(function creatorSecrets(){
  // ④ 콘솔 배너 — 개발자 도구를 열어 본 사람만 본다
  try{
    console.log('%c RooMi ',
      'background:#2f6fed;color:#fff;font:800 13px/1.7 Pretendard,sans-serif;padding:3px 9px;border-radius:6px 0 0 6px');
    console.log('%c 루미 · AI 학습 파트너 ',
      'background:#4fc3a1;color:#06281f;font:800 13px/1.7 Pretendard,sans-serif;padding:3px 9px;border-radius:0 6px 6px 0');
    console.log('%c\n' +
      '    ( • ᴗ • )\n' +
      '   [ RooMi ]\n\n' +
      '만든 사람 : 이멍멍 (한양대학교 ERICA · 인공지능학과)\n' +
      '함께한 곳 : ㈜도로 × 한양대 ERICA IC-PBL 2026-2학기\n' +
      '숨은 글   : 마을 남서쪽 길이 끊기는 자리 (-34, -39)\n' +
      '비밀 문장 : ↑ ↑ ↓ ↓ ← → ← → B A\n',
      'color:#5b6b85;font:11px/1.55 ui-monospace,Menlo,monospace');
  }catch(e){ }

  const SEEN_KEY = 'roomi_konami';
  let opened = false;

  function openCredits(){
    const m = document.getElementById('credits-modal');
    if(m) m.classList.remove('hidden');
  }

  function unlock(from){
    openCredits();
    if(opened) return;                   // 한 번 열었으면 조용히 카드만 다시 보여 준다
    opened = true;
    try{ localStorage.setItem(SEEN_KEY, '1'); }catch(e){ }
    // 로고가 6초만 아주 천천히 무지개로 돈다 — 그 뒤로는 원래대로
    const mark = document.querySelector('.brand-mark');
    if(mark){
      mark.classList.add('rainbow');
      setTimeout(()=>mark.classList.remove('rainbow'), 6000);
    }
    if(typeof toast === 'function') toast(from === 'press' ? '🛠 여기를 눌러 본 사람이 있었네' : '🌈 루미의 비밀 문장을 찾았어!');
  }

  // ① 로고 «길게 누르기» (모바일에는 화살표가 없으니 이쪽이 주 경로)
  const mark = document.querySelector('.brand-mark');
  if(mark){
    let timer = null;
    const stop = ()=>{ clearTimeout(timer); timer = null; };
    mark.addEventListener('pointerdown', ()=>{
      stop();
      timer = setTimeout(()=>{ timer = null; unlock('press'); }, 1200);
    });
    ['pointerup','pointerleave','pointercancel','pointermove'].forEach(ev=>mark.addEventListener(ev, stop));
    mark.addEventListener('contextmenu', e=>e.preventDefault());
    mark.style.cursor = 'pointer';
    mark.style.webkitTapHighlightColor = 'transparent';
  }

  // ② 코나미 코드 — 입력창에 타이핑 중일 때는 절대 가로채지 않는다
  const KONAMI = ['arrowup','arrowup','arrowdown','arrowdown','arrowleft','arrowright','arrowleft','arrowright','b','a'];
  let pos = 0;
  window.addEventListener('keydown', (e)=>{
    const t = e.target;
    if(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)){ pos = 0; return; }
    const k = String(e.key || '').toLowerCase();
    if(k === KONAMI[pos]){
      pos++;
      if(pos === KONAMI.length){ pos = 0; unlock('konami'); }
    }else{
      pos = (k === KONAMI[0]) ? 1 : 0;
    }
  });

  // 다시 온 사람: 이미 찾았다는 사실만 조용히 기억한다(카드는 그대로 열린다)
  try{ if(localStorage.getItem(SEEN_KEY) === '1') opened = true; }catch(e){ }
})();

// ============================================================
// ★ 2026-11-21 (v1.74) «논리와 편의» 배치 — 마지막 구역
//   A2 goTeach 딥링크 · B 삼막 인도(showAct/축하) · C1 탭바 · C3 보관함 칩 ·
//   C6 설정(PIN/이전 코드/이어하기) · C7 withThinking · C4 재시도 위임(위 emptyState 근처)
//   모든 새 함수는 파일 스코프의 함수 선언이라 아무 곳에서나 부를 수 있다.
// ============================================================

// ---------- C7 «루미 생각 중» 상단 바 ----------
// promise 를 그대로 돌려주는 «통과» 헬퍼 — 성공/실패를 건드리지 않는다(then 별도 가지로만 정리).
// 5초가 지나면 문구가 «거의 다 됐어!» 로 바뀐다. 채팅 스트리밍에는 절대 쓰지 않는다(전용 UI 있음).
function withThinking(promise, opts){
  const label = String((opts && opts.label) || '루미가 생각 중…');
  try{ document.querySelectorAll('.thinkbar').forEach(b=>b.remove()); }catch(e){}
  const bar = document.createElement('div');
  bar.className = 'thinkbar';
  bar.innerHTML = `<span class="rumi-pose">${rumiPose('think', 26)}</span><span class="think-text"></span>`;
  const txt = bar.querySelector('.think-text');
  txt.textContent = label;
  document.body.appendChild(bar);
  let ended = false;
  const finish = ()=>{ if(ended) return; ended = true; clearTimeout(longT); try{ bar.remove(); }catch(e){} };
  const longT = setTimeout(()=>{ if(!ended && txt) txt.textContent = '거의 다 됐어!'; }, 5000);
  Promise.resolve(promise).then(finish, finish);
  return promise;
}

// ---------- A2 «다시 가르쳐 주기» 딥링크 ----------
// 세 군데(안개 우편 · 등불 행 · 헬로 말풍선)에서 같은 흐름으로 진입시킨다:
//   마이룸 → 대화 열기 → «같이 공부» 모드 → 입력창에 미리 채우기 → 포커스.
async function goTeach(topic){
  const t = String(topic || '').trim();
  if(!t) return;
  try{ goNav('myroom'); }catch(e){}
  try{ await chatOpen(); }catch(e){ return; }
  chatModeSet('learn');
  const input = $('#chat-text');
  if(input){
    input.value = `«${t}» 다시 가르쳐 줄게`;
    input.focus();
    const end = input.value.length;
    try{ input.setSelectionRange(end, end); }catch(e){}
  }
}

// ---------- B 삼막 인도: 1회 마킹 + 액트 바 ----------
// localStorage 가 1차 방어, 서버 ob_step/firstLamp/sosFirst/crystalNow 가 2차 방어(계약 필드).
function obSeen(key){
  try{ return localStorage.getItem('roomi_ob_' + key) === '1'; }catch(e){ return true; }
}
function obMark(key){
  if(obSeen(key)) return false;
  try{ localStorage.setItem('roomi_ob_' + key, '1'); }catch(e){}
  return true;
}
// 1막 — «색칠 완료» 순간에만. ob_step===0(아직 등불 없음) 이고 이 브라우저에서 처음일 때만.
function maybeAct1(){
  if(obSeen('act1')) return;
  const step = Number(state.obStep) || 0;
  obMark('act1');   // 한 번만 띄운다 — ob_step 판정과 무관하게 이 브라우저에서는 재사하지 않는다
  if(step !== 0) return;
  showAct(1, ['이제 루미에게 오늘 배운 걸 가르쳐 줘!', '가르치면 루미의 방에 «기억 등불» 이 켜져.'],
    { label:'루미와 대화하기', go: async ()=>{
        try{ await chatOpen(); }catch(e){ return; }
        chatModeSet('learn');
        const i = $('#chat-text');
        if(i){ i.value = '오늘 배운 거 하나 가르쳐 줄게'; i.focus(); }
      } });
}
// 액트 바 — 바닥에 붙는 «비차단» 인도 바. 화면을 가리지 않고, 닫거나 목표를 눌러야 진행된다.
let _actEl = null;
function showAct(n, lines, action){
  try{ if(_actEl) _actEl.remove(); }catch(e){}
  hideAct();
  const el = document.createElement('div');
  el.className = 'act-guide act-' + n;
  el.setAttribute('role', 'status');
  const ava = document.createElement('span');
  ava.className = 'act-ava';
  ava.innerHTML = rumiPose(n === 2 ? 'sad' : 'wave', 38);
  const txt = document.createElement('span');
  txt.className = 'act-text';
  txt.textContent = Array.isArray(lines) ? lines.join(' ') : String(lines || '');
  el.appendChild(ava); el.appendChild(txt);
  if(action && typeof action.go === 'function'){
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn primary small';
    go.textContent = String(action.label || '가기');
    go.onclick = ()=>{ hideAct(); action.go(); };
    el.appendChild(go);
  }
  const arrow = document.createElement('span');
  arrow.className = 'act-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '⬇';
  el.appendChild(arrow);
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'act-x';
  x.title = '닫기';
  x.textContent = '✕';
  x.onclick = hideAct;
  el.appendChild(x);
  _actEl = el;
  document.body.appendChild(el);
}
function hideAct(){
  if(_actEl){ try{ _actEl.remove(); }catch(e){} _actEl = null; }
}

// ---------- B 축하 카드 ----------
// 전체 화면 «가벼운» 축하 — 배경은 pointer-events:none 이라 아래 조작을 막지 않고,
// 카드 자체는 (버튼이 있을 때) 누를 수 있다. 4.2초 뒤 스스로 사라진다.
function showCelebrate(title, sub, action){
  try{ document.querySelectorAll('.lamp-celebrate').forEach(b=>b.remove()); }catch(e){}
  const ov = document.createElement('div');
  ov.className = 'lamp-celebrate';
  const card = document.createElement('div');
  card.className = 'celebrate-card';
  const art = document.createElement('div');
  art.className = 'empty-art';
  art.style.cssText = 'width:84px;height:84px;margin:0 auto';
  art.innerHTML = rumiPose('happy', 84);
  const t = document.createElement('p');
  t.className = 'celebrate-title';
  t.textContent = title;
  card.appendChild(art); card.appendChild(t);
  if(sub){
    const s = document.createElement('p');
    s.className = 'celebrate-sub';
    s.textContent = sub;
    card.appendChild(s);
  }
  if(action && typeof action.go === 'function'){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn primary small';
    b.style.marginTop = '10px';
    b.textContent = String(action.label || '가기');
    b.onclick = ()=>{ ov.remove(); action.go(); };
    card.appendChild(b);
  }
  ov.appendChild(card);
  document.body.appendChild(ov);
  setTimeout(()=>{ try{ ov.remove(); }catch(e){} }, 4200);
}
// B1 삼막 1막 완료 — firstLamp:true 가 도착한 «그 순간».
async function celebrateFirstLamp(){
  obMark('act1');        // 1막 인도는 여기서 끝난 것으로 본다
  if(!obMark('lamp1')) return;   // 이 브라우저에서 축하를 «두 번» 하지 않는다
  try{ SFX.levelup(); }catch(e){}
  state._lampBorn = true;        // renderLamps 가 첫 행 불꽃에 is-born 를 붙이게 한다
  try{
    goNav('myroom');
    setRoomTab('growth');        // 등불 판넬이 사는 «성장» 탭으로 자동 전환
    await loadLamps(true);
    const panel = $('#lamp-panel');
    if(panel && !panel.classList.contains('hidden')) panel.scrollIntoView({ behavior:'smooth', block:'center' });
  }catch(e){}
  showCelebrate('첫 기억 등불이 켜졌어!', '루미가 네 말을 정말 소중히 기억하고 있어. 방이 하나 더 밝아졌어 ✨');
}

// ---------- C1 하단 탭 바 바인딩 ----------
// 홈/게임/성장은 goNav 로 화면을, 대화는 chatOpen, 마을은 기존 «AI 마을» 진입 버튼을 눌러 준다.
(function bindTabbar(){
  const bar = document.getElementById('tabbar'); if(!bar) return;
  const setActive = (name)=>{
    bar.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('on', b.dataset.tab === name));
  };
  bar.addEventListener('click', (e)=>{
    const btn = e.target.closest('.tab-btn'); if(!btn) return;
    const tab = btn.dataset.tab;
    if(tab === 'home'){ goNav('myroom'); setActive('home'); }
    else if(tab === 'games'){ goNav('games'); setActive('games'); }
    else if(tab === 'growth'){ goNav('board'); setActive('growth'); }
    else if(tab === 'chat'){
      chatOpen();
      // 대화·마을은 «화면 전환» 이 아닌 위에 뜨는 흐름 — 탭 활성 표시는 홈에 둔다
      setActive('home');
    }
    else if(tab === 'world'){
      const b = $('#btn-world');
      if(b){ b.click(); setActive('world'); }
    }
    try{ SFX.click(); }catch(e2){}
  });
})();

// ---------- C3 보관함 보기/정렬 칩 + 행 클릭(goTeach) 위임 ----------
(function bindLampVault(){
  // 저장된 보기/정렬 복구(세션을 넘어가도 아이가 고른 보기가 유지된다)
  try{ state.lampView = localStorage.getItem('roomi_lamp_view') === 'list' ? 'list' : 'grid'; }catch(e){}
  const savedSort = (function(){ try{ return localStorage.getItem('roomi_lamp_sort'); }catch(e){ return null; } })();
  if(savedSort === 'risk' || savedSort === 'crystal' || savedSort === 'recent') state.lampSort = savedSort;
  // 칩의 .on 상태를 저장값에 맞춘다
  $$('#lamp-views .lamp-viewchip').forEach(b=>b.classList.toggle('on', (b.dataset.lampView || '') === state.lampView));
  $$('#lamp-sorts .lamp-sortchip').forEach(b=>b.classList.toggle('on', (b.dataset.lampSort || '') === state.lampSort));
  $('#lamp-views')?.addEventListener('click', (e)=>{
    const b = e.target.closest('[data-lamp-view]'); if(!b) return;
    state.lampView = b.dataset.lampView === 'list' ? 'list' : 'grid';
    $$('#lamp-views .lamp-viewchip').forEach(x=>x.classList.toggle('on', x === b));
    try{ localStorage.setItem('roomi_lamp_view', state.lampView); }catch(e2){}
    if(state.lamps) renderLamps(state.lamps);
  });
  $('#lamp-sorts')?.addEventListener('click', (e)=>{
    const b = e.target.closest('[data-lamp-sort]'); if(!b) return;
    const s = b.dataset.lampSort;
    if(s === 'recent' || s === 'risk' || s === 'crystal') state.lampSort = s;
    $$('#lamp-sorts .lamp-sortchip').forEach(x=>x.classList.toggle('on', x === b));
    try{ localStorage.setItem('roomi_lamp_sort', state.lampSort); }catch(e2){}
    if(state.lamps) renderLamps(state.lamps);
  });
  // 격자/목록 공통: data-topic 이 붙은 행(=막히지 않은 행)은 통째로 «다시 가르쳐 주기» 버튼
  ['lamp-list', 'lamp-listview'].forEach(id=>{
    const el = document.getElementById(id);
    if(el) el.addEventListener('click', (e)=>{
      const row = e.target.closest('[data-topic]');
      if(row) goTeach(row.dataset.topic);
    });
  });
})();

// ---------- C6 설정: PIN 만들기/변경 + 기기 이전 코드 ----------
(function bindSettingsScreen(){
  const msg = (el, text, good)=>{
    if(!el) return;
    el.textContent = text;
    el.classList.toggle('good', !!good);
    el.classList.toggle('bad', !good);
    el.classList.remove('hidden');
  };
  const pinMsg = $('#set-pin-msg');
  $('#set-pin-save')?.addEventListener('click', async ()=>{
    const pin = (($('#set-pin') && $('#set-pin').value) || '').trim();
    if(!/^\d{4}$/.test(pin)) return msg(pinMsg, 'PIN 은 숫자 4자리예요!', false);
    const btn = $('#set-pin-save');
    if(btn) btn.disabled = true;
    try{
      await api('/api/account/pin', { pin });
      if($('#set-pin')) $('#set-pin').value = '';
      msg(pinMsg, 'PIN 을 만들었어요! 다른 기기 로그인 화면에서 닉네임 + PIN 으로 들어올 수 있어요.', true);
    }catch(e){ msg(pinMsg, e.message || 'PIN 을 저장하지 못했어요.', false); }
    finally{ if(btn) btn.disabled = false; }
  });
  $('#set-pin')?.addEventListener('keydown', (e)=>{ if(e.key === 'Enter'){ e.preventDefault(); const b = $('#set-pin-save'); if(b) b.click(); } });

  const out = $('#set-transfer-out');
  $('#set-transfer-btn')?.addEventListener('click', async ()=>{
    const btn = $('#set-transfer-btn');
    if(btn) btn.disabled = true;
    try{
      const r = await api('/api/account/transfer/code', {});
      if(out){
        out.innerHTML = `새 이전 코드 <span class="transfer-code">${esc(String(r.code || ''))}</span><br>10 분 동안만 쓸 수 있어요. 새 기기의 «이어서 하기» 에 넣어 주세요!`;
        out.classList.remove('hidden');
      }
    }catch(e){ msg(out, e.message || '코드를 만들지 못했어요.', false); }
    finally{ if(btn) btn.disabled = false; }
  });
})();

// ---------- C6 로그인 화면 «이어서 하기» (PIN 검증 + 기기 이전 코드 수령) ----------
// 성공하면 기존 «토큰 저장 → /api/user → startPlayTimer → enter()» 흐름을 그대로 탄다.
async function continueWithSession(nickname, token){
  const nick = String(nickname || '').trim();
  if(!nick || !token) throw new Error('로그인 정보가 부족해요');
  localStorage.setItem(SK.token, token);
  localStorage.setItem(SK.nick, nick);
  const u2 = await api('/api/user', { nickname: nick });
  state.user = u2.user; state.quests = u2.quests || { list:[], done:[] };
  absorbUserMeta(u2);   // ★ v1.74: ob_step · play_limit_delta 스냅샷
  localStorage.setItem(SK.uid, u2.user.id);
  if(u2.user.token) localStorage.setItem(SK.token, u2.user.token);
  if(u2.streakBonus) setTimeout(()=>bubble(` ${u2.streakBonus}일 연속 방문 보상 +${u2.streakBonus}셀!`), 800);
  // ★ 자동 로그인 경로와 같은 «한도 초과» 차단 — 새로고침·재로그인으로 우회할 수 없게
  if(u2.play && u2.play.overLimit && !state.overplayDismissed){
    show('start');
    showOverplay({ minutes: u2.play.minutes });
    return;
  }
  startPlayTimer();
  await enter();
}
(function bindContinue(){
  const row = $('#continue-row'), msg = $('#cont-msg');
  const say = (text, good)=>{
    if(!msg) return;
    msg.textContent = text;
    msg.classList.toggle('bad', !good);
    msg.classList.toggle('good', !!good);
  };
  $('#btn-continue')?.addEventListener('click', ()=>{
    if(row) row.classList.toggle('hidden');
  });
  // PIN 검증 로그인 (계약: POST /api/account/pin/verify {nickname,pin} → {ok,token,nickname})
  $('#cont-pin-go')?.addEventListener('click', async ()=>{
    const nick = (($('#cont-nick') && $('#cont-nick').value) || '').trim();
    const pin = (($('#cont-pin') && $('#cont-pin').value) || '').trim();
    if(!nick || !/^\d{4}$/.test(pin)) return say('닉네임과 PIN 숫자 4자리를 넣어 줘.', false);
    const btn = $('#cont-pin-go');
    if(btn) btn.disabled = true;
    try{
      const r = await api('/api/account/pin/verify', { nickname: nick, pin });
      say('다시 만나서 반가워! 들어갈게…', true);
      await continueWithSession(r.nickname || nick, r.token);
    }catch(e){ say(e.message || '들어가지 못했어요. 다시 확인해 줘.', false); }
    finally{ if(btn) btn.disabled = false; }
  });
  // 기기 이전 코드 수령 (계약: POST /api/account/transfer/claim {code} → {ok,token,nickname})
  $('#cont-code-go')?.addEventListener('click', async ()=>{
    const code = (($('#cont-code') && $('#cont-code').value) || '').trim();
    if(!/^\d{6}$/.test(code)) return say('이전 코드는 숫자 6자리예요.', false);
    const btn = $('#cont-code-go');
    if(btn) btn.disabled = true;
    try{
      const r = await api('/api/account/transfer/claim', { code });
      say('기억을 옮겨 왔어! 들어갈게…', true);
      await continueWithSession(r.nickname || '', r.token);
    }catch(e){ say(e.message || '코드를 받지 못했어요. 유효 시간(10분)을 확인해 줘.', false); }
    finally{ if(btn) btn.disabled = false; }
  });
})();
