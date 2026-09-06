import { useId, useState } from "react";
import { ArrowRight, ArrowUpRight, ChevronDown, Search, X } from "lucide-react";
import type { SettingsSectionId } from "./types";

type HelpArticle = {
  title: string;
  answer: string;
  section?: SettingsSectionId;
};
const helpTopics: { label: string; articles: HelpArticle[] }[] = [
  {
    label: "Getting started",
    articles: [
      {
        title: "How do I connect a provider?",
        answer:
          "Open Settings → Providers to connect your account or configure a local model, then choose a model for your chat.",
        section: "providers",
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
        title: "What does Ask first allow?",
        answer:
          "The agent asks before commands and file edits. Review approval requests in the chat before allowing the action.",
      },
      {
        title: "What does Auto Approve allow?",
        answer:
          "Runs commands and edits without asking each time. With OpenAI, the project sandbox remains in place: network access, writes outside the project, or restricted tools can still require approval. Other providers follow their own permission boundaries, and separate Gyro tool permissions can still require approval.",
      },
      {
        title: "What does Full access allow?",
        answer:
          "Allows commands and edits without the usual approval gates and bypasses the provider sandbox where supported. The agent can use Git, network access, and user tools directly. Choose this only for work you trust to run with that access.",
      },
      {
        title: "Where can I change permissions?",
        answer:
          "Use the shield menu in the composer to choose a mode. Open Settings → Permissions for individual controls. Provider restrictions and operating-system permissions can still apply.",
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
          "Open Settings → Usage Limits to review provider allowances, set token budgets, or pause provider runs, including automations. Estimated usage is labelled; billing and account allowances are managed by your provider.",
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
          "Check Settings → Providers for connection status and available setup actions. Confirm that your provider is signed in and that the selected model is available.",
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
          "Search existing issues first. Include your Gyro version, macOS version, and steps to reproduce the problem. Export diagnostics from Settings → Advanced and review them before sharing; never include credentials or private project content. Gyro is alpha software with community support.",
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

const resources = [
  ["Getting started", "README.md"],
  ["Local models", "docs/local-models.md"],
  ["Privacy", "docs/privacy.md"],
  ["Support guide", "SUPPORT.md"],
  ["Security policy", "SECURITY.md"],
] as const;
const sectionLabels: Partial<Record<SettingsSectionId, string>> = {
  providers: "Providers",
  permissions: "Permissions",
  "usage-limits": "Usage Limits",
  updates: "Updates",
  advanced: "Advanced",
};

export function SettingsHelp({
  version,
  onSectionChange,
}: {
  version?: string;
  onSectionChange?: (section: SettingsSectionId) => void;
}) {
  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState("All topics");
  const searchId = useId();
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const filtered = helpTopics
    .filter((group) => topic === "All topics" || group.label === topic)
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
      {onSectionChange && (
        <nav className="gyro-help-shortcuts" aria-label="Settings shortcuts">
          {(["providers", "permissions", "usage-limits"] as const).map(
            (section) => (
              <button
                type="button"
                key={section}
                onClick={() => onSectionChange(section)}
              >
                {sectionLabels[section]}
                <ArrowRight size={14} aria-hidden="true" />
              </button>
            ),
          )}
        </nav>
      )}
      <div
        className="gyro-help-topics"
        role="group"
        aria-label="Filter help topics"
      >
        {["All topics", ...helpTopics.map((group) => group.label)].map(
          (label) => (
            <button
              type="button"
              key={label}
              aria-pressed={topic === label}
              onClick={() => setTopic(label)}
            >
              {label}
            </button>
          ),
        )}
      </div>
      <p className="gyro-help-count" role="status">
        {terms.length
          ? `${count} ${count === 1 ? "answer" : "answers"} found`
          : "Browse questions"}
      </p>
      <div className="gyro-help-answers">
        {filtered.map((group) => (
          <section
            key={group.label}
            className="gyro-help-topic"
            aria-label={group.label}
          >
            <h2>{group.label}</h2>
            {group.articles.map((article) => (
              <details
                key={`${article.title}:${query}:${topic}`}
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
          </section>
        ))}
        {!count && (
          <div className="gyro-help-empty">
            <strong>No matching answers</strong>
            <p>Try a shorter search or browse all topics.</p>
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setTopic("All topics");
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
