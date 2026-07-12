import { runQueryUi, selfCommand } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";

/**
 * Line-level regex grep, kept when `gistan search` moved to document-unit
 * matching (TASK-260708 followup 2): the query here is one rg regex re-run
 * on every keystroke, so it still serves "find the exact line" sessions the
 * document mode intentionally gave up.
 *
 * Empty query = file list (title-level browsing); any input = live full-text
 * grep. No minimum query length — CJK queries are often a single meaningful
 * character.
 *
 * The list itself is rendered by the hidden `__grep-render` subcommand
 * (grep_render.ts) — TypeScript rather than the old sh pipeline, because
 * id-hidden display paths (ADR-0003) need the real path carried per row.
 * Everything around the reload command — fzf session, binds, selection
 * handling, and the __preview self-invocation (spans from `rg --json`,
 * anchored to the selected row's line field {2}) — is runQueryUi
 * (shared.ts), shared verbatim with search.
 */

/**
 * The reload command that re-invokes this gistan (see selfCommand for the
 * deno-dev vs compiled-binary shapes). Pure so both shapes are unit-testable
 * without touching the real globals.
 */
export function selfRenderCommand(execPath: string, mainModule: string): string {
  return selfCommand(execPath, mainModule, "__grep-render {q}");
}

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  return await runQueryUi(command, context, selfRenderCommand(Deno.execPath(), Deno.mainModule));
}
