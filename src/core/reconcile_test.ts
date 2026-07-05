import { assertEquals } from "@std/assert";
import { reconcile } from "./reconcile.ts";
import type { GistLink, State } from "./state.ts";

const HASH = "sha256:current";
const SYNCED_AT = "2026-01-01T00:00:00Z";

function link(overrides: Partial<GistLink> = {}): GistLink {
  return {
    id: "g1",
    visibility: "public",
    synced_hash: HASH,
    remote_updated_at: SYNCED_AT,
    ...overrides,
  };
}

function published(gist: GistLink): State {
  return { version: 1, snippets: { "snippets/a.md": { tags: [], gist } } };
}

function conditionOf(state: State, options: {
  localHash?: string;
  remote?: ReadonlyMap<string, { updated_at: string }>;
}) {
  const files = new Map(
    options.localHash === undefined ? [] : [["snippets/a.md", options.localHash]],
  );
  return reconcile(files, state, options.remote)[0].condition;
}

const remoteUnchanged = new Map([["g1", { updated_at: SYNCED_AT }]]);
const remoteChanged = new Map([["g1", { updated_at: "2026-02-01T00:00:00Z" }]]);
const remoteWithout = new Map<string, { updated_at: string }>();

Deno.test("a file without a gist link is unpublished", () => {
  const untracked: State = { version: 1, snippets: {} };
  assertEquals(conditionOf(untracked, { localHash: HASH, remote: remoteUnchanged }), "unpublished");
  const trackedOnly: State = {
    version: 1,
    snippets: { "snippets/a.md": { tags: [], gist: null } },
  };
  assertEquals(
    conditionOf(trackedOnly, { localHash: HASH, remote: remoteUnchanged }),
    "unpublished",
  );
});

Deno.test("published snippet drift matrix", () => {
  const state = published(link());
  assertEquals(conditionOf(state, { localHash: HASH, remote: remoteUnchanged }), "in-sync");
  assertEquals(
    conditionOf(state, { localHash: "sha256:edited", remote: remoteUnchanged }),
    "local-drift",
  );
  assertEquals(conditionOf(state, { localHash: HASH, remote: remoteChanged }), "remote-drift");
  assertEquals(
    conditionOf(state, { localHash: "sha256:edited", remote: remoteChanged }),
    "conflict",
  );
  assertEquals(conditionOf(state, { localHash: HASH, remote: remoteWithout }), "remote-deleted");
});

Deno.test("without a remote list, judgement degrades to local-only", () => {
  const state = published(link());
  assertEquals(conditionOf(state, { localHash: HASH }), "remote-unknown");
  assertEquals(conditionOf(state, { localHash: "sha256:edited" }), "local-drift");
});

Deno.test("an index entry without a file is file-missing", () => {
  assertEquals(conditionOf(published(link()), { remote: remoteUnchanged }), "file-missing");
});

Deno.test("items come back sorted by path across files and index", () => {
  const state: State = {
    version: 1,
    snippets: { "snippets/z.md": { tags: [], gist: null } },
  };
  const files = new Map([["snippets/b.md", HASH], ["snippets/a.md", HASH]]);
  assertEquals(
    reconcile(files, state).map((item) => item.path),
    ["snippets/a.md", "snippets/b.md", "snippets/z.md"],
  );
});
