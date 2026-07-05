import { assertEquals } from "@std/assert";
import { buildDescription, parseDescription, slugify } from "./description.ts";

Deno.test("build follows the [tag]: title convention", () => {
  assertEquals(
    buildDescription(["react", "example"], "countdown.tsx"),
    "[react][example]: countdown.tsx",
  );
  assertEquals(buildDescription([], "memo.md"), "memo.md");
});

Deno.test("parse extracts tags and title", () => {
  assertEquals(parseDescription("[react][example]: countdown-timer.tsx"), {
    tags: ["react", "example"],
    title: "countdown-timer.tsx",
  });
  assertEquals(parseDescription("[mise] mise-en-place memo"), {
    tags: ["mise"],
    title: "mise-en-place memo",
  });
  assertEquals(parseDescription("plain description"), { tags: [], title: "plain description" });
  assertEquals(parseDescription(""), { tags: [], title: "" });
});

Deno.test("build and parse are symmetric", () => {
  const description = buildDescription(["a", "b"], "title.md");
  assertEquals(parseDescription(description), { tags: ["a", "b"], title: "title.md" });
});

Deno.test("slugify produces directory-safe names", () => {
  assertEquals(slugify("My Cool Notes"), "my-cool-notes");
  assertEquals(slugify("  日本語だけ  "), "");
  assertEquals(slugify("a".repeat(60)).length, 40);
});
