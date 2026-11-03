import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Render production components with their real React runtime. No browser,
// provider, native bridge, persistent state or network connection is needed.
const requireUi = createRequire(
  new URL("../packages/ui/package.json", import.meta.url),
);
const requireDesktop = createRequire(
  new URL("../apps/desktop/package.json", import.meta.url),
);
const { build } = createRequire(requireDesktop.resolve("vite"))("esbuild");
const { createElement } = requireUi("react");
const { renderToStaticMarkup } = requireUi("react-dom/server");
const repo = fileURLToPath(new URL("../", import.meta.url));
const compiled = await build({
  stdin: {
    contents: `
      export { CloudSettings } from "./packages/ui/src/cloud-settings.tsx";
      export { BillingSettings } from "./packages/ui/src/billing-settings.tsx";
      export * from "./packages/ui/src/cloud-services-settings.tsx";
      export * from "./packages/ui/src/cloud-services-state.ts";
      export * from "./packages/ui/src/cloud-auth-proof.ts";
    `,
    resolveDir: repo,
    sourcefile: "cloud-settings-render-fixture.tsx",
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  jsx: "automatic",
  external: ["react", "react-dom", "lucide-react"],
  loader: { ".css": "empty" },
  logLevel: "silent",
});
const componentModule = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(
  requireUi,
  componentModule,
  componentModule.exports,
);
const ui = componentModule.exports;
const renderWarnings = [];
const render = (Component, props = {}) => {
  const originalError = console.error;
  console.error = (...args) => {
    // Shared SettingsDisclosure runs a layout effect in the desktop app. SSR
    // deliberately skips it; suppress only React's expected warning about that.
    if (
      String(args[0]).startsWith(
        "Warning: useLayoutEffect does nothing on the server",
      )
    )
      return;
    renderWarnings.push(args.map(String).join(" "));
  };
  try {
    return renderToStaticMarkup(createElement(Component, props));
  } finally {
    console.error = originalError;
  }
};
const text = (html) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
const buttons = (html) =>
  [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => ({
    attributes: match[1],
    label: text(match[2]),
  }));
const button = (html, label) => {
  const result = buttons(html).find((candidate) => candidate.label === label);
  assert.ok(result, `Expected button: ${label}`);
  return result;
};
const isDisabled = (control) =>
  /\bdisabled(?:=""|="disabled")?(?:\s|$)/.test(control.attributes);
const option = (html, value) => {
  const match = [
    ...html.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g),
  ].find((candidate) => candidate[1].includes(`value="${value}"`));
  assert.ok(match, `Expected task option: ${value}`);
  return { attributes: match[1], label: text(match[2]) };
};
let checks = 0;
const check = (name, fn) => {
  fn();
  checks++;
  console.log(`ok ${checks} - ${name}`);
};
let actionCalls = 0;
const forbidden = () => {
  actionCalls++;
  throw new Error("Render must not execute Cloud actions");
};
const cloud = {
  request: forbidden,
  preferences: forbidden,
  applySettings: forbidden,
  continueChat: forbidden,
};
const actions = {
  cloud,
  refresh: forbidden,
  manage: forbidden,
  signOut: forbidden,
};
const plus = {
  status: "active",
  productionCloud: true,
  plan: "plus",
  accountLabel: "qa@example.invalid",
  fetchedAt: "2026-11-02T10:00:00Z",
  accessUntil: "2026-12-02T10:00:00Z",
  renewalAt: "2026-12-02T10:00:00Z",
  limits: {
    devices: 2,
    storageBytes: 2_000_000_000,
    historyDays: 30,
    activeLinks: 10,
    concurrentJobs: 1,
    uploadBytesPerMonth: 4_000_000_000,
    downloadBytesPerMonth: 40_000_000_000,
  },
  cloudCapabilities: { managedAi: { allowed: true, reason: "active" } },
  cloudUsage: {
    managedAi: {
      unit: "percent",
      used: 35,
      held: 5,
      remaining: 60,
      resetAt: "2026-12-02T10:00:00Z",
    },
    storage: {
      usedBytes: 100_000_000,
      reservedBytes: 25_000_000,
      limitBytes: 2_000_000_000,
    },
  },
};
const premium = {
  ...plus,
  plan: "premium",
  limits: {
    ...plus.limits,
    devices: 5,
    storageBytes: 20_000_000_000,
    historyDays: 90,
    activeLinks: 100,
    concurrentJobs: 2,
  },
  cloudUsage: {
    ...plus.cloudUsage,
    storage: { ...plus.cloudUsage.storage, limitBytes: 20_000_000_000 },
  },
};

check(
  "unconfigured Cloud keeps local use available without invented usage",
  () => {
    const html = render(ui.CloudSettings);
    const content = text(html);
    assert.match(content, /Gyro Cloud is not available in this build/);
    assert.match(content, /No Cloud connection established/);
    assert.match(
      content,
      /complete local app remains available without a Cloud account/,
    );
    assert.doesNotMatch(
      html,
      /role="progressbar"|Managed assistance task|Selected sync &amp; backups/,
    );
  },
);

check(
  "active Cloud renders server allowance including reservations and a separate billing shortcut",
  () => {
    const html = render(ui.CloudSettings, {
      snapshot: plus,
      actions,
      onOpenBilling: forbidden,
    });
    const content = text(html);
    assert.match(html, /aria-label="Monthly managed allowance: 60% left"/);
    assert.match(html, /aria-valuenow="60"/);
    assert.match(content, /Allowance being resolved.*5\.0%/);
    assert.match(content, /Cloud storage.*125\.0 MB \/ 2 GB/);
    assert.match(content, /included in the used amount above/);
    assert.match(content, /no automatic overages/i);
    button(html, "Open plan & billing");
    assert.doesNotMatch(content, /€15|€49|VAT included|Change at next renewal/);
    assert.match(html, /aria-label="Selected context for managed assistance"/);
    assert.ok(
      isDisabled(button(html, "Send reviewed text")),
      "Empty context cannot be sent",
    );
    assert.ok(
      isDisabled(button(html, "Request Cloud deletion")),
      "Deletion needs an explicit confirmation",
    );
  },
);

check(
  "offline Cloud labels stale usage and cannot claim managed availability",
  () => {
    const html = render(ui.CloudSettings, {
      snapshot: {
        ...plus,
        status: "offline",
      },
      actions,
    });
    assert.match(html, /role="alert"/);
    assert.match(
      text(html),
      /Cannot refresh subscription.*These values are stale/,
    );
    assert.match(text(html), /Last confirmed values · offline/);
    assert.match(
      html,
      /aria-label="Managed allowance · last confirmed: 60% left"/,
    );
    assert.ok(isDisabled(button(html, "Send reviewed text")));
    assert.ok(
      isDisabled(option(html, "failure-explanation")),
      "Stale allowed=true cannot enable a new request",
    );
    assert.match(text(html), /offline/i);
  },
);

check(
  "exhaustion shows zero remaining, preserves recovery and source controls",
  () => {
    const html = render(ui.CloudSettings, {
      snapshot: {
        ...plus,
        status: "exhausted",
        cloudCapabilities: {
          managedAi: { allowed: false, reason: "exhausted" },
        },
        cloudUsage: {
          ...plus.cloudUsage,
          managedAi: {
            ...plus.cloudUsage.managedAi,
            used: 95,
            held: 5,
            remaining: 0,
          },
        },
      },
      actions,
    });
    assert.match(text(html), /Managed allowance used/);
    assert.match(html, /aria-label="Monthly managed allowance: 0% left"/);
    assert.match(text(html), /No allowance left/);
    assert.match(
      text(html),
      /Saved results and source review remain available/,
    );
    assert.ok(isDisabled(button(html, "Send reviewed text")));
    assert.ok(!isDisabled(button(html, "Recover latest request")));
  },
);

check(
  "production billing shows the exact Plus and Premium offer and defers plan changes",
  () => {
    for (const snapshot of [plus, premium]) {
      const html = render(ui.BillingSettings, {
        snapshot,
        actions,
        onOpenCloud: forbidden,
      });
      const content = text(html);
      assert.match(content, /€15\/month · VAT included/);
      assert.match(content, /€49\/month · VAT included/);
      assert.match(
        content,
        /2 devices · 2 GB including retained versions · 30 days of history · 10 active report links · 1 managed request at a time/,
      );
      assert.match(
        content,
        /5 devices · 20 GB including retained versions · 90 days of history · 100 active report links · 2 managed requests at a time/,
      );
      assert.equal(
        buttons(html).filter(({ label }) => label === "Change at next renewal")
          .length,
        1,
      );
      assert.equal((content.match(/Current plan/g) ?? []).length, 1);
      button(html, "Manage billing");
      button(html, "Open Gyro Cloud settings");
      assert.doesNotMatch(
        content,
        /Gyro account|Monthly managed allowance|Pending reservations|Simulate managed usage|Local connection test|\$10|\$40/,
      );
    }
  },
);

check("unconfigured, test and production prices cannot be confused", () => {
  const unavailable = text(render(ui.BillingSettings));
  assert.doesNotMatch(unavailable, /€15|€49|\$10|\$40|VAT included/);
  const staging = text(
    render(ui.BillingSettings, {
      snapshot: { status: "active", staging: true, plan: "plus" },
    }),
  );
  assert.match(staging, /Staging — test payments, mock AI/);
  assert.match(staging, /\$1\/month · sandbox fixture/);
  assert.match(staging, /\$2\/month · sandbox fixture/);
  assert.match(staging, /This is not the launch offer/);
  assert.doesNotMatch(staging, /€15|€49|VAT included/);
  const production = text(
    render(ui.BillingSettings, {
      snapshot: plus,
      actions: {
        ...actions,
        simulateManagedRequest: forbidden,
        simulateCancellation: forbidden,
        simulateExpiry: forbidden,
      },
    }),
  );
  assert.doesNotMatch(
    production,
    /Local connection test|Simulate managed usage|Simulate expiry|mock AI balance/,
  );
});

check("checkout pending never implies access and has explicit escape", () => {
  const html = render(ui.BillingSettings, {
    snapshot: { status: "checkout-pending", productionCloud: true },
    actions: { finishCheckout: forbidden, abandonCheckout: forbidden },
  });
  assert.match(
    text(html),
    /Checkout does not grant access until the service confirms it/,
  );
  button(html, "Open secure checkout");
  button(html, "Return to local Gyro");
  assert.doesNotMatch(text(html), /Subscription active|Current plan/);
});

check(
  "subscription interruption states remain distinct and do not offer immediate plan changes",
  () => {
    for (const [status, label] of [
      ["expired", "Subscription expired"],
      ["disputed", "Cloud access paused after a billing dispute"],
      ["payment-problem", "Payment needs attention"],
    ]) {
      const html = render(ui.BillingSettings, {
        snapshot: { ...plus, status },
        actions,
      });
      assert.ok(text(html).includes(label), `Missing ${status} label`);
      assert.doesNotMatch(text(html), /Change at next renewal/);
      button(html, "Manage billing");
    }
    const cancelled = render(ui.BillingSettings, {
      snapshot: {
        ...plus,
        status: "cancellation-scheduled",
        cancellationAt: "2026-12-02T10:00:00Z",
      },
      actions,
    });
    assert.match(text(cancelled), /Cancellation scheduled/);
    assert.match(
      text(cancelled),
      /Access ends.*Cancellation confirmed by billing/,
    );
  },
);

check("sign-in uses labelled local controls and proof is concealed", () => {
  const emailHtml = render(ui.CloudSettings, {
    snapshot: {
      status: "signed-out",
      productionCloud: true,
      authStage: "email",
    },
    actions: { requestSignin: forbidden, signOut: forbidden },
  });
  assert.match(emailHtml, /type="email" aria-label="Gyro email"/);
  assert.match(
    text(emailHtml),
    /Remember this Cloud session in macOS Keychain/,
  );
  assert.match(text(emailHtml), /Local work needs no account/);
  button(emailHtml, "Send sign-in email");
  const proofHtml = render(ui.CloudSettings, {
    snapshot: {
      status: "signed-out",
      productionCloud: true,
      authStage: "proof",
    },
    actions: { verifySignin: forbidden, signOut: forbidden },
  });
  assert.match(proofHtml, /type="password" aria-label="Sign-in link or code"/);
  assert.match(proofHtml, /maxLength="4096"/i);
  assert.match(text(proofHtml), /six- or eight-digit code/);
  const pattern = new RegExp(
    `^(?:${proofHtml.match(/\bpattern="([^"]+)"/)[1]})$`,
    "u",
  );
  for (const proof of [
    "012345",
    "01234567",
    " 01234567 ",
    "https://abcdefghijklmnopqrst.supabase.co/auth/v1/verify?token=fixture&type=email",
  ]) {
    assert.equal(pattern.test(proof), true);
    assert.equal(ui.isCloudSignInProof(proof), true);
  }
  for (const proof of [
    "",
    "1234567",
    "123456789",
    "１２３４５６",
    "１２３４５６７８",
    "١٢٣٤٥٦",
    "١٢٣٤٥٦٧٨",
    "1234567１",
  ]) {
    assert.equal(pattern.test(proof), false);
    assert.equal(ui.isCloudSignInProof(proof), false);
  }
  assert.equal(
    ui.isCloudSignInProof(`https://example.invalid/${"a".repeat(4096)}`),
    false,
  );
  assert.match(text(proofHtml), /tokens stay out of this page/);
  button(proofHtml, "Verify sign-in");
});

check("Plus and Premium offer only included managed task options", () => {
  for (const snapshot of [plus, premium]) {
    const html = render(ui.CloudSettings, { snapshot, actions });
    for (const task of ["memory-update", "check-plan", "failure-explanation"]) {
      assert.ok(
        !isDisabled(option(html, task)),
        `${snapshot.plan} should include ${task}`,
      );
    }
    for (const task of [
      "test-suggestions",
      "change-review",
      "check-comparison",
    ]) {
      assert.equal(
        isDisabled(option(html, task)),
        snapshot.plan === "plus",
        `${task} inclusion for ${snapshot.plan}`,
      );
    }
  }
});

check(
  "managed context review counts twice-serialized UTF-8 and rejects oversized text without truncation",
  () => {
    assert.equal(ui.contextReview("", "plus").allowed, false);
    assert.equal(ui.contextReview("  ", "premium").allowed, false);
    assert.equal(
      ui.contextReview("short selected text", "lite").allowed,
      false,
    );
    for (const [plan, budget] of [
      ["plus", 3904],
      ["premium", 27904],
    ]) {
      assert.equal(ui.contextReview("x".repeat(budget), plan).allowed, true);
      assert.equal(
        ui.contextReview("x".repeat(budget + 1), plan).allowed,
        false,
      );
    }
    const escaped = ui.contextReview('"'.repeat(2000), "plus");
    assert.equal(escaped.textBytes, 2000);
    // Context JSON is itself embedded in the provider request's text field.
    // Each quote occupies four bytes after both JSON serialization layers.
    assert.equal(escaped.escapedBytes, 8000);
    assert.equal(escaped.allowed, false);
    assert.equal(ui.contextReview("🙂".repeat(1000), "plus").allowed, false);
  },
);

const futureLink = {
  shareId: "11111111-1111-4111-8111-111111111111",
  expiresAt: "2999-01-01T00:00:00Z",
  revokedAt: null,
  paused: false,
};
check(
  "report links distinguish active, plan-paused, expired, revoked and unverified states",
  () => {
    for (const [share, accessState, label, disabled] of [
      [futureLink, "active", "Active", false],
      [futureLink, "exhausted", "Active", false],
      [
        { ...futureLink, paused: true },
        "active",
        "Paused by plan limit",
        false,
      ],
      [
        futureLink,
        "expired",
        "Paused while Cloud access is unavailable",
        false,
      ],
      [futureLink, "offline", "Status unverified", false],
      [
        { ...futureLink, expiresAt: "2000-01-01T00:00:00Z" },
        "active",
        "Expired",
        true,
      ],
      [
        { ...futureLink, revokedAt: "2026-11-01T00:00:00Z" },
        "active",
        "Revoked",
        true,
      ],
      [
        { ...futureLink, expiresAt: "invalid" },
        "active",
        "Status unavailable",
        false,
      ],
    ]) {
      const html = render(ui.CloudReportLinkRow, {
        share,
        accessState,
        onRevoke: forbidden,
      });
      assert.ok(text(html).includes(label), `Expected link state: ${label}`);
      assert.equal(
        isDisabled(button(html, "Revoke link")),
        disabled,
        `Revocation for ${label}`,
      );
    }
    const busy = render(ui.CloudReportLinkRow, {
      share: futureLink,
      accessState: "active",
      busy: true,
      onRevoke: forbidden,
    });
    assert.ok(isDisabled(button(busy, "Revoke link")));
  },
);

const sourceRef = {
  objectId: "22222222-2222-4222-8222-222222222222",
  revisionId: "33333333-3333-4333-8333-333333333333",
};
const proposal = {
  status: "proposal",
  loaded: true,
  expectedRevision: 4,
  content: "Synthetic draft for review",
  sources: [sourceRef],
};
const memoryProps = {
  proposal,
  currentRevision: 4,
  reviewed: false,
  provenance: createElement("p", null, "Synthetic exact source revision"),
  onRead: forbidden,
  onReviewedChange: forbidden,
  onReview: forbidden,
  onRefreshRequest: forbidden,
};
check(
  "prepared memory remains recoverable without claiming a readable or accepted draft",
  () => {
    const html = render(ui.CloudMemoryDraftCard, {
      ...memoryProps,
      proposal: { ...proposal, status: "prepared", jobStatus: "uncertain" },
    });
    const content = text(html);
    assert.match(content, /Memory draft is processing/);
    assert.match(content, /do not submit it again/);
    assert.match(content, /Existing request: uncertain/);
    assert.match(
      content,
      /Rejecting a draft does not cancel an already submitted managed request/,
    );
    assert.doesNotMatch(
      content,
      /Synthetic draft for review|Accept reviewed draft|Read draft/,
    );
    button(html, "Check existing request & refresh drafts");
    assert.ok(!isDisabled(button(html, "Reject draft")));
  },
);

check(
  "conflicted memory preserves saved edits and offers rejection or recovery",
  () => {
    const html = render(ui.CloudMemoryDraftCard, {
      ...memoryProps,
      proposal: { ...proposal, status: "conflict" },
    });
    const content = text(html);
    assert.match(content, /Memory changed while this draft was prepared/);
    assert.match(content, /Your saved edits are preserved/);
    assert.doesNotMatch(
      content,
      /Synthetic draft for review|Accept reviewed draft|Read draft/,
    );
    assert.ok(!isDisabled(button(html, "Reject draft")));
    button(html, "Check existing request & refresh drafts");
  },
);

check(
  "memory acceptance needs a loaded current proposal, valid sources and explicit review",
  () => {
    const unreviewed = render(ui.CloudMemoryDraftCard, memoryProps);
    assert.match(text(unreviewed), /Memory draft ready for review/);
    assert.match(text(unreviewed), /Synthetic draft for review/);
    assert.match(text(unreviewed), /Synthetic exact source revision/);
    assert.match(unreviewed, /type="checkbox"/);
    assert.ok(isDisabled(button(unreviewed, "Accept reviewed draft")));
    const reviewed = render(ui.CloudMemoryDraftCard, {
      ...memoryProps,
      reviewed: true,
    });
    assert.ok(!isDisabled(button(reviewed, "Accept reviewed draft")));
    for (const invalid of [
      { proposal: { ...proposal, loaded: false } },
      { currentRevision: 5 },
      { memoryDirty: true },
      { busy: true },
      { proposal: { ...proposal, sources: [] } },
      {
        proposal: {
          ...proposal,
          sources: [{ ...sourceRef, revisionId: "not-a-uuid" }],
        },
      },
    ]) {
      const html = render(ui.CloudMemoryDraftCard, {
        ...memoryProps,
        reviewed: true,
        ...invalid,
      });
      assert.ok(
        isDisabled(button(html, "Accept reviewed draft")),
        `Invalid acceptance state: ${JSON.stringify(invalid)}`,
      );
    }
  },
);

check(
  "unknown memory status fails closed and dynamic Cloud content is escaped",
  () => {
    const unknown = render(ui.CloudMemoryDraftCard, {
      ...memoryProps,
      proposal: { ...proposal, status: "unrecognized" },
    });
    assert.match(text(unknown), /Memory draft status unavailable/);
    assert.doesNotMatch(
      text(unknown),
      /Accept reviewed draft|Read draft|Synthetic draft for review/,
    );
    assert.ok(isDisabled(button(unknown, "Reject draft")));
    const html = render(ui.CloudMemoryDraftCard, {
      ...memoryProps,
      proposal: { ...proposal, content: '<script>alert("fixture")</script>' },
    });
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
  },
);

check(
  "source review preserves the exact UTF-16 message range used by server extraction",
  () => {
    const messages = [
      { role: "user", text: "A🙂BC" },
      { role: "assistant", text: "Next message" },
    ];
    assert.deepEqual(
      ui.sourceMessageExcerpt(messages, {
        startMessage: 0,
        startOffset: 1,
        endMessage: 0,
        endOffset: 4,
      }),
      [{ role: "user", text: "🙂B", index: 0 }],
    );
    assert.deepEqual(
      ui.sourceMessageExcerpt(messages, {
        startMessage: 0,
        startOffset: 0,
        endMessage: 1,
        endOffset: 0,
      }),
      [{ role: "user", text: "A🙂BC", index: 0 }],
    );
    assert.equal(
      ui.sourceMessageExcerpt(messages, {
        startMessage: 0,
        startOffset: 0,
        endMessage: 3,
        endOffset: 0,
      }),
      null,
    );
  },
);

check(
  "device revocation uses the canonical service id and rejects missing or malformed ids",
  () => {
    const canonical = "44444444-4444-4444-8444-444444444444";
    const legacy = "55555555-5555-4555-8555-555555555555";
    assert.equal(
      ui.cloudDeviceId({ id: canonical, deviceId: legacy }),
      canonical,
    );
    assert.equal(ui.cloudDeviceId({ deviceId: legacy }), legacy);
    assert.equal(ui.cloudDeviceId({ label: "Synthetic device" }), null);
    assert.equal(ui.cloudDeviceId({ id: "invalid" }), null);
  },
);

check(
  "hosted v2 staging uses the EUR offer and real Cloud controls without legacy mock claims",
  () => {
    const snapshot = {
      ...plus,
      productionCloud: false,
      cloudV2: true,
      staging: true,
      cloudCapabilities: {
        managedAi: { allowed: false, reason: "staging-ai-disabled" },
      },
    };
    const cloudHtml = render(ui.CloudSettings, { snapshot, actions });
    const billingHtml = render(ui.BillingSettings, { snapshot, actions });
    assert.match(
      text(cloudHtml),
      /Staging — test payments, managed AI disabled/,
    );
    assert.match(
      cloudHtml,
      /aria-label="Selected context for managed assistance"/,
    );
    assert.ok(isDisabled(button(cloudHtml, "Send reviewed text")));
    assert.match(
      text(billingHtml),
      /€15\/month · VAT included · sandbox price, no real charge/,
    );
    assert.match(
      text(billingHtml),
      /€49\/month · VAT included · sandbox price, no real charge/,
    );
    assert.doesNotMatch(
      text(billingHtml),
      /\$1|\$2|\$0\.05|mock AI|planning value/,
    );
  },
);

check(
  "rendering never invokes a Cloud action or emits unexpected React warnings",
  () => {
    assert.equal(actionCalls, 0);
    assert.deepEqual(renderWarnings, []);
  },
);
console.log(
  `Cloud settings render checks passed (${checks}). SSR verifies output and rendered controls; browser layout, focus and action execution are separate checks.`,
);
