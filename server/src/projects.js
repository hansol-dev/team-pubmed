import { query, transaction } from "./db.js";

function projectError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeProjectConflict(error) {
  if (error?.code === "23505") throw projectError("같은 이름의 활성 프로젝트가 이미 있습니다.", 409);
  throw error;
}

export async function listProjectsWithClient(client, userId) {
  const [projectsResult, countsResult] = await Promise.all([
    client.query(
      `SELECT project.id,project.name,project.description,project.color,
              project.sort_order,project.created_at,project.updated_at,
              count(collection.pmid)::int AS paper_count
       FROM research_projects project
       LEFT JOIN project_papers link
         ON link.project_id=project.id AND link.user_id=project.user_id
        AND link.is_del=false
       LEFT JOIN user_paper_collections collection
         ON collection.user_id=link.user_id AND collection.pmid=link.pmid
        AND collection.is_del=false
       WHERE project.user_id=$1 AND project.is_del=false
       GROUP BY project.id
       ORDER BY project.sort_order,project.created_at,project.id`,
      [userId],
    ),
    client.query(
      `SELECT count(*)::int AS total_count,
              count(*) FILTER (WHERE NOT EXISTS (
                SELECT 1
                FROM project_papers link
                JOIN research_projects project
                  ON project.id=link.project_id AND project.user_id=link.user_id
                WHERE link.user_id=collection.user_id
                  AND link.pmid=collection.pmid
                  AND link.is_del=false
                  AND project.is_del=false
              ))::int AS unassigned_count
       FROM user_paper_collections collection
       WHERE collection.user_id=$1 AND collection.is_del=false`,
      [userId],
    ),
  ]);
  const counts = countsResult.rows[0] ?? {};
  return {
    projects: projectsResult.rows,
    totalCount: Number(counts.total_count ?? 0),
    unassignedCount: Number(counts.unassigned_count ?? 0),
  };
}

export function listProjects(userId) {
  return listProjectsWithClient({ query }, userId);
}

export async function createProjectWithClient(client, userId, input) {
  try {
    const result = await client.query(
      `INSERT INTO research_projects (user_id,name,description,color,sort_order)
       VALUES ($1,$2,$3,$4,
         COALESCE((SELECT max(sort_order)+1 FROM research_projects
                   WHERE user_id=$1 AND is_del=false),0))
       RETURNING id,name,description,color,sort_order,created_at,updated_at`,
      [userId, input.name, input.description ?? "", input.color ?? "#7c6ee6"],
    );
    return { ...result.rows[0], paper_count: 0 };
  } catch (error) {
    normalizeProjectConflict(error);
  }
}

export function createProject(userId, input) {
  return createProjectWithClient({ query }, userId, input);
}

export async function updateProjectWithClient(client, userId, projectId, input) {
  try {
    const result = await client.query(
      `UPDATE research_projects
       SET name=COALESCE($3,name),description=COALESCE($4,description),
           color=COALESCE($5,color)
       WHERE id=$1 AND user_id=$2 AND is_del=false
       RETURNING id,name,description,color,sort_order,created_at,updated_at`,
      [projectId, userId, input.name ?? null, input.description ?? null, input.color ?? null],
    );
    if (!result.rowCount) throw projectError("프로젝트를 찾을 수 없습니다.", 404);
    return result.rows[0];
  } catch (error) {
    normalizeProjectConflict(error);
  }
}

export function updateProject(userId, projectId, input) {
  return updateProjectWithClient({ query }, userId, projectId, input);
}

export async function softDeleteProjectWithClient(client, userId, projectId) {
  const project = await client.query(
    `UPDATE research_projects
     SET is_del=true,deleted_at=now(),deleted_by=$1,delete_reason='user_deleted_project'
     WHERE id=$2 AND user_id=$1 AND is_del=false
     RETURNING id,name`,
    [userId, projectId],
  );
  if (!project.rowCount) return null;
  const links = await client.query(
    `UPDATE project_papers
     SET is_del=true,deleted_at=now(),deleted_by=$1,delete_reason='project_deleted'
     WHERE project_id=$2 AND user_id=$1 AND is_del=false
     RETURNING pmid`,
    [userId, projectId],
  );
  return { ...project.rows[0], removedPaperCount: links.rowCount };
}

export function softDeleteProject(userId, projectId) {
  return transaction((client) => softDeleteProjectWithClient(client, userId, projectId));
}

export async function restoreProjectWithClient(client, userId, projectId) {
  try {
    const project = await client.query(
      `UPDATE research_projects
       SET is_del=false,deleted_at=NULL,deleted_by=NULL,delete_reason=NULL
       WHERE id=$1 AND user_id=$2 AND is_del=true
       RETURNING id,name,description,color,sort_order,created_at,updated_at`,
      [projectId, userId],
    );
    if (!project.rowCount) throw projectError("복구할 프로젝트를 찾을 수 없습니다.", 404);
    const links = await client.query(
      `UPDATE project_papers link
       SET is_del=false,deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,added_at=now()
       FROM user_paper_collections collection
       WHERE link.project_id=$1 AND link.user_id=$2
         AND link.is_del=true AND link.delete_reason='project_deleted'
         AND collection.user_id=link.user_id AND collection.pmid=link.pmid
         AND collection.is_del=false
       RETURNING link.pmid`,
      [projectId, userId],
    );
    return { ...project.rows[0], restoredPaperCount: links.rowCount };
  } catch (error) {
    normalizeProjectConflict(error);
  }
}

export function restoreProject(userId, projectId) {
  return transaction((client) => restoreProjectWithClient(client, userId, projectId));
}

export async function replacePaperProjectsWithClient(client, userId, pmid, projectIds) {
  const uniqueProjectIds = [...new Set(projectIds)];
  const collection = await client.query(
    `SELECT pmid FROM user_paper_collections
     WHERE user_id=$1 AND pmid=$2 AND is_del=false`,
    [userId, pmid],
  );
  if (!collection.rowCount) throw projectError("관심 논문을 찾을 수 없습니다.", 404);

  if (uniqueProjectIds.length) {
    const ownedProjects = await client.query(
      `SELECT id FROM research_projects
       WHERE user_id=$1 AND id=ANY($2::uuid[]) AND is_del=false`,
      [userId, uniqueProjectIds],
    );
    if (ownedProjects.rowCount !== uniqueProjectIds.length) {
      throw projectError("선택한 프로젝트를 찾을 수 없습니다.", 404);
    }
  }

  await client.query(
    `UPDATE project_papers
     SET is_del=true,deleted_at=now(),deleted_by=$1,delete_reason='user_unassigned_paper'
     WHERE user_id=$1 AND pmid=$2 AND is_del=false
       AND NOT (project_id=ANY($3::uuid[]))`,
    [userId, pmid, uniqueProjectIds],
  );

  if (uniqueProjectIds.length) {
    await client.query(
      `INSERT INTO project_papers (user_id,project_id,pmid)
       SELECT $1,project.id,$3
       FROM research_projects project
       WHERE project.user_id=$1 AND project.id=ANY($2::uuid[]) AND project.is_del=false
       ON CONFLICT (user_id,project_id,pmid) DO UPDATE
       SET is_del=false,deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,added_at=now()`,
      [userId, uniqueProjectIds, pmid],
    );
  }

  const result = await client.query(
    `SELECT project.id,project.name,project.color
     FROM project_papers link
     JOIN research_projects project
       ON project.id=link.project_id AND project.user_id=link.user_id
     WHERE link.user_id=$1 AND link.pmid=$2
       AND link.is_del=false AND project.is_del=false
     ORDER BY project.sort_order,project.created_at,project.id`,
    [userId, pmid],
  );
  return result.rows;
}

export function replacePaperProjects(userId, pmid, projectIds) {
  return transaction((client) =>
    replacePaperProjectsWithClient(client, userId, pmid, projectIds));
}

export async function assignPapersToProjectsWithClient(
  client,
  userId,
  pmids,
  projectIds,
  mode = "add",
) {
  const uniquePmids = [...new Set(pmids.map(String))];
  const uniqueProjectIds = [...new Set(projectIds)];
  const collections = await client.query(
    `SELECT pmid FROM user_paper_collections
     WHERE user_id=$1 AND pmid=ANY($2::text[]) AND is_del=false`,
    [userId, uniquePmids],
  );
  if (collections.rowCount !== uniquePmids.length) {
    throw projectError("선택한 관심 논문을 찾을 수 없습니다.", 404);
  }

  if (uniqueProjectIds.length) {
    const ownedProjects = await client.query(
      `SELECT id FROM research_projects
       WHERE user_id=$1 AND id=ANY($2::uuid[]) AND is_del=false`,
      [userId, uniqueProjectIds],
    );
    if (ownedProjects.rowCount !== uniqueProjectIds.length) {
      throw projectError("선택한 프로젝트를 찾을 수 없습니다.", 404);
    }
  }

  if (mode === "replace") {
    await client.query(
      `UPDATE project_papers
       SET is_del=true,deleted_at=now(),deleted_by=$1,
           delete_reason='bulk_replaced_projects'
       WHERE user_id=$1 AND pmid=ANY($2::text[]) AND is_del=false
         AND NOT (project_id=ANY($3::uuid[]))`,
      [userId, uniquePmids, uniqueProjectIds],
    );
  }

  if (uniqueProjectIds.length) {
    await client.query(
      `INSERT INTO project_papers (user_id,project_id,pmid)
       SELECT $1,project.id,collection.pmid
       FROM research_projects project
       CROSS JOIN user_paper_collections collection
       WHERE project.user_id=$1 AND project.id=ANY($3::uuid[]) AND project.is_del=false
         AND collection.user_id=$1 AND collection.pmid=ANY($2::text[])
         AND collection.is_del=false
       ON CONFLICT (user_id,project_id,pmid) DO UPDATE
       SET is_del=false,deleted_at=NULL,deleted_by=NULL,delete_reason=NULL,added_at=now()`,
      [userId, uniquePmids, uniqueProjectIds],
    );
  }

  const result = await client.query(
    `SELECT target.pmid,
            COALESCE(jsonb_agg(jsonb_build_object(
              'id',project.id,'name',project.name,'color',project.color
            ) ORDER BY project.sort_order,project.created_at,project.id)
            FILTER (WHERE project.id IS NOT NULL),'[]'::jsonb) AS projects
     FROM unnest($2::text[]) AS target(pmid)
     LEFT JOIN project_papers link
       ON link.user_id=$1 AND link.pmid=target.pmid AND link.is_del=false
     LEFT JOIN research_projects project
       ON project.id=link.project_id AND project.user_id=link.user_id
      AND project.is_del=false
     GROUP BY target.pmid
     ORDER BY target.pmid`,
    [userId, uniquePmids],
  );
  return result.rows;
}

export function assignPapersToProjects(userId, pmids, projectIds, mode = "add") {
  return transaction((client) =>
    assignPapersToProjectsWithClient(client, userId, pmids, projectIds, mode));
}
