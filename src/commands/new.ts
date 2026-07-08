import { parseArgs } from "@std/cli/parse-args";
import { basename, dirname, join } from "@std/path";
import { DESCRIPTION_FILE } from "../core/snippets.ts";
import { exists, openEditor, requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

const FALLBACK_TEMPLATE = "# {{title}}\n";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);
  const flags = parseArgs([...command.args], {
    string: ["d", "description"],
    alias: { d: "description" },
  });
  const arg = flags._.map(String).at(0);
  if (!arg) {
    await err("usage: gistan new [-d <desc>] <filename|dirname/filename>\n");
    return 2;
  }
  if (basename(arg) === DESCRIPTION_FILE) {
    await err(`warn: ${DESCRIPTION_FILE} is reserved for gist description and is never uploaded\n`);
  }
  const config = await requireConfig(context);
  if (!config) return 1;
  const dir = arg.includes("/") ? dirname(arg) : basename(arg).replace(/\.[^.]+$/, "");
  const file = basename(arg);
  const rel = `gists/${dir}/${file}`;
  if (await exists(join(config.repo, rel))) {
    await err(`error: ${rel} already exists\n`);
    return 1;
  }
  await Deno.mkdir(join(config.repo, "gists", dir), { recursive: true });
  const content = file.endsWith(".md") ? await renderTemplate(config.repo, file) : "";
  await Deno.writeTextFile(join(config.repo, rel), content);
  if (flags.description !== undefined) {
    await Deno.writeTextFile(
      join(config.repo, "gists", dir, DESCRIPTION_FILE),
      String(flags.description),
    );
  }
  await out(`ok: created ${rel}\n`);
  return await openEditor(context, config.repo, rel);
}

async function renderTemplate(repo: string, filename: string): Promise<string> {
  let template = FALLBACK_TEMPLATE;
  try {
    template = await Deno.readTextFile(join(repo, ".gistan", "templates", "default.md"));
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return template.replaceAll("{{title}}", filename.replace(/\.md$/, ""));
}
