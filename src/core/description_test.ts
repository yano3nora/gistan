import { assertEquals } from "@std/assert";
import { slugify } from "./description.ts";

Deno.test("slugify turns descriptions into safe directory names", () => {
  assertEquals(slugify("Hello, Gist World!"), "hello-gist-world");
  assertEquals(slugify("  Multiple --- separators  "), "multiple-separators");
  assertEquals(slugify("日本語 only"), "only");
});

Deno.test("slugify truncates long names and may return empty", () => {
  assertEquals(slugify("x".repeat(60)), "x".repeat(40));
  assertEquals(slugify("日本語"), "");
});
