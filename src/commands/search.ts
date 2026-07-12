import { runQueryUi, selfCommand } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";

/**
 * Document-unit search, list rendered per keystroke (TASK-260708 followup 3):
 * fzf runs `--disabled --ansi` and the reload bind calls gistan itself —
 * `<self> __search-render {q}` (see search_render.ts) — which does the term
 * split / rg intersection / excerpt / coloring entirely in TypeScript. The
 * fzf-native matching of followup 2 could only display the raw item string,
 * so a hit deep in the flattened content horizontally scrolled the path off
 * screen; a query-time rendered `path:line: excerpt` list needs reload, and
 * self-invocation avoids re-growing fragile shell pipelines.
 *
 * Query syntax is search-specific (not fzf's): space = file-level order-free
 * AND, `!term` = exclude, terms are case-insensitive literals.
 *
 * Everything around the reload command — fzf session, binds, selection
 * handling — is runQueryUi (shared.ts), shared verbatim with grep.
 */

/**
 * The reload command that re-invokes this gistan (see selfCommand for the
 * deno-dev vs compiled-binary shapes). Pure so both shapes are unit-testable
 * without touching the real globals.
 */
export function selfRenderCommand(execPath: string, mainModule: string): string {
  return selfCommand(execPath, mainModule, "__search-render {q}");
}

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  return await runQueryUi(command, context, selfRenderCommand(Deno.execPath(), Deno.mainModule));
}
