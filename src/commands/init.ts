import { parseArgs } from "@std/cli/parse-args";
import { basename, dirname, join, resolve } from "@std/path";
import { loadConfig, saveConfig } from "../core/config.ts";
import { checkDeps } from "../core/deps.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/** Initial committed index (SPEC-0001). Written only when absent so re-runs never clobber it. */
const INITIAL_STATE = `${JSON.stringify({ version: 1, snippets: {} }, null, 2)}\n`;

const DEFAULT_TEMPLATE = "# {{title}}\n";

/** stars/ and .gistan/cache/ are re-fetchable caches and must never be committed (ADR-0001). */
const GITIGNORE_LINES = ["stars/", ".gistan/cache/"];

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const flags = parseArgs([...command.args], { boolean: ["public"] });
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);

  const deps = await checkDeps(context.runner);
  for (const dep of deps.missingOptional) {
    await err(`warn: ${dep.name} not found — ${dep.hint}\n`);
  }
  if (deps.missingRequired.length > 0) {
    for (const dep of deps.missingRequired) {
      await err(`error: ${dep.name} not found — ${dep.hint}\n`);
    }
    return 1;
  }
  await out(`ok: dependencies (${deps.present.map((dep) => dep.name).join(", ")})\n`);

  const auth = await context.runner("gh", ["auth", "status"]);
  if (auth.code !== 0) {
    await err(
      "error: gh is not authenticated — run `gh auth login` and grant the gist scope (`gh auth refresh -s gist`)\n",
    );
    return 1;
  }
  await out("ok: gh authenticated\n");

  // Repo location priority: explicit argument > previously configured repo > default.
  const requested = flags._.map(String).at(0);
  const configured = await loadConfig(context.configPath);
  const dir = resolve(requested ?? configured?.repo ?? join(context.home, "gistan"));

  if (!(await ensureRepoDir(dir, flags.public === true, context))) {
    return 1;
  }
  await scaffold(dir);
  await saveConfig(context.configPath, { repo: dir });

  await out(`ok: scaffolded ${dir} (snippets/, stars/, .gistan/)\n`);
  await out(`ok: config written to ${context.configPath}\n`);
  await out(
    `\nNext steps:\n  cd ${dir}\n  gistan import   # bring your existing gists into the repo\n`,
  );
  return 0;
}

/**
 * Makes `dir` exist as a git repo, in whichever way fits its current state:
 * adopt an existing repo, adopt an empty dir (git init), clone the same-named
 * remote (second-machine setup), or create a fresh repo via gh.
 */
async function ensureRepoDir(
  dir: string,
  isPublic: boolean,
  context: CommandContext,
): Promise<boolean> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);

  const state = await pathState(dir);
  if (state === "git") {
    await out(`ok: using existing repo at ${dir}\n`);
    return true;
  }
  if (state === "nonempty") {
    await err(
      `error: ${dir} exists but is not a git repo — pass another directory: gistan init <dir>\n`,
    );
    return false;
  }
  if (state === "empty") {
    const init = await context.runner("git", ["init"], { cwd: dir });
    if (init.code !== 0) {
      await err(init.stderr);
      return false;
    }
    await out(`ok: initialized a local git repo at ${dir} (no remote yet)\n`);
    return true;
  }

  // Missing dir: reuse the same-named remote when it exists, otherwise create it.
  // Repo name = directory basename, so `gh repo create --clone` run in the parent
  // directory checks out exactly at `dir`.
  const name = basename(dir);
  const view = await context.runner("gh", ["repo", "view", name]);
  if (view.code === 0) {
    const clone = await context.runner("gh", ["repo", "clone", name, dir]);
    if (clone.code !== 0) {
      await err(clone.stderr);
      return false;
    }
    await out(`ok: cloned existing repo "${name}" into ${dir}\n`);
    return true;
  }
  await Deno.mkdir(dirname(dir), { recursive: true });
  const visibility = isPublic ? "--public" : "--private";
  const create = await context.runner("gh", ["repo", "create", name, visibility, "--clone"], {
    cwd: dirname(dir),
  });
  if (create.code !== 0) {
    await err(create.stderr);
    return false;
  }
  await out(`ok: created ${isPublic ? "public" : "private"} repo "${name}", cloned into ${dir}\n`);
  return true;
}

async function pathState(path: string): Promise<"missing" | "git" | "empty" | "nonempty"> {
  const entries: string[] = [];
  try {
    for await (const entry of Deno.readDir(path)) {
      entries.push(entry.name);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return "missing";
    }
    throw error;
  }
  if (entries.includes(".git")) {
    return "git";
  }
  return entries.length === 0 ? "empty" : "nonempty";
}

/** Every step is create-if-absent so init stays idempotent (SPEC-0001 testcases). */
async function scaffold(dir: string): Promise<void> {
  await Deno.mkdir(join(dir, "snippets"), { recursive: true });
  await Deno.mkdir(join(dir, "stars"), { recursive: true });
  await Deno.mkdir(join(dir, ".gistan", "templates"), { recursive: true });
  await writeIfAbsent(join(dir, "snippets", ".gitkeep"), "");
  await writeIfAbsent(join(dir, ".gistan", "state.json"), INITIAL_STATE);
  await writeIfAbsent(join(dir, ".gistan", "templates", "default.md"), DEFAULT_TEMPLATE);
  await ensureGitignoreLines(join(dir, ".gitignore"), GITIGNORE_LINES);
}

async function writeIfAbsent(path: string, content: string): Promise<void> {
  try {
    await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      await Deno.writeTextFile(path, content);
      return;
    }
    throw error;
  }
}

/** Appends only the missing lines, preserving whatever the user already has. */
async function ensureGitignoreLines(path: string, lines: readonly string[]): Promise<void> {
  let current = "";
  try {
    current = await Deno.readTextFile(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  const existing = new Set(current.split("\n").map((line) => line.trim()));
  const missing = lines.filter((line) => !existing.has(line));
  if (missing.length === 0) {
    return;
  }
  const separator = current.length === 0 || current.endsWith("\n") ? "" : "\n";
  await Deno.writeTextFile(path, `${current}${separator}${missing.join("\n")}\n`);
}
