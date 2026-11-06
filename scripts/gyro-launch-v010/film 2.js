// Gyro v0.1.0 launch film. Orbital motion system: every actor lives in 3D world space,
// moves along continuous parametric paths, and is projected with perspective + depth of field.
// renderAt(t) is pure: the same t always gives the same frame.

const DEG = Math.PI / 180;
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, p) => a + (b - a) * p;
const E = {
  lin: p => p,
  io: p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  out: p => 1 - Math.pow(1 - p, 4),
  out5: p => 1 - Math.pow(1 - p, 5),
  in: p => p * p * p,
  sine: p => 0.5 - 0.5 * Math.cos(Math.PI * p),
};
const seg = (t, a, b, e = 'out') => E[e](clamp((t - a) / (b - a)));
// Piecewise keyed scalar: keys = [[t, v, ease], ...]
function kv(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [ta, va] = keys[i], [tb, vb, e = 'io'] = keys[i + 1];
    if (t < tb) return lerp(va, vb, E[e]((t - ta) / (tb - ta)));
  }
  return keys[keys.length - 1][1];
}
// Damped spring 0 -> 1 with a gentle overshoot.
const spring = u => (u <= 0 ? 0 : 1 - Math.exp(-6.5 * u) * Math.cos(10 * u));

// Integrate an angular-speed function into an angle table (deterministic).
function integrate(speed, T = 30, dt = 1 / 600) {
  const n = Math.ceil(T / dt) + 1, a = new Float64Array(n);
  for (let i = 1; i < n; i++) a[i] = a[i - 1] + speed((i - 0.5) * dt) * dt;
  return t => { const x = clamp(t, 0, T) / dt, i = Math.floor(x); return i >= n - 1 ? a[n - 1] : a[i] + (a[i + 1] - a[i]) * (x - i); };
}

// ---------- Camera ----------
const F = 2400, CX = 960, CY = 560;
const FREEZE = 26.6; // everything is still from here to 30s
// Slow global time that decelerates to a stop at FREEZE (for drifts).
const slow = integrate(t => (t < FREEZE - 2.2 ? 1 : clamp((FREEZE - t) / 2.2)));
function cam(t) {
  const s = slow(t);
  return { yaw: 5 * Math.sin(0.23 * s) * DEG + kv([[0, 0], [16.2, 0], [17.4, 6 * DEG], [20.4, -4 * DEG, 'sine'], [22.4, 0]], t), pitch: 0 };
}
function project(p, c) {
  const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw);
  const x = p.x * cy - p.z * sy, z = p.x * sy + p.z * cy, y = p.y;
  const k = F / (F + z);
  return { sx: CX + x * k, sy: CY + y * k, k, z };
}
// Orbit in the XZ plane, tilted toward camera by alpha, optionally rolled on screen by gamma.
function orbit(theta, R, alpha, gamma = 0) {
  const x0 = R * Math.cos(theta), s = Math.sin(theta);
  let x = x0, y = -R * s * Math.sin(alpha), z = R * s * Math.cos(alpha);
  if (gamma) { const cg = Math.cos(gamma), sg = Math.sin(gamma); [x, y] = [x * cg - y * sg, x * sg + y * cg]; }
  return { x, y, z };
}
const mix = (a, b, p) => ({ x: lerp(a.x, b.x, p), y: lerp(a.y, b.y, p), z: lerp(a.z, b.z, p) });
const dof = z => clamp((Math.abs(z) - 260) / 700) * 5.5;

function put(el, pr, { w, h, s = 1, o = 1, blur = null, ry = 0, zi = null, focus = 0 }) {
  if (o <= 0.003 || pr.k <= 0) { el.style.visibility = 'hidden'; return; }
  el.style.visibility = 'visible';
  const sc = pr.k * s, b = blur == null ? dof(pr.z - focus) : blur;
  el.style.transform = `translate(${pr.sx - w / 2}px,${pr.sy - h / 2}px) perspective(1600px) rotateY(${ry}deg) scale(${sc})`;
  el.style.opacity = o;
  el.style.filter = b > 0.08 ? `blur(${b.toFixed(2)}px)` : 'none';
  el.style.zIndex = zi == null ? String(2000 - Math.round(pr.z)) : String(zi);
}

// ---------- Providers ----------
const SCATTER = [
  { x: -660, y: -290, z: 150 }, { x: 640, y: -300, z: -160 }, { x: -700, y: 250, z: -200 },
  { x: 700, y: 260, z: 300 }, { x: -260, y: 380, z: 520 }, { x: 300, y: -400, z: 650 },
];
const provSpin = integrate(t => {
  // fast swirl as they are captured, settling to a calm orbit; spin-up again for the final collapse
  const capture = 95 * Math.exp(-Math.max(0, t - 4.0) * 1.6) * (t > 3.9 ? 1 : 0);
  const collapse = t > 20.4 ? 40 + 420 * E.in(clamp((t - 20.4) / 2.0)) : 0;
  return (t > 20.4 ? collapse : 17 + capture) * DEG;
});
function provPos(i, t) {
  const s = slow(t);
  const base = SCATTER[i];
  const drift = { x: base.x + 46 * Math.sin(0.55 * s + i * 1.7), y: base.y + 34 * Math.cos(0.47 * s + i * 2.3), z: base.z + 90 * Math.sin(0.33 * s + i) };
  const R = kv([[4.0, 980], [6.0, 500, 'out'], [7.7, 500], [9.3, 800, 'io'], [10.4, 800], [11.3, 1500, 'in']], t);
  const alpha = kv([[7.7, 21 * DEG], [9.3, 12 * DEG]], t) ;
  const th = provSpin(t) + i * 60 * DEG - 30 * DEG;
  const orb = orbit(th, R, alpha);
  orb.y += kv([[7.7, 40], [9.3, 30]], t);
  const w = E.io(clamp((t - 4.05 - i * 0.11) / 1.35));
  let p = mix(drift, orb, w), o, s2 = lerp(1.18, 1, w), label = 1 - clamp((t - 3.9) / 0.4);
  o = seg(t, 0.15 + i * 0.16, 0.95 + i * 0.16) * (1 - seg(t, 10.5, 11.2, 'in'));
  if (t >= 20.3) {
    // return for the collapse: come in from wide, spiral into the core
    const Rc = kv([[20.3, 1250], [22.3, 0, 'in']], t);
    const q = orbit(provSpin(t) + i * 60 * DEG, Rc, 24 * DEG);
    p = q; o = seg(t, 20.3, 20.9) * (1 - seg(t, 21.95, 22.35, 'lin')); s2 = lerp(1, 0.35, seg(t, 21.2, 22.35, 'in')); label = 0;
  }
  return { p, o, s: s2, label };
}

// ---------- Product carousel ----------
const CARDS = [{ w: 1100, h: 607, s: 0.56 }, { w: 560, h: 792, s: 0.6 }, { w: 960, h: 358, s: 0.56 }];
const STEPS = [12.45, 13.95];
function carouselStep(t) { return STEPS.reduce((a, ts) => a + E.io(clamp((t - ts) / 0.75)), 0); }
function cardPos(j, t) {
  const emerge = E.out(clamp((t - 10.6 - j * 0.12) / 1.1));
  const leave = E.in(clamp((t - 15.75 - (2 - j) * 0.06) / 0.85));
  const R = 760 * emerge + 900 * leave;
  const th = (-90 + 120 * j - 120 * carouselStep(t) + 3 * Math.sin(slow(t) * 0.8)) * DEG - (1 - emerge) * 70 * DEG;
  const p = orbit(th, R, 7 * DEG);
  p.y += -105 - 260 * leave; p.z += 500 * leave;
  const ry = -34 * Math.cos(th);
  const front = Math.max(0, -Math.sin(th));
  const o = clamp(emerge * 1.6) * (1 - leave) * (0.72 + 0.28 * front);
  return { p, o, ry, s: CARDS[j].s * lerp(0.35, 1, emerge) };
}

// ---------- Trust chips ----------
const CH = [
  { R: 560, a: 16, g: -18, ph: 0 }, { R: 640, a: -22, g: 24, ph: 55 }, { R: 600, a: 30, g: 2, ph: 120 },
  { R: 690, a: -14, g: -32, ph: 185 }, { R: 620, a: 24, g: 34, ph: 245 }, { R: 700, a: -28, g: 12, ph: 300 },
];
const chipSpin = integrate(t => (t > 20.3 ? 30 + 460 * E.in(clamp((t - 20.3) / 2.0)) : 30 + 70 * Math.exp(-Math.max(0, t - 16.6) * 1.4)) * DEG);
function chipPos(k, t) {
  const c = CH[k];
  const enter = E.out(clamp((t - 16.6 - k * 0.1) / 1.2));
  const col = E.in(clamp((t - 20.5) / 1.85));
  const R = c.R * enter * (1 - col);
  const p = orbit(chipSpin(t) + c.ph * DEG, R, c.a * DEG, c.g * DEG);
  const o = clamp(enter * 1.5) * (1 - seg(t, 21.9, 22.3, 'lin'));
  return { p, o, s: lerp(0.5, 1, enter) * lerp(1, 0.4, col) };
}

// ---------- Typography ----------
const TXT = {
  t1: { x: 960, y: 540, in: 0.35, out: 3.55 },
  t2: { x: 960, y: 175, in: 5.0, out: 7.45, st: 0.06 },
  t3: { x: 960, y: 170, in: 8.85, out: 10.45 },
  q0: { x: 960, y: 985, in: 11.55, out: 12.35 },
  q1: { x: 960, y: 985, in: 13.15, out: 13.85 },
  q2: { x: 960, y: 985, in: 14.65, out: 15.7 },
  t4: { x: 960, y: 560, in: 16.75, out: 20.35, zi: 2000 },
  wordmark: { x: 960, y: 610, in: 23.75, out: 99, st: 0.12 },
  cta: { x: 960, y: 725, in: 24.35, out: 99, st: 0.1 },
};
function renderText(t) {
  for (const id in TXT) {
    const d = TXT[id], el = d.el;
    const q = E.in(clamp((t - d.out) / 0.45));
    if (t < d.in - 0.01 || q >= 1) { el.style.visibility = 'hidden'; continue; }
    el.style.visibility = 'visible';
    el.style.zIndex = d.zi || 5000;
    el.style.transform = `translate(${d.x - d.W / 2}px,${d.y - d.H / 2 - q * 34}px)`;
    el.style.opacity = 1 - q;
    el.style.filter = q > 0.02 ? `blur(${q * 7}px)` : 'none';
    d.words.forEach((w, i) => {
      const p = E.out5(clamp((t - d.in - i * (d.st || 0.075)) / 0.7));
      w.style.opacity = p;
      w.style.transform = `translateY(${(1 - p) * 0.42}em)`;
      w.style.filter = p < 0.98 ? `blur(${(1 - p) * 9}px)` : 'none';
    });
  }
}

// ---------- Frame ----------
const $ = id => document.getElementById(id);
let P, C, K, APP, APPLOGO, APPSHOT, BLOOM, ENDLOGO, DOTS;

function renderAt(t) {
  const c = cam(t);

  // Providers
  for (let i = 0; i < 6; i++) {
    const v = provPos(i, t), pr = project(v.p, c);
    put(P[i], pr, { w: 124, h: 124, s: v.s, o: v.o });
    P[i].lastChild.style.opacity = v.label;
  }

  // Hub -> app window
  {
    const pop = spring(clamp((t - 3.95) / 1.1) * 1.1);
    const grow = E.out5(clamp((t - 7.7) / 1.45));
    const recede = E.in(clamp((t - 10.35) / 1.0));
    const W = lerp(170, 1280 * 0.72, grow), H = lerp(170, 720 * 0.72, grow);
    APP.style.width = W + 'px'; APP.style.height = H + 'px';
    APP.style.borderRadius = lerp(42, 12, grow) + 'px';
    APPLOGO.style.opacity = 1 - clamp(grow * 2.2);
    APPSHOT.style.opacity = clamp(grow * 2 - 0.5);
    const pos = { x: 0, y: lerp(40, 30, grow), z: 1700 * recede };
    const pr = project(pos, c);
    put(APP, pr, { w: W, h: H, s: pop, o: clamp(pop * 3) * (1 - recede), ry: -c.yaw / DEG * 0.8, blur: recede * 6 });
  }

  // Carousel
  for (let j = 0; j < 3; j++) {
    const v = cardPos(j, t), pr = project(v.p, c);
    put(C[j], pr, { w: CARDS[j].w, h: CARDS[j].h, s: v.s, o: v.o, ry: v.ry, focus: -700 });
  }

  // Chips
  for (let k = 0; k < 6; k++) {
    const v = chipPos(k, t), pr = project(v.p, c);
    const el = K[k];
    put(el, pr, { w: el._w, h: el._h, s: v.s, o: v.o });
  }

  // Core bloom + end logo
  {
    const pop = spring(clamp((t - 22.3) / 1.2) * 1.15);
    const up = E.io(clamp((t - 23.1) / 1.15));
    const y = lerp(540, 405, up);
    const flash = Math.exp(-Math.max(0, t - 22.35) * 2.2) * (t > 22.1 ? 1 : 0);
    const bl = 0.8 * seg(t, 21.2, 22.35, 'in') * (0.55 + 0.45 * flash) * (1 - 0.35 * up);
    BLOOM.style.visibility = bl > 0.003 ? 'visible' : 'hidden';
    BLOOM.style.transform = `translate(${960 - 450}px,${y - 450}px) scale(${0.6 + 0.5 * bl})`;
    BLOOM.style.opacity = bl; BLOOM.style.zIndex = 10;
    if (pop <= 0.001) ENDLOGO.style.visibility = 'hidden';
    else {
      ENDLOGO.style.visibility = 'visible';
      ENDLOGO.style.transform = `translate(${960 - 75}px,${y - 75}px) scale(${pop}) rotate(${(1 - clamp(pop)) * -90}deg)`;
      ENDLOGO.style.opacity = clamp(pop * 2); ENDLOGO.style.zIndex = 4000;
    }
  }

  // Background parallax
  DOTS.style.transform = `translate(${-c.yaw / DEG * 14 - 30 * slow(t) / 26}px,${-12 * slow(t) / 26}px)`;

  renderText(t);
}

window.renderAt = renderAt;
window.filmReady = (async () => {
  await document.fonts.ready;
  await Promise.all([...document.images].map(i => i.decode().catch(() => {})));
  P = [0, 1, 2, 3, 4, 5].map(i => $('p' + i));
  C = [0, 1, 2].map(i => $('c' + i));
  K = [0, 1, 2, 3, 4, 5].map(i => $('k' + i));
  CARDS.forEach((d, j) => { C[j].style.width = d.w + 'px'; C[j].style.height = d.h + 'px'; });
  K.forEach(el => { el._w = el.offsetWidth; el._h = el.offsetHeight; });
  APP = $('app'); APPLOGO = APP.querySelector('.logo'); APPSHOT = APP.querySelector('.shot');
  BLOOM = $('bloom'); ENDLOGO = $('endLogo'); DOTS = $('dots');
  for (const id in TXT) {
    const d = TXT[id]; d.el = $(id); d.el.style.visibility = 'visible';
    d.W = d.el.offsetWidth; d.H = d.el.offsetHeight; d.words = [...d.el.querySelectorAll('.w')];
    d.el.style.visibility = 'hidden';
  }
  renderAt(0);
  const q = new URLSearchParams(location.search);
  if (q.has('play')) { const t0 = performance.now(); const loop = () => { renderAt(((performance.now() - t0) / 1000) % 30); requestAnimationFrame(loop); }; loop(); }
  return true;
})();
