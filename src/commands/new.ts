import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { loadState, saveState } from "../core/state.ts";
import { exists, openEditor, requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

const FALLBACK_TEMPLATE = "# {{title}}\n";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);

  const flags = parseArgs([...command.args], { string: ["tags"] });
  const filename = flags._.map(String).at(0);
  if (filename === undefined) {
    await err("usage: gistan new [--tags <t1,t2>] <filename>\n");
    return 2;
  }
  if (filename.includes("/")) {
    // Flat structure is enforced only here, at the creation funnel (SPEC-0001).
    await err("error: snippets are flat — pass a filename without directories\n");
    return 2;
  }

  const config = await requireConfig(context);
  if (config === undefined) {
    return 1;
  }

  const relPath = `snippets/${filename}`;
  if (await exists(join(config.repo, relPath))) {
    await err(`error: ${filename} already exists — try: gistan edit ${filename}\n`);
    return 1;
  }

  const tags = (flags.tags ?? "")
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag !== "");
  const content = filename.endsWith(".md") ? await renderTemplate(config.repo, filename) : "";
  await Deno.writeTextFile(join(config.repo, relPath), content);

  const state = await loadState(config.repo);
  await saveState(config.repo, {
    version: 1,
    snippets: { ...state.snippets, [relPath]: { tags, gist: null } },
  });

  await out(`ok: created ${relPath}\n`);
  return await openEditor(context, config.repo, relPath);
}

async function renderTemplate(repo: string, filename: string): Promise<string> {
  let template = FALLBACK_TEMPLATE;
  try {
    template = await Deno.readTextFile(join(repo, ".gistan", "templates", "default.md"));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  return template.replaceAll("{{title}}", filename.replace(/\.md$/, ""));
}
