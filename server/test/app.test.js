import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp, fillYearRange, resetUserWorkspace } from "../src/app.js";

const fakeAuthUserId = "11111111-1111-4111-8111-111111111111";
const fakeAuth = (req, _res, next) => {
  req.user = { id: fakeAuthUserId, email: "test@example.com" };
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

test("fills every year in the selected collection range", () => {
  assert.deepEqual(
    fillYearRange(2020, 2024, { 2020: 12, 2022: 31, 2024: 7 }),
    { 2020: 12, 2021: 0, 2022: 31, 2023: 0, 2024: 7 },
  );
});

test("resets chats, collected papers and search history for one user", async () => {
  const calls = [];
  const rowCounts = [8, 2, 10, 3];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      return { rowCount: rowCounts[calls.length - 1] };
    },
  };

  const result = await resetUserWorkspace(client, fakeAuthUserId);
  assert.deepEqual(result, {
    removedChatCount: 2,
    removedMessageCount: 8,
    removedPaperCount: 10,
    removedSearchCount: 3,
  });
  assert.deepEqual(calls.map(({ params }) => params), [
    [fakeAuthUserId],
    [fakeAuthUserId],
    [fakeAuthUserId],
    [fakeAuthUserId],
  ]);
  assert.match(calls[0].text, /UPDATE chat_messages/);
  assert.match(calls[1].text, /UPDATE chat_rooms/);
  assert.match(calls[2].text, /UPDATE user_paper_collections/);
  assert.match(calls[3].text, /UPDATE search_runs/);
  assert.ok(calls.every(({ text }) => /is_del=true/.test(text)));
  assert.ok(calls.every(({ text }) => !/DELETE FROM/.test(text)));
});
