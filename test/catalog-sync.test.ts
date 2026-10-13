import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { LlamaServer } from "../src/index";

// Use a test-only storage path so the real config is never touched.
process.env.LLAMA_CHOOSER_STORAGE = join(
	process.env.HOME ?? "/tmp",
	".pi",
	"agent",
	"llama-chooser-catalog-test-servers.json",
);

let mod: typeof import("../src/index");

async function loadModule() {
	if (!mod) mod = await import("../src/index");
	return mod;
}

function storagePath(): string {
	return process.env.LLAMA_CHOOSER_STORAGE!;
}

function setupStorage(servers: unknown[]) {
	const dir = join(storagePath(), "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(storagePath(), JSON.stringify(servers, null, 2), "utf-8");
}

function cleanupStorage() {
	if (existsSync(storagePath())) rmSync(storagePath());
}

// ---------------------------------------------------------------------------
// pruneConfigs / modelKeyFromId / serverNamesForConfigId
// ---------------------------------------------------------------------------

function cfg(id: string, name: string, baseUrl: string): ProviderModelConfig {
	return {
		id,
		name,
		api: "openai-completions",
		baseUrl,
		input: ["text"],
		reasoning: false,
		contextWindow: 4096,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	} as ProviderModelConfig;
}

const serverA: LlamaServer = {
	name: "alpha",
	host: "127.0.0.1",
	port: 1,
	protocol: "http",
	enabled: true,
};
const serverB: LlamaServer = { ...serverA, name: "beta", port: 2 };

describe("serverNamesForConfigId", () => {
	it("parses the legacy id format", async () => {
		const { serverNamesForConfigId } = await loadModule();
		expect(serverNamesForConfigId("alpha / Qwen (Q6_K)")).toEqual(["alpha"]);
	});

	it("parses the deduplicated id format", async () => {
		const { serverNamesForConfigId } = await loadModule();
		expect(serverNamesForConfigId("Qwen (Q6_K)@alpha|beta")).toEqual(["alpha", "beta"]);
	});

	it("returns [] for an unrecognised id", async () => {
		const { serverNamesForConfigId } = await loadModule();
		expect(serverNamesForConfigId("bogus")).toEqual([]);
	});
});

describe("modelKeyFromId", () => {
	it("reduces both id formats to the model basename", async () => {
		const { modelKeyFromId } = await loadModule();
		expect(modelKeyFromId("alpha / Qwen (Q6_K)")).toBe("Qwen (Q6_K)");
		expect(modelKeyFromId("Qwen (Q6_K)@alpha|beta")).toBe("Qwen (Q6_K)");
		expect(modelKeyFromId("Qwen (Q6_K)@alpha")).toBe("Qwen (Q6_K)");
	});
});

describe("pruneConfigs", () => {
	it("drops entries whose only server is disabled", async () => {
		const { pruneConfigs } = await loadModule();
		const configs = [
			cfg("alpha / Qwen (Q6_K)", "alpha / Qwen (Q6_K)", "http://127.0.0.1:1/v1"),
			cfg("beta / Llama (Q4_K_M)", "beta / Llama (Q4_K_M)", "http://127.0.0.1:2/v1"),
		];
		const pruned = pruneConfigs(configs, [serverB]);
		expect(pruned.map((c) => c.id)).toEqual(["beta / Llama (Q4_K_M)"]);
	});

	it("drops deduplicated entries when every server is gone", async () => {
		const { pruneConfigs } = await loadModule();
		const configs = [cfg("Qwen (Q6_K)@alpha|beta", "Qwen (Q6_K) (alpha, beta)", "http://127.0.0.1:1/v1")];
		expect(pruneConfigs(configs, [])).toEqual([]);
	});

	it("repoints a surviving deduplicated entry at an enabled server", async () => {
		const { pruneConfigs } = await loadModule();
		const configs = [cfg("Qwen (Q6_K)@alpha|beta", "Qwen (Q6_K) (alpha, beta)", "http://127.0.0.1:1/v1")];
		const pruned = pruneConfigs(configs, [serverB]);
		expect(pruned).toHaveLength(1);
		expect(pruned[0].baseUrl).toBe("http://127.0.0.1:2/v1");
	});

	it("keeps entries with an unrecognised id", async () => {
		const { pruneConfigs } = await loadModule();
		const configs = [cfg("mystery", "mystery", "http://127.0.0.1:9/v1")];
		expect(pruneConfigs(configs, [serverA])).toEqual(configs);
	});
});

// ---------------------------------------------------------------------------
// serverForModelId ignores disabled servers
// ---------------------------------------------------------------------------

describe("serverForModelId with disabled servers", () => {
	beforeEach(async () => {
		cleanupStorage();
		setupStorage([
			{ name: "alpha", host: "127.0.0.1", port: 1, protocol: "http", enabled: false },
			{ name: "beta", host: "127.0.0.1", port: 2, protocol: "http", enabled: true },
		]);
		const { resetCaches } = await loadModule();
		resetCaches();
	});

	afterEach(cleanupStorage);

	it("skips a disabled server in a deduplicated id", async () => {
		const { serverForModelId } = await loadModule();
		expect(serverForModelId("Qwen@alpha|beta")?.name).toBe("beta");
	});

	it("returns undefined for a legacy id pointing at a disabled server", async () => {
		const { serverForModelId } = await loadModule();
		expect(serverForModelId("alpha / Qwen")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// End-to-end: disabling a server updates the published catalog immediately
// ---------------------------------------------------------------------------

interface FakePi {
	pi: any;
	providers: Map<string, any>;
	commands: Map<string, any>;
}

function createFakePi(): FakePi {
	const providers = new Map<string, any>();
	const commands = new Map<string, any>();
	const pi = {
		registerProvider: (id: string, config: any) => {
			providers.set(id, config);
		},
		unregisterProvider: (id: string) => {
			providers.delete(id);
		},
		registerCommand: (name: string, def: any) => {
			commands.set(name, def);
		},
		on: () => {},
	};
	return { pi, providers, commands };
}

function createFakeCtx(notifications: string[], model?: { provider: string; id: string }) {
	return {
		model,
		ui: {
			notify: (message: string) => {
				notifications.push(message);
			},
		},
	};
}

/** Minimal llama.cpp-compatible /v1/models stub. */
function startModelServer(modelIds: string[]): Promise<{ server: Server; port: number }> {
	return new Promise((resolve) => {
		const server = createServer((req, res) => {
			if (req.url?.startsWith("/v1/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ data: modelIds.map((id) => ({ id, owned_by: "llamacpp" })) }));
				return;
			}
			res.writeHead(404).end();
		});
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, port: (server.address() as AddressInfo).port });
		});
	});
}

describe("catalog sync on config change", () => {
	let alpha: { server: Server; port: number };
	let beta: { server: Server; port: number };
	let fake: FakePi;
	const notifications: string[] = [];

	beforeAll(async () => {
		alpha = await startModelServer(["/models/alpha-qwen.gguf"]);
		beta = await startModelServer(["/models/beta-llama.gguf"]);
	});

	afterAll(async () => {
		await new Promise((r) => alpha.server.close(r));
		await new Promise((r) => beta.server.close(r));
		cleanupStorage();
	});

	beforeEach(async () => {
		notifications.length = 0;
		cleanupStorage();
		setupStorage([
			{ name: "alpha", host: "127.0.0.1", port: alpha.port, protocol: "http", enabled: true },
			{ name: "beta", host: "127.0.0.1", port: beta.port, protocol: "http", enabled: true },
		]);
		const { resetCaches, default: activate } = await loadModule();
		resetCaches();
		fake = createFakePi();
		activate(fake.pi);
		// Prime the catalog the way Pi does when /model is opened: a live refresh
		// whose result Pi publishes as the provider's model list.
		const provider = fake.providers.get("llama-chooser");
		provider.models = await provider.refreshModels({
			allowNetwork: true,
			signal: new AbortController().signal,
		});
	});

	afterEach(cleanupStorage);

	function publishedIds(): string[] {
		return (fake.providers.get("llama-chooser").models ?? []).map((m: any) => m.id);
	}

	it("removes a disabled server's models from the published catalog", async () => {
		expect(publishedIds().some((id) => id.startsWith("alpha"))).toBe(true);

		const command = fake.commands.get("llama-chooser");
		await command.handler("config disable alpha", createFakeCtx(notifications));

		const ids = publishedIds();
		expect(ids.some((id) => id.includes("alpha"))).toBe(false);
		expect(ids.some((id) => id.includes("beta"))).toBe(true);
		expect(notifications.join("\n")).toContain('Disabled server "alpha"');
	});

	it("warns when the selected model leaves the catalog", async () => {
		const selected = publishedIds().find((id) => id.startsWith("alpha"))!;
		const command = fake.commands.get("llama-chooser");
		await command.handler(
			"config disable alpha",
			createFakeCtx(notifications, { provider: "llama-chooser", id: selected }),
		);
		expect(notifications.join("\n")).toContain("no longer available");
	});

	it("does not warn when the selected model stays available", async () => {
		const selected = publishedIds().find((id) => id.startsWith("beta"))!;
		const command = fake.commands.get("llama-chooser");
		await command.handler(
			"config disable alpha",
			createFakeCtx(notifications, { provider: "llama-chooser", id: selected }),
		);
		expect(notifications.join("\n")).not.toContain("no longer available");
	});

	it("removes a removed server's models from the published catalog", async () => {
		const command = fake.commands.get("llama-chooser");
		await command.handler("config remove alpha", createFakeCtx(notifications));
		expect(publishedIds().some((id) => id.includes("alpha"))).toBe(false);
	});

	it("publishes an empty catalog when the last server is disabled", async () => {
		const command = fake.commands.get("llama-chooser");
		await command.handler("config disable alpha", createFakeCtx(notifications));
		await command.handler("config disable beta", createFakeCtx(notifications));
		expect(publishedIds()).toEqual([]);
	});

	it("adds a newly enabled server's models without a restart", async () => {
		const command = fake.commands.get("llama-chooser");
		await command.handler("config disable beta", createFakeCtx(notifications));
		expect(publishedIds().some((id) => id.includes("beta"))).toBe(false);

		await command.handler("config enable beta", createFakeCtx(notifications));
		// The live refresh is fire-and-forget; let it settle.
		await new Promise((r) => setTimeout(r, 200));
		expect(publishedIds().some((id) => id.includes("beta"))).toBe(true);
	});

	it("adds a server with omitted protocol defaulting to http", async () => {
		const command = fake.commands.get("llama-chooser");
		await command.handler("config add gamma 127.0.0.1 9000", createFakeCtx(notifications));
		expect(notifications.join("\n")).toContain('Added server "gamma" at http://127.0.0.1:9000/v1');
	});

	it("edits a server with omitted protocol preserving current protocol", async () => {
		const command = fake.commands.get("llama-chooser");
		await command.handler("config edit alpha 127.0.0.1 9001", createFakeCtx(notifications));
		expect(notifications.join("\n")).toContain('Updated server "alpha" to http://127.0.0.1:9001/v1');
	});

	it("provides argument completions for config subcommands and server names", async () => {
		const command = fake.commands.get("llama-chooser");
		const configCompletions = command.getArgumentCompletions("config ");
		expect(configCompletions.some((c: any) => c.value === "config add")).toBe(true);
		expect(configCompletions.some((c: any) => c.value === "config enable")).toBe(true);

		const serverCompletions = command.getArgumentCompletions("config enable ");
		expect(serverCompletions.some((c: any) => c.value === "config enable alpha")).toBe(true);
	});
});
