// Kartenquellen für die Bodentextur. {z}/{x}/{y} werden ersetzt, {s} durch eine Subdomain.

export interface ImagerySource {
  id: string;
  label: { de: string; en: string };
  url: string;
  maxZoom: number;
  subdomains?: string[];
  attribution: string;
}

export const IMAGERY_SOURCES: ImagerySource[] = [
  {
    id: 'esri',
    label: { de: 'Satellit (Esri World Imagery)', en: 'Satellite (Esri World Imagery)' },
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 18,
    attribution: 'Esri, Maxar, Earthstar Geographics, GIS User Community',
  },
  {
    id: 'otm',
    label: { de: 'Topografisch / Wanderkarte (OpenTopoMap)', en: 'Topographic / hiking (OpenTopoMap)' },
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: ['a', 'b', 'c'],
    maxZoom: 17,
    attribution: '© OpenTopoMap (CC-BY-SA)',
  },
  {
    id: 'osm',
    label: { de: 'Straßenkarte (OpenStreetMap)', en: 'Street map (OpenStreetMap)' },
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  },
  {
    id: 'none',
    label: { de: 'Keine (nur Bodenfarben)', en: 'None (ground colours only)' },
    url: '',
    maxZoom: 0,
    attribution: '',
  },
  {
    id: 'custom',
    label: { de: 'Eigene XYZ-URL …', en: 'Custom XYZ URL …' },
    url: '',
    maxZoom: 19,
    attribution: '',
  },
];

export const ELEVATION_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const ELEVATION_MAX_ZOOM = 15;
export const ELEVATION_ATTRIBUTION = 'Mapzen / AWS Terrain Tiles';
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

export function tileUrl(template: string, z: number, x: number, y: number, subdomains?: string[]): string {
  const s = subdomains && subdomains.length ? subdomains[(x + y) % subdomains.length] : '';
  return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)).replace('{s}', s);
}

export function loadImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // nötig, damit die Pixel lesbar/als Textur nutzbar sind (CORS)
    img.decoding = 'async';
    const onAbort = () => {
      img.src = '';
      reject(new DOMException('aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    img.onload = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(img);
    };
    img.onerror = () => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error('Kachel nicht ladbar: ' + url));
    };
    img.src = url;
  });
}

/** Führt Aufgaben mit begrenzter Parallelität aus. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}
