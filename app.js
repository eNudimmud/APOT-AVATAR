import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { Sculptable, f32ToB64, b64ToF32 } from './sculpt.js';
import { RigSystem, JOINT_DEFS, GROUPS, POSES, ANIMS } from './rig.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const LS_KEY = 'apot_fit_v1';
const TARGET = new THREE.Vector3(0, 0.46, 0);

// ---------- renderer / scene
const canvas = $('#c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2e36);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.9;
const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(1.2, 2, 2.2); scene.add(key);
scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 0.5));
const floor = new THREE.Mesh(new THREE.CircleGeometry(0.6, 48), new THREE.MeshBasicMaterial({ color: 0x353a44 }));
floor.rotation.x = -Math.PI / 2; floor.position.y = -0.001; scene.add(floor);

const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 30);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.dampingFactor = 0.12;
controls.minDistance = 0.12; controls.maxDistance = 5;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

function fitDist() { if (innerWidth >= 760) return 2.5; return camera.aspect < 0.8 ? 2.6 : 1.9; }
function setView(v) {
  const d = v === 'reset' ? fitDist() : controls.getDistance?.() || fitDist();
  const dist = Math.max(0.5, Math.min(d, 3.5));
  const dir = { face: [0, 0, 1], profil: [1, 0, 0], dos: [0, 0, -1], reset: [0.35, 0.12, 1] }[v];
  const t = v === 'reset' ? TARGET.clone() : controls.target.clone();
  if (v === 'reset') t.copy(TARGET);
  const n = new THREE.Vector3(...dir).normalize();
  camera.position.copy(t).addScaledVector(n, v === 'reset' ? fitDist() : dist);
  controls.target.copy(t); controls.update();
}
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

// ---------- state
let body, outfit, sculpt, outfitMat, startTf, meshyTf, defaultState, rig;
const undoStack = [], redoStack = [];
const app = (window.__app = { ready: false, errors: [] });

// ---------- load
const draco = new DRACOLoader().setDecoderPath('./vendor/three/examples/jsm/libs/draco/gltf/');
const loader = new GLTFLoader().setDRACOLoader(draco);
const loadOne = (url, label) => new Promise((res, rej) => loader.load(url, res, (e) => { if (e.total) $('#loadmsg').textContent = `${label} ${Math.round((100 * e.loaded) / e.total)} %`; }, rej));
function firstMesh(root) { let m; root.traverse((o) => { if (!m && o.isMesh) m = o; }); return m; }

async function init() {
  const [gb, gt] = [await loadOne('assets/corps_web.glb', 'Corps'), await loadOne('assets/tenue_web.glb', 'Tenue')];
  body = firstMesh(gb.scene); outfit = firstMesh(gt.scene);
  for (const [m, root] of [[body, gb.scene], [outfit, gt.scene]]) { m.updateWorldMatrix(true, false); m.matrixWorld.decompose(m.position, m.quaternion, m.scale); m.removeFromParent(); scene.add(m); }
  body.name = 'APOT_corps'; outfit.name = 'APOT_tenue_ajustee';
  // body: vertex colours for the "traverse" highlight
  const bc = new Float32Array(body.geometry.attributes.position.count * 3).fill(1);
  body.geometry.setAttribute('color', new THREE.BufferAttribute(bc, 3));
  body.material.vertexColors = true;
  outfitMat = outfit.material;
  outfit.geometry.computeBoundsTree();
  sculpt = new Sculptable(outfit);
  outfit.rotation.setFromQuaternion(outfit.quaternion, 'XYZ');
  meshyTf = getTf();
  defaultState = await loadDefaultState();
  startTf = defaultState && defaultState.tf ? cloneTf(defaultState.tf) : cloneTf(meshyTf);
  buildSliders();
  rig = new RigSystem({ scene, camera, canvas, body, outfit });
  buildRigUI();
  restoreLocal();
  setView('reset');
  $('#loading').classList.add('gone');
  app.ready = true;
  app.info = { bodyTris: body.geometry.index.count / 3, outfitTris: outfit.geometry.index.count / 3, groups: sculpt.G, joints: JOINT_DEFS.length };
  app.rig = rig;
  app.jointScreen = (n) => rig.screenPos(n);
  app.jointLocal = (n) => rig.local[n].toArray();
  app.selectJoint = (n) => { rig.select(n); refreshRigSel(); };
}

// ---------- transform (Placer)
const deg = THREE.MathUtils.radToDeg, rad = THREE.MathUtils.degToRad;
function getTf() {
  return { p: outfit.position.toArray(), r: [deg(outfit.rotation.x), deg(outfit.rotation.y), deg(outfit.rotation.z)], su: tfU ?? outfit.scale.x, s: tfAxis.slice() };
}
let tfU = null, tfAxis = [1, 1, 1];
function setTf(t) {
  outfit.position.fromArray(t.p); outfit.rotation.set(rad(t.r[0]), rad(t.r[1]), rad(t.r[2]), 'XYZ');
  tfU = t.su; tfAxis = t.s.slice();
  outfit.scale.set(tfU * tfAxis[0], tfU * tfAxis[1], tfU * tfAxis[2]);
  outfit.updateMatrixWorld(); refreshSliders(); markPenStale();
}
const SL = {
  pos: [['X', 'p', 0, 0.15, 0.001, 'cm', 100], ['Y', 'p', 1, 0.15, 0.001, 'cm', 100], ['Z', 'p', 2, 0.15, 0.001, 'cm', 100]],
  rot: [['X', 'r', 0, 45, 0.5, '°', 1], ['Y', 'r', 1, 45, 0.5, '°', 1], ['Z', 'r', 2, 45, 0.5, '°', 1]],
  scale: [['⇔', 'su', -1, 0.25, 0.002, '%', 100], ['X', 's', 0, 0.25, 0.002, '%', 100], ['Y', 's', 1, 0.25, 0.002, '%', 100], ['Z', 's', 2, 0.25, 0.002, '%', 100]],
};
let tfGroup = 'pos';
function slVal(t, d) { return d[1] === 'su' ? t.su : t[d[1]][d[2]]; }
function slSet(t, d, v) { if (d[1] === 'su') t.su = v; else t[d[1]][d[2]] = v; }
function slRange(d) { if (d[1] === 'su') return [startTf.su * (1 - d[3]), startTf.su * (1 + d[3])]; const base = d[1] === 's' ? 1 : startTf[d[1]][d[2]]; return [base - d[3], base + d[3]]; }
function buildSliders() {
  const box = $('#sliders'); box.innerHTML = '';
  for (const d of SL[tfGroup]) {
    const [lo, hi] = slRange(d);
    const row = document.createElement('div'); row.className = 'srow';
    row.innerHTML = `<b>${d[0]}</b><button>−</button><input type="range" min="${lo}" max="${hi}" step="${d[4]}"><button>+</button><output></output>`;
    const [minus, inp, plus, out] = [row.children[1], row.children[2], row.children[3], row.children[4]];
    const apply = (v) => { const t = getTf(); slSet(t, d, Math.min(hi, Math.max(lo, v))); setTf(t); };
    inp.addEventListener('pointerdown', () => pushUndo());
    inp.addEventListener('keydown', () => pushUndo());
    inp.addEventListener('input', () => apply(+inp.value));
    inp.addEventListener('change', () => { saveLocalSoon(); autoPen(); });
    const nudge = (s) => { pushUndo(); apply(slVal(getTf(), d) + s * d[4] * (d[1] === 'p' ? 1 : 1)); saveLocalSoon(); autoPen(); };
    repeatBtn(minus, () => nudge(-1)); repeatBtn(plus, () => nudge(1));
    row._sync = () => { const v = slVal(getTf(), d); inp.value = v; const shown = d[1] === 'su' ? (v / startTf.su) * 100 : d[1] === 's' || d[1] === 'p' ? v * 100 : v; out.textContent = shown.toFixed(d[1] === 'r' ? 1 : 1) + ' ' + d[5]; };
    box.appendChild(row);
  }
  refreshSliders();
}
function refreshSliders() { $$('#sliders .srow').forEach((r) => r._sync && r._sync()); }
function repeatBtn(b, fn) {
  let t1, t2;
  const stop = () => { clearTimeout(t1); clearInterval(t2); };
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); fn(); t1 = setTimeout(() => (t2 = setInterval(fn, 60)), 380); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, stop));
}
$$('#tfseg button').forEach((b) => b.addEventListener('click', () => { $$('#tfseg button').forEach((x) => x.classList.toggle('on', x === b)); tfGroup = b.dataset.g; buildSliders(); }));
$('#tfreset').addEventListener('click', () => { pushUndo(); setTf(startTf); saveLocalSoon(); toast('Placement de départ remis'); });

// ---------- undo / redo (snapshot = sculpt positions + transform)
function snap() { return { pos: sculpt.pos.slice(), tf: getTf(), rig: rig ? rig.snapshot() : null }; }
function pushUndo() { if (!sculpt) return; undoStack.push(snap()); if (undoStack.length > 30) undoStack.shift(); redoStack.length = 0; updHist(); }
function restore(s) { sculpt.setPositions(s.pos); outfit.geometry.boundsTree.refit(); outfit.geometry.computeBoundingSphere(); setTf(s.tf); if (rig && s.rig) rig.restoreSnap(s.rig); }
$('#undo').addEventListener('click', () => { if (!undoStack.length) return; redoStack.push(snap()); restore(undoStack.pop()); updHist(); saveLocalSoon(); autoPen(); });
$('#redo').addEventListener('click', () => { if (!redoStack.length) return; undoStack.push(snap()); restore(redoStack.pop()); updHist(); saveLocalSoon(); autoPen(); });
function updHist() { $('#undo').disabled = !undoStack.length; $('#redo').disabled = !redoStack.length; }
updHist();

// ---------- modes / UI
let mode = 'vue';
$$('#tabs button').forEach((b) => b.addEventListener('click', () => {
  const m = b.dataset.mode, panel = $('#panel');
  if (m === mode) { panel.classList.toggle('folded'); return; }
  if (mode === 'rig' && rig) rig.setVisible(false);
  mode = m; panel.classList.remove('folded');
  $$('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  $$('.pane').forEach((p) => (p.hidden = p.dataset.pane !== m));
  if (mode === 'rig' && rig) { rig.setVisible(true); refreshRigSel(); }
  applyCamLock();
}));
$('#fold').addEventListener('click', () => $('#panel').classList.toggle('folded'));
$$('#views button').forEach((b) => b.addEventListener('click', () => { setView(b.dataset.view); if (mode === 'rig') refreshDepthSlider(); }));

let tool = 'gonfler', sym = true, camLocked = false;
$$('#tools button').forEach((b) => b.addEventListener('click', () => { tool = b.dataset.tool; $$('#tools button').forEach((x) => x.classList.toggle('on', x === b)); }));
const bsize = $('#bsize'), bstr = $('#bstr');
const updB = () => { $('#bsizev').textContent = (+bsize.value).toFixed(1) + ' cm'; $('#bstrv').textContent = Math.round(bstr.value * 100) + ' %'; };
bsize.addEventListener('input', updB); bstr.addEventListener('input', updB); updB();
$('#sym').addEventListener('click', (e) => { sym = !sym; e.currentTarget.classList.toggle('on', sym); });
$('#lockcam').addEventListener('click', (e) => { camLocked = !camLocked; e.currentTarget.classList.toggle('on', camLocked); applyCamLock(); });
function applyCamLock() { controls.enableRotate = !(mode === 'sculpter' && camLocked); }

$('#showbody').addEventListener('click', (e) => { body.visible = !body.visible; e.currentTarget.classList.toggle('on', body.visible); e.currentTarget.textContent = body.visible ? 'Corps visible' : 'Corps caché'; });
$('#showoutfit').addEventListener('click', (e) => { outfit.visible = !outfit.visible; e.currentTarget.classList.toggle('on', outfit.visible); e.currentTarget.textContent = outfit.visible ? 'Tenue visible' : 'Tenue cachée'; });
const opac = $('#opac');
opac.addEventListener('input', () => { setOpacity(+opac.value); });
function setOpacity(v) { outfitMat.opacity = v; outfitMat.transparent = v < 0.999; outfitMat.depthWrite = v >= 0.999; outfitMat.needsUpdate = true; $('#opacv').textContent = Math.round(v * 100) + ' %'; }

let toastT;
function toast(msg, ms = 1800) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }

// ---------- sculpt input (runs before OrbitControls via capture)
const ray = new THREE.Raycaster(); ray.firstHitOnly = true;
const ndc = new THREE.Vector2();
const ringGeo = new THREE.RingGeometry(0.93, 1, 48);
const ringMat = new THREE.MeshBasicMaterial({ color: 0xffd060, depthTest: false, transparent: true, opacity: 0.9, side: THREE.DoubleSide });
const rings = [new THREE.Mesh(ringGeo, ringMat), new THREE.Mesh(ringGeo, ringMat)];
rings.forEach((r) => { r.renderOrder = 10; r.visible = false; scene.add(r); });
let stroke = null; const pointers = new Set();

function hitOutfit(cx, cy) {
  const rc = canvas.getBoundingClientRect();
  ndc.set(((cx - rc.left) / rc.width) * 2 - 1, -((cy - rc.top) / rc.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  if (!outfit.visible) return null;
  const h = ray.intersectObject(outfit, false)[0];
  return h || null;
}
const avgScale = () => (outfit.scale.x + outfit.scale.y + outfit.scale.z) / 3;
function placeRings(hit) {
  const rW = +bsize.value / 100;
  const n = hit.face.normal.clone().transformDirection(outfit.matrixWorld);
  rings[0].position.copy(hit.point).addScaledVector(n, 0.002); rings[0].lookAt(rings[0].position.clone().add(n)); rings[0].scale.setScalar(rW); rings[0].visible = true;
  if (sym) {
    const l = outfit.worldToLocal(hit.point.clone()); l.x = -l.x; const w = outfit.localToWorld(l);
    const ln = hit.face.normal.clone(); ln.x = -ln.x; ln.transformDirection(outfit.matrixWorld);
    rings[1].position.copy(w).addScaledVector(ln, 0.002); rings[1].lookAt(rings[1].position.clone().add(ln)); rings[1].scale.setScalar(rW); rings[1].visible = true;
  } else rings[1].visible = false;
}

const pointerXY = new Map();
let rigDepth = null;
canvas.addEventListener('pointerdown', (e) => {
  pointers.add(e.pointerId);
  pointerXY.set(e.pointerId, [e.clientX, e.clientY]);
  if (stroke) { e.stopImmediatePropagation(); return; }
  if (mode === 'rig' && rig) {
    if (pointers.size >= 2 && rig.selected && !rig.testing) {
      e.stopImmediatePropagation(); e.preventDefault();
      if (rig._drag) rig.endDrag();
      const ys = [...pointerXY.values()].map((p) => p[1]);
      rigDepth = { y0: ys.reduce((a, b) => a + b, 0) / ys.length, d0: rig.getDepth() };
      controls.enabled = false;
      return;
    }
    const hit = rig.hitTest(e.clientX, e.clientY);
    if (hit && pointers.size === 1) {
      e.stopImmediatePropagation(); e.preventDefault();
      if (rig.testing) { rig.exitTester(); refreshPoseBtns(); }
      canvas.setPointerCapture(e.pointerId);
      pushUndo();
      rig.select(hit);
      refreshRigSel();
      rig.beginDrag(e.clientX, e.clientY);
      return;
    }
  }
  if (mode !== 'sculpter' || pointers.size > 1 || !sculpt) return;
  const hit = hitOutfit(e.clientX, e.clientY);
  if (!hit) return;
  e.stopImmediatePropagation(); e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  pushUndo();
  const local = outfit.worldToLocal(hit.point.clone());
  stroke = { id: e.pointerId, x: e.clientX, y: e.clientY, hit, local, t: performance.now(), moved: false };
  if (tool === 'tirer') {
    const n = camera.getWorldDirection(new THREE.Vector3());
    stroke.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, hit.point);
    stroke.startW = hit.point.clone();
    const cnt = sculpt.grabBegin(local, (+bsize.value / 100) / avgScale(), sym);
    if (!cnt) toast('Rien sous le pinceau');
  }
  placeRings(hit);
}, { capture: true });

canvas.addEventListener('pointermove', (e) => {
  if (pointerXY.has(e.pointerId)) pointerXY.set(e.pointerId, [e.clientX, e.clientY]);
  if (rigDepth && rig && rig.selected) {
    e.stopImmediatePropagation();
    const ys = [...pointerXY.values()].map((p) => p[1]);
    if (ys.length) {
      const y = ys.reduce((a, b) => a + b, 0) / ys.length;
      rig.setDepth(rigDepth.d0 + (y - rigDepth.y0) * 0.00045);
      refreshDepthSlider();
    }
    return;
  }
  if (rig && rig._drag) {
    e.stopImmediatePropagation();
    rig.dragTo(e.clientX, e.clientY);
    refreshDepthSlider();
    return;
  }
  if (!stroke || e.pointerId !== stroke.id) return;
  e.stopImmediatePropagation();
  stroke.x = e.clientX; stroke.y = e.clientY; stroke.moved = true;
  if (tool === 'tirer') {
    const rc = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rc.left) / rc.width) * 2 - 1, -((e.clientY - rc.top) / rc.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const p = new THREE.Vector3();
    if (ray.ray.intersectPlane(stroke.plane, p)) {
      const a = outfit.worldToLocal(stroke.startW.clone()), b = outfit.worldToLocal(p.clone());
      sculpt.grabMove(b.sub(a), +bstr.value);
      rings[0].position.copy(p);
    }
  }
}, { capture: true });

function endStroke(e) {
  pointers.delete(e.pointerId);
  pointerXY.delete(e.pointerId);
  if (rigDepth && pointerXY.size < 2) {
    rigDepth = null; controls.enabled = true; saveLocalSoon();
  }
  if (rig && rig._drag) { rig.endDrag(); saveLocalSoon(); }
  if (!stroke || e.pointerId !== stroke.id) return;
  e.stopImmediatePropagation();
  if (tool === 'tirer') sculpt.grabEnd();
  stroke = null; rings.forEach((r) => (r.visible = false));
  outfit.geometry.boundsTree.refit(); outfit.geometry.computeBoundingSphere();
  app.strokes = (app.strokes || 0) + 1;
  saveLocalSoon(); markPenStale(); autoPen();
}
canvas.addEventListener('pointerup', endStroke, { capture: true });
canvas.addEventListener('pointercancel', endStroke, { capture: true });

// airbrush dabs every frame while the finger is down (gonfler / pousser / lisser)
function strokeFrame() {
  if (!stroke || tool === 'tirer') return;
  const hit = hitOutfit(stroke.x, stroke.y);
  if (!hit) return;
  placeRings(hit);
  const local = outfit.worldToLocal(hit.point.clone());
  const n = sculpt.dab(tool, local, (+bsize.value / 100) / avgScale(), +bstr.value, sym);
  if (n.length) { outfit.geometry.boundsTree.refit(); }
}

// ---------- penetration: body vertices outside the outfit shell
const _v = new THREE.Vector3(), _inv = new THREE.Matrix4(), _tri = new THREE.Triangle(), _n = new THREE.Vector3();
let penStale = false;
function markPenStale() { if (app.penDone) { penStale = true; $('#penres').textContent += ' (à recalculer)'; app.penDone = false; } }
function autoPen() { if ($('#penauto').checked) computePen(); }
function computePen() {
  const t0 = performance.now();
  body.updateMatrixWorld(); outfit.updateMatrixWorld();
  _inv.copy(outfit.matrixWorld).invert();
  const bp = body.geometry.attributes.position, col = body.geometry.attributes.color;
  const op = outfit.geometry.attributes.position, oi = outfit.geometry.index.array;
  const bvh = outfit.geometry.boundsTree, target = {};
  const sc = avgScale(); let out = 0; const maxD = 0.25 / sc;
  for (let i = 0; i < bp.count; i++) {
    _v.fromBufferAttribute(bp, i).applyMatrix4(body.matrixWorld).applyMatrix4(_inv);
    const r = bvh.closestPointToPoint(_v, target, 0, maxD);
    let outside = true;
    if (r) {
      const f = r.faceIndex;
      _tri.setFromAttributeAndIndices(op, oi[3 * f], oi[3 * f + 1], oi[3 * f + 2]); _tri.getNormal(_n);
      outside = _v.sub(r.point).dot(_n) > 0;
    }
    if (outside) out++;
    col.setXYZ(i, 1, outside ? 0.18 : 1, outside ? 0.18 : 1);
  }
  col.needsUpdate = true;
  const pct = (100 * out) / bp.count, ms = Math.round(performance.now() - t0);
  $('#penres').textContent = `${out} points du corps dépassent de la tenue (${pct.toFixed(1)} %). Calcul : ${ms} ms. Mains, pieds et visage sortent forcément.`;
  app.penDone = true; app.pen = { out, pct, ms };
  return app.pen;
}
$('#pen').addEventListener('click', () => { const r = computePen(); toast(`${r.pct.toFixed(1)} % du corps traverse`); });

// ---------- save / load / export
let saveT;
function saveLocalSoon() { clearTimeout(saveT); saveT = setTimeout(saveLocal, 1000); }
function stateObj(withRest) {
  const s = { v: 1, app: 'apot_fit', groups: sculpt.G, tf: getTf(), m: outfit.matrix.toArray(), pos: f32ToB64(sculpt.pos), date: new Date().toISOString() };
  if (withRest) { s.rest = f32ToB64(sculpt.rest); s.space = 'glTF Y-up, local space of the outfit mesh (= Meshy tenue v10 local space). m = column-major node matrix in the scene, body node at its own TRS.'; s.bodyMatrix = body.matrix.toArray(); }
  if (rig) s.rig = rig.toJSON();
  return s;
}
function saveLocal() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(stateObj(false))); app.savedAt = Date.now(); $('#savestatus').textContent = 'Sauvegardé dans ce navigateur à ' + new Date().toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit' }) + '.'; }
  catch (err) { toast('Sauvegarde locale impossible : ' + err.message, 3000); }
}
function cloneTf(t) { return { p: t.p.slice(), r: t.r.slice(), su: t.su, s: t.s.slice() }; }
async function loadDefaultState() {
  try {
    const r = await fetch('assets/default_state.json');
    if (!r.ok) return null;
    return await r.json();
  } catch (err) { console.warn('default_state missing', err); return null; }
}
function applyFitState(s) {
  if (!s || typeof s !== 'object') throw new Error('État invalide');
  if (s.groups !== sculpt.G) throw new Error('Cet état ne correspond pas à ce modèle');
  if (typeof s.pos !== 'string') throw new Error('État incomplet (pas de sculpture)');
  sculpt.setPositions(b64ToF32(s.pos));
  outfit.geometry.boundsTree.refit();
  outfit.geometry.computeBoundingSphere();
  if (s.tf) setTf(s.tf);
  if (rig) {
    if (s.rig) { if (!rig.load(s.rig)) rig.estimate(); }
    else rig.estimate();
  }
  markPenStale();
}
function applyDefaultFit(quiet) {
  if (!defaultState) { sculpt.setPositions(sculpt.rest); outfit.geometry.boundsTree.refit(); setTf(meshyTf || startTf); if (rig) rig.estimate(); return false; }
  applyFitState(defaultState);
  if (!quiet) toast('Ajustement V2 chargé');
  return true;
}
function restoreLocal() {
  const raw = localStorage.getItem(LS_KEY);
  if (raw) {
    try {
      const s = JSON.parse(raw);
      if (s.groups !== sculpt.G) throw new Error('groups');
      applyFitState(s);
      toast('Sauvegarde reprise', 2200);
      return;
    } catch (err) {
      console.warn('restore failed', err);
      toast('Sauvegarde locale illisible, ajustement V2 chargé', 3000);
    }
  }
  applyDefaultFit(true);
  saveLocal();
}
const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); }
async function exportGLB() {
  const o = outfitMat.opacity; setOpacity(1);
  const vis = outfit.visible; outfit.visible = true;
  outfit.geometry.computeBoundingBox();
  try {
    const buf = await new GLTFExporter().parseAsync(outfit, { binary: true, onlyVisible: false });
    return new Blob([buf], { type: 'model/gltf-binary' });
  } finally { setOpacity(o); outfit.visible = vis; }
}
app.changed = () => sculpt.changedCount();
app.probe = (y = 0.33) => { // screen point of the outfit front at height y (test helper)
  const r = new THREE.Raycaster(new THREE.Vector3(0.03, y, 2), new THREE.Vector3(0, 0, -1)); r.firstHitOnly = true;
  const h = r.intersectObject(outfit, false)[0]; if (!h) return null;
  const p = h.point.clone().project(camera), rc = canvas.getBoundingClientRect();
  const x = rc.left + ((p.x + 1) / 2) * rc.width, yy = rc.top + ((1 - p.y) / 2) * rc.height;
  return { x, y: yy, world: h.point.toArray(), onCanvas: document.elementFromPoint(x, yy) === canvas };
};
app.exportGLB = exportGLB; app.computePen = computePen; app.state = () => stateObj(true);
app.getTf = getTf; app.setTf = (tf) => { setTf(tf); saveLocalSoon(); }; app.saveNow = saveLocal;
$('#save').addEventListener('click', () => { saveLocal(); $('#savedlg').showModal(); });
$('#closedlg').addEventListener('click', () => $('#savedlg').close());
$('#dlglb').addEventListener('click', async (e) => {
  const b = e.currentTarget; b.disabled = true; b.textContent = 'Export en cours…';
  try { const blob = await exportGLB(); download(blob, `apot_tenue_ajustee_${stamp()}.glb`); toast(`GLB prêt (${(blob.size / 1e6).toFixed(1)} Mo)`); }
  catch (err) { console.error(err); toast('Export raté : ' + err.message, 3500); }
  finally { b.disabled = false; b.textContent = '⬇ Télécharger la tenue (.glb)'; }
});
$('#dljson').addEventListener('click', () => download(new Blob([JSON.stringify(stateObj(true))], { type: 'application/json' }), `apot_tenue_etat_${stamp()}.json`));
$('#resetall').addEventListener('click', () => {
  if (!confirm('Revenir à l’ajustement V2 (celui que tu as validé) ?')) return;
  pushUndo();
  if (rig && rig.testing) rig.exitTester();
  refreshPoseBtns();
  applyDefaultFit(false);
  body.geometry.attributes.color.array.fill(1); body.geometry.attributes.color.needsUpdate = true; $('#penres').textContent = '';
  saveLocal();
  $('#savedlg').close();
});
$('#resetmeshy').addEventListener('click', () => {
  if (!confirm('Remettre la tenue telle que Meshy l’a livrée, sans tes ajustements ?')) return;
  pushUndo();
  if (rig && rig.testing) rig.exitTester();
  refreshPoseBtns();
  sculpt.setPositions(sculpt.rest); outfit.geometry.boundsTree.refit(); outfit.geometry.computeBoundingSphere();
  setTf(meshyTf || startTf);
  if (rig) rig.estimate();
  body.geometry.attributes.color.array.fill(1); body.geometry.attributes.color.needsUpdate = true; $('#penres').textContent = '';
  saveLocal();
  $('#savedlg').close(); toast('Tenue d’origine Meshy rétablie');
});
$('#openstate').addEventListener('click', () => $('#openfile').click());
$('#openfile').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const s = JSON.parse(await f.text());
    pushUndo();
    if (rig && rig.testing) rig.exitTester();
    refreshPoseBtns();
    applyFitState(s);
    saveLocal();
    $('#savedlg').close();
    toast('État ouvert : ' + (f.name || 'fichier'));
  } catch (err) {
    toast('Impossible d’ouvrir ce fichier : ' + err.message, 3500);
  }
});
addEventListener('pagehide', () => { if (!sculpt) return; clearTimeout(saveT); saveLocal(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && sculpt) { clearTimeout(saveT); saveLocal(); } });


// ---------- Rig mode UI
const FINGER_TABS = [
  { id: '', label: 'Tous' },
  { id: 'hand', label: 'Main' },
  { id: 'thumb', label: 'Pouce' },
  { id: 'index', label: 'Index' },
  { id: 'middle', label: 'Majeur' },
  { id: 'ring', label: 'Annulaire' },
  { id: 'pinky', label: 'Auriculaire' },
];
let jGroup = 'tete', jFinger = '';
function buildRigUI() {
  const box = $('#jgroups'); box.innerHTML = '';
  for (const g of GROUPS) {
    const b = document.createElement('button'); b.textContent = g.label; b.dataset.g = g.id;
    b.addEventListener('click', () => { jGroup = g.id; jFinger = ''; renderJointPicker(); });
    box.appendChild(b);
  }
  const poses = $('#poses'); poses.innerHTML = '';
  for (const p of POSES) {
    const b = document.createElement('button'); b.textContent = p.label; b.dataset.pose = p.id;
    b.addEventListener('click', () => applyPose(p.id));
    poses.appendChild(b);
  }
  const anims = $('#anims'); anims.innerHTML = '';
  for (const a of ANIMS) {
    const b = document.createElement('button'); b.textContent = a.label; b.dataset.anim = a.id;
    b.addEventListener('click', () => applyAnim(a.id));
    anims.appendChild(b);
  }
  $('#animplay').addEventListener('click', () => {
    if (!rig.animId) return;
    if (rig.animPlaying) rig.pauseAnim(); else rig.resumeAnim();
    refreshPoseBtns();
  });
  $('#animstop').addEventListener('click', () => {
    rig.stopAnim();
    refreshPoseBtns();
    toast('Retour à la pose de repos');
  });
  $('#animspeed').addEventListener('input', () => {
    const v = +$('#animspeed').value / 100;
    $('#animspeedv').textContent = v.toFixed(1) + '×';
    rig.setAnimSpeed(v);
  });
  $('#rigsym').addEventListener('click', (e) => { rig.sym = !rig.sym; e.currentTarget.classList.toggle('on', rig.sym); });
  $('#rigoutfit').addEventListener('click', (e) => {
    rig.setOutfitMode(rig.outfitMode === 'ghost' ? 'hidden' : 'ghost');
    e.currentTarget.classList.toggle('on', rig.outfitMode === 'ghost');
    e.currentTarget.textContent = rig.outfitMode === 'ghost' ? 'Tenue en transparent' : 'Tenue cachée';
  });
  const dinp = $('#rigdepth');
  dinp.addEventListener('pointerdown', () => { if (rig.selected) pushUndo(); });
  dinp.addEventListener('input', () => { rig.setDepth(+dinp.value); refreshDepthSlider(false); });
  dinp.addEventListener('change', () => saveLocalSoon());
  $('#rigcenter').addEventListener('click', () => {
    if (!rig.selected) return toast('Choisis d\'abord une articulation');
    if (rig.testing) { rig.exitTester(); refreshPoseBtns(); }
    pushUndo();
    if (!rig.centerInVolume()) toast('Pas de volume sous ce rayon');
    else { refreshDepthSlider(); saveLocalSoon(); toast('Centrée dans le volume'); }
  });
  $('#rigreset').addEventListener('click', () => { pushUndo(); if (rig.testing) rig.exitTester(); rig.estimate(); refreshRigSel(); refreshPoseBtns(); saveLocalSoon(); toast('Positions estimées depuis le corps'); });
  $('#poseamp').addEventListener('input', () => {
    $('#poseampv').textContent = $('#poseamp').value + ' %';
    if (rig.testing && rig.poseId !== 'repos') rig.setPose(rig.poseId, +$('#poseamp').value / 100);
  });
  rig.onSelect = () => refreshRigSel();
  renderJointPicker();
  refreshPoseBtns();
}
function renderJointPicker() {
  $$('#jgroups button').forEach((b) => b.classList.toggle('on', b.dataset.g === jGroup));
  const isHand = jGroup === 'mainL' || jGroup === 'mainR';
  const sub = $('#jsub'); sub.hidden = !isHand;
  if (isHand) {
    sub.innerHTML = '';
    for (const t of FINGER_TABS) {
      const b = document.createElement('button'); b.textContent = t.label;
      b.classList.toggle('on', jFinger === t.id);
      b.addEventListener('click', () => { jFinger = t.id; renderJointPicker(); });
      sub.appendChild(b);
    }
  }
  const list = $('#jlist'); list.innerHTML = '';
  const joints = JOINT_DEFS.filter((j) => {
    if (j.group !== jGroup) return false;
    if (isHand && jFinger) {
      if (jFinger === 'hand') return j.name.startsWith('hand.');
      return j.finger === true && j.fingerId === jFinger;
    }
    return true;
  });
  for (const j of joints) {
    const b = document.createElement('button'); b.textContent = j.label;
    b.classList.toggle('on', rig && rig.selected === j.name);
    b.addEventListener('click', () => { if (rig.testing) { rig.exitTester(); refreshPoseBtns(); } rig.select(j.name); refreshRigSel(); });
    list.appendChild(b);
  }
}
function refreshRigSel() {
  const n = rig && rig.selected;
  const def = n ? JOINT_DEFS.find((j) => j.name === n) : null;
  $('#rigsel').textContent = def ? ('Sélection : ' + def.label) : 'Aucune articulation sélectionnée';
  if (def && def.group !== jGroup) { jGroup = def.group; jFinger = def.fingerId || ''; }
  renderJointPicker();
  refreshDepthSlider();
}
function refreshDepthSlider(sync = true) {
  const inp = $('#rigdepth'), out = $('#rigdepthv');
  if (!rig || !rig.selected) { inp.disabled = true; out.textContent = '—'; return; }
  const r = rig.depthRange();
  inp.disabled = false;
  inp.min = r.min; inp.max = r.max; inp.step = 0.001;
  if (sync) inp.value = rig.getDepth();
  out.textContent = ((+inp.value - (r.min + r.max) / 2) * 100).toFixed(1) + ' cm';
}
function refreshPoseBtns() {
  $$('#poses button').forEach((b) => b.classList.toggle('on', rig && !rig.animId && rig.poseId === b.dataset.pose));
  const show = rig && rig.testing && !rig.animId && rig.poseId !== 'repos';
  $('#poseamprow').hidden = !show;
  $$('#anims button').forEach((b) => b.classList.toggle('on', rig && rig.animId === b.dataset.anim));
  const animOn = !!(rig && rig.animId);
  $('#animctrl').hidden = !animOn;
  const play = $('#animplay');
  if (play) {
    play.textContent = (rig && rig.animPlaying) ? '⏸ Pause' : '▶ Lecture';
    play.classList.toggle('on', !!(rig && rig.animPlaying));
  }
}
function applyPose(id) {
  if (rig.animId) rig.stopAnim();
  if (id === 'repos') {
    rig.resetPose();
    refreshPoseBtns();
    toast('Retour à la pose de repos');
    return;
  }
  const ms = rig.buildPreview();
  rig.setPose(id, +$('#poseamp').value / 100);
  refreshPoseBtns();
  toast(`Aperçu « ${POSES.find((p) => p.id === id).label} » (${ms} ms)`);
}
function applyAnim(id) {
  const ms = rig.playAnim(id);
  refreshPoseBtns();
  const label = (ANIMS.find((a) => a.id === id) || { label: id }).label;
  toast(`Animation « ${label} » (${ms} ms)`);
}

// keep Apot centred in the part of the screen the panel does not cover
let vo = '';
function updateViewOffset() {
  const W = innerWidth, H = innerHeight, pr = $('#panel').getBoundingClientRect(), tb = $('#tabs').getBoundingClientRect().bottom;
  let x = 0, y = 0;
  if (W >= 760) { const left = Math.min(W, pr.left); x = Math.max(0, W / 2 - (72 + left) / 2); }
  else { const top = Math.min(H, pr.top); y = Math.max(0, H / 2 - (tb + top) / 2); }
  const k = `${W}x${H}:${Math.round(x)},${Math.round(y)}`;
  if (k === vo) return; vo = k;
  camera.setViewOffset(W, H, Math.round(x), Math.round(y), W, H);
}
// ---------- loop
renderer.setAnimationLoop(() => { updateViewOffset(); strokeFrame(); if (rig && rig.testing) { rig.tickAnim(); rig.updateTestingMarkers(); } controls.update(); renderer.render(scene, camera); });
addEventListener('error', (e) => app.errors.push(String(e.message)));
init().catch((err) => { console.error(err); $('#loadmsg').textContent = 'Erreur de chargement : ' + err.message; app.errors.push(String(err)); });
