import { parseArgs } from "@std/cli/parse-args";
import { resolve } from "@std/path";
import { checkDeps, DEPS } from "../core/deps.ts";
import {
  browseBind,
  detectBat,
  FZF_ABORTED,
  FZF_NO_MATCH,
  openEditor,
  PREVIEW_SCROLL_BIND,
  PREVIEW_WINDOW,
  requireConfig,
  selfCommand,
  toRelPath,
  viewerBind,
  writeGistMapFile,
} from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

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
  const err = (text: string) => writeText(context.stderr, text);
  const out = (text: string) => writeText(context.stdout, text);
  const flags = parseArgs([...command.args], { boolean: ["path"], alias: { p: "path" } });

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

  const query = flags._.map(String).join(" ");
  const reloadCmd = selfRenderCommand(Deno.execPath(), Deno.mainModule);
  // Preview is also a self-invocation (see preview_render.ts): every positive
  // term emphasized over the whole file, bat syntax highlighting when
  // installed, aligned ~5 lines above the first matching line.
  const bat = (await detectBat(context.runner)) ? "bat" : "nobat";
  const previewCmd = selfCommand(
    Deno.execPath(),
    Deno.mainModule,
    `__preview search ${bat} {q} {1}`,
  );
  const mapFile = await writeGistMapFile(config.repo);
  let picked;
  try {
    picked = await context.runner("fzf", [
      "--ansi",
      "--disabled", // fzf does no filtering itself; __search-render is the matcher
      "--query",
      query,
      "--delimiter",
      ":",
      "--bind",
      `start:reload:${reloadCmd}`,
      "--bind",
      `change:reload:${reloadCmd}`,
      "--bind",
      PREVIEW_SCROLL_BIND,
      "--bind",
      browseBind(mapFile),
      ...(config.viewer === undefined ? [] : ["--bind", viewerBind(config.viewer)]),
      "--preview-window",
      PREVIEW_WINDOW,
      "--preview",
      previewCmd,
    ], { cwd: config.repo });
  } finally {
    // The map is only meaningful while fzf is running; never leave it behind.
    await Deno.remove(mapFile).catch(() => {});
  }

  if (picked.code === FZF_NO_MATCH || picked.code === FZF_ABORTED) {
    return 0;
  }
  if (picked.code !== 0) {
    await err(`error: fzf failed: ${picked.stderr.trim() || `exit ${picked.code}`}\n`);
    return 1;
  }

  // fzf strips the renderer's ANSI codes before printing the selection
  // (--ansi, verified against a real session), so this is plain
  // "display_path:line: excerpt" — or just the path for path-only rows.
  const selection = picked.stdout.split("\n").at(0)?.trim() ?? "";
  if (selection === "") {
    return 0;
  }
  const [displayPath, line] = selection.split(":");
  const path = toRelPath(displayPath);
  if (flags.path) {
    await out(`${resolve(config.repo, path)}\n`);
    return 0;
  }
  return await openEditor(context, config.repo, path, line);
}
