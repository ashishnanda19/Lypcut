/**
 * A failure that no retry will fix: the file has no audio, the checksum does not match, the transcription
 * key is wrong. Its message is written for the person using the product, because it is what they see.
 */
export class PermanentError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'PROCESSING_FAILED',
  ) {
    super(message)
    this.name = 'PermanentError'
  }
}

/** What people see when something unexpected broke. The real cause goes to the logs and the job's stage record. */
export const GENERIC_FAILURE = 'Something went wrong while processing this video. Please try again.'
