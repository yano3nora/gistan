import { join } from "@std/path";

type CommandName = "prepare" | "publish";

interface Target {
  readonly denoTarget: string;
  readonly os: "linux" | "macos" | "windows";
  readonly arch: "x64" | "arm64";
  readonly archive: "tar.gz" | "zip";
  readonly binary: "gistan" | "gistan.exe";
}

const TARGETS: readonly Target[] = [
  {
    denoTarget: "x86_64-unknown-linux-gnu",
    os: "linux",
    arch: "x64",
    archive: "tar.gz",
    binary: "gistan",
  },
  {
    denoTarget: "aarch64-unknown-linux-gnu",
    os: "linux",
    arch: "arm64",
    archive: "tar.gz",
    binary: "gistan",
  },
  {
    denoTarget: "x86_64-apple-darwin",
    os: "macos",
    arch: "x64",
    archive: "tar.gz",
    binary: "gistan",
  },
  {
    denoTarget: "aarch64-apple-darwin",
    os: "macos",
    arch: "arm64",
    archive: "tar.gz",
    binary: "gistan",
  },
  {
    denoTarget: "x86_64-pc-windows-msvc",
    os: "windows",
    arch: "x64",
    archive: "zip",
    binary: "gistan.exe",
  },
];

const PUBLISH_FLAG = "--i-understand-this-pushes-and-publishes";

function usage(): string {
  return `Usage:
  deno run -A scripts/release.ts prepare <version>
  deno run -A scripts/release.ts publish <version> ${PUBLISH_FLAG}

Examples:
  mise run release:prepare -- 0.1.0
  mise run release:publish -- 0.1.0 ${PUBLISH_FLAG}
`;
}

function parseArgs(): { command: CommandName; version: string; publishAllowed: boolean } {
  const [rawCommand, rawVersion, ...rest] = Deno.args;
  const command = rawCommand as CommandName | undefined;
  const version = rawVersion ?? Deno.env.get("GISTAN_RELEASE_VERSION");

  if (command !== "prepare" && command !== "publish") {
    throw new Error(`Unknown command.\n\n${usage()}`);
  }
  if (version === undefined || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Release version must be semver-like, for example 0.1.0.\n\n${usage()}`);
  }

  return {
    command,
    version,
    publishAllowed: rest.includes(PUBLISH_FLAG),
  };
}

async function run(command: string, args: readonly string[], cwd = Deno.cwd()): Promise<string> {
  console.log(`$ ${[command, ...args].join(" ")}`);

  const child = new Deno.Command(command, {
    args: [...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await child.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);

  if (stdout.trim() !== "") {
    console.log(stdout.trimEnd());
  }
  if (stderr.trim() !== "") {
    console.error(stderr.trimEnd());
  }
  if (!result.success) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }

  return stdout;
}

async function bumpVersion(version: string): Promise<void> {
  const path = "src/main.ts";
  const source = await Deno.readTextFile(path);
  const versionPattern = /export const VERSION = "gistan (\d+\.\d+\.\d+)";/;
  const currentVersion = source.match(versionPattern)?.[1];

  if (currentVersion === undefined) {
    throw new Error("VERSION declaration was not found or already uses a non-standard format.");
  }
  if (currentVersion === version) {
    console.log(`VERSION is already gistan ${version}; leaving src/main.ts unchanged.`);
    return;
  }

  const next = source.replace(versionPattern, `export const VERSION = "gistan ${version}";`);

  await Deno.writeTextFile(path, next);
}

async function assertCliVersion(version: string): Promise<void> {
  const stdout = await run("deno", [
    "run",
    "--allow-env",
    "--allow-read",
    "src/main.ts",
    "--version",
  ]);
  const actual = stdout.trim();
  const expected = `gistan ${version}`;

  if (actual !== expected) {
    throw new Error(`CLI version mismatch: expected "${expected}", got "${actual}".`);
  }
}

async function packageTarget(version: string, target: Target, releaseDir: string): Promise<void> {
  const workDir = join(releaseDir, `${target.os}-${target.arch}`);
  await Deno.mkdir(workDir, { recursive: true });

  // Compile each target into its own work directory so archive roots stay clean.
  await run("deno", [
    "compile",
    "--allow-env",
    "--allow-read",
    "--allow-write",
    "--allow-run",
    "--target",
    target.denoTarget,
    "--output",
    join(workDir, target.binary),
    "src/main.ts",
  ]);

  const asset = `gistan-v${version}-${target.os}-${target.arch}.${target.archive}`;
  const assetPath = join(releaseDir, asset);

  if (target.archive === "zip") {
    await run("zip", ["-j", assetPath, join(workDir, target.binary)]);
  } else {
    // `-C workDir binary` prevents leaking temporary directories into the archive.
    await run("tar", ["-czf", assetPath, "-C", workDir, target.binary]);
  }

  const checksum = await run("shasum", ["-a", "256", asset], releaseDir);
  await Deno.writeTextFile(`${assetPath}.sha256`, checksum);
}

async function assertCleanTree(): Promise<void> {
  const stdout = await run("git", ["status", "--porcelain"]);
  if (stdout.trim() !== "") {
    throw new Error("Working tree must be clean before publishing. Commit the version bump first.");
  }
}

async function prepare(version: string): Promise<void> {
  const releaseDir = join("dist", `gistan-v${version}`);

  await bumpVersion(version);
  await assertCliVersion(version);
  await run("deno", ["task", "check"]);
  await run("deno", ["task", "test"]);

  // Recreate the release directory so stale assets from a previous version/target
  // cannot be accidentally uploaded.
  await Deno.remove(releaseDir, { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  });
  await Deno.mkdir(releaseDir, { recursive: true });

  for (const target of TARGETS) {
    await packageTarget(version, target, releaseDir);
  }

  console.log(`\nRelease assets are ready in ${releaseDir}`);
  console.log("Review the version bump, commit it, then run release:publish.");
}

async function publish(version: string, publishAllowed: boolean): Promise<void> {
  if (!publishAllowed) {
    throw new Error(
      `Refusing to push tags or publish a GitHub Release without ${PUBLISH_FLAG}.`,
    );
  }

  const tag = `v${version}`;
  const actualReleaseDir = join("dist", `gistan-v${version}`);

  // Keep this check simple and explicit: publishing should happen only after
  // prepare has produced versioned assets in the expected directory.
  await assertCliVersion(version);
  await assertCleanTree();
  await Deno.stat(actualReleaseDir);
  await run("git", ["tag", tag]);
  await run("git", ["push", "origin", tag]);
  await run("gh", [
    "release",
    "create",
    tag,
    `${actualReleaseDir}/gistan-v${version}-linux-x64.tar.gz`,
    `${actualReleaseDir}/gistan-v${version}-linux-x64.tar.gz.sha256`,
    `${actualReleaseDir}/gistan-v${version}-linux-arm64.tar.gz`,
    `${actualReleaseDir}/gistan-v${version}-linux-arm64.tar.gz.sha256`,
    `${actualReleaseDir}/gistan-v${version}-macos-x64.tar.gz`,
    `${actualReleaseDir}/gistan-v${version}-macos-x64.tar.gz.sha256`,
    `${actualReleaseDir}/gistan-v${version}-macos-arm64.tar.gz`,
    `${actualReleaseDir}/gistan-v${version}-macos-arm64.tar.gz.sha256`,
    `${actualReleaseDir}/gistan-v${version}-windows-x64.zip`,
    `${actualReleaseDir}/gistan-v${version}-windows-x64.zip.sha256`,
    "--generate-notes",
    "--verify-tag",
  ]);

  console.log(`Published ${tag} from ${actualReleaseDir}.`);
}

if (import.meta.main) {
  try {
    const { command, version, publishAllowed } = parseArgs();

    if (command === "prepare") {
      await prepare(version);
    }
    if (command === "publish") {
      await publish(version, publishAllowed);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
