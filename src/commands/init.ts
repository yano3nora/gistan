import { parseArgs } from "@std/cli/parse-args";
import { join, resolve } from "@std/path";
import { loadConfig, saveConfig } from "../core/config.ts";
import { checkDeps } from "../core/deps.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

const INITIAL_STATE = `${JSON.stringify({ version: 2, gists: {} }, null, 2)}\n`;
const DEFAULT_TEMPLATE = "# {{title}}\n";
const GITIGNORE_LINES = ["stars/", ".gistan/cache/"];

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const flags = parseArgs([...command.args]);
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);
  const deps = await checkDeps(context.runner);
  for (const dep of deps.missingOptional) await err(`warn: ${dep.name} not found — ${dep.hint}\n`);
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
  const requested = flags._.map(String).at(0);
  const configured = await loadConfig(context.configPath);
  const dir = resolve(requested ?? configured?.repo ?? join(context.home, "gistan"));
  if (!(await ensureRepoDir(dir, context))) return 1;
  await scaffold(dir);
  await saveConfig(context.configPath, { repo: dir });
  await out(`ok: scaffolded ${dir} (gists/, stars/, .gistan/)\n`);
  await out(`ok: config written to ${context.configPath}\n`);
  return 0;
}

async function ensureRepoDir(dir: string, context: CommandContext): Promise<boolean> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);
  const state = await pathState(dir);
  if (state === "git") {
    await out(`ok: using existing repo at ${dir}\n`);
    return true;
  }
  if (state === "nonempty") {
    await err(`error: ${dir} exists but is not a git repo — pass another directory\n`);
    return false;
  }
  if (state === "missing") await Deno.mkdir(dir, { recursive: true });
  const init = await context.runner("git", ["init"], { cwd: dir });
  if (init.code !== 0) {
    await err(init.stderr);
    return false;
  }
  await out(`ok: initialized a local git repo at ${dir}\n`);
  return true;
}
async function pathState(path: string): Promise<"missing" | "git" | "empty" | "nonempty"> {
  const entries: string[] = [];
  try {
    for await (const e of Deno.readDir(path)) entries.push(e.name);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return "missing";
    throw e;
  }
  if (entries.includes(".git")) return "git";
  return entries.length === 0 ? "empty" : "nonempty";
}
async function scaffold(dir: string): Promise<void> {
  await Deno.mkdir(join(dir, "gists"), { recursive: true });
  await Deno.mkdir(join(dir, "stars"), { recursive: true });
  await Deno.mkdir(join(dir, ".gistan", "templates"), { recursive: true });
  await writeIfAbsent(join(dir, "gists", ".gitkeep"), "");
  await writeIfAbsent(join(dir, ".gistan", "state.json"), INITIAL_STATE);
  await writeIfAbsent(join(dir, ".gistan", "templates", "default.md"), DEFAULT_TEMPLATE);
  await ensureGitignoreLines(join(dir, ".gitignore"), GITIGNORE_LINES);
}
async function writeIfAbsent(path: string, content: string) {
  try {
    await Deno.stat(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return await Deno.writeTextFile(path, content);
    throw e;
  }
}
async function ensureGitignoreLines(path: string, lines: readonly string[]) {
  let current = "";
  try {
    current = await Deno.readTextFile(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const existing = new Set(current.split("\n").map((l) => l.trim()));
  const missing = lines.filter((l) => !existing.has(l));
  if (!missing.length) return;
  await Deno.writeTextFile(
    path,
    `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
  );
}
