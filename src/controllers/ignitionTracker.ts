import * as fs from 'fs';
import * as path from 'path';
import { Logger } from 'homebridge';

/**
 * Tracks ignition attempts and persists their outcomes to disk.
 *
 * **Why this exists.** The Mertik GV60 receiver has its own internal
 * ignition logic: when we send the Ignite command (`314103`), it opens
 * the gas valve, sparks repeatedly for ~30-60s, and then either:
 *
 *  - **Success**: the thermopile confirms flame, `guardFlameOn` goes true,
 *    `igniting` clears to 0.
 *  - **Soft failure**: the receiver gives up cleanly. `igniting` clears
 *    back to 0 but `guardFlameOn` stays 0. This is the common cold-start
 *    case — air in the pilot tube, cold thermopile, marginal gas pressure.
 *    Resolves on the next attempt 80% of the time.
 *  - **Hard lockout**: the `igniting` bit stays stuck at 1 indefinitely.
 *    This is the safety-lockout state — the receiver tripped its fault
 *    and only a paperclip reset or service visit clears it.
 *
 * This tracker doesn't drive retries directly; the controller's
 * `igniteFireplace()` does that with explicit `Attempt N of M` logging.
 * The tracker's job is to record each attempt's outcome, persist the
 * history under the homebridge `storagePath` so it survives plugin
 * restarts and log rotations, and expose the consecutive-failure count
 * to the controller's circuit breaker.
 *
 * Persistence file: `<storagePath>/valor-ignition-history.json`. The
 * previous all-in-memory approach lost every diagnostic the moment
 * homebridge rotated its log.
 */
export type AttemptOutcome = 'pending' | 'success' | 'soft-fail' | 'hard-fail';

export interface IgnitionAttempt {
  id: number;
  attemptInSequence: number;
  maxInSequence: number;
  startedAtIso: string;
  finishedAtIso?: string;
  outcome: AttemptOutcome;
  durationMs?: number;
  finalStatusBits?: string;
  reason: string;
}

export class IgnitionTracker {
  /** Auto-retries this many times before giving up. */
  static MAX_ATTEMPTS = 4;
  /** Wait this long for `guardFlameOn` or `igniting=0` after Ignite command. */
  static IGNITION_TIMEOUT_MS = 90 * 1000;
  /** Spacing between auto-retries to let the receiver / gas line settle. */
  static RETRY_DELAY_MS = 45 * 1000;
  /** Cap on history we keep persisted. */
  static MAX_HISTORY = 200;

  private history: IgnitionAttempt[] = [];
  private current: IgnitionAttempt | null = null;
  private readonly filePath?: string;

  constructor(
    private readonly log: Logger,
    storagePath?: string,
  ) {
    if (storagePath) {
      this.filePath = path.join(storagePath, 'valor-ignition-history.json');
      this.load();
    } else {
      this.log.debug('IgnitionTracker: no storagePath provided, running in-memory only');
    }
  }

  /**
   * Caller is about to send the Ignite command for the n-th attempt in
   * a retry sequence. Returns the attempt record so callers can reference
   * its id in log lines.
   */
  recordAttemptStart(attemptInSequence: number, maxInSequence: number, reason: string): IgnitionAttempt {
    const id = (this.history[this.history.length - 1]?.id ?? 0) + 1;
    this.current = {
      id,
      attemptInSequence,
      maxInSequence,
      startedAtIso: new Date().toISOString(),
      outcome: 'pending',
      reason,
    };
    return this.current;
  }

  /** Caller observed a successful outcome (guardFlameOn = true). */
  recordSuccess(durationMs: number, finalStatusBits: string): void {
    this.complete('success', durationMs, finalStatusBits);
  }

  /** Caller observed a soft failure (igniting cleared back to 0, no flame). */
  recordSoftFailure(durationMs: number, finalStatusBits: string): void {
    this.complete('soft-fail', durationMs, finalStatusBits);
  }

  /** Caller observed a hard lockout (igniting bit stuck at 1 past timeout). */
  recordHardLockout(durationMs: number, finalStatusBits: string): void {
    this.complete('hard-fail', durationMs, finalStatusBits);
  }

  /**
   * Number of consecutive failures (any kind) since the last success.
   * Used by the controller to short-circuit fresh ignite requests when
   * we've already burned through MAX_ATTEMPTS.
   */
  consecutiveFailures(): number {
    let n = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const a = this.history[i];
      if (a.outcome === 'soft-fail' || a.outcome === 'hard-fail') {
        n++;
      } else if (a.outcome === 'success') {
        break;
      }
    }
    return n;
  }

  /** True if the most recent terminated attempt was a hard lockout. */
  hasRecentHardLockout(): boolean {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const a = this.history[i];
      if (a.outcome === 'success') {
        return false;
      }
      if (a.outcome === 'hard-fail') {
        return true;
      }
    }
    return false;
  }

  /** Read-only access for diagnostics or HomeKit fault surfacing. */
  getHistory(): readonly IgnitionAttempt[] {
    return this.history;
  }

  private complete(outcome: 'success' | 'soft-fail' | 'hard-fail', durationMs: number, finalBits: string) {
    if (!this.current) {
      return;
    }
    this.current.outcome = outcome;
    this.current.finishedAtIso = new Date().toISOString();
    this.current.durationMs = durationMs;
    this.current.finalStatusBits = finalBits;
    this.history.push(this.current);
    if (this.history.length > IgnitionTracker.MAX_HISTORY) {
      this.history = this.history.slice(-IgnitionTracker.MAX_HISTORY);
    }
    this.current = null;
    this.persist();
  }

  private load() {
    if (!this.filePath) {
      return;
    }
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.history)) {
          this.history = parsed.history;
          this.log.debug(`IgnitionTracker: loaded ${this.history.length} historical attempts from ${this.filePath}`);
        }
      }
    } catch (err) {
      this.log.warn(`IgnitionTracker: failed to read history (${(err as Error).message}); starting fresh`);
      this.history = [];
    }
  }

  private persist() {
    if (!this.filePath) {
      return;
    }
    try {
      const payload = JSON.stringify({ history: this.history }, null, 2);
      fs.writeFileSync(this.filePath, payload);
    } catch (err) {
      this.log.warn(`IgnitionTracker: failed to persist history (${(err as Error).message})`);
    }
  }
}
