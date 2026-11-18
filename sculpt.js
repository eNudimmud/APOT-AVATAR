// Sculpt engine for a textured, UV-split mesh: vertices sharing a position are
// "welded" into groups so seams never tear. All maths in the mesh's LOCAL space.
import * as THREE from 'three';

export class Sculptable {
  constructor(mesh) {
    this.mesh = mesh;
    const g = (this.geo = mesh.geometry);
    const pos = g.attributes.position, nrm = g.attributes.normal;
    const n = pos.count, P = pos.array;
    // --- weld by position
    const q = 1e5, map = new Map(), v2g = new Uint32Array(n), gpos = [];
    for (let i = 0; i < n; i++) {
      const k = Math.round(P[3 * i] * q) + ',' + Math.round(P[3 * i + 1] * q) + ',' + Math.round(P[3 * i + 2] * q);
      let id = map.get(k);
      if (id === undefined) { id = gpos.length / 3; map.set(k, id); gpos.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]); }
      v2g[i] = id;
    }
    const G = (this.G = gpos.length / 3);
    this.v2g = v2g;
    this.pos = new Float32Array(gpos);
    this.rest = new Float32Array(gpos);
    // members CSR
    this.memOff = csrOffsets(G, (cb) => { for (let i = 0; i < n; i++) cb(v2g[i]); });
    this.mem = new Uint32Array(n);
    { const c = this.memOff.slice(0, G); for (let i = 0; i < n; i++) this.mem[c[v2g[i]]++] = i; }
    // faces in group ids
    const idx = g.index ? g.index.array : Uint32Array.from({ length: n }, (_, i) => i);
    const T = idx.length / 3;
    const tri = (this.tri = new Uint32Array(idx.length));
    for (let i = 0; i < idx.length; i++) tri[i] = v2g[idx[i]];
    this.T = T;
    // group -> faces CSR
    this.gfOff = csrOffsets(G, (cb) => { for (let i = 0; i < tri.length; i++) cb(tri[i]); });
    this.gf = new Uint32Array(tri.length);
    { const c = this.gfOff.slice(0, G); for (let i = 0; i < tri.length; i++) this.gf[c[tri[i]]++] = (i / 3) | 0; }
    // neighbours CSR (unique)
    const nb = Array.from({ length: G }, () => []);
    const add = (a, b) => { if (a !== b && !nb[a].includes(b)) nb[a].push(b); };
    for (let t = 0; t < T; t++) {
      const a = tri[3 * t], b = tri[3 * t + 1], c = tri[3 * t + 2];
      add(a, b); add(b, a); add(b, c); add(c, b); add(a, c); add(c, a);
    }
    this.nbOff = new Uint32Array(G + 1);
    for (let i = 0; i < G; i++) this.nbOff[i + 1] = this.nbOff[i] + nb[i].length;
    this.nb = new Uint32Array(this.nbOff[G]);
    for (let i = 0; i < G; i++) this.nb.set(nb[i], this.nbOff[i]);
    // group normals (from original vertex normals, so the look is unchanged until sculpted)
    this.gn = new Float32Array(G * 3);
    if (nrm) for (let i = 0; i < n; i++) { const gi = v2g[i]; this.gn[3 * gi] += nrm.array[3 * i]; this.gn[3 * gi + 1] += nrm.array[3 * i + 1]; this.gn[3 * gi + 2] += nrm.array[3 * i + 2]; }
    else this.recomputeNormals(null, false);
    for (let i = 0; i < G; i++) norm3(this.gn, i);
    this.flag = new Uint8Array(G);
    this.w = new Float32Array(G);
    this.side = new Uint8Array(G);
  }

  // weights for a dab at c (and mirrored at -x when sym). Returns touched list.
  gather(c, r, sym) {
    const P = this.pos, r2 = r * r, list = [];
    const mx = -c.x;
    for (let i = 0; i < this.G; i++) {
      const dy = P[3 * i + 1] - c.y, dz = P[3 * i + 2] - c.z;
      const yz = dy * dy + dz * dz;
      if (yz > r2) continue;
      const dx = P[3 * i] - c.x;
      let d2 = dx * dx + yz, s = 0;
      if (sym) { const ex = P[3 * i] - mx, e2 = ex * ex + yz; if (e2 < d2) { d2 = e2; s = 1; } }
      if (d2 >= r2) continue;
      const t = 1 - d2 / r2;
      this.w[i] = t * t; this.side[i] = s; list.push(i);
    }
    return list;
  }

  // inflate (+1) / push (-1) / smooth
  dab(tool, c, r, strength, sym) {
    const list = this.gather(c, r, sym);
    if (!list.length) return list;
    const P = this.pos, N = this.gn;
    if (tool === 'gonfler' || tool === 'pousser') {
      const k = (tool === 'gonfler' ? 1 : -1) * strength * r * 0.045;
      for (const i of list) { const w = this.w[i] * k; P[3 * i] += N[3 * i] * w; P[3 * i + 1] += N[3 * i + 1] * w; P[3 * i + 2] += N[3 * i + 2] * w; }
    } else if (tool === 'lisser') {
      const tmp = new Float32Array(list.length * 3);
      list.forEach((i, j) => {
        let ax = 0, ay = 0, az = 0; const a = this.nbOff[i], b = this.nbOff[i + 1];
        for (let e = a; e < b; e++) { const m = this.nb[e]; ax += P[3 * m]; ay += P[3 * m + 1]; az += P[3 * m + 2]; }
        const cnt = b - a || 1, f = Math.min(1, this.w[i] * strength * 0.6);
        tmp[3 * j] = P[3 * i] + (ax / cnt - P[3 * i]) * f;
        tmp[3 * j + 1] = P[3 * i + 1] + (ay / cnt - P[3 * i + 1]) * f;
        tmp[3 * j + 2] = P[3 * i + 2] + (az / cnt - P[3 * i + 2]) * f;
      });
      list.forEach((i, j) => { P[3 * i] = tmp[3 * j]; P[3 * i + 1] = tmp[3 * j + 1]; P[3 * i + 2] = tmp[3 * j + 2]; });
    }
    this.commit(list);
    return list;
  }

  grabBegin(c, r, sym) {
    const list = this.gather(c, r, sym);
    this.grab = { list, w: list.map((i) => this.w[i]), side: list.map((i) => this.side[i]), start: Float32Array.from(list.flatMap((i) => [this.pos[3 * i], this.pos[3 * i + 1], this.pos[3 * i + 2]])) };
    return list.length;
  }
  grabMove(d, strength) {
    const g = this.grab; if (!g) return;
    const P = this.pos;
    g.list.forEach((i, j) => {
      const w = g.w[j] * strength, sx = g.side[j] ? -1 : 1;
      P[3 * i] = g.start[3 * j] + d.x * sx * w; P[3 * i + 1] = g.start[3 * j + 1] + d.y * w; P[3 * i + 2] = g.start[3 * j + 2] + d.z * w;
    });
    this.commit(g.list);
  }
  grabEnd() { this.grab = null; }

  // write touched groups to the GPU buffers + recompute normals on touched + 1-ring
  commit(list) {
    const ring = [], F = this.flag;
    for (const i of list) { if (!F[i]) { F[i] = 1; ring.push(i); } }
    const base = ring.length;
    for (let k = 0; k < base; k++) { const i = ring[k]; for (let e = this.nbOff[i]; e < this.nbOff[i + 1]; e++) { const m = this.nb[e]; if (!F[m]) { F[m] = 1; ring.push(m); } } }
    for (const i of ring) F[i] = 0;
    this.recomputeNormals(ring, true);
    const pa = this.geo.attributes.position.array;
    for (const i of list) for (let e = this.memOff[i]; e < this.memOff[i + 1]; e++) { const v = this.mem[e]; pa[3 * v] = this.pos[3 * i]; pa[3 * v + 1] = this.pos[3 * i + 1]; pa[3 * v + 2] = this.pos[3 * i + 2]; }
    this.geo.attributes.position.needsUpdate = true;
    this.dirty = true;
  }

  recomputeNormals(list, write) {
    const P = this.pos, N = this.gn, tri = this.tri;
    const it = list || { length: this.G };
    for (let k = 0; k < it.length; k++) {
      const i = list ? list[k] : k;
      let nx = 0, ny = 0, nz = 0;
      for (let e = this.gfOff[i]; e < this.gfOff[i + 1]; e++) {
        const t = this.gf[e], a = tri[3 * t], b = tri[3 * t + 1], c = tri[3 * t + 2];
        const ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
        const vx = P[3 * c] - P[3 * a], vy = P[3 * c + 1] - P[3 * a + 1], vz = P[3 * c + 2] - P[3 * a + 2];
        nx += uy * vz - uz * vy; ny += uz * vx - ux * vz; nz += ux * vy - uy * vx;
      }
      N[3 * i] = nx; N[3 * i + 1] = ny; N[3 * i + 2] = nz; norm3(N, i);
      if (write) {
        const na = this.geo.attributes.normal.array;
        for (let e = this.memOff[i]; e < this.memOff[i + 1]; e++) { const v = this.mem[e]; na[3 * v] = N[3 * i]; na[3 * v + 1] = N[3 * i + 1]; na[3 * v + 2] = N[3 * i + 2]; }
      }
    }
    if (write) this.geo.attributes.normal.needsUpdate = true;
  }

  // restore a full snapshot of group positions (undo/redo/load)
  setPositions(arr) {
    const list = [];
    for (let i = 0; i < this.G; i++) {
      if (arr[3 * i] !== this.pos[3 * i] || arr[3 * i + 1] !== this.pos[3 * i + 1] || arr[3 * i + 2] !== this.pos[3 * i + 2]) {
        this.pos[3 * i] = arr[3 * i]; this.pos[3 * i + 1] = arr[3 * i + 1]; this.pos[3 * i + 2] = arr[3 * i + 2]; list.push(i);
      }
    }
    if (list.length) this.commit(list);
    return list.length;
  }
  changedCount() { let c = 0; for (let i = 0; i < this.pos.length; i++) if (this.pos[i] !== this.rest[i]) { c++; i += 2 - (i % 3); } return c; }
}

function csrOffsets(G, each) {
  const off = new Uint32Array(G + 1);
  each((g) => off[g + 1]++);
  for (let i = 0; i < G; i++) off[i + 1] += off[i];
  return off;
}
function norm3(a, i) { const l = Math.hypot(a[3 * i], a[3 * i + 1], a[3 * i + 2]) || 1; a[3 * i] /= l; a[3 * i + 1] /= l; a[3 * i + 2] /= l; }

export function f32ToB64(f) { const u = new Uint8Array(f.buffer, f.byteOffset, f.byteLength); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
export function b64ToF32(b) { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return new Float32Array(u.buffer); }
