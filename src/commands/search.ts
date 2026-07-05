import { basename } from "@std/path";
import { loadConfig } from "../core/config.ts";
import { checkDeps, DEPS } from "../core/deps.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/**
 * fzf re-runs this on every keystroke (live grep). stars/ is gitignored (a
 * cache), so --no-ignore insures it is never dropped from results, whatever
 * a given rg version's ignore semantics for explicit path arguments are.
 */
const RELOAD_CMD =
  "rg --column --line-number --no-heading --color=always --smart-case --no-ignore -- {q} snippets stars || true";

/** fzf exit codes that mean "the user just left without picking" — not errors. */
const FZF_NO_MATCH = 1;
const FZF_ABORTED = 130;

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const err = (text: string) => writeText(context.stderr, text);

  const config = await loadConfig(context.configPath);
  if (config === undefined) {
    await err("error: gistan is not initialized — run `gistan init`\n");
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
  const opened = await context.runner(
    context.editor,
    editorArgs(context.editor, path, line),
    { cwd: config.repo, interactive: true },
  );
  return opened.code;
}

/**
 * vim-family editors get a line jump, and -R for stars/ (read-only mirrors,
 * SPEC-0001). Other editors just get the file — flags are not portable.
 */
function editorArgs(editor: string, path: string, line: string): string[] {
  if (!["vi", "vim", "nvim"].includes(basename(editor))) {
    return [path];
  }
  const args = [`+${line}`, path];
  return path.startsWith("stars/") ? ["-R", ...args] : args;
}
