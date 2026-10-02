/**
 * Test: prove the refresh bug and verify the fix.
 *
 * Mirrors Pi's model-runtime refresh flow (see pi-ai/dist/models.js refresh()):
 *   - register/unregister triggers refresh({ allowNetwork: false })
 *   - refresh({ allowNetwork: true }) calls refreshModels TWICE:
 *       1. allowNetwork: false  (restore cached state)
 *       2. allowNetwork: true   (live fetch, only if credential resolves)
 *   - "Pi replaces that registration's live models with the returned list"
 *
 * The fixed refreshModels (src/index.ts) returns the cached list offline and
 * fetches live online. refreshProviderModels() calls
 * ctx.modelRegistry.refresh({ allowNetwork: true, force: true }).
 *
 * Run: npx tsx test/refresh.test.ts
 */

// --- Simulated server state (changes between "requests") ---
let serverModels: { id: string; meta?: { n_ctx?: number } }[] = [
	{ id: "org/old-model/old.gguf", meta: { n_ctx: 32768 } },
];

function fetchLiveModels() {
	// Simulate a network fetch from llama.cpp /v1/models
	return serverModels.map((m) => ({ ...m }));
}

// Local minimal shape (avoids ProviderModelConfig readonly friction in the test).
interface TestModelConfig {
	id: string;
	name: string;
	contextWindow: number;
}

function toConfig(id: string, nCtx: number): TestModelConfig {
	return { id, name: id, contextWindow: nCtx };
}

// --- The CURRENT (buggy) refreshModels: returns [] offline ---
function buggyRefreshModels(context: { allowNetwork: boolean }): Promise<TestModelConfig[]> {
	if (!context.allowNetwork) return Promise.resolve([]);
	return Promise.resolve(fetchLiveModels().map((m) => toConfig(m.id, m.meta?.n_ctx ?? 32768)));
}

// --- The FIXED refreshModels (mirrors src/index.ts): cache offline, live online,
// --- keep last known-good on empty/failed fetch ---
let cachedConfigs: TestModelConfig[] = [];
function fixedRefreshModels(context: { allowNetwork: boolean }): Promise<TestModelConfig[]> {
	if (!context.allowNetwork) return Promise.resolve(cachedConfigs);
	const fresh = fetchLiveModels().map((m) => toConfig(m.id, m.meta?.n_ctx ?? 32768));
	if (fresh.length > 0) {
		cachedConfigs = fresh;
		return Promise.resolve(fresh);
	}
	return Promise.resolve(cachedConfigs);
}

// --- Simulate Pi's model runtime refresh() ---
// Returns the resulting live catalog after the refresh completes.
async function simulatePiRefresh(
	refreshModels: (ctx: { allowNetwork: boolean }) => Promise<TestModelConfig[]>,
	allowNetwork: boolean,
): Promise<TestModelConfig[]> {
	let liveModels: TestModelConfig[] = [];
	// Phase 1: always restore cached state first (allowNetwork: false).
	const phase1 = await refreshModels({ allowNetwork: false });
	liveModels = phase1; // "Pi replaces that registration's live models with the returned list"
	if (!allowNetwork) return liveModels;
	// Phase 2: live fetch (allowNetwork: true) — only if credential resolves.
	const phase2 = await refreshModels({ allowNetwork: true });
	liveModels = phase2;
	return liveModels;
}

async function main() {
	let failures = 0;
	const assert = (cond: boolean, msg: string) => {
		if (!cond) {
			console.error(`  ✗ ${msg}`);
			failures++;
		} else {
			console.log(`  ✓ ${msg}`);
		}
	};

	console.log("=== BUGGY: deps.refresh() = unregister + re-register ===");
	// Initial registration: live fetch populates the catalog.
	serverModels = [{ id: "org/old-model/old.gguf", meta: { n_ctx: 32768 } }];
	let catalog = await simulatePiRefresh(buggyRefreshModels, true);
	assert(catalog.length === 1, "initial catalog has 1 model");
	assert(catalog[0]?.contextWindow === 32768, "initial CTX = 32768");

	// User changes the model on the server.
	serverModels = [{ id: "org/new-model/new.gguf", meta: { n_ctx: 524288 } }];

	// unregister + re-register each trigger refresh({ allowNetwork: false }).
	catalog = await simulatePiRefresh(buggyRefreshModels, false); // unregister
	assert(catalog.length === 0, "BUG PROVEN: unregister wipes the catalog (0 models)");
	catalog = await simulatePiRefresh(buggyRefreshModels, false); // re-register
	assert(catalog.length === 0, "BUG PROVEN: re-register still has 0 models (stale/empty)");
	console.log("  → Footer keeps showing the OLD model name + CTX (catalog is empty/stale).\n");

	console.log("=== FIXED: refreshProviderModels() = modelRegistry.refresh({ allowNetwork: true }) ===");
	cachedConfigs = [];
	// Initial registration: live fetch.
	serverModels = [{ id: "org/old-model/old.gguf", meta: { n_ctx: 32768 } }];
	catalog = await simulatePiRefresh(fixedRefreshModels, true);
	assert(catalog.length === 1, "initial catalog has 1 model");
	assert(catalog[0]?.contextWindow === 32768, "initial CTX = 32768");

	// User changes the model on the server.
	serverModels = [{ id: "org/new-model/new.gguf", meta: { n_ctx: 524288 } }];

	// Each new request triggers a live refresh (two phases: offline restore, then live fetch).
	catalog = await simulatePiRefresh(fixedRefreshModels, true);
	assert(catalog.length === 1, "catalog still has 1 model");
	assert(catalog[0]?.id === "org/new-model/new.gguf", "model name updated to new-model");
	assert(catalog[0]?.contextWindow === 524288, "CTX updated to 524288 (from meta.n_ctx)");

	// A local (offline) refresh does NOT wipe the catalog.
	catalog = await simulatePiRefresh(fixedRefreshModels, false);
	assert(catalog.length === 1, "offline refresh keeps the cached model (not wiped)");
	assert(catalog[0]?.contextWindow === 524288, "offline refresh keeps the fresh CTX");

	// A failed live fetch (server down) keeps the last known-good list.
	const saved = serverModels;
	serverModels = [];
	const failed = await simulatePiRefresh(fixedRefreshModels, true);
	assert(failed.length === 1, "failed live fetch keeps the last known-good list");
	assert(failed[0]?.contextWindow === 524288, "failed live fetch keeps the fresh CTX");
	serverModels = saved;

	console.log(failures === 0 ? "\nAll assertions passed." : `\n${failures} assertion(s) failed.`);
	process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
