import { basename } from "@std/path";
import type { Config } from "../core/config.ts";
import { loadConfig } from "../core/config.ts";
import type { CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

/** Loads the config or explains how to get one; callers return 1 on undefined. */
export async function requireConfig(context: CommandContext): Promise<Config | undefined> {
  const config = await loadConfig(context.configPath);
  if (config === undefined) {
    await writeText(context.stderr, "error: gistan is not initialized — run `gistan root init`\n");
  }
  return config;
}

/** CLI args accept bare filenames; the index always keys on repo-relative paths. */
export function toRelPath(arg: string): string {
  return arg.startsWith("gists/") || arg.startsWith("stars/") ? arg : `gists/${arg}`;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

/** fzf exit codes that mean "the user just left without picking" — not errors. */
export const FZF_NO_MATCH = 1;
export const FZF_ABORTED = 130;

const LIST_CMD = "rg --files --no-ignore gists stars";

/** Fuzzy file pick; path === undefined means the user left without choosing. */
export async function pickFile(
  context: CommandContext,
  repo: string,
  query: string,
): Promise<{ path?: string; failed: boolean }> {
  const picked = await context.runner("fzf", [
    "--query",
    query,
    "--bind",
    `start:reload:${LIST_CMD}`,
    "--preview",
    "head -40 {}",
  ], { cwd: repo });
  if (picked.code === FZF_NO_MATCH || picked.code === FZF_ABORTED) {
    return { failed: false };
  }
  if (picked.code !== 0) {
    await writeText(
      context.stderr,
      `error: fzf failed: ${picked.stderr.trim() || `exit ${picked.code}`}\n`,
    );
    return { failed: true };
  }
  const path = picked.stdout.split("\n").at(0)?.trim();
  return { path: path === "" ? undefined : path, failed: false };
}

/**
 * vim-family editors get a line jump and -R for stars/ (read-only mirrors,
 * SPEC-0001); other editors just get the file — flags are not portable.
 */
export function editorArgs(editor: string, path: string, line?: string): string[] {
  if (!["vi", "vim", "nvim"].includes(basename(editor))) {
    return [path];
  }
  const args = line === undefined ? [path] : [`+${line}`, path];
  return path.startsWith("stars/") ? ["-R", ...args] : args;
}

export async function openEditor(
  context: CommandContext,
  repo: string,
  path: string,
  line?: string,
): Promise<number> {
  const opened = await context.runner(context.editor, editorArgs(context.editor, path, line), {
    cwd: repo,
    interactive: true,
  });
  return opened.code;
}
