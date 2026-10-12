# Proposed New Features for pi-llama-chooser

## Prioritized Feature Ideas

### P0: High Impact / Medium Effort

#### 1. Automatic Server Health Discovery
- **Problem**: Users manually add servers but must remember to enable/disable them based on reachability. The `/llama-chooser config list` command already pings servers, but there's no automatic enrollment.
- **User benefit**: Zero-configuration experience — add a server host/port, and it's automatically enabled when reachable, disabled when not. No more "why aren't my models showing up?" confusion.
- **Implementation approach**:
  - Add a `/llama-chooser config discover <host-range>` subcommand that pings a range of IPs/hosts on a port and suggests valid configurations
  - Or: Add a background health-check loop that automatically toggles `enabled` flag based on ping results
  - Reuse existing `pingServer` infrastructure (TTL: 30s)
  - Est effort: 200-300 lines, touches `src/index.ts` config handlers
  - API impact: New CLI subcommand; no breaking changes
  - Compatibility: Fully backward-compatible

#### 2. Import/Export Server Configurations
- **Problem**: Servers stored in `~/.pi/agent/llama-chooser-servers.json` — no easy way to backup, share between devices, or migrate.
- **User benefit**: One-click backup/restore; share server configs across team members; easy migration to new machine.
- **Implementation approach**:
  - Add `/llama-chooser config export [filepath]` — exports current servers to JSON
  - Add `/llama-chooser config import <filepath>` — imports servers (with merge/prompt-for-duplicates logic)
  - Leverages existing `loadServers`/`saveServers` infrastructure
  - Est effort: 150-200 lines, new CLI subcommands
  - API impact: New CLI subcommands only
  - Compatibility: Fully backward-compatible

#### 3. Model Search/Filter in `/llama-chooser list`
- **Problem**: `/llama-chooser list` shows all models from all enabled servers, but with no way to find a specific model. Listing 50+ models is overwhelming.
- **User benefit**: Quickly find a model by name, quantization, context size, or owner; filter to specific server(s).
- **Implementation approach**:
  - Add query parameters to `/llama-chooser list`: `?search=<term>`, `?quant=<Q6_K>`, `?ctx=<32768>`
  - Server-specific filtering: `/llama-chooser list <server-name>`
  - Use existing `extractQuant`, `formatCtxSize`, `basename` utilities
  - Est effort: 250-350 lines, modify `handleList` function and add argument parsing
  - API impact: New optional CLI arguments; no breaking changes
  - Compatibility: Fully backward-compatible

---

### P1: Medium Impact / Low-Medium Effort

#### 4. Server Groups / Tags
- **Problem**: Users with many servers (e.g., 5-10) for different purposes (work, personal, development, production) need organization. Currently all servers are listed flat.
- **User benefit**: Logical grouping of servers; menu shows only relevant servers for the task at hand; cleaner UX.
- **Implementation approach**:
  - Add `tags?: string[]` field to `LlamaServer` interface (optional, backward-compatible)
  - Update interactive menu to show tags badges next to server names
  - Add `/llama-chooser config tag <name> <tag>` to add tags to servers
  - Filter server menu by tag
  - Est effort: 300-400 lines, interface change + menu updates
  - API impact: Optional `tags` field on `LlamaServer`; new CLI subcommand
  - Compatibility: Fully backward-compatible (optional field)

#### 5. Context Window Auto-Detection & Recommendations
- **Problem**: Users set `contextOverride` manually, not knowing the optimal value for their model/quantization. Model IDs contain quantization info but context recommendations are opaque.
- **User benefit**: Out-of-the-box optimal context windows; learn which contexts work best for each quantization; avoids "model overloaded" errors.
- **Implementation approach**:
  - Add a `/llama-chooser config set-ctx-rec <name>` that suggests context size based on model quant (using a lookup table: Q4_K_M → 32K, Q5_K_M → 16K, etc.)
  - Or: Auto-detect from model metadata when fetching models
  - Display recommended context in server detail view
  - Est effort: 200-300 lines, new `set-ctx-rec` subcommand + quantization-to-context lookup
  - API impact: New CLI subcommand
  - Compatibility: Fully backward-compatible

#### 6. Server Status Tooltip / Hover Details
- **Problem**: In the interactive menu, server labels show only `🟢/🔴 ✓/✗ host:port`. No information about when they were last pinged, model count, or latency.
- **User benefit**: At-a-glance server health context without selecting into detail view; faster diagnosis of stale servers.
- **Implementation approach**:
  - Extend `showServerMenu` to include more info in labels (e.g., "🟢 ✓ 12 models — last ping 20s ago")
  - Or: Add a secondary info line shown on cursor hover (if Pi UI supports it)
  - Reuse existing `modelCache` and `pingCache` data
  - Est effort: 150-250 lines, menu label enhancement
  - API impact: UI text change only
  - Compatibility: Fully backward-compatible

---

### P2: Lower Impact / Higher Effort

#### 7. Proxy Support for Server Connections
- **Problem**: Some users need to route llama.cpp server traffic through an HTTP proxy (e.g., corporate network, SSH tunneling).
- **User benefit**: Works in restricted networks; no need to expose servers directly.
- **Implementation approach**:
  - Add `proxy?: string` field to `ServerEndpoint` (e.g., "http://proxy:8080")
  - Pass proxy URL through `fetchJson` / `pingServer` calls via `proxy` option in fetch
  - Update `validateServerArgs` to accept/proxy-validate proxy URLs
  - Est effort: 350-500 lines, touches multiple functions across `helper.ts` and `index.ts`
  - API impact: New optional `proxy` field; could affect existing serializations
  - Compatibility: Mostly backward-compatible (optional field), but may need migration for existing configs

#### 8. Usage Analytics / Model Popularity Tracking
- **Problem**: No visibility into which models are actually being used vs. which are just available. Users keep models they never use, or remove models they actually need.
- **User benefit**: Data-driven decisions about which servers/models to keep; identify underutilized resources.
- **Implementation approach**:
  - Add optional usage counting when models are selected/used via Pi's usage tracking
  - Periodic report: `/llama-chooser stats` showing most-used models, servers, quantizations
  - Store counts in the server JSON alongside existing data
  - Est effort: 400-600 lines, significant new infrastructure (usage tracking, stats command, data storage)
  - API impact: New data fields, new CLI command
  - Compatibility: Requires opt-in; existing configs unaffected

#### 9. drag-and-drop Server Reordering in Menu
- **Problem**: Server order in the interactive menu is alphabetical by name. No way to prioritize frequently-used servers.
- **User benefit**: Frequently-used servers appear first; faster selection.
- **Implementation approach**:
  - Add `order?: number` field to `LlamaServer` (lower numbers = higher priority)
  - Sort servers by `order` then name in menu
  - Add `/llama-chooser config order <name> <number>` subcommand
  - Est effort: 250-350 lines, order field + sorting + CLI subcommand
  - API impact: New optional field + CLI subcommand
  - Compatibility: Backward-compatible (default order = 0, alphabetical sort)

---

## Summary Priority Matrix

| Feature | Impact | Effort | API Break? | Lines |
|---------|--------|--------|------------|-------|
| Auto server health | High | Medium | No | 200-300 |
| Import/export configs | High | Low-Med | No | 150-200 |
| Model search/filter | Medium | Medium | No | 250-350 |
| Server groups/tags | Medium | Medium | No (optional) | 300-400 |
| Auto context detection | Medium | Low-Med | No | 200-300 |
| Server status tooltips | Low | Low | No | 150-250 |
| Proxy support | Low | High | Partly | 350-500 |
| Usage analytics | Low | Very High | No (opt-in) | 400-600 |
| Server reordering | Low | Low-Med | No (optional) | 250-350 |

**Recommendation**: Start with P0 items (1-3) as they provide immediate user value with minimal risk. P1 items (4-6) are also good additions while the codebase is being refactored. Avoid P2 proxy/analytics until the core architecture is stabilized.