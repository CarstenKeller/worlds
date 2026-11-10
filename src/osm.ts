import { LocalFrame, LatLon } from './geo';
import { Polygon, Pt, Ring, joinRings, openRing, pointInRing, signedArea } from './util';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

type Tags = Record<string, string>;

interface OsmGeomPoint { lat: number; lon: number }
interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Tags;
  geometry?: (OsmGeomPoint | null)[];
  members?: { type: string; role: string; geometry?: (OsmGeomPoint | null)[] }[];
}

export interface AreaFeature { tags: Tags; poly: Polygon }
export interface LineFeature { tags: Tags; line: Pt[] }
export interface PointFeature { tags: Tags; p: Pt }

export interface OsmData {
  buildings: AreaFeature[];
  areas: AreaFeature[]; // Wald, Wasser, Wiese, …
  lines: LineFeature[]; // Straßen, Wege, Bahn, Bäche, Hecken, Zäune, Baumreihen
  points: PointFeature[]; // Einzelbäume
}

export function buildQuery(c: LatLon, r: number): string {
  const a = `(around:${Math.round(r)},${c.lat.toFixed(6)},${c.lon.toFixed(6)})`;
  return `[out:json][timeout:90];
(
  way["building"]${a};
  relation["building"]["type"="multipolygon"]${a};
  way["building:part"]${a};
  way["highway"]${a};
  way["railway"~"^(rail|tram|light_rail|narrow_gauge|subway)$"]${a};
  way["waterway"~"^(river|stream|canal|ditch|drain)$"]${a};
  way["natural"~"^(water|wood|scrub|heath|grassland|tree_row|wetland|sand|beach|bare_rock|scree)$"]${a};
  relation["natural"~"^(water|wood|scrub|heath|grassland|wetland)$"]${a};
  way["landuse"~"^(forest|grass|meadow|orchard|vineyard|farmland|allotments|cemetery|village_green|recreation_ground|residential|industrial|commercial|retail)$"]${a};
  relation["landuse"~"^(forest|grass|meadow|farmland)$"]${a};
  way["leisure"~"^(park|garden|pitch|playground)$"]${a};
  way["amenity"="parking"]${a};
  way["barrier"~"^(hedge|wall|fence|retaining_wall|city_wall)$"]${a};
  way["man_made"~"^(bridge|pier)$"]${a};
  node["natural"="tree"]${a};
);
out geom qt;`;
}

export async function fetchOsm(c: LatLon, r: number, signal?: AbortSignal): Promise<OsmElement[]> {
  const body = 'data=' + encodeURIComponent(buildQuery(c, r));
  let lastErr: unknown;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const json = await res.json();
      return json.elements as OsmElement[];
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('Overpass nicht erreichbar');
}

function toLine(frame: LocalFrame, g: (OsmGeomPoint | null)[] | undefined): Pt[] {
  const out: Pt[] = [];
  for (const p of g ?? []) if (p) out.push(frame.toLocal(p.lat, p.lon));
  return out;
}

const isClosed = (l: Pt[]) =>
  l.length >= 4 && Math.abs(l[0][0] - l[l.length - 1][0]) < 1e-6 && Math.abs(l[0][1] - l[l.length - 1][1]) < 1e-6;

function isAreaTags(t: Tags): boolean {
  return !!(t.natural || t.landuse || t.leisure || t.amenity === 'parking' || t.man_made || t.area === 'yes');
}

/** Ringe einer Multipolygon-Relation: Löcher dem umschließenden äußeren Ring zuordnen. */
function assemble(outers: Ring[], inners: Ring[]): Polygon[] {
  const polys: Polygon[] = outers.map((o) => ({ outer: o, holes: [] }));
  for (const h of inners) {
    const [x, z] = h[0];
    const host = polys.find((p) => pointInRing(x, z, p.outer));
    if (host) host.holes.push(h);
  }
  return polys;
}
/** Overpass-Elemente in lokale Geometrien umwandeln. */
export function parseOsm(frame: LocalFrame, elements: OsmElement[]): OsmData {
  const d: OsmData = { buildings: [], areas: [], lines: [], points: [] };
  for (const e of elements) {
    const tags = e.tags ?? {};
    if (e.type === 'node') {
      if (e.lat !== undefined && e.lon !== undefined) d.points.push({ tags, p: frame.toLocal(e.lat, e.lon) });
      continue;
    }
    if (e.type === 'way') {
      const line = toLine(frame, e.geometry);
      if (line.length < 2) continue;
      const building = tags.building || tags['building:part'];
      if (building && isClosed(line)) {
        const ring = openRing(line);
        if (ring.length >= 3 && Math.abs(signedArea(ring)) > 2) d.buildings.push({ tags, poly: { outer: ring, holes: [] } });
      } else if (isClosed(line) && isAreaTags(tags) && tags.natural !== 'tree_row' && !tags.barrier) {
        d.areas.push({ tags, poly: { outer: openRing(line), holes: [] } });
      } else if (tags.highway && tags.area === 'yes' && isClosed(line)) {
        d.areas.push({ tags, poly: { outer: openRing(line), holes: [] } });
      } else {
        d.lines.push({ tags, line });
      }
      continue;
    }
    // Relation (Multipolygon)
    const outers: Ring[] = [], inners: Ring[] = [];
    for (const m of e.members ?? []) {
      if (m.type !== 'way') continue;
      const l = toLine(frame, m.geometry);
      if (l.length < 2) continue;
      (m.role === 'inner' ? inners : outers).push(l);
    }
    const polys = assemble(joinRings(outers), joinRings(inners));
    for (const poly of polys) {
      if (tags.building) d.buildings.push({ tags, poly });
      else d.areas.push({ tags, poly });
    }
  }
  return d;
}
