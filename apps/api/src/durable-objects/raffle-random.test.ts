import { describe, expect, it } from "vite-plus/test";

import { CryptoRaffleRandom } from "./raffle-random";

describe("CryptoRaffleRandom", () => {
	it("draws only integers inside the inclusive Keyboard Raffle range", () => {
		const random = new CryptoRaffleRandom();
		for (let draw = 0; draw < 1_000; draw += 1) {
			const value = random.drawInclusiveInteger(1, 10_000);
			expect(Number.isInteger(value)).toBe(true);
			expect(value).toBeGreaterThanOrEqual(1);
			expect(value).toBeLessThanOrEqual(10_000);
		}
	});

	it("returns the sole value in a one-number range", () => {
		expect(new CryptoRaffleRandom().drawInclusiveInteger(42, 42)).toBe(42);
	});
});
