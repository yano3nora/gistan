import type { RunResult } from "../core/proc.ts";
import { requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/**
 * Convenience wrapper: add → commit → pull --rebase → push. A notes repo does
 * not need a curated history, so the commit message is deliberately generic.
 * Without a configured remote it stops after the local commit.
 */
export async function run(_command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);

  const config = await requireConfig(context);
  if (config === undefined) {
    return 1;
  }
  const git = (args: string[]): Promise<RunResult> =>
    context.runner("git", args, { cwd: config.repo });

  const add = await git(["add", "-A"]);
  if (add.code !== 0) {
    await err(`error: git add failed: ${add.stderr.trim()}\n`);
    return 1;
  }

  // diff --cached --quiet exits 1 when something is staged.
  const staged = await git(["diff", "--cached", "--quiet"]);
  if (staged.code !== 0) {
    const commit = await git(["commit", "-m", "docs: auto sync (gistan)"]);
    if (commit.code !== 0) {
      await err(`error: git commit failed: ${commit.stderr.trim()}\n`);
      return 1;
    }
    await out("ok: committed local changes\n");
  } else {
    await out("nothing to commit\n");
  }

  const remotes = await git(["remote"]);
  if (remotes.stdout.trim() === "") {
    await out("no remote configured — local commit only\n");
    return 0;
  }

  const pull = await git(["pull", "--rebase"]);
  if (pull.code !== 0) {
    await err(`error: git pull --rebase failed — resolve manually:\n${pull.stderr.trim()}\n`);
    return 1;
  }
  const push = await git(["push"]);
  if (push.code !== 0) {
    await err(`error: git push failed:\n${push.stderr.trim()}\n`);
    return 1;
  }
  await out("ok: synced with remote\n");
  return 0;
}
