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

-- ============ 鍘熷闄勪欢瀛樺偍锛圫upabase Storage锛?============
-- 1) 鍦ㄦ帶鍒跺彴 Storage 鈫?New bucket 鏂板缓鍚嶄负 resumes 鐨勩€愬叕寮€銆慴ucket锛圥ublic bucket 鎵撳紑锛夈€?-- 2) 鍐嶆墽琛屼笅闈㈢殑绛栫暐锛屽厑璁稿尶鍚嶄笂浼?瑕嗙洊/璇诲彇锛屼緵鍓嶇淇濆瓨涓庨瑙堝師浠躲€?--    锛堣嫢 bucket 宸茶涓?public锛宻elect 閫氬父宸叉斁寮€锛涗笅闈㈢瓥鐣ュ叏閮ㄥ箓绛夛紝鍙斁蹇冩墽琛屻€傦級
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
