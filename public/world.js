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
    bush1: 0.5, bush2: 0.48, bushBerry: 0.5
  };
  const COLL = [];

  const W = {
    engine: null, scene: null, cam: null, root: null, model: null, anims: {},
    keys: {}, stars: [], collected: 0, ready: false, open: false, opening: false,
    vy: 0, air: 0, grounded: true, animName: '', animLock: 0,
    clouds: [], birds: null, windmills: [], fires: [], shadow: null, glow: null,
    onKeyDown: null, onKeyUp: null, onResize: null, water: null, waterBump: null,
    water2: null, waterBump2: null, t: 0, waterBlocked: 0, boomIdeal: 12, lastRadius: 12,
    stations: [], lessons: null, nearStation: -1, quizOpen: false, lessonDone: 0
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
    dt.update(false);
    dt.uScale = 5; dt.vScale = 5;
    dt.anisotropicFilteringLevel = 8;
    return dt;
  }

  // 흙길 텍스처 (리본 UV 를 따라 늘어난다)
  function pathTexture(scene) {
    const W2 = 128, H2 = 256;
    const dt = new BABYLON.DynamicTexture('wPathTex', { width: W2, height: H2 }, scene, true);
    const g = dt.getContext();
    g.fillStyle = '#b09a72'; g.fillRect(0, 0, W2, H2);
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
    // 가장자리를 부드럽게 (알파 페이드)
    const img = g.getImageData(0, 0, W2, H2);
    for (let y = 0; y < H2; y++) {
      for (let x = 0; x < W2; x++) {
        const edge = Math.min(x, W2 - 1 - x) / (W2 * 0.26);
        const a = clamp(edge, 0, 1);
        img.data[(y * W2 + x) * 4 + 3] = a * 255;
      }
    }
    g.putImageData(img, 0, 0);
    dt.update(false); dt.hasAlpha = true;
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

    return water;
  }

  // 지형을 따라 흐르는 오솔길 리본
  function createPath(scene, pts, width) {
    const dirs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      dirs.push(new BABYLON.Vector2(b[0] - a[0], b[1] - a[1]).normalize());
    }
    const sections = [];
    const n = 36; // 구간당 샘플 수
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const d = dirs[i];
      const perp = new BABYLON.Vector2(-d.y, d.x);
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const x = lerp(a[0], b[0], t), z = lerp(a[1], b[1], t);
        // 가장자리를 살짝 흔들어 자연스럽게
        const jitter = (rnd() - 0.5) * width * 0.02;
        const w2 = width * 0.5 + jitter;
        const p1 = new BABYLON.Vector3(x - perp.x * w2, 0, z - perp.y * w2);
        const p2 = new BABYLON.Vector3(x + perp.x * w2, 0, z + perp.y * w2);
        p1.y = heightAt(p1.x, p1.z) + 0.055;
        p2.y = heightAt(p2.x, p2.z) + 0.055;
        sections.push([p1, p2]);
      }
    }
    const ribbon = BABYLON.MeshBuilder.CreateRibbon('wPath',
      { pathArray: sections, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
    ribbon.isPickable = false;
    ribbon.receiveShadows = true;
    const pm = pbr(scene, 'wPathMat', '#c2ad86', 0.98, 0);
    pm.albedoTexture = pathTexture(scene);
    pm.alpha = 0.95;
    pm.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    pm.zOffset = -2;
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
    PROTO[key] = { holder, container, targetH: targetH || 1 };
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
      const cr = COLL_R[key] * (scale == null ? 1 : scale);
      if (cr > 0.12) COLL.push({ x, z, r: cr });
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
  function makeSign(scene, x, z, rotY) {
    const y = heightAt(x, z);
    const wood = pbr(scene, 'signWood', '#8b5e3c', 0.85, 0);
    const woodLight = pbr(scene, 'signWoodL', '#c79a66', 0.8, 0);
    const paint = pbr(scene, 'signPaint', '#f0e0c0', 0.7, 0);
    const node = new BABYLON.TransformNode('signNode', scene);
    node.position.set(x, y, z);
    node.rotation.y = rotY == null ? 0 : rotY;

    // 기둥
    const post = BABYLON.MeshBuilder.CreateCylinder('signPost', { height: 2.1, diameter: 0.16, tessellation: 10 }, scene);
    post.position.y = 1.05; post.parent = node;
    post.material = wood; post.castShadow = true; post.receiveShadows = true; post.isPickable = false;

    // 널판 (오른쪽을 가리키는 화살표)
    const plank = BABYLON.MeshBuilder.CreateBox('signPlank', { width: 2.0, height: 0.56, depth: 0.09 }, scene);
    plank.position.set(0.15, 1.82, 0); plank.parent = node;
    plank.material = woodLight; plank.castShadow = true; plank.receiveShadows = true; plank.isPickable = false;

    // 화살촉
    const head = BABYLON.MeshBuilder.CreateCylinder('signHead',
      { height: 0.10, diameterTop: 0, diameterBottom: 0.86, tessellation: 3 }, scene);
    head.position.set(1.32, 1.82, 0); head.parent = node;
    head.rotation.x = Math.PI / 2; head.rotation.z = -Math.PI / 2;
    head.material = woodLight; head.castShadow = true; head.isPickable = false;

    // 판 위의 장식 띠 (글자 대신)
    [0.0, 0.42].forEach((off, i) => {
      const band = BABYLON.MeshBuilder.CreateBox('signBand' + i, { width: 0.94 - i * 0.3, height: 0.085, depth: 0.02 }, scene);
      band.position.set(-0.42 + off, 1.90 - i * 0.18, 0.055); band.parent = node;
      band.material = paint; band.isPickable = false;
    });

    // 작은 지붕
    const cap = BABYLON.MeshBuilder.CreateCylinder('signCap',
      { height: 0.34, diameterTop: 0.02, diameterBottom: 0.72, tessellation: 4 }, scene);
    cap.position.y = 2.22; cap.parent = node; cap.rotation.y = Math.PI / 4;
    cap.material = wood; cap.castShadow = true; cap.isPickable = false;
    return post;
  }

  function makeCampfire(scene, x, z) {
    const y = heightAt(x, z);
    const stone = pbr(scene, 'cfStone', '#6f7278', 0.9, 0);
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const s = BABYLON.MeshBuilder.CreateSphere('cfS' + i, { diameter: 0.36, segments: 8 }, scene);
      s.position.set(x + Math.cos(a) * 0.95, y + 0.12, z + Math.sin(a) * 0.95);
      s.scaling.y = 0.55; s.material = stone; s.receiveShadows = true; s.isPickable = false;
    }
    const wood = pbr(scene, 'cfWood', '#5a3b28', 0.9, 0);
    for (let i = 0; i < 4; i++) {
      const l = BABYLON.MeshBuilder.CreateCylinder('cfL' + i, { height: 1.15, diameter: 0.13, tessellation: 8 }, scene);
      l.position.set(x, y + 0.2, z);
      l.rotation.z = Math.PI / 2.6; l.rotation.y = i * Math.PI / 4;
      l.material = wood; l.isPickable = false; l.receiveShadows = true;
    }
    const flameM = emissiveMat(scene, 'cfFlameM', '#ff8f2e', 1.05);
    const flame = BABYLON.MeshBuilder.CreateCylinder('cfFlame', { height: 0.9, diameterTop: 0, diameterBottom: 0.55, tessellation: 10 }, scene);
    flame.position.set(x, y + 0.5, z); flame.material = flameM; flame.isPickable = false;
    const light = new BABYLON.PointLight('cfLight', new BABYLON.Vector3(x, y + 0.9, z), scene);
    light.diffuse = new BABYLON.Color3(1, 0.62, 0.28);
    light.intensity = 0.9; light.range = 9;
    W.fires.push({ obj: flame, light, base: y + 0.5, phase: rnd() * 6 });
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
    const grassM = pbr(scene, 'fiGrass', '#7cab5c', 0.94, 0);
    const rockM = pbr(scene, 'fiRock', '#7b6c62', 0.95, 0);
    const top = BABYLON.MeshBuilder.CreateCylinder('fiTop', { height: 0.7 * s, diameter: 5.6 * s, tessellation: 16 }, scene);
    top.position.set(x, y, z); top.material = grassM; top.receiveShadows = true; top.isPickable = false;
    const bottom = BABYLON.MeshBuilder.CreateCylinder('fiBottom', { height: 3.6 * s, diameterTop: 5.1 * s, diameterBottom: 0.4 * s, tessellation: 10 }, scene);
    bottom.position.set(x, y - 2.1 * s, z); bottom.material = rockM; bottom.isPickable = false;
    // 폭포
    const wm = pbr(scene, 'fiWater', '#9edcf0', 0.2, 0);
    wm.alpha = 0.55;
    wm.emissiveColor = new BABYLON.Color3(0.35, 0.62, 0.7);
    wm.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
    const fall = BABYLON.MeshBuilder.CreatePlane('fiFall', { width: 0.9 * s, height: 3.4 * s }, scene);
    fall.position.set(x + 2.0 * s, y - 1.7 * s, z);
    fall.material = wm; fall.isPickable = false;
    // 섬 위 나무
    if (PROTO.treeRound) spawn('treeRound', x - 1.1 * s, z - 0.2 * s, 0.55 * s, rr(0, 6), { y: y + 0.36 * s, shadow: false });
    if (PROTO.treePine) spawn('treePine', x + 1.2 * s, z + 0.7 * s, 0.45 * s, rr(0, 6), { y: y + 0.36 * s, shadow: false });
    return { top, bottom };
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
    W.stars.forEach((s) => {
      if (s.collected) return;
      const d = BABYLON.Vector3.Distance(W.root.position, s.node.position);
      if (d < 2.0) {
        s.collected = true;
        s.node.setEnabled(false);
        if (s.light) s.light.setEnabled(false);
        W.collected++;
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
    // 풍차
    W.windmills.forEach((w, i) => { w.rotation.z += dt * (0.55 + i * 0.1); });
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

    const k = W.quizOpen ? {} : W.keys;
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

    // 학습 스테이션 근접 판정
    let near = -1;
    if (!W.quizOpen) {
      for (let i = 0; i < W.stations.length; i++) {
        const s = W.stations[i];
        if (s.solved) continue;
        if (Math.hypot(W.root.position.x - s.x, W.root.position.z - s.z) < 3.4) { near = i; break; }
      }
    }
    if (near !== W.nearStation) {
      W.nearStation = near;
      showPrompt(near >= 0);
    }
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
    if (PROTO.mill) W.windmills.push(spawn('mill', 26.5, -13.5, 1.05, -0.6, { shadow: true }));
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
  }

  function buildNature(scene) {
    // ── 숲 (마을 밖 고리 형태)
    const treeKinds = ['treePine', 'treePine', 'treeRound', 'treeRound', 'treeRound', 'treeBirch', 'treeWillow'];
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
      const k = rnd() < 0.35 ? 'bushBerry' : (rnd() < 0.5 ? 'bush1' : 'bush2');
      spawn(k, x, z, rr(0.7, 1.5), rr(0, 6.28), { shadow: false });
    }
    // ── 바위
    for (let i = 0; i < 180; i++) {
      const a = rnd() * Math.PI * 2, r = 7 + Math.pow(rnd(), 0.8) * 58;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = heightAt(x, z);
      if (h < WATER_Y - 0.1) continue;
      const k = rnd() < 0.35 ? 'rockMoss' : 'rock';
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
        spawn('rock', x, z, rr(0.4, 0.95), rr(0, 6.28), { shadow: false, yOff: -0.1 });
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
    // 잔디 (많이, 합쳐서 드로우콜 절약)
    if (PROTO.grass) {
      const list = [];
      let grassMat = null;
      for (let i = 0; i < 900; i++) {
        const a = rnd() * Math.PI * 2, r = 5 + rnd() * 55;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (heightAt(x, z) < WATER_Y + 0.35) continue;
        const w = spawn('grass', x, z, rr(0.7, 1.5), rr(0, 6.28), { shadow: false });
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
    if (PROTO.plant) {
      for (let i = 0; i < 48; i++) {
        const a = rnd() * Math.PI * 2, r = 9 + rnd() * 52;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (heightAt(x, z) < WATER_Y + 0.4) continue;
        spawn('plant', x, z, rr(0.45, 0.8), rr(0, 6.28), { shadow: false });
      }
    }
  }

  // ────────────────────────── 초기화 ──────────────────────────
  function setLoadMsg(txt) {
    const el = $('#world-loading span');
    if (el) el.textContent = txt;
  }

  async function loadAllProps(scene) {
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
      ['cart', 'village', 'Cart', 1.8, null]
    ];
    // 동시 5개씩 병렬 로드 — 순차 로드보다 3~4배 빠르다
    let done = 0, idx = 0;
    const total = jobs.length;
    const worker = async () => {
      while (idx < jobs.length) {
        const [key, folder, file, h, opt] = jobs[idx++];
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

    // 로봇 (GLTF 로더 준비 대기)
    await waitFor(() => BABYLON.SceneLoader &&
      (!BABYLON.SceneLoader.IsPluginForExtensionAvailable || BABYLON.SceneLoader.IsPluginForExtensionAvailable('.glb')), 6000);

    setLoadMsg('마을을 짓는 중… 0/35');
    await loadAllProps(scene);

    setLoadMsg('나무와 집을 배치하는 중…');
    buildVillage(scene);
    buildNature(scene);
    buildGroundCover(scene);
    makeFloatingIsland(scene, -30, 18.0, -26, 1.15);
    makeFloatingIsland(scene, 38, 21.0, -14, 0.95);
    createClouds(scene);
    createBirds(scene);
    createStars(scene);
    createStations(scene);

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
    loadWorldLessons();
    setTimeout(() => engine.resize(), 60);
  }

  function bindKeys() {
    W.onKeyDown = (e) => {
      if (!W.open) return;
      const key = String(e.key || '').toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) e.preventDefault();
      if (key === 'w' || key === 'arrowup') W.keys.w = true;
      if (key === 's' || key === 'arrowdown') W.keys.s = true;
      if (key === 'a' || key === 'arrowleft') W.keys.a = true;
      if (key === 'd' || key === 'arrowright') W.keys.d = true;
      if (key === 'shift') W.keys.shift = true;
      if (key === ' ' && W.grounded && !W.animLock) { W.grounded = false; W.vy = 5.4; W.air = 0.01; oneShot('Jump', 900); }
      if (key === 'escape') { if (W.quizOpen) closeWorldQuiz(); else closeWorld(); }
      if ((key === 'e' || key === 'enter') && W.nearStation >= 0 && !W.quizOpen) openWorldQuiz(W.nearStation);
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
    W.collected = 0; W.ready = false; W.keys = {}; W.animName = ''; W.animLock = 0;
    W.stations = []; W.lessons = null; W.nearStation = -1; W.quizOpen = false; W.lessonDone = 0;
    showPrompt(false); closeWorldQuiz();
    COLL.length = 0; W.boomIdeal = 12; W.lastRadius = 12;
    W.vy = 0; W.air = 0; W.grounded = true; W.t = 0;
    for (const k in PROTO) delete PROTO[k];
    if (screen) screen.classList.add('hidden');
    const loading = $('#world-loading'); if (loading) loading.classList.remove('hidden');
    const st = $('#world-stars'); if (st) st.textContent = '⭐ 0 / 3';
    const ls = $('#world-lessons'); if (ls) ls.textContent = '📖 0 / 3';
    const hint = $('#world-hint'); if (hint) hint.textContent = '드래그로 둘러보고, WASD로 걸어요';
    const fab = $('#chat-fab'); if (fab) fab.classList.remove('hidden');
  }

  // 시연·테스트용 최소 노출 (내부 상태 참조)
  try { window.__worldState = W; window.__worldProbe = { blockReason, heightAt, colliders: COLL }; } catch (e) {}

  $('#world-prompt')?.addEventListener('click', () => {
    if (W.nearStation >= 0) openWorldQuiz(W.nearStation);
  });
  $('#wq-close')?.addEventListener('click', closeWorldQuiz);
  $('#world-quiz')?.addEventListener('click', (e) => {
    if (e.target && e.target.id === 'world-quiz') closeWorldQuiz();
  });

  $('#btn-world')?.addEventListener('click', openWorld);
  $('#world-close')?.addEventListener('click', closeWorld);
  $('#world-chat')?.addEventListener('click', () => {
    closeWorld();
    setTimeout(() => { if (typeof chatOpen === 'function') chatOpen(); }, 180);
  });
})();
