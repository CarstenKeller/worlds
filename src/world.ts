import * as THREE from 'three';
import { LocalFrame, LatLon, chooseZoom, tileXToLon, tileYToLat } from './geo';
import { HeightField, buildHeightField, loadElevation } from './terrain';
import { OsmData, fetchOsm, parseOsm } from './osm';
import { loadVectorOsm } from './vectortiles';
import { addDetail, detailTexture, facadeTexture, makeRoofSampler } from './materials';
import { ImagerySource, loadImage, pool, tileUrl } from './sources';
import {
  buildBarriers, buildBuildings, buildLines, buildTrees, buildWater, carveWater, paintGround, placeTrees,
} from './builders';
import { Polygon, pointInPolygon, ringBounds, seedFrom } from './util';

export interface WorldOptions {
  center: LatLon;
  radius: number;
  imagery: ImagerySource;
  customUrl?: string;
  maxTextureSize: number;
}

export interface WorldStats {
  buildings: number;
  trees: number;
  lines: number;
  elevationZoom: number;
  imageryZoom: number | null;
  failedImageryTiles: number;
  failedElevationTiles: number;
  osmError: string | null;
  osmSource: 'overpass' | 'openfreemap' | null;
  minHeight: number;
  maxHeight: number;
}

export interface World {
  group: THREE.Group;
  heightField: HeightField;
  footprints: Polygon[];
  /** Baumstämme für die Kollision */
  trunks: { x: number; z: number; r: number }[];
  /** Bodentextur (Draufsicht) für die Minikarte; deckt [-half, half]² ab */
  groundCanvas: HTMLCanvasElement;
  half: number;
  stats: WorldStats;
  dispose(): void;
}

export interface LoadState {
  elevation: [number, number]; // geladen, gesamt
  imagery: [number, number];
  osmHost: string | null; // gerade angefragter Overpass-Server
  osmDone: boolean; // Overpass fertig (Erfolg oder aufgegeben)
  vt: 'loading' | 'ok' | 'error'; // OpenFreeMap-Vektorkacheln
  building: boolean;
}
export type Progress = (s: LoadState) => void;

/** Lädt alle Daten und baut die Szene. Schritte: Gelände, OSM, Bildkacheln, Aufbau. */
export async function createWorld(o: WorldOptions, progress: Progress, signal?: AbortSignal): Promise<World> {
  const frame = new LocalFrame(o.center);
  const half = o.radius + 10;
  const seed = seedFrom(o.center.lat, o.center.lon);

  // Alle drei Quellen gleichzeitig laden; Fortschritt je Quelle melden
  const st: LoadState = { elevation: [0, 1], imagery: [0, 1], osmHost: null, osmDone: false, vt: 'loading', building: false };
  const report = () => progress({ ...st });
  report();
  const elevP = loadElevation(frame, half, (d, t) => { st.elevation = [d, t]; report(); }, signal);
  const osmP = loadOsmData(frame, o, st, report, signal);
  const texP = loadImageryCanvas(frame, half, o, (d, t) => { st.imagery = [d, t]; report(); }, signal);
  const [elev, osmRes, tex] = await Promise.all([elevP, osmP, texP]);
  const osm = osmRes.data;
  const osmError = osmRes.error;
  const hf = buildHeightField(frame, half, elev.sample);
  // Gelände unter Seen ebnen, bevor Mesh und alles Andere darauf aufbauen
  const waters = carveWater(osm.areas, hf);
  // Bodenfarben aus OSM unter die Kacheln legen (füllt Lücken fehlender Kacheln)
  // Dachfarben aus dem Luftbild, bevor die Bodenfarben die Lücken füllen
  const roofColorAt = tex.zoom !== null ? makeRoofSampler(tex.canvas, half) : undefined;
  const gctx = tex.canvas.getContext('2d')!;
  gctx.globalCompositeOperation = 'destination-over';
  paintGround(gctx, tex.canvas.width, half, osm.areas);
  gctx.globalCompositeOperation = 'source-over';
  st.building = true;
  report();

  await nextFrame();
  const group = new THREE.Group();
  const terrainGeo = hf.buildMesh(o.radius);
  const texture = new THREE.CanvasTexture(tex.canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  const detail = detailTexture();
  const terrainMat = new THREE.MeshLambertMaterial({ map: texture });
  addDetail(terrainMat, detail, 0.35, 0.45, 70);
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.receiveShadow = true;
  terrain.name = 'terrain';
  group.add(terrain);

  const mat = (opts: THREE.MeshLambertMaterialParameters = {}) =>
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, ...opts });

  // Gebäude: Umrisse überspringen, wenn sie in building:part-Teile zerlegt sind
  const parts = osm.buildings.filter((b) => b.tags['building:part'] && !b.tags.building);
  const partCenters = parts.map((p) => {
    const b = ringBounds(p.poly.outer);
    return [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2] as [number, number];
  });
  const buildingsToDraw = osm.buildings.filter(
    (b) => !(b.tags.building && partCenters.some(([x, z]) => pointInPolygon(x, z, b.poly))) || b.tags['building:part'],
  );
  const b = buildBuildings(buildingsToDraw, hf, o.radius, seed, roofColorAt);
  // Kollision: Gesamtumrisse (auch die zerlegten)
  const footprints = b.footprints;
  const solid = (g: THREE.BufferGeometry, m: THREE.Material) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  };
  if (b.walls) solid(b.walls, mat({ map: facadeTexture() }));
  if (b.plainWalls) solid(b.plainWalls, mat());
  if (b.roofs) solid(b.roofs, mat());
  await nextFrame();

  const lines = buildLines(osm.lines, hf, o.radius);
  if (lines.geometry) {
    const roadMat = mat({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    addDetail(roadMat, detail, 0.6, 0.55, 50);
    const roads = new THREE.Mesh(lines.geometry, roadMat);
    roads.receiveShadow = true;
    group.add(roads);
  }
  const water = buildWater(waters);
  if (water)
    group.add(new THREE.Mesh(water, new THREE.MeshLambertMaterial({ color: '#3f74a3', transparent: true, opacity: 0.88, side: THREE.DoubleSide })));
  const barriers = buildBarriers(osm.lines, hf, o.radius);
  if (barriers) solid(barriers, mat());
  await nextFrame();

  const trees = placeTrees(osm, o.radius, lines.segments, footprints, seed);
  const treeGroup = buildTrees(trees, hf, seed);
  treeGroup.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
  group.add(treeGroup);

  let minH = Infinity, maxH = -Infinity;
  for (const h of hf.h) { if (h < minH) minH = h; if (h > maxH) maxH = h; }

  return {
    group,
    heightField: hf,
    footprints,
    // Stammradius wie in buildTrees (0,2 m × Höhe/12) plus ~0,3 m Körperbreite; Büsche bleiben begehbar
    trunks: trees.filter((t) => !t.bush).map((t) => ({ x: t.x, z: t.z, r: 0.2 * (t.h / 12) + 0.3 })),
    groundCanvas: tex.canvas,
    half,
    stats: {
      buildings: buildingsToDraw.length,
      trees: trees.length,
      lines: osm.lines.length,
      elevationZoom: elev.zoom,
      imageryZoom: tex.zoom,
      failedImageryTiles: tex.failed,
      failedElevationTiles: elev.failed,
      osmError,
      osmSource: osmRes.source,
      minHeight: minH,
      maxHeight: maxH,
    },
    dispose() {
      group.traverse((obj) => {
        const m = obj as THREE.Mesh;
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        for (const mt of mats) {
          (mt as THREE.MeshLambertMaterial).map?.dispose();
          mt.dispose();
        }
      });
    },
  };
}

const EMPTY = (): OsmData => ({ buildings: [], areas: [], lines: [], points: [] });
/** Wartezeit auf Overpass, wenn die Vektorkacheln schon da sind. */
export const OVERPASS_BUDGET_MS = 30000;

/**
 * OSM-Daten aus zwei Quellen: OpenFreeMap-Vektorkacheln (schnell, weniger Details) und
 * Overpass (alle Details, aber die öffentlichen Server sind oft überlastet).
 * Overpass gewinnt, wenn es innerhalb des Zeitbudgets antwortet; sonst gelten die Vektorkacheln.
 */
async function loadOsmData(
  frame: LocalFrame, o: WorldOptions, st: LoadState, report: () => void, signal?: AbortSignal,
): Promise<{ data: OsmData; source: 'overpass' | 'openfreemap' | null; error: string | null }> {
  const t0 = performance.now();
  const ovCtl = new AbortController();
  const stopOv = () => ovCtl.abort();
  signal?.addEventListener('abort', stopOv, { once: true });
  let ovError: string | null = null;
  const ovP = fetchOsm(o.center, o.radius * 1.05, ovCtl.signal, (h) => { st.osmHost = h; report(); }, 25000)
    .then((els) => parseOsm(frame, els))
    .catch((e) => { ovError = String((e as Error).message ?? e); return null; })
    .finally(() => { st.osmDone = true; report(); });
  let vtError: string | null = null;
  const vt = await loadVectorOsm(o.center, o.radius * 1.05, signal)
    .catch((e) => {
      if (signal?.aborted) throw e;
      vtError = String((e as Error).message ?? e);
      return null;
    });
  st.vt = vt ? 'ok' : 'error';
  report();
  try {
    if (vt) {
      const left = OVERPASS_BUDGET_MS - (performance.now() - t0);
      const ov = await Promise.race([ovP, new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, left)))]);
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      if (ov) return { data: ov, source: 'overpass', error: null };
      ovCtl.abort();
      return { data: vt, source: 'openfreemap', error: null };
    }
    const ov = await ovP;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (ov) return { data: ov, source: 'overpass', error: null };
    return { data: EMPTY(), source: null, error: `OpenFreeMap: ${vtError}; Overpass: ${ovError}` };
  } finally {
    signal?.removeEventListener('abort', stopOv);
  }
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

async function loadImageryCanvas(
  frame: LocalFrame, half: number, o: WorldOptions, progress: (done: number, total: number) => void, signal?: AbortSignal,
): Promise<{ canvas: HTMLCanvasElement; zoom: number | null; failed: number }> {
  const template = o.imagery.id === 'custom' ? (o.customUrl ?? '') : o.imagery.url;
  const maxSize = Math.min(4096, o.maxTextureSize);
  if (!template) {
    progress(1, 1);
    return { canvas: makeCanvas(Math.min(maxSize, 2048)), zoom: null, failed: 0 };
  }
  const t = chooseZoom(frame.bbox(half), o.imagery.maxZoom, 16);
  // Auflösung der Kacheln (m/Pixel) bestimmt die Canvasgröße
  const mpp = (156543.03392 * Math.cos((o.center.lat * Math.PI) / 180)) / 2 ** t.z;
  const size = Math.max(512, Math.min(maxSize, Math.ceil((2 * half) / mpp)));
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d')!;
  const s = size / (2 * half);
  const tiles: [number, number][] = [];
  for (let y = t.y0; y <= t.y1; y++) for (let x = t.x0; x <= t.x1; x++) tiles.push([x, y]);
  let done = 0, failed = 0;
  progress(0, tiles.length);
  await pool(tiles, 8, async ([x, y]) => {
    try {
      const img = await loadImage(tileUrl(template, t.z, x, y, o.imagery.subdomains), signal);
      // Kachelecken exakt umrechnen (jede Kachel einzeln -> Mercator-Verzerrung vernachlässigbar)
      const [x0, z0] = frame.toLocal(tileYToLat(y, t.z), tileXToLon(x, t.z));
      const [x1, z1] = frame.toLocal(tileYToLat(y + 1, t.z), tileXToLon(x + 1, t.z));
      // +0.5 px Überlappung gegen feine Nähte
      ctx.drawImage(img, (x0 + half) * s - 0.25, (z0 + half) * s - 0.25, (x1 - x0) * s + 0.5, (z1 - z0) * s + 0.5);
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      failed++;
    }
    progress(++done, tiles.length);
  });
  return { canvas, zoom: t.z, failed };
}

function makeCanvas(size: number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}
