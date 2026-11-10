import { describe, expect, it } from 'vitest';
import { sunDirection, sunPosition } from '../src/details';

describe('Sonnenstand', () => {
  it('Sommeranfang, Mittag am Nullmeridian/Äquator: Sonne ~66,6° hoch im Norden', () => {
    const p = sunPosition(new Date(Date.UTC(2024, 5, 21, 12, 2)), 0, 0);
    expect(p.elevation).toBeGreaterThan(65.5);
    expect(p.elevation).toBeLessThan(67.5);
    expect(Math.min(p.azimuth, 360 - p.azimuth)).toBeLessThan(5);
  });
  it('Tübingen, 1. Juli 14:00 MESZ: ~63,6° hoch, leicht westlich von Süden', () => {
    const p = sunPosition(new Date(Date.UTC(2024, 6, 1, 12, 0)), 48.52, 9.05);
    expect(p.elevation).toBeGreaterThan(62);
    expect(p.elevation).toBeLessThan(65);
    expect(p.azimuth).toBeGreaterThan(185);
    expect(p.azimuth).toBeLessThan(210);
  });
  it('Richtung: Süden = +z, Osten = +x', () => {
    const s = sunDirection(180, 0), e = sunDirection(90, 0);
    expect(s.z).toBeCloseTo(1);
    expect(e.x).toBeCloseTo(1);
  });
});
