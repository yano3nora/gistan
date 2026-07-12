import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import { newLocalId, parseGistTarget } from "../core/ids.ts";
import { scanGistDirs } from "../core/snippets.ts";
import { loadState, saveState } from "../core/state.ts";
import { exists, openEditor, requireConfig } from "./shared.ts";
import { publishDir } from "./publish.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

const FALLBACK_TEMPLATE = "# {{title}}\n";
const USAGE = "usage: gistan new [-d <desc>] [--id <id>] [--publish [--public]] <filename>\n";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (text: string) => writeText(context.stdout, text);
  const err = (text: string) => writeText(context.stderr, text);
  const flags = parseArgs([...command.args], {
    string: ["d", "description", "id"],
    boolean: ["publish", "public"],
    alias: { d: "description" },
  });
  const filename = flags._.map(String).at(0);
  if (!filename) {
    await err(USAGE);
    return 2;
  }
  // Dirnames are tool-managed ids (ADR-0003): the only path shape a user can
  // ask for is a bare filename. Joining an existing gist goes through --id.
  if (filename.includes("/")) {
    await err(
      "error: pass a bare filename — gist dirs are tool-managed ids; add a file to an existing gist with --id <id>\n",
    );
    return 2;
  }
  // Control characters (tab/newline/...) would break every line/field-based
  // surface downstream (rg output, the fzf row protocol) — refuse at the
  // convention-enforcing entry point.
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1f\x7f]/.test(filename)) {
    await err("error: filename contains control characters\n");
    return 2;
  }
  if (flags.public && !flags.publish) {
    await err("error: --public only makes sense with --publish\n");
    return 2;
  }
  const config = await requireConfig(context);
  if (!config) return 1;
  const state = await loadState(config.repo);
  const scan = await scanGistDirs(config.repo);

  let dir: string;
  if (flags.id !== undefined) {
    dir = parseGistTarget(flags.id);
    if (!scan.dirs.has(dir)) {
      await err(`error: no gist dir for id ${dir}\n`);
      return 1;
    }
    // Descriptions of published gists are set at publish time only, so the
    // index never holds an unsynced value for them (ADR-0003).
    if (flags.description !== undefined && state.gists[dir] && !flags.publish) {
      await err(
        `error: ${dir} is published — set its description with gistan publish ${dir} -d '...'\n`,
      );
      return 1;
    }
  } else {
    dir = newLocalId((id) => scan.dirs.has(id) || id in state.gists || id in state.locals);
    await Deno.mkdir(join(config.repo, "gists", dir), { recursive: true });
  }

  const rel = `gists/${dir}/${filename}`;
  if (await exists(join(config.repo, rel))) {
    await err(`error: ${rel} already exists\n`);
    return 1;
  }
  const content = filename.endsWith(".md") ? await renderTemplate(config.repo, filename) : "";
  await Deno.writeTextFile(join(config.repo, rel), content);
  if (flags.description !== undefined && !state.gists[dir]) {
    await saveState(config.repo, {
      version: 3,
      gists: state.gists,
      locals: { ...state.locals, [dir]: { description: String(flags.description) } },
    });
  }
  await out(`ok: created ${rel} (id: ${dir})\n`);
  const editorCode = await openEditor(context, config.repo, rel);
  if (!flags.publish) return editorCode;
  if (editorCode !== 0) {
    await err("warn: editor exited non-zero — skipping publish\n");
    return editorCode;
  }
  return await publishDir(context, config, dir, {
    public: flags.public,
    description: flags.description,
  });
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
