import { XMLParser } from "fast-xml-parser";
import OpenAI from "openai";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { plainText } from "./pubmed.js";
import { query, transaction } from "./db.js";
import { discoverFullText, fetchBiocFullText } from "./fulltext.js";
import { supabaseAdmin } from "./auth.js";

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

function readerSections(sections) {
  return sections.map((item, sectionIndex) => ({
    id: `section-${sectionIndex + 1}`,
    title: item.section || "본문",
    paragraphs: String(item.text || "")
      .split(/\n{2,}/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean),
  })).filter((item) => item.paragraphs.length);
}

export function buildPaperReader(paper, document = null) {
  let bodySections = [];
  if (Array.isArray(document?.sections) && document.sections.length) {
    bodySections = readerSections(document.sections);
  } else if (document?.raw_xml) {
    try {
      bodySections = readerSections(parsePmcXml(document.raw_xml).sections);
    } catch {
      bodySections = [];
    }
  }
  const sections = paper.abstract
    ? [{
      id: "abstract",
      title: "초록",
      paragraphs: [paper.abstract],
    }, ...bodySections]
    : bodySections;
  const hasFullText = bodySections.length > 0;
  return {
    paper: {
      pmid: paper.pmid,
      title: paper.title,
      authors: paper.authors,
      journal: paper.journal,
      publicationYear: paper.publication_year,
      pmcid: paper.pmcid,
      doi: paper.doi,
      pubmedUrl: paper.pubmed_url,
      fullTextUrl: document?.source_url || paper.full_text_url,
      pdfUrl: document?.signed_url || paper.pdf_url || null,
      pdfSource: document?.source === "user_pdf" ? "user_pdf" : paper.pdf_source || null,
      hasUploadedPdf: document?.source === "user_pdf",
    },
    document: {
      status: hasFullText ? "full_text" : "abstract_only",
      source: document?.source || (paper.pmcid ? "pmc" : "abstract"),
      sourceUrl: document?.source_url || paper.full_text_url || paper.pubmed_url,
      license: document?.license || null,
      fileName: document?.file_name || null,
      documentId: document?.id || null,
      contentHash: document?.content_hash || null,
      sections,
    },
  };
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

async function persistDocument(paper, sections, license, rawXml, sourceUrl) {
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
          (pmid,pmcid,source,source_url,license,is_open_access,content,raw_xml,sections,
           content_hash,parser_version,is_current)
         VALUES ($1,$2,'pmc',$3,$4,true,$5,$6,$7::jsonb,$8,'publium-js-2',true) RETURNING id`,
        [paper.pmid, paper.pmcid, sourceUrl || `https://pmc.ncbi.nlm.nih.gov/articles/${paper.pmcid}/`,
          license, content, rawXml, JSON.stringify(sections), hash]
      );
      documentId = inserted.rows[0].id;
    } else {
      await client.query(
        "UPDATE paper_documents SET is_current=(id=$2),fetched_at=CASE WHEN id=$2 THEN now() ELSE fetched_at END WHERE pmid=$1",
        [paper.pmid, documentId]
      );
    }
    await client.query(
      "UPDATE paper_chunks SET is_del=true,deleted_at=now() WHERE document_id=$1 AND is_del=false",
      [documentId],
    );
    for (let index = 0; index < chunks.length; index += 1) {
      const embedding = embeddings[index];
      await client.query(
        `INSERT INTO paper_chunks
          (document_id,pmid,section,chunk_index,content,token_count,embedding,embedding_model)
         VALUES ($1,$2,$3,$4,$5,$6,${embedding ? "$7::extensions.vector" : "NULL"},${embedding ? "$8" : "NULL"})
         ON CONFLICT (document_id,chunk_index) DO UPDATE SET
           pmid=EXCLUDED.pmid,
           section=EXCLUDED.section,
           content=EXCLUDED.content,
           token_count=EXCLUDED.token_count,
           embedding=EXCLUDED.embedding,
           embedding_model=EXCLUDED.embedding_model,
           is_del=false,
           deleted_at=NULL`,
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

async function persistSourceCandidates(paper, discovery) {
  for (const resource of discovery.resources || []) {
    const candidates = [
      ["pdf", resource.pdfUrl],
      ["jats", resource.xmlUrl],
      ["text", resource.textUrl],
      ["package", resource.packageUrl],
      ["landing_page", resource.landingUrl],
    ].filter(([, url]) => url);
    for (const [format, sourceUrl] of candidates) {
      await query(
        `INSERT INTO paper_source_candidates
          (pmid,provider,format,source_url,landing_url,license,version,
           is_open_access,is_reusable,metadata,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,now()+interval '7 days')
         ON CONFLICT (pmid,provider,format,source_url) DO UPDATE SET
           landing_url=EXCLUDED.landing_url,license=EXCLUDED.license,
           version=EXCLUDED.version,is_open_access=EXCLUDED.is_open_access,
           is_reusable=EXCLUDED.is_reusable,metadata=EXCLUDED.metadata,
           discovered_at=now(),expires_at=EXCLUDED.expires_at,is_del=false,deleted_at=null`,
        [paper.pmid, resource.source, format, sourceUrl, resource.landingUrl || null,
          resource.license || null, resource.version ? String(resource.version) : null,
          Boolean(resource.isOpenAccess),
          Boolean(resource.isOpenAccess && (resource.license || resource.source === "pmc")),
          JSON.stringify(resource)],
      );
    }
  }
  await query(
    `UPDATE pubmed_records SET
       pdf_url=COALESCE($2,pdf_url),
       pdf_source=COALESCE($3,pdf_source),
       full_text_url=COALESCE($4,full_text_url),
       full_text_source=COALESCE($5,full_text_source),
       full_text_license=COALESCE($6,full_text_license),
       full_text_discovered_at=now()
     WHERE pmid=$1`,
    [paper.pmid, discovery.pdfUrl, discovery.pdfSource, discovery.landingUrl,
      discovery.source === "pmc" ? "pmc" : discovery.source ? "publisher" : null,
      discovery.license],
  );
}

export async function refreshPaperSources(pmid) {
  const result = await query("SELECT * FROM pubmed_records WHERE pmid=$1", [pmid]);
  if (!result.rowCount) return null;
  const discovery = await discoverFullText(result.rows[0]);
  await persistSourceCandidates(result.rows[0], discovery);
  return discovery;
}

export async function persistUserPdf(userId, pmid, input) {
  const paperResult = await query(
    `SELECT p.* FROM user_paper_collections up
     JOIN pubmed_records p ON p.pmid=up.pmid
     WHERE up.user_id=$1 AND up.pmid=$2 AND up.is_del=false`,
    [userId, pmid],
  );
  if (!paperResult.rowCount) return null;
  const sections = input.sections
    .map((item, index) => ({
      section: String(item.section || `페이지 ${index + 1}`).trim(),
      text: String(item.text || "").trim(),
    }))
    .filter((item) => item.text);
  const content = sections.map((item) => `${item.section}\n${item.text}`).join("\n\n");
  if (content.length < 80) {
    const error = new Error("PDF에서 분석 가능한 텍스트를 찾지 못했습니다. 스캔 PDF는 OCR이 필요합니다.");
    error.status = 422;
    throw error;
  }
  const chunks = chunkSections(sections);
  const embeddings = await embed(chunks.map((chunk) => chunk.content));
  const hash = createHash("sha256").update(content).digest("hex");
  const document = await transaction(async (client) => {
    await client.query(
      `UPDATE user_paper_documents
       SET is_current=false
       WHERE user_id=$1 AND pmid=$2 AND is_current AND not is_del`,
      [userId, pmid],
    );
    const inserted = await client.query(
      `INSERT INTO user_paper_documents
        (user_id,pmid,storage_path,file_name,size_bytes,page_count,content,sections,
         content_hash,parser_version,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,'pdfjs-client-1','ready')
       ON CONFLICT (user_id,pmid,content_hash) DO UPDATE SET
         storage_path=EXCLUDED.storage_path,file_name=EXCLUDED.file_name,
         size_bytes=EXCLUDED.size_bytes,page_count=EXCLUDED.page_count,
         content=EXCLUDED.content,sections=EXCLUDED.sections,status='ready',
         error_message=null,is_current=true,is_del=false,deleted_at=null,updated_at=now()
       RETURNING *`,
      [userId, pmid, input.storagePath, input.fileName, input.sizeBytes,
        input.pageCount, content, JSON.stringify(sections), hash],
    );
    const row = inserted.rows[0];
    await client.query(
      "UPDATE user_paper_chunks SET is_del=true,deleted_at=now() WHERE document_id=$1 AND not is_del",
      [row.id],
    );
    for (let index = 0; index < chunks.length; index += 1) {
      const embedding = embeddings[index];
      await client.query(
        `INSERT INTO user_paper_chunks
          (document_id,user_id,pmid,section,chunk_index,content,token_count,embedding,embedding_model)
         VALUES ($1,$2,$3,$4,$5,$6,$7,${embedding ? "$8::extensions.vector" : "NULL"},${embedding ? "$9" : "NULL"})
         ON CONFLICT (document_id,chunk_index) DO UPDATE SET
           section=EXCLUDED.section,content=EXCLUDED.content,token_count=EXCLUDED.token_count,
           embedding=EXCLUDED.embedding,embedding_model=EXCLUDED.embedding_model,
           is_del=false,deleted_at=null`,
        embedding
          ? [row.id, userId, pmid, chunks[index].section, index, chunks[index].content,
            Math.ceil(chunks[index].content.length / 4), JSON.stringify(embedding), config.embeddingModel]
          : [row.id, userId, pmid, chunks[index].section, index, chunks[index].content,
            Math.ceil(chunks[index].content.length / 4)],
      );
    }
    return row;
  });
  return { documentId: document.id, status: "ready", pageCount: document.page_count };
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
  let discovery = { resources: [] };
  try {
    await query("UPDATE pubmed_records SET rag_status='processing' WHERE pmid=$1", [pmid]);
    discovery = await refreshPaperSources(pmid) || discovery;
    if (!paper.pmcid) throw new Error("Paper has no PMCID");
    const aws = discovery.resources.find((item) => item.source === "pmc" && item.xmlUrl && item.isOpenAccess);
    let rawXml = "";
    let parsed;
    let sourceUrl = aws?.xmlUrl;
    if (sourceUrl) {
      const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(45_000) });
      if (!response.ok) throw new Error(`PMC AWS XML request failed (${response.status})`);
      rawXml = await response.text();
      parsed = parsePmcXml(rawXml);
    } else {
      const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi");
      Object.entries({ db: "pmc", id: paper.pmcid.replace(/^PMC/i, ""), retmode: "xml", tool: config.ncbiTool,
        ...(config.ncbiEmail ? { email: config.ncbiEmail } : {}), ...(config.ncbiApiKey ? { api_key: config.ncbiApiKey } : {}) })
        .forEach(([key, value]) => url.searchParams.set(key, value));
      sourceUrl = url.toString();
      const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      if (!response.ok) throw new Error(`PMC request failed (${response.status})`);
      rawXml = await response.text();
      parsed = parsePmcXml(rawXml);
    }
    if (!parsed.sections.length) throw new Error("PMC full text did not contain readable body sections");
    const license = aws?.license || parsed.license || discovery.license;
    if (!license) throw new Error("PMC document has no explicit open-access license");
    await persistDocument(paper, parsed.sections, license, rawXml, sourceUrl);
    return "ready";
  } catch (error) {
    try {
      const bioc = await fetchBiocFullText(paper);
      const pmcResource = discovery.resources.find((item) => item.source === "pmc" && item.isOpenAccess);
      if (bioc?.sections.length && pmcResource?.license) {
        await persistDocument(paper, bioc.sections, pmcResource.license, null, bioc.sourceUrl);
        await query(
          `INSERT INTO paper_source_candidates
            (pmid,provider,format,source_url,landing_url,license,is_open_access,is_reusable,metadata,expires_at)
           VALUES ($1,'bioc','bioc_json',$2,$3,$4,true,true,'{}'::jsonb,now()+interval '7 days')
           ON CONFLICT (pmid,provider,format,source_url) DO UPDATE SET
             discovered_at=now(),expires_at=EXCLUDED.expires_at,is_del=false,deleted_at=null`,
          [paper.pmid, bioc.sourceUrl, pmcResource.landingUrl, pmcResource.license],
        );
        return "ready";
      }
    } catch {
      // The saved abstract remains the legal and deterministic final fallback.
    }
    await query("UPDATE pubmed_records SET rag_status='abstract_only' WHERE pmid=$1", [pmid]);
    return "abstract_only";
  }
}

export async function getRoomPaperDocument(userId, roomId, pmid, requestedDocumentId = null) {
  const owned = await query(
    `SELECT p.*
     FROM chat_room_papers rp
     JOIN chat_rooms r
       ON r.id=rp.chat_room_id AND r.user_id=rp.user_id AND r.is_del=false
     JOIN user_paper_collections up
       ON up.user_id=rp.user_id AND up.pmid=rp.pmid AND up.is_del=false
     JOIN pubmed_records p ON p.pmid=rp.pmid
     WHERE rp.chat_room_id=$1 AND rp.user_id=$2 AND rp.pmid=$3`,
    [roomId, userId, pmid],
  );
  if (!owned.rowCount) return null;
  let paper = owned.rows[0];
  await ensurePaperDocument(pmid);
  if (!paper.full_text_discovered_at) {
    try {
      await refreshPaperSources(pmid);
    } catch {
      // The reader can still show the stored document or abstract.
    }
  }
  const refreshedPaper = await query("SELECT * FROM pubmed_records WHERE pmid=$1", [pmid]);
  if (refreshedPaper.rowCount) paper = refreshedPaper.rows[0];
  const userDocument = await query(
    `SELECT id,'user_pdf'::text AS source,storage_path AS source_url,
            null::text AS license,null::text AS raw_xml,sections,content_hash,file_name
     FROM user_paper_documents
     WHERE user_id=$1 AND pmid=$2 AND not is_del
       AND ($3::uuid IS NULL AND is_current OR id=$3::uuid)
     ORDER BY is_current DESC,created_at DESC LIMIT 1`,
    [userId, pmid, requestedDocumentId],
  );
  let document = userDocument.rows[0] || null;
  if (document) {
    document.storage_path = document.source_url;
    const { data, error } = await supabaseAdmin().storage
      .from("paper-pdfs")
      .createSignedUrl(document.source_url, 3600);
    if (!error) {
      document.signed_url = data.signedUrl;
      document.source_url = data.signedUrl;
    }
  } else {
    const sharedDocument = await query(
      `SELECT id,source,source_url,license,raw_xml,sections,content_hash
       FROM paper_documents
       WHERE pmid=$1 AND ($2::uuid IS NULL AND is_current OR id=$2::uuid)
       ORDER BY is_current DESC,fetched_at DESC LIMIT 1`,
      [pmid, requestedDocumentId],
    );
    document = sharedDocument.rows[0] || null;
  }
  return buildPaperReader(paper, document);
}

export async function retrieveRoomContext(userId, roomId, question, limit = 10) {
  const embedding = (await embed([question]))[0];
  let chunks = [];
  if (embedding) {
    try {
      const result = await query(
        `WITH accessible_chunks AS (
           SELECT pc.id AS chunk_id,pc.document_id,pc.pmid,pc.section,pc.content,
                  pc.embedding,pd.content_hash,1 AS source_priority
           FROM paper_chunks pc
           JOIN paper_documents pd ON pd.id=pc.document_id AND pd.is_current
           WHERE pc.is_del=false
           UNION ALL
           SELECT upc.id AS chunk_id,upc.document_id,upc.pmid,upc.section,upc.content,
                  upc.embedding,upd.content_hash,0 AS source_priority
           FROM user_paper_chunks upc
           JOIN user_paper_documents upd
             ON upd.id=upc.document_id AND upd.user_id=upc.user_id
            AND upd.is_current AND not upd.is_del
           WHERE upc.user_id=$2 AND not upc.is_del
         ), ranked AS (
           SELECT pc.chunk_id,pc.document_id,pc.content_hash,
                  pc.pmid,pc.section,pc.content,rp.position,
                  pc.embedding <=> $3::extensions.vector AS distance,
                  row_number() OVER (
                    PARTITION BY pc.pmid
                    ORDER BY pc.embedding <=> $3::extensions.vector,pc.source_priority
                  ) AS paper_rank
           FROM chat_room_papers rp
           JOIN chat_rooms r ON r.id=rp.chat_room_id AND r.user_id=rp.user_id
           JOIN accessible_chunks pc ON pc.pmid=rp.pmid
           WHERE rp.chat_room_id=$1 AND r.user_id=$2
             AND r.is_del=false AND pc.embedding IS NOT NULL
         )
         SELECT chunk_id,document_id,content_hash,pmid,section,content,1-distance AS relevance
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
    `WITH accessible_chunks AS (
       SELECT pc.id AS chunk_id,pc.document_id,pc.pmid,pc.section,pc.chunk_index,
              pc.content,pd.content_hash,1 AS source_priority
       FROM paper_chunks pc
       JOIN paper_documents pd ON pd.id=pc.document_id AND pd.is_current
       WHERE pc.is_del=false
       UNION ALL
       SELECT upc.id AS chunk_id,upc.document_id,upc.pmid,upc.section,upc.chunk_index,
              upc.content,upd.content_hash,0 AS source_priority
       FROM user_paper_chunks upc
       JOIN user_paper_documents upd
         ON upd.id=upc.document_id AND upd.user_id=upc.user_id
        AND upd.is_current AND not upd.is_del
       WHERE upc.user_id=$2 AND not upc.is_del
     ), ranked AS (
       SELECT pc.chunk_id,pc.document_id,pc.content_hash,
              pc.pmid,pc.section,pc.content,rp.position,
              row_number() OVER (
                PARTITION BY pc.pmid
                ORDER BY pc.source_priority,
                         CASE WHEN pc.section='초록' THEN 0 ELSE 1 END,pc.chunk_index
              ) AS paper_rank
       FROM chat_room_papers rp
       JOIN chat_rooms r ON r.id=rp.chat_room_id AND r.user_id=rp.user_id
       JOIN accessible_chunks pc ON pc.pmid=rp.pmid
       WHERE rp.chat_room_id=$1 AND r.user_id=$2
         AND r.is_del=false
     )
     SELECT chunk_id,document_id,content_hash,pmid,section,content,NULL::float AS relevance
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
            NULL::float AS relevance, rp.position,
            NULL::bigint AS chunk_id,NULL::uuid AS document_id,NULL::text AS content_hash
     FROM chat_room_papers rp JOIN pubmed_records p ON p.pmid=rp.pmid
     WHERE rp.chat_room_id=$1 AND rp.user_id=$2
     ORDER BY rp.position`,
    [roomId, userId]
  );
  return balanceRoomContext(overviews.rows, chunks, limit);
}
