/**
 * Cryptographic utilities for secure operations
 */

import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison to prevent timing attacks.
 *
 * Use this instead of `===` when comparing secrets, tokens, or signatures.
 * Direct string comparison leaks timing information that attackers can use
 * to incrementally guess secret values.
 *
 * @param a - First string to compare
 * @param b - Second string to compare
 * @returns true if strings are equal, false otherwise
 */
export function constantTimeEquals(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);

	if (aBytes.length !== bBytes.length) {
		return false;
	}

	return timingSafeEqual(aBytes, bBytes);
}
