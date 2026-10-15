-- 绠€鍘嗘煡閲嶇郴缁?路 Supabase 寤鸿〃鑴氭湰
-- 鐢ㄦ硶锛歋upabase 鎺у埗鍙?鈫?SQL Editor 鈫?New query 鈫?绮樿创鍏ㄩ儴 鈫?Run
-- 浣滅敤锛氬缓绔嬪叡浜殑鍊欓€変汉琛ㄤ笌璁剧疆琛紝骞跺紑鏀惧尶鍚嶈鍐欙紙anon 瑙掕壊锛夈€?
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

-- 宸插缓琛ㄧ殑鐜锛氳ˉ鍒楋紙骞傜瓑锛屽彲閲嶅鎵ц锛?alter table candidates add column if not exists file_path text;
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

create table if not exists schedules (
  id         text primary key,
  seq        int,
  name       text,
  position   text,
  time       text,
  place      text,
  note       text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table schedules enable row level security;

drop policy if exists "anon all schedules" on schedules;

create policy "anon all schedules" on schedules
  for all to anon using (true) with check (true);

-- ============ 原始附件存储（Supabase Storage）============
-- 1) 在控制台 Storage -> New bucket 新建名为 resumes 的【公开】bucket（Public bucket 打开）
-- 2) 再执行下面的策略，允许匿名上�?覆盖/读取，供前端保存与预览原件
--    （若 bucket 已设为 public，select 通常已放开；下面策略全部幂等，可放心执行。）
insert into storage.buckets (id, name, public)
  values ('Resumes', 'Resumes', true)
  on conflict (id) do update set public = true;

drop policy if exists "resumes public read"  on storage.objects;
drop policy if exists "resumes anon insert"  on storage.objects;
drop policy if exists "resumes anon update"  on storage.objects;

create policy "resumes public read" on storage.objects
  for select using (bucket_id = 'Resumes');

create policy "resumes anon insert" on storage.objects
  for insert to anon with check (bucket_id = 'Resumes');

create policy "resumes anon update" on storage.objects
  for update to anon using (bucket_id = 'Resumes') with check (bucket_id = 'Resumes');
