import type { ReleaseApi, ReleaseTarget } from "../../src/outputs/github-release/sink";

/** A release as stored by the fake, with the fields updates must keep. */
export interface FakeRelease extends ReleaseTarget {
  tag: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
}

/**
 * An in-memory release API that records writes. Updates change only the
 * body, as the real sink's PATCH does.
 *
 * @param initial - Releases that exist at the start
 * @returns The API, the stored releases and the write log
 */
export function fakeReleases(initial: Array<Partial<FakeRelease> & { tag: string }> = []) {
  let nextId = 100;
  const releases = new Map<string, FakeRelease>(
    initial.map((r) => [
      r.tag,
      {
        id: nextId++,
        body: "",
        url: `https://github.com/acme/widgets/releases/tag/${r.tag}`,
        name: `Release ${r.tag}`,
        draft: false,
        prerelease: false,
        ...r,
      },
    ])
  );
  const writes: Array<{ kind: "create" | "update"; tag: string; fields: string[] }> = [];
  let reads = 0;
  const api: ReleaseApi & { failCreate?: Error } = {
    async get(tag) {
      reads++;
      const r = releases.get(tag);
      return r ? { id: r.id, body: r.body, url: r.url } : null;
    },
    async updateBody(id, body) {
      const r = [...releases.values()].find((x) => x.id === id)!;
      r.body = body;
      writes.push({ kind: "update", tag: r.tag, fields: ["body"] });
      return { id: r.id, body: r.body, url: r.url };
    },
    async create(input) {
      if (api.failCreate) throw api.failCreate;
      const r: FakeRelease = {
        id: nextId++,
        tag: input.tag,
        name: input.name,
        body: input.body,
        url: `https://github.com/acme/widgets/releases/tag/${input.tag}`,
        draft: false,
        prerelease: input.prerelease,
      };
      releases.set(input.tag, r);
      writes.push({ kind: "create", tag: input.tag, fields: ["name", "body", "prerelease"] });
      return { id: r.id, body: r.body, url: r.url };
    },
  };
  return { api, releases, writes, reads: () => reads };
}
