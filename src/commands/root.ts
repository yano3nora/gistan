import { parseArgs } from "@std/cli/parse-args";
import type { RunResult } from "../core/proc.ts";
import { run as runInit } from "./init.ts";
import { requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/**
 * Housekeeping for the gist repo itself (setup + origin git operations),
 * kept separate from the daily local-repo commands (search/edit/list) and
 * from gist publish/pull. See docs/TASK-260708-root-command-reorg.md.
 */
const USAGE = `gistan root - manage the gist repo (setup / git housekeeping)

Usage:
  gistan root init [dir]        Set up a gist repo (was: gistan init).
  gistan root path              Print the repo's absolute path.
  gistan root commit [-m <msg>] git add -A + commit.
  gistan root push               git push.
  gistan root pull               git pull --rebase.
  gistan root status             git status.
`;

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const [sub, ...rest] = command.args;
  switch (sub) {
    case "init":
      // Reuses init.ts as-is; only the entry point moved under `root`.
      return await runInit({ name: command.name, args: rest }, context);
    case "path":
      return await runPath(context);
    case "commit":
      return await runCommit(rest, context);
    case "push":
      return await runGitPassthrough(["push"], context);
    case "pull":
      return await runGitPassthrough(["pull", "--rebase"], context);
    case "status":
      return await runGitPassthrough(["status"], context);
    case undefined:
      await writeText(context.stdout, USAGE);
      return 0;
    default:
      await writeText(context.stderr, `error: unknown 'gistan root' subcommand: ${sub}\n${USAGE}`);
      return 2;
  }
}

async function runPath(context: CommandContext): Promise<number> {
  const config = await requireConfig(context);
  if (config === undefined) return 1;
  await writeText(context.stdout, `${config.repo}\n`);
  return 0;
}

/**
 * add -A -> commit. A notes repo does not need a curated history, so an
 * unspecified message falls back to a generic one (carried over from the
 * old `gistan sync`). Mirrors the current diff/commit result rather than
 * re-wrapping it, except for the two states callers actually branch on:
 * nothing staged (exit 0) and a successful commit.
 */
async function runCommit(args: readonly string[], context: CommandContext): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);
  const config = await requireConfig(context);
  if (config === undefined) return 1;
  const flags = parseArgs([...args], { string: ["message"], alias: { m: "message" } });
  const git = (a: string[]): Promise<RunResult> => context.runner("git", a, { cwd: config.repo });

  const add = await git(["add", "-A"]);
  if (add.code !== 0) return await forward(add, context);

  // `diff --cached --quiet` exits 0 when the index already matches HEAD
  // (nothing staged) and 1 when there is something to commit.
  const staged = await git(["diff", "--cached", "--quiet"]);
  if (staged.code === 0) {
    await out("nothing to commit\n");
    return 0;
  }

  const message = flags.message ?? "docs: auto commit (gistan)";
  const commit = await git(["commit", "-m", message]);
  if (commit.code !== 0) return await forward(commit, context);
  await out("ok: committed local changes\n");
  return 0;
}

/**
 * Thin `git -C <repo>` passthrough for push/pull/status: no remote-configured
 * check, no message re-wrapping — git's own exit code, stdout and stderr
 * (e.g. "no configured push destination", or the status listing itself) are
 * the output, verbatim.
 */
async function runGitPassthrough(
  gitArgs: readonly string[],
  context: CommandContext,
): Promise<number> {
  const config = await requireConfig(context);
  if (config === undefined) return 1;
  const result = await context.runner("git", [...gitArgs], { cwd: config.repo });
  return await forward(result, context);
}

async function forward(result: RunResult, context: CommandContext): Promise<number> {
  if (result.stdout) await writeText(context.stdout, result.stdout);
  if (result.stderr) await writeText(context.stderr, result.stderr);
  return result.code;
}
