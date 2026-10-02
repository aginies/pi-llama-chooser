/**
 * Llama Chooser Extension
 *
 * Manages remote llama.cpp servers and exposes their models as selectable Pi
 * models under the "llama-chooser" provider. Includes a TPS (tokens/second)
 * speed tracker in the footer.
 *
 * Servers are persisted in ~/.pi/llama-chooser-servers.json.
 *
 * Streaming is delegated to Pi's built-in OpenAI Chat Completions adapter
 * (llama.cpp is OpenAI-compatible), so message conversion, tool handling,
 * usage accounting, and cancellation all use Pi's standard behavior. Each
 * model is routed to its server via a per-model baseUrl.
 *
 * Commands:
 *   /llama-chooser config             - Open the interactive server menu
 *   /llama-chooser config <subcmd>    - CLI config subcommands (for scripting)
 *   /llama-chooser list [server]      - List models from a server (or all enabled)
 *
 * Models from enabled servers appear under the "llama-chooser" provider in
 * /model. Each model id is "<server> (<model-basename>)" so ids stay unique
 * across servers; the per-model baseUrl is what actually routes the request.
 * The footer shows the compact id, e.g. "llm-managerR9 (Qwen3.8.gguf)".
 *
 * TPS display (footer):
 *   Shows prefill and generation speed while streaming, e.g.
 *   "⚡ 450t/s 🔥 85.3t/s". Updates ~every 100ms during a stream.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
	ProviderModelConfig,
	SessionStartEvent,
	SessionShutdownEvent,
	MessageUpdateEvent,
	MessageEndEvent,
	TurnEndEvent,
	ModelSelectEvent,
} from "@earendil-works/pi-coding-agent";
import { streamSimple as compatStreamSimple } from "@earendil-works/pi-ai/compat";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	validateName,
	validateHost,
	validatePort,
	validateServerArgs,
	type ServerEndpoint,
} from "./helper.ts";
import { createSpeedTracker, type SpeedDeps } from "./speed.ts";

// =============================================================================
// Types
// =============================================================================

interface LlamaServer {
	name: string;
	host: string;
	port: number;
	protocol: "http" | "https";
	enabled: boolean;
	/** Optional API key sent as `Authorization: Bearer <key>` for this server. */
	apiKey?: string;
}

interface LlamaModel {
	id: string;
	name?: string;
	object?: string;
	owned_by?: string;
	meta?: {
		n_ctx?: number;
		n_ctx_train?: number;
		/** llama.cpp: quantization level, e.g. "Q6_K", "Q4_K_M". */
		ftype?: string;
		/** File size in bytes (llama.cpp puts this inside meta). */
		size?: number;
		friendly_name?: string;
	};
}

// =============================================================================
// Constants
// =============================================================================

const PROVIDER_ID = "llama-chooser";
const STORAGE_PATH = path.join(os.homedir(), ".pi", "agent", "llama-chooser-servers.json");
const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 4_096;
const FETCH_TIMEOUT_MS = 10_000;
/** Cache TTL for model fetch results (60s). */
const MODEL_CACHE_TTL = 60_000;
/** Cache TTL for ping results (30s). */
const PING_CACHE_TTL = 30_000;

// =============================================================================
// Cached state
// =============================================================================

/** In-memory server cache. Re-read from disk only on first load or after write. */
let serversCache: LlamaServer[] | null = null;

/** Per-server model cache: key = "host:port". */
const modelCache = new Map<string, { models: LlamaModel[]; fetchedAt: number }>();

/** Per-server ping cache: key = "host:port". */
const pingCache = new Map<string, { online: boolean; fetchedAt: number }>();

// =============================================================================
// Storage
// =============================================================================

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function loadServers(): LlamaServer[] {
	if (serversCache !== null) return serversCache;
	try {
		if (fs.existsSync(STORAGE_PATH)) {
			const parsed = JSON.parse(fs.readFileSync(STORAGE_PATH, "utf-8"));
			if (Array.isArray(parsed)) {
				serversCache = parsed as LlamaServer[];
				return serversCache;
			}
		}
	} catch (error) {
		console.error(`llama-chooser: failed to load servers: ${errorMessage(error)}`);
	}
	serversCache = [];
	return serversCache;
}

function saveServers(servers: LlamaServer[]): void {
	try {
		const dir = path.dirname(STORAGE_PATH);
		fs.mkdirSync(dir, { recursive: true });
		const tmpPath = `${STORAGE_PATH}.tmp`;
		fs.writeFileSync(tmpPath, JSON.stringify(servers, null, 2), {
			encoding: "utf-8",
			mode: 0o600,
		});
		fs.renameSync(tmpPath, STORAGE_PATH);
		serversCache = servers; // update in-memory cache
	} catch (error) {
		console.error(`llama-chooser: failed to save servers: ${errorMessage(error)}`);
	}
}

function findServer(name: string): LlamaServer | undefined {
	return loadServers().find((s) => s.name === name);
}

function mutateServer(name: string, mutate: (server: LlamaServer) => void): string | null {
	const servers = loadServers();
	const index = servers.findIndex((s) => s.name === name);
	if (index === -1) return `Server "${name}" not found.`;
	mutate(servers[index]);
	saveServers(servers);
	return null;
}

function removeServer(name: string): boolean {
	const servers = loadServers();
	const index = servers.findIndex((s) => s.name === name);
	if (index === -1) return false;
	servers.splice(index, 1);
	saveServers(servers);
	return true;
}

// =============================================================================
// Server URLs + HTTP
// =============================================================================

function getServerUrl(server: ServerEndpoint): string {
	return `${server.protocol}://${server.host}:${server.port}`;
}

function getInferenceUrl(server: ServerEndpoint): string {
	return `${getServerUrl(server)}/v1`;
}

async function fetchJson<T>(
	url: string,
	signal?: AbortSignal,
	headers?: Record<string, string>,
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	if (signal) {
		if (signal.aborted) controller.abort();
		else signal.addEventListener("abort", () => controller.abort(), { once: true });
	}
	try {
		const res = await fetch(url, { signal: controller.signal, headers });
		if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
		return (await res.json()) as T;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Fetch models from a server, with caching (TTL: 60s).
 * Pass `force: true` to bypass the cache.
 */
async function fetchModels(
	server: LlamaServer,
	signal?: AbortSignal,
	force = false,
): Promise<LlamaModel[]> {
	const key = `${server.host}:${server.port}`;
	const cached = modelCache.get(key);
	if (!force && cached && Date.now() - cached.fetchedAt < MODEL_CACHE_TTL) {
		return cached.models;
	}
	const headers: Record<string, string> = {};
	if (server.apiKey) {
		headers["Authorization"] = `Bearer ${server.apiKey}`;
	}
	const data = await fetchJson<{ data?: LlamaModel[] }>(
		`${getInferenceUrl(server)}/models`,
		signal,
		headers,
	);
	const models = Array.isArray(data.data) ? data.data : [];
	modelCache.set(key, { models, fetchedAt: Date.now() });
	return models;
}

// =============================================================================
// Display helpers
// =============================================================================

function basename(s: string): string {
	return s.split(/[\\/]/).pop() ?? s;
}

/** Format context size for display: 32768 → "32K", 524288 → "512K". */
function formatCtxSize(ctx: number): string {
	if (ctx >= 1_000_000) return `${Math.round(ctx / 1_000_000)}M`;
	if (ctx >= 10_000) return `${Math.round(ctx / 1_000)}K`;
	return String(ctx);
}

/** Format file size for display: 4294967296 → "4.0 GB". */
function formatFileSize(bytes: number): string {
	if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
	if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
	if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(0)} KB`;
	return `${bytes} B`;
}

// =============================================================================
// Model configuration
// =============================================================================

function toModelConfig(server: LlamaServer, model: LlamaModel): ProviderModelConfig {
	const name = basename(model.id);
	const quant = model.meta?.ftype;
	const ctxSize = model.meta?.n_ctx;
	const displayName = quant ? `${name} (${quant})` : name;
	return {
		id: `${server.name} (${name})`,
		name: `${server.name} / ${displayName}`,
		api: "openai-completions",
		baseUrl: getInferenceUrl(server),
		input: ["text"],
		reasoning: false,
		contextWindow: ctxSize ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: ctxSize ?? DEFAULT_MAX_TOKENS,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: true,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
		},
	};
}

async function collectModelConfigs(signal?: AbortSignal): Promise<ProviderModelConfig[]> {
	const configs: ProviderModelConfig[] = [];
	for (const server of loadServers().filter((s) => s.enabled)) {
		if (signal?.aborted) break;
		try {
			for (const model of await fetchModels(server, signal)) {
				configs.push(toModelConfig(server, model));
			}
		} catch {
			// Skip unavailable servers; retried on next refresh.
		}
	}
	return configs;
}

// =============================================================================
// Provider registration
// =============================================================================

/**
 * Last known-good model list. Pi calls refreshModels() with allowNetwork: false
 * during local (offline) refreshes — e.g. on every register/unregister — and
 * replaces the live catalog with whatever we return. Returning [] there would
 * wipe the catalog, so we return the cached list instead.
 */
let cachedConfigs: ProviderModelConfig[] = [];

/**
 * Shared refreshModels callback. Live fetches (allowNetwork: true) update the
 * cache and return the fresh list; offline refreshes return the cache so the
 * catalog survives local refreshes without a network round-trip. A live fetch
 * that comes back empty (server down, no models) keeps the last known-good
 * list so a transient failure never wipes the catalog.
 */
async function refreshModels(context: {
	allowNetwork: boolean;
	signal: AbortSignal;
}): Promise<ProviderModelConfig[]> {
	if (!context.allowNetwork) return cachedConfigs;
	const fresh = await collectModelConfigs(context.signal);
	if (fresh.length > 0) {
		cachedConfigs = fresh;
		return fresh;
	}
	return cachedConfigs;
}

function serverForModelId(modelId: string): LlamaServer | undefined {
	const sep = modelId.indexOf(' (');
	if (sep <= 0) return undefined;
	return loadServers().find((s) => s.name === modelId.slice(0, sep));
}

/**
 * Ping a server to check if it's reachable, with caching (TTL: 30s).
 * Pass `force: true` to bypass the cache.
 */
async function pingServer(server: LlamaServer, force = false): Promise<boolean> {
	const key = `${server.host}:${server.port}`;
	const cached = pingCache.get(key);
	if (!force && cached && Date.now() - cached.fetchedAt < PING_CACHE_TTL) {
		return cached.online;
	}
	try {
		const headers: Record<string, string> = {};
		if (server.apiKey) {
			headers["Authorization"] = `Bearer ${server.apiKey}`;
		}
		const url = `${getInferenceUrl(server)}/models`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 3000);
		try {
			const res = await fetch(url, { signal: controller.signal, headers });
			const online = res.status === 200 || res.status === 401;
			pingCache.set(key, { online, fetchedAt: Date.now() });
			return online;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		pingCache.set(key, { online: false, fetchedAt: Date.now() });
		return false;
	}
}

function registerLlamaProvider(pi: ExtensionAPI): void {
	try {
		pi.unregisterProvider(PROVIDER_ID);
	} catch {
		// Not registered yet.
	}

	pi.registerProvider(PROVIDER_ID, {
		name: "Llama Chooser",
		api: "openai-completions",
		apiKey: "local",
		refreshModels,
		streamSimple: (model, context, options) => {
			const server = serverForModelId(model.id);
			const key = server?.apiKey?.trim();
			return compatStreamSimple(model, context, { ...options, apiKey: key || "local" });
		},
	});
}

// =============================================================================
// Speed tracker setup
// =============================================================================

let speedTracker: ReturnType<typeof createSpeedTracker> | undefined;
let registered = false;

function setupSpeedTracker(pi: ExtensionAPI): void {
		const deps: SpeedDeps = {
			isActive: () => registered,
			hasUI: (ctx): ctx is ExtensionContext =>
				!!ctx && ctx.hasUI && typeof ctx.ui?.setStatus === "function",
			isOurs: (ctx) => {
				if (!ctx?.model) return false;
				return ctx.model.provider === PROVIDER_ID;
			},
			enabled: () => true,
		};
	speedTracker = createSpeedTracker(deps);
	registered = true;

	// Subscribe to Pi events
	pi.on("message_start", (_e, ctx) => {
		speedTracker?.onRequest(ctx);
	});

	pi.on("message_update", (e: MessageUpdateEvent, ctx) => {
		speedTracker?.onToken(ctx, e.assistantMessageEvent);
	});

	pi.on("message_end", (e: MessageEndEvent, ctx) => {
		speedTracker?.onMessageEnd(ctx, e.message as { role?: string; usage?: { input?: number } });
	});

	pi.on("turn_end", (_e: TurnEndEvent, ctx) => {
		speedTracker?.onTurnEnd(ctx);
	});

	pi.on("model_select", (_e: ModelSelectEvent, ctx) => {
		speedTracker?.start(ctx);
	});

	pi.on("session_start", (_e: SessionStartEvent, ctx) => {
		speedTracker?.start(ctx);
	});

	pi.on("session_shutdown", (_e: SessionShutdownEvent, ctx) => {
		speedTracker?.stop(ctx);
	});
}

// =============================================================================
// Config subcommand handlers
// =============================================================================

interface Ui {
	notify: (message: string, type?: "info" | "warning" | "error") => void;
}

const SUBCOMMANDS_LIST = `
  list                                      List all servers
  add <name> <host> <port> [http|https] [apiKey]     Add a server
  edit <name> <host> <port> [http|https] [apiKey]    Edit a server
  remove <name>                             Remove a server
  enable <name>                             Enable a server
  disable <name>                            Disable a server
  refresh                                   Refresh the model list`;

const USAGE = `Llama Chooser

Usage:
  /llama-chooser config             Open the interactive server menu
  /llama-chooser list [server]      List models from a server (or all enabled)

Config subcommands:${SUBCOMMANDS_LIST}`;

const CONFIG_USAGE = `Llama Chooser — config

Run /llama-chooser config with no arguments to open the interactive menu.

CLI subcommands:${SUBCOMMANDS_LIST}`;

async function configList(ui: Ui): Promise<void> {
	const servers = loadServers();
	if (servers.length === 0) {
		ui.notify("No servers configured. Use /llama-chooser config add to add one.", "info");
		return;
	}
	const reachable = await Promise.all(servers.map((s) => pingServer(s)));
	const lines = servers.map((s, i) => {
		const bullet = reachable[i] ? "🟢" : "🔴";
		return `  ${bullet} ${s.enabled ? "✓" : "✗"} ${s.name}: ${getInferenceUrl(s)}`;
	});
	ui.notify(`Configured servers:\n${lines.join("\n")}`, "info");
}

function configAdd(rest: string[], ui: Ui): void {
	if (rest.length < 3) {
		ui.notify("Usage: /llama-chooser config add <name> <host> <port> [http|https] [apiKey]", "info");
		return;
	}
	const [name, host, port, protocol, apiKey] = rest;
	if (findServer(name)) {
		ui.notify(`Server "${name}" already exists. Use /llama-chooser config edit to modify it.`, "error");
		return;
	}
	const result = validateServerArgs(name, host, port, protocol, apiKey);
	if (result.error || !result.server) {
		ui.notify(result.error ?? "Invalid arguments.", "error");
		return;
	}
	const servers = loadServers();
	servers.push({ name, ...result.server, enabled: true });
	saveServers(servers);
	ui.notify(`Added server "${name}" at ${getInferenceUrl(result.server)}`, "info");
}

function configEdit(rest: string[], ui: Ui): void {
	if (rest.length < 3) {
		ui.notify("Usage: /llama-chooser config edit <name> <host> <port> [http|https] [apiKey]", "info");
		return;
	}
	const [name, host, port, protocol, apiKey] = rest;
	const result = validateServerArgs(name, host, port, protocol, apiKey);
	if (result.error || !result.server) {
		ui.notify(result.error ?? "Invalid arguments.", "error");
		return;
	}
	const server = result.server;
	const error = mutateServer(name, (s) => {
		s.host = server.host;
		s.port = server.port;
		s.protocol = server.protocol;
		s.apiKey = server.apiKey;
	});
	if (error) {
		ui.notify(error, "error");
		return;
	}
	ui.notify(`Updated server "${name}" to ${getInferenceUrl(server)}`, "info");
}

function configRemove(rest: string[], ui: Ui): void {
	if (rest.length < 1) {
		ui.notify("Usage: /llama-chooser config remove <name>", "info");
		return;
	}
	const name = rest[0];
	if (!removeServer(name)) {
		ui.notify(`Server "${name}" not found.`, "error");
		return;
	}
	ui.notify(`Removed server "${name}"`, "info");
}

function configToggleEnabled(rest: string[], ui: Ui, enabled: boolean): void {
	if (rest.length < 1) {
		ui.notify(`Usage: /llama-chooser config ${enabled ? "enable" : "disable"} <name>`, "info");
		return;
	}
	const error = mutateServer(rest[0], (s) => {
		s.enabled = enabled;
	});
	if (error) {
		ui.notify(error, "error");
		return;
	}
	ui.notify(`${enabled ? "Enabled" : "Disabled"} server "${rest[0]}"`, "info");
}

function configEnable(rest: string[], ui: Ui): void {
	configToggleEnabled(rest, ui, true);
}

function configDisable(rest: string[], ui: Ui): void {
	configToggleEnabled(rest, ui, false);
}

async function configRefresh(ui: Ui): Promise<void> {
	const enabled = loadServers().filter((s) => s.enabled);
	if (enabled.length === 0) {
		ui.notify("No enabled servers to refresh.", "info");
		return;
	}
	ui.notify(`Refreshing models from ${enabled.length} server(s)...`, "info");

	// Parallel fetch: ping + fetch all servers simultaneously
	const results = await Promise.all(
		enabled.map(async (server) => {
			try {
				const models = await fetchModels(server, undefined, true);
				const names = models.map((m) => m.name ?? m.id).join(", ");
				return `  🟢 ${server.name}: ${models.length} model(s) — ${names}`;
			} catch (error) {
				return `  🔴 ${server.name}: ${errorMessage(error)}`;
			}
		}),
	);
	ui.notify(`Model refresh complete:\n${results.join("\n")}\nModels are available in /model.`, "info");
}

// =============================================================================
// Interactive menu
// =============================================================================

const ADD_SERVER_OPTION = "+ Add a server";
const EDIT_OPTION = "Edit values";
const ENABLE_OPTION = "Enable";
const DISABLE_OPTION = "Disable";
const REFRESH_OPTION = "Refresh models";
const REMOVE_OPTION = "Remove server";
const BACK_OPTION = "< Back to server list";

function serverLabel(server: LlamaServer, online: boolean): string {
	const bullet = online ? "🟢" : "🔴";
	return `${bullet} ${server.enabled ? "✓" : "✗"} ${server.name}  (${server.host}:${server.port})`;
}

async function showServerMenu(ctx: ExtensionCommandContext): Promise<void> {
	for (;;) {
		const servers = loadServers();
		const labels = await Promise.all(
			servers.map(async (s) => {
				const online = await pingServer(s);
				return serverLabel(s, online);
			}),
		);
		const options = [ADD_SERVER_OPTION, ...labels];
		const labelToServer = new Map(labels.map((label, i) => [label, servers[i]]));
		const choice = await ctx.ui.select("Llama Chooser — servers", options);
		if (choice === undefined) return;
		if (choice === ADD_SERVER_OPTION) {
			await addServerWizard(ctx);
			continue;
		}
		const server = labelToServer.get(choice);
		if (server) await showServerDetail(ctx, server);
	}
}

async function addServerWizard(ctx: ExtensionCommandContext): Promise<void> {
	for (;;) {
		const nameRaw = await ctx.ui.input("Server name (e.g. aginies.guibland.com)");
		if (nameRaw === undefined) return;
		const name = nameRaw.trim();
		const nameError = validateName(name);
		if (nameError) {
			ctx.ui.notify(nameError, "error");
			continue;
		}
		if (findServer(name)) {
			ctx.ui.notify(`Server "${name}" already exists.`, "error");
			continue;
		}

		const hostRaw = await ctx.ui.input("Host — IP or hostname (e.g. 192.168.1.50)");
		if (hostRaw === undefined) return;
		const hostError = validateHost(hostRaw);
		if (hostError) {
			ctx.ui.notify(hostError, "error");
			continue;
		}
		const host = hostRaw.trim();

		const portRaw = await ctx.ui.input("Port (1-65535, e.g. 8080)");
		if (portRaw === undefined) return;
		const portResult = validatePort(portRaw);
		const port = portResult.port;
		if (portResult.error || port === undefined) {
			ctx.ui.notify(portResult.error ?? "Invalid port.", "error");
			continue;
		}

		const protocol = (await ctx.ui.select("Protocol", ["http", "https"])) as
			| "http"
			| "https"
			| undefined;
		if (protocol === undefined) return;

		const keyRaw = await ctx.ui.input("API key (optional — Enter to skip)");
		if (keyRaw === undefined) return;
		const apiKey = keyRaw.trim() || undefined;

		const servers = loadServers();
		servers.push({ name, host, port, protocol, apiKey, enabled: true });
		saveServers(servers);
		ctx.ui.notify(`Added server "${name}" at ${getInferenceUrl({ host, port, protocol })}`, "info");
		return;
	}
}

async function showServerDetail(ctx: ExtensionCommandContext, server: LlamaServer): Promise<void> {
	for (;;) {
		const info = [
			`Name:     ${server.name}`,
			`Host:     ${server.host}`,
			`Port:     ${server.port}`,
			`Protocol: ${server.protocol}`,
			`API key:  ${server.apiKey ? "set" : "none"}`,
			`URL:      ${getInferenceUrl(server)}`,
			`Status:   ${server.enabled ? "enabled" : "disabled"}`,
		].join("\n");
		const options = [
			EDIT_OPTION,
			server.enabled ? DISABLE_OPTION : ENABLE_OPTION,
			REFRESH_OPTION,
			REMOVE_OPTION,
			BACK_OPTION,
		];
		const choice = await ctx.ui.select(`Server: ${server.name}\n\n${info}`, options);
		if (choice === undefined || choice === BACK_OPTION) return;

		if (choice === EDIT_OPTION) {
			await editServerWizard(ctx, server);
			// editServerWizard mutates in place; re-read for consistency.
			const updated = findServer(server.name);
			if (!updated) return;
			server = updated;
			continue;
		}
		if (choice === (server.enabled ? DISABLE_OPTION : ENABLE_OPTION)) {
			mutateServer(server.name, (s) => {
				s.enabled = !s.enabled;
			});
			// mutateServer mutates in place; flip the local reference.
			server.enabled = !server.enabled;
			continue;
		}
		if (choice === REFRESH_OPTION) {
			await refreshOneServer(ctx, server);
			continue;
		}
		if (choice === REMOVE_OPTION) {
			const ok = await ctx.ui.confirm("Remove server", `Remove "${server.name}"?`);
			if (ok) {
				removeServer(server.name);
				ctx.ui.notify(`Removed server "${server.name}"`, "info");
				return;
			}
			continue;
		}
	}
}

async function editServerWizard(ctx: ExtensionCommandContext, server: LlamaServer): Promise<void> {
	for (;;) {
		const hostRaw = await ctx.ui.input(`Host — current: ${server.host} (Enter to keep)`);
		if (hostRaw === undefined) return;
		let host = server.host;
		if (hostRaw.trim() !== "") {
			const hostError = validateHost(hostRaw);
			if (hostError) {
				ctx.ui.notify(hostError, "error");
				continue;
			}
			host = hostRaw.trim();
		}

		const portRaw = await ctx.ui.input(`Port — current: ${server.port} (Enter to keep)`);
		if (portRaw === undefined) return;
		let port = server.port;
		if (portRaw.trim() !== "") {
			const portResult = validatePort(portRaw);
			const newPort = portResult.port;
			if (portResult.error || newPort === undefined) {
				ctx.ui.notify(portResult.error ?? "Invalid port.", "error");
				continue;
			}
			port = newPort;
		}

		const protocol = (await ctx.ui.select(`Protocol — current: ${server.protocol}`, [
			server.protocol,
			server.protocol === "http" ? "https" : "http",
		])) as "http" | "https" | undefined;
		if (protocol === undefined) return;

		const keyRaw = await ctx.ui.input(
			`API key — current: ${server.apiKey ? "set" : "none"} (Enter to keep)`,
		);
		if (keyRaw === undefined) return;
		const apiKey = keyRaw.trim() !== "" ? keyRaw.trim() : server.apiKey;

		const error = mutateServer(server.name, (s) => {
			s.host = host;
			s.port = port;
			s.protocol = protocol;
			s.apiKey = apiKey;
		});
		if (error) {
			ctx.ui.notify(error, "error");
			return;
		}
		ctx.ui.notify(`Updated server "${server.name}" to ${getInferenceUrl({ host, port, protocol })}`, "info");
		return;
	}
}

async function refreshOneServer(ctx: ExtensionCommandContext, server: LlamaServer): Promise<void> {
	try {
		const models = await fetchModels(server);
		ctx.ui.notify(`${server.name}: ${models.length} model(s) available.`, "info");
	} catch (error) {
		ctx.ui.notify(`Could not reach ${server.name}: ${errorMessage(error)}`, "error");
	}
}

// =============================================================================
// Command handlers
// =============================================================================

async function handleConfigCli(rest: string[], ui: Ui): Promise<void> {
	const subcommand = (rest[0] ?? "").toLowerCase();
	const args = rest.slice(1);
	switch (subcommand) {
		case "list":
			await configList(ui);
			return;
		case "add":
			configAdd(args, ui);
			return;
		case "edit":
			configEdit(args, ui);
			return;
		case "remove":
			configRemove(args, ui);
			return;
		case "enable":
			configEnable(args, ui);
			return;
		case "disable":
			configDisable(args, ui);
			return;
		case "refresh":
			await configRefresh(ui);
			return;
		default:
			ui.notify(CONFIG_USAGE, "info");
			return;
	}
}

async function handleList(rest: string[], ui: Ui): Promise<void> {
	const serverName = (rest[0] ?? "").trim();
	const enabled = loadServers().filter((s) => s.enabled);
	if (enabled.length === 0) {
		ui.notify("No enabled servers configured. Use /llama-chooser config to add one.", "info");
		return;
	}
	const targets = serverName ? enabled.filter((s) => s.name === serverName) : enabled;
	if (targets.length === 0) {
		ui.notify(`Server "${serverName}" not found or disabled.`, "error");
		return;
	}
	// Parallel fetch across all target servers
	const results = await Promise.all(
		targets.map(async (server) => {
			try {
				const models = await fetchModels(server);
				if (models.length === 0) {
					return `  ${server.name}: No models found.`;
				}
				const lines = models.map((m) => {
					const cols: string[] = [];
					const baseName = basename(m.id);
					const quant = m.meta?.ftype;
					const ctx = m.meta?.n_ctx;
					const size = m.meta?.size;

					cols.push(baseName);
					if (quant) cols.push(quant);
					if (ctx) cols.push(`${formatCtxSize(ctx)} ctx`);
					if (size) cols.push(formatFileSize(size));
					if (m.owned_by) cols.push(`[${m.owned_by}]`);
					return `    ${cols.join(" | ")}`;
				});
				return `Models on ${server.name} (${models.length}):\n${lines.join("\n")}`;
			} catch (error) {
				return `  ${server.name}: Failed to fetch models — ${errorMessage(error)}`;
			}
		}),
	);
	ui.notify(results.join("\n\n"), "info");
}

// =============================================================================
// Extension entry point
// =============================================================================

export default function (pi: ExtensionAPI) {
	// Register the provider.
	registerLlamaProvider(pi);

	// Re-register on reload.
	pi.on("session_start", (event: SessionStartEvent) => {
		if (event.reason === "reload") registerLlamaProvider(pi);
	});

	// Setup speed tracker.
	setupSpeedTracker(pi);

	// ---------------------------------------------------------- /llama-chooser
	pi.registerCommand("llama-chooser", {
		description: "Manage remote llama.cpp servers and their models (config, list)",
		getArgumentCompletions: (prefix) => {
			const subcommands = ["config", "list"];
			const filtered = subcommands.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const subcommand = (parts[0] ?? "").toLowerCase();
			const rest = parts.slice(1);
			const ui = ctx.ui;

			switch (subcommand) {
				case "config":
					if (rest.length === 0) {
						await showServerMenu(ctx);
						return;
					}
					await handleConfigCli(rest, ui);
					return;
				case "list":
					await handleList(rest, ui);
					return;
				default:
					ui.notify(USAGE, "info");
					return;
			}
		},
	});
}
