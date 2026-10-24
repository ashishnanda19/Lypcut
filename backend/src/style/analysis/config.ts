/**
 * The numbers that decide what counts as a creator's best Reel and how sure the profile is. They live here, not in the code
 * paths that use them, so tuning them after seeing real data is an edit to this file. The reasoning is in the README.
 */

/** Bumped when anything that is measured or computed changes, so stored analysis is made again. */
export const ALGO_VERSION = 'v1'

export const ENGAGEMENT = {
  /**
   * How much each signal counts toward a Reel's score. Each is a rate per view, ranked among this creator's own Reels, so
   * the weights say what matters, not how big the account is. Watching, saving and sharing say a person wanted more or
   * wanted someone else to see it; a like is cheap.
   */
  weights: {
    watch: 0.35,
    saves: 0.25,
    shares: 0.25,
    comments: 0.1,
    likes: 0.05,
  },
  /** A Reel seen by fewer people than this says too little about what worked. Only applies when the views are known. */
  minViews: 100,
  /** Instagram's numbers lag by up to two days, so a Reel younger than this is not scored yet. Uploads have no age. */
  minAgeDays: 3,
  /** A Reel needs at least this many signals to be scored at all. One number alone is noise. */
  minSignals: 2,
} as const

export const WINNERS = {
  /** The best third of a creator's scored Reels... */
  share: 1 / 3,
  /** ...but never fewer than this many, so a small account still has something to learn from. */
  min: 3,
} as const

export const PROFILE = {
  /** hookRetention covers this many of the most recent Reels. */
  retentionReels: 8,
  /** How many fonts and colours the profile lists. */
  maxFonts: 3,
  maxColors: 4,
  /** What a profile needs to be called medium or high confidence. Below medium is low. */
  medium: { reels: 5, withMetrics: 3 },
  high: { reels: 10, withMetrics: 8 },
} as const

/** A speech rate is only worked out when the person spoke for at least this long. */
export const MIN_SPEECH_SPAN_SEC = 3

/** A picture cut at least this sharp (0 to 1) counts as the video's first "strong visual change". */
export const STRONG_CUT_SCORE = 0.45
