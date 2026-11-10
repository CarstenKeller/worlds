// Erkundung möglicher offener Datenquellen (A-01): Erreichbarkeit, CORS, Inhalt. Nur Protokoll, kein Fehlschlag.
import { describe, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ORIGIN = 'https://carstenkeller.github.io';
const URLS: [string, string][] = [
  ['basemap.de 3D Gebäude 3857', 'https://sgx.geodatenzentrum.de/gdz_basemapde_3d_gebaeude/lod2_3857_null.json'],
  ['basemap.de 3D Gebäude 4978+DGM5', 'https://sgx.geodatenzentrum.de/gdz_basemapde_3d_gebaeude/lod2_4978_dgm5.json'],
  ['basemap.de 3D Gelände RGB', 'https://sgx.geodatenzentrum.de/gdz_basemapde_3d_gelaende/dgm5_3857_rgb.json'],
  ['Meta Canopy tiles.geojson', 'https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/tiles.geojson'],
  ['Terrascope WMTS Capabilities', 'https://services.terrascope.be/wmts/v2?SERVICE=WMTS&REQUEST=GetCapabilities'],
  ['Panoramax Suche', 'https://api.panoramax.xyz/api/search?bbox=9.05,48.51,9.06,48.53&limit=2'],
];

async function probe(label: string, url: string) {
  try {
    const res = await fetch(url, { headers: { Origin: ORIGIN }, signal: AbortSignal.timeout(20000) });
    const buf = Buffer.from(await res.arrayBuffer());
    const head = buf.subarray(0, 600).toString('utf8').replace(/\s+/g, ' ');
    console.log(`[probe] ${label}: HTTP ${res.status}, ${buf.length} B, CORS=${res.headers.get('access-control-allow-origin')}, type=${res.headers.get('content-type')}\n   ${head}`);
  } catch (e) {
    console.log(`[probe] ${label}: Fehler ${(e as Error).message}`);
  }
}

describe('Quellen-Erkundung', () => {
  for (const [l, u] of URLS) it(l, () => probe(l, u), 30000);

  it('basemap.de 3D Dokumentation (Lizenz, URLs)', async () => {
    try {
      const res = await fetch('https://sg.geodatenzentrum.de/web_public/gdz/dokumentation/deu/basemap.de_3d.pdf', { signal: AbortSignal.timeout(20000) });
      writeFileSync('/tmp/bm3d.pdf', Buffer.from(await res.arrayBuffer()));
      const txt = execFileSync('pdftotext', ['-layout', '/tmp/bm3d.pdf', '-']).toString();
      const lines = txt.split('\n').filter((l) => /lizenz|nutzung|quellenvermerk|dl-de|cc ?by|https?:\/\/|cors|format|b3dm|glb|terrain|rgb/i.test(l));
      console.log('[probe] basemap.de_3d.pdf:\n' + lines.map((l) => '   ' + l.trim()).join('\n'));
    } catch (e) {
      console.log('[probe] PDF: Fehler ' + (e as Error).message);
    }
  }, 40000);
});
