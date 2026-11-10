import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { HeightField } from './terrain';
import { AreaFeature, LineFeature } from './osm';
import { RoadSeg, roadStyle } from './builders';
import { Polygon, Pt, Ring, densify, pointInPolygon, pointInRing, rng, ringBounds } from './util';

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
  nearest(x: number, z: number, ok: (s: RoadSeg) => boolean): { p: Pt; d: number } | null {
    const ci = Math.floor(x / this.cell), cj = Math.floor(z / this.cell);
    let best: { p: Pt; d: number } | null = null;
    for (let i = ci - 2; i <= ci + 2; i++)
      for (let j = cj - 2; j <= cj + 2; j++)
        for (const s of this.map.get(i + ',' + j) ?? []) {
          if (!ok(s)) continue;
          const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
          const L2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - s.a[0]) * dx + (z - s.a[1]) * dz) / L2));
          const px = s.a[0] + t * dx, pz = s.a[1] + t * dz;
          const d = Math.hypot(px - x, pz - z);
          if (!best || d < best.d) best = { p: [px, pz], d };
        }
    return best;
  }
}

const ACCESS = /^(residential|living_street|service|unclassified|tertiary|secondary|primary|pedestrian|footway|path|track|cycleway|steps)$/;

// ---------------------------------------------------------------- Türen und Mülltonnen

export interface Entrance { ring: Ring; area: number; residential: boolean }

export function buildDoorsAndBins(entrances: Entrance[], segs: RoadSeg[], hf: HeightField, radius: number, seed: number) {
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
  // Tür: Blatt + heller Rahmen + Stufe
  const door = mergeGeometries([
    new THREE.BoxGeometry(1.0, 2.1, 0.1).translate(0, 1.05 + 0.15, 0),
    new THREE.BoxGeometry(1.4, 0.15, 0.9).translate(0, 0.075, 0.35),
  ])!;
  const doorMesh = instanced(door, doors, doorColors);
  const bin = mergeGeometries([
    new THREE.BoxGeometry(0.58, 0.95, 0.72).translate(0, 0.475, 0),
    new THREE.BoxGeometry(0.62, 0.06, 0.78).translate(0, 0.98, 0),
  ])!;
  const binMesh = instanced(bin, bins, binColors);
  return { doors: doorMesh, bins: binMesh, binPosts };
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

  // Auto: Karosserie (Instanzfarbe), Glas/Kabine dunkel, Räder schwarz – drei Instanzgruppen
  const body = mergeGeometries([
    new THREE.BoxGeometry(1.8, 0.62, 4.3).translate(0, 0.62, 0),
    new THREE.BoxGeometry(1.74, 0.12, 2.3).translate(0, 1.42, -0.25), // Dach
  ])!;
  const glass = new THREE.BoxGeometry(1.66, 0.5, 2.45).translate(0, 1.15, -0.25);
  const wheelGeo = new THREE.CylinderGeometry(0.33, 0.33, 0.22, 12).rotateZ(Math.PI / 2);
  const wheels = mergeGeometries([[-0.82, 1.35], [0.82, 1.35], [-0.82, -1.35], [0.82, -1.35]].map(([x, z]) => wheelGeo.clone().translate(x, 0.33, z)))!;
  const group = new THREE.Group();
  group.add(instanced(body, cars, carCols));
  group.add(instanced(glass, cars, cars.map(() => new THREE.Color('#1d2630'))));
  group.add(instanced(wheels, cars, cars.map(() => new THREE.Color('#151515'))));
  // Laterne: Mast, Ausleger, Leuchte
  const lamp = mergeGeometries([
    new THREE.CylinderGeometry(0.06, 0.09, 6, 8).translate(0, 3, 0),
    new THREE.BoxGeometry(0.08, 0.08, 1.4).translate(0, 5.95, 0.65),
    new THREE.BoxGeometry(0.3, 0.12, 0.55).translate(0, 5.88, 1.3),
  ])!;
  group.add(instanced(lamp, lamps, lamps.map(() => new THREE.Color('#5c6166'))));
  return { group, posts, cars: cars.length, lamps: lamps.length };
}
