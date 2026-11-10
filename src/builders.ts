import * as THREE from 'three';
import { HeightField } from './terrain';
import { AreaFeature, LineFeature, OsmData } from './osm';
import { Polygon, Pt, Ring, densify, parseMeters, pointInPolygon, rng, ringBounds, signedArea } from './util';

/** Sammelt Dreiecke mit Normalen und Farben zu einer einzigen Geometrie (ein Draw-Call). */
class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, color: THREE.Color, n?: THREE.Vector3) {
    const geo = new THREE.Vector3().subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b)).normalize();
    const nn = n ?? geo;
    // Umlaufsinn an die gewünschte Normale anpassen: sonst gilt die Fläche als Rückseite
    // und three.js dreht die Normale bei DoubleSide um (Fläche wirkt dunkel).
    const verts = n && geo.dot(n) < 0 ? [a, c, b] : [a, b, c];
    for (const v of verts) {
      this.pos.push(v.x, v.y, v.z);
      this.nor.push(nn.x, nn.y, nn.z);
      this.col.push(color.r, color.g, color.b);
    }
  }
  /** Viereck a-b-c-d (gegen den Uhrzeigersinn von außen gesehen). */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, color: THREE.Color) {
    this.tri(a, b, c, color);
    this.tri(a, c, d, color);
  }
  get empty() {
    return this.pos.length === 0;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** OSM-Farbangabe (#rgb, #rrggbb oder CSS-Farbname) lesen; sonst fallback. */
export function cssColor(v: string | undefined, fallback: THREE.Color): THREE.Color {
  if (!v) return fallback;
  const t = v.trim().toLowerCase().replace(/[\s_-]/g, '');
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(t)) return new THREE.Color().setStyle(t);
  const names = THREE.Color.NAMES as Record<string, number>;
  if (t in names) return new THREE.Color(names[t]);
  return fallback;
}

// ---------------------------------------------------------------- Gebäude

const WALL_COLORS = ['#e8e0d0', '#d9cdb8', '#f0ece4', '#c9b79c', '#b5654a', '#d6c4a8', '#e3d5c0'];
const ROOF_SLOPED = ['#8a3b2a', '#6e3326', '#4a4a4f', '#7a4a32', '#9a5440'];
const ROOF_FLAT = ['#7d7d7d', '#6b6b6b', '#8c8a85'];

export function estimateHeight(tags: Record<string, string>): { height: number; minHeight: number; roofHeight: number } {
  const levels = parseFloat(tags['building:levels'] ?? '');
  const roofLevels = parseFloat(tags['roof:levels'] ?? '');
  const shape = tags['roof:shape'];
  const sloped = shape === 'gabled' || shape === 'hipped' || shape === 'pyramidal';
  let roofHeight = parseMeters(tags['roof:height']) ?? (Number.isFinite(roofLevels) ? roofLevels * 2.8 : sloped ? 3 : 0);
  let height = parseMeters(tags.height);
  if (height === undefined) {
    if (Number.isFinite(levels)) height = levels * 3 + roofHeight;
    else {
      const b = tags.building ?? tags['building:part'] ?? 'yes';
      const def: Record<string, number> = {
        garage: 2.8, garages: 2.8, shed: 2.5, carport: 2.6, hut: 2.8, cabin: 3, roof: 4, kiosk: 3,
        house: 7, detached: 7, semidetached_house: 7, terrace: 8, bungalow: 4, farm: 7, barn: 8,
        residential: 9, apartments: 13, office: 14, commercial: 10, retail: 7, industrial: 8, warehouse: 9,
        school: 11, church: 16, chapel: 8, hospital: 16, train_station: 10, greenhouse: 3.5,
      };
      height = (def[b] ?? 6) + (sloped && def[b] === undefined ? roofHeight : 0);
    }
  }
  roofHeight = Math.min(roofHeight, height * 0.6);
  const minLevel = parseFloat(tags['building:min_level'] ?? '');
  const minHeight = parseMeters(tags.min_height) ?? (Number.isFinite(minLevel) ? minLevel * 3 : 0);
  return { height, minHeight, roofHeight };
}

function ccw(r: Ring): Ring {
  // Im x/z-System (z nach Süden) entspricht positive signedArea von oben gesehen dem Uhrzeigersinn.
  return signedArea(r) > 0 ? r.slice().reverse() : r;
}

export function buildBuildings(list: AreaFeature[], hf: HeightField, radius: number, seed: number) {
  const walls = new MeshBuilder();
  const roofs = new MeshBuilder();
  const rand = rng(seed ^ 0xb11d);
  const footprints: Polygon[] = [];
  const up = V(0, 1, 0);
  // Gebäude, die "building:part"-Teile haben, nicht doppelt zeichnen: Teile stehen im OSM-Datensatz zusätzlich.
  for (const f of list) {
    const { outer } = f.poly;
    const bb = ringBounds(outer);
    const cx = (bb.minX + bb.maxX) / 2, cz = (bb.minZ + bb.maxZ) / 2;
    if (cx * cx + cz * cz > radius * radius) continue;
    if (f.tags.location === 'underground' || f.tags.layer?.startsWith('-')) continue;
    const outerR = ccw(outer);
    const holes = f.poly.holes.map((h) => (signedArea(h) > 0 ? h : h.slice().reverse()));
    let gMin = Infinity, gMax = -Infinity;
    for (const [x, z] of outerR) {
      const h = hf.height(x, z);
      gMin = Math.min(gMin, h);
      gMax = Math.max(gMax, h);
    }
    const { height, minHeight, roofHeight } = estimateHeight(f.tags);
    const isRoofOnly = f.tags.building === 'roof';
    const base = isRoofOnly ? gMin + Math.max(minHeight, height - 0.5) : gMin + minHeight - (minHeight > 0 ? 0 : 1.0);
    const eave = Math.max(gMin + height - roofHeight, gMax + 2.2);
    const wallCol = cssColor(f.tags['building:colour'], new THREE.Color(WALL_COLORS[Math.floor(rand() * WALL_COLORS.length)]));
    const shape = f.tags['roof:shape'];
    const sloped = roofHeight > 0 && (shape === 'gabled' || shape === 'hipped' || shape === 'pyramidal');
    const roofCol = cssColor(
      f.tags['roof:colour'],
      new THREE.Color((sloped ? ROOF_SLOPED : ROOF_FLAT)[Math.floor(rand() * (sloped ? ROOF_SLOPED.length : ROOF_FLAT.length))]),
    );
    if (!isRoofOnly && f.tags.building !== 'carport') footprints.push({ outer: outerR, holes });

    const wallRing = (ring: Ring, top: number) => {
      for (let i = 0; i < ring.length; i++) {
        const [x0, z0] = ring[i];
        const [x1, z1] = ring[(i + 1) % ring.length];
        walls.quad(V(x0, base, z0), V(x1, base, z1), V(x1, top, z1), V(x0, top, z0), wallCol);
      }
    };
    if (isRoofOnly) {
      // Dach ohne Wände (Tankstellen, Unterstände): dünne Platte
      flatRoof(roofs, outerR, holes, eave + 0.3, roofCol, up);
      flatRoof(roofs, outerR.slice().reverse(), [], base, roofCol, V(0, -1, 0));
      continue;
    }
    wallRing(outerR, eave);
    for (const h of holes) wallRing(h, eave);

    if (sloped && outerR.length === 4 && holes.length === 0 && shape !== 'pyramidal') {
      gableRoof(walls, roofs, outerR, eave, roofHeight, shape === 'hipped', wallCol, roofCol);
    } else if (sloped && holes.length === 0 && shape === 'pyramidal') {
      const top = V(cx, eave + roofHeight, cz);
      for (let i = 0; i < outerR.length; i++) {
        const [x0, z0] = outerR[i], [x1, z1] = outerR[(i + 1) % outerR.length];
        roofs.tri(V(x0, eave, z0), V(x1, eave, z1), top, roofCol);
      }
    } else {
      flatRoof(roofs, outerR, holes, eave, roofCol, up);
    }
  }
  return { walls: walls.empty ? null : walls.build(), roofs: roofs.empty ? null : roofs.build(), footprints };
}

function flatRoof(mb: MeshBuilder, outer: Ring, holes: Ring[], y: number, color: THREE.Color, n: THREE.Vector3) {
  const contour = outer.map(([x, z]) => new THREE.Vector2(x, z));
  const hs = holes.map((h) => h.map(([x, z]) => new THREE.Vector2(x, z)));
  const all = contour.concat(...hs);
  const tris = THREE.ShapeUtils.triangulateShape(contour, hs);
  for (const [a, b, c] of tris) {
    const pa = all[a], pb = all[b], pc = all[c];
    // Orientierung so wählen, dass die Fläche zur Normalen n zeigt
    const va = V(pa.x, y, pa.y), vb = V(pb.x, y, pb.y), vc = V(pc.x, y, pc.y);
    const geomN = new THREE.Vector3().subVectors(vc, vb).cross(new THREE.Vector3().subVectors(va, vb));
    if (geomN.dot(n) >= 0) mb.tri(va, vb, vc, color, n);
    else mb.tri(va, vc, vb, color, n);
  }
}

function gableRoof(
  walls: MeshBuilder, roofs: MeshBuilder, r: Ring, eave: number, rh: number, hipped: boolean,
  wallCol: THREE.Color, roofCol: THREE.Color,
) {
  // Längere Seite = Traufseite; First parallel dazu.
  const len = (i: number) => Math.hypot(r[(i + 1) % 4][0] - r[i][0], r[(i + 1) % 4][1] - r[i][1]);
  const s = len(0) + len(2) >= len(1) + len(3) ? 0 : 1;
  const A = r[s], B = r[(s + 1) % 4], C = r[(s + 2) % 4], D = r[(s + 3) % 4];
  const mid = (p: Pt, q: Pt): Pt => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  let r1 = mid(D, A), r2 = mid(B, C); // Firstendpunkte über den Giebelseiten
  if (hipped) {
    const short = (len((s + 1) % 4) + len((s + 3) % 4)) / 4; // halbe Gebäudebreite
    const dx = r2[0] - r1[0], dz = r2[1] - r1[1];
    const L = Math.hypot(dx, dz);
    const k = Math.min(short / L, 0.45);
    r1 = [r1[0] + dx * k, r1[1] + dz * k];
    r2 = [r2[0] - dx * k, r2[1] - dz * k];
  }
  const yt = eave + rh;
  const P = (p: Pt, y: number) => V(p[0], y, p[1]);
  roofs.quad(P(A, eave), P(B, eave), P(r2, yt), P(r1, yt), roofCol);
  roofs.quad(P(C, eave), P(D, eave), P(r1, yt), P(r2, yt), roofCol);
  if (hipped) {
    roofs.tri(P(B, eave), P(C, eave), P(r2, yt), roofCol);
    roofs.tri(P(D, eave), P(A, eave), P(r1, yt), roofCol);
  } else {
    walls.tri(P(B, eave), P(C, eave), P(r2, yt), wallCol);
    walls.tri(P(D, eave), P(A, eave), P(r1, yt), wallCol);
  }
}

// ---------------------------------------------------------------- Linien (Wege, Gewässer, Bahn)

interface LineStyle { width: number; color: string; lift: number }

export function roadStyle(t: Record<string, string>): LineStyle | null {
  if (t.tunnel && t.tunnel !== 'no') return null;
  if (t.highway) {
    const hw = t.highway;
    if (hw === 'proposed' || hw === 'abandoned' || hw === 'razed' || hw === 'elevator') return null;
    const widths: Record<string, number> = {
      motorway: 11, trunk: 9, primary: 7.5, secondary: 7, tertiary: 6, unclassified: 5, residential: 5,
      living_street: 4.5, service: 3.5, motorway_link: 5, trunk_link: 5, primary_link: 5, secondary_link: 5,
      tertiary_link: 4.5, pedestrian: 5, track: 2.8, footway: 1.8, path: 1.2, cycleway: 2, bridleway: 2,
      steps: 1.8, construction: 5, platform: 3, corridor: 2, raceway: 8, busway: 6,
    };
    const unpaved = /^(unpaved|gravel|fine_gravel|dirt|earth|ground|grass|mud|sand|compacted|wood|woodchips|pebblestone)$/.test(t.surface ?? '');
    const natural = hw === 'track' || hw === 'path' || hw === 'bridleway';
    const paved = /^(asphalt|paved|concrete|paving_stones|sett|cobblestone|concrete:plates)$/.test(t.surface ?? '');
    const color = unpaved || (natural && !paved) ? (t.surface === 'grass' ? '#6f8f45' : '#a08a66') : hw === 'footway' || hw === 'pedestrian' || hw === 'steps' ? '#9b968c' : '#55575a';
    const lift = hw === 'footway' || hw === 'path' || hw === 'cycleway' || hw === 'steps' ? 0.14 : natural ? 0.12 : 0.1;
    return { width: parseMeters(t.width) ?? widths[hw] ?? 3, color, lift };
  }
  if (t.railway) return { width: 3.2, color: '#6d635a', lift: 0.16 };
  if (t.waterway) {
    const w: Record<string, number> = { river: 12, canal: 10, stream: 2, ditch: 1.2, drain: 1.2 };
    return { width: parseMeters(t.width) ?? w[t.waterway] ?? 2, color: '#3c6f9c', lift: 0.08 };
  }
  return null;
}

/** Band entlang einer Linie, an das Gelände angeschmiegt. */
function ribbon(mb: MeshBuilder, line: Pt[], hf: HeightField, width: number, lift: number, color: THREE.Color, radius: number) {
  const pts = densify(line, Math.max(1.5, hf.step * 0.75));
  const half = width / 2;
  const left: THREE.Vector3[] = [], right: THREE.Vector3[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    dx /= L; dz /= L;
    const nx = -dz * half, nz = dx * half;
    const lx = p[0] + nx, lz = p[1] + nz, rx = p[0] - nx, rz = p[1] - nz;
    left.push(V(lx, hf.height(lx, lz) + lift, lz));
    right.push(V(rx, hf.height(rx, rz) + lift, rz));
  }
  const up = V(0, 1, 0);
  const r2 = (radius + 2) ** 2;
  for (let i = 0; i < pts.length - 1; i++) {
    const m = pts[i];
    if (m[0] * m[0] + m[1] * m[1] > r2) continue;
    const a = left[i], b = left[i + 1], c = right[i + 1], d = right[i];
    // Normale nach oben (genügt für flache Bänder, vermeidet Flackern bei Rückseiten)
    mb.tri(a, d, c, color, up);
    mb.tri(a, c, b, color, up);
  }
}

export function buildLines(lines: LineFeature[], hf: HeightField, radius: number) {
  const mb = new MeshBuilder();
  // Breite zuerst, damit schmale Wege bei gleichem Abstand nicht verdeckt werden (lift regelt den Rest)
  const items = lines
    .map((l) => ({ l, s: roadStyle(l.tags) }))
    .filter((x): x is { l: LineFeature; s: LineStyle } => !!x.s)
    .sort((a, b) => b.s.width - a.s.width);
  const segs: RoadSeg[] = [];
  for (const { l, s } of items) {
    ribbon(mb, l.line, hf, s.width, s.lift, new THREE.Color(s.color), radius);
    if (l.tags.highway || l.tags.railway || l.tags.waterway)
      for (let i = 0; i < l.line.length - 1; i++) segs.push({ a: l.line[i], b: l.line[i + 1], half: s.width / 2 });
  }
  return { geometry: mb.empty ? null : mb.build(), segments: segs };
}

// ---------------------------------------------------------------- Barrieren (Hecke, Mauer, Zaun)

export function buildBarriers(lines: LineFeature[], hf: HeightField, radius: number) {
  const mb = new MeshBuilder();
  const styles: Record<string, { h: number; w: number; c: string }> = {
    hedge: { h: 1.6, w: 0.9, c: '#3d5e2c' },
    wall: { h: 1.8, w: 0.3, c: '#a8a39a' },
    city_wall: { h: 6, w: 1.5, c: '#9a8f80' },
    retaining_wall: { h: 1.2, w: 0.4, c: '#8f8a80' },
    fence: { h: 1.2, w: 0.06, c: '#7a6a55' },
  };
  const r2 = radius * radius;
  for (const l of lines) {
    const st = styles[l.tags.barrier ?? ''];
    if (!st) continue;
    const h = parseMeters(l.tags.height) ?? st.h;
    const col = new THREE.Color(st.c);
    const pts = densify(l.line, 3);
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
      if (x0 * x0 + z0 * z0 > r2) continue;
      let dx = x1 - x0, dz = z1 - z0;
      const L = Math.hypot(dx, dz) || 1;
      dx /= L; dz /= L;
      const nx = -dz * st.w / 2, nz = dx * st.w / 2;
      const g0 = hf.height(x0, z0), g1 = hf.height(x1, z1);
      const a = V(x0 + nx, g0 - 0.3, z0 + nz), b = V(x1 + nx, g1 - 0.3, z1 + nz);
      const c = V(x1 - nx, g1 - 0.3, z1 - nz), d = V(x0 - nx, g0 - 0.3, z0 - nz);
      const at = V(a.x, g0 + h, a.z), bt = V(b.x, g1 + h, b.z), ct = V(c.x, g1 + h, c.z), dt = V(d.x, g0 + h, d.z);
      mb.quad(a, b, bt, at, col);
      mb.quad(c, d, dt, ct, col);
      mb.quad(at, bt, ct, dt, col);
      mb.quad(b, c, ct, bt, col);
      mb.quad(d, a, at, dt, col);
    }
  }
  return mb.empty ? null : mb.build();
}

// ---------------------------------------------------------------- Flächen: Wasser + Bodenbemalung

export function isWater(t: Record<string, string>): boolean {
  return t.natural === 'water' || t.waterway === 'riverbank' || t.landuse === 'reservoir' || t.landuse === 'basin';
}

/** Gelände unter Wasserflächen absenken, damit Seen eben sind. Gibt die Wasserspiegel zurück. */
export function carveWater(areas: AreaFeature[], hf: HeightField): { f: AreaFeature; level: number }[] {
  const out: { f: AreaFeature; level: number }[] = [];
  for (const f of areas) {
    if (!isWater(f.tags)) continue;
    const hs = f.poly.outer.map(([x, z]) => hf.height(x, z)).sort((a, b) => a - b);
    if (!hs.length) continue;
    const level = hs[Math.floor(hs.length * 0.1)];
    const bb = ringBounds(f.poly.outer);
    const i0 = Math.max(0, Math.floor((bb.minX + hf.half) / hf.step)), i1 = Math.min(hf.n - 1, Math.ceil((bb.maxX + hf.half) / hf.step));
    const j0 = Math.max(0, Math.floor((bb.minZ + hf.half) / hf.step)), j1 = Math.min(hf.n - 1, Math.ceil((bb.maxZ + hf.half) / hf.step));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const x = -hf.half + i * hf.step, z = -hf.half + j * hf.step;
        if (pointInPolygon(x, z, f.poly)) hf.h[j * hf.n + i] = Math.min(hf.h[j * hf.n + i], level - 0.6);
      }
    out.push({ f, level });
  }
  return out;
}

export function buildWater(waters: { f: AreaFeature; level: number }[]) {
  const mb = new MeshBuilder();
  const col = new THREE.Color('#3f74a3');
  for (const { f, level } of waters) flatRoof(mb, ccw(f.poly.outer), f.poly.holes, level, col, V(0, 1, 0));
  return mb.empty ? null : mb.build();
}

export function groundColor(t: Record<string, string>): string | null {
  if (isWater(t)) return '#3a6ea5';
  if (t.landuse === 'forest' || t.natural === 'wood') return '#35552c';
  if (t.natural === 'scrub' || t.natural === 'heath') return '#5f7440';
  if (t.natural === 'wetland') return '#5d7a5a';
  if (t.natural === 'sand' || t.natural === 'beach') return '#d8c890';
  if (t.natural === 'bare_rock' || t.natural === 'scree') return '#8f8a82';
  if (t.landuse === 'farmland') return '#a99a62';
  if (t.landuse === 'vineyard' || t.landuse === 'orchard') return '#7c8a4a';
  if (/^(grass|meadow|village_green|recreation_ground|cemetery|allotments)$/.test(t.landuse ?? '') || t.natural === 'grassland') return '#6c9a48';
  if (t.leisure === 'park' || t.leisure === 'garden' || t.leisure === 'playground') return '#6fa04c';
  if (t.leisure === 'pitch') return '#5f9a45';
  if (t.amenity === 'parking' || t.highway) return '#77787a';
  if (/^(residential|commercial|retail)$/.test(t.landuse ?? '')) return '#8e917f';
  if (t.landuse === 'industrial') return '#8a8580';
  return null;
}

/** Grundbemalung der Bodentextur aus OSM-Flächen (Untergrund, falls Kartenkacheln fehlen). */
export function paintGround(ctx: CanvasRenderingContext2D, size: number, half: number, areas: AreaFeature[]) {
  ctx.fillStyle = '#7a8f55';
  ctx.fillRect(0, 0, size, size);
  const s = size / (2 * half);
  const order = (t: Record<string, string>) => (t.landuse ? 0 : t.leisure ? 1 : 2);
  const sorted = areas.slice().sort((a, b) => order(a.tags) - order(b.tags));
  for (const a of sorted) {
    const c = groundColor(a.tags);
    if (!c) continue;
    ctx.fillStyle = c;
    ctx.beginPath();
    for (const r of [a.poly.outer, ...a.poly.holes]) {
      r.forEach(([x, z], i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, (x + half) * s, (z + half) * s));
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
}

// ---------------------------------------------------------------- Bäume

interface RoadSeg { a: Pt; b: Pt; half: number }

class SegGrid {
  cell = 12;
  map = new Map<string, RoadSeg[]>();
  add(s: RoadSeg) {
    const x0 = Math.floor((Math.min(s.a[0], s.b[0]) - s.half) / this.cell), x1 = Math.floor((Math.max(s.a[0], s.b[0]) + s.half) / this.cell);
    const z0 = Math.floor((Math.min(s.a[1], s.b[1]) - s.half) / this.cell), z1 = Math.floor((Math.max(s.a[1], s.b[1]) + s.half) / this.cell);
    if ((x1 - x0) * (z1 - z0) > 400) return;
    for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
      const k = i + ',' + j;
      let l = this.map.get(k);
      if (!l) this.map.set(k, (l = []));
      l.push(s);
    }
  }
  near(x: number, z: number, margin: number): boolean {
    const l = this.map.get(Math.floor(x / this.cell) + ',' + Math.floor(z / this.cell));
    if (!l) return false;
    for (const s of l) {
      const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
      const L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - s.a[0]) * dx + (z - s.a[1]) * dz) / L2));
      const px = s.a[0] + t * dx - x, pz = s.a[1] + t * dz - z;
      if (px * px + pz * pz < (s.half + margin) ** 2) return true;
    }
    return false;
  }
}

export interface TreeInstance { x: number; z: number; h: number; conifer: boolean; bush?: boolean }

export function placeTrees(osm: OsmData, radius: number, segments: RoadSeg[], footprints: Polygon[], seed: number, maxTrees = 25000): TreeInstance[] {
  const rand = rng(seed ^ 0x7ee5);
  const grid = new SegGrid();
  for (const s of segments) grid.add(s);
  const fpGrid = new Map<string, Polygon[]>();
  for (const p of footprints) {
    const b = ringBounds(p.outer);
    for (let i = Math.floor(b.minX / 20); i <= Math.floor(b.maxX / 20); i++)
      for (let j = Math.floor(b.minZ / 20); j <= Math.floor(b.maxZ / 20); j++) {
        const k = i + ',' + j;
        (fpGrid.get(k) ?? fpGrid.set(k, []).get(k)!).push(p);
      }
  }
  const inBuilding = (x: number, z: number) => (fpGrid.get(Math.floor(x / 20) + ',' + Math.floor(z / 20)) ?? []).some((p) => pointInPolygon(x, z, p));
  const r2 = radius * radius;
  const ok = (x: number, z: number) => x * x + z * z <= r2 && !grid.near(x, z, 0.8) && !inBuilding(x, z);
  const trees: TreeInstance[] = [];
  const kind = (t: Record<string, string>) =>
    t.leaf_type === 'needleleaved' ? true : t.leaf_type === 'broadleaved' ? false : rand() < 0.5; // Annahme: ohne Angabe Mischwald

  // Flächen: Wald (dicht), Obstwiese (Raster), Gebüsch (Büsche)
  type Job = { f: AreaFeature; spacing: number; bush: boolean; orchard: boolean };
  const jobs: Job[] = [];
  for (const f of osm.areas) {
    const t = f.tags;
    if (t.landuse === 'forest' || t.natural === 'wood') jobs.push({ f, spacing: 5.5, bush: false, orchard: false });
    else if (t.landuse === 'orchard') jobs.push({ f, spacing: 8, bush: false, orchard: true });
    else if (t.natural === 'scrub') jobs.push({ f, spacing: 4, bush: true, orchard: false });
  }
  // Erwartete Anzahl abschätzen und Dichte notfalls senken
  let expected = 0;
  for (const j of jobs) {
    const b = ringBounds(j.f.poly.outer);
    const w = Math.min(b.maxX, radius) - Math.max(b.minX, -radius), h = Math.min(b.maxZ, radius) - Math.max(b.minZ, -radius);
    if (w > 0 && h > 0) expected += Math.min(w * h, Math.abs(signedArea(j.f.poly.outer))) / (j.spacing * j.spacing);
  }
  const budget = maxTrees - osm.points.length;
  const scale = expected > budget ? Math.sqrt(expected / Math.max(budget, 1)) : 1;

  for (const j of jobs) {
    const b = ringBounds(j.f.poly.outer);
    const sp = j.spacing * scale;
    const x0 = Math.max(b.minX, -radius), x1 = Math.min(b.maxX, radius), z0 = Math.max(b.minZ, -radius), z1 = Math.min(b.maxZ, radius);
    for (let z = z0; z < z1; z += sp)
      for (let x = x0; x < x1; x += sp) {
        // Raster mit Zufallsversatz (Wald) bzw. fast regelmäßig (Obstwiese)
        const jit = j.orchard ? 0.1 : 0.9;
        const px = x + (rand() - 0.5) * sp * jit, pz = z + (rand() - 0.5) * sp * jit;
        if (!pointInPolygon(px, pz, j.f.poly) || !ok(px, pz)) continue;
        if (j.bush) trees.push({ x: px, z: pz, h: 1 + rand() * 2.5, conifer: false, bush: true });
        else if (j.orchard) trees.push({ x: px, z: pz, h: 4 + rand() * 3, conifer: false });
        else {
          const conifer = kind(j.f.tags);
          trees.push({ x: px, z: pz, h: conifer ? 15 + rand() * 15 : 12 + rand() * 14, conifer });
        }
      }
  }
  // Baumreihen
  for (const l of osm.lines) {
    if (l.tags.natural !== 'tree_row') continue;
    for (const [x, z] of densify(l.line, 7)) if (ok(x, z)) trees.push({ x, z, h: parseMeters(l.tags.height) ?? 8 + rand() * 8, conifer: l.tags.leaf_type === 'needleleaved' });
  }
  // Einzelbäume (nicht gegen Wege prüfen: OSM-Position gilt)
  for (const p of osm.points) {
    const [x, z] = p.p;
    if (x * x + z * z > r2 || p.tags.natural !== 'tree') continue;
    trees.push({ x, z, h: parseMeters(p.tags.height) ?? 8 + rand() * 7, conifer: p.tags.leaf_type === 'needleleaved' });
  }
  return trees.slice(0, maxTrees);
}

export function buildTrees(trees: TreeInstance[], hf: HeightField, seed: number): THREE.Object3D {
  const group = new THREE.Group();
  const rand = rng(seed ^ 0x51ab);
  const trunkGeo = new THREE.CylinderGeometry(0.12, 0.2, 1, 5).translate(0, 0.5, 0);
  const coneGeo = new THREE.ConeGeometry(0.5, 1, 7).translate(0, 0.5, 0);
  const blobGeo = new THREE.IcosahedronGeometry(0.5, 1).translate(0, 0.5, 0);
  const trunkMat = new THREE.MeshLambertMaterial({ color: '#5a4030' });
  const crownMat = new THREE.MeshLambertMaterial({ color: '#ffffff' }); // Farbe je Instanz
  const conifers = trees.filter((t) => t.conifer);
  const leafy = trees.filter((t) => !t.conifer);
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
  const cones = new THREE.InstancedMesh(coneGeo, crownMat, Math.max(conifers.length, 1));
  const blobs = new THREE.InstancedMesh(blobGeo, crownMat, Math.max(leafy.length, 1));
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const c = new THREE.Color();
  let ti = 0, ci = 0, bi = 0;
  for (const t of trees) {
    const g = hf.height(t.x, t.z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2);
    if (t.bush) {
      p.set(t.x, g - 0.2, t.z);
      s.set(t.h * 1.3, t.h, t.h * 1.3);
      blobs.setMatrixAt(bi, m.compose(p, q, s));
      blobs.setColorAt(bi++, c.setHSL(0.25 + rand() * 0.05, 0.35, 0.22 + rand() * 0.08));
      continue;
    }
    const trunkH = t.conifer ? t.h * 0.25 : t.h * 0.4;
    p.set(t.x, g - 0.1, t.z);
    s.set(t.h / 12, trunkH + 0.2, t.h / 12);
    trunks.setMatrixAt(ti++, m.compose(p, q, s));
    if (t.conifer) {
      p.set(t.x, g + trunkH * 0.6, t.z);
      const w = t.h * (0.32 + rand() * 0.1);
      s.set(w, t.h - trunkH * 0.6, w);
      cones.setMatrixAt(ci, m.compose(p, q, s));
      cones.setColorAt(ci++, c.setHSL(0.33 + rand() * 0.04, 0.4, 0.16 + rand() * 0.06));
    } else {
      const w = t.h * (0.55 + rand() * 0.2);
      p.set(t.x, g + trunkH * 0.75, t.z);
      s.set(w, t.h - trunkH * 0.75, w);
      blobs.setMatrixAt(bi, m.compose(p, q, s));
      blobs.setColorAt(bi++, c.setHSL(0.24 + rand() * 0.06, 0.42, 0.22 + rand() * 0.1));
    }
  }
  trunks.count = ti;
  cones.count = ci;
  blobs.count = bi;
  for (const im of [trunks, cones, blobs]) {
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.computeBoundingSphere();
    im.castShadow = false;
    if (im.count > 0) group.add(im);
  }
  return group;
}
