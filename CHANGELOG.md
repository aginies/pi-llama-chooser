# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] — 2026-10-15

### Changed

- **Server selection in `/model`** — models served by several servers are no longer collapsed into one unselectable row. Each enabled server now contributes its own entry (`<server> / <Model> (<quant>)`), so the machine that answers is picked explicitly. This is the new default; the previous merged behaviour is kept behind the `dedup` switch.

### Added

- **`/llama-chooser config dedup <on|off|status>`** — switches the `/model` catalog between one row per server (off, default) and one merged row per identical model that routes to the first online server (on). The choice is persisted in `~/.pi/agent/llama-chooser-servers-settings.json` and applies immediately, no `/reload` needed.
- **"Model rows in /model" menu entry** — the same switch in the interactive `/llama-chooser config` menu.
- **Settings persistence** — new `src/settings.ts`: atomic, cached, tolerant reads/writes of the preferences sidecar (bad or missing JSON falls back to defaults rather than hiding the catalog).

### Compatibility

- Ids kept from a previous merged catalog (`<Model>@<server1>|<server2>`) still resolve and stream after switching modes; so do legacy `<server> / <Model>` ids after switching back.
- The server file keeps its plain-array shape; settings live in a sibling file, so hand-edited configs are unaffected.

[0.6.0]: https://github.com/aginies/pi-llama-chooser/releases/tag/v0.6.0

## [0.5.2] — 2026-10-13

### Fixed

- **Deduplicated model ID and name corruption** — fixed loop variable destructuring in `dedupConfigs` that previously injected the literal JavaScript source code of `function basename(...)` into deduplicated model IDs and names.
- **Quantization regex coverage** — `extractQuant` now recognizes standard GGUF quantizations containing numbers after an underscore (`Q8_0`, `Q4_0`, `Q4_1`, `Q5_0`, `Q5_1`) and `BF16`.
- **Speed tracker reactivation on session start** — restored `registered = true` in `pi.on("session_start")` so the speed tracker stays operational across session reloads and switches after `session_shutdown`.
- **Speed tracker prefill state reset** — `resetInternal()` and `onRequest()` now clear `lastPrefillTps`, ensuring that new requests display the pending prefill status (`⚡…`) instead of stale metrics from previous turns.
- **Protocol defaulting in CLI `config add` and `config edit`** — `config add` now defaults protocol to `"http"` when omitted, fulfilling the documented 3-argument syntax (`/llama-chooser config add <name> <host> <port>`). `config edit` preserves the existing configured protocol when omitted.
- **Context override fallback for 0** — `toModelConfig` properly handles `contextOverride: 0` by falling back to the model's native context window instead of evaluating to a 0-token window.
- **Cache invalidation on server edit** — both old server address and new endpoint caches are invalidated when updating a server's configuration.
- **API key removal in server edit wizard** — `promptEditApiKey` now allows users to clear an existing API key by typing `-` or `none`.
- **Server name delimiter validation** — `validateName` rejects `@`, `|`, and `/` characters to protect model ID formats and routing lookups.
- **Robust model list handling** — `fetchModels` defensively filters out invalid or malformed upstream model objects missing string IDs.

### Added

- **Command argument auto-completion** — `/llama-chooser` command now autocompletes config subcommands (`add`, `edit`, `remove`, `enable`, `disable`, `refresh`, `set-ctx`, `clear-ctx`) and configured server names.

[0.5.2]: https://github.com/aginies/pi-llama-chooser/releases/tag/v0.5.2

## [0.5.1] — 2026-10-12

### Fixed

- **Config changes take effect immediately** — disabling, enabling, editing or
  removing a server now republishes the model catalog to Pi right away
  (`pi.registerProvider` with the rebuilt model list) instead of waiting for a
  restart. Previously the published catalog was only rebuilt on a live
  `refreshModels` call, so `/model` kept showing models of disabled or removed
  servers until pi was restarted.
- **Server enable/disable toggle persistence** — fixed a double-inversion bug
  in the interactive server detail menu where in-place mutation caused the
  toggled enablement state to revert immediately.
- **Server menu startup latency** — `showServerMenu` and `pingServer` skip
  network requests for disabled servers, eliminating the 3-second timeout freeze
  when opening `/llama-chooser config` or returning from server details when an
  offline server is disabled.
- **Disabled server display indicator** — `serverLabel` now displays a distinct
  `⚪ ✗` badge for disabled servers instead of a misleading green indicator.
- **External config file reloading** — `loadServers` tracks file modification
  time and size, reloading servers automatically when the config file is edited
  outside of the interactive menu.
- **Offline refreshes no longer return stale models** — `refreshModels` with
  `allowNetwork: false` rebuilds the catalog from the current server config
  (regenerating ids, base URLs and context-window overrides) instead of
  returning the cached list verbatim.
- **Live refresh fallback is pruned** — when a live fetch comes back empty,
  the retained "last known-good" catalog is now pruned to the servers that are
  still enabled, so an unreachable server no longer keeps a disabled one alive
  in `/model`.
- **Routing ignores disabled servers** — `serverForModelId` only considers
  enabled servers, so a stale deduplicated id (`model@alpha|beta`) can never
  route a request to a server that was just disabled.

### Added

- **Warning when the selected model disappears** — if the model in use belongs
  to a server that was disabled or removed, the extension notifies you to pick
  another one with `/model`.
- Cached model data for servers that are no longer enabled is dropped, and
  edited servers invalidate their model/ping cache so the new endpoint is
  re-fetched.

[0.5.1]: https://github.com/aginies/pi-llama-chooser/releases/tag/v0.5.1

## [0.5.0] — 2026-10-03

### Changed
- **Declare `@earendil-works/pi-ai` as peer dependency** — the extension
  runtime-imports `streamSimple` from `@earendil-works/pi-ai/compat`; the
  dependency is now declared explicitly instead of relying on npm hoisting
  from `@earendil-works/pi-coding-agent`.
- **Remove unused `@earendil-works/pi-tui` peer dependency** — the extension
  never imports the TUI package; it was declared in error.

[0.5.0]: https://github.com/aginies/pi-llama-chooser/releases/tag/v0.5.0

## [0.4.0] — 2026-10-02

### Changed

- Re-release of the 0.3.4 changes (version bump only, no code changes).

## [0.3.4] — 2026-10-02

### Changed

- **Parallel model fetching** — `collectModelConfigs` now fetches from all
  enabled servers simultaneously via `Promise.allSettled` instead of
  sequentially. Model refresh latency drops from N×latency to ~1×latency.
- **Pre-compiled quantization regex** — `extractQuant` now uses a module-level
  `const QUANT_RE` instead of compiling the regex on every call.
- **Filter disabled servers in `config list`** — only pings enabled servers
  instead of all configured servers, avoiding unnecessary HTTP requests.
- **Force-refresh in server detail** — the "Refresh models" button in the
  server detail menu now bypasses the 60s model cache, returning fresh data
  as the user expects.
- **Single split in `dedupConfigs`** — replaced two `split("/")` calls per
  config (basename + server name) with a single `lastIndexOf` + `slice`,
  storing both values in the Map entry to avoid recomputation.

## [0.3.3] — 2025-10-02

### Added

- **Context window override** — set a custom context window per server via
  `set-ctx` / `clear-ctx` CLI commands or the `contextOverride` config field.

### Fixed

- **Model display names** — changed separator from ` :: ` to ` / ` to match
  the name field; quantization level now included in model id so it displays
  correctly; stripped `.gguf`/`.bin`/`.pt`/`.pth`/`.safetensors` extensions.

## [0.3.2] — 2025-10-02

### Changed

- **README** — clarified model display locations, added deduplication note,
  fixed speed tracker example and color gradient, added language tags to all
  code blocks (MD040).

## [0.3.1] — 2025-07-17

### Fixed

- **401 Unauthorized on legacy model IDs** — `serverForModelId` no longer
  falls back to the old `server :: model` format after the dedup refactor.
  Restored backward compatibility so non-deduplicated models route correctly.

## [0.2.0] — 2025-07-17

### Added

- **Model deduplication across servers** — identical models (same basename) on
  multiple servers are merged into a single entry. The model id uses the format
  `<basename>@<server1>|<server2>` and routing tries each server in order until
  one is online.

### Fixed

- **`serverForModelId` parsing fragility** — changed model ID separator from
  ` ( ` to ` :: ` so server names containing ` ( ` are handled correctly.
- **JSON parsing validation** — `loadServers()` now filters out malformed
  entries with a type guard requiring `name`, `host`, `port`, and valid
  `protocol`. Invalid entries are silently dropped.
- **Protocol validation** — `validateProtocol()` no longer defaults to
  `"http"` when given `undefined`. Missing protocol is now a hard error.
- **Wizard error handling** — each wizard step (name, host, port, protocol,
  api key) has its own loop. Validation errors only re-prompt the current
  field instead of restarting the entire wizard.
- **IP validation** — inputs containing only digits, dots, and colons are
  now treated as IPs and validated strictly. Malformed IPs like `192.168.1`
  or `256.1.1.1` are rejected instead of falling through to hostname
  validation.
- **Validation final gate** — both add and edit wizards now call
  `validateServerArgs()` before persisting, catching edge cases individual
  validators might miss.

### Documentation

- Added `pi install npm:pi-llama-chooser` installation method to README.
- Added README with usage, commands, configuration, and development sections.

### Cleanup

- Removed stale `test/refresh.test.ts` simulation file.
- Removed stale `"test"` script from `package.json`.

[0.2.0]: https://github.com/aginies/pi-llama-chooser/releases/tag/v0.2.0
