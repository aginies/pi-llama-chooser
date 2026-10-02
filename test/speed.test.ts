import { describe, it, expect } from "vitest";
import { createSpeedTracker, STATUS_KEY } from "../src/speed";

describe("STATUS_KEY", () => {
	it("has the expected value", () => {
		expect(STATUS_KEY).toBe("llama-chooser-speed");
	});
});

describe("createSpeedTracker", () => {
	const createDeps = (overrides = {}): import("../src/speed").SpeedDeps => ({
		isActive: () => true,
		hasUI: () => false,
		isOurs: () => true,
		enabled: () => true,
		...overrides,
	});

	it("creates a tracker with idle state", () => {
		const tracker = createSpeedTracker(createDeps());
		expect(tracker).toBeDefined();
		expect(tracker.onRequest).toBeDefined();
		expect(tracker.onToken).toBeDefined();
		expect(tracker.onMessageEnd).toBeDefined();
		expect(tracker.onTurnEnd).toBeDefined();
		expect(tracker.start).toBeDefined();
		expect(tracker.stop).toBeDefined();
	});

	it("does nothing when inactive", () => {
		const deps = createDeps({ isActive: () => false });
		const tracker = createSpeedTracker(deps);
		// Should not throw
		expect(() => tracker.onRequest(undefined)).not.toThrow();
		expect(() => tracker.onToken(undefined, { type: "text_delta" } as any)).not.toThrow();
		expect(() => tracker.onMessageEnd(undefined, {} as any)).not.toThrow();
		expect(() => tracker.onTurnEnd(undefined)).not.toThrow();
		expect(() => tracker.start(undefined)).not.toThrow();
		expect(() => tracker.stop(undefined)).not.toThrow();
	});

	it("does nothing when disabled", () => {
		const deps = createDeps({ enabled: () => false });
		const tracker = createSpeedTracker(deps);
		expect(() => tracker.onRequest(undefined)).not.toThrow();
		expect(() => tracker.onToken(undefined, { type: "text_delta" } as any)).not.toThrow();
	});

	it("does nothing for non-ours contexts", () => {
		const deps = createDeps({ isOurs: () => false });
		const tracker = createSpeedTracker(deps);
		expect(() => tracker.onRequest(undefined)).not.toThrow();
		expect(() => tracker.onToken(undefined, { type: "text_delta" } as any)).not.toThrow();
	});

	it("handles message_start (onRequest)", () => {
		const deps = createDeps();
		const tracker = createSpeedTracker(deps);
		// Should not throw
		expect(() => tracker.onRequest(undefined)).not.toThrow();
	});

	it("handles various event types in onToken", () => {
		const deps = createDeps();
		const tracker = createSpeedTracker(deps);
		tracker.onRequest(undefined);

		// Delta types should be handled
		expect(() =>
			tracker.onToken(undefined, { type: "text_delta" } as any),
		).not.toThrow();
		expect(() =>
			tracker.onToken(undefined, { type: "thinking_delta" } as any),
		).not.toThrow();
		expect(() =>
			tracker.onToken(undefined, { type: "toolcall_delta" } as any),
		).not.toThrow();

		// Error type should be handled
		expect(() =>
			tracker.onToken(undefined, { type: "error" } as any),
		).not.toThrow();

		// Other types should be ignored (no throw)
		expect(() =>
			tracker.onToken(undefined, { type: "some_other_type" } as any),
		).not.toThrow();
	});

	it("handles message_end (onMessageEnd)", () => {
		const deps = createDeps();
		const tracker = createSpeedTracker(deps);
		tracker.onRequest(undefined);
		tracker.onToken(undefined, { type: "text_delta" } as any);

		expect(() =>
			tracker.onMessageEnd(undefined, { role: "assistant" } as any),
		).not.toThrow();

		// Non-assistant messages should be ignored (no throw)
		expect(() =>
			tracker.onMessageEnd(undefined, { role: "user" } as any),
		).not.toThrow();
	});

	it("handles turn_end (onTurnEnd)", () => {
		const deps = createDeps();
		const tracker = createSpeedTracker(deps);
		tracker.onRequest(undefined);

		expect(() => tracker.onTurnEnd(undefined)).not.toThrow();
	});

	it("handles start and stop", () => {
		const deps = createDeps();
		const tracker = createSpeedTracker(deps);

		expect(() => tracker.start(undefined)).not.toThrow();
		expect(() => tracker.stop(undefined)).not.toThrow();
	});

	it("handles undefined context gracefully", () => {
		const deps = createDeps();
		const tracker = createSpeedTracker(deps);

		expect(() => tracker.onRequest(undefined)).not.toThrow();
		expect(() => tracker.onToken(undefined, { type: "text_delta" } as any)).not.toThrow();
		expect(() => tracker.onMessageEnd(undefined, {} as any)).not.toThrow();
		expect(() => tracker.onTurnEnd(undefined)).not.toThrow();
		expect(() => tracker.start(undefined)).not.toThrow();
		expect(() => tracker.stop(undefined)).not.toThrow();
	});
});
