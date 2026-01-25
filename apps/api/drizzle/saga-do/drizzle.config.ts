import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/durable-objects/schemas/saga.schema.ts",
	out: "./drizzle/saga-do",
	dialect: "sqlite",
});
