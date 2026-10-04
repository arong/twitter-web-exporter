const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const PRESENCE_WINDOW = MINUTE;
export const GAP_MIN = 3 * SECOND;
export const GAP_MAX = 8 * SECOND;
export const BREAK_EVERY_MIN = 8;
export const BREAK_EVERY_MAX = 12;
export const BREAK_MIN = 30 * SECOND;
export const BREAK_MAX = 90 * SECOND;
export const VIDEO_WEIGHT = 5;
export const RATE_LIMIT_PAUSE = 30 * MINUTE;
export const RATE_LIMIT_PAUSE_MAX = 6 * HOUR;
export const FORBIDDEN_STREAK = 3;
export const FORBIDDEN_PAUSE = 30 * MINUTE;
export const NETWORK_ERROR_LIMIT = 5;
export const NETWORK_ERROR_PAUSE = 30 * MINUTE;

export type PaceDecision =
  | { ok: true }
  | { ok: false; reason: 'away' }
  | { ok: false; reason: 'paused' | 'cap' | 'gap'; until: number };

/**
 * Decides when the next media download may start, so that downloads look like
 * a person browsing: only while the user is active, with random gaps and
 * breaks, a weighted hourly cap, and long cooldowns when the CDN pushes back.
 */
export class Pacer {
  private lastActivityAt = -Infinity;
  private nextAllowedAt = 0;
  private pausedUntil = 0;
  private sinceBreak = 0;
  private breakAfter: number;
  private history: { at: number; weight: number }[] = [];
  private networkErrors: number[] = [];
  private forbiddenStreak = 0;
  private rateLimitPause = RATE_LIMIT_PAUSE;

  constructor(
    public hourlyLimit: number,
    private random: () => number = Math.random,
  ) {
    this.breakAfter = this.between(BREAK_EVERY_MIN, BREAK_EVERY_MAX + 1, true);
  }

  private between(min: number, max: number, integer = false) {
    const value = min + this.random() * (max - min);
    return integer ? Math.floor(value) : value;
  }

  private prune(now: number) {
    this.history = this.history.filter((h) => now - h.at < HOUR);
    this.networkErrors = this.networkErrors.filter((t) => now - t < HOUR);
  }

  recordActivity(now: number) {
    this.lastActivityAt = now;
  }

  isPresent(now: number, visible: boolean) {
    return visible && now - this.lastActivityAt <= PRESENCE_WINDOW;
  }

  /** Weighted downloads in the last hour. */
  used(now: number) {
    this.prune(now);
    return this.history.reduce((sum, h) => sum + h.weight, 0);
  }

  get pauseEndsAt() {
    return this.pausedUntil;
  }

  decide(now: number, visible: boolean, weight = 1): PaceDecision {
    if (now < this.pausedUntil) {
      return { ok: false, reason: 'paused', until: this.pausedUntil };
    }
    if (!this.isPresent(now, visible)) {
      return { ok: false, reason: 'away' };
    }
    if (this.used(now) + weight > this.hourlyLimit) {
      const oldest = this.history[0];
      return { ok: false, reason: 'cap', until: oldest ? oldest.at + HOUR : now + MINUTE };
    }
    if (now < this.nextAllowedAt) {
      return { ok: false, reason: 'gap', until: this.nextAllowedAt };
    }
    return { ok: true };
  }

  /** A download finished (successfully or not, the request was still made). */
  recordDownload(now: number, weight: number) {
    this.history.push({ at: now, weight });
    this.sinceBreak += 1;
    let wait = this.between(GAP_MIN, GAP_MAX);
    if (this.sinceBreak >= this.breakAfter) {
      wait = this.between(BREAK_MIN, BREAK_MAX);
      this.sinceBreak = 0;
      this.breakAfter = this.between(BREAK_EVERY_MIN, BREAK_EVERY_MAX + 1, true);
    }
    this.nextAllowedAt = now + wait;
  }

  recordSuccess() {
    this.forbiddenStreak = 0;
    this.rateLimitPause = RATE_LIMIT_PAUSE;
  }

  /** The CDN answered with a non-2xx status. */
  recordHttpError(now: number, status: number) {
    if (status === 429) {
      this.pause(now, this.rateLimitPause);
      this.rateLimitPause = Math.min(this.rateLimitPause * 2, RATE_LIMIT_PAUSE_MAX);
      return;
    }
    if (status === 403) {
      this.forbiddenStreak += 1;
      if (this.forbiddenStreak >= FORBIDDEN_STREAK) {
        this.forbiddenStreak = 0;
        this.pause(now, FORBIDDEN_PAUSE);
      }
      return;
    }
    this.forbiddenStreak = 0;
  }

  /** The download failed without an HTTP response. */
  recordNetworkError(now: number) {
    this.networkErrors.push(now);
    this.prune(now);
    if (this.networkErrors.length >= NETWORK_ERROR_LIMIT) {
      this.networkErrors = [];
      this.pause(now, NETWORK_ERROR_PAUSE);
    }
  }

  pause(now: number, duration: number) {
    this.pausedUntil = Math.max(this.pausedUntil, now + duration);
  }
}
