-- 简历查重系统 · Supabase 建表脚本
-- 用法：Supabase 控制台 → SQL Editor → New query → 粘贴全部 → Run
-- 作用：建立共享的候选人表与设置表，并开放匿名读写（anon 角色）。

create table if not exists candidates (
  id          text primary key,
  seq         int,
  name        text,
  phone       text,
  email       text,
  position    text,
  source      text,
  raw_text    text,
  score       int,
  note        text,
  src_file    text,
  status      text,
  dup_flag    text,
  interviews  jsonb default '[]'::jsonb,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table if not exists settings (
  id         int primary key,
  threshold  int default 70
);

insert into settings (id, threshold) values (1, 70)
  on conflict (id) do nothing;

alter table candidates enable row level security;
alter table settings   enable row level security;

drop policy if exists "anon all candidates" on candidates;
drop policy if exists "anon all settings"   on settings;

create policy "anon all candidates" on candidates
  for all to anon using (true) with check (true);

create policy "anon all settings" on settings
  for all to anon using (true) with check (true);
