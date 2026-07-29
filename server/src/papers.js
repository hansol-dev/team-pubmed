import { query, transaction } from "./db.js";

export async function upsertPapers(papers) {
  if (!papers.length) return;
  await transaction(async (client) => {
    for (const paper of papers) {
      await client.query(
        `INSERT INTO pubmed_records
          (pmid, title, abstract, journal, publication_year, authors, doi, pmcid,
           pubmed_url, full_text_url, full_text_source, full_text_status,
           metadata_fetched_at, abstract_fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,now(),
                 CASE WHEN $3 <> '' THEN now() ELSE NULL END)
         ON CONFLICT (pmid) DO UPDATE SET
           title = CASE WHEN EXCLUDED.title <> '' THEN EXCLUDED.title ELSE pubmed_records.title END,
           abstract = CASE WHEN EXCLUDED.abstract <> '' THEN EXCLUDED.abstract ELSE pubmed_records.abstract END,
           journal = CASE WHEN EXCLUDED.journal <> '' THEN EXCLUDED.journal ELSE pubmed_records.journal END,
           publication_year = COALESCE(EXCLUDED.publication_year, pubmed_records.publication_year),
           authors = CASE WHEN jsonb_array_length(EXCLUDED.authors) > 0 THEN EXCLUDED.authors ELSE pubmed_records.authors END,
           doi = COALESCE(NULLIF(EXCLUDED.doi, ''), pubmed_records.doi),
           pmcid = COALESCE(NULLIF(EXCLUDED.pmcid, ''), pubmed_records.pmcid),
           pubmed_url = EXCLUDED.pubmed_url,
           full_text_url = COALESCE(EXCLUDED.full_text_url, pubmed_records.full_text_url),
           full_text_source = COALESCE(EXCLUDED.full_text_source, pubmed_records.full_text_source),
           full_text_status = EXCLUDED.full_text_status,
           abstract_fetched_at = CASE WHEN EXCLUDED.abstract <> '' THEN now() ELSE pubmed_records.abstract_fetched_at END,
           metadata_fetched_at = now()`,
        [paper.pmid, paper.title || "제목 없음", paper.abstract, paper.journal, paper.pub_year, JSON.stringify(paper.authors),
          paper.doi || null, paper.pmcid || null, paper.pubmed_url, paper.full_text_url, paper.full_text_source,
          paper.pmcid ? "pmc_available" : (paper.doi ? "publisher_only" : "unavailable")]
      );
    }
  });
}

export async function addToCollection(userId, pmids, keyword = "") {
  const result = await query(
    `INSERT INTO user_paper_collections (user_id, pmid)
     SELECT $1, p.pmid FROM pubmed_records p WHERE p.pmid = ANY($2::text[])
     ON CONFLICT (user_id, pmid) DO UPDATE
     SET is_del=false,deleted_at=NULL,deleted_by=NULL,saved_at=now()
     WHERE user_paper_collections.is_del=true
     RETURNING pmid`,
    [userId, pmids]
  );
  return result.rows.map((row) => row.pmid);
}

export async function listPapers(userId, filters = {}) {
  const values = [userId];
  const where = ["up.user_id = $1", "up.is_del = false"];
  if (filters.keyword) {
    values.push(`%${filters.keyword}%`);
    where.push(`(p.title ILIKE $${values.length} OR p.abstract ILIKE $${values.length})`);
  }
  if (filters.yearFrom) {
    values.push(filters.yearFrom);
    where.push(`p.publication_year >= $${values.length}`);
  }
  if (filters.yearTo) {
    values.push(filters.yearTo);
    where.push(`p.publication_year <= $${values.length}`);
  }
  if (filters.journal) {
    values.push(filters.journal);
    where.push(`p.journal = $${values.length}`);
  }
  values.push(filters.limit || 100);
  const result = await query(
    `SELECT p.*, p.publication_year AS pub_year, up.saved_at AS collected_at,
       CASE WHEN user_document.id IS NOT NULL OR p.rag_status='ready' THEN 'ready'
            ELSE p.rag_status END AS document_status,
       CASE WHEN user_document.id IS NOT NULL THEN 'user_pdf'
            WHEN p.rag_status='ready' THEN 'pmc'
            ELSE 'abstract' END AS document_source,
       user_document.file_name AS uploaded_pdf_name,
       (user_document.id IS NOT NULL) AS has_uploaded_pdf,
       CASE WHEN p.pmcid IS NOT NULL THEN 'pmc_full_text'
            WHEN p.doi IS NOT NULL THEN 'publisher_link' ELSE 'abstract_only' END AS access_level
     FROM user_paper_collections up JOIN pubmed_records p ON p.pmid = up.pmid
     LEFT JOIN LATERAL (
       SELECT id,file_name FROM user_paper_documents
       WHERE user_id=up.user_id AND pmid=up.pmid AND is_current AND not is_del
       ORDER BY created_at DESC LIMIT 1
     ) user_document ON true
     WHERE ${where.join(" AND ")}
     ORDER BY p.publication_year DESC NULLS LAST, p.pmid DESC LIMIT $${values.length}`,
    values
  );
  return result.rows;
}
