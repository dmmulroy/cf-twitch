import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { parseSync, Visitor } from "oxc-parser";

const cfTwitchSourceRoots = [
  "apps/api/scripts",
  "apps/api/src",
  "apps/api/test",
  "packages/contracts/src",
  "packages/shared-infrastructure/src",
] as const;

const forbiddenNewRuntimeDependencies = [
  "agents",
  "better-result",
  "drizzle-orm",
  "hono",
  "zod",
] as const;

const ContractsPackageManifest = Schema.Struct({
  exports: Schema.Struct({
    "./*": Schema.Literal("./src/*.ts"),
  }),
});

const parseContractsPackageManifest = Schema.decodeEffect(
  Schema.fromJsonString(ContractsPackageManifest),
);

const ApiPackageManifest = Schema.Struct({
  dependencies: Schema.Record(Schema.String, Schema.String),
});

const parseApiPackageManifest = Schema.decodeEffect(Schema.fromJsonString(ApiPackageManifest));

interface ArchitectureViolation {
  readonly file: string;
  readonly reason: string;
}

/** Error returned when the workspace breaks one or more architecture rules. */
class CfTwitchArchitectureError extends Schema.TaggedError<CfTwitchArchitectureError>()(
  "CfTwitchArchitectureError",
  {
    operation: Schema.Literals(["verifyCfTwitchArchitecture"]),
    reason: Schema.Literals(["ArchitectureRulesViolated"]),
    /** Each offending file with the rule it breaks. */
    violations: Schema.Array(
      Schema.Struct({
        file: Schema.String,
        reason: Schema.String,
      }),
    ),
  },
) {
  /** Operator guidance listing every violation and how to rerun the check. */
  override get message(): string {
    const details = this.violations
      .map((violation) => `${violation.file}: ${violation.reason}`)
      .join("\n");

    return `CF Twitch architecture verification found rule violations:\n${details}\nFix each listed file and rerun \`pnpm verify\`.`;
  }
}

/** Parsed module specifiers and syntax errors from one TypeScript source file. */
export interface ParsedSourceImports {
  /** Parser diagnostics; a non-empty list means the specifiers may be incomplete. */
  readonly errors: ReadonlyArray<string>;
  /** Static import, re-export, and literal dynamic-import specifiers in source order by kind. */
  readonly specifiers: ReadonlyArray<string>;
}

/**
 * Parses static imports, re-exports, and literal dynamic imports from TypeScript source.
 *
 * @returns The specifiers and any parser diagnostics; syntax errors are reported in `errors`
 *   rather than thrown.
 */
export const parseCfTwitchSourceImports = (file: string, source: string): ParsedSourceImports => {
  const parsed = parseSync(file, source);
  const dynamicSpecifiers: string[] = [];

  const visitor = new Visitor({
    ImportExpression(node) {
      if (node.source.type !== "Literal" || !Schema.is(Schema.String)(node.source.value)) return;
      dynamicSpecifiers.push(node.source.value);
    },
    TSImportType(node) {
      if (node.source.type !== "Literal" || !Schema.is(Schema.String)(node.source.value)) return;
      dynamicSpecifiers.push(node.source.value);
    },
  });

  visitor.visit(parsed.program);

  return {
    errors: parsed.errors.map((error) => error.message),
    specifiers: [
      ...parsed.module.staticImports.map((entry) => entry.moduleRequest.value),
      ...parsed.module.staticExports.flatMap((entry) =>
        entry.entries.flatMap((exportEntry) =>
          exportEntry.moduleRequest === null ? [] : [exportEntry.moduleRequest.value],
        ),
      ),
      ...dynamicSpecifiers,
    ],
  };
};

const listTypeScriptFiles = Effect.fn("CfTwitchArchitecture.listTypeScriptFiles")(function* (
  root: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (!(yield* fileSystem.exists(root))) return [];

  const entries = yield* fileSystem.readDirectory(root, { recursive: true });

  return entries
    .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
    .map((entry) => path.join(root, entry));
});

const inspectCfTwitchSourceText = (
  file: string,
  source: string,
): ReadonlyArray<ArchitectureViolation> => {
  const violations: Array<ArchitectureViolation> = [];

  if (source.includes("vi.mock(") || source.includes("jest.mock(")) {
    violations.push({
      file,
      reason: "Module mocking is forbidden. Provide a real or in-memory service Layer instead.",
    });
  }

  if (source.includes("process.env")) {
    violations.push({
      file,
      reason:
        "Direct process.env access is forbidden. Read environment values through Effect Config.",
    });
  }

  if (source.includes(".rpc(")) {
    violations.push({
      file,
      reason:
        "Durable Object RPC calls are forbidden. Call the Durable Object through its HTTP contract and generated client.",
    });
  }

  if (source.includes("transferredFrom") || source.includes("Alchemy.adopt(")) {
    violations.push({
      file,
      reason:
        "Automatic production resource adoption or transfer is forbidden. Remove it and follow the production cutover gate.",
    });
  }

  return violations;
};

const inspectCfTwitchPackageImport = (
  file: string,
  specifier: string,
): ReadonlyArray<ArchitectureViolation> => {
  const violations: Array<ArchitectureViolation> = [];

  const forbiddenDependency = forbiddenNewRuntimeDependencies.find(
    (dependency) => specifier === dependency || specifier.startsWith(`${dependency}/`),
  );

  if (forbiddenDependency !== undefined) {
    violations.push({
      file,
      reason: `Forbidden legacy dependency import ${specifier}. Replace it with the Effect or Alchemy equivalent.`,
    });
  }

  if (specifier === "@cf-twitch/contracts") {
    violations.push({
      file,
      reason:
        "Bare @cf-twitch/contracts import is forbidden. Import the explicit @cf-twitch/contracts/<concept> subpath.",
    });
  }

  if (file.startsWith("packages/") && specifier.startsWith("@cf-twitch/api")) {
    violations.push({
      file,
      reason:
        "Package import of the API application is forbidden. Move the shared code into a package.",
    });
  }

  if (
    file.startsWith("packages/contracts/") &&
    (specifier === "@cf-twitch/shared-infrastructure" ||
      specifier === "alchemy" ||
      specifier.startsWith("alchemy/") ||
      specifier.startsWith("@cloudflare/") ||
      specifier.startsWith("cloudflare:"))
  ) {
    violations.push({
      file,
      reason: `Portable contracts import infrastructure or Cloudflare module ${specifier}. Move that dependency into the API application or shared-infrastructure.`,
    });
  }

  return violations;
};

const inspectCfTwitchRelativeImport = (
  file: string,
  specifier: string,
  destination: string,
  applicationsRoot: string,
  applicationSource: string,
  featuresSource: string,
  runtimeSource: string,
): ReadonlyArray<ArchitectureViolation> => {
  if (file.startsWith("packages/") && destination.startsWith(applicationsRoot)) {
    return [
      {
        file,
        reason: `Package reaches into an application through ${specifier}. Move the shared code into a package.`,
      },
    ];
  }

  const belongsToFeatureOrRuntime =
    file.startsWith("apps/api/src/features/") || file.startsWith("apps/api/src/runtime/");

  const reachesLegacyApiSource =
    destination.startsWith(applicationSource) &&
    !destination.startsWith(featuresSource) &&
    !destination.startsWith(runtimeSource);

  return belongsToFeatureOrRuntime && reachesLegacyApiSource
    ? [
        {
          file,
          reason: `Feature or runtime source reaches outside the canonical API source roots through ${specifier}. Move the imported code under src/features or src/runtime.`,
        },
      ]
    : [];
};

const inspectCfTwitchSource = Effect.fn("CfTwitchArchitecture.inspectCfTwitchSource")(function* (
  file: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* fileSystem.readFileString(file);
  const parsedImports = parseCfTwitchSourceImports(file, source);

  const violations: Array<ArchitectureViolation> = [
    ...parsedImports.errors.map((error) => ({
      file,
      reason: `TypeScript source could not be parsed: ${error}. Fix the syntax error.`,
    })),
    ...inspectCfTwitchSourceText(file, source),
  ];

  const applicationsRoot = path.resolve("apps");
  const applicationSource = path.resolve("apps/api/src");
  const featuresSource = path.resolve("apps/api/src/features");
  const runtimeSource = path.resolve("apps/api/src/runtime");

  for (const specifier of parsedImports.specifiers) {
    violations.push(...inspectCfTwitchPackageImport(file, specifier));

    if (!specifier.startsWith(".")) continue;
    violations.push(
      ...inspectCfTwitchRelativeImport(
        file,
        specifier,
        path.resolve(path.dirname(file), specifier),
        applicationsRoot,
        applicationSource,
        featuresSource,
        runtimeSource,
      ),
    );
  }

  return violations;
});

const verifyPackageManifests = Effect.fn("CfTwitchArchitecture.verifyPackageManifests")(
  function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    const contractsManifestSource = yield* fileSystem.readFileString(
      "packages/contracts/package.json",
    );

    const apiManifestSource = yield* fileSystem.readFileString("apps/api/package.json");
    const violations: Array<ArchitectureViolation> = [];

    const contractsManifest = yield* parseContractsPackageManifest(contractsManifestSource).pipe(
      Effect.match({ onFailure: () => Option.none(), onSuccess: Option.some }),
    );

    const apiManifest = yield* parseApiPackageManifest(apiManifestSource).pipe(
      Effect.match({ onFailure: () => Option.none(), onSuccess: Option.some }),
    );

    if (Option.isNone(contractsManifest)) {
      violations.push({
        file: "packages/contracts/package.json",
        reason:
          'Contracts package manifest lacks the canonical source subpath export. Set exports to { "./*": "./src/*.ts" }.',
      });
    }

    if (Option.isNone(apiManifest)) {
      violations.push({
        file: "apps/api/package.json",
        reason:
          "API package manifest dependencies are missing or not string-valued. Restore a dependencies object of package versions.",
      });
    }

    if (yield* fileSystem.exists("packages/contracts/src/index.ts")) {
      violations.push({
        file: "packages/contracts/src/index.ts",
        reason:
          "Contracts source barrel index.ts is forbidden. Delete it and import explicit concept subpaths.",
      });
    }

    for (const dependency of forbiddenNewRuntimeDependencies) {
      if (Option.isSome(apiManifest) && dependency in apiManifest.value.dependencies) {
        violations.push({
          file: "apps/api/package.json",
          reason: `API package declares forbidden legacy dependency ${dependency}. Remove it from apps/api/package.json.`,
        });
      }
    }

    return violations;
  },
);

/**
 * Verifies canonical cf-twitch workspace and package boundaries.
 *
 * @returns Nothing on success; fails with `CfTwitchArchitectureError` listing every violation, or
 *   with `PlatformError` when a source file or manifest cannot be read.
 */
export const verifyCfTwitchArchitecture = Effect.fn(
  "CfTwitchArchitecture.verifyCfTwitchArchitecture",
)(function* () {
  const files = yield* Effect.forEach(cfTwitchSourceRoots, listTypeScriptFiles, {
    concurrency: "unbounded",
  }).pipe(Effect.map((groups) => groups.flat()));

  const sourceViolations = yield* Effect.forEach(files, inspectCfTwitchSource, {
    concurrency: "unbounded",
  }).pipe(Effect.map((groups) => groups.flat()));

  const packageViolations = yield* verifyPackageManifests();
  const violations = [...sourceViolations, ...packageViolations];

  if (violations.length > 0) {
    return yield* Effect.fail(
      new CfTwitchArchitectureError({
        operation: "verifyCfTwitchArchitecture",
        reason: "ArchitectureRulesViolated",
        violations,
      }),
    );
  }

  yield* Effect.logInfo(`CF Twitch architecture verified across ${files.length} source files.`);
});

if (import.meta.main) {
  NodeRuntime.runMain(verifyCfTwitchArchitecture().pipe(Effect.provide(NodeServices.layer)));
}
