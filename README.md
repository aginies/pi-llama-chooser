# pi-llama-chooser

Pi extension: manage remote llama.cpp servers and use their models via `/model`.

## Installation

Install from Pi:

```bash
pi install npm:pi-llama-chooser
```

Or directly with npm:

```bash
npm install pi-llama-chooser
```

Requires `@earendil-works/pi-coding-agent` and Node.js ≥ 22.19.0.

## Usage

### Commands

| Command | Description |
|---|---|
| `/llama-chooser config` | Open the interactive server menu |
| `/llama-chooser config add <name> <host> <port> [http\|https] [apiKey]` | Add a server |
| `/llama-chooser config edit <name> <host> <port> [http\|https] [apiKey]` | Edit a server |
| `/llama-chooser config remove <name>` | Remove a server |
| `/llama-chooser config enable <name>` | Enable a server |
| `/llama-chooser config disable <name>` | Disable a server |
| `/llama-chooser config refresh` | Refresh models from all enabled servers |
| `/llama-chooser list [server]` | List models (from all enabled or a specific server) |

### Interactive Menu

Run `/llama-chooser config` to open a menu:

1. **Add a server** — step-by-step wizard for name, host, port, protocol, API key
2. **Select a server** — see status (🟢 online / 🔴 offline, ✓ enabled / ✗ disabled)
3. **Server actions** — edit values, enable/disable, refresh models, remove

### Models

Enabled servers' models appear under the **Llama Chooser** provider in `/model`. The model name shows the server, model basename, and quantization level (e.g. `myServer / Qwen2.5 (Q6_K)`).

Run `/llama-chooser list` to see full details per model:

- Quantization level (e.g. `Q6_K`)
- Context window (e.g. `116K ctx`)
- File size (e.g. `27.9 GB`)
- Owner (e.g. `[llamacpp]`)

Models with the same basename across servers are automatically deduplicated into a single entry that routes to any online server.

### Speed Tracker

The footer shows prefill and generation speed while streaming:

```bash
⚡450t/s 🔥85.3t/s
```

Rates are color-coded (red → orange → yellow → lime → cyan → violet) and use a moving window for generation speed.

## Configuration

Servers are stored in `~/.pi/agent/llama-chooser-servers.json`.

```json
[
  {
    "name": "my-server",
    "host": "192.168.1.50",
    "port": 8080,
    "protocol": "http",
    "enabled": true,
    "apiKey": "optional-api-key"
  }
]
```

- `name` — unique identifier (no spaces, no `__`)
- `host` — IP address or hostname
- `port` — 1–65535
- `protocol` — `http` or `https`
- `apiKey` — optional Bearer token for authentication

## Development

```bash
npm run typecheck   # TypeScript check
npm run dev         # Run with local extension
```
