-- Vendor Validation System: everything n8n stores, plus the lookup lists for the official checks.
-- Only the service key can read or write: RLS is on and no policies are granted.

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- Vendors and their assessments
-- ---------------------------------------------------------------------------

-- One row per vendor who emailed us; written by the Intake workflow.
create table if not exists vendors (
  vendor_id      text primary key,
  contact_email  text not null,
  sender_name    text,
  company_name   text,
  website        text,
  category_guess text,
  subject        text,
  email_summary  text,
  email_body     text,
  received_at    timestamptz,
  form_sent_at   timestamptz,
  status         text not null default 'form_sent',   -- form_sent | assessed
  triage_note    text,
  updated_at     timestamptz not null default now()
);

-- One row per submitted form; written by the Assess workflow, decided on the review page.
create table if not exists assessments (
  vendor_id         text primary key,
  company_name      text,
  contact_name      text,
  contact_email     text,
  phone             text,
  category          text,
  city              text,
  website           text,
  years_in_business text,
  turnover          text,
  payment_terms     text,
  certifications    text,
  score             integer,
  tier              text,                               -- A | B | C | D | Blocked | Unscored
  blocked           boolean not null default false,
  recommendation    text,
  summary           text,
  official_checks   jsonb not null default '{}',
  criteria          jsonb not null default '[]',
  knockouts         jsonb not null default '[]',
  red_flags         jsonb not null default '[]',
  web_findings      jsonb not null default '[]',
  questions         jsonb not null default '[]',
  form              jsonb not null default '{}',
  status            text not null default 'pending_review',  -- pending_review | approved | info_requested | rejected
  reviewer          text,
  reviewer_note     text,
  decided_at        timestamptz,
  assessed_at       timestamptz not null default now(),
  model             text,
  raw_model_output  text
);
create index if not exists assessments_status_idx on assessments (status, assessed_at desc);

-- ---------------------------------------------------------------------------
-- Lookup lists, refreshed weekly by the GitHub job
-- ---------------------------------------------------------------------------

-- Lower-case, drop punctuation and legal suffixes so "Packages Ltd." matches "PACKAGES LIMITED".
create or replace function norm_name(t text) returns text
language sql immutable as $$
  select trim(regexp_replace(
    regexp_replace(
      regexp_replace(lower(coalesce(t, '')), '[^a-z0-9 ]', ' ', 'g'),
      '\m(m s|pvt|private|ltd|limited|co|company|the|smc|llc|inc)\M', ' ', 'g'),
    '\s+', ' ', 'g'))
$$;

-- FBR Active Taxpayer Lists (income tax and sales tax).
create table if not exists atl_entries (
  list          text not null check (list in ('income_tax', 'sales_tax')),
  ntn           text,
  cnic          text,
  name          text,
  business_name text
);
create index if not exists atl_ntn_idx  on atl_entries (ntn)  where ntn is not null;
create index if not exists atl_cnic_idx on atl_entries (cnic) where cnic is not null;

-- UN Security Council consolidated list and NACTA proscribed list.
create table if not exists sanctions_entries (
  id         bigint generated always as identity primary key,
  source     text not null check (source in ('UN', 'NACTA')),
  source_ref text,
  kind       text not null check (kind in ('individual', 'entity')),
  name       text not null,
  name_norm  text generated always as (norm_name(name)) stored,
  cnic       text,
  listed_on  date,
  details    text
);
create index if not exists sanctions_name_trgm on sanctions_entries using gin (name_norm gin_trgm_ops);
create index if not exists sanctions_cnic_idx  on sanctions_entries (cnic) where cnic is not null;

-- One row per sync, so a check can say how fresh its list is.
create table if not exists sync_runs (
  id             bigint generated always as identity primary key,
  source         text not null,
  rows_loaded    integer,
  source_updated text,
  ok             boolean not null default true,
  note           text,
  ran_at         timestamptz not null default now()
);

alter table vendors           enable row level security;
alter table assessments       enable row level security;
alter table atl_entries       enable row level security;
alter table sanctions_entries enable row level security;
alter table sync_runs         enable row level security;

-- ---------------------------------------------------------------------------
-- Checks called by n8n. Each returns one JSON object, so n8n gets exactly one item back.
-- ---------------------------------------------------------------------------

drop function if exists check_atl(text, text, text);
drop function if exists match_sanctions(text[], text[], real);
drop function if exists list_freshness();

create or replace function last_sync(p_source text) returns jsonb
language sql stable as $$
  select coalesce((select jsonb_build_object('rows', rows_loaded, 'source_updated', source_updated, 'synced_at', ran_at)
                     from sync_runs where source = p_source and ok order by ran_at desc limit 1), 'null'::jsonb)
$$;

-- Is this NTN / STRN / CNIC on either active list?
create or replace function check_atl(p_ntn text default null, p_strn text default null, p_cnic text default null)
returns jsonb language sql stable as $$
  with q as (
    select nullif(regexp_replace(upper(coalesce(p_ntn, '')),  '[^A-Z0-9]', '', 'g'), '') as ntn,
           nullif(regexp_replace(upper(coalesce(p_strn, '')), '[^A-Z0-9]', '', 'g'), '') as strn,
           nullif(regexp_replace(coalesce(p_cnic, ''), '\D', '', 'g'), '') as cnic
  ), hits as (
    select a.list, 'ntn' as matched_on, a.ntn, a.name, a.business_name
      from atl_entries a, q where q.ntn is not null and a.ntn = q.ntn
    union all
    select a.list, 'strn', a.ntn, a.name, a.business_name
      from atl_entries a, q where q.strn is not null and a.list = 'sales_tax' and a.ntn = q.strn
    union all
    select a.list, 'cnic', a.ntn, a.name, a.business_name
      from atl_entries a, q where q.cnic is not null and a.cnic = q.cnic
  )
  select jsonb_build_object(
    'income_tax_active', exists (select 1 from hits where list = 'income_tax'),
    'sales_tax_active',  exists (select 1 from hits where list = 'sales_tax'),
    'matches',           coalesce((select jsonb_agg(to_jsonb(hits)) from hits), '[]'),
    'lists_loaded',      exists (select 1 from atl_entries limit 1),
    'income_tax_list',   last_sync('fbr_income_tax'),
    'sales_tax_list',    last_sync('fbr_sales_tax'))
$$;

-- Fuzzy name match for the company and each director, exact match for CNICs.
create or replace function match_sanctions(p_names text[], p_cnics text[] default '{}', p_threshold real default 0.6)
returns jsonb language sql stable as $$
  with hits as (
    select n as query, 'name' as matched_on, s.source, s.source_ref, s.kind, s.name, round(similarity(s.name_norm, norm_name(n))::numeric, 2) as score
      from unnest(p_names) as n
      join sanctions_entries s on s.name_norm % norm_name(n)
     where length(norm_name(n)) >= 4 and similarity(s.name_norm, norm_name(n)) >= p_threshold
    union all
    select c, 'cnic', s.source, s.source_ref, s.kind, s.name, 1.0
      from unnest(p_cnics) as c
      join sanctions_entries s on s.cnic = regexp_replace(c, '\D', '', 'g')
     where length(regexp_replace(c, '\D', '', 'g')) = 13
  )
  select jsonb_build_object(
    'matches',      coalesce((select jsonb_agg(to_jsonb(hits) order by score desc) from hits), '[]'),
    'lists_loaded', exists (select 1 from sanctions_entries limit 1),
    'un_list',      last_sync('un'),
    'nacta_list',   last_sync('nacta'))
$$;

revoke execute on function check_atl(text, text, text)          from anon, authenticated;
revoke execute on function match_sanctions(text[], text[], real) from anon, authenticated;
revoke execute on function last_sync(text)                       from anon, authenticated;
