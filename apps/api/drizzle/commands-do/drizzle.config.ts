import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/durable-objects/schemas/commands-do.schema.ts",
	out: "./drizzle/commands-do",
	dialect: "sqlite",
});
