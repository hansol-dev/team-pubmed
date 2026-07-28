import { XMLParser } from "fast-xml-parser";
import OpenAI from "openai";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { plainText } from "./pubmed.js";
import { query, transaction } from "./db.js";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", textNodeName: "#text" });
const array = (value) => value == null ? [] : Array.isArray(value) ? value : [value];
let openai;

function getOpenAI() {
  if (!config.openaiApiKey) return null;
  openai ||= new OpenAI({ apiKey: config.openaiApiKey });
  return openai;
}

function collectSections(node, inheritedTitle = "본문", output = []) {
  if (!node || typeof node !== "object") return output;
  for (const section of array(node.sec)) {
    const title = plainText(section.title) || inheritedTitle;
    const paragraphs = array(section.p).map(plainText).filter(Boolean);
    if (paragraphs.length) output.push({ section: title, text: paragraphs.join("\n\n") });
    collectSections(section, title, output);
  }
  return output;
}

export function parsePmcXml(xml) {
  const data = parser.parse(xml);
  const article = data?.article || data?.pmc?.article || data?.["pmc-articleset"]?.article;
  if (!article) throw new Error("PMC returned an unsupported XML document");
  const body = article.body || {};
  const sections = collectSections(body);
  const looseParagraphs = array(body.p).map(plainText).filter(Boolean);
  if (looseParagraphs.length) sections.unshift({ section: "본문", text: looseParagraphs.join("\n\n") });
  const license = plainText(article.front?.["article-meta"]?.permissions?.license?.["license-p"]) ||
    plainText(article.front?.["article-meta"]?.permissions?.["copyright-statement"]);
  return { sections, license };
}

export function chunkSections(sections, maxChars = 4200, overlap = 400) {
  const chunks = [];
  for (const { section, text } of sections) {
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + maxChars, text.length);
      if (end < text.length) {
        const boundary = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(". ", end));
        if (boundary > start + maxChars * 0.6) end = boundary + 1;
      }
      const content = text.slice(start, end).trim();
      if (content) chunks.push({ section, content });
      if (end >= text.length) break;
      start = Math.max(start + 1, end - overlap);
    }
  }
  return chunks;
}

export function balanceRoomContext(overviews, chunks, limit = 8) {
  const target = Math.max(limit, overviews.length);
  const balanced = [...overviews];
  const picked = new Set();

  for (const overview of overviews) {
    if (balanced.length >= target) break;
    const bestChunk = chunks.find((item) => item.pmid === overview.pmid && !picked.has(item));
    if (bestChunk) {
      picked.add(bestChunk);
      balanced.push(bestChunk);
    }
  }
  for (const chunk of chunks) {
    if (balanced.length >= target) break;
    if (!picked.has(chunk)) balanced.push(chunk);
  }
  return balanced.slice(0, target);
}

async function embed(contents) {
  const client = getOpenAI();
  if (!client || !contents.length) return contents.map(() => null);
  try {
    const response = await client.embeddings.create({ model: config.embeddingModel, input: contents });
    return response.data.map((item) => item.embedding);
  } catch {
    return contents.map(() => null);
  }
}

async function persistDocument(paper, sections, license, rawXml) {
  const chunks = chunkSections(sections);
  const embeddings = await embed(chunks.map((chunk) => chunk.content));
  await transaction(async (client) => {
    const content = sections.map((item) => `${item.section}\n${item.text}`).join("\n\n");
    const hash = createHash("sha256").update(content).digest("hex");
    const existing = await client.query(
      "SELECT id FROM paper_documents WHERE pmid=$1 AND content_hash=$2",
      [paper.pmid, hash]
    );
    let documentId = existing.rows[0]?.id;
    if (!documentId) {
      await client.query("UPDATE paper_documents SET is_current=false WHERE pmid=$1 AND is_current", [paper.pmid]);
      const inserted = await client.query(
        `INSERT INTO paper_documents
          (pmid,pmcid,source,source_url,license,is_open_access,content,raw_xml,
           content_hash,parser_version,is_current)
         VALUES ($1,$2,'pmc',$3,$4,true,$5,$6,$7,'publium-js-1',true) RETURNING id`,
        [paper.pmid, paper.pmcid, `https://pmc.ncbi.nlm.nih.gov/articles/${paper.pmcid}/`,
          license, content, rawXml, hash]
      );
      documentId = inserted.rows[0].id;
    } else {
      await client.query(
        "UPDATE paper_documents SET is_current=(id=$2),fetched_at=CASE WHEN id=$2 THEN now() ELSE fetched_at END WHERE pmid=$1",
        [paper.pmid, documentId]
      );
    }
    await client.query("DELETE FROM paper_chunks WHERE document_id = $1", [documentId]);
    for (let index = 0; index < chunks.length; index += 1) {
      const embedding = embeddings[index];
      await client.query(
        `INSERT INTO paper_chunks
          (document_id,pmid,section,chunk_index,content,token_count,embedding,embedding_model)
         VALUES ($1,$2,$3,$4,$5,$6,${embedding ? "$7::extensions.vector" : "NULL"},${embedding ? "$8" : "NULL"})`,
        embedding
          ? [documentId, paper.pmid, chunks[index].section, index, chunks[index].content,
            Math.ceil(chunks[index].content.length / 4), JSON.stringify(embedding), config.embeddingModel]
          : [documentId, paper.pmid, chunks[index].section, index, chunks[index].content,
            Math.ceil(chunks[index].content.length / 4)]
      );
    }
    await client.query("UPDATE pubmed_records SET rag_status='ready' WHERE pmid=$1", [paper.pmid]);
  });
}

export async function ensurePaperDocument(pmid) {
  const existing = await query(
    "SELECT id FROM paper_documents WHERE pmid=$1 AND is_current",
    [pmid]
  );
  if (existing.rowCount) return "ready";
  const paperResult = await query("SELECT * FROM pubmed_records WHERE pmid=$1", [pmid]);
  if (!paperResult.rowCount) throw new Error(`Unknown PMID: ${pmid}`);
  const paper = paperResult.rows[0];
  if (!paper.pmcid) {
    await query("UPDATE pubmed_records SET rag_status='abstract_only' WHERE pmid=$1", [pmid]);
    return "abstract_only";
  }
  try {
    await query("UPDATE pubmed_records SET rag_status='processing' WHERE pmid=$1", [pmid]);
    const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi");
    Object.entries({ db: "pmc", id: paper.pmcid.replace(/^PMC/i, ""), retmode: "xml", tool: config.ncbiTool,
      ...(config.ncbiEmail ? { email: config.ncbiEmail } : {}), ...(config.ncbiApiKey ? { api_key: config.ncbiApiKey } : {}) })
      .forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
    if (!response.ok) throw new Error(`PMC request failed (${response.status})`);
    const rawXml = await response.text();
    const parsed = parsePmcXml(rawXml);
    if (!parsed.sections.length) throw new Error("PMC full text did not contain readable body sections");
    // Store only PMC documents with an explicit reusable/open-access license.
    if (!parsed.license) throw new Error("PMC document has no explicit open-access license");
    await persistDocument(paper, parsed.sections, parsed.license, rawXml);
    return "ready";
  } catch (error) {
    // Do not crawl DOI/publisher pages. PubMed abstract is the only legal fallback here.
    await query("UPDATE pubmed_records SET rag_status='abstract_only' WHERE pmid=$1", [pmid]);
    return "abstract_only";
  }
}

export async function retrieveRoomContext(userId, roomId, question, limit = 10) {
  const embedding = (await embed([question]))[0];
  let chunks = [];
  if (embedding) {
    try {
      const result = await query(
        `WITH ranked AS (
           SELECT pc.pmid,pc.section,pc.content,rp.position,
                  pc.embedding <=> $3::extensions.vector AS distance,
                  row_number() OVER (
                    PARTITION BY pc.pmid
                    ORDER BY pc.embedding <=> $3::extensions.vector
                  ) AS paper_rank
           FROM chat_room_papers rp
           JOIN chat_rooms r ON r.id=rp.chat_room_id AND r.user_id=rp.user_id
           JOIN paper_chunks pc ON pc.pmid=rp.pmid
           JOIN paper_documents pd ON pd.id=pc.document_id AND pd.is_current
           WHERE rp.chat_room_id=$1 AND r.user_id=$2 AND pc.embedding IS NOT NULL
         )
         SELECT pmid,section,content,1-distance AS relevance
         FROM ranked
         WHERE paper_rank<=2
         ORDER BY paper_rank,position,distance
         LIMIT $4`,
        [roomId, userId, JSON.stringify(embedding), limit]
      );
      chunks = result.rows;
    } catch {
      // pgvector may be unavailable; deterministic chunk fallback follows.
    }
  }
  if (!chunks.length) {
    const result = await query(
    `WITH ranked AS (
       SELECT pc.pmid,pc.section,pc.content,rp.position,
              row_number() OVER (
                PARTITION BY pc.pmid
                ORDER BY CASE WHEN pc.section='초록' THEN 0 ELSE 1 END,pc.chunk_index
              ) AS paper_rank
       FROM chat_room_papers rp
       JOIN chat_rooms r ON r.id=rp.chat_room_id AND r.user_id=rp.user_id
       JOIN paper_chunks pc ON pc.pmid=rp.pmid
       JOIN paper_documents pd ON pd.id=pc.document_id AND pd.is_current
       WHERE rp.chat_room_id=$1 AND r.user_id=$2
     )
     SELECT pmid,section,content,NULL::float AS relevance
     FROM ranked
     WHERE paper_rank<=2
     ORDER BY paper_rank,position
     LIMIT $3`,
    [roomId, userId, limit]
  );
    chunks = result.rows;
  }
  const overviews = await query(
    `SELECT p.pmid,'논문 개요' AS section,
            concat_ws(E'\n',
              '제목: ' || COALESCE(NULLIF(p.title,''),'제목 없음'),
              CASE WHEN COALESCE(p.journal,'')<>'' THEN '저널: ' || p.journal END,
              CASE WHEN p.publication_year IS NOT NULL THEN '발행 연도: ' || p.publication_year::text END,
              '초록: ' || CASE WHEN COALESCE(p.abstract,'')<>'' THEN p.abstract
                              ELSE '초록이 제공되지 않습니다.' END
            ) AS content,
            NULL::float AS relevance, rp.position
     FROM chat_room_papers rp JOIN pubmed_records p ON p.pmid=rp.pmid
     WHERE rp.chat_room_id=$1 AND rp.user_id=$2
     ORDER BY rp.position`,
    [roomId, userId]
  );
  return balanceRoomContext(overviews.rows, chunks, limit);
}
