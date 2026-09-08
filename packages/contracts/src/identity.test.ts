import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { FastCheck } from "effect/testing";
import { IsoTimestamp } from "./identity.ts";

const parseIsoTimestamp = Schema.decodeEffect(IsoTimestamp);
const parseCalendarTimestamp = Schema.decodeUnknownOption(IsoTimestamp);

describe("ISO timestamp calendar compatibility", () => {
  it("accepts every generated UTC instant with its explicit offset", () => {
    FastCheck.assert(
      FastCheck.property(
        FastCheck.integer({ min: 0, max: 4_102_444_800_000 }),
        (epochMilliseconds) => {
          const timestamp = new Date(epochMilliseconds).toISOString();
          expect(Effect.runSync(parseIsoTimestamp(timestamp))).toBe(timestamp);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("preserves minute-precision instants accepted by the public API", () => {
    for (const timestamp of ["2026-01-01T12:30Z", "2026-01-01T12:30+05:30"]) {
      expect(Effect.runSync(parseIsoTimestamp(timestamp))).toBe(timestamp);
    }
    for (const timestamp of ["2026-01-01T12Z", "2026-01-01T12:30", "2025-02-29T12:30Z"]) {
      expect(parseCalendarTimestamp(timestamp)._tag).toBe("None");
    }
  });

  it("rejects normalized impossible calendar dates instead of silently rolling into another month", () => {
    for (const timestamp of [
      "2025-02-29T12:00:00Z",
      "2100-02-29T12:00:00Z",
      "2026-04-31T12:00:00Z",
      "2026-02-30T12:00:00+03:00",
    ]) {
      expect(parseCalendarTimestamp(timestamp)._tag).toBe("None");
    }
    expect(parseCalendarTimestamp("2000-02-29T12:00:00+03:00")._tag).toBe("Some");
    expect(parseCalendarTimestamp("2024-02-29T12:00:00-05:30")._tag).toBe("Some");
  });
});
