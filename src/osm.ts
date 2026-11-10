import { LocalFrame, LatLon } from './geo';
import { Polygon, Pt, Ring, joinRings, openRing, pointInRing, signedArea } from './util';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
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

/** Rechteck (Grad) um die Mitte; Overpass filtert damit deutlich schneller als mit around. */
export function queryBox(c: LatLon, r: number) {
  const dLat = r / 111320;
  const dLon = r / (111320 * Math.cos((c.lat * Math.PI) / 180));
  return { s: c.lat - dLat, w: c.lon - dLon, n: c.lat + dLat, e: c.lon + dLon };
}

export function buildQuery(c: LatLon, r: number, serverTimeout = 50): string {
  const b = queryBox(c, r);
  const bbox = [b.s, b.w, b.n, b.e].map((v) => v.toFixed(6)).join(',');
  // Globale [bbox:…] statt (around:…) je Zeile: gemessen 2026-11-10 war around auf einem
  // öffentlichen Server schon für Gebäude allein > 80 s langsam.
  return `[out:json][timeout:${serverTimeout}][bbox:${bbox}];
(
  way["building"];
  relation["building"]["type"="multipolygon"];
  way["building:part"];
  way["highway"];
  way["railway"~"^(rail|tram|light_rail|narrow_gauge|subway)$"];
  way["waterway"~"^(river|stream|canal|ditch|drain|riverbank)$"];
  way["natural"~"^(water|wood|scrub|heath|grassland|tree_row|wetland|sand|beach|bare_rock|scree)$"];
  relation["natural"~"^(water|wood|scrub|heath|grassland|wetland)$"];
  way["landuse"~"^(forest|grass|meadow|orchard|vineyard|farmland|allotments|cemetery|village_green|recreation_ground|residential|industrial|commercial|retail|reservoir|basin)$"];
  relation["landuse"~"^(forest|grass|meadow|farmland)$"];
  way["leisure"~"^(park|garden|pitch|playground)$"];
  way["amenity"="parking"];
  way["barrier"~"^(hedge|wall|fence|retaining_wall|city_wall)$"];
  way["man_made"~"^(bridge|pier)$"];
  node["natural"="tree"];
);
out geom qt;`;
}

/** Ein Endpunkt nach dem anderen, je mit eigenem Zeitlimit; Abbruch durch den Nutzer bricht alles ab. */
export async function fetchOsm(
  c: LatLon, r: number, signal?: AbortSignal, onTry?: (host: string) => void, perServerMs = 60000,
): Promise<OsmElement[]> {
  const body = 'data=' + encodeURIComponent(buildQuery(c, r, Math.round(perServerMs / 1000) - 5));
  const errors: string[] = [];
  for (const url of OVERPASS_ENDPOINTS) {
    const host = new URL(url).host;
    onTry?.(host);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), perServerMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      // Overpass meldet Zeitüberschreitung teils als 200 mit "remark"
      if (json.remark && /timed out|out of memory/i.test(json.remark) && !json.elements?.length) throw new Error(json.remark);
      return json.elements as OsmElement[];
    } catch (e) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      errors.push(`${host}: ${ctl.signal.aborted ? 'Zeitlimit' : (e as Error).message}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  throw new Error(errors.join('; '));
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
