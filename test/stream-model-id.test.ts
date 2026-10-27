import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { LlamaServer, LlamaModel } from "../src/index";

// ---------------------------------------------------------------------------
// Stream forwards the *upstream* model id, not the catalog display id.
//
// The catalog id is a human label ("<server> / <model> (<quant>)") so Pi can
// show one row per server / merge identical models. But Pi sends that id back
// verbatim as the `model` field of the OpenAI request. Servers that validate
// it (llama-swap routers, OpenAI-compatible gateways) reject the label, so the
// extension must resolve the exact id the server exposed on /v1/models and
// forward that instead.
// ---------------------------------------------------------------------------

// Unique storage path so this file (which mocks fetch + hits the network path)
// can't race with the other files that share the default test storage file.
process.env.LLAMA_CHOOSER_STORAGE = join(
	process.env.HOME ?? "/tmp",
	".pi",
	"agent",
	"llama-chooser-stream-test-servers.json",
);

let mod: typeof import("../src/index");
async function loadModule() {
	if (!mod) mod = await import("../src/index");
	return mod;
}

function setupTestStorage(servers: any[]) {
	const dir = join(process.env.LLAMA_CHOOSER_STORAGE!, "..");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(process.env.LLAMA_CHOOSER_STORAGE!, JSON.stringify(servers, null, 2), "utf-8");
}
function cleanupTestStorage() {
	try {
		if (existsSync(process.env.LLAMA_CHOOSER_STORAGE!)) rmSync(process.env.LLAMA_CHOOSER_STORAGE!);
	} catch {
		/* ignore */
	}
}

const HOST = "127.0.0.1";
const PORT = 8137;

// Two models with the SAME basename but different quant, so we can prove the
// routing matches the exact catalog row the user picked. The upstream ids are
// deliberately distinct from the display label ("q7b-a (Q6_K)") so assertions
// can tell the wire id apart from the catalog label.
const MODELS: LlamaModel[] = [
	{ id: "q7b-a", meta: { ftype: "Q6_K", n_ctx: 32768 } } as LlamaModel,
	{ id: "q7b-b", meta: { ftype: "Q4_K_M", n_ctx: 32768 } } as LlamaModel,
];

type Captured = { url: string; model: string };

async function run({ dedup = false, servers = undefined }: { dedup?: boolean; servers?: LlamaServer[] } = {}) {
	const { resetCaches, refreshModels, llamaProviderConfig } = await loadModule();
	resetCaches();

	const list = servers ?? [
		{
			name: "myserver",
			host: HOST,
			port: PORT,
			protocol: "http",
			enabled: true,
		},
	];
	setupTestStorage(list);
	// Settings sidecar lives next to the servers file (-settings.json).
	writeFileSync(
		process.env.LLAMA_CHOOSER_STORAGE!.replace(/\.json$/, "-settings.json"),
		JSON.stringify({ dedupModels: dedup }, null, 2),
		"utf-8",
	);

	let captured: Captured | undefined;
	const originalFetch = globalThis.fetch;
	const mockFetch = vi.fn(async (input: any, init?: any) => {
		const url = typeof input === "string" ? input : input?.url ?? String(input);
		const path = new URL(url).pathname;
		if (path.endsWith("/v1/models")) {
			return new Response(JSON.stringify({ object: "list", data: MODELS }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		if (path.endsWith("/v1/chat/completions")) {
			const body = JSON.parse(init?.body ?? "{}");
			captured = { url, model: body.model };
			const sse =
				"data:" +
				JSON.stringify({ choices: [{ delta: { content: "hi" } }] }) +
				"\n\ndata:" +
				JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
				"\n\ndata: [DONE]\n\n";
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}
		return new Response("not found", { status: 404 });
	});
	globalThis.fetch = mockFetch as any;

		try {
		// Populate the per-server model cache and build the catalog.
		const configs = (await refreshModels({
								allowNetwork: true,
								publish: () => Promise.resolve(true),
								signal: new AbortController().signal,
				})) as ProviderModelConfig[];
				expect(configs.length).toBe(2);

		const provider = llamaProviderConfig(configs);
		expect(typeof provider.streamSimple).toBe("function");

		// Pick the Q6_K row and stream. In dedup mode the row is a merged display
		// label ("<model> (<quant>) (server)"); in the default mode it is
		// "<server> / <model> (<quant>)".
		const chosen = configs.find((c) => c.name.includes("(Q6_K)"))!;
		const context: any = {
			messages: [{ role: "user", content: "hello" }],
			model: { provider: "llama-chooser", id: chosen.id },
		};
		const stream = provider.streamSimple!(chosen as any, context, { stream: true } as any);
		await stream.result().catch(() => {});

		expect(captured, "expected a completion request to be sent").toBeDefined();
		// The wire `model` must be the exact upstream id the server exposed,
		// NOT the catalog display label (one-row-per-server or merged).
		expect(captured!.model).toBe("q7b-a");
		expect(captured!.model).not.toContain("/");
		expect(captured!.model).not.toContain("(");
	} finally {
		globalThis.fetch = originalFetch;
		cleanupTestStorage();
	}
}

describe("stream forwards the upstream model id", () => {
	it("sends the server's real model id (one row per server)", async () => {
		await run();
	});

	it("sends the server's real model id even for a deduplicated merged row", async () => {
		await run({ dedup: true });
	});
});
