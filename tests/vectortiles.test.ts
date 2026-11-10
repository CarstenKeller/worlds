import { describe, expect, it } from 'vitest';
import { PbfWriter } from 'pbf';
import { LocalFrame, latToTileY, lonToTileX } from '../src/geo';
import { clipRing, decodeTile } from '../src/vectortiles';
import { OsmData } from '../src/osm';

// Minimaler MVT-Encoder (Spezifikation 2.1) nur für Tests
type Feat = { type: 1 | 2 | 3; props: Record<string, string | number>; geom: number[][][] };
const zz = (n: number) => (n << 1) ^ (n >> 31);
function encodeGeom(type: number, rings: number[][][]): number[] {
  const out: number[] = [];
  let cx = 0, cy = 0;
  for (const r of rings) {
    const [x0, y0] = r[0];
    out.push((1 & 7) | (1 << 3), zz(x0 - cx), zz(y0 - cy));
    cx = x0; cy = y0;
    const rest = type === 3 ? r.slice(1) : r.slice(1);
    out.push((2 & 7) | (rest.length << 3));
    for (const [x, y] of rest) { out.push(zz(x - cx), zz(y - cy)); cx = x; cy = y; }
    if (type === 3) out.push((7 & 7) | (1 << 3));
  }
  return out;
}
function encodeTile(layers: Record<string, Feat[]>): Uint8Array {
  const pbf = new PbfWriter();
  for (const [name, feats] of Object.entries(layers)) {
    pbf.writeMessage(3, (_: unknown, p: PbfWriter) => {
      const keys: string[] = [], values: (string | number)[] = [];
      p.writeVarintField(15, 2);
      p.writeStringField(1, name);
      p.writeVarintField(5, 4096);
      for (const f of feats) {
        const tags: number[] = [];
        for (const [k, v] of Object.entries(f.props)) {
          let ki = keys.indexOf(k); if (ki < 0) { ki = keys.length; keys.push(k); }
          let vi = values.indexOf(v); if (vi < 0) { vi = values.length; values.push(v); }
          tags.push(ki, vi);
        }
        p.writeMessage(2, (_: unknown, q: PbfWriter) => {
          q.writePackedVarint(2, tags);
          q.writeVarintField(3, f.type);
          q.writePackedVarint(4, encodeGeom(f.type, f.geom));
        }, null);
      }
      for (const k of keys) p.writeStringField(3, k);
      for (const v of values)
        p.writeMessage(4, (_: unknown, q: PbfWriter) => {
          if (typeof v === 'string') q.writeStringField(1, v); else q.writeDoubleField(3, v);
        }, null);
    }, null);
  }
  return pbf.finish();
}

describe('vectortiles', () => {
  it('beschneidet Ringe auf die Kachel', () => {
    const r = clipRing([{ x: -100, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 50 }, { x: -100, y: 50 }], 4096);
    expect(Math.min(...r.map((p) => p.x))).toBe(0);
    expect(r.length).toBe(4);
  });

  it('dekodiert Gebäude, Wege und Wald', () => {
    const z = 14, lat = 48.52, lon = 9.05;
    const x = Math.floor(lonToTileX(lon, z)), y = Math.floor(latToTileY(lat, z));
    // Uhrzeigersinn in Kachelkoordinaten (y nach unten) = Außenring
    const sq = (x0: number, y0: number, s: number) => [[[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]]];
    const buf = encodeTile({
      building: [
        { type: 3, props: { render_height: 12, render_min_height: 0 }, geom: sq(1000, 1000, 40) },
        { type: 3, props: { render_height: 6 }, geom: sq(-20, 2000, 40) }, // ragt links über den Rand
      ],
      transportation: [
        { type: 2, props: { class: 'minor' }, geom: [[[0, 2048], [4096, 2048]]] },
        { type: 2, props: { class: 'path', subclass: 'footway' }, geom: [[[100, 100], [200, 200]]] },
        { type: 2, props: { class: 'primary', brunnel: 'tunnel' }, geom: [[[0, 0], [10, 10]]] },
      ],
      landcover: [{ type: 3, props: { class: 'wood', subclass: 'forest' }, geom: sq(2500, 2500, 1000) }],
    });
    const frame = new LocalFrame({ lat, lon });
    const out: OsmData = { buildings: [], areas: [], lines: [], points: [] };
    decodeTile(buf, x, y, z, frame, out);
    expect(out.buildings.length).toBe(2);
    expect(out.buildings[0].tags.height).toBe('12');
    expect(out.lines.map((l) => l.tags.highway)).toEqual(['residential', 'footway', 'primary']);
    expect(out.lines[2].tags.tunnel).toBe('yes');
    expect(out.areas[0].tags.landuse).toBe('forest');
    // Kachel z14 ist bei 48,5° ca. 1,6 km breit -> 40 Einheiten ≈ 16 m
    const xs = out.buildings[0].poly.outer.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(12);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(20);
    // beschnittenes Gebäude nur halb so breit
    const xs2 = out.buildings[1].poly.outer.map((p) => p[0]);
    expect(Math.max(...xs2) - Math.min(...xs2)).toBeLessThan(10);
  });
});
