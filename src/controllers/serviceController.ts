import { Characteristic, Logger, PlatformAccessory, Service } from "homebridge";
import { IDeviceConfig } from "../models/deviceConfig";
import { ValorPlatform } from "../platform";

export interface IServiceController {
  reachableCharacteristic(): Characteristic;
  activeCharacteristic(): Characteristic;
  currentHeaterCoolerStateCharacteristic(): Characteristic;
  targetHeaterCoolerStateCharacteristic(): Characteristic;
  currentTemperatureCharacteristic(): Characteristic;
  coolingThresholdTemperatureCharacteristic(): Characteristic;
  lockControlsCharacteristic(): Characteristic;
  swingModeCharacteristic(): Characteristic;
  heatingThresholdTemperatureCharacteristic(): Characteristic;
  initCharacteristics(): void;
}

export class ServiceController implements IServiceController {
  private readonly config: IDeviceConfig;
  private readonly service: Service;
  private readonly reachableService: Service;

  constructor(
    public readonly log: Logger,
    public readonly accessory: PlatformAccessory,
    private readonly platform: ValorPlatform
  ) {
    this.config = this.accessory.context.device;

    // Get or add the HeaterCooler service
    this.service =
      this.accessory.getService(this.platform.Service.HeaterCooler) ||
      this.accessory.addService(this.platform.Service.HeaterCooler);

    // Get or add ContactSensor service
    this.reachableService =
      this.accessory.getService(this.platform.Service.ContactSensor) ||
      this.accessory.addService(this.platform.Service.ContactSensor);

    // Note: Don't call initCharacteristics() here - it will be called after handlers are set up
  }

  initCharacteristics() {
    const name = this.config.name;
    if (name.length < 2) {
      this.platform.log.error(
        `The given name ${this.config.name}, is too short`
      );
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.RESOURCE_DOES_NOT_EXIST
      );
    }
    this.accessory
      .getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, "Valor")
      .setCharacteristic(this.platform.Characteristic.Model, "B6R-WME")
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.accessory.UUID
      )
      .setCharacteristic(
        this.platform.Characteristic.Name,
        this.config.name ?? "Fireplace"
      );

    // Set the service names
    this.service.setCharacteristic(
      this.platform.Characteristic.Name,
      this.config.name ?? "Fireplace"
    );
    this.reachableService.setCharacteristic(
      this.platform.Characteristic.Name,
      "Connected"
    );

    // Configure target heater cooler state to only support HEAT
    // This is a heater-only device (fireplace)
    this.targetHeaterCoolerStateCharacteristic().setProps({
      validValues: [
        this.platform.Characteristic.TargetHeaterCoolerState.HEAT,
      ],
    });

    // Configure HeatingThresholdTemperature with proper props.
    // minValue 0 keeps the "off" state addressable (target temp can be 0).
    // maxValue 26.5°C (~79.7°F) is a hard safety cap — 36°C (~97°F) is
    // unsafe for a fireplace thermostat and slipped through the slider
    // before. If anyone needs higher they should use Manual flame-height.
    this.heatingThresholdTemperatureCharacteristic().setProps({
      minValue: 0.0,
      maxValue: 26.5,
      minStep: 0.5,
    });

    // Configure CoolingThresholdTemperature - required for iOS to display
    // detail view. Even though we don't use cooling, iOS needs this
    // characteristic defined. Cap matches heating for consistency.
    this.coolingThresholdTemperatureCharacteristic().setProps({
      minValue: 10.0,
      maxValue: 26.5,
      minStep: 0.5,
    });

    // Configure CurrentTemperature with proper props
    this.currentTemperatureCharacteristic().setProps({
      minValue: 0.0,
      maxValue: 100.0,
      minStep: 0.1,
    });
  }

  reachableCharacteristic = () =>
    this.reachableService.getCharacteristic(
      this.platform.Characteristic.ContactSensorState
    );

  activeCharacteristic = () =>
    this.service.getCharacteristic(this.platform.Characteristic.Active);

  currentHeaterCoolerStateCharacteristic = () =>
    this.service.getCharacteristic(
      this.platform.Characteristic.CurrentHeaterCoolerState
    );

  targetHeaterCoolerStateCharacteristic = () =>
    this.service.getCharacteristic(
      this.platform.Characteristic.TargetHeaterCoolerState
    );

  currentTemperatureCharacteristic = () =>
    this.service.getCharacteristic(
      this.platform.Characteristic.CurrentTemperature
    );

  coolingThresholdTemperatureCharacteristic = () =>
    this.service.getCharacteristic(
      this.platform.Characteristic.CoolingThresholdTemperature
    );

  lockControlsCharacteristic = () =>
    this.service.getCharacteristic(
      this.platform.Characteristic.LockPhysicalControls
    );

  swingModeCharacteristic = () =>
    this.service.getCharacteristic(this.platform.Characteristic.SwingMode);

  heatingThresholdTemperatureCharacteristic = () =>
    this.service.getCharacteristic(
      this.platform.Characteristic.HeatingThresholdTemperature
    );
}
