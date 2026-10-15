import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	readSettings,
	writeSettings,
	parseSettings,
	settingsPathFor,
	resetSettingsCache,
	DEFAULT_SETTINGS,
} from "../src/settings";
import type { LlamaServer } from "../src/index";

// Test-only storage path so the real config is never touched.
process.env.LLAMA_CHOOSER_STORAGE = join(
	process.env.HOME ?? "/tmp",
	".pi",
	"agent",
	"llama-chooser-dedup-test-servers.json",
);

let mod: typeof import("../src/index");

async function loadModule() {
	if (!mod) mod = await import("../src/index");
	return mod;
}

function storagePath(): string {
	return process.env.LLAMA_CHOOSER_STORAGE!;
}

function settingsPath(): string {
	return settingsPathFor(storagePath());
}

function cleanupStorage() {
	for (const p of [storagePath(), settingsPath()]) {
		if (existsSync(p)) rmSync(p);
	}
	resetSettingsCache();
}

function setupStorage(servers: unknown[]) {
	const dir = join(storagePath(), "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(storagePath(), JSON.stringify(servers, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// settings.ts (pure)
// ---------------------------------------------------------------------------

describe("settings", () => {
	it("derives the settings path next to the server file", () => {
		expect(settingsPathFor("/x/llama-chooser-servers.json")).toBe(
			"/x/llama-chooser-servers-settings.json",
		);
		expect(settingsPathFor("/x/custom-storage")).toBe("/x/custom-storage-settings.json");
	});

	it("defaults to one /model row per server", () => {
		expect(DEFAULT_SETTINGS.dedupModels).toBe(false);
	});

	it("parses known keys and ignores junk", () => {
		expect(parseSettings(`{"dedupModels":true}`).dedupModels).toBe(true);
		expect(parseSettings(`{"dedupModels":"yes","other":1}`).dedupModels).toBe(false);
		expect(parseSettings("not json").dedupModels).toBe(false);
		expect(parseSettings("[]").dedupModels).toBe(false);
	});

	it("reads defaults for a missing file and round-trips a written one", () => {
		cleanupStorage();
		expect(readSettings(settingsPath()).dedupModels).toBe(false);
		writeSettings(settingsPath(), { dedupModels: true });
		expect(readSettings(settingsPath()).dedupModels).toBe(true);
		cleanupStorage();
	});
});

// ---------------------------------------------------------------------------
// Catalog mode, end to end through the /llama-chooser config dedup command
// ---------------------------------------------------------------------------

function createFakePi(): { pi: any; providers: Map<string, any>; commands: Map<string, any> } {
	const providers = new Map<string, any>();
	const commands = new Map<string, any>();
	const pi = {
		registerProvider: (id: string, config: any) => void providers.set(id, config),
		unregisterProvider: (id: string) => void providers.delete(id),
		registerCommand: (name: string, def: any) => void commands.set(name, def),
		on: () => {},
	};
	return { pi, providers, commands };
}

function createFakeCtx(notifications: string[], model?: { provider: string; id: string }) {
	return { model, ui: { notify: (message: string) => void notifications.push(message) } };
}

/** Minimal llama.cpp-compatible /v1/models stub serving a single model id. */
async function startModelServer(modelIds: string[]): Promise<{ server: Server; port: number }> {
	return new Promise((resolve) => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: modelIds.map((id) => ({ id, owned_by: "llamacpp" })) }));
		});
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, port: (server.address() as AddressInfo).port });
		});
	});
}

describe("/model rows for a model served by two servers", () => {
	const SHARED = "/models/Ornith-1.5-9B-Q8_0.gguf";
	let alpha: { server: Server; port: number };
	let beta: { server: Server; port: number };
	let fake: ReturnType<typeof createFakePi>;
	const notifications: string[] = [];

	beforeAll(async () => {
		alpha = await startModelServer([SHARED]);
		beta = await startModelServer([SHARED]);
	});

	afterAll(async () => {
		await new Promise((r) => alpha.server.close(r));
		await new Promise((r) => beta.server.close(r));
	});

	beforeEach(async () => {
		notifications.length = 0;
		cleanupStorage();
		setupStorage([
			{ name: "alpha", host: "127.0.0.1", port: alpha.port, protocol: "http", enabled: true },
			{ name: "beta", host: "127.0.0.1", port: beta.port, protocol: "http", enabled: true },
		] satisfies LlamaServer[]);
		const { resetCaches, default: activate } = await loadModule();
		resetCaches();
		fake = createFakePi();
		activate(fake.pi);
		const provider = fake.providers.get("llama-chooser");
		provider.models = await provider.refreshModels({
			allowNetwork: true,
			signal: new AbortController().signal,
		});
	});

	afterEach(cleanupStorage);

	function published() {
		return (fake.providers.get("llama-chooser").models ?? []) as {
			id: string;
			name: string;
			baseUrl: string;
		}[];
	}

	it("publishes one selectable row per server by default", () => {
		const ids = published().map((m) => m.id);
		expect(ids).toHaveLength(2);
		expect(ids).toContain("alpha / Ornith-1.5-9B-Q8_0 (Q8_0)");
		expect(ids).toContain("beta / Ornith-1.5-9B-Q8_0 (Q8_0)");
	});

	it("keeps each row pointed at its own server", () => {
		const rows = published();
		expect(rows.find((r) => r.id.startsWith("alpha"))?.baseUrl).toBe(
			`http://127.0.0.1:${alpha.port}/v1`,
		);
		expect(rows.find((r) => r.id.startsWith("beta"))?.baseUrl).toBe(
			`http://127.0.0.1:${beta.port}/v1`,
		);
	});

	it("merges into a single row when dedup is on", async () => {
		const command = fake.commands.get("llama-chooser");
		await command.handler("config dedup on", createFakeCtx(notifications));

		const ids = published().map((m) => m.id);
		expect(ids).toEqual(["Ornith-1.5-9B-Q8_0 (Q8_0)@alpha|beta"]);
		expect(published()[0].name).toBe("Ornith-1.5-9B-Q8_0 (Q8_0) (alpha, beta)");
		expect(readSettings(settingsPath()).dedupModels).toBe(true);

		// ...and back to per-server rows.
		await command.handler("config dedup off", createFakeCtx(notifications));
		expect(published().map((m) => m.id)).toEqual([
			"alpha / Ornith-1.5-9B-Q8_0 (Q8_0)",
			"beta / Ornith-1.5-9B-Q8_0 (Q8_0)",
		]);
		expect(readSettings(settingsPath()).dedupModels).toBe(false);
	});

	it("reports the current mode and still routes legacy ids", async () => {
		const command = fake.commands.get("llama-chooser");
		await command.handler("config dedup status", createFakeCtx(notifications));
		expect(notifications.join("\n")).toContain("per server");

		const { serverForModelId, serverNamesForConfigId } = await loadModule();
		// An id kept from a previous merged catalog still resolves to a server.
		expect(serverNamesForConfigId("Ornith-1.5-9B-Q8_0 (Q8_0)@alpha|beta")).toEqual([
			"alpha",
			"beta",
		]);
		expect(serverForModelId("Ornith-1.5-9B-Q8_0 (Q8_0)@alpha|beta")?.name).toBeTruthy();
		expect(serverForModelId("beta / Ornith-1.5-9B-Q8_0 (Q8_0)")?.name).toBe("beta");
	});
});
