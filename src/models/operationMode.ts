import { CharacteristicValue } from 'homebridge';
import { ValorPlatform } from '../platform';

export enum OperationMode {
  Off = 1,
  Manual = 2,
  Temperature = 3,
  Eco = 4,
}

export class OperationModeUtils {
  public static needsIgnite(mode: OperationMode): boolean {
    switch (mode) {
      case OperationMode.Eco:
      case OperationMode.Manual:
      case OperationMode.Temperature:
        return true;
      default:
        return false;
    }
  }

  public static toHeatingCoolerState(
    platform: ValorPlatform,
    mode: OperationMode,
    guardFlameOn: boolean,
  ): CharacteristicValue {
    // Every branch below assigns, including default, so no initializer is needed.
    let state: CharacteristicValue;
    switch (mode) {
      case OperationMode.Temperature:
        state = platform.Characteristic.CurrentHeaterCoolerState.IDLE;
        break;
      case OperationMode.Eco:
      case OperationMode.Manual:
        state = platform.Characteristic.CurrentHeaterCoolerState.HEATING;
        break;
      default:
        state = guardFlameOn
          ? platform.Characteristic.CurrentHeaterCoolerState.IDLE
          : platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
        break;
    }
    return state;
  }

  public static toTargetHeaterCoolerState(
    platform: ValorPlatform,
    _mode: OperationMode,
  ): CharacteristicValue {
    // All modes map to HEAT since this is a heater-only device. The mode is kept
    // in the signature for symmetry with the other converters and callers.
    return platform.Characteristic.TargetHeaterCoolerState.HEAT;
  }

  public static ofHeaterCoolerState(
    platform: ValorPlatform,
    value: CharacteristicValue,
  ): OperationMode {
    // HEAT is the only supported mode - always use Temperature mode
    if (value === platform.Characteristic.TargetHeaterCoolerState.HEAT) {
      return OperationMode.Temperature;
    } else {
      return OperationMode.Off;
    }
  }

  public static toActive(
    platform: ValorPlatform,
    mode: OperationMode,
    igniting: boolean,
    shuttingDown: boolean,
  ): CharacteristicValue {
    return mode === OperationMode.Off && (!igniting || shuttingDown)
      ? platform.Characteristic.Active.INACTIVE
      : platform.Characteristic.Active.ACTIVE;
  }

  public static ofActive(
    platform: ValorPlatform,
    value: CharacteristicValue,
    heatingCoolerStateValue: CharacteristicValue,
  ): OperationMode {
    return value === platform.Characteristic.Active.ACTIVE
      ? this.ofHeaterCoolerState(platform, heatingCoolerStateValue)
      : OperationMode.Off;
  }
}
