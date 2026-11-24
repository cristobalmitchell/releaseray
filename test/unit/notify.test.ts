/**
 * The notify sink (CONVERSION-PLAN §7.4, Phase 5 acceptance criteria 1 and 2):
 * the Slack host allowlist, when entries post, notify-once across identical
 * runs, `notify: always`, failures, and the entry layer's credential handling.
 * Requests are recorded by the MSW-style stand-in the carried suites use.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readInputs } from "../../src/action/inputs";
import { readNotifySecrets } from "../../src/action/main";
import { loadConfig, parseConfig } from "../../src/config/load";
import { resolveConfig } from "../../src/config/resolve";
import { configureLogger, resetLogger } from "../../src/core/logger";
import { ReleaseRayError } from "../../src/core/errors";
import type { IssueData, PullData } from "../../src/core/fetch/github";
import type { LLMProvider } from "../../src/core/llm/provider";
import { createFakeProvider } from "../../src/core/llm/providers/fake";
import { BUNDLED_TEMPLATES } from "../../src/core/prompt/templates";
import { createGit } from "../../src/core/range/git";
import { doctor } from "../../src/modes/doctor";
import { generate } from "../../src/modes/generate";
import { publish } from "../../src/modes/publish";
import {
  applyNotify,
  renderTitle,
  shouldNotify,
  type NotifyEntry,
} from "../../src/outputs/notify/sink";
import { publishToSlack, validateSlackWebhookUrl } from "../../src/outputs/notify/slack";
import { recordedGitHub } from "../helpers/fake-github";
import { fakeReleases } from "../helpers/fake-release";
import { createTestRepo, type TestRepo } from "../helpers/git-repo";
import { http, HttpResponse, setupServer } from "../helpers/http-mock";
import { errorHandlers, publisherHandlers } from "../helpers/publisher-mocks";

const ROOT = join(__dirname, "..", "..");
const recorded = JSON.parse(
  readFileSync(join(ROOT, "test/fixtures/golden/github.json"), "utf8")
) as { pulls: PullData[]; issues: IssueData[] };

// Built at runtime so secret scanners stay quiet (CONTRIBUTING.md).
const SLACK_URL = ["https://hooks.slack.com", "services", "T0000", "B0000", "notify"].join("/");
const TEAMS_URL = ["https://acme.webhook.office.com", "webhookb2", "notify"].join("/");
const INTERCOM_TOKEN = ["tok", "notify", "test"].join("-");

/** Every request, recorded before it is resolved. */
const server = setupServer(...publisherHandlers);
const seen: Array<{ method: string; url: string; body: string }> = [];
beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
  server.events.on("request:start", async ({ request }) => {
    seen.push({ method: request.method, url: request.url, body: await request.text() });
  });
  configureLogger({ sink: () => {} });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  server.close();
  resetLogger();
});
beforeEach(() => {
  seen.length = 0;
});

const slackPosts = () => seen.filter((r) => r.url.startsWith("https://hooks.slack.com/"));

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function counting() {
  let calls = 0;
  const provider: LLMProvider = {
    async generateStructured(...args) {
      calls++;
      return createFakeProvider().generateStructured(...args);
    },
  };
  return { provider, calls: () => calls };
}

function config(raw: Record<string, unknown> = {}) {
  return resolveConfig(parseConfig({ version: 1, ...raw }));
}

const slackEngineer = (extra: Record<string, unknown> = {}) =>
  config({
    outputs: {
      notify: [{ type: "slack", persona: "engineer", webhookUrlEnv: "SLACK_URL", ...extra }],
    },
  });

interface Harness {
  repo: TestRepo;
  releases: ReturnType<typeof fakeReleases>;
}

function harness(): Harness {
  const repo = createTestRepo();
  repo.commit("chore: initial commit", "2026-01-10");
  repo.tag("v1.1.0");
  repo.commit("feat!: drop Node 18 support (#14)", "2026-05-04");
  repo.commit("perf: parse large files in a stream (#15)", "2026-05-05");
  repo.commit("fix: keep column order when exporting (#17)", "2026-05-07");
  repo.tag("v1.2.0");
  dirs.push(repo.dir);
  return { repo, releases: fakeReleases([{ tag: "v1.2.0", body: "Intro.\n" }]) };
}

async function runGenerate(
  h: Harness,
  cfg: ReturnType<typeof config>,
  opts: {
    publish?: boolean;
    notify?: "primary-changed" | "always";
    secrets?: Record<string, string>;
    llm?: ReturnType<typeof counting>;
  } = {}
) {
  const llm = opts.llm ?? counting();
  const out = await generate(
    {
      range: { kind: "tag", to: "v1.2.0" },
      allowSparse: true,
      force: false,
      publish: opts.publish ?? true,
      workspace: h.repo.dir,
      ...(opts.notify ? { notify: opts.notify } : {}),
    },
    cfg,
    {
      git: createGit(h.repo.dir),
      github: recordedGitHub(structuredClone(recorded)).reader,
      llm: () => llm.provider,
      templates: BUNDLED_TEMPLATES,
      repo: {
        owner: "acme",
        repo: "widgets",
        serverUrl: "https://github.com",
        visibility: "public",
      },
      priced: false,
      sleep: async () => {},
      now: () => 0,
      release: h.releases.api,
      changelogText: () => {
        const f = join(h.repo.dir, "CHANGELOG.md");
        return existsSync(f) ? readFileSync(f, "utf8") : "";
      },
      persisted: { release: h.releases.api, workspace: h.repo.dir },
      notifySecrets: opts.secrets ?? { SLACK_URL },
    }
  );
  return { out, llm };
}

describe("Slack host allowlist", () => {
  it("accepts only https URLs on hooks.slack.com and hooks.slack-gov.com", () => {
    expect(() => validateSlackWebhookUrl(SLACK_URL)).not.toThrow();
    expect(() =>
      validateSlackWebhookUrl(SLACK_URL.replace("hooks.slack.com", "hooks.slack-gov.com"))
    ).not.toThrow();
    for (const url of [
      SLACK_URL.replace("https:", "http:"),
      SLACK_URL.replace("hooks.slack.com", "hooks.slack.com.evil.test"),
      SLACK_URL.replace("hooks.slack.com", "evil.test/hooks.slack.com"),
      SLACK_URL.replace("hooks.slack.com", "hooks.slack.com@evil.test"),
      SLACK_URL.replace("hooks.slack.com", "slack.com"),
      SLACK_URL.replace("hooks.slack.com", "127.0.0.1"),
      "hooks.slack.com/services/T0/B0/x",
      "not a url",
    ]) {
      expect(() => validateSlackWebhookUrl(url), url).toThrow(/Invalid Slack webhook URL/);
    }
  });

  it("sends nothing to a non-Slack host", async () => {
    server.use(http.post("https://evil.test/*", () => HttpResponse.text("ok")));
    const result = await publishToSlack({
      webhookUrl: "https://evil.test/services/T0/B0/x",
      version: "v1.2.0",
      repoFullName: "acme/widgets",
      content: "Notes",
      persona: "engineer",
      urls: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("must start with https://hooks.slack.com/");
    expect(seen).toEqual([]);
  });
});

describe("when an entry posts", () => {
  it("posts when the primary target changed, or always", () => {
    const entry = { when: "primary-changed" } as const;
    expect(shouldNotify(entry, { primaryChanged: true, override: null })).toBe(true);
    expect(shouldNotify(entry, { primaryChanged: false, override: null })).toBe(false);
    expect(shouldNotify(entry, { primaryChanged: false, override: "always" })).toBe(true);
    expect(shouldNotify({ when: "always" }, { primaryChanged: false, override: null })).toBe(true);
    expect(
      shouldNotify({ when: "always" }, { primaryChanged: false, override: "primary-changed" })
    ).toBe(false);
  });

  it("renders the Intercom title from the key", () => {
    expect(renderTitle("Release {{key}}", "v1.2.0")).toBe("Release v1.2.0");
    expect(renderTitle("{{ key }}: what changed", "2026-W19")).toBe("2026-W19: what changed");
  });

  it("sends each kind with its credential, skips personas without text, and reports failures", async () => {
    const entries: NotifyEntry[] = [
      { type: "slack", persona: "engineer", webhookUrlEnv: "SLACK_URL", when: "primary-changed" },
      { type: "teams", persona: "engineer", webhookUrlEnv: "TEAMS_URL", when: "primary-changed" },
      {
        type: "intercom",
        persona: "customer",
        apiKeyEnv: "INTERCOM_TOKEN",
        collectionId: "42",
        state: "draft",
        titleTemplate: "Widgets {{key}}",
        when: "primary-changed",
      },
      { type: "slack", persona: "internal", webhookUrlEnv: "SLACK_URL", when: "primary-changed" },
      { type: "slack", persona: "sales", webhookUrlEnv: "SLACK_URL", when: "primary-changed" },
    ];
    const outcome = await applyNotify(
      entries,
      [
        { id: "engineer", text: "### Features\n- Streams large files" },
        { id: "customer", text: "Large files open faster." },
        { id: "internal" },
      ],
      {
        key: "v1.2.0",
        repoFullName: "acme/widgets",
        primaryChanged: true,
        override: null,
        releaseUrl: "https://github.com/acme/widgets/releases/tag/v1.2.0",
      },
      { SLACK_URL, TEAMS_URL, INTERCOM_TOKEN }
    );
    expect(outcome.results.map((r) => [r.type, r.persona, r.status])).toEqual([
      ["slack", "engineer", "sent"],
      ["teams", "engineer", "sent"],
      ["intercom", "customer", "sent"],
      ["slack", "internal", "skipped"],
      ["slack", "sales", "skipped"],
    ]);
    const slack = JSON.parse(slackPosts()[0].body) as {
      blocks: Array<{ text?: { text: string } }>;
    };
    expect(slack.blocks[0].text?.text).toContain("v1.2.0 Released");
    expect(JSON.stringify(slack)).toContain("Streams large files");
    const intercom = seen.find((r) => r.method === "POST" && r.url.includes("intercom"))!;
    expect(JSON.parse(intercom.body)).toMatchObject({
      title: "Widgets v1.2.0",
      state: "draft",
      parent_id: "42",
    });
  });

  it("fails an entry whose credential is unset or whose post fails, and goes on", async () => {
    server.use(errorHandlers.slack500);
    const outcome = await applyNotify(
      [
        { type: "slack", persona: "engineer", webhookUrlEnv: "SLACK_URL", when: "always" },
        { type: "teams", persona: "engineer", webhookUrlEnv: "TEAMS_URL", when: "always" },
      ],
      [{ id: "engineer", text: "Notes" }],
      { key: "v1.2.0", repoFullName: "acme/widgets", primaryChanged: false, override: null },
      { SLACK_URL }
    );
    expect(outcome).toMatchObject({ sent: 0, failed: 2 });
    expect(outcome.results.map((r) => r.detail)).toEqual([
      "Slack API error: 500 Internal Server Error",
      "TEAMS_URL is not set",
    ]);
  });
});

describe("notify once (Phase 5 criterion 2)", () => {
  it("two identical runs send one Slack request; notify: always sends one more", async () => {
    const h = harness();
    const first = await runGenerate(h, slackEngineer());
    expect(first.out.errors).toEqual([]);
    expect(first.out.outputs["release-changed"]).toBe("true");
    expect(first.out.summary).toContain("## Notifications");
    expect(first.out.summary).toContain("- Slack (engineer): sent");

    const second = await runGenerate(h, slackEngineer());
    expect(second.out.outputs["release-changed"]).toBe("false");
    expect(second.llm.calls()).toBe(0);
    expect(second.out.summary).toContain(
      "- Slack (engineer): skipped, the primary target did not change"
    );
    expect(slackPosts()).toHaveLength(1);

    const resent = await runGenerate(h, slackEngineer(), { notify: "always" });
    expect(resent.out.outputs["release-changed"]).toBe("false");
    // The stored release text is reused: no LLM call to resend it.
    expect(resent.llm.calls()).toBe(0);
    expect(slackPosts()).toHaveLength(2);
    expect(slackPosts()[1].body).toBe(slackPosts()[0].body);
    expect(h.releases.writes).toHaveLength(1);
  });

  it("sends nothing when publish is off", async () => {
    const h = harness();
    const run = await runGenerate(h, slackEngineer({ when: "always" }), { publish: false });
    expect(run.out.errors).toEqual([]);
    expect(run.out.summary).not.toContain("## Notifications");
    expect(seen).toEqual([]);
  });

  it("generates a persona routed only to an always notification on every publishing run", async () => {
    const h = harness();
    const cfg = config({
      outputs: {
        summary: { personas: ["engineer"] },
        files: { enabled: false },
        notify: [
          { type: "slack", persona: "customer", webhookUrlEnv: "SLACK_URL", when: "always" },
        ],
      },
    });
    const first = await runGenerate(h, cfg);
    expect(first.llm.calls()).toBe(2);
    const second = await runGenerate(h, cfg);
    expect(second.llm.calls()).toBe(1);
    expect(slackPosts()).toHaveLength(2);
    expect(slackPosts().every((r) => r.body.includes("Persona: _customer_"))).toBe(true);
  });

  it("does not generate a persona routed only to a notification when nothing changed", async () => {
    const h = harness();
    const cfg = config({
      outputs: {
        summary: { personas: ["engineer"] },
        files: { enabled: false },
        notify: [{ type: "slack", persona: "customer", webhookUrlEnv: "SLACK_URL" }],
      },
    });
    expect((await runGenerate(h, cfg)).llm.calls()).toBe(2);
    expect((await runGenerate(h, cfg)).llm.calls()).toBe(0);
    expect(slackPosts()).toHaveLength(1);
  });
});

describe("failures", () => {
  it("exits 7 after the release write when a notification fails", async () => {
    server.use(errorHandlers.slack404);
    const h = harness();
    const { out } = await runGenerate(h, slackEngineer());
    expect(out.outputs["release-changed"]).toBe("true");
    expect(out.exitCode).toBe(7);
    expect(out.errors).toEqual([
      "Notification to Slack (engineer) failed: Slack API error: 404 Webhook not found",
    ]);
    expect(out.errors.join("\n")).not.toContain(SLACK_URL);
  });

  it("exits 2 before any read or write when a publishing run lacks a credential", async () => {
    const h = harness();
    const llm = counting();
    await expect(runGenerate(h, slackEngineer(), { secrets: {}, llm })).rejects.toMatchObject({
      exitCode: 2,
      details: [
        "SLACK_URL is not set: pass the secret to this step as env (SLACK_URL: ${{ secrets.SLACK_URL }})",
      ],
    });
    expect(llm.calls()).toBe(0);
    expect(h.releases.writes).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("does not need the credential when publish is off", async () => {
    const h = harness();
    const run = await runGenerate(h, slackEngineer(), { publish: false, secrets: {} });
    expect(run.out.errors).toEqual([]);
  });
});

describe("publish mode", () => {
  it("notifies from notes.json once, and again with notify: always", async () => {
    const h = harness();
    const cfg = slackEngineer();
    const generated = await runGenerate(h, cfg, { publish: false });
    const request = {
      workspace: h.repo.dir,
      notesDir: generated.out.outputs["notes-dir"],
      expectedDigest: generated.out.outputs["notes-digest"],
    };
    const deps = { release: h.releases.api, workspace: h.repo.dir };
    const notifyDeps = {
      repo: { owner: "acme", repo: "widgets", serverUrl: "https://github.com" },
      secrets: { SLACK_URL },
    };
    const first = await publish(request, cfg, deps, notifyDeps);
    expect(first.outputs["release-changed"]).toBe("true");
    expect(first.summary).toContain("- Slack (engineer): sent");
    const second = await publish(request, cfg, deps, notifyDeps);
    expect(second.outputs["release-changed"]).toBe("false");
    expect(slackPosts()).toHaveLength(1);
    await publish({ ...request, notify: "always" }, cfg, deps, notifyDeps);
    expect(slackPosts()).toHaveLength(2);
    expect(slackPosts()[0].body).toContain("https://github.com/acme/widgets/releases/tag/v1.2.0");
  });

  it("refuses before any write when the credential is missing", async () => {
    const h = harness();
    const cfg = slackEngineer();
    const generated = await runGenerate(h, cfg, { publish: false });
    await expect(
      publish(
        {
          workspace: h.repo.dir,
          notesDir: generated.out.outputs["notes-dir"],
          expectedDigest: generated.out.outputs["notes-digest"],
        },
        cfg,
        { release: h.releases.api, workspace: h.repo.dir },
        { repo: { owner: "acme", repo: "widgets", serverUrl: "https://github.com" }, secrets: {} }
      )
    ).rejects.toBeInstanceOf(ReleaseRayError);
    expect(h.releases.writes).toEqual([]);
  });
});

describe("entry layer", () => {
  it("reads only the variables the config names and masks each value", () => {
    const masked: string[] = [];
    const loaded = {
      config: parseConfig({
        version: 1,
        outputs: {
          notify: [
            { type: "slack", persona: "engineer", webhookUrlEnv: "SLACK_URL" },
            {
              type: "intercom",
              persona: "customer",
              apiKeyEnv: "INTERCOM_TOKEN",
              collectionId: "1",
            },
            { type: "teams", persona: "engineer", webhookUrlEnv: "TEAMS_URL" },
          ],
        },
      }),
    } as Parameters<typeof readNotifySecrets>[0];
    const secrets = readNotifySecrets(
      loaded,
      { SLACK_URL, INTERCOM_TOKEN, OTHER_SECRET: "unrelated" },
      { setSecret: (v) => masked.push(v) }
    );
    expect(secrets).toEqual({ SLACK_URL, INTERCOM_TOKEN });
    expect(masked).toEqual([SLACK_URL, INTERCOM_TOKEN]);
  });

  it("parses the notify input", () => {
    const read = (value: string) => readInputs({ getInput: (n) => (n === "notify" ? value : "") });
    expect(read("").notify).toBeNull();
    expect(read("always").notify).toBe("always");
    expect(read("primary-changed").notify).toBe("primary-changed");
    expect(() => read("never")).toThrow(ReleaseRayError);
  });

  it("doctor names unset notify variables, never values", async () => {
    const repo = createTestRepo();
    repo.commit("chore: initial commit", "2026-01-10");
    repo.tag("v1.0.0");
    dirs.push(repo.dir);
    const ws = mkdtempSync(join(tmpdir(), "releaseray-notify-"));
    dirs.push(ws);
    mkdirSync(join(ws, ".releaseray"));
    writeFileSync(
      join(ws, ".releaseray", "config.yml"),
      [
        "version: 1",
        "outputs:",
        "  notify:",
        "    - { type: slack, persona: engineer, webhookUrlEnv: SLACK_URL }",
        "    - { type: teams, persona: engineer, webhookUrlEnv: TEAMS_URL }",
        "",
      ].join("\n")
    );
    expect(loadConfig({ workspace: ws }).config.outputs.notify).toHaveLength(2);
    const out = await doctor(
      {
        workspace: ws,
        credentials: {
          openai: true,
          anthropic: false,
          aws: false,
          notify: { SLACK_URL: true, TEAMS_URL: false },
        },
        visibility: "private",
        nodeVersion: "24.22.1",
      },
      { git: createGit(repo.dir), github: recordedGitHub(recorded).reader }
    );
    const check = out.checks.find((c) => c.name === "Notifications")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toBe(
      "2 configured (slack, teams); TEAMS_URL not set, so a publishing run fails before writing"
    );
  });
});
