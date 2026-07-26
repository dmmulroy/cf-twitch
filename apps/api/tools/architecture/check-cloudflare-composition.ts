import { relative, resolve, sep } from "node:path";
import { Project } from "ts-morph";

const packageRoot = resolve(import.meta.dirname, "../..");
const sourceRoot = resolve(packageRoot, "src");
const project = new Project({ tsConfigFilePath: resolve(packageRoot, "tsconfig.json") });
const productionFiles = project
	.getSourceFiles(resolve(sourceRoot, "**/*.ts"))
	.filter((sourceFile) => !sourceFile.getFilePath().includes(`${sep}__tests__${sep}`))
	.filter((sourceFile) => !sourceFile.getBaseName().endsWith(".test.ts"));

const temporaryRouteBindingLookupAllowlist = new Set([
	"src/routes/admin.ts",
	"src/routes/api.ts",
	"src/routes/eventsub-setup.ts",
	"src/routes/oauth.ts",
	"src/routes/webhooks.ts",
]);

const temporaryGlobalStubLocatorAllowlist = new Set([
	"src/durable-objects/achievements-do.ts",
	"src/durable-objects/event-bus-do.ts",
	"src/durable-objects/eventsub-webhook-do.ts",
	"src/durable-objects/keyboard-raffle-saga-do.ts",
	"src/durable-objects/song-request-saga-do.ts",
	"src/durable-objects/stream-lifecycle-do.ts",
	"src/lib/chat-command/catalog.ts",
	"src/lib/chat-command/handlers/achievements.ts",
	"src/lib/chat-command/handlers/raffle-leaderboard.ts",
	"src/lib/chat-command/handlers/stats.ts",
	"src/routes/admin.ts",
	"src/routes/api.ts",
	"src/routes/oauth.ts",
	"src/routes/stats.ts",
	"src/routes/webhooks.ts",
	"src/services/spotify-service.ts",
	"src/services/twitch-service.ts",
]);

const temporaryHonoImportAllowlist = new Set(["src/lib/cache.ts", "src/lib/request-context.ts"]);

const temporaryCloudflareRuntimeImportAllowlist = new Set([
	"src/lib/durable-objects.ts",
	"src/lib/song-queue-client.ts",
]);

const temporaryGeneratedEnvAllowlist = new Set([
	"src/cloudflare-secret-bindings.d.ts",
	"src/lib/chat-command/index.ts",
	"src/lib/durable-objects.ts",
	"src/lib/saga-host.ts",
	"src/lib/song-queue-client.ts",
	"src/routes/admin.ts",
	"src/routes/api.ts",
	"src/routes/eventsub-setup.ts",
	"src/routes/oauth.ts",
	"src/routes/overlay.ts",
	"src/routes/stats.ts",
	"src/routes/webhooks.ts",
	"src/services/spotify-service.ts",
	"src/services/twitch-service.ts",
]);

const temporaryApplicationBindingNameAllowlist = new Set([
	"src/lib/chat-command/catalog.ts",
	"src/lib/chat-command/handlers/achievements.ts",
	"src/lib/chat-command/handlers/raffle-leaderboard.ts",
	"src/lib/chat-command/handlers/stats.ts",
]);

function repositoryPath(filePath: string): string {
	return relative(packageRoot, filePath).split(sep).join("/");
}

const violations: string[] = [];
for (const sourceFile of productionFiles) {
	const path = repositoryPath(sourceFile.getFilePath());
	const source = sourceFile.getFullText();
	const isCloudflareOwner =
		path === "src/index.ts" ||
		path.startsWith("src/adapters/cloudflare/") ||
		path.startsWith("src/durable-objects/");

	for (const declaration of sourceFile.getImportDeclarations()) {
		const moduleName = declaration.getModuleSpecifierValue();
		const isHonoOwner =
			path === "src/index.ts" ||
			path.startsWith("src/adapters/http/") ||
			path.startsWith("src/routes/");
		if (moduleName === "hono" && !isHonoOwner && !temporaryHonoImportAllowlist.has(path)) {
			violations.push(`${path}: Hono import is outside an HTTP adapter`);
		}
		if (
			moduleName === "cloudflare:workers" &&
			!isCloudflareOwner &&
			!temporaryCloudflareRuntimeImportAllowlist.has(path)
		) {
			violations.push(`${path}: Cloudflare runtime import is outside a runtime owner`);
		}

		const importsGlobalStubLocator = declaration
			.getNamedImports()
			.some((namedImport) => namedImport.getName() === "getStub");
		if (
			importsGlobalStubLocator &&
			!path.startsWith("src/adapters/cloudflare/") &&
			!temporaryGlobalStubLocatorAllowlist.has(path)
		) {
			violations.push(`${path}: getStub import is outside its migration allowlist`);
		}
	}

	if (
		/\b(?:Cloudflare\.)?Env\b/u.test(source) &&
		!isCloudflareOwner &&
		!temporaryGeneratedEnvAllowlist.has(path)
	) {
		violations.push(`${path}: generated Env reference is outside its migration allowlist`);
	}

	const isApplicationCode =
		path.startsWith("src/application/") ||
		path.startsWith("src/domain/") ||
		path.startsWith("src/capabilities/") ||
		path.startsWith("src/lib/chat-command/");
	if (
		isApplicationCode &&
		/\b[A-Z][A-Z0-9_]*(?:_DO|_BUCKET|_KV|_QUEUE)\b/u.test(source) &&
		!temporaryApplicationBindingNameAllowlist.has(path)
	) {
		violations.push(`${path}: Cloudflare binding name is outside its migration allowlist`);
	}

	const isHttpAdapterOrLegacyRoute =
		path.startsWith("src/adapters/http/") || path.startsWith("src/routes/");
	if (
		isHttpAdapterOrLegacyRoute &&
		/\.env\b/u.test(source) &&
		!temporaryRouteBindingLookupAllowlist.has(path)
	) {
		violations.push(`${path}: route binding lookup is outside its migration allowlist`);
	}
}

if (violations.length > 0) {
	process.stderr.write(
		`${["Cloudflare composition architecture violations:", ...violations].join("\n")}\n`,
	);
	process.exitCode = 1;
} else {
	process.stdout.write("Cloudflare composition architecture check passed\n");
}
