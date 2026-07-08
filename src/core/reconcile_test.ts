import { assertEquals } from "@std/assert";
import { reconcile } from "./reconcile.ts";
import type { LocalGistDir } from "./snippets.ts";
const entry = {
  id: "g1",
  visibility: "public" as const,
  remote_updated_at: "t1",
  synced_description_hash: null,
  files: { "a.md": "h1" },
};
function local(
  files: Record<string, string> = { "a.md": "h1" },
  dh: string | null = null,
): LocalGistDir {
  return { dirname: "one", files, description: dh ? "desc" : "", descriptionHash: dh };
}
Deno.test("reconcile v2 covers directory and drift states", () => {
  assertEquals(
    reconcile(new Map([["one", local()]]), { version: 2, gists: {} }).at(0)?.condition,
    "unpublished",
  );
  assertEquals(
    reconcile(new Map(), { version: 2, gists: { one: entry } }).at(0)?.condition,
    "dir-missing",
  );
  assertEquals(
    reconcile(new Map([["one", local()]]), { version: 2, gists: { one: entry } }, new Map()).at(0)
      ?.condition,
    "remote-deleted",
  );
  assertEquals(
    reconcile(new Map([["one", local({ "a.md": "changed" })]]), {
      version: 2,
      gists: { one: entry },
    }).at(0)?.condition,
    "local-drift",
  );
  assertEquals(
    reconcile(new Map([["one", local({ "a.md": "h1", "b.md": "h2" })]]), {
      version: 2,
      gists: { one: entry },
    }).at(0)?.condition,
    "local-drift",
  );
  assertEquals(
    reconcile(new Map([["one", local({})]]), { version: 2, gists: { one: entry } }).at(0)
      ?.condition,
    "local-drift",
  );
  assertEquals(
    reconcile(new Map([["one", local({ "a.md": "h1" }, "dh")]]), {
      version: 2,
      gists: { one: entry },
    }).at(0)?.condition,
    "local-drift",
  );
  assertEquals(
    reconcile(
      new Map([["one", local()]]),
      { version: 2, gists: { one: entry } },
      new Map([["g1", { updated_at: "t2" }]]),
    ).at(0)?.condition,
    "remote-drift",
  );
  assertEquals(
    reconcile(new Map([["one", local({ "a.md": "changed" })]]), {
      version: 2,
      gists: { one: entry },
    }, new Map([["g1", { updated_at: "t2" }]])).at(0)?.condition,
    "conflict",
  );
});
