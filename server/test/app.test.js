import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  bestEvidenceQuote,
  API_REVISION,
  contextSources,
  createApp,
  evidenceScope,
  fillYearRange,
  recordSearchRun,
  resetUserWorkspace,
} from "../src/app.js";

const fakeAuthUserId = "11111111-1111-4111-8111-111111111111";
const fakeAuth = (req, _res, next) => {
  req.user = { id: fakeAuthUserId, email: "test@example.com" };
  next();
};

test("exposes a deployment revision for API bundle verification", () => {
  assert.equal(API_REVISION, "2026-08-27-overview-continuation-v1");
});

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

test("rejects legacy search requests that try to auto-save every result", async () => {
  const response = await request(createApp({ authMiddleware: fakeAuth }))
    .post("/api/collection/search")
    .send({
      keyword: "diabetes",
      yearFrom: 2020,
      yearTo: 2024,
      maxCount: 10,
      saveToCollection: true,
    });
  assert.equal(response.status, 400);
  assert.equal(response.body.error, "Invalid request");
});

test("records search results without inserting them into the interest collection", async () => {
  const calls = [];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      if (/INSERT INTO search_runs/.test(text)) {
        return { rowCount: 1, rows: [{ id: "22222222-2222-4222-8222-222222222222" }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const result = await recordSearchRun(
    client,
    fakeAuthUserId,
    { keyword: "diabetes", yearFrom: 2020, yearTo: 2024, maxCount: 2 },
    [{ pmid: "123" }, { pmid: "456" }],
    { 2024: 2 },
  );

  assert.deepEqual(result, {
    runId: "22222222-2222-4222-8222-222222222222",
    savedCount: 0,
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ text }) => !/user_paper_collections/.test(text)));
  assert.ok(calls.slice(1).every(({ text }) => /added_to_collection/.test(text) && /false/.test(text)));
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

test("turns retrieved evidence into stable source references", () => {
  const sources = contextSources([
    { pmid: "123", section: "Results", content: "The primary outcome improved.", relevance: "0.91" },
    { pmid: "123", section: "Results", content: "The primary outcome improved.", relevance: "0.91" },
  ]);
  assert.deepEqual(sources, [{
    id: "source-1",
    pmid: "123",
    section: "Results",
    excerpt: "The primary outcome improved.",
    quote: "The primary outcome improved.",
    chunkId: null,
    documentId: null,
    contentHash: null,
    relevance: 0.91,
  }]);
});

test("selects one exact supporting sentence instead of a broad chunk", () => {
  const content = `${"Background context. ".repeat(100)}
The total sample consisted of 306 participants across three groups.
Additional discussion followed.`;
  const quote = bestEvidenceQuote(
    content,
    "How many participants were included?",
    "The study included 306 participants.",
  );
  assert.equal(quote, "The total sample consisted of 306 participants across three groups.");
  const sources = contextSources([
    {
      pmid: "42496099",
      section: "Procedure",
      content: "The study was approved by the University's Ethics Committee.",
      chunk_id: 80,
    },
    {
      pmid: "42496099",
      section: "Participants",
      content,
      chunk_id: 81,
      document_id: "a09f4a89-2f39-4f4f-a87a-a87f76f13d74",
      content_hash: "hash-v1",
    },
  ], {
    question: "How many participants were included?",
    answer: "전체 참여자는 306명이었습니다.",
  });
  assert.equal(sources.length, 1);
  const [source] = sources;
  assert.equal(source.quote, quote);
  assert.equal(source.chunkId, 81);
  assert.equal(source.documentId, "a09f4a89-2f39-4f4f-a87a-a87f76f13d74");
  assert.equal(source.contentHash, "hash-v1");
});

test("describes full-text, mixed and abstract-only evidence scopes", () => {
  assert.equal(evidenceScope({ paperCount: 2, fullTextCount: 2 }).mode, "full_text");
  assert.equal(evidenceScope({ paper_count: 2, full_text_count: 1 }).mode, "mixed");
  const abstract = evidenceScope({ paperCount: 2, fullTextCount: 0 });
  assert.equal(abstract.mode, "abstract");
  assert.match(abstract.instruction, /추측하지/);
});

test("resets chats, collected papers and search history for one user", async () => {
  const calls = [];
  const rowCounts = [8, 2, 4, 2, 10, 3];
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
    removedProjectCount: 2,
    removedProjectPaperCount: 4,
    removedSearchCount: 3,
  });
  assert.deepEqual(calls.map(({ params }) => params), [
    [fakeAuthUserId],
    [fakeAuthUserId],
    [fakeAuthUserId],
    [fakeAuthUserId],
    [fakeAuthUserId],
    [fakeAuthUserId],
  ]);
  assert.match(calls[0].text, /UPDATE chat_messages/);
  assert.match(calls[1].text, /UPDATE chat_rooms/);
  assert.match(calls[2].text, /UPDATE project_papers/);
  assert.match(calls[3].text, /UPDATE research_projects/);
  assert.match(calls[4].text, /UPDATE user_paper_collections/);
  assert.match(calls[4].text, /delete_reason='workspace_reset'/);
  assert.match(calls[5].text, /UPDATE search_runs/);
  assert.ok(calls.every(({ text }) => /is_del=true/.test(text)));
  assert.ok(calls.every(({ text }) => !/DELETE FROM/.test(text)));
});
