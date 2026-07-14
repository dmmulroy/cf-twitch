import { Result } from "better-result";
import { describe, expect, it } from "vite-plus/test";

import {
	ChatCommandEngine,
	ChatCommandSendError,
	chatTextResponse,
} from "../../../lib/chat-command";
import {
	FakeChatSender,
	FakeCommandCatalog,
	FakeMetrics,
	FixedClock,
	NullLogger,
	makeCommand,
	noHandlers,
} from "./fakes";

import type { ChatCommandInput, ComputedCommandHandler } from "../../../lib/chat-command";

function makeInput(
	text: string,
	permission: ChatCommandInput["viewer"]["permission"] = "everyone",
) {
	return {
		messageId: "msg-1",
		text,
		receivedAt: "2026-01-01T00:00:00.000Z",
		viewer: {
			userId: "user-1",
			displayName: "Viewer",
			permission,
		},
	} satisfies ChatCommandInput;
}

function makeEngine(options?: {
	catalog?: FakeCommandCatalog;
	sender?: FakeChatSender;
	metrics?: FakeMetrics;
	handlers?: Record<string, ComputedCommandHandler>;
}) {
	const catalog = options?.catalog ?? new FakeCommandCatalog();
	const sender = options?.sender ?? new FakeChatSender();
	const metrics = options?.metrics ?? new FakeMetrics();
	const engine = new ChatCommandEngine(
		catalog,
		sender,
		metrics,
		options?.handlers ?? noHandlers(),
		new FixedClock(new Date("2026-01-01T05:00:00.000Z")),
		new NullLogger(),
	);
	return { engine, catalog, sender, metrics };
}

describe("ChatCommandEngine", () => {
	it("ignores messages that are not commands", async () => {
		const { engine, sender } = makeEngine();

		const result = await engine.execute(makeInput("hello chat"));

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.value).toEqual({ _tag: "ChatCommandIgnored", reason: "not_command" });
		}
		expect(sender.sent).toEqual([]);
	});

	it("ignores unknown commands", async () => {
		const { engine, sender, metrics } = makeEngine();

		const result = await engine.execute(makeInput("!doesnotexist"));

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.value).toEqual({
				_tag: "ChatCommandIgnored",
				reason: "unknown_command",
				commandName: "doesnotexist",
			});
		}
		expect(sender.sent).toEqual([]);
		expect(metrics.written[0]?.status).toBe("ignored");
	});

	it("ignores disabled commands", async () => {
		const catalog = new FakeCommandCatalog();
		catalog.commands.set("time", makeCommand({ name: "time", enabled: false }));
		const { engine, sender } = makeEngine({ catalog });

		const result = await engine.execute(makeInput("!time"));

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.value).toEqual({
				_tag: "ChatCommandIgnored",
				reason: "disabled",
				commandName: "time",
			});
		}
		expect(sender.sent).toEqual([]);
	});

	it("ignores commands when the viewer lacks permission", async () => {
		const catalog = new FakeCommandCatalog();
		catalog.commands.set("modsonly", makeCommand({ name: "modsonly", permission: "moderator" }));
		const { engine, sender } = makeEngine({ catalog });

		const result = await engine.execute(makeInput("!modsonly", "vip"));

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.value).toEqual({
				_tag: "ChatCommandIgnored",
				reason: "permission_denied",
				commandName: "modsonly",
			});
		}
		expect(sender.sent).toEqual([]);
	});

	it("sends a computed command response", async () => {
		const catalog = new FakeCommandCatalog();
		catalog.commands.set("time", makeCommand({ name: "time", handlerKey: "time" }));
		const handler = {
			async handle() {
				return Result.ok(chatTextResponse("Current time is: 12:00:00 AM EST"));
			},
		} satisfies ComputedCommandHandler;
		const { engine, sender, metrics } = makeEngine({ catalog, handlers: { time: handler } });

		const result = await engine.execute(makeInput("!time"));

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.value).toEqual({
				_tag: "ChatCommandCompleted",
				commandName: "time",
				responseSent: true,
			});
		}
		expect(sender.sent).toEqual(["Current time is: 12:00:00 AM EST"]);
		expect(metrics.written[0]?.status).toBe("success");
	});

	it("returns ChatCommandSendError when sending the response fails", async () => {
		const catalog = new FakeCommandCatalog();
		catalog.commands.set("time", makeCommand({ name: "time", handlerKey: "time" }));
		const sender = new FakeChatSender();
		sender.error = new Error("Twitch unavailable");
		const handler = {
			async handle() {
				return Result.ok(chatTextResponse("Current time is: 12:00:00 AM EST"));
			},
		} satisfies ComputedCommandHandler;
		const { engine, metrics } = makeEngine({ catalog, sender, handlers: { time: handler } });

		const result = await engine.execute(makeInput("!time"));

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(ChatCommandSendError.is(result.error)).toBe(true);
		}
		expect(metrics.written[0]?.status).toBe("error");
	});
});
