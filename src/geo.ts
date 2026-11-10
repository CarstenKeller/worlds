// Geografische Hilfsfunktionen: lokales Koordinatensystem und Web-Mercator-Kacheln.
// Lokales System: Ursprung = Weltmitte, x nach Osten, z nach Süden (three.js: -z = Norden), y = Höhe.

export const EARTH_RADIUS = 6378137; // WGS84-Äquatorradius (wie Web-Mercator)

export interface LatLon {
  lat: number;
  lon: number;
}

export class LocalFrame {
  readonly mPerDegLat: number;
  readonly mPerDegLon: number;
  constructor(readonly center: LatLon) {
    const rad = (center.lat * Math.PI) / 180;
    // Für Radien bis wenige km reicht eine lokale Tangentialebene (Fehler << 1 m).
    this.mPerDegLat = (Math.PI / 180) * EARTH_RADIUS;
    this.mPerDegLon = (Math.PI / 180) * EARTH_RADIUS * Math.cos(rad);
  }
  toLocal(lat: number, lon: number): [number, number] {
    return [(lon - this.center.lon) * this.mPerDegLon, -(lat - this.center.lat) * this.mPerDegLat];
  }
  toLatLon(x: number, z: number): LatLon {
    return { lat: this.center.lat - z / this.mPerDegLat, lon: this.center.lon + x / this.mPerDegLon };
  }
  /** Bounding-Box (Grad) eines Quadrats mit halber Kantenlänge r um die Mitte. */
  bbox(r: number) {
    const dLat = r / this.mPerDegLat;
    const dLon = r / this.mPerDegLon;
    return {
      south: this.center.lat - dLat,
      north: this.center.lat + dLat,
      west: this.center.lon - dLon,
      east: this.center.lon + dLon,
    };
  }
}

/** Kachel-x (gebrochen) für Längengrad bei Zoom z. */
export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

/** Kachel-y (gebrochen) für Breitengrad bei Zoom z. */
export function latToTileY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

export function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export function tileYToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export interface TileRange {
  z: number;
  x0: number;
  y0: number;
  x1: number; // inklusive
  y1: number; // inklusive
}

export function tileRange(b: { south: number; north: number; west: number; east: number }, z: number): TileRange {
  return {
    z,
    x0: Math.floor(lonToTileX(b.west, z)),
    x1: Math.floor(lonToTileX(b.east, z)),
    y0: Math.floor(latToTileY(b.north, z)),
    y1: Math.floor(latToTileY(b.south, z)),
  };
}

export function tileCountPerAxis(t: TileRange): number {
  return Math.max(t.x1 - t.x0 + 1, t.y1 - t.y0 + 1);
}

/**
 * Höchsten Zoom wählen (≤ maxZoom), bei dem die Box höchstens maxPerAxis Kacheln je Achse braucht.
 */
export function chooseZoom(
  b: { south: number; north: number; west: number; east: number },
  maxZoom: number,
  maxPerAxis: number,
  minZoom = 1,
): TileRange {
  for (let z = maxZoom; z > minZoom; z--) {
    const t = tileRange(b, z);
    if (tileCountPerAxis(t) <= maxPerAxis) return t;
  }
  return tileRange(b, minZoom);
}

/** Terrarium-Kodierung (Mapzen/AWS Terrain Tiles): h = R*256 + G + B/256 - 32768. */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Abstand zweier Punkte in Metern (Haversine) – für die Anzeige. */
export function distanceMeters(a: LatLon, b: LatLon): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(s));
}
