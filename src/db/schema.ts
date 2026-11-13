// ERD(테이블 10개)와 같은 구조. 같은 의자 시간 겹침은 DB가 막는다(EXCLUDE).
export const SCHEMA = `
create extension if not exists btree_gist schema public;

create table if not exists patients (
  id serial primary key,
  name text not null,
  phone text unique,
  birth_date date not null,
  guardian_phone text,
  check (phone is not null or guardian_phone is not null),
  preferred_channel text not null default '문자' check (preferred_channel in ('문자','전화')),
  last_checkup_at date,
  checkup_cycle_months int not null default 6
);

create table if not exists staff (
  id serial primary key,
  name text not null,
  role text not null check (role in ('데스크','원장','위생사')),
  email text not null unique,
  password_hash text not null default '',
  is_active boolean not null default true
);

create table if not exists chairs (
  id serial primary key,
  name text not null unique
);

create table if not exists procedures (
  id serial primary key,
  name text not null unique,
  duration_min int not null check (duration_min > 0),
  supplies text not null default '',
  needs_checkup boolean not null default false,
  keywords text not null default ''
);

create table if not exists appointments (
  id serial primary key,
  patient_id int not null references patients(id),
  chair_id int not null references chairs(id),
  procedure_id int not null references procedures(id),
  start_at timestamptz not null,
  end_at timestamptz not null,
  source text not null default '웹앱' check (source in ('전화','네이버','웹앱')),
  status text not null default '예약' check (status in ('예약','완료','노쇼','취소')),
  confirm_status text not null default '미확인' check (confirm_status in ('미확인','확인','변경 요청')),
  check (end_at > start_at)
);
do $$ begin
  alter table appointments add constraint no_chair_overlap
    exclude using gist (chair_id with =, tstzrange(start_at, end_at) with &&) where (status = '예약');
exception when duplicate_object then null; end $$;

create table if not exists treatments (
  id serial primary key,
  appointment_id int unique references appointments(id),
  patient_id int not null references patients(id),
  procedure_id int not null references procedures(id),
  doctor_id int references staff(id),
  hygienist_id int references staff(id),
  treated_at date not null,
  record_note text not null default ''
);

create table if not exists documents (
  id serial primary key,
  kind text not null check (kind in ('주의사항','보험 기준')),
  title text not null,
  edition_year int not null,
  is_current boolean not null default true,
  file_url text not null default '',
  uploaded_by int references staff(id),
  uploaded_at timestamptz not null default now()
);

create table if not exists document_chunks (
  id serial primary key,
  document_id int not null references documents(id),
  procedure_id int references procedures(id),
  page int not null,
  heading text not null default '',
  content text not null
);

create table if not exists chat_questions (
  id serial primary key,
  patient_id int not null references patients(id),
  question text not null,
  category text not null check (category in ('주의사항','보험','증상','기타')),
  status text not null check (status in ('AI 답변','증상 안내','데스크 대기','데스크 답변')),
  ai_answer text,
  source_chunk_ids int[] not null default '{}',
  desk_answer text,
  answered_by int references staff(id),
  asked_at timestamptz not null default now(),
  answered_at timestamptz
);

create table if not exists notifications (
  id serial primary key,
  patient_id int not null references patients(id),
  kind text not null check (kind in ('전날 확인','검진 안내','데스크 답변')),
  ref_id int,
  title text not null,
  body text not null default '',
  sent_at timestamptz not null default now(),
  read_at timestamptz
);
`;
