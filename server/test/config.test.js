import test from "node:test";
import assert from "node:assert/strict";
import { cleanEnvValue } from "../src/config.js";

test("keeps a plain environment value unchanged", () => {
  assert.equal(cleanEnvValue("OPENAI_API_KEY", "sk-example"), "sk-example");
});

test("removes an accidentally pasted assignment prefix", () => {
  assert.equal(
    cleanEnvValue("SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY=sb_secret_example"),
    "sb_secret_example"
  );
});

test("removes surrounding quotes and whitespace", () => {
  assert.equal(
    cleanEnvValue("SUPABASE_URL", '  "https://example.supabase.co"  '),
    "https://example.supabase.co"
  );
});

test("normalizes a quoted assignment copied from an env file", () => {
  assert.equal(
    cleanEnvValue("NCBI_TOOL", '"NCBI_TOOL=publium"'),
    "publium"
  );
});
