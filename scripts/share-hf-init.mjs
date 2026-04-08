import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const privateDir = resolve(rootDir, ".pi/hf-private");
const denyFile = resolve(privateDir, "deny.txt");
const workspaceDir = resolve(rootDir, ".pi/hf-sessions");

mkdirSync(privateDir, { recursive: true });

if (!existsSync(denyFile)) {
	writeFileSync(denyFile, "/Users/dmmulroy/\ntrycloudflare\\.com\nngrok(-free)?\\.app\n", "utf8");
	process.stdout.write(`Created starter deny list at ${denyFile}\n`);
}

const repo = process.env.PI_SHARE_HF_REPO ?? "dmmulroy/cf-twitch-pi-sessions";
const organization = process.env.PI_SHARE_HF_ORGANIZATION;
const args = ["init", "--workspace", workspaceDir, "--repo", repo, "--no-images"];

if (organization) {
	args.push("--organization", organization);
}

const result = spawnSync("pi-share-hf", args, { stdio: "inherit" });

if (result.error) {
	if (result.error.name === "ENOENT") {
		process.stderr.write(
			"pi-share-hf is not installed. Install it with: npm install -g pi-share-hf @mariozechner/pi-coding-agent\n",
		);
	} else {
		process.stderr.write(`${result.error.message}\n`);
	}
	process.exit(1);
}

if (typeof result.status === "number" && result.status !== 0) {
	process.exit(result.status);
}

process.stdout.write("\nNext steps:\n");
process.stdout.write(`- Review ${denyFile}\n`);
process.stdout.write("- Run pnpm share:secrets\n");
process.stdout.write("- Run pnpm share:collect\n");
