import {
  CHANGELOG_RELEASES_API,
  RELEASES_PAGE,
  fetchGitHubJson,
  formatPublishedDate,
  isPublicAlphaRelease,
  isPublicStableRelease,
  releaseAnchor,
  renderReleaseNotes,
} from "./release-utils.js";

const ALPHA_GROUP_ID = "alpha";

const list = document.querySelector("[data-changelog-list]");
const rail = document.querySelector("[data-version-rail]");
const jump = document.querySelector("[data-version-jump]");
const status = document.querySelector("[data-changelog-status]");
const fallback = document.querySelector("[data-changelog-fallback]");

// "v0.1.0-alpha.49.7" reads as "Alpha 49.7" in the group summary.
function alphaLabel(tag) {
  return tag.replace(/^v0\.1\.0-alpha\./i, "Alpha ");
}

function appendLink(target, href, text) {
  const link = document.createElement("a");
  link.href = href;
  link.textContent = text;
  target.append(link);
}

function byNewest(a, b) {
  return (
    new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
  );
}

function renderRelease(release, kicker) {
  const article = document.createElement("article");
  article.className = "release-entry";
  article.id = releaseAnchor(release.tag_name);

  const header = document.createElement("header");
  const label = document.createElement("p");
  label.className = "release-kicker";
  label.textContent = kicker;
  const title = document.createElement("h2");
  title.textContent = release.name || release.tag_name;
  const meta = document.createElement("p");
  meta.className = "release-entry-meta";
  meta.textContent = formatPublishedDate(release.published_at);
  header.append(label, title, meta);

  const notes = document.createElement("div");
  notes.className = "release-notes-content";
  renderReleaseNotes(notes, release.body, { skipFirstHeading: true });

  const github = document.createElement("a");
  github.className = "text-link";
  github.href = release.html_url;
  github.textContent = "View on GitHub";

  article.append(header, notes, github);
  return article;
}

// Every alpha sits under one collapsed heading so the page leads with final
// releases instead of dozens of preview builds.
function renderAlphaGroup(alphas) {
  const group = document.createElement("details");
  group.className = "release-group";
  group.id = ALPHA_GROUP_ID;

  const summary = document.createElement("summary");
  const heading = document.createElement("span");
  heading.className = "release-group-heading";
  const label = document.createElement("span");
  label.className = "release-kicker";
  label.textContent = "Public alpha";
  const title = document.createElement("span");
  title.className = "release-group-title";
  title.textContent = "v0.1.0 Alpha";
  const meta = document.createElement("span");
  meta.className = "release-entry-meta";
  const newest = alphas[0];
  const oldest = alphas[alphas.length - 1];
  const range =
    alphas.length > 1
      ? `${formatPublishedDate(oldest.published_at)} – ${formatPublishedDate(newest.published_at)}`
      : formatPublishedDate(newest.published_at);
  meta.textContent = `${alphas.length} ${alphas.length === 1 ? "release" : "releases"} · latest ${alphaLabel(newest.tag_name)} · ${range}`;
  heading.append(label, title, meta);
  summary.append(heading);

  const entries = document.createElement("div");
  entries.className = "release-group-entries";
  for (const [index, release] of alphas.entries()) {
    entries.append(
      renderRelease(release, index === 0 ? "Latest alpha" : "Public alpha"),
    );
  }

  group.append(summary, entries);
  return group;
}

// Opens the alpha group when a link or the page URL points inside it, so
// shared links to a single alpha still land on that release.
function revealHashTarget() {
  const id = decodeURIComponent(window.location.hash.slice(1));
  if (!id) return;
  const target = document.getElementById(id);
  const group = target?.closest(".release-group");
  if (!group) return;
  group.open = true;
  target.scrollIntoView();
}

async function loadChangelog() {
  if (!list || !rail || !jump) return;
  try {
    const response = await fetchGitHubJson(CHANGELOG_RELEASES_API);
    const releases = Array.isArray(response) ? response : [];
    const stable = releases.filter(isPublicStableRelease).sort(byNewest);
    const alphas = releases.filter(isPublicAlphaRelease).sort(byNewest);
    if (!stable.length && !alphas.length) {
      throw new Error("No public releases found");
    }

    list.replaceChildren();
    rail.replaceChildren();
    jump.replaceChildren();
    for (const [index, release] of stable.entries()) {
      const href = `#${releaseAnchor(release.tag_name)}`;
      appendLink(rail, href, release.tag_name);
      appendLink(jump, href, release.tag_name);
      list.append(renderRelease(release, index === 0 ? "Latest" : "Release"));
    }
    if (alphas.length) {
      appendLink(rail, `#${ALPHA_GROUP_ID}`, "Alpha");
      appendLink(jump, `#${ALPHA_GROUP_ID}`, "Alpha");
      list.append(renderAlphaGroup(alphas));
    }
    const total = stable.length + alphas.length;
    if (status) status.textContent = `${total} releases`;
    if (fallback) fallback.hidden = true;
    window.addEventListener("hashchange", revealHashTarget);
    revealHashTarget();
  } catch {
    if (status) status.textContent = "Release history is unavailable.";
    if (fallback) fallback.hidden = false;
    const link = fallback?.querySelector("a");
    if (link) link.href = RELEASES_PAGE;
  }
}

loadChangelog();
