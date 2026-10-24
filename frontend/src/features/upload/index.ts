import { isReal } from '@/lib/runtime'
import { SimulatedUpload } from './simulated'
import { Uploader, type UploadEvents, type UploadHandle } from './uploader'

export type { UploadEvents, UploadHandle }

/** Starts sending a video: for real against the backend, or simulated against the mock. */
export function startUpload(
  file: File,
  durationSec: number | undefined,
  events: UploadEvents,
  /** Finish an upload that stopped earlier, in the project it belongs to. */
  resumeProjectId?: string,
): UploadHandle {
  const handle = isReal
    ? new Uploader(file, durationSec, events, {}, resumeProjectId ?? null)
    : new SimulatedUpload(file, durationSec, events)
  handle.start()
  return handle
}
