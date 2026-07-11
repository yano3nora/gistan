import { assertEquals } from "@std/assert";
import { checkDeps } from "./deps.ts";
import { EXIT_COMMAND_NOT_FOUND, type Runner } from "./proc.ts";

function runnerMissing(names: readonly string[]): Runner {
  return (cmd) =>
    Promise.resolve(
      names.includes(cmd)
        ? { code: EXIT_COMMAND_NOT_FOUND, stdout: "", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
}

Deno.test("classifies missing deps by requirement", async () => {
  const report = await checkDeps(runnerMissing(["gh", "fzf"]));
  assertEquals(report.missingRequired.map((dep) => dep.name), ["gh"]);
  assertEquals(report.missingOptional.map((dep) => dep.name), ["fzf"]);
  assertEquals(report.present.map((dep) => dep.name), ["git", "rg", "bat"]);
});

Deno.test("treats non-zero exit codes other than 127 as present", async () => {
  // A probe may exit 1 (e.g. unknown flag) and still prove the binary exists.
  const runner: Runner = () => Promise.resolve({ code: 1, stdout: "", stderr: "" });
  const report = await checkDeps(runner);
  assertEquals(report.missingRequired, []);
  assertEquals(report.missingOptional, []);
});
