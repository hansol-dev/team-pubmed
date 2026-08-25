import test from "node:test";
import assert from "node:assert/strict";
import {
  addToCollectionWithClient,
  listPapersWithClient,
  removeFromCollectionWithClient,
} from "../src/papers.js";

const userId = "11111111-1111-4111-8111-111111111111";
const searchRunId = "22222222-2222-4222-8222-222222222222";

test("explicitly saves or restores an interest paper for the authenticated user", async () => {
  const calls = [];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      if (/SELECT id FROM search_runs/.test(text)) return { rowCount: 1, rows: [{ id: searchRunId }] };
      if (/INSERT INTO user_paper_collections/.test(text)) {
        return { rowCount: 1, rows: [{ pmid: "123" }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };

  const saved = await addToCollectionWithClient(client, userId, ["123"], searchRunId);

  assert.deepEqual(saved, ["123"]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].params, [searchRunId, userId]);
  assert.match(calls[0].text, /user_id=\$2 AND is_del=false/);
  assert.match(calls[1].text, /ON CONFLICT \(user_id, pmid\) DO UPDATE/);
  assert.match(calls[1].text, /is_del=false/);
  assert.match(calls[1].text, /delete_reason=NULL/);
  assert.match(calls[2].text, /SET added_to_collection=true/);
  assert.ok(calls.every(({ text }) => !/DELETE FROM/.test(text)));
});

test("does not attach an interest action to another user's search run", async () => {
  const client = {
    query: async () => ({ rowCount: 0, rows: [] }),
  };

  await assert.rejects(
    addToCollectionWithClient(client, userId, ["123"], searchRunId),
    (error) => error.status === 404 && error.message === "Search result not found",
  );
});

test("soft-removes only the authenticated user's active interest row", async () => {
  const calls = [];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      return { rowCount: 1, rows: [{ pmid: "123" }] };
    },
  };

  const removed = await removeFromCollectionWithClient(client, userId, "123");

  assert.equal(removed, true);
  assert.deepEqual(calls[0].params, [userId, "123"]);
  assert.match(calls[0].text, /UPDATE user_paper_collections/);
  assert.match(calls[0].text, /is_del=true/);
  assert.match(calls[0].text, /deleted_at=now\(\)/);
  assert.match(calls[0].text, /deleted_by=\$1/);
  assert.match(calls[0].text, /delete_reason='user_removed_interest'/);
  assert.match(calls[0].text, /user_id=\$1 AND pmid=\$2 AND is_del=false/);
  assert.doesNotMatch(calls[0].text, /DELETE FROM/);
});

test("lists only the authenticated user's non-deleted interest papers", async () => {
  const calls = [];
  const client = {
    query: async (text, params) => {
      calls.push({ text, params });
      return { rowCount: 0, rows: [] };
    },
  };

  await listPapersWithClient(client, userId, { limit: 25 });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], userId);
  assert.match(calls[0].text, /up\.user_id = \$1/);
  assert.match(calls[0].text, /up\.is_del = false/);
});
