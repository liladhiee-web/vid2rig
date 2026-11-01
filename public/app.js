// Prompt2Rig — Video Upload → MediaPipe Live Pose → Mixamo Rigging,
// with optional GVHMR GPU HQ Pass, GLB & BVH Export, and smooth lag-free performance.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { FilesetResolver, PoseLandmarker, DrawingUtils } from '@mediapipe/tasks-vision';
import { createStage } from './stage.js';
import { HAND_LIMITS, Rig, OneEuro, Track, trackToClip, blendSnapshots, smplGlobals, aaToQuat } from './retarget.js';
import { exportBVHFile } from './bvhExport.js';

const $ = (s) => document.querySelector(s);

// Mixamo-rigged characters
const THREE_MODELS = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r169/examples/models/gltf/';
const CHARACTERS = {
  xbot: { name: 'X Bot', url: THREE_MODELS + 'Xbot.glb' },
  michelle: { name: 'Michelle', url: THREE_MODELS + 'Michelle.glb' },
  soldier: { name: 'Soldier', url: THREE_MODELS + 'Soldier.glb' },
};

const MP_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MP_MODEL = (v) => `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${v}/float16/latest/pose_landmarker_${v}.task`;

// ---- Settings -----------------------------------------------------------------
const DEFAULTS = {
  engine: 'gvhmr',      // GVHMR is the primary motion solver
  useMediaPipe: false,  // MediaPipe is optional in-browser preview / client fallback
  hands: true,
  rootMotion: true,
  inPlace: false,       // In-Place motion lock for Game Dev (locks horizontal root translation X/Z=0)
  staticCamera: true,   // Fixed studio camera with no automatic panning or tracking
  poseModel: 'full',
  smoothing: 0.5,
  showSkel: true,
  character: 'xbot',
  swap: false,
  cinematic: false,
};
const settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('p2r_cfg') || '{}') }; }
  catch { return { ...DEFAULTS }; }
})();
const save = () => { try { localStorage.setItem('p2r_cfg', JSON.stringify(settings)); } catch {} };

function bindSetting(id, kind = 'value', onChange) {
  const el = $('#' + id);
  if (!el) return;
  if (kind === 'checked') el.checked = !!settings[id];
  else el.value = settings[id];
  el.addEventListener('input', () => {
    settings[id] = kind === 'checked' ? el.checked : (el.type === 'range' ? Number(el.value) : el.value);
    save(); onChange?.(settings[id]);
  });
  onChange?.(settings[id]);
}

// ---- Log & HUD ----------------------------------------------------------------
function log(msg, cls = '') {
  const el = $('#log');
  if (!el) return;
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `${new Date().toLocaleTimeString([], { hour12: false })}  ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function pill(id, text, state) {
  const p = $('#pill-' + id);
  if (!p) return;
  p.textContent = text;
  p.className = 'pill ' + (state || '');
}
function banner(text) {
  const b = $('#banner');
  if (!b) return;
  b.textContent = text || '';
  b.classList.toggle('on', !!text);
}

// ---- Loading Modal Overlay ---------------------------------------------------
let loadingTimer = null;
function showLoading(title = 'PROCESSING MOTION...', detail = 'Tracking body pose landmarks', progress = null) {
  const overlay = $('#loading-overlay');
  const tEl = $('#loading-title');
  const dEl = $('#loading-detail');
  const pEl = $('#loading-progress');
  if (!overlay) return;

  tEl.textContent = title;
  dEl.textContent = detail;
  if (progress != null && progress >= 0 && progress <= 100) {
    pEl.classList.remove('indeterminate');
    pEl.style.width = `${progress}%`;
  } else {
    pEl.classList.add('indeterminate');
    pEl.style.width = '40%';
  }
  overlay.classList.add('active');
}

function updateLoadingDetail(detail) {
  const dEl = $('#loading-detail');
  if (dEl) dEl.textContent = detail;
}

function hideLoading() {
  const overlay = $('#loading-overlay');
  if (overlay) overlay.classList.remove('active');
  if (loadingTimer) { clearTimeout(loadingTimer); loadingTimer = null; }
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `${path} → ${res.status}`);
  return json;
}

// ---- Three.js Stage -----------------------------------------------------------
const stage = createStage($('#stage'));
stage.setStaticCamera(settings.staticCamera);
const { scene } = stage;

new ResizeObserver(() => {
  const v = $('#vidwrap');
  if (v) stage.setInset(v.offsetLeft + v.offsetWidth);
}).observe($('#vidwrap'));

// ---- Character Management ----------------------------------------------------
let model = null, rig = null;

async function loadModel(src, name) {
  const isFbx = /\.fbx$/i.test(name);
  const obj = await (isFbx ? new FBXLoader() : new GLTFLoader()).loadAsync(src);
  const root = isFbx ? obj : obj.scene;
  if (isFbx) root.scale.setScalar(0.01);
  root.updateMatrixWorld(true);

  const armX = (side) => {
    let b;
    root.traverse((o) => {
      if (!b && o.isBone && o.name.replace(/^mixamorig\d*[:_]?/i, '') === side + 'Arm') b = o;
    });
    return b?.getWorldPosition(new THREE.Vector3()).x;
  };
  const lx = armX('Left'), rx = armX('Right');
  if (lx != null && rx != null && lx < rx) {
    root.rotation.y += Math.PI;
    root.updateMatrixWorld(true);
  }
  const box = new THREE.Box3().setFromObject(root);
  root.position.y -= box.min.y;
  root.position.x -= (box.min.x + box.max.x) / 2;
  root.position.z -= (box.min.z + box.max.z) / 2;
  root.traverse((o) => {
    if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; }
  });
  root.updateMatrixWorld(true);
  return root;
}

async function loadCharacter(src, name = 'X Bot') {
  pill('rig', 'loading ' + name.toLowerCase(), 'busy');
  const root = await loadModel(src, name);
  root.name = 'Character';
  const newRig = new Rig(root);
  if (model) {
    scene.remove(model);
    stage.removeContactShadow(model);
  }
  scene.add(root);
  stage.contactShadow(root);
  model = root;
  rig = newRig;
  window.rig = newRig;

  for (const t of takes) {
    t.live = new Track(rig.order.length);
    t.liveDone = false;
    if (t.hqRaw) t.hq = bakeSmpl(t.hqRaw);
  }
  liveState = { hip0: null, baseY: null, mpp: null, scale: null };
  liveSnap = null; switchFrom = null;
  pill('rig', name.toLowerCase(), 'ok');
  log(`character loaded: ${name} (${rig.order.length} bones, ${rig.height.toFixed(2)} m)`);
  resetCast();
  updateExportButtons();
}

const cast = {};
let onStage = null;

function resetCast() {
  for (const k of Object.keys(cast)) {
    scene.remove(cast[k].model);
    stage.removeContactShadow(cast[k].model);
    delete cast[k];
  }
  onStage = null;
  if (model) model.visible = true;
}

async function swapCharacter() {
  const keys = Object.keys(CHARACTERS);
  const shown = onStage || settings.character;
  const next = keys[(keys.indexOf(shown) + 1) % keys.length];
  if (next === settings.character) { showOnStage(null); return; }
  if (!cast[next]) {
    const m = await loadModel(CHARACTERS[next].url, CHARACTERS[next].name);
    if (cast[next]) return;
    m.visible = false;
    scene.add(m);
    cast[next] = { model: m, rig: new Rig(m) };
  }
  showOnStage(next);
}

function showOnStage(key) {
  if (onStage && cast[onStage]) {
    cast[onStage].model.visible = false;
    stage.removeContactShadow(cast[onStage].model);
  }
  onStage = key;
  model.visible = !key;
  stage.removeContactShadow(model);
  if (key) {
    cast[key].model.visible = true;
    stage.contactShadow(cast[key].model);
  } else {
    stage.contactShadow(model);
  }
  pill('rig', (key ? CHARACTERS[key].name : (CHARACTERS[settings.character]?.name || 'character')).toLowerCase(), 'ok');
}

// ---- MediaPipe Pose Initialization (Optional Preview) -------------------------
let landmarker = null, vision = null, mpTs = 0;
let poseInitPromise = null;

async function initPose(variant = 'full') {
  pill('pose', 'loading ' + variant, 'busy');
  vision ||= await FilesetResolver.forVisionTasks(MP_WASM);
  const make = (delegate) => PoseLandmarker.createFromOptions(vision, {
    baseOptions: { modelAssetPath: MP_MODEL(variant), delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  const old = landmarker;
  landmarker = null;
  try {
    landmarker = await make('GPU');
  } catch (e) {
    log('GPU delegate fallback to CPU: ' + e.message);
    landmarker = await make('CPU');
  }
  old?.close();
  pill('pose', 'mediapipe: ' + variant, 'ok');
  log(`MediaPipe Pose model (${variant}) initialized (optional preview)`, 'ok');
  return landmarker;
}

function ensurePoseReady() {
  if (landmarker) return Promise.resolve(landmarker);
  if (poseInitPromise) return poseInitPromise;
  poseInitPromise = initPose(settings.poseModel).catch((e) => {
    log('pose model failed: ' + e.message, 'err');
    pill('pose', 'failed', 'bad');
    poseInitPromise = null;
  });
  return poseInitPromise;
}

// ---- Takes & Storage ----------------------------------------------------------
let takeSeq = 0;
const takes = [];

class Take {
  constructor(name) {
    this.id = ++takeSeq;
    this.name = name;
    this.videoUrl = null;
    this.localBlobUrl = null;
    this.status = 'processing';
    this.live = null;
    this.liveDone = false;
    this.hq = null;
    this.hqRaw = null;
    this.hqStatus = 'off';
    this.hqAt = 0;
    this.rootOffset = null;
    this.timings = {};
    this.ready = new Promise((r) => (this._resolveReady = r));
  }
  get best() { return this.hq || (this.liveDone ? this.live : null); }
}

function updateExportButtons() {
  const activeTake = current || takes[takes.length - 1];
  const hasBest = !!activeTake?.best;
  const glbBtn = $('#btn-export-glb');
  const bvhBtn = $('#btn-export-bvh');
  const inPlacePill = $('#pill-inplace');
  if (inPlacePill) inPlacePill.style.display = settings.inPlace ? 'inline-flex' : 'none';

  const modeText = settings.inPlace ? ' (In-Place)' : ' (Root Motion)';
  if (glbBtn) {
    glbBtn.disabled = !hasBest;
    glbBtn.textContent = `↓ Export GLB${modeText}`;
  }
  if (bvhBtn) {
    bvhBtn.disabled = !hasBest;
    bvhBtn.textContent = `↓ Export BVH${modeText}`;
  }
}

function renderTakes() {
  const el = $('#takes');
  if (!el) return;
  el.innerHTML = '';
  for (const t of [...takes].reverse()) {
    const card = document.createElement('div');
    card.className = 'take' + (t === current ? ' playing' : '');
    const live = t.liveDone ? '<span class="pill ok">live preview</span>' : '';
    const hq = {
      running: '<span class="pill busy">gvhmr solving</span>',
      done: `<span class="pill ok">gvhmr ${t.timings.hq ? t.timings.hq.toFixed(1) + 's' : 'ready'}</span>`,
      error: '<span class="pill bad">gvhmr failed</span>',
    }[t.hqStatus] || (t.status === 'processing' ? '<span class="pill busy">processing</span>' : '');

    card.innerHTML = `
      <div class="p" title="${escapeHtml(t.name)}">#${t.id} · ${escapeHtml(t.name)}</div>
      <div class="meta">${hq}${live}</div>
      <div class="actions">
        <button class="btn" data-a="play">▶ play</button>
        <button class="btn" data-a="glb" ${t.best ? '' : 'disabled'}>↓ glb</button>
        <button class="btn bvh" data-a="bvh" ${t.best ? '' : 'disabled'}>↓ bvh</button>
      </div>`;

    card.querySelector('[data-a=play]').onclick = () => playTake(t);
    card.querySelector('[data-a=glb]').onclick = () => exportTakeGLB(t);
    card.querySelector('[data-a=bvh]').onclick = () => exportTakeBVH(t);
    el.appendChild(card);
  }
  updateExportButtons();
}

const escapeHtml = (s) => (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- Video Upload & Processing Workflow (GVHMR Main Engine) -------------------
async function handleVideoFile(file) {
  if (!file) return;
  log(`selected video: ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)`);

  const take = new Take(file.name);
  take.localBlobUrl = URL.createObjectURL(file);
  take.videoUrl = take.localBlobUrl;
  takes.push(take);
  renderTakes();

  const card = $('#active-video-card');
  if (card) {
    card.classList.add('active');
    $('#card-filename').textContent = take.name;
    $('#card-duration').textContent = '...';
    $('#card-res').textContent = '...';
    $('#card-status').textContent = 'uploading';
  }

  // Show Loading Overlay
  showLoading('SOLVING 3D MOTION WITH GVHMR', `Uploading ${file.name} for GPU motion recovery...`, 20);

  // Background upload to server for GVHMR worker
  let serverUploadedUrl = null;
  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent(file.name) },
      body: file,
    });
    if (res.ok) {
      const json = await res.json();
      serverUploadedUrl = json.url;
      take.videoUrl = serverUploadedUrl;
      log(`video ready for GVHMR: ${serverUploadedUrl}`, 'ok');
    }
  } catch (e) {
    log('Server upload failed: ' + e.message, 'err');
  }

  // GVHMR is the MAIN engine
  if (hqOnline) {
    showLoading('SOLVING 3D MOTION WITH GVHMR', 'Running GPU human motion recovery & SMPL rotations...', 45);
    runGVHMR(take);

    // If optional MediaPipe preview is enabled, also run live preview while waiting
    if (settings.useMediaPipe) {
      ensurePoseReady().then(() => playTake(take));
    }
  } else {
    // Worker offline: Notify user and handle fallback
    log('GVHMR GPU worker is offline. Checking fallback...', 'err');
    if (settings.useMediaPipe) {
      log('Running optional MediaPipe fallback...', 'ok');
      ensurePoseReady().then(() => playTake(take));
    } else {
      hideLoading();
      banner('GVHMR Worker Offline — Connect GPU or enable MediaPipe fallback');
      const useFallback = confirm('GVHMR GPU worker is currently offline.\n\nWould you like to enable the optional MediaPipe in-browser engine as fallback?');
      if (useFallback) {
        settings.useMediaPipe = true;
        const cb = $('#useMediaPipe');
        if (cb) cb.checked = true;
        save();
        ensurePoseReady().then(() => playTake(take));
      } else {
        playTake(take);
      }
    }
  }
}

// ---- GVHMR Main Engine Solver Pass --------------------------------------------
let hqOnline = false;

async function checkHQ() {
  const statusEl = $('#engine-gvhmr-status');
  try {
    const r = await api('/api/hq/health');
    hqOnline = !!r.ok;
    const deviceStr = r.device ? r.device.toLowerCase() : 'gpu';
    if (r.ok) {
      pill('hq', `gvhmr: ${deviceStr}`, 'ok');
      if (statusEl) {
        statusEl.textContent = `Worker Online · ${deviceStr.toUpperCase()}`;
        statusEl.style.color = 'var(--primary)';
      }
    } else {
      pill('hq', 'gvhmr: offline', 'bad');
      if (statusEl) {
        statusEl.textContent = 'Worker Offline · Connect GPU worker or use MediaPipe';
        statusEl.style.color = 'var(--err)';
      }
    }
  } catch {
    hqOnline = false;
    pill('hq', 'gvhmr: offline', 'bad');
    if (statusEl) {
      statusEl.textContent = 'Worker Offline · Connect GPU worker or use MediaPipe';
      statusEl.style.color = 'var(--err)';
    }
  }
}

function runGVHMR(take) {
  const t0 = performance.now();
  take.hqStatus = 'running';
  renderTakes();
  log(`#${take.id} GVHMR Main Engine: solving 3D motion on GPU...`, 'hq');

  const cardStatus = $('#card-status');
  if (cardStatus) cardStatus.textContent = 'solving (gvhmr)';

  take.hqPromise = (async () => {
    // 1. Submit request to /api/hq
    const startRes = await api('/api/hq', {
      video_url: take.videoUrl,
      ...(take.handsMethod ? { hands: take.handsMethod } : {}),
    });

    // If already done or direct legacy payload
    if (startRes && startRes.status === 'done' && startRes.global_orient) {
      return startRes;
    }
    if (startRes && startRes.global_orient && !startRes.jobId) {
      return startRes;
    }

    const jobId = startRes?.jobId;
    if (!jobId) {
      return startRes;
    }

    // 2. Poll /api/hq/job every 2s (completely eliminates Cloudflare 125s Error 524 timeouts)
    const pollStart = performance.now();
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const elapsed = Math.round((performance.now() - pollStart) / 1000);

      showLoading(
        'SOLVING 3D MOTION WITH GVHMR',
        `Running GPU motion solver & SMPL mesh recovery (${elapsed}s elapsed)...`,
        Math.min(95, 45 + Math.round(elapsed * 0.4))
      );
      if (cardStatus) cardStatus.textContent = `solving (${elapsed}s)`;

      const pollRes = await fetch(`/api/hq/job?jobId=${encodeURIComponent(jobId)}`).then((r) => {
        if (!r.ok && r.status !== 500) throw new Error(`polling error: ${r.status}`);
        return r.json();
      });

      if (pollRes.status === 'done') {
        return pollRes;
      }
      if (pollRes.status === 'error') {
        throw new Error(pollRes.error || 'GVHMR solver failed');
      }
    }
  })()
    .then((r) => {
      take.hqRaw = r;
      take.hq = bakeSmpl(r);
      take.hqAt = performance.now();
      take.hqStatus = 'done';
      take.timings.hq = (performance.now() - t0) / 1000;
      log(`#${take.id} GVHMR solved ${r.n} frames in ${take.timings.hq.toFixed(1)}s!`, 'ok');

      hideLoading();
      banner(`GVHMR Solved (${take.timings.hq.toFixed(1)}s)`);
      setTimeout(() => banner(''), 3000);

      if (cardStatus) cardStatus.textContent = 'gvhmr ready';

      // Automatically play the solved motion with the character!
      playTake(take);
    })
    .catch((e) => {
      take.hqStatus = 'error';
      log(`#${take.id} GVHMR solver error: ${e.message}`, 'err');
      hideLoading();
      banner('GVHMR Solve Failed: ' + e.message);
      if (cardStatus) cardStatus.textContent = 'error';
    })
    .finally(() => {
      renderTakes();
      updateExportButtons();
    });
}
const runHQ = runGVHMR;

// ---- SMPL Baking -------------------------------------------------------------
const _kp = Array.from({ length: 21 }, () => new THREE.Vector3());

function applyHandsFrame(hands, f, yawFix) {
  HAND_LIMITS.enabled = hands?.method !== 'wilor';
  for (const [src, side] of [['R', 'Right'], ['L', 'Left']]) {
    const h = hands?.[src];
    if (settings.hands !== false && h?.valid?.[f]) {
      const o = f * 63;
      for (let j = 0; j < 21; j++) {
        _kp[j].set(h.kp[o + j * 3], h.kp[o + j * 3 + 1], h.kp[o + j * 3 + 2]).applyQuaternion(yawFix);
      }
      rig.applyHand(side, _kp);
    } else {
      rig.relaxHand(side);
    }
  }
}

function bakeSmpl(r) {
  const { n, fps, global_orient: GO, body_pose: BP, transl: T, leg_length } = r;
  const fWorld = new THREE.Vector3(0, 0, 1).applyQuaternion(aaToQuat(GO[0], GO[1], GO[2]));
  let targetYaw = 0;
  if (r.incam_global_orient0) {
    const [a, b, c] = r.incam_global_orient0;
    const fc = new THREE.Vector3(0, 0, 1).applyQuaternion(aaToQuat(a, b, c));
    targetYaw = Math.atan2(fc.x, -fc.z);
  }
  const yawFix = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), targetYaw - Math.atan2(fWorld.x, fWorld.z));
  const scale = rig.legLength / (leg_length || 0.85);
  const track = new Track(rig.order.length);
  const lows = [];
  const d = new THREE.Vector3();

  for (let f = 0; f < n; f++) {
    rig.reset();
    rig.applySmplGlobal(smplGlobals(
      GO.subarray ? GO.subarray(f * 3, f * 3 + 3) : GO.slice(f * 3, f * 3 + 3),
      BP.slice(f * 63, f * 63 + 63),
      yawFix
    ));
    d.set(T[f * 3] - T[0], T[f * 3 + 1] - T[1], T[f * 3 + 2] - T[2]).applyQuaternion(yawFix).multiplyScalar(scale);
    const p = rig.rest.Hips.wp.clone().add(d);
    rig.setHipsWorld(p);
    applyHandsFrame(r.hands, f, yawFix);
    lows.push(rig.lowestFoot());
    track.push(f / fps, rig.snapshot());
  }
  const sorted = [...lows].sort((a, b) => a - b);
  const offset = rig.floorY - sorted[Math.floor(sorted.length * 0.08)];
  track.p.forEach((p, f) => { p[1] += offset + Math.max(0, rig.floorY - (lows[f] + offset)); });
  rig.reset();
  return track;
}

// ---- Playback & Detection ----------------------------------------------------
const video = $('#video');
const overlay = $('#overlay');
const octx = overlay.getContext('2d');
let current = null;
const queue = [];
let liveSnap = null;
let liveState = null;
const worldFilter = new OneEuro(99);
const hipFilter = new OneEuro(2);
let lastRenderedHips = new THREE.Vector3();
let switchFrom = null, switchAt = 0;

function setSmoothing(s) {
  worldFilter.minCutoff = hipFilter.minCutoff = THREE.MathUtils.lerp(6, 0.4, s);
  worldFilter.beta = hipFilter.beta = THREE.MathUtils.lerp(1.2, 0.15, s);
}

function playTake(take) {
  if (!take.videoUrl) return;
  if (current && rig) {
    switchFrom = rig.snapshot();
    switchAt = performance.now();
  }
  current = take;
  if (!take.liveDone) {
    take.live = new Track(rig.order.length);
    liveState = { hip0: null, baseY: null, mpp: null, scale: null };
    worldFilter.reset();
    hipFilter.reset();
    liveSnap = null;
  }
  $('#vid-empty').style.display = 'none';
  video.style.display = 'block';
  video.src = take.videoUrl;

  video.onloadedmetadata = () => {
    const isPortrait = video.videoHeight > video.videoWidth;
    $('#vidwrap').classList.toggle('portrait', isPortrait);
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;

    // Update active video card info
    const card = $('#active-video-card');
    if (card) {
      card.classList.add('active');
      $('#card-filename').textContent = take.name;
      $('#card-duration').textContent = `${video.duration.toFixed(1)}s`;
      $('#card-res').textContent = `${video.videoWidth}x${video.videoHeight}`;
      $('#card-status').textContent = take.hq ? 'gvhmr ready' : (settings.useMediaPipe ? 'tracking (preview)' : 'ready');
    }
  };

  lastDetectT = -1;
  video.currentTime = 0;
  video.play().catch(() => {});
  renderTakes();

  if (take.hq) {
    hideLoading();
  } else if (settings.useMediaPipe) {
    showLoading('TRACKING POSE WITH MEDIAPIPE (PREVIEW)', `Analyzing ${take.name}...`);
  }
}

video.addEventListener('ended', () => {
  if (settings.swap && rig) {
    swapCharacter().catch((e) => log('swap failed: ' + e.message, 'err'));
  }
  if (current && !current.liveDone && settings.useMediaPipe) {
    current.liveDone = current.live.length > 3;
    log(`#${current.id} MediaPipe tracking finished: ${current.live.length} frames`, 'ok');
    hideLoading();
    const st = $('#card-status');
    if (st) st.textContent = current.hq ? 'gvhmr ready' : 'retargeted (preview)';
    renderTakes();
  }
  video.currentTime = 0;
  video.play().catch(() => {});
});

// Detection hook (only runs if optional MediaPipe is enabled)
let lastDetectT = -1;
let videoFrameCallbackHandle = null;

function detectIfNewFrame() {
  if (!settings.useMediaPipe || !landmarker || !rig || !current || video.readyState < 2 || video.seeking) return;
  const mediaTime = video.currentTime;
  if (mediaTime === lastDetectT) return;
  if (mediaTime < lastDetectT) liveLoopReset();
  lastDetectT = mediaTime;

  try {
    const ts = Math.max(mpTs + 1, performance.now());
    mpTs = ts;
    const res = landmarker.detectForVideo(video, ts);
    drawOverlay(res);
    if (!current.liveDone && res.worldLandmarks?.[0]) {
      liveSnap = solveLive(res, mediaTime);
      current.live.push(mediaTime, liveSnap);
      updateLoadingDetail(`Tracked ${current.live.length} frames (${mediaTime.toFixed(1)}s / ${video.duration ? video.duration.toFixed(1) + 's' : ''})`);
    }
  } catch (e) {
    console.error(e);
  }
}

function liveLoopReset() {
  worldFilter.reset();
  hipFilter.reset();
}

// Optimized Canvas Overlay with Green & Black Cyber Theme
function drawOverlay(res) {
  // CRITICAL FIX: Only resize canvas if dimensions actually changed!
  // Setting width/height on every frame destroys the WebGL backing store and stalls GPU!
  if (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight) {
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
  }
  octx.clearRect(0, 0, overlay.width, overlay.height);
  if (!settings.showSkel || !res.landmarks?.[0]) return;

  const du = new DrawingUtils(octx);
  // Cyber neon green connectors and mint landmarks
  du.drawConnectors(res.landmarks[0], PoseLandmarker.POSE_CONNECTIONS, { color: '#00ff88', lineWidth: 2.5 });
  du.drawLandmarks(res.landmarks[0], { color: '#34d399', fillColor: '#050806', lineWidth: 1.5, radius: 2.5 });
}

// Pre-allocated scratch objects to eliminate GC pauses during tracking
const _lm = Array.from({ length: 33 }, () => new THREE.Vector3());
const _rawLm = new Float32Array(99);
const _vHipMid = new THREE.Vector3();
const _vShMid = new THREE.Vector3();
const _hipPos = new THREE.Vector3();

function solveLive(res, t) {
  const w = res.worldLandmarks[0];
  const n2 = res.landmarks[0];

  for (let i = 0; i < 33; i++) {
    const p = w[i];
    _rawLm[i * 3] = p.x;
    _rawLm[i * 3 + 1] = -p.y;
    _rawLm[i * 3 + 2] = -p.z;
  }
  const f = worldFilter.filter(_rawLm, t);
  for (let i = 0; i < 33; i++) _lm[i].set(f[i * 3], f[i * 3 + 1], f[i * 3 + 2]);
  const vis = w.map((p) => p.visibility ?? 1);

  const W = video.videoWidth, H = video.videoHeight;
  const hx = (n2[23].x + n2[24].x) * 0.5 * W;
  const hy = (n2[23].y + n2[24].y) * 0.5 * H;
  const sx = (n2[11].x + n2[12].x) * 0.5 * W;
  const sy = (n2[11].y + n2[12].y) * 0.5 * H;

  const hf = hipFilter.filter([hx, hy], t);
  _vHipMid.copy(_lm[23]).add(_lm[24]).multiplyScalar(0.5);
  _vShMid.copy(_lm[11]).add(_lm[12]).multiplyScalar(0.5);

  const pxDist = Math.max(1, Math.hypot(sx - hx, sy - hy));
  const mpp = _vShMid.distanceTo(_vHipMid) / pxDist;
  const leg = (_lm[23].distanceTo(_lm[25]) + _lm[25].distanceTo(_lm[27]) + _lm[24].distanceTo(_lm[26]) + _lm[26].distanceTo(_lm[28])) / 2;

  const S = liveState;
  S.mpp = S.mpp == null ? mpp : S.mpp + 0.05 * (mpp - S.mpp);
  S.scale = S.scale == null ? rig.legLength / leg : S.scale + 0.05 * (rig.legLength / leg - S.scale);
  if (!S.hip0) S.hip0 = [hf[0], hf[1]];

  rig.reset();
  rig.applyLandmarks(_lm, vis);
  _hipPos.copy(rig.rest.Hips.wp);

  if (settings.rootMotion) {
    _hipPos.x += (hf[0] - S.hip0[0]) * S.mpp * S.scale;
    _hipPos.y += -(hf[1] - S.hip0[1]) * S.mpp * S.scale;
  }
  rig.setHipsWorld(_hipPos);
  if (S.baseY == null) S.baseY = rig.floorY - rig.lowestFoot();
  _hipPos.y += S.baseY;
  rig.setHipsWorld(_hipPos);
  rig.clampToFloor();
  return rig.snapshot();
}

// ---- Render Loop (60fps lag-free) --------------------------------------------
const bufA = { q: null, p: new Float32Array(3) };
const bufB = { q: null, p: new Float32Array(3) };
const bufC = { q: null, p: new Float32Array(3) };

function frame() {
  requestAnimationFrame(frame);
  tick();
}

function tick() {
  detectIfNewFrame();
  if (rig && current) {
    const n = rig.order.length * 4;
    for (const b of [bufA, bufB, bufC]) {
      if (!b.q || b.q.length !== n) b.q = new Float32Array(n);
    }
    const t = video.currentTime;
    const live = current.liveDone ? current.live.sample(t, bufA) : liveSnap;
    const hq = current.hq ? current.hq.sample(t, bufB) : null;
    let snap = hq || live;
    let src = hq ? 'GVHMR (MAIN ENGINE)' : live ? 'MediaPipe (PREVIEW)' : '—';

    if (hq && live && current.hqAt && performance.now() - current.hqAt < 600) {
      const w = Math.min(1, (performance.now() - current.hqAt) / 600);
      if (w < 1) {
        snap = blendSnapshots(live.q, live.p, hq.q, hq.p, w, bufC);
        src = 'Preview → GVHMR Blend';
      }
    }
    if (snap && switchFrom) {
      const w = Math.min(1, (performance.now() - switchAt) / 250);
      if (w < 1) snap = blendSnapshots(switchFrom.q, switchFrom.p, snap.q, snap.p, w, snap === bufC ? bufA : bufC);
      else switchFrom = null;
    }
    if (snap) {
      rig.applySnapshot(snap);
      if (settings.inPlace) {
        // In-Place (Game Dev Mode): lock horizontal hips translation (X/Z) at origin rest pose, preserve vertical Y
        const h = rig.hipsWorld();
        h.x = rig.rest.Hips.wp.x;
        h.z = rig.rest.Hips.wp.z;
        rig.setHipsWorld(h);
      } else if (current.rootOffset?.lengthSq()) {
        const h = rig.hipsWorld().add(current.rootOffset);
        rig.setHipsWorld(h);
      }
      rig.hipsWorld(lastRenderedHips);
    }
    const hud = $('#hud-src');
    hud.textContent = src;
    hud.className = 'tag ' + (hq ? 'src-hq' : 'src-live');
    $('#hud-time').textContent = `#${current.id}  ${t.toFixed(2)}s`;
  }
  if (rig) {
    const shown = onStage ? cast[onStage].rig : rig;
    if (shown !== rig) shown.copyPoseFrom(rig);
    stage.placeContactShadow(shown.model, shown.hipsWorld(), shown.floorY, shown.height);
  }
  stage.update(rig ? lastRenderedHips : null);
}

// ---- Export Handlers (GLB & BVH) ---------------------------------------------
async function exportTakeGLB(take, options = {}) {
  const track = take.best;
  if (!track || !rig) {
    log('No motion track ready to export', 'err');
    return;
  }
  const inPlace = options.inPlace !== undefined ? options.inPlace : !!settings.inPlace;
  const cleanName = (take.name || 'motion').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40);
  const suffix = inPlace ? '_inplace' : '_root';
  const name = `take${take.id}_${cleanName}${take.hq ? '_hq' : '_live'}${suffix}`;
  banner(`Exporting ${name}.glb${inPlace ? ' (In-Place Game Dev)' : ''}...`);

  try {
    const clip = trackToClip(rig, track, name, { inPlace });
    const glb = await new GLTFExporter().parseAsync(model, { binary: true, animations: [clip] });
    const blob = new Blob([glb], { type: 'model/gltf-binary' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name + '.glb';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);

    // Save copy to ./takes
    const q = new URLSearchParams({ name, ext: 'glb', inPlace: inPlace ? '1' : '0', ...(take.videoUrl?.startsWith('http') ? { source: take.videoUrl } : {}) });
    fetch('/api/takes?' + q, { method: 'POST', body: glb }).catch(() => {});
    log(`exported ${name}.glb (${inPlace ? 'in-place game dev' : 'root motion'})`, 'ok');
    banner(`Saved ${name}.glb`);
    setTimeout(() => banner(''), 2500);
  } catch (err) {
    log('GLB export failed: ' + err.message, 'err');
    banner('Export failed');
  }
}

function exportTakeBVH(take, options = {}) {
  const track = take.best;
  if (!track || !rig) {
    log('No motion track ready to export', 'err');
    return;
  }
  const inPlace = options.inPlace !== undefined ? options.inPlace : !!settings.inPlace;
  const cleanName = (take.name || 'motion').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40);
  const suffix = inPlace ? '_inplace' : '_root';
  const name = `take${take.id}_${cleanName}${take.hq ? '_hq' : '_live'}${suffix}`;
  banner(`Exporting ${name}.bvh${inPlace ? ' (In-Place Game Dev)' : ''}...`);

  try {
    const bvhStr = exportBVHFile(rig, track, name, 1.0, { inPlace });
    // Save copy to server ./takes
    const q = new URLSearchParams({ name, ext: 'bvh', inPlace: inPlace ? '1' : '0', ...(take.videoUrl?.startsWith('http') ? { source: take.videoUrl } : {}) });
    fetch('/api/takes?' + q, { method: 'POST', body: bvhStr }).catch(() => {});
    log(`exported ${name}.bvh (${inPlace ? 'in-place game dev mocap' : 'root motion mocap'})`, 'ok');
    banner(`Saved ${name}.bvh`);
    setTimeout(() => banner(''), 2500);
  } catch (err) {
    log('BVH export failed: ' + err.message, 'err');
    banner('Export failed');
  }
}

// ---- UI Bindings & Drag-and-Drop ---------------------------------------------
const dropzone = $('#dropzone');
const fileInput = $('#file-upload-vid');

if (dropzone && fileInput) {
  dropzone.onclick = () => fileInput.click();
  fileInput.onchange = (e) => {
    const f = e.target.files?.[0];
    if (f) handleVideoFile(f);
  };

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const f = e.dataTransfer?.files?.[0];
    if (f) handleVideoFile(f);
  });
}

const reprocessBtn = $('#btn-reprocess');
if (reprocessBtn) {
  reprocessBtn.onclick = () => {
    if (current) {
      if (hqOnline) {
        showLoading('SOLVING 3D MOTION WITH GVHMR', 'Re-solving motion with GVHMR GPU engine...');
        runGVHMR(current);
      } else {
        playTake(current);
      }
    }
  };
}

const changeVidBtn = $('#btn-change-vid');
if (changeVidBtn && fileInput) {
  changeVidBtn.onclick = () => fileInput.click();
}

// Export buttons in sidebar
$('#btn-export-glb').onclick = () => {
  const active = current || takes[takes.length - 1];
  if (active) exportTakeGLB(active);
};
$('#btn-export-bvh').onclick = () => {
  const active = current || takes[takes.length - 1];
  if (active) exportTakeBVH(active);
};

// Character file loader
$('#btn-char').onclick = () => $('#file-char').click();
$('#file-char').onchange = (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  loadCharacter(url, f.name).catch((err) => {
    log('character load error: ' + err.message, 'err');
    pill('rig', 'failed', 'bad');
  });
};

// Bind UI settings
bindSetting('hands', 'checked', () => {
  if (rig) for (const t of takes) if (t.hqRaw) t.hq = bakeSmpl(t.hqRaw);
});
bindSetting('rootMotion', 'checked');

// In-Place Motion (Game Dev Mode) Toggle
bindSetting('inPlace', 'checked', (on) => {
  updateExportButtons();
  renderTakes();
  banner(on ? 'In-Place Mode (Game Dev): Root X/Z Locked at Origin' : 'Root Motion: 3D Trajectory Active');
  setTimeout(() => banner(''), 2500);
});

// Static Camera (No Camera Moves) Toggle
bindSetting('staticCamera', 'checked', (on) => {
  stage.setStaticCamera(on);
  if (on) {
    settings.cinematic = false;
    const cEl = $('#cinematic');
    if (cEl) cEl.checked = false;
    banner('Static Camera: Fixed Studio Tripod');
  } else {
    banner('Tracking Camera: Auto Focus Active');
  }
  setTimeout(() => banner(''), 2500);
});

// Optional MediaPipe Preview Toggle
bindSetting('useMediaPipe', 'checked', (on) => {
  const ctrl = $('#mediapipe-controls');
  if (ctrl) ctrl.style.display = on ? 'flex' : 'none';
  if (on) {
    pill('pose', 'loading pose…', 'busy');
    ensurePoseReady().then(() => pill('pose', 'mediapipe: on', 'ok'));
  } else {
    pill('pose', 'mediapipe: optional', '');
    if (overlay && octx) octx.clearRect(0, 0, overlay.width, overlay.height);
  }
});
bindSetting('showSkel', 'checked');
bindSetting('smoothing', 'value', setSmoothing);
bindSetting('poseModel', 'value', (v) => { if (settings.useMediaPipe) initPose(v); });
bindSetting('swap', 'checked', (on) => { if (!on && model) showOnStage(null); });
bindSetting('cinematic', 'checked', (on) => {
  stage.setCinematic(on);
  if (on) {
    settings.staticCamera = false;
    const sEl = $('#staticCamera');
    if (sEl) sEl.checked = false;
  }
});
bindSetting('character', 'value', (c) => {
  if (rig && CHARACTERS[c]) {
    loadCharacter(CHARACTERS[c].url, CHARACTERS[c].name).catch((e) => log('character error: ' + e.message, 'err'));
  }
});

// Window debug handle
window.p2r = {
  get current() { return current; },
  get rig() { return rig; },
  takes, video, stage, exportTakeGLB, exportTakeBVH,
  rebake() { for (const t of takes) if (t.hqRaw) t.hq = bakeSmpl(t.hqRaw); },
};

// ---- Boot ---------------------------------------------------------------------
frame();
const startChar = CHARACTERS[settings.character] || CHARACTERS.xbot;
loadCharacter(startChar.url, startChar.name).catch((e) => {
  log('character failed: ' + e.message, 'err');
  pill('rig', 'failed', 'bad');
});

// Lazy-load MediaPipe ONLY if optional preview was enabled
if (settings.useMediaPipe) {
  ensurePoseReady();
} else {
  pill('pose', 'mediapipe: optional', '');
}

checkHQ();
setInterval(checkHQ, 6000);
log('Vid2Rig Studio ready. GVHMR is the main 3D engine (MediaPipe optional)');
