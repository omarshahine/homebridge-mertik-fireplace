# Changelog

## [2.1.4] - 2026-06-21

### Fixed
- **HomeKit showed 80°F (the safety cap) instead of the real setpoint right after ignition, with repeated "Heating Threshold Temperature ... exceeded maximum of 26.5" warnings.** The fireplace lands in Manual mode for a few seconds after igniting, and `targetHeatingThresholdValue` mapped Manual-mode flame height onto the thermostat slider using a 5–36 range. Since the slider is capped at the 26.5°C / 80°F safety max, a high flame produced values like 33 that overflowed the cap — HomeKit rejected them with a warning and clamped the display to 80°F. The device's actual thermostat setpoint (e.g. 68°F) was correct the whole time; only the slider was wrong.
  - The heating/cooling threshold now always reports the device's real thermostat setpoint, clamped to the characteristic's advertised range, and no longer maps flame height onto the slider. No more illegal-value warnings, and the slider reflects the setpoint you actually chose.

## [2.1.3] - 2026-06-20

### Added
- **`auxFan` per-fireplace config option** (default `true`). Set to `false` for units without the optional auxiliary fan kit: the SwingMode (fan) control is no longer exposed in HomeKit and the plugin never sends aux commands. Previously the fan toggle was always present even on fireplaces with no fan connected, and could be left in a stale `aux:true` state. Exposed in the Homebridge UI config schema.

## [2.1.2] - 2026-06-20

### Fixed
- **Fireplace could ignite *after* you turned it off, and repeated taps spawned duplicate ignition loops.** Root cause: `this.igniting` did double duty as both the live device status bit (overwritten on every status packet) and the ignition-sequence control flag. Between retry attempts the device reports `igniting:0`, which clobbered the control flag — so an Off during the inter-attempt wait failed to abort the sequence, and the re-entrancy guard failed to block a second concurrent ignite loop. Observed in the field: two loops reporting success with the same attempt id, and a burner that lit ~90s after the user pressed Off.
  - Introduced a dedicated `igniteSequenceActive` flag that is **never** touched by status packets. It is now the single source of truth for "a sequence is running," driving both the re-entrancy guard and abort eligibility.
  - **An Off now reliably aborts an in-progress sequence** even during the inter-attempt wait, and is signaled synchronously (`abortIgnition()`) the instant it arrives — even while another request is in flight.
  - `waitForIgnitionOutcome()` now bails **mid-attempt** on abort instead of running the full ~90s ignition window first.
  - On abort, the controller sends GuardFlame Off to guarantee a partially-lit burner is shut off — **"off" means off.**
- **Retry storm eliminated.** `setMode()`'s "ignore, sequence already running" path now returns success instead of a failure that made `requestController` queue 90s retries. `requestController.sendRequest()` now refuses to run two requests concurrently (deferring the later one), which stops the duplicate ignite loops and the rogue aux toggling that fell out of the concurrency.

### Notes
- Soft-fail retries remain **in-memory only and do not resume after a Homebridge restart** — by design, so a gas burner never lights itself unattended on a reboot/crash. Lockout and attempt history still persist for diagnostics.

## [2.1.0] - 2026-05-17

### Added
- **Ignition lockout circuit breaker with auto-retry.** When `igniteFireplace()` runs, it now sends the Ignite command and observes the receiver's own ignition cycle to completion. Three outcome classes are distinguished:
  - **success**: `guardFlameOn` confirmed → exit, clear failure history.
  - **soft-fail**: `igniting` cleared back to 0 but no flame caught (cold pilot, air in line — common cold-start case) → retry after delay.
  - **hard-fail**: `igniting` bit stuck past timeout → Mertik GV60 safety lockout → stop the sequence, require manual reset (paperclip, cycle gas, or service).

  Default: 4 attempts, 90s timeout per attempt, 3 min between retries. Each attempt logs as `[ignite] Attempt N of M` with explicit outcomes — makes postmortem of "did the fireplace try and fail?" trivial. Off requests mid-sequence abort the loop cleanly.
- **Persistent ignition history** at `<storagePath>/valor-ignition-history.json` via new `IgnitionTracker` class. Records every attempt with timestamps, outcomes, durations, and final status bits. Survives plugin restarts and homebridge log rotations — the previous all-in-memory state lost every diagnostic the moment the log rotated.
- **Six newly-decoded status packet fields** on `FireplaceStatus`, in parity with `valor-fireplace-cli` 1.1.0:
  - `burnerOutput` (chars 14-15) — current burner output 0-255, continuous.
  - `lightBrightness` (chars 20-21) — decorative light dimmer setpoint 0-255 (persists across off).
  - `fanSpeed` (chars 22-23) — circulating fan speed 0-4.
  - `scheduleActive` (status bit 9) — schedule/timer overlay flag.
  - `lightOn` (status bit 13) — decorative light power.
  - `statusBitsHex` — raw 4-char hex of the status bit field.
- **Derived signals** on `FireplaceStatus`:
  - `lockoutSuspected` — heuristic candidate for hard lockout.
  - `pilotOnly` — `guardFlameOn && burnerOutput === 0`.
- **`isLockoutActive()` on `IFireplaceController`.** Public method exposing whether the controller is in a confirmed hard-lockout state, for future code wiring up a HomeKit `StatusFault` characteristic.
- **`'lockout'` event** emitted on the controller for fault-state subscribers. Fires `true` when a hard lockout is detected, `false` when it clears.

### Changed
- **Lockout state gates non-Off commands** but lets shutdowns through. When a hard lockout is in effect from a prior session, `request()` blocks ignite/mode/temp requests with a clear warning. An Off request is always allowed (does no harm, may help reconcile state).
- **`processStatusResponse`** no longer auto-shuts-off during the `lostConnection` recovery path while a hard lockout is active — the gas is already off and the receiver is in fault state, so a shutdown command would just generate log noise.

## [2.0.1] - 2026-01-11

### Fixed
- Temperature now displays in configured unit (F/C) in all log messages
- Setting temperature no longer briefly switches to Manual mode when already in Temperature mode
- Mode detection now correctly identifies Remote/Thermostat controlled modes via endByte

### Changed
- HeaterCooler now advertises Heat mode only (removed Cool and Auto options from Apple Home)
- Simplified operation mode mappings for heat-only device

## [2.0.0] - 2026-01-10

### Added
- Debug mode configuration option - logs all status updates when enabled
- Temperature unit configuration (Celsius/Fahrenheit) for log output
- Smart status logging - only logs on state changes (not every 15 seconds)
- HomeKit screenshot in README

### Changed
- Rebranded from homebridge-mertik-fireplace to homebridge-valor-fireplace
- Platform name changed to "ValorFireplace"
- Manufacturer set to "Valor"
- License changed to MIT
- Temperatures rounded to whole numbers when displayed in Fahrenheit

### Documentation
- Added comprehensive device compatibility info
- Documented GV60 WiFi Module requirement
- Added link to Valor10 Remote App compatible fireplaces
- Created CLAUDE.md with technical architecture details
- Documented status packet structure and mode detection logic
