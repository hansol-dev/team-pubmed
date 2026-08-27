import { query } from "./db.js";

function numeric(value) {
  return Number(value ?? 0);
}

function yearCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([year, count]) => /^\d{4}$/.test(year) && Number.isFinite(Number(count)))
      .map(([year, count]) => [year, Number(count)]),
  );
}

export async function getOverviewWithClient(client, userId) {
  const [summaryResult, projectsResult, latestRunResult] = await Promise.all([
    client.query(
      `WITH active_collection AS (
         SELECT collection.pmid,paper.journal,paper.rag_status,
                EXISTS (
                  SELECT 1 FROM user_paper_documents document
                  WHERE document.user_id=collection.user_id
                    AND document.pmid=collection.pmid
                    AND document.is_current=true AND document.is_del=false
                ) AS has_user_document,
                EXISTS (
                  SELECT 1
                  FROM project_papers project_link
                  JOIN research_projects project
                    ON project.id=project_link.project_id
                   AND project.user_id=project_link.user_id
                  WHERE project_link.user_id=collection.user_id
                    AND project_link.pmid=collection.pmid
                    AND project_link.is_del=false AND project.is_del=false
                ) AS is_assigned
         FROM user_paper_collections collection
         JOIN pubmed_records paper ON paper.pmid=collection.pmid
         WHERE collection.user_id=$1 AND collection.is_del=false
       )
       SELECT count(*)::int AS total_papers,
              count(DISTINCT NULLIF(journal,''))::int AS total_journals,
              count(*) FILTER (
                WHERE rag_status='ready' OR has_user_document
              )::int AS ready_count,
              count(*) FILTER (
                WHERE NOT (rag_status='ready' OR has_user_document)
                  AND rag_status IN ('pending','processing')
              )::int AS processing_count,
              count(*) FILTER (
                WHERE NOT (rag_status='ready' OR has_user_document)
                  AND COALESCE(rag_status,'') NOT IN ('pending','processing')
              )::int AS abstract_only_count,
              count(*) FILTER (WHERE NOT is_assigned)::int AS unassigned_count,
              (SELECT count(*)::int FROM research_projects project
               WHERE project.user_id=$1 AND project.is_del=false) AS project_count
       FROM active_collection`,
      [userId],
    ),
    client.query(
      `SELECT project.id,project.name,project.color,
              count(collection.pmid)::int AS paper_count
       FROM research_projects project
       LEFT JOIN project_papers project_link
         ON project_link.project_id=project.id
        AND project_link.user_id=project.user_id
        AND project_link.is_del=false
       LEFT JOIN user_paper_collections collection
         ON collection.user_id=project_link.user_id
        AND collection.pmid=project_link.pmid
        AND collection.is_del=false
       WHERE project.user_id=$1 AND project.is_del=false
       GROUP BY project.id
       ORDER BY paper_count DESC,project.sort_order,project.created_at,project.id
       LIMIT 6`,
      [userId],
    ),
    client.query(
      `SELECT query,year_from,year_to,result_count,request_params,created_at
       FROM search_runs
       WHERE user_id=$1 AND status='completed' AND is_del=false
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    ),
  ]);

  const summary = summaryResult.rows[0] ?? {};
  const latest = latestRunResult.rows[0];
  const papersByYear = yearCounts(latest?.request_params?.papersByYear);
  const totalMatches = Object.values(papersByYear).reduce((sum, count) => sum + count, 0);

  return {
    totalPapers: numeric(summary.total_papers),
    totalJournals: numeric(summary.total_journals),
    projectCount: numeric(summary.project_count),
    unassignedCount: numeric(summary.unassigned_count),
    projectDistribution: projectsResult.rows.map((project) => ({
      id: project.id,
      name: project.name,
      color: project.color,
      paperCount: numeric(project.paper_count),
    })),
    analysisStatus: {
      ready: numeric(summary.ready_count),
      abstractOnly: numeric(summary.abstract_only_count),
      processing: numeric(summary.processing_count),
    },
    papersByYear,
    latestSearch: latest ? {
      keyword: latest.query,
      yearFrom: numeric(latest.year_from),
      yearTo: numeric(latest.year_to),
      resultCount: numeric(latest.result_count),
      totalMatches,
      searchedAt: latest.created_at,
    } : null,
  };
}

export function getOverview(userId) {
  return getOverviewWithClient({ query }, userId);
}
