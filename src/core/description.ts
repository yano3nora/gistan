/**
 * The user's long-standing gist naming convention: `[tag1][tag2]: title`.
 * build (publish) and parse (import) must stay symmetric.
 */

export function buildDescription(tags: readonly string[], title: string): string {
  return tags.length > 0 ? `${tags.map((tag) => `[${tag}]`).join("")}: ${title}` : title;
}

export function parseDescription(description: string): { tags: string[]; title: string } {
  const match = description.match(/^((?:\[[^\]]+\])+)\s*:?\s*(.*)$/s);
  if (match === null) {
    return { tags: [], title: description.trim() };
  }
  const tags = [...match[1].matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
  return { tags, title: match[2].trim() };
}

/** Directory-name-safe slug for multi-file gist imports; may return "". */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
