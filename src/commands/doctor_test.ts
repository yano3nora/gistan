import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { saveConfig } from "../core/config.ts";
import type { Runner } from "../core/proc.ts";
import { loadState, saveState } from "../core/state.ts";
import { memoryContext } from "../testing.ts";
import { run } from "./doctor.ts";

const AT = "2026-01-01T00:00:00Z";

async function fixture(entryId: string) {
  const home = await Deno.makeTempDir();
  const repo = join(home, "repo");
  await Deno.mkdir(join(repo, "snippets"), { recursive: true });
  await Deno.mkdir(join(repo, ".gistan"), { recursive: true });
  await saveConfig(join(home, "config.toml"), { repo });
  await saveState(repo, {
    version: 1,
    snippets: {
      "snippets/gone.md": {
        tags: ["t"],
        gist: {
          id: entryId,
          visibility: "public",
          synced_hash: "sha256:x",
          remote_updated_at: AT,
        },
      },
    },
  });
  return { home, repo };
}

const remoteWithG1: Runner = (cmd, args) => {
  if (cmd === "gh" && args[1] === "gists?per_page=100") {
    return Promise.resolve({ code: 0, stdout: `g1\t${AT}\ttrue\n`, stderr: "" });
  }
  if (cmd === "gh" && args[1] === "gists/g1") {
    return Promise.resolve({
      code: 0,
      stdout: JSON.stringify({
        files: { "gone.md": { filename: "gone.md", content: "restored!" } },
      }),
      stderr: "",
    });
  }
  return Promise.resolve({ code: 0, stdout: "", stderr: "" });
};

Deno.test("doctor restores a missing file from its surviving gist", async () => {
  const { home, repo } = await fixture("g1");
  const io = memoryContext(remoteWithG1, home, { confirmAnswer: [true] });

  assertEquals(await run({ name: "doctor", args: [] }, io.context), 0);
  assertEquals(await Deno.readTextFile(join(repo, "snippets", "gone.md")), "restored!");
  assertEquals(io.stdout.includes("1 fixed"), true);
});

Deno.test("doctor deletes the orphan gist when restore is declined", async () => {
  const { home, repo } = await fixture("g1");
  const calls: string[] = [];
  const recording: Runner = (cmd, args, options) => {
    calls.push(`${cmd} ${args.join(" ")}`);
    return remoteWithG1(cmd, args, options);
  };
  // No to restore, yes to delete-and-forget.
  const io = memoryContext(recording, home, { confirmAnswer: [false, true] });

  assertEquals(await run({ name: "doctor", args: [] }, io.context), 0);
  assertEquals(calls.some((call) => call.includes("gists/g1") && call.includes("DELETE")), true);
  assertEquals((await loadState(repo)).snippets["snippets/gone.md"], undefined);
});

Deno.test("doctor unlinks an entry whose gist was deleted upstream", async () => {
  const home = await Deno.makeTempDir();
  const repo = join(home, "repo");
  await Deno.mkdir(join(repo, "snippets"), { recursive: true });
  await Deno.mkdir(join(repo, ".gistan"), { recursive: true });
  await saveConfig(join(home, "config.toml"), { repo });
  await Deno.writeTextFile(join(repo, "snippets", "alive.md"), "still here");
  await saveState(repo, {
    version: 1,
    snippets: {
      "snippets/alive.md": {
        tags: ["t"],
        gist: {
          id: "gdead",
          visibility: "public",
          synced_hash: "sha256:x",
          remote_updated_at: AT,
        },
      },
    },
  });
  const runner: Runner = (cmd, args) => {
    if (cmd === "gh" && args[1] === "gists?per_page=100") {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" }); // nothing upstream
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const io = memoryContext(runner, home, { confirmAnswer: [true] });

  assertEquals(await run({ name: "doctor", args: [] }, io.context), 0);
  assertEquals((await loadState(repo)).snippets["snippets/alive.md"], { tags: ["t"], gist: null });
});

Deno.test("doctor reports a clean repo", async () => {
  const home = await Deno.makeTempDir();
  const repo = join(home, "repo");
  await Deno.mkdir(join(repo, "snippets"), { recursive: true });
  await Deno.mkdir(join(repo, ".gistan"), { recursive: true });
  await saveConfig(join(home, "config.toml"), { repo });
  const runner: Runner = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });
  const io = memoryContext(runner, home);

  assertEquals(await run({ name: "doctor", args: [] }, io.context), 0);
  assertEquals(io.stdout.includes("no issues"), true);
});
