/**
 * Derives a stable UUID from a saga identity for replay-safe domain event publication.
 * The UUID is an identity projection, not a random or cryptographic authorization token.
 */
export async function deriveSagaEventId(sagaId: string): Promise<string> {
	const digest = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`cf-twitch:saga-event:${sagaId}`)),
	);
	const bytes = digest.slice(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
