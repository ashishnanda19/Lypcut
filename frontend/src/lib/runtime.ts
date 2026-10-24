/**
 * Which backend the app talks to, decided once at build time by VITE_API_MODE.
 *
 *   mock  the in-browser mock API answers everything (the default; no server needed)
 *   real  the Lypcut backend answers everything except /style/*, which is still mocked (Phase 3)
 */
export type ApiMode = 'mock' | 'real'

export function resolveMode(value: unknown): ApiMode {
  return value === 'real' ? 'real' : 'mock'
}

export const API_MODE: ApiMode = resolveMode(import.meta.env.VITE_API_MODE)
export const isReal = API_MODE === 'real'

/** Where the live job feed lives. The mock answers on a made-up host; the backend shares the page's own origin. */
export function jobsSocketUrl(loc: Pick<Location, 'protocol' | 'host'> = window.location): string {
  if (!isReal) return 'wss://api.lypcut.mock/jobs'
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/api/jobs/ws`
}
