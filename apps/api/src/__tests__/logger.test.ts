import { afterEach, describe, expect, it, vi } from "vitest";

import { Logger, withLogContext } from "../lib/logger";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("structured logger", () => {
	it("redacts sensitive values and emits JSON", () => {
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		const testLogger = new Logger();

		testLogger.info("Testing redaction", {
			event: "test.redaction",
			component: "worker",
			code: "oauth-code",
			accessToken: "secret-access-token",
			refreshToken: "secret-refresh-token",
			authorization: "Bearer super-secret",
			userInput: "spotify:track:123",
			rawBody: '{"super":"secret"}',
			error: new Error("boom"),
		});

		expect(infoSpy).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(infoSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;

		expect(payload.event).toBe("test.redaction");
		expect(payload.access_token).toBe("[REDACTED]");
		expect(payload.refresh_token).toBe("[REDACTED]");
		expect(payload.authorization).toBe("[REDACTED]");
		expect(payload.code).toBeUndefined();
		expect(payload.input_length).toBe("spotify:track:123".length);
		expect(payload.body_size_bytes).toBe('{"super":"secret"}'.length);
		expect(payload.error_message).toBe("boom");
	});

	it("merges async context into child logger output", () => {
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
		const testLogger = new Logger().child({ component: "route", route: "/health" });

		withLogContext(
			{
				request_id: "req-123",
				trace_id: "trace-123",
			},
			() => {
				testLogger.info("Health request completed", {
					event: "http.request.completed",
					status_code: 200,
				});
			},
		);

		expect(infoSpy).toHaveBeenCalledTimes(1);
		const payload = JSON.parse(infoSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;

		expect(payload.request_id).toBe("req-123");
		expect(payload.trace_id).toBe("trace-123");
		expect(payload.route).toBe("/health");
		expect(payload.status_code).toBe(200);
	});
});
