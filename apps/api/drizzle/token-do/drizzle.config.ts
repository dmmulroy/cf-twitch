import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/durable-objects/schemas/token-schema.ts",
	out: "./drizzle/token-do",
	dialect: "sqlite",
});
