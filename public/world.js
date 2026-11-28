// ============================================================
// 2026-10-31 — AI 마을 (Babylon.js + CC0 Quaternius 에셋)
//  - My Room 과 별도 엔진/씬. 열 때만 생성하고 닫으면 dispose.
//  - 실제 3D 에셋(나무·바위·집·우물 등) + 지형/호수/부유섬/별 조각
//  - 곡선 오솔길, 물 반사, 그림자, 안개, 블룸/ACES 톤매핑
// ============================================================
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };

  // 결정론적 난수 — 새로고침해도 같은 마을이 나오도록
  let _seed = 20261031;
  function rnd() {
    _seed = (_seed * 1664525 + 1013904223) % 4294967296;
    return _seed / 4294967296;
  }
  const rr = (a, b) => a + rnd() * (b - a);
  const pickOne = (arr) => arr[Math.min(arr.length - 1, (rnd() * arr.length) | 0)];

  const WORLD_SIZE = 184;
  const EDGE_R = 62;        // 걸어다닐 수 있는 반경
  const WATER_Y = -0.6;
  const LAKE = { x: 27, z: 12 };
  // 충돌 반경(원본 스케일 기준, 배치 스케일을 곱해 사용)
  const COLL_R = {
    house1: 2.4, house2: 2.7, house3: 2.3, house4: 2.4, inn: 2.8,
    blacksmith: 2.4, stable: 2.2, mill: 2.2, belltower: 1.7, well: 1.05,
    market: 1.35, gazebo: 1.8, barrel: 0.42, crate: 0.46, hay: 0.62,
    cart: 0.95, fence: 0.45, bench: 0.55, stump: 0.4, log: 0.7,
    treeRound: 0.36, treeRound2: 0.34, treePine: 0.32, treePine2: 0.3,
    treeBirch: 0.3, treeWillow: 0.34, rock: 0.5, rockMoss: 0.46,
    bush1: 0.5, bush2: 0.48, bushBerry: 0.5,
    // v1.33 변형 에셋 — 충돌 반경을 빼먹으면 «나무 통과» 물리 버그가 되살아난다
    treeRound3: 0.36, treeRound4: 0.36, treeRound5: 0.36,
    treeBirch2: 0.3, treePine3: 0.32, treeWillow2: 0.34,
    rock2: 0.5, rock3: 0.5, rock4: 0.5, rockMoss2: 0.46, bushBerry2: 0.5
  };
  const COLL = [];
  const SEGS = [];   // 긴 물체(울타리 등)는 선분으로 충돌 처리

  const W = {
    engine: null, scene: null, cam: null, root: null, model: null, anims: {},
    keys: {}, stars: [], collected: 0, ready: false, open: false, opening: false,
    cancelBuild: false, starsCollected: null,   // ★ 로딩 중 닫기 취소 플래그 / 오늘 주운 별(서버 동기)
    vy: 0, air: 0, grounded: true, animName: '', animLock: 0,
    clouds: [], birds: null, windmills: [], fires: [], shadow: null, glow: null,
    onKeyDown: null, onKeyUp: null, onResize: null, water: null, waterBump: null,
    water2: null, waterBump2: null, t: 0, waterBlocked: 0, boomIdeal: 12, lastRadius: 12,
    stations: [], lessons: null, nearStation: -1, quizOpen: false, lessonDone: 0, villageKeys: [],
    chests: [], nearType: '', near: -1, starfall: null, starTimer: 40,
    fallTex: null, floaters: [],         // v1.33 폭포 스크롤 / 부유 쇄석
    chatOpen: false,                     // v1.34 세계 안 대화 중 (걷기 입력 잠금)
    peers: new Map(), presenceTimer: null, presenceBusy: false, nearPeer: null,  // v1.35 친구와 같은 마을
    quests: [], questDone: new Set(), questMarks: [], questRelics: [], nearQuest: null,  // v1.37 의뢰 레이어
    secretOpen: false, secretSeen: false,  // v1.38 마을 끝 이정표
    vaultOpen: false, vaultLit: 0, vaultFixed: 0, vaultLamps: [], vaultSpot: null, vaultGlow: null,  // v1.39 별빛 저장고
    rumi: null, rumiNear: false, rumiTipShown: false, rumiPickObs: null,  // ★ 2026-11-20 (v1.71) 루미 NPC
    crystals: [],   // ★ 2026-11-20 (v1.71) 수정 구슬 — village_props crystal_1..5 로 spawn 된 유물
    shards: [], shardTipShown: false, teachCount: null,   // ★ 2026-11-21 (v1.74) 빛의 조각 명예 장식(정적 emissive — fx 슬롯 불필요)
    warpOpen: false, warp: null,                          // ★ 2026-11-21 (v1.74) 빠른 이동 — 순수 UI(사용성 기능, 저사양 단계에서도 유지)
    // ★ 2026-11-21 (v1.73) L1 성능 프레임워크 상태 — closeWorld 가 전부 리셋한다.
    //   fx: 특수효과 스위치(2·3단계 작업자는 새 이펙트를 반드시 여기에 등록).
    //   veg: «거리 3환» 컬링 레지스트리(sp_ wrap + 배치 좌표). grassThin: thinInstance 잔디 수집 버퍼.
    //   fxProbe: FPS 샘플러 — 2.5s 평균이 26 미만이면 2연속으로 품질 한 단계 강등(내려가기만).
    fx: { godRays: false, weather: false, waterWave: true, windSway: false, birds: true, fish: false,
      cloth: true, grassBend: false, petals: false, footprints: false, dof: false,
      shadows: true, ssao: true, particles: true },   // 기본값 = «현행 동작» (초기 단계 적용 시 덮어씀)
    fxTier: 'high',
    veg: [], vegTimer: 0,
    grassThin: {},
    fxProbe: { active: false, frames: 0, time: 0, low: 0 },
    waterMat: null, __shadowListSave: null,
    // ★ 2026-11-21 (v1.73) L2 환경 시스템 — 낮밤/날씨/안개/야간 요소(3단계 작업자 계약 필드).
    //   dayNight: { t(0..1, 0=새벽), day(세계 날짜), hour(0..24), isNight, nightK(0..1 밤 비중) }
    //   weather:  { mode('clear'|'cloudy'|'rain'|'mist'), windStrength(0..1 — 후속 바람 흔들림 소비),
    //               fogBoost(0..0.8 — /api/lamps decay≥50 비율×0.8 «기억 안개»), cloud/rain/mist(블렌드 가중) }
    dayNight: null, weather: null, hemi: null, sun: null, sunDir: null,
    skyBox: null, skyMat: null, starDomeMat: null, moonMesh: null,
    fogPlanes: null, windowMat: null, windowLights: [], foam: null,
    waterWM: null, groundMat: null, groundBump: null,
    rainPs: null, ripplePs: null, rainE: null, rippleE: null,
    godRayPP: null, sunMesh: null, lilyWraps: [],
    ridgeMats: [], shoreMat: null,
    // ★ 2026-11-21 (v1.73) L4/L5/L6 — 생명감·스토리·마감 레이어 상태(closeWorld 가 전부 리셋한다)
    sway: null,      // 바람 흔들림(CustomMaterial) 레지스트리 { mats:[], saved:[[mesh, 원본재질]] }
    pillars: null,   // 의뢰 광기둥 + 탑 빛기둥(emissive — 라이트 아님)
    fish: null,      // 호수 물고기 그림자 + 물결 링
    butterflies: null, flags: null, springFog: null,
    petals: null,    // 계절 흩날림 파티클(≤120)
    prints: null,    // 발자국 링 버퍼(24장)
    sparkle: null,   // 수집 흡입 광휘 파티클(≤40)
    bloomT: 0, dofT: 0,             // 화면 펄스 타이머(블룸/DOF)
    __lastInput: 0, onCanvasDown: null, rippleTex: null
  };

  // ────────────────────────── 지형 ──────────────────────────
  // 마을 중앙은 평평하고, 호수는 움푹 파이고, 바깥으로 갈수록 능선이 솟는다.
  function baseNoise(x, z) {
    return (
      Math.sin(x * 0.052) * Math.cos(z * 0.046) * 3.3 +
      Math.sin(x * 0.107 + z * 0.071) * 1.55 +
      Math.cos(x * 0.028 - z * 0.041) * 2.15 +
      Math.sin(x * 0.215 + 0.7) * Math.cos(z * 0.183 - 0.4) * 0.5
    );
  }
  function heightAt(x, z) {
    const r = Math.hypot(x, z);
    let h = baseNoise(x, z);
    // 마을 평탄지
    h *= smoothstep(13, 31, r);
    // 호수 저지대 + 웅덩이 (완만한 그릇 형태)
    const dl = Math.hypot(x - LAKE.x, z - LAKE.z);
    const low = 1 - smoothstep(11, 25, dl);
    const lowK = 0.55;
    h *= (1 - low * lowK);
    h -= (1 - smoothstep(3.0, 12.0, dl)) * 4.2;
    // 외곽 산맥
    const ridge = smoothstep(60, 88, r);
    h += ridge * (Math.sin(x * 0.071) * Math.cos(z * 0.066) * 13 + 9.5);
    // 호수 밖은 바닥을 -2.4 로 제한 (깊은 구덩이 방지)
    if (dl > 13.5) h = Math.max(h, -2.4);
    return h;
  }
  function groundY(x, z) { return Math.max(heightAt(x, z), WATER_Y); }
  function inLake(x, z) { return Math.hypot(x - LAKE.x, z - LAKE.z) < 9.6; }
  // 실제 수면이 있는 곳(호수 원판 안 + 지형이 수위 아래)만 막는다
  function canWalk(x, z) {
    if (inLake(x, z) && heightAt(x, z) < WATER_Y + 0.05) return false;
    return true;
  }
  // 이동 차단 사유 반환 (null = 통과 가능)
  function blockReason(x, z) {
    if (x * x + z * z > EDGE_R * EDGE_R) return 'edge';
    if (!canWalk(x, z)) return 'water';
    for (let i = 0; i < COLL.length; i++) {
      const c = COLL[i];
      const dx = x - c.x, dz = z - c.z;
      if (dx * dx + dz * dz < c.r * c.r) return 'prop';
    }
    // 선분(울타리) — 점과 선분 거리
    for (let i = 0; i < SEGS.length; i++) {
      const g = SEGS[i];
      const vx = g.x2 - g.x1, vz = g.z2 - g.z1;
      const wx = x - g.x1, wz = z - g.z1;
      const len2 = vx * vx + vz * vz || 1;
      let t = (wx * vx + wz * vz) / len2;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const px = g.x1 + vx * t - x, pz = g.z1 + vz * t - z;
      if (px * px + pz * pz < g.r * g.r) return 'prop';
    }
    return null;
  }

  // ────────────────────────── 재질 유틸 ──────────────────────────
  function pbr(scene, name, hex, rough, metal) {
    const m = new BABYLON.PBRMaterial(name, scene);
    m.albedoColor = BABYLON.Color3.FromHexString(hex);
    m.metallic = metal == null ? 0 : metal;
    m.roughness = rough == null ? 0.85 : rough;
    m.environmentIntensity = 0.55;
    return m;
  }
  function emissiveMat(scene, name, hex, intensity) {
    const m = pbr(scene, name, hex, 0.5, 0);
    m.emissiveColor = BABYLON.Color3.FromHexString(hex);
    m.emissiveIntensity = intensity == null ? 1.1 : intensity;
    m.disableLighting = false;
    return m;
  }

  // ────────────────────────── 절차적 텍스처 ──────────────────────────
  // 구름 — 여러 겹 퍼프로 뭉게구름 느낌
  function cloudTexture(scene) {
    const S = 256;
    const dt = new BABYLON.DynamicTexture('wCloudTex', { width: S, height: S }, scene, true);
    const g = dt.getContext();
    g.clearRect(0, 0, S, S);
    const puffs = [
      [118, 132, 56], [78, 142, 40], [162, 144, 42], [104, 108, 34],
      [140, 112, 30], [92, 122, 26], [150, 126, 24]
    ];
    puffs.forEach((p) => {
      const gr = g.createRadialGradient(p[0], p[1], 1, p[0], p[1], p[2]);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(0.5, 'rgba(255,255,255,0.72)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(p[0], p[1], p[2], 0, 6.284); g.fill();
    });
    dt.update(false); dt.hasAlpha = true;
    return dt;
  }
  // 연기 퍼프
  function smokeTexture(scene) {
    const S = 64;
    const dt = new BABYLON.DynamicTexture('wSmokeTex', { width: S, height: S }, scene, false);
    const g = dt.getContext();
    g.clearRect(0, 0, S, S);
    const gr = g.createRadialGradient(32, 32, 1, 32, 32, 31);
    gr.addColorStop(0, 'rgba(255,255,255,0.95)');
    gr.addColorStop(0.45, 'rgba(240,240,240,0.45)');
    gr.addColorStop(1, 'rgba(230,230,230,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(32, 32, 31, 0, 6.284); g.fill();
    dt.update(false); dt.hasAlpha = true;
    return dt;
  }
  // 새 실루엣
  function birdTexture(scene) {
    const S = 64;
    const dt = new BABYLON.DynamicTexture('wBirdTex', { width: S, height: S }, scene, true);
    const g = dt.getContext();
    g.clearRect(0, 0, S, S);
    g.strokeStyle = 'rgba(38,44,54,0.9)'; g.lineWidth = 4; g.lineCap = 'round';
    g.beginPath(); g.moveTo(8, 40); g.quadraticCurveTo(22, 22, 32, 36);
    g.quadraticCurveTo(42, 22, 56, 40); g.stroke();
    dt.update(false); dt.hasAlpha = true;
    return dt;
  }

  // 표면 요철용 노멀맵 — 물결 / 흙 디테일에 함께 사용
  function normalTexture(scene, name, size, strength, freq) {
    const dt = new BABYLON.DynamicTexture(name, { width: size, height: size }, scene, true);
    const ctx = dt.getContext();
    const H = new Float32Array(size * size);
    const TAU = Math.PI * 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x / size) * TAU, v = (y / size) * TAU;
        H[y * size + x] =
          Math.sin(u * freq + Math.cos(v * 2) * 1.6) * 0.5 +
          Math.sin(v * (freq + 2) + Math.cos(u * 3) * 1.3) * 0.34 +
          Math.sin((u + v) * (freq + 5)) * 0.16;
      }
    }
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const l = H[y * size + ((x - 1 + size) % size)];
        const r = H[y * size + ((x + 1) % size)];
        const d = H[((y - 1 + size) % size) * size + x];
        const u2 = H[((y + 1) % size) * size + x];
        let nx = (l - r) * strength, ny = (d - u2) * strength, nz = 1;
        const len = Math.hypot(nx, ny, nz);
        const i = (y * size + x) * 4;
        img.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
        img.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
        img.data[i + 2] = ((nz / len) * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    dt.update(false);
    dt.wrapU = dt.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    return dt;
  }

  // 잔디 알베도 — 큰 얼룩 + 잔풀 + 반점을 겹쳐 그린다 (타일 이음새 없이)
  function grassTexture(scene) {
    // v1.33: 텍스처 전용 난수를 쓰고 «원래 시드» 로 되돌린다 —
    //   질감을 추가해도 마을/숲 배치(결정론적 rnd 시퀀스)가 한 치도 흔들리지 않게 하기 위함.
    const savedSeed = _seed;
    const S = 1024;
    const dt = new BABYLON.DynamicTexture('wGroundTex', { width: S, height: S }, scene, true);
    const g = dt.getContext();
    // 기본색 + 픽셀 단위 노이즈 (그라디언트 밴딩 방지용 디더링)
    g.fillStyle = '#74a354'; g.fillRect(0, 0, S, S);
    try {
      const base = g.getImageData(0, 0, S, S);
      const d = base.data;
      for (let i = 0; i < d.length; i += 4) {
        const nz = (rnd() - 0.5) * 22;
        d[i] = clamp(d[i] + nz, 0, 255);
        d[i + 1] = clamp(d[i + 1] + nz * 0.9, 0, 255);
        d[i + 2] = clamp(d[i + 2] + nz * 0.7, 0, 255);
      }
      g.putImageData(base, 0, 0);
    } catch (e) { /* 노이즈 생략 */ }

    // 큰 얼룩 (테두리 넘어가도 이음새 없도록 9번 반복)
    const blot = (x, y, r, rgb, a) => {
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const gr = g.createRadialGradient(x + ox * S, y + oy * S, 0, x + ox * S, y + oy * S, r);
          gr.addColorStop(0, 'rgba(' + rgb + ',' + a + ')');
          gr.addColorStop(1, 'rgba(' + rgb + ',0)');
          g.fillStyle = gr;
          g.beginPath(); g.arc(x + ox * S, y + oy * S, r, 0, 6.284); g.fill();
        }
      }
    };
    for (let i = 0; i < 520; i++) {
      const dark = rnd() < 0.5;
      blot(rnd() * S, rnd() * S, rr(14, 58), dark ? '66,106,52' : '122,160,88', rr(0.05, 0.12));
    }
    for (let i = 0; i < 40; i++) {
      const dark = rnd() < 0.5;
      blot(rnd() * S, rnd() * S, rr(90, 150), dark ? '70,110,55' : '118,156,86', rr(0.03, 0.05));
    }
    // 흙이 드러난 자리
    for (let i = 0; i < 26; i++) {
      blot(rnd() * S, rnd() * S, rr(20, 62), '124,104,72', rr(0.08, 0.18));
    }
    // 잔풀결
    for (let i = 0; i < 14000; i++) {
      const x = rnd() * S, y = rnd() * S, len = 2 + rnd() * 7;
      g.strokeStyle = 'rgba(' + ((52 + rnd() * 52) | 0) + ',' + ((104 + rnd() * 62) | 0) + ',' + ((46 + rnd() * 34) | 0) + ',' + (0.14 + rnd() * 0.3) + ')';
      g.lineWidth = 0.6 + rnd() * 1.1;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + rnd() * 2.4 - 1.2, y - len); g.stroke();
    }
    // 햇빛 반점
    for (let i = 0; i < 150; i++) {
      g.fillStyle = 'rgba(255,248,205,' + (0.04 + rnd() * 0.09) + ')';
      g.beginPath(); g.arc(rnd() * S, rnd() * S, 2 + rnd() * 9, 0, 6.284); g.fill();
    }
    // v1.33 근거리 미세 디테일: 낙엽·마른 풀·흙 알갱이·연두 새싹.
    //   Wide shot 에서는 «큰 얼룩» 이, 가까이서는 «점·선» 이 보이도록 스케일을 두 층으로 나눈다.
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * S, y = rnd() * S, t = rnd();
      if (t < 0.42) {
        g.strokeStyle = 'rgba(' + ((150 + rnd() * 60) | 0) + ',' + ((128 + rnd() * 48) | 0) + ',' +
          ((70 + rnd() * 40) | 0) + ',' + (0.10 + rnd() * 0.22) + ')';
        g.lineWidth = 0.7 + rnd() * 1.2;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 7, y + (rnd() - 0.5) * 3); g.stroke();
      } else if (t < 0.72) {
        g.fillStyle = 'rgba(96,84,62,' + (0.10 + rnd() * 0.22) + ')';
        g.beginPath(); g.arc(x, y, 0.5 + rnd() * 1.6, 0, 6.284); g.fill();
      } else {
        g.fillStyle = 'rgba(' + ((150 + rnd() * 50) | 0) + ',' + ((196 + rnd() * 40) | 0) + ',' +
          ((96 + rnd() * 40) | 0) + ',' + (0.08 + rnd() * 0.18) + ')';
        g.beginPath(); g.arc(x, y, 0.6 + rnd() * 1.8, 0, 6.284); g.fill();
      }
    }
    dt.update(false);
    _seed = savedSeed;                 // 배치 시퀀스 원복
    dt.uScale = 5; dt.vScale = 5;
    dt.anisotropicFilteringLevel = 8;
    return dt;
  }

  // 흙길 텍스처 (리본 UV 를 따라 늘어난다)
  function pathTexture(scene) {
    const savedSeed = _seed;
    const W2 = 128, H2 = 256;
    const dt = new BABYLON.DynamicTexture('wPathTex', { width: W2, height: H2 }, scene, true);
    const g = dt.getContext();
    g.fillStyle = '#b09a72'; g.fillRect(0, 0, W2, H2);
    // v1.33 수레바퀴 자국 — 리본을 따라 반복되므로 길의 «방향» 이 읽힌다
    [0.30, 0.70].forEach((fx) => {
      const grd = g.createLinearGradient((fx - 0.09) * W2, 0, (fx + 0.09) * W2, 0);
      grd.addColorStop(0, 'rgba(112,92,66,0)');
      grd.addColorStop(0.5, 'rgba(104,84,58,0.20)');
      grd.addColorStop(1, 'rgba(112,92,66,0)');
      g.fillStyle = grd; g.fillRect((fx - 0.09) * W2, 0, 0.18 * W2, H2);
    });
    for (let i = 0; i < 900; i++) {
      const x = rnd() * W2, y = rnd() * H2, r = 1 + rnd() * 5;
      const c = rnd() < 0.5 ? '150,132,100' : '196,178,146';
      g.fillStyle = 'rgba(' + c + ',' + (0.18 + rnd() * 0.35) + ')';
      g.beginPath(); g.arc(x, y, r, 0, 6.284); g.fill();
    }
    for (let i = 0; i < 260; i++) {
      g.fillStyle = 'rgba(120,104,78,' + (0.15 + rnd() * 0.25) + ')';
      g.beginPath(); g.arc(rnd() * W2, rnd() * H2, 0.8 + rnd() * 2.4, 0, 6.284); g.fill();
    }
    // v1.33 자갈 + 흙갈이 결 — 가까이서 «평면 색 띠» 로 보이지 않게
    for (let i = 0; i < 420; i++) {
      const x = rnd() * W2, y = rnd() * H2, r = 0.6 + rnd() * 2.2;
      g.fillStyle = 'rgba(' + ((178 + rnd() * 40) | 0) + ',' + ((164 + rnd() * 36) | 0) + ',' +
        ((140 + rnd() * 34) | 0) + ',' + (0.25 + rnd() * 0.4) + ')';
      g.beginPath(); g.arc(x, y, r, 0, 6.284); g.fill();
    }
    for (let i = 0; i < 90; i++) {
      g.strokeStyle = 'rgba(126,108,80,' + (0.06 + rnd() * 0.12) + ')';
      g.lineWidth = 0.6 + rnd() * 1.4;
      const x = rnd() * W2, y = rnd() * H2;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 5, y + 8 + rnd() * 26); g.stroke();
    }
    // v1.33 가장자리: 페이드를 넓히고 «풀색» 으로 물들인다 → 검은 테두리 제거
    const img = g.getImageData(0, 0, W2, H2);
    for (let y = 0; y < H2; y++) {
      for (let x = 0; x < W2; x++) {
        const edge = Math.min(x, W2 - 1 - x) / (W2 * 0.34);
        const a = clamp(edge, 0, 1);
        const i = (y * W2 + x) * 4;
        if (a < 1) {
          const k = 1 - a;
          img.data[i] = img.data[i] * a + 116 * k;
          img.data[i + 1] = img.data[i + 1] * a + 154 * k;
          img.data[i + 2] = img.data[i + 2] * a + 84 * k;
        }
        img.data[i + 3] = a * a * (3 - 2 * a) * 255;
      }
    }
    g.putImageData(img, 0, 0);
    dt.update(false); dt.hasAlpha = true;
    // v1.33: DynamicTexture 기본값 CLAMP 이면 vScale=8 이 «끝 픽셀» 만 반복한다.
    //   WRAP 으로 바꿔야 자갈·수레바퀴 결이 길을 따라 진짜로 반복된다.
    dt.wrapU = dt.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    _seed = savedSeed;
    dt.uScale = 1; dt.vScale = 8;
    return dt;
  }

  // ────────────────────────── 하늘 / 조명 ──────────────────────────
  function createSky(scene) {
    scene.clearColor = new BABYLON.Color4(0.6, 0.79, 0.96, 1);
    let skybox = null;
    try {
      if (BABYLON.SkyMaterial) {
        skybox = BABYLON.MeshBuilder.CreateBox('wSkyBox', { size: 900 }, scene);
        const sky = new BABYLON.SkyMaterial('wSkyMat', scene);
        sky.inclination = 0.24;          // 해가 조금 낮게 — 오후 햇살
        sky.luminance = 1.0;
        sky.turbidity = 6.2;
        sky.rayleigh = 2.35;
        sky.mieCoefficient = 0.0045;
        sky.mieDirectionalG = 0.83;
        sky.sunPosition = new BABYLON.Vector3(-0.42, 0.34, -0.84).normalize().scale(120);
        sky.useSunPosition = true;
        skybox.material = sky;
        skybox.infiniteDistance = true;
        skybox.isPickable = false;
        skybox.applyFog = false;
        // ★ 2026-11-21 (v1.73) L2 낮밤 — SkyMaterial 참조를 남겨 updateEnvironment 가
        //   sunPosition(태양 궤도)·luminance(새벽/밤 명암)·mieCoefficient(석양 산란)를 구동한다.
        W.skyMat = sky;
        W.skyBox = skybox;
      }
    } catch (e) { skybox = null; }

    if (!skybox) {
      const dome = BABYLON.MeshBuilder.CreateSphere('wSkyDome', { diameter: 700, segments: 24 }, scene);
      const dt = new BABYLON.DynamicTexture('wSkyT', { width: 16, height: 256 }, scene, true);
      const g = dt.getContext();
      const gr = g.createLinearGradient(0, 0, 0, 256);
      gr.addColorStop(0, '#5aa8ef'); gr.addColorStop(0.5, '#bcdcfb'); gr.addColorStop(1, '#f6f1e2');
      g.fillStyle = gr; g.fillRect(0, 0, 16, 256); dt.update(false);
      const m = new BABYLON.StandardMaterial('wSkyFallback', scene);
      m.emissiveTexture = dt; m.disableLighting = true; m.backFaceCulling = false;
      dome.material = m; dome.infiniteDistance = true; dome.isPickable = false; dome.applyFog = false;
      skybox = dome;
      W.skyBox = skybox;   // ★ v1.73 — 폴백 돔도 WaterMaterial 반사 목록에 쓴다
    }
    return skybox;
  }

  function createLights(scene) {
    const hemi = new BABYLON.HemisphericLight('wHemi', new BABYLON.Vector3(0, 1, 0), scene);
    hemi.intensity = 0.74;
    hemi.diffuse = new BABYLON.Color3(1, 0.99, 0.95);
    hemi.groundColor = new BABYLON.Color3(0.42, 0.5, 0.36);

    const sun = new BABYLON.DirectionalLight('wSun', new BABYLON.Vector3(0.42, -0.72, 0.55), scene);
    sun.intensity = 2.35;
    sun.diffuse = new BABYLON.Color3(1, 0.96, 0.87);
    sun.position = new BABYLON.Vector3(-56, 78, -70);
    sun.autoCalcShadowZBounds = false;
    sun.shadowMinZ = 1; sun.shadowMaxZ = 150;

    const sh = new BABYLON.ShadowGenerator(2048, sun);
    sh.usePercentageCloserFiltering = true;
    sh.filteringQuality = BABYLON.ShadowGenerator.QUALITY_MEDIUM;
    sh.darkness = 0.30;
    sh.bias = 0.0035;
    sh.normalBias = 0.055;
    W.shadow = sh;

    // 하늘 반사 — PBR 재질의 광택/환경광
    try {
      const env = BABYLON.CubeTexture.CreateFromPrefilteredData(
        'https://assets.babylonjs.com/environments/environmentSpecular.env', scene);
      scene.environmentTexture = env;
      scene.environmentIntensity = 0.75;
    } catch (e) { /* 환경맵이 없어도 동작 */ }
    return { hemi, sun, sh };
  }

  // ────────────────────────── 지형 / 물 / 길 ──────────────────────────
  function createTerrain(scene) {
    const seg = 228;
    const ground = BABYLON.MeshBuilder.CreateGround('wTerrain',
      { width: WORLD_SIZE, height: WORLD_SIZE, subdivisions: seg, updatable: true }, scene);
    const pos = ground.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    for (let i = 0; i < pos.length; i += 3) pos[i + 1] = heightAt(pos[i], pos[i + 2]);
    ground.updateVerticesData(BABYLON.VertexBuffer.PositionKind, pos);
    const idx = ground.getIndices();
    const nrm = [];
    BABYLON.VertexData.ComputeNormals(pos, idx, nrm);
    ground.setVerticesData(BABYLON.VertexBuffer.NormalKind, nrm);
    ground.receiveShadows = true;
    ground.isPickable = false;

    // v1.33 지형 «정점 색» 분층 — 알베도 텍스처에 «곱해지는 계수» 로만 쓴다.
    //   절대색을 넣으면 PBR 곱셈에서 전체가 어두워지므로 값은 반드시 1 근처(0.55~1.35).
    //   높이 · 법선 기울기 · 호수와의 거리로 모래/암벽/능선/저지대를 한 장에서 섞는다.
    const cols = new Float32Array((pos.length / 3) * 4);
    const hash2 = (x, z) => {
      const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453;
      return v - Math.floor(v);
    };
    for (let i = 0, j = 0; i < pos.length; i += 3, j += 4) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      const ny = Math.abs(nrm[i + 1]);              // 1 = 평지, 작을수록 급경사
      const dl = Math.hypot(x - LAKE.x, z - LAKE.z);
      let r = 1, g = 1, b = 1;
      // 호숫가 모래·자갈 띠 (수면 바로 바깥)
      const shore = (1 - smoothstep(9.4, 15.5, dl)) * smoothstep(7.6, 9.4, dl);
      r += shore * 0.20; g += shore * 0.07; b -= shore * 0.20;
      // 높은 능선은 차가운 회녹색
      const high = smoothstep(6, 18, y);
      r -= high * 0.16; g -= high * 0.08; b -= high * 0.14;
      // 급사면은 바위빛 — 채도를 낮추고 살짝 어둡게
      const steep = 1 - smoothstep(0.72, 0.96, ny);
      r -= steep * 0.06; g -= steep * 0.02; b += steep * 0.02;
      const dim = 1 - steep * 0.10;
      r *= dim; g *= dim; b *= dim;
      // 배수가 잘 안 되는 저지대는 짙은 풀
      const low = (1 - smoothstep(-1.2, 1.6, y)) * (1 - shore);
      r -= low * 0.10; g -= low * 0.02; b -= low * 0.14;
      // 미세 얼룩 — 넓은 면의 기계적인 밴딩 방지(배치용 rnd 시퀀스는 건드리지 않음)
        const n = (hash2(x * 0.7, z * 0.7) - 0.5) * 0.10;
        r += n; g += n * 0.8; b += n * 0.6;
        // v1.33 저주파 «초지 얼룩» — 고주파 점노이즈만으로는 넓은 평지가 밋밋했다.
        const patch = Math.sin(x * 0.16 + Math.sin(z * 0.09) * 1.7) * Math.cos(z * 0.14 - 0.6);
        r += patch * 0.09; g += patch * 0.06; b += patch * 0.09;
      cols[j] = clamp(r, 0.55, 1.35);
      cols[j + 1] = clamp(g, 0.55, 1.35);
      cols[j + 2] = clamp(b, 0.55, 1.35);
      cols[j + 3] = 1;
    }
    ground.setVerticesData(BABYLON.VertexBuffer.ColorKind, cols, false, 4);
    ground.useVertexColors = true;

    const gm = new BABYLON.PBRMaterial('wGroundMat', scene);
    gm.albedoTexture = grassTexture(scene);
    gm.metallic = 0; gm.roughness = 0.97;
    gm.environmentIntensity = 0.42;
    try {
      // ★ 2026-11-21 (v1.73) L3 지형 디테일 — 두 주파수가 섞인 256 노멀맵 한 장 + «거리 페이드».
      //   PBR 은 bump 레이어 2개를 못 얹으므로 단일 object-space bump 로 근접 디테일을 만들고,
      //   updateEnvironment 가 카메라 부무 길이에 따라 bumpTexture.level(강도) 을 0.5↔0.16 로
      //   부드럽게 낮춰 원거리에서의 노이즈 떨림을 없앤다(2-material 분할보다 단순·안전).
      const bump = normalTexture(scene, 'wGroundNrm', 256, 2.6, 5);
      bump.uScale = 30; bump.vScale = 30;
      gm.bumpTexture = bump;
      gm.bumpTexture.level = 0.45;
      W.groundBump = bump;
      W.groundMat = gm;
    } catch (e) { /* 노멀맵 없이도 동작 */ }
    ground.material = gm;

    const water = createWater(scene, ground);
    return { ground, water };
  }

  // ★ 2026-11-21 (v1.73) L3 수면 업그레이드 — high 단계에서는 WaterMaterial(반사·파고·색) 을 얹고
  //   low/min(또는 강등)에서는 기존 «정적 색 수면» 으로 완전 회귀한다(applyFeature 'waterWave' 참고).
  //   반사 renderList 는 지형+하늘+주요 건물만 — RTT 비용을 통제한다(격프레임 갱신).
  function createWater(scene, ground) {
    const cx = LAKE.x, cz = LAKE.z;
    const water = BABYLON.MeshBuilder.CreateDisc('wWater', { radius: 9.6, tessellation: 64 }, scene);
    water.rotation.x = Math.PI / 2;
    water.position.set(cx, WATER_Y, cz);
    water.isPickable = false;
    const wm = new BABYLON.PBRMaterial('wWaterMat', scene);
    wm.albedoColor = new BABYLON.Color3(0.05, 0.23, 0.31);
    wm.metallic = 0.0;
    wm.roughness = 0.30;
    wm.alpha = 0.93;
    wm.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    wm.backFaceCulling = false;
    wm.environmentIntensity = 0.5;
    wm.usePhysicalLightFalloff = false;
    try {
      const bump = normalTexture(scene, 'wWaterNrm', 256, 2.2, 4);
      bump.uScale = 5; bump.vScale = 5;
      wm.bumpTexture = bump;
      wm.bumpTexture.level = 0.35;
      W.waterBump = bump;
    } catch (e) { /* 생략 가능 */ }
    wm.emissiveColor = new BABYLON.Color3(0.02, 0.10, 0.14);
    W.water = water;
    W.waterMat = wm;   // ★ 2026-11-21 (v1.73) 정적 수면 회귀 경로용 참조(applyFeature 'waterWave')

    // ★ v1.73 WaterMaterial — babylonjs-materials CDN 포함 패키지. 실패하면 정적 수면 유지.
    try {
      if (BABYLON.WaterMaterial) {
        const wmm = new BABYLON.WaterMaterial('wWaterWM', scene, new BABYLON.Vector2(512, 256));
        wmm.backFaceCulling = false;
        wmm.windForce = 7;
        wmm.waveHeight = 0.055;
        wmm.bumpHeight = 0.10;
        wmm.waveLength = 0.32;
        wmm.waterColor = new BABYLON.Color3(0.09, 0.30, 0.36);
        wmm.colorBlendFactor = 0.30;
        if (W.waterBump) wmm.bumpTexture = W.waterBump;
        if (ground) wmm.addToRenderList(ground);
        if (W.skyBox) wmm.addToRenderList(W.skyBox);
        // RTT 비용 절반 — 반사·굴절 모두 격프레임 갱신(스타일 수면이라 시각 차이 미미)
        try { if (wmm.reflectionTexture) wmm.reflectionTexture.refreshRate = 2; } catch (e) { }
        try { if (wmm.refractionTexture) wmm.refractionTexture.refreshRate = 2; } catch (e) { }
        W.waterWM = wmm;
        water.material = wmm;
      } else {
        water.material = wm;
      }
    } catch (e) {
      W.waterWM = null;
      water.material = wm;
    }

    // v1.33 얕은 물 띠 — 수면 원판(9.6) 바깥의 급한 경계를 «모래→물» 로 부드럽게 잇는다.
    try {
      const SS = 256;
      const st = new BABYLON.DynamicTexture('wShoreTex', { width: SS, height: SS }, scene, true);
      const sg = st.getContext();
      sg.clearRect(0, 0, SS, SS);
      const grd = sg.createRadialGradient(SS / 2, SS / 2, 0, SS / 2, SS / 2, SS / 2);
      grd.addColorStop(0, 'rgba(150,214,224,0)');
      grd.addColorStop(0.72, 'rgba(150,214,224,0)');
      grd.addColorStop(0.83, 'rgba(158,220,226,0.55)');
      grd.addColorStop(0.94, 'rgba(176,226,214,0.28)');
      grd.addColorStop(1, 'rgba(176,226,214,0)');
      sg.fillStyle = grd; sg.fillRect(0, 0, SS, SS);
      st.update(false); st.hasAlpha = true;
      const sm = new BABYLON.StandardMaterial('wShoreMat', scene);
      sm.diffuseTexture = st; sm.diffuseTexture.hasAlpha = true;
      sm.useAlphaFromDiffuseTexture = true;
      // disableLighting 아래에서는 diffuseTexture 색이 씹힌다 → emissiveTexture 로 원색 출력
      sm.emissiveTexture = st;
      sm.emissiveColor = new BABYLON.Color3(1, 1, 1);
      sm.diffuseColor = new BABYLON.Color3(0, 0, 0);
      sm.specularColor = new BABYLON.Color3(0, 0, 0);
      sm.disableLighting = true; sm.backFaceCulling = false;
      const shore = BABYLON.MeshBuilder.CreateDisc('wShore', { radius: 11.8, tessellation: 64 }, scene);
      shore.rotation.x = Math.PI / 2;
      shore.position.set(cx, WATER_Y + 0.015, cz);
      shore.material = sm; shore.isPickable = false; shore.applyFog = true;
      W.shoreMat = sm;   // ★ v1.73 — 밤 팔레트 디밍(updateEnvironment)용 참조
    } catch (e) { /* 얕은 물 띠 없이도 동작 */ }

    // ★ v1.73 물가 거품선 — 수면 원판(9.6) 가장자리의 흰 거품 링 1 드로우콜.
    //   물결 스위치(W.fx.waterWave)를 따라 켜지고, 알파는 updateEnvironment 가 파도 호흡으로 흔든다.
    try {
      const foamM = new BABYLON.StandardMaterial('wFoamMat', scene);
      foamM.emissiveColor = new BABYLON.Color3(0.88, 0.95, 0.97);
      foamM.diffuseColor = new BABYLON.Color3(0, 0, 0);
      foamM.specularColor = new BABYLON.Color3(0, 0, 0);
      foamM.disableLighting = true;
      foamM.backFaceCulling = false;
      foamM.alpha = 0.3;
      const foam = BABYLON.MeshBuilder.CreateTorus('wFoam',
        { diameter: 19.55, thickness: 0.16, tessellation: 64 }, scene);
      foam.rotation.x = Math.PI / 2;
      foam.position.set(cx, WATER_Y + 0.035, cz);
      foam.material = foamM; foam.isPickable = false;
      W.foam = foam;
    } catch (e) { W.foam = null; }

    return water;
  }

  // 지형을 따라 흐르는 오솔길 리본
  function createPath(scene, pts, width) {
    // v1.33 재설계: «구간별 perp» 가 꺾임점에서 순간적으로 바뀌어 리본이 비틀리고
    //   그 틈으로 검은 뒷면이 새어 나왔다. 점열을 먼저 만든 뒤 «이웃 접선 평균» 으로
    //   perp 를 구하면 모든 단면이 연속 → 검은 지그재그가 구조적으로 사라진다.
    //   rnd() 호출 횟수는 기존과 «정확히 동일»(구간수 × 36) 하게 유지해 배치를 보존한다.
    const n = 36;
    const P = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      for (let k = 0; k < n; k++) {
        const t = k / n;
        P.push({ x: lerp(a[0], b[0], t), z: lerp(a[1], b[1], t), j: rnd() - 0.5 });
      }
    }
    const last = pts[pts.length - 1];
    P.push({ x: last[0], z: last[1], j: 0 });   // 끝점은 rnd 를 쓰지 않는다

    const sections = P.map((p, i) => {
      const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz) || 1;
      const px = -dz / L, pz = dx / L;         // 접선의 수직
      const w2 = width * 0.5 + p.j * width * 0.02;
      const p1 = new BABYLON.Vector3(p.x - px * w2, 0, p.z - pz * w2);
      const p2 = new BABYLON.Vector3(p.x + px * w2, 0, p.z + pz * w2);
      // v1.33: 지형과 살짝 띄워 z-fighting 을 없앤다.
      p1.y = heightAt(p1.x, p1.z) + 0.10;
      p2.y = heightAt(p2.x, p2.z) + 0.10;
      return [p1, p2];
    });
    const ribbon = BABYLON.MeshBuilder.CreateRibbon('wPath',
      { pathArray: sections, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
    ribbon.isPickable = false;
    ribbon.receiveShadows = true;
    const pm = pbr(scene, 'wPathMat', '#f0ece2', 0.98, 0);   // v1.33 텍스처 원색이 주도
    pm.albedoTexture = pathTexture(scene);
    pm.useAlphaFromAlbedoTexture = true;                       // v1.33 가장자리 페이드 실제 적용
    pm.alpha = 0.98;
    pm.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    pm.zOffset = -4;
    ribbon.material = pm;
    return ribbon;
  }

  // ────────────────────────── 에셋 로딩 ──────────────────────────
  const PROTO = {};

  function worldBounds(root) {
    const min = new BABYLON.Vector3(1e9, 1e9, 1e9);
    const max = new BABYLON.Vector3(-1e9, -1e9, -1e9);
    const meshes = root.getChildMeshes ? root.getChildMeshes(false) : [];
    meshes.forEach((m) => {
      m.computeWorldMatrix(true);
      const bb = m.getBoundingInfo().boundingBox;
      min.minimizeInPlace(bb.minimumWorld);
      max.maximizeInPlace(bb.maximumWorld);
    });
    if (min.x > max.x) return null;
    return { min, max };
  }

  // GLB 하나를 "높이 targetH, 바닥 y=0" 으로 정규화해서 보관
  async function loadProto(scene, key, folder, file, targetH, opt) {
    const o = opt || {};
    const base = 'assets/' + folder + '/';
    const container = await BABYLON.SceneLoader.LoadAssetContainerAsync(base, file + '.glb', scene);
    // ★ 로드 도중 씬이 닫혔(교체)으면 원형을 등록하지 않는다 —
    //   폐기된 씬에 묶인 프로토타입이 PROTO 에 남아 다음 입장을 오염시키는 것을 막는다.
    if (W.scene !== scene) {
      try { container.dispose(); } catch (e) { }
      return null;
    }
    container.addAllToScene();
    const holder = new BABYLON.TransformNode('proto_' + key, scene);
    container.rootNodes.forEach((nd) => { nd.parent = holder; });
    holder.computeWorldMatrix(true);

    const b = worldBounds(holder);
    if (!b) { container.removeAllFromScene(); return null; }
    const rawH = Math.max(0.0001, b.max.y - b.min.y);
    const s = (targetH || 1) / rawH;
    holder.scaling.setAll(s);
    holder.position.y = -b.min.y * s;

    container.meshes.forEach((m) => {
      if (!m.getTotalVertices || m.getTotalVertices() === 0) return;
      m.isPickable = false;
      m.receiveShadows = true;
      m.alwaysSelectAsActiveMesh = false;
      const mats = m.material && m.material.subMaterials ? m.material.subMaterials : [m.material];
      mats.forEach((mat) => {
        if (!mat) return;
        if (mat.albedoColor !== undefined) {
          mat.metallic = 0;
          mat.roughness = clamp((mat.roughness == null ? 0.9 : mat.roughness) * 0.6 + 0.34, 0.45, 0.96);
          mat.environmentIntensity = 0.68;
          mat.specularIntensity = 0.25;
          if (o.color) mat.albedoColor = BABYLON.Color3.FromHexString(o.color);
          else if (o.tint) mat.albedoColor = mat.albedoColor.multiply(BABYLON.Color3.FromHexString(o.tint));
        } else if (mat.diffuseColor !== undefined) {
          mat.specularColor = new BABYLON.Color3(0.06, 0.06, 0.06);
          if (o.color) mat.diffuseColor = BABYLON.Color3.FromHexString(o.color);
        }
      });
    });

    holder.setEnabled(false);
    PROTO[key] = { holder, container, targetH: targetH || 1,
      w: (b.max.x - b.min.x) * s, d: (b.max.z - b.min.z) * s };
    // ★ 2026-11-21 (v1.73) 인스턴스 대상 GLB 는 로드 직후 소스를 준비한다 —
    //   buildVillage(buildRest) 보다 «먼저» 준비돼 있어야 첫 spawn 부터 인스턴스 경로를 탄다.
    //   실패해도 조용히 넘어간다(해당 종류만 clone 경로로 계속 — 렌더 결과는 동일).
    if (INSTANCED_KEYS[key]) {
      try { prepareProtoInstances(scene, key); } catch (e) { /* clone 경로로 회귀 */ }
    }
    return PROTO[key];
  }

  // 원본을 복제해 배치. wrap 노드가 위치/회전/배율을 담당.
  // ★ 2026-11-21 (v1.73) 인스턴싱 스폰 — 같은 GLB 를 많이 찍는 소품(나무·바위·덤불·울타리·꽃
  //   등, spawn 수 > 10) 은 clone 대신 InstancedMesh 로 찍어 «(종류×자식mesh) 당 1 드로우콜» 로
  //   줄인다. clone 경로는 그대로 남아 있어 실패 시 자연 회귀한다.
  //   - 잔디 3종(THIN_KEYS) 은 여기서 thinInstance 버퍼로 «수집만» 하고 null 반환
  //     (커밋은 buildRest 의 commitThinGrass — 섬 위 잔디까지 같은 버퍼로).
  //   - 난수 소모: 본 함수는 rnd/rr 를 «절대» 쓰지 않는다 — 배치 시퀀스는 호출부 책임(원본 동일).
  //   - 충돌/그림자 규칙은 registerSpawnCollide + 인스턴스 캐스터 규칙으로 «원본과 동일» 유지.
  function spawn(key, x, z, scale, rotY, opts) {
    const p = PROTO[key];
    if (!p) return null;
    const o = opts || {};
    const sc = (scale == null ? 1 : scale);
    const ry = (rotY == null ? 0 : rotY);
    const y = (o.y != null) ? o.y : (heightAt(x, z) + (o.yOff || 0));

    // ★ v1.73 thin 잔디 수집 — 커밋 전이면 버퍼로 모은다(heightAt 는 난수를 쓰지 않는다)
    if (THIN_KEYS[key] && p.holder && !p.thinDone) {
      grassThinCollect(key, x, y, z, sc, ry);
      return null;
    }

    // ★ v1.73 인스턴스 경로 — 준비된 proto(p.inst) 만. 실패 시 아래 clone 경로로 회귀.
    if (p.inst) {
      const w = spawnInstanced(p, key, x, y, z, sc, ry, o);
      if (w) {
        registerSpawnCollide(key, p, x, z, sc, ry, o);
        return w;
      }
    }

    const wrap = new BABYLON.TransformNode('sp_' + key, scene());
    const c = p.holder.clone('m_' + key, wrap);
    if (!c) { wrap.dispose(); return null; }
    c.setEnabled(true);
    wrap.position.set(x, y, z);
    wrap.rotation.y = ry;
    wrap.scaling.setAll(sc);
    registerSpawnCollide(key, p, x, z, sc, ry, o);
    if (o.shadow !== false) {
      try {
        wrap.getChildMeshes(false).forEach((m) => {
          m.receiveShadows = true;
          if (o.shadow === true || scale >= 0.9) m.castShadow = true;
          if (m.castShadow && W.shadow) W.shadow.addShadowCaster(m, false);
        });
      } catch (e) { /* 그림자 생략 */ }
    }
    return wrap;
  }
  function scene() { return W.scene; }

  // ══════════════ ★ 2026-11-21 (v1.73) L1 성능 프레임워크 ══════════════
  //  ① GLB 반복 소품 인스턴싱  ② 잔디 thinInstance  ③ 거리 3환 컬링  ④ 품질 단계(W.fx)
  //  ── «2·3단계(낮밤/날씨/바람 흔들림) 작업자 필독 계약» ──
  //    새 특수효과를 만들 때는 반드시:
  //      1) W.fx 에 키를 추가한다 (아래 FX_TIERS 네 단계 표 전부).
  //      2) applyFeature() 에 «실제 토글 코드» 를 붙인다 — low/min 에서 반드시 꺼지고,
  //         다시 켤 때 «원래의 정적 표현» 으로 되돌아가는 회귀 경로가 동작해야 한다.
  //      3) update() 프레임 루프에서 W.fx.<키> 를 보고 계산을 스킵할 수 있게 한다.
  //    계약을 어기면 low 단계 기기에서 프레임이 붕괴한다. PointLight 는 ≤9 예산(현재 3개
  //    모닥불 + 3개 빛 조각 = 6) — 새 이펙트는 emissive+GlowLayer 로 대체한다.
  //  ────────────────────────────────────────────────────────────────────
  const FX_TIERS = {
    //        godRays  weather  waterWave  windSway  birds  fish  cloth  grassBend  petals  footprints  dof   shadows  ssao  particles
    //   ★ 2026-11-21 (v1.73) L2: godRays = VLS 태양빛 기둥(high 전용), weather = 비/안개 시트
    //     (high·mid — mid 의 비 파티클은 emitRate 를 낮춰 유지), waterWave = WaterMaterial 반사 수면(high 전용).
    high: { godRays: true,  weather: true,  waterWave: true,  windSway: true,  birds: true,  fish: true,  cloth: true,  grassBend: true,  petals: true,  footprints: true,  dof: true,  shadows: true,  ssao: true,  particles: true },
    mid:  { godRays: false, weather: true,  waterWave: true,  windSway: true,  birds: true,  fish: false, cloth: true,  grassBend: true,  petals: false, footprints: false, dof: false, shadows: true,  ssao: true,  particles: true },
    low:  { godRays: false, weather: false, waterWave: false, windSway: false, birds: false, fish: false, cloth: false, grassBend: false, petals: false, footprints: false, dof: false, shadows: false, ssao: false, particles: true },
    min:  { godRays: false, weather: false, waterWave: false, windSway: false, birds: false, fish: false, cloth: false, grassBend: false, petals: false, footprints: false, dof: false, shadows: false, ssao: false, particles: false }
  };

  // ★ v1.73 인스턴싱 화이트리스트 — «같은 GLB 를 spawn 수 > 10» 찍는 소품만.
  //   절대 넣지 말 것: 보물상자·빛 조각·스테이션(지혜의 샘)·루미 NPC·crystal·mill(풍차 날개
  //   탐색)·bonfire(모닥불 흔들림/PointLight 계약)·house·bench 등 상호작용·독립 애니 소품.
  const INSTANCED_KEYS = {
    treePine: 1, treeRound: 1, treeBirch: 1, treeWillow: 1,
    treeRound3: 1, treeRound4: 1, treeRound5: 1, treeBirch2: 1, treePine3: 1, treeWillow2: 1,
    bush1: 1, bush2: 1, bushBerry: 1, bushBerry2: 1,
    rock: 1, rock2: 1, rock3: 1, rock4: 1, rockMoss: 1, rockMoss2: 1,
    stump: 1, log: 1, lilypad: 1, fence: 1,
    flowers: 1, plant: 1, plant2: 1, plant3: 1
  };
  // ★ v1.73 잔디 3종(GLB) — thinInstance 행렬 버퍼. spawn() 이 수집만 하고
  //   buildRest 의 commitThinGrass() 이 한 번에 GPU 로 올린다(섬 위 잔디까지 같은 버퍼).
  const THIN_KEYS = { grass: 1, grass2: 1, grassShort: 1 };
  // ★ v1.73 거리 3환(근/중/원) 컬링 거리표 [hide, show]. show = hide-8 (히스테리시스).
  //   Babylon instance 는 addLODLevel 을 «상속하지 않으므로» 원거리 LOD(null) 를
  //   «거리 그룹 setEnabled 스위치» 로 대체한다. 플레이어 속도 6m/s × 0.5s = 3m < 8m 갭 → 안전.
  //   대형나무는 실루엣이 커서 84m, 덤불·꽃·수련은 작아서 56~62m 에서 숨긴다.
  const VEG_CULL = {
    treePine: [84, 76], treeRound: [84, 76], treeBirch: [84, 76], treeWillow: [84, 76],
    treeRound3: [84, 76], treeRound4: [84, 76], treeRound5: [84, 76],
    treeBirch2: [84, 76], treePine3: [84, 76], treeWillow2: [84, 76],
    bush1: [60, 52], bush2: [60, 52], bushBerry: [60, 52], bushBerry2: [60, 52],
    rock: [68, 60], rock2: [68, 60], rock3: [68, 60], rock4: [68, 60],
    rockMoss: [68, 60], rockMoss2: [68, 60],
    stump: [60, 52], log: [60, 52], lilypad: [62, 54],
    flowers: [58, 50], plant: [58, 50], plant2: [58, 50], plant3: [58, 50]
  };

  // ★ v1.73 인스턴스 소스 준비 — loadProto 직후 1회.
  //   자식 mesh 의 «holder 기준 월드 행렬»(holder y 보정·스케일 포함) 을 pos/rotQ/scl 로 분해해
  //   저장한다. 인스턴스를 wrap 밑에 붙이면 wrap ∘ (pos·rotQ·scl) = clone 경로의 월드 변환과
  //   «정확히 같은» 결과가 나온다 — 배치 시퀀스/좌표를 1도 안 건드리면서 렌더 경로만 바꾼다.
  //   원본 mesh 는 isVisible=false 로 숨긴다(소스가 숨겨져도 인스턴스는 그대로 그려진다 —
  //   Babylon 공식 동작. setEnabled(false) 인 holder 아래에 있어도 마찬가지).
  function prepareProtoInstances(scene, key) {
    const p = PROTO[key];
    if (!p || p.inst) return;
    const holder = p.holder;
    holder.computeWorldMatrix(true);
    const sources = [];
    holder.getChildMeshes(false).forEach((m) => {
      if (!m.getTotalVertices || m.getTotalVertices() === 0) return;
      m.computeWorldMatrix(true);
      const rel = m.getWorldMatrix().clone();
      const pos = new BABYLON.Vector3(), rotQ = new BABYLON.Quaternion(), scl = new BABYLON.Vector3();
      rel.decompose(scl, rotQ, pos);
      m.isVisible = false;
      m.isPickable = false;
      m.receiveShadows = true;
      sources.push({ mesh: m, pos, rotQ, scl });
    });
    if (sources.length) p.inst = { sources };
  }

  // ★ v1.73 충돌 등록 — clone/인스턴스 양쪽 경로가 «같은 함수» 로 같은 규칙을 쓴다(드리프트 방지).
  //   원본 spawn() 로직 그대로: fence 는 선분(SEGS), 나머지는 원형(COLL_R × 스케일).
  //   충돌은 mesh 가 아니라 «배치 좌표» 기반이므로 인스턴스여도 fence/나무 통과 버그 없음.
  function registerSpawnCollide(key, p, x, z, sc, ry, o) {
    if (o.collide === false || !COLL_R[key]) return;
    if (key === 'fence' && p.w && p.d) {
      const half = (Math.max(p.w, p.d) / 2) * sc * 0.92;
      const ax = Math.cos(ry) * half, az = -Math.sin(ry) * half;
      SEGS.push({ x1: x - ax, z1: z - az, x2: x + ax, z2: z + az, r: 0.34 });
    } else {
      const cr = COLL_R[key] * sc;
      if (cr > 0.12) COLL.push({ x, z, r: cr });
    }
  }

  // ★ v1.73 인스턴스 스폰 — proto 자식 mesh 하나당 InstancedMesh 소스 1개.
  //   그림자는 원본 clone 경로와 «동일한 규칙»(shadow===true || scale>=0.9) 으로 인스턴스 단위
  //   등록한다 — addShadowCaster(소스) 로 한 번에 배치하는 방식은 «숨긴 소스» 의 섀도 패스
  //   동작이 버전에 따라 달라질 수 있어, 회귀 없는 쪽(인스턴스 단위)을 택했다.
  //   실패 시 만든 것 전부 치우고 null 반환 → 호출부가 기존 clone 경로로 자연 회귀한다.
  function spawnInstanced(p, key, x, y, z, sc, ry, o) {
    const wrap = new BABYLON.TransformNode('sp_' + key, scene());
    wrap.position.set(x, y, z);
    wrap.rotation.y = ry;
    wrap.scaling.setAll(sc);
    const made = [];
    try {
      const src = p.inst.sources;
      for (let i = 0; i < src.length; i++) {
        const s = src[i];
        const inst = s.mesh.createInstance('in_' + key + '_' + i);
        inst.position.copyFrom(s.pos);
        inst.rotationQuaternion = s.rotQ.clone();
        inst.scaling.copyFrom(s.scl);
        inst.parent = wrap;
        inst.isPickable = false;
        inst.receiveShadows = true;
        if (o.shadow === true || sc >= 0.9) {
          inst.castShadow = true;
          if (W.shadow) W.shadow.addShadowCaster(inst, false);
        }
        made.push(inst);
      }
    } catch (e) {
      made.forEach((m) => { try { m.dispose(); } catch (e2) { } });
      try { wrap.dispose(); } catch (e2) { }
      return null;
    }
    if (!made.length) { try { wrap.dispose(); } catch (e2) { } return null; }
    // ★ v1.73 거리 3환 등록 — «식물성·바위» 소품만(건물·울타리·상호작용물은 제외)
    const cd = VEG_CULL[key];
    if (cd && W.veg) W.veg.push({ n: wrap, x, z, hide: cd[0], show: cd[1], on: true });
    return wrap;
  }

  // ★ v1.73 잔디 배치 수집 — commitThinGrass 이 한꺼번에 GPU 버퍼로 올린다.
  //   spawn() 의 THIN_KEYS 분기에서만 호출. 여기서는 난수를 «절대» 소모하지 않는다
  //   (배치 시퀀스는 호출부 루프가 이미 원본과 같은 횟수로 소모했다).
  function grassThinCollect(key, x, y, z, s, rotY) {
    if (!W.grassThin) W.grassThin = {};
    if (!W.grassThin[key]) W.grassThin[key] = [];
    W.grassThin[key].push({ x, y, z, s, r: rotY });
  }

  // ★ v1.73 잔디 thinInstance 커밋 — buildRest 이 섬(makeFloatingIsland)까지 지난 뒤 1회 호출.
  //   - thin 인스턴스는 «소스 mesh 자체의 드로우» 를 타므로 소스가 disabled/숨김이면 같이
  //     안 그려진다(일반 instance 와 다른 점!). → holder 밖으로 꺼내 enabled 유지 +
  //     alwaysSelectAsActiveMesh=true 로 보장한다(버퍼 행렬로 퍼진 인스턴스가 소스의
  //     frustum 컬링으로 통째로 빠지는 사고 방지).
  //   - [엔진 근거] instancesVertex.fx: «finalWorld = world * finalWorld» — thin 버퍼 행렬은
  //     소스 mesh 의 월드 행렬과 «곱해진다». 따라서 소스 변환을 «단위행렬로 리셋» 해서
  //     버퍼 행렬이 절대 월드 행렬로 쓰이게 만든다. 버퍼 행렬 = Compose(스케일, rotY, 위치)
  //     × «mesh 의 holder 기준 월드 행렬» — 일반 인스턴스 경로와 같은 수학.
  //   - 커밋 후 p.inst 도 준비해 둔다 → 이후에 spawn('grass') 이 불리면 일반 instance 로 회귀.
  function commitThinGrass(scene) {
    const keys = Object.keys(W.grassThin || {});
    keys.forEach((key) => {
      const p = PROTO[key];
      const list = W.grassThin[key];
      delete W.grassThin[key];
      if (!p || !p.holder || !list || !list.length) return;
      p.thinDone = true;   // 실패해도 «커밋 끝» — 이후 spawn('grass') 은 clone 경로로 회귀(버퍼 누수 방지)
      try {
        const sources = [];
        p.holder.getChildMeshes(false).forEach((m) => {
          if (!m.getTotalVertices || m.getTotalVertices() === 0) return;
          try { m.setParent(null); } catch (e) { return; }
          m.computeWorldMatrix(true);
          const rel = m.getWorldMatrix().clone();   // «holder 기준» 변환 — 리셋 «전»에 캡처
          // 소스 변환을 단위행렬로 — thin 버퍼 행렬이 절대 월드로 쓰이도록(위 엔진 근거)
          m.position.set(0, 0, 0);
          if (m.rotationQuaternion) m.rotationQuaternion = BABYLON.Quaternion.Identity();
          else m.rotation.set(0, 0, 0);
          m.scaling.setAll(1);
          m.computeWorldMatrix(true);
          m.isPickable = false;
          m.receiveShadows = true;
          m.castShadow = false;
          m.alwaysSelectAsActiveMesh = true;
          // 기존 병합 경로와 같게 «잔디 재질은 양면» — clone 때와 픽셀 동일하게
          if (m.material && m.material.backFaceCulling !== undefined) m.material.backFaceCulling = false;
          const buf = new Float32Array(list.length * 16);
          for (let i = 0; i < list.length; i++) {
            const g = list[i];
            const m4 = BABYLON.Matrix.Compose(
              new BABYLON.Vector3(g.s, g.s, g.s),
              BABYLON.Quaternion.RotationYawPitchRoll(g.r, 0, 0),
              new BABYLON.Vector3(g.x, g.y, g.z)
            ).multiply(rel);
            m4.copyToArray(buf, i * 16);
          }
          m.thinInstanceSetBuffer('matrix', buf, 16);
          try { m.thinInstanceRefreshBoundingInfo(); } catch (e) { }
          const pos = new BABYLON.Vector3(), rotQ = new BABYLON.Quaternion(), scl = new BABYLON.Vector3();
          rel.decompose(scl, rotQ, pos);
          sources.push({ mesh: m, pos, rotQ, scl });
        });
        if (sources.length) { p.inst = { sources }; p.thinDone = true; }
      } catch (e) { /* 커밋 실패 시 그 종류 잔디만 생략 — 나머지 월드는 정상 */ }
    });
    W.grassThin = {};
  }

  // ★ v1.73 거리 3환 컬링 — 플레이어(root) 기준. 0.5s 간격으로 검사(update() 에서 호출).
  //   원환 밖은 setEnabled(false) 로 «활성 mesh 평가» 에서 완전히 뺀다(CPU 컬링 비용 절감).
  //   clearGlade 로 dispose 된 wrap 은 isDisposed 가드로 조용히 건너뛴다.
  function updateVegRings() {
    if (!W.root) return;
    const px = W.root.position.x, pz = W.root.position.z;
    const veg = W.veg;
    for (let i = 0; i < veg.length; i++) {
      const v = veg[i];
      if (!v.n || v.n.isDisposed()) continue;
      const d = Math.hypot(v.x - px, v.z - pz);
      if (v.on && d > v.hide) { v.on = false; v.n.setEnabled(false); }
      else if (!v.on && d < v.show) { v.on = true; v.n.setEnabled(true); }
    }
  }

  // ★ v1.73 개별 특수효과 토글 — setWorldFx('birds', false) 처럼 단일 키를 실시간 반영.
  function setWorldFx(key, on) {
    if (!W.fx || !(key in W.fx)) return;
    W.fx[key] = !!on;
    applyFeature(key, W.fx[key]);
  }

  // ★ v1.73 품질 단계 적용 — FX_TIERS 표를 W.fx 에 펼치고 «실제» 사이드이펙트를 연결한다.
  function applyWorldQuality(tier) {
    const t = FX_TIERS[tier] ? tier : 'high';
    W.fxTier = t;
    const flags = FX_TIERS[t];
    Object.keys(flags).forEach((k) => { W.fx[k] = flags[k]; applyFeature(k, flags[k]); });
  }

  // ★ v1.73 초기 단계 판정 — 터치 기기·작은 화면·고DPR 은 mid 에서 시작.
  //   이후는 FPS 프로브(update()) 가 «내려가기만» 조정한다(되올리기 없음 — 히스테리시스 오실레이션 방지).
  function detectInitialTier() {
    try {
      const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const small = Math.min(window.screen.width, window.screen.height) < 820;
      if (coarse || small || dpr >= 2.5) return 'mid';
    } catch (e) { }
    return 'high';
  }

  // ★ v1.73 품질 강등 — high → mid → low → min (한 방향만).
  function downgradeWorldQuality() {
    const order = ['high', 'mid', 'low', 'min'];
    const i = order.indexOf(W.fxTier);
    if (i < 0 || i >= order.length - 1) return;
    console.warn('[world] FPS 저하 — 품질 단계 강등:', W.fxTier, '→', order[i + 1]);
    applyWorldQuality(order[i + 1]);
  }

  // ★ v1.73 특수효과 «실제» 토글 스위치 — 각 키의 회귀 경로는 «반드시» 여기에서만 건드린다.
  function applyFeature(key, on) {
    if (!W.scene) return;   // 씬이 없으면 플래그만 기억 — initWorld 마지막에 다시 적용된다
    try {
      switch (key) {
        case 'shadows': {
          // caster 목록 스왑 — renderList 를 비우면 섀도 패스가 아무것도 그리지 않는다.
          // 재입장/복귀 시 원목록 복원. (강등 뒤 추가된 caster 는 빈 목록으로 들어간다 —
          // «내려가기만» 정책이라 복원 누락 실드가 실질적으로 발생하지 않는다)
          const map = W.shadow && W.shadow.getShadowMap ? (W.shadow.getShadowMap() || null) : null;
          if (!map) break;
          if (!on) {
            if (!W.__shadowListSave) { W.__shadowListSave = map.renderList || []; map.renderList = []; }
          } else if (W.__shadowListSave) {
            map.renderList = W.__shadowListSave;
            W.__shadowListSave = null;
          }
          break;
        }
        case 'ssao': {
          if (W.ssao) W.ssao.setEnabled(!!on);   // PostProcessRenderPipeline 표준 토글
          break;
        }
        case 'waterWave': {
          // low/min 회귀 경로 — 범프를 떼면 «정적 색 수면» (물결 스크롤도 update() 에서 중단).
          // W.waterMat/waterBump 참조는 createWater 가 채운다 — 재활성화 시 원복.
          // ★ 2026-11-21 (v1.73) L3: high 단계에서는 WaterMaterial 반사 수면으로 스왑,
          //   그 외(강등 포함)는 정적 PBR 수면으로 «완전 회귀» 하고 WaterMaterial 은 반납한다.
          if (W.waterMat) W.waterMat.bumpTexture = on ? (W.waterBump || null) : null;
          const useWM = !!on && !!W.waterWM && W.fxTier === 'high';
          if (W.water) {
            try { W.water.material = useWM ? W.waterWM : (W.waterMat || W.water.material); } catch (e) { }
          }
          if (W.foam) { try { W.foam.setEnabled(!!on); } catch (e) { } }   // 거품선도 물결과 같은 스위치
          if (!useWM && W.waterWM) retireWaterWM();
          break;
        }
        case 'godRays': {
          // ★ 2026-11-21 (v1.73) L2 — 태양빛 기둥(VLS post-process). high 전용, 미지원 환경은 무음 생략.
          if (on) ensureGodRays(); else disposeGodRays();
          break;
        }
        case 'weather': {
          // ★ 2026-11-21 (v1.73) L2 — 지면 안개 시트 가시화 + 비 시스템 정지(비 «시작» 은
          //   updateEnvironment 의 날씨 가중치 조건이 담당한다 — 여기서는 회귀 경로만 닫는다).
          if (W.fogPlanes) W.fogPlanes.forEach((p) => { try { p.setEnabled(!!on); } catch (e) { } });
          // ★ 2026-11-21 (v1.73) L5 — «지혜의 샘» 안개도 weather 슬롯을 재사용한다.
          //   당일 미해결 샘일수록 안개가 짙어지고(답 맞추면 걷힘), 꺼지면 완전히 숨는다.
          if (on && W.scene) ensureSpringFog(W.scene);
          else if (W.springFog) W.springFog.forEach((f) => { try { f.p.visibility = 0; } catch (e) { } });
          if (!on) stopRainFx();
          break;
        }
        case 'particles': {
          // 굴뚝 연기 — stop() 해도 이미 나온 입자는 자연 소멸(팝 없음)
          W.fires.forEach((f) => { if (f.ps) { if (on) f.ps.start(); else f.ps.stop(); } });
          // ★ 2026-11-21 (v1.73) L4/L6 — 나비·수집 광휘·계절 흩날림도 particles 예산을 함께 따른다
          //   (보고서 명기: 나비/광휘는 W.fx.particles 슬롯에 태운다)
          if (on && W.scene) { ensureButterflies(W.scene); ensureSparkle(W.scene); }
          if (!on) {
            if (W.butterflies) W.butterflies.forEach((b) => { (b.vis || []).forEach((m) => { try { m.visibility = 0; } catch (e) { } }); });
            if (W.petals) { try { W.petals.ps.stop(); W.petals.ps.emitter.set(0, -60, 0); } catch (e) { } }
          }
          break;
        }
        case 'birds': {
          // 새 스프라이트 — 알파 0 으로 숨김(스프라이트 매니저는 통짜 1 드로우콜이라
          // 숨김 이득은 CPU 갱신 스킵이 본체: update() 의 W.fx.birds 가드)
          if (W.birds) W.birds.forEach((b) => { if (b.sp && b.sp.color) b.sp.color.a = on ? (b.alpha0 != null ? b.alpha0 : 0.85) : 0; });
          break;
        }
        case 'windSway': {
          // ★ 2026-11-21 (v1.73) L4 — CustomMaterial 정점 주입(잔디·나무 수관) «실구현».
          //    켜면 소스 재질을 스왑(thin/일반 인스턴스 전부 함께 흔들린다), 끄면 «원본 재질» 로 완전 회귀.
          if (on) ensureWindSway(); else revertWindSway();
          break;
        }
        case 'grassBend': {
          // ★ L4-2 — 잔디 굽힘은 셰이더가 onBind 때 W.fx.grassBend 를 직접 읽어 uBendOn 으로 반영하고,
          //    updateLife 가 SW.bend(플레이어 위치) 계산을 스킵한다 — «실제 소비» 는 두 지점.
          break;
        }
        case 'cloth': {
          // ★ L4-6 — 깃발 천은 CPU 정점파. 꺼지면 updateFlags 의 W.fx.cloth 가드가
          //    파동 업데이트를 멈춰 «정적 천» 으로 회귀한다(재질 교체 없음).
          break;
        }
        case 'fish': {
          // ★ L4-4 — 호수 물고기 그림자. 끄면 링·물고기 전부 visibility 0 으로 회귀.
          if (on) { if (W.scene) ensureFish(W.scene); }
          else if (W.fish) {
            W.fish.list.forEach((f) => { try { f.m.visibility = 0; } catch (e) { } });
            W.fish.rings.forEach((r) => { try { r.m.visibility = 0; } catch (e) { } });
          }
          break;
        }
        case 'petals': {
          // ★ L6-11 — 계절 흩날림. 끄면 파티클 stop + 이미터를 화면 밖으로 치운다.
          if (on) { if (W.scene) ensurePetals(W.scene); }
          else if (W.petals) { try { W.petals.ps.stop(); W.petals.ps.emitter.set(0, -60, 0); } catch (e) { } }
          break;
        }
        case 'footprints': {
          // ★ L6-13 — 발자국. 끄면 링 버퍼 전부 숨기고 나이를 만료 처리.
          if (on) { if (W.scene) ensurePrints(W.scene); }
          else if (W.prints) W.prints.list.forEach((pr) => { try { pr.m.visibility = 0; pr.age = 5; } catch (e) { } });
          break;
        }
        case 'dof': {
          // ★ L6-15 — 심도 과장은 «2초 순간» 만. 끄면 즉시 원복(강등 경로).
          if (!on && W.pipe && W.pipe.depthOfFieldEnabled) {
            try { W.pipe.depthOfFieldEnabled = false; } catch (e) { }
            W.dofT = 0;
          }
          break;
        }
      }
    } catch (e) { /* 토글 실패가 세계를 죽이지 않게 */ }
  }

  // ────────────────────────── 절차적 소품 ──────────────────────────
  // v1.33 «인덱스 노이즈» — 전역 rnd 시퀀스를 «절대» 소모하지 않는다.
  //   소품을 아무리 늘려도 마을·숲·바위 배치가 한 치도 흔들리지 않게 하기 위함.
  const nz = (i, k) => {
    const v = Math.sin(i * 127.1 + (k || 0) * 311.7 + 74.7) * 43758.5453;
    return v - Math.floor(v);
  };

  // v1.33 나뭇결 텍스처 — 세로 결 + 밝은 하이라이트 + 옹이
  function woodTexture(scene, name, dark) {
    const savedSeed = _seed;            // 텍스처 전용 난수 → 배치 시퀀스 원복
    const S = 512;
    const dt = new BABYLON.DynamicTexture(name, { width: S, height: S }, scene, true);
    const g = dt.getContext();
    g.fillStyle = dark ? '#6b422c' : '#bb8850';
    g.fillRect(0, 0, S, S);
    for (let i = 0; i < 190; i++) {
      const x = rnd() * S;
      g.strokeStyle = (dark ? 'rgba(40,22,14,' : 'rgba(96,58,32,') + (0.05 + rnd() * 0.17) + ')';
      g.lineWidth = 0.6 + rnd() * 2.6;
      g.beginPath(); g.moveTo(x, 0);
      for (let y2 = 0; y2 <= S; y2 += 32) g.lineTo(x + Math.sin(y2 * 0.018 + i) * 2.3, y2);
      g.stroke();
    }
    for (let i = 0; i < 90; i++) {
      const x = rnd() * S;
      g.strokeStyle = 'rgba(255,224,172,' + (0.03 + rnd() * 0.10) + ')';
      g.lineWidth = 0.5 + rnd() * 1.6;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x + rnd() * 6 - 3, S); g.stroke();
    }
    for (let i = 0; i < 5; i++) {
      const x = rnd() * S, yy = rnd() * S, r = 6 + rnd() * 12;
      for (let k = 3; k >= 1; k--) {
        g.strokeStyle = 'rgba(58,34,20,' + (0.10 + k * 0.05) + ')';
        g.lineWidth = 1.4;
        g.beginPath(); g.ellipse(x, yy, r * k * 0.5, r * k * 0.28, 0, 0, 6.284); g.stroke();
      }
    }
    dt.update(false);
    dt.wrapU = dt.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    _seed = savedSeed;
    return dt;
  }

  // v1.33 이정표 글판 — 나뭇결 위 «AI 마을» 음각 문자 + 화살
  function signFaceTexture(scene) {
    const SW = 512, SH = 144;
    const dt = new BABYLON.DynamicTexture('signFaceTex', { width: SW, height: SH }, scene, true);
    const g = dt.getContext();
    const grd = g.createLinearGradient(0, 0, 0, SH);
    grd.addColorStop(0, '#dcb077'); grd.addColorStop(0.52, '#c48f55'); grd.addColorStop(1, '#a97645');
    g.fillStyle = grd; g.fillRect(0, 0, SW, SH);
    for (let i = 0; i < 70; i++) {
      const x = nz(i, 1) * SW;
      g.strokeStyle = 'rgba(90,54,28,' + (0.03 + nz(i, 2) * 0.10) + ')';
      g.lineWidth = 0.5 + nz(i, 3) * 1.8;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x + nz(i, 4) * 5 - 2.5, SH); g.stroke();
    }
    g.strokeStyle = 'rgba(86,52,26,0.55)'; g.lineWidth = 5;
    g.strokeRect(9, 9, SW - 18, SH - 18);
    g.fillStyle = '#fff4d9';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 70px "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
    g.fillText('AI 마을', SW * 0.43, SH * 0.51);
    // 오른쪽 화살 (글꼴 의존 없이 직접 그린다)
    g.beginPath();
    g.moveTo(SW - 108, SH * 0.5 - 27); g.lineTo(SW - 40, SH * 0.5);
    g.lineTo(SW - 108, SH * 0.5 + 27); g.lineTo(SW - 92, SH * 0.5); g.closePath(); g.fill();
    // v1.33: update(false) 는 invertY=false 라 «글자가 위아래로 뒤집혀» 나온다.
    //   문자가 있는 텍스처는 반드시 기본값(update()) 으로 올린다.
    dt.update();
    return dt;
  }

  // v1.33 깃발 문양 — 마름모 문장 + 물결 띠
  function bannerTexture(scene) {
    const BW = 256, BH = 320;
    const dt = new BABYLON.DynamicTexture('bannerTex', { width: BW, height: BH }, scene, true);
    const g = dt.getContext();
    const grd = g.createLinearGradient(0, 0, 0, BH);
    grd.addColorStop(0, '#57c9ac'); grd.addColorStop(1, '#2f9b86');
    g.fillStyle = grd; g.fillRect(0, 0, BW, BH);
    g.strokeStyle = 'rgba(255,240,190,0.85)'; g.lineWidth = 7;
    g.strokeRect(12, 12, BW - 24, BH - 24);
    g.fillStyle = 'rgba(255,244,205,0.92)';
    g.beginPath(); g.moveTo(BW / 2, 74); g.lineTo(BW - 62, BH / 2);
    g.lineTo(BW / 2, BH - 92); g.lineTo(62, BH / 2); g.closePath(); g.fill();
    g.fillStyle = '#2f9b86';
    g.beginPath(); g.arc(BW / 2, BH / 2 - 8, 27, 0, 6.284); g.fill();
    g.fillStyle = 'rgba(255,244,205,0.9)';
    g.font = 'bold 30px sans-serif'; g.textAlign = 'center';
    for (let i = 0; i < 3; i++) g.fillText('★', BW / 2 + (i - 1) * 52, BH - 46);
    dt.update();          // v1.33 문양 뒤집힘 방지
    return dt;
  }

  // v1.33 폭포 텍스처 — 세로 물줄기 + 위아래 페이드 (매 프레임 vOffset 스크롤)
  function waterfallTexture(scene) {
    const savedSeed = _seed;
    const FW = 128, FH = 256;
    const dt = new BABYLON.DynamicTexture('waterfallTex', { width: FW, height: FH }, scene, true);
    const g = dt.getContext();
    g.clearRect(0, 0, FW, FH);
    for (let i = 0; i < 46; i++) {
      const x = rnd() * FW, w = 1 + rnd() * 7;
      g.strokeStyle = 'rgba(' + (200 + rnd() * 55 | 0) + ',' + (232 + rnd() * 23 | 0) + ',255,' +
        (0.10 + rnd() * 0.55) + ')';
      g.lineWidth = w;
      g.beginPath(); g.moveTo(x, 0);
      for (let yy = 0; yy <= FH; yy += 24) g.lineTo(x + Math.sin(yy * 0.05 + i) * 2.2, yy);
      g.stroke();
    }
    const img = g.getImageData(0, 0, FW, FH);
    for (let yy = 0; yy < FH; yy++) {
      const fade = Math.min(yy / 26, (FH - 1 - yy) / 40, 1);
      for (let xx = 0; xx < FW; xx++) {
        const i = (yy * FW + xx) * 4;
        img.data[i + 3] = Math.min(img.data[i + 3], fade * 235);
      }
    }
    g.putImageData(img, 0, 0);
    dt.update(false);
    dt.hasAlpha = true;              // v1.33: 이게 없으면 투명부가 «검은 사각형» 으로 렌더된다
    dt.wrapU = dt.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE;
    dt.vScale = 1.6;
    _seed = savedSeed;
    return dt;
  }

  function makeSign(scene, x, z, rotY) {
    const y = heightAt(x, z);
    // v1.33 전면 재설계: 돌 기단 + 나뭇결 기둥 + 철 고리 + 글판 + 이중 경사 지붕
    const woodMat = pbr(scene, 'signWoodMat', '#ffffff', 0.86, 0);
    woodMat.albedoTexture = woodTexture(scene, 'signWoodTex', false);
    const darkWood = pbr(scene, 'signDarkWood', '#ffffff', 0.9, 0);
    darkWood.albedoTexture = woodTexture(scene, 'signDarkTex', true);
    const iron = pbr(scene, 'signIron', '#4d515a', 0.52, 0.42);
    const stone = pbr(scene, 'signStone', '#736f65', 0.95, 0);
    // v1.33: disableLighting + emissiveTexture 로 «텍스처 원색» 을 그대로 출력한다.
    //   PBR 에 albedo 만 얹으면 그늘에서 글자가 갈색으로 죽어 읽히지 않는다.
    const faceTex = signFaceTexture(scene);
    const faceMat = new BABYLON.StandardMaterial('signFaceMat', scene);
    faceMat.diffuseTexture = faceTex;
    faceMat.emissiveTexture = faceTex;
    faceMat.emissiveColor = new BABYLON.Color3(1, 1, 1);
    faceMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    faceMat.specularColor = new BABYLON.Color3(0, 0, 0);
    faceMat.disableLighting = true;
    faceMat.backFaceCulling = false;

    const node = new BABYLON.TransformNode('signNode', scene);
    node.position.set(x, y, z);
    node.rotation.y = rotY == null ? 0 : rotY;
    const put = (m, mat, px, py, pz) => {
      m.position.set(px, py, pz); m.parent = node;
      if (mat) m.material = mat;
      m.isPickable = false; m.receiveShadows = true; m.castShadow = true;
      return m;
    };

    // ① 돌 받침 — 육각 기단 + 얇은 상판
    put(BABYLON.MeshBuilder.CreateCylinder('signFoot',
      { height: 0.30, diameterTop: 0.72, diameterBottom: 0.94, tessellation: 6 }, scene), stone, 0, 0.15, 0);
    put(BABYLON.MeshBuilder.CreateCylinder('signFoot2',
      { height: 0.10, diameter: 0.66, tessellation: 6 }, scene), stone, 0, 0.34, 0);

    // ② 기둥 + 철 고리 — «글판 뒤» 로 물려 글자를 가리지 않게 한다.
    //   노드가 Math.PI 로 회전하므로 카메라 쪽은 로컬 -Z. 기둥은 +Z 로 보내야 진짜 뒤가 된다.
    const post = put(BABYLON.MeshBuilder.CreateCylinder('signPost',
      { height: 2.0, diameter: 0.20, tessellation: 12 }, scene), woodMat, 0, 1.36, 0.13);
    [0.58, 1.74].forEach((py, i) => {
      put(BABYLON.MeshBuilder.CreateTorus('signHoop' + i,
        { diameter: 0.25, thickness: 0.05, tessellation: 14 }, scene), iron, 0, py, 0.13);
    });

    // ③ 널판 + 앞·뒤 글판 (양쪽 모두 정방향으로 읽힌다)
    put(BABYLON.MeshBuilder.CreateBox('signPlank',
      { width: 1.92, height: 0.58, depth: 0.12 }, scene), darkWood, 0.10, 2.00, 0);
    // CreatePlane 기본 법선은 -Z. «각자 자기 쪽» 관찰자에게 정방향이 되도록 서로 반대로 회전.
    const faceF = BABYLON.MeshBuilder.CreatePlane('signFaceF', { width: 1.78, height: 0.50 }, scene);
    faceF.rotation.y = Math.PI;                    // +Z 쪽에 정면
    put(faceF, faceMat, 0.10, 2.00, 0.078);
    put(BABYLON.MeshBuilder.CreatePlane('signFaceB',
      { width: 1.78, height: 0.50 }, scene), faceMat, 0.10, 2.00, -0.078);   // -Z 쪽에 정면
    [[-0.76, 1.78], [0.96, 1.78], [-0.76, 2.22], [0.96, 2.22]].forEach((p, i) => {
      put(BABYLON.MeshBuilder.CreateSphere('signRivet' + i,
        { diameter: 0.075, segments: 8 }, scene), iron, p[0], p[1], 0.092);
    });

    // ④ 화살촉 + 목봉
    put(BABYLON.MeshBuilder.CreateBox('signArrowNeck',
      { width: 0.34, height: 0.20, depth: 0.10 }, scene), darkWood, 1.16, 2.00, 0);
    const head = BABYLON.MeshBuilder.CreateCylinder('signHead',
      { height: 0.11, diameterTop: 0, diameterBottom: 0.82, tessellation: 3 }, scene);
    head.rotation.x = Math.PI / 2; head.rotation.z = -Math.PI / 2;
    put(head, woodMat, 1.42, 2.00, 0);

    // ⑤ 이중 경사 지붕 + 용마루 + 꼭대기 장식
    [-1, 1].forEach((sd, i) => {
      const rf = BABYLON.MeshBuilder.CreateBox('signRoof' + i,
        { width: 1.22, height: 0.10, depth: 0.66 }, scene);
      rf.rotation.z = -sd * 0.36;
      put(rf, darkWood, 0.10 + sd * 0.53, 2.47, 0);
    });
    const ridge = BABYLON.MeshBuilder.CreateCylinder('signRidge',
      { height: 0.72, diameter: 0.11, tessellation: 8 }, scene);
    ridge.rotation.x = Math.PI / 2;
    put(ridge, iron, 0.10, 2.55, 0);
    put(BABYLON.MeshBuilder.CreateSphere('signFinial',
      { diameter: 0.20, segments: 10 }, scene), iron, 0.10, 2.68, 0);
    return post;
  }

  function makeCampfire(scene, x, z) {
    const y = heightAt(x, z);
    const phase = rnd() * 6;     // v1.32 와 동일하게 «정확히 1회» 소모 → 배치 시퀀스 보존
    // v1.33 «Bonfire_Lit.glb» 우선 — 돌·장작·불길이 하나의 모델로 정돈된다.
    if (PROTO.bonfire) {
      spawn('bonfire', x, z, 1.05, nz(x * 3 + z) * 6.28, { shadow: true });
      COLL.push({ x, z, r: 0.85 });
    } else {
      // GLB 로드 실패 시에만 쓰는 절차적 대체 (색·크기 편차는 인덱스 노이즈로)
      const stone = pbr(scene, 'cfStone' + x, '#77746d', 0.92, 0);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const d = BABYLON.MeshBuilder.CreateSphere('cfS' + i,
          { diameter: 0.30 + nz(i, 1) * 0.16, segments: 10 }, scene);
        d.position.set(x + Math.cos(a) * 0.92, y + 0.10, z + Math.sin(a) * 0.92);
        d.scaling.y = 0.58; d.rotation.y = nz(i, 2) * 6.28;
        d.material = stone; d.receiveShadows = true; d.castShadow = true; d.isPickable = false;
      }
      const wood = pbr(scene, 'cfWood' + x, '#5a3b28', 0.9, 0);
      for (let i = 0; i < 5; i++) {
        const l = BABYLON.MeshBuilder.CreateCylinder('cfL' + i,
          { height: 1.2, diameter: 0.14, tessellation: 8 }, scene);
        l.position.set(x, y + 0.22, z);
        l.rotation.z = Math.PI / 2.5; l.rotation.y = i * Math.PI / 5;
        l.material = wood; l.isPickable = false; l.receiveShadows = true;
      }
    }
    // 불빛 + 흔들림 (W.fires 애니메이션 계약은 그대로 유지)
    const flameM = emissiveMat(scene, 'cfFlameM' + x + z, '#ff9b3d', 1.0);
    flameM.alpha = 0.82;
    flameM.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    const flame = BABYLON.MeshBuilder.CreateCylinder('cfFlame' + x,
      { height: 0.72, diameterTop: 0, diameterBottom: 0.46, tessellation: 12 }, scene);
    flame.position.set(x, y + 0.46, z); flame.material = flameM; flame.isPickable = false;
    const ember = new BABYLON.PointLight('cfLight' + x + z, new BABYLON.Vector3(x, y + 0.85, z), scene);
    ember.diffuse = new BABYLON.Color3(1, 0.62, 0.28);
    ember.intensity = 0.9; ember.range = 9;
    // ★ 2026-11-21 (v1.73) L4 — mat 참조를 남겨 «화염 자체발광» 도 밤(nightK)에 부스트한다.
    //    라이트 추가 없이 emissive 만 — PointLight 예산(≤9) 불변.
    W.fires.push({ obj: flame, light: ember, base: y + 0.46, phase, mat: flameM });
    return flame;
  }

  // 연기 파티클
  function makeSmoke(scene, x, y, z) {
    try {
      if (!W.smokeTex) W.smokeTex = smokeTexture(scene);
      const ps = new BABYLON.ParticleSystem('smoke' + x + z, 42, scene);
      ps.particleTexture = W.smokeTex;
      ps.emitter = new BABYLON.Vector3(x, y, z);
      ps.minEmitBox = new BABYLON.Vector3(-0.12, 0, -0.12);
      ps.maxEmitBox = new BABYLON.Vector3(0.12, 0.1, 0.12);
      ps.color1 = new BABYLON.Color4(0.92, 0.92, 0.95, 0.5);
      ps.color2 = new BABYLON.Color4(0.82, 0.84, 0.88, 0.32);
      ps.colorDead = new BABYLON.Color4(0.7, 0.72, 0.78, 0);
      ps.minSize = 0.35; ps.maxSize = 1.5;
      ps.minLifeTime = 2.6; ps.maxLifeTime = 5.2;
      ps.emitRate = 9;
      ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
      ps.gravity = new BABYLON.Vector3(0.32, 1.15, 0.1);
      ps.direction1 = new BABYLON.Vector3(-0.25, 0.7, -0.25);
      ps.direction2 = new BABYLON.Vector3(0.35, 1.3, 0.35);
      ps.minAngularSpeed = -0.4; ps.maxAngularSpeed = 0.4;
      ps.minEmitPower = 0.2; ps.maxEmitPower = 0.55;
      ps.updateSpeed = 0.014;
      ps.start();
      W.fires.push({ ps });
    } catch (e) { /* 파티클 생략 */ }
  }

  function makeFloatingIsland(scene, x, y, z, s) {
    // v1.33 «비정형 암반 + 층진 잔디 + 다단 폭포 + 부유 쇄석» 전면 재설계
    const grassM = pbr(scene, 'fiGrass', '#6fa552', 0.94, 0);
    const grassEdge = pbr(scene, 'fiGrassEdge', '#4f8440', 0.96, 0);
    const soilM = pbr(scene, 'fiSoil', '#6b573f', 0.98, 0);
    const rockM = pbr(scene, 'fiRock', '#6d675c', 0.96, 0);
    const rockDark = pbr(scene, 'fiRockDark', '#4e4941', 0.98, 0);
    // 쇄석은 PBR 조명에서 «하얗게» 날아가므로 색을 고정한 StandardMaterial 을 쓴다
    const chipM = new BABYLON.StandardMaterial('fiChipMat', scene);
    // v1.33: 평면 법선 저폴리에서 «빛이 안 닿는 삼각면» 의 난반사가 0 이 되어
    //   검은 얼룩처럼 보였다. 약한 자체 발광으로 암부를 띄우되 명암은 유지한다.
    chipM.diffuseColor = BABYLON.Color3.FromHexString('#6b6557');
    chipM.emissiveColor = BABYLON.Color3.FromHexString('#3c3a31');
    chipM.specularColor = new BABYLON.Color3(0.04, 0.04, 0.04);

    // ① 암반 — 원통 정점을 각도·높이별로 흔들어 비정형 역원뿔로 만든다
    const rock = BABYLON.MeshBuilder.CreateCylinder('fiRockBody', {
      height: 3.9 * s, diameterTop: 5.4 * s, diameterBottom: 0.42 * s,
      tessellation: 16, subdivisions: 5
    }, scene);
    const pos = rock.getVerticesData(BABYLON.VertexBuffer.PositionKind);
    for (let i = 0; i < pos.length; i += 3) {
      const px = pos[i], py = pos[i + 1], pz = pos[i + 2];
      const a = Math.atan2(pz, px);
      const k = 1 + (nz(Math.round(a * 10) + 40, 1) - 0.5) * 0.26 + Math.sin(a * 3 + py) * 0.05;
      pos[i] = px * k; pos[i + 2] = pz * k;
      pos[i + 1] = py + (nz(Math.round(px * 3) + 90, 2) - 0.5) * 0.16 * s;
    }
    rock.updateVerticesData(BABYLON.VertexBuffer.PositionKind, pos);
    const nrm = [];
    BABYLON.VertexData.ComputeNormals(pos, rock.getIndices(), nrm);
    rock.setVerticesData(BABYLON.VertexBuffer.NormalKind, nrm);
    rock.position.set(x, y - 2.05 * s, z);
    rock.material = rockM; rock.isPickable = false;
    rock.receiveShadows = true; rock.castShadow = true;

    // ② 잔디 — 흙받이 / 옆면 풀 / 윗면 3겹 (경계가 딱 끊기지 않게)
    const layers = [
      { r: 2.86, h: 0.34, dy: 0.02, m: soilM },
      { r: 2.78, h: 0.30, dy: 0.20, m: grassEdge },
      { r: 2.60, h: 0.18, dy: 0.36, m: grassM }
    ];
    let top = null;
    layers.forEach((L, i) => {
      const d = BABYLON.MeshBuilder.CreateCylinder('fiTop' + i,
        { height: L.h * s, diameter: L.r * 2 * s, tessellation: 22 }, scene);
      d.position.set(x, y + L.dy * s, z);
      d.material = L.m; d.isPickable = false;
      d.receiveShadows = true; d.castShadow = true;
      if (i === 2) top = d;
    });
    // 잔디 가장자리 처진 풀숲
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * 6.283 + nz(i, 8) * 0.12;
      const r = (2.58 + nz(i, 9) * 0.22) * s;
      const tuft = BABYLON.MeshBuilder.CreateCylinder('fiTuft' + i,
        { height: (0.16 + nz(i, 10) * 0.18) * s, diameterTop: 0, diameterBottom: 0.20 * s, tessellation: 4 }, scene);
      tuft.position.set(x + Math.cos(a) * r, y + 0.30 * s, z + Math.sin(a) * r);
      tuft.rotation.z = Math.cos(a) * 0.5; tuft.rotation.x = -Math.sin(a) * 0.5;
      tuft.material = grassEdge; tuft.isPickable = false;
    }

    // ③ 폭포 — 공유 텍스처를 매 프레임 스크롤 (update() 의 W.fallTex)
    if (!W.fallTex) W.fallTex = waterfallTexture(scene);
    // v1.33: wShore 에서 검증한 «disableLighting + emissiveTexture + diffuse alpha» 조합.
    //   PBR 에 albedo alpha 만 맡기면 투명부가 검게 남아 하늘에 검은 사각형이 떴다.
    const wfMat = new BABYLON.StandardMaterial('fiFallMat', scene);
    wfMat.diffuseTexture = W.fallTex;
    wfMat.diffuseTexture.hasAlpha = true;
    wfMat.useAlphaFromDiffuseTexture = true;
    wfMat.emissiveTexture = W.fallTex;
    wfMat.emissiveColor = new BABYLON.Color3(0.86, 0.95, 1);
    wfMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    wfMat.specularColor = new BABYLON.Color3(0, 0, 0);
    wfMat.disableLighting = true;
    wfMat.backFaceCulling = false;
    wfMat.alpha = 0.72;                 // «흰 천» 처럼 보이지 않게 투명도를 낮춘다
    [[2.30, 0.10, 0.95], [-1.95, 1.15, 0.72], [0.45, -2.30, 0.62]].forEach((o, i) => {
      const f = BABYLON.MeshBuilder.CreatePlane('fiFall' + i,
        { width: o[2] * s, height: 3.35 * s, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
      f.position.set(x + o[0] * s, y - 1.42 * s, z + o[1] * s);
      f.rotation.y = Math.atan2(o[0], o[1]) + Math.PI / 2;
      f.material = wfMat; f.isPickable = false;
    });

    // ④ 섬 아래 부유 쇄석 — 위아래로 둥실거리며 천천히 회전
    for (let i = 0; i < 8; i++) {
      const a = nz(i, 11) * 6.283, r = (1.8 + nz(i, 12) * 2.4) * s;
      const chip = BABYLON.MeshBuilder.CreatePolyhedron('fiChip' + i,
        { type: 1, size: (0.14 + nz(i, 13) * 0.20) * s }, scene);
      const yy = y - (2.2 + nz(i, 14) * 2.6) * s;
      chip.position.set(x + Math.cos(a) * r, yy, z + Math.sin(a) * r);
      chip.rotation.set(nz(i, 15) * 3, nz(i, 16) * 3, nz(i, 17) * 3);
      chip.material = chipM;
      chip.isPickable = false;
      W.floaters.push({ m: chip, base: yy, ph: nz(i, 18) * 6.283, sp: 0.4 + nz(i, 19) * 0.7 });
    }

    // ⑤ 섬 위 풀숲·꽃 — «rnd 를 쓰지 않고» 인덱스 노이즈로 채운다 (배치 시퀀스 보존)
    if (PROTO.grass) {
      for (let i = 0; i < 22; i++) {
        const a = nz(i, 20) * 6.283, r = (0.5 + nz(i, 21) * 1.85) * s;
        spawn('grass', x + Math.cos(a) * r, z + Math.sin(a) * r,
          (0.5 + nz(i, 22) * 0.5) * s, nz(i, 23) * 6.283,
          { y: y + 0.45 * s, shadow: false, collide: false });
      }
    }
    if (PROTO.flowers) {
      for (let i = 0; i < 8; i++) {
        const a = nz(i, 24) * 6.283, r = (0.6 + nz(i, 25) * 1.7) * s;
        spawn('flowers', x + Math.cos(a) * r, z + Math.sin(a) * r,
          (0.45 + nz(i, 26) * 0.35) * s, nz(i, 27) * 6.283,
          { y: y + 0.45 * s, shadow: false, collide: false });
      }
    }

    // ⑥ 섬 위 나무 (기존 rr 2회 호출을 그대로 유지 → 배치 시퀀스 보존)
    if (PROTO.treeRound) spawn('treeRound', x - 1.1 * s, z - 0.2 * s, 0.55 * s, rr(0, 6), { y: y + 0.45 * s, shadow: false });
    if (PROTO.treePine) spawn('treePine', x + 1.2 * s, z + 0.7 * s, 0.45 * s, rr(0, 6), { y: y + 0.45 * s, shadow: false });
    return { top, bottom: rock };
  }

  function createClouds(scene) {
    try {
      const tex = cloudTexture(scene);
      const mgr = new BABYLON.SpriteManager('wClouds', tex, 30, 320, scene);
      mgr.isPickable = false;
      for (let i = 0; i < 24; i++) {
        const sp = mgr.createInstance('cl' + i);
        const r = rr(48, 118);
        const a = rr(0, Math.PI * 2);
        sp.position.set(Math.cos(a) * r, rr(26, 46), Math.sin(a) * r);
        const sc = rr(16, 34);
        sp.width = sc; sp.height = sc * 0.52;
        sp.color = new BABYLON.Color4(1, 1, 1, rr(0.62, 0.9));
        sp.invertU = rnd() < 0.5;
        W.clouds.push(sp);
      }
    } catch (e) { W.clouds = []; }
  }

  function createBirds(scene) {
    try {
      const tex = birdTexture(scene);
      const mgr = new BABYLON.SpriteManager('wBirds', tex, 14, 96, scene);
      mgr.isPickable = false;
      const list = [];
      for (let i = 0; i < 9; i++) {
        const sp = mgr.createInstance('bd' + i);
        sp.width = 1.5; sp.height = 1.5;
        sp.color = new BABYLON.Color4(0.16, 0.19, 0.24, 0.85);
        // ★ 2026-11-21 (v1.73) L4 떼(boid) — 앞 7 마리는 «무리», 뒤 2 마리는 영구 대기(알파 0).
        //   r/a/y/spd 는 «무리 중심» 주위 개체 궤도 오프셋으로 재활용. rr 소모 횟수(4회/마리)는
        //   원본과 동일 — 이후 배치 rnd 시퀀스가 한 칸도 흔들리지 않는다.
        list.push({ sp, r: rr(1.6, 4.4), a: rr(0, 6.28), y: rr(-2.4, 2.2), spd: rr(0.3, 0.55),
          ph: nz(i, 64) * 6.28, px: 0, py: 18, pz: 0, alpha0: i < 7 ? 0.85 : 0, flock: i < 7 });
      }
      W.birds = list;
    } catch (e) { W.birds = null; }
  }

  function createStars(scene) {
    const spots = [[2.0, -9.0], [-40.0, 26.2], [34.0, -24.0]];
    const orbM = emissiveMat(scene, 'starOrbM', '#ffcf4d', 1.15);
    const ringM = emissiveMat(scene, 'starRingM', '#ffe89a', 0.95);
    spots.forEach((p, i) => {
      const y = heightAt(p[0], p[1]) + 1.55;
      const node = new BABYLON.TransformNode('starNode' + i, scene);
      node.position.set(p[0], y, p[1]);
      const orb = BABYLON.MeshBuilder.CreateSphere('starOrb' + i, { diameter: 0.46, segments: 18 }, scene);
      orb.material = orbM; orb.parent = node; orb.isPickable = false;
      const ring = BABYLON.MeshBuilder.CreateTorus('starRing' + i, { diameter: 0.9, thickness: 0.035, tessellation: 26 }, scene);
      ring.material = ringM; ring.parent = node; ring.rotation.x = Math.PI / 2.2; ring.isPickable = false;
      const beam = BABYLON.MeshBuilder.CreateCylinder('starBeam' + i, { height: 3.6, diameterTop: 0.26, diameterBottom: 0.02, tessellation: 10 }, scene);
      beam.material = ringM; beam.parent = node; beam.position.y = 0.3; beam.alpha = 0.10; beam.isPickable = false;
      const light = new BABYLON.PointLight('starLight' + i, new BABYLON.Vector3(p[0], y, p[1]), scene);
      light.diffuse = new BABYLON.Color3(1, 0.78, 0.35);
      light.intensity = 0.55; light.range = 5.5;
      W.stars.push({ node, orb, ring, beam, light, collected: false });
    });
  }

  // ────────────────────────── 로봇 ──────────────────────────
  // ────────────── 마을 성장 (내가 한 만큼 자란다) ──────────────
  const VILLAGE_SLOTS = {
    tree_1:  { kind: 'treeRound',  x: 13.4, z: 1.2, s: 1.00 },
    tree_2:  { kind: 'treeBirch',  x: 12.6, z: -5.4, s: 0.95 },
    tree_3:  { kind: 'treeRound2', x: 8.4, z: -11.4, s: 1.00 },
    tree_4:  { kind: 'treePine',   x: -8.2, z: -12.2, s: 0.95 },
    tree_5:  { kind: 'treeBirch',  x: -12.8, z: -7.0, s: 1.00 },
    tree_6:  { kind: 'treeRound',  x: -13.6, z: 6.4, s: 0.95 },
    tree_7:  { kind: 'treePine2',  x: -9.0, z: 12.0, s: 1.00 },
    tree_8:  { kind: 'treeRound2', x: 9.6, z: 11.4, s: 0.95 },
    tree_9:  { kind: 'treeRound',  x: 15.2, z: 6.6, s: 1.00 },
    tree_10: { kind: 'treeBirch',  x: -15.0, z: -1.4, s: 0.95 },
    lantern_1: { kind: 'lantern', x: -5.2, z: 3.0, s: 1.0 },
    lantern_2: { kind: 'lantern', x: 5.0, z: -1.0, s: 1.0 },
    bench_1:   { kind: 'bench',   x: -4.4, z: -6.6, s: 1.0 },
    banner_1:  { kind: 'banner',  x: 4.2, z: 14.2, s: 1.0 },
    fountain:  { kind: 'fountain',x: 0.0, z: 6.6, s: 1.0 },
    // ★ 2026-11-20 (v1.71) 수정 구슬 — 별빛 저장고 둘레 «고정 슬롯» 5개(중심 + 오프셋 dx/dz).
    //   반경 2.3m 는 저장고 기단(충돌 r 1.02)을 벗어난다. VILLAGE_SLOTS 에 넣었으므로
    //   🌳 HUD 의 «마을 성장» 카운트가 수정 구슬도 자동으로 센다(의도된 동작).
    crystal_1: { kind: 'crystal', dx:  2.30, dz:  0.00 },
    crystal_2: { kind: 'crystal', dx:  0.71, dz:  2.19 },
    crystal_3: { kind: 'crystal', dx: -1.86, dz:  1.35 },
    crystal_4: { kind: 'crystal', dx: -1.86, dz: -1.35 },
    crystal_5: { kind: 'crystal', dx:  0.71, dz: -2.19 },
    // ★ 2026-11-21 (v1.74) «빛의 조각» 명예 장식 — teach_count 마일스톤(25=석벤치 · 50=화환).
    //   server(server.js crystalEventFor) 가 village_props 에 shard_bench · shard_wreath 키를
    //   쓰면 아래 «고정 슬롯» 에 세워진다. 겹침은 crystal 처럼 본문에서 freeSpotNear 로 밀어 둔다.
    //   shard_bench  — 시장 서쪽 공터(시장 포장지 5.2,-4.2 에서 3.3m · 등받이가 시장을 바라봄 rot -0.83).
    //                  우물(r 1.05)·랜턴2(5.0,-1.0)·벤치(3.4,-9.2) 와 모두 3m 이상 떨어져 있다.
    //   shard_wreath — 마을 입구 문기둥(입구 울타리 끄트멍 -3.8,15.5 에서 1.0m · 이정표 2.9,15.2 대칭축).
    //                  길 폴리라인(0,26→-0.5,14) 위에 올라오지 않게 동쪽으로 1m 비켜 세운다.
    shard_bench:  { kind: 'shardBench',  x: 7.6,   z: -6.4,  rot: -0.83 },
    shard_wreath: { kind: 'shardWreath', x: -3.0,  z: 16.1,  rot: 0.10 }
  };

  // ★ v1.44 «멈춘 마을» — 본부에서 고친 시설은 마을에 등으로 남는다.
  //   village_props 에 영구 저장되므로 «다음 날 다시 와도» 그대로 보인다.
  //   (기존 relic_* 은 데이터만 남고 렌더는 당일 questDone 만 봤던 틈을 여기서 피한다.)
  const CAMP_SPOTS = {
    well:      { x: 0.5,  z: -8.5 },
    mill:      { x: 26.5, z: -13.5 },
    bell:      { x: -20,  z: -2 },
    laundry:   { x: 8,    z: 12 },
    generator: { x: 9,    z: 9.5 }
  };
  W.campaignRelics = [];
  W.campaignFixed = 0;
  function applyCampaignVisuals(scene, keys){
    const S = scene || W.scene;
    if(!S) return;
    W.campaignRelics.forEach(n => { try{ n.dispose(); }catch(e){ } });
    W.campaignRelics = [];
    const best = {};
    (keys || []).forEach(k => {
      const m = /^campaign_([a-z]+)_lv(\d+)$/.exec(String(k));
      if(!m) return;
      const key = m[1], lv = Number(m[2]);
      if(!best[key] || best[key] < lv) best[key] = lv;
    });
    Object.keys(best).forEach(key => {
      const sp = CAMP_SPOTS[key];
      if(!sp) return;
      const lv = best[key];
      const y = heightAt(sp.x, sp.z);
      const color = lv >= 3 ? '#ffd873' : (lv >= 2 ? '#8fe0b8' : '#7fc7ee');
      // 레벨이 오를수록 등이 커진다 — «내가 고친 만큼 마을이 밝아진다»
      const core = BABYLON.MeshBuilder.CreateSphere('campaignOrb_' + key,
        { diameter: 0.34 + lv * 0.12, segments: 10 }, S);
      core.position.set(sp.x, y + 1.35, sp.z);
      core.material = questMat(S, 'campaignMat_' + key, color, 0.95);
      core.isPickable = false;
      W.campaignRelics.push(core);
      const halo = BABYLON.MeshBuilder.CreateSphere('campaignHalo_' + key,
        { diameter: 0.85 + lv * 0.22, segments: 8 }, S);
      halo.position.copyFrom(core.position);
      halo.material = questMat(S, 'campaignHaloMat_' + key, color, 0.16);
      halo.isPickable = false;
      W.campaignRelics.push(halo);
    });
    W.campaignFixed = Object.keys(best).length;
  }
  // 본부에서 정비를 마치면 «월드 전체를 다시 만들지 않고» 등만 갱신한다.
  async function refreshCampaignVisuals(){
    if(typeof api !== 'function' || !W.scene) return;
    try{
      const r = await api('/api/world/village');
      if(r && r.props) applyCampaignVisuals(W.scene, r.props);
    }catch(e){ /* 로그인 전이면 생략 */ }
  }

  function makeVillageProp(scene, slot, key) {
    const x = slot.x, z = slot.z, y = heightAt(x, z);
    const node = new BABYLON.TransformNode('vp' + key, scene);
    node.position.set(x, y, z);
    const put = (m, mat, px, py, pz) => {
      m.position.set(px, py, pz); m.parent = node;
      if (mat) m.material = mat;
      m.isPickable = false; m.receiveShadows = true; m.castShadow = true;
      return m;
    };
    // v1.33: GlowLayer + ACES 노출에서 밝은 돌이 «하얗게» 날아가 톤을 낮춘다
    const wood = pbr(scene, 'vpWood' + key, '#6d4830', 0.88, 0);
    const iron = pbr(scene, 'vpIron' + key, '#3d4149', 0.55, 0.4);
    const stone = pbr(scene, 'vpStone' + key, '#a79e8c', 0.93, 0);
    const stone2 = pbr(scene, 'vpStone2' + key, '#8d8473', 0.94, 0);

    if (slot.kind === 'lantern') {
      // v1.33 육각 돌받침 + 철 고리 + 4기둥 유리 등롱 + 이중 갓
      put(BABYLON.MeshBuilder.CreateCylinder('vpFoot' + key,
        { height: 0.26, diameterTop: 0.56, diameterBottom: 0.72, tessellation: 6 }, scene), stone, 0, 0.13, 0);
      put(BABYLON.MeshBuilder.CreateCylinder('vpFoot2' + key,
        { height: 0.09, diameter: 0.48, tessellation: 6 }, scene), stone2, 0, 0.30, 0);
      put(BABYLON.MeshBuilder.CreateCylinder('vpPost' + key,
        { height: 1.82, diameter: 0.15, tessellation: 12 }, scene), wood, 0, 1.25, 0);
      [0.52, 1.90].forEach((py, i) => put(BABYLON.MeshBuilder.CreateTorus('vpHoop' + i + key,
        { diameter: 0.20, thickness: 0.04, tessellation: 12 }, scene), iron, 0, py, 0));
      // 등롱 하판 + 유리 + 4 모서리 기둥
      put(BABYLON.MeshBuilder.CreateBox('vpTray' + key,
        { width: 0.56, height: 0.09, depth: 0.56 }, scene), iron, 0, 2.16, 0);
      // ★ 포인트라이트 대신 유리 emissive 강화로 발광 보상 (GlowLayer 가 번으로 보태 준다)
      const glass = emissiveMat(scene, 'vpGlass' + key, '#ffd08a', 1.35);
      const bulb = put(BABYLON.MeshBuilder.CreateBox('vpBulb' + key,
        { width: 0.42, height: 0.48, depth: 0.42 }, scene), glass, 0, 2.45, 0);
      bulb.castShadow = false;
      [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach((p, i) => put(
        BABYLON.MeshBuilder.CreateCylinder('vpCorner' + i + key,
          { height: 0.52, diameter: 0.05, tessellation: 6 }, scene), iron, p[0] * 0.24, 2.45, p[1] * 0.24));
      put(BABYLON.MeshBuilder.CreateBox('vpLid' + key,
        { width: 0.62, height: 0.08, depth: 0.62 }, scene), iron, 0, 2.74, 0);
      put(BABYLON.MeshBuilder.CreateCylinder('vpCap' + key,
        { height: 0.24, diameterTop: 0.06, diameterBottom: 0.66, tessellation: 4 }, scene), stone2, 0, 2.88, 0)
        .rotation.y = Math.PI / 4;
      put(BABYLON.MeshBuilder.CreateSphere('vpKnob' + key,
        { diameter: 0.16, segments: 10 }, scene), iron, 0, 3.04, 0);
      // ★ 장식용 포인트라이트 제거 — 등롱 유리(emissive 1.35)가 자체 발광으로 충분
      COLL.push({ x, z, r: 0.42 });

    } else if (slot.kind === 'banner') {
      // v1.33 돌받침 + 가로봉 + 문양 깃발 + 끈·술 + 꼭대기 볼
      put(BABYLON.MeshBuilder.CreateCylinder('vpBFoot' + key,
        { height: 0.22, diameterTop: 0.42, diameterBottom: 0.58, tessellation: 6 }, scene), stone, 0, 0.11, 0);
      put(BABYLON.MeshBuilder.CreateCylinder('vpBp' + key,
        { height: 3.05, diameter: 0.11, tessellation: 10 }, scene), iron, 0, 1.70, 0);
      const bar = put(BABYLON.MeshBuilder.CreateCylinder('vpBar' + key,
        { height: 1.28, diameter: 0.075, tessellation: 8 }, scene), wood, 0.50, 3.10, 0);
      bar.rotation.z = Math.PI / 2;
      put(BABYLON.MeshBuilder.CreateSphere('vpBKnobL' + key,
        { diameter: 0.14, segments: 8 }, scene), iron, -0.14, 3.10, 0);
      put(BABYLON.MeshBuilder.CreateSphere('vpBKnobR' + key,
        { diameter: 0.14, segments: 8 }, scene), iron, 1.14, 3.10, 0);
      const bm = pbr(scene, 'vpClothM' + key, '#ffffff', 0.9, 0);
      bm.albedoTexture = bannerTexture(scene);
      bm.emissiveTexture = bm.albedoTexture;
      bm.emissiveColor = new BABYLON.Color3(0.12, 0.12, 0.10);
      bm.backFaceCulling = false;
      const cloth = put(BABYLON.MeshBuilder.CreatePlane('vpCloth' + key,
        { width: 0.94, height: 1.20, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene), bm, 0.50, 2.42, 0.01);
      cloth.castShadow = false;
      for (let i = 0; i < 5; i++) put(BABYLON.MeshBuilder.CreateCylinder('vpTassel' + i + key,
        { height: 0.18, diameterTop: 0.05, diameterBottom: 0.015, tessellation: 6 }, scene),
        wood, 0.10 + i * 0.20, 1.76, 0.01);
      put(BABYLON.MeshBuilder.CreateSphere('vpBTop' + key,
        { diameter: 0.18, segments: 10 }, scene), iron, 0, 3.28, 0);
      COLL.push({ x, z, r: 0.36 });

    } else if (slot.kind === 'fountain') {
      // v1.33 3단 석조 + 물결 원판 + 중앙 분수주 + 6갈래 물줄기 + 물보라
      put(BABYLON.MeshBuilder.CreateCylinder('vpFBase' + key,
        { height: 0.22, diameter: 3.1, tessellation: 24 }, scene), stone2, 0, 0.11, 0);
      put(BABYLON.MeshBuilder.CreateCylinder('vpFStep' + key,
        { height: 0.18, diameter: 2.92, tessellation: 24 }, scene), stone, 0, 0.30, 0);
      put(BABYLON.MeshBuilder.CreateTorus('vpFr' + key,
        { diameter: 2.72, thickness: 0.34, tessellation: 28 }, scene), stone, 0, 0.42, 0);
      put(BABYLON.MeshBuilder.CreateTorus('vpFrIn' + key,
        { diameter: 2.24, thickness: 0.13, tessellation: 28 }, scene), stone2, 0, 0.48, 0);
      const wm = emissiveMat(scene, 'vpFwM' + key, '#6fd2ec', 0.75);
      wm.alpha = 0.86;
      wm.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
      const pool = BABYLON.MeshBuilder.CreateDisc('vpFw' + key, { radius: 1.20, tessellation: 36 }, scene);
      pool.rotation.x = Math.PI / 2;
      put(pool, wm, 0, 0.50, 0); pool.castShadow = false;
      put(BABYLON.MeshBuilder.CreateCylinder('vpFPillar' + key,
        { height: 0.92, diameterTop: 0.30, diameterBottom: 0.44, tessellation: 10 }, scene), stone, 0, 0.95, 0);
      put(BABYLON.MeshBuilder.CreateCylinder('vpFBowl' + key,
        { height: 0.16, diameterTop: 0.94, diameterBottom: 0.46, tessellation: 16 }, scene), stone2, 0, 1.48, 0);
      put(BABYLON.MeshBuilder.CreateSphere('vpFOrb' + key,
        { diameter: 0.30, segments: 12 }, scene), wm, 0, 1.72, 0).castShadow = false;
      // 대칭 6갈래 물줄기
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * 6.283;
        const j = BABYLON.MeshBuilder.CreateCylinder('vpJet' + i + key,
          { height: 0.92, diameterTop: 0.035, diameterBottom: 0.11, tessellation: 8 }, scene);
        j.rotation.z = Math.cos(a) * 0.52; j.rotation.x = -Math.sin(a) * 0.52;
        put(j, wm, Math.cos(a) * 0.42, 1.12, Math.sin(a) * 0.42);
        j.castShadow = false;
      }
      // 난간 위 4개 돌장식
      [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach((p, i) => put(
        BABYLON.MeshBuilder.CreateSphere('vpFDeco' + i + key,
          { diameter: 0.24, segments: 10 }, scene), stone, p[0] * 1.36, 0.58, p[1] * 1.36));
      COLL.push({ x, z, r: 1.62 });
    }
  }
  async function loadVillage(scene) {
    if (typeof api !== 'function') return;
    try {
      const r = await api('/api/world/village');
      if (W.scene !== scene) return;   // ★ 대기 사이 마을이 닫혔으면 폐기된 씬에 그리기를 중단
      const keys = (r && r.props) || [];
      W.villageKeys = keys;
      // ★ 다른 소품 spawn 이 하나라도 실패해도 «정비 등» 은 반드시 켜지게 맨 먼저 그린다.
      applyCampaignVisuals(scene, keys);
      const crystalsBefore = W.crystals.length;   // ★ v1.73 L6 — «수정화» 순간 감지용
      try {
        keys.forEach((k) => {
          const slot = VILLAGE_SLOTS[k];
          if (!slot) return;
          // ★ 2026-11-20 (v1.71) 수정 구슬 — GLB 가 없는 절차 소품은 별도 경로로 만든다.
          //   tree/lantern 과 같은 «props 구동» 경로(같은 keys 루프)를 타고, 메시만 수정이다.
          if (slot.kind === 'crystal') { makeCrystalProp(scene, slot, k); return; }
          // ★ 2026-11-21 (v1.74) 빛의 조각 장식 — crystal 과 같은 «절차 소품 별도 경로»(kind 분기만 추가).
          if (slot.kind === 'shardBench') { makeShardBench(scene, slot, k); return; }
          if (slot.kind === 'shardWreath') { makeShardWreath(scene, slot, k); return; }
          if (slot.kind !== 'lantern' && slot.kind !== 'banner' && slot.kind !== 'fountain') {
            if (blockReason(slot.x, slot.z)) return;   // 이미 다른 소품이 있으면 건너뛴다
            spawn(slot.kind, slot.x, slot.z, slot.s, rnd() * 6.28, { shadow: true });
          } else {
            makeVillageProp(scene, slot, k);
          }
        });
      } catch (e) { /* 소품 하나 실패는 마을 전체를 멈추지 않게 */ }
      // ★ 2026-11-21 (v1.73) L5/L6 — 새 구슬이 생긴 순간 = «수정화». 점등 펄스는 updateCrystals 가
      //    처리하고, 화면 심도 과장(DOF 2초, high 전용)은 여기서 한 번 연다.
      if (W.crystals.length > crystalsBefore) { try { pulseDof(); } catch (e) { } }
      // ★ 2026-11-21 (v1.74) «빛의 조각» 팁 숫자 — teach_count(/api/user v1.74 계약) 를 마을 열릴 때
      //    1회만 내려받는다. 실패해도 shardCount() 이 마일스톤 하한(벤치 25 · 화환 50)으로 보여 준다.
      loadTeachCount();
      const el = $('#world-village');
      if (el) {
        // ★ relic_*·campaign_*_lv* 등은 마을 나무·장식 슬롯이 아니므로 «🌳» HUD 에서 뺀다
        el.textContent = `🌳 ${keys.filter((k) => !!VILLAGE_SLOTS[k]).length}`;
      }
    } catch (e) { /* 로그인 전이면 생략 */ }
  }

  // ────────────── ★ 2026-11-20 (v1.71) 수정 구슬 ──────────────
  //   개념을 3번 다져 «굳힌» 흔적 — server 가 village_props 에 crystal_1..crystal_5 키를
  //   쓰면 별빛 저장고 둘레 고정 슬롯에 수정이 spawn 된다(장기 수집 비주얼).
  //   발광은 emissive 재질 + 기존 GlowLayer — 포인트라이트는 추가하지 않는다(v1.69 예산).
  function makeCrystalProp(scene, slot, key) {
    // 저장고 «실제» 위치(v1.39 freeSpotNear 로 밀릴 수 있음)를 기준으로 오프셋을 더한다
    const vs = W.vaultSpot || VAULT_SPOT || VAULT_BASE;
    let x = (vs.x || 0) + slot.dx, z = (vs.z || 0) + slot.dz;
    // 슬롯에 다른 소품이 겹쳐 있으면 바로 옆 빈자리로 밀어 둔다(spawn 건너뛰기 방지)
    if (blockReason(x, z)) { const f = freeSpotNear(x, z, 2); x = f.x; z = f.z; }
    const y = heightAt(x, z);
    const idx = Number(key.slice(-1)) || 1;
    // ★ 2026-11-21 (v1.73) L5 진열관 — 석재 받침 + 발광 룬 고리. 재질은 지혜의 샘 것을 «재사용»
    //    (새 재질 0개 — 예산 규율), 발광은 emissive+기존 GlowLayer — 라이트 추가 없음.
    try {
      const ped = BABYLON.MeshBuilder.CreateCylinder('crystalPed_' + key,
        { height: 0.34, diameterTop: 0.52, diameterBottom: 0.74, tessellation: 8 }, scene);
      ped.position.set(x, y + 0.17, z);
      ped.material = scene.getMaterialByName('stStone') || null;
      ped.isPickable = false; ped.receiveShadows = true; ped.castShadow = true;
      const rune = BABYLON.MeshBuilder.CreateTorus('crystalRune_' + key,
        { diameter: 0.58, thickness: 0.032, tessellation: 22 }, scene);
      rune.position.set(x, y + 0.36, z);
      rune.rotation.x = Math.PI / 2;
      rune.material = scene.getMaterialByName('stRingM0') ||
        emissiveMat(scene, 'crystalRuneM_' + key, '#8ccbff', 0.9);
      rune.isPickable = false;
      COLL.push({ x, z, r: 0.5 });   // 받침에 부딪히게 — «전시된 유물» 로 읽힌다
    } catch (e) { /* 받침 실패는 구슬만으로 계속 */ }
    // 얼음빛 수정 — (0.55, 0.80, 1.0) ≈ #8ccbff, 반투명 emissive
    const m = emissiveMat(scene, 'crystalMat_' + key, '#8ccbff', 1.05);
    m.alpha = 0.85;
    const cry = BABYLON.MeshBuilder.CreatePolyhedron('crystal_' + key, { type: 1, size: 0.34 }, scene);
    // ★ L5 — 부유 높이 «층별 낙차» (nz 결정론 — rnd 시퀀스 무소모)
    const baseY = y + 0.62 + nz(idx, 45) * 0.3;
    cry.position.set(x, baseY, z);
    cry.material = m;
    cry.isPickable = false;
    // 부유·자전 애니메이션은 updateCrystals 가 프레임마다 처리한다
    // ★ L5/L6 — pulseT: spawn 직후 «점등 펄스»(1.05→1.95→1.05, 개체별 0.45s 지연 스태거)
    W.crystals.push({ m: cry, baseY, phase: nz(idx, 31) * 6.28, pulseT: -(idx - 1) * 0.45 });
  }

  function updateCrystals(dt) {
    if (!W.crystals || !W.crystals.length) return;
    W.crystals.forEach((c) => {
      c.m.position.y = c.baseY + Math.sin(W.t * 1.5 + c.phase) * 0.09;   // 높이를 살짝 부유
      c.m.rotation.y += dt * 0.4;                                        // 천천히 자전
      // ★ 2026-11-21 (v1.73) L5 — «새 구슬이 생길 때» 한 번 점등 펄스(emissive 강도 왕복).
      //    서버가 village_props 로 구슬을 다시 내려 줄 때마다 «굳어진 기억» 이 한 번 빛난다.
      if (c.pulseT != null && c.pulseT < 1.6) {
        c.pulseT += dt;
        const k = clamp(c.pulseT / 1.6, 0, 1);
        const mm = c.m.material;
        if (mm && mm.emissiveIntensity != null) mm.emissiveIntensity = 1.05 + Math.sin(k * Math.PI) * 0.9;
      }
    });
  }

  // ────────────── ★ 2026-11-21 (v1.74) «빛의 조각» 명예 장식 ──────────────
  //  «가르침의 흔적» — teach_count 마일스톤(25=석벤치 · 50=화환) 이 되면 server 가
  //  village_props 에 shard_bench · shard_wreath 키를 기록하고, loadVillage 가 고정 슬롯에 세운다.
  //  · 발광은 전부 emissive 재질 + 기존 GlowLayer — 포인트라이트 추가 0(v1.69 예산 ≤9 불변).
  //  · 배치 난수는 nz(i,k) 인덱스 노이즈만 — 전역 rnd() 시퀀스를 한 칸도 소모하지 않는다.
  //  · 정적 소품(매 프레임 갱신·품질 단계 분기 없음)이라 W.fx 슬롯이 필요 없다 — crystal 선례와 같다.

  //  석재 재질 — 지혜의 샘 stStone/stStone2 «이름으로 재사용»(createStations 이 먼저 지나가 있다).
  function shardStone(scene, name, hex, rough) {
    return scene.getMaterialByName(name) || pbr(scene, name, hex, rough, 0);
  }

  //  shard_bench — 석재 작은 벤치(좌면 + 4 다리 + 등받이) + 등받이 «빛의 조각» 3쪽 박힘.
  //  수정 구슬(crystal) 과 같은 얼음빛 #8ccbff — «굳은 기억» 이 시장 자리에도 보이게.
  function makeShardBench(scene, slot, key) {
    try {
      let x = slot.x, z = slot.z;
      if (blockReason(x, z)) { const f = freeSpotNear(x, z, 2.5); x = f.x; z = f.z; }
      const y = heightAt(x, z);
      const node = new BABYLON.TransformNode('shardBench_' + key, scene);
      node.position.set(x, y, z);
      node.rotation.y = slot.rot || 0;
      const stone = shardStone(scene, 'stStone', '#cfc6b4', 0.92);
      const stone2 = shardStone(scene, 'stStone2', '#b7ad99', 0.9);
      const put = (m, px, py, pz) => {
        m.position.set(px, py, pz); m.parent = node;
        m.isPickable = false; m.receiveShadows = true; m.castShadow = true;
        return m;
      };
      // ① 돌 좌면 + 4 다리
      put(BABYLON.MeshBuilder.CreateBox('sbSeat_' + key,
        { width: 1.44, height: 0.10, depth: 0.40 }, scene), 0, 0.46, 0).material = stone;
      [[-0.60, -0.13], [0.60, -0.13], [-0.60, 0.13], [0.60, 0.13]].forEach((p, i) => {
        put(BABYLON.MeshBuilder.CreateBox('sbLeg' + i + '_' + key,
          { width: 0.11, height: 0.42, depth: 0.11 }, scene), p[0], 0.21, p[1]).material = stone2;
      });
      // ② 등받이 — 좌면 뒤쪽 돌기둥 2개 + 판
      put(BABYLON.MeshBuilder.CreateBox('sbPost0_' + key,
        { width: 0.10, height: 0.50, depth: 0.09 }, scene), -0.60, 0.64, -0.15).material = stone;
      put(BABYLON.MeshBuilder.CreateBox('sbPost1_' + key,
        { width: 0.10, height: 0.50, depth: 0.09 }, scene), 0.60, 0.64, -0.15).material = stone;
      put(BABYLON.MeshBuilder.CreateBox('sbBack_' + key,
        { width: 1.44, height: 0.26, depth: 0.08 }, scene), 0, 0.79, -0.15).material = stone2;
      // ③ «빛의 조각» 3쪽 — 등받이 판 뒤쪽으로 절반 묻혀 «박힌 장식».
      let gemM = scene.getMaterialByName('shardGemM');
      if (!gemM) { gemM = emissiveMat(scene, 'shardGemM', '#8ccbff', 1.05); gemM.alpha = 0.9; }
      [-0.36, 0, 0.36].forEach((gx, i) => {
        const gem = BABYLON.MeshBuilder.CreatePolyhedron('sbGem' + i + '_' + key,
          { type: 1, size: 0.085 }, scene);
        put(gem, gx, 0.79, -0.115).material = gemM;
        gem.castShadow = false;
      });
      COLL.push({ x, z, r: 0.62 });   // 벤치 충돌 관례(0.55) + 등받이 분
      W.shards.push({ key, x, z });
    } catch (e) { /* 장식 하나 실패가 마을을 멈추지 않게 */ }
  }

  //  꽃잎 마카롱 팔레트 — 길가 꾸미기(dressPaths 의 Flowers GLB) 톤과 맞춘 4색
  const SHARD_MACARON = ['#f6a8c0', '#ffd98e', '#a8e0c0', '#bcbcf0'];

  //  shard_wreath — 마을 입구 문기둥 + 걸어 놓은 화환(torus 링 + 링 둘레 꽃 7송이) + 꼭대기 네갈래 별.
  function makeShardWreath(scene, slot, key) {
    try {
      let x = slot.x, z = slot.z;
      if (blockReason(x, z)) { const f = freeSpotNear(x, z, 2.5); x = f.x; z = f.z; }
      const y = heightAt(x, z);
      const node = new BABYLON.TransformNode('shardWreath_' + key, scene);
      node.position.set(x, y, z);
      node.rotation.y = slot.rot || 0;
      const stone = shardStone(scene, 'stStone', '#cfc6b4', 0.92);
      const wood = scene.getMaterialByName('shardWoodM') || pbr(scene, 'shardWoodM', '#6d4830', 0.88, 0);
      const iron = scene.getMaterialByName('shardIronM') || pbr(scene, 'shardIronM', '#3d4149', 0.55, 0.4);
      const put = (m, px, py, pz) => {
        m.position.set(px, py, pz); m.parent = node;
        m.isPickable = false; m.receiveShadows = true; m.castShadow = true;
        return m;
      };
      // ① 돌 받침 + 목주(문기둥) + 꼭대기 쇠구슬
      put(BABYLON.MeshBuilder.CreateCylinder('swFoot_' + key,
        { height: 0.22, diameterTop: 0.46, diameterBottom: 0.62, tessellation: 6 }, scene), 0, 0.11, 0).material = stone;
      put(BABYLON.MeshBuilder.CreateCylinder('swPole_' + key,
        { height: 2.70, diameter: 0.13, tessellation: 10 }, scene), 0, 1.45, 0).material = wood;
      put(BABYLON.MeshBuilder.CreateSphere('swKnob_' + key,
        { diameter: 0.15, segments: 8 }, scene), 0, 2.86, 0).material = iron;
      // ② 화환 — 세워 건 링이 기둥 «앞» 에 걸린다(정면 ±Z 에서 원형). «앞» 은 마을 입구 길 쪽.
      const ring = put(BABYLON.MeshBuilder.CreateTorus('swRing_' + key,
        { diameter: 0.66, thickness: 0.055, tessellation: 26 }, scene), 0, 1.92, 0.24);
      ring.material = wood;
      ring.rotation.x = Math.PI / 2;
      // ③ 꽃 7송이 — 링 둘레에 마카롱색 작은 공꽃(nz 결정론)
      const macM = SHARD_MACARON.map((hex, i) =>
        scene.getMaterialByName('shardMacM' + i) || pbr(scene, 'shardMacM' + i, hex, 0.6, 0));
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * 6.283 + nz(i, 91) * 0.22;
        const fl = BABYLON.MeshBuilder.CreateSphere('swFl' + i + '_' + key,
          { diameter: 0.115 + nz(i, 92) * 0.03, segments: 8 }, scene);
        put(fl, Math.cos(a) * 0.33, 1.92 + Math.sin(a) * 0.33, 0.24)
          .material = macM[i % macM.length];
        fl.castShadow = false;
      }
      // ④ 꼭대기 네갈래 별 — 마름모 판 2장 십자 교차 + 중심 구슬(emissive + GlowLayer)
      const starM = scene.getMaterialByName('shardStarM') || emissiveMat(scene, 'shardStarM', '#ffe89a', 1.15);
      const s1 = put(BABYLON.MeshBuilder.CreateDisc('swStar0_' + key,
        { radius: 0.17, tessellation: 4, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene), 0, 3.06, 0);
      s1.material = starM; s1.castShadow = false;
      const s2 = put(BABYLON.MeshBuilder.CreateDisc('swStar1_' + key,
        { radius: 0.17, tessellation: 4, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene), 0, 3.06, 0);
      s2.material = starM; s2.rotation.y = Math.PI / 2; s2.castShadow = false;
      const orb = put(BABYLON.MeshBuilder.CreateSphere('swStarOrb_' + key,
        { diameter: 0.10, segments: 8 }, scene), 0, 3.06, 0);
      orb.material = starM; orb.castShadow = false;
      COLL.push({ x, z, r: 0.30 });   // 가는 기둥 — 입구 통행을 가로막지 않게 작게
      W.shards.push({ key, x, z });
    } catch (e) { /* 장식 하나 실패가 마을을 멈추지 않게 */ }
  }

  //  «빛의 조각» 현재 값 — /api/user 의 teach_count(v1.74 서버 계약) 를 마을 열릴 때 1회만 내려받는다.
  function loadTeachCount() {
    if (typeof api !== 'function') return;
    api('/api/user', undefined, 8000).then((r) => {
      if (r && r.teach_count != null) W.teachCount = Number(r.teach_count) || 0;
    }).catch(() => { /* 조용히 — 마일스톤 하한 표기로 폴백 */ });
  }
  //  실패 폴백 — 장식 키가 있으면 최소한 «그 마일스톤» 은 맞게 보여 준다.
  function shardCount() {
    if (W.teachCount != null) return W.teachCount;
    const ks = W.villageKeys || [];
    if (ks.indexOf('shard_wreath') >= 0) return 50;
    if (ks.indexOf('shard_bench') >= 0) return 25;
    return 0;
  }

  //  근접 팁 — 친구 팁(#world-peer-tip) «같은 요소» 를 재사용한다(showRumiTip 3자 공유 패턴).
  //  우선순위: 친구 > 루미 > 빛의 조각. updateRumi «뒤» 에 호출되므로 한 프레임 안에 정리된다.
  function showShardTip(on) {
    const tip = $('#world-peer-tip');
    if (!tip) return;
    if (on) {
      if (!W.shardTipShown) {
        tip.dataset.uid = '';   // 친구 팁이 이름을 다시 쓰게 «uid 캐시» 를 비운다
        const ico = tip.querySelector('.wpt-ico');
        const b = tip.querySelector('b');
        const sp = tip.querySelector('.wpt-txt span');
        if (ico) ico.textContent = '💠';
        if (b) b.textContent = '빛의 조각';
        if (sp) sp.textContent = shardCount() + '개 — 가르침의 흔적';
      }
      tip.classList.remove('hidden');
      W.shardTipShown = true;
    } else if (W.shardTipShown) {
      W.shardTipShown = false;
      // 다른 팁(친구·루미)이 같은 프레임에 요소를 받았으면 «소유자가 고친다» — 되돌리지 않는다
      if (!W.nearPeer && !W.rumiNear) {
        const ico = tip.querySelector('.wpt-ico');
        const b = tip.querySelector('b');
        const sp = tip.querySelector('.wpt-txt span');
        if (ico) ico.textContent = '👋';
        if (b) b.textContent = '친구';
        if (sp) sp.textContent = 'E 키로 인사해요';
        tip.classList.add('hidden');
      }
    }
  }

  function updateShardTip() {
    if (!W.shards.length || !W.root) { showShardTip(false); return; }
    if (W.quizOpen || W.chatOpen || W.secretOpen || W.vaultOpen || W.warpOpen) { showShardTip(false); return; }
    let best = null, bd = 3.4;
    for (let i = 0; i < W.shards.length; i++) {
      const s = W.shards[i];
      const d = Math.hypot(W.root.position.x - s.x, W.root.position.z - s.z);
      if (d < bd) { bd = d; best = s; }
    }
    showShardTip(!!best);
  }

  // ────────────── 지혜의 샘 (학습 스테이션) ──────────────
  const STATION_SPOTS = [
    { x: -40.0, z: 13.4 },   // 돌원 남쪽
    { x: 27.6, z: -28.6 },   // 전망대 남서
    { x: -34.0, z: -33.2 }   // 버드나무숲 북쪽
  ];
  function createStations(scene) {
    const stone = pbr(scene, 'stStone', '#cfc6b4', 0.92, 0);
    const stone2 = pbr(scene, 'stStone2', '#b7ad99', 0.9, 0);
    STATION_SPOTS.forEach((sp, i) => {
      const y = heightAt(sp.x, sp.z);
      const node = new BABYLON.TransformNode('station' + i, scene);
      node.position.set(sp.x, y, sp.z);

      const base = BABYLON.MeshBuilder.CreateCylinder('stBase' + i,
        { height: 0.5, diameterTop: 1.2, diameterBottom: 1.5, tessellation: 8 }, scene);
      base.position.y = 0.25; base.parent = node;
      base.material = stone; base.receiveShadows = true; base.castShadow = true; base.isPickable = false;

      const post = BABYLON.MeshBuilder.CreateCylinder('stPost' + i,
        { height: 0.62, diameterTop: 0.34, diameterBottom: 0.52, tessellation: 8 }, scene);
      post.position.y = 0.78; post.parent = node;
      post.material = stone2; post.receiveShadows = true; post.castShadow = true; post.isPickable = false;

      const cryMat = emissiveMat(scene, 'stCryM' + i, '#6fd8ff', 1.15);
      const cry = BABYLON.MeshBuilder.CreatePolyhedron('stCry' + i, { type: 1, size: 0.34 }, scene);
      cry.position.y = 1.55; cry.parent = node; cry.material = cryMat; cry.isPickable = false;

      const ringMat = emissiveMat(scene, 'stRingM' + i, '#bff0ff', 0.85);
      const ring = BABYLON.MeshBuilder.CreateTorus('stRing' + i,
        { diameter: 1.15, thickness: 0.04, tessellation: 24 }, scene);
      ring.position.y = 1.55; ring.parent = node; ring.material = ringMat; ring.isPickable = false;
      ring.rotation.x = Math.PI / 2.6;

      const light = new BABYLON.PointLight('stLight' + i, new BABYLON.Vector3(sp.x, y + 1.7, sp.z), scene);
      light.diffuse = new BABYLON.Color3(0.45, 0.85, 1);
      light.intensity = 0.75; light.range = 6;

      COLL.push({ x: sp.x, z: sp.z, r: 0.9 });
      W.stations.push({ x: sp.x, z: sp.z, node, cry, ring, light, ringMat, cryMat, solved: false });
    });
  }
  function setStationSolved(i) {
    const st = W.stations[i];
    if (!st) return;
    st.solved = true;
    try {
      st.cryMat.emissiveColor = new BABYLON.Color3(1, 0.78, 0.3);
      st.ringMat.emissiveColor = new BABYLON.Color3(1, 0.86, 0.45);
      st.light.diffuse = new BABYLON.Color3(1, 0.78, 0.35);
      st.light.intensity = 1.0;
    } catch (e) { }
  }

  async function loadWorldLessons() {
    if (typeof api !== 'function') return;
    try {
      const r = await api('/api/world/lesson');
      if (!r || !r.stations) return;
      W.lessons = r.stations;
      W.lessonDone = r.done || 0;
      W.lessons.forEach((st) => { if (st.solved) setStationSolved(st.station); });
      const el = $('#world-lessons');
      if (el) el.textContent = `📖 ${W.lessonDone} / ${r.total || 3}`;
    } catch (e) { /* 로그인 전이면 조용히 생략 */ }
  }

  // ── v1.37 «의뢰» 레이어 — 세계를 미니게임의 «이유» 로 만든다 ──
  //   좌표는 buildVillage 의 기존 프롭 앵커를 «그대로» 쓴다(레이아웃을 건드리지 않는다).
  const QUEST_SPOTS = [
    { key:'well', x:0.5,   z:-8.5,  label:'우물' },
    { key:'mill', x:26.5,  z:-13.5, label:'풍차' },
    { key:'bell', x:-20.0, z:-2.0,  label:'종탑' },
    // ★ v1.84 «기억의 등대» — 미니게임이 아니라 «루미에게 설명하기» 로 푸는 학습 의뢰.
    //   좌표는 호수 중심(27,12)에서 마을 반대편(24°) 물가. heightAt 으로 미리 계산한 값이다:
    //   등대 탑은 수심 0.4m 얕은 물(물가 8.0m 안쪽 7.4m), 상호작용 자리는 마른 땅(10.0m, 높이 0.6).
    //   난수(rnd)를 쓰지 않으므로 기존 나무·바위 배치 시퀀스는 그대로다.
    { key:'light', x:36.14, z:16.07, label:'등대' }
  ];
  const LIGHTHOUSE = { x: 33.76, z: 15.01 };
  const QUEST_PROMPT = {
    well:'우물이 버그로 막혔어 · 두더지 300점',
    mill:'풍차가 멈췄어 · 슈터 800점 + 목숨 1개',
    bell:'종탑이 잠들었어 · 퍼즐 3문제 한 번에',
    light:'등대 불이 흐려졌어 · 루미에게 개념 하나 설명하기'
  };

  function questMat(scene, name, hex, alpha){
    const m = new BABYLON.StandardMaterial(name, scene);
    m.emissiveColor = BABYLON.Color3.FromHexString(hex);
    m.diffuseColor = new BABYLON.Color3(0,0,0);
    m.specularColor = new BABYLON.Color3(0,0,0);
    m.disableLighting = true;
    if(alpha != null) m.alpha = alpha;
    return m;
  }

  function buildQuestMarks(scene){
    if(!scene) return;
    if(!W.questMarks.length){
      QUEST_SPOTS.forEach((sp, i) => {
        const y = heightAt(sp.x, sp.z);
        const orb = BABYLON.MeshBuilder.CreateSphere('questOrb_' + sp.key,
          { diameter:0.42, segments:8 }, scene);
        orb.position.set(sp.x, y + 2.0, sp.z);
        orb.material = questMat(scene, 'questOrbMat_' + sp.key, '#ffd43b');
        orb.isPickable = false;
        const ring = BABYLON.MeshBuilder.CreateDisc('questRing_' + sp.key,
          { radius:0.8, tessellation:24 }, scene);
        ring.rotation.x = Math.PI / 2;
        ring.position.set(sp.x, y + 0.06, sp.z);
        ring.material = questMat(scene, 'questRingMat_' + sp.key, '#ffd43b', 0.32);
        ring.isPickable = false;
        W.questMarks.push({ key:sp.key, orb, ring, baseY:y + 2.0, phase:i * 2.1 });
      });
    }
    // 완료 여부만 갱신 — 씬을 다시 만들지 않는다
    W.questMarks.forEach(m => {
      const on = !W.questDone.has(m.key);
      m.orb.setEnabled(on); m.ring.setEnabled(on);
    });
  }

  function applyQuestVisuals(){
    const S = W.scene;
    if(!S) return;
    W.questRelics.forEach(n => { try{ n.dispose(); }catch(e){ } });
    W.questRelics = [];
    // ★ v1.84 등대는 «파란 구슬» 대신 등대 불 자체가 켜지는 것으로 완료를 보여 준다
    setLighthouseLit(W.questDone.has('light'));
    W.questDone.forEach(key => {
      const sp = QUEST_SPOTS.find(s => s.key === key);
      if(!sp || key === 'light') return;
      const y = heightAt(sp.x, sp.z);
      // 완료한 의뢰는 «파란 빛» 으로 남는다 — village_props 덕분에 다음 날에도 유지(P2)
      const orb = BABYLON.MeshBuilder.CreateSphere('questRelic_' + key,
        { diameter:0.5, segments:8 }, S);
      orb.position.set(sp.x, y + 1.1, sp.z);
      orb.material = questMat(S, 'questRelicMat_' + key, '#5cd6c0');
      orb.isPickable = false;
      W.questRelics.push(orb);
      if(key === 'well'){
        const water = BABYLON.MeshBuilder.CreateDisc('questWater_' + key,
          { radius:0.55, tessellation:24 }, S);
        water.rotation.x = Math.PI / 2;
        water.position.set(sp.x, y + 0.18, sp.z);
        water.material = questMat(S, 'questWaterMat_' + key, '#6fd2ec', 0.72);
        water.isPickable = false;
        W.questRelics.push(water);
      }
    });
    const hud = $('#world-quests');
    if(hud) hud.textContent = `🛠 ${W.questDone.size} / ${QUEST_SPOTS.length}`;
  }

  async function loadWorldQuests(){
    if(typeof api !== 'function' || !W.scene) return;
    try{
      const r = await api('/api/world/quest', undefined, 8000);
      W.quests = r.quests || [];
      W.questDone = new Set(W.quests.filter(q => q.done).map(q => q.key));
      W.questSkipReady = !!r.skipReady;
      const chip = $('#world-quests');
      if (chip) chip.classList.toggle('can-skip', W.questSkipReady);
      // ★ 서버가 알려 주는 «오늘 이미 주운 별»(POST /api/world/star 의 star 필드 = 0..2 인덱스)을 저장해 두고
      //   별이 만들어진 뒤 복원한다 — 당일 재입장 시 부활 수거·HUD 어긋남을 막는다
      W.starsCollected = Array.isArray(r.stars_collected)
        ? r.stars_collected.map((v) => Number(v)).filter((v) => v >= 0)
        : null;
      buildQuestMarks(W.scene);
      applyQuestVisuals();
      applyCollectedStars();
    }catch(e){
      // 비로그인·오프라인이면 «의뢰 없이» 조용히 논다
      W.quests = []; W.questDone = new Set();
      W.questMarks.forEach(m => { m.orb.setEnabled(false); m.ring.setEnabled(false); });
    }
  }

  function setPromptType(type) {
    const ico = $('#world-prompt .wp-ico');
    const b = $('#world-prompt .wp-txt b');
    const sp = $('#world-prompt .wp-txt span');
    if (type === 'quest') {
      // v1.37: 조건을 «누르기 전에» 보여준다 — 무엇을 하러 가는지 알고 출발하게
      if (ico) ico.textContent = '🛠';
      if (b) b.textContent = '오늘의 의뢰';
      if (sp) sp.textContent = QUEST_PROMPT[W.nearQuest] || '눌러서 도전하기';
    } else if (type === 'chest') {
      if (ico) ico.textContent = '🎁';
      if (b) b.textContent = '보물상자';
      if (sp) sp.textContent = '눌러서 열어 보기';
    } else if (type === 'vault') {
      // v1.39: 지금 켜진 등을 «누르기 전에» 보여준다 — 들어가 볼 이유가 된다
      if (ico) ico.textContent = '🏮';
      if (b) b.textContent = '별빛 저장고';
      if (sp) sp.textContent = `${W.vaultLit || 0} / ${VAULT_LIGHTS} 등이 켜져 있어요`;
    } else if (type === 'secret') {
      // v1.38: 설명을 «낡은 이정표» 라고만 적는다 — 무슨 글이 있는지는 열어 봐야 안다
      if (ico) ico.textContent = '🪧';
      if (b) b.textContent = '낡은 이정표';
      if (sp) sp.textContent = '눌러서 읽어 보기';
    } else {
      if (ico) ico.textContent = '📖';
      if (b) b.textContent = '지혜의 샘';
      if (sp) sp.textContent = '눌러서 루미의 질문 풀기';
    }
  }
  function showPrompt(on) {
    const el = $('#world-prompt');
    if (!el) return;
    if (on) el.classList.remove('hidden');
    else el.classList.add('hidden');
  }

  function openWorldQuiz(i) {
    const st = W.lessons && W.lessons[i];
    if (!st) { if (typeof toast === 'function') toast('문제를 불러오는 중이에요'); loadWorldLessons(); return; }
    W.quizOpen = true;
    showPrompt(false);
    const box = $('#world-quiz');
    const topic = $('#wq-topic'), q = $('#wq-q'), opts = $('#wq-opts'), feed = $('#wq-feed');
    if (topic) topic.textContent = st.topic || '오늘의 질문';
    if (q) q.textContent = st.q;
    if (feed) { feed.classList.add('hidden'); feed.textContent = ''; feed.className = 'wq-feed hidden'; }
    if (opts) {
      opts.innerHTML = '';
      st.options.forEach((text, idx) => {
        const b = document.createElement('button');
        b.className = 'wq-opt';
        b.textContent = text;
        b.dataset.idx = String(idx);
        b.addEventListener('click', () => answerWorldQuiz(i, idx, b));
        opts.appendChild(b);
      });
    }
    if (box) box.classList.remove('hidden');
  }

  function closeWorldQuiz() {
    W.quizOpen = false;
    const box = $('#world-quiz');
    if (box) box.classList.add('hidden');
  }

  async function answerWorldQuiz(i, choice, btn) {
    if (typeof api !== 'function') return;
    const opts = $('#wq-opts');
    if (opts) [...opts.children].forEach((b) => { b.disabled = true; });
    try {
      const r = await api('/api/world/lesson/answer', { station: i, choice });
      const feed = $('#wq-feed');
      if (r.correct) {
        // ★ already(오늘 이미 정답)는 서버가 done/total 없이 답할 수 있다 — 카운트를 부풀리지 말고 조용히 닫는다
        if (r.already) { closeWorldQuiz(); return; }
        if (btn) btn.classList.add('ok');
        if (feed) {
          feed.className = 'wq-feed ok';
          feed.innerHTML = `정답이야! +${r.reward || 5}셀` + (r.explain ? `<br><span style="opacity:.85">${r.explain}</span>` : '');
        }
        W.lessonDone = r.done != null ? r.done : W.lessonDone + 1;
        const el = $('#world-lessons');
        if (el) el.textContent = `📖 ${W.lessonDone} / ${r.total || 3}`;
        setStationSolved(i);
        if (W.lessons) { const s0 = W.lessons.find((x) => x.station === i); if (s0) s0.solved = true; }
        if (r.balance != null && typeof setBalance === 'function') setBalance(r.balance);
        if (typeof toast === 'function') toast(`📖 지혜 조각 +1 · +${r.reward || 5}셀`);
        if (W.lessonDone >= (r.total || 3)) {
          oneShot('Dance', 1800);
          if (typeof toast === 'function') setTimeout(() => toast('🎉 오늘의 지혜 3개를 모두 모았어!'), 1200);
        } else {
          oneShot('ThumbsUp', 900);
        }
        setTimeout(() => { closeWorldQuiz(); }, 2100);
      } else {
        if (btn) btn.classList.add('no');
        if (feed) { feed.className = 'wq-feed no'; feed.textContent = '💡 ' + (r.hint || '한 번 더 생각해 보자.'); }
        if (opts) setTimeout(() => { [...opts.children].forEach((b) => { b.disabled = false; b.classList.remove('no'); }); }, 900);
      }
    } catch (e) {
      const feed = $('#wq-feed');
      if (feed) { feed.className = 'wq-feed no'; feed.textContent = (e && e.message) || '잠시 후 다시 시도해 주세요'; }
      if (opts) [...opts.children].forEach((b) => { b.disabled = false; });
    }
  }

  // ────────────── 보물상자 (하루 5개) ──────────────
  const CHEST_SPOTS = [
    { x: 18.5, z: 6.5 },
    { x: -21.0, z: 2.5 },
    { x: 7.5, z: -17.0 },
    { x: -28.0, z: -20.0 },
    { x: 23.0, z: -13.0 }
  ];
  // ★ v1.84 보물상자 나무결 — 널판 4장 + 결 무늬 + 이음매. 장면당 한 번만 만들어 상자 5개가 공유한다.
  //   난수는 쓰지 않는다(자체 해시) → 전역 rnd 시퀀스·마을 배치는 그대로다.
  function chestWoodTexture(scene) {
    if (scene.__roomiChestWood) return scene.__roomiChestWood;
    const S = 256;
    const dt = new BABYLON.DynamicTexture('chestWoodTex', { width: S, height: S }, scene, true);
    const g = dt.getContext();
    const base = [138, 90, 52];
    const PLANKS = 4, PH = S / PLANKS;
    for (let p = 0; p < PLANKS; p++) {
      // 널판마다 살짝 다른 명도 (결정적 해시: 인덱스만 쓴다)
      const k = ((p * 2654435761) >>> 0) % 1000 / 1000;
      const shade = 0.92 + k * 0.16;
      g.fillStyle = `rgb(${Math.round(base[0] * shade)},${Math.round(base[1] * shade)},${Math.round(base[2] * shade)})`;
      g.fillRect(0, p * PH, S, PH);
      // 결 무늬 — 물결치는 가는 선 여러 줄
      for (let l = 0; l < 9; l++) {
        const y0 = p * PH + 4 + l * ((PH - 8) / 9);
        const amp = 1.5 + ((l * 7 + p * 3) % 5) * 0.6;
        g.strokeStyle = (l + p) % 2 ? 'rgba(70,40,18,0.22)' : 'rgba(255,220,170,0.10)';
        g.lineWidth = 1.2;
        g.beginPath();
        for (let x = 0; x <= S; x += 8) {
          const y = y0 + Math.sin(x * 0.045 + l * 1.7 + p) * amp;
          if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
      }
      // 널판 이음매 — 어두운 가는 선
      g.fillStyle = 'rgba(40,22,10,0.55)';
      g.fillRect(0, p * PH, S, 2);
    }
    dt.hasAlpha = false;
    dt.update(false);
    scene.__roomiChestWood = dt;
    return dt;
  }
  function makeChest(scene, sp, i) {
    const wood = pbr(scene, 'chestWood' + i, '#ffffff', 0.85, 0);
    wood.albedoTexture = chestWoodTexture(scene);
    const iron = pbr(scene, 'chestIron' + i, '#3d3a38', 0.5, 0.6);
    // ★ 포인트라이트 대신 emissive 강화로 발광 보상 (씬 라이트 총량 축소)
    const gold = emissiveMat(scene, 'chestGold' + i, '#ffd15c', 1.25);
    const y = heightAt(sp.x, sp.z);
    const node = new BABYLON.TransformNode('chest' + i, scene);
    node.position.set(sp.x, y, sp.z);
    const body = BABYLON.MeshBuilder.CreateBox('chestB' + i, { width: 1.16, height: 0.74, depth: 0.76 }, scene);
    body.position.y = 0.37; body.parent = node; body.material = wood;
    body.receiveShadows = true; body.castShadow = true; body.isPickable = false;
    const lid = BABYLON.MeshBuilder.CreateBox('chestL' + i, { width: 1.24, height: 0.26, depth: 0.84 }, scene);
    lid.position.y = 0.85; lid.parent = node; lid.material = wood;
    lid.receiveShadows = true; lid.castShadow = true; lid.isPickable = false;
    const band = BABYLON.MeshBuilder.CreateBox('chestBand' + i, { width: 0.2, height: 0.8, depth: 0.8 }, scene);
    band.position.y = 0.4; band.parent = node; band.material = gold; band.isPickable = false;
    // 쇠 띠 — 앞뒤 면에 두 줄씩. 금 띠(가운데)와 겹치지 않게 x=±0.38 에 둔다
    [-0.38, 0.38].forEach((sx) => {
      [-0.39, 0.39].forEach((sz) => {
        const strap = BABYLON.MeshBuilder.CreateBox('chestStrap' + i, { width: 0.1, height: 0.76, depth: 0.03 }, scene);
        strap.position.set(sx, 0.37, sz); strap.parent = node; strap.material = iron;
        strap.isPickable = false; strap.receiveShadows = true;
      });
    });
    // 멀리서도 보이는 표식 (떠 있는 빛)
    const beacon = BABYLON.MeshBuilder.CreateSphere('chestBeacon' + i, { diameter: 0.34, segments: 8 }, scene);
    beacon.position.y = 1.75; beacon.parent = node; beacon.material = gold; beacon.isPickable = false;
    const glow = BABYLON.MeshBuilder.CreateDisc('chestGlow' + i, { radius: 0.85, tessellation: 20 }, scene);
    glow.rotation.x = Math.PI / 2; glow.position.y = 0.02; glow.parent = node;
    const gm = emissiveMat(scene, 'chestGlowM' + i, '#ffd98a', 1.0);
    gm.alpha = 0.35; gm.backFaceCulling = false; glow.material = gm; glow.isPickable = false;
    // ★ 장식용 포인트라이트 제거 — 골드 밴드·비컨·바닥 글로우가 모두 emissive 라 빛 없이도 발광한다
    W.chests.push({ x: sp.x, z: sp.z, node, lid, band, glow, beacon, claimed: false });
  }
  function setChestClaimed(i) {
    const c = W.chests[i];
    if (!c) return;
    c.claimed = true;
    try {
      c.lid.position.y = 0.97; c.lid.rotation.x = -0.55;
      if (c.beacon) c.beacon.setEnabled(false);
      c.glow.material.alpha = 0.06;
      c.band.material.emissiveColor = new BABYLON.Color3(0.35, 0.32, 0.25);
    } catch (e) { }
  }
  async function loadTreasure() {
    if (typeof api !== 'function') return;
    try {
      const r = await api('/api/world/treasure');
      (r.spots || []).forEach((sp) => { if (sp.claimed) setChestClaimed(sp.i); });
      const left = r.left != null ? r.left : 0;
      const el = $('#world-treasure');
      if (el) el.textContent = `🎁 ${left}`;
    } catch (e) { }
  }
  async function openChest(i) {
    const c = W.chests[i];
    if (!c || c.claimed || typeof api !== 'function') return;
    try {
      const r = await api('/api/world/treasure', { spot: i });
      setChestClaimed(i);
      try { collectFx(c.node.position); } catch (e) { }   // ★ v1.73 L6 — 흡입 광휘 + 블룸 펄스
      if (r.balance != null && typeof setBalance === 'function') setBalance(r.balance);
      if (r.reward) {
        if (typeof toast === 'function') toast(`🎁 보물 발견! +${r.reward}셀` + (r.left != null ? ` · 남은 보물 ${r.left}` : ''));
        oneShot('ThumbsUp', 900);
      }
      const el = $('#world-treasure');
      if (el && r.left != null) el.textContent = `🎁 ${r.left}`;
      showPrompt(false);
      W.nearType = ''; W.near = -1;
    } catch (e) { if (typeof toast === 'function') toast(e.message); }
  }

  // ────────────── 비밀 이정표 (v1.38 이스터에그) ──────────────
  //   남서쪽 길이 «끊기는 자리» 에 작은 돌 하나. 표식도 빛도 알림도 없다.
  //   다만 3m 안에 서면 프롬프트가 뜨고, 누르면 글이 읽힌다.
  //   좌표는 고정이지만 나무 충돌체와 겹칠 수 있어 «가까운 빈 자리» 로 한 번 밀어 둔다.
  const SECRET_BASE = { x: -34.5, z: -39.2 };
  const SECRET_SPOT = { x: SECRET_BASE.x, z: SECRET_BASE.z };
  const SECRET_READ_KEY = 'roomi_secret_maker';

  function freeSpotNear(x, z, maxR) {
    if (!blockReason(x, z)) return { x, z };
    for (let r = 0.8; r <= (maxR || 7); r += 0.8) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const nx = x + Math.cos(a) * r, nz2 = z + Math.sin(a) * r;
        if (!blockReason(nx, nz2)) return { x: nx, z: nz2 };
      }
    }
    return { x, z };
  }

  // 돌판에 «아주 작게» 새긴 글. 멀리서는 그냥 돌덩이로 보이게 대비를 낮춘다.
  // 나뭇결 널판에 «아주 작게» 새긴 글. 멀리서는 그냥 낡은 팻말로 보인다.
  function secretFaceTexture(scene) {
    const SW = 256, SH = 144;
    const dt = new BABYLON.DynamicTexture('secretFaceTex', { width: SW, height: SH }, scene, true);
    const g = dt.getContext();
    g.fillStyle = '#b3a084'; g.fillRect(0, 0, SW, SH);
    // 나뭇결
    for (let i = 0; i < 26; i++) {
      const y = nz(i, 5) * SH;
      g.strokeStyle = 'rgba(92,66,40,' + (0.04 + nz(i, 6) * 0.10).toFixed(3) + ')';
      g.lineWidth = 0.8 + nz(i, 7) * 2.2;
      g.beginPath(); g.moveTo(0, y);
      for (let xx = 0; xx <= SW; xx += 24) g.lineTo(xx, y + Math.sin(xx * 0.05 + i) * 1.6);
      g.stroke();
    }
    // 얼룩
    for (let i = 0; i < 40; i++) {
      g.fillStyle = 'rgba(96,72,44,' + (0.02 + nz(i, 8) * 0.05).toFixed(3) + ')';
      g.beginPath(); g.arc(nz(i, 1) * SW, nz(i, 2) * SH, 3 + nz(i, 4) * 8, 0, 6.284); g.fill();
    }
    g.strokeStyle = 'rgba(74,54,32,0.42)'; g.lineWidth = 3;
    g.strokeRect(11, 11, SW - 22, SH - 22);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(56,38,22,0.86)';
    g.font = 'bold 42px "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
    g.fillText('루미', SW / 2, SH * 0.41);
    g.fillStyle = 'rgba(56,38,22,0.55)';
    g.font = 'bold 19px "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
    g.fillText('2026', SW / 2, SH * 0.66);
    // 아주 작은 하트 — 이 팻말을 찾아낸 사람만 알아본다
    const hx = SW / 2, hy = SH * 0.84, hs = 6;
    g.fillStyle = 'rgba(150,62,62,0.40)';
    g.beginPath();
    g.moveTo(hx, hy + hs);
    g.bezierCurveTo(hx - hs * 1.7, hy - hs * 0.4, hx - hs * 0.6, hy - hs * 1.6, hx, hy - hs * 0.5);
    g.bezierCurveTo(hx + hs * 0.6, hy - hs * 1.6, hx + hs * 1.7, hy - hs * 0.4, hx, hy + hs);
    g.fill();
    // v1.33 교훈: 글자가 있는 DynamicTexture 는 update(false) 금지(상하 반전)
    dt.update();
    return dt;
  }

  // 빈터 만들기 — «자연물(sp_ 접두어)» 만 지우고 그 충돌체도 함께 걷어 낸다.
  //   건물·울타리(sp_house/sp_fence 등)는 이름 규칙에서 제외해 실수로 사라지지 않게 한다.
  const GLADE_RE = /^sp_(tree|bush|rock|plant|stump|log|grass|flowers|fern|mushroom)/i;
  function clearGlade(scene, x, z, radius) {
    const killed = [];
    scene.transformNodes.slice().forEach((n) => {
      if (!GLADE_RE.test(n.name)) return;
      if (Math.hypot(n.position.x - x, n.position.z - z) > radius) return;
      killed.push([n.position.x, n.position.z]);
      try { n.dispose(); } catch (e) { }
    });
    killed.forEach(([kx, kz]) => {
      for (let i = COLL.length - 1; i >= 0; i--) {
        const c = COLL[i];
        if (Math.abs(c.x - kx) < 1e-4 && Math.abs(c.z - kz) < 1e-4) COLL.splice(i, 1);
      }
    });
    return killed.length;
  }

  function buildSecretSign(scene) {
    const sp = freeSpotNear(SECRET_BASE.x, SECRET_BASE.z, 7);
    SECRET_SPOT.x = sp.x; SECRET_SPOT.z = sp.z;
    // v1.38: 숲 한가운데라 나무에 파묻혀 «보이지도 않는» 상태가 됐다.
    //   주변 자연물만 걷어 내 작은 빈터를 만든다(건물·울타리는 건드리지 않는다).
    //   빈터 중심은 «길 쪽» 으로 7m 밀어 둔다 — 카메라는 아이 뒤 12m 에 서므로,
    //   중심을 팻말에 두면 카메라가 다시 숲에 들어가 화면이 나뭇잎으로 덮인다.
    const ax = -33.0 - sp.x, az = -37.0 - sp.z;
    const al = Math.hypot(ax, az) || 1;
    const gx = sp.x + (ax / al) * 7.0, gz = sp.z + (az / al) * 7.0;
    W.secretCleared = clearGlade(scene, gx, gz, 9.0);
    const y = heightAt(sp.x, sp.z);
    const node = new BABYLON.TransformNode('secretSign', scene);
    node.position.set(sp.x, y, sp.z);
    // 글판은 -Z 를 본다 → 길에서 걸어 들어오는 «북동» 쪽을 향하게 돌린다.
    //   (한 번만 돌려 두면 아이는 늘 글자를 정면으로 만난다)
    node.rotation.y = Math.PI + 0.60;

    const wood = pbr(scene, 'secretWood', '#6a4a33', 0.9, 0);
    const darkWood = pbr(scene, 'secretWoodDark', '#57402c', 0.92, 0);
    const moss = pbr(scene, 'secretMoss', '#6d8459', 0.98, 0);

    // ① 기둥 — 땅에 박혀 있다
    const post = BABYLON.MeshBuilder.CreateCylinder('secretPost',
      { height: 1.16, diameter: 0.17, tessellation: 9 }, scene);
    post.position.set(0, 0.58, 0); post.parent = node; post.material = wood;
    post.isPickable = false; post.receiveShadows = true; post.castShadow = true;

    // ② 널판 — 살짝 기울어 오래된 느낌
    // 기둥 «앞» 에 널판을 다는 게 진짜 팻말이다 — z=0 에 두면 기둥이 글자를 가린다.
    const plank = BABYLON.MeshBuilder.CreateBox('secretPlank',
      { width: 0.80, height: 0.46, depth: 0.07 }, scene);
    plank.position.set(0.02, 1.00, -0.115); plank.rotation.z = -0.05;
    plank.parent = node; plank.material = darkWood;
    plank.isPickable = false; plank.receiveShadows = true; plank.castShadow = true;

    // ③ 글판 — CreatePlane 기본 법선은 -Z. 앞면을 -Z 로 두면 정방향으로 읽힌다.
    const face = BABYLON.MeshBuilder.CreatePlane('secretFace',
      { width: 0.72, height: 0.40 }, scene);
    face.position.set(0.02, 1.00, -0.153); face.rotation.z = -0.05;
    face.parent = node;
    const fm = new BABYLON.StandardMaterial('secretFaceMat', scene);
    const tex = secretFaceTexture(scene);
    fm.diffuseTexture = tex; fm.emissiveTexture = tex;
    fm.emissiveColor = new BABYLON.Color3(0.9, 0.9, 0.9);
    fm.diffuseColor = new BABYLON.Color3(0, 0, 0);
    fm.specularColor = new BABYLON.Color3(0, 0, 0);
    fm.disableLighting = true;
    face.material = fm;
    face.isPickable = false;

    // ④ 발치 이끼 — «여기 오래 서 있었다» 는 신호
    [[0.20, 0.05, 0.13], [-0.16, -0.09, 0.11], [0.02, -0.20, 0.10]].forEach((m, i) => {
      const blob = BABYLON.MeshBuilder.CreateSphere('secretMossBase' + i,
        { diameter: 1, segments: 8 }, scene);
      blob.scaling.set(m[2] * 2.6, m[2] * 0.7, m[2] * 2.4);
      blob.position.set(m[0], 0.03, m[1]);
      blob.parent = node; blob.material = moss; blob.isPickable = false;
    });

    W.secretSign = node;
    // 기둥에 부딪히지 않게 «작은 충돌체» 만 등록한다 (아이들이 통과하지 않도록)
    COLL.push({ x: sp.x, z: sp.z, r: 0.34 });
  }

  // ────────────── ★ v1.84 «기억의 등대» — 학습 의뢰 랜드마크 ──────────────
  //   호수 건너편 물가의 흰 등대. 등불 유리는 의뢰 전에는 흐린 회청색,
  //   아이가 루미에게 개념을 설명해 의뢰를 끝내면 따뜻한 금빛으로 켜지고 빛줄기 두 갈래가 돈다.
  //   예산: PointLight 를 추가하지 않는다(emissive + GlowLayer 만). 난수(rnd) 소모 없음.
  //   로컬 좌표: y=0 은 물 밑 바위 바닥(WATER_Y-0.35), -Z 면(문)이 상호작용 자리(뭍)를 본다.
  function buildLighthouse(scene) {
    if (!scene || W.lighthouse) return;
    const T = LIGHTHOUSE;
    const Q = QUEST_SPOTS.find((s) => s.key === 'light');
    // 뭍 쪽 빈터 — 카메라가 아이 뒤 12m 에 서므로 바깥쪽으로 4m 밀어 둔다(비밀 이정표와 같은 이유)
    const ox = Q.x - T.x, oz = Q.z - T.z, ol = Math.hypot(ox, oz) || 1;
    clearGlade(scene, Q.x + (ox / ol) * 4, Q.z + (oz / ol) * 4, 7.5);
    clearGlade(scene, T.x, T.z, 2.6);   // 탑 발치의 물가 바위

    const node = new BABYLON.TransformNode('lighthouse', scene);
    node.position.set(T.x, WATER_Y - 0.35, T.z);
    node.rotation.y = Math.atan2(-ox, -oz);   // 로컬 -Z → 뭍 방향

    const white = pbr(scene, 'lhWhite', '#f3eee3', 0.78, 0);
    const red = pbr(scene, 'lhRed', '#c4513e', 0.72, 0);
    const roofMat = pbr(scene, 'lhRoof', '#a8402f', 0.7, 0);
    const stone = pbr(scene, 'lhStone', '#9a958a', 0.95, 0);
    const stone2 = pbr(scene, 'lhStone2', '#7f7a70', 0.95, 0);
    const wood = pbr(scene, 'lhWood', '#5e4331', 0.9, 0);
    const iron = pbr(scene, 'lhIron', '#3d4650', 0.5, 0.6);
    const lens = pbr(scene, 'lhLens', '#8fa2b6', 0.2, 0);
    lens.alpha = 0.92;

    const meshes = [];
    const part = (m, mat, x, y, z) => {
      m.position.set(x, y, z); m.parent = node; m.material = mat;
      m.isPickable = false; m.receiveShadows = true;
      meshes.push(m);
      return m;
    };

    // ① 바위 받침 — 물에서 솟은 둥근 돌무더기(가장 큰 돌 꼭대기가 수면 위 0.5m)
    [[0, 0, 2.3, 1.15, 2.1, stone], [1.05, 0.45, 1.25, 0.8, 1.05, stone2], [-0.95, 0.7, 1.15, 0.7, 1.0, stone],
      [0.6, -1.05, 1.05, 0.62, 1.15, stone2], [-0.75, -0.85, 1.2, 0.72, 0.95, stone]].forEach((r, i) => {
      const b = BABYLON.MeshBuilder.CreateSphere('lhRock' + i, { diameter: 1, segments: 10 }, scene);
      b.scaling.set(r[2], r[4], r[3]);
      part(b, r[5], r[0], r[4] * 0.3, r[1]);
    });

    // ② 돌 기단
    part(BABYLON.MeshBuilder.CreateCylinder('lhPlinth', { height: 0.45, diameter: 2.0, tessellation: 18 }, scene),
      stone, 0, 0.975, 0);

    // ③ 탑 몸통 — 아래가 넓은 원뿔대 + 빨간 띠 두 줄
    const TB = 1.2, TH = 4.0, DB = 1.45, DT = 1.0;
    const dAt = (t) => DB + (DT - DB) * t;           // 높이 비율 t 의 지름
    part(BABYLON.MeshBuilder.CreateCylinder('lhTower',
      { height: TH, diameterBottom: DB, diameterTop: DT, tessellation: 20 }, scene), white, 0, TB + TH / 2, 0);
    [0.36, 0.7].forEach((t, i) => {
      const bh = 0.42 / TH;
      part(BABYLON.MeshBuilder.CreateCylinder('lhBand' + i,
        { height: 0.42, diameterBottom: dAt(t - bh / 2) + 0.03, diameterTop: dAt(t + bh / 2) + 0.03, tessellation: 20 }, scene),
        red, 0, TB + TH * t, 0);
    });

    // ④ 문·계단·창 — 문은 -Z 면(뭍 쪽)
    part(BABYLON.MeshBuilder.CreateBox('lhDoor', { width: 0.42, height: 0.74, depth: 0.08 }, scene),
      wood, 0, TB + 0.37, -(dAt(0.09) / 2) + 0.01);
    part(BABYLON.MeshBuilder.CreateBox('lhStep', { width: 0.62, height: 0.1, depth: 0.34 }, scene),
      stone, 0, TB + 0.05, -(DB / 2) - 0.12);
    const win1 = part(BABYLON.MeshBuilder.CreateBox('lhWin1', { width: 0.18, height: 0.3, depth: 0.06 }, scene),
      iron, 0, TB + TH * 0.52, -(dAt(0.52) / 2) + 0.005);
    win1.rotation.x = 0.06;
    const win2 = part(BABYLON.MeshBuilder.CreateBox('lhWin2', { width: 0.06, height: 0.28, depth: 0.16 }, scene),
      iron, dAt(0.82) / 2 - 0.005, TB + TH * 0.82, 0);
    win2.rotation.z = -0.06;

    // ⑤ 전망대 — 바닥판 + 난간(고리 + 기둥 10개)
    const GY = TB + TH;
    part(BABYLON.MeshBuilder.CreateCylinder('lhDeck', { height: 0.12, diameter: 1.62, tessellation: 20 }, scene),
      iron, 0, GY + 0.06, 0);
    part(BABYLON.MeshBuilder.CreateTorus('lhRail', { diameter: 1.52, thickness: 0.035, tessellation: 28 }, scene),
      iron, 0, GY + 0.46, 0);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      part(BABYLON.MeshBuilder.CreateCylinder('lhPost' + i, { height: 0.36, diameter: 0.035, tessellation: 6 }, scene),
        iron, Math.cos(a) * 0.76, GY + 0.3, Math.sin(a) * 0.76);
    }

    // ⑥ 등불 방 — 유리 원기둥 + 창살 6개, 위에 빨간 원뿔 지붕과 꼭지 구슬
    const LY = GY + 0.12 + 0.35;
    part(BABYLON.MeshBuilder.CreateCylinder('lhLens', { height: 0.7, diameter: 0.8, tessellation: 16 }, scene),
      lens, 0, LY, 0);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      part(BABYLON.MeshBuilder.CreateCylinder('lhMullion' + i, { height: 0.7, diameter: 0.035, tessellation: 6 }, scene),
        iron, Math.cos(a) * 0.405, LY, Math.sin(a) * 0.405);
    }
    part(BABYLON.MeshBuilder.CreateCylinder('lhRoofCone', { height: 0.55, diameterTop: 0.04, diameterBottom: 1.06, tessellation: 18 }, scene),
      roofMat, 0, LY + 0.35 + 0.275, 0);
    part(BABYLON.MeshBuilder.CreateSphere('lhFinial', { diameter: 0.14, segments: 8 }, scene),
      iron, 0, LY + 0.35 + 0.6, 0);

    // ⑦ 빛줄기 두 갈래 — 등불이 켜졌을 때만. 좁은 끝이 등불 안에서 시작해 바깥으로 넓어진다.
    const beamMat = new BABYLON.StandardMaterial('lhBeamMat', scene);
    beamMat.emissiveColor = BABYLON.Color3.FromHexString('#ffe3a1');
    beamMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    beamMat.specularColor = new BABYLON.Color3(0, 0, 0);
    beamMat.disableLighting = true;
    beamMat.backFaceCulling = false;
    beamMat.alpha = 0.12;
    const pivot = new BABYLON.TransformNode('lhBeamPivot', scene);
    pivot.parent = node; pivot.position.set(0, LY, 0);
    const beams = [-1, 1].map((sgn, i) => {
      const b = BABYLON.MeshBuilder.CreateCylinder('lhBeam' + i,
        { height: 7, diameterTop: 1.9, diameterBottom: 0.16, tessellation: 14 }, scene);
      b.rotation.z = -sgn * Math.PI / 2;   // 원기둥 축(y)을 ±x 로 눕힌다 — 넓은 끝이 바깥
      b.position.set(sgn * 3.5, 0, 0);
      b.parent = pivot; b.material = beamMat; b.isPickable = false;
      b.setEnabled(false);
      return b;
    });

    // 그림자·수면 반사 — 호수 40m 안 구조물 규칙을 따른다(빛줄기는 제외)
    meshes.forEach((m) => {
      if (W.shadow && m.position.y > 0.9) { m.castShadow = true; try { W.shadow.addShadowCaster(m, false); } catch (e) { } }
      if (W.waterWM) { try { W.waterWM.addToRenderList(m); } catch (e) { } }
    });

    COLL.push({ x: T.x, z: T.z, r: 1.5 });
    W.lighthouse = { node, lens, pivot, beams, beamMat, lit: false };
    setLighthouseLit(!!W.lighthouseLit);   // 의뢰 상태가 빌드보다 먼저 도착했으면 여기서 반영
  }

  // 등불 켜기/끄기 — applyQuestVisuals 가 부른다. 빌드 전이면 상태만 기억해 둔다.
  function setLighthouseLit(on) {
    W.lighthouseLit = !!on;
    const L = W.lighthouse;
    if (!L) return;
    L.lit = !!on;
    L.lens.emissiveColor = BABYLON.Color3.FromHexString(on ? '#ffcf6b' : '#5d6f84');
    L.lens.emissiveIntensity = on ? 1.5 : 0.35;
    L.beams.forEach((b) => b.setEnabled(!!on));
  }

  // 매 프레임 — 켜진 등불은 천천히 돌고, 밤일수록 빛줄기가 진해진다. 꺼진 등불은 아주 약하게 숨 쉰다.
  function updateLighthouse(dt) {
    const L = W.lighthouse;
    if (!L) return;
    if (L.lit) {
      L.pivot.rotation.y += dt * 0.55;
      const nk = (W.dayNight && W.dayNight.nightK) || 0;
      L.beamMat.alpha = 0.05 + 0.22 * nk;
      L.lens.emissiveIntensity = 1.4 + 0.2 * Math.sin(W.t * 2.2);
    } else {
      L.lens.emissiveIntensity = 0.3 + 0.08 * Math.sin(W.t * 0.9);
    }
  }

  // ────────────────────────── v1.39 별빛 저장고 ──────────────────────────
  //  아이가 «고쳐 쓴 생각» 을 하나 남길 때마다 이 저장고의 등이 하나씩 켜진다.
  //  학습이 세계를 바꾼다는 사실을 «숫자» 가 아니라 «빛» 으로 보여주는 장치.
  const VAULT_BASE = { x: 9.0, z: 9.5 };
  const VAULT_LIGHTS = 8;
  let VAULT_SPOT = { x: VAULT_BASE.x, z: VAULT_BASE.z };

  function vaultBoardTexture(scene) {
    const W2 = 320, H2 = 128;
    const dt = new BABYLON.DynamicTexture('vaultBoardTex', { width: W2, height: H2 }, scene, true);
    const g = dt.getContext();
    g.fillStyle = '#4a3620'; g.fillRect(0, 0, W2, H2);
    // 나뭇결 — 비밀 팻말과 같은 질감을 써서 «같은 마을의 물건» 으로 읽히게
    for (let i = 0; i < 18; i++) {
      const yy = nz(i, 21) * H2;
      g.strokeStyle = 'rgba(28,18,8,' + (0.06 + nz(i, 22) * 0.10).toFixed(3) + ')';
      g.lineWidth = 0.8 + nz(i, 23) * 1.8;
      g.beginPath(); g.moveTo(0, yy);
      for (let xx = 0; xx <= W2; xx += 20) g.lineTo(xx, yy + Math.sin(xx * 0.05 + i) * 1.4);
      g.stroke();
    }
    g.strokeStyle = 'rgba(226,196,132,0.55)'; g.lineWidth = 3;
    g.strokeRect(9, 9, W2 - 18, H2 - 18);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#f6e6bf';
    g.font = 'bold 40px "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
    g.fillText('별빛 저장고', W2 / 2, H2 * 0.40);
    g.fillStyle = 'rgba(246,230,191,0.62)';
    g.font = 'bold 17px "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
    g.fillText('고쳐 쓴 생각이 쌓이는 곳', W2 / 2, H2 * 0.70);
    // v1.33 교훈: 글자가 있는 DynamicTexture 는 update(false) 금지(상하 반전)
    dt.update();
    return dt;
  }

  function buildThoughtVault(scene) {
    const sp = freeSpotNear(VAULT_BASE.x, VAULT_BASE.z, 6) || VAULT_BASE;
    VAULT_SPOT = { x: sp.x, z: sp.z };
    W.vaultSpot = VAULT_SPOT;
    W.vaultLit = 0; W.vaultFixed = 0;
    const y = heightAt(sp.x, sp.z);

    const node = new BABYLON.TransformNode('thoughtVault', scene);
    node.position.set(sp.x, y, sp.z);

    const stone = pbr(scene, 'vaultStone', '#b3a892', 0.95, 0);
    const wood = pbr(scene, 'vaultWood', '#6b4f31', 0.86, 0);
    const iron = pbr(scene, 'vaultIron', '#5a5248', 0.6, 0.35);

    // ① 네모난 석재 대좌 + 둥근 돌받침 — «케이크» 처럼 보이지 않게 각을 준다
    const plinth = BABYLON.MeshBuilder.CreateBox('vaultPlinth',
      { width: 2.0, height: 0.26, depth: 2.0 }, scene);
    plinth.position.y = 0.13; plinth.parent = node; plinth.material = stone;
    const plinth2 = BABYLON.MeshBuilder.CreateBox('vaultPlinth2',
      { width: 1.5, height: 0.22, depth: 1.5 }, scene);
    plinth2.position.y = 0.37; plinth2.parent = node; plinth2.material = stone;
    const drum = BABYLON.MeshBuilder.CreateCylinder('vaultDrum',
      { diameterTop: 1.05, diameterBottom: 1.22, height: 0.34, tessellation: 16 }, scene);
    drum.position.y = 0.65; drum.parent = node; drum.material = stone;

    // ② 중심 기둥 + 두 개의 나무 등걸이
    const post = BABYLON.MeshBuilder.CreateCylinder('vaultPost',
      { diameter: 0.24, height: 2.9, tessellation: 16 }, scene);
    post.position.y = 2.05; post.parent = node; post.material = wood;
    [1.42, 2.00].forEach((ly, i) => {
      const ring = BABYLON.MeshBuilder.CreateCylinder('vaultRing' + i,
        { diameter: i ? 1.24 : 1.72, height: 0.09, tessellation: 20 }, scene);
      ring.position.y = ly; ring.parent = node; ring.material = wood;
      const band = BABYLON.MeshBuilder.CreateTorus('vaultBand' + i,
        { diameter: i ? 1.24 : 1.72, thickness: 0.045, tessellation: 20 }, scene);
      band.position.y = ly + 0.06; band.parent = node; band.material = iron;
    });

    // ③ 등 8개 — 켜짐/꺼짐을 «각자» 제어해야 하므로 재질을 따로 만든다
    W.vaultLamps = [];
    for (let i = 0; i < VAULT_LIGHTS; i++) {
      const upper = i >= 4;
      const a = ((i % 4) / 4) * Math.PI * 2 + (upper ? Math.PI / 4 : 0);
      const rad = upper ? 0.55 : 0.79;
      const ly = upper ? 2.06 : 1.48;
      const m = new BABYLON.StandardMaterial('vaultLampMat' + i, scene);
      m.disableLighting = true;
      m.diffuseColor = new BABYLON.Color3(0.22, 0.17, 0.10);   // 꺼진 등도 «등» 으로 보이게
      m.emissiveColor = new BABYLON.Color3(0.26, 0.20, 0.10);
      m.specularColor = new BABYLON.Color3(0, 0, 0);
      const lamp = BABYLON.MeshBuilder.CreateSphere('vaultLamp' + i,
        { diameter: 0.30, segments: 10 }, scene);
      lamp.material = m;
      lamp.position.set(Math.cos(a) * rad, ly + 0.16, Math.sin(a) * rad);
      lamp.parent = node;
      lamp.isPickable = false;
      W.vaultLamps.push(m);
    }
    // ★ 저장고 포인트라이트 제거 — 등 8개가 모두 emissive 재질(disableLighting)이라
    //   자체 발광 + GlowLayer 로 충분하다. applyVaultLights 의 W.vaultGlow 분기는 null 로 무력화.
    W.vaultGlow = null;

    // ④ 지붕 + 나무 팻말 (글자는 «기둥 앞» 에 달아야 가려지지 않는다 — v1.38 교훈)
    const roof = BABYLON.MeshBuilder.CreateCylinder('vaultRoof',
      { diameterTop: 0.10, diameterBottom: 0.92, height: 0.32, tessellation: 16 }, scene);
    roof.position.y = 3.62; roof.parent = node; roof.material = wood;
    // v1.38 교훈: 팻말은 기둥 «앞» 에 달아야 한다. z=0 에 두면 기둥이 글자를 가른다.
    const board = BABYLON.MeshBuilder.CreateBox('vaultBoard',
      { width: 1.66, height: 0.64, depth: 0.08 }, scene);
    board.position.set(0, 2.58, -0.21); board.parent = node; board.material = wood;
    const btex = vaultBoardTexture(scene);
    const bmat = new BABYLON.StandardMaterial('vaultBoardMat', scene);
    bmat.diffuseTexture = btex; bmat.emissiveTexture = btex;
    bmat.emissiveColor = new BABYLON.Color3(0.55, 0.55, 0.55);
    bmat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    bmat.specularColor = new BABYLON.Color3(0, 0, 0);
    const face = BABYLON.MeshBuilder.CreatePlane('vaultBoardFace',
      { width: 1.58, height: 0.58 }, scene);
    face.position.set(0, 2.58, -0.256);
    face.parent = node; face.material = bmat; face.isPickable = false;

    W.vaultNode = node;
    applyVaultLights(0);
    // 기단에 부딪히지 않게 «기단보다 작은» 충돌체 하나만 등록한다
    COLL.push({ x: sp.x, z: sp.z, r: 1.02 });
  }

  // 켜진 등 수를 그대로 «빛» 으로 반영한다. 서버 숫자와 화면이 어긋나지 않도록 한 곳에서만 계산.
  function applyVaultLights(lit) {
    const n = Math.max(0, Math.min(VAULT_LIGHTS, Math.round(Number(lit) || 0)));
    W.vaultLit = n;
    (W.vaultLamps || []).forEach((m, i) => {
      const on = i < n;
      m.emissiveColor = on
        ? new BABYLON.Color3(1.0, 0.80, 0.34)
        : new BABYLON.Color3(0.26, 0.20, 0.10);
      m.diffuseColor = on
        ? new BABYLON.Color3(1.0, 0.88, 0.50)
        : new BABYLON.Color3(0.22, 0.17, 0.10);
    });
    if (W.vaultGlow) W.vaultGlow.intensity = 0.16 + n * 0.20;
    renderVaultCard();
  }

  async function loadThoughtSummary() {
    if (typeof api !== 'function') { applyVaultLights(0); return; }
    try {
      const r = await api('/api/thoughts/summary', undefined, 8000);
      const s = (r && r.stats) || null;
      W.vaultFixed = s ? (s.fixed || 0) : 0;
      applyVaultLights(s ? (s.lit || 0) : 0);
    } catch (e) {
      // 비로그인·오프라인: 꺼진 저장고로 조용히 논다 (세계는 그대로 열린다)
      W.vaultFixed = 0;
      applyVaultLights(0);
    }
  }

  function renderVaultCard() {
    const lamps = $('#wv-lamps');
    if (lamps) {
      const lit = W.vaultLit || 0;
      let html = '';
      for (let i = 0; i < VAULT_LIGHTS; i++) {
        html += `<div class="vlamp${i < lit ? ' on' : ''}"><i></i><span>${i + 1}</span></div>`;
      }
      lamps.innerHTML = html;
    }
    const fixed = $('#wv-fixed'); if (fixed) fixed.textContent = (W.vaultFixed || 0) + '개';
    const litEl = $('#wv-lit'); if (litEl) litEl.textContent = `${W.vaultLit || 0} / ${VAULT_LIGHTS}`;
    const q = $('#wv-quote');
    if (q) {
      const n = W.vaultLit || 0;
      q.textContent = n === 0
        ? '아직 등이 하나도 안 켜져 있어요.'
        : n >= VAULT_LIGHTS
          ? '저장고가 가득 찼어요! 네가 고친 생각으로 마을이 환해졌어.'
          : `네가 고친 생각 ${n}개가 별빛이 되어 여기 있어요.`;
    }
  }

  async function openVault() {
    const box = $('#world-vault');
    if (!box) return;
    W.vaultOpen = true;
    showPrompt(false);
    renderVaultCard();
    box.classList.remove('hidden');
    await loadThoughtSummary();
  }

  function closeVault() {
    W.vaultOpen = false;
    const box = $('#world-vault');
    if (box) box.classList.add('hidden');
  }

  async function openSecret() {
    const box = $('#world-secret');
    if (!box) return;
    W.secretOpen = true;
    showPrompt(false);
    box.classList.remove('hidden');
    const rew = $('#ws-reward');
    if (rew) rew.textContent = '';
    // 이미 읽은 계정이면 서버가 first:false 로 답한다 — 보상 문구만 다르다
    if (typeof api === 'function') {
      try {
        const r = await api('/api/world/secret', { key: 'maker' }, 8000);
        if (r && r.first) {
          W.secretSeen = true;
          try { localStorage.setItem(SECRET_READ_KEY, '1'); } catch (e) { }
          if (r.balance != null && typeof setBalance === 'function') setBalance(r.balance);
          if (rew) rew.textContent = `🌱 처음 찾은 사람에게 +${r.reward}셀`;
          if (typeof toast === 'function') toast('🪧 아주 오래된 글을 읽었어');
          oneShot('Dance', 1600);
        } else if (rew) {
          rew.textContent = '다시 찾아와 줘서 고마워';
        }
      } catch (e) {
        if (rew) rew.textContent = '';
      }
    }
  }

  function closeSecret() {
    W.secretOpen = false;
    const box = $('#world-secret');
    if (box) box.classList.add('hidden');
    try { const cv = $('#world3d'); if (cv) cv.focus(); } catch (e) { }
  }

  // ────────────── 별똥별 (가끔 떨어지는 보너스) ──────────────
  function spawnStarfall(scene) {
    const a = rnd() * Math.PI * 2;
    const r = 12 + rnd() * 34;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    if (!canWalk(x, z)) { W.starTimer = 6; return; }
    const y = heightAt(x, z);
    // ★ 포인트라이트 대신 구슬 emissive 강화로 발광 보상 (별똥별은 순간 장식 조명이었다)
    const mat = emissiveMat(scene, 'sfM' + Math.floor(rnd() * 9999), '#fff3c4', 2.0);
    const orb = BABYLON.MeshBuilder.CreateSphere('starfall', { diameter: 0.55, segments: 10 }, scene);
    orb.material = mat; orb.isPickable = false;
    orb.position.set(x + 26, y + 24, z + 26);
    W.starfall = { x, z, y, orb, t: 0, phase: 'fall', life: 0 };
    if (typeof toast === 'function') toast('🌠 별똥별이 떨어졌어! 반짝이는 곳으로 가 보자');
  }
  function updateStarfall(dt) {
    const sf = W.starfall;
    if (!sf) {
      W.starTimer -= dt;
      if (W.starTimer <= 0) { W.starTimer = 42 + rnd() * 26; spawnStarfall(W.scene); }
      return;
    }
    if (sf.phase === 'fall') {
      sf.t += dt * 1.6;
      const k = Math.min(1, sf.t);
      const e = k * k;
      sf.orb.position.set(sf.x + 26 * (1 - e), sf.y + 0.9 + 24 * (1 - e), sf.z + 26 * (1 - e));
      if (k >= 1) { sf.phase = 'idle'; sf.life = 22; sf.orb.position.set(sf.x, sf.y + 0.9, sf.z); }
    } else if (sf.phase === 'idle') {
      sf.life -= dt;
      sf.orb.position.y = sf.y + 0.9 + Math.sin(W.t * 2.4) * 0.18;
      sf.orb.rotation.y += dt * 2;
      const d = Math.hypot(W.root.position.x - sf.x, W.root.position.z - sf.z);
      if (d < 2.2) {
        sf.phase = 'taken';
        collectStarfall();
      } else if (sf.life <= 0) {
        sf.phase = 'gone';
        try { sf.orb.dispose(); } catch (e) { }
        W.starfall = null;
      }
    }
  }
  async function collectStarfall() {
    const sf = W.starfall;
    let fxPos = null;
    try { if (sf) { fxPos = sf.orb.position.clone(); sf.orb.dispose(); } } catch (e) { }
    W.starfall = null;
    W.starTimer = 45 + rnd() * 25;
    try { collectFx(fxPos); } catch (e) { }   // ★ v1.73 L6 — 흡입 광휘 + 블룸 펄스
    if (typeof api !== 'function') return;
    try {
      const r = await api('/api/world/starfall', {});
      if (r.capped) { if (typeof toast === 'function') toast('🌠 오늘 별똥별은 여기까지!'); return; }
      if (r.balance != null && typeof setBalance === 'function') setBalance(r.balance);
      if (typeof toast === 'function') toast(`🌠 별똥별 획득! +${r.reward || 3}셀`);
      oneShot('Dance', 1400);
    } catch (e) { }
  }

  async function loadRobot(scene) {
    const res = await BABYLON.SceneLoader.ImportMeshAsync('', 'assets/', 'robot-expressive.glb', scene);
    const model = res.meshes[0];
    const bounds = model.getHierarchyBoundingVectors(true);
    const h = Math.max(0.1, bounds.max.y - bounds.min.y);
    const s = 2.3 / h;
    model.scaling.scaleInPlace(s);
    model.position.y = -bounds.min.y * s;

    const root = new BABYLON.TransformNode('worldRobotRoot', scene);
    model.parent = root;

    const col = (typeof effectiveColors === 'function' && typeof state !== 'undefined' && state.robot)
      ? effectiveColors(state.robot.template, state.robot.palette)
      : { body: '#5cc9a7', head: '#a8e6d0', antenna: '#ff9f43', arms: '#3d9e80', legs: '#2a7a63' };
    const darken = (hex, k) => BABYLON.Color3.FromHexString(hex).scale(k).toHexString();
    const cols = { Main: darken(col.body, 0.7), Grey: darken(col.head, 0.88), Black: '#131e2b' };
    const seen = new Set();
    res.meshes.forEach((m) => {
      const mats = m.material && m.material.subMaterials ? m.material.subMaterials : [m.material];
      mats.forEach((mat) => {
        if (!mat || seen.has(mat.uniqueId)) return;
        seen.add(mat.uniqueId);
        const hex = cols[mat.name];
        if (!hex) return;
        if (mat.albedoColor) {
          mat.albedoColor = BABYLON.Color3.FromHexString(hex);
          mat.metallic = 0.05; mat.roughness = 0.42; mat.environmentIntensity = 0.9;
        } else if (mat.diffuseColor) {
          mat.diffuseColor = BABYLON.Color3.FromHexString(hex);
          mat.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
        }
      });
      m.receiveShadows = true;
      if (W.shadow) W.shadow.addShadowCaster(m, false);
    });

    const anims = {};
    res.animationGroups.forEach((g) => { g.stop(); anims[g.name] = g; });
    if (anims.Idle) anims.Idle.start(true);

    root.position.set(0, heightAt(0, 12), 12);
    root.rotation.y = Math.PI;
    try {
      if (typeof addBlobShadow === 'function') {
        const blob = addBlobShadow(scene, 0, 0, 0.95, 0.5);
        if (blob) { blob.parent = root; blob.position.set(0, 0.03, 0); }
      }
    } catch (e) { /* 생략 */ }
    return { root, model, anims };
  }

  function setAnim(name, loop) {
    if (W.animLock && name !== 'Idle') return;
    if (W.animName === name) return;
    const a = W.anims[name] || W.anims.Idle;
    if (!a) return;
    Object.keys(W.anims).forEach((k) => { try { W.anims[k].stop(); } catch (e) { } });
    try { a.start(loop !== false, 1.0); } catch (e) { }
    W.animName = name;
  }
  function oneShot(name, ms) {
    setAnim(name, false);
    W.animLock = 1;
    setTimeout(() => { W.animLock = 0; W.animName = ''; setAnim('Idle'); }, ms || 1000);
  }

  // ══════════════ ★ 2026-11-21 (v1.73) L2 환경 시스템 + L3 표현 레이어 ══════════════
  //  «루미의 기억이 흐려지는 시간» — 밤은 플레이의 일부다. 미술은 이 세계관을 서비스한다.
  //  ── 3단계(바람 흔들림) 작업자 계약 필드 ──
  //   · W.dayNight : { t(0..1, 0=새벽), day(세계 날짜 정수), hour(0..24), isNight, nightK }
  //       현실 20분 = 세계 하루(DAY_LEN). updateEnvironment() 가 매 프레임 갱신.
  //   · W.weather  : { mode('clear'|'cloudy'|'rain'|'mist'), windStrength(0..1),
  //       fogBoost(0..0.8 — /api/lamps 의 decay≥50 등불 비율×0.8 «기억 안개»), cloud/rain/mist }
  //       windStrength 를 소비해 나뭇가지/옷/깃발 흔들림을 만들면 된다(이 파일에서는 계산만).
  //   · window.__rmiFogLevel : 0..1 — app.js 타워/등불 UI 가 읽을 수 있는 «실효 안개량»(느슨한 계약).
  //  ────────────────────────────────────────────────────────────────────

  const DAY_LEN = 1200;      // 현실 20분 = 세계 하루
  const DAY_START = 0.10;    // 마을 입장 시각 — 아침 햇살부터 시작(밤은 «이벤트» 처럼 찾아온다)

  // 오솔길 폴리라인 — buildVillage 의 createPath 와 dressPaths(길가 꾸미기)가 «같은 데이터» 를 쓴다.
  const PATH_LINES = [
    { pts: [[0, 26], [0.4, 20], [-0.5, 14], [-1.0, 8], [0, 2], [0.6, -3.5], [0.2, -9]], w: 2.8 },
    { pts: [[0, 2], [-5.5, -0.5], [-11, -3.5], [-16.5, -8.5]], w: 2.4 },
    { pts: [[0.2, -9], [5.5, -11.5], [11.5, -13.5], [17, -12]], w: 2.2 },
    { pts: [[0, 8], [6.5, 8.0], [12, 8.5], [16.5, 9.5]], w: 2.0 },
    { pts: [[-1.5, 10], [-9, 12], [-18, 15], [-28, 18], [-37, 19.5]], w: 1.9 },
    { pts: [[0.2, -14], [8, -20], [18, -25], [27, -30], [33, -32]], w: 1.9 },
    { pts: [[-13.5, -4], [-19, -12], [-25, -22], [-30, -32], [-33, -37]], w: 1.8 }
  ];
  // 집 배치 — buildVillage(스폰)·addWindowLights(밤 창불)·수면 반사 목록이 공유한다.
  const HOUSE_DEFS = [
    { k: 'house1', x: -11.5, z: -13.0, s: 1.0, rot: 0.24 },
    { k: 'house2', x: 11.0, z: -15.0, s: 1.0, rot: -0.3 },
    { k: 'house3', x: -10.0, z: -21.5, s: 0.95, rot: 0.1 },
    { k: 'house4', x: 9.0, z: -23.0, s: 0.95, rot: -0.16 },
    { k: 'inn', x: 0.5, z: -25.0, s: 0.95, rot: Math.PI },
    { k: 'blacksmith', x: -18.5, z: -16.5, s: 1.0, rot: 0.62 },
    { k: 'stable', x: 19.5, z: -18.5, s: 1.0, rot: -0.5 },
    { k: 'house1', x: -21.0, z: -8.0, s: 0.85, rot: 0.85 },
    { k: 'house3', x: 18.0, z: -6.0, s: 0.82, rot: -0.9 }
  ];

  // ── 낮밤 색 팔레트 — «지브리감» 키프레임(새벽 안개 파랑 → 정오 투명한 밝음 → 석양 금빛 주황 → 밤 짙은 남보라).
  //    숫자 필드: sunI(태양광 세기) hemiI(반광) lum(SkyMaterial luminance, 클수록 어두움)
  //    mie(빛 산란) star(별 밝기) night(밤 비중) fogD(안개 배수) win(창불) moon(달)
  const DN_KEYS = [
    { t: 0.00, sunI: 0.50, hemiI: 0.34, lum: 2.4, mie: 0.011, star: 0.50, night: 0.60, fogD: 1.55, win: 0.55, moon: 0.55,
      sunC: '#ffc9a0', hemiC: '#b9c8e6', hemiG: '#2e3550', fogC: '#c3d3e6', ccC: '#8fa7c9' },   // 새벽 — 안개 파랑
    { t: 0.06, sunI: 1.60, hemiI: 0.58, lum: 1.25, mie: 0.010, star: 0.02, night: 0.10, fogD: 1.15, win: 0.15, moon: 0,
      sunC: '#ffd9a8', hemiC: '#ffe2c4', hemiG: '#55503e', fogC: '#e2d3bd', ccC: '#ffd2a3' },   // 일출 — 금빛
    { t: 0.16, sunI: 2.10, hemiI: 0.72, lum: 1.0, mie: 0.0055, star: 0, night: 0, fogD: 1.0, win: 0, moon: 0,
      sunC: '#fff0d2', hemiC: '#fff3dd', hemiG: '#6a7a58', fogC: '#dfeaf2', ccC: '#abd9f4' },   // 아침
    { t: 0.50, sunI: 2.45, hemiI: 0.80, lum: 0.85, mie: 0.0042, star: 0, night: 0, fogD: 0.9, win: 0, moon: 0,
      sunC: '#fffdf2', hemiC: '#ffffff', hemiG: '#77856a', fogC: '#cfe6f2', ccC: '#9cd2f5' },   // 정오 — 투명한 밝음
    { t: 0.76, sunI: 2.05, hemiI: 0.70, lum: 1.0, mie: 0.006, star: 0, night: 0.05, fogD: 1.0, win: 0.08, moon: 0,
      sunC: '#ffe3b4', hemiC: '#ffedd2', hemiG: '#6e7a5c', fogC: '#dde4e2', ccC: '#c8ddef' },   // 늦은 오후
    { t: 0.87, sunI: 1.30, hemiI: 0.50, lum: 1.5, mie: 0.012, star: 0.12, night: 0.35, fogD: 1.2, win: 0.50, moon: 0.15,
      sunC: '#ff9d54', hemiC: '#ffd2a0', hemiG: '#5c5443', fogC: '#edb98a', ccC: '#ff9e66' },   // 석양 — 금빛 주황
    { t: 0.95, sunI: 0.42, hemiI: 0.20, lum: 6.0, mie: 0.006, star: 1.0, night: 1.0, fogD: 1.6, win: 0.95, moon: 1.0,
      sunC: '#a8bde9', hemiC: '#8497c4', hemiG: '#232c45', fogC: '#2a3554', ccC: '#1b2540' }    // 밤 — 짙은 남보라(달빛)
  ];
  DN_KEYS.push(Object.assign({}, DN_KEYS[0], { t: 1.0 }));   // wrap — 1.0 = 다음 날 새벽

  // 날씨 목표 가중치 — 모드 전환은 이 값들로 «수 초에 걸쳐» 블렌딩된다(하루 안에는 급변 없음).
  const WEATHER_TARGETS = {
    clear: { cloud: 0.04, rain: 0, mist: 0 },
    cloudy: { cloud: 0.72, rain: 0, mist: 0.10 },
    rain: { cloud: 0.95, rain: 1, mist: 0.14 },
    mist: { cloud: 0.30, rain: 0, mist: 0.85 }
  };

  let DN_OUT = null;   // dnSample 스크래치 — 매 프레임 할당 없이 재사용(GC 규율)

  function dnScratch() {
    if (!DN_OUT) {
      DN_OUT = {
        sunI: 0, hemiI: 0, lum: 1, mie: 0.005, star: 0, night: 0, fogD: 1, win: 0, moon: 0,
        sunC: new BABYLON.Color3(1, 1, 1), hemiC: new BABYLON.Color3(1, 1, 1),
        hemiG: new BABYLON.Color3(0.4, 0.45, 0.35), fogC: new BABYLON.Color3(0.72, 0.83, 0.92),
        ccC: new BABYLON.Color3(0.6, 0.79, 0.96)
      };
      DN_KEYS.forEach((k) => {
        k.sunC3 = BABYLON.Color3.FromHexString(k.sunC);
        k.hemiC3 = BABYLON.Color3.FromHexString(k.hemiC);
        k.hemiG3 = BABYLON.Color3.FromHexString(k.hemiG);
        k.fogC3 = BABYLON.Color3.FromHexString(k.fogC);
        k.ccC3 = BABYLON.Color3.FromHexString(k.ccC);
      });
    }
    return DN_OUT;
  }

  // dayNightLerp — t(0..1) 에서 팔레트 키프레임을 «wrap 보간» 해 하나의 샘플로 반환(재사용 객체).
  function dnSample(t) {
    const K = DN_KEYS;
    let i = 0;
    while (i < K.length - 1 && t > K[i + 1].t) i++;
    const a = K[i], b = K[Math.min(i + 1, K.length - 1)];
    const k = clamp((t - a.t) / Math.max(0.0001, b.t - a.t), 0, 1);
    const o = dnScratch();
    o.sunI = lerp(a.sunI, b.sunI, k); o.hemiI = lerp(a.hemiI, b.hemiI, k);
    o.lum = lerp(a.lum, b.lum, k); o.mie = lerp(a.mie, b.mie, k);
    o.star = lerp(a.star, b.star, k); o.night = lerp(a.night, b.night, k);
    o.fogD = lerp(a.fogD, b.fogD, k); o.win = lerp(a.win, b.win, k);
    o.moon = lerp(a.moon, b.moon, k);
    const mix = (d, ca, cb) => {
      d.r = lerp(ca.r, cb.r, k); d.g = lerp(ca.g, cb.g, k); d.b = lerp(ca.b, cb.b, k);
    };
    mix(o.sunC, a.sunC3, b.sunC3); mix(o.hemiC, a.hemiC3, b.hemiC3); mix(o.hemiG, a.hemiG3, b.hemiG3);
    mix(o.fogC, a.fogC3, b.fogC3); mix(o.ccC, a.ccC3, b.ccC3);
    return o;
  }

  // 결정론적 날씨 해시 — «세계 날짜» 의 순수 함수(새로고침해도 같은 날씨)
  function hash01(n) {
    const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return v - Math.floor(v);
  }
  // 기본: 맑음 50% / 흐림 25% / 비 15% / 아침안개 10% — «기억 안개»(fogBoost) 가 크면
  // 안개·비 비중이 그만큼 옮겨 간다(루미의 기억이 흐려진 마을 = 더 자주, 더 짙은 안개).
  function pickWeather(day) {
    const fb = W.weather ? W.weather.fogBoost : 0;
    const mistW = 0.10 + fb * 0.30;
    const rainW = Math.max(0.06, 0.15 - fb * 0.06);
    const cloudyW = Math.max(0.14, 0.25 - fb * 0.06);
    const r = hash01(day * 7.13 + 5.7);
    if (r < mistW) return 'mist';
    if (r < mistW + rainW) return 'rain';
    if (r < mistW + rainW + cloudyW) return 'cloudy';
    return 'clear';
  }

  function initEnvironment(scene, lights) {
    W.dayNight = { t: DAY_START, day: 0, hour: DAY_START * 24, isNight: false, nightK: 0 };
    W.weather = { mode: 'clear', cloud: 0, rain: 0, mist: 0, tCloud: 0, tRain: 0, tMist: 0,
      windStrength: 0.25, fogBoost: 0, day: -1 };
    W.hemi = lights.hemi; W.sun = lights.sun;
    W.sunDir = new BABYLON.Vector3(0.6, 0.7, -0.35);
    try { window.__rmiFogLevel = 0; } catch (e) { }
    createStarDome(scene);
    createMoon(scene);
    createFogPlanes(scene);
  }

  // ── 밤하늘 별돔 — 스프라이트 150개 대신 «텍스처 돔 1 드로우콜»(안개 영향도 안 받는다).
  function createStarDome(scene) {
    try {
      const S = 1024, H = S / 2;
      const dt = new BABYLON.DynamicTexture('wStarTex', { width: S, height: H }, scene, true);
      const g = dt.getContext();
      g.fillStyle = '#0a1024';   // 짙은 남색 배경 — 밤하늘 톤 보강(알파로 낮에 완전히 사라짐)
      g.fillRect(0, 0, S, H);
      for (let i = 0; i < 520; i++) {
        const band = nz(i, 301) < 0.42;   // 은하수 띠
        const x = nz(i, 302) * S;
        const y = band ? H / 2 + Math.sin(x / S * 6.28) * 40 + (nz(i, 303) - 0.5) * 70
          : nz(i, 304) * H;
        const r = 0.5 + nz(i, 305) * 1.6;
        const tint = nz(i, 306);
        const col = tint < 0.12 ? '255,222,180' : tint < 0.24 ? '188,212,255' : '255,255,255';
        g.fillStyle = 'rgba(' + col + ',' + (0.35 + nz(i, 307) * 0.65) + ')';
        g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
      }
      for (let i = 0; i < 10; i++) {   // 밝은 별 몇 개
        g.fillStyle = 'rgba(255,255,255,0.95)';
        g.beginPath(); g.arc(nz(i, 311) * S, nz(i, 312) * H, 2.2, 0, 6.283); g.fill();
      }
      dt.update(false);
      const m = new BABYLON.StandardMaterial('wStarMat', scene);
      m.emissiveTexture = dt;
      m.emissiveColor = new BABYLON.Color3(1, 1, 1);
      m.diffuseColor = new BABYLON.Color3(0, 0, 0);
      m.specularColor = new BABYLON.Color3(0, 0, 0);
      m.disableLighting = true;
      m.backFaceCulling = false;
      m.alpha = 0;
      const dome = BABYLON.MeshBuilder.CreateSphere('wStarDome',
        { diameter: 760, segments: 18, sideOrientation: BABYLON.Mesh.BACKSIDE }, scene);
      dome.material = m; dome.isPickable = false;
      dome.applyFog = false; dome.infiniteDistance = false;
      W.starDomeMat = m;
    } catch (e) { W.starDomeMat = null; }
  }

  // ── 달 — 태양 «대궤도» (밤에는 태양 자리에, 낮에는 지평선 반대편 아래로)
  function createMoon(scene) {
    try {
      const S = 128;
      const dt = new BABYLON.DynamicTexture('wMoonTex', { width: S, height: S }, scene, true);
      const g = dt.getContext();
      const gr = g.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S / 2);
      gr.addColorStop(0, 'rgba(255,248,224,1)');
      gr.addColorStop(0.52, 'rgba(255,244,212,0.98)');
      gr.addColorStop(0.62, 'rgba(240,236,214,0.5)');
      gr.addColorStop(1, 'rgba(226,232,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, 6.283); g.fill();
      for (let i = 0; i < 7; i++) {   // 크레이터 살짝
        g.fillStyle = 'rgba(214,206,186,' + (0.10 + nz(i, 324) * 0.14) + ')';
        g.beginPath();
        g.arc(S / 2 + (nz(i, 321) - 0.5) * S * 0.42, S / 2 + (nz(i, 322) - 0.5) * S * 0.42,
          3 + nz(i, 323) * 7, 0, 6.283);
        g.fill();
      }
      dt.update(false); dt.hasAlpha = true;
      const m = new BABYLON.StandardMaterial('wMoonMat', scene);
      m.emissiveTexture = dt; m.opacityTexture = dt;
      m.diffuseColor = new BABYLON.Color3(0, 0, 0);
      m.specularColor = new BABYLON.Color3(0, 0, 0);
      m.disableLighting = true; m.backFaceCulling = false; m.alpha = 0;
      const mesh = BABYLON.MeshBuilder.CreatePlane('wMoon', { size: 34 }, scene);
      mesh.material = m;
      mesh.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
      mesh.isPickable = false; mesh.applyFog = false;
      W.moonMesh = mesh;
    } catch (e) { W.moonMesh = null; }
  }

  // ── 지면 안개 시트(≤5장) — 호수/저지대에 깔리는 낮은 안개. 프로그램 노이즈 텍스처 +
  //    느린 표류·호흡. 밤/«기억 안개»(fogBoost)/아침안개 모드에서 짙어진다. W.fx.weather 가 통제.
  function fogTexture(scene, seed) {
    const Wd = 256, Hd = 128;
    const dt = new BABYLON.DynamicTexture('wFogTex' + seed, { width: Wd, height: Hd }, scene, true);
    const g = dt.getContext();
    g.clearRect(0, 0, Wd, Hd);
    for (let i = 0; i < 26; i++) {
      const x = nz(i + seed * 17, 201) * Wd;
      const y = Hd * 0.5 + (nz(i + seed * 19, 202) - 0.5) * Hd * 0.5;
      const r = 22 + nz(i + seed * 23, 203) * 46;
      const gr = g.createRadialGradient(x, y, 1, x, y, r);
      gr.addColorStop(0, 'rgba(232,238,247,' + (0.10 + nz(i + seed * 29, 204) * 0.12) + ')');
      gr.addColorStop(1, 'rgba(232,238,247,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
    }
    dt.update(false); dt.hasAlpha = true;
    dt.wrapU = BABYLON.Texture.WRAP_ADDRESSMODE;
    return dt;
  }
  function createFogPlanes(scene) {
    const spots = [
      [LAKE.x + 2, LAKE.z + 4, 20, 3.4], [LAKE.x - 5, LAKE.z - 5, 16, 2.8],
      [-14, 16, 18, 3.0], [10, 19, 16, 2.7], [-7, -20, 18, 3.1]
    ];
    const list = [];
    spots.forEach((s, i) => {
      try {
        const tex = fogTexture(scene, i);
        const p = BABYLON.MeshBuilder.CreatePlane('wFog' + i,
          { width: s[2], height: s[3], sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        p.position.set(s[0], groundY(s[0], s[1]) + s[3] * 0.22, s[1]);
        p.billboardMode = BABYLON.Mesh.BILLBOARDMODE_Y;
        const m = new BABYLON.StandardMaterial('wFogMat' + i, scene);
        m.emissiveTexture = tex; m.opacityTexture = tex;
        m.diffuseColor = new BABYLON.Color3(0, 0, 0);
        m.specularColor = new BABYLON.Color3(0, 0, 0);
        m.emissiveColor = new BABYLON.Color3(1, 1, 1);
        m.disableLighting = true; m.backFaceCulling = false; m.alpha = 0;
        p.material = m; p.isPickable = false; p.applyFog = false;
        p.setEnabled(false);            // applyFeature('weather') 이 켤 때까지 숨김
        p.__ph = nz(i, 210) * 6.283; p.__bx = s[0]; p.__tex = tex;
        list.push(p);
      } catch (e) { /* 시트 1장 실패는 생략 */ }
    });
    W.fogPlanes = list;
  }

  // ── 비 — GPU 파티클(≤1100) + 지면 파문 링(≤240). W.fx.weather && W.fx.particles 조건에서만 시작.
  function rainTexture(scene) {
    const dt = new BABYLON.DynamicTexture('wRainTex', { width: 32, height: 64 }, scene, true);
    const g = dt.getContext();
    g.clearRect(0, 0, 32, 64);
    const gr = g.createLinearGradient(0, 0, 0, 64);
    gr.addColorStop(0, 'rgba(190,214,240,0)');
    gr.addColorStop(0.5, 'rgba(200,220,245,0.75)');
    gr.addColorStop(1, 'rgba(190,214,240,0)');
    g.fillStyle = gr; g.fillRect(13, 0, 6, 64);
    dt.update(false); dt.hasAlpha = true;
    return dt;
  }
  function rippleTexture(scene) {
    const dt = new BABYLON.DynamicTexture('wRippleTex', { width: 64, height: 64 }, scene, true);
    const g = dt.getContext();
    g.clearRect(0, 0, 64, 64);
    g.strokeStyle = 'rgba(210,230,245,0.8)'; g.lineWidth = 3;
    g.beginPath(); g.arc(32, 32, 20, 0, 6.283); g.stroke();
    g.strokeStyle = 'rgba(210,230,245,0.35)'; g.lineWidth = 2;
    g.beginPath(); g.arc(32, 32, 26, 0, 6.283); g.stroke();
    dt.update(false); dt.hasAlpha = true;
    return dt;
  }
  function ensureRain(scene) {
    if (W.rainPs) return;
    try {
      const ps = new BABYLON.ParticleSystem('wRain', 1100, scene);
      ps.particleTexture = rainTexture(scene);
      W.rainE = new BABYLON.Vector3(0, 14, 0);
      ps.emitter = W.rainE;
      ps.minEmitBox = new BABYLON.Vector3(-24, 2, -24);
      ps.maxEmitBox = new BABYLON.Vector3(24, 8, 24);
      ps.direction1 = new BABYLON.Vector3(-0.12, -1, -0.05);
      ps.direction2 = new BABYLON.Vector3(0.12, -1, 0.05);
      ps.gravity = new BABYLON.Vector3(0, -9, 0);
      ps.minEmitPower = 10; ps.maxEmitPower = 14;
      // 수명 × 낙하속도 ≈ 18m — 방출 높이(지면+11m)에서 지면까지 «끝까지» 떨어지도록
      ps.minLifeTime = 0.9; ps.maxLifeTime = 1.3;
      ps.minSize = 1.4; ps.maxSize = 2.4;
      ps.color1 = new BABYLON.Color4(0.75, 0.85, 0.95, 0.30);
      ps.color2 = new BABYLON.Color4(0.78, 0.87, 0.96, 0.22);
      ps.colorDead = new BABYLON.Color4(0.7, 0.8, 0.9, 0);
      ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
      ps.emitRate = 0;
      ps.start();
      W.rainPs = ps;
      const rp = new BABYLON.ParticleSystem('wRipple', 240, scene);
      rp.particleTexture = rippleTexture(scene);
      W.rippleE = new BABYLON.Vector3(0, 0, 0);
      rp.emitter = W.rippleE;
      rp.minEmitBox = new BABYLON.Vector3(-20, 0, -20);
      rp.maxEmitBox = new BABYLON.Vector3(20, 0.4, 20);
      rp.direction1 = new BABYLON.Vector3(0, 0.02, 0);
      rp.direction2 = new BABYLON.Vector3(0, 0.06, 0);
      rp.minEmitPower = 0.01; rp.maxEmitPower = 0.05;
      rp.minLifeTime = 0.5; rp.maxLifeTime = 0.9;
      rp.minSize = 0.25; rp.maxSize = 0.75;
      rp.color1 = new BABYLON.Color4(0.85, 0.92, 0.98, 0.24);
      rp.color2 = new BABYLON.Color4(0.85, 0.92, 0.98, 0.16);
      rp.colorDead = new BABYLON.Color4(0.8, 0.9, 1, 0);
      rp.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
      rp.emitRate = 0;
      rp.start();
      W.ripplePs = rp;
    } catch (e) { W.rainPs = null; W.ripplePs = null; }
  }
  function stopRainFx() {
    try { if (W.rainPs && W.rainPs.isStarted) W.rainPs.stop(); } catch (e) { }
    try { if (W.ripplePs && W.ripplePs.isStarted) W.ripplePs.stop(); } catch (e) { }
  }

  // ── God rays — VLS post-process. high 전용(W.fx.godRays), 미지원 환경 무음 생략.
  //    weight 는 updateEnvironment 가 새벽/석양 창(t∈[0.03,0.12]∪[0.88,0.97])에서만 연다.
  function ensureGodRays() {
    if (W.godRayPP || !W.scene || !W.cam || !W.engine) return;
    if (!BABYLON.VolumetricLightScatteringPostProcess) return;
    try {
      if (!W.sunMesh) {
        const S = 128;
        const dt = new BABYLON.DynamicTexture('wSunTex', { width: S, height: S }, W.scene, true);
        const g = dt.getContext();
        const gr = g.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2);
        gr.addColorStop(0, 'rgba(255,246,214,1)');
        gr.addColorStop(0.35, 'rgba(255,224,150,0.55)');
        gr.addColorStop(1, 'rgba(255,210,120,0)');
        g.fillStyle = gr; g.fillRect(0, 0, S, S);
        dt.update(false); dt.hasAlpha = true;
        const m = new BABYLON.StandardMaterial('wSunMeshMat', W.scene);
        m.emissiveTexture = dt; m.opacityTexture = dt;
        m.diffuseColor = new BABYLON.Color3(0, 0, 0);
        m.specularColor = new BABYLON.Color3(0, 0, 0);
        m.disableLighting = true; m.backFaceCulling = false;
        const mesh = BABYLON.MeshBuilder.CreatePlane('wSunMesh', { size: 30 }, W.scene);
        mesh.material = m;
        mesh.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
        mesh.isPickable = false; mesh.applyFog = false;
        mesh.setEnabled(false);
        W.sunMesh = mesh;
      }
      const pp = new BABYLON.VolumetricLightScatteringPostProcess('wGodRays', 0.5, W.cam, W.sunMesh, 60,
        BABYLON.Texture.BILINEAR_SAMPLINGMODE, W.engine, false, W.scene);
      try { pp.exposure = 0.26; } catch (e) { }
      try { pp.decay = 0.9662; } catch (e) { }
      try { pp.weight = 0; } catch (e) { }
      try { pp.density = 0.94; } catch (e) { }
      W.godRayPP = pp;
    } catch (e) { W.godRayPP = null; }
  }
  function disposeGodRays() {
    try { if (W.godRayPP && W.cam) W.cam.detachPostProcess(W.godRayPP); } catch (e) { }
    try { if (W.godRayPP) W.godRayPP.dispose(); } catch (e) { }
    W.godRayPP = null;
    try { if (W.sunMesh) W.sunMesh.setEnabled(false); } catch (e) { }
  }

  // ── 밤 창불 — 집 GLB 위 «대표 창» emissive 패널(총 11개 — PointLight 추가 없음).
  //    낮 alpha 0 → 밤 palette.win 로 은은히 켜진다(공유 재질 1개).
  function addWindowLights(scene) {
    try {
      if (!W.windowMat) {
        W.windowMat = emissiveMat(scene, 'wWindowMat', '#ffcf7a', 1.35);
        W.windowMat.alpha = 0;
        W.windowMat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
        W.windowMat.backFaceCulling = false;
        W.windowMat.disableLighting = true;
      }
      if (!W.windowLights) W.windowLights = [];
      if (W.windowLights.length) return;
      HOUSE_DEFS.forEach((h, hi) => {
        const p = PROTO[h.k];
        const wrap = h.wrap && !h.wrap.isDisposed() ? h.wrap : null;
        if (!p || !wrap) return;
        const hw = p.w || 3, hd = p.d || 3, hh = p.targetH || 5;
        const spots = [[hw * 0.16, hh * 0.42, hd * 0.52]];
        if (hi === 1 || hi === 4) spots.push([-hw * 0.14, hh * 0.45, -hd * 0.52]);   // inn·house2 뒷창
        spots.forEach((o, oi) => {
          const q = BABYLON.MeshBuilder.CreatePlane('wWin' + hi + '_' + oi,
            { width: 0.62, height: 0.80, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
          q.position.set(o[0], o[1], o[2]);
          q.material = W.windowMat;
          q.isPickable = false;
          q.parent = wrap;
          W.windowLights.push(q);
        });
      });
    } catch (e) { /* 창불 실패는 조용히 */ }
  }

  // ── «기억 안개» — /api/lamps 의 decay≥50 등불 비율 p → fogBoost = p*0.8 (순수 읽기, 서버 불변).
  //    실패 시 fogBoost 0 무음. window.__rmiFogLevel 로 app.js UI 가 읽을 수 있다.
  async function fetchLampFog() {
    try {
      if (typeof api !== 'function') return;
      const r = await api('/api/lamps', undefined, 8000);
      if (!r || !Array.isArray(r.lamps) || !r.lamps.length) return;
      const dim = r.lamps.filter((l) => (l.decay | 0) >= 50).length;
      const p = dim / r.lamps.length;
      if (W.weather) W.weather.fogBoost = clamp(p * 0.8, 0, 0.8);
    } catch (e) { if (W.weather) W.weather.fogBoost = 0; }
  }

  // ── 길가 꾸미기 — 오솔길 가장자리에 마카롱색 꽃무리(≤64) + 자갈(≤46). nz 인덱스 노이즈만
  //    써서 «기존 배치 rnd 시퀀스를 1회도 소모하지 않는다». blockReason 으로 집/울타리 침범 방지.
  function dressPaths(scene) {
    try {
      let fi = 0, pi = 0;
      for (let li = 0; li < PATH_LINES.length; li++) {
        const L = PATH_LINES[li];
        const segs = [];
        let total = 0;
        for (let i = 0; i < L.pts.length - 1; i++) {
          const dx = L.pts[i + 1][0] - L.pts[i][0], dz = L.pts[i + 1][1] - L.pts[i][1];
          const len = Math.hypot(dx, dz);
          segs.push({ a: L.pts[i], b: L.pts[i + 1], dx, dz, len });
          total += len;
        }
        const steps = Math.floor(total / 2.4);
        for (let s = 0; s < steps; s++) {
          const want = (s + 0.5) / steps * total;
          let acc = 0, seg = segs[0], lt = 0;
          for (let i = 0; i < segs.length; i++) {
            if (acc + segs[i].len >= want) { seg = segs[i]; lt = (want - acc) / (segs[i].len || 1); break; }
            acc += segs[i].len;
          }
          const px = lerp(seg.a[0], seg.b[0], lt), pz = lerp(seg.a[1], seg.b[1], lt);
          const il = Math.hypot(seg.dx, seg.dz) || 1;
          const nx2 = -seg.dz / il, nzv = seg.dx / il;      // 진행 방향의 수직
          const side = nz(li * 131 + s, 71) > 0.5 ? 1 : -1;
          const off = L.w * 0.5 + 0.5 + nz(li * 137 + s, 72) * 1.0;
          const x = px + nx2 * side * off + (nz(li * 139 + s, 73) - 0.5) * 1.4;
          const z = pz + nzv * side * off + (nz(li * 149 + s, 74) - 0.5) * 1.4;
          if (heightAt(x, z) < WATER_Y + 0.28) continue;
          if (blockReason(x, z)) continue;                  // 건물/울타리/바위 위에는 심지 않는다
          if (fi < 64 && nz(li * 151 + s, 75) < 0.62) {
            spawn('flowers', x, z, 0.42 + nz(li * 157 + s, 76) * 0.30,
              nz(li * 163 + s, 77) * 6.28, { shadow: false, collide: false });
            fi++;
          } else if (pi < 46) {
            const k = nz(li * 167 + s, 78) < 0.5 ? 'rock2' : 'rock4';
            spawn(k, x, z, 0.13 + nz(li * 173 + s, 79) * 0.10,
              nz(li * 179 + s, 80) * 6.28, { shadow: false, collide: false, yOff: -0.04 });
            pi++;
          }
        }
      }
    } catch (e) { /* 길꾸미기 실패는 조용히 */ }
  }

  // ── 급경사자갈 — heightAt 유한차분으로 경사 판정(순수 함수라 난수 소모 없음). ≤160개,
  //    기존 instance 파이프라인(VEG_CULL 거리 컬링)을 그대로 탄다.
  function slopeRocks(scene) {
    try {
      let placed = 0;
      for (let i = 0; i < 640 && placed < 160; i++) {
        const a = nz(i, 81) * 6.283;
        const r = 20 + nz(i, 82) * 38;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (Math.hypot(x - LAKE.x, z - LAKE.z) < 13) continue;   // 호수 주변은 비운다
        if (heightAt(x, z) < WATER_Y + 0.3) continue;
        const e = 0.9;
        const sx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
        const sz2 = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
        if (Math.hypot(sx, sz2) < 0.62) continue;                // 평지엔 두지 않는다
        if (blockReason(x, z)) continue;
        const k = nz(i, 83) < 0.5 ? 'rock2' : 'rock4';
        spawn(k, x, z, 0.18 + nz(i, 84) * 0.20, nz(i, 85) * 6.28,
          { shadow: false, collide: false, yOff: -0.06 });
        placed++;
      }
    } catch (e) { /* 생략 */ }
  }

  // WaterMaterial 반납 — 강등/비high 단계에서 RTT 비용을 완전히 치운다(«내려가기만» 정책과 일치).
  function retireWaterWM() {
    if (!W.waterWM) return;
    try {
      const s = W.scene;
      [W.waterWM.reflectionTexture, W.waterWM.refractionTexture].forEach((t) => {
        if (t && s) {
          const i = s.customRenderTargets.indexOf(t);
          if (i >= 0) s.customRenderTargets.splice(i, 1);
        }
      });
      W.waterWM.dispose();
    } catch (e) { }
    W.waterWM = null;
  }

  // ── 환경 프레임 갱신 — 낮밤 진행 → 날씨 블렌딩 → 조명/하늘/안개/야간 요소 → 특수효과 구동.
  //    low/min 에서도 «핵심 낮밤» 는 동작한다(속성 갱신 수십 개 — CPU 비용 미미).
  function updateEnvironment(dt) {
    if (!W.scene || !W.dayNight || !W.weather) return;
    const dn = W.dayNight, wx = W.weather;

    // ① 시간 진행 — W.t(기존 누적 시계)를 그대로 소비(기존 update 체인과 충돌 없음)
    const ft = W.t / DAY_LEN + DAY_START;
    dn.t = ft % 1;
    dn.day = Math.floor(ft);
    dn.hour = dn.t * 24;

    // ② 날씨 — 세계 «날짜» 가 바뀔 때만 모드 결정(결정론), 전환은 수 초 블렌딩(급변 없음)
    if (wx.day !== dn.day) {
      wx.day = dn.day;
      wx.mode = pickWeather(dn.day);
      const T = WEATHER_TARGETS[wx.mode] || WEATHER_TARGETS.clear;
      wx.tCloud = T.cloud; wx.tRain = T.rain; wx.tMist = T.mist;
    }
    const bl = Math.min(1, dt / 22);
    wx.cloud += (wx.tCloud - wx.cloud) * bl;
    wx.rain += (wx.tRain - wx.rain) * bl;
    wx.mist += (wx.tMist - wx.mist) * bl;
    wx.windStrength = clamp(0.18 + wx.cloud * 0.3 + wx.rain * 0.55, 0, 1);   // 3단계 바람 소비

    // ③ 팔레트 샘플
    const pal = dnSample(dn.t);
    dn.nightK = pal.night;
    dn.isNight = pal.night > 0.55;

    // ④ 태양/달 궤적 — 낮: 동(+x)에서 서(-x)로 아치, 밤: 같은 궤도를 달이 대신 운행
    let dirX, dirY, dirZ, isSun;
    if (dn.t > 0.05 && dn.t < 0.95) {
      const a = (dn.t - 0.05) / 0.90 * Math.PI;
      dirX = Math.cos(a) * 0.85; dirY = Math.sin(a); dirZ = -0.42;
      isSun = true;
    } else {
      const ma = ((dn.t + 0.05) % 1) / 0.10 * Math.PI;
      dirX = Math.cos(ma) * 0.8; dirY = Math.sin(ma); dirZ = 0.45;
      isSun = false;
    }
    const LL0 = Math.hypot(dirX, dirY, dirZ) || 1;
    const sd = W.sunDir;
    sd.set(dirX / LL0, dirY / LL0, dirZ / LL0);
    // 그림자용 방향 — 지평선 직전의 «눕는 그림자» 는 아크네를 만들므로 최소 고도를 클램프
    const ly = Math.max(sd.y, 0.16);
    const LL = Math.hypot(sd.x, ly, sd.z) || 1;
    const dim = clamp(1 - wx.cloud * 0.30 - wx.rain * 0.42 - wx.mist * 0.18, 0.25, 1);
    if (W.sun) {
      W.sun.direction.set(-sd.x / LL, -ly / LL, -sd.z / LL);
      W.sun.position.set(sd.x * 90, ly * 90, sd.z * 90);   // 그림자 방향이 태양(밤엔 달)을 따라간다
      W.sun.intensity = pal.sunI * dim;
      W.sun.diffuse.copyFrom(pal.sunC);
    }
    if (W.hemi) {
      W.hemi.intensity = pal.hemiI * dim;
      W.hemi.diffuse.copyFrom(pal.hemiC);
      W.hemi.groundColor.copyFrom(pal.hemiG);
    }

    // ⑤ 하늘/안개/바탕색 — SkyMaterial·EXP2 안개가 하나의 팔레트를 따라간다
    if (W.skyMat) {
      W.skyMat.sunPosition.set(sd.x * 120, sd.y * 120, sd.z * 120);
      W.skyMat.luminance = pal.lum + wx.cloud * 1.1 + wx.rain * 1.6;
      W.skyMat.mieCoefficient = pal.mie + wx.rain * 0.004;
    }
    try {
      const cc = W.scene.clearColor;
      cc.r = pal.ccC.r; cc.g = pal.ccC.g; cc.b = pal.ccC.b;
      const fogk = clamp(wx.cloud * 0.35 + wx.rain * 0.45 + wx.mist * 0.25, 0, 1);
      W.scene.fogColor.set(lerp(pal.fogC.r, 0.60, fogk), lerp(pal.fogC.g, 0.65, fogk), lerp(pal.fogC.b, 0.72, fogk));
      W.scene.fogDensity = Math.min(0.0105, 0.0038 * pal.fogD * (1 + wx.fogBoost * 0.5 + wx.mist * 0.4));
    } catch (e) { }

    // ⑥ 야간 요소 — 별돔·달·창불
    if (W.starDomeMat) {
      const sa = pal.star * clamp(1 - wx.cloud * 0.5 - wx.rain * 0.7 - wx.mist * 0.3, 0, 1);
      if (Math.abs(W.starDomeMat.alpha - sa) > 0.004) W.starDomeMat.alpha = sa;
      // GlowLayer alpha 무시 방지 — 낮(emissiveIntensity 0)에는 별빛 블룸도 함께 꺼진다
      W.starDomeMat.emissiveIntensity = sa;
    }
    if (W.moonMesh) {
      const mA = pal.moon * clamp(1 - wx.cloud * 0.4, 0, 1);
      if (Math.abs(W.moonMesh.material.alpha - mA) > 0.004) W.moonMesh.material.alpha = mA;
      W.moonMesh.material.emissiveIntensity = mA * 1.2;
      if (mA <= 0.002 && W.moonMesh.isEnabled()) W.moonMesh.setEnabled(false);
      else if (mA > 0.002 && !W.moonMesh.isEnabled()) W.moonMesh.setEnabled(true);
      // 낮에는 «태양 반대편» 지평선 아래로 숨고, 밤에는 태양 궤도를 대신 달린다
      if (isSun) {
        W.moonMesh.position.set(-sd.x * 300, Math.max(30, -sd.y * 300), -sd.z * 300);
      } else {
        W.moonMesh.position.set(sd.x * 300, sd.y * 300, sd.z * 300);
      }
    }
    if (W.windowMat) {
      const wA = clamp(pal.win * (1 - wx.cloud * 0.25), 0, 0.9);
      if (Math.abs((W.windowMat.alpha || 0) - wA) > 0.01) W.windowMat.alpha = wA;
      // GlowLayer 는 alpha 0 인 mesh 의 emissive 도 찍는다 — 낮에는 emissive 강도도 0 으로
      // 죽여 «낮에 창이 희미하게 빛나는» 일이 없게 한다.
      W.windowMat.emissiveIntensity = wA * 1.5;
    }
    // disableLighting 재질의 «야간 디밍» — 원경 능선·호숫가 얕은 물 띠는 조명을 안 받는 재질이라
    // 밤 팔레트에 맞춰 수동으로 어둡게 죽인다(안 하면 밤에 «발광하는 언덕» 이 된다).
    const dk = 1 - dn.nightK * 0.82;
    if (W.ridgeMats) {
      for (let i = 0; i < W.ridgeMats.length; i++) {
        const r = W.ridgeMats[i];
        if (r && r.m) r.m.emissiveColor.set(r.base.r * dk, r.base.g * dk, r.base.b * dk);
      }
    }
    if (W.shoreMat) W.shoreMat.alpha = lerp(1, 0.45, dn.nightK);

    // ⑦ 구름 — 날씨 가중치로 알파/명도(기존 W.clouds 재사용, 새 드로우콜 없음)
    if (W.fx.weather && W.clouds.length) {
      const ck = Math.min(1, dt * 2.5);
      for (let i = 0; i < W.clouds.length; i++) {
        const c = W.clouds[i];
        if (c.__a0 == null) c.__a0 = c.color.a;
        const tgtA = Math.min(1, c.__a0 * (0.8 + wx.cloud * 0.55));
        c.color.a += (tgtA - c.color.a) * ck;
        const sh = clamp(1 - wx.cloud * 0.10 - wx.rain * 0.24, 0.55, 1);
        c.color.r = sh; c.color.g = sh; c.color.b = Math.min(1, sh * 1.05);
      }
    }

    // ⑧ 지면 안개 시트 — 밤/기억안개/아침안개에 두터워진다(호흡·표류 포함)
    if (W.fogPlanes && W.fogPlanes.length) {
      const vis = !!W.fx.weather;
      const base = 0.10 + dn.nightK * 0.16 + wx.fogBoost * 0.30 + wx.mist * 0.42 + wx.rain * 0.08;
      for (let i = 0; i < W.fogPlanes.length; i++) {
        const p = W.fogPlanes[i];
        if (!p || p.isDisposed()) continue;
        if (!vis) { if (p.isEnabled()) p.setEnabled(false); continue; }
        if (!p.isEnabled()) p.setEnabled(true);
        p.material.alpha = clamp(base * (0.75 + Math.sin(W.t * 0.23 + p.__ph) * 0.25), 0, 0.85);
        p.position.x = p.__bx + Math.sin(W.t * 0.045 + p.__ph) * 2.4;
        p.__tex.uOffset = (W.t * 0.004 + p.__ph * 0.13) % 1;
      }
    }

    // ⑨ 비 — fx.weather && fx.particles 에서만. 파티클 예산: 비 ≤1100, 파문 ≤240.
    const wantRain = !!W.fx.weather && !!W.fx.particles && wx.rain > 0.35 &&
      dn.t > 0.04 && dn.t < 0.97;
    if (wantRain && !W.rainPs) ensureRain(W.scene);
    if (W.rainPs) {
      const ps = W.rainPs;
      if (wantRain && W.root) {
        if (!ps.isStarted) ps.start();
        ps.emitRate = Math.floor(620 * wx.rain);
        const px = W.root.position.x, pz = W.root.position.z;
        W.rainE.set(px, groundY(px, pz) + 11, pz);
        if (W.ripplePs) {
          if (!W.ripplePs.isStarted) W.ripplePs.start();
          W.ripplePs.emitRate = Math.floor(80 * wx.rain);
          W.rippleE.set(px, groundY(px, pz) + 0.3, pz);
        }
      } else {
        if (ps.isStarted) ps.stop();
        if (W.ripplePs && W.ripplePs.isStarted) W.ripplePs.stop();
      }
    }

    // ⑩ 호수 거품선 + 수련 부유 — 물결 스위치(W.fx.waterWave)를 그대로 따른다
    if (W.foam && W.fx.waterWave && W.foam.isEnabled()) {
      W.foam.material.alpha = clamp(0.30 + Math.sin(W.t * 1.15) * 0.10 + wx.rain * 0.22, 0.08, 0.7);
    }
    if (W.fx.waterWave && W.lilyWraps && W.lilyWraps.length) {
      for (let i = 0; i < W.lilyWraps.length; i++) {
        const lp = W.lilyWraps[i];
        if (lp.w && !lp.w.isDisposed()) lp.w.position.y = lp.y + Math.sin(W.t * 1.25 + lp.ph) * 0.045;
      }
    }

    // ⑪ God rays — 새벽/석양 창에서만 빛나고 정오·밤에는 닫는다(high 전용)
    if (W.godRayPP) {
      const g1 = smoothstep(0.03, 0.055, dn.t) * (1 - smoothstep(0.10, 0.13, dn.t));
      const g2 = smoothstep(0.875, 0.895, dn.t) * (1 - smoothstep(0.945, 0.972, dn.t));
      const gk = Math.max(g1, g2) * (1 - wx.cloud * 0.55) * (1 - wx.rain * 0.85) * (1 - wx.mist * 0.4);
      W.godRayPP.weight = 0.9 * gk;
      if (W.sunMesh) {
        if (gk > 0.01 && isSun) {
          if (!W.sunMesh.isEnabled()) W.sunMesh.setEnabled(true);
          W.sunMesh.position.set(sd.x * 145, sd.y * 145, sd.z * 145);
        } else if (W.sunMesh.isEnabled()) {
          W.sunMesh.setEnabled(false);
        }
      }
    }

    // ⑫ 지형 bump 디테일 — 카메라 부무 길이로 «거리 페이드»(근접 0.5 ↔ 원거리 0.16)
    if (W.groundBump) {
      const br = W.cam ? W.cam.radius : 12;
      const lvl = lerp(0.5, 0.16, smoothstep(10, 22, br));
      if (Math.abs(W.groundBump.level - lvl) > 0.05) W.groundBump.level = lvl;
    }

    // ⑬ 실효 안개량 노출 — app.js 타워/등불 UI 의 «느슨한» 읽기 계약(하드 의존 없음)
    try {
      const fl = clamp(wx.fogBoost + wx.mist * 0.35, 0, 1);
      if (Math.abs((window.__rmiFogLevel || 0) - fl) > 0.01) {
        window.__rmiFogLevel = Math.round(fl * 1000) / 1000;
      }
    } catch (e) { }
  }

  // ══════════════ ★ 2026-11-21 (v1.73) L4 생명감 + L5 스토리 연동 + L6 마감 레이어 ══════════════
  //  «루미의 능력은 아이가 가르친 기억등에서 왔다» — 이 레이어의 효과는 세계가 아이의 학습에
  //  반응한다는 것을 보여 준다. 안개는 아직 배우지 못한 것, 빛기둥은 오늘의 과제, 수정은 굳어진 기억.
  //  예산 규율(v1.69 계약): PointLight 추가 0 — 전부 emissive+기존 GlowLayer. 새 재질 10개,
  //  새 파티클 ≤300(계절 120 + 수집 광휘 40), 프레임 로직은 O(가시 객체).
  //  전 효과가 W.fx 슬롯(applyFeature 실구현) + closeWorld 정리를 따른다.

  // ── L4-1/2. 바람 흔들림(바람 흔들림) + 잔디 굽힘 — CustomMaterial 정점 셰이더 주입(high·mid 만) ──
  //   • 잔디(grass/grass2): thin 소스 «재질» 하나만 바꾸면 thin/일반 인스턴스·clone 전부 함께 흔들린다.
  //   • 나무 수관(treeRound/treePine/treeWillow): «자식 중 부피 최대» 메시를 수관으로 택하고,
  //     수관 전용 재질을 새로 만들어(예산 3개) 몸통은 그대로 둔다. 멀티머티리얼 GLB 는 안전 생략.
  //   • heightFactor 는 «로컬 y» (인스턴스 스케일 불변), 위상·변위는 «월드 xz» — 한 번 주입으로
  //     thin/일반 인스턴스 전부 같은 바람을 맞는다.
  //   • 젖은 무게: 비·안개(rain/mist) 시 amp ×0.6 — updateLife 가 CPU 합산해 uWind 로 내린다.
  //   • low/min 회귀: revertWindSway 가 «원본 재질» 로 되돌리고 CustomMaterial 을 폐기한다.
  const SW = { wind: 0, dx: 1, dz: 0.2, bend: null };   // 셰이더 유니폼 CPU 상태(매 프레임 갱신)

  function makeSwayMaterial(scene, srcMat, opt) {
    try {
      if (!BABYLON.CustomMaterial || !srcMat || srcMat.subMaterials) return null;
      const cm = new BABYLON.CustomMaterial('wSwayM_' + opt.tag, scene);
      const tex = srcMat.albedoTexture || srcMat.diffuseTexture || null;
      if (tex) {
        cm.diffuseTexture = tex;
        if (tex.hasAlpha) { cm.diffuseTexture.hasAlpha = true; cm.useAlphaFromDiffuseTexture = true; }
      }
      const col = srcMat.albedoColor || srcMat.diffuseColor || null;
      if (col) cm.diffuseColor = col.clone();
      if (srcMat.emissiveColor) cm.emissiveColor = srcMat.emissiveColor.clone();
      if (srcMat.emissiveTexture) cm.emissiveTexture = srcMat.emissiveTexture;
      cm.alpha = (srcMat.alpha == null ? 1 : srcMat.alpha);
      if (srcMat.transparencyMode) cm.transparencyMode = srcMat.transparencyMode;
      if (cm.transparencyMode === BABYLON.Material.MATERIAL_ALPHATEST && cm.diffuseTexture) {
        cm.alphaCutOff = 0.4;
      }
      // 원본이 unlit 이면 그대로 unlit — 색이 어긋나지 않게
      if (srcMat.disableLighting) {
        cm.disableLighting = true;
        if (col) cm.emissiveColor = col.clone();
      }
      cm.backFaceCulling = false;              // 식물 계열 — commitThinGrass 도 양면으로 맞춰 둠
      cm.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
      if (srcMat.bumpTexture) cm.bumpTexture = srcMat.bumpTexture;

      cm.AddUniform('uTime', 'float');
      cm.AddUniform('uWind', 'float');
      cm.AddUniform('uAmp', 'float');
      cm.AddUniform('uFreq', 'float');
      cm.AddUniform('uMinY', 'float');
      cm.AddUniform('uHInv', 'float');
      cm.AddUniform('uDirX', 'float');
      cm.AddUniform('uDirZ', 'float');
      if (opt.bend) { cm.AddUniform('uBend', 'vec2'); cm.AddUniform('uBendOn', 'float'); }

      // 정점 변위 — local y → heightFactor, world xz → 위상·방향(인스턴스 회전과 무관하게
      // «같은 바람 방향» 이 되도록 worldPosUpdated 에 직접 더한다)
      cm.Vertex_After_WorldPosGenerated = `
        float _hf = clamp((positionUpdated.y - uMinY) * uHInv, 0.0, 1.0);
        _hf = _hf * _hf;
        float _ph = worldPosUpdated.x * 1.7 + worldPosUpdated.z * 1.3;
        float _sw = (sin(uTime * uFreq + _ph) + sin(uTime * uFreq * 2.17 + _ph * 1.31) * 0.35)
                  * uWind * uAmp * _hf;
        worldPosUpdated.x += uDirX * _sw;
        worldPosUpdated.z += uDirZ * _sw;` +
        (opt.bend ? `
        // player trample — bend grass tops away from the player (radius 1.2m)
        float _bd = distance(worldPosUpdated.xz, uBend);
        float _bk = (1.0 - smoothstep(0.15, 1.2, _bd)) * uBendOn * _hf;
        vec2 _aw = worldPosUpdated.xz - uBend;
        _aw /= max(0.05, length(_aw));
        worldPosUpdated.x += _aw.x * _bk * 0.20;
        worldPosUpdated.z += _aw.y * _bk * 0.20;` : '');
      // 유니폼은 «바인드 시점» 에 현재 상태를 읽어 넣는다(공식 onBindObservable 패턴)
      cm.onBindObservable.add(() => {
        const ef = cm.getEffect();
        if (!ef) return;
        ef.setFloat('uTime', W.t);
        ef.setFloat('uWind', SW.wind);
        ef.setFloat('uAmp', opt.amp);
        ef.setFloat('uFreq', opt.freq);
        ef.setFloat('uMinY', opt.minY);
        ef.setFloat('uHInv', opt.hInv);
        ef.setFloat('uDirX', SW.dx);
        ef.setFloat('uDirZ', SW.dz);
        if (opt.bend) {
          ef.setFloat('uBendOn', W.fx.grassBend ? 1.0 : 0.0);
          if (SW.bend) ef.setVector2('uBend', SW.bend);
        }
      });
      return cm;
    } catch (e) { return null; }
  }

  function attachSwayMesh(scene, mesh, opt) {
    if (!mesh || mesh.isDisposed() || !mesh.material ||
        !mesh.getTotalVertices || mesh.getTotalVertices() === 0) return false;
    if (mesh.__swayOn) return true;
    try {
      // ★ 주의 — thin 커밋 뒤 mesh.getBoundingInfo() 는 «모든 thin 인스턴스» 의 합집합
      //    바운딩으로 갱신돼 있다 → uHInv 가 망가진다. 로컬 «정점 데이터» 를 직접 훑어
      //    minY/maxY 를 구한다(재질당 1회 — 소스 정점 수 수준, 무시 가능).
      const pd = mesh.getVerticesData(BABYLON.VertexBuffer.PositionKind);
      let mnY = 0, mxY = 0.05;
      if (pd) {
        for (let i = 1; i < pd.length; i += 3) {
          if (pd[i] < mnY) mnY = pd[i];
          if (pd[i] > mxY) mxY = pd[i];
        }
      }
      const o = Object.assign({ amp: 0.15, freq: 2.4, bend: false, tag: mesh.name }, opt);
      o.minY = mnY;
      o.hInv = 1 / Math.max(0.05, mxY - mnY);
      const cm = makeSwayMaterial(scene, mesh.material, o);
      if (!cm) return false;
      W.sway.saved.push([mesh, mesh.material]);
      mesh.material = cm;
      W.sway.mats.push(cm);
      mesh.__swayOn = true;
      return true;
    } catch (e) { return false; }
  }

  function ensureWindSway() {
    const S = W.scene;
    if (!S || !BABYLON.CustomMaterial) return;
    if (!W.sway) W.sway = { mats: [], saved: [] };
    if (!SW.bend) SW.bend = new BABYLON.Vector2(0, 0);
    // ① 잔디 — thin 커밋 뒤에는 소스가 holder 밖으로 나오므로 p.inst.sources 경로로 찾는다
    ['grass', 'grass2'].forEach((key, ki) => {
      const p = PROTO[key];
      if (!p) return;
      const meshes = (p.inst && p.inst.sources) ? p.inst.sources.map((s) => s.mesh)
        : (p.holder ? p.holder.getChildMeshes(false) : []);
      meshes.forEach((m) => attachSwayMesh(S, m, { amp: 0.16, freq: 2.4 + ki * 0.5, bend: true, tag: key }));
    });
    // ② 나무 수관 — 대표 3종(새 재질 예산 3개). «자식 중 부피 최대» = 수관(단일 메시면 나무 전체).
    ['treeRound', 'treePine', 'treeWillow'].forEach((key) => {
      const p = PROTO[key];
      if (!p) return;
      const meshes = (p.inst && p.inst.sources) ? p.inst.sources.map((s) => s.mesh)
        : (p.holder ? p.holder.getChildMeshes(false) : []);
      let best = null, bestV = 0;
      meshes.forEach((m) => {
        if (!m.getTotalVertices || m.getTotalVertices() === 0) return;
        const bb = m.getBoundingInfo().boundingBox;
        const v = (bb.maximum.x - bb.minimum.x) * (bb.maximum.y - bb.minimum.y) * (bb.maximum.z - bb.minimum.z);
        if (v > bestV) { bestV = v; best = m; }
      });
      if (best) attachSwayMesh(S, best, { amp: 0.38, freq: 1.05, bend: false, tag: key });
    });
  }

  function revertWindSway() {
    const sw = W.sway;
    if (!sw) return;
    sw.saved.forEach((pr) => {
      const m = pr[0], om = pr[1];
      if (m && !m.isDisposed()) { try { m.material = om; } catch (e) { } }
      m.__swayOn = false;
    });
    sw.mats.forEach((cm) => { try { cm.dispose(); } catch (e) { } });
    sw.saved = []; sw.mats = [];
  }

  // ── L4-4. 호수 물고기 그림자 — 수면 밑 어두운 작은 타원 + 이따금 물결 링(high 전용) ──
  //   밤(nightK)에는 사라진다. 링은 «비 파문» 과 같은 패턴(원 텍스처 확장·페이드)을 재사용.
  function ensureFish(scene) {
    if (W.fish || !scene) return;
    try {
      const m = new BABYLON.StandardMaterial('wFishMat', scene);
      m.diffuseColor = new BABYLON.Color3(0.10, 0.20, 0.22);
      m.emissiveColor = new BABYLON.Color3(0.05, 0.10, 0.11);
      m.specularColor = new BABYLON.Color3(0, 0, 0);
      m.alpha = 0.55;
      const list = [];
      for (let i = 0; i < 7; i++) {
        const f = BABYLON.MeshBuilder.CreateSphere('wFish' + i, { diameter: 0.5, segments: 8 }, scene);
        f.scaling.set(1.15, 0.18, 0.5);
        f.material = m;
        f.isPickable = false;
        const a = nz(i, 61) * 6.283, r = 1.5 + nz(i, 62) * 5.5;
        const fx2 = LAKE.x + Math.cos(a) * r, fz2 = LAKE.z + Math.sin(a) * r;
        f.position.set(fx2, WATER_Y - 0.16, fz2);
        list.push({ m: f, x: fx2, z: fz2, a, spd: 0.45 + nz(i, 63) * 0.5,
          ph: nz(i, 64) * 6.283, ripT: 2 + nz(i, 65) * 7, vis0: 0.65 + nz(i, 66) * 0.35 });
      }
      W.rippleTex = W.rippleTex || rippleTexture(scene);
      const rm = new BABYLON.StandardMaterial('wFishRingMat', scene);
      rm.emissiveTexture = W.rippleTex;
      rm.opacityTexture = W.rippleTex;
      rm.diffuseColor = new BABYLON.Color3(0, 0, 0);
      rm.specularColor = new BABYLON.Color3(0, 0, 0);
      rm.emissiveColor = new BABYLON.Color3(1, 1, 1);
      rm.disableLighting = true;
      rm.backFaceCulling = false;
      rm.alpha = 0.6;
      const rings = [];
      for (let i = 0; i < 5; i++) {
        const r = BABYLON.MeshBuilder.CreateDisc('wFishRing' + i, { radius: 1, tessellation: 24 }, scene);
        r.rotation.x = Math.PI / 2;
        r.position.set(0, WATER_Y + 0.03, 0);
        r.material = rm;
        r.isPickable = false;
        r.visibility = 0;
        rings.push({ m: r, age: 9, x: 0, z: 0 });
      }
      W.fish = { mat: m, ringMat: rm, list, rings, ridx: 0 };
    } catch (e) { W.fish = null; }
  }
  function spawnFishRipple(x, z) {
    const F = W.fish;
    if (!F) return;
    const r = F.rings[F.ridx];
    F.ridx = (F.ridx + 1) % F.rings.length;
    r.x = x; r.z = z; r.age = 0;
    r.m.position.set(x, WATER_Y + 0.03, z);
    r.m.scaling.setAll(0.25);
  }
  function updateFish(dt, dn) {
    const F = W.fish;
    if (!F) return;
    // 밤에는 그림자가 사라진다(물고기도 잠든다) — «야간 생태» 는 dayNight.nightK 를 따른다
    const vis = clamp(1 - smoothstep(0.25, 0.55, dn.nightK || 0), 0, 1);
    for (let i = 0; i < F.list.length; i++) {
      const f = F.list[i];
      f.a += (nz(i + Math.floor(W.t * 0.4), 61) - 0.5) * dt * 1.6;   // 랜덤 워크 선회
      const r = Math.hypot(f.x - LAKE.x, f.z - LAKE.z);
      if (r > 7.5) {          // 호수 밖으로 나가면 중심을 향해 조금씩 조준
        const toC = Math.atan2(LAKE.z - f.z, LAKE.x - f.x);
        let d2 = toC - f.a;
        while (d2 > Math.PI) d2 -= Math.PI * 2;
        while (d2 < -Math.PI) d2 += Math.PI * 2;
        f.a += d2 * Math.min(1, dt * 2.2);
      }
      f.x += Math.cos(f.a) * f.spd * dt;
      f.z += Math.sin(f.a) * f.spd * dt;
      f.m.position.set(f.x, WATER_Y - 0.16 - (i % 3) * 0.07 + Math.sin(W.t * 1.2 + f.ph) * 0.035, f.z);
      f.m.rotation.y = -f.a;
      f.m.visibility = vis * f.vis0;
      f.ripT -= dt;
      if (f.ripT <= 0) { f.ripT = 3.5 + nz(i, 62) * 6.5; if (vis > 0.5) spawnFishRipple(f.x, f.z); }
    }
    for (let i = 0; i < F.rings.length; i++) {
      const rg = F.rings[i];
      if (rg.age >= 1.2) { if (rg.m.visibility !== 0) rg.m.visibility = 0; continue; }
      rg.age += dt;
      const k = clamp(rg.age / 1.2, 0, 1);
      rg.m.scaling.setAll(0.25 + k * 1.05);
      rg.m.visibility = (1 - k) * 0.55 * vis;
    }
  }

  // ── L4-5. 나비 — 꽃길(길가 꾸미기 꽃무리 구간) 위 4마리, 두 날개 삼각판 현 대칭 +
  //    랜덤 워크 방산. «오직 낮에만» (nightK 0.5 이상에서 숨는다).
  //    슬롯: W.fx.particles 재사용(보고서 명기) — 재질은 starRingM/signIron «재사용»(새 재질 0).
  const BUTTERFLY_SPOTS = [[1.8, 9.5], [-6.5, -1.5], [9.5, 8.2], [-14.5, 14.0]];
  function ensureButterflies(scene) {
    if (W.butterflies || !scene) return;
    try {
      const wingM = scene.getMaterialByName('starRingM');
      const bodyM = scene.getMaterialByName('signIron');
      // ★ 시점 순서 주의 — applyFeature('particles') 는 buildRest «전» 에도 불릴 수 있다.
      //   이때는 starRingM(createStars) 이 아직 없으므로 «건너뛰고», buildRest 마지막에서 재호출된다.
      if (!wingM) return;
      const list = [];
      for (let i = 0; i < BUTTERFLY_SPOTS.length; i++) {
        const sp = BUTTERFLY_SPOTS[i];
        const root = new BABYLON.TransformNode('wBfly' + i, scene);
        root.position.set(sp[0], groundY(sp[0], sp[1]) + 1.15, sp[1]);
        const body = BABYLON.MeshBuilder.CreateSphere('wBflyB' + i, { diameter: 0.07, segments: 6 }, scene);
        body.scaling.z = 2.2;
        body.material = bodyM || null;
        body.parent = root;
        body.isPickable = false;
        const vis = [body];
        const wings = [];
        [-1, 1].forEach((s) => {
          // 날개 축은 «진행축(+z)» — pivot.rotation.z 로 팔랑(±x 팁이 위아래로)
          const pv = new BABYLON.TransformNode('wBflyP' + i + (s > 0 ? 'R' : 'L'), scene);
          pv.parent = root;
          pv.position.set(s * 0.035, 0, 0);
          const w = BABYLON.MeshBuilder.CreateDisc('wBflyW' + i + (s > 0 ? 'R' : 'L'),
            { radius: 0.11, tessellation: 3, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
          w.rotation.x = Math.PI / 2;
          w.position.x = s * 0.09;
          w.material = wingM || null;
          w.parent = pv;
          w.isPickable = false;
          vis.push(w);
          wings.push({ pv, s });
        });
        list.push({ root, wings, vis, ax: sp[0], az: sp[1], a: nz(i, 71) * 6.283,
          rad: 1.4 + nz(i, 72) * 1.6, ph: nz(i, 73) * 6.283, turn: (nz(i, 74) - 0.5) * 1.6,
          px: sp[0], pz: sp[1] });
      }
      W.butterflies = list;
    } catch (e) { W.butterflies = null; }
  }
  function updateButterflies(dt, dn) {
    const dayK = 1 - smoothstep(0.25, 0.5, dn.nightK || 0);
    for (let i = 0; i < W.butterflies.length; i++) {
      const b = W.butterflies[i];
      if (dayK <= 0.01) {
        if (b.root.isEnabled()) b.root.setEnabled(false);
        continue;
      }
      if (!b.root.isEnabled()) b.root.setEnabled(true);
      b.a += b.turn * dt;
      const step = Math.floor(W.t * 0.6) + i * 7;
      if (nz(step, 75) > 0.93) b.turn = (nz(step, 76) - 0.5) * 3.4;   // 결정론 방향 전환(rnd 무소모)
      const tx = b.ax + Math.cos(b.a) * b.rad + Math.sin(W.t * 0.9 + b.ph) * 0.8;
      const tz2 = b.az + Math.sin(b.a) * b.rad + Math.cos(W.t * 0.7 + b.ph) * 0.8;
      const ty = groundY(b.ax, b.az) + 1.05 + Math.sin(W.t * 1.35 + b.ph) * 0.4;
      const kk = Math.min(1, dt * 1.6);
      const ox = b.px, oz2 = b.pz;
      b.px += (tx - b.px) * kk;
      b.pz += (tz2 - b.pz) * kk;
      b.root.position.set(b.px, ty, b.pz);
      const ddx = b.px - ox, ddz = b.pz - oz2;
      if (ddx * ddx + ddz * ddz > 1e-7) b.root.rotation.y = Math.atan2(ddx, ddz);
      const flap = 0.35 + Math.sin(W.t * 19 + b.ph) * 0.6;
      (b.wings || []).forEach((w) => { if (w.pv) w.pv.rotation.z = -w.s * flap; });
      for (let v = 0; v < b.vis.length; v++) b.vis[v].visibility = dayK;
    }
  }

  // ── L4-6. 깃발 — 풍차 옆·시장 옆·마을 입구 3면(기둥+천). 첫 물결은 CPU 정점파
  //    (CustomMaterial 예산을 바람 흔들림에 쓰므로 천은 7×7 격자 정점을 직접 흔든다 — 81점×3면 무시 가능).
  //    천 재질은 광장 수정구 «plazaOrbM» 을 재사용(새 재질 0) — 마을 깃발이 은은한 금빛.
  function ensureFlags(scene) {
    if (W.flags || !scene) return;
    try {
      const poleM = scene.getMaterialByName('signWoodMat');
      const clothM = scene.getMaterialByName('plazaOrbM');
      const spots = [
        { x: 23.8, z: -11.2, ry: -0.9 },    // 풍차 옆
        { x: -10.8, z: 0.6, ry: 0.7 },      // 시장 뒤편
        { x: 2.6, z: 13.6, ry: Math.PI }    // 마을 입구
      ];
      const list = [];
      spots.forEach((sp, i) => {
        if (blockReason(sp.x, sp.z)) return;   // 기존 소품과 겹치면 이 깃발은 생략
        const y = heightAt(sp.x, sp.z);
        const node = new BABYLON.TransformNode('wFlag' + i, scene);
        node.position.set(sp.x, y, sp.z);
        node.rotation.y = sp.ry;
        const pole = BABYLON.MeshBuilder.CreateCylinder('wFlagPole' + i,
          { height: 2.7, diameter: 0.075, tessellation: 8 }, scene);
        pole.position.set(0, 1.35, 0);
        pole.parent = node;
        pole.material = poleM || null;
        pole.isPickable = false; pole.receiveShadows = true; pole.castShadow = true;
        const cloth = BABYLON.MeshBuilder.CreateGround('wFlagCloth' + i,
          { width: 1.15, height: 0.62, subdivisions: 7, updatable: true,
            sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
        cloth.position.set(0.6, 2.56, 0);
        cloth.parent = node;
        cloth.material = clothM || null;
        cloth.isPickable = false;
        list.push({ node, cloth, x0: -0.575, wInv: 1 / 1.15, phase: nz(i, 81) * 6.28 });
        COLL.push({ x: sp.x, z: sp.z, r: 0.22 });
      });
      W.flags = list;
    } catch (e) { W.flags = null; }
  }
  function updateFlags(dt) {
    const FL = W.flags;
    if (!FL || !FL.length || !W.fx.cloth) return;   // fx.cloth 꺼짐 = «정적 천» 회귀
    const wind = W.weather ? W.weather.windStrength : 0.3;
    for (let fi = 0; fi < FL.length; fi++) {
      const f = FL[fi];
      f.phase += dt * (2.0 + wind * 3.2);
      const pos = f.cloth.getVerticesData(BABYLON.VertexBuffer.PositionKind);
      if (!pos) continue;
      const n = pos.length / 3;
      for (let i = 0; i < n; i++) {
        const lx = pos[i * 3];
        const k = clamp((lx - f.x0) * f.wInv, 0, 1);   // 깃대 0 → 끝 1
        pos[i * 3 + 1] = Math.sin(f.phase + lx * 4.5 + fi) * (0.03 + wind * 0.08) * k;
        pos[i * 3 + 2] = Math.cos(f.phase * 0.83 + lx * 3.4 + fi * 2) * (0.015 + wind * 0.05) * k;
      }
      f.cloth.updateVerticesData(BABYLON.VertexBuffer.PositionKind, pos);
    }
  }

  // ── L5-8. 의뢰 광기둥 + 탑 빛기둥 — emissive «원기둥 3단» (가시성 계단식 하강 = 상단 소멸).
  //    의뢰 3곳(우물·풍차·종탑)은 «오늘 의뢰가 남아 있을 때» 만 호박빛, 완료/미발급일 소등.
  //    탑(종탑을 이 세계의 탑으로 정한다)은 «탑 보스 주말»(세계 날짜 %7 ≥ 5)에만 얼음빛.
  //    emissive 재질 2개(호박·얼음) — 라이트 아님, add 와 무관하게 GlowLayer 가 번으로 보탠다.
  function makePillarSegs(scene, name, x, z, mat, hTotal, r0, visBase) {
    const segs = [];
    const y0 = groundY(x, z);
    for (let i = 0; i < 3; i++) {
      const h = hTotal / 3;
      const rB = r0 * (1 - i * 0.16), rT = r0 * (1 - (i + 1) * 0.16);
      const cyl = BABYLON.MeshBuilder.CreateCylinder(name + '_' + i,
        { height: h, diameterTop: Math.max(0.1, rT * 2), diameterBottom: Math.max(0.14, rB * 2), tessellation: 10 }, scene);
      cyl.position.set(x, y0 + h * i + h * 0.5, z);
      cyl.material = mat;
      cyl.isPickable = false;
      cyl.receiveShadows = false;
      cyl.visibility = visBase[i] || 0.3;
      segs.push(cyl);
    }
    return segs;
  }
  function ensurePillars(scene) {
    if (W.pillars || !scene) return;
    try {
      const amber = questMat(scene, 'wPillarAmber', '#ffd43b', 0.30);
      const ice = questMat(scene, 'wPillarIce', '#8fd0ff', 0.30);
      const visBase = [0.85, 0.42, 0.18];
      const quest = QUEST_SPOTS.map((sp, i) => ({
        key: sp.key, k: 0,
        segs: makePillarSegs(scene, 'wQPillar' + i, sp.x, sp.z, amber, 34, 0.5, visBase)
      }));
      const tower = { k: 0, segs: makePillarSegs(scene, 'wTPillar', -20.0, -2.0, ice, 40, 0.62, visBase) };
      W.pillars = { quest, tower, visBase };
    } catch (e) { W.pillars = null; }
  }
  function updatePillars(dt, dn) {
    const P = W.pillars;
    if (!P) return;
    const setSegs = (segs, k, ph) => {
      const pulse = 0.82 + Math.sin(W.t * 1.6 + ph) * 0.18;
      for (let si = 0; si < segs.length; si++) {
        const v = k * P.visBase[si] * pulse;
        const s = segs[si];
        s.visibility = v;
        if (v > 0.006) { if (!s.isEnabled()) s.setEnabled(true); }
        else if (s.isEnabled()) s.setEnabled(false);
      }
    };
    for (let i = 0; i < P.quest.length; i++) {
      const q = P.quest[i];
      const active = W.quests.length > 0 && !W.questDone.has(q.key);
      q.k += ((active ? 1 : 0) - q.k) * Math.min(1, dt * 1.8);
      setSegs(q.segs, q.k, i * 1.3);
    }
    const boss = (dn.day % 7) >= 5;
    P.tower.k += ((boss ? 1 : 0) - P.tower.k) * Math.min(1, dt * 1.1);
    setSegs(P.tower.segs, P.tower.k, 0.7);
  }

  // ── L5-10. «지혜의 샘» 안개 — L2 지면 안개 시트의 «영역 표현» 보강. 각 샘마다 2장,
  //    wFogMat0 재질 «재사용»(새 재질 0, 개별 농도는 mesh.visibility 로).
  //    당일 그 샘을 풀었으면(W.stations[i].solved) 안개가 걷힌다 — «답 맞추면 샘의 안개가 걦힌다».
  function ensureSpringFog(scene) {
    if (W.springFog || !scene) return;
    try {
      const srcMat = scene.getMaterialByName('wFogMat0');
      if (!srcMat) return;                     // L2 안개 시트가 없으면 생략
      const list = [];
      STATION_SPOTS.forEach((sp, i) => {
        for (let k = 0; k < 2; k++) {
          const x = sp.x + (nz(i * 2 + k, 91) - 0.5) * 4.6;
          const z = sp.z + (nz(i * 2 + k, 92) - 0.5) * 4.6;
          const p = BABYLON.MeshBuilder.CreatePlane('wSpringFog' + i + '_' + k,
            { width: 7.5, height: 2.7, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
          p.position.set(x, groundY(x, z) + 0.8, z);
          p.billboardMode = BABYLON.Mesh.BILLBOARDMODE_Y;
          p.material = srcMat;
          p.isPickable = false;
          p.applyFog = false;
          p.visibility = 0;
          p.__ph = nz(i * 3 + k, 93) * 6.283;
          p.__bx = x;
          list.push({ p, i });
        }
      });
      W.springFog = list;
    } catch (e) { W.springFog = null; }
  }
  function updateSpringFog(dn, wx) {
    const base = 0.34 + dn.nightK * 0.20 + wx.fogBoost * 0.35 + wx.mist * 0.30;
    for (let i = 0; i < W.springFog.length; i++) {
      const f = W.springFog[i];
      const st = W.stations[f.i];
      const solvedK = st && st.solved ? 0.10 : 1.0;
      f.p.visibility = clamp(base * solvedK * (0.8 + Math.sin(W.t * 0.19 + f.p.__ph) * 0.2), 0, 0.85);
      f.p.position.x = f.p.__bx + Math.sin(W.t * 0.035 + f.p.__ph) * 1.6;
    }
  }

  // ── L6-11. 계절 흩날림 — 세계 날짜 → 월(day%12 + 1). 3~5월 꽃잎 / 9~11월 낙엽 / 그 외 빛먼지.
  //    파티클 ≤120, 이미터가 플레이어를 따라다니고 «바람 가중» 은 중력 x 로 응답. W.fx.petals(high 전용).
  function petalTexture(scene, mode) {
    const S = 32;
    const dt = new BABYLON.DynamicTexture('wSeasonTex' + mode, { width: S, height: S }, scene, true);
    const g = dt.getContext();
    g.clearRect(0, 0, S, S);
    const gr = g.createRadialGradient(16, 16, 1, 16, 16, 14);
    if (mode === 0) {          // 꽃잎 — 연분홍
      gr.addColorStop(0, 'rgba(255,225,235,0.95)');
      gr.addColorStop(0.6, 'rgba(250,190,210,0.75)');
      gr.addColorStop(1, 'rgba(250,190,210,0)');
      g.fillStyle = gr;
      g.beginPath(); g.ellipse(16, 16, 13, 8, 0.6, 0, 6.283); g.fill();
    } else if (mode === 1) {   // 낙엽 — 주황
      gr.addColorStop(0, 'rgba(255,190,90,0.95)');
      gr.addColorStop(0.6, 'rgba(220,120,40,0.8)');
      gr.addColorStop(1, 'rgba(220,120,40,0)');
      g.fillStyle = gr;
      g.beginPath(); g.ellipse(16, 16, 13, 9, -0.5, 0, 6.283); g.fill();
    } else {                   // 빛먼지 — 옅은 금점
      gr.addColorStop(0, 'rgba(255,246,214,0.8)');
      gr.addColorStop(1, 'rgba(255,246,214,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(16, 16, 13, 0, 6.283); g.fill();
    }
    dt.update(false); dt.hasAlpha = true;
    return dt;
  }
  function ensurePetals(scene) {
    if (W.petals || !scene) return;
    try {
      const ps = new BABYLON.ParticleSystem('wSeason', 120, scene);
      ps.emitter = new BABYLON.Vector3(0, -60, 0);
      ps.minEmitBox = new BABYLON.Vector3(-8, 1.5, -8);
      ps.maxEmitBox = new BABYLON.Vector3(8, 4.5, 8);
      ps.direction1 = new BABYLON.Vector3(-1.4, -0.7, -0.9);
      ps.direction2 = new BABYLON.Vector3(0.5, -0.25, 0.9);
      ps.minEmitPower = 0.4; ps.maxEmitPower = 1.0;
      ps.gravity = new BABYLON.Vector3(0, -0.45, 0);
      ps.minAngularSpeed = -1.6; ps.maxAngularSpeed = 1.6;
      ps.minLifeTime = 5; ps.maxLifeTime = 9;
      ps.minSize = 0.10; ps.maxSize = 0.24;
      ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
      ps.emitRate = 0;
      ps.start();
      W.petals = { ps, tex: [petalTexture(scene, 0), petalTexture(scene, 1)], mode: -1 };
    } catch (e) { W.petals = null; }
  }
  function updatePetals(dt, dn, wx) {
    const P = W.petals;
    if (!P || !W.fx.petals || !W.fx.particles || !W.root) {
      if (P && P.ps.isStarted) P.ps.stop();
      return;
    }
    const month = (dn.day % 12) + 1;
    const mode = (month >= 3 && month <= 5) ? 0 : (month >= 9 && month <= 11) ? 1 : 2;
    if (mode !== P.mode) {
      P.mode = mode;
      P.ps.particleTexture = mode === 2 ? (W.smokeTex || P.tex[0]) : P.tex[mode];
      if (mode === 0) {
        P.ps.color1 = new BABYLON.Color4(1, 0.88, 0.92, 0.9);
        P.ps.color2 = new BABYLON.Color4(1, 0.8, 0.87, 0.6);
        P.ps.emitRate = 24; P.ps.minSize = 0.09; P.ps.maxSize = 0.2;
      } else if (mode === 1) {
        P.ps.color1 = new BABYLON.Color4(0.98, 0.72, 0.34, 0.95);
        P.ps.color2 = new BABYLON.Color4(0.88, 0.5, 0.2, 0.7);
        P.ps.emitRate = 18; P.ps.minSize = 0.12; P.ps.maxSize = 0.26;
      } else {
        P.ps.color1 = new BABYLON.Color4(1, 0.96, 0.82, 0.5);
        P.ps.color2 = new BABYLON.Color4(1, 0.9, 0.7, 0.3);
        P.ps.emitRate = 7; P.ps.minSize = 0.05; P.ps.maxSize = 0.12;
      }
      P.ps.colorDead = new BABYLON.Color4(1, 0.9, 0.8, 0);
    }
    // 플레이어 주변 우선 + 바람에 밀린다(중력 x = windStrength)
    P.ps.emitter.set(W.root.position.x, groundY(W.root.position.x, W.root.position.z) + 6.0, W.root.position.z);
    P.ps.gravity.x = (wx.windStrength || 0.2) * 2.2;
    if (!P.ps.isStarted) P.ps.start();
  }

  // ── L6-13. 발자국 — 오솔길 위를 걸을 때 0.6m 마다 한 쌍(4s 페이드, 24장 링 버퍼, 왼·오른 오프셋).
  //    빗물(rain)에 젖으면 더 어둡게. 재질 1개 «공유» + mesh.visibility 로 개별 페이드(예산 1).
  function onPath(x, z) {
    for (let li = 0; li < PATH_LINES.length; li++) {
      const L = PATH_LINES[li];
      const lim = L.w * 0.5 + 0.55;
      for (let i = 0; i < L.pts.length - 1; i++) {
        const ax = L.pts[i][0], az = L.pts[i][1];
        const vx = L.pts[i + 1][0] - ax, vz = L.pts[i + 1][1] - az;
        const len2 = vx * vx + vz * vz || 1;
        let t = ((x - ax) * vx + (z - az) * vz) / len2;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        const dx = ax + vx * t - x, dz = az + vz * t - z;
        if (dx * dx + dz * dz < lim * lim) return true;
      }
    }
    return false;
  }
  function ensurePrints(scene) {
    if (W.prints || !scene) return;
    try {
      const mat = new BABYLON.StandardMaterial('wPrintMat', scene);
      mat.diffuseColor = new BABYLON.Color3(0.12, 0.10, 0.08);
      mat.emissiveColor = new BABYLON.Color3(0.34, 0.28, 0.20);
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      mat.alpha = 0.9;
      mat.disableLighting = true;
      mat.zOffset = -5;
      const list = [];
      for (let i = 0; i < 24; i++) {
        const p = BABYLON.MeshBuilder.CreatePlane('wPrint' + i, { width: 0.16, height: 0.34 }, scene);
        p.rotation.x = Math.PI / 2;
        p.material = mat;
        p.isPickable = false;
        p.visibility = 0;
        list.push({ m: p, age: 5 });
      }
      W.prints = { mat, list, idx: 0, lx: 0, lz: 0, rainK: -1 };
      if (W.root) { W.prints.lx = W.root.position.x; W.prints.lz = W.root.position.z; }
    } catch (e) { W.prints = null; }
  }
  function spawnPrintPair(x, z, ry, nx, nzv) {
    const P = W.prints;
    for (let s = -1; s <= 1; s += 2) {
      const pr = P.list[P.idx];
      P.idx = (P.idx + 1) % P.list.length;
      const wx2 = x + nx * 0.13 * s, wz2 = z + nzv * 0.13 * s;
      pr.m.position.set(wx2, groundY(wx2, wz2) + (onPath(wx2, wz2) ? 0.13 : 0.04), wz2);
      pr.m.rotation.y = ry + (nz(P.idx, 66) - 0.5) * 0.3;
      pr.age = 0;
    }
  }
  function updatePrints(dt, wx) {
    const P = W.prints;
    if (!P || !W.root) return;
    const px = W.root.position.x, pz = W.root.position.z;
    const mvx = px - P.lx, mvz = pz - P.lz;
    const mv = Math.hypot(mvx, mvz);
    if (mv > 0.6) {
      P.lx = px; P.lz = pz;
      if (onPath(px, pz)) spawnPrintPair(px, pz, Math.atan2(mvx, mvz), -mvz / mv, mvx / mv);
    }
    for (let i = 0; i < P.list.length; i++) {
      const pr = P.list[i];
      if (pr.age >= 4) continue;
      pr.age += dt;
      const k = pr.age / 4;
      if (k >= 1) { pr.m.visibility = 0; pr.age = 4.01; continue; }
      pr.m.visibility = (1 - k) * 0.5 * (k < 0.08 ? k / 0.08 : 1);
    }
    const rainK = clamp(wx.rain, 0, 1);
    if (P.mat && Math.abs(rainK - P.rainK) > 0.05) {
      P.rainK = rainK;
      P.mat.emissiveColor.set(lerp(0.34, 0.15, rainK), lerp(0.28, 0.12, rainK), lerp(0.20, 0.09, rainK));
    }
  }

  // ── L6-12. 수집 순간 — «빛이 아이에게로» 흡입 광휘 + 아주 작은 블룸 펄스(+0.15 → 원복).
  //    파티클 40개 «하나» 를 재사용(manualEmitCount 버스트), 텍스처는 굴뚝 연기 텍스처 재활용(새 재질 0).
  function ensureSparkle(scene) {
    if (W.sparkle || !scene) return;
    try {
      W.smokeTex = W.smokeTex || smokeTexture(scene);
      const ps = new BABYLON.ParticleSystem('wSparkle', 40, scene);
      ps.particleTexture = W.smokeTex;
      ps.emitter = new BABYLON.Vector3(0, -60, 0);
      ps.minEmitBox = new BABYLON.Vector3(-0.22, 0, -0.22);
      ps.maxEmitBox = new BABYLON.Vector3(0.22, 0.35, 0.22);
      ps.direction1 = new BABYLON.Vector3(0, 1, 0);
      ps.direction2 = new BABYLON.Vector3(0.4, 1.6, 0.4);
      ps.minEmitPower = 1.4; ps.maxEmitPower = 2.6;
      ps.gravity = new BABYLON.Vector3(0, -0.6, 0);
      ps.minLifeTime = 0.32; ps.maxLifeTime = 0.62;
      ps.minSize = 0.10; ps.maxSize = 0.28;
      ps.color1 = new BABYLON.Color4(1, 0.92, 0.6, 0.95);
      ps.color2 = new BABYLON.Color4(1, 0.8, 0.42, 0.7);
      ps.colorDead = new BABYLON.Color4(1, 0.85, 0.5, 0);
      ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
      ps.emitRate = 0;
      ps.start();
      W.sparkle = ps;
    } catch (e) { W.sparkle = null; }
  }
  function collectFx(pos) {
    if (!pos) return;
    try {
      if (W.fx.particles && W.sparkle) {
        const ps = W.sparkle;
        ps.emitter.copyFrom(pos);
        if (W.root) {
          const dx = W.root.position.x - pos.x;
          const dy = (W.root.position.y + 1.2) - pos.y;
          const dz = W.root.position.z - pos.z;
          const L = Math.hypot(dx, dy, dz) || 1;
          const k = 3.4 / L;
          ps.direction1.set(dx * k - 0.7, dy * k - 0.4, dz * k - 0.7);
          ps.direction2.set(dx * k + 0.7, dy * k + 0.4, dz * k + 0.7);
        }
        ps.manualEmitCount = 22;
      }
      if (W.pipe && W.pipe.bloomEnabled) W.bloomT = 0.45;
    } catch (e) { }
  }

  // ── L6-15. DOF 순간 — «마을에 들어온 순간» / «수정화 순간» 2초만 심도 과장(high 전용) ──
  function pulseDof() {
    if (!W.fx.dof) return;
    if (!W.pipe || !W.pipe.depthOfField) return;
    W.dofT = 0.0001;
  }

  // ── L4/L5/L6 프레임 오케스트레이터 — update() 마지막에서 호출 ──
  function updateLife(dt) {
    if (!W.scene || !W.dayNight || !W.weather) return;
    const dn = W.dayNight, wx = W.weather;
    // ① 바람 상태 — «젖은 무게»: 비·안개 시 amp ×0.6 (바람은 windStrength 를 따른다)
    const wet = clamp(wx.rain * 0.8 + wx.mist * 0.6, 0, 1);
    SW.wind = W.fx.windSway ? wx.windStrength * lerp(1.0, 0.6, wet) : 0;
    const az = 0.85 + Math.sin(W.t * 0.021) * 0.9;   // 바람 방향이 아주 천천히 돈다
    SW.dx = Math.cos(az); SW.dz = Math.sin(az);
    if (SW.bend && W.root && W.fx.grassBend) {
      SW.bend.x = W.root.position.x; SW.bend.y = W.root.position.z;
    }
    // ② 호수 물고기 — 밤에 사라진다
    if (W.fx.fish && W.fish) updateFish(dt, dn);
    // ③ 나비 — 낮에만
    if (W.fx.particles && W.butterflies) updateButterflies(dt, dn);
    // ④ 의뢰 광기둥 + 탑 빛기둥
    if (W.pillars) updatePillars(dt, dn);
    // ⑤ 샘 안개 — weather 슬롯 재사용
    if (W.springFog) {
      if (W.fx.weather) updateSpringFog(dn, wx);
      else W.springFog.forEach((f) => { if (f.p.visibility !== 0) f.p.visibility = 0; });
    }
    // ⑥ 계절 흩날림
    if (W.fx.petals && W.petals) updatePetals(dt, dn, wx);
    // ⑦ 발자국
    if (W.fx.footprints && W.prints && W.root) updatePrints(dt, wx);
    // ⑧ 깃발 천파
    if (W.fx.cloth) updateFlags(dt);
    // ⑨ 화면 펄스 — 블룸(수집) + DOF(입장·수정화)
    if (W.bloomT > 0 && W.pipe) {
      W.bloomT -= dt;
      const kb = clamp(1 - W.bloomT / 0.45, 0, 1);
      try { W.pipe.bloomWeight = 0.20 + Math.sin(kb * Math.PI) * 0.15; } catch (e) { }
      if (W.bloomT <= 0) { try { W.pipe.bloomWeight = 0.20; } catch (e) { } W.bloomT = 0; }
    }
    if (W.dofT > 0) {
      W.dofT += dt;
      const kd = Math.min(1, W.dofT / 2.0);
      const sd2 = Math.sin(kd * Math.PI);
      try {
        W.pipe.depthOfFieldEnabled = true;
        W.pipe.depthOfField.fStop = lerp(28, 3.5, sd2);
        if (W.cam) W.pipe.depthOfField.focusDistance = W.cam.radius * 1000;
      } catch (e) { }
      if (kd >= 1) { try { W.pipe.depthOfFieldEnabled = false; } catch (e) { } W.dofT = 0; }
    }
    // ⑩ 카메라 미호흡 — 정지 3초 뒤 주기 6s 사인 부유(목표 ±0.15% 반경). «어떤 입력» 이든 즉시 해제.
    if (W.cam && W.root && W.open && (W.t - (W.__lastInput || 0)) > 3 &&
        !W.quizOpen && !W.chatOpen && !W.secretOpen && !W.vaultOpen) {
      W.cam.target.y += Math.sin(W.t * 1.047) * W.cam.radius * 0.0015;
    }
  }

  // ────────────────────────── 수집 / 업데이트 ──────────────────────────
  function collectStars() {
    if (!W.root) return;
    W.stars.forEach((s, starIdx) => {
      if (s.collected) return;
      const d = BABYLON.Vector3.Distance(W.root.position, s.node.position);
      if (d < 2.0) {
        s.collected = true;
        s.node.setEnabled(false);
        if (s.light) s.light.setEnabled(false);
        W.collected++;
        try { collectFx(s.node.position); } catch (e) { }   // ★ v1.73 L6 — 흡입 광휘 + 블룸 펄스
        // v1.37: 빛 조각 3개 → «의뢰 건너뛰기 1장». 서버가 하루 1장만 발급한다.
        if (typeof api === 'function') {
          api('/api/world/star', { star: starIdx }, 8000)
            .then(r => {
              if (r && r.skipReady) {
                W.questSkipReady = true;
                const chip = $('#world-quests');
                if (chip) chip.classList.add('can-skip');
                if (typeof toast === 'function') toast('🎫 의뢰 한 번 건너뛸 수 있어!');
              }
            }).catch(() => { });
        }
        const el = $('#world-stars'); if (el) el.textContent = `⭐ ${W.collected} / 3`;
        const hint = $('#world-hint');
        if (W.collected >= 3) {
          if (hint) hint.textContent = '🎉 마을 탐험 완료! 루미가 아주 기뻐해.';
          oneShot('Dance', 1800);
          if (typeof toast === 'function') toast('🎉 빛 조각 3개를 모두 찾았어!');
        } else {
          if (hint) hint.textContent = `빛 조각 ${W.collected}/3 · 조금만 더!`;
          oneShot('ThumbsUp', 900);
          if (typeof toast === 'function') toast(`⭐ 빛 조각 ${W.collected}/3`);
        }
      }
    });
  }

  // ★ 오늘 이미 주운 별 복원 — GET /api/world/quest 의 stars_collected(별 인덱스 배열)를 반영한다.
  //   식별자는 collectStars 가 POST /api/world/star 로 보내는 star 필드(0..2, createStars 배치 순서)와 같다.
  //   별이 아직 만들어지지 않았으면(buildRest 전) 조용히 건너뛰고, 만들어진 뒤 다시 호출된다.
  function applyCollectedStars() {
    if (!W.starsCollected || !W.starsCollected.length || !W.stars.length) return;
    let n = 0;
    W.stars.forEach((s, i) => {
      if (!s.collected && W.starsCollected.indexOf(i) >= 0) {
        s.collected = true;
        s.node.setEnabled(false);
        if (s.light) s.light.setEnabled(false);
      }
      if (s.collected) n++;
    });
    W.collected = n;
    const el = $('#world-stars');
    if (el) el.textContent = `⭐ ${n} / 3`;
    const hint = $('#world-hint');
    if (hint && n >= 3) hint.textContent = '🎉 마을 탐험 완료! 루미가 아주 기뻐해.';
  }

  function update(dt) {
    if (!W.scene) return;
    W.t += dt;
    // ★ 2026-11-21 (v1.73) L2 환경 — 낮밤·날씨·안개·야간 요소(모든 품질 단계에서 동작하는 핵심 미술)
    updateEnvironment(dt);
    // ★ 2026-11-21 (v1.73) FPS 프로브 — 2.5s 평균 < 26fps 가 2연속이면 한 단계 강등(내려가기만).
    //   active 는 buildRest 완료 시점에 켠다 — 백그라운드 GLB 로딩 히치로 오강하 하는 것을 막음.
    const pr = W.fxProbe;
    if (pr && pr.active) {
      pr.frames++; pr.time += dt;
      if (pr.time >= 2.5) {
        const fps = pr.frames / pr.time;
        pr.frames = 0; pr.time = 0;
        if (fps < 26) pr.low++; else pr.low = 0;
        if (pr.low >= 2) { pr.low = 0; downgradeWorldQuality(); }
      }
    }
    // ★ v1.73 거리 3환 컬링 — 0.5s 간격(플레이어 6m/s × 0.5s = 3m < 히스테리시스 8m 갭)
    W.vegTimer += dt;
    if (W.vegTimer >= 0.5) { W.vegTimer = 0; updateVegRings(); }
    // 물결 애니메이션 — W.fx.waterWave 가 꺼져 있으면 스크롤도 중단(정적 수면 회귀)
    if (W.fx.waterWave && W.waterBump) {
      W.waterBump.uOffset = (W.waterBump.uOffset + dt * 0.012) % 1;
      W.waterBump.vOffset = (W.waterBump.vOffset + dt * 0.019) % 1;
    }
    // 모닥불 흔들림
    W.fires.forEach((f, i) => {
      if (f.obj) {
        const k = 1 + Math.sin(W.t * 8 + f.phase) * 0.12;
        f.obj.scaling.y = k;
        f.obj.scaling.x = 2 - k;
      }
      if (f.light) {
        // ★ 2026-11-21 (v1.73) L2 — 밤에는 모닥불이 «주광원». 등 추가 없이 기존 3개 PointLight
        //   강도만 밤 비중(nightK)에 따라 최대 1.7배 부스트(루미의 기억이 흐려지는 밤의 가시성).
        const nk = W.dayNight ? W.dayNight.nightK : 0;
        f.light.intensity = (0.8 + Math.sin(W.t * 11 + i) * 0.22) * (1 + nk * 0.7);
      }
      // ★ 2026-11-21 (v1.73) L4 — 화염(불씨) 자체발광도 밤에 더 밝고 따뜻하게.
      //    흔들림 «같은 위상»(W.t*8 + phase) — 라이트 추가 없이 emissive 강도만(예산 불변).
      if (f.mat) {
        const nk2 = W.dayNight ? W.dayNight.nightK : 0;
        f.mat.emissiveIntensity = (1.0 + nk2 * 0.8) * (0.9 + Math.sin(W.t * 8 + f.phase) * 0.18);
      }
    });
    // v1.33 폭포 흐름 + 부유 쇄석 둥실거림
    if (W.fallTex) W.fallTex.vOffset = (W.fallTex.vOffset + dt * 0.30) % 1;
    W.floaters.forEach((f) => {
      f.m.position.y = f.base + Math.sin(W.t * f.sp + f.ph) * 0.22;
      f.m.rotation.y += dt * 0.26;
      f.m.rotation.x += dt * 0.11;
    });
    // 풍차
    // v1.36: 날개만 회전(집은 고정). null 이면 조용히 건너뛴다.
    W.windmills.forEach((w, i) => { if (w) w.rotation.z += dt * (0.55 + i * 0.1); });
    // 구름 / 새
    W.clouds.forEach((c) => {
      // ★ 2026-11-21 (v1.73) L2 — 표류 속도가 W.weather.windStrength 를 따른다(비바람에 몰리는 구름)
      c.position.x += dt * (0.55 + (W.weather ? W.weather.windStrength * 1.5 : 0));
      if (c.position.x > 128) c.position.x = -128;
    });
    if (W.birds && W.fx.birds) {   // ★ v1.73 fx.birds 가드 — 끄면 스프라이트 갱신 스킵
      // ★ 2026-11-21 (v1.73) L4 — 떼(boid) 비행: 무리 중심이 마을 큰 원을 도는데, 개체는
      //   «중심 주위 궤도 + 이웃 분리(separation) + 랜덤 워크» 로 따라 붙는다(n=7 — O(n²) 무시 가능).
      //   밤(nightK>0.5)에는 알파 페이드로 사라져 «나무에 앉은 셈» 이 되고, 낮이면 돌아온다.
      const nkB = W.dayNight ? W.dayNight.nightK : 0;
      const dayK = 1 - smoothstep(0.30, 0.55, nkB);
      const ca = W.t * 0.028;
      const ccx = Math.cos(ca) * 26, ccz = Math.sin(ca) * 26;
      const ccy = 16 + Math.sin(W.t * 0.07) * 3.5;
      const bs = W.birds;
      for (let i = 0; i < bs.length; i++) {
        const b = bs[i];
        if (!b.flock) continue;
        b.a += dt * b.spd * (1 + (W.weather ? W.weather.windStrength * 0.4 : 0));
        const wob = W.t * 0.9 + b.ph;
        let tx = ccx + Math.cos(b.a) * b.r + Math.sin(wob) * 1.3;
        let ty = ccy + b.y + Math.sin(wob * 0.77) * 0.8;
        let tz = ccz + Math.sin(b.a) * b.r + Math.cos(wob * 0.61) * 1.3;
        // 분리 — 이웃과 1.6m 이내면 밀어낸다
        for (let j = 0; j < bs.length; j++) {
          if (j === i || !bs[j].flock) continue;
          const o = bs[j];
          const dx = b.px - o.px, dy = b.py - o.py, dz = b.pz - o.pz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > 0.0001 && d2 < 2.56) {
            const inv = 1 / Math.sqrt(d2);
            tx += dx * inv * 1.4; ty += dy * inv * 0.7; tz += dz * inv * 1.4;
          }
        }
        const kk = Math.min(1, dt * 2.4);
        b.px += (tx - b.px) * kk;
        b.py += (ty - b.py) * kk;
        b.pz += (tz - b.pz) * kk;
        b.sp.position.set(b.px, b.py, b.pz);
        const tgtA = b.alpha0 * dayK;
        if (Math.abs(b.sp.color.a - tgtA) > 0.004) b.sp.color.a += (tgtA - b.sp.color.a) * Math.min(1, dt * 2);
      }
    }
    // 보물상자 비컨 둥실거림
    W.chests.forEach((c, i) => {
      if (c.claimed || !c.beacon) return;
      c.beacon.position.y = 1.75 + Math.sin(W.t * 2.2 + i) * 0.12;
      c.beacon.rotation.y += dt * 1.4;
    });
    // 지혜의 샘 — 수정 회전 + 근접 시 프롬프트
    W.stations.forEach((s, i) => {
      s.cry.rotation.y += dt * 0.9;
      s.ring.rotation.z += dt * 0.6;
      s.cry.position.y = 1.55 + Math.sin(W.t * 1.7 + i) * 0.07;
    });
    // 별 조각
    W.stars.forEach((s, i) => {
      if (s.collected) return;
      s.orb.rotation.y += dt * 0.9;
      s.ring.rotation.z += dt * 0.55;
      const yy = heightAt(s.node.position.x, s.node.position.z) + 1.55 + Math.sin(W.t * 1.6 + i) * 0.13;
      s.node.position.y = yy;
      if (s.light) s.light.position.y = yy;
    });
    if (!W.root || !W.cam) return;

    // v1.34: 대화 중에도 로봇이 걸어가면 안 된다 — 퀴즈와 같은 방식으로 입력을 비운다
    // ★ 2026-11-21 (v1.74) 빠른 이동 메뉴가 열려 있어도 같은 규칙(메뉴 아래에서 걷기 금지)
    const k = (W.quizOpen || W.chatOpen || W.secretOpen || W.warpOpen) ? {} : W.keys;
    const fwd = new BABYLON.Vector3(W.cam.target.x - W.cam.position.x, 0, W.cam.target.z - W.cam.position.z);
    if (fwd.length() < 0.001) fwd.set(0, 0, 1); else fwd.normalize();
    const right = BABYLON.Vector3.Cross(fwd, BABYLON.Axis.Y).normalize();
    const ix = (k.d ? 1 : 0) - (k.a ? 1 : 0);
    const iz = (k.w ? 1 : 0) - (k.s ? 1 : 0);
    const dir = fwd.scale(iz).add(right.scale(ix));
    let moving = false;

    if (dir.lengthSquared() > 0.001) {
      dir.normalize();
      moving = true;
      const speed = k.shift ? 6.0 : 3.6;
      const px = W.root.position.x, pz = W.root.position.z;
      const nx = px + dir.x * speed * dt;
      const nz = pz + dir.z * speed * dt;
      // 1) 완전 이동 → 2) 축별 슬라이드(벽에 붙어 미끄러지도록)
      let reason = blockReason(nx, nz);
      if (!reason) {
        W.root.position.x = nx;
        W.root.position.z = nz;
      } else {
        const rx = blockReason(nx, pz);
        const rz = blockReason(px, nz);
        if (!rx) { W.root.position.x = nx; reason = rz; }
        else if (!rz) { W.root.position.z = nz; reason = rx; }
        if (reason && W.t - W.waterBlocked > 5) {
          W.waterBlocked = W.t;
          const hint = $('#world-hint');
          const msg = reason === 'water' ? '💧 물에는 들어갈 수 없어요'
            : reason === 'edge' ? '🌲 여기서부터는 아직 길이 없어요'
            : '🚪 여기는 지나갈 수 없어요';
          if (hint) hint.textContent = msg;
          setTimeout(() => {
            const h = $('#world-hint');
            if (!h) return;
            h.textContent = W.collected >= 3
              ? '🎉 마을 탐험 완료! 루미가 아주 기뻐해.'
              : `빛 조각 ${W.collected}/3 · 조금만 더!`;
          }, 2200);
        }
      }
      const targetYaw = Math.atan2(dir.x, dir.z);
      let d = targetYaw - W.root.rotation.y;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      W.root.rotation.y += d * Math.min(1, dt * 11);
    }
    if (!W.grounded) {
      W.vy -= 13 * dt;
      W.air += W.vy * dt;
      if (W.air <= 0) { W.air = 0; W.vy = 0; W.grounded = true; }
    }
    // ★ 2026-11-21 (v1.73) L6 — 걷기 중이면 «입력 중» 으로 센다(터치 D패드는 keydown 이 없다 —
    //    키보드·터치 공통으로 카메라 미호흡이 즉시 풀리게 하는 단일 지점).
    if (moving) W.__lastInput = W.t;
    // 지면 추종: 경사에서 덜 튀도록 부드럽게
    const gy = heightAt(W.root.position.x, W.root.position.z) + W.air;
    W.root.position.y = W.grounded
      ? W.root.position.y + (gy - W.root.position.y) * Math.min(1, dt * 14)
      : gy;
    if (Math.abs(W.root.position.y - gy) > 2.2) W.root.position.y = gy;

    const desired = new BABYLON.Vector3(W.root.position.x, W.root.position.y + 1.3, W.root.position.z);
    W.cam.target = BABYLON.Vector3.Lerp(W.cam.target, desired, Math.min(1, dt * 7));

    // 카메라가 언덕/분지에 파묻히지 않도록 붐 길이를 줄였다가 서서히 복구
    const c = W.cam;
    if (c.radius > W.boomIdeal) W.boomIdeal = c.radius;   // 줌아웃은 그대로 존중
    let rad = c.radius;
    for (let i = 0; i < 8; i++) {
      const cx = c.target.x + rad * Math.cos(c.alpha) * Math.sin(c.beta);
      const cz = c.target.z + rad * Math.sin(c.alpha) * Math.sin(c.beta);
      const cy = c.target.y + rad * Math.cos(c.beta);
      if (cy > heightAt(cx, cz) + 1.15) break;
      rad -= 0.9;
      if (rad <= c.lowerRadiusLimit) { rad = c.lowerRadiusLimit; break; }
    }
    if (rad < c.radius) c.radius = rad;
    else if (c.radius < W.boomIdeal) c.radius = Math.min(W.boomIdeal, c.radius + dt * 5);
    W.lastRadius = c.radius;

    if (!W.animLock) {
      if (!W.grounded) setAnim('Jump', false);
      else if (moving) setAnim(k.shift ? 'Running' : 'Walking', true);
      else setAnim('Idle', true);
    }
    collectStars();

    // 학습 스테이션 · 보물상자 · «의뢰» 근접 판정
    let near = -1, nearType = '';
    // ★ 2026-11-21 (v1.74) 빠른 이동 메뉴가 열려 있으면 프롬프트 상태도 그대로 둔다
    if (!W.quizOpen && !W.chatOpen && !W.secretOpen && !W.vaultOpen && !W.warpOpen) {
      for (let i = 0; i < W.stations.length; i++) {
        const s = W.stations[i];
        if (s.solved) continue;
        if (Math.hypot(W.root.position.x - s.x, W.root.position.z - s.z) < 3.4) { nearType = 'station'; near = i; break; }
      }
      if (!nearType) {
        for (let i = 0; i < W.chests.length; i++) {
          const c = W.chests[i];
          if (c.claimed) continue;
          if (Math.hypot(W.root.position.x - c.x, W.root.position.z - c.z) < 2.4) { nearType = 'chest'; near = i; break; }
        }
      }
      // v1.37: 미완료 의뢰 표식에만 반응한다
      if (!nearType && W.quests.length) {
        for (let i = 0; i < QUEST_SPOTS.length; i++) {
          const q = QUEST_SPOTS[i];
          if (W.questDone.has(q.key)) continue;
          if (Math.hypot(W.root.position.x - q.x, W.root.position.z - q.z) < 3.4) {
            nearType = 'quest'; near = i; break;
          }
        }
      }
      // v1.39 별빛 저장고 — 광장 옆에 서 있는 «내가 고친 생각» 의 집
      if (!nearType && W.vaultSpot &&
          Math.hypot(W.root.position.x - W.vaultSpot.x, W.root.position.z - W.vaultSpot.z) < 3.6) {
        nearType = 'vault'; near = 0;
      }
      // v1.38: 마을 끝 이정표 — 다른 상호작용이 없을 때만 (가장 «뒤» 우선순위)
      if (!nearType && Math.hypot(W.root.position.x - SECRET_SPOT.x, W.root.position.z - SECRET_SPOT.z) < 3.2) {
        nearType = 'secret'; near = 0;
      }
    }
    W.nearQuest = nearType === 'quest' ? QUEST_SPOTS[near].key : null;
    if (nearType !== W.nearType || near !== W.near) {
      W.nearType = nearType;
      W.near = near;
      W.nearStation = nearType === 'station' ? near : -1;
      if (nearType) setPromptType(nearType);
      showPrompt(!!nearType);
    }
    // v1.37: 의뢰 표식이 둥실 떠 있는 느낌
    W.questMarks.forEach(m => {
      if (!m.orb.isEnabled()) return;
      m.orb.position.y = m.baseY + Math.sin(W.t * 1.8 + m.phase) * 0.12;
      m.orb.rotation.y += dt * 0.8;
    });
    updateStarfall(dt);
    updatePeers(dt);          // v1.35 친구 위치 보간·근접 판정
    updateCrystals(dt);       // ★ 2026-11-20 (v1.71) 수정 구슬 부유·자전
    updateLighthouse(dt);     // ★ v1.84 기억의 등대 — 켜진 등불 회전·밤 빛줄기
    updateRumi(dt);           // ★ 2026-11-20 (v1.71) 루미 NPC — 시간표·대기 부유·근접 판정
    updateLife(dt);           // ★ 2026-11-21 (v1.73) L4/L5/L6 — 생명감·스토리·마감 프레임 오케스트레이터
    // ★ 2026-11-21 (v1.74) — 빛의 조각 근접 팁(루미 팁 «뒤» 에 정리) + 빠른 이동 페이드 전환
    updateWarp(dt);
    updateShardTip();
  }

  // ────────────────────────── 마을 배치 ──────────────────────────
  function buildVillage(scene) {
    const S = scene;
    // ── 오솔길 (입구 → 광장 → 마을 안쪽)
    // ★ 2026-11-21 (v1.73) L2 — PATH_LINES 데이터를 길가 꾸미기(dressPaths)와 공유한다.
    //   «배열·순서·폭 원본 그대로» — rnd 시퀀스와 길 모양은 한 치도 흔들리지 않는다.
    PATH_LINES.forEach((L) => { createPath(S, L.pts, L.w); });

    makeSign(S, 2.9, 15.2, Math.PI - 0.08);

    // ── 집들
    // ★ 2026-11-21 (v1.73) L2 — HOUSE_DEFS 공유(밤 창불·수면 반사가 같은 배치를 읽는다).
    HOUSE_DEFS.forEach((h, hi) => {
      const w = spawn(h.k, h.x, h.z, h.s, h.rot, { shadow: true });
      if (w) {
        w.__kind = 'house';
        h.wrap = w;
        // 호수와 가까운 주요 건물만 수면 반사 목록에(WaterMaterial RTT 비용 통제)
        if (W.waterWM && Math.hypot(h.x - LAKE.x, h.z - LAKE.z) < 40) {
          w.getChildMeshes(false).forEach((m) => { try { W.waterWM.addToRenderList(m); } catch (e) { } });
        }
      }
    });
    addWindowLights(S);   // ★ v1.73 밤 창불(11개 emissive 패널 — PointLight 예산 불변)

    // ── 큰 구조물
    // ★ 2026-11-21 (v1.73) 수면 반사 등록 헬퍼 — 호수 40m 안의 구조물만(비용 통제)
    const reflectNearLake = (w, x, z) => {
      if (w && W.waterWM && Math.hypot(x - LAKE.x, z - LAKE.z) < 40) {
        w.getChildMeshes(false).forEach((m) => { try { W.waterWM.addToRenderList(m); } catch (e) { } });
      }
    };
    if (PROTO.mill) {
      const millWrap = spawn('mill', 26.5, -13.5, 1.05, -0.6, { shadow: true });
      if (millWrap) {
        // v1.36: Mill.glb 는 «집(Mill)» 과 «날개(Mill_Blades)» 가 따로 들어 있다.
        //   예전엔 spawn() 이 돌려준 «집 전체» 를 Z 축으로 계속 돌려서
        //   건물이 기울고 지붕에서 들보(날개 한 짝)가 튀어나오는 버그가 있었다.
        //   → 회전 대상은 «날개 노드 하나» 뿐이다.
        //   GLTF 의 Mill_Blades 는 «TransformNode 하나 + primitive 메시 4개» 로 쪼개져 있다.
        //   primitive 하나만 돌리면 그 날개짓이 축에서 떨어져 나가므로 «부모 노드» 를 돌린다.
        const blade = millWrap.getChildTransformNodes(false)
          .find((n) => /mill_?blades/i.test(n.name) && !/primitive/i.test(n.name));
        W.windmills.push(blade || null);
        if (!blade) console.warn('[world] Mill_Blades 를 찾지 못해 풍차를 회전하지 않습니다');
        reflectNearLake(millWrap, 26.5, -13.5);
      }
    }
    if (PROTO.belltower) spawn('belltower', -20.0, -2.0, 1.0, 0.2, { shadow: true });
    if (PROTO.well) reflectNearLake(spawn('well', 0.5, -8.5, 1.0, 0.3, { shadow: true }), 0.5, -8.5);
    if (PROTO.gazebo) reflectNearLake(spawn('gazebo', 15.5, -25.5, 1.0, -0.25, { shadow: true }), 15.5, -25.5);
    if (PROTO.market) {
      spawn('market', -5.0, -4.6, 1.0, 0.5, { shadow: true });
      spawn('market', 5.2, -4.2, 1.0, -0.55, { shadow: true });
    }

    // ── 소품
    const props = [
      ['cart', -8.5, -17.5, 1.0, 0.4],
      ['cart', 13.5, -20.0, 0.9, -1.1],
      ['hay', 6.5, -19.0, 1.0, 0.3], ['hay', 7.6, -20.4, 0.9, 1.4], ['hay', -16.0, -12.0, 0.85, 0.6],
      ['barrel', 8.2, -13.4, 1.0, 0], ['barrel', 8.9, -14.2, 0.9, 0.8], ['barrel', -13.4, -10.6, 1.0, 0.4],
      ['crate', -13.9, -18.4, 1.0, 0.2], ['crate', 12.6, -11.8, 0.9, 0.9], ['crate', 1.6, -22.6, 0.85, 0.3]
    ];
    props.forEach(([k, x, z, s, rot]) => spawn(k, x, z, s, rot, { shadow: true }));

    // ── 울타리: 농장 테두리 + 마을 입구 몇 조각
    const fenceRect = (x0, z0, x1, z1, step) => {
      const pts = [];
      for (let x = x0; x <= x1; x += step) { pts.push([x, z0, 0]); pts.push([x, z1, 0]); }
      for (let z = z0; z <= z1; z += step) { pts.push([x0, z, Math.PI / 2]); pts.push([x1, z, Math.PI / 2]); }
      pts.forEach(([x, z, ry]) => {
        if (heightAt(x, z) > WATER_Y + 0.2) spawn('fence', x, z, 1.0, ry, { shadow: true });
      });
    };
    fenceRect(26, 26, 40, 38, 2.35);            // 농장
    [[-9, 15.5, 0], [-6.4, 15.5, 0], [-3.8, 15.5, 0], [3.6, 15.5, 0], [6.2, 15.5, 0]].forEach(([x, z, ry]) => {
      spawn('fence', x, z, 1.0, ry, { shadow: true });   // 마을 입구
    });
    // ── 벤치
    [[-3.2, -9.6, 1.1], [3.4, -9.2, -1.1], [1.2, -3.0, 0.2]].forEach(([x, z, r]) => spawn('bench', x, z, 1.0, r, { shadow: true }));

    // ── 연기 (굴뚝)
    [[-11.5, -13.0], [11.0, -15.0], [0.5, -25.0], [9.0, -23.0]].forEach(([x, z]) => {
      makeSmoke(S, x + 0.9, heightAt(x, z) + 3.2, z + 0.5);
    });

    makeCampfire(S, -2.0, 4.2);
    makePlaza(S, -10.0, 4.0);      // v1.33 판석 광장 (입구 서쪽 공터)
  }

  function buildNature(scene) {
    // ── 숲 (마을 밖 고리 형태)
    // v1.33 변형 6종 추가. «배열 길이만» 바꾸면 rnd 소모 횟수는 그대로라
    //   나무 좌표 시퀀스가 보존되고 수종만 다양해진다.
    const treeKinds = ['treePine', 'treePine', 'treeRound', 'treeRound', 'treeBirch', 'treeWillow',
      'treeRound3', 'treeRound4', 'treeRound5', 'treeBirch2', 'treePine3', 'treeWillow2', 'treePine'];
    let placed = 0, guard = 0;
    while (placed < 380 && guard++ < 12000) {
      const a = rnd() * Math.PI * 2;
      const r = 21 + Math.pow(rnd(), 0.72) * 44;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = heightAt(x, z);
      if (h < WATER_Y + 0.35) continue;
      // 마을/길 위는 비우기
      if (Math.abs(x) < 19 && z > -30 && z < 26) continue;
      const kind = pickOne(treeKinds);
      if (!PROTO[kind]) continue;
      const s = rr(0.95, 1.8);
      spawn(kind, x, z, s, rr(0, 6.28), { shadow: s > 1.05 });
      placed++;
    }
    // ── 마을 안 정원 나무
    [[-6.2, -10.2, 0.9], [6.4, -9.6, 0.85], [-15.0, -22.0, 1.0], [14.8, -9.5, 0.95], [-4.0, -19.8, 0.8], [4.6, -27.5, 0.9]]
      .forEach(([x, z, s]) => spawn('treeRound', x, z, s, rr(0, 6.28), { shadow: true }));

    // ── 덤불
    for (let i = 0; i < 180; i++) {
      const a = rnd() * Math.PI * 2, r = 8 + rnd() * 56;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (heightAt(x, z) < WATER_Y + 0.3) continue;
      if (Math.abs(x) < 11 && z > -30 && z < 27) continue;
      // v1.33: rnd 소모 횟수를 원본과 동일하게(1 또는 2회) 유지하며 열매 덤불 변형만 섞는다
      const k = rnd() < 0.35
        ? (nz(i, 33) < 0.5 ? 'bushBerry' : 'bushBerry2')
        : (rnd() < 0.5 ? 'bush1' : 'bush2');
      spawn(k, x, z, rr(0.7, 1.5), rr(0, 6.28), { shadow: false });
    }
    // ── 바위
    const rockPoolPlain = ['rock', 'rock2', 'rock3', 'rock4'];
    const rockPoolMoss = ['rockMoss', 'rockMoss2'];
    for (let i = 0; i < 180; i++) {
      const a = rnd() * Math.PI * 2, r = 7 + Math.pow(rnd(), 0.8) * 58;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = heightAt(x, z);
      if (h < WATER_Y - 0.1) continue;
      // v1.33: rnd 1회는 그대로, 종류 선택만 인덱스 노이즈로 → 좌표 시퀀스 보존
      const pool = rnd() < 0.35 ? rockPoolMoss : rockPoolPlain;
      const k = pool[(nz(i, 31) * pool.length) | 0];
      spawn(k, x, z, rr(0.5, 1.25), rr(0, 6.28), { shadow: false, yOff: -0.12 });
    }
    // ── 호숫가 (수련잎은 물 안, 바위는 물가)
    for (let i = 0; i < 34; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 4.5 + rnd() * 7.6;
      const x = LAKE.x + Math.cos(a) * r, z = LAKE.z + Math.sin(a) * r;
      if (r < 7.2 && i % 2 === 0) {
        // ★ 2026-11-21 (v1.73) L3 — 가까운 수련 6장만 «wrap 단위» 미세 부유(인스턴스 행렬 갱신 없음)
        const lw = spawn('lilypad', x, z, rr(0.4, 0.75), rr(0, 6.28), { y: WATER_Y + 0.04, shadow: false });
        if (lw && W.lilyWraps.length < 6) {
          W.lilyWraps.push({ w: lw, y: WATER_Y + 0.04, ph: nz(i, 91) * 6.283 });
        }
      } else {
        const k = rockPoolPlain[(nz(i, 32) * rockPoolPlain.length) | 0];  // v1.33 호숫가도 바위 변형
        spawn(k, x, z, rr(0.4, 0.95), rr(0, 6.28), { shadow: false, yOff: -0.1 });
      }
    }
    // ══ 바깥 권역 거점 ══════════════════════════════════
    // 1) 돌원 (서쪽 언덕)
    (() => {
      const cx = -40, cz = 20, R = 4.4;
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2;
        const x = cx + Math.cos(a) * R, z = cz + Math.sin(a) * R;
        spawn('rockMoss', x, z, rr(1.5, 2.3), a, { shadow: true, yOff: -0.25 });
      }
      makeCampfire(scene, cx, cz);
      spawn('log', cx + 2.6, cz + 2.2, 1.2, 1.1, { shadow: true });
      spawn('log', cx - 2.4, cz + 2.4, 1.1, -0.9, { shadow: true });
    })();
    // 2) 전망대 (북동쪽 구릉)
    (() => {
      const cx = 34, cz = -34;
      if (PROTO.gazebo) spawn('gazebo', cx, cz, 1.05, -0.4, { shadow: true });
      spawn('bench', cx + 3.4, cz + 1.4, 1.0, -1.2, { shadow: true });
      spawn('bench', cx - 3.2, cz + 1.8, 1.0, 1.1, { shadow: true });
      [[cx - 5.5, cz + 4.2], [cx + 5.6, cz + 4.0], [cx, cz + 6.2]].forEach(([x, z]) => {
        spawn('hay', x, z, 0.9, rr(0, 6.28), { shadow: true });
      });
    })();
    // 3) 버드나무 숲 (남서쪽)
    (() => {
      const cx = -34, cz = -40;
      for (let i = 0; i < 9; i++) {
        const a = rr(0, 6.28), r = rr(1.5, 7.5);
        spawn('treeWillow', cx + Math.cos(a) * r, cz + Math.sin(a) * r, rr(0.95, 1.5), rr(0, 6.28), { shadow: true });
      }
      makeCampfire(scene, cx, cz);
      spawn('stump', cx + 2.2, cz - 1.8, 1.1, 0.4, { shadow: true });
      spawn('stump', cx - 1.8, cz + 2.0, 0.95, 2.1, { shadow: true });
    })();

    // ── 통나무 / 그루터기
    for (let i = 0; i < 30; i++) {
      const a = rnd() * Math.PI * 2, r = 16 + rnd() * 42;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (heightAt(x, z) < WATER_Y + 0.2) continue;
      spawn(rnd() < 0.5 ? 'stump' : 'log', x, z, rr(0.8, 1.3), rr(0, 6.28), { shadow: false });
    }
  }

  // 잔디·꽃 — clone 을 합쳐 드로우콜을 줄인다
  // ★ 2026-11-21 (v1.73) 잔디: 900 clone → MergeMeshes 대신 «thinInstance 행렬 버퍼» 로 수집.
  //   spawn() 이 THIN_KEYS 분기에서 grassThinCollect 로 보내므로, 여기는 «배치 루프의 rnd 소모
  //   횟수» 만 원본과 똑같이(2 rnd + 건너뛰기 분기 + nz + rr×2) 돌리고 커밋은 commitThinGrass 가
  //   buildRest 에서 1회 한다. 꽃·화분은 INSTANCED_KEYS 로 일반 instance 경로.
  function buildGroundCover(scene) {
    // 잔디 (많이, thinInstance 로 1~3 드로우콜) — v1.33 3종 변형을 인덱스 노이즈로 섞는다
    const grassPool = ['grass', 'grass2', 'grassShort'].filter(k => PROTO[k]);
    if (grassPool.length) {
      for (let i = 0; i < 900; i++) {
        const a = rnd() * Math.PI * 2, r = 5 + rnd() * 55;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (heightAt(x, z) < WATER_Y + 0.35) continue;
        const gk = grassPool[(nz(i, 35) * grassPool.length) | 0];
        spawn(gk, x, z, rr(0.7, 1.5), rr(0, 6.28), { shadow: false });
      }
    }
    // 꽃
    if (PROTO.flowers) {
      for (let i = 0; i < 230; i++) {
        const a = rnd() * Math.PI * 2, r = 5 + rnd() * 50;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (heightAt(x, z) < WATER_Y + 0.4) continue;
        spawn('flowers', x, z, rr(0.6, 1.1), rr(0, 6.28), { shadow: false });
      }
    }
    const plantPool = ['plant', 'plant2', 'plant3'].filter(k => PROTO[k]);
    if (plantPool.length) {
      for (let i = 0; i < 48; i++) {
        const a = rnd() * Math.PI * 2, r = 9 + rnd() * 52;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (heightAt(x, z) < WATER_Y + 0.4) continue;
        const pk = plantPool[(nz(i, 36) * plantPool.length) | 0];   // v1.33 풀잎 변형
        spawn(pk, x, z, rr(0.45, 0.8), rr(0, 6.28), { shadow: false });
      }
    }
  }

  // v1.33 원경 능선 — 지형(±92) 바깥에 «대기 원근» 3겹을 세워 깊이를 만든다.
  //   가까울수록 짙고 멀수록 옅은 청회색. 안개 대신 «링 자체의 3단 명도차» 로 사라진다.
  function createDistantRidges(scene) {
    // v1.33: 숲에 가리지 않되, EDGE_R(62) 밖으로 충분히 밀어 «검은 벽» 이 되지 않게 한다.
    //   가까울수록 짙은 녹회 → 멀수록 옅은 청회. 대기 원근은 색 3단으로만 표현한다.
    const rings = [
      { r: 106, h: 30, col: '#7f9c8c', seg: 72, jag: 0.30 },
      { r: 132, h: 42, col: '#9ab6b6', seg: 72, jag: 0.40 },
      { r: 158, h: 54, col: '#bdd2d4', seg: 72, jag: 0.48 }
    ];
    rings.forEach((R, ri) => {
      const bottom = [], top = [];
      for (let i = 0; i <= R.seg; i++) {
        const a = (i / R.seg) * Math.PI * 2;
        const rr2 = R.r + Math.sin(a * (6 + ri) + ri) * 4.5;
        const wave = 0.55 + 0.45 * (Math.sin(a * (7 + ri * 2) + ri * 1.7) + 1) * 0.5;
        const h = R.h * wave + nz(i, 40 + ri) * R.h * R.jag;
        bottom.push(new BABYLON.Vector3(Math.cos(a) * rr2, -8, Math.sin(a) * rr2));
        top.push(new BABYLON.Vector3(Math.cos(a) * rr2, h, Math.sin(a) * rr2));
      }
      const mesh = BABYLON.MeshBuilder.CreateRibbon('wRidge' + ri,
        { pathArray: [bottom, top], sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
      // v1.33: 링 «안쪽» 에서 보면 법선이 등져서 조명부가 0 이 되어 검은 벽이 됐다.
      //   disableLighting + emissiveColor 로 방향 무관 «순색» 을 출력한다.
      //   단, StandardMaterial+disableLighting 조합에 scene FOGMODE_EXP2 를 얹으면
      //   원거리 능선이 다시 «검은 벽» 으로 렌더링된다(진단: fog OFF 시 정상 청회색).
      //   → 이 메시는 안개에서 제외하고, rings 의 3단 명도차로 대기 원근을 만든다.
      const m = new BABYLON.StandardMaterial('wRidgeMat' + ri, scene);
      m.emissiveColor = BABYLON.Color3.FromHexString(R.col);
      m.diffuseColor = new BABYLON.Color3(0, 0, 0);
      m.specularColor = new BABYLON.Color3(0, 0, 0);
      m.disableLighting = true;
      m.backFaceCulling = false;
      mesh.material = m;
      mesh.isPickable = false;
      mesh.applyFog = false;
      m.fogEnabled = false;
      mesh.receiveShadows = false;
      // ★ 2026-11-21 (v1.73) L3 — 원경 능선을 수면 반사 목록에 넣어 호수에 하늘·능선이 비친다
      if (W.waterWM) { try { W.waterWM.addToRenderList(mesh); } catch (e) { } }
      // ★ v1.73 L2 — disableLighting 재질은 조명을 안 받으므로 밤 팔레트에 맞춰 «수동 디밍»
      //   (updateEnvironment 가 nightK 로 emissiveColor 를 낮춘다)
      if (!W.ridgeMats) W.ridgeMats = [];
      W.ridgeMats.push({ m, base: BABYLON.Color3.FromHexString(R.col) });
    });
  }

  // v1.33 마을 광장 — 판석을 «높이차·미세 회전» 으로 깔아 평면 타일 느낌을 없앤다.
  //   GLB 지형판은 원본 높이가 제각각이라 비율이 튀므로 여기선 절차적으로 만든다.
  function makePlaza(scene, cx, cz) {
    // v1.33: 밝은 회색은 ACES 노출에서 «하얀 타일» 로 날아가므로 한 톤 이상 낮춘다
    const light = pbr(scene, 'plazaLight', '#9c927c', 0.94, 0);
    const dark = pbr(scene, 'plazaDark', '#7d7462', 0.95, 0);
    const moss = pbr(scene, 'plazaMoss', '#6c8759', 0.96, 0);
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 6; col++) {
        const i = row * 6 + col;
        const x = cx + col * 0.94 + (nz(i, 50) - 0.5) * 0.20;
        const z = cz + row * 0.94 + (nz(i, 51) - 0.5) * 0.20;
        const slab = BABYLON.MeshBuilder.CreateBox('plazaSlab' + i,
          { width: 0.86 + nz(i, 52) * 0.05, height: 0.10, depth: 0.86 + nz(i, 53) * 0.05 }, scene);
        slab.position.set(x, heightAt(x, z) + 0.05 + nz(i, 54) * 0.012, z);
        slab.rotation.y = (nz(i, 55) - 0.5) * 0.24;
        slab.material = i % 7 === 0 ? moss : (i % 3 === 0 ? dark : light);
        slab.receiveShadows = true; slab.castShadow = true; slab.isPickable = false;
      }
    }
    // 광장 중앙의 낮은 표지석
    const px = cx + 2.35, pz = cz + 1.42;
    const base = BABYLON.MeshBuilder.CreateCylinder('plazaStone',
      { height: 0.42, diameterTop: 0.52, diameterBottom: 0.72, tessellation: 8 }, scene);
    base.position.set(px, heightAt(px, pz) + 0.30, pz);
    base.material = dark; base.receiveShadows = true; base.castShadow = true; base.isPickable = false;
    const orb = BABYLON.MeshBuilder.CreateSphere('plazaOrb', { diameter: 0.26, segments: 12 }, scene);
    orb.position.set(px, heightAt(px, pz) + 0.66, pz);
    orb.material = emissiveMat(scene, 'plazaOrbM', '#ffe6a6', 0.9);
    orb.isPickable = false;
  }

  // ────────────────────────── 초기화 ──────────────────────────
  function setLoadMsg(txt) {
    const el = $('#world-loading span');
    if (el) el.textContent = txt;
  }

  async function loadAllProps(scene, only, skip) {
    const jobs = [
      ['grass', 'nature', 'Grass', 0.28, { color: '#5da344' }],
      ['flowers', 'nature', 'Flowers', 0.42, null],
      ['plant', 'nature', 'Plant_1', 0.36, null],
      ['bush1', 'nature', 'Bush_1', 0.9, null],
      ['bush2', 'nature', 'Bush_2', 0.85, null],
      ['bushBerry', 'nature', 'BushBerries_1', 1.0, null],
      ['rock', 'nature', 'Rock_1', 0.55, null],
      ['rockMoss', 'nature', 'Rock_Moss_1', 0.5, null],
      ['stump', 'nature', 'TreeStump', 0.6, null],
      ['log', 'nature', 'WoodLog', 0.7, null],
      ['lilypad', 'nature', 'Lilypad', 0.34, { color: '#5f9e48' }],
      ['treeRound', 'nature', 'CommonTree_1', 7.0, null],
      ['treeRound2', 'nature', 'CommonTree_3', 6.2, null],
      ['treePine', 'nature', 'PineTree_1', 8.2, null],
      ['treePine2', 'nature', 'PineTree_3', 7.4, null],
      ['treeBirch', 'nature', 'BirchTree_1', 7.6, null],
      ['treeWillow', 'nature', 'Willow_1', 6.4, null],
      ['house1', 'village', 'House_1', 5.4, null],
      ['house2', 'village', 'House_2', 5.8, null],
      ['house3', 'village', 'House_3', 4.8, null],
      ['house4', 'village', 'House_4', 5.0, null],
      ['inn', 'village', 'Inn', 6.2, null],
      ['blacksmith', 'village', 'Blacksmith', 4.6, null],
      ['stable', 'village', 'Stable', 4.2, null],
      ['mill', 'village', 'Mill', 8.6, null],
      ['belltower', 'village', 'Bell_Tower', 9.4, null],
      ['well', 'village', 'Well', 2.6, null],
      ['market', 'village', 'MarketStand_1', 2.4, null],
      ['gazebo', 'village', 'Gazebo', 3.6, null],
      ['fence', 'village', 'Fence', 1.35, null],
      ['bench', 'village', 'Bench_1', 1.0, null],
      ['barrel', 'village', 'Barrel', 1.0, null],
      ['crate', 'village', 'Crate', 1.1, null],
      ['hay', 'village', 'Hay', 1.2, null],
      ['cart', 'village', 'Cart', 1.8, null],
      ['bonfire', 'village', 'Bonfire_Lit', 1.15, null],    // v1.33 모닥불 전용 GLB
      // v1.33 변형 에셋 — 같은 종류가 반복돼 «복붙 숲» 처럼 보이던 문제를 푼다
      ['treeRound3', 'nature', 'CommonTree_2', 6.6, null],
      ['treeRound4', 'nature', 'CommonTree_4', 6.8, null],
      ['treeRound5', 'nature', 'CommonTree_5', 7.2, null],
      ['treeBirch2', 'nature', 'BirchTree_2', 7.2, null],
      ['treePine3', 'nature', 'PineTree_2', 7.8, null],
      ['treeWillow2', 'nature', 'Willow_2', 6.0, null],
      ['rock2', 'nature', 'Rock_2', 0.5, null],
      ['rock3', 'nature', 'Rock_4', 0.62, null],
      ['rock4', 'nature', 'Rock_5', 0.44, null],
      ['rockMoss2', 'nature', 'Rock_Moss_2', 0.46, null],
      ['bushBerry2', 'nature', 'BushBerries_2', 0.92, null],
      ['grass2', 'nature', 'Grass_2', 0.26, { color: '#63a94a' }],
      ['grassShort', 'nature', 'Grass_Short', 0.16, { color: '#6aad4e' }],
      ['plant2', 'nature', 'Plant_2', 0.34, null],
      ['plant3', 'nature', 'Plant_3', 0.30, null]
    ];
    // only 가 주어지면 해당 키만 로드 (점진 로딩 1단계 = 마을)
    let queue = only ? jobs.filter(j => only.indexOf(j[0]) >= 0) : jobs;
    if (skip) queue = queue.filter(j => skip.indexOf(j[0]) < 0);
    let done = 0, idx = 0;
    const total = queue.length;
    const worker = async () => {
      while (idx < queue.length) {
        if (W.scene !== scene) return;   // ★ 닫는 도중이면 남은 에셋 로드를 중단
        const [key, folder, file, h, opt] = queue[idx++];
        try {
          await loadProto(scene, key, folder, file, h, opt);
        } catch (e) {
          console.warn('[world] 에셋 실패', key, e && e.message);
        }
        done++;
        if (done % 3 === 0 || done === total) setLoadMsg(`AI 마을을 짓는 중… ${done}/${total}`);
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
  }

  async function initWorld() {
    W.cancelBuild = false;   // ★ 새 빌드 시작 — 이전 «로딩 중 닫기» 플래그 해제
    // ★ 실패한 이전 시도의 엔진/씬이 남아 있으면 먼저 폐기한다 — WebGL 컨텍스트 누수(상한 ~16개) 방지
    if (W.engine) {
      try { W.engine.stopRenderLoop(); } catch (e) { }
      try { if (W.scene) W.scene.dispose(); } catch (e) { }
      try { W.engine.dispose(); } catch (e) { }
      W.engine = null; W.scene = null;
    }
    const canvas = $('#world3d');
    const engine = new BABYLON.Engine(canvas, true, {
      preserveDrawingBuffer: true, stencil: true, adaptToDeviceRatio: true,
      antialias: true, powerPreference: 'high-performance'
    });
    const scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0.6, 0.79, 0.96, 1);
    scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
    scene.fogColor = new BABYLON.Color3(0.72, 0.83, 0.92);
    scene.fogDensity = 0.0038;
    scene.ambientColor = new BABYLON.Color3(0.3, 0.32, 0.3);
    scene.skipPointerMovePicking = true;
    W.engine = engine; W.scene = scene;
    // ★ 취소(Esc/✕ 닫기)·씬 교체 감지 — await 사이마다 확인해 뒤처리를 중단한다
    const dead = () => W.cancelBuild || W.scene !== scene;
    const abort = () => {
      try { engine.stopRenderLoop(); } catch (e) { }
      try { scene.dispose(); } catch (e) { }
      try { engine.dispose(); } catch (e) { }
      if (W.scene === scene) { W.scene = null; W.engine = null; }
      const err = new Error('마을 만들기가 취소되었어요');
      err.cancelled = true;
      throw err;
    };

    await waitFor(() => BABYLON.SkyMaterial, 4000);
    if (dead()) abort();
    setLoadMsg('하늘을 만드는 중…');
    createSky(scene);
    const lights = createLights(scene);
    // ★ 2026-11-21 (v1.73) L2 환경 시스템 기동 — 낮밤 팔레트·날씨·별돔·달·지면 안개 시트 준비.
    //    물(WaterMaterial)은 createTerrain 안에서 만들어지고, applyWorldQuality 가 티어에 맞게 스왑한다.
    initEnvironment(scene, lights);

    setLoadMsg('땅을 만드는 중…');
    createTerrain(scene);
    createDistantRidges(scene);    // v1.33 원경 능선 3겹 (에셋 로딩과 무관)

    // 로봇 (GLTF 로더 준비 대기)
    await waitFor(() => BABYLON.SceneLoader &&
      (!BABYLON.SceneLoader.IsPluginForExtensionAvailable || BABYLON.SceneLoader.IsPluginForExtensionAvailable('.glb')), 6000);
    if (dead()) abort();

    // ── 1단계: 마을에 필요한 에셋만 먼저 (건물·소품 + 정원 나무)
    const CORE_KEYS = ['house1', 'house2', 'house3', 'house4', 'inn', 'blacksmith',
      'stable', 'mill', 'belltower', 'well', 'market', 'gazebo', 'fence', 'bench',
      'barrel', 'crate', 'hay', 'cart', 'treeRound', 'treeBirch', 'bonfire'];
    setLoadMsg('마을을 짓는 중…');
    await loadAllProps(scene, CORE_KEYS);
    if (dead()) abort();
    buildVillage(scene);

    setLoadMsg('루미를 데려오는 중…');
    const loaded = await loadRobot(scene);
    if (dead()) abort();
    W.root = loaded.root; W.model = loaded.model; W.anims = loaded.anims;

    // ★ 프레임 간격이 크게 벌어져도(백그라운드 복귀 등) speed*dt 로 벽을 뚫지 않게 dt 를 최대 0.1초로 제한
    scene.onBeforeRenderObservable.add(() => { update(Math.min(engine.getDeltaTime() / 1000, 0.1)); });

    // 카메라
    const cam = new BABYLON.ArcRotateCamera('wCam', Math.PI / 2, 1.27, 12.0,
      new BABYLON.Vector3(0, 2.4, 12), scene);
    cam.lowerBetaLimit = 0.95; cam.upperBetaLimit = 1.46;
    cam.lowerRadiusLimit = 5.5; cam.upperRadiusLimit = 24;
    cam.wheelDeltaPercentage = 0.018;
    cam.panningSensibility = 0;
    cam.inertia = 0.82;
    cam.minZ = 0.4; cam.maxZ = 400;
    cam.attachControl(canvas, true);
    W.cam = cam;

    // 후처리
    try {
      const glow = new BABYLON.GlowLayer('wGlow', scene, { mainTextureFixedSize: 512, blurKernelSize: 32 });
      glow.intensity = 0.42;
      W.glow = glow;
    } catch (e) { }
    try {
      const pipe = new BABYLON.DefaultRenderingPipeline('wPipe', true, scene, [cam]);
      pipe.fxaaEnabled = true;
      pipe.samples = 2;
      pipe.bloomEnabled = true;
      pipe.bloomThreshold = 0.82;
      pipe.bloomWeight = 0.20;
      pipe.bloomKernel = 42;
      pipe.bloomScale = 0.5;
      pipe.sharpenEnabled = true;
      pipe.sharpen.edgeAmount = 0.16;
      pipe.sharpen.colorAmount = 1.0;
      pipe.imageProcessing.toneMappingEnabled = true;
      try { pipe.imageProcessing.toneMappingType = BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES; } catch (e) { }
      pipe.imageProcessing.exposure = 1.09;
      pipe.imageProcessing.contrast = 1.12;
      pipe.imageProcessing.vignetteEnabled = true;
      pipe.imageProcessing.vignetteWeight = 1.05;
      pipe.imageProcessing.vignetteStretch = 0.6;
      W.pipe = pipe;
    } catch (e) { }
    try {
      if (BABYLON.SSAO2RenderingPipeline && engine.webGLVersion > 1) {
        const ssao = new BABYLON.SSAO2RenderingPipeline('wSSAO', scene, { ssaoRatio: 0.5, blurRatio: 0.5 }, [cam]);
        ssao.radius = 1.1; ssao.totalStrength = 0.85; ssao.samples = 10; ssao.expensiveBlur = false;
        W.ssao = ssao;
      }
    } catch (e) { }

    // ★ 2026-11-21 (v1.73) 초기 품질 단계 적용 — 파이프라인·물이 모두 만들어진 뒤.
    //   터치 기기·작은 화면은 mid 로 시작하고, 이후 FPS 프로브가 26fps 미만 2연속이면
    //   mid → low → min 으로 한 단계씩 내려간다(내려가기만 — 안정 우선).
    applyWorldQuality(detectInitialTier());

    bindKeys();
    W.onResize = () => engine.resize();
    window.addEventListener('resize', W.onResize);
    engine.runRenderLoop(() => scene.render());
    W.ready = true;
    try { pulseDof(); } catch (e) { }   // ★ v1.73 L6 — «마을에 들어온 순간» DOF 2초(high 전용)
    startPresence();                  // v1.35 친구 위치 동기화 시작
    loadWorldQuests();                // v1.37 오늘의 의뢰 표식 · 완료 흔적
    loadWorldLessons();
    setTimeout(() => engine.resize(), 60);
    // ── 2단계: 숲·바닥·별·거점은 화면이 뜬 뒤 백그라운드로 채운다
    setTimeout(() => { buildRest(scene); }, 80);
  }

  async function buildRest(scene) {
    // ★ closeWorld 와의 경합 방지 — 씬이 이미 닫혔(교체)으면 아무것도 만들지 않는다
    if (W.cancelBuild || W.scene !== scene) return;
    try {
      const CORE = ['house1', 'house2', 'house3', 'house4', 'inn', 'blacksmith',
        'stable', 'mill', 'belltower', 'well', 'market', 'gazebo', 'fence', 'bench',
        'barrel', 'crate', 'hay', 'cart', 'treeRound', 'treeBirch', 'bonfire'];
      await loadAllProps(scene, null, CORE);   // CORE 는 건너뛰고 나머지
      if (W.cancelBuild || W.scene !== scene) return;   // ★ await 사이 닫혔으면 중단
      buildNature(scene);
      buildGroundCover(scene);
      // v1.33 부유섬은 장식이 많아 «한 섬이 실패해도» 나머지 월드가 살아있도록 개별 보호
      try { makeFloatingIsland(scene, -30, 18.0, -26, 1.15); } catch (e) { console.warn('[world] island A', e && e.message); }
      try { makeFloatingIsland(scene, 38, 21.0, -14, 0.95); } catch (e) { console.warn('[world] island B', e && e.message); }
      // ★ 2026-11-21 (v1.73) 잔디 thinInstance 커밋 — 섬 위 잔디 spawn 이 모두 끝난 «직후» 1회.
      //   (loadVillage 등 이후 spawn 은 잔디를 안 찍으므로 안전. 커밋 뒤 spawn('grass') 은
      //    일반 instance 경로로 자동 회귀한다)
      commitThinGrass(scene);
      createClouds(scene);
      createBirds(scene);
      createStars(scene);
      applyCollectedStars();   // ★ 로딩 직전에 내려받은 «오늘 주운 별» 목록을 새 별에 반영
      createStations(scene);
      CHEST_SPOTS.forEach((sp, i) => { try { makeChest(scene, sp, i); } catch (e) { } });
      try { buildSecretSign(scene); } catch (e) { console.warn('[world] secret sign', e && e.message); }
      try { buildLighthouse(scene); } catch (e) { console.warn('[world] lighthouse', e && e.message); }
      try { buildThoughtVault(scene); } catch (e) { console.warn('[world] thought vault', e && e.message); }
      try { loadVillage(scene); } catch (e) { }
      try { loadTreasure(); } catch (e) { }
      try { loadThoughtSummary(); } catch (e) { }   // v1.39 고쳐 쓴 생각 수만큼 저장고 등을 켠다
      // ★ 2026-11-20 (v1.71) 루미 NPC — 동기 빌드(await 없음)라 «씬 닫힘» 검사가 필요 없다.
      //   buildVillage 이후 호출되므로 COLL 이 차 있어 freeSpotNear 가 정확히 동작한다.
      try { initRumi(scene); } catch (e) { console.warn('[world] rumi npc', e && e.message); }
      // ★ 2026-11-21 (v1.73) L2/L3 마무리 — 마을 배치가 «완전히» 차오른 뒤의 증분 꾸미기.
      //   dressPaths/slopeRocks 는 nz 인덱스 노이즈만 쓰고 blockReason 으로 기존 배치를 침범하지 않는다.
      try { dressPaths(scene); } catch (e) { console.warn('[world] path dress', e && e.message); }
      try { slopeRocks(scene); } catch (e) { console.warn('[world] slope rocks', e && e.message); }
      // ★ 2026-11-21 (v1.73) L4/L5 — PROTO 가 «전부» 로드된 뒤 바람 흔들림 재적용
      //   (applyWorldQuality 는 PROTO 로딩 «전» 에 불렸다 — 잔디·나무는 여기서 확보된다)
      //   + 의뢰/탑 빛기둥 설치(퀘스트 데이터는 loadWorldQuests 가 나중에 채워도 매 프레임 읽는다)
      try { applyFeature('windSway', W.fx.windSway); } catch (e) { }
      try { ensurePillars(scene); } catch (e) { }
      // ★ 나비 — applyFeature('particles') 가 buildRest «전» 에 불렸으면 이때까지 미룬다
      //   (starRingM/signIron 이 createStars/makeSign 뒤에 존재해야 «재사용 재질» 이 붙는다)
      try { ensureButterflies(scene); } catch (e) { }
      // ★ «기억 안개» 연동 — /api/lamps 의 decay≥50 등불 비율 → W.weather.fogBoost(순수 읽기).
      try { fetchLampFog(); } catch (e) { }
      // ★ 2026-11-21 (v1.73) 씬 전체가 차오른 뒤:
      //   ① selection octree — scene.pick/pointer 판정용 가속 구조(활성 mesh 수 대폭 감소의 이득)
      //   ② FPS 프로브 활성화 — 여기부터가 «실제 플레이 프레임». 로딩 히치를 측정하지 않는다.
      try { scene.createOrUpdateSelectionOctree(); } catch (e) { }
      W.fxProbe.active = true;
    } catch (e) { console.warn('[world] rest build', e && e.message); }
  }

  function bindKeys() {
    W.onKeyDown = (e) => {
      if (!W.open) return;
      W.__lastInput = W.t;   // ★ v1.73 L6 — 키 입력 = 카메라 미호흡 즉시 해제
      const key = String(e.key || '').toLowerCase();
      // v1.34: 대화 중에는 입력창 타이핑(WASD·Space·Enter)을 절대 가로채지 않는다.
      //   preventDefault 보다 «먼저» 빠져나가야 스페이스·한글이 정상 입력된다.
      if (W.chatOpen) {
        if (key === 'escape') { e.preventDefault(); closeWorldChat(); }
        return;
      }
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) e.preventDefault();
      if (key === 'w' || key === 'arrowup') W.keys.w = true;
      if (key === 's' || key === 'arrowdown') W.keys.s = true;
      if (key === 'a' || key === 'arrowleft') W.keys.a = true;
      if (key === 'd' || key === 'arrowright') W.keys.d = true;
      if (key === 'shift') W.keys.shift = true;
      if (key === ' ' && W.grounded && !W.animLock) { W.grounded = false; W.vy = 5.4; W.air = 0.01; oneShot('Jump', 900); }
      // ★ 2026-11-21 (v1.74) Esc — 빠른 이동 메뉴가 열려 있으면 «메뉴만» 닫는다(세계를 닫지 않게)
      if (key === 'escape') { if (W.warpOpen) closeWarpMenu(); else if (W.secretOpen) closeSecret(); else if (W.vaultOpen) closeVault(); else if (W.quizOpen) closeWorldQuiz(); else closeWorld(); }
      if ((key === 'e' || key === 'enter') && !W.quizOpen && !W.secretOpen && !W.vaultOpen && !W.warpOpen) {
        if (W.nearPeer) { waveToPeer(W.nearPeer); return; }   // v1.35 친구 인사가 우선
        // ★ 2026-11-20 (v1.71) 루미에게 말 걸기 — app.js 의 window.__rmiRoutine 로 연결
        if (W.rumiNear && W.rumi && W.rumi.state === 'idle') { rumiTalk(W.rumi.spot); return; }
        if (W.nearType === 'vault') openVault();
        else if (W.nearType === 'secret') openSecret();
        else if (W.nearType === 'chest' && W.near >= 0) openChest(W.near);
        else if (W.nearStation >= 0) openWorldQuiz(W.nearStation);
      }
    };
    W.onKeyUp = (e) => {
      W.__lastInput = W.t;   // ★ v1.73 L6 — 키 입력 = 카메라 미호흡 즉시 해제
      const key = String(e.key || '').toLowerCase();
      if (key === 'w' || key === 'arrowup') W.keys.w = false;
      if (key === 's' || key === 'arrowdown') W.keys.s = false;
      if (key === 'a' || key === 'arrowleft') W.keys.a = false;
      if (key === 'd' || key === 'arrowright') W.keys.d = false;
      if (key === 'shift') W.keys.shift = false;
    };
    window.addEventListener('keydown', W.onKeyDown);
    window.addEventListener('keyup', W.onKeyUp);
    const cvs = document.querySelector('#world3d');
    if (cvs) {
      cvs.addEventListener('wheel', () => {
        W.__lastInput = W.t;   // ★ v1.73 L6 — 휠 줌도 «입력» (미호흡 해제)
        clearTimeout(W.__wheelT);
        W.__wheelT = setTimeout(() => { if (W.cam) W.boomIdeal = W.cam.radius; }, 320);
      }, { passive: true });
      // ★ v1.73 L6 — 포인터 드래그(카메라 회전)도 입력으로 간주 — closeWorld 에서 해제
      W.onCanvasDown = () => { W.__lastInput = W.t; };
      cvs.addEventListener('pointerdown', W.onCanvasDown);
    }
    $$('#world-dpad [data-wk]').forEach((b) => {
      const k = b.dataset.wk;
      const on = (e) => { e.preventDefault(); W.keys[k] = true; };
      const off = (e) => { e.preventDefault(); W.keys[k] = false; };
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointerleave', off);
      b.addEventListener('pointercancel', off);
    });
  }

  function waitFor(fn, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        let ok = false;
        try { ok = !!fn(); } catch (e) { }
        if (ok) return resolve(true);
        if (Date.now() - t0 > (ms || 6000)) return resolve(false);
        setTimeout(tick, 120);
      };
      tick();
    });
  }

  // ────────────────────────── 열기 / 닫기 ──────────────────────────
  async function openWorld() {
    if (W.open || W.opening) return;
    W.opening = true;
    const screen = $('#world-screen');
    const loading = $('#world-loading');
    if (screen) screen.classList.remove('hidden');
    const fab = $('#chat-fab'); if (fab) fab.classList.add('hidden');
    if (typeof chatClose === 'function') chatClose();
    if (loading) loading.classList.remove('hidden');
    setLoadMsg('AI 마을을 만드는 중…');
    _seed = 20261031;
    try {
      if (!W.ready) await initWorld();
      // ★ 로딩 중 닫기(Esc/✕)가 걸린 경우 — 열지 말고 조용히 완전 정리
      if (W.cancelBuild) { closeWorld(); return; }
      if (loading) loading.classList.add('hidden');
      W.open = true;
    } catch (e) {
      console.error('[world]', e);
      // ★ 사용자가 로딩 중 닫은 것(cancelled)은 오류 화면 없이 조용히 넘어간다
      if (!(e && e.cancelled)) {
        if (loading) loading.innerHTML = '<span>AI 마을을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</span>';
      }
      // 로딩 중 닫기 경로는 closeWorld 가 조기 반환해 FAB 를 못 돌려 준다 — 여기서 복구
      if (fab) fab.classList.remove('hidden');
    } finally { W.opening = false; }
  }

  function closeWorld() {
    const screen = $('#world-screen');
    // ★ 로딩 중 닫기 — 화면만 숨기고 빌드가 계속 도는 문제를 막는다
    //   (initWorld 가 다음 await 뒤에 중단하고, buildRest 도 이 플래그로 즉시 반환)
    W.cancelBuild = true;
    if (!W.open && !W.ready) { if (screen) screen.classList.add('hidden'); return; }
    if (W.chatOpen) closeWorldChat();      // v1.34 대화층도 함께 닫는다
    stopPresence();                        // v1.35 친구 동기화 중지 + «마을 떠남» 알림
    // ★ 2026-11-20 (v1.71) 루미 NPC + 수정 구슬 정리 — v1.69 수명 규율: 새 상태는 전부 닫는다
    if (W.rumiPickObs && W.scene) { try { W.scene.onPointerObservable.remove(W.rumiPickObs); } catch (e) { } }
    W.rumiPickObs = null;
    disposeRumi();                         // 루미 메시·명패 텍스처·재질까지 전부 폐기
    W.crystals = [];                       // 수정은 씬 dispose 를 따라가므로 배열만 비운다
    W.open = false;
    try { if (W.engine) W.engine.stopRenderLoop(); } catch (e) { }
    try { if (W.scene) W.scene.dispose(); } catch (e) { }
    try { if (W.engine) W.engine.dispose(); } catch (e) { }
    try {
      window.removeEventListener('keydown', W.onKeyDown);
      window.removeEventListener('keyup', W.onKeyUp);
      window.removeEventListener('resize', W.onResize);
    } catch (e) { }
    W.engine = null; W.scene = null; W.cam = null; W.root = null; W.model = null;
    W.anims = {}; W.stars = []; W.clouds = []; W.birds = null; W.fires = []; W.windmills = [];
    W.quests = []; W.questDone = new Set(); W.questMarks = []; W.questRelics = []; W.nearQuest = null;
    W.lighthouse = null; W.lighthouseLit = false;   // ★ v1.84 등대 메시는 씬 dispose 를 따라간다
    W.collected = 0; W.ready = false; W.keys = {}; W.animName = ''; W.animLock = 0;
    W.stations = []; W.lessons = null; W.nearStation = -1; W.quizOpen = false; W.lessonDone = 0; W.villageKeys = [];
    W.chests = []; W.nearType = ''; W.near = -1; W.starfall = null; W.starTimer = 40;
    W.secretOpen = false; W.secretSign = null;   // v1.38 이정표 상태 초기화(씬은 아래에서 dispose)
    W.vaultOpen = false; W.vaultLit = 0; W.vaultFixed = 0; W.vaultLamps = []; W.vaultSpot = null; W.vaultGlow = null;  // v1.39
    W.floaters = []; W.fallTex = null; W.smokeTex = null;   // ★ v1.33 연기·폭포 텍스처 + 연기 텍스처 누락 수정(재입장 시 폐기된 텍스처 재사용 방지)
    W.starsCollected = null;   // ★ 오늘 주운 별 목록도 새 입장에서 다시 내려받는다
    // ★ 2026-11-21 (v1.73) L1 성능 프레임워크 정리 — v1.69 수명 규율: 새 상태는 전부 닫는다.
    //   - W.veg(거리 3환 레지스트리): wrap 노드는 씬 dispose 를 따라가므로 배열만 비운다.
    //   - grassThin(수집 버퍼)·fxProbe·shadowListSave: 프레임워크 상태 초기화.
    //   - PROTO 안의 인스턴스 소스(p.inst)/thin 소스(p.thinDone) 는 아래 PROTO 삭제와 함께 사라진다
    //     — 재입장 시 loadProto 가 «처음부터» 다시 준비하므로 폐기된 씬의 소스가 새 씬을 오염시키지 않는다.
    W.veg = []; W.vegTimer = 0; W.grassThin = {};
    W.fxProbe = { active: false, frames: 0, time: 0, low: 0 };
    W.__shadowListSave = null; W.waterMat = null;
    // ★ 2026-11-21 (v1.73) L2/L3 환경 상태 — v1.69 수명 규율: 새 상태는 전부 닫는다.
    //   (메시·재질은 씬 dispose 를 따라가고, 참조·배열·계약 필드를 여기서 초기화한다)
    W.dayNight = null; W.weather = null; W.skyBox = null; W.skyMat = null;
    W.starDomeMat = null; W.moonMesh = null; W.fogPlanes = null;
    W.windowMat = null; W.windowLights = []; W.foam = null;
    W.waterWM = null; W.groundMat = null; W.groundBump = null;
    W.rainPs = null; W.ripplePs = null; W.rainE = null; W.rippleE = null;
    W.godRayPP = null; W.sunMesh = null; W.lilyWraps = [];
    W.hemi = null; W.sun = null; W.sunDir = null;
    W.ridgeMats = []; W.shoreMat = null;
    // ★ 2026-11-21 (v1.73) L4/L5/L6 — 생명감·스토리·마감 레이어 상태 전부 리셋(v1.69 수명 규율).
    //    메시·재질·파티클·텍스처는 씬 dispose 를 따라가고, 참조·버퍼·리스너만 여기서 끊는다.
    //    (W.sway 의 CustomMaterial 은 applyFeature('windSway',false) 경로와 씬 dispose 양쪽으로 회수)
    W.sway = null; W.pillars = null; W.fish = null; W.butterflies = null; W.flags = null;
    W.springFog = null; W.petals = null; W.prints = null; W.sparkle = null; W.rippleTex = null;
    W.bloomT = 0; W.dofT = 0; W.__lastInput = 0;
    // ★ 2026-11-21 (v1.74) 빛의 조각 + 빠른 이동 정리 — v1.69 수명 규율: 새 상태는 전부 닫는다.
    //   - 팁: 친구 팁 요소를 공유하므로 «원문구» 로 되돌리고 숨긴다(다음 입장 오염 방지).
    //   - 메뉴/페이드 DOM 은 #world-screen 소유(씬 dispose 와 무관) → 상태만 idle 로 되돌리고
    //     페이드 opacity 를 0 으로. 칩·메뉴 DOM 은 한 번 만들어 두고 재사용(initWarpUI 가드).
    //   - shards 배열·teachCount 는 씬과 함께 폐기 개념 — 재입장 시 loadVillage 가 다시 채운다.
    showShardTip(false);
    W.shards = []; W.shardTipShown = false; W.teachCount = null;
    closeWarpMenu();
    if (W.warp) {
      W.warp.state = 'idle'; W.warp.fade = 0; W.warp.cool = 0; W.warp.dest = null;
      if (W.warp.el) { try { W.warp.el.style.opacity = '0'; } catch (e) { } }
    }
    W.warpOpen = false;
    if (W.onCanvasDown) {
      try {
        const cvd = document.querySelector('#world3d');
        if (cvd) cvd.removeEventListener('pointerdown', W.onCanvasDown);
      } catch (e) { }
      W.onCanvasDown = null;
    }
    try { window.__rmiFogLevel = 0; } catch (e) { }
    W.fxTier = 'high';
    W.fx = { godRays: false, weather: false, waterWave: true, windSway: false, birds: true, fish: false,
      cloth: true, grassBend: false, petals: false, footprints: false, dof: false,
      shadows: true, ssao: true, particles: true };
    showPrompt(false); closeWorldQuiz(); closeSecret(); closeVault();
    COLL.length = 0; SEGS.length = 0; W.boomIdeal = 12; W.lastRadius = 12;
    W.vy = 0; W.air = 0; W.grounded = true; W.t = 0;
    for (const k in PROTO) delete PROTO[k];
    if (screen) screen.classList.add('hidden');
    const loading = $('#world-loading'); if (loading) loading.classList.remove('hidden');
    const st = $('#world-stars'); if (st) st.textContent = '⭐ 0 / 3';
    const ls = $('#world-lessons'); if (ls) ls.textContent = '📖 0 / 3';
    const hint = $('#world-hint'); if (hint) hint.textContent = '드래그로 둘러보고, WASD로 걸어요';
    const fab = $('#chat-fab'); if (fab) fab.classList.remove('hidden');
  }

  // ── v1.35 친구와 «같은 마을» 에서 놀기 ──
  //   소켓 대신 1.6초 폴링. 내 위치를 올리고, «서로 친구» 인 사람의 위치만 받아 온다.
  //   서버가 친구 관계를 확인하므로 모르는 사람의 좌표는 애초에 오지 않는다.
  function peerColors(rb) {
    try {
      if (typeof effectiveColors === 'function') {
        return effectiveColors((rb && rb.template) || 'doro', (rb && rb.palette) || null);
      }
    } catch (e) { }
    return { body: '#5cc9a7', head: '#a8e6d0', antenna: '#ff9f43' };
  }

  function pbMat(scene, uid, tag, hex, emis) {
    const m = new BABYLON.StandardMaterial('pb' + tag + '_' + uid, scene);
    const c = BABYLON.Color3.FromHexString(hex || '#5cc9a7');
    m.diffuseColor = c;
    // v1.33 교훈: 어두운 면이 순흑이 되지 않게 약한 자체 발광을 준다
    m.emissiveColor = c.scale(emis == null ? 0.16 : emis);
    m.specularColor = new BABYLON.Color3(0.07, 0.07, 0.07);
    return m;
  }

  // 친구 로봇 — GLB 를 또 불러오면 메시가 수천 개 늘어나므로 «9개 안팎» 절차 모델로 만든다.
  function buildPeerBot(scene, peer) {
    const uid = peer.uid;
    const col = peerColors(peer.robot);
    const root = new BABYLON.TransformNode('peerRoot_' + uid, scene);
    const model = new BABYLON.TransformNode('peerModel_' + uid, scene);
    model.parent = root;

    const mBody = pbMat(scene, uid, 'Body', col.body, 0.16);
    const mHead = pbMat(scene, uid, 'Head', col.head, 0.18);
    const mAnt = pbMat(scene, uid, 'Ant', col.antenna, 0.24);
    const mDark = pbMat(scene, uid, 'Dark', '#22313f', 0.02);
    const mEye = pbMat(scene, uid, 'Eye', '#ffffff', 0.85);

    const body = BABYLON.MeshBuilder.CreateCapsule('pbBody_' + uid,
      { height: 0.84, radius: 0.30, tessellation: 12 }, scene);
    body.position.y = 0.56; body.material = mBody; body.parent = model;

    const head = BABYLON.MeshBuilder.CreateSphere('pbHead_' + uid,
      { diameter: 0.66, segments: 12 }, scene);
    head.position.y = 1.18; head.material = mHead; head.parent = model;

    const face = BABYLON.MeshBuilder.CreateBox('pbFace_' + uid,
      { width: 0.40, height: 0.28, depth: 0.07 }, scene);
    face.position.set(0, 1.20, 0.27); face.material = mDark; face.parent = model;

    const eyes = [];
    [-0.086, 0.086].forEach((dx, i) => {
      const e = BABYLON.MeshBuilder.CreateSphere('pbEye_' + uid + '_' + i,
        { diameter: 0.082, segments: 6 }, scene);
      e.position.set(dx, 1.215, 0.315); e.scaling.z = 0.6;
      e.material = mEye; e.parent = model;
      eyes.push(e);
    });

    const stalk = BABYLON.MeshBuilder.CreateCylinder('pbAnt_' + uid,
      { height: 0.26, diameter: 0.036, tessellation: 6 }, scene);
    stalk.position.y = 1.62; stalk.material = mAnt; stalk.parent = model;
    const tip = BABYLON.MeshBuilder.CreateSphere('pbTip_' + uid,
      { diameter: 0.105, segments: 6 }, scene);
    tip.position.y = 1.77; tip.material = mAnt; tip.parent = model;

    const hands = [];
    [-1, 1].forEach((s, i) => {
      const h = BABYLON.MeshBuilder.CreateSphere('pbHand_' + uid + '_' + i,
        { diameter: 0.15, segments: 6 }, scene);
      h.position.set(s * 0.34, 0.64, 0.02); h.material = mBody; h.parent = model;
      hands.push(h);
      const f = BABYLON.MeshBuilder.CreateSphere('pbFoot_' + uid + '_' + i,
        { diameter: 0.19, segments: 6 }, scene);
      f.position.set(s * 0.13, 0.10, 0.03); f.scaling.y = 0.55;
      f.material = mBody; f.parent = model;
    });

    // 닉네임 명패 — 빌보드라서 어느 각도에서나 정면으로 읽힌다.
    const plate = BABYLON.MeshBuilder.CreatePlane('pbName_' + uid,
      { width: 1.45, height: 0.34 }, scene);
    plate.position.y = 2.02;
    plate.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plate.parent = model;
    const tex = new BABYLON.DynamicTexture('pbNameTex_' + uid,
      { width: 360, height: 84 }, scene, true);
    tex.hasAlpha = true;
    const c2 = tex.getContext();
    c2.clearRect(0, 0, 360, 84);
    c2.fillStyle = 'rgba(10,24,40,0.74)';
    const rr = 26, rw = 360, rh = 84;
    c2.beginPath();
    c2.moveTo(rr + 6, 8); c2.lineTo(rw - rr - 6, 8);
    c2.quadraticCurveTo(rw - 6, 8, rw - 6, rr + 8);
    c2.lineTo(rw - 6, rh - rr - 8); c2.quadraticCurveTo(rw - 6, rh - 8, rw - rr - 6, rh - 8);
    c2.lineTo(rr + 6, rh - 8); c2.quadraticCurveTo(6, rh - 8, 6, rh - rr - 8);
    c2.lineTo(6, rr + 8); c2.quadraticCurveTo(6, 8, rr + 6, 8);
    c2.closePath(); c2.fill();
    c2.fillStyle = '#eaf7ff';
    c2.font = 'bold 34px "Apple SD Gothic Neo", system-ui, sans-serif';
    c2.textAlign = 'center'; c2.textBaseline = 'middle';
    const nm = String(peer.nickname || '친구');
    c2.fillText(nm.length > 9 ? nm.slice(0, 9) + '…' : nm, 180, 44);
    tex.update();                       // ★ 문자 텍스처는 반드시 update() (v1.33 교훈)
    const pm = new BABYLON.StandardMaterial('pbNameMat_' + uid, scene);
    pm.diffuseTexture = tex;
    pm.diffuseTexture.hasAlpha = true;
    pm.useAlphaFromDiffuseTexture = true;
    pm.emissiveTexture = tex;
    pm.emissiveColor = new BABYLON.Color3(1, 1, 1);
    pm.diffuseColor = new BABYLON.Color3(0, 0, 0);
    pm.specularColor = new BABYLON.Color3(0, 0, 0);
    pm.disableLighting = true;
    pm.backFaceCulling = false;
    plate.material = pm;

    root.position.set(peer.x, heightAt(peer.x, peer.z), peer.z);
    root.rotation.y = peer.ry || 0;

    return {
      uid, nickname: peer.nickname, level: peer.level,
      root, model, hands, baseHandY: 0.64,
      tx: peer.x, tz: peer.z, ty: peer.ry || 0,
      anim: peer.anim || 'Idle',
      phase: nz(peer.uid, 7) * 6.28,
      waveT: 0,
      mats: [mBody, mHead, mAnt, mDark, mEye, pm], tex
    };
  }

  function removePeer(uid) {
    const p = W.peers.get(uid);
    if (!p) return;
    W.peers.delete(uid);
    try {
      p.root.getChildMeshes().forEach((m) => { try { m.dispose(); } catch (e) { } });
      p.root.dispose();
      p.mats.forEach((m) => { try { m.dispose(); } catch (e) { } });
      p.tex.dispose();
    } catch (e) { }
  }

  function applyPeers(list) {
    if (!W.scene) return;
    const seen = new Set();
    list.forEach((peer) => {
      if (!peer || !peer.uid) return;
      seen.add(peer.uid);
      let p = W.peers.get(peer.uid);
      if (!p) { p = buildPeerBot(W.scene, peer); W.peers.set(peer.uid, p); }
      p.nickname = peer.nickname || p.nickname;
      p.tx = peer.x; p.tz = peer.z; p.ty = peer.ry || 0;
      p.anim = peer.anim || 'Idle';
    });
    W.peers.forEach((p, uid) => { if (!seen.has(uid)) removePeer(uid); });
    const chip = $('#world-friends');
    if (chip) chip.textContent = '👥 ' + W.peers.size;
  }

  function showPeerTip(peer) {
    const tip = $('#world-peer-tip');
    if (!tip) return;
    if (peer) {
      if (tip.dataset.uid !== String(peer.uid)) {
        tip.dataset.uid = String(peer.uid);
        const b = tip.querySelector('b');
        if (b) b.textContent = peer.nickname || '친구';
      }
      tip.classList.remove('hidden');
    } else {
      tip.classList.add('hidden');
      tip.dataset.uid = '';
    }
  }

  function updatePeers(dt) {
    if (!W.peers || !W.peers.size) { W.nearPeer = null; return; }
    let nearest = null, nearestD = 4.2;
    W.peers.forEach((p) => {
      const k = Math.min(1, dt * 6);
      p.root.position.x += (p.tx - p.root.position.x) * k;
      p.root.position.z += (p.tz - p.root.position.z) * k;
      const gy = heightAt(p.root.position.x, p.root.position.z);
      p.root.position.y += (gy - p.root.position.y) * Math.min(1, dt * 9);

      let d = p.ty - p.root.rotation.y;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      p.root.rotation.y += d * Math.min(1, dt * 7);

      // ★ 전송 측 setAnim 이 쓰는 이름('Walking'/'Running')과 일치 — 'Walk'/'Run' 은 존재하지 않는 이름
      const walking = p.anim === 'Walking' || p.anim === 'Running';
      p.phase += dt * (walking ? 9 : 2.2);
      p.model.position.y = walking ? Math.sin(p.phase) * 0.045 : Math.sin(p.phase) * 0.02;
      p.hands.forEach((h, i) => {
        h.position.y = p.baseHandY + (walking ? Math.sin(p.phase + i * Math.PI) * 0.09 : 0);
      });

      if (p.waveT > 0) {
        p.waveT = Math.max(0, p.waveT - dt);
        const h = p.hands[1];
        h.position.y = 1.42 + Math.sin((1.2 - p.waveT) * 22) * 0.10;
        h.position.x = 0.44;
      } else {
        p.hands[1].position.x = 0.34;
      }

      if (W.root) {
        const dd = Math.hypot(p.root.position.x - W.root.position.x, p.root.position.z - W.root.position.z);
        if (dd < nearestD) { nearestD = dd; nearest = p; }
      }
    });
    W.nearPeer = nearest ? nearest.uid : null;
    showPeerTip(nearest);
  }

  async function syncPresence() {
    if (!W.open || !W.ready || !W.root || W.presenceBusy) return;
    if (typeof api !== 'function') return;
    W.presenceBusy = true;
    try {
      const r = await api('/api/world/presence', {
        x: +W.root.position.x.toFixed(2),
        z: +W.root.position.z.toFixed(2),
        ry: +W.root.rotation.y.toFixed(2),
        anim: W.animName || 'Idle'
      }, 8000);
      if (W.open && r) applyPeers(r.peers || []);
    } catch (e) {
      // 네트워크가 끊겨도 혼자 놀 수 있어야 한다 — 조용히 넘어간다
    } finally { W.presenceBusy = false; }
  }

  function startPresence() {
    if (W.presenceTimer) { clearInterval(W.presenceTimer); W.presenceTimer = null; }
    syncPresence();
    W.presenceTimer = setInterval(syncPresence, 1600);
  }

  function stopPresence() {
    if (W.presenceTimer) { clearInterval(W.presenceTimer); W.presenceTimer = null; }
    try { if (typeof api === 'function') api('/api/world/leave', {}); } catch (e) { }
    W.peers.forEach((p, uid) => removePeer(uid));
    W.peers.clear();
    showPeerTip(null);
    W.nearPeer = null;
    const chip = $('#world-friends'); if (chip) chip.textContent = '👥 0';
  }

  async function waveToPeer(uid) {
    const p = W.peers && W.peers.get(uid);
    if (!p || typeof api !== 'function') return;
    p.waveT = 1.2;
    try {
      const r = await api('/api/world/wave', { to: uid }, 8000);
      if (r && r.throttled) { if (typeof toast === 'function') toast('조금 있다가 또 인사해요 🙂'); }
      else if (typeof toast === 'function') toast('👋 ' + (p.nickname || '친구') + '에게 인사했어요!');
    } catch (e) {
      if (typeof toast === 'function') toast(e.message || '인사를 전하지 못했어요');
    }
  }

  // ────────────────────────── ★ 2026-11-20 (v1.71) 루미 NPC ──────────────────────────
  //  루미도 마을에서 «살아 움직인다» — 시간대마다 다른 곳에 서서 아이를 기다린다.
  //  · 모델: 친구(peer) 절차 빌드 buildPeerBot 재사용(GLB 를 또 불러오지 않는다) + scale 0.8
  //  · presence 업로드 없음(혼자 서 있는 NPC — W.peers 에 넣지 않는다)
  //  · 발광 없음·등 추가 없음: pbMat 자체 발광 + 기존 GlowLayer 만 쓴다
  const RUMI_SCALE = 0.8;
  //  시간대별 장소 — 우물·풍차·종탑 «상호작용 지점» 에서 2~3m(풍차는 날개 반경 밖 4m) 떨어진 자리.
  //  보물상자(23,-13 · -21,2.5)·벤치·시장 충돌체와도 1.9m 이상 떨어져 있다.
  const RUMI_SPOTS = {
    well: { x: 2.9,  z: -7.3 },    // 우물(0.5,-8.5) 남동쪽 2.7m
    mill: { x: 25.2, z: -9.6 },    // 풍차(26.5,-13.5) 북쪽 4.1m — 날개 반경 밖, 상자(23,-13)와 4m
    bell: { x: -18.0, z: -0.5 }    // 종탑(-20,-2) 북동쪽 2.6m
  };
  //  KST 시각 → 장소. 06~11시 우물 / 12~16시 풍차 / 17~21시 종탑 / 그 외(22~05시) 우물.
  //  world.js 는 기존에 시각 처리가 없어 «기기 로컬 시각» 을 그대로 쓴다(new Date() 관례 없음).
  function rumiSpotForHour(h) {
    if (h >= 6 && h < 12) return 'well';
    if (h >= 12 && h < 17) return 'mill';
    if (h >= 17 && h < 22) return 'bell';
    return 'well';
  }
  function rumiTarget(spot) {
    const base = RUMI_SPOTS[spot] || RUMI_SPOTS.well;
    // 목표 자리에 소품이 겹쳐 서 있으면 바로 근처 빈자리로 밀어 준다(v1.38 freeSpotNear 재사용)
    return freeSpotNear(base.x, base.z, 2.5);
  }

  function initRumi(scene) {
    if (W.rumi) return;
    const spot = rumiSpotForHour(new Date().getHours());
    const tgt = rumiTarget(spot);
    // 친구 로봇과 같은 절차 모델 — 이름표 «루미» 는 buildPeerBot 의 nickname 빌보드가 그려 준다.
    // uid 는 «숫자» 를 쓴다: buildPeerBot 이 nz(uid,7) 로 대기 phase 를 만드는데,
    // 문자열 uid 는 NaN 이 되어 position.y 가 깨진다(친구 uid 는 서버 숫자 문자열이라 안전).
    const p = buildPeerBot(scene, { uid: 9001, nickname: '루미', x: tgt.x, z: tgt.z, ry: 0, anim: 'Idle' });
    p.root.scaling.setAll(RUMI_SCALE);          // 친구보다 한 단계 작은 «루미»
    p.mats.forEach((m) => { m.alpha = 0; });    // 페이드 인으로 등장
    p.state = 'in';                             // 'idle' | 'out' | 'in'
    p.fade = 0;
    p.spot = spot;
    p.nextSpot = null;
    p.hourCheck = 0;   // 시간표 재검사 누적(dt 클램프 ≤0.1 이라 안전) — setInterval 없이 수명 관리
    W.rumi = p;

    // 클릭(탭)으로도 말 걸기 — 드래그 카메라 회전은 POINTERTAP 이 걸러 준다
    const meshes = p.root.getChildMeshes();
    if (scene.onPointerObservable) {
      W.rumiPickObs = scene.onPointerObservable.add((pi) => {
        if (!W.rumi || pi.type !== BABYLON.PointerEventTypes.POINTERTAP) return;
        if (W.chatOpen || W.quizOpen || W.secretOpen || W.vaultOpen) return;
        const hit = scene.pick(scene.pointerX, scene.pointerY, (m) => meshes.indexOf(m) !== -1);
        if (hit && hit.hit) rumiTalk(W.rumi.spot);
      });
    }
  }

  function disposeRumi() {
    const p = W.rumi;
    if (!p) return;
    W.rumi = null;
    W.rumiNear = false;
    showRumiTip(false);   // 팁이 떠 있었으면 «E 키로 인사해요» 원문구로 되돌려 둔다
    W.rumiTipShown = false;   // 팁 요소를 못 찾았어도 플래그는 확실히 내린다
    try { p.root.getChildMeshes().forEach((m) => { try { m.dispose(); } catch (e) { } }); } catch (e) { }
    try { p.root.dispose(); } catch (e) { }
    (p.mats || []).forEach((m) => { try { m.dispose(); } catch (e) { } });
    try { if (p.tex) p.tex.dispose(); } catch (e) { }
  }

  //  app.js 가 창구(window.__rmiRoutine)를 연다 — world.js 는 «호출만» 한다.
  //  없거나(비로그인·구버전 app.js) 던져도 절대 오류가 세계로 새지 않게 조용히 삼킨다.
  function rumiTalk(spot) {
    const p = W.rumi;
    if (p) p.waveT = 1.2;                       // 손 흔들기는 세계 안에서 바로 보여 준다
    try {
      if (typeof window.__rmiRoutine === 'function') {
        const r = window.__rmiRoutine(spot);
        if (r && typeof r.catch === 'function') r.catch(() => { });   // Promise 거절도 조용히
        return;
      }
      if (typeof toast === 'function') toast('루미가 기다리고 있어요 🙂');
    } catch (e) { /* 대화 실패가 세계를 멈추게 하지 않는다 */ }
  }

  //  루미 팁 — 친구 팁(#world-peer-tip)과 «같은 요소» 를 재사용한다.
  //  showPeerTip 은 <b>(이름)만 고치므로, 루미가 문구를 고쳤으면 숨길 때 원문구로 되돌린다.
  function showRumiTip(on) {
    const tip = $('#world-peer-tip');
    if (!tip) return;
    const ico = tip.querySelector('.wpt-ico');
    const sp = tip.querySelector('.wpt-txt span');
    if (on) {
      if (ico) ico.textContent = '🤖';
      if (sp) sp.textContent = '루미가 기다리고 있어 (E)';
      tip.classList.remove('hidden');
    } else if (W.rumiTipShown) {
      if (ico) ico.textContent = '👋';
      if (sp) sp.textContent = 'E 키로 인사해요';
      tip.classList.add('hidden');
    }
    W.rumiTipShown = on;
  }

  function updateRumi(dt) {
    const p = W.rumi;
    if (!p || !W.scene) return;
    // 시간표 — 60초에 한 번 시간대가 바뀌었는지 본다(«매분 검사» 요구)
    p.hourCheck += dt;
    if (p.hourCheck >= 60) {
      p.hourCheck = 0;
      const ns = rumiSpotForHour(new Date().getHours());
      if (ns !== p.spot && p.state === 'idle') { p.state = 'out'; p.nextSpot = ns; }
    }
    //  시간대 전환 — «길 찾기 없이» 가장 단순한 방식을 택했다:
    //  페이드 아웃 → 자리 이동 → 페이드 인. 직선 보간은 집을 뚫고 가는 모양새가 나와서 배제.
    if (p.state === 'out') {
      p.fade = Math.max(0, p.fade - dt * 2.2);
      p.mats.forEach((m) => { m.alpha = p.fade; });
      if (p.fade <= 0) {
        const t = rumiTarget(p.nextSpot || 'well');
        p.spot = p.nextSpot || 'well';
        p.nextSpot = null;
        p.root.position.set(t.x, heightAt(t.x, t.z), t.z);
        p.state = 'in';
      }
      // 사라지는 동안은 팁·근접을 확실히 끈다(이전 프레임 팁이 남지 않게)
      W.rumiNear = false;
      showRumiTip(false);
      return;
    }
    if (p.state === 'in') {
      p.fade = Math.min(1, p.fade + dt * 2.2);
      p.mats.forEach((m) => { m.alpha = p.fade; });
      if (p.fade >= 1) p.state = 'idle';
    }
    //  대기 부유 — 친구 로봇 Idle 로직과 같은 패턴(phase 로 살짝 떠오르고 손은 내려 있음)
    p.phase += dt * 2.2;
    p.model.position.y = Math.sin(p.phase) * 0.02;
    p.hands.forEach((h) => { h.position.y = p.baseHandY; });
    if (p.waveT > 0) {
      p.waveT = Math.max(0, p.waveT - dt);
      const h = p.hands[1];
      h.position.y = 1.42 + Math.sin((1.2 - p.waveT) * 22) * 0.10;
      h.position.x = 0.44;
    } else {
      p.hands[1].position.x = 0.34;
    }
    //  근접 판정(<4m) + 팁 — 친구가 근처에 있으면 친구 팁이 우선(양보)
    let near = false;
    if (W.root && p.state === 'idle') {
      const d = Math.hypot(p.root.position.x - W.root.position.x, p.root.position.z - W.root.position.z);
      near = d < 4;
    }
    W.rumiNear = near;
    showRumiTip(near && !W.nearPeer);
  }

  // ────────────────────────── ★ 2026-11-21 (v1.74) 빠른 이동 ──────────────────────────
  //  마을이 넓어져 «한 번에 원하는 곳» 으로 가게 해 주는 사용성 기능. 순수 UI 라 W.fx 와 무관하다
  //  (저사양 단계에서도 유지 — 특수효과가 아니라 «길을 잃지 않게» 하는 장치다).
  //  · 전환은 루미 시간표 이동의 «검증된 방식» 을 그대로 옮긴 것: 직선 보간 없이
  //    페이드 아웃(≈0.45s) → 순간이동 → 페이드 인(≈0.45s). 건물을 뚫고 나는 모양새 원천 차단.
  //  · 메뉴 오버레이는 world-quiz · wq-* «기존 패널 스타일 클래스» 재사용 — 새 CSS 0줄.
  //  · 목적지 «상태표» — 미완 의뢰 🔸 · 완료 ✔ · 루미는 현재 시간대 장소 이름.

  //  내리는 곳 — 시설 «앞 빈자리» 는 순간이동 직전 freeSpotNear 로 확정한다
  //  (저장고처럼 자리가 밀리는 시설, 루미처럼 걸어 다니는 NPC 를 정확히 따라가기 위함).
  function warpPoint(px, pz, r) {
    const f = freeSpotNear(px, pz, r || 3);
    return { x: f.x, z: f.z, yaw: Math.atan2(px - f.x, pz - f.z) };   // 내리자마자 시설을 바라보게
  }
  function questMarkFor(key) {
    return () => (W.questDone && W.questDone.has(key)) ? '✔' : '🔸';
  }
  function stationMarkFor(i) {
    return () => (W.lessons && W.lessons[i] && W.lessons[i].solved) ? '✔' : '';
  }
  function rumiPlaceMark() {
    if (!W.rumi) return '·';
    const names = { well: '우물', mill: '풍차', bell: '종탑' };
    return names[W.rumi.spot] || '우물';
  }
  function rumiPick() {
    if (!W.rumi || !W.rumi.root) return null;
    const p = W.rumi.root.position;
    return warpPoint(p.x + 2.0, p.z + 1.6, 3);   // 루미 «바로 앞» 2~3m — 내리면 바로 E 로 인사 가능
  }
  const WARP_DESTS = [
    { id: 'st0',   label: '📖 지혜의 샘 · 돌원 남쪽',       mark: stationMarkFor(0), pick: () => warpPoint(STATION_SPOTS[0].x, STATION_SPOTS[0].z) },
    { id: 'st1',   label: '📖 지혜의 샘 · 전망대 남서',     mark: stationMarkFor(1), pick: () => warpPoint(STATION_SPOTS[1].x, STATION_SPOTS[1].z) },
    { id: 'st2',   label: '📖 지혜의 샘 · 버드나무숲 북쪽', mark: stationMarkFor(2), pick: () => warpPoint(STATION_SPOTS[2].x, STATION_SPOTS[2].z) },
    { id: 'mill',  label: '🌬️ 풍차',        mark: questMarkFor('mill'), pick: () => warpPoint(26.5, -13.5) },
    { id: 'bell',  label: '🔔 종탑',        mark: questMarkFor('bell'), pick: () => warpPoint(-20.0, -2.0) },
    // 탑 좌표로 찾으면 물·충돌체를 피한 가장 가까운 뭍 자리에 내려 «탑을 바라보며» 선다
    { id: 'light', label: '🗼 기억의 등대',  mark: questMarkFor('light'), pick: () => warpPoint(LIGHTHOUSE.x, LIGHTHOUSE.z, 4) },
    { id: 'vault', label: '🏮 별빛 저장고',  mark: () => '', pick: () => warpPoint(VAULT_SPOT.x, VAULT_SPOT.z) },
    { id: 'rumi',  label: '🤖 루미 (일과 중)', mark: rumiPlaceMark, pick: rumiPick },
    { id: 'gate',  label: '🚪 마을 입구',    mark: () => '', pick: () => warpPoint(0, 12) }
  ];

  function initWarpUI() {
    if (W.warp) return;
    const screen = $('#world-screen');
    if (!screen) return;
    // ① HUD 칩 — v1.71 «의뢰 건너뛰기» 칩처럼 «button» 으로 만들어 키보드·터치가 같게 먹게 한다
    const stats = screen.querySelector('.wh-stats');
    if (stats && !$('#world-warp-chip')) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.id = 'world-warp-chip';
      chip.className = 'world-chip';
      chip.title = '빠른 이동';
      chip.textContent = '🧭 이동';
      chip.addEventListener('click', () => { if (W.warpOpen) closeWarpMenu(); else openWarpMenu(); });
      stats.appendChild(chip);
    }
    // ② 순간이동 페이드 레이어 — 캔버스 위(quiz z6 아래) 짙은 밤색 페이드. pointer-events 없음.
    const fade = document.createElement('div');
    fade.id = 'world-warp-fade';
    fade.setAttribute('style', 'position:absolute;inset:0;z-index:5;background:#0b1420;opacity:0;pointer-events:none');
    screen.appendChild(fade);
    // ③ 메뉴 오버레이 — world-quiz/wq-* 스타일 클래스 재사용
    const menu = document.createElement('div');
    menu.id = 'world-warp';
    menu.className = 'world-quiz hidden';
    menu.innerHTML =
      '<div class="wq-card"><div class="wq-head">' +
      '<span class="wq-chip">🧭 빠른 이동</span>' +
      '<button type="button" id="warp-close" class="wq-x" title="닫기">✕</button>' +
      '</div><p class="wq-q" style="margin:2px 0 12px">어디로 갈까?</p>' +
      '<div class="wq-opts" id="warp-opts"></div></div>';
    screen.appendChild(menu);
    menu.addEventListener('click', (e) => { if (e.target && e.target.id === 'world-warp') closeWarpMenu(); });
    $('#warp-close')?.addEventListener('click', closeWarpMenu);
    W.warp = { state: 'idle', fade: 0, cool: 0, dest: null, el: fade };
  }

  //  메뉴 항목 — 열 때마다 다시 그려 «의뢰·샘·루미 상태» 가 항상 현재 값으로 보인다
  function warpItems() {
    const box = $('#warp-opts');
    if (!box) return;
    box.innerHTML = '';
    WARP_DESTS.forEach((d) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'wq-opt';
      let mark = '';
      try { mark = d.mark ? (d.mark() || '') : ''; } catch (e) { }
      b.textContent = d.label + (mark ? '   ' + mark : '');
      b.addEventListener('click', () => pickWarpDest(d));
      box.appendChild(b);
    });
  }

  //  다른 패널(quiz·chat·secret·vault) 이 열려 있으면 못 연다 — v1.71 루미 클릭 게이트와 같은 조합
  function openWarpMenu() {
    if (!W.open || !W.ready || !W.root) return;
    if (W.quizOpen || W.chatOpen || W.secretOpen || W.vaultOpen) return;
    if (!W.warp || W.warp.state !== 'idle' || W.warp.cool > 0) return;   // 전환 중·쿨다운엔 무시
    warpItems();
    W.warpOpen = true;
    W.keys = {};   // 걷기 입력 즉시 해제(openWorldChat 과 같은 규칙)
    const el = $('#world-warp');
    if (el) el.classList.remove('hidden');
  }

  function closeWarpMenu() {
    W.warpOpen = false;
    const el = $('#world-warp');
    if (el) el.classList.add('hidden');
  }

  function pickWarpDest(d) {
    if (!d || !d.pick) return;
    if (d.id === 'rumi' && !W.rumi) {   // 루미가 아직 세워지지 않았으면 조용히 안내
      closeWarpMenu();
      if (typeof toast === 'function') toast('루미가 마을 어딘가를 배회하고 있어요');
      return;
    }
    closeWarpMenu();
    startWarp(d);
  }

  //  페이드 아웃 → 순간이동 → 페이드 인. 루미 시간표 전환과 «같은 속도»(dt*2.2 ≈ 0.45s×2)
  function startWarp(d) {
    if (!W.root || !W.scene || !W.warp || W.warp.state !== 'idle') return;
    W.warp.state = 'out';
    W.warp.fade = 0;
    W.warp.dest = d;
    W.warp.cool = 2;          // 연타 방지 2s 쿨다운 — 선택 순간부터
    W.keys = {};              // 이동 입력 해제
    const plain = String(d.label || '').replace(/^[^\s]+\s/, '');
    const hint = $('#world-hint');
    if (hint) hint.textContent = '🌀 ' + plain + ' — 이동 중…';
  }

  function updateWarp(dt) {
    const wp = W.warp;
    if (!wp) return;
    if (wp.cool > 0) wp.cool -= dt;
    if (wp.state === 'out') {
      wp.fade = Math.min(1, wp.fade + dt * 2.2);
      if (wp.el) wp.el.style.opacity = String(wp.fade);
      if (wp.fade >= 1) {
        // «빈자리» 는 화면이 완전히 가려진 «이 시점» 에 확정한다 — 밀리는 대상을 정확히 따라간다
        const t = wp.dest ? wp.dest.pick() : null;
        if (t && W.root) {
          W.root.position.set(t.x, heightAt(t.x, t.z), t.z);
          W.root.rotation.y = t.yaw || 0;
          if (W.cam) { W.cam.target.set(t.x, W.root.position.y + 1.3, t.z); }   // 카메라 순간 점프 방지
          W.vy = 0; W.air = 0; W.grounded = true;
          // 이전 자리 프롬프트는 «일단» 숨긴다 — 새 자리의 상호작용은 다음 프레임 근접 판정이 다시 연다
          showPrompt(false);
          W.nearType = ''; W.near = -1; W.nearStation = -1;
        }
        wp.state = 'in';
      }
    } else if (wp.state === 'in') {
      wp.fade = Math.max(0, wp.fade - dt * 2.2);
      if (wp.el) wp.el.style.opacity = String(wp.fade);
      if (wp.fade <= 0) { wp.state = 'idle'; wp.dest = null; }
    }
  }

  // ── v1.34: 세계를 나가지 않고 «그 자리에서» 대화 ──
  //   기존엔 closeWorld() 로 씬을 dispose 한 뒤 채팅을 열어, 마을이 사라졌다.
  //   이제 씬은 살려 두고 대화층만 위에 얹는다(로봇은 계속 숨쉬고 마을은 계속 움직인다).
  function openWorldChat() {
    if (!W.open || !W.ready) return;
    W.chatOpen = true;
    W.keys = {};                                  // 걷기 입력 즉시 해제
    const screen = $('#world-screen');
    if (screen) screen.classList.add('chatting');
    const panel = $('#chat-panel');
    if (panel) { panel.classList.remove('hidden'); panel.classList.add('in-world'); }
    if (typeof chatOpen === 'function') chatOpen();   // app.js 가 이력·모드·칩을 채운다
  }
  function closeWorldChat() {
    W.chatOpen = false;
    W.keys = {};
    const screen = $('#world-screen');
    if (screen) screen.classList.remove('chatting');
    const panel = $('#chat-panel');
    if (panel) { panel.classList.add('hidden'); panel.classList.remove('in-world'); }
    if (typeof chatClose === 'function') chatClose();
    try { const cv = $('#world3d'); if (cv) cv.focus(); } catch (e) { }
  }

  // 시연·테스트용 최소 노출 (내부 상태 참조)
  try {
    window.__worldState = W;
    window.__worldProbe = { blockReason, heightAt, colliders: COLL, secret: SECRET_SPOT, vault: () => VAULT_SPOT, vaultLit: () => W.vaultLit };
    // v1.37: «세계 → 게임 → 세계» 브리지. world.js 는 IIFE 라 이 창구가 필요하다.
    // v1.39: 수첩에서 생각을 고치면 세계의 등을 다시 켠다.
    // v1.44: 정비 완료 직후 마을의 등만 다시 켠다.
    // ★ 2026-11-21 (v1.73) fx 창구 — 2·3단계(낮밤/날씨/바람 흔들림) 와 설정 UI 가 소비한다.
    //   World.fx.set('birds', false) / World.fx.apply('low') / World.fx.tier()
    window.World = { open: openWorld, close: closeWorld, refresh: loadWorldQuests,
      refreshThoughts: loadThoughtSummary, refreshVillage: refreshCampaignVisuals,
      fx: { set: setWorldFx, apply: applyWorldQuality, tier: () => W.fxTier } };
  } catch (e) { }

  $('#world-prompt')?.addEventListener('click', () => {
    if (W.nearType === 'quest' && W.nearQuest) {
      if (typeof window.startWorldQuest === 'function') window.startWorldQuest(W.nearQuest);
      return;
    }
    if (W.nearType === 'vault') openVault();
    else if (W.nearType === 'secret') openSecret();
    else if (W.nearType === 'chest' && W.near >= 0) openChest(W.near);
    else if (W.nearStation >= 0) openWorldQuiz(W.nearStation);
  });
  $('#wv-close')?.addEventListener('click', closeVault);
  $('#world-vault')?.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'world-vault') closeVault();
  });
  // 수첩으로 건너가는 다리 — 세계를 닫고 마이룸의 «정비사 수첩» 을 연다 (app.js 가 창구를 연다)
  $('#wv-go')?.addEventListener('click', () => {
    closeVault();
    if (typeof window.goStoryBook === 'function') window.goStoryBook();
  });
  $('#ws-close')?.addEventListener('click', closeSecret);
  $('#world-secret')?.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'world-secret') closeSecret();
  });
  // v1.37: 별 3개로 얻은 «건너뛰기 1장» 은 HUD 칩을 눌러 쓴다
  $('#world-quests')?.addEventListener('click', async () => {
    if (!W.questSkipReady || typeof api !== 'function') return;
    const target = QUEST_SPOTS.find(s => !W.questDone.has(s.key));
    if (!target) return;
    try {
      const r = await api('/api/world/quest/skip', { quest: target.key }, 8000);
      if (r && r.ok) {
        if (typeof toast === 'function') toast('🎫 의뢰 한 건을 건너뛰었어!');
        loadWorldQuests();
      }
    } catch (e) { if (typeof toast === 'function') toast(e.message); }
  });
  $('#wq-close')?.addEventListener('click', closeWorldQuiz);
  $('#world-quiz')?.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'world-quiz') closeWorldQuiz();
  });

  $('#btn-world')?.addEventListener('click', openWorld);
  $('#world-close')?.addEventListener('click', closeWorld);
  // v1.34: 세계를 유지한 채 그 자리에서 대화한다(씬 dispose 없음).
  $('#world-chat')?.addEventListener('click', () => { openWorldChat(); });
  // 패널 자체의 ✕ 로 닫아도 걷기 잠금이 풀리도록 상태를 맞춘다
  $('#chat-close')?.addEventListener('click', () => { if (W.chatOpen) closeWorldChat(); });
  // ★ 2026-11-21 (v1.74) 빠른 이동 — HUD 칩·메뉴·페이드 DOM 을 한 번 만들어 둔다(페이지 로드 시점).
  //   #world-screen 이 정적 HTML 이므로 씬 열고 닫기와 무관하게 재사용된다.
  try { initWarpUI(); } catch (e) { /* 칩 하나 실패가 세계를 멈추지 않게 */ }
})();
