// Läuft nur in der CI (npm run test:live): prüft die echten Datenquellen, die aus der
// Entwicklungs-Sandbox nicht erreichbar sind, und protokolliert die Antwortzeiten.
import { describe, expect, it } from 'vitest';
import { LocalFrame } from '../src/geo';
import { loadVectorOsm } from '../src/vectortiles';
import { OVERPASS_ENDPOINTS, buildQuery, parseOsm } from '../src/osm';

const C = { lat: 48.52066, lon: 9.05322 }; // Tübingen, Altstadt
const R = 300;

describe('Live-Datenquellen', () => {
  it('OpenFreeMap liefert Gebäude, Wege und Flächen', async () => {
    const t0 = Date.now();
    const d = await loadVectorOsm(C, R);
    const ms = Date.now() - t0;
    const heights = d.buildings.map((b) => Number(b.tags.height)).filter(Number.isFinite);
    console.log(`[live] OpenFreeMap: ${ms} ms, ${d.buildings.length} Gebäude, ${d.lines.length} Linien, ${d.areas.length} Flächen;`
      + ` Höhen min/max ${Math.min(...heights)}/${Math.max(...heights)};`
      + ` Wegtypen ${[...new Set(d.lines.map((l) => l.tags.highway ?? l.tags.railway ?? l.tags.waterway))].join(',')};`
      + ` Flächentypen ${[...new Set(d.areas.map((a) => Object.entries(a.tags).map((e) => e.join('=')).join('+')))].join(',')}`);
    expect(d.buildings.length).toBeGreaterThan(50);
    expect(d.lines.length).toBeGreaterThan(20);
  }, 60000);

  for (const url of OVERPASS_ENDPOINTS) {
    it(`Overpass ${new URL(url).host} (nur Zeitmessung)`, async () => {
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(buildQuery(C, R, 40)),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: AbortSignal.timeout(45000),
        });
        const text = await res.text();
        let n = -1;
        try { n = parseOsm(new LocalFrame(C), JSON.parse(text).elements).buildings.length; } catch { /* kein JSON */ }
        console.log(`[live] ${url}: HTTP ${res.status}, ${Date.now() - t0} ms, ${text.length} Bytes, ${n} Gebäude`);
      } catch (e) {
        console.log(`[live] ${url}: Fehler nach ${Date.now() - t0} ms: ${(e as Error).message}`);
      }
    }, 50000);
  }
});
