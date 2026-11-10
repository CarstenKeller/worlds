import * as THREE from 'three';
import { LocalFrame, chooseZoom, decodeTerrarium, latToTileY, lonToTileX } from './geo';
import { ELEVATION_MAX_ZOOM, ELEVATION_URL, loadImage, pool, tileUrl } from './sources';

/**
 * Regelmäßiges Höhengitter über dem Quadrat [-half, half]² (lokale Meter).
 * Die Interpolation in height() entspricht exakt der Dreiecksaufteilung des Meshes,
 * damit Wege, Bäume und die Kamera genau auf der sichtbaren Oberfläche liegen.
 */
export class HeightField {
  readonly step: number;
  constructor(
    readonly n: number, // Punkte je Achse
    readonly half: number,
    readonly h: Float32Array, // n*n, Zeile = z-Index
  ) {
    this.step = (2 * half) / (n - 1);
  }

  at(i: number, j: number): number {
    return this.h[j * this.n + i];
  }

  height(x: number, z: number): number {
    const gx = Math.min(Math.max((x + this.half) / this.step, 0), this.n - 1.0001);
    const gz = Math.min(Math.max((z + this.half) / this.step, 0), this.n - 1.0001);
    const i = Math.floor(gx), j = Math.floor(gz);
    const fx = gx - i, fz = gz - j;
    const a = this.at(i, j), b = this.at(i + 1, j), c = this.at(i, j + 1), d = this.at(i + 1, j + 1);
    // Diagonale b–c (siehe buildMesh)
    if (fx + fz <= 1) return a + (b - a) * fx + (c - a) * fz;
    return d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
  }

  /** Mesh als Kreisscheibe mit Radius radius; uv über das gesamte Quadrat. */
  buildMesh(radius: number): THREE.BufferGeometry {
    const n = this.n;
    const pos = new Float32Array(n * n * 3);
    const uv = new Float32Array(n * n * 2);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = -this.half + i * this.step;
        const z = -this.half + j * this.step;
        pos[k * 3] = x;
        pos[k * 3 + 1] = this.h[k];
        pos[k * 3 + 2] = z;
        uv[k * 2] = i / (n - 1);
        uv[k * 2 + 1] = 1 - j / (n - 1); // Canvas-Textur: v=1 oben (Norden)
      }
    const idx: number[] = [];
    const lim = (radius + this.step) ** 2;
    const inside = (i: number, j: number) => {
      const x = -this.half + (i + 0.5) * this.step, z = -this.half + (j + 0.5) * this.step;
      return x * x + z * z <= lim;
    };
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        if (!inside(i, j)) continue;
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
}

/** Höhen-Mosaik aus Terrarium-Kacheln: liefert eine Abtastfunktion (lat, lon) -> Meter. */
export async function loadElevation(
  frame: LocalFrame,
  half: number,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ sample: (lat: number, lon: number) => number; failed: number; zoom: number }> {
  const t = chooseZoom(frame.bbox(half), ELEVATION_MAX_ZOOM, 6);
  const w = (t.x1 - t.x0 + 1) * 256;
  const hgt = (t.y1 - t.y0 + 1) * 256;
  const data = new Float32Array(w * hgt);
  const valid = new Uint8Array(w * hgt);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const tiles: [number, number][] = [];
  for (let y = t.y0; y <= t.y1; y++) for (let x = t.x0; x <= t.x1; x++) tiles.push([x, y]);
  let done = 0, failed = 0;
  await pool(tiles, 6, async ([x, y]) => {
    try {
      const img = await loadImage(tileUrl(ELEVATION_URL, t.z, x, y), signal);
      ctx.clearRect(0, 0, 256, 256);
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, 256, 256).data;
      const ox = (x - t.x0) * 256, oy = (y - t.y0) * 256;
      for (let py = 0; py < 256; py++)
        for (let pxi = 0; pxi < 256; pxi++) {
          const s = (py * 256 + pxi) * 4;
          const d = (oy + py) * w + ox + pxi;
          data[d] = decodeTerrarium(px[s], px[s + 1], px[s + 2]);
          valid[d] = 1;
        }
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      failed++;
    }
    onProgress(++done, tiles.length);
  });
  // Fehlende Kacheln: mit Mittelwert der gültigen Pixel füllen (flach statt Loch).
  let sum = 0, cnt = 0;
  for (let i = 0; i < data.length; i++) if (valid[i]) { sum += data[i]; cnt++; }
  const mean = cnt ? sum / cnt : 0;
  for (let i = 0; i < data.length; i++) if (!valid[i]) data[i] = mean;

  const sample = (lat: number, lon: number) => {
    // Pixelmitten liegen bei +0.5
    const gx = Math.min(Math.max((lonToTileX(lon, t.z) - t.x0) * 256 - 0.5, 0), w - 1.001);
    const gy = Math.min(Math.max((latToTileY(lat, t.z) - t.y0) * 256 - 0.5, 0), hgt - 1.001);
    const i = Math.floor(gx), j = Math.floor(gy);
    const fx = gx - i, fy = gy - j;
    const p = (a: number, b: number) => data[b * w + a];
    return (
      p(i, j) * (1 - fx) * (1 - fy) + p(i + 1, j) * fx * (1 - fy) + p(i, j + 1) * (1 - fx) * fy + p(i + 1, j + 1) * fx * fy
    );
  };
  return { sample, failed, zoom: t.z };
}

export function buildHeightField(
  frame: LocalFrame,
  half: number,
  sample: (lat: number, lon: number) => number,
): HeightField {
  // Gitterweite ≥ 2 m, höchstens 257 Punkte je Achse
  const n = Math.min(257, Math.max(33, Math.ceil((2 * half) / 2) + 1));
  const h = new Float32Array(n * n);
  const step = (2 * half) / (n - 1);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const { lat, lon } = frame.toLatLon(-half + i * step, -half + j * step);
      h[j * n + i] = sample(lat, lon);
    }
  return new HeightField(n, half, h);
}
