export type Pt = [number, number]; // lokale Koordinaten x, z
export type Ring = Pt[];

/** Reproduzierbarer Zufallsgenerator (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFrom(lat: number, lon: number): number {
  return (Math.round(lat * 1e5) * 73856093) ^ (Math.round(lon * 1e5) * 19349663);
}

/** Vorzeichenbehaftete Fläche (Schuhbandformel). */
export function signedArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2;
}

export function pointInRing(x: number, z: number, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, zi] = r[i];
    const [xj, zj] = r[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export interface Polygon {
  outer: Ring;
  holes: Ring[];
}

export function pointInPolygon(x: number, z: number, p: Polygon): boolean {
  if (!pointInRing(x, z, p.outer)) return false;
  for (const h of p.holes) if (pointInRing(x, z, h)) return false;
  return true;
}

export function ringBounds(r: Ring) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (const [x, z] of r) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

/** Geschlossenen Ring ohne doppelten Endpunkt zurückgeben. */
export function openRing(r: Ring): Ring {
  if (r.length > 1) {
    const a = r[0], b = r[r.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return r.slice(0, -1);
  }
  return r;
}

/**
 * Teilstücke (Wege einer Multipolygon-Relation) zu geschlossenen Ringen verbinden.
 * Endpunkte gelten als gleich, wenn sie weniger als 1 cm auseinanderliegen.
 */
export function joinRings(parts: Ring[]): Ring[] {
  const eq = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
  const rest = parts.filter((p) => p.length >= 2).map((p) => p.slice());
  const out: Ring[] = [];
  while (rest.length) {
    let cur = rest.shift()!;
    let changed = true;
    while (!eq(cur[0], cur[cur.length - 1]) && changed) {
      changed = false;
      for (let i = 0; i < rest.length; i++) {
        const p = rest[i];
        const end = cur[cur.length - 1];
        if (eq(end, p[0])) cur = cur.concat(p.slice(1));
        else if (eq(end, p[p.length - 1])) cur = cur.concat(p.slice(0, -1).reverse());
        else continue;
        rest.splice(i, 1);
        changed = true;
        break;
      }
    }
    if (cur.length >= 4 && eq(cur[0], cur[cur.length - 1])) out.push(openRing(cur));
  }
  return out;
}

/** Linie in Stücke von höchstens maxLen Metern unterteilen (für das Anschmiegen ans Gelände). */
export function densify(line: Pt[], maxLen: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const [x0, z0] = line[i];
    const [x1, z1] = line[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / maxLen));
    for (let k = 0; k < n; k++) out.push([x0 + ((x1 - x0) * k) / n, z0 + ((z1 - z0) * k) / n]);
  }
  if (line.length) out.push(line[line.length - 1]);
  return out;
}

/** Zahl aus OSM-Tag lesen ("12", "12 m", "12.5"); Fuß/andere Einheiten werden ignoriert. */
export function parseMeters(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const m = /^\s*([0-9]+(?:[.,][0-9]+)?)\s*(m)?\s*$/.exec(v);
  if (!m) return undefined;
  const n = parseFloat(m[1].replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}
