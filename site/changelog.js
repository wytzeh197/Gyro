import {
  RELEASES_API,
  RELEASES_PAGE,
  fetchGitHubJson,
  formatPublishedDate,
  isPublicAlphaRelease,
  releaseAnchor,
  renderReleaseNotes,
} from "./release-utils.js";

const list = document.querySelector("[data-changelog-list]");
const rail = document.querySelector("[data-version-rail]");
const jump = document.querySelector("[data-version-jump]");
const status = document.querySelector("[data-changelog-status]");
const fallback = document.querySelector("[data-changelog-fallback]");

function versionLabel(tag) {
  return tag.replace(/^v0\.1\.0-/, "");
}

function appendVersionLink(target, release) {
  const link = document.createElement("a");
  link.href = `#${releaseAnchor(release.tag_name)}`;
  link.textContent = versionLabel(release.tag_name);
  target.append(link);
}

function renderRelease(release, index) {
  const article = document.createElement("article");
  article.className = "release-entry";
  article.id = releaseAnchor(release.tag_name);

  const header = document.createElement("header");
  const label = document.createElement("p");
  label.className = "release-kicker";
  label.textContent = index === 0 ? "Latest public alpha" : "Public alpha";
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
  github.textContent = "View release and assets on GitHub";

  article.append(header, notes, github);
  return article;
}

async function loadChangelog() {
  if (!list || !rail || !jump) return;
  try {
    const response = await fetchGitHubJson(RELEASES_API);
    const releases = Array.isArray(response)
      ? response.filter(isPublicAlphaRelease)
      : [];
    releases.sort(
      (a, b) =>
        new Date(b.published_at).getTime() - new Date(a.published_at).getTime(),
    );
    if (!releases.length) throw new Error("No public alpha releases found");

    list.replaceChildren();
    rail.replaceChildren();
    jump.replaceChildren();
    for (const [index, release] of releases.entries()) {
      appendVersionLink(rail, release);
      appendVersionLink(jump, release);
      list.append(renderRelease(release, index));
    }
    if (status) status.textContent = `${releases.length} public alpha releases`;
    if (fallback) fallback.hidden = true;
  } catch {
    if (status)
      status.textContent = "Release history is temporarily unavailable.";
    if (fallback) fallback.hidden = false;
    const link = fallback?.querySelector("a");
    if (link) link.href = RELEASES_PAGE;
  }
}

loadChangelog();
