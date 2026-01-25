import { defineConfig } from "drizzle-kit";

export default defineConfig({
	out: "./drizzle/keyboard-raffle-do",
	schema: "./src/durable-objects/schemas/keyboard-raffle-do.schema.ts",
	dialect: "sqlite",
	driver: "durable-sqlite",
});
