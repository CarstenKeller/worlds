import { describe, expect, it } from 'vitest';
import { LocalFrame, chooseZoom, decodeTerrarium, latToTileY, lonToTileX, tileXToLon, tileYToLat, distanceMeters } from '../src/geo';
import { densify, joinRings, parseMeters, pointInPolygon, signedArea } from '../src/util';
import { HeightField } from '../src/terrain';
import { parseOsm, buildQuery } from '../src/osm';
import { estimateHeight, roadStyle } from '../src/builders';

describe('geo', () => {
  it('rechnet lokal <-> lat/lon zurück', () => {
    const f = new LocalFrame({ lat: 48.5, lon: 9.05 });
    const [x, z] = f.toLocal(48.501, 9.052);
    const p = f.toLatLon(x, z);
    expect(p.lat).toBeCloseTo(48.501, 9);
    expect(p.lon).toBeCloseTo(9.052, 9);
    expect(z).toBeLessThan(0); // Norden = -z
    expect(x).toBeGreaterThan(0); // Osten = +x
  });
  it('lokale Distanz passt zu Haversine (<0,1 %)', () => {
    const f = new LocalFrame({ lat: 50, lon: 8 });
    const [x, z] = f.toLocal(50.01, 8.015);
    const d = distanceMeters({ lat: 50, lon: 8 }, { lat: 50.01, lon: 8.015 });
    expect(Math.abs(Math.hypot(x, z) - d) / d).toBeLessThan(0.001);
  });
  it('Kachelumrechnung ist invers', () => {
    expect(tileXToLon(lonToTileX(9.05, 15), 15)).toBeCloseTo(9.05, 9);
    expect(tileYToLat(latToTileY(48.5, 15), 15)).toBeCloseTo(48.5, 9);
  });
  it('wählt Zoom nach Kachelzahl', () => {
    const f = new LocalFrame({ lat: 48.5, lon: 9.05 });
    const t = chooseZoom(f.bbox(310), 18, 16);
    expect(t.z).toBe(18);
    const big = chooseZoom(f.bbox(2010), 18, 16);
    expect(big.z).toBeLessThan(18);
    expect(Math.max(big.x1 - big.x0, big.y1 - big.y0) + 1).toBeLessThanOrEqual(16);
  });
  it('dekodiert Terrarium', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    expect(decodeTerrarium(129, 44, 128)).toBeCloseTo(300.5, 6);
  });
});

describe('util', () => {
  it('Punkt im Polygon mit Loch', () => {
    const poly = { outer: [[0, 0], [10, 0], [10, 10], [0, 10]] as [number, number][], holes: [[[4, 4], [6, 4], [6, 6], [4, 6]] as [number, number][]] };
    expect(pointInPolygon(2, 2, poly)).toBe(true);
    expect(pointInPolygon(5, 5, poly)).toBe(false);
    expect(pointInPolygon(12, 5, poly)).toBe(false);
  });
  it('verbindet Teilwege zu Ringen', () => {
    const rings = joinRings([
      [[0, 0], [10, 0]],
      [[10, 10], [10, 0]], // umgedreht
      [[10, 10], [0, 10], [0, 0]],
    ]);
    expect(rings.length).toBe(1);
    expect(Math.abs(signedArea(rings[0]))).toBeCloseTo(100);
  });
  it('liest Meterangaben', () => {
    expect(parseMeters('12')).toBe(12);
    expect(parseMeters('7,5 m')).toBe(7.5);
    expect(parseMeters('30 ft')).toBeUndefined();
    expect(parseMeters(undefined)).toBeUndefined();
  });
  it('unterteilt Linien', () => {
    const d = densify([[0, 0], [10, 0]], 3);
    expect(d.length).toBe(5);
    expect(d[d.length - 1]).toEqual([10, 0]);
  });
});

describe('HeightField', () => {
  it('Interpolation trifft Gitterpunkte und ist innerhalb der Dreiecke linear', () => {
    const n = 3;
    const h = new Float32Array([0, 1, 2, 1, 2, 3, 2, 3, 10]);
    const hf = new HeightField(n, 10, h);
    expect(hf.height(-10, -10)).toBeCloseTo(0);
    expect(hf.height(0, 0)).toBeCloseTo(2);
    expect(hf.height(10, 10)).toBeCloseTo(10, 2);
    // Zelle (1,1): a=2 b=3 c=3 d=10, Punkt auf Diagonale b–c -> 3
    expect(hf.height(5, 5)).toBeCloseTo(3);
  });
  it('Mesh enthält nur Dreiecke im Kreis', () => {
    const n = 21;
    const hf = new HeightField(n, 100, new Float32Array(n * n));
    const g = hf.buildMesh(50);
    const idx = g.getIndex()!;
    const pos = g.getAttribute('position');
    for (let i = 0; i < idx.count; i++) {
      const k = idx.getX(i);
      expect(Math.hypot(pos.getX(k), pos.getZ(k))).toBeLessThan(50 + 2 * hf.step);
    }
    expect(idx.count).toBeGreaterThan(0);
  });
});

describe('osm', () => {
  it('Abfrage nutzt ein Rechteck um die Position', () => {
    const q = buildQuery({ lat: 48.5, lon: 9.05 }, 300);
    const m = /\[bbox:([-0-9.]+),([-0-9.]+),([-0-9.]+),([-0-9.]+)\]/.exec(q)!;
    const [s, w, n, e] = m.slice(1).map(Number);
    expect((n - s) * 111320).toBeCloseTo(600, 0);
    expect((e - w) * 111320 * Math.cos((48.5 * Math.PI) / 180)).toBeCloseTo(600, 0);
    expect(q).toContain('out geom');
    expect(q).not.toContain('around');
  });
  it('ordnet Elemente zu', () => {
    const f = new LocalFrame({ lat: 48.5, lon: 9.05 });
    const sq = (d: number) => [
      { lat: 48.5, lon: 9.05 }, { lat: 48.5, lon: 9.05 + d }, { lat: 48.5 + d, lon: 9.05 + d }, { lat: 48.5 + d, lon: 9.05 }, { lat: 48.5, lon: 9.05 },
    ];
    const d = parseOsm(f, [
      { type: 'way', id: 1, tags: { building: 'house' }, geometry: sq(0.0002) },
      { type: 'way', id: 2, tags: { highway: 'residential' }, geometry: [{ lat: 48.5, lon: 9.05 }, { lat: 48.501, lon: 9.05 }] },
      { type: 'way', id: 3, tags: { landuse: 'forest' }, geometry: sq(0.002) },
      { type: 'node', id: 4, lat: 48.5001, lon: 9.0501, tags: { natural: 'tree' } },
      {
        type: 'relation', id: 5, tags: { type: 'multipolygon', natural: 'water' },
        members: [
          { type: 'way', role: 'outer', geometry: sq(0.001).slice(0, 3) },
          { type: 'way', role: 'outer', geometry: sq(0.001).slice(2) },
        ],
      },
    ]);
    expect(d.buildings.length).toBe(1);
    expect(d.lines.length).toBe(1);
    expect(d.areas.length).toBe(2);
    expect(d.points.length).toBe(1);
  });
});

describe('builders', () => {
  it('schätzt Gebäudehöhen', () => {
    expect(estimateHeight({ building: 'yes', height: '20' }).height).toBe(20);
    expect(estimateHeight({ building: 'yes', 'building:levels': '4' }).height).toBe(12);
    expect(estimateHeight({ building: 'garage' }).height).toBeLessThan(4);
    const r = estimateHeight({ building: 'house', 'building:levels': '2', 'roof:shape': 'gabled' });
    expect(r.roofHeight).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(6);
  });
  it('Wegbreiten und Tunnel', () => {
    expect(roadStyle({ highway: 'primary' })!.width).toBeGreaterThan(roadStyle({ highway: 'footway' })!.width);
    expect(roadStyle({ highway: 'primary', tunnel: 'yes' })).toBeNull();
    expect(roadStyle({ highway: 'track', width: '4' })!.width).toBe(4);
    expect(roadStyle({ building: 'yes' })).toBeNull();
  });
});
