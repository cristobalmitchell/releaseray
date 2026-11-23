/**
 * A stateful fake of the GitHub REST endpoints the Action calls, on
 * 127.0.0.1 at a random port. Responses carry the documented fields the
 * Action reads (see src/core/fetch/github.ts and
 * src/outputs/github-release/sink.ts) and nothing it does not.
 *
 * Behavior that matters for the criteria follows the REST reference:
 * "Get a release by tag name" returns published releases only, updates
 * change only the fields sent, every response carries the x-ratelimit
 * headers, and lists fit on one page (no Link header).
 *
 * Every request is logged with its route template, so a test can compare
 * the server's count with the `github-requests` output and count writes.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A pull request in the fake. */
export interface FakePull {
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string;
  mergedAt: string | null;
}

/** An issue in the fake (numbers are shared with pull requests). */
export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  author: string;
}

/** An issue or pull request comment, or a review. */
export interface FakeComment {
  number: number;
  author: string;
  body: string;
  association: string;
  kind: "comment" | "review";
}

/** A release in the fake. */
export interface FakeRelease {
  id: number;
  tag: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
}

/** One logged request. */
export interface LoggedRequest {
  method: string;
  /** Route template, as Octokit names routes, such as `GET /repos/{owner}/{repo}/pulls/{pull_number}`. */
  route: string;
  status: number;
}

/** Options that change the fake's behavior. */
export interface FakeGitHubOptions {
  owner?: string;
  repo?: string;
  /** The core limit the x-ratelimit headers and /rate_limit report. */
  rateLimit?: number;
  /** Return release bodies with CRLF line endings, as some clients store them. */
  crlfReleaseBodies?: boolean;
}

type Handler = (
  params: Record<string, string>,
  body: Record<string, unknown>
) => { status: number; json: unknown };

const SERVER = "https://github.com";

/** The fake server. */
export class FakeGitHub {
  readonly owner: string;
  readonly repo: string;
  readonly pulls = new Map<number, FakePull>();
  readonly issues = new Map<number, FakeIssue>();
  readonly comments: FakeComment[] = [];
  readonly releases: FakeRelease[] = [];
  readonly log: LoggedRequest[] = [];
  private nextReleaseId = 1000;
  private used = 0;
  private readonly limit: number;
  private readonly reset = Math.floor(Date.now() / 1000) + 3600;
  private server: Server | null = null;
  private readonly routes: Array<{
    method: string;
    route: string;
    pattern: RegExp;
    handler: Handler;
  }>;

  constructor(private readonly options: FakeGitHubOptions = {}) {
    this.owner = options.owner ?? "acme";
    this.repo = options.repo ?? "widgets";
    this.limit = options.rateLimit ?? 5000;
    const r = "/repos/{owner}/{repo}";
    this.routes = [
      this.route("GET", "/rate_limit", () => this.rateLimitBody()),
      this.route("GET", `${r}/pulls/{pull_number}`, (p) => this.getPull(Number(p.pull_number))),
      this.route("GET", `${r}/pulls/{pull_number}/reviews`, (p) =>
        this.listComments(Number(p.pull_number), "review")
      ),
      this.route("GET", `${r}/issues/{issue_number}`, (p) => this.getIssue(Number(p.issue_number))),
      this.route("GET", `${r}/issues/{issue_number}/comments`, (p) =>
        this.listComments(Number(p.issue_number), "comment")
      ),
      this.route("GET", `${r}/releases/tags/{tag}`, (p) => this.getReleaseByTag(p.tag)),
      this.route("GET", `${r}/releases`, () => ({
        status: 200,
        json: [...this.releases].reverse().map((rel) => this.releaseJson(rel)),
      })),
      this.route("POST", `${r}/releases`, (_p, body) => this.createRelease(body)),
      this.route("PATCH", `${r}/releases/{release_id}`, (p, body) =>
        this.updateRelease(Number(p.release_id), body)
      ),
    ];
  }

  private route(method: string, route: string, handler: Handler) {
    const pattern = new RegExp(
      `^${route.replace(/\{(\w+)\}/g, (_m, name: string) => `(?<${name}>[^/]+)`)}$`
    );
    return { method, route: `${method} ${route}`, pattern, handler };
  }

  /** Adds a merged pull request (and its issue twin, as the issues API sees it). */
  addPull(
    pull: Omit<FakePull, "labels" | "author" | "mergedAt" | "body"> & Partial<FakePull>
  ): void {
    this.pulls.set(pull.number, {
      body: "",
      labels: [],
      author: "octo-dev",
      mergedAt: "2026-11-01T12:00:00Z",
      ...pull,
    });
  }

  /** Adds an issue. */
  addIssue(issue: Omit<FakeIssue, "labels" | "author" | "body"> & Partial<FakeIssue>): void {
    this.issues.set(issue.number, { body: "", labels: [], author: "octo-user", ...issue });
  }

  /** Adds a release, published unless `draft`. */
  addRelease(release: Partial<FakeRelease> & { tag: string }): FakeRelease {
    const stored: FakeRelease = {
      id: this.nextReleaseId++,
      name: release.tag,
      body: "",
      draft: false,
      prerelease: false,
      ...release,
    };
    this.releases.push(stored);
    return stored;
  }

  /** The release for a tag, drafts included. */
  release(tag: string): FakeRelease | undefined {
    return this.releases.find((r) => r.tag === tag);
  }

  /** Requests other than GET (writes). */
  writes(): LoggedRequest[] {
    return this.log.filter((l) => l.method !== "GET");
  }

  /** Requests the Action counts against its budget: all but GET /rate_limit. */
  counted(): number {
    return this.log.filter((l) => l.route !== "GET /rate_limit").length;
  }

  /** Starts listening; returns the base URL for GITHUB_API_URL. */
  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /** Stops listening. */
  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const method = (req.method ?? "GET").toUpperCase();
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let status = 404;
    let json: unknown = { message: "Not Found", documentation_url: "https://docs.github.com/rest" };
    let route = `${method} ${path}`;
    if (!/^(token|bearer) \S+/i.test(req.headers.authorization ?? "")) {
      status = 401;
      json = { message: "Requires authentication" };
    } else {
      for (const r of this.routes) {
        if (r.method !== method) continue;
        const m = r.pattern.exec(path);
        if (!m) continue;
        route = r.route;
        const params = m.groups ?? {};
        if (
          params.owner !== undefined &&
          (params.owner !== this.owner || params.repo !== this.repo)
        ) {
          break;
        }
        ({ status, json } = r.handler(
          params,
          raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
        ));
        break;
      }
    }
    this.log.push({ method, route, status });
    if (route !== "GET /rate_limit") this.used++;
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      ...this.rateHeaders(),
    });
    res.end(JSON.stringify(json));
  }

  private rateHeaders(): Record<string, string> {
    return {
      "x-ratelimit-limit": String(this.limit),
      "x-ratelimit-remaining": String(Math.max(0, this.limit - this.used)),
      "x-ratelimit-used": String(this.used),
      "x-ratelimit-reset": String(this.reset),
      "x-ratelimit-resource": "core",
    };
  }

  private rateLimitBody() {
    const core = {
      limit: this.limit,
      used: this.used,
      remaining: Math.max(0, this.limit - this.used),
      reset: this.reset,
    };
    return { status: 200, json: { resources: { core }, rate: core } };
  }

  private user(login: string) {
    return { login };
  }

  private labels(names: string[]) {
    return names.map((name) => ({ name }));
  }

  private notFound() {
    return { status: 404, json: { message: "Not Found" } };
  }

  private getPull(n: number) {
    const p = this.pulls.get(n);
    if (!p) return this.notFound();
    return {
      status: 200,
      json: {
        number: p.number,
        title: p.title,
        body: p.body,
        labels: this.labels(p.labels),
        user: this.user(p.author),
        merged: p.mergedAt !== null,
        merged_at: p.mergedAt,
        html_url: `${SERVER}/${this.owner}/${this.repo}/pull/${p.number}`,
      },
    };
  }

  private getIssue(n: number) {
    const pull = this.pulls.get(n);
    const issue = this.issues.get(n);
    const item = pull ?? issue;
    if (!item) return this.notFound();
    return {
      status: 200,
      json: {
        number: item.number,
        title: item.title,
        body: item.body,
        labels: this.labels(item.labels),
        user: this.user(item.author),
        html_url: `${SERVER}/${this.owner}/${this.repo}/${pull ? "pull" : "issues"}/${n}`,
        ...(pull
          ? { pull_request: { url: `${SERVER}/${this.owner}/${this.repo}/pull/${n}` } }
          : {}),
      },
    };
  }

  private listComments(n: number, kind: FakeComment["kind"]) {
    if (!this.pulls.has(n) && !this.issues.has(n)) return this.notFound();
    return {
      status: 200,
      json: this.comments
        .filter((c) => c.number === n && c.kind === kind)
        .map((c) => ({
          user: this.user(c.author),
          body: c.body,
          author_association: c.association,
        })),
    };
  }

  private releaseJson(r: FakeRelease) {
    const body = this.options.crlfReleaseBodies ? r.body.replace(/\r?\n/g, "\r\n") : r.body;
    return {
      id: r.id,
      tag_name: r.tag,
      name: r.name,
      body,
      draft: r.draft,
      prerelease: r.prerelease,
      html_url: `${SERVER}/${this.owner}/${this.repo}/releases/tag/${r.tag}`,
    };
  }

  private getReleaseByTag(tag: string) {
    // "Get a published release with the specified tag": drafts are not returned.
    const r = this.releases.find((x) => x.tag === tag && !x.draft);
    return r ? { status: 200, json: this.releaseJson(r) } : this.notFound();
  }

  private createRelease(body: Record<string, unknown>) {
    const tag = String(body.tag_name ?? "");
    if (!tag) return { status: 422, json: { message: "Validation Failed" } };
    if (this.releases.some((r) => r.tag === tag && !r.draft)) {
      return { status: 422, json: { message: "Validation Failed: tag_name already_exists" } };
    }
    const r = this.addRelease({
      tag,
      name: String(body.name ?? tag),
      body: String(body.body ?? ""),
      draft: body.draft === true,
      prerelease: body.prerelease === true,
    });
    return { status: 201, json: this.releaseJson(r) };
  }

  private updateRelease(id: number, body: Record<string, unknown>) {
    const r = this.releases.find((x) => x.id === id);
    if (!r) return this.notFound();
    // Only the fields sent change.
    if (typeof body.body === "string") r.body = body.body;
    if (typeof body.name === "string") r.name = body.name;
    if (typeof body.draft === "boolean") r.draft = body.draft;
    if (typeof body.prerelease === "boolean") r.prerelease = body.prerelease;
    return { status: 200, json: this.releaseJson(r) };
  }
}
