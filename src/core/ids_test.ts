import { assertEquals, assertMatch } from "@std/assert";
import { newLocalId, parseGistTarget } from "./ids.ts";

Deno.test("newLocalId generates a `_`-prefixed 9-character id", () => {
  const id = newLocalId(() => false);
  assertMatch(id, /^_[a-z0-9]{8}$/);
  assertEquals(id.length, 9);
});

Deno.test("newLocalId retries while the candidate is taken", () => {
  let calls = 0;
  const rejected = new Set<string>();
  const id = newLocalId((candidate) => {
    calls++;
    if (calls <= 3) {
      rejected.add(candidate);
      return true; // taken — forces a retry
    }
    return false;
  });
  assertEquals(calls, 4);
  assertMatch(id, /^_[a-z0-9]{8}$/);
  // The winning id was never one of the rejected candidates.
  assertEquals(rejected.has(id), false);
});

Deno.test("parseGistTarget passes through a bare gist id", () => {
  assertEquals(parseGistTarget("abc123"), "abc123");
});

Deno.test("parseGistTarget passes through a local id unchanged", () => {
  assertEquals(parseGistTarget("_a1b2c3d4"), "_a1b2c3d4");
});

Deno.test("parseGistTarget extracts the id from an owner-qualified gist URL", () => {
  assertEquals(parseGistTarget("https://gist.github.com/owner/abc123"), "abc123");
});

Deno.test("parseGistTarget extracts the id from an owner-less gist URL", () => {
  assertEquals(parseGistTarget("https://gist.github.com/abc123"), "abc123");
});

Deno.test("parseGistTarget strips a trailing slash before extracting the id", () => {
  assertEquals(parseGistTarget("https://gist.github.com/owner/abc123/"), "abc123");
});

Deno.test("parseGistTarget extracts the dirname from a bare gists/<id> path", () => {
  assertEquals(parseGistTarget("gists/abc123"), "abc123");
});

Deno.test("parseGistTarget extracts the dirname from a gists/<id>/<file> path", () => {
  assertEquals(parseGistTarget("gists/abc123/file.md"), "abc123");
});
