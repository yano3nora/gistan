import { assertEquals } from "@std/assert";
import { reconcile } from "./reconcile.ts";
import type { LocalGistDir } from "./snippets.ts";
import type { State } from "./state.ts";

const entry = {
  visibility: "public" as const,
  description: "",
  remote_updated_at: "t1",
  files: { "a.md": "h1" },
};

function state(gists: State["gists"] = {}): State {
  return { version: 3, gists, locals: {} };
}

function local(files: Record<string, string> = { "a.md": "h1" }): LocalGistDir {
  return { dirname: "one", files };
}

Deno.test("reconcile: local dir with no index entry is unpublished", () => {
  assertEquals(
    reconcile(new Map([["one", local()]]), state()).at(0)?.condition,
    "unpublished",
  );
});

Deno.test("reconcile: index entry with no local dir is dir-missing", () => {
  assertEquals(
    reconcile(new Map(), state({ one: entry })).at(0)?.condition,
    "dir-missing",
  );
});

Deno.test("reconcile: entry+dir with an empty remote map is remote-deleted", () => {
  assertEquals(
    reconcile(new Map([["one", local()]]), state({ one: entry }), new Map()).at(0)?.condition,
    "remote-deleted",
  );
});

Deno.test("reconcile: changed file content is local-drift", () => {
  assertEquals(
    reconcile(new Map([["one", local({ "a.md": "changed" })]]), state({ one: entry })).at(0)
      ?.condition,
    "local-drift",
  );
});

Deno.test("reconcile: an added file is local-drift", () => {
  assertEquals(
    reconcile(
      new Map([["one", local({ "a.md": "h1", "b.md": "h2" })]]),
      state({ one: entry }),
    ).at(0)?.condition,
    "local-drift",
  );
});

Deno.test("reconcile: a removed file is local-drift", () => {
  assertEquals(
    reconcile(new Map([["one", local({})]]), state({ one: entry })).at(0)?.condition,
    "local-drift",
  );
});

Deno.test("reconcile: matching files with no remote map is remote-unknown", () => {
  assertEquals(
    reconcile(new Map([["one", local()]]), state({ one: entry })).at(0)?.condition,
    "remote-unknown",
  );
});

Deno.test("reconcile: matching files and matching remote timestamp is in-sync", () => {
  assertEquals(
    reconcile(
      new Map([["one", local()]]),
      state({ one: entry }),
      new Map([["one", { updated_at: "t1" }]]),
    ).at(0)?.condition,
    "in-sync",
  );
});

Deno.test("reconcile: matching files but a changed remote timestamp is remote-drift", () => {
  assertEquals(
    reconcile(
      new Map([["one", local()]]),
      state({ one: entry }),
      new Map([["one", { updated_at: "t2" }]]),
    ).at(0)?.condition,
    "remote-drift",
  );
});

Deno.test("reconcile: local and remote both changed is conflict", () => {
  assertEquals(
    reconcile(
      new Map([["one", local({ "a.md": "changed" })]]),
      state({ one: entry }),
      new Map([["one", { updated_at: "t2" }]]),
    ).at(0)?.condition,
    "conflict",
  );
});

Deno.test("reconcile: a remote description-only change surfaces as remote-drift via updated_at, not a description comparison", () => {
  // ADR-0003: reconcile never compares descriptions directly — a remote
  // description edit is only visible because GitHub bumps updated_at.
  assertEquals(
    reconcile(
      new Map([["one", local()]]),
      state({ one: { ...entry, description: "stale index copy" } }),
      new Map([["one", { updated_at: "t2" }]]),
    ).at(0)?.condition,
    "remote-drift",
  );
});
