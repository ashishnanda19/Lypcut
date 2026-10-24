/** Drizzle wraps the driver's error; the Postgres error code is on the original (`cause`). */
function pgCode(e: unknown): string | undefined {
  const inner =
    (e as { cause?: { code?: string } } | null)?.cause ?? (e as { code?: string } | null)
  return (inner as { code?: string } | null)?.code
}

export const isUniqueViolation = (e: unknown) => pgCode(e) === '23505'
export const isForeignKeyViolation = (e: unknown) => pgCode(e) === '23503'
