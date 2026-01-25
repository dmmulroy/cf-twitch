import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/durable-objects/schemas/keyboard-raffle-do.schema.ts",
	out: "./drizzle/keyboard-raffle-do",
	dialect: "sqlite",
});
