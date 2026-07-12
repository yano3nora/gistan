import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";
import type { GistSummary } from "../core/gh.ts";
import { getGistFiles, listOwnGistSummaries } from "../core/gh.ts";
import { contentHash } from "../core/snippets.ts";
import type { State } from "../core/state.ts";
import { loadState, saveState } from "../core/state.ts";
import { exists, requireConfig } from "./shared.ts";
import type { CommandArgs, CommandContext } from "./types.ts";
import { writeText } from "./types.ts";

export async function run(command: CommandArgs, context: CommandContext): Promise<number> {
  const out = (t: string) => writeText(context.stdout, t);
  const err = (t: string) => writeText(context.stderr, t);
  const flags = parseArgs([...command.args], { string: ["limit"] });
  const limit = flags.limit === undefined ? undefined : Number(flags.limit);
  if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
    await err("error: --limit must be a positive integer\n");
    return 2;
  }
  const config = await requireConfig(context);
  if (!config) return 1;
  const summaries = await listOwnGistSummaries(
    context.runner,
    (p, t) => out(`fetching gist list… page ${p} (${t} so far)\n`),
  );
  const targets = limit === undefined ? summaries : summaries.slice(0, limit);
  let state = await loadState(config.repo);
  let imported = 0, skipped = 0, failed = 0;
  for (const [i, gist] of targets.entries()) {
    // Already-indexed ids skip instantly with no output so re-runs stay quiet;
    // everything past this line hits the network, so announce progress first.
    if (state.gists[gist.id]) {
      skipped++;
      continue;
    }
    await out(`importing ${gist.id} (${i + 1}/${targets.length})…\n`);
    try {
      const r = await importOne(config.repo, state, gist, context);
      if (r === "skipped") skipped++;
      else {
        state = r;
        await saveState(config.repo, state);
        imported++;
      }
    } catch (e) {
      failed++;
      await err(
        `warn: failed to import ${gist.id}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }
  await out(`done: ${imported} imported, ${skipped} skipped, ${failed} failed\n`);
  return failed > 0 ? 1 : 0;
}

/**
 * The dir is simply gists/<gist-id>/ (ADR-0003) — no dirname derivation from
 * the description, no reserved filenames; the description goes into the
 * index entry.
 */
async function importOne(
  repo: string,
  state: State,
  gist: GistSummary,
  context: CommandContext,
): Promise<State | "skipped"> {
  const files = await getGistFiles(context.runner, gist.id);
  if (files.length === 0) throw new Error("gist has no files");
  const dirPath = join(repo, "gists", gist.id);
  // The id is not indexed (checked by the caller), so an existing dir is a
  // hand-made squatter — overriding it needs an explicit yes.
  if (await exists(dirPath)) {
    if (
      !(await context.confirm(`gists/${gist.id} already exists and is not indexed. Override it?`))
    ) {
      return "skipped";
    }
    await Deno.remove(dirPath, { recursive: true });
  }
  await Deno.mkdir(dirPath, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const f of files) {
    if (f.content === undefined || f.truncated) {
      throw new Error(`file ${f.filename} is truncated (>1MB) — import it manually`);
    }
    await Deno.writeTextFile(join(dirPath, f.filename), f.content);
    hashes[f.filename] = await contentHash(new TextEncoder().encode(f.content));
  }
  return {
    version: 3,
    gists: {
      ...state.gists,
      [gist.id]: {
        visibility: gist.public ? "public" : "secret",
        description: gist.description.trim(),
        remote_updated_at: gist.updated_at,
        files: hashes,
      },
    },
    locals: state.locals,
  };
}
