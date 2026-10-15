// =============================================================================
// settings.ts — persisted preferences for llama-chooser
//
// Small JSON sidecar next to the server file (same directory, `-settings.json`
// suffix) so the server list keeps its plain-array shape. Reads are cached on
// file mtime/size, tolerant of unknown/missing keys, and never throw: a broken
// settings file falls back to the defaults instead of hiding every model.
// =============================================================================

import fs from "node:fs";
import path from "node:path";

export interface LlamaChooserSettings {
	/**
	 * Merge models that share a basename across several servers into a single
	 * `/model` entry that routes to the first online server.
	 *
	 * When false (the default), every server contributes its own entry, so the
	 * serving machine can be picked explicitly in `/model`.
	 */
	dedupModels: boolean;
}

export const DEFAULT_SETTINGS: LlamaChooserSettings = { dedupModels: false };

/** Derive the settings path from the server storage path. */
export function settingsPathFor(storagePath: string): string {
	return `${storagePath.replace(/\.json$/i, "")}-settings.json`;
}

/** Parse settings text. Unknown shapes and bad JSON yield the defaults. */
export function parseSettings(text: string): LlamaChooserSettings {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ...DEFAULT_SETTINGS };
	}
	const raw = (parsed as Record<string, unknown>)["dedupModels"];
	return {
		dedupModels: typeof raw === "boolean" ? raw : DEFAULT_SETTINGS.dedupModels,
	};
}

interface SettingsCacheEntry {
	path: string;
	mtimeMs: number;
	size: number;
	settings: LlamaChooserSettings;
}

let cache: SettingsCacheEntry | null = null;

/** Read settings from disk, reusing the in-memory copy while the file is unchanged. */
export function readSettings(settingsPath: string): LlamaChooserSettings {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(settingsPath);
	} catch {
		cache = null;
		return { ...DEFAULT_SETTINGS };
	}
	if (cache && cache.path === settingsPath && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
		return cache.settings;
	}
	let settings = { ...DEFAULT_SETTINGS };
	try {
		settings = parseSettings(fs.readFileSync(settingsPath, "utf-8"));
	} catch {
		// Unreadable file: keep the defaults, don't cache so a fix is picked up.
		return { ...DEFAULT_SETTINGS };
	}
	cache = { path: settingsPath, mtimeMs: stat.mtimeMs, size: stat.size, settings };
	return settings;
}

/** Persist settings atomically and refresh the in-memory copy. */
export function writeSettings(settingsPath: string, settings: LlamaChooserSettings): void {
	const dir = path.dirname(settingsPath);
	fs.mkdirSync(dir, { recursive: true });
	const tmpPath = `${settingsPath}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), { encoding: "utf-8", mode: 0o600 });
	fs.renameSync(tmpPath, settingsPath);
	cache = null; // force a re-read on next access
}

/** Forget the cached settings (used by tests). */
export function resetSettingsCache(): void {
	cache = null;
}
