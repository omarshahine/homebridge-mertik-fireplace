import { Logger } from 'homebridge';
import { OperationMode } from '../models/operationMode';
import { IRequest } from '../models/request';
import { IFireplaceController } from './fireplaceController';

export interface IRequestController {
  isLocked(): boolean;
  unlock(): void;
  lock(): void;
  setAux(on: boolean): void;
  setMode(mode: OperationMode): void;
  setTemperature(temperature: number): void;
  currentRequest(): IRequest | undefined;
}

export class RequestController implements IRequestController{
  private static MAX_RETRIES = 10;
  private static DEBOUNCE_MS = 10_000;
  private static RETRY_DELAY_MS = 90_000;
  private busy = false;
  private scheduledRequest?: IRequest;
  private sendTask?: NodeJS.Timer;
  private lockTask?: NodeJS.Timer;
  private retryCount = 0;

  constructor(
    public readonly log: Logger,
    public readonly fireplace: IFireplaceController,
    public locked = false) {

  }

  public isLocked(): boolean {
    return this.locked || this.lockTask !== undefined;
  }

  private isAllowed(): boolean {
    return !this.locked;
  }

  currentRequest() {
    return this.scheduledRequest;
  }

  clearScheduledLock() {
    clearInterval(this.lockTask);
    this.lockTask = undefined;
  }

  lock() {
    this.clearScheduledLock();
    this.log.info('Lock control after 1 minute (makes sure that automations still run through.');
    this.lockTask = setTimeout(() => {
      this.locked = true;
      this.log.info('Locked controls');
    }, 60_000);
  }

  unlock() {
    this.clearScheduledLock();
    this.locked = false;
    this.log.info('Unlocked controls');

  }

  setAux(on: boolean) {
    this.retryCount = 0;
    this.scheduleRequest({auxOn: on});
  }

  setMode(mode: OperationMode) {
    this.retryCount = 0;
    // An Off must abort an in-progress ignition sequence IMMEDIATELY, even if
    // a request is currently in flight (the multi-minute ignite loop). Signal
    // it synchronously here rather than waiting for this request to be
    // dequeued — otherwise the burner can light after the user said off.
    if (mode === OperationMode.Off) {
      this.fireplace.abortIgnition();
    }
    this.scheduleRequest({mode});
  }

  setTemperature(temperature: number) {
    this.retryCount = 0;
    this.scheduleRequest({temperature});
  }

  clearScheduledTask() {
    clearInterval(this.sendTask);
    this.sendTask = undefined;
  }

  private scheduleRequest(request: IRequest, delayMs: number = RequestController.DEBOUNCE_MS) {
    if (this.sendTask) {
      this.clearScheduledTask();
    }

    const mergedRequest = this.scheduledRequest ? {...this.scheduledRequest, ...request} : request;
    this.scheduledRequest = mergedRequest;
    this.sendTask = setTimeout(() => this.sendRequest(mergedRequest), delayMs);
  }

  private async sendRequest(request: IRequest, retry = false) {
    // Never run two requests against the fireplace concurrently. A request in
    // flight can be a multi-minute ignition retry sequence; starting another
    // on top of it spawns duplicate ignite loops and a retry storm (observed
    // 2026-06-20). Defer instead — the in-flight request will finish and the
    // rescheduled one runs then. An Off has already signaled its abort
    // synchronously via setMode(), so deferring it here is safe.
    if (this.busy) {
      this.scheduleRequest(request, RequestController.DEBOUNCE_MS);
      return;
    }
    this.clearScheduledTask();
    if (!this.isAllowed()) {
      if (!retry) {
        setTimeout(() => this.sendRequest(request, true), RequestController.DEBOUNCE_MS);
        return;
      }

      this.log.info('Parental controls active, action is not allowed!');
      this.scheduledRequest = undefined;
      return;
    }
    this.log.debug(`Request: ${JSON.stringify(request)}`);
    this.busy = true;
    const success = await this.fireplace.request(request);
    if (!success) {
      this.retryCount++;
      if (this.retryCount <= RequestController.MAX_RETRIES) {
        this.log.info(`Retry attempt ${this.retryCount}/${RequestController.MAX_RETRIES} (waiting ${RequestController.RETRY_DELAY_MS / 1000}s)`);
        this.scheduleRequest(request, RequestController.RETRY_DELAY_MS);
      } else {
        this.log.warn(`Max retries (${RequestController.MAX_RETRIES}) reached, giving up`);
        this.retryCount = 0;
      }
    } else {
      this.retryCount = 0;
    }
    this.scheduledRequest = undefined;
    this.busy = false;
  }
}
