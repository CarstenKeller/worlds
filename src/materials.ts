import * as THREE from 'three';
import { rng } from './util';

/** Fassadentextur: ein Fensterfeld (FACADE_MODULE breit × ein Stockwerk hoch), weiß = Wandfarbe. */
export function facadeTexture(): THREE.Texture {
  const n = 128;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, n, n);
  // leichte Putzstruktur
  const r = rng(7);
  for (let i = 0; i < 900; i++) {
    const v = 235 + Math.floor(r() * 20);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(Math.floor(r() * n), Math.floor(r() * n), 2, 2);
  }
  // Fenster: Rahmen hell, Glas dunkel bläulich, Sprosse; Unterkante ~0,9 m über Geschossboden
  const x0 = 0.3 * n, x1 = 0.7 * n, y0 = (1 - 0.82) * n, y1 = (1 - 0.32) * n; // Canvas-y nach unten
  g.fillStyle = '#d8d8d8';
  g.fillRect(x0 - 4, y0 - 4, x1 - x0 + 8, y1 - y0 + 8);
  const grad = g.createLinearGradient(0, y0, 0, y1);
  grad.addColorStop(0, '#5b6b7c');
  grad.addColorStop(1, '#2c3642');
  g.fillStyle = grad;
  g.fillRect(x0, y0, x1 - x0, y1 - y0);
  g.fillStyle = '#d8d8d8';
  g.fillRect((x0 + x1) / 2 - 1.5, y0, 3, y1 - y0);
  // Fensterbank
  g.fillStyle = '#9a9a9a';
  g.fillRect(x0 - 6, y1 + 3, x1 - x0 + 12, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Graustufen-Rauschen (Mittelwert ~0,5), kachelbar, für Feinstruktur auf Boden und Straßen. */
export function detailTexture(): THREE.Texture {
  const n = 256;
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const img = g.createImageData(n, n);
  const r = rng(11);
  // mehrere Oktaven Wertrauschen mit periodischem Gitter (nahtlos kachelbar)
  const oct = [8, 16, 32, 64, 128];
  const grids = oct.map((k) => Array.from({ length: k * k }, () => r()));
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      let v = 0, w = 0;
      oct.forEach((k, o) => {
        const gx = (x / n) * k, gy = (y / n) * k;
        const i = Math.floor(gx), j = Math.floor(gy);
        const fx = smooth(gx - i), fy = smooth(gy - j);
        const G = grids[o];
        const at = (a: number, b: number) => G[((b % k) * k) + (a % k)];
        const val = at(i, j) * (1 - fx) * (1 - fy) + at(i + 1, j) * fx * (1 - fy) + at(i, j + 1) * (1 - fx) * fy + at(i + 1, j + 1) * fx * fy;
        const amp = 1 / (o + 1);
        v += val * amp;
        w += amp;
      });
      const b = Math.round((v / w) * 255);
      const p = (y * n + x) * 4;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = b;
      img.data[p + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/**
 * Feinstruktur in ein Lambert-Material einmischen: Rauschen in Weltkoordinaten (scale = Wiederholungen
 * je Meter), nur in der Nähe (verblasst bis fadeDist), damit es in der Ferne nicht flimmert.
 */
export function addDetail(m: THREE.MeshLambertMaterial, tex: THREE.Texture, scale: number, strength: number, fadeDist = 60, vertical = false): { value: number } {
  // vertical: auch senkrechte Flächen (Hecken, Mauern) bekommen Struktur statt Streifen
  const uvExpr = vertical ? 'vec2(vDetailPos.x + vDetailPos.z, vDetailPos.y * 1.3 + vDetailPos.z * 0.4)' : 'vDetailPos.xz';
  // Schalter (A-01: Feinstruktur ist erfunden) – 0 = aus, 1 = an
  const on = { value: 1 };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.detailMap = { value: tex };
    shader.uniforms.detailOn = on;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDetailPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDetailPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D detailMap;\nuniform float detailOn;\nvarying vec3 vDetailPos;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          float d1 = texture2D(detailMap, ${uvExpr} * ${scale.toFixed(4)}).r;
          float d2 = texture2D(detailMap, ${uvExpr} * ${(scale * 0.137).toFixed(4)}).r;
          float k = detailOn * ${strength.toFixed(3)} * (1.0 - smoothstep(${(fadeDist * 0.3).toFixed(1)}, ${fadeDist.toFixed(1)}, length(vViewPosition)));
          diffuseColor.rgb *= mix(1.0, (d1 * 0.65 + d2 * 0.35) * 2.0, k);
        }`,
      );
  };
  m.customProgramCacheKey = () => `detail-${scale}-${strength}-${fadeDist}-${vertical}`;
  return on;
}

/** Bodentextur im Speicher verkleinert lesen und daraus Dachfarben ableiten. */
export function makeRoofSampler(ground: HTMLCanvasElement, half: number): ((x: number, z: number) => THREE.Color | null) | undefined {
  try {
    const n = Math.min(1024, ground.width);
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(ground, 0, 0, n, n);
    const data = g.getImageData(0, 0, n, n).data;
    const s = n / (2 * half);
    const hsl = { h: 0, s: 0, l: 0 };
    return (x, z) => {
      const px = Math.round((x + half) * s), pz = Math.round((z + half) * s);
      let r = 0, gg = 0, b = 0, cnt = 0;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = px + dx, zz = pz + dz;
          if (xx < 0 || zz < 0 || xx >= n || zz >= n) continue;
          const i = (zz * n + xx) * 4;
          if (data[i + 3] < 200) continue;
          r += data[i]; gg += data[i + 1]; b += data[i + 2]; cnt++;
        }
      if (!cnt) return null;
      const col = new THREE.Color().setRGB(r / cnt / 255, gg / cnt / 255, b / cnt / 255, THREE.SRGBColorSpace);
      col.getHSL(hsl);
      // Grün = vermutlich Baumkrone über dem Dach -> keine Farbe ableiten
      if (hsl.h > 0.17 && hsl.h < 0.45 && hsl.s > 0.12) return null;
      return col.setHSL(hsl.h, Math.min(hsl.s * 1.15, 0.55), Math.min(Math.max(hsl.l * 1.15, 0.14), 0.62));
    };
  } catch {
    return undefined; // z. B. Canvas ohne CORS-Freigabe
  }
}

// ---------------------------------------------------------------- weitere Texturen (gezeichnet, keine fremden Bilder)

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function plaster(g: CanvasRenderingContext2D, n: number, seed: number, base = 245, spread = 18) {
  g.fillStyle = `rgb(${base},${base},${base})`;
  g.fillRect(0, 0, n, n);
  const r = rng(seed);
  for (let i = 0; i < n * 7; i++) {
    const v = base - Math.floor(r() * spread);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(Math.floor(r() * n), Math.floor(r() * n), 2, 2);
  }
}

/**
 * Fassadenvarianten (ein Feld = 3 m breit × 1 Geschoss), weiß = Wandfarbe (Vertexfarbe multipliziert):
 * 0 modern (große Fenster), 1 klassisch mit Klappläden, 2 Klinker (eigene Steinfarbe).
 */
export function facadeTextures(): THREE.Texture[] {
  const n = 128;
  const windowAt = (g: CanvasRenderingContext2D, x0: number, x1: number, y0: number, y1: number, frame: string, bars: boolean) => {
    g.fillStyle = frame;
    g.fillRect(x0 - 4, y0 - 4, x1 - x0 + 8, y1 - y0 + 8);
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, '#6f8191');
    gr.addColorStop(0.45, '#3a4653');
    gr.addColorStop(1, '#232b33');
    g.fillStyle = gr;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
    // Spiegelung
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.beginPath(); g.moveTo(x0, y1); g.lineTo(x0 + (x1 - x0) * 0.35, y0); g.lineTo(x0 + (x1 - x0) * 0.55, y0); g.lineTo(x0 + (x1 - x0) * 0.2, y1); g.fill();
    g.fillStyle = frame;
    g.fillRect((x0 + x1) / 2 - 1.5, y0, 3, y1 - y0);
    if (bars) g.fillRect(x0, y0 + (y1 - y0) * 0.38, x1 - x0, 3);
    g.fillStyle = '#8d8d8d';
    g.fillRect(x0 - 7, y1 + 3, x1 - x0 + 14, 5); // Fensterbank
  };
  const v0 = canvasTex(n, n, (g) => { plaster(g, n, 3); windowAt(g, 0.27 * n, 0.73 * n, 0.16 * n, 0.7 * n, '#e4e4e4', false); });
  const v1 = canvasTex(n, n, (g) => {
    plaster(g, n, 5, 240, 22);
    const x0 = 0.36 * n, x1 = 0.64 * n, y0 = 0.2 * n, y1 = 0.68 * n;
    windowAt(g, x0, x1, y0, y1, '#f4f4f0', true);
    // Klappläden (Lamellen)
    for (const [a, b] of [[x0 - 4 - 0.15 * n, x0 - 6], [x1 + 6, x1 + 4 + 0.15 * n]]) {
      g.fillStyle = '#4f6a4a';
      g.fillRect(a, y0 - 4, b - a, y1 - y0 + 8);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      for (let y = y0; y < y1; y += 5) g.fillRect(a + 2, y, b - a - 4, 1.5);
    }
  });
  const v2 = canvasTex(n, n, (g) => {
    // Klinker: rötliche Steine mit Fugen, Läuferverband
    g.fillStyle = '#c9c2b8';
    g.fillRect(0, 0, n, n);
    const r = rng(9);
    const bh = n / 16, bw = n / 5.5;
    for (let row = 0; row < 16; row++)
      for (let x = -(row % 2) * bw / 2; x < n; x += bw) {
        const v = 0.8 + r() * 0.35;
        g.fillStyle = `rgb(${Math.floor(165 * v)},${Math.floor(78 * v)},${Math.floor(58 * v)})`;
        g.fillRect(x + 1, row * bh + 1, bw - 2, bh - 2);
      }
    windowAt(g, 0.3 * n, 0.7 * n, 0.2 * n, 0.68 * n, '#f2f2f2', false);
    g.fillStyle = '#b9b2a8';
    g.fillRect(0.3 * n - 6, 0.2 * n - 9, 0.4 * n + 12, 5); // Sturz
  });
  return [v0, v1, v2];
}

/** Dachziegel: 1 Wiederholung = 1 m entlang Traufe (u) × 1 m Dachfläche (v). Weiß = Dachfarbe. */
export function roofTexture(): THREE.Texture {
  return canvasTex(64, 64, (g) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 64, 64);
    const r = rng(13);
    for (let row = 0; row < 3; row++) {
      const y = row * 21.3;
      for (let x = -(row % 2) * 8; x < 64; x += 16) {
        const v = 200 + Math.floor(r() * 55);
        const gr = g.createLinearGradient(0, y, 0, y + 21);
        gr.addColorStop(0, `rgb(${v},${v},${v})`);
        gr.addColorStop(1, `rgb(${v - 70},${v - 70},${v - 70})`);
        g.fillStyle = gr;
        g.beginPath();
        g.moveTo(x + 1, y);
        g.lineTo(x + 15, y);
        g.quadraticCurveTo(x + 15, y + 21, x + 8, y + 21);
        g.quadraticCurveTo(x + 1, y + 21, x + 1, y);
        g.fill();
      }
    }
  });
}

/** Haustür mit Füllungen, Glasausschnitt und Griff (auf das Türblatt gemappt). */
export function doorTexture(): THREE.Texture {
  return canvasTex(64, 128, (g) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 64, 128);
    g.strokeStyle = 'rgba(0,0,0,0.35)';
    g.lineWidth = 2;
    g.strokeRect(10, 12, 44, 30);
    g.strokeRect(10, 52, 44, 30);
    g.strokeRect(10, 92, 44, 26);
    g.fillStyle = '#56636f';
    g.fillRect(14, 16, 36, 22); // Glasausschnitt
    g.fillStyle = '#c8c8c8';
    g.fillRect(48, 64, 4, 16); // Griff
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.fillRect(0, 0, 3, 128);
    g.fillRect(61, 0, 3, 128);
  });
}

/** Mülltonne: senkrechte Rippen, Deckelkante. */
export function binTexture(): THREE.Texture {
  return canvasTex(64, 64, (g) => {
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 64, 64);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let x = 4; x < 64; x += 10) g.fillRect(x, 8, 3, 50);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(0, 4, 64, 3);
  });
}

/** Grasbüschel (Alpha): mehrere Halme, unten dunkler. */
export function grassTexture(): THREE.Texture {
  return canvasTex(128, 64, (g) => {
    g.clearRect(0, 0, 128, 64);
    const r = rng(21);
    for (let i = 0; i < 70; i++) {
      const x = 4 + r() * 120, h = 25 + r() * 37, lean = (r() - 0.5) * 18;
      const c = 0.75 + r() * 0.35;
      g.strokeStyle = `rgb(${Math.floor(110 * c)},${Math.floor(150 * c)},${Math.floor(60 * c)})`;
      g.lineWidth = 1.5 + r() * 1.5;
      g.beginPath();
      g.moveTo(x, 64);
      g.quadraticCurveTo(x + lean * 0.3, 64 - h * 0.6, x + lean, 64 - h);
      g.stroke();
    }
  });
}

/** Lattenzaun (Alpha): u = 1 m, v = Zaunhöhe. Holz hell gestrichen. */
export function fenceTexture(): THREE.Texture {
  return canvasTex(64, 64, (g) => {
    g.clearRect(0, 0, 64, 64);
    g.fillStyle = '#d9d2c3';
    for (let x = 2; x < 64; x += 8) {
      g.fillRect(x, 6, 5, 58);
      g.beginPath(); g.moveTo(x, 6); g.lineTo(x + 2.5, 1); g.lineTo(x + 5, 6); g.fill();
    }
    g.fillStyle = '#b8b0a0';
    g.fillRect(0, 18, 64, 4);
    g.fillRect(0, 46, 64, 4);
  });
}
