# homebridge-valor-fireplace

Homebridge plugin for Valor fireplaces with WiFi controllers (B6R-WME). Exposes fireplaces as HomeKit HeaterCooler accessories.

## Commands

```bash
npm run build          # Compile TypeScript → dist/
npm run lint           # ESLint with zero warnings allowed
npm run watch          # Build + link + nodemon for development
```

`prepublishOnly` runs lint + build automatically before `npm publish`.

## Architecture

```
src/
├── index.ts                          # Plugin registration entry point
├── settings.ts                       # Platform name + plugin name constants
├── platform.ts                       # ValorPlatform - discovers/registers accessories from config
├── platformAccessory.ts              # Bridges fireplace ↔ HomeKit characteristics
├── controllers/
│   ├── fireplaceController.ts        # TCP communication with fireplace hardware
│   ├── requestController.ts          # Request queuing, merging, retry logic
│   └── serviceController.ts          # HomeKit service/characteristic setup
└── models/
    ├── fireplaceStatus.ts            # Parses 106-char status packets
    ├── operationMode.ts              # Off, Manual, Temperature, Eco modes
    ├── flameHeight.ts                # 11 discrete flame height steps
    ├── temperatureRange.ts           # Temperature ↔ bit encoding
    ├── auxMode.ts                    # Aux fan (mapped to SwingMode)
    ├── deviceConfig.ts               # Per-fireplace config (name + IP)
    └── request.ts                    # Request interface (mode, temp, aux)
```

## Key Design Details

- **Protocol**: Raw TCP on port 2000, hex-encoded command packets with prefix `0233303330333033303830`
- **Polling**: Status polled every 15s; device marked unreachable after 5min without response
- **Status packets**: 106-character strings parsed by `FireplaceStatus`
- **Request merging**: Multiple rapid changes are merged into one request (10s debounce). Failed requests retry up to 10 times.
- **Ignition**: 40s async delay after ignite command; 30s for shutdown
- **Temperature**: Always Celsius internally (0-36°C range). In Manual mode, flame height percentage is mapped to the 5-36 range for the slider.
- **HomeKit mapping**: HeaterCooler service (heat only), ContactSensor for reachability, SwingMode for aux fan, LockPhysicalControls for parental lock (60s activation delay)
- **No test suite** - no unit or integration tests exist

## Configuration

Platform name: `ValorFireplace`. Each fireplace needs a **static IP address**.

```json
{
  "platform": "ValorFireplace",
  "fireplaces": [
    { "name": "Living Room", "ip": "192.168.1.100" }
  ],
  "debug": false,
  "temperatureUnit": "C"
}
```

## Code Style

- TypeScript with `strict: true`, `noImplicitAny: false`
- Single quotes, 2-space indent, 140 char max line length
- ESLint config in `.eslintrc`

## Claude Code GitHub Actions

This repo uses Claude Code GitHub Actions for PR automation:

- **`claude-code-review.yml`** - Auto-reviews PRs when marked "Ready for review" (draft → ready triggers review)
- **`claude.yml`** - Responds to `@claude` mentions in PR/issue comments for manual reviews

**Workflow:** Open PRs as draft → push commits → mark "Ready for review" to trigger auto-review. Use `@claude` in comments for follow-up reviews.

## Clawpatch Code Review

This repo uses [Clawpatch](https://clawpatch.ai) for local automated code review. Keep `.clawpatch/` ignored; it is generated runtime state containing features, findings, reports, runs, and patch attempts.

Standard workflow:

```bash
clawpatch doctor
clawpatch init          # first time only
clawpatch map
clawpatch review --limit 10
clawpatch report --output .clawpatch/reports/summary.md
clawpatch show --finding <id>
clawpatch fix --finding <id>
clawpatch revalidate --finding <id>
```

If this repo needs hand-authored feature coverage, keep those curated definitions in `tools/clawpatch/features/` and sync/copy them into `.clawpatch/features/` before review. Do not commit `.clawpatch/` generated state.


<!-- BEGIN CLAUDE MEMORY IMPORT: -Users-omarshahine-GitHub-homebridge-valor-fireplace -->
## Imported Claude Project Memory

Durable memory promoted from `~/.claude/projects/-Users-omarshahine-GitHub-homebridge-valor-fireplace/memory` during the AGENTS.md migration. Keep this section current when project-specific operating knowledge changes.

### memory/MEMORY.md

# Homebridge Valor Fireplace - Project Memory

## npm Publishing
- **CI auto-publishes on tag push**: `.github/workflows/publish-npm.yml` triggers on `v*` tags via NPM trusted publishing (OIDC). Just `git push origin main --tags` — no local `npm publish` needed.
- `npm version patch` auto-creates commit + tag — amend the commit if you need to include additional changes before publishing
- For local `npm publish` (rarely needed now): npm account uses **passkey auth**, must run in interactive terminal — not from Claude Code's sandbox
- Always check `npm notice Tarball Contents` to verify no dev files leak into the package
- Create GitHub release with `gh release create v<version>` for visibility

## .npmignore
- Must exclude `.claude/`, `.cursor/`, and `CLAUDE.md` (case-sensitive)
- Fixed in v2.0.3 — was previously leaking `.claude/settings.local.json` and `.cursor/BUGBOT.md`

## Version History
- v2.0.4: Retry delay 10s→90s (RETRY_DELAY_MS), split from 10s debounce (DEBOUNCE_MS). Old 10s retry fired before 40s ignite + 15s status poll could settle, causing spurious retry storms.
- v2.0.3: Fixed phantom status logs, added retry limit (MAX_RETRIES=10), cleaned .npmignore
- v2.0.2: Initial certified version

<!-- END CLAUDE MEMORY IMPORT: -Users-omarshahine-GitHub-homebridge-valor-fireplace -->
