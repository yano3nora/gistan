import { checkDeps, DEPS } from "../core/deps.ts";
import { FZF_ABORTED, FZF_NO_MATCH, openEditor, requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/**
 * fzf re-runs this on every keystroke. Empty query = file list (title-level
 * browsing); any input = live full-text grep. No minimum query length — CJK
 * queries are often a single meaningful character. stars/ is gitignored (a
 * cache), so --no-ignore insures it is never dropped from results, whatever
 * a given rg version's ignore semantics for explicit path arguments are.
 */
const GREP_CMD =
  "rg --column --line-number --no-heading --color=always --smart-case --no-ignore -- {q} snippets stars || true";
const LIST_CMD = "rg --files --no-ignore snippets stars";
const RELOAD_CMD = `if [ -n {q} ]; then ${GREP_CMD}; else ${LIST_CMD}; fi`;

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const err = (text: string) => writeText(context.stderr, text);

  const config = await requireConfig(context);
  if (config === undefined) {
    return 1;
  }

  const needed = DEPS.filter((dep) => dep.name === "rg" || dep.name === "fzf");
  const report = await checkDeps(context.runner, needed);
  const missing = [...report.missingRequired, ...report.missingOptional];
  if (missing.length > 0) {
    for (const dep of missing) {
      await err(`error: ${dep.name} is required for search — ${dep.hint}\n`);
    }
    return 1;
  }

  const query = command.args.join(" ");
  const picked = await context.runner("fzf", [
    "--ansi",
    "--disabled", // fzf does no filtering itself; rg (via reload) is the matcher
    "--query",
    query,
    "--delimiter",
    ":",
    "--bind",
    `start:reload:${RELOAD_CMD}`,
    "--bind",
    `change:reload:${RELOAD_CMD}`,
    "--preview",
    "awk 'NR>={2}-3 && NR<={2}+15' {1}",
  ], { cwd: config.repo });

  if (picked.code === FZF_NO_MATCH || picked.code === FZF_ABORTED) {
    return 0;
  }
  if (picked.code !== 0) {
    await err(`error: fzf failed: ${picked.stderr.trim() || `exit ${picked.code}`}\n`);
    return 1;
  }

  const selection = picked.stdout.split("\n").at(0)?.trim() ?? "";
  if (selection === "") {
    return 0;
  }
  const [path, line] = selection.split(":");
  return await openEditor(context, config.repo, path, line);
}
