import { esc, link } from "./components.mjs";
const nav = [
  ["/product/", "Product"],
  ["/providers/", "Providers"],
  ["/docs/", "Docs"],
  ["/changelog/", "Changelog"],
];
const docs = [
  ["/docs/getting-started/", "Getting started"],
  ["/docs/providers/", "Provider setup"],
  ["/docs/local-models/", "Local models"],
  ["/docs/troubleshooting/", "Troubleshooting"],
];
function navLinks(items, path) {
  return items
    .map(
      ([url, title]) =>
        `<a href="${url}"${path === url ? ' aria-current="page"' : ""}>${title}</a>`,
    )
    .join("");
}
export function layout(page) {
  let body = page.body();
  const aliases =
    page.path === "/"
      ? {
          "<h1>": '<h1 id="hero-title">',
          '<section id="product"':
            '<span id="product-title"></span><section id="product"',
          '<section class="home-tools" id="agents">':
            '<section class="home-tools" id="agents"><span id="agents-title" class="anchor-alias"></span><span id="agent-gemini" class="anchor-alias"></span>',
          "<h2>A few things to know.":
            '<h2 id="faq-title">A few things to know.',
          "<h2>Start with one small task.":
            '<h2 id="download-title">Start with one small task.',
        }
      : page.path === "/install/"
        ? {
            "<h2>Before you install":
              '<h2 id="requirements-title">Before you install',
            '<div class="download-box"':
              '<div id="download-title" class="download-box"',
            '<section id="download"': '<section id="download"',
            '<section id="first-launch"':
              '<span id="help-title" class="anchor-alias"></span><section id="first-launch"',
          }
        : {};
  for (const [from, to] of Object.entries(aliases))
    body = body.replace(from, to);
  const headings = [
    ...body.matchAll(/<section id="([^"]+)"[^>]*>\s*<h2>(.*?)<\/h2>/gs),
  ].map((m) => ["#" + m[1], m[2]]);
  return `<!doctype html>
<html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#ffffff"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; connect-src 'self' https://api.github.com; img-src 'self' data:; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'"><title>${esc(page.title)}</title><meta name="description" content="${esc(page.description)}"><link rel="canonical" href="https://usegyro.io${page.path}">${page.noindex ? '<meta name="robots" content="noindex">' : ""}<meta property="og:type" content="website"><meta property="og:title" content="${esc(page.title)}"><meta property="og:description" content="${esc(page.description)}"><meta property="og:url" content="https://usegyro.io${page.path}"><meta property="og:image" content="https://usegyro.io/assets/social-preview.png"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(page.title)}"><meta name="twitter:description" content="${esc(page.description)}"><meta name="twitter:image" content="https://usegyro.io/assets/social-preview.png"><link rel="icon" href="/assets/gyro-mark.png"><link rel="preload" href="/assets/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin><link rel="preload" href="/assets/fonts/inter-tight-latin.woff2" as="font" type="font/woff2" crossorigin><script src="/theme.js"></script><link rel="stylesheet" href="/styles.css"><script type="module" src="/app.js"></script>${["/", "/product/"].includes(page.path) ? '<script type="module" src="/motion.js"></script>' : ""}</head>
<body class="${page.layout || "standard"}-page"><a class="skip-link" href="#main">Skip to content</a><header class="site-header"><div class="header-inner"><a class="brand" href="/" aria-label="Gyro home"><img src="/assets/gyro-mark.png" width="28" height="28" alt=""><span>Gyro</span></a><nav class="desktop-nav" aria-label="Main navigation">${navLinks(nav, page.path)}</nav><div class="header-actions">${link("https://github.com/wytzeh197/Gyro", "GitHub", "github-link")}<button class="theme-toggle" data-theme-toggle aria-label="Switch to dark theme" type="button"><span aria-hidden="true">◐</span></button>${link("/install/", "Download", "button compact primary")}<details class="mobile-menu"><summary>Menu</summary><nav aria-label="Mobile navigation">${navLinks(nav, page.path)}${link("https://github.com/wytzeh197/Gyro", "GitHub")}</nav></details></div></div></header>
<main id="main" class="shell">${page.layout === "docs" ? `<div class="docs-layout"><aside class="docs-sidebar"><nav aria-label="Documentation">${navLinks(docs, page.path)}</nav>${headings.length ? `<nav aria-label="On this page"><strong>On this page</strong>${navLinks(headings, page.path)}</nav>` : ""}</aside><article class="reading">${body}</article></div>` : body}</main>
<footer class="site-footer"><div class="shell"><div class="footer-grid"><div><a class="brand" href="/"><img src="/assets/gyro-mark.png" width="28" height="28" alt=""><span>Gyro</span></a><p>Your AI coding tools.<br>One workspace.</p><p class="muted">Open source. Built for macOS.</p></div><nav aria-label="Product links"><strong>Product</strong>${navLinks([...nav, ["/install/", "Install"]], page.path)}</nav><nav aria-label="Project links"><strong>Project</strong>${link("/about/", "About")}${link("https://github.com/wytzeh197/Gyro", "Source")}${link("https://github.com/wytzeh197/Gyro/blob/main/SUPPORT.md", "Support")}${link("https://github.com/wytzeh197/Gyro/security", "Security")}</nav><nav aria-label="Legal links"><strong>Details</strong>${link("/privacy/", "Privacy &amp; Legal")}${link("https://github.com/wytzeh197/Gyro/blob/main/LICENSE", "License")}${link("/assets/ATTRIBUTIONS.md", "Attributions")}</nav></div><p class="footer-note">Public alpha. Keep a backup and start with a safe project.</p></div></footer></body></html>`;
}
