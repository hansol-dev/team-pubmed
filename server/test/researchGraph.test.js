import test from "node:test";
import assert from "node:assert/strict";
import { AIMessage } from "@langchain/core/messages";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  answerResearchGraphQuestionWithClient,
  getResearchGraphWithClient,
} from "../src/researchGraph.js";
import {
  buildResearchCorpus,
  retrieveResearchSubgraph,
} from "../../shared/researchGraph.js";

const userId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const fakeAuth = (req, _res, next) => {
  req.user = { id: userId, email: "test@example.com" };
  next();
};

const papers = [
  {
    pmid: "1001",
    title: "Cancer biomarker discovery using genomic sequencing",
    abstract: "A genomic biomarker was evaluated for early cancer detection in a clinical cohort.",
    journal: "Cancer Research",
    publication_year: 2025,
    total_count: 3,
  },
  {
    pmid: "1002",
    title: "Validation of tumor biomarkers",
    abstract: "This cohort study validates molecular biomarkers for precision oncology.",
    journal: "Oncology Reports",
    publication_year: 2024,
    total_count: 3,
  },
  {
    pmid: "1003",
    title: "Lifestyle intervention for diabetes",
    abstract: "Physical activity improved glycemic control in adults with diabetes.",
    journal: "Metabolism",
    publication_year: 2023,
    total_count: 3,
  },
];

test("builds a deterministic interest corpus with inferred topics and concepts", () => {
  const corpus = buildResearchCorpus(papers, { source: { kind: "interest", projectId: "all" } });

  assert.equal(corpus.papers.length, 3);
  assert.ok(corpus.topics.some((topic) => topic.id === "oncology"));
  assert.ok(corpus.topics.some((topic) => topic.id === "metabolism"));
  assert.ok(corpus.papers[0].conceptIds.includes("genomics"));
  assert.deepEqual(corpus.yearRange, [2023, 2025]);
});

test("retrieves direct papers and expands to graph neighbors", () => {
  const corpus = buildResearchCorpus(papers);
  const evidence = retrieveResearchSubgraph("암 바이오마커와 유전체 연구", corpus.papers);

  assert.ok(evidence.some((item) => item.paper.pmid === "1001" && item.matchType === "direct"));
  assert.ok(evidence.some((item) => item.paper.pmid === "1002"));
  assert.ok(evidence.every((item) => item.paper.pmid !== "1003"));
});

test("loads only active owned papers in the requested active project", async () => {
  const calls = [];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: papers };
    },
  };

  const result = await getResearchGraphWithClient(client, userId, { projectId, limit: 120 });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [userId, projectId, 120]);
  assert.match(calls[0].text, /collection\.user_id=\$1/);
  assert.match(calls[0].text, /collection\.is_del=false/);
  assert.match(calls[0].text, /project_link\.project_id=\$2/);
  assert.match(calls[0].text, /project_link\.is_del=false/);
  assert.match(calls[0].text, /project\.is_del=false/);
  assert.equal(result.scope.projectId, projectId);
  assert.equal(result.scope.totalPapers, 3);
});

test("uses an active-link exclusion for the unassigned graph scope", async () => {
  const calls = [];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      return { rows: [] };
    },
  };

  const result = await getResearchGraphWithClient(client, userId, { projectId: "unassigned", limit: 200 });

  assert.deepEqual(calls[0].params, [userId, 200]);
  assert.match(calls[0].text, /NOT EXISTS/);
  assert.match(calls[0].text, /project_link\.is_del=false/);
  assert.match(calls[0].text, /project\.is_del=false/);
  assert.equal(result.scope.totalPapers, 0);
});

test("guards unsafe Graph RAG input before querying the user's papers", async () => {
  let queried = false;
  const result = await answerResearchGraphQuestionWithClient(
    { query: async () => { queried = true; return { rows: papers }; } },
    userId,
    { question: "내 증상에 어떤 약을 먹어야 해?", projectId: "all" },
    { model: { invoke: async () => new AIMessage("unsafe") } },
  );

  assert.equal(result.decision, "blocked");
  assert.equal(queried, false);
  assert.deepEqual(result.sources, []);
});

test("generates a guarded answer from the retrieved interest-paper subgraph", async () => {
  const modelCalls = [];
  const client = { query: async () => ({ rows: papers }) };
  const result = await answerResearchGraphQuestionWithClient(
    client,
    userId,
    { question: "암 바이오마커와 유전체 연구를 비교해줘", projectId: "all" },
    {
      model: {
        invoke: async (messages) => {
          modelCalls.push(messages);
          return new AIMessage("두 논문은 바이오마커 검증과 유전체 분석을 연결합니다.");
        },
      },
    },
  );

  assert.equal(result.decision, "allow");
  assert.ok(result.sources.length >= 2);
  assert.equal(result.retrieval.evidenceScope, "title_abstract");
  assert.match(modelCalls[0][0].content, /<graph_evidence>/);
  assert.match(modelCalls[0][0].content, /Cancer biomarker discovery/);
});

test("rejects a graph request above the bounded paper limit", async () => {
  const response = await request(createApp({ authMiddleware: fakeAuth }))
    .get("/api/research-graph?limit=301");

  assert.equal(response.status, 400);
  assert.equal(response.body.error, "Invalid request");
});
