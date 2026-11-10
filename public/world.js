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
    vaultOpen: false, vaultLit: 0, vaultFixed: 0, vaultLamps: [], vaultSpot: null, vaultGlow: null  // v1.39 별빛 저장고
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
      const bump = normalTexture(scene, 'wGroundNrm', 128, 1.6, 3);
      bump.uScale = 38; bump.vScale = 38;
      gm.bumpTexture = bump;
      gm.bumpTexture.level = 0.28;
    } catch (e) { /* 노멀맵 없이도 동작 */ }
    ground.material = gm;

    const water = createWater(scene);
    return { ground, water };
  }

  function createWater(scene) {
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
    water.material = wm;
    W.water = water;

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
    } catch (e) { /* 얕은 물 띠 없이도 동작 */ }

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
    return PROTO[key];
  }

  // 원본을 복제해 배치. wrap 노드가 위치/회전/배율을 담당.
  function spawn(key, x, z, scale, rotY, opts) {
    const p = PROTO[key];
    if (!p) return null;
    const o = opts || {};
    const wrap = new BABYLON.TransformNode('sp_' + key, scene());
    const c = p.holder.clone('m_' + key, wrap);
    if (!c) { wrap.dispose(); return null; }
    c.setEnabled(true);
    const y = (o.y != null) ? o.y : (heightAt(x, z) + (o.yOff || 0));
    wrap.position.set(x, y, z);
    wrap.rotation.y = rotY == null ? 0 : rotY;
    wrap.scaling.setAll(scale == null ? 1 : scale);
    // 충돌체 등록 (건물·나무·바위 등 통과 방지)
    if (o.collide !== false && COLL_R[key]) {
      const sc = (scale == null ? 1 : scale);
      if (key === 'fence' && p.w && p.d) {
        // 긴 축을 따라 선분 충돌체 (원형이면 끝을 통과해 버린다)
        const half = (Math.max(p.w, p.d) / 2) * sc * 0.92;
        const ry = rotY == null ? 0 : rotY;
        const ax = Math.cos(ry) * half, az = -Math.sin(ry) * half;
        SEGS.push({ x1: x - ax, z1: z - az, x2: x + ax, z2: z + az, r: 0.34 });
      } else {
        const cr = COLL_R[key] * sc;
        if (cr > 0.12) COLL.push({ x, z, r: cr });
      }
    }
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
    W.fires.push({ obj: flame, light: ember, base: y + 0.46, phase });
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
        list.push({ sp, r: rr(20, 46), a: rr(0, 6.28), y: rr(16, 30), spd: rr(0.1, 0.24) });
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
    fountain:  { kind: 'fountain',x: 0.0, z: 6.6, s: 1.0 }
  };
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
      const glass = emissiveMat(scene, 'vpGlass' + key, '#ffd08a', 1.05);
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
      const lt = new BABYLON.PointLight('vpL' + key, new BABYLON.Vector3(x, y + 2.45, z), scene);
      lt.diffuse = new BABYLON.Color3(1, 0.82, 0.5); lt.intensity = 0.6; lt.range = 7;
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
      const keys = (r && r.props) || [];
      W.villageKeys = keys;
      keys.forEach((k) => {
        const slot = VILLAGE_SLOTS[k];
        if (!slot) return;
        if (slot.kind !== 'lantern' && slot.kind !== 'banner' && slot.kind !== 'fountain') {
          if (blockReason(slot.x, slot.z)) return;   // 이미 다른 소품이 있으면 건너뛴다
          spawn(slot.kind, slot.x, slot.z, slot.s, rnd() * 6.28, { shadow: true });
        } else {
          makeVillageProp(scene, slot, k);
        }
      });
      const el = $('#world-village');
      if (el) el.textContent = `🌳 ${keys.length}`;
    } catch (e) { /* 로그인 전이면 생략 */ }
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
    { key:'bell', x:-20.0, z:-2.0,  label:'종탑' }
  ];
  const QUEST_PROMPT = {
    well:'우물이 버그로 막혔어 · 두더지 300점',
    mill:'풍차가 멈췄어 · 슈터 800점 + 목숨 1개',
    bell:'종탑이 잠들었어 · 퍼즐 3문제 한 번에'
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
    W.questDone.forEach(key => {
      const sp = QUEST_SPOTS.find(s => s.key === key);
      if(!sp) return;
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
    if(hud) hud.textContent = `🛠 ${W.questDone.size} / 3`;
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
      buildQuestMarks(W.scene);
      applyQuestVisuals();
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
  function makeChest(scene, sp, i) {
    const wood = pbr(scene, 'chestWood' + i, '#8a5a34', 0.85, 0);
    const gold = emissiveMat(scene, 'chestGold' + i, '#ffd15c', 0.9);
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
    // 멀리서도 보이는 표식 (떠 있는 빛)
    const beacon = BABYLON.MeshBuilder.CreateSphere('chestBeacon' + i, { diameter: 0.34, segments: 8 }, scene);
    beacon.position.y = 1.75; beacon.parent = node; beacon.material = gold; beacon.isPickable = false;
    const glow = BABYLON.MeshBuilder.CreateDisc('chestGlow' + i, { radius: 0.85, tessellation: 20 }, scene);
    glow.rotation.x = Math.PI / 2; glow.position.y = 0.02; glow.parent = node;
    const gm = emissiveMat(scene, 'chestGlowM' + i, '#ffd98a', 0.7);
    gm.alpha = 0.35; gm.backFaceCulling = false; glow.material = gm; glow.isPickable = false;
    const light = new BABYLON.PointLight('chestLt' + i, new BABYLON.Vector3(sp.x, y + 1, sp.z), scene);
    light.diffuse = new BABYLON.Color3(1, 0.85, 0.5); light.intensity = 0.5; light.range = 4.5;
    W.chests.push({ x: sp.x, z: sp.z, node, lid, band, glow, light, beacon, claimed: false });
  }
  function setChestClaimed(i) {
    const c = W.chests[i];
    if (!c) return;
    c.claimed = true;
    try {
      c.lid.position.y = 0.97; c.lid.rotation.x = -0.55;
      c.light.intensity = 0.08;
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
    // 저장고 자체의 따뜻한 불빛 — 켜진 등 수에 따라 세진다
    const glow = new BABYLON.PointLight('vaultGlow', new BABYLON.Vector3(0, 1.6, 0), scene);
    glow.parent = node;
    glow.diffuse = new BABYLON.Color3(1.0, 0.80, 0.42);
    glow.intensity = 0.16;
    glow.range = 9.5;
    W.vaultGlow = glow;

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
    const mat = emissiveMat(scene, 'sfM' + Math.floor(rnd() * 9999), '#fff3c4', 1.8);
    const orb = BABYLON.MeshBuilder.CreateSphere('starfall', { diameter: 0.55, segments: 10 }, scene);
    orb.material = mat; orb.isPickable = false;
    orb.position.set(x + 26, y + 24, z + 26);
    const lt = new BABYLON.PointLight('sfLt', new BABYLON.Vector3(x, y + 1.5, z), scene);
    lt.diffuse = new BABYLON.Color3(1, 0.95, 0.7); lt.intensity = 0; lt.range = 9;
    W.starfall = { x, z, y, orb, lt, t: 0, phase: 'fall', life: 0 };
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
      if (k >= 1) { sf.phase = 'idle'; sf.life = 22; sf.orb.position.set(sf.x, sf.y + 0.9, sf.z); sf.lt.intensity = 1.1; }
    } else if (sf.phase === 'idle') {
      sf.life -= dt;
      sf.orb.position.y = sf.y + 0.9 + Math.sin(W.t * 2.4) * 0.18;
      sf.orb.rotation.y += dt * 2;
      sf.lt.intensity = 1.0 + Math.sin(W.t * 5) * 0.25;
      const d = Math.hypot(W.root.position.x - sf.x, W.root.position.z - sf.z);
      if (d < 2.2) {
        sf.phase = 'taken';
        collectStarfall();
      } else if (sf.life <= 0) {
        sf.phase = 'gone';
        try { sf.orb.dispose(); sf.lt.dispose(); } catch (e) { }
        W.starfall = null;
      }
    }
  }
  async function collectStarfall() {
    const sf = W.starfall;
    try { if (sf) { sf.orb.dispose(); sf.lt.dispose(); } } catch (e) { }
    W.starfall = null;
    W.starTimer = 45 + rnd() * 25;
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

  function update(dt) {
    if (!W.scene) return;
    W.t += dt;
    // 물결 애니메이션
    if (W.waterBump) {
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
      if (f.light) f.light.intensity = 0.8 + Math.sin(W.t * 11 + i) * 0.22;
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
      c.position.x += dt * 0.55;
      if (c.position.x > 128) c.position.x = -128;
    });
    if (W.birds) {
      W.birds.forEach((b, i) => {
        b.a += dt * b.spd;
        b.sp.position.set(Math.cos(b.a) * b.r, b.y + Math.sin(W.t * 0.8 + i) * 0.7, Math.sin(b.a) * b.r);
      });
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
    const k = (W.quizOpen || W.chatOpen || W.secretOpen) ? {} : W.keys;
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
    if (!W.quizOpen && !W.chatOpen && !W.secretOpen && !W.vaultOpen) {
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
  }

  // ────────────────────────── 마을 배치 ──────────────────────────
  function buildVillage(scene) {
    const S = scene;
    // ── 오솔길 (입구 → 광장 → 마을 안쪽)
    createPath(S, [[0, 26], [0.4, 20], [-0.5, 14], [-1.0, 8], [0, 2], [0.6, -3.5], [0.2, -9]], 2.8);
    createPath(S, [[0, 2], [-5.5, -0.5], [-11, -3.5], [-16.5, -8.5]], 2.4);
    createPath(S, [[0.2, -9], [5.5, -11.5], [11.5, -13.5], [17, -12]], 2.2);
    createPath(S, [[0, 8], [6.5, 8.0], [12, 8.5], [16.5, 9.5]], 2.0);
    // 바깥 권역으로 이어지는 길
    createPath(S, [[-1.5, 10], [-9, 12], [-18, 15], [-28, 18], [-37, 19.5]], 1.9);
    createPath(S, [[0.2, -14], [8, -20], [18, -25], [27, -30], [33, -32]], 1.9);
    createPath(S, [[-13.5, -4], [-19, -12], [-25, -22], [-30, -32], [-33, -37]], 1.8);

    makeSign(S, 2.9, 15.2, Math.PI - 0.08);

    // ── 집들
    const houses = [
      ['house1', -11.5, -13.0, 1.0, 0.24],
      ['house2', 11.0, -15.0, 1.0, -0.3],
      ['house3', -10.0, -21.5, 0.95, 0.1],
      ['house4', 9.0, -23.0, 0.95, -0.16],
      ['inn', 0.5, -25.0, 0.95, Math.PI],
      ['blacksmith', -18.5, -16.5, 1.0, 0.62],
      ['stable', 19.5, -18.5, 1.0, -0.5],
      ['house1', -21.0, -8.0, 0.85, 0.85],
      ['house3', 18.0, -6.0, 0.82, -0.9]
    ];
    houses.forEach(([k, x, z, s, rot]) => {
      const w = spawn(k, x, z, s, rot, { shadow: true });
      if (w) w.__kind = 'house';
    });

    // ── 큰 구조물
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
      }
    }
    if (PROTO.belltower) spawn('belltower', -20.0, -2.0, 1.0, 0.2, { shadow: true });
    if (PROTO.well) spawn('well', 0.5, -8.5, 1.0, 0.3, { shadow: true });
    if (PROTO.gazebo) spawn('gazebo', 15.5, -25.5, 1.0, -0.25, { shadow: true });
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
        spawn('lilypad', x, z, rr(0.4, 0.75), rr(0, 6.28), { y: WATER_Y + 0.04, shadow: false });
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
  function buildGroundCover(scene) {
    // 잔디 (많이, 합쳐서 드로우콜 절약) — v1.33 3종 변형을 인덱스 노이즈로 섞는다
    const grassPool = ['grass', 'grass2', 'grassShort'].filter(k => PROTO[k]);
    if (grassPool.length) {
      const list = [];
      let grassMat = null;
      for (let i = 0; i < 900; i++) {
        const a = rnd() * Math.PI * 2, r = 5 + rnd() * 55;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (heightAt(x, z) < WATER_Y + 0.35) continue;
        const gk = grassPool[(nz(i, 35) * grassPool.length) | 0];
        const w = spawn(gk, x, z, rr(0.7, 1.5), rr(0, 6.28), { shadow: false });
        if (!w) continue;
        w.getChildMeshes(false).forEach((m) => {
          if (!grassMat && m.material) grassMat = m.material;
          m.setParent(null);          // 월드 변환 유지한 채 분리
          list.push(m);
        });
        w.dispose();
      }
      if (list.length > 1) {
        try {
          const so = list[0].sideOrientation;
          list.forEach((m) => { m.sideOrientation = so; });
          if (grassMat && grassMat.backFaceCulling !== undefined) grassMat.backFaceCulling = false;
          const merged = BABYLON.Mesh.MergeMeshes(list, true, true, undefined, false, false);
          if (merged) {
            merged.name = 'wGrassMerged';
            merged.isPickable = false;
            merged.receiveShadows = true;
            if (grassMat) merged.material = grassMat;
          }
        } catch (e) { /* 합치기 실패 시 개별 유지 */ }
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

    await waitFor(() => BABYLON.SkyMaterial, 4000);
    setLoadMsg('하늘을 만드는 중…');
    createSky(scene);
    const lights = createLights(scene);

    setLoadMsg('땅을 만드는 중…');
    createTerrain(scene);
    createDistantRidges(scene);    // v1.33 원경 능선 3겹 (에셋 로딩과 무관)

    // 로봇 (GLTF 로더 준비 대기)
    await waitFor(() => BABYLON.SceneLoader &&
      (!BABYLON.SceneLoader.IsPluginForExtensionAvailable || BABYLON.SceneLoader.IsPluginForExtensionAvailable('.glb')), 6000);

    // ── 1단계: 마을에 필요한 에셋만 먼저 (건물·소품 + 정원 나무)
    const CORE_KEYS = ['house1', 'house2', 'house3', 'house4', 'inn', 'blacksmith',
      'stable', 'mill', 'belltower', 'well', 'market', 'gazebo', 'fence', 'bench',
      'barrel', 'crate', 'hay', 'cart', 'treeRound', 'treeBirch', 'bonfire'];
    setLoadMsg('마을을 짓는 중…');
    await loadAllProps(scene, CORE_KEYS);
    buildVillage(scene);

    setLoadMsg('루미를 데려오는 중…');
    const loaded = await loadRobot(scene);
    W.root = loaded.root; W.model = loaded.model; W.anims = loaded.anims;

    scene.onBeforeRenderObservable.add(() => { update(engine.getDeltaTime() / 1000); });

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

    bindKeys();
    W.onResize = () => engine.resize();
    window.addEventListener('resize', W.onResize);
    engine.runRenderLoop(() => scene.render());
    W.ready = true;
    startPresence();                  // v1.35 친구 위치 동기화 시작
    loadWorldQuests();                // v1.37 오늘의 의뢰 표식 · 완료 흔적
    loadWorldLessons();
    setTimeout(() => engine.resize(), 60);
    // ── 2단계: 숲·바닥·별·거점은 화면이 뜬 뒤 백그라운드로 채운다
    setTimeout(() => { buildRest(scene); }, 80);
  }

  async function buildRest(scene) {
    try {
      const CORE = ['house1', 'house2', 'house3', 'house4', 'inn', 'blacksmith',
        'stable', 'mill', 'belltower', 'well', 'market', 'gazebo', 'fence', 'bench',
        'barrel', 'crate', 'hay', 'cart', 'treeRound', 'treeBirch', 'bonfire'];
      await loadAllProps(scene, null, CORE);   // CORE 는 건너뛰고 나머지
      buildNature(scene);
      buildGroundCover(scene);
      // v1.33 부유섬은 장식이 많아 «한 섬이 실패해도» 나머지 월드가 살아있도록 개별 보호
      try { makeFloatingIsland(scene, -30, 18.0, -26, 1.15); } catch (e) { console.warn('[world] island A', e && e.message); }
      try { makeFloatingIsland(scene, 38, 21.0, -14, 0.95); } catch (e) { console.warn('[world] island B', e && e.message); }
      createClouds(scene);
      createBirds(scene);
      createStars(scene);
      createStations(scene);
      CHEST_SPOTS.forEach((sp, i) => { try { makeChest(scene, sp, i); } catch (e) { } });
      try { buildSecretSign(scene); } catch (e) { console.warn('[world] secret sign', e && e.message); }
      try { buildThoughtVault(scene); } catch (e) { console.warn('[world] thought vault', e && e.message); }
      try { loadVillage(scene); } catch (e) { }
      try { loadTreasure(); } catch (e) { }
      try { loadThoughtSummary(); } catch (e) { }   // v1.39 고쳐 쓴 생각 수만큼 저장고 등을 켠다
    } catch (e) { console.warn('[world] rest build', e && e.message); }
  }

  function bindKeys() {
    W.onKeyDown = (e) => {
      if (!W.open) return;
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
      if (key === 'escape') { if (W.secretOpen) closeSecret(); else if (W.vaultOpen) closeVault(); else if (W.quizOpen) closeWorldQuiz(); else closeWorld(); }
      if ((key === 'e' || key === 'enter') && !W.quizOpen && !W.secretOpen && !W.vaultOpen) {
        if (W.nearPeer) { waveToPeer(W.nearPeer); return; }   // v1.35 친구 인사가 우선
        if (W.nearType === 'vault') openVault();
        else if (W.nearType === 'secret') openSecret();
        else if (W.nearType === 'chest' && W.near >= 0) openChest(W.near);
        else if (W.nearStation >= 0) openWorldQuiz(W.nearStation);
      }
    };
    W.onKeyUp = (e) => {
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
    if (cvs) cvs.addEventListener('wheel', () => {
      clearTimeout(W.__wheelT);
      W.__wheelT = setTimeout(() => { if (W.cam) W.boomIdeal = W.cam.radius; }, 320);
    }, { passive: true });
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
      if (loading) loading.classList.add('hidden');
      W.open = true;
    } catch (e) {
      console.error('[world]', e);
      if (loading) loading.innerHTML = '<span>AI 마을을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</span>';
      if (fab) fab.classList.remove('hidden');
    } finally { W.opening = false; }
  }

  function closeWorld() {
    const screen = $('#world-screen');
    if (!W.open && !W.ready) { if (screen) screen.classList.add('hidden'); return; }
    if (W.chatOpen) closeWorldChat();      // v1.34 대화층도 함께 닫는다
    stopPresence();                        // v1.35 친구 동기화 중지 + «마을 떠남» 알림
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
    W.collected = 0; W.ready = false; W.keys = {}; W.animName = ''; W.animLock = 0;
    W.stations = []; W.lessons = null; W.nearStation = -1; W.quizOpen = false; W.lessonDone = 0; W.villageKeys = [];
    W.chests = []; W.nearType = ''; W.near = -1; W.starfall = null; W.starTimer = 40;
    W.secretOpen = false; W.secretSign = null;   // v1.38 이정표 상태 초기화(씬은 아래에서 dispose)
    W.vaultOpen = false; W.vaultLit = 0; W.vaultFixed = 0; W.vaultLamps = []; W.vaultSpot = null; W.vaultGlow = null;  // v1.39
    W.floaters = []; W.fallTex = null;          // v1.33 부유 쇄석·폭포 텍스처 참조 해제
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

      const walking = p.anim === 'Walk' || p.anim === 'Run';
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
    window.World = { open: openWorld, close: closeWorld, refresh: loadWorldQuests, refreshThoughts: loadThoughtSummary };
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
})();
