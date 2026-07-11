import { EXIT_COMMAND_NOT_FOUND, type Runner } from "./proc.ts";

export interface DepSpec {
  readonly name: string;
  /** Cheap args to probe existence; any exit code other than 127 proves the binary is there. */
  readonly probeArgs: readonly string[];
  /** Required deps block init; optional ones only produce a warning. */
  readonly required: boolean;
  /** Which gistan feature needs it and how to install — shown when missing. */
  readonly hint: string;
}

export const DEPS: readonly DepSpec[] = [
  {
    name: "gh",
    probeArgs: ["--version"],
    required: true,
    hint: "auth & GitHub API (brew install gh)",
  },
  {
    name: "git",
    probeArgs: ["--version"],
    required: true,
    hint: "repo operations (xcode-select --install / brew install git)",
  },
  {
    name: "rg",
    probeArgs: ["--version"],
    required: false,
    hint: "needed by `gistan search` / `gistan grep` (brew install ripgrep)",
  },
  {
    name: "fzf",
    probeArgs: ["--version"],
    required: false,
    hint: "needed by `gistan search` / `gistan grep` (brew install fzf)",
  },
  {
    name: "bat",
    probeArgs: ["--version"],
    required: false,
    hint: "syntax-highlighted previews in `gistan search` / `gistan grep` (brew install bat)",
  },
];

export interface DepsReport {
  readonly present: readonly DepSpec[];
  readonly missingRequired: readonly DepSpec[];
  readonly missingOptional: readonly DepSpec[];
}

export async function checkDeps(
  runner: Runner,
  deps: readonly DepSpec[] = DEPS,
): Promise<DepsReport> {
  const present: DepSpec[] = [];
  const missingRequired: DepSpec[] = [];
  const missingOptional: DepSpec[] = [];
  for (const dep of deps) {
    const result = await runner(dep.name, dep.probeArgs);
    if (result.code === EXIT_COMMAND_NOT_FOUND) {
      (dep.required ? missingRequired : missingOptional).push(dep);
    } else {
      present.push(dep);
    }
  }
  return { present, missingRequired, missingOptional };
}
