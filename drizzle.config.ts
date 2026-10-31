import { defineConfig } from "drizzle-kit";

// `npm run db:generate` turns schema changes into SQL migrations in ./drizzle.
// Migrations are applied by scripts/migrate.ts (and automatically on app start in development).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
});
