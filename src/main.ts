import './style.css';
import * as THREE from 'three';
import { lang, t } from './i18n';
import { ELEVATION_ATTRIBUTION, IMAGERY_SOURCES, OSM_ATTRIBUTION } from './sources';
import { VT_ATTRIBUTION } from './vectortiles';
import { createWorld, LoadState, ViewMode, World } from './world';
import { Walker } from './controls';
import { icon } from './icons';

document.documentElement.lang = lang;
const app = document.getElementById('app')!;

// ---------------------------------------------------------------- Darstellung (Design D-07)
type Theme = 'system' | 'light' | 'dark';
const store = {
  get(k: string): string | null {
    try { return localStorage.getItem('worlds.' + k); } catch { return null; }
  },
  set(k: string, v: string) {
    try { localStorage.setItem('worlds.' + k, v); } catch { /* privat/gesperrt: ignorieren */ }
  },
};
function applyTheme(th: Theme) {
  if (th === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = th;
}
let theme = (store.get('theme') as Theme) || 'system';
applyTheme(theme);

function themeButton(extraClass = ''): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.innerHTML = `<button class="icon-btn tip-left ${extraClass}" type="button" data-tip="${t.theme}" aria-label="${t.theme}" aria-haspopup="menu">${icon('contrast')}</button>`;
  const btn = wrap.querySelector('button')!;
  let menu: HTMLElement | null = null;
  const close = () => { menu?.remove(); menu = null; };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu) return close();
    menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    menu.style.top = '56px';
    menu.style.right = '0';
    for (const [v, label] of [['system', t.themeSystem], ['light', t.themeLight], ['dark', t.themeDark]] as [Theme, string][]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(theme === v));
      b.textContent = label;
      b.onclick = () => { theme = v; store.set('theme', v); applyTheme(v); close(); };
      menu.appendChild(b);
    }
    wrap.appendChild(menu);
    setTimeout(() => document.addEventListener('click', close, { once: true }));
  });
  return wrap;
}

// ---------------------------------------------------------------- Zustand / URL
interface Params { lat: number; lon: number; r: number; src: string; url: string; eye: number }
function readParams(): Params {
  const h = new URLSearchParams(location.hash.slice(1));
  const num = (k: string, d: number) => (h.has(k) && Number.isFinite(parseFloat(h.get(k)!)) ? parseFloat(h.get(k)!) : d);
  const saved = (k: string, d: string) => store.get(k) ?? d;
  return {
    lat: num('lat', parseFloat(saved('lat', '48.52066'))),
    lon: num('lon', parseFloat(saved('lon', '9.05322'))),
    r: num('r', parseFloat(saved('r', '300'))),
    src: h.get('src') ?? saved('src', 'esri'),
    url: saved('url', ''),
    eye: num('eye', parseFloat(saved('eye', '1.5'))),
  };
}
function writeParams(p: Params) {
  const h = new URLSearchParams({ lat: p.lat.toFixed(6), lon: p.lon.toFixed(6), r: String(p.r), src: p.src });
  if (p.eye !== 1.5) h.set('eye', String(p.eye));
  history.replaceState(null, '', '#' + h.toString());
  for (const k of ['lat', 'lon', 'r', 'src', 'url', 'eye'] as const) store.set(k, String(p[k]));
}

// ---------------------------------------------------------------- Auswahl-Bildschirm
let abort: AbortController | null = null;

function showSetup(message?: { text: string; error?: boolean }) {
  const p = readParams();
  app.innerHTML = `
  <main class="setup">
    <div class="topbar"><h1>${t.appTitle}</h1></div>
    <p class="subtitle">${t.subtitle}</p>
    <form class="card" novalidate>
      <div class="row">
        <label>${t.searchLabel}<input name="q" type="search" placeholder="${t.searchPlaceholder}" autocomplete="off" enterkeyhint="search"></label>
        <button class="icon-btn tip-left" type="button" data-act="search" data-tip="${t.search}" aria-label="${t.search}">${icon('search')}</button>
      </div>
      <ul class="results" hidden></ul>
      <div class="row">
        <label>${t.lat}<input name="lat" inputmode="decimal" value="${p.lat}"></label>
        <label>${t.lon}<input name="lon" inputmode="decimal" value="${p.lon}"></label>
        <button class="icon-btn tip-left" type="button" data-act="locate" data-tip="${t.myLocation}" aria-label="${t.myLocation}">${icon('location')}</button>
      </div>
      <label>${t.radius}
        <div class="radius-row">
          <input name="rRange" type="range" min="50" max="2000" step="10" value="${p.r}" aria-label="${t.radius}">
          <input name="r" type="number" min="50" max="2000" step="10" value="${p.r}" inputmode="numeric">
        </div>
      </label>
      <p class="hint">${t.radiusHint}</p>
      <label>${t.imagery}
        <select name="src">${IMAGERY_SOURCES.map((s) => `<option value="${s.id}" ${s.id === p.src ? 'selected' : ''}>${s.label[lang]}</option>`).join('')}</select>
      </label>
      <label data-custom ${p.src === 'custom' ? '' : 'hidden'}>${t.customUrl}<input name="url" type="url" value="${escapeAttr(p.url)}" placeholder="https://…/{z}/{x}/{y}.png"></label>
      <label>${t.eyeHeight}<input name="eye" type="number" min="0.3" max="50" step="0.1" value="${p.eye}" inputmode="decimal"></label>
      <p class="msg ${message?.error ? 'error' : 'warn'}" ${message ? '' : 'hidden'}></p>
      <div class="progress" hidden><span class="step"></span><div class="bar"><div></div></div></div>
      <button class="primary" type="submit">${icon('globe')}<span>${t.create}</span></button>
    </form>
    <p class="sources">${t.sources}: ${ELEVATION_ATTRIBUTION} · ${OSM_ATTRIBUTION} · ${IMAGERY_SOURCES.filter((s) => s.attribution).map((s) => s.attribution).join(' · ')}</p>
  </main>`;
  app.querySelector('.topbar')!.appendChild(themeButton());
  const form = app.querySelector('form')!;
  const msg = form.querySelector('.msg') as HTMLElement;
  if (message) msg.textContent = message.text;
  const f = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  const setMsg = (text: string | null, error = true) => {
    msg.hidden = !text;
    msg.textContent = text ?? '';
    msg.className = 'msg ' + (error ? 'error' : 'warn');
  };
  f('rRange').addEventListener('input', () => (f('r').value = f('rRange').value));
  f('r').addEventListener('input', () => (f('rRange').value = f('r').value));
  f('src').addEventListener('change', () => ((form.querySelector('[data-custom]') as HTMLElement).hidden = f('src').value !== 'custom'));

  // Ortssuche über Nominatim (Nutzungsrichtlinie: nur auf ausdrückliche Anfrage, keine Autovervollständigung)
  const results = form.querySelector('.results') as HTMLUListElement;
  const doSearch = async () => {
    const q = f('q').value.trim();
    if (!q) return;
    setMsg(null);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&accept-language=${lang}&q=${encodeURIComponent(q)}`);
      const list = (await res.json()) as { lat: string; lon: string; display_name: string }[];
      results.innerHTML = '';
      results.hidden = false;
      if (!list.length) results.innerHTML = `<li>${t.noResults}</li>`;
      for (const r of list) {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = r.display_name;
        b.onclick = () => {
          f('lat').value = (+r.lat).toFixed(6);
          f('lon').value = (+r.lon).toFixed(6);
          results.hidden = true;
        };
        li.appendChild(b);
        results.appendChild(li);
      }
    } catch (e) {
      setMsg(String((e as Error).message));
    }
  };
  form.querySelector('[data-act=search]')!.addEventListener('click', doSearch);
  f('q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSearch(); }
  });
  form.querySelector('[data-act=locate]')!.addEventListener('click', () => {
    if (!navigator.geolocation) return setMsg(t.locationDenied);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        f('lat').value = pos.coords.latitude.toFixed(6);
        f('lon').value = pos.coords.longitude.toFixed(6);
        setMsg(null);
      },
      () => setMsg(t.locationDenied), // Design D-05: Verweigerung erklären
      { enableHighAccuracy: true, timeout: 15000 },
    );
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const lat = parseFloat(f('lat').value.replace(',', '.'));
    const lon = parseFloat(f('lon').value.replace(',', '.'));
    const r = Math.min(2000, Math.max(50, Math.round(parseFloat(f('r').value) || 300)));
    const eye = Math.min(50, Math.max(0.3, parseFloat(f('eye').value.replace(',', '.')) || 1.5));
    if (!(Math.abs(lat) <= 85 && Math.abs(lon) <= 180)) return setMsg(t.invalidCoords);
    const params: Params = { lat, lon, r, src: f('src').value, url: f('url').value.trim(), eye };
    writeParams(params);
    await start(params, form, setMsg);
  });
}

function escapeAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ---------------------------------------------------------------- Erstellen + 3D-Ansicht
let renderer: THREE.WebGLRenderer | null = null;
function getRenderer(): THREE.WebGLRenderer {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }
  return renderer;
}

async function start(p: Params, form: HTMLFormElement, setMsg: (t: string | null, error?: boolean) => void) {
  let r: THREE.WebGLRenderer;
  try {
    r = getRenderer();
  } catch {
    return setMsg(t.webglMissing);
  }
  const submit = form.querySelector('button[type=submit]') as HTMLButtonElement;
  const prog = form.querySelector('.progress') as HTMLElement;
  const stepEl = prog.querySelector('.step') as HTMLElement;
  const bar = prog.querySelector('.bar > div') as HTMLElement;
  submit.disabled = true;
  prog.hidden = false;
  setMsg(null);
  abort = new AbortController();
  // Abbrechen-Knopf während des Ladens
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary';
  cancel.textContent = t.cancel;
  cancel.onclick = () => abort?.abort();
  prog.appendChild(cancel);
  const t0 = performance.now();
  let last: LoadState | null = null;
  const render = () => {
    if (!last) return;
    const s = last;
    const sec = Math.round((performance.now() - t0) / 1000);
    const osmLine = `${t.osmLabel} OpenFreeMap ${t.state[s.vt]} · Overpass ${s.osmDone ? t.state.done : t.osmWaiting(s.osmHost ?? '…')}`;
    stepEl.innerHTML = s.building
      ? escapeAttr(t.stepBuild)
      : [
          `${t.stepElevation} ${s.elevation[0]}/${s.elevation[1]}`,
          `${t.stepImagery} ${s.imagery[0]}/${s.imagery[1]}`,
          osmLine,
          `${sec} s`,
        ].map(escapeAttr).join('<br>');
    const f = s.building ? 1 : (s.elevation[0] / s.elevation[1] + s.imagery[0] / Math.max(1, s.imagery[1]) + (s.vt !== 'loading' ? 1 : 0)) / 3;
    bar.style.width = `${Math.min(1, f) * 100}%`;
  };
  const tick = setInterval(render, 1000);
  const src = IMAGERY_SOURCES.find((s) => s.id === p.src) ?? IMAGERY_SOURCES[0];
  try {
    const world = await createWorld(
      { center: { lat: p.lat, lon: p.lon }, radius: p.r, imagery: src, customUrl: p.url, maxTextureSize: r.capabilities.maxTextureSize },
      (s) => { last = s; render(); },
      abort.signal,
    );
    clearInterval(tick);
    const warnings: string[] = [];
    if (world.stats.osmError) warnings.push(t.osmFailed + ` (${world.stats.osmError})`);
    if (world.stats.failedImageryTiles) warnings.push(t.tilesFailed(world.stats.failedImageryTiles));
    if (world.stats.failedElevationTiles) warnings.push(t.elevFailed(world.stats.failedElevationTiles));
    showWorld(world, p, src.attribution || (p.src === 'custom' ? p.url.replace(/^https?:\/\/([^/]+).*/, '$1') : ''), warnings);
  } catch (e) {
    clearInterval(tick);
    cancel.remove();
    submit.disabled = false;
    prog.hidden = true;
    if ((e as Error).name === 'AbortError') setMsg(t.cancelled, false);
    else setMsg(`${t.failed}: ${(e as Error).message ?? e}`);
  }
}

function showWorld(world: World, p: Params, imageryAttribution: string, warnings: string[]) {
  const r = getRenderer();
  app.innerHTML = `
  <div class="view">
    <div class="hud-top">
      <button class="icon-btn tip-right" type="button" data-act="back" data-tip="${t.back}" aria-label="${t.back}">${icon('back')}</button>
      <span class="spacer"></span>
      <button class="icon-btn tip-left" type="button" data-act="layer" aria-pressed="false">${icon('layers')}</button>
      <button class="icon-btn tip-left" type="button" data-act="map" data-tip="${t.minimap}" aria-label="${t.minimap}" aria-pressed="false">${icon('map')}</button>
      <button class="icon-btn tip-left" type="button" data-act="help" data-tip="${t.help}" aria-label="${t.help}" aria-expanded="false">${icon('help')}</button>
    </div>
    <div class="crosshair"></div>
    <div class="center-msg" data-look hidden>${t.clickToLook}</div>
    <div class="center-msg edge-msg" data-edge hidden>${t.edge}</div>
    <div class="joy" hidden><div></div></div>
    <div class="hud-under">
      <div class="hud-panel" data-info></div>
      <div class="hud-panel legend" data-legend hidden>${t.legendReal}</div>
      <canvas class="minimap" width="480" height="480" hidden aria-label="${t.minimap}"></canvas>
      ${warnings.map((w) => `<p class="warn">${escapeAttr(w)} <span aria-hidden="true">✕</span></p>`).join('')}
      <div class="hud-panel" data-helptext hidden></div>
    </div>
    <div class="attribution">${[ELEVATION_ATTRIBUTION, OSM_ATTRIBUTION, world.stats.osmSource === 'openfreemap' ? VT_ATTRIBUTION : '', imageryAttribution].filter(Boolean).join(' · ')}</div>
  </div>`;
  const view = app.querySelector('.view') as HTMLElement;
  view.prepend(r.domElement);
  view.querySelector('.hud-top')!.insertBefore(themeButton(), view.querySelector('[data-act=help]'));

  const scene = new THREE.Scene();
  const sky = new THREE.Color('#a9c8e8');
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, Math.max(150, p.r * 0.8), Math.max(900, p.r * 3.5));
  scene.add(new THREE.HemisphereLight('#dfeeff', '#4a5a3a', 1.6));
  const sun = new THREE.DirectionalLight('#fff4e0', 1.9);
  // Sonne aus Südwesten, ca. 40° hoch; Schatten nur im Umkreis der Kamera (folgt mit)
  const sunDir = new THREE.Vector3(-0.55, 0.85, 0.45).normalize();
  const touchDevice = matchMedia('(pointer: coarse)').matches;
  sun.castShadow = true;
  sun.shadow.mapSize.set(touchDevice ? 1024 : 2048, touchDevice ? 1024 : 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -60;
  sc.right = sc.top = 60;
  sc.near = 1;
  sc.far = 600;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);
  scene.add(world.group);
  // Umland außerhalb der Welt: ebene Fläche im Nebel, damit der Rand nicht im Himmel endet
  const outer = new THREE.Mesh(
    new THREE.RingGeometry(p.r * 0.98, p.r * 8, 64, 1).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ color: '#6f8452' }),
  );
  outer.position.y = world.stats.minHeight - 1;
  scene.add(outer);

  const camera = new THREE.PerspectiveCamera(70, 1, 0.1, Math.max(2500, p.r * 5));
  const walker = new Walker(camera, r.domElement, (x, z) => world.heightField.height(x, z), p.r, world.footprints, world.trunks);
  walker.eyeHeight = p.eye;
  const [sx, sz] = walker.findStart();
  walker.setPosition(sx, sz);

  const touch = matchMedia('(pointer: coarse)').matches;
  const info = view.querySelector('[data-info]') as HTMLElement;
  const look = view.querySelector('[data-look]') as HTMLElement;
  const edge = view.querySelector('[data-edge]') as HTMLElement;
  const helpText = view.querySelector('[data-helptext]') as HTMLElement;
  const joy = view.querySelector('.joy') as HTMLElement;
  const knob = joy.firstElementChild as HTMLElement;
  helpText.textContent = `${touch ? t.helpTouch : t.helpDesktop} · ${t.stats(world.stats.buildings, world.stats.trees)}`
    + (world.stats.osmSource ? ` · ${t.osmSourceLabel(world.stats.osmSource)}` : '');
  // Steuerungshinweis beim Start kurz zeigen; er liegt oben und blockiert keine Eingaben
  helpText.hidden = false;
  setTimeout(() => { if (helpBtn.getAttribute('aria-expanded') !== 'true') helpText.hidden = true; }, 6000);
  // Warnungen bleiben stehen, bis man sie antippt (vorher nach 12 s weg – wurden übersehen)
  const warns = Array.from(view.querySelectorAll('.hud-under .warn')) as HTMLElement[];
  warns.forEach((w) => { w.title = t.tapToClose; w.onclick = () => w.remove(); });
  // Minikarte (Draufsicht, Norden oben) – Wahl bleibt gespeichert
  const mini = view.querySelector('.minimap') as HTMLCanvasElement;
  const mapBtn = view.querySelector('[data-act=map]') as HTMLButtonElement;
  const miniBase = buildMinimapBase(world, mini.width);
  const setMini = (on: boolean) => {
    mini.hidden = !on;
    mapBtn.setAttribute('aria-pressed', String(on));
    store.set('minimap', on ? '1' : '0');
  };
  setMini(store.get('minimap') === '1');
  // Ansicht Echt/Fantasie (A-01)
  const layerBtn = view.querySelector('[data-act=layer]') as HTMLButtonElement;
  const legend = view.querySelector('[data-legend]') as HTMLElement;
  const setView = (mode: ViewMode) => {
    world.setMode(mode);
    const real = mode === 'real';
    layerBtn.setAttribute('aria-pressed', String(real));
    // Tooltip nennt, wohin der Knopf umschaltet
    layerBtn.dataset.tip = real ? t.toFantasy : t.toReal;
    layerBtn.setAttribute('aria-label', layerBtn.dataset.tip);
    legend.hidden = !real;
    store.set('view', mode);
  };
  setView(store.get('view') === 'real' ? 'real' : 'fantasy');
  layerBtn.onclick = () => setView(layerBtn.getAttribute('aria-pressed') === 'true' ? 'fantasy' : 'real');
  mapBtn.onclick = () => setMini(mini.hidden !== false);
  mini.onclick = () => setMini(false);
  look.hidden = touch;
  const helpBtn = view.querySelector('[data-act=help]') as HTMLButtonElement;
  helpBtn.onclick = () => {
    helpText.hidden = !helpText.hidden;
    helpBtn.setAttribute('aria-expanded', String(!helpText.hidden));
  };
  const onLock = () => (look.hidden = touch || document.pointerLockElement === r.domElement);
  document.addEventListener('pointerlockchange', onLock);
  walker.onJoystick = (active, x0, y0, dx, dy) => {
    joy.hidden = !active;
    joy.style.left = x0 + 'px';
    joy.style.top = y0 + 'px';
    const L = Math.hypot(dx, dy), m = Math.min(L, 60) / (L || 1);
    knob.style.transform = `translate(${dx * m}px, ${dy * m}px)`;
  };

  const resize = () => {
    const w = view.clientWidth, h = view.clientHeight;
    r.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  let last = performance.now();
  let infoT = 0;
  r.setAnimationLoop((now) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    walker.update(dt);
    // Schattenausschnitt auf ganze Texel einrasten, sonst flimmern Schattenkanten beim Gehen
    const texel = 120 / sun.shadow.mapSize.x;
    const cx = Math.round(camera.position.x / texel) * texel, cz = Math.round(camera.position.z / texel) * texel;
    sun.target.position.set(cx, camera.position.y, cz);
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 250);
    infoT += dt;
    if (infoT > 0.25) {
      infoT = 0;
      const pos = camera.position;
      const d = Math.hypot(pos.x, pos.z);
      // yaw=0 -> Norden; yaw wächst gegen den Uhrzeigersinn (nach Westen)
      const heading = ((-walker.yaw * 180) / Math.PI % 360 + 360) % 360;
      info.textContent = t.hud(world.heightField.height(pos.x, pos.z), d, t.dirs[Math.round(heading / 45) % 8]);
      edge.hidden = d < p.r - 4;
    }
    if (!mini.hidden) drawMinimap(mini, miniBase, world.half, camera.position.x, camera.position.z, walker.yaw);
    r.render(scene, camera);
  });

  (view.querySelector('[data-act=back]') as HTMLButtonElement).onclick = () => {
    r.setAnimationLoop(null);
    walker.dispose();
    window.removeEventListener('resize', resize);
    document.removeEventListener('pointerlockchange', onLock);
    world.dispose();
    outer.geometry.dispose();
    (outer.material as THREE.Material).dispose();
    r.domElement.remove();
    showSetup();
  };
  // Für automatische Tests/Fehlersuche erreichbar
  (window as unknown as { __worlds: unknown }).__worlds = { world, walker, camera, scene };
}

/** Grundbild der Minikarte: Bodentextur verkleinert, Gebäude dunkel, Kreis als Weltgrenze. */
function buildMinimapBase(world: World, size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.drawImage(world.groundCanvas, 0, 0, size, size);
  const s = size / (2 * world.half);
  g.fillStyle = 'rgba(40,40,45,0.85)';
  for (const f of world.footprints) {
    g.beginPath();
    for (const ring of [f.outer, ...f.holes]) {
      ring.forEach(([x, z], i) => (i ? g.lineTo : g.moveTo).call(g, (x + world.half) * s, (z + world.half) * s));
      g.closePath();
    }
    g.fill('evenodd');
  }
  return c;
}

function drawMinimap(c: HTMLCanvasElement, base: HTMLCanvasElement, half: number, x: number, z: number, yaw: number) {
  const g = c.getContext('2d')!;
  const n = c.width, s = n / (2 * half);
  g.clearRect(0, 0, n, n);
  g.save();
  g.beginPath();
  g.arc(n / 2, n / 2, n / 2 - 2, 0, Math.PI * 2);
  g.clip();
  g.drawImage(base, 0, 0);
  g.restore();
  g.lineWidth = 3;
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.beginPath();
  g.arc(n / 2, n / 2, n / 2 - 2, 0, Math.PI * 2);
  g.stroke();
  // Spieler als Pfeil in Blickrichtung (yaw=0 -> Norden = oben)
  const px = (x + half) * s, pz = (z + half) * s;
  g.save();
  g.translate(px, pz);
  g.rotate(-yaw);
  g.beginPath();
  g.moveTo(0, -18);
  g.lineTo(11, 12);
  g.lineTo(0, 6);
  g.lineTo(-11, 12);
  g.closePath();
  g.fillStyle = '#ff5a36';
  g.strokeStyle = '#ffffff';
  g.lineWidth = 3;
  g.fill();
  g.stroke();
  g.restore();
  g.fillStyle = '#ffffff';
  g.font = 'bold 26px system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText('N', n / 2, 30);
}

showSetup();
