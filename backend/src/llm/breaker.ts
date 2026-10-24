/**
 * A circuit breaker. After `threshold` failures in a row the circuit opens and callers are told to use the fallback
 * for `cooldownMs`; then one trial call is let through, and success closes it again.
 */
export class CircuitBreaker {
  private failures = 0
  private openedAt: number | null = null
  private trial = false

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Should the real provider be tried right now? */
  allow(): boolean {
    if (this.openedAt === null) return true
    if (this.now() - this.openedAt < this.cooldownMs) return false
    // Cooled down: let exactly one call through to find out.
    if (this.trial) return false
    this.trial = true
    return true
  }

  success() {
    this.failures = 0
    this.openedAt = null
    this.trial = false
  }

  failure() {
    this.failures++
    this.trial = false
    if (this.failures >= this.threshold) this.openedAt = this.now()
  }

  get open(): boolean {
    return this.openedAt !== null && this.now() - this.openedAt < this.cooldownMs
  }
}
