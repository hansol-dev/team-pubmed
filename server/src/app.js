import cors from "cors";
import express from "express";
import helmet from "helmet";
import OpenAI from "openai";
import { z } from "zod";
import { config } from "./config.js";
import { requireUser } from "./auth.js";
import { query, transaction } from "./db.js";
import { BLOCKED_RESPONSE, isMedicalAdviceRequest } from "./guard.js";
import { addToCollection, listPapers, upsertPapers } from "./papers.js";
import { ensurePaperDocument, retrieveRoomContext } from "./pmc.js";
import { countPubMedByYear, searchPubMed } from "./pubmed.js";

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const parse = (schema, value) => schema.parse(value);
const searchSchema = z.object({
  keyword: z.string().trim().min(1).max(120),
  yearFrom: z.coerce.number().int().min(1900).max(2100),
  yearTo: z.coerce.number().int().min(1900).max(2100),
  maxCount: z.coerce.number().int().min(1).max(100).default(50),
  saveToCollection: z.boolean().optional().default(true),
}).refine((value) => value.yearFrom <= value.yearTo, { message: "yearFrom must be <= yearTo" });
const roomSchema = z.object({
  pmids: z.array(z.string().regex(/^\d+$/)).max(5).default([]),
  title: z.string().trim().max(120).optional(),
});
const chatSchema = z.object({
  conversationId: z.string().uuid(),
  message: z.string().trim().min(1).max(4000),
});

export function fillYearRange(yearFrom, yearTo, counts = {}) {
  if (!Number.isInteger(yearFrom) || !Number.isInteger(yearTo) || yearFrom > yearTo) return counts;
  const completed = {};
  for (let year = yearFrom; year <= yearTo; year += 1) {
    completed[year] = Number(counts[year] ?? counts[String(year)] ?? 0);
  }
  return completed;
}

function paperFilters(input) {
  return parse(z.object({
    keyword: z.string().trim().max(120).optional(),
    yearFrom: z.coerce.number().int().min(1900).max(2100).optional(),
    yearTo: z.coerce.number().int().min(1900).max(2100).optional(),
    journal: z.string().trim().max(300).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
  }), input);
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

async function roomForUser(userId, roomId) {
  const result = await query("SELECT * FROM chat_rooms WHERE id=$1 AND user_id=$2", [roomId, userId]);
  return result.rows[0];
}

async function messagesForRoom(userId, roomId, limit = 200) {
  const result = await query(
    `SELECT m.id, m.role, m.content, m.created_at
     FROM chat_messages m JOIN chat_rooms r ON r.id=m.chat_room_id
     WHERE m.chat_room_id=$1 AND r.user_id=$2 ORDER BY m.id DESC LIMIT $3`,
    [roomId, userId, limit]
  );
  return result.rows.reverse();
}

async function saveMessage(userId, roomId, role, content) {
  const result = await query(
    `INSERT INTO chat_messages (chat_room_id,user_id,role,content)
     SELECT id,$2,$3,$4 FROM chat_rooms WHERE id=$1 AND user_id=$2 RETURNING *`,
    [roomId, userId, role, content]
  );
  if (!result.rowCount) {
    const error = new Error("Conversation not found");
    error.status = 404;
    throw error;
  }
  await query("UPDATE chat_rooms SET updated_at=now() WHERE id=$1", [roomId]);
  return result.rows[0];
}

async function saveSearchRun(userId, input, papers, papersByYear) {
  return transaction(async (client) => {
    const runResult = await client.query(
      `INSERT INTO search_runs
        (user_id,query,year_from,year_to,max_results,status,result_count,stored_count,
         request_params,started_at,completed_at)
       VALUES ($1,$2,$3,$4,$5,'completed',$6,$6,$7::jsonb,now(),now()) RETURNING id`,
      [userId, input.keyword, input.yearFrom, input.yearTo, input.maxCount, papers.length,
        JSON.stringify({ sort: "pub date", source: "pubmed", papersByYear })]
    );
    const runId = runResult.rows[0].id;
    let savedCount = 0;
    if (input.saveToCollection && papers.length) {
      const saved = await client.query(
        `INSERT INTO user_paper_collections(user_id,pmid,first_search_run_id)
         SELECT $1,unnest($2::text[]),$3
         ON CONFLICT(user_id,pmid) DO NOTHING RETURNING pmid`,
        [userId, papers.map((paper) => paper.pmid), runId]
      );
      savedCount = saved.rowCount;
    }
    for (const [rank, paper] of papers.entries()) {
      await client.query(
        `INSERT INTO search_run_papers(search_run_id,user_id,pmid,result_rank,added_to_collection)
         VALUES($1,$2,$3,$4,$5)`,
        [runId, userId, paper.pmid, rank + 1, input.saveToCollection]
      );
    }
    return { runId, savedCount };
  });
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
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", asyncRoute(async (_req, res) => {
    await query("SELECT 1");
    res.json({ status: "ok" });
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
    res.json({
      papers,
      papersByYear,
      total: papers.length,
      savedCount: saved.savedCount,
      searchRunId: saved.runId,
    });
  }));

  app.post("/api/collection", asyncRoute(async (req, res) => {
    const input = parse(z.object({
      pmids: z.array(z.string().regex(/^\d+$/)).min(1).max(100),
      keyword: z.string().trim().max(120).optional().default(""),
    }), req.body);
    const savedPmids = await addToCollection(req.user.id, input.pmids, input.keyword);
    res.json({ savedPmids, savedCount: savedPmids.length });
  }));

  app.delete("/api/collection", asyncRoute(async (req, res) => {
    const result = await query(
      "DELETE FROM user_paper_collections WHERE user_id=$1 RETURNING pmid",
      [req.user.id]
    );
    res.json({ removedCount: result.rowCount });
  }));

  app.delete("/api/collection/:pmid", asyncRoute(async (req, res) => {
    const pmid = parse(z.string().regex(/^\d+$/), req.params.pmid);
    const result = await query(
      "DELETE FROM user_paper_collections WHERE user_id=$1 AND pmid=$2 RETURNING pmid",
      [req.user.id, pmid]
    );
    res.json({ removed: Boolean(result.rowCount), pmid });
  }));

  app.get("/api/papers", asyncRoute(async (req, res) => {
    const filters = paperFilters(req.query);
    if (filters.yearFrom && filters.yearTo && filters.yearFrom > filters.yearTo) {
      return res.status(400).json({ error: "yearFrom must be <= yearTo" });
    }
    const papers = await listPapers(req.user.id, filters);
    res.json({ papers, total: papers.length });
  }));

  app.get("/api/papers/filters", asyncRoute(async (req, res) => {
    const result = await query(
      `SELECT array_remove(array_agg(DISTINCT p.journal ORDER BY p.journal), '') AS journals,
              min(p.publication_year) AS min_year, max(p.publication_year) AS max_year
       FROM user_paper_collections up JOIN pubmed_records p ON p.pmid=up.pmid WHERE up.user_id=$1`,
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
             FROM user_paper_collections up JOIN pubmed_records p ON p.pmid=up.pmid WHERE up.user_id=$1`, [req.user.id]),
      query(`SELECT p.publication_year AS year, count(*)::int AS count FROM user_paper_collections up JOIN pubmed_records p ON p.pmid=up.pmid
             WHERE up.user_id=$1 AND p.publication_year IS NOT NULL GROUP BY p.publication_year ORDER BY p.publication_year`, [req.user.id]),
      query(`SELECT p.journal, count(*)::int AS count FROM user_paper_collections up JOIN pubmed_records p ON p.pmid=up.pmid
             WHERE up.user_id=$1 AND p.journal<>'' GROUP BY p.journal ORDER BY count DESC, p.journal LIMIT 10`, [req.user.id]),
      query(`SELECT year_from, year_to, request_params
             FROM search_runs WHERE user_id=$1 AND status='completed'
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
      `SELECT r.id,r.title,r.created_at,r.updated_at,count(rp.pmid)::int AS paper_count
       FROM chat_rooms r LEFT JOIN chat_room_papers rp ON rp.chat_room_id=r.id
       WHERE r.user_id=$1 GROUP BY r.id ORDER BY r.updated_at DESC`,
      [req.user.id]
    );
    res.json({ conversations: result.rows });
  }));

  app.post("/api/chat/conversations/from-papers", asyncRoute(async (req, res) => {
    const input = parse(roomSchema, req.body);
    const owned = await query(
      "SELECT * FROM pubmed_records WHERE pmid=ANY($1::text[]) AND pmid IN (SELECT pmid FROM user_paper_collections WHERE user_id=$2)",
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
      papers.push({ ...item, documentStatus: await ensurePaperDocument(item.pmid) });
    }
    res.status(201).json({ conversation: room, papers });
  }));

  app.get("/api/chat/conversations/:id", asyncRoute(async (req, res) => {
    const room = await roomForUser(req.user.id, req.params.id);
    if (!room) return res.status(404).json({ error: "Conversation not found" });
    const papers = await query(
      `SELECT p.*,p.publication_year AS pub_year,p.rag_status AS document_status
       FROM chat_room_papers rp JOIN pubmed_records p ON p.pmid=rp.pmid
       WHERE rp.chat_room_id=$1 ORDER BY rp.position`,
      [room.id]
    );
    res.json({ conversation: room, papers: papers.rows });
  }));

  app.delete("/api/chat/conversations/:id", asyncRoute(async (req, res) => {
    const result = await query("DELETE FROM chat_rooms WHERE id=$1 AND user_id=$2 RETURNING id", [req.params.id, req.user.id]);
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
      `DELETE FROM chat_messages WHERE chat_room_id=$1 AND user_id=$2 RETURNING id`,
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
    const emit = (token) => res.write(`data: ${JSON.stringify({ token })}\n\n`);

    if (isMedicalAdviceRequest(input.message)) {
      emit(BLOCKED_RESPONSE);
      await saveMessage(req.user.id, input.conversationId, "assistant", BLOCKED_RESPONSE);
      res.write("event: done\ndata: {}\n\n");
      return res.end();
    }
    if (!config.openaiApiKey) {
      const message = "OPENAI_API_KEY가 설정되지 않았습니다.";
      emit(message);
      await saveMessage(req.user.id, input.conversationId, "assistant", message);
      res.write("event: done\ndata: {}\n\n");
      return res.end();
    }

    const [context, history] = await Promise.all([
      retrieveRoomContext(req.user.id, input.conversationId, input.message),
      messagesForRoom(req.user.id, input.conversationId, 30),
    ]);
    const evidence = context.map((item, index) =>
      `[근거 ${index + 1}] PMID ${item.pmid} / ${item.section}\n${item.content}`
    ).join("\n\n");
    const system = evidence
      ? `당신은 선택된 PubMed 논문을 분석하는 연구 보조자입니다.
제공된 근거 밖의 내용을 사실처럼 만들지 말고, 근거가 부족하면 명확히 말하세요.
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
    const client = new OpenAI({ apiKey: config.openaiApiKey });
    let stream;
    try {
      stream = await client.chat.completions.create({
        model: config.chatModel,
        stream: true,
        messages: [
          { role: "system", content: system },
          ...history.slice(0, -1).map((item) => ({ role: item.role, content: item.content })),
          { role: "user", content: input.message },
        ],
      });
    } catch (error) {
      if (config.env !== "test") console.error("OpenAI stream startup failed", error);
      const message = "AI 응답을 시작하지 못했습니다. 잠시 후 다시 시도해주세요.";
      emit(message);
      await saveMessage(req.user.id, input.conversationId, "assistant", message);
      res.write("event: done\ndata: {}\n\n");
      return res.end();
    }
    let answer = "";
    try {
      for await (const part of stream) {
        const token = part.choices[0]?.delta?.content || "";
        if (token) {
          answer += token;
          emit(token);
        }
      }
      if (answer) await saveMessage(req.user.id, input.conversationId, "assistant", answer);
      res.write("event: done\ndata: {}\n\n");
      res.end();
    } catch (error) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: "응답 스트리밍이 중단되었습니다." })}\n\n`);
      res.end();
    }
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
