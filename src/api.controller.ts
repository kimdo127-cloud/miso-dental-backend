import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers, NotFoundException, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { q } from './db/db';
import { resetAndSeed } from './db/seed';
import { answer } from './chat';
import { CLINIC, isClinicOpen, kstAt, kstDate, kstParts, addDays } from './time';

const SECRET = process.env.JWT_SECRET || 'dev-only-secret';
const digits = (s: string) => (s || '').replace(/\D/g, '');

// 로그인 단위는 휴대폰 번호. 그 번호가 본인 번호거나 보호자 번호인 환자가 "가족"
function loginPhone(auth?: string): string {
  const token = (auth || '').replace(/^Bearer\s+/i, '');
  try {
    const p: any = jwt.verify(token, SECRET);
    if (p.role !== 'patient' || !p.phone) throw new Error();
    return p.phone;
  } catch {
    throw new UnauthorizedException('다시 본인 확인을 해 주세요.');
  }
}
async function family(phone: string) {
  return q<any>(`select id,name,birth_date::text birth_date,phone,guardian_phone,
      date_part('year', age(birth_date))::int as age, (phone is null or phone <> $1) as is_child
    from patients where phone = $1 or guardian_phone = $1 order by (phone = $1) desc nulls last, birth_date`, [phone]);
}
// 진료받을 사람(X-Patient-Id)이 로그인한 가족인지 확인. 다른 집 환자 번호는 거절
async function target(auth: string | undefined, pid: string | undefined): Promise<{ phone: string; id: number; ids: number[] }> {
  const phone = loginPhone(auth);
  const fam = await family(phone);
  if (!fam.length) throw new UnauthorizedException('다시 본인 확인을 해 주세요.');
  const ids = fam.map((f) => f.id);
  const id = pid ? Number(pid) : ids[0];
  if (!ids.includes(id)) throw new ForbiddenException('우리 가족의 진료 정보만 볼 수 있어요.');
  return { phone, id, ids };
}

// 진료 시간 안의 30분 단위 시작 시각 (분)
function openSlots(date: string, duration: number): number[] {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  if (dow === 0) return [];
  const end = dow === 6 ? 780 : 1110;
  const out: number[] = [];
  for (let t = 570; t + duration <= end; t += 30) {
    if (dow !== 6 && t < 840 && t + duration > 780) continue; // 점심시간 걸침
    out.push(t);
  }
  return out;
}

async function freeChairs(start: string, end: string): Promise<number[]> {
  const rows = await q<{ id: number }>(
    `select id from chairs c where not exists (
       select 1 from appointments a where a.chair_id = c.id and a.status = '예약'
         and tstzrange(a.start_at, a.end_at) && tstzrange($1::timestamptz, $2::timestamptz)) order by id`, [start, end]);
  return rows.map((r) => r.id);
}

@Controller()
export class ApiController {
  @Get('health') health() { return { ok: true }; }

  @Get('clinic') clinic() { return { ...CLINIC, open: isClinicOpen() }; }

  @Post('reset') async reset() {
    if (process.env.ALLOW_RESET !== 'true') throw new ForbiddenException();
    await resetAndSeed();
    return { ok: true };
  }

  // P1 본인 확인: 휴대폰 번호(아이는 보호자 번호) + 이름
  @Post('patient/login') async login(@Body() b: { phone: string; name: string }) {
    const phone = digits(b?.phone);
    const name = (b?.name || '').trim();
    if (phone.length < 10 || !name) throw new BadRequestException('휴대폰 번호와 이름을 입력해 주세요.');
    // 로그인하는 사람은 휴대폰 주인(부모). 아이 이름으로는 로그인하지 않음
    const rows = await q<{ id: number }>(`select id from patients where phone = $1 and name = $2`, [phone, name]);
    if (!rows.length) throw new NotFoundException(`등록된 환자 정보를 찾지 못했어요. 병원(${CLINIC.phone})으로 연락 주세요.`);
    const token = jwt.sign({ phone, role: 'patient' }, SECRET, { expiresIn: '7d' });
    return { token, profiles: await this.profilesOf(phone) };
  }

  private async profilesOf(phone: string) {
    return (await family(phone)).map((f) => ({ id: f.id, name: f.name, age: f.age, isChild: f.is_child, isOwner: f.phone === phone }));
  }

  // "누구 진료인가요?" 고르기: 본인과 보호자 번호로 연결된 아이들
  @Get('profiles') async profiles(@Headers('authorization') auth: string) {
    return this.profilesOf(loginPhone(auth));
  }

  // P2 홈
  @Get('me') async me(@Headers('authorization') auth: string, @Headers('x-patient-id') pid: string) {
    const { id, ids, phone } = await target(auth, pid);
    const [owner] = await q<any>(`select name from patients where phone=$1`, [phone]);
    const [p] = await q<any>(`select id,name,birth_date,guardian_phone,last_checkup_at,checkup_cycle_months,
        (last_checkup_at + make_interval(months => checkup_cycle_months))::date::text as next_checkup_due from patients where id=$1`, [id]);
    const [next] = await q<any>(`select a.id,a.start_at,a.end_at,a.confirm_status,p.name procedure from appointments a join procedures p on p.id=a.procedure_id
        where a.patient_id=$1 and a.status='예약' and a.start_at > now() order by a.start_at limit 1`, [id]);
    const [{ unread }] = await q<any>(`select count(*)::int unread from notifications where patient_id = any($1) and read_at is null`, [ids]);
    const isChild = p.guardian_phone != null;
    const [{ n: hasCheckup }] = await q<any>(`select count(*)::int n from appointments a join procedures p on p.id=a.procedure_id where a.patient_id=$1 and a.status='예약' and a.start_at > now() and p.name='정기 검진'`, [id]);
    // 가족 전체의 다가오는 예약 (보호자가 아이들 예약을 한눈에)
    const familyUpcoming = await q<any>(`select a.id,a.start_at,a.confirm_status,p.name procedure,pt.id patient_id,pt.name patient from appointments a
        join procedures p on p.id=a.procedure_id join patients pt on pt.id=a.patient_id
        where a.patient_id = any($1) and a.status='예약' and a.start_at > now() order by a.start_at limit 10`, [ids]);
    return { id, ownerName: owner?.name ?? null, name: p.name, isChild, nextAppointment: next || null, familyUpcoming, unread, nextCheckupDue: p.next_checkup_due, checkupOverdue: !!p.next_checkup_due && p.next_checkup_due <= kstDate() && !hasCheckup };
  }

  // P4 내 예약
  @Get('appointments') async appointments(@Headers('authorization') auth: string, @Headers('x-patient-id') pid: string) {
    const { ids } = await target(auth, pid);
    return q(`select a.id,a.start_at,a.end_at,a.status,a.confirm_status,a.source,p.name procedure,c.name chair,pt.id patient_id,pt.name patient
        from appointments a join procedures p on p.id=a.procedure_id join chairs c on c.id=a.chair_id join patients pt on pt.id=a.patient_id
        where a.patient_id = any($1) and a.status = '예약' and a.start_at > now() order by a.start_at`, [ids]);
  }

  // P4-1 전날 확인: 갈게요 / 변경할게요
  @Post('appointments/:id/confirm') async confirm(@Headers('authorization') auth: string, @Headers('x-patient-id') pid: string, @Param('id') aid: string, @Body() b: { answer: 'yes' | 'change' }) {
    const { ids } = await target(auth, pid);
    if (!['yes', 'change'].includes(b?.answer)) throw new BadRequestException();
    const rows = await q(`update appointments set confirm_status=$1 where id=$2 and patient_id = any($3) and status='예약' returning id,confirm_status`, [b.answer === 'yes' ? '확인' : '변경 요청', Number(aid), ids]);
    if (!rows.length) throw new NotFoundException('예약을 찾지 못했어요.');
    return rows[0];
  }

  @Get('procedures') procedures() {
    return q(`select id,name,duration_min from procedures where name <> '교정 장치 부착' order by id`);
  }

  // P5-1 빈 시간: 시술 소요 시간 동안 빈 의자가 있는 시간만 가능
  @Get('slots') async slots(@Query('procedureId') procedureId: string, @Query('date') date: string) {
    const [p] = await q<any>(`select duration_min from procedures where id=$1`, [Number(procedureId)]);
    if (!p || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new BadRequestException();
    const today = kstDate();
    if (date < today || date > addDays(today, 30)) return [];
    const nowMin = kstParts().min;
    // 그날 예약을 한 번에 읽어 의자별로 비는 시간을 계산 (시간칸마다 DB를 부르지 않음)
    const busy = await q<{ chair_id: number; s: number; e: number }>(
      `select chair_id, extract(epoch from start_at)::bigint s, extract(epoch from end_at)::bigint e from appointments
        where status='예약' and start_at < $2 and end_at > $1`, [kstAt(date, 0, 0), kstAt(addDays(date, 1), 0, 0)]);
    const chairs = (await q<{ id: number }>(`select id from chairs`)).map((c) => c.id);
    const base = Date.parse(kstAt(date, 0, 0)) / 1000;
    const out = [];
    for (const t of openSlots(date, p.duration_min)) {
      if (date === today && t <= nowMin + 60) continue;
      const s0 = base + t * 60, e0 = s0 + p.duration_min * 60;
      const free = chairs.some((c) => !busy.some((b) => b.chair_id === c && Number(b.s) < e0 && Number(b.e) > s0));
      out.push({ time: `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`, available: free });
    }
    return out;
  }

  // P5 예약 신청: 빈 의자를 골라 저장. 같은 의자 겹침은 DB가 거절 (23P01)
  @Post('appointments') async book(@Headers('authorization') auth: string, @Headers('x-patient-id') pid: string, @Body() b: { procedureId: number; date: string; time: string }) {
    const { id } = await target(auth, pid);
    const [p] = await q<any>(`select id,duration_min from procedures where id=$1`, [Number(b?.procedureId)]);
    const m = /^(\d{2}):(\d{2})$/.exec(b?.time || '');
    if (!p || !m || !/^\d{4}-\d{2}-\d{2}$/.test(b?.date || '')) throw new BadRequestException('시술과 시간을 골라 주세요.');
    const t = Number(m[1]) * 60 + Number(m[2]);
    if (!openSlots(b.date, p.duration_min).includes(t) || b.date < kstDate()) throw new BadRequestException('예약할 수 없는 시간이에요.');
    const start = kstAt(b.date, 0, t), end = kstAt(b.date, 0, t + p.duration_min);
    const mine = await q(`select 1 from appointments where patient_id=$1 and status='예약' and tstzrange(start_at,end_at) && tstzrange($2::timestamptz,$3::timestamptz)`, [id, start, end]);
    if (mine.length) throw new ConflictException('같은 시간에 이미 예약이 있어요.');
    for (const chair of await freeChairs(start, end)) {
      try {
        const [row] = await q(`insert into appointments(patient_id,chair_id,procedure_id,start_at,end_at,source,status,confirm_status) values ($1,$2,$3,$4,$5,'웹앱','예약','확인') returning id,start_at`, [id, chair, p.id, start, end]);
        return row;
      } catch (e: any) {
        if (e?.code !== '23P01') throw e; // 동시에 같은 의자가 잡힌 경우 다음 의자 시도
      }
    }
    throw new ConflictException('그 시간에 빈 의자가 없어요. 다른 시간을 골라 주세요.');
  }

  // P6 받은 시술: 시술 이름과 날짜만. 진료 기록 내용(record_note)은 주지 않음 (FR-10)
  @Get('treatments') async treatments(@Headers('authorization') auth: string, @Headers('x-patient-id') pid: string) {
    const { id } = await target(auth, pid);
    return q(`select t.id,t.treated_at::text treated_at,p.id procedure_id,p.name procedure from treatments t join procedures p on p.id=t.procedure_id where t.patient_id=$1 order by t.treated_at desc`, [id]);
  }

  // P6-1 시술별 주의사항 (그 시술 자료만)
  @Get('aftercare/:procedureId') async aftercare(@Param('procedureId') pid: string) {
    const [proc] = await q<any>(`select id,name from procedures where id=$1`, [Number(pid)]);
    if (!proc) throw new NotFoundException();
    const items = await q(`select c.page,c.heading,c.content,d.title,d.edition_year from document_chunks c join documents d on d.id=c.document_id
        where d.kind='주의사항' and d.is_current and c.procedure_id=$1 order by c.page`, [proc.id]);
    return { procedure: proc.name, items };
  }

  // P7 알림함
  @Get('notifications') async notifications(@Headers('authorization') auth: string, @Headers('x-patient-id') pid: string) {
    const { ids } = await target(auth, pid);
    return q(`select n.id,n.kind,n.ref_id,n.title,n.body,n.sent_at,n.read_at,p.id patient_id,p.name patient from notifications n join patients p on p.id=n.patient_id
        where n.patient_id = any($1) order by n.sent_at desc`, [ids]);
  }
  @Post('notifications/:id/read') async read(@Headers('authorization') auth: string, @Headers('x-patient-id') pid: string, @Param('id') nid: string) {
    const { ids } = await target(auth, pid);
    await q(`update notifications set read_at=coalesce(read_at,now()) where id=$1 and patient_id = any($2)`, [Number(nid), ids]);
    return { ok: true };
  }

  // P3 AI 상담
  @Post('chat') async chat(@Headers('authorization') auth: string, @Headers('x-patient-id') pid: string, @Body() b: { question: string }) {
    const { id } = await target(auth, pid);
    const question = (b?.question || '').trim();
    if (!question) throw new BadRequestException('질문을 입력해 주세요.');
    if (question.length > 500) throw new BadRequestException('질문은 500자 이내로 써 주세요.');
    return answer(id, question);
  }
  @Get('chat') async history(@Headers('authorization') auth: string, @Headers('x-patient-id') pid: string) {
    const { id } = await target(auth, pid);
    return q(`select id,question,category,status,ai_answer,desk_answer,asked_at,answered_at from chat_questions where patient_id=$1 order by asked_at desc limit 30`, [id]);
  }
}
