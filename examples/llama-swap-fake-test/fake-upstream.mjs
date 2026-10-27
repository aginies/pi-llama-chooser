// Fake llama.cpp upstream for testing pi-llama-chooser + llama-swap.
// Speaks just enough of the OpenAI /v1 API so the chooser can list models and
// "stream" a reply — no real GPU or model files required.
//
//   node fake-upstream.mjs [--port 8080] [--host 127.0.0.1]
//
// Endpoints:
//   GET  /v1/models
//   POST /v1/chat/completions   (streams a canned SSE reply echoing the model)
//   GET  /running                (llama-swap-style: which model is "loaded")
//
// It pretends to load/unload: POST /v1/chat/completions marks the model loaded,
// and anything not loaded in the last 5s is reported unloaded by /running.

import http from "node:http";

const args = process.argv.slice(2);
const flag = (name, def) => {
	const i = args.indexOf(name);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const host = flag("--host", "127.0.0.1");
const port = Number(flag("--port", 8080));

// Two fake models, as if loaded by two llama.cpp profiles.
const MODELS = [
	{
		id: "Qwen2.5-7B-Instruct-Q6_K",
		object: "model",
		created: 1700000000,
		owned_by: "llamacpp",
		meta: { ftype: "Q6_K", n_ctx: 32768, size_bytes: 4.6e9 },
	},
	{
		id: "Llama-3.1-8B-Instruct-Q4_K_M",
		object: "model",
		created: 1700000000,
		owned_by: "llamacpp",
		meta: { ftype: "Q4_K_M", n_ctx: 131072, size_bytes: 4.9e9 },
	},
];

const loaded = new Map(); // id -> last-used epoch ms
const TTL = 5_000;

function sendJson(res, status, obj) {
	const body = JSON.stringify(obj, null, 2);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(body),
	});
	res.end(body);
}

function streamSse(res, modelId, messages) {
	const prompt = (messages ?? [])
		.map((m) => `[${m.role}] ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
		.join("\n");
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	loaded.set(modelId, Date.now());
	const id = "chatcmpl-fake";
	const chunk = (tok) =>
		res.write(
			`data:${JSON.stringify({
				id,
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: modelId,
				choices: [{ delta: { content: tok }, index: 0 }],
			})}\n\n`,
		);
	const reply = `I am a FAKE ${modelId}. You said: ${prompt.slice(0, 80)}... (this upstream serves no real weights).`;
	for (const tok of reply.split(" ")) {
		setTimeout(() => chunk(` ${tok}`), 20);
	}
	setTimeout(() => {
		res.write(`data:${JSON.stringify({ id, choices: [{ finish_reason: "stop", index: 0 }] })}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	}, reply.length * 20 + 50);
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, `http://${host}`);
	const path = url.pathname;

	if (req.method === "GET" && path === "/v1/models") {
		return sendJson(res, 200, { object: "list", data: MODELS });
	}

	if (req.method === "GET" && path === "/running") {
		const now = Date.now();
		return sendJson(res, 200, {
			data: MODELS.map((m) => ({
				id: m.id,
				status: loaded.get(m.id) && now - loaded.get(m.id) < TTL ? "loaded" : "unloaded",
			})),
		});
	}

	if (req.method === "POST" && path === "/v1/chat/completions") {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			let json;
			try {
				json = JSON.parse(body || "{}");
			} catch {
				return sendJson(res, 400, { error: { message: "invalid JSON body" } });
			}
			const modelId = json.model ?? MODELS[0].id;
			if (!json.stream) {
				return sendJson(res, 200, {
					id: "chatcmpl-fake",
					object: "chat.completion",
					model: modelId,
					choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `FAKE reply from ${modelId}.` } }],
				});
			}
			streamSse(res, modelId, json.messages);
		});
		return;
	}

	sendJson(res, 404, { error: { message: `no route ${req.method} ${path}` } });
});

server.listen(port, host, () => {
	console.log(`[fake-upstream] listening on http://${host}:${port}`);
	console.log(`[fake-upstream] GET  /v1/models`);
	console.log(`[fake-upstream] POST /v1/chat/completions  (add "stream":true for SSE)`);
	console.log(`[fake-upstream] GET  /running`);
});
