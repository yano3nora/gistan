/**
 * Dirname/id conventions under gists/ (ADR-0003): a published dir is named by
 * its gist id; an unpublished dir gets a `_`-prefixed local id at `new` time.
 * The prefix only exists so generated names can never collide with a real
 * gist id (GitHub ids are hex) — published-vs-local is always decided by
 * index membership, never by dirname shape, so hand-made dirs like
 * `gists/_drafts/` are valid local dirs too.
 */

const LOCAL_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const LOCAL_ID_LENGTH = 8;

/** Generates an unused `_xxxxxxxx` local id; `taken` closes over existing dirnames. */
export function newLocalId(taken: (id: string) => boolean): string {
  while (true) {
    const bytes = crypto.getRandomValues(new Uint8Array(LOCAL_ID_LENGTH));
    const id = "_" +
      [...bytes].map((byte) => LOCAL_ID_ALPHABET[byte % LOCAL_ID_ALPHABET.length]).join("");
    if (!taken(id)) return id;
  }
}

/**
 * Normalizes a publish/unpublish/new --id target to a dirname. Accepts a gist
 * URL (https://gist.github.com/<owner>/<id> or /<id> — last path segment
 * wins, same rule as `star add`), a repo path (gists/<dir> or
 * gists/<dir>/<file> pasted from the shell), or a bare id / local id.
 */
export function parseGistTarget(arg: string): string {
  const trimmed = arg.trim().replace(/\/+$/, "");
  if (/^https?:\/\//.test(trimmed)) {
    return trimmed.split("/").filter((segment) => segment !== "").at(-1) ?? "";
  }
  if (trimmed.startsWith("gists/")) {
    return trimmed.split("/").filter((segment) => segment !== "").at(1) ?? "";
  }
  return trimmed;
}
