import { parse, stringify } from "@std/toml";
import { dirname, join } from "@std/path";

export interface Config {
  /** Absolute path to the gist repo (the markdown source of truth). */
  readonly repo: string;
  /**
   * Command the ctrl-v bind in `search` / `grep` hands the selected file to
   * (e.g. "leaf", "glow -p"). Unset = the bind is not installed. Set by
   * hand-editing config.toml; `root init` preserves it.
   */
  readonly viewer?: string;
}

export function defaultConfigPath(env: { HOME?: string; XDG_CONFIG_HOME?: string }): string {
  const base = env.XDG_CONFIG_HOME ?? join(env.HOME ?? ".", ".config");
  return join(base, "gistan", "config.toml");
}

/** Returns undefined when the file does not exist (= not initialized yet). */
export async function loadConfig(path: string): Promise<Config | undefined> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return undefined;
    }
    throw error;
  }
  const parsed = parse(text);
  const repo = parsed.repo;
  if (typeof repo !== "string" || repo.length === 0) {
    throw new Error(`invalid config at ${path}: "repo" must be a non-empty string`);
  }
  const viewer = parsed.viewer;
  if (viewer !== undefined && (typeof viewer !== "string" || viewer.length === 0)) {
    throw new Error(`invalid config at ${path}: "viewer" must be a non-empty string`);
  }
  return viewer === undefined ? { repo } : { repo, viewer };
}

export async function saveConfig(path: string, config: Config): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  // Spell the keys out: stringify would serialize any extra Config fields,
  // and an undefined viewer must be omitted rather than written as a key.
  const body = config.viewer === undefined
    ? { repo: config.repo }
    : { repo: config.repo, viewer: config.viewer };
  await Deno.writeTextFile(path, stringify(body));
}
