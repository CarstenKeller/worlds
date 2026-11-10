import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HeightField } from './terrain';
import { AreaFeature, LineFeature } from './osm';
import { MeshBuilder, RoadSeg, roadStyle } from './builders';
import { Polygon, Pt, Ring, densify, pointInPolygon, pointInRing, rng, ringBounds } from './util';
import { addDetail, binTexture, detailTexture, doorTexture, fenceTexture } from './materials';

// ---------------------------------------------------------------- Sonnenstand

/**
 * Sonnenstand (NOAA-Näherung, Genauigkeit ~1°): Azimut ab Norden im Uhrzeigersinn, Höhe über dem Horizont, beides in Grad.
 */
export function sunPosition(date: Date, lat: number, lon: number): { azimuth: number; elevation: number } {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;
  const n = jd - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * rad;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const eps = (23.439 - 0.0000004 * n) * rad;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = (gmst * 15 + lon) * rad;
  const ha = lst - ra;
  const phi = lat * rad;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(ha));
  return { azimuth: ((az / rad) + 360) % 360, elevation: el / rad };
}

/** Richtung zur Sonne im lokalen System (x Osten, y oben, z Süden). */
export function sunDirection(azimuthDeg: number, elevationDeg: number): THREE.Vector3 {
  const a = (azimuthDeg * Math.PI) / 180, e = (elevationDeg * Math.PI) / 180;
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
}

/** Einfacher Himmel: Verlauf Horizont -> Zenit, Sonnenscheibe mit Hof. */
export function createSky(radius: number, sunDir: THREE.Vector3, elevation: number) {
  const low = Math.max(0, Math.min(1, elevation / 25)); // 0 = tief, 1 = hoch
  const horizon = new THREE.Color().lerpColors(new THREE.Color('#f2c79a'), new THREE.Color('#d3e3ef'), low);
  const zenith = new THREE.Color().lerpColors(new THREE.Color('#3d5a8a'), new THREE.Color('#5d8fd0'), low);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { sunDir: { value: sunDir.clone() }, horizon: { value: horizon }, zenith: { value: zenith } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 sunDir; uniform vec3 horizon; uniform vec3 zenith; varying vec3 vDir;
      void main(){
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 c = mix(horizon, zenith, pow(h, 0.55));
        float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        c += vec3(1.0, 0.9, 0.7) * (pow(s, 2500.0) * 4.0 + pow(s, 40.0) * 0.35 + pow(s, 6.0) * 0.12);
        if (vDir.y < 0.0) c = horizon * 0.92;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return { mesh, horizon };
}

// ---------------------------------------------------------------- Straßen-Nachbarschaft

class SegIndex {
  cell = 25;
  map = new Map<string, RoadSeg[]>();
  constructor(segs: RoadSeg[]) {
    for (const s of segs) {
      const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / this.cell), x1 = Math.floor(Math.max(s.a[0], s.b[0]) / this.cell);
      const z0 = Math.floor(Math.min(s.a[1], s.b[1]) / this.cell), z1 = Math.floor(Math.max(s.a[1], s.b[1]) / this.cell);
      if ((x1 - x0 + 1) * (z1 - z0 + 1) > 400) continue;
      for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) {
        const k = i + ',' + j;
        (this.map.get(k) ?? this.map.set(k, []).get(k)!).push(s);
      }
    }
  }
  /** Nächster Punkt auf einem Weg (bis ~50 m), der die Bedingung erfüllt. */
  nearest(x: number, z: number, ok: (s: RoadSeg) => boolean): { p: Pt; d: number; s: RoadSeg } | null {
    const ci = Math.floor(x / this.cell), cj = Math.floor(z / this.cell);
    let best: { p: Pt; d: number; s: RoadSeg } | null = null;
    for (let i = ci - 2; i <= ci + 2; i++)
      for (let j = cj - 2; j <= cj + 2; j++)
        for (const s of this.map.get(i + ',' + j) ?? []) {
          if (!ok(s)) continue;
          const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
          const L2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - s.a[0]) * dx + (z - s.a[1]) * dz) / L2));
          const px = s.a[0] + t * dx, pz = s.a[1] + t * dz;
          const d = Math.hypot(px - x, pz - z);
          if (!best || d < best.d) best = { p: [px, pz], d, s };
        }
    return best;
  }
}

const ACCESS = /^(residential|living_street|service|unclassified|tertiary|secondary|primary|pedestrian|footway|path|track|cycleway|steps)$/;

// ---------------------------------------------------------------- Türen und Mülltonnen

export interface Entrance { ring: Ring; area: number; residential: boolean }

export function buildDoorsAndBins(entrances: Entrance[], segs: RoadSeg[], hf: HeightField, radius: number, seed: number, footprints: Polygon[] = []) {
  const yard = new YardBuilder(hf, footprints, seed);
  const rand = rng(seed ^ 0xd00);
  const idx = new SegIndex(segs.filter((s) => s.kind && ACCESS.test(s.kind)));
  const doors: THREE.Matrix4[] = [], doorColors: THREE.Color[] = [];
  const bins: THREE.Matrix4[] = [], binColors: THREE.Color[] = [];
  const binPosts: { x: number; z: number; r: number }[] = [];
  const DOOR = ['#4a3426', '#2f3438', '#f2f0ea', '#6b2f24', '#35503a', '#5a5f66'];
  const BIN = ['#3b3b3b', '#6b4a2b', '#2456a6', '#d9b81c']; // Rest, Bio, Papier, Gelb (übliche Farben in DE)
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  for (const e of entrances) {
    const r = e.ring;
    const bb = ringBounds(r);
    const cx = (bb.minX + bb.maxX) / 2, cz = (bb.minZ + bb.maxZ) / 2;
    if (cx * cx + cz * cz > radius * radius) continue;
    // Wand mit dem kürzesten Weg zur nächsten Straße, deren Außenseite zur Straße zeigt
    let best: { i: number; d: number; road: Pt } | null = null;
    for (let i = 0; i < r.length; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L < 2.5) continue;
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      const near = idx.nearest(mx, mz, () => true);
      if (!near) continue;
      let nx = (b[1] - a[1]) / L, nz = -(b[0] - a[0]) / L;
      // Außennormale robust bestimmen: zeigt sie ins Gebäude, umdrehen
      if (pointInRing(mx + nx * 0.3, mz + nz * 0.3, r)) { nx = -nx; nz = -nz; }
      const toRoad = (near.p[0] - mx) * nx + (near.p[1] - mz) * nz;
      if (toRoad <= 0) continue;
      if (!best || near.d < best.d) best = { i, d: near.d, road: near.p };
    }
    if (!best || best.d > 60) continue;
    const a = r[best.i], b = r[(best.i + 1) % r.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const ux = (b[0] - a[0]) / L, uz = (b[1] - a[1]) / L;
    let nx = uz, nz = -ux;
    if (pointInRing((a[0] + b[0]) / 2 + nx * 0.3, (a[1] + b[1]) / 2 + nz * 0.3, r)) { nx = -nx; nz = -nz; }
    // Tür auf ein Fensterfeld der Fassade setzen (3-m-Raster, Mitte des mittleren Feldes)
    const n = Math.max(1, Math.round(L / 3));
    const t = (Math.floor(n / 2) + 0.5) * (L / n);
    const dx = a[0] + ux * t + nx * 0.06, dz = a[1] + uz * t + nz * 0.06;
    const g = hf.height(dx, dz);
    const yaw = Math.atan2(nx, nz);
    q.setFromAxisAngle(up, yaw);
    doors.push(m.compose(new THREE.Vector3(dx, g, dz), q, new THREE.Vector3(1, 1, 1)).clone());
    doorColors.push(new THREE.Color(DOOR[Math.floor(rand() * DOOR.length)]));
    // Vorgarten (Fantasie): Weg Tür -> Straße, Zaun/Hecke an der Straße, teils Einfahrt
    if (e.residential && e.area < 450) {
      const road = idx.nearest(dx, dz, (sg) => !!sg.kind && /^(residential|living_street|service|unclassified|tertiary|secondary|primary|pedestrian)$/.test(sg.kind));
      if (road && road.d - road.s.half > 2 && road.d < 35) {
        // halbe Hausbreite entlang der Straße
        const sx = road.s.b[0] - road.s.a[0], sz = road.s.b[1] - road.s.a[1], sl = Math.hypot(sx, sz) || 1;
        const tx = sx / sl, tz = sz / sl;
        let lo = Infinity, hi = -Infinity;
        for (const [px, pz] of r) { const pr = (px - dx) * tx + (pz - dz) * tz; lo = Math.min(lo, pr); hi = Math.max(hi, pr); }
        yard.add(dx + nx * 0.85, dz + nz * 0.85, road.p, road.s.half, tx, tz, lo, hi, idx);
      }
    }
    // Mülltonnen: bei ~60 % der Wohnhäuser, 1–3 Stück neben der Tür
    if (e.residential && rand() < 0.6) {
      const count = 1 + Math.floor(rand() * 3);
      const side = rand() < 0.5 ? -1 : 1;
      for (let k = 0; k < count; k++) {
        const off = side * (1.6 + k * 0.75);
        if (t + off < 0.5 || t + off > L - 0.5) continue;
        const bx = a[0] + ux * (t + off) + nx * 0.55, bz = a[1] + uz * (t + off) + nz * 0.55;
        q.setFromAxisAngle(up, yaw + (rand() - 0.5) * 0.3);
        bins.push(m.compose(new THREE.Vector3(bx, hf.height(bx, bz), bz), q, new THREE.Vector3(1, 1, 1)).clone());
        binColors.push(new THREE.Color(BIN[Math.floor(rand() * BIN.length)]));
        binPosts.push({ x: bx, z: bz, r: 0.6 });
      }
    }
  }
  // Tür: Blatt mit Füllungen (Textur), Rahmen und Stufe getrennt, damit die Textur nur auf dem Blatt liegt
  const leaf = new THREE.BoxGeometry(1.0, 2.1, 0.08).translate(0, 1.2, 0.02);
  const doorMesh = new THREE.Group();
  doorMesh.add(instanced(leaf, doors, doorColors, new THREE.MeshLambertMaterial({ map: doorTexture() })));
  const frame = mergeGeometries([
    new THREE.BoxGeometry(0.1, 2.25, 0.12).translate(-0.55, 1.25, 0),
    new THREE.BoxGeometry(0.1, 2.25, 0.12).translate(0.55, 1.25, 0),
    new THREE.BoxGeometry(1.2, 0.1, 0.12).translate(0, 2.32, 0),
  ])!;
  doorMesh.add(instanced(frame, doors, doors.map(() => new THREE.Color('#e8e6e0'))));
  const step = new THREE.BoxGeometry(1.5, 0.15, 0.9).translate(0, 0.075, 0.4);
  doorMesh.add(instanced(step, doors, doors.map(() => new THREE.Color('#9c9790'))));
  // Tonne: leicht konisch (8-eckig), Deckel mit Überstand, Räder
  const bin = mergeGeometries([
    new THREE.CylinderGeometry(0.4, 0.34, 0.95, 8, 1).scale(0.85, 1, 1).rotateY(Math.PI / 8).translate(0, 0.5, 0),
    new THREE.BoxGeometry(0.66, 0.06, 0.8).translate(0, 1.0, 0),
    new THREE.CylinderGeometry(0.1, 0.1, 0.06, 10).rotateZ(Math.PI / 2).translate(-0.3, 0.1, -0.32),
    new THREE.CylinderGeometry(0.1, 0.1, 0.06, 10).rotateZ(Math.PI / 2).translate(0.3, 0.1, -0.32),
  ])!;
  const binMesh = instanced(bin, bins, binColors, new THREE.MeshLambertMaterial({ map: binTexture() }));
  return { doors: doorMesh, bins: binMesh, binPosts: [...binPosts, ...yard.posts], yard: yard.build(), drivewayCars: yard.cars };
}

function instanced(geo: THREE.BufferGeometry, mats: THREE.Matrix4[], cols: THREE.Color[], material?: THREE.Material) {
  const im = new THREE.InstancedMesh(geo, material ?? new THREE.MeshLambertMaterial({ color: '#ffffff' }), Math.max(1, mats.length));
  mats.forEach((mm, i) => { im.setMatrixAt(i, mm); im.setColorAt(i, cols[i] ?? new THREE.Color('#ffffff')); });
  im.count = mats.length;
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.computeBoundingSphere();
  im.castShadow = im.receiveShadow = true;
  return im;
}

// ---------------------------------------------------------------- Autos und Laternen

const CAR_COLORS = ['#e9e9e6', '#e9e9e6', '#1c1c1e', '#1c1c1e', '#6e7175', '#a8abb0', '#a8abb0', '#24406e', '#7a1c1c', '#3d4a3a', '#c9c2b0'];

export function buildCarsAndLamps(
  lines: LineFeature[], areas: AreaFeature[], footprints: Polygon[], hf: HeightField, radius: number, seed: number,
  extraCars: { x: number; z: number; yaw: number }[] = [],
) {
  const rand = rng(seed ^ 0xca5);
  const cars: THREE.Matrix4[] = [], carCols: THREE.Color[] = [];
  const lamps: THREE.Matrix4[] = [];
  const posts: { x: number; z: number; r: number }[] = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const inBuilding = (x: number, z: number) => footprints.some((p) => {
    const b = ringBounds(p.outer);
    return x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ && pointInRing(x, z, p.outer);
  });
  const r2 = (radius - 3) ** 2;
  const place = (x: number, z: number, yaw: number) => {
    if (x * x + z * z > r2 || inBuilding(x, z)) return;
    q.setFromAxisAngle(up, yaw);
    cars.push(m.compose(new THREE.Vector3(x, hf.height(x, z), z), q, new THREE.Vector3(1, 1, 1)).clone());
    carCols.push(new THREE.Color(CAR_COLORS[Math.floor(rand() * CAR_COLORS.length)]));
    // Kollision: zwei Kreise längs des Autos
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    posts.push({ x: x + fx * 1.2, z: z + fz * 1.2, r: 1.25 }, { x: x - fx * 1.2, z: z - fz * 1.2, r: 1.25 });
  };
  for (const l of lines) {
    const hw = l.tags.highway;
    if (!hw) continue;
    const st = roadStyle(l.tags);
    if (!st) continue;
    const parking = /^(residential|living_street|unclassified|tertiary)$/.test(hw);
    const lit = /^(residential|living_street|unclassified|tertiary|secondary|primary)$/.test(hw);
    if (!parking && !lit) continue;
    const pts = densify(l.line, 1);
    let dist = 0, nextCar = 4 + rand() * 6, nextLamp = 8 + rand() * 10, lampSide = 1;
    for (let i = 1; i < pts.length; i++) {
      const [x0, z0] = pts[i - 1], [x1, z1] = pts[i];
      const d = Math.hypot(x1 - x0, z1 - z0);
      dist += d;
      const ux = (x1 - x0) / (d || 1), uz = (z1 - z0) / (d || 1);
      const nx = -uz, nz = ux;
      const yaw = Math.atan2(ux, uz);
      // Abstand zu Wegenden (Kreuzungen) halten
      const farFromEnds = dist > 8 && i < pts.length - 8;
      if (parking && dist >= nextCar && farFromEnds) {
        // Am Fahrbahnrand parken: breite Straßen auf der Fahrbahn, schmale am Rand daneben
        const off = st.width >= 5.5 ? st.width / 2 - 1.1 : st.width / 2 + 1.0;
        for (const side of [-1, 1]) if (rand() < 0.45) place(x1 + nx * off * side, z1 + nz * off * side, yaw + (side < 0 ? Math.PI : 0));
        nextCar = dist + 5.5 + (rand() < 0.4 ? rand() * 12 : 0);
      }
      if (lit && dist >= nextLamp) {
        const off = st.width / 2 + 0.7;
        const lx = x1 + nx * off * lampSide, lz = z1 + nz * off * lampSide;
        if (lx * lx + lz * lz < r2 && !inBuilding(lx, lz)) {
          q.setFromAxisAngle(up, Math.atan2(-nx * lampSide, -nz * lampSide)); // Arm zur Straße
          lamps.push(m.compose(new THREE.Vector3(lx, hf.height(lx, lz), lz), q, new THREE.Vector3(1, 1, 1)).clone());
          posts.push({ x: lx, z: lz, r: 0.35 });
        }
        lampSide = -lampSide;
        nextLamp = dist + 28 + rand() * 8;
      }
    }
  }
  for (const c of extraCars) place(c.x, c.z, c.yaw);
  // Parkplätze (amenity=parking): Raster 2,6 × 5,5 m, etwa zur Hälfte belegt
  for (const a of areas) {
    if (a.tags.amenity !== 'parking' || a.tags.parking === 'underground' || a.tags.parking === 'multi-storey') continue;
    const b = ringBounds(a.poly.outer);
    // Ausrichtung: längste Kante
    let ang = 0, best = 0;
    const r = a.poly.outer;
    for (let i = 0; i < r.length; i++) {
      const p = r[i], q2 = r[(i + 1) % r.length];
      const L = Math.hypot(q2[0] - p[0], q2[1] - p[1]);
      if (L > best) { best = L; ang = Math.atan2(q2[0] - p[0], q2[1] - p[1]); }
    }
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const ext = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2;
    const ux = Math.sin(ang), uz = Math.cos(ang), vx = uz, vz = -ux;
    for (let s = -ext; s <= ext; s += 2.6)
      for (let t = -ext; t <= ext; t += 6) {
        const x = cx + ux * s + vx * t, z = cz + uz * s + vz * t;
        if (!pointInPolygon(x, z, a.poly) || rand() > 0.5) continue;
        place(x, z, ang + Math.PI / 2 + (rand() < 0.5 ? Math.PI : 0));
      }
  }

  // Auto: Seitenprofil extrudiert (abgerundet), Glashaus etwas schmaler, Räder mit Felgen, Lichter.
  const group = new THREE.Group();
  const profile = (pts: [number, number][], width: number, bevel: number) => {
    const sh = new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y)));
    const g = new THREE.ExtrudeGeometry(sh, { depth: width - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 4 });
    g.rotateY(-Math.PI / 2); // Profil-x -> Fahrzeuglänge (z), Extrusion -> Breite (x)
    g.translate((width - 2 * bevel) / 2, 0, 0);
    return g;
  };
  // Kompaktwagen ~4,3 m: Heck links (z < 0), Front rechts (z > 0)
  const body = profile([[-2.1, 0.32], [2.08, 0.32], [2.14, 0.62], [2.0, 0.82], [0.95, 0.92], [-1.55, 0.98], [-2.05, 0.9], [-2.14, 0.58]], 1.78, 0.08);
  const glass = profile([[0.92, 0.9], [0.28, 1.38], [-1.05, 1.42], [-1.62, 0.96]], 1.6, 0.05);
  const wheel = new THREE.CylinderGeometry(0.32, 0.32, 0.22, 16).rotateZ(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(0.19, 0.19, 0.235, 10).rotateZ(Math.PI / 2);
  const W = [[-0.8, 1.32], [0.8, 1.32], [-0.8, -1.3], [0.8, -1.3]];
  const wheels = mergeGeometries(W.map(([x, z]) => wheel.clone().translate(x, 0.32, z)))!;
  const rims = mergeGeometries(W.map(([x, z]) => rim.clone().translate(x, 0.32, z)))!;
  const lightsF = mergeGeometries([-0.6, 0.6].map((x) => new THREE.BoxGeometry(0.36, 0.1, 0.05).translate(x, 0.72, 2.1)))!;
  const lightsR = mergeGeometries([-0.62, 0.62].map((x) => new THREE.BoxGeometry(0.3, 0.12, 0.05).translate(x, 0.74, -2.13)))!;
  const plate = new THREE.BoxGeometry(0.52, 0.12, 0.03);
  const plates = mergeGeometries([plate.clone().translate(0, 0.48, 2.16), plate.clone().translate(0, 0.55, -2.17)])!;
  const paint = new THREE.MeshPhongMaterial({ color: '#ffffff', shininess: 70, specular: new THREE.Color('#666666') });
  group.add(instanced(body, cars, carCols, paint));
  group.add(instanced(glass, cars, cars.map(() => new THREE.Color('#202a33')), new THREE.MeshPhongMaterial({ color: '#ffffff', shininess: 120, specular: new THREE.Color('#aaaaaa') })));
  group.add(instanced(wheels, cars, cars.map(() => new THREE.Color('#141414'))));
  group.add(instanced(rims, cars, cars.map(() => new THREE.Color('#9a9da1'))));
  group.add(instanced(lightsF, cars, cars.map(() => new THREE.Color('#f4f1e6'))));
  group.add(instanced(lightsR, cars, cars.map(() => new THREE.Color('#9b1b1b'))));
  group.add(instanced(plates, cars, cars.map(() => new THREE.Color('#f2f2f2'))));
  // Laterne: Mast, Ausleger, Leuchte
  const lamp = mergeGeometries([
    new THREE.CylinderGeometry(0.06, 0.09, 6, 8).translate(0, 3, 0),
    new THREE.BoxGeometry(0.08, 0.08, 1.4).translate(0, 5.95, 0.65),
    new THREE.BoxGeometry(0.3, 0.12, 0.55).translate(0, 5.88, 1.3),
  ])!;
  group.add(instanced(lamp, lamps, lamps.map(() => new THREE.Color('#5c6166'))));
  return { group, posts, cars: cars.length, lamps: lamps.length };
}

// ---------------------------------------------------------------- Vorgärten (Fantasie)

class YardBuilder {
  paving = new MeshBuilder(); // Wege, Einfahrten
  hedge = new MeshBuilder();
  wall = new MeshBuilder();
  fence = new MeshBuilder(); // Lattenzaun (Textur mit Alpha)
  posts: { x: number; z: number; r: number }[] = [];
  cars: { x: number; z: number; yaw: number }[] = [];
  private rand: () => number;
  constructor(private hf: HeightField, private footprints: Polygon[], seed: number) {
    this.rand = rng(seed ^ 0x9a7d);
  }
  private inBuilding(x: number, z: number) {
    return this.footprints.some((p) => {
      const b = ringBounds(p.outer);
      return x >= b.minX - 0.3 && x <= b.maxX + 0.3 && z >= b.minZ - 0.3 && z <= b.maxZ + 0.3 && pointInRing(x, z, p.outer);
    });
  }
  /** Flaches Band auf dem Gelände von p nach q. */
  private strip(p: Pt, q: Pt, w: number, col: THREE.Color) {
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (L < 0.3) return;
    const ux = (q[0] - p[0]) / L, uz = (q[1] - p[1]) / L, nx = -uz * w / 2, nz = ux * w / 2;
    const n = Math.ceil(L / 1.5);
    const up = new THREE.Vector3(0, 1, 0);
    const at = (t: number, s: number) => {
      const x = p[0] + ux * L * t + nx * s, z = p[1] + uz * L * t + nz * s;
      return new THREE.Vector3(x, this.hf.height(x, z) + 0.07, z);
    };
    for (let i = 0; i < n; i++) {
      const a = at(i / n, -1), b = at(i / n, 1), c = at((i + 1) / n, 1), d = at((i + 1) / n, -1);
      this.paving.tri(a, b, c, col, up);
      this.paving.tri(a, c, d, col, up);
    }
  }
  add(doorX: number, doorZ: number, roadPt: Pt, roadHalf: number, tx: number, tz: number, lo: number, hi: number, idx: SegIndex) {
    const r = this.rand;
    // Richtung Haus -> Straße
    let ox = roadPt[0] - doorX, oz = roadPt[1] - doorZ;
    const d = Math.hypot(ox, oz) || 1;
    ox /= d; oz /= d;
    const edge: Pt = [roadPt[0] - ox * (roadHalf + 1.6), roadPt[1] - oz * (roadHalf + 1.6)]; // Grundstücksgrenze hinter 1,6 m Gehweg
    const pave = new THREE.Color().setHSL(0.08, 0.06, 0.55 + r() * 0.12);
    // Gartenweg
    this.strip([doorX, doorZ], [roadPt[0] - ox * roadHalf, roadPt[1] - oz * roadHalf], 1.2, pave);
    // Einfahrt (45 %) seitlich neben dem Haus
    const side = r() < 0.5 ? -1 : 1;
    let gap2: [number, number] | null = null;
    if (r() < 0.45) {
      const off = side < 0 ? lo - 2.2 : hi + 2.2;
      const a: Pt = [roadPt[0] - ox * roadHalf + tx * off, roadPt[1] - oz * roadHalf + tz * off];
      const depth = d - roadHalf + 3;
      const b: Pt = [a[0] - ox * depth, a[1] - oz * depth];
      if (!this.inBuilding(b[0], b[1]) && !this.inBuilding((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)) {
        this.strip(a, b, 3, new THREE.Color().setHSL(0.07, 0.05, 0.5 + r() * 0.1));
        gap2 = [off - 1.7, off + 1.7];
        if (r() < 0.55) this.cars.push({ x: a[0] - ox * (depth - 3), z: a[1] - oz * (depth - 3), yaw: Math.atan2(-ox, -oz) });
      }
    }
    // Einfriedung an der Straße: Hecke 35 %, Lattenzaun 35 %, Mäuerchen 15 %, nichts 15 %
    const kr = r();
    const kind = kr < 0.35 ? 'hedge' : kr < 0.7 ? 'fence' : kr < 0.85 ? 'wall' : null;
    if (!kind) return;
    const hedgeCol = new THREE.Color().setHSL(0.27 + r() * 0.04, 0.42, 0.2 + r() * 0.07);
    const wallCol = new THREE.Color().setHSL(0.08, 0.08, 0.6 + r() * 0.12);
    const from = lo - 3, to = hi + 3, step = 0.5;
    for (let a = from; a < to; a += step) {
      const m = a + step / 2;
      if (Math.abs(m) < 0.8) continue; // Lücke für den Gartenweg
      if (gap2 && m > gap2[0] && m < gap2[1]) continue;
      const x0 = edge[0] + tx * a, z0 = edge[1] + tz * a, x1 = edge[0] + tx * (a + step), z1 = edge[1] + tz * (a + step);
      if (this.inBuilding((x0 + x1) / 2, (z0 + z1) / 2)) continue;
      const near = idx.nearest((x0 + x1) / 2, (z0 + z1) / 2, () => true);
      if (near && near.d < near.s.half + 0.8) continue; // nicht auf Wege
      if (kind === 'hedge') this.box(this.hedge, x0, z0, x1, z1, 0.7, 1.1 + r() * 0.15, hedgeCol);
      else if (kind === 'wall') this.box(this.wall, x0, z0, x1, z1, 0.25, 0.6, wallCol);
      else this.panel(x0, z0, x1, z1, a, 1.0);
      if (kind !== 'fence' || Math.round(a / step) % 2 === 0) this.posts.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, r: 0.35 });
    }
  }
  private box(mb: MeshBuilder, x0: number, z0: number, x1: number, z1: number, w: number, h: number, col: THREE.Color) {
    const L = Math.hypot(x1 - x0, z1 - z0) || 1, nx = -(z1 - z0) / L * w / 2, nz = (x1 - x0) / L * w / 2;
    const g0 = this.hf.height(x0, z0) - 0.1, g1 = this.hf.height(x1, z1) - 0.1;
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const a = V(x0 + nx, g0, z0 + nz), b = V(x1 + nx, g1, z1 + nz), c = V(x1 - nx, g1, z1 - nz), d = V(x0 - nx, g0, z0 - nz);
    const at = V(a.x, g0 + h, a.z), bt = V(b.x, g1 + h, b.z), ct = V(c.x, g1 + h, c.z), dt = V(d.x, g0 + h, d.z);
    mb.quad(a, b, bt, at, col);
    mb.quad(c, d, dt, ct, col);
    mb.quad(at, bt, ct, dt, col);
  }
  private panel(x0: number, z0: number, x1: number, z1: number, u0: number, h: number) {
    const g0 = this.hf.height(x0, z0), g1 = this.hf.height(x1, z1);
    const L = Math.hypot(x1 - x0, z1 - z0);
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const col = new THREE.Color('#ffffff');
    this.fence.quad(V(x0, g0, z0), V(x1, g1, z1), V(x1, g1 + h, z1), V(x0, g0 + h, z0), col, [[u0, 0], [u0 + L, 0], [u0 + L, 1], [u0, 1]]);
  }
  build() {
    const g = new THREE.Group();
    const add = (mb: MeshBuilder, m: THREE.Material, cast = true) => {
      if (mb.empty) return;
      const mesh = new THREE.Mesh(mb.build(), m);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      g.add(mesh);
    };
    add(this.paving, new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }), false);
    // Blattwerk bzw. Stein als feine Struktur (Rauschen in Weltkoordinaten)
    const dt = detailTexture();
    const hedgeMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    addDetail(hedgeMat, dt, 1.6, 1.0, 40, true);
    const wallMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    addDetail(wallMat, dt, 0.9, 0.6, 40, true);
    add(this.hedge, hedgeMat);
    add(this.wall, wallMat);
    add(this.fence, new THREE.MeshLambertMaterial({ map: fenceTexture(), alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true }));
    return g;
  }
}

// ---------------------------------------------------------------- Gras (Fantasie, nur in der Nähe)

export class Grass {
  mesh: THREE.InstancedMesh;
  private cx = Infinity;
  private cz = Infinity;
  private data: Uint8ClampedArray;
  private n: number;
  private s: number;
  private fp = new Map<string, Polygon[]>();
  private idx: SegIndex;
  static readonly RANGE = 28;
  static readonly STEP = 0.5;
  constructor(ground: HTMLCanvasElement, private half: number, private hf: HeightField, segs: RoadSeg[], footprints: Polygon[], tex: THREE.Texture) {
    this.n = Math.min(1024, ground.width);
    const c = document.createElement('canvas');
    c.width = c.height = this.n;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(ground, 0, 0, this.n, this.n);
    this.data = g.getImageData(0, 0, this.n, this.n).data;
    this.s = this.n / (2 * half);
    this.idx = new SegIndex(segs);
    for (const p of footprints) {
      const b = ringBounds(p.outer);
      for (let i = Math.floor(b.minX / 10); i <= Math.floor(b.maxX / 10); i++)
        for (let j = Math.floor(b.minZ / 10); j <= Math.floor(b.maxZ / 10); j++) {
          const k = i + ',' + j;
          (this.fp.get(k) ?? this.fp.set(k, []).get(k)!).push(p);
        }
    }
    // Büschel: zwei gekreuzte Flächen 0,6 × 0,32 m
    const q1 = new THREE.PlaneGeometry(0.6, 0.32).translate(0, 0.16, 0);
    const q2 = q1.clone().rotateY(Math.PI / 2);
    const geo = mergeGeometries([q1, q2])!;
    const max = Math.ceil((Math.PI * Grass.RANGE * Grass.RANGE) / (Grass.STEP * Grass.STEP));
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.45, side: THREE.DoubleSide }), max);
    this.mesh.count = 0;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false; // Instanzen wandern mit der Kamera
  }
  private green(x: number, z: number): number {
    const px = Math.floor((x + this.half) * this.s), pz = Math.floor((z + this.half) * this.s);
    if (px < 0 || pz < 0 || px >= this.n || pz >= this.n) return 0;
    const i = (pz * this.n + px) * 4;
    const r = this.data[i], g = this.data[i + 1], b = this.data[i + 2];
    // "grün genug": G überwiegt R und B, nicht zu dunkel (Schatten/Wasser)
    const v = (g - Math.max(r, b)) / 255;
    return g > 45 ? Math.max(0, Math.min(1, v * 6)) : 0;
  }
  private blocked(x: number, z: number) {
    for (const p of this.fp.get(Math.floor(x / 10) + ',' + Math.floor(z / 10)) ?? []) if (pointInPolygon(x, z, p)) return true;
    const near = this.idx.nearest(x, z, (s) => s.kind !== 'water');
    return !!near && near.d < near.s.half + 0.4;
  }
  /** Gras um (x, z) neu verteilen, wenn man sich weit genug bewegt hat. */
  update(x: number, z: number, radius: number) {
    if (Math.hypot(x - this.cx, z - this.cz) < 6) return;
    this.cx = x;
    this.cz = z;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    const R = Grass.RANGE, st = Grass.STEP;
    let k = 0;
    // Raster in Weltkoordinaten (fest), damit Büschel beim Nachführen nicht springen
    for (let gz = Math.floor((z - R) / st); gz <= Math.ceil((z + R) / st); gz++)
      for (let gx = Math.floor((x - R) / st); gx <= Math.ceil((x + R) / st); gx++) {
        const h = ((gx * 73856093) ^ (gz * 19349663)) >>> 0;
        const r1 = (h % 1000) / 1000, r2 = ((h >>> 10) % 1000) / 1000, r3 = ((h >>> 20) % 1000) / 1000;
        const wx = gx * st + (r1 - 0.5) * st, wz = gz * st + (r2 - 0.5) * st;
        const dx = wx - x, dz = wz - z;
        if (dx * dx + dz * dz > R * R || wx * wx + wz * wz > radius * radius) continue;
        const gr = this.green(wx, wz);
        if (gr < 0.15 || r3 > gr + 0.25 || this.blocked(wx, wz)) continue;
        q.setFromAxisAngle(up, r1 * Math.PI);
        const s = 0.7 + r2 * 0.8;
        sc.set(s, s * (0.8 + r3 * 0.6), s);
        p.set(wx, this.hf.height(wx, wz) - 0.02, wz);
        this.mesh.setMatrixAt(k, m.compose(p, q, sc));
        this.mesh.setColorAt(k, col.setHSL(0.24 + r3 * 0.05, 0.45, 0.4 + r1 * 0.2));
        if (++k >= this.mesh.instanceMatrix.count) break;
      }
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
