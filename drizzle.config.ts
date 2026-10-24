import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  casing: 'snake_case',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
})
