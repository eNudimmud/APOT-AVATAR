// Manual joint placement + lightweight skinning preview for the Apot fit app.
import * as THREE from 'three';
import { computeSkinWeights, palmFrame, fingerAxis } from './weights.js';

const FINGERS = [
  { id: 'thumb',  label: 'Pouce' },
  { id: 'index',  label: 'Index' },
  { id: 'middle', label: 'Majeur' },
  { id: 'ring',   label: 'Annulaire' },
  { id: 'pinky',  label: 'Auriculaire' },
];
const PHAL = ['01', '02', '03'];
const PHAL_FR = ['base', 'milieu', 'bout'];

/** Usual ~21-bone layout (hips…toe) + 5×3 finger joints per hand. hips is the root. */
export const JOINT_DEFS = (() => {
  const d = [];
  const add = (name, parent, label, group, radius, extra = {}) => {
    d.push({ name, parent, label, group, radius, ...extra });
  };
  add('hips', null, 'Hanches', 'torse', 0.018);
  add('spine', 'hips', 'Colonne', 'torse', 0.014);
  add('chest', 'spine', 'Poitrine', 'torse', 0.014);
  add('neck', 'chest', 'Cou', 'tete', 0.012);
  add('head', 'neck', 'Tête', 'tete', 0.018);
  for (const [S, sideFr, gArm, gHand] of [['L', 'G', 'brasL', 'mainL'], ['R', 'D', 'brasR', 'mainR']]) {
    add(`shoulder.${S}`, 'chest', `Épaule ${sideFr}`, gArm, 0.013, { pair: `shoulder.${S === 'L' ? 'R' : 'L'}` });
    add(`upper_arm.${S}`, `shoulder.${S}`, `Bras ${sideFr}`, gArm, 0.013, { pair: `upper_arm.${S === 'L' ? 'R' : 'L'}` });
    add(`forearm.${S}`, `upper_arm.${S}`, `Avant-bras ${sideFr}`, gArm, 0.012, { pair: `forearm.${S === 'L' ? 'R' : 'L'}` });
    add(`hand.${S}`, `forearm.${S}`, `Main ${sideFr}`, gHand, 0.011, { pair: `hand.${S === 'L' ? 'R' : 'L'}` });
    for (const f of FINGERS) {
      for (let k = 0; k < 3; k++) {
        const name = `${f.id}.${PHAL[k]}.${S}`;
        const parent = k === 0 ? `hand.${S}` : `${f.id}.${PHAL[k - 1]}.${S}`;
        const pair = `${f.id}.${PHAL[k]}.${S === 'L' ? 'R' : 'L'}`;
        add(name, parent, `${f.label} ${sideFr} (${PHAL_FR[k]})`, gHand, 0.0065, { pair, finger: true, fingerId: f.id, phal: k });
      }
    }
  }
  for (const [S, sideFr] of [['L', 'G'], ['R', 'D']]) {
    add(`thigh.${S}`, 'hips', `Cuisse ${sideFr}`, 'jambes', 0.014, { pair: `thigh.${S === 'L' ? 'R' : 'L'}` });
    add(`shin.${S}`, `thigh.${S}`, `Tibia ${sideFr}`, 'jambes', 0.013, { pair: `shin.${S === 'L' ? 'R' : 'L'}` });
    add(`foot.${S}`, `shin.${S}`, `Pied ${sideFr}`, 'jambes', 0.011, { pair: `foot.${S === 'L' ? 'R' : 'L'}` });
    add(`toe.${S}`, `foot.${S}`, `Orteils ${sideFr}`, 'jambes', 0.009, { pair: `toe.${S === 'L' ? 'R' : 'L'}` });
  }
  return d;
})();

export const JOINT_INDEX = Object.fromEntries(JOINT_DEFS.map((j, i) => [j.name, i]));
export const GROUPS = [
  { id: 'tete', label: 'Tête' },
  { id: 'torse', label: 'Torse' },
  { id: 'brasL', label: 'Bras G' },
  { id: 'brasR', label: 'Bras D' },
  { id: 'mainL', label: 'Main G' },
  { id: 'mainR', label: 'Main D' },
  { id: 'jambes', label: 'Jambes' },
];
export const POSES = [
  { id: 'repos', label: 'Repos' },
  { id: 'bras_leves', label: 'Bras levés' },
  { id: 'accroupi', label: 'Accroupi' },
  { id: 'tete_tournee', label: 'Tête tournée' },
  { id: 'poing_ferme', label: 'Poing fermé' },
  { id: 'marche', label: 'Marche' },
];

const PRIMARY_CHILD = {
  hips: 'spine', spine: 'chest', chest: 'neck', neck: 'head',
  'shoulder.L': 'upper_arm.L', 'upper_arm.L': 'forearm.L', 'forearm.L': 'hand.L', 'hand.L': 'middle.01.L',
  'shoulder.R': 'upper_arm.R', 'upper_arm.R': 'forearm.R', 'forearm.R': 'hand.R', 'hand.R': 'middle.01.R',
  'thigh.L': 'shin.L', 'shin.L': 'foot.L', 'foot.L': 'toe.L',
  'thigh.R': 'shin.R', 'shin.R': 'foot.R', 'foot.R': 'toe.R',
};
for (const S of ['L', 'R']) {
  for (const f of FINGERS) {
    PRIMARY_CHILD[`${f.id}.01.${S}`] = `${f.id}.02.${S}`;
    PRIMARY_CHILD[`${f.id}.02.${S}`] = `${f.id}.03.${S}`;
  }
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

function childrenOf(name) {
  return JOINT_DEFS.filter((j) => j.parent === name).map((j) => j.name);
}

export class RigSystem {
  constructor({ scene, camera, canvas, body, outfit }) {
    this.scene = scene;
    this.camera = camera;
    this.canvas = canvas;
    this.body = body;
    this.outfit = outfit;
    this.sym = true;
    this.selected = null;
    this.visible = false;
    this.testing = false;
    this.poseId = 'repos';
    this.poseAmt = 1;
    this.outfitMode = 'ghost';
    this.onSelect = null;
    this.local = Object.fromEntries(JOINT_DEFS.map((j) => [j.name, new THREE.Vector3()]));
    this._savedOutfit = null;
    this._preview = null;
    this._drag = null;

    if (!body.geometry.boundsTree) body.geometry.computeBoundsTree();

    const sphGeo = new THREE.SphereGeometry(1, 16, 12);
    this.markers = {};
    this.markerGroup = new THREE.Group();
    this.markerGroup.name = 'APOT_rig_markers';
    this.markerGroup.visible = false;
    for (const j of JOINT_DEFS) {
      const mat = new THREE.MeshBasicMaterial({
        color: j.finger ? 0xf0c56a : 0xe0a83a,
        depthTest: false,
        transparent: true,
        opacity: 0.95,
        toneMapped: false,
      });
      const m = new THREE.Mesh(sphGeo, mat);
      m.name = 'joint:' + j.name;
      m.renderOrder = 20;
      m.scale.setScalar(j.radius);
      this.markers[j.name] = m;
      this.markerGroup.add(m);
    }
    const lineGeo = new THREE.BufferGeometry();
    const nSeg = JOINT_DEFS.filter((j) => j.parent).length;
    lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nSeg * 2 * 3), 3));
    this.lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
      color: 0xffe6a0, depthTest: false, transparent: true, opacity: 0.85, toneMapped: false,
    }));
    this.lines.renderOrder = 19;
    this.lines.frustumCulled = false;
    this.markerGroup.add(this.lines);
    scene.add(this.markerGroup);

    this.ray = new THREE.Raycaster();
    this.plane = new THREE.Plane();
  }

  // ----- serialize
  toJSON() {
    return {
      space: 'glTF Y-up, local space of the body mesh',
      bodyMatrix: this.body.matrix.toArray(),
      joints: JOINT_DEFS.map((j) => ({
        name: j.name,
        parent: j.parent,
        p: this.local[j.name].toArray(),
      })),
    };
  }
  load(rig) {
    if (!rig || !Array.isArray(rig.joints)) return false;
    const byName = Object.fromEntries(rig.joints.map((j) => [j.name, j]));
    let n = 0;
    for (const j of JOINT_DEFS) {
      const src = byName[j.name];
      if (src && Array.isArray(src.p) && src.p.length === 3) {
        this.local[j.name].fromArray(src.p); n++;
      }
    }
    if (n < 10) return false;
    this._syncMarkers();
    this._previewDirty = true;
    return true;
  }
  snapshot() {
    const o = {};
    for (const j of JOINT_DEFS) o[j.name] = this.local[j.name].toArray();
    return o;
  }
  restoreSnap(o) {
    if (!o) return;
    for (const j of JOINT_DEFS) if (o[j.name]) this.local[j.name].fromArray(o[j.name]);
    this._syncMarkers();
    this._previewDirty = true;
    if (this.testing) this.buildPreview(true);
  }

  setVisible(v) {
    this.visible = v;
    this.markerGroup.visible = v && !this.testing;
    if (v) {
      this._saveOutfit();
      this.applyOutfitMode(this.outfitMode);
      this._syncMarkers();
    } else {
      this.resetPose();
      this._teardownPreview();
      this._restoreOutfit();
      this.markerGroup.visible = false;
    }
  }
  setOutfitMode(mode) {
    this.outfitMode = mode;
    if (this.visible) this.applyOutfitMode(mode);
  }
  _saveOutfit() {
    if (this._savedOutfit) return;
    const mat = this.outfit.material;
    this._savedOutfit = { visible: this.outfit.visible, opacity: mat.opacity, transparent: mat.transparent, depthWrite: mat.depthWrite };
  }
  _restoreOutfit() {
    const s = this._savedOutfit;
    if (!s) return;
    this.outfit.visible = s.visible;
    const mat = this.outfit.material;
    mat.opacity = s.opacity; mat.transparent = s.transparent; mat.depthWrite = s.depthWrite; mat.needsUpdate = true;
    this._savedOutfit = null;
  }
  applyOutfitMode(mode) {
    const mat = this.outfit.material;
    if (mode === 'hidden') {
      this.outfit.visible = false;
    } else if (mode === 'ghost') {
      this.outfit.visible = true;
      mat.opacity = 0.32; mat.transparent = true; mat.depthWrite = false; mat.needsUpdate = true;
    } else {
      this.outfit.visible = true;
      mat.opacity = 1; mat.transparent = false; mat.depthWrite = true; mat.needsUpdate = true;
    }
  }

  // ----- world / local
  localToWorld(name, t = _v) { return this.body.localToWorld(t.copy(this.local[name])); }
  worldToLocal(w, t) { return this.body.worldToLocal((t || new THREE.Vector3()).copy(w)); }
  setWorld(name, w, withSym = true) {
    this.worldToLocal(w, this.local[name]);
    if (withSym && this.sym) {
      const def = JOINT_DEFS[JOINT_INDEX[name]];
      if (def.pair) {
        const p = this.local[name];
        this.local[def.pair].set(-p.x, p.y, p.z);
      } else if (!def.pair && (name === 'hips' || name === 'spine' || name === 'chest' || name === 'neck' || name === 'head')) {
        this.local[name].x = 0;
      }
    }
    this._syncMarkers();
    this._previewDirty = true;
  }

  _syncMarkers() {
    this.body.updateMatrixWorld(true);
    const pa = this.lines.geometry.attributes.position.array;
    let k = 0;
    for (const j of JOINT_DEFS) {
      const w = this.localToWorld(j.name, _v);
      this.markers[j.name].position.copy(w);
      const sel = j.name === this.selected;
      this.markers[j.name].scale.setScalar(j.radius * (sel ? 1.55 : 1));
      this.markers[j.name].material.color.setHex(sel ? 0x6ea6ff : (j.finger ? 0xf0c56a : 0xe0a83a));
      if (j.parent) {
        const p = this.localToWorld(j.parent, _v2);
        pa[k++] = p.x; pa[k++] = p.y; pa[k++] = p.z;
        pa[k++] = w.x; pa[k++] = w.y; pa[k++] = w.z;
      }
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
  }

  select(name) {
    this.selected = name;
    this._syncMarkers();
    if (this.onSelect) this.onSelect(name);
  }

  // Pixel hit-test; fingers get a larger minimum radius.
  hitTest(cx, cy) {
    const rc = this.canvas.getBoundingClientRect();
    let best = null, bestD = Infinity;
    for (const j of JOINT_DEFS) {
      const w = this.markers[j.name].position;
      _v.copy(w).project(this.camera);
      if (_v.z < -1 || _v.z > 1) continue;
      const x = rc.left + ((_v.x + 1) / 2) * rc.width;
      const y = rc.top + ((1 - _v.y) / 2) * rc.height;
      const dx = cx - x, dy = cy - y, d = Math.hypot(dx, dy);
      const minR = j.finger ? 36 : 28;
      const r = Math.max(minR, (j.radius * 1.4 / w.distanceTo(this.camera.position)) * rc.height * 0.6);
      if (d <= r && d < bestD) { bestD = d; best = j.name; }
    }
    return best;
  }

  screenPos(name) {
    const rc = this.canvas.getBoundingClientRect();
    const w = this.localToWorld(name, _v).project(this.camera);
    return {
      x: rc.left + ((w.x + 1) / 2) * rc.width,
      y: rc.top + ((1 - w.y) / 2) * rc.height,
      z: w.z,
      onCanvas: true,
    };
  }

  beginDrag(cx, cy) {
    if (!this.selected || this.testing) return false;
    const w = this.localToWorld(this.selected, new THREE.Vector3());
    this.camera.getWorldDirection(_v2);
    this.plane.setFromNormalAndCoplanarPoint(_v2, w);
    this._drag = { name: this.selected, start: w, planeN: _v2.clone() };
    return true;
  }
  dragTo(cx, cy) {
    if (!this._drag) return;
    this._setRayFromCanvas(cx, cy);
    if (this.ray.ray.intersectPlane(this.plane, _v3)) this.setWorld(this._drag.name, _v3);
  }
  endDrag() { this._drag = null; }

  // Depth along the camera view axis, in metres (positive = away from camera).
  depthRange() {
    this.body.updateMatrixWorld(true);
    if (!this.body.geometry.boundingBox) this.body.geometry.computeBoundingBox();
    const box = this.body.geometry.boundingBox;
    const corners = [box.min, box.max].flatMap((a) => [box.min, box.max].flatMap((b) => [
      this.body.localToWorld(new THREE.Vector3(a.x, a.y, b.z)),
    ]));
    // simpler: transform 8 corners
    const pts = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      pts.push(this.body.localToWorld(new THREE.Vector3(x, y, z)));
    }
    this.camera.getWorldDirection(_v2);
    const dots = pts.map((p) => p.dot(_v2));
    return { min: Math.min(...dots) - 0.04, max: Math.max(...dots) + 0.04, axis: _v2.clone() };
  }
  getDepth() {
    if (!this.selected) return 0;
    this.camera.getWorldDirection(_v2);
    return this.localToWorld(this.selected, _v).dot(_v2);
  }
  setDepth(dot) {
    if (!this.selected || this.testing) return;
    this.camera.getWorldDirection(_v2);
    const w = this.localToWorld(this.selected, new THREE.Vector3());
    const cur = w.dot(_v2);
    w.addScaledVector(_v2, dot - cur);
    this.setWorld(this.selected, w);
  }
  nudgeDepth(meters) {
    if (!this.selected || this.testing) return;
    this.camera.getWorldDirection(_v2);
    const w = this.localToWorld(this.selected, new THREE.Vector3());
    w.addScaledVector(_v2, meters);
    this.setWorld(this.selected, w);
  }

  centerInVolume() {
    if (!this.selected) return false;
    const w = this.localToWorld(this.selected, new THREE.Vector3());
    this.camera.getWorldDirection(_v2);
    const mid = this._interior(w, _v2);
    if (!mid) return false;
    this.setWorld(this.selected, mid);
    return true;
  }

  _setRayFromCanvas(cx, cy) {
    const rc = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((cx - rc.left) / rc.width) * 2 - 1, -((cy - rc.top) / rc.height) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
  }

  // Like _interior, but keep the original point if the hit is too far (avoids jumping into the torso).
  _interiorNear(point, dir, maxDist = 0.025) {
    const mid = this._interior(point, dir);
    if (!mid || mid.distanceTo(point) > maxDist) return point.clone();
    return mid;
  }

  // Midpoint of first and last hits through the body along a ray that passes by `point`.
  _interior(point, dir) {
    const d = dir.clone().normalize();
    const origin = point.clone().addScaledVector(d, -3);
    const prev = this.ray.firstHitOnly;
    this.ray.firstHitOnly = false;
    this.ray.near = 0; this.ray.far = 8;
    this.ray.ray.set(origin, d);
    const hits = this.ray.intersectObject(this.body, false);
    this.ray.firstHitOnly = prev;
    if (hits.length >= 2) {
      return hits[0].point.clone().lerp(hits[hits.length - 1].point, 0.5);
    }
    if (hits.length === 1) return hits[0].point.clone();
    // try opposite
    this.ray.firstHitOnly = false;
    this.ray.ray.set(point.clone().addScaledVector(d, 3), d.clone().negate());
    const hits2 = this.ray.intersectObject(this.body, false);
    this.ray.firstHitOnly = prev;
    if (hits2.length >= 2) return hits2[0].point.clone().lerp(hits2[hits2.length - 1].point, 0.5);
    return null;
  }

  // ----- auto-estimate from the body mesh
  estimate() {
    const body = this.body;
    body.updateMatrixWorld(true);
    const attr = body.geometry.attributes.position;
    const N = attr.count;
    const P = new Float32Array(N * 3);
    const v = new THREE.Vector3();
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, zmin = Infinity, zmax = -Infinity;
    for (let i = 0; i < N; i++) {
      v.fromBufferAttribute(attr, i).applyMatrix4(body.matrixWorld);
      P[3 * i] = v.x; P[3 * i + 1] = v.y; P[3 * i + 2] = v.z;
      if (v.x < xmin) xmin = v.x; if (v.x > xmax) xmax = v.x;
      if (v.y < ymin) ymin = v.y; if (v.y > ymax) ymax = v.y;
      if (v.z < zmin) zmin = v.z; if (v.z > zmax) zmax = v.z;
    }
    const h = Math.max(1e-4, ymax - ymin);
    // width profile to find neck / hips
    const bins = 50, width = new Float32Array(bins), midZ = new Float32Array(bins), cnt = new Uint32Array(bins), gap = new Uint32Array(bins);
    for (let i = 0; i < N; i++) {
      const y = P[3 * i + 1];
      const b = Math.max(0, Math.min(bins - 1, ((y - ymin) / h * bins) | 0));
      const x = P[3 * i], z = P[3 * i + 2];
      width[b] = Math.max(width[b], Math.abs(x));
      midZ[b] += z; cnt[b]++;
      if (Math.abs(x) < 0.02) gap[b]++;
    }
    for (let b = 0; b < bins; b++) if (cnt[b]) midZ[b] /= cnt[b];
    const yAt = (t) => ymin + t * h;
    // neck: narrowest width in the upper half
    let neckB = (0.62 * bins) | 0, neckW = Infinity;
    for (let b = (0.52 * bins) | 0; b < (0.72 * bins); b++) {
      if (cnt[b] > 8 && width[b] < neckW) { neckW = width[b]; neckB = b; }
    }
    const neckY = yAt((neckB + 0.5) / bins);
    // hips: first height from the feet where the mid-line fills (legs join)
    let hipB = (0.24 * bins) | 0;
    for (let b = (0.12 * bins) | 0; b < (0.40 * bins); b++) {
      if (gap[b] > 15 && cnt[b] > 40) { hipB = b; break; }
    }
    const hipsY = yAt((hipB + 0.5) / bins) + 0.05;
    const chestY = neckY * 0.35 + hipsY * 0.15 + ymin * 0 + (neckY + hipsY) * 0.5 * 0.5;
    const chestY2 = hipsY + (neckY - hipsY) * 0.62;
    const spineY = hipsY + (neckY - hipsY) * 0.28;
    const headY = neckY + Math.min(0.045, (ymax - neckY) * 0.18);
    const zC = (zmin + zmax) * 0.5 * 0.15; // slightly forward of box center is often 0; use 0 and snap
    const centerline = {
      hips: [0, hipsY, 0.01],
      spine: [0, spineY, 0.02],
      chest: [0, chestY2, 0.015],
      neck: [0, neckY, 0.01],
      head: [0, headY, 0],
    };
    const world = {};
    for (const [n, p] of Object.entries(centerline)) {
      const w = new THREE.Vector3(...p);
      const mid = this._interior(w, new THREE.Vector3(0, 0, 1)) || w;
      mid.x = 0;
      world[n] = mid;
    }

    const meanBand = (pred) => {
      let sx = 0, sy = 0, sz = 0, c = 0;
      for (let i = 0; i < N; i++) {
        const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
        if (pred(x, y, z)) { sx += x; sy += y; sz += z; c++; }
      }
      return c ? new THREE.Vector3(sx / c, sy / c, sz / c) : null;
    };
    const extreme = (pred, score) => {
      let best = -Infinity, bp = null;
      for (let i = 0; i < N; i++) {
        const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
        if (!pred(x, y, z)) continue;
        const s = score(x, y, z);
        if (s > best) { best = s; bp = new THREE.Vector3(x, y, z); }
      }
      return bp;
    };

    for (const S of [1, -1]) {
      const tag = S > 0 ? 'L' : 'R';
      const side = (x) => x * S;
      // legs
      const thigh = meanBand((x, y) => side(x) > 0.04 && y > hipsY - 0.06 && y < hipsY + 0.02) || new THREE.Vector3(S * 0.09, hipsY - 0.04, 0.02);
      const shin = meanBand((x, y) => side(x) > 0.05 && y > ymin + 0.08 && y < ymin + 0.16) || new THREE.Vector3(S * 0.10, ymin + 0.12, 0.02);
      const foot = meanBand((x, y) => side(x) > 0.04 && y < ymin + 0.07) || new THREE.Vector3(S * 0.10, ymin + 0.03, 0.02);
      const toe = extreme((x, y) => side(x) > 0.03 && y < ymin + 0.08, (x, y, z) => z) || foot.clone().add(new THREE.Vector3(0, -0.01, 0.08));
      world[`thigh.${tag}`] = this._interior(thigh, new THREE.Vector3(0, 0, 1)) || thigh;
      world[`shin.${tag}`] = this._interior(shin, new THREE.Vector3(0, 0, 1)) || shin;
      world[`foot.${tag}`] = this._interior(foot, new THREE.Vector3(0, 0, 1)) || foot;
      world[`toe.${tag}`] = toe;

      // arms: outside the torso, below the neck, above the hips-ish
      const armPred = (x, y) => side(x) > 0.13 && y < neckY - 0.02 && y > hipsY - 0.02;
      const shoulder = meanBand((x, y) => side(x) > 0.08 && side(x) < 0.14 && y > chestY2 - 0.03 && y < neckY - 0.02)
        || new THREE.Vector3(S * 0.11, chestY2 + 0.03, 0);
      const upper = meanBand((x, y) => side(x) > 0.14 && side(x) < 0.19 && y > hipsY + 0.12 && y < neckY)
        || new THREE.Vector3(S * 0.16, chestY2 - 0.03, 0.01);
      const elbow = meanBand((x, y) => side(x) > 0.18 && side(x) < 0.23 && y < chestY2 && y > hipsY)
        || new THREE.Vector3(S * 0.21, hipsY + 0.12, 0.04);
      const wrist = meanBand((x, y) => side(x) > 0.21 && side(x) < 0.25 && y < elbow.y + 0.04 && y > ymin + 0.22)
        || new THREE.Vector3(S * 0.235, elbow.y - 0.05, 0.06);
      world[`shoulder.${tag}`] = this._interior(shoulder, new THREE.Vector3(0, 0, 1)) || shoulder;
      world[`upper_arm.${tag}`] = this._interior(upper, new THREE.Vector3(0, 0, 1)) || upper;
      world[`forearm.${tag}`] = this._interior(elbow, new THREE.Vector3(0, 0, 1)) || elbow;
      world[`hand.${tag}`] = this._interior(wrist, new THREE.Vector3(0, 0, 1)) || wrist;

      this._placeFingers(world, P, N, tag, S, world[`hand.${tag}`], neckY, hipsY);
    }

    // write body-local
    for (const j of JOINT_DEFS) {
      const w = world[j.name];
      if (w) this.worldToLocal(w, this.local[j.name]);
    }
    // force midline x = 0 in local after convert (body may be slightly off-center)
    for (const n of ['hips', 'spine', 'chest', 'neck', 'head']) this.local[n].x = 0;
    this._syncMarkers();
    this._previewDirty = true;
  }

  _placeFingers(world, P, N, tag, S, hand, neckY, hipsY) {
    const tip = (() => {
      let best = -Infinity, p = hand.clone();
      for (let i = 0; i < N; i++) {
        const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
        if (y > neckY - 0.05 || y < hipsY - 0.05) continue;
        const s = x * S;
        if (s < 0.20) continue;
        if (s > best) { best = s; p = new THREE.Vector3(x, y, z); }
      }
      return p;
    })();
    const out = tip.clone().sub(hand);
    if (out.lengthSq() < 1e-8) out.set(S, -0.4, 0.2);
    out.normalize();
    // palm: prefer "down" (-Y) then forward
    let up = new THREE.Vector3(0, 1, 0);
    const across = new THREE.Vector3().crossVectors(out, up);
    if (across.lengthSq() < 1e-8) across.crossVectors(out, new THREE.Vector3(0, 0, 1));
    across.normalize();
    // we want "across" ≈ world Z (forward) so the thumb sits forward of the fingers
    if (across.z * S < 0) across.negate(); // tweak: keep +Z component
    up = new THREE.Vector3().crossVectors(across, out).normalize();

    // collect hand cloud
    const pts = [];
    for (let i = 0; i < N; i++) {
      const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
      if (y > hand.y + 0.08 || y < hand.y - 0.08) continue;
      if (x * S < hand.x * S - 0.01) continue;
      const p = new THREE.Vector3(x, y, z);
      const along = p.clone().sub(hand).dot(out);
      if (along < -0.005) continue;
      pts.push({ p, along, u: p.clone().sub(hand).dot(up), a: p.clone().sub(hand).dot(across) });
    }
    const fingerLen = Math.max(0.03, Math.min(0.07, (pts.reduce((m, q) => Math.max(m, q.along), 0.03))));
    // 5 fan directions: thumb more palmar (+across) and slightly up; pinky opposite
    const fans = [
      { id: 'thumb',  u: 0.35, a: 0.85 },
      { id: 'index',  u: 0.55, a: 0.25 },
      { id: 'middle', u: 0.15, a: 0.02 },
      { id: 'ring',   u: -0.25, a: -0.12 },
      { id: 'pinky',  u: -0.55, a: -0.25 },
    ];
    for (const f of fans) {
      const dir = out.clone().addScaledVector(up, f.u * 0.55).addScaledVector(across, f.a * 0.55).normalize();
      // farthest point in a loose cone
      let best = 0, tipP = hand.clone().addScaledVector(dir, fingerLen);
      for (const q of pts) {
        const dlt = q.p.clone().sub(hand);
        const al = dlt.dot(dir);
        if (al < 0.008) continue;
        const lat = dlt.clone().addScaledVector(dir, -al).length();
        if (lat > 0.018) continue;
        if (al > best) { best = al; tipP = q.p.clone(); }
      }
      const base = hand.clone().addScaledVector(dir, 0.008);
      for (let k = 0; k < 3; k++) {
        const t = (k + 1) / 3.15;
        const p = base.clone().lerp(tipP, t);
        const mid = this._interiorNear(p, dir, 0.02);
        world[`${f.id}.0${k + 1}.${tag}`] = mid;
      }
    }
  }

  // ----- tester / skinning
  buildPreview(force) {
    if (this._preview && !this._previewDirty && !force) {
      this.testing = true;
      this._setPreviewVisible(true);
      this.markerGroup.visible = true;
      return this._preview.ms;
    }
    const t0 = performance.now();
    this._teardownPreview(false);
    this.body.updateMatrixWorld(true);
    this.outfit.updateMatrixWorld(true);

    const rigRoot = new THREE.Group();
    rigRoot.name = 'APOT_rig_root';
    this.body.matrixWorld.decompose(rigRoot.position, rigRoot.quaternion, rigRoot.scale);
    this.scene.add(rigRoot);

    const bones = {};
    const boneList = [];
    for (const j of JOINT_DEFS) {
      const b = new THREE.Bone();
      b.name = j.name;
      bones[j.name] = b;
      boneList.push(b);
    }
    // attach hierarchy and aim +Y toward the primary child, in rigRoot space
    const headOf = (n) => this.local[n].clone();
    const tailOf = (n) => {
      const c = PRIMARY_CHILD[n];
      if (c) return this.local[c].clone();
      const def = JOINT_DEFS[JOINT_INDEX[n]];
      if (n === 'head') {
        // long tail to the crown so the face is weighted to the head bone
        if (!this.body.geometry.boundingBox) this.body.geometry.computeBoundingBox();
        const topLocalY = this.body.geometry.boundingBox.max.y;
        return new THREE.Vector3(this.local.head.x, topLocalY, this.local.head.z);
      }
      if (def.parent) {
        const d = this.local[n].clone().sub(this.local[def.parent]);
        if (d.lengthSq() > 1e-10) return this.local[n].clone().add(d.normalize().multiplyScalar(n.startsWith('toe') ? 0.04 : 0.025));
      }
      return this.local[n].clone().add(new THREE.Vector3(0, 0.04, 0));
    };
    const bind = {};
    for (const j of JOINT_DEFS) {
      const b = bones[j.name];
      const head = headOf(j.name);
      const tail = tailOf(j.name);
      const dir = tail.sub(head);
      if (!j.parent) {
        b.position.copy(head);
        if (dir.lengthSq() > 1e-12) b.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
        rigRoot.add(b);
      } else {
        const pb = bones[j.parent];
        pb.add(b);
        pb.updateMatrixWorld(true);
        const headW = rigRoot.localToWorld(head.clone());
        const tailW = rigRoot.localToWorld(tailOf(j.name));
        b.position.copy(pb.worldToLocal(headW));
        const lp = b.position;
        const lt = pb.worldToLocal(tailW);
        const ld = lt.sub(lp);
        if (ld.lengthSq() > 1e-12) b.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), ld.normalize());
      }
      b.updateMatrix();
      bind[j.name] = { pos: b.position.clone(), quat: b.quaternion.clone() };
    }
    rigRoot.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(boneList);

    const jointsW = {};
    const segs = [];
    for (const j of JOINT_DEFS) {
      const a = this.localToWorld(j.name, new THREE.Vector3());
      jointsW[j.name] = a.toArray();
      const c = PRIMARY_CHILD[j.name];
      const b = c ? this.localToWorld(c, new THREE.Vector3()) : this.body.localToWorld(tailOf(j.name));
      const ab = b.clone().sub(a);
      const len2 = ab.lengthSq() || 1e-8;
      segs.push({ i: JOINT_INDEX[j.name], name: j.name, a: a.toArray(), ab: ab.toArray(), len2 });
    }

    const skinMesh = (mesh) => {
      const pos = mesh.geometry.attributes.position;
      const n = pos.count;
      const world = new Float32Array(n * 3);
      const mw = mesh.matrixWorld;
      const v = new THREE.Vector3();
      for (let i = 0; i < n; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mw);
        world[3 * i] = v.x; world[3 * i + 1] = v.y; world[3 * i + 2] = v.z;
      }
      const { skinIndex: idx, skinWeight: wgt } = computeSkinWeights({
        positions: world,
        index: mesh.geometry.index ? mesh.geometry.index.array : null,
        joints: jointsW,
        segments: segs,
        maxInfluences: 4,
        blend: 0.035,
      });
      const geo = mesh.geometry;
      geo.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
      geo.setAttribute('skinWeight', new THREE.BufferAttribute(wgt, 4));
      const sk = new THREE.SkinnedMesh(geo, mesh.material);
      sk.name = mesh.name + '_skinned';
      sk.frustumCulled = false;
      mesh.matrixWorld.decompose(sk.position, sk.quaternion, sk.scale);
      sk.bind(skeleton, mesh.matrixWorld.clone());
      this.scene.add(sk);
      mesh.visible = false;
      return sk;
    };

    const bodySk = skinMesh(this.body);
    const outfitSk = skinMesh(this.outfit);
    // keep markers visible on top during pose
    this.markerGroup.visible = true;

    this._preview = { rigRoot, bones, boneList, skeleton, bind, bodySk, outfitSk, bodyWas: true, outfitWas: this.outfit.visible, ms: Math.round(performance.now() - t0) };
    this._previewDirty = false;
    this.testing = true;
    this._bindMarkersToBones();
    return this._preview.ms;
  }

  _bindMarkersToBones() {
    // follow posed bones: parent a copy offset? we'll tick from bone world positions
  }
  updateTestingMarkers() {
    if (!this.testing || !this._preview) return;
    const { bones } = this._preview;
    const pa = this.lines.geometry.attributes.position.array;
    let k = 0;
    for (const j of JOINT_DEFS) {
      bones[j.name].getWorldPosition(_v);
      this.markers[j.name].position.copy(_v);
      if (j.parent) {
        bones[j.parent].getWorldPosition(_v2);
        pa[k++] = _v2.x; pa[k++] = _v2.y; pa[k++] = _v2.z;
        pa[k++] = _v.x; pa[k++] = _v.y; pa[k++] = _v.z;
      }
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
  }

  _setPreviewVisible(on) {
    if (!this._preview) return;
    this._preview.bodySk.visible = on;
    this._preview.outfitSk.visible = on && this.outfitMode !== 'hidden';
    this.body.visible = !on;
    if (on) {
      this.outfit.visible = false;
      if (this.outfitMode !== 'hidden') this._preview.outfitSk.visible = true;
    } else {
      this._restoreOutfit();
      this._saveOutfit();
      this.applyOutfitMode(this.outfitMode);
    }
  }

  resetPose() {
    this.poseId = 'repos';
    if (!this._preview) return;
    const { bones, bind } = this._preview;
    for (const j of JOINT_DEFS) {
      bones[j.name].position.copy(bind[j.name].pos);
      bones[j.name].quaternion.copy(bind[j.name].quat);
    }
  }

  setPose(id, amt = 1) {
    if (id === 'repos') { this.resetPose(); return; }
    if (!this.testing) this.buildPreview();
    this.resetPose();
    this.poseId = id;
    this.poseAmt = amt;
    const { bones } = this._preview;
    const a = amt;
    const _axis = new THREE.Vector3();
    const _wq = new THREE.Quaternion();
    const _pq = new THREE.Quaternion();
    const _add = new THREE.Quaternion();
    const rotWorld = (name, ax, ay, az, angle) => {
      const b = bones[name]; if (!b) return;
      _axis.set(ax, ay, az).normalize();
      b.updateWorldMatrix(true, false);
      b.getWorldQuaternion(_wq);
      _add.setFromAxisAngle(_axis, angle * a);
      const target = _add.multiply(_wq);
      if (b.parent) {
        b.parent.getWorldQuaternion(_pq).invert();
        b.quaternion.copy(_pq).multiply(target);
      } else {
        b.quaternion.copy(target);
      }
    };
    // World-space rotations (more stable than local axes after auto-aim).
    if (id === 'bras_leves') {
      // Raise forward/up (axis tilted in front of the coronal plane) so the arms
      // come up in front of the body, not in a flat T.
      rotWorld('upper_arm.L', 0.45, 0, 1, 1.85);
      rotWorld('upper_arm.R', 0.45, 0, -1, 1.85);
      rotWorld('forearm.L', 0.45, 0, 1, 0.35);
      rotWorld('forearm.R', 0.45, 0, -1, 0.35);
    } else if (id === 'accroupi') {
      rotWorld('thigh.L', 1, 0, 0, -1.35); rotWorld('thigh.R', 1, 0, 0, -1.35);
      rotWorld('shin.L', 1, 0, 0, 1.7); rotWorld('shin.R', 1, 0, 0, 1.7);
      rotWorld('foot.L', 1, 0, 0, -0.35); rotWorld('foot.R', 1, 0, 0, -0.35);
      rotWorld('spine', 1, 0, 0, 0.2);
    } else if (id === 'tete_tournee') {
      rotWorld('neck', 0, 1, 0, 0.7);
      rotWorld('head', 0, 1, 0, 0.45);
    } else if (id === 'poing_ferme') {
      const pj = {};
      for (const j of JOINT_DEFS) pj[j.name] = this.localToWorld(j.name, new THREE.Vector3()).toArray();
      for (const S of ['L', 'R']) {
        const palm = palmFrame(pj, S);
        if (!palm) continue;
        for (const f of FINGERS) {
          const axis = fingerAxis(pj, f.id, S, palm) || palm.axis;
          const curl = f.id === 'thumb' ? 0.75 : 1;
          rotWorld(`${f.id}.01.${S}`, axis[0], axis[1], axis[2], 0.85 * curl);
          rotWorld(`${f.id}.02.${S}`, axis[0], axis[1], axis[2], 1.2 * curl);
          rotWorld(`${f.id}.03.${S}`, axis[0], axis[1], axis[2], 0.95 * curl);
        }
      }
    } else if (id === 'marche') {
      rotWorld('thigh.L', 1, 0, 0, -0.7); rotWorld('thigh.R', 1, 0, 0, 0.55);
      rotWorld('shin.L', 1, 0, 0, 0.45); rotWorld('shin.R', 1, 0, 0, 0.2);
      rotWorld('upper_arm.L', 0, 0, 1, 0.5); rotWorld('upper_arm.R', 0, 0, 1, -0.55);
      rotWorld('forearm.L', 0, 0, 1, -0.25); rotWorld('forearm.R', 0, 0, 1, 0.25);
    }
  }

  exitTester() {
    if (!this.testing && !this._preview) return;
    this.resetPose();
    this._teardownPreview(true);
  }
  _teardownPreview(restore = true) {
    const p = this._preview;
    if (!p) { this.testing = false; return; }
    if (p.bodySk) this.scene.remove(p.bodySk);
    if (p.outfitSk) this.scene.remove(p.outfitSk);
    // SkinnedMesh shares geometry; do not dispose it. Drop skin attrs so export stays clean.
    for (const g of [this.body.geometry, this.outfit.geometry]) {
      if (g.getAttribute('skinIndex')) g.deleteAttribute('skinIndex');
      if (g.getAttribute('skinWeight')) g.deleteAttribute('skinWeight');
    }
    if (p.rigRoot) this.scene.remove(p.rigRoot);
    this._preview = null;
    this.testing = false;
    this.poseId = 'repos';
    this.body.visible = true;
    if (restore && this.visible) {
      this.applyOutfitMode(this.outfitMode);
      this.markerGroup.visible = true;
    }
    this._syncMarkers();
  }

  dispose() {
    this._teardownPreview();
    this.scene.remove(this.markerGroup);
  }
}
