// Erkundung basemap.de 3D (Format) und DGM5-Gelände (Kodierung, CORS). Nur Protokoll.
import { describe, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ORIGIN = 'https://carstenkeller.github.io';
const BASE = 'https://sgx.geodatenzentrum.de/gdz_basemapde_3d_gebaeude/';
const get = (u: string) => fetch(u, { headers: { Origin: ORIGIN }, signal: AbortSignal.timeout(20000) });

/** Minimaler PNG-Dekoder (8 bit, RGB/RGBA, nicht interlaced). */
function decodePng(buf: Buffer) {
  let p = 8, w = 0, h = 0, ct = 0;
  const idat: Buffer[] = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9]; }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = inflateSync(Buffer.concat(idat)), out = Buffer.alloc(w * h * bpp);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (w * bpp + 1)], row = raw.subarray(y * (w * bpp + 1) + 1, (y + 1) * (w * bpp + 1));
    for (let i = 0; i < w * bpp; i++) {
      const a = i >= bpp ? out[y * w * bpp + i - bpp] : 0, b = y ? out[(y - 1) * w * bpp + i] : 0, c = y && i >= bpp ? out[(y - 1) * w * bpp + i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * w * bpp + i] = v & 255;
    }
  }
  return { w, h, bpp, px: (x: number, y: number) => [...out.subarray((y * w + x) * bpp, (y * w + x) * bpp + bpp)] };
}

describe('basemap.de Erkundung', () => {
  it('3D-Gebäude: Aufbau des Kachelbaums', async () => {
    const root = await (await get(BASE + 'lod2_3857_null.json')).json();
    console.log('[probe2] root keys', Object.keys(root), 'root.root keys', Object.keys(root.root), 'children', root.root.children?.length);
    console.log('[probe2] root (Anfang):', JSON.stringify(root).slice(0, 1200));
    const first = root.root.children[0];
    const ext = first.box[first.box.length - 1];
    const sub = await get(BASE + ext);
    const txt = await sub.text();
    console.log(`[probe2] ${ext}: HTTP ${sub.status}, ${txt.length} B, CORS=${sub.headers.get('access-control-allow-origin')}\n   ${txt.slice(0, 1500)}`);
    // einem Inhalt bis zum Blatt folgen
    const urls = [...txt.matchAll(/"([^"]+\.(?:b3dm|glb|gltf|json|pnts|i3dm|cmpt))"/g)].map((m) => m[1]);
    console.log('[probe2] Verweise (erste 10):', urls.slice(0, 10));
    for (const u of urls.slice(0, 3)) {
      const full = new URL(u, BASE + ext).href;
      const r = await get(full);
      const b = Buffer.from(await r.arrayBuffer());
      console.log(`[probe2] ${full}: HTTP ${r.status}, ${b.length} B, magic=${b.subarray(0, 4).toString('latin1')}, CORS=${r.headers.get('access-control-allow-origin')}, type=${r.headers.get('content-type')}\n   ${b.subarray(0, 300).toString('latin1').replace(/[^\x20-\x7e]/g, '.')}`);
    }
  }, 60000);

  it('DGM5-Gelände: Kodierung prüfen (Tübingen Marktplatz, AWS ≈ 338 m)', async () => {
    const lat = 48.52066, lon = 9.05322;
    for (const z of [12, 14, 15, 16]) {
      const n = 2 ** z, fx = ((lon + 180) / 360) * n, r = (lat * Math.PI) / 180;
      const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
      const x = Math.floor(fx), y = Math.floor(fy);
      const url = `https://sg.geodatenzentrum.de/gdz_basemapde_3d_gelaende/dgm5_rgb_tiles/${z}/${x}/${y}.png`;
      try {
        const res = await get(url);
        const b = Buffer.from(await res.arrayBuffer());
        let info = '';
        if (res.ok && b.subarray(1, 4).toString() === 'PNG') {
          const png = decodePng(b);
          const [R, G, B] = png.px(Math.floor((fx - x) * png.w), Math.floor((fy - y) * png.h));
          info = `${png.w}x${png.h} bpp=${png.bpp} RGB=${R},${G},${B} mapbox=${(-10000 + (R * 65536 + G * 256 + B) * 0.1).toFixed(1)} terrarium=${(R * 256 + G + B / 256 - 32768).toFixed(1)}`;
        }
        console.log(`[probe2] DGM z${z}: HTTP ${res.status}, ${b.length} B, CORS=${res.headers.get('access-control-allow-origin')}, ${info}`);
      } catch (e) {
        console.log(`[probe2] DGM z${z}: Fehler ${(e as Error).message}`);
      }
    }
  }, 60000);

  it('Lizenz: basemap.de-3D-Dokumentation', async () => {
    try {
      const res = await fetch('https://sg.geodatenzentrum.de/web_public/gdz/dokumentation/deu/basemap.de_3d.pdf', { signal: AbortSignal.timeout(20000) });
      writeFileSync('/tmp/bm3d.pdf', Buffer.from(await res.arrayBuffer()));
      const txt = execFileSync('pdftotext', ['-layout', '/tmp/bm3d.pdf', '-']).toString();
      console.log('[probe2] PDF-Text (gefiltert):\n' + txt.split('\n').filter((l) => /lizenz|nutzung|quellenvermerk|dl-de|cc.?by|geobasis|©|https?:\/\/|format|b3dm|glb|rgb|kodier|höhe =|elevation/i.test(l)).map((l) => '   ' + l.trim()).join('\n'));
    } catch (e) {
      console.log('[probe2] PDF: Fehler ' + (e as Error).message);
    }
  }, 40000);
});
