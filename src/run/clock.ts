/**
 * Measures the time of a run for its time limit (§D). Time spent while at least one
 * approval waits for the user does not count. `onExpire` is called once.
 */
export class RunClock {
  private usedMs = 0;
  private since: number | null = null;
  private waits = 0;
  private running = false;
  private expired = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly limitMs: number,
    private readonly onExpire: () => void,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  /** Starts or continues counting. */
  start(): void {
    this.running = true;
    this.count();
  }

  /** Stops counting, for example between two attempts of a run. */
  pause(): void {
    this.hold();
    this.running = false;
  }

  beginWait(): void {
    this.waits += 1;
    if (this.waits === 1) this.hold();
  }

  endWait(): void {
    if (this.waits === 0) return;
    this.waits -= 1;
    if (this.waits === 0) this.count();
  }

  hasExpired(): boolean {
    return this.expired;
  }

  remainingMs(): number {
    const live = this.since === null ? 0 : this.nowMs() - this.since;
    return Math.max(0, this.limitMs - this.usedMs - live);
  }

  private count(): void {
    if (!this.running || this.waits > 0 || this.expired || this.since !== null) return;
    this.since = this.nowMs();
    // setTimeout accepts at most about 24.8 days. A longer limit is checked again when the timer fires.
    const delay = Math.min(Math.max(0, this.limitMs - this.usedMs), 2_147_483_647);
    this.timer = setTimeout(() => this.fire(), delay);
  }

  private hold(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.since !== null) {
      this.usedMs += this.nowMs() - this.since;
      this.since = null;
    }
  }

  private fire(): void {
    this.timer = undefined;
    if (this.since !== null) {
      this.usedMs += this.nowMs() - this.since;
      this.since = null;
    }
    if (this.usedMs >= this.limitMs) {
      this.expired = true;
      this.onExpire();
    } else {
      this.count();
    }
  }
}
