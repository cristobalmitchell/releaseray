/**
 * The live, read-only check (`pnpm test:e2e:live`, run by e2e.yml): the
 * committed bundle runs `mode: doctor` and `mode: preview` against this
 * repository on github.com with the job's own GITHUB_TOKEN and the fake
 * model. Every request goes through a local proxy that records it and
 * refuses anything but GET and HEAD, so "no writes" is checked rather than
 * assumed. Exits 1 unless both modes exit 0 with no write attempted and the
 * checkout unchanged.
 *
 * Environment: GITHUB_TOKEN, GITHUB_REPOSITORY, and optionally
 * GITHUB_API_URL and GITHUB_WORKSPACE (default: the current directory).
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cleanup } from "./harness/git-fixture";
import { runAction } from "./harness/run-action";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Headers passed back to the Action. */
const KEEP = /^(content-type|link|x-ratelimit-.*|retry-after|x-github-request-id)$/i;

async function main(): Promise<number> {
  const token = required("GITHUB_TOKEN");
  const repository = required("GITHUB_REPOSITORY");
  const upstream = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();

  const seen: Array<{ method: string; path: string; status: number }> = [];
  const proxy = createServer(async (req, res) => {
    const method = (req.method ?? "GET").toUpperCase();
    const path = req.url ?? "/";
    if (method !== "GET" && method !== "HEAD") {
      seen.push({ method, path, status: 403 });
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "The live e2e check refuses writes" }));
      return;
    }
    const response = await fetch(`${upstream}${path}`, {
      method,
      headers: {
        authorization: String(req.headers.authorization ?? ""),
        accept: String(req.headers.accept ?? "application/vnd.github+json"),
        "user-agent": String(req.headers["user-agent"] ?? "releaseray-e2e-live"),
        "x-github-api-version": String(req.headers["x-github-api-version"] ?? "2022-11-28"),
      },
    });
    seen.push({ method, path, status: response.status });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      if (!KEEP.test(name)) return;
      // Keep pagination on the proxy.
      headers[name] = name.toLowerCase() === "link" ? value.split(upstream).join(base) : value;
    });
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

  const state = () =>
    execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: workspace,
      encoding: "utf8",
    }) + execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" });
  const before = state();

  const failures: string[] = [];
  for (const mode of ["doctor", "preview"]) {
    const run = await runAction({
      workspace,
      event: "workflow_dispatch",
      payload: { inputs: {}, repository: { private: false } },
      repository,
      apiUrl: base,
      inputs: { mode, to: "HEAD", "github-token": token },
    });
    console.log(
      `${mode}: exit ${run.code}; outputs ${JSON.stringify(run.outputs)}; ${run.errors.length} errors`
    );
    for (const e of run.errors) console.log(`  error: ${e}`);
    if (run.code !== 0) failures.push(`${mode} exited ${run.code}`);
    if ((run.outputs["llm-calls"] ?? "0") !== "0") failures.push(`${mode} called a model`);
    if (run.outputs["release-changed"] === "true" || run.outputs["changelog-changed"] === "true") {
      failures.push(`${mode} reported a write`);
    }
  }
  proxy.close();
  cleanup();

  const writes = seen.filter((s) => s.method !== "GET" && s.method !== "HEAD");
  console.log(`${seen.length} requests to ${upstream}, ${writes.length} writes attempted`);
  if (writes.length > 0)
    failures.push(`write attempts: ${writes.map((w) => `${w.method} ${w.path}`).join(", ")}`);
  if (state() !== before) failures.push("the checkout changed");
  for (const f of failures) console.log(`::error title=live e2e::${f}`);
  return failures.length > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  }
);
