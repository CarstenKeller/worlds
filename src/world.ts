import * as THREE from 'three';
import { LocalFrame, LatLon, chooseZoom, tileXToLon, tileYToLat } from './geo';
import { HeightField, buildHeightField, loadElevation } from './terrain';
import { OsmData, fetchOsm, parseOsm } from './osm';
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
  minHeight: number;
  maxHeight: number;
}

export interface World {
  group: THREE.Group;
  heightField: HeightField;
  footprints: Polygon[];
  stats: WorldStats;
  dispose(): void;
}

export interface LoadState {
  elevation: [number, number]; // geladen, gesamt
  imagery: [number, number];
  osmHost: string | null; // gerade angefragter Overpass-Server
  osmDone: boolean;
  building: boolean;
}
export type Progress = (s: LoadState) => void;

/** Lädt alle Daten und baut die Szene. Schritte: Gelände, OSM, Bildkacheln, Aufbau. */
export async function createWorld(o: WorldOptions, progress: Progress, signal?: AbortSignal): Promise<World> {
  const frame = new LocalFrame(o.center);
  const half = o.radius + 10;
  const seed = seedFrom(o.center.lat, o.center.lon);

  // Alle drei Quellen gleichzeitig laden; Fortschritt je Quelle melden
  const st: LoadState = { elevation: [0, 1], imagery: [0, 1], osmHost: null, osmDone: false, building: false };
  const report = () => progress({ ...st });
  report();
  const elevP = loadElevation(frame, half, (d, t) => { st.elevation = [d, t]; report(); }, signal);
  let osmError: string | null = null;
  const osmP: Promise<OsmData> = fetchOsm(o.center, o.radius * 1.05, signal, (h) => { st.osmHost = h; report(); })
    .then((els) => parseOsm(frame, els))
    .catch((e) => {
      if ((e as Error).name === 'AbortError') throw e;
      osmError = String((e as Error).message ?? e);
      return { buildings: [], areas: [], lines: [], points: [] } as OsmData;
    })
    .finally(() => { st.osmDone = true; report(); });
  const texP = loadImageryCanvas(frame, half, o, (d, t) => { st.imagery = [d, t]; report(); }, signal);
  const [elev, osm, tex] = await Promise.all([elevP, osmP, texP]);
  const hf = buildHeightField(frame, half, elev.sample);
  // Gelände unter Seen ebnen, bevor Mesh und alles Andere darauf aufbauen
  const waters = carveWater(osm.areas, hf);
  // Bodenfarben aus OSM unter die Kacheln legen (füllt Lücken fehlender Kacheln)
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
  const terrain = new THREE.Mesh(terrainGeo, new THREE.MeshLambertMaterial({ map: texture }));
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
  const b = buildBuildings(buildingsToDraw, hf, o.radius, seed);
  // Kollision: Gesamtumrisse (auch die zerlegten)
  const footprints = b.footprints;
  if (b.walls) group.add(new THREE.Mesh(b.walls, mat()));
  if (b.roofs) group.add(new THREE.Mesh(b.roofs, mat()));
  await nextFrame();

  const lines = buildLines(osm.lines, hf, o.radius);
  if (lines.geometry)
    group.add(new THREE.Mesh(lines.geometry, mat({ polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })));
  const water = buildWater(waters);
  if (water)
    group.add(new THREE.Mesh(water, new THREE.MeshLambertMaterial({ color: '#3f74a3', transparent: true, opacity: 0.88, side: THREE.DoubleSide })));
  const barriers = buildBarriers(osm.lines, hf, o.radius);
  if (barriers) group.add(new THREE.Mesh(barriers, mat()));
  await nextFrame();

  const trees = placeTrees(osm, o.radius, lines.segments, footprints, seed);
  group.add(buildTrees(trees, hf, seed));

  let minH = Infinity, maxH = -Infinity;
  for (const h of hf.h) { if (h < minH) minH = h; if (h > maxH) maxH = h; }

  return {
    group,
    heightField: hf,
    footprints,
    stats: {
      buildings: buildingsToDraw.length,
      trees: trees.length,
      lines: osm.lines.length,
      elevationZoom: elev.zoom,
      imageryZoom: tex.zoom,
      failedImageryTiles: tex.failed,
      failedElevationTiles: elev.failed,
      osmError,
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
