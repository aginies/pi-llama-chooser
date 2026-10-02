/**
 * Speed tracker for llama-chooser.
 *
 * Measures prefill and generation speed from Pi's stream events and displays
 * the rates in the footer/status line via ctx.ui.setStatus().
 *
 * Footer format (compact, coexists with other extensions):
 *   ⚡ {prefill} t/s 🔥 {gen} t/s
 *
 * Integration: the extension subscribes to Pi events and delegates to this
 * module. This module owns the measurement logic and the footer rendering.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

// =============================================================================
// Constants
// =============================================================================

/** Key used for the footer status line (unique per extension). */
export const STATUS_KEY = "llama-chooser-speed";

/** Max time between footer updates while a stream is live.
 * The generation rate is a moving average over GEN_WINDOW_MS (1.5s), so it
 * changes slowly — 2 updates/sec is smooth enough and avoids footer churn. */
const RENDER_THROTTLE_MS = 500;
/** Moving window used for the generation rate. */
const GEN_WINDOW_MS = 1_500;
/** Minimum window span before a rate is trusted (avoid startup spikes). */
const GEN_MIN_SPAN_MS = 300;
/** Minimum prefill span (s) before a prefill rate is computed. */
const PREFILL_MIN_SPAN_S = 0.05;

const DELTA_EVENT_TYPES = new Set<string>([
	"text_delta",
	"thinking_delta",
	"toolcall_delta",
]);

// =============================================================================
// Types
// =============================================================================

interface Sample {
	ts: number;
	n: number;
}

type SpeedState = "idle" | "prefill" | "streaming" | "done";

export interface SpeedDeps {
	/** Whether the extension is still active (post-shutdown guard). */
	isActive: () => boolean;
	/** Whether the ctx has a UI (with stale-ctx safety). */
	hasUI: (ctx: ExtensionContext | undefined) => ctx is ExtensionContext;
	/** Whether the current session model belongs to this provider. */
	isOurs: (ctx: ExtensionContext | undefined) => boolean;
	/** Whether the widget is enabled in settings. */
	enabled: () => boolean;
}

// =============================================================================
// Helpers
// =============================================================================

function formatRate(rate: number): string {
	return rate >= 100 ? String(Math.round(rate)) : rate.toFixed(1);
}

/**
 * 6-stop gradient color for TPS display.
 * Interpolates through ANSI 256-color codes from red (0%) to cyan (100%+).
 *
 * Stops: red → orange → yellow → lime → spring-green → cyan
 */
function rateColor(rate: number, kind: "prefill" | "gen"): string {
	const maxRate = kind === "prefill" ? 2000 : 100;
	const t = Math.min(rate / maxRate, 1);

	// 6 color stops (R, G, B in 0-255 space) — spaced for visual distinction
	const stops = [
		{ r: 255, g: 0, b: 0 },      // 0%   — red
		{ r: 255, g: 100, b: 0 },    // 20%  — orange
		{ r: 255, g: 200, b: 0 },    // 40%  — yellow
		{ r: 50, g: 255, b: 50 },    // 60%  — lime
		{ r: 0, g: 255, b: 255 },    // 80%  — cyan
		{ r: 148, g: 0, b: 211 },      // 100% — dark violet
	];

	// Clamp t to [0, 1] and find which segment we're in
	const clampedT = Math.max(0, Math.min(t, 1));
	const segment = Math.min(Math.floor(clampedT * 5), 4); // 0-4
	const segStart = segment / 5;
	const segEnd = (segment + 1) / 5;
	const localT = (clampedT - segStart) / (segEnd - segStart);

	const c0 = stops[segment];
	const c1 = stops[segment + 1];
	const r = Math.round(c0.r + (c1.r - c0.r) * localT);
	const g = Math.round(c0.g + (c1.g - c0.g) * localT);
	const b = Math.round(c0.b + (c1.b - c0.b) * localT);

	return `\x1b[38;2;${r};${g};${b}m`;
}

// =============================================================================
// Speed tracker
// =============================================================================

export function createSpeedTracker(deps: SpeedDeps) {
	let state: SpeedState = "idle";
	let prefillStart: number | undefined;
	let firstTokenAt: number | undefined;
	let tokenCount = 0;
	let samples: Sample[] = [];
	let lastPrefillTps: number | undefined;
	let lastGenTps: number | undefined;
	let lastRenderAt = 0;
	let statusActive = false;
	let lastSentText = "";
	/** Most recent live ctx (used when a callback arrives without one). */
	let lastCtx: ExtensionContext | undefined;

	function rememberCtx(ctx: ExtensionContext | undefined): void {
		if (ctx && deps.hasUI(ctx)) lastCtx = ctx;
	}

	function targetCtx(ctx: ExtensionContext | undefined): ExtensionContext | undefined {
		if (ctx && deps.hasUI(ctx)) return ctx;
		return lastCtx;
	}

	function clearStatus(ctx: ExtensionContext | undefined): void {
		if (!deps.hasUI(ctx) || !statusActive) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// UI may be gone; ignore.
		}
		statusActive = false;
		lastSentText = "";
	}

	function resetInternal(): void {
		state = "idle";
		prefillStart = undefined;
		firstTokenAt = undefined;
		tokenCount = 0;
		samples = [];
		lastGenTps = undefined;
		statusActive = false;
		lastSentText = "";
	}

	/** Moving-window generation rate over the recorded arrival samples. */
	function genRateAt(now: number): number | undefined {
		if (samples.length === 0) return undefined;
		const cutoff = now - GEN_WINDOW_MS;
		while (samples.length > 1 && samples[0].ts < cutoff) samples.shift();
		// Hard cap to prevent unbounded growth during very long generations.
		if (samples.length > 1000) {
			samples = samples.slice(-500);
		}
		const oldest = samples[0];
		const span = now - oldest.ts;
		if (span < GEN_MIN_SPAN_MS) return lastGenTps;
		const tokens = tokenCount - oldest.n;
		if (tokens <= 0) return lastGenTps;
		return tokens / (span / 1000);
	}

	function buildLine(_ctx: ExtensionContext | undefined): string {
		const parts: string[] = [];

		let live: number | undefined;
		if (state === "streaming") {
			live = genRateAt(Date.now());
			if (live !== undefined) lastGenTps = live;
		}
		const gen = live ?? lastGenTps;

		// Prefill
		if (lastPrefillTps !== undefined) {
			parts.push(`${rateColor(lastPrefillTps, "prefill")}⚡${Math.round(lastPrefillTps)}t/s\x1b[0m`);
		} else if (state === "prefill") {
			parts.push("\x1b[33m⚡…\x1b[0m");
		}

		// Generation
		if (gen !== undefined) {
			parts.push(`${rateColor(gen, "gen")}🔥${formatRate(gen)}t/s\x1b[0m`);
		} else if (state === "prefill" || state === "streaming") {
			parts.push("\x1b[90m🔥…\x1b[0m");
		}

		// Idle: nothing to show
		if (state === "idle" && parts.length === 0) {
			parts.push("\x1b[90m⏸\x1b[0m");
		}

		return parts.join(" ");
	}

	function render(ctx: ExtensionContext | undefined, force = false): void {
		if (!deps.isActive() || !deps.enabled()) {
			clearStatus(ctx);
			return;
		}
		if (!deps.hasUI(ctx) || !deps.isOurs(ctx)) return;
		const line = buildLine(ctx);
		if (!force && Date.now() - lastRenderAt < RENDER_THROTTLE_MS) return;
		lastRenderAt = Date.now();
		if (line === lastSentText && statusActive) return;
		lastSentText = line;
		try {
			ctx.ui.setStatus(STATUS_KEY, line);
			statusActive = true;
		} catch {
			// UI may be gone; ignore.
		}
	}

	return {
		/** Called when a new LLM call starts (prefill pending). */
		onRequest(ctx: ExtensionContext | undefined): void {
			if (!deps.isActive()) return;
			rememberCtx(ctx);
			if (!deps.isOurs(ctx) || !deps.enabled()) {
				clearStatus(targetCtx(ctx));
				resetInternal();
				return;
			}
			state = "prefill";
			prefillStart = Date.now();
			firstTokenAt = undefined;
			tokenCount = 0;
			samples = [{ ts: Date.now(), n: 0 }];
			render(ctx, true);
		},

		/** Called for each token stream event. */
		onToken(ctx: ExtensionContext | undefined, ev: AssistantMessageEvent): void {
			if (!deps.isActive() || !deps.enabled()) return;
			rememberCtx(ctx);
			if (!deps.isOurs(ctx)) return;
			if (ev.type === "error") {
				state = "done";
				render(ctx, true);
				return;
			}
			if (!DELTA_EVENT_TYPES.has(ev.type)) return;
			if (state === "prefill" || state === "idle") {
				state = "streaming";
				if (firstTokenAt === undefined) firstTokenAt = Date.now();
			}
			tokenCount++;
			samples.push({ ts: Date.now(), n: tokenCount });
			render(ctx);
		},

		/** Called when the assistant message ends. */
		onMessageEnd(ctx: ExtensionContext | undefined, message: { role?: string; usage?: { input?: number } }): void {
			if (!deps.isActive() || !deps.enabled()) return;
			rememberCtx(ctx);
			if (!deps.isOurs(ctx)) return;
			if (message.role !== "assistant") return;
			const promptTokens = message.usage?.input;
			if (
				promptTokens !== undefined &&
				promptTokens > 0 &&
				prefillStart !== undefined &&
				firstTokenAt !== undefined
			) {
				const spanS = (firstTokenAt - prefillStart) / 1000;
				if (spanS >= PREFILL_MIN_SPAN_S) {
					lastPrefillTps = promptTokens / spanS;
				}
			}
			state = "done";
			render(ctx, true);
		},

		/** Called when the turn ends. */
		onTurnEnd(ctx: ExtensionContext | undefined): void {
			rememberCtx(ctx);
			if (!deps.isActive() || !deps.enabled()) {
				clearStatus(targetCtx(ctx));
				resetInternal();
				return;
			}
			if (!deps.isOurs(ctx)) {
				clearStatus(targetCtx(ctx));
				resetInternal();
				return;
			}
			state = "idle";
			tokenCount = 0;
			samples = [];
			render(ctx, true);
		},

		/** Render the current (idle) state on session start / model select. */
		start(ctx: ExtensionContext | undefined): void {
			if (!deps.isActive()) return;
			rememberCtx(ctx);
			const target = targetCtx(ctx);
			if (!deps.enabled() || !target || !deps.isOurs(target)) {
				clearStatus(targetCtx(ctx));
				return;
			}
			state = "idle";
			render(target, true);
		},

		/** Hide the footer metrics (session shutdown, toggle off, foreign model). */
		stop(ctx: ExtensionContext | undefined): void {
			clearStatus(targetCtx(ctx));
			resetInternal();
		},
	};
}

export type SpeedTracker = ReturnType<typeof createSpeedTracker>;
