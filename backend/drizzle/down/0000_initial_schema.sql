-- Undoes the initial schema: everything in the application's schema goes (tables, types, the pg_trgm extension).
DROP SCHEMA public CASCADE;--> statement-breakpoint
CREATE SCHEMA public;
