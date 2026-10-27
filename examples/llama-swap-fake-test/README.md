# Fake test: pi-llama-chooser + llama-swap (no GPU / no model files)

This exercises the whole selection → routing → streaming path using a **fake
upstream** that pretends to be llama.cpp. Nothing real is loaded.

## Files

| File | What it is |
|---|---|
| `fake-upstream.mjs` | A tiny Node HTTP server that speaks `/v1/models` and streams a canned `/v1/chat/completions` reply. No weights, no GPU. |
| `llama-swap.json` | A llama-swap profile set whose `cmd` just starts `fake-upstream.mjs` (once per model, on different ports). |

## Option A — fastest: point the chooser straight at the fake upstream

Good for testing the chooser alone.

```bash
# terminal 1 — start the fake llama.cpp
node examples/llama-swap-fake-test/fake-upstream.mjs --port 8080
```

```bash
# terminal 2 — in pi
pi
/llama-chooser config add fakeswap  127.0.0.1  8080  http
/llama-chooser config refresh
/llama-chooser list          # you should see Qwen2.5-7B-Instruct (Q6_K)
                             #        and Llama-3.1-8B-Instruct (Q4_K_M)
```

Now pick one from `/model` and type anything — you'll get a canned fake reply
streamed back with the speed footer running. The catalog shows the fake
quantization / context because `fake-upstream.mjs` returns them in `meta`.

## Option B — full path: chooser → llama-swap → fake upstream

Good for testing the llama-swap load/unload/swrap layer too.

```bash
# terminal 1 — start llama-swap (its `cmd` launches the fake upstreams)
llama-swap -c examples/llama-swap-fake-test/llama-swap.json

# terminal 2 — in pi, point the chooser at the llama-swap proxy
pi
/llama-chooser config add fakeswap  127.0.0.1  8080  http
/llama-chooser config refresh
/llama-chooser list
```

Then pick a model in `/model`. llama-swap autoloads the matching fake upstream,
forwards the request, streams the canned reply, and auto-unloads after the
profile's `ttl` (300s here). Check what's "loaded" with:

```bash
curl -s http://127.0.0.1:8080/running
```

## Verify the routes the chooser actually uses

```bash
# 1) catalog source
curl -s http://127.0.0.1:8080/v1/models

# 2) a non-streaming completion (canned JSON reply)
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"Qwen2.5-7B-Instruct-Q6_K","messages":[{"role":"user","content":"hi"}]}'

# 3) a streaming completion (canned SSE)
curl -sN http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"Qwen2.5-7B-Instruct-Q6_K","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

## Note on llama-swap and the `model` id (the 404 you may have seen)

llama-swap (and any OpenAI-compatible gateway that validates the request)
routes on the **exact** `model` id it exposes on `/v1/models`. The chooser's
catalog `id` is a human label — `"<server> / <model> (<quant>)"` or, with
`dedup`, `"<model> (<quant>) (<s1>, <s2>)"` — and Pi sends that label verbatim
as the `model` field. A strict server rejects it:

```
Error: 404: {"message":"no router for requested model", ...}
```

The fix (see `src/index.ts`, `streamSimple` + `upstreamModelIdFor`): at stream
time the chooser looks the real upstream id up from the per-server model
cache (matched by the display label) and forwards **that** as the wire `model`,
while keeping the display label for the catalog. So the request that reaches
llama-swap carries e.g. `"Qwen2.5-7B-Instruct-Q6_K"`, not
`"fakeswap / Qwen2.5-7B-Instruct-Q6_K (Q6_K)"`.

You can see the difference with the scripts in this repo:

```bash
# end-to-end against the real fake-upstream.mjs (one row per server)
node ... && npx tsx /tmp/e2e.mjs     # WIRE model field -> "Qwen2.5-7B-Instruct-Q6_K"
# dedup path (two servers, same model)
npx tsx /tmp/dedup.mjs               # merged row, but WIRE model field -> "Qwen2.5-7B-Instruct-Q6_K"
```

And the unit test that locks it in:

```bash
npm test    # test/stream-model-id.test.ts — one-row-per-server AND dedup
```

## What this proves

- The chooser lists models from `<server>/v1/models` and shows quant/context.
- A `/model` selection routes to `<server>/v1/chat/completions` with the right
  `baseUrl` (one row per server / merged with `dedup`), and forwards the
  **exact upstream `model` id** so strict servers (llama-swap) accept it.
- With llama-swap, load/unload/swapping is handled by the proxy, not the chooser
  — the chooser only ever sends the request.

To tear down: Ctrl-C both terminals (or `kill` the `node` / `llama-swap` processes).
