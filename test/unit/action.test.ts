import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { planEvent, readContext, type RunContext } from "../../src/action/context";
import { INPUT_DEFAULTS, readInputs, type Inputs } from "../../src/action/inputs";
import type { ActionsIO } from "../../src/action/io";
import { main, MAX_ANNOTATIONS } from "../../src/action/main";
import { ReleaseRayError } from "../../src/core/errors";
import type { IssueData, PullData } from "../../src/core/fetch/github";
import type { LLMProvider } from "../../src/core/llm/provider";
import { createFakeProvider } from "../../src/core/llm/providers/fake";
import { recordedGitHub } from "../helpers/fake-github";
import { createTestRepo, type TestRepo } from "../helpers/git-repo";

const ROOT = join(__dirname, "..", "..");
const data = JSON.parse(
  readFileSync(join(ROOT, "test", "fixtures", "golden", "github.json"), "utf8")
) as { pulls: PullData[]; issues: IssueData[] };

/** A fake runner I/O that records everything. */
function fakeIO(inputs: Record<string, string> = {}) {
  const log = {
    outputs: {} as Record<string, string>,
    summary: "",
    errors: [] as string[],
    warnings: [] as string[],
    notices: [] as string[],
  };
  const io: ActionsIO = {
    getInput: (name) => inputs[name] ?? "",
    setOutput: (name, value) => {
      log.outputs[name] = value;
    },
    writeSummary: async (md) => {
      log.summary += md;
    },
    error: (m) => log.errors.push(m),
    warning: (m) => log.warnings.push(m),
    notice: (m) => log.notices.push(m),
    info: () => {},
    debug: () => {},
    setSecret: () => {},
  };
  return { io, log };
}

const baseInputs = (overrides: Partial<Inputs> = {}): Inputs => ({
  ...readInputs({ getInput: () => "" }),
  ...overrides,
});

const ctx = (
  eventName: string,
  payload: Record<string, unknown> = {},
  extra: Partial<RunContext> = {}
): RunContext => ({
  eventName,
  payload,
  owner: "acme",
  repo: "widgets",
  serverUrl: "https://github.com",
  apiUrl: "https://api.github.com",
  workspace: "/w",
  refName: "",
  refType: "",
  visibility: "unknown",
  ...extra,
});

function failure(fn: () => unknown): ReleaseRayError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseRayError);
    expect((error as ReleaseRayError).exitCode).toBe(2);
    return error as ReleaseRayError;
  }
  throw new Error("expected a ReleaseRayError");
}

describe("action.yml", () => {
  const meta = parse(readFileSync(join(ROOT, "action.yml"), "utf8")) as {
    inputs: Record<string, { default?: string }>;
    outputs: Record<string, unknown>;
    runs: { using: string; main: string };
  };

  it("declares exactly the inputs the entry layer reads, with the same defaults", () => {
    expect(Object.keys(meta.inputs).sort()).toEqual(Object.keys(INPUT_DEFAULTS).sort());
    for (const [name, value] of Object.entries(INPUT_DEFAULTS)) {
      if (name === "github-token") continue;
      expect(meta.inputs[name].default ?? "", name).toBe(value);
    }
    expect(meta.inputs["github-token"].default).toBe("${{ github.token }}");
  });

  it("runs the committed bundle on node24 and declares the documented outputs", () => {
    expect(meta.runs).toEqual({ using: "node24", main: "dist/action.js" });
    expect(Object.keys(meta.outputs).sort()).toEqual(
      [
        "changelog-changed",
        "from",
        "github-requests",
        "key",
        "llm-calls",
        "llm-cost-usd",
        "notes-digest",
        "notes-dir",
        "release-changed",
        "release-url",
        "to",
      ].sort()
    );
  });
});

describe("inputs", () => {
  it("maps blank values to defaults and parses booleans strictly", () => {
    const inputs = readInputs({ getInput: (n) => ({ force: "True", publish: "" })[n] ?? "" });
    expect(inputs.mode).toBe("generate");
    expect(inputs.config).toBe(".releaseray/config.yml");
    expect(inputs.force).toBe(true);
    expect(inputs.publish).toBeNull();
    expect(
      failure(() => readInputs({ getInput: (n) => (n === "force" ? "yes" : "") })).details
    ).toEqual(['force: expected true or false, got "yes"']);
  });

  it("rejects unknown and v1.1 modes", () => {
    expect(
      failure(() => readInputs({ getInput: (n) => (n === "mode" ? "adopt" : "") })).details
    ).toEqual(["mode: adopt arrives in v1.1"]);
    expect(() => readInputs({ getInput: (n) => (n === "mode" ? "run" : "") })).toThrow(
      ReleaseRayError
    );
  });

  it("splits personas", () => {
    expect(
      readInputs({ getInput: (n) => (n === "personas" ? " engineer, customer ," : "") }).personas
    ).toEqual(["engineer", "customer"]);
  });
});

describe("event allowlist", () => {
  const today = "2026-09-14";

  it("refuses pull_request_target, workflow_run and other events", () => {
    expect(failure(() => planEvent(ctx("pull_request_target"), baseInputs(), today)).message).toBe(
      "pull_request_target is not supported"
    );
    expect(failure(() => planEvent(ctx("workflow_run"), baseInputs(), today)).details[0]).toMatch(
      /Dispatch the release-notes workflow from your release job/
    );
    expect(() => planEvent(ctx("issues"), baseInputs(), today)).toThrow(ReleaseRayError);
  });

  it("runs pull_request as a preview without prompts or publishing", () => {
    const plan = planEvent(ctx("pull_request"), baseInputs({ previewPrompts: true }), today);
    expect(plan).toMatchObject({ mode: "preview", publish: false, previewPrompts: false });
    expect(plan.range).toEqual({ kind: "unreleased", today });
    expect(plan.notices[0]).toMatch(/preview only/);
  });

  it("takes the tag from a published release and publishes by default", () => {
    const plan = planEvent(
      ctx("release", { action: "published", release: { tag_name: "v1.2.0" } }),
      baseInputs(),
      today
    );
    expect(plan).toMatchObject({
      mode: "generate",
      publish: true,
      range: { kind: "tag", to: "v1.2.0" },
    });
    expect(() =>
      planEvent(
        ctx("release", { action: "created", release: { tag_name: "v1" } }),
        baseInputs(),
        today
      )
    ).toThrow(/action "created"/);
  });

  it("takes the tag from a tag push, and needs to on a branch push", () => {
    expect(
      planEvent(ctx("push", {}, { refType: "tag", refName: "v2.0.0" }), baseInputs(), today)
    ).toMatchObject({ publish: true, range: { kind: "tag", to: "v2.0.0" } });
    expect(
      failure(() =>
        planEvent(ctx("push", {}, { refType: "branch", refName: "main" }), baseInputs(), today)
      ).message
    ).toBe("A push to a branch needs an explicit to");
    expect(
      planEvent(ctx("push", {}, { refType: "branch" }), baseInputs({ to: "v2.0.0" }), today).publish
    ).toBe(false);
  });

  it("needs to on a dispatch and does not publish unless asked", () => {
    expect(failure(() => planEvent(ctx("workflow_dispatch"), baseInputs(), today)).message).toBe(
      "No release tag"
    );
    expect(
      planEvent(ctx("workflow_dispatch"), baseInputs({ to: "v1.2.0", from: "v1.0.0" }), today)
    ).toMatchObject({ publish: false, range: { kind: "tag", to: "v1.2.0", from: "v1.0.0" } });
    expect(
      planEvent(ctx("workflow_dispatch"), baseInputs({ to: "v1.2.0", publish: true }), today)
        .publish
    ).toBe(true);
  });

  it("previews HEAD on a schedule and never publishes", () => {
    const plan = planEvent(ctx("schedule"), baseInputs({ publish: true }), today);
    expect(plan).toMatchObject({ publish: false, range: { kind: "unreleased", today } });
    expect(plan.notices).toContain("Scheduled runs never publish; publish was turned off");
  });

  it("builds date windows and requires their key", () => {
    expect(
      failure(() => planEvent(ctx("workflow_dispatch"), baseInputs({ since: "2026-01-01" }), today))
        .message
    ).toBe("A date window needs the key input");
    expect(
      planEvent(
        ctx("workflow_dispatch"),
        baseInputs({ since: "2026-01-01", key: "2026-q1" }),
        today
      ).range
    ).toEqual({ kind: "window", since: "2026-01-01", key: "2026-q1" });
  });

  it("reads repository visibility from the payload", () => {
    const env = {
      GITHUB_REPOSITORY: "acme/widgets",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_WORKSPACE: "/w",
      GITHUB_EVENT_PATH: "/event.json",
    };
    const read = (priv: unknown) => () => JSON.stringify({ repository: { private: priv } });
    expect(readContext(env, read(true)).visibility).toBe("private");
    expect(readContext(env, read(false)).visibility).toBe("public");
    expect(readContext(env, () => "{}").visibility).toBe("unknown");
    expect(() => readContext({}, () => "{}")).toThrow(/GITHUB_REPOSITORY is not set/);
  });
});

describe("main", () => {
  let repo: TestRepo;
  const dirs: string[] = [];
  beforeAll(() => {
    repo = createTestRepo();
    repo.commit("chore: initial commit", "2026-01-10");
    repo.tag("v1.1.0");
    repo.commit("feat!: drop Node 18 support (#14)", "2026-05-04");
    repo.commit("perf: parse large files in a stream (#15)", "2026-05-05");
    repo.commit("fix: keep column order when exporting (#17)", "2026-05-07");
    repo.tag("v1.2.0");
  });
  afterAll(() => {
    repo.remove();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function env(event: string, payload: Record<string, unknown> = {}, workspace = repo.dir) {
    const dir = mkdtempSync(join(tmpdir(), "releaseray-event-"));
    dirs.push(dir);
    writeFileSync(join(dir, "event.json"), JSON.stringify(payload));
    return {
      GITHUB_REPOSITORY: "acme/widgets",
      GITHUB_EVENT_NAME: event,
      GITHUB_EVENT_PATH: join(dir, "event.json"),
      GITHUB_WORKSPACE: workspace,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REF_NAME: "",
      GITHUB_REF_TYPE: "",
    };
  }

  function counting() {
    let calls = 0;
    const provider: LLMProvider = {
      async generateStructured(...args) {
        calls++;
        return createFakeProvider().generateStructured(...args);
      },
    };
    return { factory: async () => provider, calls: () => calls };
  }

  const deps = (io: ActionsIO, e: Record<string, string>, llm = counting()) => ({
    io,
    env: e,
    now: () => new Date("2026-09-14T12:00:00Z"),
    sleep: async () => {},
    github: () => recordedGitHub(data).reader,
    provider: llm.factory,
  });

  it("completes Flow 1 on a published release with every dispatch-only input blank", async () => {
    const { io, log } = fakeIO({ "github-token": "t" });
    const llm = counting();
    const code = await main(
      deps(
        io,
        env("release", {
          action: "published",
          release: { tag_name: "v1.2.0" },
          repository: { private: false },
        }),
        llm
      )
    );
    expect(log.errors).toEqual([]);
    expect(code).toBe(0);
    expect(llm.calls()).toBe(2);
    expect(log.outputs).toMatchObject({ key: "v1.2.0", from: "v1.1.0", "llm-calls": "2" });
    expect(log.summary).toContain("## Engineer");
  });

  it("previews on pull_request with no LLM call and exits 0", async () => {
    const { io, log } = fakeIO({ mode: "generate", "github-token": "t" });
    const llm = counting();
    const code = await main(deps(io, env("pull_request"), llm));
    expect(code).toBe(0);
    expect(llm.calls()).toBe(0);
    expect(log.summary).toContain("Approximate classification");
    expect(log.notices[0]).toMatch(/preview only/);
  });

  it("exits 2 on pull_request_target in its first step", async () => {
    const { io, log } = fakeIO();
    expect(await main(deps(io, env("pull_request_target")))).toBe(2);
    expect(log.errors[0]).toBe("pull_request_target is not supported");
    expect(log.summary).toContain("# ReleaseRay failed");
  });

  it("exits 2 on a depth-1 checkout and names fetch-depth: 0", async () => {
    const shallow = mkdtempSync(join(tmpdir(), "releaseray-shallow-"));
    dirs.push(shallow);
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${repo.dir}`, shallow]);
    const { io, log } = fakeIO({ to: "v1.2.0", "github-token": "t" });
    expect(await main(deps(io, env("workflow_dispatch", {}, shallow)))).toBe(2);
    expect(log.errors.join("\n")).toMatch(/fetch-depth: 0/);
  });

  it("runs validate-config with no secrets and annotates every problem", async () => {
    const ws = mkdtempSync(join(tmpdir(), "releaseray-ws-"));
    dirs.push(ws);
    mkdirSync(join(ws, ".releaseray"));
    writeFileSync(join(ws, ".releaseray/config.yml"), "version: 1\nllm: { provider: bedrock }\n");
    const { io, log } = fakeIO({ mode: "validate-config" });
    expect(await main({ ...deps(io, env("workflow_dispatch", {}, ws)), github: undefined })).toBe(
      2
    );
    expect(log.errors).toEqual(["llm.region: required when llm.provider is bedrock"]);
  });

  it("runs doctor and migrate-personas", async () => {
    const one = fakeIO({ mode: "doctor", "github-token": "t" });
    expect(await main(deps(one.io, env("workflow_dispatch")))).toBe(0);
    expect(one.log.summary).toContain("# ReleaseRay doctor");

    const ws = mkdtempSync(join(tmpdir(), "releaseray-ws-"));
    dirs.push(ws);
    mkdirSync(join(ws, ".releaseray"));
    writeFileSync(
      join(ws, ".releaseray/personas.yml"),
      readFileSync(join(ROOT, "test/fixtures/personas/legacy.yml"), "utf8")
    );
    const two = fakeIO({ mode: "migrate-personas" });
    expect(await main(deps(two.io, env("workflow_dispatch", {}, ws)))).toBe(0);
    expect(two.log.summary).toContain("personas migrated");
  });

  it("collapses more than 10 warnings into 10 annotations", async () => {
    const ws = mkdtempSync(join(tmpdir(), "releaseray-ws-"));
    dirs.push(ws);
    mkdirSync(join(ws, ".releaseray"));
    const personas = Array.from({ length: 12 }, (_, i) => ({
      name: `P${i}`,
      slug: `P ${i}`,
      tone: "x",
    }));
    writeFileSync(join(ws, ".releaseray/personas.yml"), JSON.stringify({ personas }));
    const { io, log } = fakeIO({ mode: "migrate-personas" });
    await main(deps(io, env("workflow_dispatch", {}, ws)));
    expect(log.warnings).toHaveLength(MAX_ANNOTATIONS);
    expect(log.warnings.at(-1)).toMatch(/more warnings; see the job summary/);
  });
});
