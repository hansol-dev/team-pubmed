# Publium Renewal Architecture

## Objective

Move Publium to a separated deployment architecture while preserving the
current visual design and user-facing behavior.

| Layer | Target |
| --- | --- |
| Frontend | React 19 + Vite on Vercel |
| Backend | Node.js 20 + Express on Render |
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
- `chat_rooms` and `chat_messages` are user scoped.
- `chat_room_papers` permanently binds one to five owned papers to a room.
- `paper_documents` and `paper_chunks` contain reusable PMC/abstract analysis
  material.

## Deployment boundaries

The browser receives only the Supabase public URL, anon key, and Render API
origin. Supabase service-role, NCBI, and OpenAI keys remain on Render.
