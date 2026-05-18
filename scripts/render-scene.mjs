#!/usr/bin/env node
// Offscreen renderer for visually-3d scenes — pure Node, no dependencies,
// no browser, no GPU. Rasterizes a MachineSceneDescriptor into a 2x2
// contact-sheet PNG so a vision model can inspect it "visually":
//
//   top-left   ISO    shaded isometric — recognizability + occlusion
//   top-right  FRONT  +Z looking toward -Z
//   bottom-left SIDE   +X looking toward -X
//   bottom-right TOP   looking straight down (-Y)
//
// It is a painter's-algorithm flat-shaded solid renderer: faces are OPAQUE,
// so a part buried inside a box is genuinely hidden in the image. That is
// what lets the reviewer apply the "X-ray test" — if you can SEE it, it is
// legible; if the render hides it, the scene hides it.
//
// Usage: node scripts/render-scene.mjs <scene.json> <out.png> [panelPx]

import { readFileSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

// ── vector helpers ────────────────────────────────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

// three.js Euler order 'XYZ': R = Rx · Ry · Rz, so apply Rz, then Ry, then Rx.
const rotate = (p, r) => {
  if (!r) return p;
  const [rx, ry, rz] = r;
  let [x, y, z] = p;
  let c = Math.cos(rz), s = Math.sin(rz);
  [x, y] = [x * c - y * s, x * s + y * c];
  c = Math.cos(ry); s = Math.sin(ry);
  [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(rx); s = Math.sin(rx);
  [y, z] = [y * c - z * s, y * s + z * c];
  return [x, y, z];
};

// ── material colours (mirrors src/components/Viewer.tsx) ──────────────────
const hex = (h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const materialColor = (material, shape) => {
  const m = (material || '').toLowerCase();
  if (m.includes('glass') || m.includes('display')) return hex('#46b7ff');
  if (m.includes('carbon')) return hex('#1c2128');
  if (m.includes('brass')) return hex('#d4a657');
  if (m.includes('copper')) return hex('#b87333');
  if (m.includes('fiberglass')) return hex('#e8e8ea');
  if (m.includes('concrete')) return hex('#6e737b');
  if (m.includes('white')) return hex('#f0f0f2');
  if (m.includes('rubber') || m.includes('black')) return hex('#2b2f38');
  if (m.includes('anodized')) return hex('#3a3d44');
  if (m.includes('steel') || m.includes('aluminum') || m.includes('metal') || m.includes('forged'))
    return hex('#9ca3af');
  return shape === 'complex' ? hex('#a855f7') : hex('#8b949e');
};

// ── primitive tessellation ────────────────────────────────────────────────
// Geometry is emitted in local space; emitQuad/emitTri auto-orient winding so
// the face normal points away from `ref` (a point known to be inside).
const emitTri = (tris, a, b, c, ref) => {
  const n = cross(sub(b, a), sub(c, a));
  const centroid = scl(add(add(a, b), c), 1 / 3);
  tris.push(dot(n, sub(centroid, ref)) >= 0 ? [a, b, c] : [a, c, b]);
};
const emitQuad = (tris, a, b, c, d, ref) => {
  emitTri(tris, a, b, c, ref);
  emitTri(tris, a, c, d, ref);
};

const SEG = 26; // radial segments for round primitives

const tessellate = (shape, size) => {
  const tris = [];
  const O = [0, 0, 0];
  const s = size.map((n) => (Number.isFinite(n) && n > 0 ? n : 0.0001));

  if (shape === 'box' || shape === 'complex') {
    const [w = 1, h = 1, d = 1] = s;
    const x = w / 2, y = h / 2, z = d / 2;
    const v = [
      [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
      [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z],
    ];
    const F = [
      [1, 5, 6, 2], [4, 0, 3, 7], [3, 2, 6, 7],
      [4, 5, 1, 0], [5, 4, 7, 6], [0, 1, 2, 3],
    ];
    for (const [a, b, c, d2] of F) emitQuad(tris, v[a], v[b], v[c], v[d2], O);
    return tris;
  }

  if (shape === 'cylinder') {
    // [r,h] uniform, or [rTop,rBot,h] tapered.
    const [a = 0.5, b = 1, c] = s;
    const rT = c !== undefined ? a : a;
    const rB = c !== undefined ? b : a;
    const h = c !== undefined ? c : b;
    const top = [], bot = [];
    for (let i = 0; i < SEG; i++) {
      const ang = (2 * Math.PI * i) / SEG;
      top.push([rT * Math.cos(ang), h / 2, rT * Math.sin(ang)]);
      bot.push([rB * Math.cos(ang), -h / 2, rB * Math.sin(ang)]);
    }
    const cT = [0, h / 2, 0], cB = [0, -h / 2, 0];
    for (let i = 0; i < SEG; i++) {
      const j = (i + 1) % SEG;
      emitQuad(tris, bot[i], top[i], top[j], bot[j], O);
      if (rT > 1e-4) emitTri(tris, cT, top[i], top[j], O);
      if (rB > 1e-4) emitTri(tris, cB, bot[i], bot[j], O);
    }
    return tris;
  }

  if (shape === 'cone') {
    const [r = 0.5, h = 1] = s;
    const apex = [0, h / 2, 0], cB = [0, -h / 2, 0];
    const base = [];
    for (let i = 0; i < SEG; i++) {
      const ang = (2 * Math.PI * i) / SEG;
      base.push([r * Math.cos(ang), -h / 2, r * Math.sin(ang)]);
    }
    for (let i = 0; i < SEG; i++) {
      const j = (i + 1) % SEG;
      emitTri(tris, apex, base[i], base[j], O);
      emitTri(tris, cB, base[i], base[j], O);
    }
    return tris;
  }

  if (shape === 'sphere') {
    const r = s[0] ?? 0.5;
    const LAT = 14, LON = 22;
    const pt = (t, p) => [
      r * Math.sin(t) * Math.cos(p),
      r * Math.cos(t),
      r * Math.sin(t) * Math.sin(p),
    ];
    for (let i = 0; i < LAT; i++) {
      const t0 = (Math.PI * i) / LAT, t1 = (Math.PI * (i + 1)) / LAT;
      for (let k = 0; k < LON; k++) {
        const p0 = (2 * Math.PI * k) / LON, p1 = (2 * Math.PI * (k + 1)) / LON;
        emitQuad(tris, pt(t0, p0), pt(t1, p0), pt(t1, p1), pt(t0, p1), O);
      }
    }
    return tris;
  }

  if (shape === 'torus') {
    const [R = 0.5, tube = 0.15] = s;
    const RAD = 30, TUB = 16;
    const pt = (u, v) => [
      (R + tube * Math.cos(v)) * Math.cos(u),
      (R + tube * Math.cos(v)) * Math.sin(u),
      tube * Math.sin(v),
    ];
    for (let i = 0; i < RAD; i++) {
      const u0 = (2 * Math.PI * i) / RAD, u1 = (2 * Math.PI * (i + 1)) / RAD;
      const um = (u0 + u1) / 2;
      const ringC = [R * Math.cos(um), R * Math.sin(um), 0];
      for (let k = 0; k < TUB; k++) {
        const v0 = (2 * Math.PI * k) / TUB, v1 = (2 * Math.PI * (k + 1)) / TUB;
        emitQuad(tris, pt(u0, v0), pt(u1, v0), pt(u1, v1), pt(u0, v1), ringC);
      }
    }
    return tris;
  }

  if (shape === 'capsule') {
    const [r = 0.3, len = 1] = s;
    const half = len / 2;
    const top = [], bot = [];
    for (let i = 0; i < SEG; i++) {
      const ang = (2 * Math.PI * i) / SEG;
      top.push([r * Math.cos(ang), half, r * Math.sin(ang)]);
      bot.push([r * Math.cos(ang), -half, r * Math.sin(ang)]);
    }
    for (let i = 0; i < SEG; i++) {
      const j = (i + 1) % SEG;
      emitQuad(tris, bot[i], top[i], top[j], bot[j], O);
    }
    // hemispheres
    const RINGS = 6;
    for (const sign of [1, -1]) {
      const cap = [0, sign * half, 0];
      const pt = (t, p) => [
        r * Math.sin(t) * Math.cos(p),
        sign * half + sign * r * Math.cos(t),
        r * Math.sin(t) * Math.sin(p),
      ];
      for (let i = 0; i < RINGS; i++) {
        const t0 = (Math.PI / 2) * (i / RINGS), t1 = (Math.PI / 2) * ((i + 1) / RINGS);
        for (let k = 0; k < SEG; k++) {
          const p0 = (2 * Math.PI * k) / SEG, p1 = (2 * Math.PI * (k + 1)) / SEG;
          emitQuad(tris, pt(t0, p0), pt(t1, p0), pt(t1, p1), pt(t0, p1), cap);
        }
      }
    }
    return tris;
  }

  return tris;
};

// ── build the world-space triangle soup ──────────────────────────────────
const LIGHT = norm([-0.45, 1, 0.55]);
const AMBIENT = 0.34, DIFFUSE = 0.66;

const buildScene = (scene) => {
  const soup = [];
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const part of scene.parts || []) {
    if (!part || !Array.isArray(part.size) || !Array.isArray(part.position)) continue;
    const rgb = materialColor(part.material, part.shape);
    const local = tessellate(part.shape, part.size);
    for (const [a, b, c] of local) {
      const wa = add(rotate(a, part.rotation), part.position);
      const wb = add(rotate(b, part.rotation), part.position);
      const wc = add(rotate(c, part.rotation), part.position);
      const n = norm(cross(sub(wb, wa), sub(wc, wa)));
      const lambert = AMBIENT + DIFFUSE * Math.max(0, dot(n, LIGHT));
      const color = rgb.map((ch) => Math.min(255, ch * lambert));
      soup.push({ a: wa, b: wb, c: wc, n, color });
      for (const v of [wa, wb, wc]) {
        for (let i = 0; i < 3; i++) {
          if (v[i] < lo[i]) lo[i] = v[i];
          if (v[i] > hi[i]) hi[i] = v[i];
        }
      }
    }
  }
  if (!Number.isFinite(lo[0])) { lo = [-1, -1, -1]; hi = [1, 1, 1]; }
  const center = scl(add(lo, hi), 0.5);
  return { soup, center, lo, hi };
};

// ── camera bases (right, up, fwd) — fwd points toward the camera ──────────
const VIEWS = {
  ISO: cameraBasis(norm([1, 0.82, 1]), [0, 1, 0]),
  FRONT: cameraBasis([0, 0, 1], [0, 1, 0]),
  SIDE: cameraBasis([1, 0, 0], [0, 1, 0]),
  TOP: cameraBasis([0, 1, 0], [0, 0, -1]),
};
function cameraBasis(fwd, worldUp) {
  const right = norm(cross(worldUp, fwd));
  const up = norm(cross(fwd, right));
  return { right, up, fwd };
}

// ── framebuffer ───────────────────────────────────────────────────────────
const BG = [13, 17, 23];

const makeBuffer = (w, h, bg) => {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = bg[0]; buf[i * 4 + 1] = bg[1];
    buf[i * 4 + 2] = bg[2]; buf[i * 4 + 3] = 255;
  }
  return buf;
};

// rasterize one triangle (screen coords) into buf, opaque overwrite
const fillTri = (buf, w, h, p0, p1, p2, color) => {
  const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
  if (Math.abs(area) < 1e-6) return;
  const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
  const maxX = Math.min(w - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
  const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
  const edge = (a, b, px, py) =>
    (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
  const sign = area > 0 ? 1 : -1;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      if (
        edge(p0, p1, px, py) * sign >= 0 &&
        edge(p1, p2, px, py) * sign >= 0 &&
        edge(p2, p0, px, py) * sign >= 0
      ) {
        const o = (y * w + x) * 4;
        buf[o] = color[0]; buf[o + 1] = color[1]; buf[o + 2] = color[2];
      }
    }
  }
};

const blit = (dst, dw, src, sw, sh, ox, oy) => {
  for (let y = 0; y < sh; y++) {
    src.copy(dst, ((oy + y) * dw + ox) * 4, (y * sw) * 4, (y * sw + sw) * 4);
  }
};

// ── 5x7 bitmap font (only the glyphs the panel labels need) ───────────────
const FONT = {
  I: [14, 4, 4, 4, 4, 4, 14], S: [15, 16, 16, 14, 1, 1, 30],
  O: [14, 17, 17, 17, 17, 17, 14], F: [31, 16, 16, 30, 16, 16, 16],
  R: [30, 17, 17, 30, 20, 18, 17], N: [17, 25, 25, 21, 19, 19, 17],
  T: [31, 4, 4, 4, 4, 4, 4], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], P: [31, 17, 17, 31, 16, 16, 16],
  ' ': [0, 0, 0, 0, 0, 0, 0],
};
const drawText = (buf, w, h, text, x, y, scale, color) => {
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const g = FONT[ch] || FONT[' '];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if ((g[row] >> (4 - col)) & 1) {
          for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
              const px = cx + col * scale + dx, py = y + row * scale + dy;
              if (px >= 0 && px < w && py >= 0 && py < h) {
                const o = (py * w + px) * 4;
                buf[o] = color[0]; buf[o + 1] = color[1]; buf[o + 2] = color[2];
              }
            }
          }
        }
      }
    }
    cx += 6 * scale;
  }
};

// ── render one panel ──────────────────────────────────────────────────────
const renderPanel = (world, view, label, px) => {
  const buf = makeBuffer(px, px, [20, 24, 31]);
  const margin = Math.round(px * 0.07);
  const { right, up, fwd } = view;
  const c = world.center;

  // project + cull back faces
  const faces = [];
  for (const t of world.soup) {
    if (dot(t.n, fwd) <= 0) continue; // back face
    const proj = (v) => {
      const d = sub(v, c);
      return [dot(d, right), dot(d, up), dot(d, fwd)];
    };
    const a = proj(t.a), b = proj(t.b), d = proj(t.c);
    faces.push({ a, b, d, depth: (a[2] + b[2] + d[2]) / 3, color: t.color });
  }
  if (!faces.length) {
    drawText(buf, px, px, label, margin, margin, Math.max(2, Math.round(px / 200)), [110, 118, 128]);
    return buf;
  }

  // fit projected bounds to the panel
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const f of faces) {
    for (const v of [f.a, f.b, f.d]) {
      if (v[0] < minX) minX = v[0];
      if (v[0] > maxX) maxX = v[0];
      if (v[1] < minY) minY = v[1];
      if (v[1] > maxY) maxY = v[1];
    }
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-3);
  const scale = (px - 2 * margin) / span;
  const offX = margin + (px - 2 * margin - (maxX - minX) * scale) / 2;
  const offY = margin + (px - 2 * margin - (maxY - minY) * scale) / 2;
  const toScreen = (v) => [
    offX + (v[0] - minX) * scale,
    px - (offY + (v[1] - minY) * scale), // flip Y for image space
  ];

  // ground line at world y=0 for the elevation views
  if (label === 'FRONT' || label === 'SIDE') {
    const gy = px - (offY + (0 - c[1] - minY) * scale);
    if (gy >= 0 && gy < px) {
      for (let x = 0; x < px; x++) {
        const o = (Math.round(gy) * px + x) * 4;
        buf[o] = 48; buf[o + 1] = 54; buf[o + 2] = 61;
      }
    }
  }

  // painter's algorithm: far faces first
  faces.sort((u, v) => u.depth - v.depth);
  for (const f of faces) {
    fillTri(buf, px, px, toScreen(f.a), toScreen(f.b), toScreen(f.d), f.color);
  }
  drawText(buf, px, px, label, margin, margin, Math.max(2, Math.round(px / 200)), [165, 173, 183]);
  return buf;
};

// ── PNG encoder (built-in zlib, no deps) ──────────────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const encodePNG = (w, h, rgba) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

// ── main ──────────────────────────────────────────────────────────────────
const [scenePath, outPath, panelArg] = process.argv.slice(2);
if (!scenePath || !outPath) {
  console.error('usage: node scripts/render-scene.mjs <scene.json> <out.png> [panelPx]');
  process.exit(1);
}
const panel = Math.max(200, Number(panelArg) || 540);
const gap = Math.round(panel * 0.03);

let scene;
try {
  scene = JSON.parse(readFileSync(scenePath, 'utf8'));
} catch (e) {
  console.error(`render-scene: cannot read scene: ${e.message}`);
  process.exit(1);
}

const world = buildScene(scene);
const sheetW = panel * 2 + gap * 3;
const sheetH = panel * 2 + gap * 3;
const sheet = makeBuffer(sheetW, sheetH, BG);

const layout = [
  ['ISO', VIEWS.ISO, gap, gap],
  ['FRONT', VIEWS.FRONT, gap * 2 + panel, gap],
  ['SIDE', VIEWS.SIDE, gap, gap * 2 + panel],
  ['TOP', VIEWS.TOP, gap * 2 + panel, gap * 2 + panel],
];
for (const [label, view, ox, oy] of layout) {
  const p = renderPanel(world, view, label, panel);
  blit(sheet, sheetW, p, panel, panel, ox, oy);
}

writeFileSync(outPath, encodePNG(sheetW, sheetH, sheet));
console.log(
  `render-scene: ${scene.parts ? scene.parts.length : 0} parts, ` +
    `${world.soup.length} triangles -> ${outPath} (${sheetW}x${sheetH})`,
);
