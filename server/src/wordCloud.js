import { query } from "./db.js";
import { extractPaperKeywords } from "../../shared/wordCloud.js";

export function summarizeWordCloud(papers = [], { limit = 160, projectId = "all" } = {}) {
  return {
    scope: "interest",
    projectId: projectId || "all",
    paperCount: papers.length,
    missingAbstractCount: papers.filter((paper) => !String(paper.abstract ?? "").trim()).length,
    terms: extractPaperKeywords(papers, { limit }),
  };
}

export async function getInterestWordCloudWithClient(
  client,
  userId,
  filters = {},
  { limit = 160 } = {},
) {
  const values = [userId];
  const where = ["collection.user_id=$1", "collection.is_del=false"];

  if (filters.keyword) {
    values.push(`%${filters.keyword}%`);
    where.push(`(paper.title ILIKE $${values.length} OR paper.abstract ILIKE $${values.length})`);
  }
  if (filters.yearFrom) {
    values.push(filters.yearFrom);
    where.push(`paper.publication_year >= $${values.length}`);
  }
  if (filters.yearTo) {
    values.push(filters.yearTo);
    where.push(`paper.publication_year <= $${values.length}`);
  }
  if (filters.journal) {
    values.push(filters.journal);
    where.push(`paper.journal = $${values.length}`);
  }
  if (filters.projectId === "unassigned") {
    where.push(`NOT EXISTS (
      SELECT 1
      FROM project_papers project_link
      JOIN research_projects project
        ON project.id=project_link.project_id AND project.user_id=project_link.user_id
      WHERE project_link.user_id=collection.user_id
        AND project_link.pmid=collection.pmid
        AND project_link.is_del=false
        AND project.is_del=false
    )`);
  } else if (filters.projectId) {
    values.push(filters.projectId);
    where.push(`EXISTS (
      SELECT 1
      FROM project_papers project_link
      JOIN research_projects project
        ON project.id=project_link.project_id AND project.user_id=project_link.user_id
      WHERE project_link.user_id=collection.user_id
        AND project_link.pmid=collection.pmid
        AND project_link.project_id=$${values.length}
        AND project_link.is_del=false
        AND project.is_del=false
    )`);
  }

  const result = await client.query(
    `SELECT paper.title,paper.abstract
     FROM user_paper_collections collection
     JOIN pubmed_records paper ON paper.pmid=collection.pmid
     WHERE ${where.join(" AND ")}
     ORDER BY paper.pmid`,
    values,
  );

  return summarizeWordCloud(result.rows, {
    limit,
    projectId: filters.projectId || "all",
  });
}

export function getInterestWordCloud(userId, filters = {}, options = {}) {
  return getInterestWordCloudWithClient({ query }, userId, filters, options);
}
