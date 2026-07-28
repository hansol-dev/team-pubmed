import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";

const fakeAuth = (req, _res, next) => {
  req.user = { id: "11111111-1111-4111-8111-111111111111", email: "test@example.com" };
  next();
};

test("returns authenticated user contract", async () => {
  const response = await request(createApp({ authMiddleware: fakeAuth })).get("/api/auth/me");
  assert.equal(response.status, 200);
  assert.equal(response.body.user.email, "test@example.com");
});

test("validates collection search input before external calls", async () => {
  const response = await request(createApp({ authMiddleware: fakeAuth }))
    .post("/api/collection/search")
    .send({ keyword: "", yearFrom: 2025, yearTo: 2024 });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "Invalid request");
});

test("allows the Vercel deployment's same-origin API requests", async () => {
  const response = await request(createApp({ authMiddleware: fakeAuth }))
    .get("/api/auth/me")
    .set("Host", "publium-renewal.vercel.app")
    .set("Origin", "https://publium-renewal.vercel.app");
  assert.equal(response.status, 200);
  assert.equal(response.headers["access-control-allow-origin"], "https://publium-renewal.vercel.app");
});

test("does not grant CORS access to an unrelated origin", async () => {
  const response = await request(createApp({ authMiddleware: fakeAuth }))
    .get("/api/auth/me")
    .set("Host", "publium-renewal.vercel.app")
    .set("Origin", "https://untrusted.example");
  assert.equal(response.status, 200);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
});
