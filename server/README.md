# Publium Express API

Node 22 + Express backend for the renewed Publium client. Supabase provides Auth and PostgreSQL/pgvector. The API stores PubMed metadata and abstracts when a search is performed. PMC full text is fetched only once, when papers are attached to a conversation; subsequent questions use saved chunks.

Publisher/DOI pages are never crawled. A DOI is exposed only as an outbound link. If a paper has no reusable PMC full text, the stored PubMed abstract becomes its RAG document and the UI receives `abstract_only`.

## Local setup

```powershell
Copy-Item .env.example .env
npm install
npm run db:migrate
npm run dev
```

Every `/api` endpoint except `GET /api/health` requires `Authorization: Bearer <Supabase access token>`.

`db:migrate` applies the repository's canonical `supabase/schema.sql`; the
server does not maintain a second, competing schema.

## API

- `GET /api/health`
- `GET /api/auth/me`
- `POST /api/collection/search` — `{ keyword, yearFrom, yearTo, maxCount, saveToCollection? }`
- `POST /api/collection` — `{ pmids, keyword? }`
- `DELETE /api/collection/:pmid`
- `GET /api/overview`
- `GET /api/trend?keyword&yearFrom&yearTo`
- `GET /api/papers?keyword&yearFrom&yearTo&journal&limit`
- `GET /api/papers/filters`
- `GET /api/papers/export.csv`
- `GET /api/chat/conversations`
- `POST /api/chat/conversations/from-papers` — `{ pmids, title? }`, 1–5 owned papers
- `GET|DELETE /api/chat/conversations/:id`
- `GET|DELETE /api/chat/:id/messages`
- `POST /api/chat/stream` — `{ conversationId, message }`

The chat stream uses SSE:

```text
data: {"token":"..."}

event: done
data: {}
```

Chat requests run through a LangGraph workflow before SSE emission:

1. Block personal medical advice and prompt-injection attempts.
2. Redact sensitive values before retrieval and LangChain model execution.
3. Generate a grounded answer with `ChatOpenAI`.
4. Validate the complete output and replace unsafe medical instructions.

Run `npm test` for parser, chunker, LangGraph guardrails, and HTTP-contract tests.
