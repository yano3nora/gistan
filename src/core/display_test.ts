import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { descriptionFor, displayPath, idSegment, loadDescriptions } from "./display.ts";

// -- displayPath --------------------------------------------------------------

Deno.test("displayPath strips the gist id from a published gists/ path", () => {
  assertEquals(displayPath("gists/abc123/note.md"), "note.md");
});

Deno.test("displayPath strips the gist id but keeps the owner for stars/ paths", () => {
  assertEquals(displayPath("stars/octocat/abc123/note.md"), "stars/octocat/note.md");
});

Deno.test("displayPath passes a bare gists/<file> through unchanged (no id segment to hide)", () => {
  assertEquals(displayPath("gists/note.md"), "gists/note.md");
});

Deno.test("displayPath passes depth-2+ nested gists/ paths through unchanged (unmanaged, status warns)", () => {
  assertEquals(displayPath("gists/abc123/sub/note.md"), "gists/abc123/sub/note.md");
});

Deno.test("displayPath passes nested stars/ paths through unchanged", () => {
  assertEquals(displayPath("stars/octocat/abc123/sub/note.md"), "stars/octocat/abc123/sub/note.md");
});

Deno.test("displayPath passes unmanaged top-level paths through unchanged", () => {
  assertEquals(displayPath("README.md"), "README.md");
  assertEquals(displayPath("stars/octocat"), "stars/octocat");
});

// -- idSegment ------------------------------------------------------------------

Deno.test("idSegment reads the dirname for gists/ paths, even a bare dir with no file", () => {
  assertEquals(idSegment("gists/abc123/note.md"), "abc123");
  assertEquals(idSegment("gists/abc123"), "abc123");
});

Deno.test("idSegment reads the 3rd segment (the gist id) for stars/ paths", () => {
  assertEquals(idSegment("stars/octocat/abc123/note.md"), "abc123");
});

Deno.test("idSegment is undefined for anything without a resolvable id segment", () => {
  assertEquals(idSegment("stars/octocat"), undefined);
  assertEquals(idSegment("README.md"), undefined);
  assertEquals(idSegment("gists"), undefined);
  assertEquals(idSegment(""), undefined);
});

// -- loadDescriptions / descriptionFor -------------------------------------------

async function descFixture(): Promise<string> {
  const repo = await Deno.makeTempDir();
  await Deno.mkdir(join(repo, ".gistan", "cache"), { recursive: true });
  await Deno.writeTextFile(
    join(repo, ".gistan", "state.json"),
    JSON.stringify({
      version: 3,
      gists: {
        abc123: {
          visibility: "public",
          description: "a published gist",
          remote_updated_at: "2026-07-08T00:00:00Z",
          files: { "note.md": "sha256:x" },
        },
        // An empty description must never surface as a match target.
        def456: {
          visibility: "secret",
          description: "",
          remote_updated_at: "2026-07-08T00:00:00Z",
          files: {},
        },
      },
      locals: { _ab: { description: "an unpublished draft" } },
    }),
  );
  await Deno.writeTextFile(
    join(repo, ".gistan", "cache", "stars.json"),
    JSON.stringify({
      version: 1,
      stars: {
        star789: {
          owner: "octocat",
          description: "someone else's gist",
          updated_at: "2026-07-08T00:00:00Z",
          fetched_at: "2026-07-08T00:00:00Z",
        },
      },
    }),
  );
  return repo;
}

Deno.test("loadDescriptions merges published + local + star descriptions, keyed by dir/id", async () => {
  const repo = await descFixture();
  const descriptions = await loadDescriptions(repo);
  assertEquals(descriptions.get("abc123"), "a published gist");
  assertEquals(descriptions.get("_ab"), "an unpublished draft");
  assertEquals(descriptions.get("star789"), "someone else's gist");
  assertEquals(descriptions.has("def456"), false); // empty description excluded
});

Deno.test("descriptionFor resolves a repo path through idSegment against the merged map", async () => {
  const repo = await descFixture();
  const descriptions = await loadDescriptions(repo);
  assertEquals(descriptionFor(descriptions, "gists/abc123/note.md"), "a published gist");
  assertEquals(descriptionFor(descriptions, "gists/_ab/draft.md"), "an unpublished draft");
  assertEquals(
    descriptionFor(descriptions, "stars/octocat/star789/note.md"),
    "someone else's gist",
  );
  assertEquals(descriptionFor(descriptions, "gists/unknown-id/x.md"), "");
  assertEquals(descriptionFor(descriptions, "README.md"), "");
});

Deno.test("loadDescriptions on a repo with no index/cache yet returns an empty map", async () => {
  const repo = await Deno.makeTempDir();
  const descriptions = await loadDescriptions(repo);
  assertEquals(descriptions.size, 0);
});
