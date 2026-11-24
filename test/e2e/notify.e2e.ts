/**
 * Notifications from the bundle (CONVERSION-PLAN §7.4): Phase 5 criterion 2,
 * notify once. The Slack requests are recorded by a preload, so the bundle
 * runs unchanged, host allowlist included.
 */
import { afterAll, describe, expect, it } from "vitest";
import { cleanup, cloneWorkspace } from "./harness/git-fixture";
import { notifyRecorder } from "./harness/run-action";
import { buildWorld, type World } from "./harness/world";

const worlds: World[] = [];
afterAll(async () => {
  await Promise.all(worlds.map((w) => w.stop()));
  cleanup();
});

const CONFIG = [
  "version: 1",
  "outputs:",
  "  notify:",
  "    - { type: slack, persona: engineer, webhookUrlEnv: RELEASERAY_SLACK_WEBHOOK_URL }",
  "",
].join("\n");

// Built at runtime so secret scanners stay quiet (CONTRIBUTING.md).
const WEBHOOK = ["https://hooks.slack.com", "services", "T0E2E", "B0E2E", "notify"].join("/");

describe("5.2 notify once", () => {
  it("sends one Slack request for two identical runs, and one more with notify: always", async () => {
    const w = await buildWorld({ config: CONFIG });
    worlds.push(w);
    w.gh.addRelease({ tag: "v1.1.0", body: "Intro." });
    const recorder = notifyRecorder();
    const env = { ...recorder.env, RELEASERAY_SLACK_WEBHOOK_URL: WEBHOOK };
    const onRelease = () =>
      w.run({
        workspace: cloneWorkspace(w.origin, { ref: "v1.1.0" }),
        event: "release",
        payload: { action: "published", release: { tag_name: "v1.1.0" } },
        inputs: { to: "v1.1.0", publish: "true" },
        env,
      });

    const first = await onRelease();
    expect(first.errors).toEqual([]);
    expect(first.outputs).toMatchObject({ "release-changed": "true", "exit-code": "0" });
    expect(first.summary).toContain("- Slack (engineer): sent");
    const second = await onRelease();
    expect(second.code).toBe(0);
    expect(second.outputs).toMatchObject({ "release-changed": "false", "llm-calls": "0" });
    expect(recorder.requests()).toHaveLength(1);

    const [sent] = recorder.requests();
    expect(sent).toMatchObject({ method: "POST", url: WEBHOOK });
    const message = JSON.parse(sent.body) as { text: string; blocks: unknown[] };
    expect(message.text).toBe("v1.1.0 released for acme/widgets");
    expect(JSON.stringify(message.blocks)).toContain(
      "https://github.com/acme/widgets/releases/tag/v1.1.0"
    );

    const resend = await w.run({
      workspace: cloneWorkspace(w.origin),
      event: "workflow_dispatch",
      payload: { inputs: { to: "v1.1.0", publish: "true", notify: "always" } },
      inputs: { to: "v1.1.0", publish: "true", notify: "always" },
      env,
    });
    expect(resend.code).toBe(0);
    expect(resend.outputs).toMatchObject({ "release-changed": "false", "llm-calls": "0" });
    expect(recorder.requests()).toHaveLength(2);
    expect(recorder.requests()[1].body).toBe(sent.body);
    expect(w.gh.writes()).toHaveLength(1);

    // The URL is masked for the runner and printed nowhere else.
    for (const run of [first, second, resend]) {
      const lines = `${run.stdout}\n${run.stderr}`.split("\n");
      expect(lines.filter((l) => l.includes(WEBHOOK))).toEqual([`::add-mask::${WEBHOOK}`]);
      expect(run.summary).not.toContain(WEBHOOK);
    }
  });

  it("refuses a webhook on another host, after the release write, with exit 7", async () => {
    const w = await buildWorld({ config: CONFIG });
    worlds.push(w);
    w.gh.addRelease({ tag: "v1.1.0", body: "Intro." });
    const recorder = notifyRecorder();
    const run = await w.run({
      workspace: cloneWorkspace(w.origin, { ref: "v1.1.0" }),
      event: "release",
      payload: { action: "published", release: { tag_name: "v1.1.0" } },
      inputs: { to: "v1.1.0", publish: "true" },
      env: {
        ...recorder.env,
        RELEASERAY_SLACK_WEBHOOK_URL: WEBHOOK.replace(
          "hooks.slack.com",
          "hooks.slack.com.evil.test"
        ),
      },
    });
    expect(run.code).toBe(7);
    expect(run.outputs).toMatchObject({ "release-changed": "true", "exit-code": "7" });
    expect(run.errors.join("\n")).toContain("Invalid Slack webhook URL");
    expect(recorder.requests()).toEqual([]);
  });

  it("fails before any write when the webhook variable is not set", async () => {
    const w = await buildWorld({ config: CONFIG });
    worlds.push(w);
    w.gh.addRelease({ tag: "v1.1.0", body: "Intro." });
    const recorder = notifyRecorder();
    const run = await w.run({
      workspace: cloneWorkspace(w.origin, { ref: "v1.1.0" }),
      event: "release",
      payload: { action: "published", release: { tag_name: "v1.1.0" } },
      inputs: { to: "v1.1.0", publish: "true" },
      env: recorder.env,
    });
    expect(run.code).toBe(2);
    expect(run.errors.join("\n")).toContain("RELEASERAY_SLACK_WEBHOOK_URL is not set");
    expect(w.gh.writes()).toEqual([]);
    expect(recorder.requests()).toEqual([]);
  });
});
