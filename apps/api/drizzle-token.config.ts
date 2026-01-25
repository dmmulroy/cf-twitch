import { defineConfig } from "drizzle-kit";

export default defineConfig({
	out: "./drizzle/token-do",
	schema: "./src/durable-objects/schemas/token-schema.ts",
	dialect: "sqlite",
	driver: "durable-sqlite",
});
