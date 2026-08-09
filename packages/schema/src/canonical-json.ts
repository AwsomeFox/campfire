/**
 * Stable, key-sorted JSON for comparing two values by CONTENT (issue #2097 review).
 *
 * `JSON.stringify` preserves insertion order, so two structurally identical objects built by
 * different code paths — a client's request body versus a row parsed back out of storage,
 * or a spec re-serialized by an MCP client — routinely produce different strings. Anything
 * asking "did this actually change?" therefore has to canonicalize first, or it answers "yes"
 * for every input and whatever it guards fires unconditionally.
 *
 * That mistake has been made twice in this feature — once comparing campaign mechanics
 * profiles, once comparing action specs to detect a round-tripped edit — so the helper lives
 * in one place both can reach rather than being reimplemented per call site.
 *
 * A leaf module with no imports, so any schema module and any server module can use it
 * without an import cycle.
 */
export function canonicalJson(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.keys(node as Record<string, unknown>)
          .sort()
          .map((key) => [key, walk((node as Record<string, unknown>)[key])]),
      );
    }
    return node;
  };
  return JSON.stringify(walk(value) ?? null);
}
