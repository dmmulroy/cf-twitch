import { relative, resolve, sep } from "node:path";
import { Project } from "ts-morph";

const packageRoot = resolve(import.meta.dirname, "../..");
const sourceRoot = resolve(packageRoot, "src");
const project = new Project({ tsConfigFilePath: resolve(packageRoot, "tsconfig.json") });
const productionFiles = project
	.getSourceFiles(resolve(sourceRoot, "**/*.ts"))
	.filter((sourceFile) => !sourceFile.getFilePath().includes(`${sep}__tests__${sep}`))
	.filter((sourceFile) => !sourceFile.getBaseName().endsWith(".test.ts"));

function repositoryPath(filePath: string): string {
	return relative(packageRoot, filePath).split(sep).join("/");
}

const violations: string[] = [];
for (const sourceFile of productionFiles) {
	const path = repositoryPath(sourceFile.getFilePath());
	const source = sourceFile.getFullText();
	const isCloudflareOwner =
		path === "src/index.ts" ||
		path === "src/cloudflare-secret-bindings.d.ts" ||
		path === "src/lib/saga-host.ts" ||
		path.startsWith("src/adapters/cloudflare/") ||
		path.startsWith("src/durable-objects/");

	for (const declaration of sourceFile.getImportDeclarations()) {
		const moduleName = declaration.getModuleSpecifierValue();
		const isHonoOwner =
			path === "src/index.ts" ||
			path === "src/lib/request-context.ts" ||
			path.startsWith("src/adapters/http/");
		if (moduleName === "hono" && !isHonoOwner) {
			violations.push(`${path}: Hono import is outside an HTTP adapter`);
		}
		if (moduleName === "cloudflare:workers" && !isCloudflareOwner) {
			violations.push(`${path}: Cloudflare runtime import is outside a runtime owner`);
		}
		const importsAmbientWorkerEnvironment = declaration
			.getNamedImports()
			.some((namedImport) => namedImport.getName() === "env");
		if (moduleName === "cloudflare:workers" && importsAmbientWorkerEnvironment) {
			violations.push(`${path}: ambient Cloudflare Worker env import is forbidden`);
		}

		const importsGlobalStubLocator = declaration
			.getNamedImports()
			.some((namedImport) => namedImport.getName() === "getStub");
		if (importsGlobalStubLocator) {
			violations.push(`${path}: ambient getStub import is forbidden`);
		}
	}

	if (/\b(?:Cloudflare\.)?Env\b/u.test(source) && !isCloudflareOwner) {
		violations.push(`${path}: generated Env reference is outside a runtime owner`);
	}
	if (/\bthis\.env\b/u.test(source)) {
		violations.push(`${path}: inherited ambient env access is forbidden after construction`);
	}

	const isApplicationCode =
		path.startsWith("src/application/") ||
		path.startsWith("src/domain/") ||
		path.startsWith("src/capabilities/") ||
		path.startsWith("src/lib/chat-command/");
	if (isApplicationCode && /\b[A-Z][A-Z0-9_]*(?:_DO|_BUCKET|_KV|_QUEUE)\b/u.test(source)) {
		violations.push(`${path}: Cloudflare binding name is forbidden in application code`);
	}
	if (
		(path.startsWith("src/capabilities/") || path.startsWith("src/domain/")) &&
		/\b(?:Promise|Result)\s*<\s*unknown\b/u.test(source)
	) {
		violations.push(`${path}: application contract returns unknown boundary data`);
	}

	const isHttpAdapter = path.startsWith("src/adapters/http/");
	if (isHttpAdapter && /\.env\b/u.test(source)) {
		violations.push(`${path}: HTTP adapter binding lookup is forbidden`);
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
