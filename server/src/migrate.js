import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { closePool, query } from "./db.js";

// Keep one canonical schema for Supabase CLI and this backend command.
const path = fileURLToPath(new URL("../../supabase/schema.sql", import.meta.url));
try {
  await query(await readFile(path, "utf8"));
  console.log("Database migration completed");
} finally {
  await closePool();
}
