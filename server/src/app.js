import cors from "cors";
import express from "express";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import { runGuardedChat } from "./chatbot.js";
import { config } from "./config.js";
import { requireUser, supabaseAdmin } from "./auth.js";
import { query, transaction } from "./db.js";
import { addToCollection, listPapers, removeFromCollection, upsertPapers } from "./papers.js";
import {
  assignPapersToProjects,
  createProject,
  listProjects,
  replacePaperProjects,
  restoreProject,
  softDeleteProject,
  updateProject,
} from "./projects.js";
import {
  ensurePaperDocument,
  getRoomPaperDocument,
  persistUserPdf,
  refreshPaperSources,
  retrieveRoomContext,
} from "./pmc.js";
import { countPubMedByYear, searchPubMed } from "./pubmed.js";
import { getInterestWordCloud } from "./wordCloud.js";

export const API_REVISION = "2026-08-25-project-wordcloud-v2";

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const parse = (schema, value) => schema.parse(value);
const searchSchema = z.object({
  keyword: z.string().trim().min(1).max(120),
  yearFrom: z.coerce.number().int().min(1900).max(2100),
  yearTo: z.coerce.number().int().min(1900).max(2100),
  maxCount: z.coerce.number().int().min(1).max(100).default(50),
  // Search results and the user's interest collection are intentionally separate.
  // Keeping this compatibility field as false-only makes old auto-save clients fail
  // loudly instead of silently collecting every search result again.
  saveToCollection: z.literal(false).optional().default(false),
}).refine((value) => value.yearFrom <= value.yearTo, { message: "yearFrom must be <= yearTo" });
const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional().default(""),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional().default("#7c6ee6"),
});
const projectUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "At least one field is required" });
const projectIdSchema = z.string().uuid();
const bulkPaperProjectSchema = z.object({
  pmids: z.array(z.string().regex(/^\d+$/)).min(1).max(100),
  projectIds: z.array(z.string().uuid()).max(100).default([]),
  mode: z.enum(["add", "replace"]).default("add"),
}).refine((value) => value.mode === "replace" || value.projectIds.length > 0, {
  message: "At least one project is required in add mode",
});
const roomSchema = z.object({
  pmids: z.array(z.string().regex(/^\d+$/)).max(5).default([]),
  title: z.string().trim().max(120).optional(),
});
const chatSchema = z.object({
  conversationId: z.string().uuid(),
  message: z.string().trim().min(1).max(4000),
});
const pdfUploadSchema = z.object({
  storagePath: z.string().trim().min(1).max(600),
  fileName: z.string().trim().min(1).max(255),
  sizeBytes: z.coerce.number().int().min(1).max(25 * 1024 * 1024),
  pageCount: z.coerce.number().int().min(1).max(2000),
  sections: z.array(z.object({
    section: z.string().trim().min(1).max(120),
    text: z.string().trim().min(1).max(300_000),
  })).min(1).max(2000),
}).superRefine((value, ctx) => {
  const total = value.sections.reduce((sum, item) => sum + item.text.length, 0);
  if (total > 3_500_000) ctx.addIssue({ code: "custom", message: "Extracted PDF text is too large" });
});
const wordCloudTermLimitSchema = z.coerce.number().int().min(10).max(200).default(160);

export function fillYearRange(yearFrom, yearTo, counts = {}) {
  if (!Number.isInteger(yearFrom) || !Number.isInteger(yearTo) || yearFrom > yearTo) return counts;
  const completed = {};
  for (let year = yearFrom; year <= yearTo; year += 1) {
    completed[year] = Number(counts[year] ?? counts[String(year)] ?? 0);
  }
  return completed;
}

export async function resetUserWorkspace(client, userId) {
  const messages = await client.query(
    `UPDATE chat_messages
     SET is_del=true,deleted_at=now(),deleted_by=$1
     WHERE user_id=$1 AND is_del=false RETURNING id`,
    [userId],
  );
  const chatRooms = await client.query(
    `UPDATE chat_rooms
     SET is_del=true,deleted_at=now(),deleted_by=$1
     WHERE user_id=$1 AND is_del=false RETURNING id`,
    [userId],
  );
  const projectPapers = await client.query(
    `UPDATE project_papers
     SET is_del=true,deleted_at=now(),deleted_by=$1,
         delete_reason='workspace_reset'
     WHERE user_id=$1 AND is_del=false RETURNING pmid`,
    [userId],
  );
  const projects = await client.query(
    `UPDATE research_projects
     SET is_del=true,deleted_at=now(),deleted_by=$1,
         delete_reason='workspace_reset'
     WHERE user_id=$1 AND is_del=false RETURNING id`,
    [userId],
  );
  const collection = await client.query(
    `UPDATE user_paper_collections
     SET is_del=true,deleted_at=now(),deleted_by=$1,
         delete_reason='workspace_reset'
     WHERE user_id=$1 AND is_del=false RETURNING pmid`,
    [userId],
  );
  const searchRuns = await client.query(
    `UPDATE search_runs
     SET is_del=true,deleted_at=now(),deleted_by=$1
     WHERE user_id=$1 AND is_del=false RETURNING id`,
    [userId],
  );
  return {
    removedChatCount: chatRooms.rowCount,
    removedMessageCount: messages.rowCount,
    removedPaperCount: collection.rowCount,
    removedProjectCount: projects.rowCount,
    removedProjectPaperCount: projectPapers.rowCount,
    removedSearchCount: searchRuns.rowCount,
  };
}

function paperFilters(input) {
  return parse(z.object({
    keyword: z.string().trim().max(120).optional(),
    yearFrom: z.coerce.number().int().min(1900).max(2100).optional(),
    yearTo: z.coerce.number().int().min(1900).max(2100).optional(),
    journal: z.string().trim().max(300).optional(),
    projectId: z.union([z.string().uuid(), z.literal("unassigned")]).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
  }), input);
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function evidenceWords(value) {
  return new Set(
    String(value || "").toLowerCase()
      .match(/\p{L}[\p{L}\p{N}'-]{2,}|\p{N}+/gu) || [],
  );
}

export function bestEvidenceQuote(content, question = "", answer = "") {
  const candidates = String(content || "")
    .split(/\n+|(?<=[.!?])\s+/)
    .map((item) => item.replace(/^(제목|저널|발행 연도|초록):\s*/i, "").trim())
    .filter((item) => item.length >= 30);
  if (!candidates.length) return String(content || "").trim().slice(0, 280);
  const target = evidenceWords(`${question} ${answer}`);
  let best = candidates[0];
  let bestScore = -1;
  for (const candidate of candidates) {
    const words = evidenceWords(candidate);
    const overlap = [...words].filter((word) => target.has(word)).length;
    const score = overlap / Math.max(1, Math.sqrt(words.size));
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best.slice(0, 500);
}

export function contextSources(context = [], { question = "", answer = "" } = {}) {
  const seen = new Set();
  const sources = [];
  for (const item of context) {
    const quote = bestEvidenceQuote(item.content, question, answer);
    if (!item.pmid || !quote) continue;
    const key = `${item.pmid}:${item.section || "본문"}:${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      id: `source-${sources.length + 1}`,
      pmid: String(item.pmid),
      section: item.section || "본문",
      excerpt: quote,
      quote,
      chunkId: item.chunk_id || null,
      documentId: item.document_id || null,
      contentHash: item.content_hash || null,
      relevance: Number.isFinite(Number(item.relevance)) ? Number(item.relevance) : null,
      _answerOverlap: [...evidenceWords(quote)].filter((word) =>
        evidenceWords(`${question} ${answer}`).has(word)).length,
    });
  }
  const ranked = question || answer
    ? [...sources].sort((left, right) =>
        right._answerOverlap - left._answerOverlap
        || (right.relevance ?? -1) - (left.relevance ?? -1))
    : sources;
  const relevant = ranked.filter((item) => item._answerOverlap > 0);
  return (relevant.length ? relevant : ranked).slice(0, question || answer ? 5 : ranked.length)
    .map(({ _answerOverlap, ...source }) => source);
}

export function evidenceScope(summary = {}) {
  const total = Number(summary.paperCount ?? summary.paper_count ?? 0) || 0;
  const full = Number(summary.fullTextCount ?? summary.full_text_count ?? 0) || 0;
  if (!total) {
    return { mode: "none", instruction: "현재 선택된 논문이 없습니다." };
  }
  if (full === total) {
    return {
      mode: "full_text",
      instruction: "선택된 모든 논문에 접근 가능한 전문 근거가 있습니다. 제공된 전문 근거와 초록 안에서만 답하세요.",
    };
  }
  if (full > 0) {
    return {
      mode: "mixed",
      instruction: `선택 논문 ${total}편 중 ${full}편만 접근 가능한 전문이 있고 나머지는 초록만 있습니다. 초록만 있는 논문의 세부 방법, 표, 추가 통계, 세부 결과를 추측하지 말고 확인할 수 없다고 명시하세요.`,
    };
  }
  return {
    mode: "abstract",
    instruction: "선택된 모든 논문은 제목과 초록만 제공됩니다. 초록에 직접 적힌 내용만 설명하고, 세부 방법, 표, 추가 통계, 세부 결과, 본문 한계를 추측하지 말며 전문 확인이 필요하다고 명시하세요.",
  };
}

async function roomForUser(userId, roomId) {
  const result = await query(
    "SELECT * FROM chat_rooms WHERE id=$1 AND user_id=$2 AND is_del=false",
    [roomId, userId],
  );
  return result.rows[0];
}

async function messagesForRoom(userId, roomId, limit = 200) {
  const result = await query(
    `SELECT m.id, m.role, m.content, m.citations, m.created_at
     FROM chat_messages m JOIN chat_rooms r ON r.id=m.chat_room_id
     WHERE m.chat_room_id=$1 AND r.user_id=$2
       AND m.is_del=false AND r.is_del=false
     ORDER BY m.id DESC LIMIT $3`,
    [roomId, userId, limit]
  );
  return result.rows.reverse();
}

async function saveMessage(userId, roomId, role, content, citations = []) {
  const result = await query(
    `INSERT INTO chat_messages (chat_room_id,user_id,role,content,citations)
     SELECT id,$2,$3,$4,$5::jsonb FROM chat_rooms
     WHERE id=$1 AND user_id=$2 AND is_del=false RETURNING *`,
    [roomId, userId, role, content, JSON.stringify(citations)]
  );
  if (!result.rowCount) {
    const error = new Error("Conversation not found");
    error.status = 404;
    throw error;
  }
  await query("UPDATE chat_rooms SET updated_at=now() WHERE id=$1", [roomId]);
  return result.rows[0];
}

export async function recordSearchRun(client, userId, input, papers, papersByYear) {
  const runResult = await client.query(
    `INSERT INTO search_runs
      (user_id,query,year_from,year_to,max_results,status,result_count,stored_count,
       request_params,started_at,completed_at)
     VALUES ($1,$2,$3,$4,$5,'completed',$6,$6,$7::jsonb,now(),now()) RETURNING id`,
    [userId, input.keyword, input.yearFrom, input.yearTo, input.maxCount, papers.length,
      JSON.stringify({ sort: "pub date", source: "pubmed", papersByYear })]
  );
  const runId = runResult.rows[0].id;
  for (const [rank, paper] of papers.entries()) {
    await client.query(
      `INSERT INTO search_run_papers(search_run_id,user_id,pmid,result_rank,added_to_collection)
       VALUES($1,$2,$3,$4,false)`,
      [runId, userId, paper.pmid, rank + 1]
    );
  }
  return { runId, savedCount: 0 };
}

async function saveSearchRun(userId, input, papers, papersByYear) {
  return transaction((client) => recordSearchRun(client, userId, input, papers, papersByYear));
}

async function activeCollectionPmids(userId, pmids) {
  if (!pmids.length) return new Set();
  const result = await query(
    `SELECT pmid FROM user_paper_collections
     WHERE user_id=$1 AND pmid=ANY($2::text[]) AND is_del=false`,
    [userId, pmids],
  );
  return new Set(result.rows.map((row) => String(row.pmid)));
}

export function createApp({ authMiddleware = requireUser } = {}) {
  const app = express();
  const configuredOrigins = new Set(
    config.clientOrigin.split(",").map((item) => item.trim()).filter(Boolean)
  );
  app.disable("x-powered-by");
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use((req, res, next) => {
    const forwardedHost = req.headers["x-forwarded-host"]?.split(",")[0]?.trim();
    const requestHost = forwardedHost || req.headers.host;
    return cors({
      credentials: true,
      origin(origin, callback) {
        if (!origin) return callback(null, true);
        try {
          const sameOrigin = requestHost && new URL(origin).host === requestHost;
          return callback(null, sameOrigin || configuredOrigins.has(origin));
        } catch {
          return callback(null, false);
        }
      },
    })(req, res, next);
  });
  app.use(express.json({ limit: "8mb" }));

  app.get("/api/health", asyncRoute(async (_req, res) => {
    await query("SELECT 1");
    res.json({ status: "ok", revision: API_REVISION });
  }));
  app.use("/api", authMiddleware);

  app.get("/api/auth/me", (req, res) => res.json({ user: req.user }));

  app.post("/api/collection/search", asyncRoute(async (req, res) => {
    const input = parse(searchSchema, req.body);
    const [papers, papersByYear] = await Promise.all([
      searchPubMed(input),
      countPubMedByYear(input),
    ]);
    await upsertPapers(papers);
    const saved = await saveSearchRun(req.user.id, input, papers, papersByYear);
    const savedPmids = await activeCollectionPmids(req.user.id, papers.map((paper) => paper.pmid));
    res.json({
      papers: papers.map((paper) => ({
        ...paper,
        isSaved: savedPmids.has(String(paper.pmid)),
      })),
      papersByYear,
      total: papers.length,
      savedCount: 0,
      searchRunId: saved.runId,
    });
  }));

  app.post("/api/collection", asyncRoute(async (req, res) => {
    const input = parse(z.object({
      pmids: z.array(z.string().regex(/^\d+$/)).min(1).max(100),
      searchRunId: z.string().uuid().optional().nullable(),
    }), req.body);
    const savedPmids = await addToCollection(req.user.id, input.pmids, input.searchRunId);
    res.json({ savedPmids, savedCount: savedPmids.length });
  }));

  app.delete("/api/collection", asyncRoute(async (req, res) => {
    const result = await transaction((client) => resetUserWorkspace(client, req.user.id));
    res.json(result);
  }));

  app.delete("/api/collection/:pmid", asyncRoute(async (req, res) => {
    const pmid = parse(z.string().regex(/^\d+$/), req.params.pmid);
    const removed = await removeFromCollection(req.user.id, pmid);
    res.json({ removed, pmid });
  }));

  app.get("/api/projects", asyncRoute(async (req, res) => {
    res.json(await listProjects(req.user.id));
  }));

  app.post("/api/projects", asyncRoute(async (req, res) => {
    const input = parse(projectCreateSchema, req.body);
    const project = await createProject(req.user.id, input);
    res.status(201).json({ project });
  }));

  app.patch("/api/projects/:projectId", asyncRoute(async (req, res) => {
    const projectId = parse(projectIdSchema, req.params.projectId);
    const input = parse(projectUpdateSchema, req.body);
    const project = await updateProject(req.user.id, projectId, input);
    res.json({ project });
  }));

  app.delete("/api/projects/:projectId", asyncRoute(async (req, res) => {
    const projectId = parse(projectIdSchema, req.params.projectId);
    const project = await softDeleteProject(req.user.id, projectId);
    if (!project) return res.status(404).json({ error: "프로젝트를 찾을 수 없습니다." });
    return res.json({ project, removed: true });
  }));

  app.post("/api/projects/:projectId/restore", asyncRoute(async (req, res) => {
    const projectId = parse(projectIdSchema, req.params.projectId);
    const project = await restoreProject(req.user.id, projectId);
    res.json({ project, restored: true });
  }));

  app.put("/api/papers/:pmid/projects", asyncRoute(async (req, res) => {
    const pmid = parse(z.string().regex(/^\d+$/), req.params.pmid);
    const input = parse(z.object({
      projectIds: z.array(z.string().uuid()).max(100).default([]),
    }), req.body);
    const projects = await replacePaperProjects(req.user.id, pmid, input.projectIds);
    res.json({ pmid, projects });
  }));

  app.put("/api/papers/projects", asyncRoute(async (req, res) => {
    const input = parse(bulkPaperProjectSchema, req.body);
    const papers = await assignPapersToProjects(
      req.user.id,
      input.pmids,
      input.projectIds,
      input.mode,
    );
    res.json({ papers, updatedCount: papers.length, mode: input.mode });
  }));

  app.get("/api/papers", asyncRoute(async (req, res) => {
    const filters = paperFilters(req.query);
    if (filters.yearFrom && filters.yearTo && filters.yearFrom > filters.yearTo) {
      return res.status(400).json({ error: "yearFrom must be <= yearTo" });
    }
    const papers = await listPapers(req.user.id, filters);
    res.json({ papers, total: papers.length });
  }));

  app.get("/api/wordcloud", asyncRoute(async (req, res) => {
    const { limit: _paperLimit, ...filters } = paperFilters(req.query);
    if (filters.yearFrom && filters.yearTo && filters.yearFrom > filters.yearTo) {
      return res.status(400).json({ error: "yearFrom must be <= yearTo" });
    }
    const termLimit = parse(wordCloudTermLimitSchema, req.query.termLimit);
    const summary = await getInterestWordCloud(req.user.id, filters, { limit: termLimit });
    res.json(summary);
  }));

  app.get("/api/papers/filters", asyncRoute(async (req, res) => {
    const result = await query(
      `SELECT array_remove(array_agg(DISTINCT p.journal ORDER BY p.journal), '') AS journals,
              min(p.publication_year) AS min_year, max(p.publication_year) AS max_year
       FROM user_paper_collections up JOIN pubmed_records p ON p.pmid=up.pmid
       WHERE up.user_id=$1 AND up.is_del=false`,
      [req.user.id]
    );
    res.json(result.rows[0] || { journals: [], min_year: null, max_year: null });
  }));

  app.get("/api/papers/export.csv", asyncRoute(async (req, res) => {
    const papers = await listPapers(req.user.id, { ...paperFilters(req.query), limit: 10000 });
    const fields = ["pmid", "title", "abstract", "journal", "pub_year", "authors", "doi", "pmcid", "pubmed_url", "full_text_url"];
    const csv = [fields.join(","), ...papers.map((paper) => fields.map((field) => csvCell(paper[field])).join(","))].join("\r\n");
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", 'attachment; filename="publium-papers.csv"');
    res.send(`\ufeff${csv}`);
  }));

  app.get("/api/overview", asyncRoute(async (req, res) => {
    const [summary, years, journals, latestRun] = await Promise.all([
      query(`SELECT count(*)::int AS total_papers, count(DISTINCT NULLIF(p.journal,''))::int AS total_journals
             FROM user_paper_collections up JOIN pubmed_records p ON p.pmid=up.pmid
             WHERE up.user_id=$1 AND up.is_del=false`, [req.user.id]),
      query(`SELECT p.publication_year AS year, count(*)::int AS count FROM user_paper_collections up JOIN pubmed_records p ON p.pmid=up.pmid
             WHERE up.user_id=$1 AND up.is_del=false AND p.publication_year IS NOT NULL
             GROUP BY p.publication_year ORDER BY p.publication_year`, [req.user.id]),
      query(`SELECT p.journal, count(*)::int AS count FROM user_paper_collections up JOIN pubmed_records p ON p.pmid=up.pmid
             WHERE up.user_id=$1 AND up.is_del=false AND p.journal<>''
             GROUP BY p.journal ORDER BY count DESC, p.journal LIMIT 10`, [req.user.id]),
      query(`SELECT year_from, year_to, request_params
             FROM search_runs WHERE user_id=$1 AND status='completed' AND is_del=false
             ORDER BY created_at DESC LIMIT 1`, [req.user.id]),
    ]);
    const collectedByYear = Object.fromEntries(years.rows.map((row) => [row.year, row.count]));
    const latest = latestRun.rows[0];
    const storedTrend = latest?.request_params?.papersByYear;
    const papersByYear = latest
      ? fillYearRange(
          Number(latest.year_from),
          Number(latest.year_to),
          storedTrend && Object.keys(storedTrend).length ? storedTrend : collectedByYear,
        )
      : collectedByYear;
    res.json({
      totalPapers: summary.rows[0].total_papers,
      totalJournals: summary.rows[0].total_journals,
      papersByYear,
      topJournals: journals.rows,
    });
  }));

  app.get("/api/trend", asyncRoute(async (req, res) => {
    const input = parse(searchSchema.omit({ maxCount: true, saveToCollection: true }), req.query);
    res.json({ keyword: input.keyword, papersByYear: await countPubMedByYear(input) });
  }));

  app.get("/api/chat/conversations", asyncRoute(async (req, res) => {
    const result = await query(
      `SELECT r.id,r.title,r.created_at,r.updated_at,
              count(rp.pmid)::int AS paper_count,
              count(rp.pmid) FILTER (
                WHERE p.rag_status='ready' OR EXISTS (
                  SELECT 1 FROM user_paper_documents upd
                  WHERE upd.user_id=r.user_id AND upd.pmid=rp.pmid
                    AND upd.is_current AND not upd.is_del
                )
              )::int AS full_text_count
       FROM chat_rooms r
       LEFT JOIN chat_room_papers rp ON rp.chat_room_id=r.id
       LEFT JOIN pubmed_records p ON p.pmid=rp.pmid
       WHERE r.user_id=$1 AND r.is_del=false
       GROUP BY r.id ORDER BY r.updated_at DESC`,
      [req.user.id]
    );
    res.json({ conversations: result.rows });
  }));

  app.post("/api/chat/conversations/from-papers", asyncRoute(async (req, res) => {
    const input = parse(roomSchema, req.body);
    const owned = await query(
      `SELECT * FROM pubmed_records
       WHERE pmid=ANY($1::text[])
         AND pmid IN (
           SELECT pmid FROM user_paper_collections
           WHERE user_id=$2 AND is_del=false
         )`,
      [input.pmids, req.user.id]
    );
    if (owned.rowCount !== new Set(input.pmids).size) return res.status(403).json({ error: "All papers must belong to your collection" });
    const room = await transaction(async (client) => {
      const created = await client.query(
        "INSERT INTO chat_rooms(user_id,title) VALUES($1,$2) RETURNING *",
        [req.user.id, input.title || owned.rows[0]?.title?.slice(0, 120) || (input.pmids.length ? "논문 분석" : "새 채팅")]
      );
      for (const [position, pmid] of [...new Set(input.pmids)].entries()) {
        await client.query(
          "INSERT INTO chat_room_papers(chat_room_id,user_id,pmid,position) VALUES($1,$2,$3,$4)",
          [created.rows[0].id, req.user.id, pmid, position + 1]
        );
      }
      return created.rows[0];
    });
    const papers = [];
    for (const item of owned.rows) {
      const uploaded = await query(
        `SELECT 1 FROM user_paper_documents
         WHERE user_id=$1 AND pmid=$2 AND is_current AND not is_del`,
        [req.user.id, item.pmid],
      );
      papers.push({
        ...item,
        documentStatus: uploaded.rowCount ? "ready" : await ensurePaperDocument(item.pmid),
        documentSource: uploaded.rowCount ? "user_pdf" : undefined,
      });
    }
    res.status(201).json({ conversation: room, papers });
  }));

  app.get("/api/chat/conversations/:id", asyncRoute(async (req, res) => {
    const room = await roomForUser(req.user.id, req.params.id);
    if (!room) return res.status(404).json({ error: "Conversation not found" });
    const papers = await query(
      `SELECT p.*,p.publication_year AS pub_year,
              CASE WHEN uploaded.id IS NOT NULL OR p.rag_status='ready' THEN 'ready'
                   ELSE p.rag_status END AS document_status,
              CASE WHEN uploaded.id IS NOT NULL THEN 'user_pdf'
                   WHEN p.rag_status='ready' THEN 'pmc'
                   ELSE 'abstract' END AS document_source,
              uploaded.file_name AS uploaded_pdf_name,
              (uploaded.id IS NOT NULL) AS has_uploaded_pdf
       FROM chat_room_papers rp JOIN pubmed_records p ON p.pmid=rp.pmid
       LEFT JOIN LATERAL (
         SELECT id,file_name FROM user_paper_documents
         WHERE user_id=rp.user_id AND pmid=rp.pmid AND is_current AND not is_del
         ORDER BY created_at DESC LIMIT 1
       ) uploaded ON true
       WHERE rp.chat_room_id=$1 ORDER BY rp.position`,
      [room.id]
    );
    res.json({ conversation: room, papers: papers.rows });
  }));

  app.get("/api/papers/:pmid/sources", asyncRoute(async (req, res) => {
    const pmid = parse(z.string().regex(/^\d+$/), req.params.pmid);
    const owned = await query(
      "SELECT 1 FROM user_paper_collections WHERE user_id=$1 AND pmid=$2 AND not is_del",
      [req.user.id, pmid],
    );
    if (!owned.rowCount) return res.status(404).json({ error: "Paper not found in your collection" });
    const result = await query(
      `SELECT provider,format,source_url,landing_url,license,version,
              is_open_access,is_reusable,discovered_at
       FROM paper_source_candidates
       WHERE pmid=$1 AND not is_del
       ORDER BY CASE provider WHEN 'pmc' THEN 1 WHEN 'bioc' THEN 2
                              WHEN 'unpaywall' THEN 3 ELSE 4 END,
                CASE format WHEN 'pdf' THEN 1 WHEN 'jats' THEN 2 ELSE 3 END`,
      [pmid],
    );
    res.json({ pmid, sources: result.rows });
  }));

  app.post("/api/papers/:pmid/sources/discover", asyncRoute(async (req, res) => {
    const pmid = parse(z.string().regex(/^\d+$/), req.params.pmid);
    const owned = await query(
      "SELECT 1 FROM user_paper_collections WHERE user_id=$1 AND pmid=$2 AND not is_del",
      [req.user.id, pmid],
    );
    if (!owned.rowCount) return res.status(404).json({ error: "Paper not found in your collection" });
    const discovery = await refreshPaperSources(pmid);
    res.json({ pmid, ...discovery });
  }));

  app.post("/api/papers/:pmid/pdf", asyncRoute(async (req, res) => {
    const pmid = parse(z.string().regex(/^\d+$/), req.params.pmid);
    const input = parse(pdfUploadSchema, req.body);
    const expectedPrefix = `${req.user.id}/${pmid}/`;
    if (!input.storagePath.startsWith(expectedPrefix) || !input.storagePath.toLowerCase().endsWith(".pdf")) {
      return res.status(400).json({ error: "Invalid PDF storage path" });
    }
    const result = await persistUserPdf(req.user.id, pmid, input);
    if (!result) return res.status(404).json({ error: "Paper not found in your collection" });
    res.status(201).json(result);
  }));

  app.post("/api/papers/:pmid/pdf/upload-url", asyncRoute(async (req, res) => {
    const pmid = parse(z.string().regex(/^\d+$/), req.params.pmid);
    const input = parse(z.object({
      fileName: z.string().trim().min(1).max(255).refine((value) => /\.pdf$/i.test(value)),
      sizeBytes: z.coerce.number().int().min(1).max(25 * 1024 * 1024),
    }), req.body);
    const owned = await query(
      "SELECT 1 FROM user_paper_collections WHERE user_id=$1 AND pmid=$2 AND not is_del",
      [req.user.id, pmid],
    );
    if (!owned.rowCount) return res.status(404).json({ error: "Paper not found in your collection" });
    const path = `${req.user.id}/${pmid}/${randomUUID()}.pdf`;
    const { data, error } = await supabaseAdmin().storage
      .from("paper-pdfs")
      .createSignedUploadUrl(path);
    if (error) throw error;
    res.json({ path: data.path, token: data.token, maxBytes: 25 * 1024 * 1024 });
  }));

  app.get("/api/chat/conversations/:id/papers/:pmid/document", asyncRoute(async (req, res) => {
    const pmid = parse(z.string().regex(/^\d+$/), req.params.pmid);
    const documentId = req.query.documentId
      ? parse(z.string().uuid(), req.query.documentId)
      : null;
    const reader = await getRoomPaperDocument(req.user.id, req.params.id, pmid, documentId);
    if (!reader) return res.status(404).json({ error: "Paper not found in this conversation" });
    if (reader.paper?.pdfUrl) {
      const queryString = documentId ? `?documentId=${encodeURIComponent(documentId)}` : "";
      reader.paper.externalPdfUrl = reader.paper.pdfUrl;
      reader.paper.pdfUrl = `/api/chat/conversations/${encodeURIComponent(req.params.id)}/papers/${encodeURIComponent(pmid)}/pdf${queryString}`;
    }
    res.json(reader);
  }));

  app.get("/api/chat/conversations/:id/papers/:pmid/pdf", asyncRoute(async (req, res) => {
    const pmid = parse(z.string().regex(/^\d+$/), req.params.pmid);
    const documentId = req.query.documentId
      ? parse(z.string().uuid(), req.query.documentId)
      : null;
    const reader = await getRoomPaperDocument(req.user.id, req.params.id, pmid, documentId);
    const pdfUrl = reader?.paper?.pdfUrl;
    if (!pdfUrl) return res.status(404).json({ error: "PDF is not available" });
    const parsedUrl = new URL(pdfUrl);
    const allowedHost = parsedUrl.hostname === "pmc-oa-opendata.s3.amazonaws.com"
      || parsedUrl.hostname === "ftp.ncbi.nlm.nih.gov"
      || parsedUrl.hostname.endsWith(".supabase.co");
    if (!allowedHost) return res.status(422).json({ error: "This PDF can only be opened on the external provider" });
    const upstream = await fetch(pdfUrl, {
      headers: req.headers.range ? { Range: req.headers.range } : {},
      signal: AbortSignal.timeout(45_000),
    });
    if (!upstream.ok && upstream.status !== 206) {
      return res.status(502).json({ error: `PDF provider request failed (${upstream.status})` });
    }
    res.status(upstream.status === 206 ? 206 : 200);
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", "inline");
    for (const header of ["accept-ranges", "content-length", "content-range", "etag", "last-modified"]) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  }));

  app.delete("/api/chat/conversations/:id", asyncRoute(async (req, res) => {
    const result = await query(
      `UPDATE chat_rooms
       SET is_del=true,deleted_at=now(),deleted_by=$2
       WHERE id=$1 AND user_id=$2 AND is_del=false RETURNING id`,
      [req.params.id, req.user.id],
    );
    res.json({ removed: Boolean(result.rowCount) });
  }));

  const historyHandler = asyncRoute(async (req, res) => {
    if (!await roomForUser(req.user.id, req.params.id)) return res.status(404).json({ error: "Conversation not found" });
    res.json({ conversationId: req.params.id, messages: await messagesForRoom(req.user.id, req.params.id) });
  });
  app.get("/api/chat/:id/messages", historyHandler);
  app.get("/api/chat/conversations/:id/messages", historyHandler);

  const deleteHistoryHandler = asyncRoute(async (req, res) => {
    const result = await query(
      `UPDATE chat_messages
       SET is_del=true,deleted_at=now(),deleted_by=$2
       WHERE chat_room_id=$1 AND user_id=$2 AND is_del=false RETURNING id`,
      [req.params.id, req.user.id]
    );
    res.json({ conversationId: req.params.id, removedCount: result.rowCount });
  });
  app.delete("/api/chat/:id/messages", deleteHistoryHandler);
  app.delete("/api/chat/conversations/:id/messages", deleteHistoryHandler);

  app.post("/api/chat/stream", asyncRoute(async (req, res) => {
    const input = parse(chatSchema, req.body);
    if (!await roomForUser(req.user.id, input.conversationId)) return res.status(404).json({ error: "Conversation not found" });
    await saveMessage(req.user.id, input.conversationId, "user", input.message);
    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();
    const emitEvent = (event, data) =>
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const emit = (token) => emitEvent("token", { token });

    let result;
    try {
      result = await runGuardedChat({
        message: input.message,
        prepare: async (sanitizedMessage) => {
          const [context, history, scopeResult] = await Promise.all([
            retrieveRoomContext(req.user.id, input.conversationId, sanitizedMessage),
            messagesForRoom(req.user.id, input.conversationId, 30),
            query(
              `SELECT count(rp.pmid)::int AS paper_count,
                      count(rp.pmid) FILTER (
                        WHERE p.rag_status='ready' OR EXISTS (
                          SELECT 1 FROM user_paper_documents upd
                          WHERE upd.user_id=rp.user_id AND upd.pmid=rp.pmid
                            AND upd.is_current AND not upd.is_del
                        )
                      )::int AS full_text_count
               FROM chat_room_papers rp
               JOIN chat_rooms r ON r.id=rp.chat_room_id AND r.user_id=rp.user_id AND r.is_del=false
               JOIN pubmed_records p ON p.pmid=rp.pmid
               WHERE rp.chat_room_id=$1 AND rp.user_id=$2`,
              [input.conversationId, req.user.id],
            ),
          ]);
          const scope = evidenceScope(scopeResult.rows[0]);
          const evidence = context.map((item, index) =>
            `[근거 ${index + 1}] PMID ${item.pmid} / ${item.section}\n${item.content}`
          ).join("\n\n");
          const system = evidence
            ? `당신은 선택된 PubMed 논문을 분석하는 연구 보조자입니다.
제공된 근거 밖의 내용을 사실처럼 만들지 말고, 근거가 부족하면 명확히 말하세요.
근거 범위: ${scope.instruction}
이전 어시스턴트 답변은 논문 근거가 아닙니다. 이전 답변과 아래 근거가 충돌하면 반드시 아래 근거를 따르세요.
선택된 논문이 여러 편이면 모든 논문을 빠짐없이 고려하고, 공통점·차이점·상충하는 결과를 종합하세요.
개별 논문의 결과와 종합 해석을 구분하세요.
사용자가 명시적으로 요청하지 않는 한 답변 본문에 PMID 번호, 내부 근거 번호, 원시 식별자를 표시하지 마세요.
개인 진단·처방·복용량 안내는 하지 마세요. 한국어로 답하세요.
항상 결론과 핵심 답변을 가장 먼저 제시한 뒤 근거와 세부 내용을 설명하세요.
첫 답변은 '결론'이라는 제목을 붙이지 말고 2~4문장으로 바로 답하세요.
그다음부터 Markdown을 사용해 다음 순서로 작성하세요.
## 핵심 근거
짧은 불릿 목록으로 정리하세요.
선택 논문이 여러 편이면 ## 논문 간 비교를 추가해 공통점과 차이점을 표나 불릿으로 정리하세요.
마지막에는 ## 한계를 추가하세요.
긴 문단을 피하고 문단은 최대 3문장으로 제한하세요.

${evidence}`
            : `당신은 PubMed 연구 탐색을 돕는 연구 보조자입니다.
현재 이 채팅방에는 선택된 논문이 없습니다. 특정 논문의 결과를 아는 것처럼 답하지 마세요.
사용자의 연구 질문 구체화, PubMed 검색어·검색식 구성, 논문 선별 기준 정리를 도우세요.
개인 진단·처방·복용량 안내는 하지 말고 한국어로 답하세요.
항상 결론과 핵심 답변을 가장 먼저 제시한 뒤 근거와 세부 내용을 설명하세요.
첫 답변에는 '결론'이라는 제목을 붙이지 말고 바로 핵심 내용을 말하세요.
이후 내용에는 Markdown 제목과 짧은 불릿 목록을 사용하고, 한 문단은 최대 3문장으로 제한하세요.
논문 분석이 필요하면 먼저 논문 목록에서 논문을 선택해 채팅방으로 보내도록 안내하세요.`;
          return {
            context,
            history: history.slice(0, -1).map((item) => ({ role: item.role, content: item.content })),
            system,
          };
        },
      });
    } catch (error) {
      if (config.env !== "test") console.error("Guarded chat workflow failed", error);
      const message = "AI 응답을 시작하지 못했습니다. 잠시 후 다시 시도해주세요.";
      emit(message);
      await saveMessage(req.user.id, input.conversationId, "assistant", message);
      res.write("event: done\ndata: {}\n\n");
      return res.end();
    }

    const answer = result.response;
    emit(answer);
    const sources = result.decision === "allow"
      ? contextSources(result.context, { question: input.message, answer })
      : [];
    if (sources.length) emitEvent("sources", { sources });
    await saveMessage(req.user.id, input.conversationId, "assistant", answer, sources);
    res.write("event: done\ndata: {}\n\n");
    res.end();
  }));

  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    if (error instanceof z.ZodError) return res.status(400).json({ error: "Invalid request", issues: error.issues });
    const status = error.status || 500;
    if (config.env !== "test") console.error(error);
    return res.status(status).json({ error: status === 500 ? "Internal server error" : error.message });
  });
  return app;
}
