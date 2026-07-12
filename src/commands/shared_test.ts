import { assert } from "@std/assert";
import { browseBind } from "./shared.ts";

Deno.test("browseBind's body has no parentheses or brackets (fzf execute-silent constraint)", () => {
  const bind = browseBind("/tmp/gistan-map.tsv");
  assert(bind.startsWith("ctrl-o:execute-silent("));
  assert(bind.endsWith(")"));
  const body = bind.slice("ctrl-o:execute-silent(".length, -1);
  assert(!body.includes("("));
  assert(!body.includes(")"));
  assert(!body.includes("["));
  assert(!body.includes("]"));
  assert(!body.includes("$("));
});

Deno.test("browseBind derives the stars/ gist id from the 3rd path segment", () => {
  const body = browseBind("/tmp/gistan-map.tsv");
  // p=stars/octocat/abc123/file.md -> d=stars -> rest=octocat/abc123/file.md
  // -> rest=abc123/file.md -> id=abc123 (peeled with #/%% expansions only).
  assert(body.includes("d=${p%%/*}"));
  assert(body.includes('if test "$d" = stars'));
  assert(body.includes("rest=${p#stars/}"));
  assert(body.includes("rest=${rest#*/}"));
  assert(body.includes("id=${rest%%/*}"));
});

Deno.test("browseBind still falls back to the dirname map for gists/ paths", () => {
  const body = browseBind("/tmp/gistan-map.tsv");
  assert(body.includes("awk -F'\\t' -v d=\"$d\" '$1==d {print $2}' \"/tmp/gistan-map.tsv\""));
});
