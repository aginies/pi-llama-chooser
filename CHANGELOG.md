# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[unreleased]: https://github.com/aginies/pi-llama-chooser/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/aginies/pi-llama-chooser/releases/tag/v0.2.0
