import { getDb, q } from './db';
import { SCHEMA } from './schema';
import { PROCEDURES, AFTERCARE, INSURANCE, LAST_NAMES, FIRST_NAMES } from './content';
import { kstDate, kstAt, addDays } from '../time';

// 시연용 가상 데이터. 실행할 때마다 처음 상태로 되돌린다.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];

export async function resetAndSeed() {
  seed = 42;
  const db = await getDb();
  await db.exec(`drop table if exists notifications, chat_questions, document_chunks, documents, treatments, appointments, procedures, chairs, staff, patients cascade;`);
  await db.exec(SCHEMA);

  for (let i = 1; i <= 5; i++) await q(`insert into chairs(name) values ($1)`, [`${i}번 의자`]);
  for (const p of PROCEDURES) await q(`insert into procedures(name,duration_min,supplies,needs_checkup,keywords) values ($1,$2,$3,$4,$5)`, [p.name, p.min, p.supplies, p.checkup, p.keywords]);
  const staff: [string, string, string][] = [['박대표', '원장', 'ceo@miso.test'], ['최부원', '원장', 'vice@miso.test'], ['한실장', '데스크', 'desk1@miso.test'], ['이주임', '데스크', 'desk2@miso.test'],
    ['정위생', '위생사', 'hyg1@miso.test'], ['강위생', '위생사', 'hyg2@miso.test'], ['조위생', '위생사', 'hyg3@miso.test'], ['윤위생', '위생사', 'hyg4@miso.test']];
  for (const s of staff) await q(`insert into staff(name,role,email) values ($1,$2,$3)`, s);

  const procs = await q<{ id: number; name: string; duration_min: number }>(`select id,name,duration_min from procedures order by id`);
  const pid = (n: string) => procs.find((p) => p.name === n)!.id;

  // 문서와 근거 조각
  const aft = await q<{ id: number }>(`insert into documents(kind,title,edition_year,is_current,file_url,uploaded_by) values ('주의사항','시술 후 주의사항 안내 (가상)',2026,true,'/docs/aftercare-2026.pdf',3) returning id`);
  for (const [name, chunks] of Object.entries(AFTERCARE))
    for (const c of chunks) await q(`insert into document_chunks(document_id,procedure_id,page,heading,content) values ($1,$2,$3,$4,$5)`, [aft[0].id, pid(name), c.page, c.heading, c.content]);
  for (const year of [2025, 2026]) {
    const d = await q<{ id: number }>(`insert into documents(kind,title,edition_year,is_current,file_url,uploaded_by) values ('보험 기준',$1,$2,$3,$4,3) returning id`, [`치과 건강보험 적용 기준 안내 ${year}년 판 (가상)`, year, year === 2026, `/docs/insurance-${year}.pdf`]);
    for (const c of INSURANCE[year]) await q(`insert into document_chunks(document_id,procedure_id,page,heading,content) values ($1,$2,$3,$4,$5)`, [d[0].id, c.proc ? pid(c.proc) : null, c.page, c.heading, c.content]);
  }

  const today = kstDate();
  // 시연 환자
  const demo = await q<{ id: number }>(`insert into patients(name,phone,birth_date,preferred_channel,last_checkup_at) values ('김민지','01012345678','1990-03-15','문자',$1) returning id`, [addDays(today, -186)]);
  // 보호자(엄마)와 아이 둘: 아이는 휴대폰 없이 보호자 번호로 연결
  await q(`insert into patients(name,phone,birth_date,preferred_channel,last_checkup_at) values ('박지연','01055556666','1988-09-21','문자',$1)`, [addDays(today, -90)]);
  const kid = await q<{ id: number }>(`insert into patients(name,phone,birth_date,guardian_phone,last_checkup_at) values ('이하준',null,'2017-06-02','01055556666',$1) returning id`, [addDays(today, -200)]);
  const kid2 = await q<{ id: number }>(`insert into patients(name,phone,birth_date,guardian_phone,last_checkup_at) values ('이서아',null,'2020-02-14','01055556666',$1) returning id`, [addDays(today, -100)]);
  // 가상 환자 약 1,200명
  const phones = new Set(['01012345678', '01055556666']);
  for (let i = 0; i < 1196; i++) {
    let ph = ''; do { ph = '010' + String(Math.floor(rnd() * 1e8)).padStart(8, '0'); } while (phones.has(ph)); phones.add(ph);
    const y = 1940 + Math.floor(rnd() * 75);
    await q(`insert into patients(name,phone,birth_date,preferred_channel,last_checkup_at) values ($1,$2,$3,$4,$5)`,
      [pick(LAST_NAMES) + pick(FIRST_NAMES), ph, `${y}-${String(1 + Math.floor(rnd() * 12)).padStart(2, '0')}-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`, y < 1960 ? '전화' : '문자', addDays(today, -Math.floor(rnd() * 400))]);
  }

  // 시연 환자: 받은 시술 3건, 내일 예약 1건
  const past: [string, number, string][] = [['충치 치료(레진)', -330, '하악 좌측 제1대구치 레진 충전'], ['스케일링', -186, '전악 스케일링, 치은염 경미'], ['사랑니 발치', -7, '하악 우측 매복 사랑니 발치, 봉합 3바늘']];
  for (const [name, d, note] of past) {
    const a = await q<{ id: number }>(`insert into appointments(patient_id,chair_id,procedure_id,start_at,end_at,source,status,confirm_status) values ($1,1,$2,$3,$4,'전화','완료','확인') returning id`,
      [demo[0].id, pid(name), kstAt(addDays(today, d), 10, 0), kstAt(addDays(today, d), 10, procs.find((p) => p.name === name)!.duration_min)]);
    await q(`insert into treatments(appointment_id,patient_id,procedure_id,doctor_id,hygienist_id,treated_at,record_note) values ($1,$2,$3,1,5,$4,$5)`, [a[0].id, demo[0].id, pid(name), addDays(today, d), note]);
  }
  const tomorrow = addDays(today, 1);
  const tmr = await q<{ id: number }>(`insert into appointments(patient_id,chair_id,procedure_id,start_at,end_at,source,status) values ($1,1,$2,$3,$4,'네이버','예약') returning id`,
    [demo[0].id, pid('정기 검진'), kstAt(tomorrow, 10, 0), kstAt(tomorrow, 10, 30)]);
  await q(`insert into notifications(patient_id,kind,ref_id,title,body) values ($1,'전날 확인',$2,'내일 예약을 확인해 주세요','내일 오전 10:00 정기 검진 예약이 있어요. 오실 수 있는지 알려 주세요.')`, [demo[0].id, tmr[0].id]);
  await q(`insert into notifications(patient_id,kind,title,body,read_at) values ($1,'검진 안내','정기 검진 시기가 됐어요','마지막 검진 후 6개월이 지났어요. 편한 시간에 예약해 주세요.',now())`, [demo[0].id]);

  // 아이들: 하준이는 모레 충치 치료 예약, 서아는 지난달 정기 검진
  let da = addDays(today, 2);
  if (new Date(da + 'T00:00:00Z').getUTCDay() === 0) da = addDays(da, 1); // 일요일 휴진
  await q(`insert into appointments(patient_id,chair_id,procedure_id,start_at,end_at,source,status) values ($1,2,$2,$3,$4,'전화','예약')`, [kid[0].id, pid('충치 치료(레진)'), kstAt(da, 15, 0), kstAt(da, 15, 30)]);
  const ka = await q<{ id: number }>(`insert into appointments(patient_id,chair_id,procedure_id,start_at,end_at,source,status,confirm_status) values ($1,3,$2,$3,$4,'전화','완료','확인') returning id`, [kid2[0].id, pid('정기 검진'), kstAt(addDays(today, -100), 11, 0), kstAt(addDays(today, -100), 11, 30)]);
  await q(`insert into treatments(appointment_id,patient_id,procedure_id,doctor_id,hygienist_id,treated_at,record_note) values ($1,$2,$3,2,6,$4,'유치 우식 관찰, 불소 도포')`, [ka[0].id, kid2[0].id, pid('정기 검진'), addDays(today, -100)]);
  await q(`insert into notifications(patient_id,kind,title,body) values ($1,'검진 안내','하준이 정기 검진 시기가 됐어요','마지막 검진 후 6개월이 지났어요. 충치 치료 오실 때 함께 받아도 돼요.')`, [kid[0].id]);

  // 앞으로 2주 예약 (의자별로 겹치지 않게 채움)
  const others = await q<{ id: number }>(`select id from patients where id > $1 order by id limit 400`, [kid2[0].id]);
  for (let d = 0; d <= 14; d++) {
    const day = addDays(today, d);
    const dow = new Date(day + 'T00:00:00Z').getUTCDay();
    if (dow === 0) continue;
    const endMin = dow === 6 ? 13 * 60 : 18 * 60 + 30;
    for (let chair = 1; chair <= 5; chair++) {
      let t = 9 * 60 + 30;
      while (t < endMin) {
        const p = pick(procs);
        const lunch = dow !== 6 && t < 14 * 60 && t + p.duration_min > 13 * 60;
        if (t + p.duration_min > endMin || lunch) { t = lunch ? 14 * 60 : endMin; continue; }
        if (rnd() < 0.55 && !(d === 1 && chair === 1 && t >= 600 && t < 630) && !(day === da && chair === 2 && t >= 900 && t < 930)) {
          try {
            await q(`insert into appointments(patient_id,chair_id,procedure_id,start_at,end_at,source,status) values ($1,$2,$3,$4,$5,$6,'예약')`,
              [pick(others).id, chair, p.id, kstAt(day, 0, t), kstAt(day, 0, t + p.duration_min), pick(['전화', '네이버', '웹앱'])]);
            t += p.duration_min;
          } catch { t += 30; } // 시연 환자 예약과 겹치면 건너뜀 (DB가 막음)
        } else t += 30;
      }
    }
  }
  const n = await q(`select (select count(*) from patients) p, (select count(*) from appointments) a, (select count(*) from document_chunks) c`);
  console.log('seed done', n[0]);
}

if (require.main === module) resetAndSeed().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
