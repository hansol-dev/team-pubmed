-- Publium renewal schema for Supabase PostgreSQL.
-- Apply this file to a new Supabase project with the SQL editor or CLI.
-- Existing SQLite files are intentionally not modified by this schema.

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- Keep updated_at handling consistent across user-owned and shared records.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text,
  avatar_url text,
  -- The old application used lower-cased email strings as user IDs. This field
  -- is the stable bridge used by the later SQLite-to-Supabase import.
  legacy_user_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_profiles_email_not_blank
    check (email is null or btrim(email) <> ''),
  constraint user_profiles_legacy_key_normalized
    check (
      legacy_user_key is null
      or legacy_user_key = lower(btrim(legacy_user_key))
    )
);

create unique index if not exists user_profiles_email_lower_uidx
  on public.user_profiles (lower(email))
  where email is not null;

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_profiles (
    id,
    email,
    display_name,
    avatar_url,
    legacy_user_key
  )
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name'
    ),
    coalesce(
      new.raw_user_meta_data ->> 'avatar_url',
      new.raw_user_meta_data ->> 'picture'
    ),
    case
      when new.email is null then null
      else lower(btrim(new.email))
    end
  )
  on conflict (id) do update
  set
    email = excluded.email,
    display_name = coalesce(
      excluded.display_name,
      public.user_profiles.display_name
    ),
    avatar_url = coalesce(
      excluded.avatar_url,
      public.user_profiles.avatar_url
    ),
    legacy_user_key = coalesce(
      public.user_profiles.legacy_user_key,
      excluded.legacy_user_key
    ),
    updated_at = now();

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert or update of email, raw_user_meta_data on auth.users
  for each row execute function public.handle_new_auth_user();

-- Backfill profiles when this schema is applied to a project that already has
-- Supabase Auth users.
insert into public.user_profiles (
  id,
  email,
  display_name,
  avatar_url,
  legacy_user_key
)
select
  auth_user.id,
  auth_user.email,
  coalesce(
    auth_user.raw_user_meta_data ->> 'full_name',
    auth_user.raw_user_meta_data ->> 'name'
  ),
  coalesce(
    auth_user.raw_user_meta_data ->> 'avatar_url',
    auth_user.raw_user_meta_data ->> 'picture'
  ),
  case
    when auth_user.email is null then null
    else lower(btrim(auth_user.email))
  end
from auth.users auth_user
on conflict (id) do nothing;

drop trigger if exists set_user_profiles_updated_at on public.user_profiles;
create trigger set_user_profiles_updated_at
  before update on public.user_profiles
  for each row execute function public.set_updated_at();

-- Shared PubMed cache. Search results are upserted here immediately, including
-- abstracts, so normal browsing and abstract-only chat do not call PubMed again.
create table if not exists public.pubmed_records (
  pmid text primary key,
  title text not null,
  abstract text not null default '',
  authors jsonb not null default '[]'::jsonb,
  journal text not null default '',
  publication_year integer,
  publication_date date,
  doi text,
  pmcid text,
  pubmed_url text not null,
  publisher_url text,
  full_text_url text,
  pdf_url text,
  pdf_source text,
  full_text_license text,
  full_text_discovered_at timestamptz,
  full_text_source text,
  full_text_status text not null default 'unknown',
  rag_status text not null default 'abstract_only',
  metadata_fetched_at timestamptz not null default now(),
  abstract_fetched_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pubmed_records_pmid_digits
    check (pmid ~ '^[0-9]+$'),
  constraint pubmed_records_title_not_blank
    check (btrim(title) <> ''),
  constraint pubmed_records_authors_array
    check (jsonb_typeof(authors) = 'array'),
  constraint pubmed_records_publication_year_range
    check (
      publication_year is null
      or publication_year between 1800 and 2200
    ),
  constraint pubmed_records_doi_not_blank
    check (doi is null or btrim(doi) <> ''),
  constraint pubmed_records_pmcid_format
    check (pmcid is null or pmcid ~ '^PMC[0-9]+$'),
  constraint pubmed_records_pmid_pmcid_key unique (pmid, pmcid),
  constraint pubmed_records_full_text_source
    check (
      full_text_source is null
      or full_text_source in ('pmc', 'publisher')
    ),
  constraint pubmed_records_full_text_status
    check (
      full_text_status in (
        'unknown',
        'unavailable',
        'pmc_available',
        'publisher_only'
      )
    ),
  constraint pubmed_records_rag_status
    check (
      rag_status in (
        'abstract_only',
        'pending',
        'processing',
        'ready',
        'failed'
      )
    )
);

alter table public.pubmed_records
  add column if not exists pdf_url text,
  add column if not exists pdf_source text,
  add column if not exists full_text_license text,
  add column if not exists full_text_discovered_at timestamptz;

alter table public.pubmed_records
  drop constraint if exists pubmed_records_pdf_source;
alter table public.pubmed_records
  add constraint pubmed_records_pdf_source
  check (
    pdf_source is null
    or pdf_source in ('pmc', 'unpaywall', 'crossref')
  );

create index if not exists pubmed_records_doi_lower_idx
  on public.pubmed_records (lower(doi))
  where doi is not null;
create unique index if not exists pubmed_records_pmcid_uidx
  on public.pubmed_records (pmcid)
  where pmcid is not null;
create index if not exists pubmed_records_year_idx
  on public.pubmed_records (publication_year desc);
create index if not exists pubmed_records_journal_idx
  on public.pubmed_records (journal);
create index if not exists pubmed_records_metadata_fetched_idx
  on public.pubmed_records (metadata_fetched_at);
create index if not exists pubmed_records_search_idx
  on public.pubmed_records using gin (
    to_tsvector(
      'english',
      coalesce(title, '') || ' ' || coalesce(abstract, '')
    )
  );

drop trigger if exists set_pubmed_records_updated_at on public.pubmed_records;
create trigger set_pubmed_records_updated_at
  before update on public.pubmed_records
  for each row execute function public.set_updated_at();

-- One row per PubMed query. This preserves collection/search history without
-- duplicating shared article metadata.
create table if not exists public.search_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  query text not null,
  year_from integer,
  year_to integer,
  max_results integer not null default 100,
  status text not null default 'pending',
  result_count integer not null default 0,
  stored_count integer not null default 0,
  request_params jsonb not null default '{}'::jsonb,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  is_del boolean not null default false,
  deleted_at timestamptz,
  deleted_by uuid,
  constraint search_runs_owner_key unique (id, user_id),
  constraint search_runs_query_not_blank check (btrim(query) <> ''),
  constraint search_runs_year_from_range
    check (year_from is null or year_from between 1800 and 2200),
  constraint search_runs_year_to_range
    check (year_to is null or year_to between 1800 and 2200),
  constraint search_runs_year_order
    check (
      year_from is null
      or year_to is null
      or year_from <= year_to
    ),
  constraint search_runs_max_results_range
    check (max_results between 1 and 10000),
  constraint search_runs_counts_nonnegative
    check (result_count >= 0 and stored_count >= 0),
  constraint search_runs_status
    check (status in ('pending', 'running', 'completed', 'failed')),
  constraint search_runs_request_params_object
    check (jsonb_typeof(request_params) = 'object')
);

alter table public.search_runs
  add column if not exists is_del boolean not null default false,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;

create index if not exists search_runs_user_created_idx
  on public.search_runs (user_id, created_at desc);

drop trigger if exists set_search_runs_updated_at on public.search_runs;
create trigger set_search_runs_updated_at
  before update on public.search_runs
  for each row execute function public.set_updated_at();

create table if not exists public.search_run_papers (
  search_run_id uuid not null,
  user_id uuid not null,
  pmid text not null references public.pubmed_records(pmid) on delete restrict,
  result_rank integer not null,
  added_to_collection boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (search_run_id, pmid),
  constraint search_run_papers_run_owner_fk
    foreign key (search_run_id, user_id)
    references public.search_runs(id, user_id)
    on delete cascade,
  constraint search_run_papers_rank_positive check (result_rank > 0),
  constraint search_run_papers_rank_unique
    unique (search_run_id, result_rank)
);

create index if not exists search_run_papers_user_idx
  on public.search_run_papers (user_id, search_run_id);
create index if not exists search_run_papers_pmid_idx
  on public.search_run_papers (pmid);

-- User ownership is a join, not a copy of PubMed metadata.
create table if not exists public.user_paper_collections (
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  pmid text not null references public.pubmed_records(pmid) on delete restrict,
  first_search_run_id uuid,
  saved_at timestamptz not null default now(),
  notes text,
  is_del boolean not null default false,
  deleted_at timestamptz,
  deleted_by uuid,
  primary key (user_id, pmid),
  constraint user_paper_collections_first_search_fk
    foreign key (first_search_run_id, user_id)
    references public.search_runs(id, user_id)
    on delete set null (first_search_run_id)
);

alter table public.user_paper_collections
  add column if not exists is_del boolean not null default false,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;

create index if not exists user_paper_collections_saved_idx
  on public.user_paper_collections (user_id, saved_at desc);
create index if not exists user_paper_collections_pmid_idx
  on public.user_paper_collections (pmid);

create table if not exists public.chat_rooms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  title text not null default '새 논문 대화',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz,
  is_del boolean not null default false,
  deleted_at timestamptz,
  deleted_by uuid,
  constraint chat_rooms_owner_key unique (id, user_id),
  constraint chat_rooms_title_not_blank check (btrim(title) <> ''),
  constraint chat_rooms_status check (status in ('active', 'archived'))
);

alter table public.chat_rooms
  add column if not exists is_del boolean not null default false,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;

create index if not exists chat_rooms_user_recent_idx
  on public.chat_rooms (
    user_id,
    last_message_at desc nulls last,
    created_at desc
  );

drop trigger if exists set_chat_rooms_updated_at on public.chat_rooms;
create trigger set_chat_rooms_updated_at
  before update on public.chat_rooms
  for each row execute function public.set_updated_at();

-- position is deliberately constrained to 1..5. Together with the unique
-- (room, position) key, this enforces the product's five-paper maximum even
-- under concurrent requests.
create table if not exists public.chat_room_papers (
  chat_room_id uuid not null,
  user_id uuid not null,
  pmid text not null,
  position smallint not null,
  added_at timestamptz not null default now(),
  primary key (chat_room_id, pmid),
  constraint chat_room_papers_room_owner_fk
    foreign key (chat_room_id, user_id)
    references public.chat_rooms(id, user_id)
    on delete cascade,
  constraint chat_room_papers_owned_paper_fk
    foreign key (user_id, pmid)
    references public.user_paper_collections(user_id, pmid)
    on delete cascade,
  constraint chat_room_papers_position_range check (position between 1 and 5),
  constraint chat_room_papers_position_unique unique (chat_room_id, position)
);

create index if not exists chat_room_papers_user_idx
  on public.chat_room_papers (user_id, chat_room_id);
create index if not exists chat_room_papers_pmid_idx
  on public.chat_room_papers (pmid);

create table if not exists public.chat_messages (
  id bigint generated by default as identity primary key,
  chat_room_id uuid not null,
  user_id uuid not null,
  role text not null,
  content text not null,
  citations jsonb not null default '[]'::jsonb,
  model text,
  prompt_tokens integer,
  completion_tokens integer,
  client_message_id uuid,
  created_at timestamptz not null default now(),
  is_del boolean not null default false,
  deleted_at timestamptz,
  deleted_by uuid,
  constraint chat_messages_room_owner_fk
    foreign key (chat_room_id, user_id)
    references public.chat_rooms(id, user_id)
    on delete cascade,
  constraint chat_messages_role
    check (role in ('system', 'user', 'assistant', 'tool')),
  constraint chat_messages_content_not_blank check (btrim(content) <> ''),
  constraint chat_messages_citations_array
    check (jsonb_typeof(citations) = 'array'),
  constraint chat_messages_prompt_tokens_nonnegative
    check (prompt_tokens is null or prompt_tokens >= 0),
  constraint chat_messages_completion_tokens_nonnegative
    check (completion_tokens is null or completion_tokens >= 0),
  constraint chat_messages_client_id_unique
    unique (chat_room_id, client_message_id)
);

alter table public.chat_messages
  add column if not exists is_del boolean not null default false,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid;

create index if not exists chat_messages_room_order_idx
  on public.chat_messages (chat_room_id, id);
create index if not exists chat_messages_user_recent_idx
  on public.chat_messages (user_id, created_at desc);

create or replace function public.touch_chat_room_after_message()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update public.chat_rooms
  set last_message_at = new.created_at
  where id = new.chat_room_id and user_id = new.user_id;
  return new;
end;
$$;

drop trigger if exists touch_chat_room_after_message on public.chat_messages;
create trigger touch_chat_room_after_message
  after insert on public.chat_messages
  for each row execute function public.touch_chat_room_after_message();

-- Only legally retrievable PMC open-access content belongs here. Publisher
-- pages are linked from pubmed_records but are never scraped into this table.
create table if not exists public.paper_documents (
  id uuid primary key default gen_random_uuid(),
  pmid text not null,
  pmcid text not null,
  source text not null default 'pmc',
  source_url text not null,
  license text not null,
  is_open_access boolean not null default true,
  content text not null,
  raw_xml text,
  sections jsonb not null default '[]'::jsonb,
  content_hash text not null,
  parser_version text not null,
  is_current boolean not null default true,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint paper_documents_record_key unique (id, pmid),
  constraint paper_documents_version_unique unique (pmid, content_hash),
  constraint paper_documents_pubmed_record_fk
    foreign key (pmid, pmcid)
    references public.pubmed_records(pmid, pmcid)
    on delete cascade,
  constraint paper_documents_pmcid_format check (pmcid ~ '^PMC[0-9]+$'),
  constraint paper_documents_pmc_only check (source = 'pmc'),
  constraint paper_documents_open_access_only check (is_open_access),
  constraint paper_documents_source_url_not_blank
    check (btrim(source_url) <> ''),
  constraint paper_documents_license_not_blank check (btrim(license) <> ''),
  constraint paper_documents_content_not_blank check (btrim(content) <> ''),
  constraint paper_documents_hash_not_blank check (btrim(content_hash) <> ''),
  constraint paper_documents_parser_not_blank check (btrim(parser_version) <> '')
);

alter table public.paper_documents
  add column if not exists sections jsonb not null default '[]'::jsonb;

create index if not exists paper_documents_pmid_fetched_idx
  on public.paper_documents (pmid, fetched_at desc);
create index if not exists paper_documents_pmcid_idx
  on public.paper_documents (pmcid);
create unique index if not exists paper_documents_one_current_uidx
  on public.paper_documents (pmid)
  where is_current;

drop trigger if exists set_paper_documents_updated_at on public.paper_documents;
create trigger set_paper_documents_updated_at
  before update on public.paper_documents
  for each row execute function public.set_updated_at();

-- text-embedding-3-small produces 1,536-dimensional vectors. Store the model
-- name per chunk so a future embedding migration can be performed explicitly.
create table if not exists public.paper_chunks (
  id bigint generated by default as identity primary key,
  document_id uuid not null references public.paper_documents(id) on delete cascade,
  pmid text not null,
  section text not null default '',
  chunk_index integer not null,
  content text not null,
  token_count integer,
  embedding extensions.vector(1536),
  embedding_model text,
  created_at timestamptz not null default now(),
  is_del boolean not null default false,
  deleted_at timestamptz,
  constraint paper_chunks_document_pmid_fk
    foreign key (document_id, pmid)
    references public.paper_documents(id, pmid)
    on delete cascade,
  constraint paper_chunks_order_unique unique (document_id, chunk_index),
  constraint paper_chunks_index_nonnegative check (chunk_index >= 0),
  constraint paper_chunks_content_not_blank check (btrim(content) <> ''),
  constraint paper_chunks_token_count_positive
    check (token_count is null or token_count > 0),
  constraint paper_chunks_embedding_metadata
    check (
      (embedding is null and embedding_model is null)
      or (
        embedding is not null
        and embedding_model is not null
        and btrim(embedding_model) <> ''
      )
    )
);

alter table public.paper_chunks
  add column if not exists is_del boolean not null default false,
  add column if not exists deleted_at timestamptz;

create index if not exists paper_chunks_document_order_idx
  on public.paper_chunks (document_id, chunk_index);
create index if not exists paper_chunks_pmid_idx
  on public.paper_chunks (pmid);
create index if not exists paper_chunks_embedding_hnsw_idx
  on public.paper_chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null;

create table if not exists public.paper_source_candidates (
  id bigint generated by default as identity primary key,
  pmid text not null references public.pubmed_records(pmid) on delete cascade,
  provider text not null,
  format text not null,
  source_url text not null,
  landing_url text,
  license text,
  version text,
  is_open_access boolean not null default false,
  is_reusable boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  discovered_at timestamptz not null default now(),
  expires_at timestamptz,
  is_del boolean not null default false,
  deleted_at timestamptz,
  constraint paper_source_candidates_provider
    check (provider in ('pmc', 'bioc', 'unpaywall', 'crossref')),
  constraint paper_source_candidates_format
    check (format in ('jats', 'bioc_json', 'text', 'pdf', 'landing_page', 'package')),
  constraint paper_source_candidates_url_not_blank check (btrim(source_url) <> ''),
  constraint paper_source_candidates_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint paper_source_candidates_unique unique (pmid, provider, format, source_url)
);

create index if not exists paper_source_candidates_pmid_idx
  on public.paper_source_candidates (pmid, discovered_at desc)
  where not is_del;

-- User-provided PDFs remain private to their owner. Extracted text is kept in
-- user-scoped tables and never promoted into the shared PMC document cache.
create table if not exists public.user_paper_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.user_profiles(id) on delete cascade,
  pmid text not null references public.pubmed_records(pmid) on delete restrict,
  source text not null default 'user_pdf',
  storage_path text not null,
  file_name text not null,
  mime_type text not null default 'application/pdf',
  size_bytes bigint not null,
  page_count integer,
  content text not null,
  sections jsonb not null default '[]'::jsonb,
  content_hash text not null,
  parser_version text not null,
  status text not null default 'ready',
  error_message text,
  is_current boolean not null default true,
  is_del boolean not null default false,
  deleted_at timestamptz,
  deleted_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_paper_documents_owner_key unique (id, user_id, pmid),
  constraint user_paper_documents_version_unique unique (user_id, pmid, content_hash),
  constraint user_paper_documents_owned_paper_fk
    foreign key (user_id, pmid)
    references public.user_paper_collections(user_id, pmid)
    on delete cascade,
  constraint user_paper_documents_source check (source = 'user_pdf'),
  constraint user_paper_documents_path_not_blank check (btrim(storage_path) <> ''),
  constraint user_paper_documents_name_not_blank check (btrim(file_name) <> ''),
  constraint user_paper_documents_pdf_mime check (mime_type = 'application/pdf'),
  constraint user_paper_documents_size check (size_bytes between 1 and 26214400),
  constraint user_paper_documents_pages check (page_count is null or page_count between 1 and 2000),
  constraint user_paper_documents_content_not_blank check (btrim(content) <> ''),
  constraint user_paper_documents_sections_array check (jsonb_typeof(sections) = 'array'),
  constraint user_paper_documents_hash_not_blank check (btrim(content_hash) <> ''),
  constraint user_paper_documents_parser_not_blank check (btrim(parser_version) <> ''),
  constraint user_paper_documents_status
    check (status in ('processing', 'ready', 'failed', 'scanned_unreadable'))
);

create unique index if not exists user_paper_documents_one_current_uidx
  on public.user_paper_documents (user_id, pmid)
  where is_current and not is_del;
create index if not exists user_paper_documents_owner_idx
  on public.user_paper_documents (user_id, pmid, created_at desc);

drop trigger if exists set_user_paper_documents_updated_at
  on public.user_paper_documents;
create trigger set_user_paper_documents_updated_at
  before update on public.user_paper_documents
  for each row execute function public.set_updated_at();

create table if not exists public.user_paper_chunks (
  id bigint generated by default as identity primary key,
  document_id uuid not null,
  user_id uuid not null,
  pmid text not null,
  section text not null default '',
  chunk_index integer not null,
  content text not null,
  token_count integer,
  embedding extensions.vector(1536),
  embedding_model text,
  created_at timestamptz not null default now(),
  is_del boolean not null default false,
  deleted_at timestamptz,
  constraint user_paper_chunks_document_fk
    foreign key (document_id, user_id, pmid)
    references public.user_paper_documents(id, user_id, pmid)
    on delete cascade,
  constraint user_paper_chunks_order_unique unique (document_id, chunk_index),
  constraint user_paper_chunks_index_nonnegative check (chunk_index >= 0),
  constraint user_paper_chunks_content_not_blank check (btrim(content) <> ''),
  constraint user_paper_chunks_token_count_positive
    check (token_count is null or token_count > 0),
  constraint user_paper_chunks_embedding_metadata
    check (
      (embedding is null and embedding_model is null)
      or (
        embedding is not null
        and embedding_model is not null
        and btrim(embedding_model) <> ''
      )
    )
);

create index if not exists user_paper_chunks_owner_idx
  on public.user_paper_chunks (user_id, pmid, document_id, chunk_index);
create index if not exists user_paper_chunks_embedding_hnsw_idx
  on public.user_paper_chunks
  using hnsw (embedding extensions.vector_cosine_ops)
  where embedding is not null and not is_del;

-- RLS -----------------------------------------------------------------------

alter table public.user_profiles enable row level security;
alter table public.pubmed_records enable row level security;
alter table public.search_runs enable row level security;
alter table public.search_run_papers enable row level security;
alter table public.user_paper_collections enable row level security;
alter table public.chat_rooms enable row level security;
alter table public.chat_room_papers enable row level security;
alter table public.chat_messages enable row level security;
alter table public.paper_documents enable row level security;
alter table public.paper_chunks enable row level security;
alter table public.paper_source_candidates enable row level security;
alter table public.user_paper_documents enable row level security;
alter table public.user_paper_chunks enable row level security;

drop policy if exists "profiles_select_own" on public.user_profiles;
create policy "profiles_select_own"
  on public.user_profiles for select
  to authenticated
  using (id = (select auth.uid()));

drop policy if exists "profiles_insert_own" on public.user_profiles;
create policy "profiles_insert_own"
  on public.user_profiles for insert
  to authenticated
  with check (id = (select auth.uid()));

drop policy if exists "profiles_update_own" on public.user_profiles;
create policy "profiles_update_own"
  on public.user_profiles for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists "pubmed_records_read_authenticated"
  on public.pubmed_records;
create policy "pubmed_records_read_authenticated"
  on public.pubmed_records for select
  to authenticated
  using (true);

-- Shared metadata/documents are written only by the trusted backend service
-- role. Supabase service_role bypasses RLS, so no client write policy is added.

drop policy if exists "search_runs_own_all" on public.search_runs;
create policy "search_runs_own_all"
  on public.search_runs for all
  to authenticated
  using (user_id = (select auth.uid()) and not is_del)
  with check (user_id = (select auth.uid()));

drop policy if exists "search_run_papers_own_all"
  on public.search_run_papers;
create policy "search_run_papers_own_all"
  on public.search_run_papers for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "collections_select_own"
  on public.user_paper_collections;
create policy "collections_select_own"
  on public.user_paper_collections for select
  to authenticated
  using (user_id = (select auth.uid()) and not is_del);

drop policy if exists "collections_insert_own"
  on public.user_paper_collections;
create policy "collections_insert_own"
  on public.user_paper_collections for insert
  to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "collections_update_own"
  on public.user_paper_collections;
create policy "collections_update_own"
  on public.user_paper_collections for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "collections_delete_own"
  on public.user_paper_collections;
create policy "collections_delete_own"
  on public.user_paper_collections for delete
  to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "chat_rooms_own_all" on public.chat_rooms;
create policy "chat_rooms_own_all"
  on public.chat_rooms for all
  to authenticated
  using (user_id = (select auth.uid()) and not is_del)
  with check (user_id = (select auth.uid()));

drop policy if exists "chat_room_papers_own_all"
  on public.chat_room_papers;
create policy "chat_room_papers_own_all"
  on public.chat_room_papers for all
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "chat_messages_own_all" on public.chat_messages;
create policy "chat_messages_own_all"
  on public.chat_messages for all
  to authenticated
  using (user_id = (select auth.uid()) and not is_del)
  with check (user_id = (select auth.uid()));

drop policy if exists "paper_documents_read_if_collected"
  on public.paper_documents;
create policy "paper_documents_read_if_collected"
  on public.paper_documents for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_paper_collections collection
      where collection.user_id = (select auth.uid())
        and collection.pmid = paper_documents.pmid
        and not collection.is_del
    )
  );

drop policy if exists "paper_chunks_read_if_collected"
  on public.paper_chunks;
create policy "paper_chunks_read_if_collected"
  on public.paper_chunks for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_paper_collections collection
      where collection.user_id = (select auth.uid())
        and collection.pmid = paper_chunks.pmid
        and not collection.is_del
    )
    and not paper_chunks.is_del
  );

drop policy if exists "paper_source_candidates_read_if_collected"
  on public.paper_source_candidates;
create policy "paper_source_candidates_read_if_collected"
  on public.paper_source_candidates for select
  to authenticated
  using (
    exists (
      select 1
      from public.user_paper_collections collection
      where collection.user_id = (select auth.uid())
        and collection.pmid = paper_source_candidates.pmid
        and not collection.is_del
    )
    and not paper_source_candidates.is_del
  );

drop policy if exists "user_paper_documents_own_read"
  on public.user_paper_documents;
create policy "user_paper_documents_own_read"
  on public.user_paper_documents for select
  to authenticated
  using (user_id = (select auth.uid()) and not is_del);

drop policy if exists "user_paper_chunks_own_read"
  on public.user_paper_chunks;
create policy "user_paper_chunks_own_read"
  on public.user_paper_chunks for select
  to authenticated
  using (user_id = (select auth.uid()) and not is_del);

-- Vector retrieval is restricted to papers fixed to a room owned by the
-- caller. RLS remains active because this is a security-invoker function.
create or replace function public.match_chat_room_chunks(
  p_chat_room_id uuid,
  p_query_embedding extensions.vector(1536),
  p_match_threshold double precision default 0.2,
  p_match_count integer default 8
)
returns table (
  chunk_id bigint,
  pmid text,
  section text,
  content text,
  similarity double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    chunk.id as chunk_id,
    chunk.pmid,
    chunk.section,
    chunk.content,
    1 - (chunk.embedding <=> p_query_embedding) as similarity
  from public.paper_chunks chunk
  join public.paper_documents document
    on document.id = chunk.document_id
   and document.pmid = chunk.pmid
   and document.is_current
  join public.chat_room_papers room_paper
    on room_paper.pmid = chunk.pmid
  join public.chat_rooms room
    on room.id = room_paper.chat_room_id
   and room.user_id = room_paper.user_id
  where room_paper.chat_room_id = p_chat_room_id
    and room_paper.user_id = (select auth.uid())
    and not room.is_del
    and not chunk.is_del
    and chunk.embedding is not null
    and 1 - (chunk.embedding <=> p_query_embedding) >= p_match_threshold
  order by chunk.embedding <=> p_query_embedding
  limit least(greatest(coalesce(p_match_count, 8), 1), 20);
$$;

revoke all on function public.match_chat_room_chunks(
  uuid,
  extensions.vector,
  double precision,
  integer
) from public;
grant execute on function public.match_chat_room_chunks(
  uuid,
  extensions.vector,
  double precision,
  integer
) to authenticated;
grant execute on function public.match_chat_room_chunks(
  uuid,
  extensions.vector,
  double precision,
  integer
) to service_role;

-- Explicit grants complement RLS. Shared-cache mutation and RAG ingestion stay
-- backend-only; user-owned tables remain directly usable by the React client.
grant select on public.pubmed_records to authenticated;
grant select, insert, update on public.user_profiles to authenticated;
revoke delete on public.search_runs, public.search_run_papers,
  public.user_paper_collections, public.chat_rooms,
  public.chat_room_papers, public.chat_messages
from authenticated;
grant select, insert, update on public.search_runs to authenticated;
grant select, insert, update on public.search_run_papers to authenticated;
grant select, insert, update
  on public.user_paper_collections to authenticated;
grant select, insert, update on public.chat_rooms to authenticated;
grant select, insert, update on public.chat_room_papers to authenticated;
grant select, insert, update on public.chat_messages to authenticated;
grant select on public.paper_documents to authenticated;
grant select on public.paper_chunks to authenticated;
grant select on public.paper_source_candidates to authenticated;
grant select on public.user_paper_documents to authenticated;
grant select on public.user_paper_chunks to authenticated;
grant usage, select on sequence public.chat_messages_id_seq to authenticated;

grant all on table
  public.user_profiles,
  public.pubmed_records,
  public.search_runs,
  public.search_run_papers,
  public.user_paper_collections,
  public.chat_rooms,
  public.chat_room_papers,
  public.chat_messages,
  public.paper_documents,
  public.paper_chunks,
  public.paper_source_candidates,
  public.user_paper_documents,
  public.user_paper_chunks
to service_role;
grant usage, select on all sequences in schema public to service_role;

comment on table public.pubmed_records is
  'Shared PubMed metadata cache; abstracts are upserted during search.';
comment on column public.user_profiles.legacy_user_key is
  'Lower-cased email used to map legacy SQLite user_id values during import.';
comment on table public.paper_documents is
  'Shared extracted full text from PMC open-access sources; publisher content is not scraped.';
comment on table public.user_paper_documents is
  'Private user-uploaded PDF metadata and extracted text, isolated by owner.';
comment on column public.paper_chunks.embedding is
  '1536-dimensional embedding generated by the model named in embedding_model.';

-- Private original PDFs. The first path segment is always the authenticated
-- user's UUID, so browser uploads cannot cross user boundaries.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('paper-pdfs', 'paper-pdfs', false, 26214400, array['application/pdf'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "paper_pdfs_insert_own" on storage.objects;
create policy "paper_pdfs_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'paper-pdfs'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "paper_pdfs_select_own" on storage.objects;
create policy "paper_pdfs_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'paper-pdfs'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
