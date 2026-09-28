// Gyro v0.1.0 launch film (dark). Deterministic: renderAt(t) fully defines each frame.
const E = {
  lin: p => p,
  io: p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  out: p => 1 - Math.pow(1 - p, 4),
  in: p => p * p * p,
};
const DEF = { x: 960, y: 540, s: 1, o: 1, r: 0, ry: 0, b: 0 };
const K = (t, p = {}, e = 'io') => ({ t, e, ...p });
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const seg = (t, a, b, e = 'out') => E[e](clamp((t - a) / (b - a)));

const stmt = a => [K(a, { x: 200, y: 580, o: 0, b: 10 }), K(a + 0.5, { y: 540, o: 1, b: 0 }, 'out'), K(a + 1.35, { y: 532 }, 'lin'), K(a + 1.75, { y: 490, o: 0, b: 8 }, 'in')];

const SPEC = [
  ['rings', 560, 560, 'c', [K(0, { y: 520, s: 0.85, o: 0 }), K(1.2, { s: 1, o: 0.55 }, 'out'), K(2.9, { s: 1.06 }, 'lin'), K(3.6, { s: 2.8, o: 0 }, 'in')]],
  ['term', null, null, 'c', [K(0.2, { o: 0, y: 560 }), K(0.6, { o: 1, y: 540 }, 'out'), K(3.0), K(3.5, { o: 0, y: 515, b: 6 }, 'in')]],

  ['wChat', null, null, 'c', [K(3.7, { x: 530, y: 520, o: 0, b: 10, s: 1.08 }), K(4.2, { y: 470, o: 1, b: 0, s: 1 }, 'out'), K(6.9, { y: 462 }, 'lin'), K(7.45, { y: 420, o: 0, b: 8 }, 'in')]],
  ['wCli', null, null, 'c', [K(4.3, { x: 975, y: 520, o: 0, b: 10, s: 1.08 }), K(4.8, { y: 470, o: 1, b: 0, s: 1 }, 'out'), K(6.95, { y: 462 }, 'lin'), K(7.5, { y: 420, o: 0, b: 8 }, 'in')]],
  ['wIde', null, null, 'c', [K(4.9, { x: 1405, y: 520, o: 0, b: 10, s: 1.08 }), K(5.4, { y: 470, o: 1, b: 0, s: 1 }, 'out'), K(7.0, { y: 462 }, 'lin'), K(7.55, { y: 420, o: 0, b: 8 }, 'in')]],
  ['inone', null, null, 'c', [K(5.8, { y: 680, o: 0, b: 8 }), K(6.4, { y: 660, o: 1, b: 0 }, 'out'), K(7.0), K(7.5, { o: 0, y: 630 }, 'in')]],

  ['sChat', 1152, 720, 'c', [K(7.6, { y: 600, s: 0.8, o: 0 }), K(8.4, { y: 520, s: 0.85, o: 1 }, 'out'), K(9.6, { s: 0.875 }, 'lin'), K(10.25, { x: 470, y: 520, s: 0.55, ry: 32, o: 0.45 }),
    K(12.9, { x: 480 }, 'lin'), K(13.4, { x: 470, s: 0.55, o: 1 }), K(13.9), K(14.4, { y: 470, o: 0, s: 0.5 }, 'in')]],
  ['sWork', 1152, 720, 'c', [K(9.6, { x: 1560, y: 520, s: 0.7, ry: -34, o: 0 }), K(10.3, { x: 960, s: 0.85, ry: 0, o: 1 }), K(11.3, { s: 0.875 }, 'lin'), K(11.9, { x: 1450, s: 0.55, ry: -32, o: 0.45 }),
    K(12.9, { x: 1440 }, 'lin'), K(13.4, { x: 1450, o: 1 }), K(13.9), K(14.4, { y: 470, o: 0, s: 0.5 }, 'in')]],
  ['sRev', 1152, 720, 'c', [K(11.3, { y: 700, s: 0.78, o: 0 }), K(11.95, { y: 520, s: 0.85, o: 1 }, 'out'), K(12.9, { s: 0.875 }, 'lin'), K(13.4, { s: 0.62 }), K(13.9), K(14.4, { y: 470, o: 0, s: 0.56 }, 'in')]],
  ['tChat', null, null, 'c', [K(8.2, { y: 870, o: 0 }), K(8.7, { y: 860, o: 1 }, 'out'), K(9.35), K(9.7, { o: 0 })]],
  ['tWork', null, null, 'c', [K(10.3, { y: 870, o: 0 }), K(10.7, { y: 860, o: 1 }, 'out'), K(11.05), K(11.35, { o: 0 })]],
  ['tRev', null, null, 'c', [K(11.95, { y: 870, o: 0 }), K(12.35, { y: 860, o: 1 }, 'out'), K(12.7), K(12.95, { o: 0 })]],

  ['agentsT', null, null, 'c', [K(14.3, { y: 205, o: 0, b: 8 }), K(15.0, { y: 190, o: 1, b: 0 }, 'out'), K(18.2, { y: 184 }, 'lin'), K(18.7, { y: 150, o: 0, b: 6 }, 'in')]],
  ['orbit', 1000, 360, 'c', [K(14.5, { y: 650, s: 0.8, o: 0 }), K(15.3, { s: 1, o: 1 }, 'out'), K(18.2), K(18.7, { s: 1.12, o: 0 })]],
  ['hub', 170, 170, 'c', [K(14.5, { y: 650, s: 0.6, o: 0 }), K(15.2, { s: 1, o: 1 }, 'out'), K(18.2), K(18.7, { s: 0.85, o: 0 }, 'in')]],

  ['st1', null, null, 'l', stmt(18.7)],
  ['st2', null, null, 'l', stmt(20.45)],
  ['st3', null, null, 'l', stmt(22.2)],

  ['logo', 150, 150, 'c', [K(24.1, { y: 405, s: 0.6, o: 0, b: 8 }), K(24.9, { s: 1, o: 1, b: 0 }, 'out'), K(27.3, { s: 1.03 }, 'io')]],
  ['wordmark', null, null, 'c', [K(25.0, { y: 625, o: 0, b: 8 }), K(25.65, { y: 605, o: 1, b: 0 }, 'out')]],
  ['cta', null, null, 'c', [K(25.8, { y: 725, o: 0 }), K(26.45, { y: 715, o: 1 }, 'out')]],
];

const els = [];
function prep() {
  for (const [id, w, h, anchor, keys] of SPEC) {
    const el = document.getElementById(id);
    let W = w, H = h;
    if (w != null) { el.style.width = w + 'px'; el.style.height = h + 'px'; }
    else { W = el.offsetWidth; H = el.offsetHeight; }
    let prev = { ...DEF };
    const ks = keys.map(k => { const n = { ...prev, ...k }; prev = n; return n; });
    els.push({ el, W, H, anchor, ks });
  }
}
function sample(ks, t) {
  if (t <= ks[0].t) return ks[0];
  const last = ks[ks.length - 1];
  if (t >= last.t) return last;
  let i = 0;
  while (ks[i + 1].t <= t) i++;
  const a = ks[i], b = ks[i + 1];
  const p = E[b.e]((t - a.t) / (b.t - a.t));
  const o = {};
  for (const k of Object.keys(DEF)) o[k] = a[k] + (b[k] - a[k]) * p;
  return o;
}
function place(el, W, H, anchor, v) {
  if (v.o <= 0.002) { el.style.visibility = 'hidden'; return; }
  el.style.visibility = 'visible';
  const tx = anchor === 'l' ? v.x : v.x - W / 2, ty = v.y - H / 2;
  el.style.transform = `translate(${tx}px,${ty}px) perspective(1800px) rotateY(${v.ry}deg) rotate(${v.r}deg) scale(${v.s})`;
  el.style.opacity = v.o;
  el.style.filter = v.b > 0.05 ? `blur(${v.b}px)` : 'none';
}

// Ring spin: constant, then decelerates to a full stop before the final hold.
function phase(t) {
  const V = 46, T0 = 25.4, D = 1.9;
  if (t <= T0) return V * t;
  const u = Math.min(t, T0 + D) - T0;
  return V * T0 + V * (u - (u * u) / (2 * D));
}

const provs = [];
function renderAt(t) {
  for (const { el, W, H, anchor, ks } of els) place(el, W, H, anchor, sample(ks, t));

  // Rings
  const ph = phase(t);
  const r = document.querySelectorAll('.ring');
  r[0].style.transform = `rotateX(68deg) rotateZ(${ph}deg)`;
  r[1].style.transform = `rotateY(${ph * 0.8}deg) rotateX(18deg)`;
  r[2].style.transform = `rotateY(40deg) rotateX(${ph * 0.6}deg)`;

  // Terminal typing
  const cmd = 'gyro --version';
  const n = Math.floor(clamp((t - 0.75) / 1.0) * cmd.length);
  document.getElementById('typed').textContent = cmd.slice(0, n);
  const typing = t > 0.75 && t < 1.75;
  const caretOn = t < 2.1 && (typing || Math.floor(t * 2.4) % 2 === 0);
  document.getElementById('caret').style.opacity = caretOn ? 1 : 0;
  document.getElementById('out').style.opacity = seg(t, 2.1, 2.3);

  // Provider orbit
  const appearAll = seg(t, 18.1, 18.6, 'in');
  for (let i = 0; i < 6; i++) {
    const el = provs[i];
    const ap = seg(t, 14.8 + i * 0.1, 15.5 + i * 0.1) * (1 - appearAll);
    if (ap <= 0.002) { el.style.visibility = 'hidden'; continue; }
    el.style.visibility = 'visible';
    const th = ((i * 60 + 18 * (t - 14.3)) * Math.PI) / 180 + (1 - ap) * 0.6;
    const rad = 0.55 + 0.45 * ap;
    const z = Math.sin(th);
    const x = 960 + 500 * rad * Math.cos(th), y = 650 + 180 * rad * z;
    const s = (0.78 + 0.22 * (z + 1) / 2) * (0.8 + 0.2 * ap);
    el.style.transform = `translate(${x - 64}px,${y - 64}px) scale(${s})`;
    el.style.opacity = ap * (0.5 + 0.5 * (z + 1) / 2);
    el.style.zIndex = z > 0 ? 5 : 1;
  }
  document.getElementById('hub').style.zIndex = 3;

  // Glow breath, frozen for the final hold
  const g = document.getElementById('glow');
  const d = clamp(t / 27.3);
  g.style.transform = `scale(${1 + 0.06 * Math.sin(d * Math.PI * 3)})`;
  g.style.opacity = 0.7 + 0.3 * seg(t, 23.8, 25.5, 'io');
}

window.renderAt = renderAt;
window.filmReady = (async () => {
  await document.fonts.ready;
  await Promise.all([...document.images].map(i => i.decode().catch(() => {})));
  for (let i = 0; i < 6; i++) provs.push(document.getElementById('p' + i));
  prep();
  renderAt(0);
  return true;
})();
