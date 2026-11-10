// Zweite OSM-Quelle: Vektorkacheln von OpenFreeMap (OpenMapTiles-Schema, CDN, ohne Schlüssel).
// Schneller und zuverlässiger als die öffentlichen Overpass-Server, aber weniger Details:
// keine Einzelbäume, Hecken, Zäune, Dachformen; Gebäudehöhe als render_height.
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { LocalFrame, LatLon, tileRange, tileXToLon, tileYToLat } from './geo';
import { AreaFeature, LineFeature, OsmData } from './osm';
import { Pt, Ring, openRing, signedArea } from './util';

export const OPENFREEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet';
export const VT_ZOOM = 14; // höchste Zoomstufe des Schemas; enthält Gebäude
export const VT_ATTRIBUTION = 'OpenFreeMap © OpenMapTiles';

type Tags = Record<string, string>;
type P = { x: number; y: number };

/** Ring auf das Rechteck [0,e]² beschneiden (Sutherland-Hodgman), damit Kachelpuffer nicht doppelt zählt. */
export function clipRing(ring: P[], e: number): P[] {
  let pts = ring;
  const edges: [(p: P) => boolean, (a: P, b: P) => P][] = [
    [(p) => p.x >= 0, (a, b) => ({ x: 0, y: a.y + ((b.y - a.y) * (0 - a.x)) / (b.x - a.x) })],
    [(p) => p.x <= e, (a, b) => ({ x: e, y: a.y + ((b.y - a.y) * (e - a.x)) / (b.x - a.x) })],
    [(p) => p.y >= 0, (a, b) => ({ x: a.x + ((b.x - a.x) * (0 - a.y)) / (b.y - a.y), y: 0 })],
    [(p) => p.y <= e, (a, b) => ({ x: a.x + ((b.x - a.x) * (e - a.y)) / (b.y - a.y), y: e })],
  ];
  for (const [inside, cut] of edges) {
    if (!pts.length) break;
    const out: P[] = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i], prev = pts[(i + pts.length - 1) % pts.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) {
        if (!pi) out.push(cut(prev, cur));
        out.push(cur);
      } else if (pi) out.push(cut(prev, cur));
    }
    pts = out;
  }
  return pts;
}

function transportTags(p: Record<string, unknown>): Tags | null {
  const cls = String(p.class ?? '');
  const sub = String(p.subclass ?? '');
  const t: Tags = {};
  if (p.brunnel === 'tunnel') t.tunnel = 'yes';
  if (p.brunnel === 'bridge') t.bridge = 'yes';
  if (p.surface === 'unpaved') t.surface = 'unpaved';
  if (p.surface === 'paved') t.surface = 'paved';
  const roads: Record<string, string> = {
    motorway: 'motorway', trunk: 'trunk', primary: 'primary', secondary: 'secondary', tertiary: 'tertiary',
    minor: 'residential', service: 'service', track: 'track', raceway: 'raceway', busway: 'busway',
  };
  if (roads[cls]) t.highway = sub === 'living_street' || sub === 'pedestrian' ? sub : roads[cls];
  else if (cls === 'path') t.highway = /^(footway|cycleway|steps|bridleway|pedestrian|path)$/.test(sub) ? sub : 'path';
  else if (/^(rail|transit)$/.test(cls)) t.railway = sub || 'rail';
  else return null;
  return t;
}

function areaTags(layer: string, p: Record<string, unknown>): Tags | null {
  const cls = String(p.class ?? '');
  const sub = String(p.subclass ?? '');
  if (layer === 'water') return cls === 'swimming_pool' ? null : { natural: 'water' };
  if (layer === 'landcover') {
    if (cls === 'wood') return sub === 'forest' ? { landuse: 'forest' } : { natural: 'wood' };
    if (cls === 'grass') return sub === 'scrub' ? { natural: 'scrub' } : sub === 'heath' ? { natural: 'heath' } : { landuse: 'grass' };
    if (cls === 'farmland') return sub === 'orchard' ? { landuse: 'orchard' } : sub === 'vineyard' ? { landuse: 'vineyard' } : { landuse: 'farmland' };
    if (cls === 'sand') return { natural: 'sand' };
    if (cls === 'wetland') return { natural: 'wetland' };
    if (cls === 'rock') return { natural: 'bare_rock' };
    return null;
  }
  if (layer === 'landuse') {
    if (/^(residential|industrial|commercial|retail|cemetery|allotments)$/.test(cls)) return { landuse: cls };
    if (/^(pitch|playground|garden)$/.test(cls)) return { leisure: cls };
    return null;
  }
  if (layer === 'park') return { leisure: 'park' };
  return null;
}

/** Eine Kachel (PBF) in lokale Geometrien umwandeln. */
export function decodeTile(buf: ArrayBuffer | Uint8Array, x: number, y: number, z: number, frame: LocalFrame, out: OsmData) {
  const tile = new VectorTile(new PbfReader(buf instanceof Uint8Array ? buf : new Uint8Array(buf)));
  for (const name of ['building', 'transportation', 'water', 'waterway', 'landcover', 'landuse', 'park']) {
    const layer = tile.layers[name];
    if (!layer) continue;
    const e = layer.extent;
    const toLocal = (p: P): Pt => frame.toLocal(tileYToLat(y + p.y / e, z), tileXToLon(x + p.x / e, z));
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      const props = f.properties as Record<string, unknown>;
      if (f.type === 2) {
        let tags: Tags | null = null;
        if (name === 'transportation') tags = transportTags(props);
        else if (name === 'waterway' && props.brunnel !== 'tunnel') tags = { waterway: String(props.class ?? 'stream') };
        if (!tags) continue;
        for (const line of f.loadGeometry()) if (line.length >= 2) out.lines.push({ tags, line: line.map(toLocal) } as LineFeature);
        continue;
      }
      if (f.type !== 3) continue;
      let tags: Tags | null;
      if (name === 'building') {
        if (props.hide_3d) continue; // Umriss, dessen Teile (building:part) separat kommen
        tags = { building: 'yes' };
        if (props.render_height !== undefined) tags.height = String(props.render_height);
        if (props.render_min_height) tags.min_height = String(props.render_min_height);
      } else tags = areaTags(name, props);
      if (!tags) continue;
      for (const poly of classifyRings(f.loadGeometry())) {
        const rings: Ring[] = [];
        for (const r of poly) {
          const c = clipRing(r, e);
          if (c.length >= 3) rings.push(openRing(c.map(toLocal)));
        }
        if (!rings.length || Math.abs(signedArea(rings[0])) < 1) continue;
        const feat: AreaFeature = { tags, poly: { outer: rings[0], holes: rings.slice(1) } };
        (name === 'building' ? out.buildings : out.areas).push(feat);
      }
    }
  }
}

let tileTemplate: Promise<string> | null = null;
async function getTemplate(signal?: AbortSignal): Promise<string> {
  // Die TileJSON nennt die aktuelle Datenversion im Kachelpfad
  tileTemplate ??= fetch(OPENFREEMAP_TILEJSON, { signal })
    .then((r) => {
      if (!r.ok) throw new Error('TileJSON HTTP ' + r.status);
      return r.json();
    })
    .then((j: { tiles: string[] }) => j.tiles[0]);
  try {
    return await tileTemplate;
  } catch (e) {
    tileTemplate = null;
    throw e;
  }
}

export async function loadVectorOsm(center: LatLon, r: number, signal?: AbortSignal): Promise<OsmData> {
  const frame = new LocalFrame(center);
  const tpl = await getTemplate(signal);
  const t = tileRange(frame.bbox(r), VT_ZOOM);
  const out: OsmData = { buildings: [], areas: [], lines: [], points: [] };
  const jobs: Promise<void>[] = [];
  for (let y = t.y0; y <= t.y1; y++)
    for (let x = t.x0; x <= t.x1; x++)
      jobs.push(
        fetch(tpl.replace('{z}', String(VT_ZOOM)).replace('{x}', String(x)).replace('{y}', String(y)), { signal })
          .then((res) => {
            if (res.status === 204 || res.status === 404) return null; // leere Kachel (z. B. Meer)
            if (!res.ok) throw new Error('Kachel HTTP ' + res.status);
            return res.arrayBuffer();
          })
          .then((buf) => { if (buf) decodeTile(buf, x, y, VT_ZOOM, frame, out); }),
      );
  await Promise.all(jobs);
  return out;
}
