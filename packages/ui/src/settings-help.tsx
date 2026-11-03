import { SettingsDisclosure } from "./settings-disclosure";
import { useId, useState } from "react";
import { ArrowRight, ArrowUpRight, ChevronDown, Search, X } from "lucide-react";
import type { SettingsSectionId } from "./types";

type HelpArticle = {
  title: string;
  answer: string;
  section?: SettingsSectionId;
};
const helpArticleGroups: { label: string; articles: HelpArticle[] }[] = [
  {
    label: "Getting started",
    articles: [
      {
        title: "How do I connect a provider?",
        answer:
          "Open Settings → Models & accounts to connect your account or configure a local model, then choose a model for your chat.",
        section: "providers",
      },
      {
        title: "How do I control how hard Gyro works?",
        answer:
          "Open Settings → Chat & agents to tune context efficiency, experiments, auto-compact, and parallel agents. Token budgets stay on Usage & limits.",
        section: "efficiency",
      },
      {
        title: "How do I start a task?",
        answer:
          "Open a project, start a chat, and describe what you want done. Attach relevant files or images for context, and choose a model, reasoning effort, and permission mode in the composer.",
      },
      {
        title: "Which chat commands can I use?",
        answer:
          "Type /help in the composer to browse available commands, including planning and setting a goal.",
      },
    ],
  },
  {
    label: "Permissions and approvals",
    articles: [
      {
        title: "What does Ask for approval allow?",
        answer:
          "The agent asks before commands and file edits. Review approval requests in the chat before allowing the action.",
      },
      {
        title: "What does Approve for me allow?",
        answer:
          "Runs commands and edits without asking each time. With OpenAI, the project sandbox remains in place: network access, writes outside the project, or restricted tools can still require approval. Other providers follow their own permission boundaries, and separate Gyro tool permissions can still require approval.",
      },
      {
        title: "What does Full access allow?",
        answer:
          "Unrestricted access to the internet and any file on your computer. Allows commands and edits without the usual approval gates and bypasses the provider sandbox where supported. Choose this only for work you trust to run with that access.",
      },
      {
        title: "Where can I change permissions?",
        answer:
          "Use the approval menu in the composer to choose a mode. Open Settings → Permissions for individual controls. Provider restrictions and operating-system permissions can still apply.",
        section: "permissions",
      },
    ],
  },
  {
    label: "Usage and privacy",
    articles: [
      {
        title: "How do I manage usage and budgets?",
        answer:
          "Open Settings → Usage & limits to review provider allowances, set token budgets, or pause provider runs, including automations. A daily pace warning fires when usage runs more than a day's share (about 14%) ahead of an even weekly pace. Token budgets use observed usage and an in-flight request can exceed them; they are not invoice limits. Estimated usage is labelled; billing and account allowances are managed by your provider.",
        section: "usage-limits",
      },
      {
        title: "Where does my data go?",
        answer:
          "Sessions and settings are stored on your Mac. Your configured provider receives the prompts, files, and tool context needed for a request, under its own privacy terms. Gyro does not require a Gyro account.",
      },
    ],
  },
  {
    label: "Troubleshooting and support",
    articles: [
      {
        title: "Why is my provider not ready?",
        answer:
          "Check Settings → Models & accounts for connection status and available setup actions. Confirm that your provider is signed in and that the selected model is available.",
        section: "providers",
      },
      {
        title: "How do I update Gyro?",
        answer:
          "Open Settings → Updates to check for updates. Release notes list changes and fixes for each version.",
        section: "updates",
      },
      {
        title: "How do I report a problem?",
        answer:
          "Search existing issues first. Include your Gyro version, macOS version, and steps to reproduce the problem. Export diagnostics from Settings → Data & privacy and review them before sharing; never include credentials or private project content. Gyro is alpha software with community support.",
        section: "advanced",
      },
      {
        title: "How do I report a security issue?",
        answer:
          "Use the private reporting instructions in the security policy below. Do not post vulnerabilities in public issues.",
      },
    ],
  },
];

const helpTopics = [
  { id: "getting-started", label: "Getting started", articles: [...helpArticleGroups[0]!.articles.slice(1), ...helpArticleGroups[2]!.articles] },
  { id: "providers", label: "Providers", articles: [helpArticleGroups[0]!.articles[0]!, helpArticleGroups[3]!.articles[0]!] },
  { id: "permissions", label: "Permissions", articles: helpArticleGroups[1]!.articles },
  { id: "troubleshooting", label: "Troubleshooting", articles: [helpArticleGroups[3]!.articles[1]!] },
  { id: "support", label: "Support", articles: helpArticleGroups[3]!.articles.slice(2) },
];

const resources = [
  ["Getting started", "README.md"],
  ["Local models", "docs/local-models.md"],
  ["Privacy", "docs/privacy.md"],
  ["Support guide", "SUPPORT.md"],
  ["Security policy", "SECURITY.md"],
] as const;
const sectionLabels: Partial<Record<SettingsSectionId, string>> = {
  providers: "Models & accounts",
  efficiency: "Chat & agents",
  permissions: "Permissions",
  updates: "Updates",
  advanced: "Data & privacy",
};

export function SettingsHelp({
  version,
  onSectionChange,
}: {
  version?: string;
  onSectionChange?: (section: SettingsSectionId) => void;
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = helpTopics
    .map((group) => ({
      ...group,
      articles: group.articles.filter((article) =>
        terms.every((term) =>
          `${group.label} ${article.title} ${article.answer}`
            .toLowerCase()
            .includes(term),
        ),
      ),
    }))
    .filter((group) => group.articles.length);
  const count = filtered.reduce((sum, group) => sum + group.articles.length, 0);
  return (
    <div className="gyro-help">
      <div className="gyro-help-search">
        <Search size={17} aria-hidden="true" />
        <input
          id={searchId}
          type="search"
          aria-label="Search Help"
          placeholder="Search questions, permissions, providers…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button
            type="button"
            aria-label="Clear help search"
            onClick={() => setQuery("")}
          >
            <X size={15} />
          </button>
        )}
      </div>
      <p className="gyro-help-count" role="status">
        {terms.length
          ? `${count} ${count === 1 ? "answer" : "answers"} found`
          : ""}
      </p>
      <div className="gyro-help-answers">
        {filtered.map((group) => (
          <SettingsDisclosure key={group.label} id={`help-${group.id}`} title={group.label} summary={`${group.articles.length} ${group.articles.length === 1 ? "answer" : "answers"}`} attention={terms.length > 0}>
            {group.articles.map((article) => (
              <details
                key={`${article.title}:${query}`}
                open={terms.length ? true : undefined}
              >
                <summary>
                  {article.title}
                  <ChevronDown size={15} aria-hidden="true" />
                </summary>
                <div className="gyro-help-answer">
                  <p>{article.answer}</p>
                  {article.section && onSectionChange && (
                    <button
                      type="button"
                      onClick={() => onSectionChange(article.section!)}
                    >
                      Open {sectionLabels[article.section]}
                      <ArrowRight size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>
              </details>
            ))}
          </SettingsDisclosure>
        ))}
        {!count && (
          <div className="gyro-help-empty">
            <strong>No matching answers</strong>
            <p>Try a shorter search or browse all topics.</p>
            <button
              type="button"
              onClick={() => {
                setQuery("");
              }}
            >
              Show all questions
            </button>
          </div>
        )}
      </div>
      <section className="gyro-help-resources" aria-label="Guides and support">
        <h2>Guides & support</h2>
        <div>
          {resources.map(([label, path]) => (
            <a
              key={path}
              data-setting-key={label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}
              href={`https://github.com/wytzeh197/Gyro/blob/main/${path}`}
              target="_blank"
              rel="noreferrer"
            >
              {label}
              <ArrowUpRight size={13} aria-hidden="true" />
            </a>
          ))}
          <a
            href="https://github.com/wytzeh197/Gyro/issues"
            target="_blank"
            rel="noreferrer"
          >
            Issues and feature requests
            <ArrowUpRight size={13} aria-hidden="true" />
          </a>
        </div>
      </section>
      <footer className="gyro-help-footer">
        <span>
          <strong>Gyro</strong>
          <span data-setting-key="version-and-build" tabIndex={-1}>
            {version ?? "Version unavailable"}
          </span>
          <span data-setting-key="license" tabIndex={-1}>
            Apache-2.0
          </span>
        </span>
        <span>
          <a
            href="https://github.com/wytzeh197/Gyro/releases"
            target="_blank"
            rel="noreferrer"
          >
            Release notes
          </a>
          <a
            href="https://github.com/wytzeh197/Gyro"
            target="_blank"
            rel="noreferrer"
          >
            Repository
          </a>
        </span>
      </footer>
    </div>
  );
}
