// Region-aware preview skin weights: classify verts to a limb first, then
// nearest-segment IDW within that region (max 4 influences). A short blended
// band at the armpit / hip / neck avoids a hard seam.
export const FINGER_IDS = ['thumb', 'index', 'middle', 'ring', 'pinky'];

export const BONES_OF = {
  torso: ['hips', 'spine', 'chest', 'neck', 'shoulder.L', 'shoulder.R'],
  head: ['head', 'neck'],
  'arm.L': ['upper_arm.L', 'forearm.L', 'hand.L'],
  'arm.R': ['upper_arm.R', 'forearm.R', 'hand.R'],
  'leg.L': ['thigh.L', 'shin.L', 'foot.L', 'toe.L', 'hips'],
  'leg.R': ['thigh.R', 'shin.R', 'foot.R', 'toe.R', 'hips'],
};
for (const S of ['L', 'R']) {
  for (const f of FINGER_IDS) {
    BONES_OF[`${f}.${S}`] = [`${f}.01.${S}`, `${f}.02.${S}`, `${f}.03.${S}`, `hand.${S}`];
  }
}

const Q = 1e5;

function planeSide(x, y, z, pl) {
  return (x - pl.o[0]) * pl.n[0] + (y - pl.o[1]) * pl.n[1] + (z - pl.o[2]) * pl.n[2];
}
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scale(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function len(a) { return Math.hypot(a[0], a[1], a[2]) || 1e-8; }
function norm(a) { const l = len(a); return [a[0] / l, a[1] / l, a[2] / l]; }
function smooth01(t) { t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }

function weldAndAdj(positions, index, n) {
  const map = new Map(), v2g = new Uint32Array(n), gpos = [];
  for (let i = 0; i < n; i++) {
    const k = Math.round(positions[3 * i] * Q) + ',' + Math.round(positions[3 * i + 1] * Q) + ',' + Math.round(positions[3 * i + 2] * Q);
    let id = map.get(k);
    if (id === undefined) { id = gpos.length / 3; map.set(k, id); gpos.push(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]); }
    v2g[i] = id;
  }
  const G = gpos.length / 3;
  const adj = Array.from({ length: G }, () => []);
  const addE = (a, b) => { if (a !== b && !adj[a].includes(b)) adj[a].push(b); };
  const tri = index || Uint32Array.from({ length: n }, (_, i) => i);
  for (let t = 0; t + 2 < tri.length; t += 3) {
    const a = v2g[tri[t]], b = v2g[tri[t + 1]], c = v2g[tri[t + 2]];
    addE(a, b); addE(b, a); addE(b, c); addE(c, b); addE(a, c); addE(c, a);
  }
  return { G, gpos, v2g, adj };
}

function segDist2(px, py, pz, s) {
  let t = ((px - s.a[0]) * s.ab[0] + (py - s.a[1]) * s.ab[1] + (pz - s.a[2]) * s.ab[2]) / s.len2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const dx = px - (s.a[0] + s.ab[0] * t), dy = py - (s.a[1] + s.ab[1] * t), dz = pz - (s.a[2] + s.ab[2] * t);
  return dx * dx + dy * dy + dz * dz;
}

function nearestSegs(px, py, pz, segs, names, k) {
  const acc = [];
  for (const s of segs) {
    if (names && !names.has(s.name)) continue;
    const d = segDist2(px, py, pz, s);
    if (acc.length < k) acc.push({ i: s.i, name: s.name, d });
    else {
      let w = 0;
      for (let j = 1; j < k; j++) if (acc[j].d > acc[w].d) w = j;
      if (d < acc[w].d) acc[w] = { i: s.i, name: s.name, d };
    }
  }
  acc.sort((a, b) => a.d - b.d);
  return acc;
}

function makePlanes(J) {
  const hips = J.hips || [0, 0.24, 0], neck = J.neck || [0, 0.56, 0], chest = J.chest || [0, 0.45, 0];
  let up = norm(sub(neck, hips));
  if (up[1] < 0) up = scale(up, -1);
  const head = { o: neck, n: up };
  const arm = {}, leg = {};
  for (const S of ['L', 'R']) {
    const socket = J[`upper_arm.${S}`] || J[`shoulder.${S}`];
    const hip = J[`thigh.${S}`] || hips;
    const shin = J[`shin.${S}`];
    if (socket) {
      let n = sub(socket, chest);
      n = sub(n, scale(up, dot(n, up)));
      if (len(n) < 1e-5) n = [S === 'L' ? 1 : -1, 0, 0];
      arm[S] = { o: socket, n: norm(n) };
    }
    if (hip) {
      let n = shin ? sub(shin, hip) : scale(up, -1);
      if (len(n) < 1e-5) n = [0, -1, 0];
      leg[S] = { o: hip, n: norm(n) };
    }
  }
  const wrist = {};
  for (const S of ['L', 'R']) {
    const hand = J[`hand.${S}`], mid = J[`middle.01.${S}`] || J[`forearm.${S}`];
    if (hand && mid) wrist[S] = { o: hand, n: norm(sub(mid, hand)) };
  }
  return { head, arm, leg, wrist, up };
}

function flood(adj, G, gpos, seed, allow) {
  const lab = new Uint8Array(G); // 1 = in
  const q = [];
  for (const g of seed) { if (!lab[g]) { lab[g] = 1; q.push(g); } }
  for (let i = 0; i < q.length; i++) {
    const g = q[i], a = adj[g];
    for (let k = 0; k < a.length; k++) {
      const n = a[k];
      if (lab[n]) continue;
      if (allow && !allow(n, gpos[3 * n], gpos[3 * n + 1], gpos[3 * n + 2])) continue;
      lab[n] = 1; q.push(n);
    }
  }
  return lab;
}

/**
 * @param {{positions:Float32Array, index:ArrayLike<number>|null, joints:Object, segments:Array, maxInfluences?:number, blend?:number}} args
 * joints: { name: [x,y,z] } in the same space as positions
 * segments: [{ name, i, a:[x,y,z], ab:[x,y,z], len2 }]
 */
export function computeSkinWeights({ positions, index, joints, segments, maxInfluences = 4, blend = 0.035 }) {
  const n = positions.length / 3;
  const { G, gpos, v2g, adj } = weldAndAdj(positions, index, n);
  const J = joints;
  const pl = makePlanes(J);
  const byName = Object.fromEntries(segments.map((s) => [s.name, s]));
  const segsOf = (names) => names.map((nm) => byName[nm]).filter(Boolean);

  const near = (g, names, r) => {
    const r2 = r * r, x = gpos[3 * g], y = gpos[3 * g + 1], z = gpos[3 * g + 2];
    for (const s of segsOf(names)) if (segDist2(x, y, z, s) < r2) return true;
    return false;
  };

  // --- classify groups ---
  const tag = new Array(G).fill('torso');

  // head: above the neck plane, flood from verts near the skull
  if (pl.head) {
    const seed = [];
    for (let g = 0; g < G; g++) {
      const s = planeSide(gpos[3 * g], gpos[3 * g + 1], gpos[3 * g + 2], pl.head);
      if (s > 0 && near(g, ['head', 'neck'], 0.08)) seed.push(g);
    }
    const lab = flood(adj, G, gpos, seed, (_, x, y, z) => planeSide(x, y, z, pl.head) > -blend);
    for (let g = 0; g < G; g++) if (lab[g] || planeSide(gpos[3 * g], gpos[3 * g + 1], gpos[3 * g + 2], pl.head) > 0.02) tag[g] = 'head';
  }

  // arms: beyond the outward armpit plane AND connected to the arm bone chain
  for (const S of ['L', 'R']) {
    if (!pl.arm[S]) continue;
    const armBones = BONES_OF[`arm.${S}`].concat(FINGER_IDS.map((f) => `${f}.01.${S}`), FINGER_IDS.map((f) => `${f}.02.${S}`), FINGER_IDS.map((f) => `${f}.03.${S}`));
    const seed = [];
    for (let g = 0; g < G; g++) {
      if (tag[g] === 'head') continue;
      const s = planeSide(gpos[3 * g], gpos[3 * g + 1], gpos[3 * g + 2], pl.arm[S]);
      if (s > 0 && near(g, armBones, 0.045)) seed.push(g);
    }
    const lab = flood(adj, G, gpos, seed, (n, x, y, z) => {
      if (planeSide(x, y, z, pl.arm[S]) <= -blend * 0.25) return false;
      return near(n, armBones, 0.055);
    });
    for (let g = 0; g < G; g++) if (lab[g]) tag[g] = `arm.${S}`;
  }

  // legs: past the hip/thigh plane, connected to the leg chain
  for (const S of ['L', 'R']) {
    if (!pl.leg[S]) continue;
    const seed = [];
    for (let g = 0; g < G; g++) {
      if (tag[g] !== 'torso') continue;
      const s = planeSide(gpos[3 * g], gpos[3 * g + 1], gpos[3 * g + 2], pl.leg[S]);
      if (s > 0 && near(g, BONES_OF[`leg.${S}`], 0.05)) seed.push(g);
    }
    const lab = flood(adj, G, gpos, seed, (n, x, y, z) => {
      if (planeSide(x, y, z, pl.leg[S]) <= -blend * 0.25) return false;
      return near(n, BONES_OF[`leg.${S}`], 0.06);
    });
    for (let g = 0; g < G; g++) if (lab[g]) tag[g] = `leg.${S}`;
  }

  // fingers: within the hand, past the wrist plane, nearest finger chain
  for (const S of ['L', 'R']) {
    if (!pl.wrist[S]) continue;
    for (let g = 0; g < G; g++) {
      if (tag[g] !== `arm.${S}`) continue;
      const x = gpos[3 * g], y = gpos[3 * g + 1], z = gpos[3 * g + 2];
      if (planeSide(x, y, z, pl.wrist[S]) < 0.005) continue;
      let best = null, bestD = 0.018 * 0.018;
      for (const f of FINGER_IDS) {
        const names = [`${f}.01.${S}`, `${f}.02.${S}`, `${f}.03.${S}`];
        for (const s of segsOf(names)) {
          const d = segDist2(x, y, z, s);
          if (d < bestD) { bestD = d; best = `${f}.${S}`; }
        }
      }
      if (best) tag[g] = best;
    }
  }

  // --- weights ---
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  const nameSet = (arr) => new Set(arr.filter((nm) => byName[nm]));

  const write = (i, hits, scaleMap) => {
    const k = Math.min(maxInfluences, hits.length);
    const tmp = [];
    let sum = 0;
    for (let j = 0; j < k; j++) {
      let w = 1 / (hits[j].d + 1e-8);
      if (scaleMap) w *= scaleMap(hits[j].name);
      tmp.push({ i: hits[j].i, w });
      sum += w;
    }
    if (!sum) { skinIndex[4 * i] = 0; skinWeight[4 * i] = 1; return; }
    for (let j = 0; j < k; j++) {
      skinIndex[4 * i + j] = tmp[j].i;
      skinWeight[4 * i + j] = tmp[j].w / sum;
    }
  };

  for (let i = 0; i < n; i++) {
    const g = v2g[i], region = tag[g];
    const x = positions[3 * i], y = positions[3 * i + 1], z = positions[3 * i + 2];
    const base = BONES_OF[region] || BONES_OF.torso;

    // blended seam at armpit / hip / neck
    let extra = null, fade = 0, extraIs = null;
    const dist3 = (pl) => Math.hypot(x - pl.o[0], y - pl.o[1], z - pl.o[2]);
    if (region === 'torso' || region.startsWith('arm.')) {
      const S = region === 'torso'
        ? (pl.arm.L && pl.arm.R ? (planeSide(x, y, z, pl.arm.L) > planeSide(x, y, z, pl.arm.R) ? 'L' : 'R') : (pl.arm.L ? 'L' : 'R'))
        : region.split('.')[1];
      if (pl.arm[S] && dist3(pl.arm[S]) < 0.06) {
        const s = planeSide(x, y, z, pl.arm[S]);
        if (Math.abs(s) < blend) {
          fade = smooth01((s + blend) / (2 * blend)); // 0 at torso, 1 at arm
          extra = BONES_OF[`arm.${S}`];
          extraIs = 'arm';
        }
      }
    }
    if (!extra && (region === 'torso' || region.startsWith('leg.'))) {
      const S = region === 'torso'
        ? (pl.leg.L && pl.leg.R ? (planeSide(x, y, z, pl.leg.L) > planeSide(x, y, z, pl.leg.R) ? 'L' : 'R') : (pl.leg.L ? 'L' : 'R'))
        : region.split('.')[1];
      if (pl.leg[S] && dist3(pl.leg[S]) < 0.07) {
        const s = planeSide(x, y, z, pl.leg[S]);
        if (Math.abs(s) < blend) {
          fade = smooth01((s + blend) / (2 * blend));
          extra = BONES_OF[`leg.${S}`];
          extraIs = 'leg';
        }
      }
    }
    if (!extra && (region === 'torso' || region === 'head') && pl.head && dist3(pl.head) < 0.07) {
      const s = planeSide(x, y, z, pl.head);
      if (Math.abs(s) < blend) {
        fade = smooth01((s + blend) / (2 * blend));
        extra = BONES_OF.head;
        extraIs = 'head';
      }
    }

    if (extra) {
      const names = nameSet(base.concat(extra));
      const hits = nearestSegs(x, y, z, segments, names, maxInfluences);
      const extraSet = new Set(extra);
      write(i, hits, (nm) => extraSet.has(nm) ? fade : (1 - fade));
    } else {
      write(i, nearestSegs(x, y, z, segments, nameSet(base), maxInfluences));
    }
  }
  return { skinIndex, skinWeight };
}

/** Palm facing direction + finger bend axis from JD's joint placement. */
export function palmFrame(joints, side) {
  const S = side;
  const hand = joints[`hand.${S}`], mid = joints[`middle.01.${S}`];
  const idx = joints[`index.01.${S}`], pnk = joints[`pinky.01.${S}`];
  if (!hand || !mid) return null;
  const finger = norm(sub(mid, hand));
  let across;
  if (idx && pnk) across = sub(idx, pnk);
  else across = [0, 0, 1];
  if (len(across) < 1e-6) across = [0, 0, 1];
  across = norm(across);
  // N = across × finger; pick the orientation that faces the body / down in A-pose
  let N = [
    across[1] * finger[2] - across[2] * finger[1],
    across[2] * finger[0] - across[0] * finger[2],
    across[0] * finger[1] - across[1] * finger[0],
  ];
  const toBody = [S === 'L' ? -1 : 1, -0.8, 0];
  if (dot(N, toBody) < 0) N = scale(N, -1);
  N = norm(N);
  // curl axis: finger × N so a fingertip moves toward the palm
  let axis = [
    finger[1] * N[2] - finger[2] * N[1],
    finger[2] * N[0] - finger[0] * N[2],
    finger[0] * N[1] - finger[1] * N[0],
  ];
  if (len(axis) < 1e-6) axis = [0, 0, S === 'L' ? 1 : -1];
  axis = norm(axis);
  return { finger, across, normal: N, axis };
}

export function fingerAxis(joints, fingerId, side, palm) {
  const a = joints[`${fingerId}.01.${side}`], b = joints[`${fingerId}.03.${side}`] || joints[`${fingerId}.02.${side}`];
  if (!a || !b || !palm) return palm && palm.axis;
  const dir = norm(sub(b, a));
  let axis = [
    dir[1] * palm.normal[2] - dir[2] * palm.normal[1],
    dir[2] * palm.normal[0] - dir[0] * palm.normal[2],
    dir[0] * palm.normal[1] - dir[1] * palm.normal[0],
  ];
  if (len(axis) < 1e-6) return palm.axis;
  return norm(axis);
}
