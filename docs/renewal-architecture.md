# Publium Renewal Architecture

## Objective

Move Publium to a separated deployment architecture while preserving the
current visual design and user-facing behavior.

| Layer | Target |
| --- | --- |
| Frontend | React 19 + Vite on Vercel |
| Backend | Node.js 22 + Express on Vercel Functions |
| Authentication | Supabase Google OAuth |
| Database | Supabase PostgreSQL with RLS |
| Paper source | NCBI PubMed E-utilities and PMC |
| AI | OpenAI streaming responses with paper-scoped retrieval |

The existing FastAPI, Jinja, CSS, and JavaScript implementation remains in the
repository as the visual and behavior reference until renewal feature parity is
verified.

## Design preservation contract

- Preserve the existing landing page, application shell, spacing, colors,
  typography, cards, charts, responsive breakpoints, and mobile collection
  sheet.
- Reuse the current CSS rules where practical.
- Componentization must not introduce a visual redesign.
- New controls may be added only where required for source links, paper
  selection, ingestion status, conversations, and citations.

## Paper lifecycle

1. Search PubMed with ESearch.
2. Fetch metadata with EFetch.
3. Upsert shared paper metadata and abstract by PMID.
4. Link only explicitly saved papers to the signed-in user.
5. When papers are sent to chat, resolve PMCID and ingest eligible PMC content
   once.
6. Store normalized documents, chunks, and embeddings in Supabase.
7. On each question, retrieve only chunks belonging to the chat room's selected
   papers.
8. Fall back to the stored abstract when PMC full text is unavailable.

Paid publisher content must not be scraped. Publisher and DOI URLs are stored
as outbound links only.

## Core data ownership

- `pubmed_records` is shared and deduplicated by PMID.
- `user_paper_collections` defines which papers a user owns.
- `research_projects` and `project_papers` classify owned papers without copying paper content.
- `chat_rooms` and `chat_messages` are user scoped.
- `chat_room_papers` permanently binds one to five owned papers to a room.
- `paper_documents` and `paper_chunks` contain reusable PMC/abstract analysis
  material.

All user and business data uses soft deletion. General reads and aggregates
must include `is_del = false`; project graph queries also verify the authenticated
`user_id` on both the project and paper link.

## Interest-paper Graph RAG

Research Galaxy uses the active interest collection as its primary corpus. It
does not persist a duplicate graph database.

```text
Authenticated user
  → all / unassigned / owned project scope
  → active interest papers (maximum 200)
  → title + abstract topic/concept graph
  → direct evidence (maximum 3)
  → one-hop graph neighbors (maximum 3)
  → LangGraph input guard
  → OpenAI answer from the six-paper subgraph
  → answer + direct/neighbor source labels
```

The graph itself is deterministic and does not call OpenAI. An API call occurs
only when the user requests a Graph RAG answer. The current evidence scope is
title and abstract; full-text chunks remain in the separate conversation-scoped
vector RAG pipeline. The fixed 148-paper corpus remains available only as an
explicit demo scope.

## Deployment boundaries

The browser receives only the Supabase public URL and anon key. The frontend
calls `/api/...` on the same Vercel deployment. Supabase service-role, NCBI,
OpenAI, and database credentials remain server-only Vercel environment
variables.
