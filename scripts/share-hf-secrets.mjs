import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const privateDir = resolve(rootDir, ".pi/hf-private");
const outputFile = resolve(privateDir, "secrets.txt");
const envFiles = [resolve(rootDir, ".envrc"), resolve(rootDir, ".dev.vars")];
const envVarNames = [
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"HF_TOKEN",
	"GOOGLE_API_KEY",
	"GOOGLE_GENERATIVE_AI_API_KEY",
	"OPENROUTER_API_KEY",
	"XAI_API_KEY",
	"MISTRAL_API_KEY",
	"GROQ_API_KEY",
];

mkdirSync(privateDir, { recursive: true });

function stripQuotes(value) {
	if (value.length < 2) {
		return value;
	}

	const first = value.at(0);
	const last = value.at(-1);
	if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
		return value.slice(1, -1);
	}
	return value;
}

function collectFromEnvFile(filePath, values) {
	if (!existsSync(filePath)) {
		return;
	}

	const lines = readFileSync(filePath, "utf8").split(/\r?\n/u);
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}

		const normalized = line.startsWith("export ") ? line.slice(7) : line;
		const separatorIndex = normalized.indexOf("=");
		if (separatorIndex === -1) {
			continue;
		}

		const value = stripQuotes(normalized.slice(separatorIndex + 1).trim());
		if (value) {
			values.add(value);
		}
	}
}

const values = new Set();
for (const filePath of envFiles) {
	collectFromEnvFile(filePath, values);
}

for (const name of envVarNames) {
	const value = process.env[name];
	if (value) {
		values.add(value);
	}
}

const sortedValues = [...values].filter(Boolean).sort((left, right) => left.localeCompare(right));
writeFileSync(
	outputFile,
	`${sortedValues.join("\n")}${sortedValues.length > 0 ? "\n" : ""}`,
	"utf8",
);

process.stdout.write(`Wrote ${sortedValues.length} secret value(s) to ${outputFile}\n`);
