-- Vendor Validation System: lookup tables for the official checks.
-- Filled weekly by the sync job; read by n8n with the service key only.

create extension if not exists pg_trgm;

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

-- One row per sync, so the review page can say how fresh each list is.
create table if not exists sync_runs (
  id             bigint generated always as identity primary key,
  source         text not null,
  rows_loaded    integer,
  source_updated text,
  ok             boolean not null default true,
  note           text,
  ran_at         timestamptz not null default now()
);

-- No policies: only the service key (which bypasses RLS) can read or write.
alter table atl_entries       enable row level security;
alter table sanctions_entries enable row level security;
alter table sync_runs         enable row level security;

-- Is this NTN / STRN / CNIC on either active list?
create or replace function check_atl(p_ntn text default null, p_strn text default null, p_cnic text default null)
returns table (list text, matched_on text, ntn text, cnic text, name text, business_name text)
language sql stable as $$
  with q as (
    select nullif(regexp_replace(upper(coalesce(p_ntn, '')),  '[^A-Z0-9]', '', 'g'), '') as ntn,
           nullif(regexp_replace(upper(coalesce(p_strn, '')), '[^A-Z0-9]', '', 'g'), '') as strn,
           nullif(regexp_replace(coalesce(p_cnic, ''), '\D', '', 'g'), '') as cnic
  )
  select a.list, 'ntn', a.ntn, a.cnic, a.name, a.business_name
    from atl_entries a, q where q.ntn is not null and regexp_replace(upper(a.ntn), '[^A-Z0-9]', '', 'g') = q.ntn
  union all
  select a.list, 'strn', a.ntn, a.cnic, a.name, a.business_name
    from atl_entries a, q where q.strn is not null and a.list = 'sales_tax' and regexp_replace(upper(a.ntn), '[^A-Z0-9]', '', 'g') = q.strn
  union all
  select a.list, 'cnic', a.ntn, a.cnic, a.name, a.business_name
    from atl_entries a, q where q.cnic is not null and a.cnic = q.cnic
$$;

-- Fuzzy name match for the company and each director, exact match for CNICs.
create or replace function match_sanctions(p_names text[], p_cnics text[] default '{}', p_threshold real default 0.6)
returns table (query text, matched_on text, source text, source_ref text, kind text, name text, cnic text, score real)
language sql stable as $$
  select n, 'name', s.source, s.source_ref, s.kind, s.name, s.cnic, similarity(s.name_norm, norm_name(n))
    from unnest(p_names) as n
    join sanctions_entries s on s.name_norm % norm_name(n)
   where length(norm_name(n)) >= 4 and similarity(s.name_norm, norm_name(n)) >= p_threshold
  union all
  select c, 'cnic', s.source, s.source_ref, s.kind, s.name, s.cnic, 1.0
    from unnest(p_cnics) as c
    join sanctions_entries s on s.cnic = regexp_replace(c, '\D', '', 'g')
   where length(regexp_replace(c, '\D', '', 'g')) = 13
$$;

create or replace function list_freshness()
returns table (source text, rows_loaded integer, source_updated text, ran_at timestamptz)
language sql stable as $$
  select distinct on (source) source, rows_loaded, source_updated, ran_at
    from sync_runs where ok order by source, ran_at desc
$$;

revoke execute on function check_atl(text, text, text)            from anon, authenticated;
revoke execute on function match_sanctions(text[], text[], real)   from anon, authenticated;
revoke execute on function list_freshness()                        from anon, authenticated;
