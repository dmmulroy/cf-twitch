/** Explicit randomness capability for fair Keyboard Raffle number draws. */
export interface RaffleRandom {
	/** Draws an unpredictable integer in the inclusive range without modulo bias. */
	drawInclusiveInteger(minimum: number, maximum: number): number;
}

/** Cryptographic Keyboard Raffle randomness implemented with rejection sampling. */
export class CryptoRaffleRandom implements RaffleRandom {
	/** Draws an unpredictable integer in the inclusive range without modulo bias. */
	drawInclusiveInteger(minimum: number, maximum: number): number {
		if (!Number.isSafeInteger(minimum) || !Number.isSafeInteger(maximum) || maximum < minimum) {
			throw new Error("Raffle random range invalid");
		}
		const range = maximum - minimum + 1;
		if (range > 0x1_0000_0000) {
			throw new Error("Raffle random range exceeds Uint32 capacity");
		}
		const acceptedUpperBound = Math.floor(0x1_0000_0000 / range) * range;
		const randomWord = new Uint32Array(1);
		do {
			crypto.getRandomValues(randomWord);
		} while ((randomWord[0] ?? acceptedUpperBound) >= acceptedUpperBound);
		return minimum + ((randomWord[0] ?? 0) % range);
	}
}
