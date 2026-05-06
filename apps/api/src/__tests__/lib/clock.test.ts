import { describe, expect, it } from "vitest";

import { SystemClock } from "../../lib/clock";

describe("SystemClock", () => {
	it("resolves valid, invalid, and missing ISO timestamps", () => {
		const clock = new SystemClock(() => new Date("2026-01-22T12:00:00.000Z"));

		expect(clock.resolveIsoTimestamp("2026-01-22T13:30:00.000Z")).toBe("2026-01-22T13:30:00.000Z");
		expect(clock.resolveIsoTimestamp("not-a-date")).toBe("2026-01-22T12:00:00.000Z");
		expect(clock.resolveIsoTimestamp()).toBe("2026-01-22T12:00:00.000Z");
	});

	it("compares timestamp evidence", () => {
		const clock = new SystemClock(() => new Date("2026-01-22T12:00:00.000Z"));
		const earlier = clock.resolveIsoTimestamp("2026-01-22T12:00:00.000Z");
		const later = clock.resolveIsoTimestamp("2026-01-22T13:00:00.000Z");

		expect(clock.isBefore(earlier, later)).toBe(true);
		expect(clock.isBefore(later, earlier)).toBe(false);
	});
});
