import test from "node:test";
import assert from "node:assert/strict";
import { getOverviewWithClient } from "../src/overview.js";

const userId = "11111111-1111-4111-8111-111111111111";

test("builds an actionable overview from one user's active data", async () => {
  const calls = [];
  const responses = [
    {
      rows: [{
        total_papers: 12,
        total_journals: 7,
        project_count: 3,
        unassigned_count: 2,
        ready_count: 5,
        abstract_only_count: 6,
        processing_count: 1,
      }],
    },
    {
      rows: [
        { id: "project-a", name: "비만 연구", color: "#7c6ee6", paper_count: 7 },
        { id: "project-b", name: "당뇨 연구", color: "#4f9c8f", paper_count: 3 },
      ],
    },
    {
      rows: [{
        query: "obesity",
        year_from: 2023,
        year_to: 2025,
        result_count: 50,
        request_params: { papersByYear: { 2023: 100, 2024: "130", invalid: 8 } },
        created_at: "2026-08-27T00:00:00.000Z",
      }],
    },
    {
      rows: [{
        pmid: "12345678",
        title: "A recent paper",
        journal: "Journal of Useful Evidence",
        publication_year: 2025,
        saved_at: "2026-08-26T10:30:00.000Z",
        projects: [{ id: "project-a", name: "비만 연구", color: "#7c6ee6" }],
      }],
    },
  ];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      return responses[calls.length - 1];
    },
  };

  const overview = await getOverviewWithClient(client, userId);

  assert.equal(calls.length, 4);
  assert.ok(calls.every(({ params }) => params[0] === userId));
  assert.match(calls[0].text, /collection\.is_del=false/);
  assert.match(calls[0].text, /document\.is_del=false/);
  assert.match(calls[0].text, /project_link\.is_del=false AND project\.is_del=false/);
  assert.match(calls[1].text, /project\.is_del=false/);
  assert.match(calls[1].text, /collection\.is_del=false/);
  assert.match(calls[2].text, /is_del=false/);
  assert.match(calls[3].text, /collection\.is_del=false/);
  assert.match(calls[3].text, /project_link\.is_del=false AND project\.is_del=false/);
  assert.match(calls[3].text, /LIMIT 3/);
  assert.deepEqual(overview.analysisStatus, { ready: 5, abstractOnly: 6, processing: 1 });
  assert.equal(overview.projectDistribution[0].paperCount, 7);
  assert.deepEqual(overview.papersByYear, { 2023: 100, 2024: 130 });
  assert.equal(overview.latestSearch.keyword, "obesity");
  assert.equal(overview.latestSearch.totalMatches, 230);
  assert.deepEqual(overview.recentPapers, [{
    pmid: "12345678",
    title: "A recent paper",
    journal: "Journal of Useful Evidence",
    pubYear: 2025,
    savedAt: "2026-08-26T10:30:00.000Z",
    projects: [{ id: "project-a", name: "비만 연구", color: "#7c6ee6" }],
  }]);
});

test("returns an empty search trend without disguising interest-paper years as search data", async () => {
  const responses = [
    { rows: [{ total_papers: 0, project_count: 0 }] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
  ];
  const client = { query: async () => responses.shift() };

  const overview = await getOverviewWithClient(client, userId);

  assert.deepEqual(overview.papersByYear, {});
  assert.equal(overview.latestSearch, null);
  assert.deepEqual(overview.projectDistribution, []);
  assert.deepEqual(overview.recentPapers, []);
});
