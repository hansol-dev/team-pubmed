import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  getInterestWordCloudWithClient,
  summarizeWordCloud,
} from "../src/wordCloud.js";

const userId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const fakeAuth = (req, _res, next) => {
  req.user = { id: userId, email: "test@example.com" };
  next();
};

test("counts one paper once while retaining repeated occurrences", () => {
  const summary = summarizeWordCloud([
    {
      title: "Cancer biomarker discovery",
      abstract: "Biomarkers biomarker biomarker improve cancer detection.",
    },
    {
      title: "Biomarker validation",
      abstract: "A biomarker supports detection.",
    },
  ]);

  const biomarker = summary.terms.find((term) => term.text === "biomarker");
  assert.equal(summary.paperCount, 2);
  assert.equal(summary.missingAbstractCount, 0);
  assert.equal(biomarker.paperCount, 2);
  assert.equal(biomarker.occurrences, 6);
  assert.equal(biomarker.titleCount, 2);
  assert.ok(biomarker.score > biomarker.paperCount);
});

test("reports papers without abstracts while still using their titles", () => {
  const summary = summarizeWordCloud([
    { title: "Genomic medicine", abstract: "" },
    { title: "Precision medicine", abstract: null },
  ]);

  assert.equal(summary.paperCount, 2);
  assert.equal(summary.missingAbstractCount, 2);
  assert.equal(summary.terms.find((term) => term.text === "medicine").paperCount, 2);
});

test("loads only one user's active interest papers and active project links", async () => {
  const calls = [];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      return {
        rows: [
          { title: "Cancer biomarker", abstract: "Biomarker validation" },
          { title: "Clinical biomarker", abstract: "" },
        ],
      };
    },
  };

  const result = await getInterestWordCloudWithClient(client, userId, {
    keyword: "biomarker",
    yearFrom: 2020,
    yearTo: 2025,
    journal: "Nature Medicine",
    projectId,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [
    userId,
    "%biomarker%",
    2020,
    2025,
    "Nature Medicine",
    projectId,
  ]);
  assert.match(calls[0].text, /collection\.user_id=\$1/);
  assert.match(calls[0].text, /collection\.is_del=false/);
  assert.match(calls[0].text, /project_link\.project_id=\$6/);
  assert.match(calls[0].text, /project_link\.is_del=false/);
  assert.match(calls[0].text, /project\.is_del=false/);
  assert.doesNotMatch(calls[0].text, /\bLIMIT\b/);
  assert.equal(result.projectId, projectId);
  assert.equal(result.paperCount, 2);
});

test("uses an active-link NOT EXISTS condition for the unassigned scope", async () => {
  const calls = [];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: [] };
    },
  };

  const result = await getInterestWordCloudWithClient(client, userId, { projectId: "unassigned" });

  assert.deepEqual(calls[0].params, [userId]);
  assert.match(calls[0].text, /NOT EXISTS/);
  assert.match(calls[0].text, /project_link\.is_del=false/);
  assert.match(calls[0].text, /project\.is_del=false/);
  assert.equal(result.projectId, "unassigned");
});

test("rejects an excessive keyword count before querying the database", async () => {
  const response = await request(createApp({ authMiddleware: fakeAuth }))
    .get("/api/wordcloud?termLimit=201");

  assert.equal(response.status, 400);
  assert.equal(response.body.error, "Invalid request");
});
