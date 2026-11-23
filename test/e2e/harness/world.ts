/**
 * A fixture repository and its fake GitHub, as most scenarios use them:
 * a root commit with the config, pull requests merged with merge commits,
 * and tags; the same pull requests and issues in the fake server.
 */
import { FakeGitHub, type FakeGitHubOptions } from "./github-server";
import {
  cloneWorkspace,
  createOrigin,
  HistoryBuilder,
  type Mark,
  type Origin,
} from "./git-fixture";
import { runAction, type ActionRun, type ActionStep } from "./run-action";

/** A pull request in a world. */
export interface WorldPull {
  number: number;
  title: string;
  body?: string;
  labels?: string[];
}

/** A built world. */
export interface World {
  gh: FakeGitHub;
  apiUrl: string;
  origin: Origin;
  /** The root commit and the merge commit of each pull request, in order. */
  marks: { root: Mark; merges: Mark[] };
  /** Runs the bundle with this world's API URL. */
  run(step: Omit<ActionStep, "apiUrl">): Promise<ActionRun>;
  /** Flow 1 on a published release (examples/workflows/release-notes.yml). */
  releasePublished(tag: string, options?: { private?: boolean }): Promise<ActionRun>;
  /** Flow 1 by dispatch with publish on or off. */
  dispatch(tag: string, inputs?: Record<string, string>): Promise<ActionRun>;
  /** Flow 2 on a tag push (examples/workflows/release-notes-on-tag.yml). */
  tagPushed(
    tag: string,
    options?: { workspace?: string; pathPrefix?: string[] }
  ): Promise<ActionRun>;
  stop(): Promise<void>;
}

/** The pull requests most scenarios use; #2 links issue #1. */
export const DEFAULT_PULLS: WorldPull[] = [
  {
    number: 2,
    title: "feat: add CSV export",
    body: "Adds `export --csv` so reports can be opened in a spreadsheet without a script.\n\nCloses #1.",
  },
  {
    number: 3,
    title: "fix: keep empty rows on import",
    body: "Empty rows no longer stop an import half way; they are kept and reported at the end.",
  },
  {
    number: 4,
    title: "perf: cache tag lookups",
    body: "Tag lookups are cached for the length of a run, which halves the time to list a long history.",
  },
];

/**
 * Builds a world.
 *
 * @param options - Root files, pull requests, tags by mark, fake server options
 * @returns The world, with its server started
 */
export async function buildWorld(
  options: {
    files?: Record<string, string>;
    config?: string;
    pulls?: WorldPull[];
    /** Tags to create; the default is v1.0.0 at the root and v1.1.0 at main. */
    tags?: (marks: { root: Mark; merges: Mark[] }) => Record<string, Mark>;
    /** More history, after main is built. */
    extend?: (history: HistoryBuilder, marks: { root: Mark; merges: Mark[] }) => void;
    github?: FakeGitHubOptions;
  } = {}
): Promise<World> {
  const pulls = options.pulls ?? DEFAULT_PULLS;
  const history = new HistoryBuilder();
  const root = history.commit("chore: start the project", {
    files: {
      "README.md": "# widgets\n",
      ...(options.config !== undefined ? { ".releaseray/config.yml": options.config } : {}),
      ...options.files,
    },
  });
  const merges: Mark[] = [];
  let tip = root;
  for (const pull of pulls) {
    tip = history.mergePull(tip, pull);
    merges.push(tip);
  }
  const marks = { root, merges };
  history.ref("refs/heads/main", tip);
  const tags = options.tags?.(marks) ?? { "v1.0.0": root, "v1.1.0": tip };
  for (const [tag, mark] of Object.entries(tags)) history.ref(`refs/tags/${tag}`, mark);
  options.extend?.(history, marks);
  const origin = createOrigin(history);

  const gh = new FakeGitHub(options.github);
  for (const pull of pulls) gh.addPull({ ...pull, labels: pull.labels ?? [] });
  gh.addIssue({ number: 1, title: "CSV export", body: "Customers want CSV." });
  const apiUrl = await gh.start();

  const run = (step: Omit<ActionStep, "apiUrl">) => runAction({ ...step, apiUrl });
  return {
    gh,
    apiUrl,
    origin,
    marks,
    run,
    releasePublished(tag, opts = {}) {
      return run({
        workspace: cloneWorkspace(origin, { ref: tag }),
        event: "release",
        payload: {
          action: "published",
          release: { tag_name: tag },
          repository: { private: opts.private ?? false },
        },
        // What release-notes.yml passes on a release event: every dispatch-only input blank.
        inputs: { to: tag, from: "", personas: "", publish: "true", force: "false" },
      });
    },
    dispatch(tag, inputs = {}) {
      return run({
        workspace: cloneWorkspace(origin),
        event: "workflow_dispatch",
        payload: { inputs: { to: tag, ...inputs } },
        inputs: { to: tag, publish: "false", force: "false", ...inputs },
      });
    },
    tagPushed(tag, opts = {}) {
      return run({
        workspace: opts.workspace ?? cloneWorkspace(origin, { ref: "main" }),
        event: "push",
        ref: { name: tag, type: "tag" },
        payload: { ref: `refs/tags/${tag}`, head_commit: { message: "a tagged commit" } },
        inputs: { to: tag, "create-release": "true", push: "true" },
        pathPrefix: opts.pathPrefix,
      });
    },
    stop: () => gh.stop(),
  };
}
