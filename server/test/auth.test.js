import test from "node:test";
import assert from "node:assert/strict";
import { resolveLocalDevelopmentUser } from "../src/auth.js";

const userId = "11111111-1111-4111-8111-111111111111";

test("accepts the local token only in a non-Vercel development server", () => {
  const result = resolveLocalDevelopmentUser("publium-local-development", {
    env: "development",
    vercel: "",
    userId,
  });
  assert.equal(result.user.id, userId);
});

test("never accepts the local token in production or Vercel", () => {
  assert.equal(resolveLocalDevelopmentUser("publium-local-development", {
    env: "production",
    vercel: "",
    userId,
  }), null);
  assert.equal(resolveLocalDevelopmentUser("publium-local-development", {
    env: "development",
    vercel: "1",
    userId,
  }), null);
});
