import type { Transition, Variants } from 'framer-motion'

/**
 * Motion vocabulary. Every duration stays under 300ms (product rule), and
 * <MotionConfig reducedMotion="user"> at the app root handles reduced motion.
 *
 * The "leap" is the signature: a short arc up, a squash on landing, a settle.
 */
export const EASE_OUT = [0.2, 0.8, 0.2, 1] as const
export const EASE_LEAP = [0.3, 0.7, 0.3, 1] as const

export const quick: Transition = { duration: 0.16, ease: EASE_OUT }
export const panel: Transition = { duration: 0.24, ease: EASE_OUT }
export const spring: Transition = { type: 'spring', stiffness: 520, damping: 34, mass: 0.7 }

/** Panel and page-section entrance: fade + small rise. */
export const rise: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: panel },
  exit: { opacity: 0, y: 4, transition: quick },
}

/** A clip that was just placed by an AI edit: leap, squash, settle. */
export const leap: Variants = {
  rest: { y: 0, scaleX: 1, scaleY: 1 },
  jump: {
    y: [0, -9, 1, 0],
    scaleX: [1, 0.97, 1.03, 1],
    scaleY: [1, 1.05, 0.96, 1],
    transition: { duration: 0.28, ease: EASE_LEAP, times: [0, 0.35, 0.72, 1] },
  },
}

/** Staggered list entrance, e.g. chat messages or search results. */
export const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.035 } },
}
