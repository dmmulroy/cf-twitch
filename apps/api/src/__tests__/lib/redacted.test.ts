import { describe, expect, it } from "vite-plus/test";

import { redactValue, revealRedactedValue } from "../../lib/redacted";

describe("Redacted", () => {
	it("keeps credential values out of diagnostics and snapshots", () => {
		const credential = redactValue("provider-secret-value");
		const diagnostic = JSON.stringify({ credential, rendered: String(credential) });

		expect(diagnostic).not.toContain("provider-secret-value");
		expect(diagnostic).toContain("[REDACTED]");
		expect(revealRedactedValue(credential)).toBe("provider-secret-value");
	});
});
