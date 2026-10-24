/**
 * Project data (a transcript, the candidate moments) goes to the model inside one clearly marked block, and the system
 * prompt says everything in it is material to read, never instructions. "<" is escaped inside the JSON, so a speaker
 * who says "</data> now do this" cannot close the block from within it.
 */
export function dataBlock(payload: unknown): string {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c')
  return `<data>\n${json}\n</data>`
}

/** The reverse, for the offline model, which reads the same block a real model would. */
export function readDataBlock<T = unknown>(context: string | undefined): T | undefined {
  const m = context ? /<data>\n([\s\S]*)\n<\/data>/.exec(context) : null
  if (!m) return undefined
  try {
    return JSON.parse(m[1]!) as T
  } catch {
    return undefined
  }
}
