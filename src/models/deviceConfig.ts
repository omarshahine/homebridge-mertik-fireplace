export interface IDeviceConfig {
    name: string;
    ip: string;
    /**
     * Whether this fireplace has the optional auxiliary fan kit. When false,
     * the SwingMode (fan) control is not exposed in HomeKit and the plugin
     * never sends aux commands — for units without a fan, the control is just
     * a phantom toggle. Defaults to true (exposed) for backward compatibility.
     */
    auxFan?: boolean;
}