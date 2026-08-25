import test from "node:test";
import assert from "node:assert/strict";
import {
  assignPapersToProjectsWithClient,
  createProjectWithClient,
  listProjectsWithClient,
  replacePaperProjectsWithClient,
  restoreProjectWithClient,
  softDeleteProjectWithClient,
  updateProjectWithClient,
} from "../src/projects.js";

const userId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const secondProjectId = "33333333-3333-4333-8333-333333333333";

test("lists only active projects and counts unassigned papers for one user", async () => {
  const calls = [];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      if (/FROM research_projects project/.test(text)) {
        return { rows: [{ id: projectId, name: "프로젝트 A", paper_count: 2 }] };
      }
      return { rows: [{ total_count: 5, unassigned_count: 3 }] };
    },
  };

  const result = await listProjectsWithClient(client, userId);

  assert.equal(result.totalCount, 5);
  assert.equal(result.unassignedCount, 3);
  assert.equal(result.projects[0].paper_count, 2);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ params }) => params[0] === userId));
  assert.match(calls[0].text, /project\.user_id=\$1 AND project\.is_del=false/);
  assert.match(calls[0].text, /link\.is_del=false/);
  assert.match(calls[1].text, /collection\.user_id=\$1 AND collection\.is_del=false/);
});

test("creates and updates only the authenticated user's active project", async () => {
  const calls = [];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      return {
        rowCount: 1,
        rows: [{ id: projectId, name: params[1] ?? "수정된 이름", color: "#7c6ee6" }],
      };
    },
  };

  const created = await createProjectWithClient(client, userId, {
    name: "프로젝트 A",
    description: "설명",
    color: "#7c6ee6",
  });
  const updated = await updateProjectWithClient(client, userId, projectId, { name: "수정된 이름" });

  assert.equal(created.paper_count, 0);
  assert.equal(updated.id, projectId);
  assert.deepEqual(calls[0].params.slice(0, 2), [userId, "프로젝트 A"]);
  assert.deepEqual(calls[1].params.slice(0, 2), [projectId, userId]);
  assert.match(calls[1].text, /id=\$1 AND user_id=\$2 AND is_del=false/);
  assert.ok(calls.every(({ text }) => !/DELETE FROM/.test(text)));
});

test("soft-deletes a project and its active paper links without physical deletion", async () => {
  const calls = [];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      if (/UPDATE research_projects/.test(text)) {
        return { rowCount: 1, rows: [{ id: projectId, name: "프로젝트 A" }] };
      }
      return { rowCount: 3, rows: [{ pmid: "1" }, { pmid: "2" }, { pmid: "3" }] };
    },
  };

  const result = await softDeleteProjectWithClient(client, userId, projectId);

  assert.equal(result.removedPaperCount, 3);
  assert.ok(calls.every(({ params }) => params[0] === userId && params[1] === projectId));
  assert.match(calls[0].text, /is_del=true/);
  assert.match(calls[0].text, /delete_reason='user_deleted_project'/);
  assert.match(calls[1].text, /UPDATE project_papers/);
  assert.match(calls[1].text, /delete_reason='project_deleted'/);
  assert.ok(calls.every(({ text }) => !/DELETE FROM/.test(text)));
});

test("restores only links hidden by project deletion whose interest paper is still active", async () => {
  const calls = [];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      if (/UPDATE research_projects/.test(text)) {
        return { rowCount: 1, rows: [{ id: projectId, name: "프로젝트 A" }] };
      }
      return { rowCount: 2, rows: [{ pmid: "1" }, { pmid: "2" }] };
    },
  };

  const result = await restoreProjectWithClient(client, userId, projectId);

  assert.equal(result.restoredPaperCount, 2);
  assert.match(calls[1].text, /link\.delete_reason='project_deleted'/);
  assert.match(calls[1].text, /collection\.is_del=false/);
  assert.ok(calls.every(({ text }) => !/DELETE FROM/.test(text)));
});

test("replaces one interest paper's project links using only owned active projects", async () => {
  const calls = [];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      if (/SELECT pmid FROM user_paper_collections/.test(text)) {
        return { rowCount: 1, rows: [{ pmid: "123" }] };
      }
      if (/SELECT id FROM research_projects/.test(text)) {
        return { rowCount: 2, rows: [{ id: projectId }, { id: secondProjectId }] };
      }
      if (/SELECT project\.id,project\.name/.test(text)) {
        return { rowCount: 2, rows: [{ id: projectId }, { id: secondProjectId }] };
      }
      return { rowCount: 2, rows: [] };
    },
  };

  const projects = await replacePaperProjectsWithClient(
    client,
    userId,
    "123",
    [projectId, secondProjectId, projectId],
  );

  assert.equal(projects.length, 2);
  assert.deepEqual(calls[0].params, [userId, "123"]);
  assert.deepEqual(calls[1].params, [userId, [projectId, secondProjectId]]);
  assert.match(calls[0].text, /user_id=\$1 AND pmid=\$2 AND is_del=false/);
  assert.match(calls[1].text, /user_id=\$1.*is_del=false/s);
  assert.match(calls[2].text, /UPDATE project_papers/);
  assert.match(calls[2].text, /delete_reason='user_unassigned_paper'/);
  assert.match(calls[3].text, /ON CONFLICT \(user_id,project_id,pmid\) DO UPDATE/);
  assert.ok(calls.every(({ text }) => !/DELETE FROM/.test(text)));
});

test("rejects project assignment when any selected project belongs elsewhere", async () => {
  const client = {
    query: async (text) => {
      if (/SELECT pmid FROM user_paper_collections/.test(text)) {
        return { rowCount: 1, rows: [{ pmid: "123" }] };
      }
      return { rowCount: 1, rows: [{ id: projectId }] };
    },
  };

  await assert.rejects(
    replacePaperProjectsWithClient(client, userId, "123", [projectId, secondProjectId]),
    (error) => error.status === 404 && /프로젝트/.test(error.message),
  );
});

test("adds projects to several owned papers without removing existing links", async () => {
  const calls = [];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      if (/SELECT pmid FROM user_paper_collections/.test(text)) {
        return { rowCount: 2, rows: [{ pmid: "123" }, { pmid: "456" }] };
      }
      if (/SELECT id FROM research_projects/.test(text)) {
        return { rowCount: 1, rows: [{ id: projectId }] };
      }
      if (/SELECT target\.pmid/.test(text)) {
        return {
          rowCount: 2,
          rows: [
            { pmid: "123", projects: [{ id: projectId }] },
            { pmid: "456", projects: [{ id: projectId }] },
          ],
        };
      }
      return { rowCount: 2, rows: [] };
    },
  };

  const papers = await assignPapersToProjectsWithClient(
    client,
    userId,
    ["123", "456", "123"],
    [projectId, projectId],
    "add",
  );

  assert.equal(papers.length, 2);
  assert.deepEqual(calls[0].params, [userId, ["123", "456"]]);
  assert.deepEqual(calls[1].params, [userId, [projectId]]);
  assert.ok(calls.some(({ text }) => /CROSS JOIN user_paper_collections/.test(text)));
  assert.ok(calls.every(({ text }) => !/UPDATE project_papers/.test(text)));
  assert.ok(calls.every(({ text }) => !/DELETE FROM/.test(text)));
});

test("replaces several papers' projects using soft deletion and supports moving to unassigned", async () => {
  const calls = [];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      if (/SELECT pmid FROM user_paper_collections/.test(text)) {
        return { rowCount: 2, rows: [{ pmid: "123" }, { pmid: "456" }] };
      }
      if (/SELECT target\.pmid/.test(text)) {
        return {
          rowCount: 2,
          rows: [{ pmid: "123", projects: [] }, { pmid: "456", projects: [] }],
        };
      }
      return { rowCount: 2, rows: [] };
    },
  };

  const papers = await assignPapersToProjectsWithClient(
    client,
    userId,
    ["123", "456"],
    [],
    "replace",
  );

  assert.equal(papers.length, 2);
  const update = calls.find(({ text }) => /UPDATE project_papers/.test(text));
  assert.ok(update);
  assert.match(update.text, /is_del=true/);
  assert.match(update.text, /delete_reason='bulk_replaced_projects'/);
  assert.deepEqual(update.params, [userId, ["123", "456"], []]);
  assert.ok(calls.every(({ text }) => !/DELETE FROM/.test(text)));
});

test("rejects bulk assignment when any paper is not an active interest paper", async () => {
  const client = {
    query: async () => ({ rowCount: 1, rows: [{ pmid: "123" }] }),
  };

  await assert.rejects(
    assignPapersToProjectsWithClient(
      client,
      userId,
      ["123", "456"],
      [projectId],
      "add",
    ),
    (error) => error.status === 404 && /관심 논문/.test(error.message),
  );
});
