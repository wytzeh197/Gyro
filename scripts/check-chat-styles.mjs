import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { postcss } from "./css-parser.mjs";
import { readUiStyleSources } from "./ui-style-sources.mjs";
import {
  chatSelectorPattern,
  chatSelectorSubject,
} from "./chat-style-scope.mjs";

export function checkChatStyles() {
  const failures = [];
  const sources = readUiStyleSources();
  const file = sources.find((file) => file.path.endsWith("/chat.css"));
  if (!file)
    return ["Chat styling must have one owner: packages/ui/src/chat.css."];
  const policyTokens = [
    "content-width",
    "gutter",
    "text-size",
    "text-line",
    "small-size",
    "meta-size",
    "radius-card",
    "turn-gap",
    "block-gap",
    "space-1",
    "space-2",
    "space-4",
    "raised",
    "hairline",
    "motion-fast",
    "motion-normal",
    "ease",
  ];
  const definitions = new Map(
    policyTokens.map((name) => [`--gyro-chat-${name}`, []]),
  );
  let rules = 0;
  for (const source of sources) {
    const tree = postcss.parse(source.source, { from: source.path });
    const isChat = source === file;
    tree.walkRules((rule) => {
      if (isChat) rules++;
      else if (chatSelectorPattern.test(rule.selector))
        failures.push(
          `${source.path}:${rule.source.start.line}: chat selectors belong in chat.css.`,
        );
    });
    tree.walkDecls((declaration) => {
      const location = `${source.path}:${declaration.source.start.line}`;
      if (definitions.has(declaration.prop))
        definitions
          .get(declaration.prop)
          .push({ selector: declaration.parent.selector, isChat });
      if (
        /--gyro-composer-width|--gyro-composer-zoom|--gyro-chat-font-(?:body|response|work|meta)/.test(
          declaration.prop + declaration.value,
        )
      )
        failures.push(`${location}: obsolete competing chat alias.`);
      if (!isChat) return;
      if (declaration.important)
        failures.push(`${location}: chat must not use !important.`);
      if (declaration.prop.startsWith("--")) {
        if (
          /(?:#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\()/i.test(
            declaration.value,
          ) &&
          !(
            declaration.parent.selector === ":root" &&
            ["--gyro-chat-media-text", "--gyro-chat-media-shade"].includes(
              declaration.prop,
            )
          )
        )
          failures.push(
            `${location}: chat colour aliases must use the product's semantic tokens.`,
          );
        return;
      }
      if (
        /(?<![\w-])#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/i.test(
          declaration.value,
        )
      )
        failures.push(`${location}: use a semantic colour token.`);
      if (
        ["font-size", "font"].includes(declaration.prop) &&
        /\d(?:px|rem|em|vw|cqi)/.test(
          declaration.prop === "font"
            ? declaration.value.split("/")[0]
            : declaration.value,
        )
      )
        failures.push(`${location}: use a typography token.`);
      if (
        /radius$/.test(declaration.prop) &&
        /\d(?:px|%)/.test(declaration.value)
      )
        failures.push(`${location}: use a radius token.`);
      if (
        /^(?:padding|margin|gap|row-gap|column-gap)(?:-|$)/.test(
          declaration.prop,
        ) &&
        /[1-9]\d*(?:\.\d+)?px\b/.test(declaration.value)
      )
        failures.push(`${location}: use the scaled spacing tokens.`);
    });
  }
  // Margins used to defeat the shared spacing through later shorthands.
  // Keep one actual setter for each role, not merely one token definition.
  const spacing = [
    {
      selector: ".gyro-chat-turn",
      target: /\.gyro-chat-turn(?![\w-])/,
      side: "bottom",
      token: "--gyro-chat-turn-gap",
      count: 0,
    },
    {
      selector: ".gyro-chat-turn > .gyro-message.is-user",
      target: /\.gyro-message\.is-user(?![\w-])/,
      side: "bottom",
      token: "--gyro-chat-block-gap",
      count: 0,
    },
    {
      selector: ".gyro-run-header",
      target: /\.gyro-run-header(?![\w-])/,
      side: "bottom",
      token: "--gyro-chat-block-gap",
      count: 0,
    },
    {
      selector: ".gyro-chat-run-change-summary",
      target: /\.gyro-chat-run-change-summary(?![\w-])/,
      side: "top",
      token: "--gyro-chat-block-gap",
      count: 0,
    },
  ];
  postcss.parse(file.source).walkRules((rule) => {
    for (const selector of postcss.list.comma(rule.selector)) {
      const subject = chatSelectorSubject(selector);
      if (subject.includes("::")) continue;
      for (const policy of spacing.filter((policy) =>
        policy.target.test(subject),
      ))
        rule.walkDecls((declaration) => {
          if (
            ![
              "margin",
              "margin-block",
              `margin-${policy.side}`,
              `margin-block-${policy.side === "top" ? "start" : "end"}`,
            ].includes(declaration.prop)
          )
            return;
          policy.count++;
          if (
            rule.selector !== policy.selector ||
            declaration.prop !== `margin-${policy.side}` ||
            declaration.value !== `var(${policy.token})`
          )
            failures.push(
              `chat.css:${declaration.source.start.line}: ${policy.selector} spacing has one authority (${policy.token}).`,
            );
        });
    }
  });
  for (const policy of spacing)
    if (policy.count !== 1)
      failures.push(
        `${policy.selector}: expected one spacing authority, found ${policy.count}.`,
      );
  for (const [name, entries] of definitions) {
    const expected =
      name === "--gyro-chat-raised"
        ? [":root", ':root[data-theme="light"]']
        : [":root"];
    if (
      entries.length !== expected.length ||
      entries.some((entry) => !entry.isChat) ||
      expected.some(
        (selector) => !entries.some((entry) => entry.selector === selector),
      )
    )
      failures.push(
        `${name}: expected one authority in chat.css${expected.length === 2 ? " plus its explicit light-theme mapping" : ""}.`,
      );
  }
  const budget = JSON.parse(
    readFileSync(new URL("./chat-style-budget.json", import.meta.url)),
  );
  if (rules > budget.maximumRules)
    failures.push(
      `Chat rule count ${rules} exceeds its ratchet budget ${budget.maximumRules}.`,
    );
  return failures;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const failures = checkChatStyles();
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else console.log("Chat style ownership, tokens and drift budget passed.");
}
