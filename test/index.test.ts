import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LlamaServer, LlamaModel, ProviderModelConfig } from "../src/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Use a test-only storage path to avoid clobbering the real config at
// ~/.pi/agent/llama-chooser-servers.json.
process.env.LLAMA_CHOOSER_STORAGE = join(
	process.env.HOME ?? "/tmp",
	".pi",
	"agent",
	"llama-chooser-test-servers.json",
);

// Dynamic import to avoid ESM/CJS issues
let mod: typeof import("../src/index");

async function loadModule() {
	if (!mod) {
		mod = await import("../src/index");
	}
	return mod;
}

function testStoragePath(): string {
	return process.env.LLAMA_CHOOSER_STORAGE!;
}

function setupTestStorage(servers: any[]) {
	const dir = join(testStoragePath(), "..");
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(testStoragePath(), JSON.stringify(servers, null, 2), "utf-8");
}

function clearTestStorage() {
	if (existsSync(testStoragePath())) {
		rmSync(testStoragePath());
	}
}

function cleanupTestStorage() {
	try {
		clearTestStorage();
	} catch {
		// ignore
	}
}

// ---------------------------------------------------------------------------
// basename
// ---------------------------------------------------------------------------

describe("basename", () => {
	it("strips .gguf extension", async () => {
		const { basename } = await loadModule();
		expect(basename("model.gguf")).toBe("model");
	});

	it("strips .bin extension", async () => {
		const { basename } = await loadModule();
		expect(basename("model.bin")).toBe("model");
	});

	it("strips .pt extension", async () => {
		const { basename } = await loadModule();
		expect(basename("model.pt")).toBe("model");
	});

	it("strips .pth extension", async () => {
		const { basename } = await loadModule();
		expect(basename("model.pth")).toBe("model");
	});

	it("strips .safetensors extension", async () => {
		const { basename } = await loadModule();
		expect(basename("model.safetensors")).toBe("model");
	});

	it("strips path separators", async () => {
		const { basename } = await loadModule();
		expect(basename("path/to/model.gguf")).toBe("model");
		expect(basename("path\\to\\model.gguf")).toBe("model");
	});

	it("handles no extension", async () => {
		const { basename } = await loadModule();
		expect(basename("model")).toBe("model");
	});

	it("handles mixed case extensions", async () => {
		const { basename } = await loadModule();
		expect(basename("model.GGUF")).toBe("model");
		expect(basename("model.Bin")).toBe("model");
	});
});

// ---------------------------------------------------------------------------
// formatCtxSize
// ---------------------------------------------------------------------------

describe("formatCtxSize", () => {
	it("formats raw values", async () => {
		const { formatCtxSize } = await loadModule();
		expect(formatCtxSize(512)).toBe("512");
		expect(formatCtxSize(1024)).toBe("1024");
	});

	it("formats K values", async () => {
		const { formatCtxSize } = await loadModule();
		expect(formatCtxSize(32768)).toBe("33K");
		expect(formatCtxSize(10000)).toBe("10K");
		expect(formatCtxSize(100000)).toBe("100K");
	});

	it("formats M values", async () => {
		const { formatCtxSize } = await loadModule();
		expect(formatCtxSize(1000000)).toBe("1M");
		expect(formatCtxSize(5242880)).toBe("5M");
		expect(formatCtxSize(10485760)).toBe("10M");
	});
});

// ---------------------------------------------------------------------------
// formatFileSize
// ---------------------------------------------------------------------------

describe("formatFileSize", () => {
	it("formats bytes", async () => {
		const { formatFileSize } = await loadModule();
		expect(formatFileSize(0)).toBe("0 B");
		expect(formatFileSize(512)).toBe("512 B");
		expect(formatFileSize(1023)).toBe("1023 B");
	});

	it("formats KB", async () => {
		const { formatFileSize } = await loadModule();
		expect(formatFileSize(1024)).toBe("1 KB");
		expect(formatFileSize(10240)).toBe("10 KB");
		expect(formatFileSize(1048575)).toBe("1024 KB");
	});

	it("formats MB", async () => {
		const { formatFileSize } = await loadModule();
		expect(formatFileSize(1048576)).toBe("1 MB");
		expect(formatFileSize(10485760)).toBe("10 MB");
		expect(formatFileSize(1073741823)).toBe("1024 MB");
	});

	it("formats GB", async () => {
		const { formatFileSize } = await loadModule();
		expect(formatFileSize(1073741824)).toBe("1.0 GB");
		expect(formatFileSize(2147483648)).toBe("2.0 GB");
	});
});

// ---------------------------------------------------------------------------
// Storage functions
// ---------------------------------------------------------------------------

describe("storage", () => {
	beforeEach(async () => {
		cleanupTestStorage();
		setupTestStorage([]);
		// Clear in-memory caches so each test starts fresh
		const { resetCaches } = await loadModule();
		resetCaches();
	});

	afterEach(() => {
		cleanupTestStorage();
	});

	it("loads empty storage", async () => {
		const { loadServers } = await loadModule();
		expect(loadServers()).toEqual([]);
	});

	it("loads servers from storage", async () => {
		setupTestStorage([
			{ name: "server1", host: "192.168.1.1", port: 8080, protocol: "http", enabled: true },
		]);
		const { loadServers } = await loadModule();
		const servers = loadServers();
		expect(servers).toHaveLength(1);
		expect(servers[0].name).toBe("server1");
	});

	it("filters invalid entries", async () => {
		setupTestStorage([
			{ name: "valid", host: "192.168.1.1", port: 8080, protocol: "http", enabled: true },
			{ name: "invalid", host: "192.168.1.1", port: 8080, protocol: "ftp", enabled: true },
			"not-an-object",
			{ name: "no-host", port: 8080, protocol: "http", enabled: true },
		]);
		const { loadServers } = await loadModule();
		const servers = loadServers();
		expect(servers).toHaveLength(1);
		expect(servers[0].name).toBe("valid");
	});

	it("finds server by name", async () => {
		setupTestStorage([
			{ name: "server1", host: "192.168.1.1", port: 8080, protocol: "http", enabled: true },
		]);
		const { findServer } = await loadModule();
		const server = findServer("server1");
		expect(server).toBeDefined();
		expect(server?.name).toBe("server1");
	});

	it("returns undefined for unknown server", async () => {
		setupTestStorage([]);
		const { findServer } = await loadModule();
		expect(findServer("unknown")).toBeUndefined();
	});

	it("saves and loads servers", async () => {
		const { saveServers, loadServers } = await loadModule();
		const servers = [
			{ name: "server1", host: "192.168.1.1", port: 8080, protocol: "http", enabled: true },
		];
		saveServers(servers);
		const loaded = loadServers();
		expect(loaded).toEqual(servers);
	});

	it("mutates server", async () => {
		setupTestStorage([
			{ name: "server1", host: "192.168.1.1", port: 8080, protocol: "http", enabled: true },
		]);
		const { mutateServer, findServer } = await loadModule();
		const err = mutateServer("server1", (s: LlamaServer) => {
			s.port = 9000;
		});
		expect(err).toBeNull();
		expect(findServer("server1")?.port).toBe(9000);
	});

	it("returns error for unknown server mutation", async () => {
		setupTestStorage([]);
		const { mutateServer } = await loadModule();
		const err = mutateServer("unknown", () => {});
		expect(err).toBe('Server "unknown" not found.');
	});

	it("removes server", async () => {
		setupTestStorage([
			{ name: "server1", host: "192.168.1.1", port: 8080, protocol: "http", enabled: true },
		]);
		const { removeServer, loadServers } = await loadModule();
		expect(removeServer("server1")).toBe(true);
		expect(loadServers()).toHaveLength(0);
	});

	it("returns false for unknown server removal", async () => {
		setupTestStorage([]);
		const { removeServer } = await loadModule();
		expect(removeServer("unknown")).toBe(false);
	});

	it("persists contextOverride", async () => {
		setupTestStorage([
			{
				name: "server1",
				host: "192.168.1.1",
				port: 8080,
				protocol: "http",
				enabled: true,
				contextOverride: 8192,
			},
		]);
		const { findServer } = await loadModule();
		const server = findServer("server1");
		expect(server?.contextOverride).toBe(8192);
	});
});

// ---------------------------------------------------------------------------
// toModelConfig
// ---------------------------------------------------------------------------

describe("toModelConfig", () => {
	const server: LlamaServer = {
		name: "my-server",
		host: "192.168.1.1",
		port: 8080,
		protocol: "http",
		enabled: true,
	};

	const model: LlamaModel = {
		id: "Qwen3.6-35B-A3B-UD-Q6_K.gguf",
		meta: {
			n_ctx: 32768,
			ftype: "Q6_K",
		},
	};

	it("creates correct model config", async () => {
		const { toModelConfig } = await loadModule();
		const config = toModelConfig(server, model);
		expect(config.id).toBe("my-server / Qwen3.6-35B-A3B-UD-Q6_K (Q6_K)");
		expect(config.name).toBe("my-server / Qwen3.6-35B-A3B-UD-Q6_K (Q6_K)");
		expect(config.api).toBe("openai-completions");
		expect(config.baseUrl).toBe("http://192.168.1.1:8080/v1");
		expect(config.input).toEqual(["text"]);
		expect(config.reasoning).toBe(false);
	});

	it("uses contextOverride when set", async () => {
		const { toModelConfig } = await loadModule();
		const serverWithOverride: LlamaServer = { ...server, contextOverride: 8192 };
		const config = toModelConfig(serverWithOverride, model);
		expect(config.contextWindow).toBe(8192);
		expect(config.maxTokens).toBe(8192);
	});

	it("falls back to model n_ctx", async () => {
		const { toModelConfig } = await loadModule();
		const config = toModelConfig(server, model);
		expect(config.contextWindow).toBe(32768);
		expect(config.maxTokens).toBe(32768);
	});

	it("falls back to defaults when no context", async () => {
		const { toModelConfig } = await loadModule();
		const modelNoCtx: LlamaModel = { id: "model.gguf", meta: {} };
		const config = toModelConfig(server, modelNoCtx);
		expect(config.contextWindow).toBe(32768);
		expect(config.maxTokens).toBe(4096);
	});

	it("handles model without quantization", async () => {
		const { toModelConfig } = await loadModule();
		const modelNoQuant: LlamaModel = { id: "model.gguf", meta: { n_ctx: 32768 } };
		const config = toModelConfig(server, modelNoQuant);
		expect(config.id).toBe("my-server / model");
		expect(config.name).toBe("my-server / model");
	});

	it("sets cost to zero", async () => {
		const { toModelConfig } = await loadModule();
		const config = toModelConfig(server, model);
		expect(config.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("sets compat flags", async () => {
		const { toModelConfig } = await loadModule();
		const config = toModelConfig(server, model);
		expect(config.compat.supportsStore).toBe(false);
		expect(config.compat.supportsDeveloperRole).toBe(false);
		expect(config.compat.supportsReasoningEffort).toBe(false);
		expect(config.compat.supportsUsageInStreaming).toBe(true);
		expect(config.compat.supportsStrictMode).toBe(false);
		expect(config.compat.maxTokensField).toBe("max_tokens");
	});
});

// ---------------------------------------------------------------------------
// dedupConfigs
// ---------------------------------------------------------------------------

describe("dedupConfigs", () => {
	function makeConfig(overrides: Partial<ProviderModelConfig> = {}): ProviderModelConfig {
		return {
			id: "server1 / model",
			name: "server1 / model",
			api: "openai-completions",
			baseUrl: "http://192.168.1.1:8080/v1",
			input: ["text"],
			reasoning: false,
			contextWindow: 32768,
			maxTokens: 4096,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				supportsUsageInStreaming: true,
				supportsStrictMode: false,
				maxTokensField: "max_tokens",
			},
			...overrides,
		};
	}

	it("returns single config unchanged", async () => {
		const { dedupConfigs } = await loadModule();
		const configs = [makeConfig()];
		const result = dedupConfigs(configs);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("server1 / model");
	});

	it("merges configs with same basename", async () => {
		const { dedupConfigs } = await loadModule();
		const configs = [
			makeConfig({ id: "server1 / model", name: "server1 / model", baseUrl: "http://192.168.1.1:8080/v1" }),
			makeConfig({ id: "server2 / model", name: "server2 / model", baseUrl: "http://192.168.1.2:8080/v1" }),
		];
		const result = dedupConfigs(configs);
		expect(result).toHaveLength(1);
		expect(result[0].id).toContain("@");
		expect(result[0].id).toContain("|");
		expect(result[0].name).toContain("(");
		expect(result[0].name).toContain(")");
	});

	it("keeps different models separate", async () => {
		const { dedupConfigs } = await loadModule();
		const configs = [
			makeConfig({ id: "server1 / model1", name: "server1 / model1" }),
			makeConfig({ id: "server1 / model2", name: "server1 / model2" }),
		];
		const result = dedupConfigs(configs);
		expect(result).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// serverForModelId
// ---------------------------------------------------------------------------

describe("serverForModelId", () => {
	beforeEach(async () => {
		cleanupTestStorage();
		setupTestStorage([
			{ name: "server1", host: "192.168.1.1", port: 8080, protocol: "http", enabled: true },
			{ name: "server2", host: "192.168.1.2", port: 8080, protocol: "http", enabled: true },
		]);
		// Clear in-memory caches so each test starts fresh
		const { resetCaches } = await loadModule();
		resetCaches();
	});

	afterEach(() => {
		cleanupTestStorage();
	});

	it("parses legacy format", async () => {
		const { serverForModelId } = await loadModule();
		const server = serverForModelId("server1 / model.gguf");
		expect(server?.name).toBe("server1");
	});

	it("parses legacy format with spaces", async () => {
		const { serverForModelId } = await loadModule();
		const server = serverForModelId("  server1  /  model.gguf");
		expect(server?.name).toBe("server1");
	});

	it("returns undefined for unknown server", async () => {
		const { serverForModelId } = await loadModule();
		const server = serverForModelId("unknown / model.gguf");
		expect(server).toBeUndefined();
	});

	it("parses deduplicated format", async () => {
		const { serverForModelId } = await loadModule();
		const server = serverForModelId("model@server1|server2");
		expect(server).toBeDefined();
		expect(["server1", "server2"].includes(server?.name ?? "")).toBe(true);
	});

	it("returns undefined for unrecognised format", async () => {
		const { serverForModelId } = await loadModule();
		expect(serverForModelId("completely-bogus")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// getServerUrl / getInferenceUrl
// ---------------------------------------------------------------------------

describe("URL helpers", () => {
	it("formats server URL", async () => {
		const { getServerUrl } = await loadModule();
		expect(getServerUrl({ host: "192.168.1.1", port: 8080, protocol: "http" as any })).toBe(
			"http://192.168.1.1:8080",
		);
		expect(getServerUrl({ host: "example.com", port: 443, protocol: "https" as any })).toBe(
			"https://example.com:443",
		);
	});

	it("formats inference URL", async () => {
		const { getInferenceUrl } = await loadModule();
		expect(getInferenceUrl({ host: "192.168.1.1", port: 8080, protocol: "http" as any })).toBe(
			"http://192.168.1.1:8080/v1",
		);
	});
});
