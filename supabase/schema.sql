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
  file_path   text,
  file_url    text,
  file_type   text,
  file_size   bigint,
  file_name   text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- 已建表的环境：补列（幂等，可重复执行）
alter table candidates add column if not exists file_path text;
alter table candidates add column if not exists file_url  text;
alter table candidates add column if not exists file_type text;
alter table candidates add column if not exists file_size bigint;
alter table candidates add column if not exists file_name text;

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

-- ============ 原始附件存储（Supabase Storage） ============
-- 1) 在控制台 Storage → New bucket 新建名为 resumes 的【公开】bucket（Public bucket 打开）。
-- 2) 再执行下面的策略，允许匿名上传/覆盖/读取，供前端保存与预览原件。
--    （若 bucket 已设为 public，select 通常已放开；下面策略全部幂等，可放心执行。）
insert into storage.buckets (id, name, public)
  values ('resumes', 'resumes', true)
  on conflict (id) do update set public = true;

drop policy if exists "resumes public read"  on storage.objects;
drop policy if exists "resumes anon insert"  on storage.objects;
drop policy if exists "resumes anon update"  on storage.objects;

create policy "resumes public read" on storage.objects
  for select using (bucket_id = 'resumes');

create policy "resumes anon insert" on storage.objects
  for insert to anon with check (bucket_id = 'resumes');

create policy "resumes anon update" on storage.objects
  for update to anon using (bucket_id = 'resumes') with check (bucket_id = 'resumes');
