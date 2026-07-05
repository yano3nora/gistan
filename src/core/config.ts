import { parse, stringify } from "@std/toml";
import { dirname, join } from "@std/path";

export interface Config {
  /** Absolute path to the gist repo (the markdown source of truth). */
  readonly repo: string;
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
  const repo = parse(text).repo;
  if (typeof repo !== "string" || repo.length === 0) {
    throw new Error(`invalid config at ${path}: "repo" must be a non-empty string`);
  }
  return { repo };
}

export async function saveConfig(path: string, config: Config): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, stringify({ repo: config.repo }));
}
