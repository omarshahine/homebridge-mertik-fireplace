import { CharacteristicValue, PlatformAccessory } from 'homebridge';
import {
  IFireplaceController,
  FireplaceController,
} from './controllers/fireplaceController';
import {
  IRequestController,
  RequestController,
} from './controllers/requestController';
import {
  IServiceController,
  ServiceController,
} from './controllers/serviceController';
import { AuxModeUtils } from './models/auxMode';
import { FireplaceStatus } from './models/fireplaceStatus';
import { OperationMode, OperationModeUtils } from './models/operationMode';
import { ValorPlatform } from './platform';

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class FireplacePlatformAccessory {
  private readonly fireplace: IFireplaceController;
  private readonly request: IRequestController;
  private readonly service: IServiceController;
  private lastStatusKey: string | undefined;
  /**
   * Whether this fireplace has the optional aux fan kit. When false the
   * SwingMode control is never exposed and aux is never touched. Defaults to
   * true (exposed) unless the device config explicitly sets auxFan: false.
   */
  private readonly auxFanEnabled: boolean;

  constructor(
    private readonly platform: ValorPlatform,
    accessory: PlatformAccessory,
  ) {
    this.auxFanEnabled = accessory.context.device?.auxFan !== false;
    this.fireplace = new FireplaceController(platform.log, accessory, platform);
    this.service = new ServiceController(platform.log, accessory, platform);
    this.request = new RequestController(
      platform.log,
      this.fireplace,
      this.isLocked(),
    );
    this.subscribeFireplace();
    this.subscribeService();
    // Initialize characteristics AFTER handlers are set up to avoid validation errors
    this.service.initCharacteristics();
  }

  private isLocked(): boolean {
    return (
      this.service.lockControlsCharacteristic()?.value ===
      this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
    );
  }

  subscribeFireplace() {
    this.fireplace.on('status', (status) => {
      this.logStatus(status);
      this.updateActive(status);
      if (!status.igniting && !status.shutdown) {
        this.updateCurrentHeatingCoolerState(status);
        this.updateTargetHeatingCoolerState(status);
        this.updateCurrentTemperature(status);
      }
      if (this.auxFanEnabled) {
        this.updateSwingMode(status);
      }
      this.updateHeatingThresholdTemperature(status);
    });
    this.fireplace.on('reachable', (reachable) => {
      this.updateReachable(reachable);
    });
  }

  subscribeService() {
    this.service
      .activeCharacteristic()
      .onGet(() => this.activeValue(this.getStatus()))
      .onSet((value) => {
        this.platform.log.debug('activeCharacteristic onSet');
        const status = this.getStatus();
        if (
          (value === this.platform.Characteristic.Active.ACTIVE &&
            status.mode === OperationMode.Off) ||
          (value === this.platform.Characteristic.Active.INACTIVE &&
            status.mode !== OperationMode.Off)
        ) {
          this.request.setMode(
            OperationModeUtils.ofActive(
              this.platform,
              value,
              this.service.targetHeaterCoolerStateCharacteristic().value ||
                this.platform.Characteristic.TargetHeaterCoolerState.AUTO,
            ),
          );
        }
      });
    this.service
      .currentHeaterCoolerStateCharacteristic()
      .onGet(() => this.heaterCoolerStateValue(this.getStatus()));

    this.service
      .targetHeaterCoolerStateCharacteristic()
      .onGet(() => this.targetHeaterCoolerStateValue(this.getStatus()))
      .onSet((value) => {
        this.platform.log.debug('targetHeaterCoolerStateCharacteristic onSet');
        this.request.setMode(
          OperationModeUtils.ofHeaterCoolerState(this.platform, value),
        );
      });

    this.service
      .lockControlsCharacteristic()
      .onGet(() => this.request.isLocked())
      .onSet((value) =>
        value ===
        this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
          ? this.request.lock()
          : this.request.unlock(),
      );

    if (this.auxFanEnabled) {
      this.service
        .swingModeCharacteristic()
        .onGet(() => this.swingModeValue(this.getStatus()))
        .onSet((value) =>
          this.request.setAux(AuxModeUtils.fromSwingMode(this.platform, value)),
        );
    } else {
      // No aux fan kit on this unit — drop the phantom SwingMode control so it
      // doesn't appear in the Home app, and never send aux commands.
      this.service.removeSwingMode();
    }

    this.service
      .heatingThresholdTemperatureCharacteristic()
      .onGet(() => this.targetHeatingThresholdValue(this.getStatus()))
      .onSet((value) => {
        this.request.setTemperature(value as number);
      });

    this.service
      .coolingThresholdTemperatureCharacteristic()
      .onGet(() => this.targetHeatingThresholdValue(this.getStatus())) // Return same as heating for heater-only device
      .onSet((value) => {
        this.request.setTemperature(value as number); // Treat cooling adjustment as heating adjustment
      });

    this.service
      .reachableCharacteristic()
      .onGet(() => this.reachableValue(this.fireplace.reachable()));
  }

  private getStatus(): FireplaceStatus {
    if (!this.fireplace.reachable()) {
      this.platform.log.debug('Device not connected!');
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    const status = this.fireplace.status();
    if (!status) {
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.RESOURCE_BUSY,
      );
    }
    return status!;
  }

  // Update handlers

  private updateReachable(reachable: boolean) {
    this.service
      .reachableCharacteristic()
      .updateValue(this.reachableValue(reachable));
  }

  private updateActive(status: FireplaceStatus) {
    this.service.activeCharacteristic().updateValue(this.activeValue(status));
  }

  private updateCurrentHeatingCoolerState(status: FireplaceStatus) {
    this.service
      .currentHeaterCoolerStateCharacteristic()
      .updateValue(this.heaterCoolerStateValue(status));
  }

  private updateTargetHeatingCoolerState(status: FireplaceStatus) {
    this.service
      .targetHeaterCoolerStateCharacteristic()
      .updateValue(this.targetHeaterCoolerStateValue(status));
  }

  private updateCurrentTemperature(status: FireplaceStatus) {
    this.service
      .currentTemperatureCharacteristic()
      .updateValue(
        status.currentTemperature > 100 ? 20 : status.currentTemperature,
      );
  }

  private updateSwingMode(status: FireplaceStatus) {
    this.service
      .swingModeCharacteristic()
      .updateValue(this.swingModeValue(status));
  }

  private updateHeatingThresholdTemperature(status: FireplaceStatus) {
    this.service
      .heatingThresholdTemperatureCharacteristic()
      .updateValue(this.targetHeatingThresholdValue(status));
  }

  // CharacteristicValues

  private reachableValue(reachable: boolean): CharacteristicValue {
    return reachable
      ? this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED
      : this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED;
  }

  private activeValue(status: FireplaceStatus): CharacteristicValue {
    const currentRequest = this.request.currentRequest();
    let mode = status.mode;
    if (currentRequest?.mode) {
      const requestedMode = currentRequest?.mode || OperationMode.Manual;
      // Override mode with requested mode to not flicker the interface.
      mode = requestedMode;
    }
    return OperationModeUtils.toActive(
      this.platform,
      mode,
      status.igniting,
      status.shuttingDown,
    );
  }

  private swingModeValue(status: FireplaceStatus): CharacteristicValue {
    const currentRequest = this.request.currentRequest();
    if (currentRequest?.auxOn) {
      const requestedAux = currentRequest?.auxOn || false;
      return AuxModeUtils.toSwingMode(this.platform, requestedAux);
    }
    return AuxModeUtils.toSwingMode(this.platform, status.auxOn);
  }

  private heaterCoolerStateValue(status: FireplaceStatus): CharacteristicValue {
    const currentRequest = this.request.currentRequest();
    if (currentRequest?.mode) {
      const requestedMode = currentRequest?.mode || OperationMode.Manual;
      return OperationModeUtils.toHeatingCoolerState(
        this.platform,
        requestedMode,
        status.guardFlameOn,
      );
    }
    return OperationModeUtils.toHeatingCoolerState(
      this.platform,
      status.mode,
      status.guardFlameOn,
    );
  }

  private targetHeaterCoolerStateValue(
    status: FireplaceStatus,
  ): CharacteristicValue {
    const currentRequest = this.request.currentRequest();
    if (currentRequest?.mode) {
      const requestedMode = currentRequest?.mode || OperationMode.Manual;
      return OperationModeUtils.toTargetHeaterCoolerState(
        this.platform,
        requestedMode,
      );
    }
    return OperationModeUtils.toTargetHeaterCoolerState(
      this.platform,
      status.mode,
    );
  }

  private targetHeatingThresholdValue(
    status: FireplaceStatus,
  ): CharacteristicValue {
    const currentRequest = this.request.currentRequest();
    // Prefer an explicit in-flight temperature request; otherwise report the
    // device's real thermostat setpoint (chars 32-35), which the receiver
    // retains even while transiently in Manual mode after ignition.
    //
    // We intentionally do NOT map Manual-mode flame height onto this slider.
    // Flame height maps to a 5-36 range, but the characteristic is capped at
    // the 80°F / 26.5°C safety max — so a high flame produced values like 33
    // that overflowed the cap. That was the source of both the repeated
    // "exceeded maximum of 26.5" warnings and the slider showing 80°F instead
    // of the user's actual setpoint (e.g. 68°F) right after ignition.
    const target = currentRequest?.temperature ?? status.targetTemperature;

    // Clamp into the characteristic's advertised range so HomeKit never
    // receives an illegal value (which it would reject with a warning and
    // clamp anyway). Read the bounds from the characteristic so this tracks
    // any future change to the configured cap.
    const props = this.service.heatingThresholdTemperatureCharacteristic().props;
    const min = props.minValue ?? 0;
    const max = props.maxValue ?? 26.5;
    return Math.min(max, Math.max(min, target));
  }

  /**
   * The fireplace is idle when it is off and no ignition or shutdown sequence
   * is running. Nothing about an idle fireplace changes between polls except
   * the room temperature, so recurring logs while idle are pure noise.
   */
  private isIdle(status: FireplaceStatus): boolean {
    return (
      status.mode === OperationMode.Off &&
      !status.igniting &&
      !status.shuttingDown &&
      !status.guardFlameOn
    );
  }

  private logStatus(status: FireplaceStatus) {
    const formattedStatus = this.formatStatus(status);
    const idle = this.isIdle(status);
    // While idle, ambient temperature drift alone would emit a "Status changed"
    // line every poll, so compare on everything but the room temperature.
    const key = idle ? this.formatStatus(status, false) : formattedStatus;
    const first = this.lastStatusKey === undefined;
    const statusChanged = !first && this.lastStatusKey !== key;
    this.lastStatusKey = key;

    // Log on first status and on changes. Repeat polls are only logged at info
    // level in debug mode, and only while the fireplace is doing something —
    // otherwise they go to the debug channel (visible with homebridge -D).
    if (first) {
      this.platform.log.info(`Initial status - ${formattedStatus}`);
    } else if (statusChanged) {
      this.platform.log.info(`Status changed - ${formattedStatus}`);
    } else if (this.platform.debugMode && !idle) {
      this.platform.log.info(`Status update - ${formattedStatus}`);
    } else {
      this.platform.log.debug(`Status update - ${formattedStatus}`);
    }
  }

  // Format status with temperature in configured unit
  private formatStatus(status: FireplaceStatus, includeCurrent = true): string {
    const unit = this.platform.temperatureUnit;
    const current = unit === 'F'
      ? this.celsiusToFahrenheit(status.currentTemperature)
      : status.currentTemperature;
    const target = unit === 'F'
      ? this.celsiusToFahrenheit(status.targetTemperature)
      : status.targetTemperature;

    return `mode:${OperationMode[status.mode]} `
      + `ignite:${status.igniting} `
      + `target:${target}°${unit} `
      + `aux:${status.auxOn} `
      + (includeCurrent ? `current:${current}°${unit} ` : '')
      + `shutdown:${status.shuttingDown} `
      + `guardOn:${status.guardFlameOn}`;
  }

  private celsiusToFahrenheit(celsius: number): number {
    return Math.round(celsius * 9/5 + 32);
  }
}
