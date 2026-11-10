import * as THREE from 'three';
import { Polygon, pointInPolygon, ringBounds } from './util';

/**
 * Ich-Perspektive: Kamera auf Augenhöhe über dem Gelände.
 * Desktop: WASD/Pfeile + Maus (Pointer-Lock), Umschalt = rennen.
 * Touch: linke Bildschirmhälfte = Joystick (gehen), rechte Hälfte = umsehen.
 */
export class Walker {
  yaw = 0;
  pitch = 0;
  eyeHeight = 1.5;
  speed = 1.6; // m/s (Gehen)
  runFactor = 4;
  private keys = new Set<string>();
  private joy = { id: -1, x0: 0, y0: 0, dx: 0, dy: 0 };
  private look = { id: -1, x: 0, y: 0 };
  private grid = new Map<string, Polygon[]>();
  private posts = new Map<string, { x: number; z: number; r: number }[]>();
  private disposers: (() => void)[] = [];
  onJoystick?: (active: boolean, x0: number, y0: number, dx: number, dy: number) => void;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    readonly dom: HTMLElement,
    readonly ground: (x: number, z: number) => number,
    readonly radius: number,
    buildings: Polygon[],
    /** Runde Hindernisse (Baumstämme): Mittelpunkt und Radius inkl. Körperbreite */
    posts: { x: number; z: number; r: number }[] = [],
  ) {
    for (const c of posts) {
      const k = Math.floor(c.x / 10) + ',' + Math.floor(c.z / 10);
      (this.posts.get(k) ?? this.posts.set(k, []).get(k)!).push(c);
    }
    for (const p of buildings) {
      const b = ringBounds(p.outer);
      for (let i = Math.floor(b.minX / 10); i <= Math.floor(b.maxX / 10); i++)
        for (let j = Math.floor(b.minZ / 10); j <= Math.floor(b.maxZ / 10); j++) {
          const k = i + ',' + j;
          (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(p);
        }
    }
    this.bind();
  }

  private on<K extends keyof WindowEventMap>(t: EventTarget, type: K | string, fn: (e: any) => void, opts?: AddEventListenerOptions) {
    t.addEventListener(type, fn, opts);
    this.disposers.push(() => t.removeEventListener(type, fn, opts));
  }

  private bind() {
    const d = this.dom;
    this.on(window, 'keydown', (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input,select,textarea')) return;
      this.keys.add(e.code);
    });
    this.on(window, 'keyup', (e: KeyboardEvent) => this.keys.delete(e.code));
    this.on(window, 'blur', () => this.keys.clear());
    this.on(d, 'click', () => {
      if (matchMedia('(pointer: fine)').matches && document.pointerLockElement !== d) d.requestPointerLock?.();
    });
    this.on(document, 'mousemove', (e: MouseEvent) => {
      if (document.pointerLockElement !== d) return;
      this.turn(e.movementX * 0.0022, e.movementY * 0.0022);
    });
    this.on(d, 'touchstart', (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX < window.innerWidth / 2 && this.joy.id < 0) {
          this.joy = { id: t.identifier, x0: t.clientX, y0: t.clientY, dx: 0, dy: 0 };
          this.onJoystick?.(true, t.clientX, t.clientY, 0, 0);
        } else if (this.look.id < 0) this.look = { id: t.identifier, x: t.clientX, y: t.clientY };
      }
      e.preventDefault();
    }, { passive: false });
    this.on(d, 'touchmove', (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.joy.id) {
          this.joy.dx = t.clientX - this.joy.x0;
          this.joy.dy = t.clientY - this.joy.y0;
          this.onJoystick?.(true, this.joy.x0, this.joy.y0, this.joy.dx, this.joy.dy);
        } else if (t.identifier === this.look.id) {
          this.turn((t.clientX - this.look.x) * 0.005, (t.clientY - this.look.y) * 0.005);
          this.look.x = t.clientX;
          this.look.y = t.clientY;
        }
      }
      e.preventDefault();
    }, { passive: false });
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.joy.id) {
          this.joy.id = -1;
          this.joy.dx = this.joy.dy = 0;
          this.onJoystick?.(false, 0, 0, 0, 0);
        }
        if (t.identifier === this.look.id) this.look.id = -1;
      }
    };
    this.on(d, 'touchend', end);
    this.on(d, 'touchcancel', end);
  }

  private turn(dx: number, dy: number) {
    this.yaw -= dx;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch - dy));
  }

  blocked(x: number, z: number): boolean {
    if (x * x + z * z > (this.radius - 0.5) ** 2) return true;
    const gx = Math.floor(x / 10), gz = Math.floor(z / 10);
    const l = this.grid.get(gx + ',' + gz);
    if (l && l.some((p) => pointInPolygon(x, z, p))) return true;
    // Stämme: auch Nachbarzellen prüfen (Radius kann über die Zellgrenze reichen)
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++)
        for (const c of this.posts.get(gx + i + ',' + (gz + j)) ?? [])
          if ((x - c.x) ** 2 + (z - c.z) ** 2 < c.r * c.r) return true;
    return false;
  }

  setPosition(x: number, z: number) {
    this.camera.position.set(x, this.ground(x, z) + this.eyeHeight, z);
  }

  /** Freien Startpunkt nahe der Mitte suchen (nicht in einem Gebäude). */
  findStart(): [number, number] {
    for (let r = 0; r < this.radius; r += 3)
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        if (!this.blocked(x, z) && !this.blocked(x + 0.4, z) && !this.blocked(x - 0.4, z)) return [x, z];
        if (r === 0) break;
      }
    return [0, 0];
  }

  update(dt: number) {
    let f = 0, s = 0;
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) f += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) f -= 1;
    if (k.has('KeyA')) s -= 1;
    if (k.has('KeyD')) s += 1;
    if (k.has('ArrowLeft')) this.yaw += 1.8 * dt;
    if (k.has('ArrowRight')) this.yaw -= 1.8 * dt;
    let run = k.has('ShiftLeft') || k.has('ShiftRight');
    if (this.joy.id >= 0) {
      const max = 60;
      const jx = Math.max(-1, Math.min(1, this.joy.dx / max)), jy = Math.max(-1, Math.min(1, this.joy.dy / max));
      f -= jy;
      s += jx;
      if (Math.hypot(this.joy.dx, this.joy.dy) > max * 1.6) run = true;
    }
    const len = Math.hypot(f, s);
    if (len > 1) { f /= len; s /= len; }
    const v = this.speed * (run ? this.runFactor : 1) * dt;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    // Blickrichtung (yaw=0) = -z = Norden
    const dx = (-sin * f + cos * s) * v;
    const dz = (-cos * f - sin * s) * v;
    const p = this.camera.position;
    let x = p.x, z = p.z;
    // Achsenweise prüfen: an Wänden entlanggleiten statt hängenbleiben
    if (!this.blocked(x + dx, z)) x += dx;
    if (!this.blocked(x, z + dz)) z += dz;
    const target = this.ground(x, z) + this.eyeHeight;
    // Sanft nachführen, damit Stufen im Gelände nicht ruckeln
    const y = p.y + (target - p.y) * Math.min(1, dt * 12);
    p.set(x, y, z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  dispose() {
    this.disposers.forEach((d) => d());
    this.disposers = [];
    if (document.pointerLockElement === this.dom) document.exitPointerLock();
  }
}
