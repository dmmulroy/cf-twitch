/** RPC stub shape exposed by Agent-based Durable Objects before their name is initialized. */
export type DurableObjectAgentStub = Readonly<{
	fetch?: (request: Request) => Promise<Response>;
	setName?: (name: string) => Promise<unknown>;
}>;

/** Initializes an Agent through PartyServer's bootstrap route with an RPC fallback. */
export async function initializeDurableObjectAgentStub<T extends DurableObjectAgentStub>(
	stub: T,
	name: string,
): Promise<T> {
	if (stub.setName === undefined) return stub;

	if (stub.fetch !== undefined) {
		try {
			const request = new Request("http://durable-object/cdn-cgi/partyserver/set-name/", {
				headers: { "x-partykit-room": name },
			});
			const response = await stub.fetch(request);
			await response.text();
			if (response.ok) return stub;
		} catch {
			// RPC initialization below is the compatibility fallback for non-PartyServer stubs.
		}
	}

	await stub.setName(name);
	return stub;
}
