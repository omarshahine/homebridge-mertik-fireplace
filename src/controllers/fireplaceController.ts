import { IDeviceConfig } from '../models/deviceConfig';
import EventEmitter from 'events';
import net, { Socket } from 'net';
import { FireplaceStatus } from '../models/fireplaceStatus';
import { OperationMode, OperationModeUtils } from '../models/operationMode';
import { FlameHeight, FlameHeightUtils } from '../models/flameHeight';
import { Logger, PlatformAccessory } from 'homebridge';
import { TemperatureRangeUtils } from '../models/temperatureRange';
import { IRequest } from '../models/request';
import { ValorPlatform } from '../platform';
import { IgnitionTracker } from './ignitionTracker';

export interface IFireplaceController extends EventEmitter {
  request(request: IRequest): Promise<boolean>;
  status(): FireplaceStatus | undefined;
  getFlameHeight(): FlameHeight;
  reachable(): boolean;
  setTemperature(temperature: number): void;
  /**
   * True when a confirmed Mertik GV60 hard-lockout state is in effect
   * (last terminated attempt was a hard-fail with no subsequent success).
   * Future code can wire this to a HomeKit `StatusFault` characteristic.
   */
  isLockoutActive(): boolean;
  /**
   * Abort any in-progress ignition retry sequence and ensure the burner is
   * shut off. No-op if no sequence is running.
   */
  abortIgnition(): void;
}

export interface IFireplaceEvents {
  on(event: 'status', listener: (status: FireplaceStatus) => void): this;
  on(event: 'reachable', listener: (reachable: boolean) => void): this;
  on(event: 'lockout', listener: (active: boolean) => void): this;
  /**
   * Fired when `guardFlameOff()` hits its ceiling without seeing
   * `guardFlameOn` clear. The `elapsedMs` argument is the actual wall time
   * spent waiting. Subscribers (HomeKit fault surface, log audit) can use
   * this to flag a partial shutdown rather than blindly trusting the
   * fixed delay that the older implementation used.
   */
  on(event: 'shutdownTimeout', listener: (elapsedMs: number) => void): this;
}

export class FireplaceController extends EventEmitter implements IFireplaceController, IFireplaceEvents {
  private readonly config: IDeviceConfig;
  private height = FlameHeight.Step11;
  private statusTimer: NodeJS.Timer | undefined;
  private client: Socket | null = null;
  private lastContact: Date = new Date();
  private lastStatus: FireplaceStatus | undefined;
  /**
   * Mirror of the receiver's live `igniting` status bit, refreshed on every
   * status packet (`processStatusResponse`). This is HARDWARE STATE — it
   * goes 0 between retry attempts while the gas line settles. Never use it
   * to decide whether our own retry sequence is running; use
   * `igniteSequenceActive` for that.
   */
  private igniting = false;
  private shuttingDown = false;
  private lostConnection = false;
  /**
   * True for the entire lifetime of an `igniteFireplace()` run — across all
   * attempts AND the waits between them. Unlike `igniting`, this is OUR
   * control state and is never overwritten by an incoming status packet.
   *
   * This is the single source of truth for "is an ignition sequence in
   * progress": it drives the re-entrancy guard (so repeated taps can't spawn
   * a second concurrent loop) and the abort-eligibility check (so an Off
   * reliably cancels a sequence even during the inter-attempt wait, when the
   * device bit reads 0). Conflating these two concerns into `igniting` was
   * the root cause of ignites-after-off and duplicate concurrent loops.
   */
  private igniteSequenceActive = false;
  /**
   * Set when a user request (typically Off) wants to interrupt the auto-retry
   * loop. The loop polls this between AND during attempts and bails out
   * gracefully, ensuring the burner is shut off afterwards.
   */
  private ignitionAbortRequested = false;
  /**
   * Tracks attempt outcomes and persists history across plugin restarts.
   * Provides the `consecutiveFailures` / `hasRecentHardLockout` signals
   * used by the circuit breaker below.
   */
  private readonly ignitionTracker: IgnitionTracker;
  private static UNREACHABLE_TIMEOUT = 1000 * 60 * 5; //5 min
  private static REFRESH_TIMEOUT = 1000 * 15; //15 seconds
  private static STATUS_PACKET_LENGTH = 106; //characters
  /**
   * How often we poll status while waiting for an Ignite to resolve.
   * Tighter than the normal 15s subscription because we want to catch
   * the igniting=1 → 0 transition quickly.
   */
  private static IGNITE_POLL_INTERVAL_MS = 5_000;
  /**
   * How long to wait for a status response after issuing a poll command
   * inside a transition wait. Must be longer than the normal round-trip
   * but short enough that a missed response just causes the next poll to
   * retry. 5s mirrors the CLI's `STATUS_RESPONSE_TIMEOUT`.
   */
  private static STATUS_RESPONSE_TIMEOUT_MS = 5_000;
  /**
   * Shutdown ceiling. Empirically a real shutdown observed at the cabin
   * (2026-05-17) took 26s — comfortably under this ceiling, but the
   * previous 30s blind delay was only 4s of headroom. 45s gives the gas
   * valve, pilot millivolts decay, and thermopile latch release plenty of
   * room without leaving HomeKit hanging.
   */
  private static SHUTDOWN_CEILING_MS = 45_000;
  /**
   * Poll cadence inside the shutdown wait. 2s is fine-grained enough to
   * catch the `guardFlameOn` clear within ~2s of the actual event.
   */
  private static SHUTDOWN_POLL_INTERVAL_MS = 2_000;
  /**
   * Hard safety cap on the thermostat setpoint, in Celsius. Mirrors the
   * HomeKit `setProps` cap in `serviceController` — duplicated here as a
   * defense against any code path (cached HomeKit state, restored
   * accessory state, future internal callers) that bypasses the slider's
   * advertised maxValue. 26.5°C ≈ 79.7°F.
   */
  private static MAX_SAFE_TARGET_C = 26.5;

  constructor(
    public readonly log: Logger,
    public readonly accessory: PlatformAccessory,
    public readonly platform?: ValorPlatform,
  ) {
    super();
    this.config = this.accessory.context.device;
    const storagePath = this.platform?.api?.user?.storagePath?.();
    this.ignitionTracker = new IgnitionTracker(this.log, storagePath);
    this.startStatusSubscription();
  }

  private startStatusSubscription(): void {
    this.stopStatusSubscription();
    this.log.debug('Start requesting status');
    this.client = null;
    this.statusTimer = setInterval((e) => e.refreshStatus(), FireplaceController.REFRESH_TIMEOUT, this);
  }

  private stopStatusSubscription() {
    this.log.debug('Stop requesting status');
    if (this.statusTimer) {
      clearInterval(this.statusTimer);
      this.statusTimer = undefined;
    }
  }

  private refreshStatus() {
    const isReachable = this.reachable();
    this.emit('reachable', isReachable);

    if (this.lastStatus) {
      // Security mechanisnm to turn off fireplace when we had contcat before.
      this.lostConnection = !isReachable;
      if (this.lostConnection){
        this.log.error('Lost contact!');
      }
    }

    try {
      this.sendCommand('303303');
    } catch {
      this.log.error('Failed to refresh!');
    }
  }

  private processStatusResponse(response: string) {
    const newStatus = new FireplaceStatus(response);
    this.lastContact = new Date();
    this.igniting = newStatus.igniting;
    this.shuttingDown = newStatus.shuttingDown;
    this.lastStatus = newStatus;
    this.emit('status', this.lastStatus);
    if (this.lostConnection) {
      // Make sure to turn it off, as we are not sure which state we are in.
      this.guardFlameOff();
    }
  }

  /**
   * True when the most recent terminated attempt was a hard lockout
   * (igniting bit stuck past timeout). External callers (HomeKit fault
   * surface, status reporting) can use this to render fault state.
   */
  public isLockoutActive(): boolean {
    return this.ignitionTracker.hasRecentHardLockout();
  }

  /**
   * Ignite the fireplace, retrying up to `IgnitionTracker.MAX_ATTEMPTS`
   * times. Each attempt sends the Ignite command, waits for the receiver's
   * own ignition cycle to resolve, and either declares success
   * (`guardFlameOn` confirmed), a soft failure (receiver cleanly gave up —
   * `igniting` cleared but no flame), or a hard lockout (`igniting` bit
   * stuck past `IGNITION_TIMEOUT_MS` — receiver is in safety fault and
   * needs manual reset).
   *
   * Logs each attempt as `[ignite] Attempt N of M` so the failure pattern
   * is visible in `homebridge.log` after the fact. Persists every outcome
   * to `<storagePath>/valor-ignition-history.json` for postmortem use even
   * if the homebridge log rotates.
   */
  private async igniteFireplace(): Promise<boolean> {
    if (this.igniteSequenceActive) {
      this.log.debug('Ignore — an ignition sequence is already in progress!');
      return false;
    }
    if (this.ignitionTracker.hasRecentHardLockout()) {
      this.log.error(
        '[ignite] Refusing to attempt — prior session ended in hard lockout. ' +
        'Manual intervention required (cycle gas at the wall, paperclip-reset the WiFi module, ' +
        'or retry ignition from the handheld). Restart homebridge after recovery to clear this state.',
      );
      return false;
    }
    this.ignitionAbortRequested = false;
    this.igniteSequenceActive = true;
    const max = IgnitionTracker.MAX_ATTEMPTS;
    try {
      for (let attempt = 1; attempt <= max; attempt++) {
        if (this.ignitionAbortRequested) {
          this.log.info(`[ignite] Attempt sequence aborted by user request before attempt ${attempt} of ${max}`);
          return false;
        }
        this.log.info(`[ignite] Attempt ${attempt} of ${max}: sending Ignite command`);
        const record = this.ignitionTracker.recordAttemptStart(attempt, max, 'auto-retry');
        const startedAt = Date.now();
        this.sendCommand('314103');
        const outcome = await this.waitForIgnitionOutcome(attempt, max);
        const elapsedMs = Date.now() - startedAt;
        const bits = this.lastStatus?.statusBitsHex ?? '????';
        if (outcome === 'aborted') {
          this.ignitionTracker.recordAborted(elapsedMs, bits);
          this.log.info(
            `[ignite] Attempt ${attempt} of ${max}: aborted by user request after ` +
            `${Math.round(elapsedMs / 1000)}s — ensuring burner is off.`,
          );
          await this.ensureOffAfterAbort();
          return false;
        }
        if (outcome === 'success') {
          this.ignitionTracker.recordSuccess(elapsedMs, bits);
          this.log.info(
            `[ignite] Attempt ${attempt} of ${max}: ✓ success after ${Math.round(elapsedMs / 1000)}s ` +
            `(attempt id=${record.id}, bits=0x${bits})`,
          );
          this.emit('lockout', false);
          return true;
        }
        if (outcome === 'soft-fail') {
          this.ignitionTracker.recordSoftFailure(elapsedMs, bits);
          this.log.warn(
            `[ignite] Attempt ${attempt} of ${max}: ✗ soft-fail after ${Math.round(elapsedMs / 1000)}s — ` +
            `receiver gave up cleanly (bits=0x${bits}). Common on cold starts.`,
          );
        } else {
          this.ignitionTracker.recordHardLockout(elapsedMs, bits);
          this.log.error(
            `[ignite] Attempt ${attempt} of ${max}: ✗ HARD LOCKOUT — igniting bit stuck after ` +
            `${Math.round(elapsedMs / 1000)}s (bits=0x${bits}). Stopping retry sequence; manual reset required.`,
          );
          this.emit('lockout', true);
          return false;
        }
        if (attempt < max) {
          const delaySec = Math.round(IgnitionTracker.RETRY_DELAY_MS / 1000);
          this.log.info(`[ignite] Waiting ${delaySec}s before attempt ${attempt + 1} of ${max}`);
          const aborted = await this.delayWithAbort(IgnitionTracker.RETRY_DELAY_MS);
          if (aborted) {
            this.log.info('[ignite] Retry wait interrupted by user request — aborting sequence');
            return false;
          }
        }
      }
      this.log.error(
        `[ignite] All ${max} attempts failed (no hard lockout but pilot never caught). ` +
        'Likely needs manual intervention: check gas pressure, pilot orifice, thermopile, or spark electrode.',
      );
      this.emit('lockout', true);
      return false;
    } finally {
      this.igniteSequenceActive = false;
    }
  }

  /**
   * After an aborted ignition sequence, make sure the burner is actually
   * off. An attempt may have caught flame in the poll window just before the
   * abort was observed, so we can't assume "aborted" means "never lit." This
   * is the safety backstop behind the user's Off request.
   */
  private async ensureOffAfterAbort(): Promise<void> {
    try {
      await this.guardFlameOff();
    } catch (err) {
      this.log.warn(`[ignite] Post-abort shutoff failed: ${(err as Error).message}`);
    }
  }

  /**
   * Poll status during an Ignite attempt and decide its outcome.
   *
   * Returns:
   *  - `'success'`: `guardFlameOn` came up — pilot caught.
   *  - `'soft-fail'`: `igniting` cleared back to 0 but no flame. Receiver
   *    gave up cleanly. Worth retrying.
   *  - `'hard-fail'`: `IGNITION_TIMEOUT_MS` elapsed with `igniting` still
   *    set. Receiver is locked out; only manual reset clears this.
   */
  private async waitForIgnitionOutcome(attempt: number, max: number): Promise<'success' | 'soft-fail' | 'hard-fail' | 'aborted'> {
    const start = Date.now();
    const timeoutMs = IgnitionTracker.IGNITION_TIMEOUT_MS;
    while (Date.now() - start < timeoutMs) {
      // Bail mid-attempt the instant the user asks to stop — don't run the
      // full ignition window before honoring an Off.
      if (this.ignitionAbortRequested) return 'aborted';
      await this.delay(FireplaceController.IGNITE_POLL_INTERVAL_MS);
      if (this.ignitionAbortRequested) return 'aborted';
      // Subscribe to the next status event before sending the poll, so we
      // can't race the response. Replaces a fixed 500ms wait that risked
      // reading stale `lastStatus` under slow network conditions.
      const responsePromise = this.waitForNextStatus(FireplaceController.STATUS_RESPONSE_TIMEOUT_MS);
      try {
        this.sendCommand('303303');
      } catch {
        this.log.debug('[ignite] Status request during ignite wait failed (will retry)');
      }
      const s = await responsePromise;
      if (!s) continue;
      if (s.guardFlameOn) {
        return 'success';
      }
      if (!s.igniting) {
        // Receiver cleared the igniting bit but never confirmed flame.
        // Classic soft failure — the most common cold-start outcome.
        return 'soft-fail';
      }
      // Promote progress ticks to info so the homebridge log shows the
      // attempt is alive during the 90s ignition window. Otherwise users
      // see an Ignite send and then silence until the outcome lands.
      this.log.info(
        `[ignite] Attempt ${attempt}/${max}: still igniting at ${Math.round((Date.now() - start) / 1000)}s (bits=0x${s.statusBitsHex})`,
      );
    }
    return 'hard-fail';
  }

  /**
   * Like `delay()` but bails out early if `ignitionAbortRequested` becomes
   * true. Returns true if it was interrupted, false on normal completion.
   */
  private async delayWithAbort(ms: number): Promise<boolean> {
    const step = 1000;
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (this.ignitionAbortRequested) return true;
      await this.delay(Math.min(step, end - Date.now()));
    }
    return false;
  }

  private async standBy() {
    this.log.info('Standby');
    await this.setTemperatureValue(0);
    const msg = '3136303003';
    return this.sendCommand(msg);
  }

  /**
   * Send the GuardFlame Off command and wait — by polling status, not a
   * blind delay — until the receiver confirms `guardFlameOn` is clear.
   *
   * Returns `true` on confirmed shutdown, `false` if we hit the
   * `SHUTDOWN_CEILING_MS` ceiling without confirmation. On timeout,
   * emits `'shutdownTimeout'` with the elapsed wall time so HomeKit and
   * log subscribers can react instead of trusting a stale assumption.
   *
   * Ported from `valor-fireplace-cli` v1.1.1 (`waitForTransition`). The
   * older 30s blind delay observed only ~4s of headroom on a real 26s
   * shutdown — slightly slower cycles would miss without anyone noticing.
   */
  private async guardFlameOff(): Promise<boolean> {
    if (this.shuttingDown) {
      this.log.debug('Ignore already shutting down!');
      return true;
    }
    this.log.info('GuardFlame Off');
    this.shuttingDown = true;
    let offSent = false;
    try {
      this.sendCommand('313003');
      offSent = true;
    } catch {
      this.log.warn('[shutdown] Initial GuardFlame Off send failed — will retry inside poll loop');
    }
    const start = Date.now();
    const ceilingMs = FireplaceController.SHUTDOWN_CEILING_MS;
    const pollMs = FireplaceController.SHUTDOWN_POLL_INTERVAL_MS;
    // A single poll iteration consumes up to `pollMs + STATUS_RESPONSE_TIMEOUT_MS`
    // of wall time. Refuse to start a new iteration unless we have that much
    // budget remaining — otherwise the stated ceiling is soft by up to 7s
    // and we'd block HomeKit past what the docstring promises.
    const stepBudgetMs = pollMs + FireplaceController.STATUS_RESPONSE_TIMEOUT_MS;
    while (Date.now() - start + stepBudgetMs <= ceilingMs) {
      await this.delay(pollMs);
      // Keep retrying the actual shutdown command until the socket accepts
      // it. The receiver is idempotent for repeat GuardFlame Off sends, so
      // there's no harm in re-sending; the risk we're guarding against is
      // a destroyed socket on the first send silently leaving the flame on
      // for the full ceiling window.
      if (!offSent) {
        try {
          this.sendCommand('313003');
          offSent = true;
          this.log.info('[shutdown] GuardFlame Off command resent after earlier failure');
        } catch {
          this.log.warn('[shutdown] GuardFlame Off send still failing — will retry next tick');
        }
      }
      const responsePromise = this.waitForNextStatus(FireplaceController.STATUS_RESPONSE_TIMEOUT_MS);
      try {
        this.sendCommand('303303');
      } catch {
        this.log.debug('[shutdown] Status poll send failed (will retry next tick)');
      }
      const s = await responsePromise;
      const elapsed = Math.round((Date.now() - start) / 1000);
      if (s && !s.guardFlameOn) {
        this.log.info(`[shutdown] Confirmed off after ${elapsed}s`);
        return true;
      }
      this.log.info(`[shutdown] Waiting for guard flame off at ${elapsed}s`);
    }
    const elapsedMs = Date.now() - start;
    this.log.warn(
      `[shutdown] Did not confirm off within ${Math.round(ceilingMs / 1000)}s ceiling — ` +
      'guard flame may still be on. Emitting shutdownTimeout event.',
    );
    this.emit('shutdownTimeout', elapsedMs);
    return false;
  }

  /**
   * Wait for the next `status` event with a timeout. Subscribes
   * synchronously (via `this.once`) before returning, so callers can do
   *
   *   const responsePromise = this.waitForNextStatus(timeoutMs);
   *   this.sendCommand('303303');
   *   const s = await responsePromise;
   *
   * without racing the response. If no event arrives in `timeoutMs`,
   * resolves with the current `lastStatus` (which may be stale or
   * undefined) — the caller decides what to do with stale data.
   *
   * Ported from `valor-fireplace-cli` v1.1.0 — replaces a fixed 500ms
   * delay that risked reading stale `lastStatus` under slow network
   * conditions.
   */
  private waitForNextStatus(timeoutMs: number): Promise<FireplaceStatus | undefined> {
    return new Promise((resolve) => {
      let resolved = false;
      const finish = (s: FireplaceStatus | undefined) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        this.removeListener('status', handler);
        resolve(s);
      };
      const handler = (s: FireplaceStatus) => finish(s);
      const timer = setTimeout(() => finish(this.lastStatus), timeoutMs);
      this.once('status', handler);
    });
  }

  private setEcoMode(){
    return this.sendCommand('4233303103');
  }

  private setManualMode(){
    return this.sendCommand('423003');
  }

  private setTemperatureMode() {
    return this.sendCommand('4232303103');
  }

  private ensureClient(): Socket {
    const ip = this.config.ip;
    this.log.debug(`Using ip:'${ip}'`);
    if (!this.client
      || (typeof(this.client) === 'undefined') || (typeof(this.client.destroyed) !== 'boolean') || (this.client.destroyed === true)) {
      this.log.debug('Created socket');
      this.client = new net.Socket();
      this.client.connect(2000, ip);
      this.client.setTimeout(FireplaceController.REFRESH_TIMEOUT);
      this.client.on('data', (data) => {
        const tempData = data.toString().substring(1, data.length - 1);
        if (tempData.length === FireplaceController.STATUS_PACKET_LENGTH) {
          this.processStatusResponse(tempData);
        }
      });
      this.client.on('error', (err) => {
        this.log.debug('Socket error: ' + err.message);
        if (this.client && typeof(this.client.destroy) === 'function') {
          this.client.destroy();
        }
      });
    }
    return this.client;
  }

  private sendCommand(command: string): boolean {
    const prefix = '0233303330333033303830';
    const packet = Buffer.from(prefix + command, 'hex');
    this.log.debug('Sending packet: ' + prefix + command);
    return this.ensureClient().write(packet);
  }

  reachable(): boolean {
    const now = new Date().getTime();
    const last = this.lastContact.getTime();
    return (now - last) < FireplaceController.UNREACHABLE_TIMEOUT;
  }

  status(): FireplaceStatus | undefined {
    return this.lastStatus;
  }

  delay = ms => new Promise(res => setTimeout(res, ms));

  resetFlameHeight(): void {
    const msg = '3136' + FlameHeight.Step11 + '03';
    this.sendCommand(msg);
  }

  async setFlameHeight(temperature: number) {
    const percentage = ((temperature) - 5) / 31;
    this.log.debug(`Set flame height to percentage: ${percentage}`);
    const height = FlameHeightUtils.ofPercentage(percentage);
    this.log.info(`Set flame height to ${height.toString()}`);
    this.height = height;
    this.resetFlameHeight();
    await this.delay(10_000);
    const msg = '3136' + height + '03';
    this.sendCommand(msg);
    await this.delay(1_000);
  }

  public getFlameHeight(): FlameHeight {
    return this.height;
  }

  public async setTemperature(temperature: number) {
    // Defensive safety cap. The HomeKit slider is already constrained by
    // `setProps` in serviceController, but cached/restored state and
    // internal callers can still hand us higher values.
    if (temperature > FireplaceController.MAX_SAFE_TARGET_C) {
      this.log.warn(
        `Target temperature ${temperature}°C exceeds safety cap of ` +
        `${FireplaceController.MAX_SAFE_TARGET_C}°C — clamping.`,
      );
      temperature = FireplaceController.MAX_SAFE_TARGET_C;
    }
    // Log in configured temperature unit
    const unit = this.platform?.temperatureUnit || 'C';
    const displayTemp = unit === 'F' ? Math.round(temperature * 9/5 + 32) : temperature;
    this.log.info(`Set temperature to ${displayTemp}°${unit}`);

    // Only do full mode reset if not already in temperature mode
    const currentMode = this.lastStatus?.mode;
    if (currentMode !== OperationMode.Temperature) {
      this.setManualMode();
      await this.delay(1_000);
      this.resetFlameHeight();
      await this.delay(5_000);
      this.setTemperatureMode();
      await this.delay(5_000);
    }

    if (this?.lastStatus?.targetTemperature !== temperature) {
      await this.setTemperatureValue(temperature);
    }
  }

  private async setTemperatureValue(temperature: number) {
    const value = TemperatureRangeUtils.toBits(temperature);
    const msg = '42324644303' + value + '03';
    this.sendCommand(msg);
    await this.delay(1_000);
  }

  async setMode(request: IRequest): Promise<boolean> {
    const mode = request.mode!;
    const currentMode = this.lastStatus?.mode || OperationMode.Off;
    if (this.igniteSequenceActive) {
      // A sequence owns the fireplace right now. Ignore this re-entrant mode
      // change instead of spawning a second concurrent ignite loop. Return
      // true: this is a deliberate no-op, not a failure — returning false
      // would make requestController queue a retry storm.
      this.log.debug('Ignore — ignition sequence already in progress!');
      return true;
    }
    if (OperationModeUtils.needsIgnite(mode) && currentMode === OperationMode.Off && !this.lastStatus?.guardFlameOn) {
      this.log.info('Ignite fireplace');
      const igniteSucceeded = await this.igniteFireplace();
      if (!igniteSucceeded) {
        // igniteFireplace() already ran its own MAX_ATTEMPTS retry sequence
        // and (on hard-fail) flipped the lockout circuit breaker. Returning
        // true here keeps requestController from queueing a second-layer
        // 90s retry storm on top of that.
        return true;
      }
      // Ignition succeeded. The receiver lands in Manual by default —
      // fall through so we still apply the user's requested mode (e.g.
      // Temperature for HEAT) instead of leaving them stuck in Manual.
    }
    // Re-read mode: lastStatus was updated by the polls inside the ignite
    // wait loop, so currentMode (captured above) is stale post-ignite.
    const liveMode = this.lastStatus?.mode || OperationMode.Off;
    if (liveMode === mode) {
      this.log.debug('Ignore same mode!');
      return true;
    }
    this.log.info(`Set mode to: ${OperationMode[mode]}`);
    const targetTemperature = request.temperature ?? this.lastStatus?.targetTemperature ?? 20;
    switch(mode) {
      case OperationMode.Manual:
        this.setManualMode();
        await this.setFlameHeight(targetTemperature);
        break;
      case OperationMode.Eco:
        await this.setFlameHeight(targetTemperature);
        this.setEcoMode();
        break;
      case OperationMode.Temperature:
        await this.setTemperature(targetTemperature);
        break;
      case OperationMode.Off:
        await this.guardFlameOff();
        break;
    }
    return true;
  }

  setAux(on: boolean) {
    this.log.info(`Set aux mode to ${on}`);
    this.sendCommand(on ? '32303031030a' : '32303030030a');
  }

  /**
   * Signal that any in-progress ignition sequence should abort. Safe to call
   * from outside `request()` (e.g. the request controller, the instant an Off
   * arrives) so the abort is honored immediately even while another request
   * is in flight. The sequence loop sees the flag, stops, and shuts the
   * burner off. No-op if no sequence is running.
   */
  public abortIgnition(): void {
    if (this.igniteSequenceActive && !this.ignitionAbortRequested) {
      this.log.info('Off requested while ignition sequence is in progress — aborting and shutting off');
      this.ignitionAbortRequested = true;
    }
  }

  async request(request: IRequest): Promise<boolean> {
    // If the auto-retry ignition loop is active, an Off request should
    // abort the sequence rather than queueing behind it. (Also signaled
    // synchronously by requestController via abortIgnition() — this is the
    // defensive second line for direct callers.)
    if (request.mode === OperationMode.Off) {
      this.abortIgnition();
    }
    // If a prior session ended in a hard lockout, block everything except
    // an explicit Off (which can't hurt and may help reconcile state).
    if (this.ignitionTracker.hasRecentHardLockout() && request.mode !== OperationMode.Off) {
      this.log.warn(
        'Ignoring request — fireplace is in Mertik GV60 hard-lockout state. ' +
        'Physical intervention required to clear (cycle gas at the wall, paperclip-reset the WiFi module, ' +
        'or retry ignition from the handheld). Restart homebridge after recovery.',
      );
      return false;
    }
    let succeeds = true;
    const currentMode = this.lastStatus?.mode || OperationMode.Off;
    this.stopStatusSubscription();
    if (request.mode !== undefined
      && request.mode !== currentMode) {
      succeeds = await this.setMode(request);
    } else if (request.temperature !== undefined
      && (request.mode === OperationMode.Temperature || this.lastStatus?.mode === OperationMode.Temperature)) {
      if (request.temperature <= 0.0) {
        await this.standBy();
      } else {
        await this.setTemperature(request.temperature);
      }
    } else if (request.temperature !== undefined
       && (request.mode === OperationMode.Manual || request.mode === OperationMode.Eco
        || this.lastStatus?.mode === OperationMode.Manual || this.lastStatus?.mode === OperationMode.Eco)) {
      if (request.temperature <= 0.0) {
        await this.standBy();
      } else {
        await this.setFlameHeight(request.temperature);
      }
    }
    await this.delay(5_000);
    if ((!request.temperature || request.temperature > 0.0) && request.auxOn !== undefined) {
      await this.delay(8_000);
      this.setAux(request.auxOn);
      await this.delay(5_000);
    }
    this.startStatusSubscription();
    return succeeds;
  }
}
