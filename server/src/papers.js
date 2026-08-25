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

export async function addToCollectionWithClient(client, userId, pmids, searchRunId = null) {
  if (searchRunId) {
    const sourceRun = await client.query(
      `SELECT id FROM search_runs
       WHERE id=$1 AND user_id=$2 AND is_del=false`,
      [searchRunId, userId],
    );
    if (!sourceRun.rowCount) {
      const error = new Error("Search result not found");
      error.status = 404;
      throw error;
    }
  }

  const result = await client.query(
    `INSERT INTO user_paper_collections (user_id, pmid, first_search_run_id)
     SELECT $1, p.pmid, $3::uuid
     FROM pubmed_records p
     WHERE p.pmid = ANY($2::text[])
       AND ($3::uuid IS NULL OR EXISTS (
         SELECT 1 FROM search_run_papers result
         WHERE result.search_run_id=$3 AND result.user_id=$1
           AND result.pmid=p.pmid
       ))
     ON CONFLICT (user_id, pmid) DO UPDATE
     SET is_del=false,deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,saved_at=now(),
         first_search_run_id=COALESCE(user_paper_collections.first_search_run_id,
                                      EXCLUDED.first_search_run_id)
     WHERE user_paper_collections.is_del=true
     RETURNING pmid`,
    [userId, pmids, searchRunId],
  );

  if (searchRunId) {
    await client.query(
      `UPDATE search_run_papers result
       SET added_to_collection=true
       WHERE result.search_run_id=$1 AND result.user_id=$2
         AND result.pmid=ANY($3::text[])
         AND EXISTS (
           SELECT 1 FROM user_paper_collections collection
           WHERE collection.user_id=$2 AND collection.pmid=result.pmid
             AND collection.is_del=false
         )`,
      [searchRunId, userId, pmids],
    );
  }

  return result.rows.map((row) => row.pmid);
}

export async function addToCollection(userId, pmids, searchRunId = null) {
  return transaction((client) =>
    addToCollectionWithClient(client, userId, pmids, searchRunId));
}

export async function removeFromCollectionWithClient(client, userId, pmid) {
  const result = await client.query(
    `UPDATE user_paper_collections
     SET is_del=true,deleted_at=now(),deleted_by=$1,
         delete_reason='user_removed_interest'
     WHERE user_id=$1 AND pmid=$2 AND is_del=false
     RETURNING pmid`,
    [userId, pmid],
  );
  return Boolean(result.rowCount);
}

export async function removeFromCollection(userId, pmid) {
  return removeFromCollectionWithClient({ query }, userId, pmid);
}

export async function listPapersWithClient(client, userId, filters = {}) {
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
  if (filters.projectId === "unassigned") {
    where.push(`NOT EXISTS (
      SELECT 1 FROM project_papers project_link
      JOIN research_projects project
        ON project.id=project_link.project_id AND project.user_id=project_link.user_id
      WHERE project_link.user_id=up.user_id AND project_link.pmid=up.pmid
        AND project_link.is_del=false AND project.is_del=false
    )`);
  } else if (filters.projectId) {
    values.push(filters.projectId);
    where.push(`EXISTS (
      SELECT 1 FROM project_papers project_link
      JOIN research_projects project
        ON project.id=project_link.project_id AND project.user_id=project_link.user_id
      WHERE project_link.user_id=up.user_id AND project_link.pmid=up.pmid
        AND project_link.project_id=$${values.length}
        AND project_link.is_del=false AND project.is_del=false
    )`);
  }
  values.push(filters.limit || 100);
  const result = await client.query(
    `SELECT p.*, p.publication_year AS pub_year, up.saved_at AS collected_at,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id',project.id,'name',project.name,'color',project.color
         ) ORDER BY project.sort_order,project.created_at,project.id)
         FROM project_papers project_link
         JOIN research_projects project
           ON project.id=project_link.project_id AND project.user_id=project_link.user_id
         WHERE project_link.user_id=up.user_id AND project_link.pmid=up.pmid
           AND project_link.is_del=false AND project.is_del=false
       ),'[]'::jsonb) AS projects,
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

export async function listPapers(userId, filters = {}) {
  return listPapersWithClient({ query }, userId, filters);
}
