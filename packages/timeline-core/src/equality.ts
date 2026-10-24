import type {
  Timeline,
  TimelineItem,
  TimelineOp,
  TimelineSettings,
} from "./types.js";

/**
 * Structural equality for JSON values. The front end compares timeline objects by identity (`a !== b`),
 * which is exact in memory: an item that was not touched is literally the same object. On the server every
 * timeline is loaded fresh from the database, so no two share identity and the comparison has to be by value.
 * Key order does not matter.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== typeof b ||
    a === null ||
    b === null ||
    typeof a !== "object"
  )
    return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return (
      a.length === other.length && a.every((x, i) => deepEqual(x, other[i]))
    );
  }
  const ka = Object.keys(a as object).filter(
    (k) => (a as Record<string, unknown>)[k] !== undefined,
  );
  const kb = Object.keys(b as object).filter(
    (k) => (b as Record<string, unknown>)[k] !== undefined,
  );
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}

export const sameItem = (
  a: TimelineItem | undefined,
  b: TimelineItem | undefined,
): boolean =>
  a === b || (a !== undefined && b !== undefined && deepEqual(a, b));

export const sameTimeline = (a: Timeline, b: Timeline): boolean =>
  deepEqual(a, b);

/**
 * A patch that turns `from` into `to`. This is how Restore stays non-destructive, and how a batch's single
 * inverse is derived: patchBetween(after, before) undoes the whole edit.
 */
export function patchBetween(
  from: Timeline,
  to: Timeline,
): Extract<TimelineOp, { type: "patch" }> {
  const upsert = Object.values(to.items).filter(
    (it) => !sameItem(from.items[it.id], it),
  );
  const remove = Object.keys(from.items).filter((id) => !to.items[id]);
  const settings: Partial<TimelineSettings> = {};
  let any = false;
  const keys = new Set([
    ...Object.keys(from.settings),
    ...Object.keys(to.settings),
  ]) as Set<keyof TimelineSettings>;
  for (const k of keys) {
    if (!deepEqual(from.settings[k], to.settings[k])) {
      (settings as Record<string, unknown>)[k] = to.settings[k];
      any = true;
    }
  }
  return { type: "patch", upsert, remove, ...(any ? { settings } : {}) };
}

/** True when a patch changes nothing. */
export const isEmptyPatch = (
  op: Extract<TimelineOp, { type: "patch" }>,
): boolean => !op.upsert.length && !op.remove.length && !op.settings;
