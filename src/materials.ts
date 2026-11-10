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
export function addDetail(m: THREE.MeshLambertMaterial, tex: THREE.Texture, scale: number, strength: number, fadeDist = 60) {
  m.onBeforeCompile = (shader) => {
    shader.uniforms.detailMap = { value: tex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vDetailPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDetailPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D detailMap;\nvarying vec3 vDetailPos;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          float d1 = texture2D(detailMap, vDetailPos.xz * ${scale.toFixed(4)}).r;
          float d2 = texture2D(detailMap, vDetailPos.xz * ${(scale * 0.137).toFixed(4)}).r;
          float k = ${strength.toFixed(3)} * (1.0 - smoothstep(${(fadeDist * 0.3).toFixed(1)}, ${fadeDist.toFixed(1)}, length(vViewPosition)));
          diffuseColor.rgb *= mix(1.0, (d1 * 0.65 + d2 * 0.35) * 2.0, k);
        }`,
      );
  };
  m.customProgramCacheKey = () => `detail-${scale}-${strength}-${fadeDist}`;
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
