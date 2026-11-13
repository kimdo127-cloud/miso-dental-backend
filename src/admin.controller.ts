import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers, NotFoundException, Param, Post, Query, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { q } from './db/db';
import { checkPassword } from './password';
import { addDays, kstAt, kstDate } from './time';
import { pushToDify } from './dify-knowledge';

const SECRET = process.env.JWT_SECRET || 'dev-only-secret';
type Role = '데스크' | '원장' | '위생사';
type Staff = { id: number; name: string; role: Role };

// 직원 토큰 확인 + 역할 검사. 사용 중지 계정은 거절
async function staff(auth: string | undefined, roles?: Role[]): Promise<Staff> {
  let id: number;
  try {
    const p: any = jwt.verify((auth || '').replace(/^Bearer\s+/i, ''), SECRET);
    if (p.role !== 'staff') throw new Error();
    id = p.sub;
  } catch { throw new UnauthorizedException('다시 로그인해 주세요.'); }
  const [s] = await q<any>(`select id,name,role,is_active from staff where id=$1`, [id]);
  if (!s?.is_active) throw new UnauthorizedException('사용할 수 없는 계정이에요.');
  if (roles && !roles.includes(s.role)) throw new ForbiddenException(`${roles.join(' · ')}만 할 수 있어요.`);
  return s;
}
const DESK: Role[] = ['데스크', '원장'];

function openSlotsMin(date: string, duration: number): number[] {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  if (dow === 0) return [];
  const end = dow === 6 ? 780 : 1110, out: number[] = [];
  for (let t = 570; t + duration <= end; t += 30) { if (dow !== 6 && t < 840 && t + duration > 780) continue; out.push(t); }
  return out;
}

@Controller('admin')
export class AdminController {
  // A1 직원 로그인
  @Post('login') async login(@Body() b: { email: string; password: string }) {
    const [s] = await q<any>(`select id,name,role,is_active,password_hash from staff where email=$1`, [(b?.email || '').trim().toLowerCase()]);
    if (!s || !checkPassword(b?.password || '', s.password_hash)) throw new UnauthorizedException('이메일이나 비밀번호가 맞지 않아요.');
    if (!s.is_active) throw new UnauthorizedException('사용 중지된 계정이에요. 원장님께 문의해 주세요.');
    return { token: jwt.sign({ sub: s.id, role: 'staff' }, SECRET, { expiresIn: '12h' }), staff: { id: s.id, name: s.name, role: s.role } };
  }
  @Get('me') async me(@Headers('authorization') a: string) { return staff(a); }

  // A2 대시보드: 지금 처리할 일
  @Get('dashboard') async dashboard(@Headers('authorization') a: string) {
    const me = await staff(a);
    const today = kstDate(), tomorrow = addDays(today, 1);
    const [c] = await q<any>(`select
      (select count(*)::int from chat_questions where status='데스크 대기') waiting,
      (select count(*)::int from appointments where status='예약' and start_at >= $1 and start_at < $2 and confirm_status <> '확인') unconfirmed,
      (select count(*)::int from appointments where status='예약' and confirm_status='변경 요청' and start_at > now()) change_req,
      (select count(*)::int from appointments where status='예약' and start_at >= $3 and start_at < $1) today_cnt`,
      [kstAt(tomorrow, 0, 0), kstAt(addDays(tomorrow, 1), 0, 0), kstAt(today, 0, 0)]);
    const [{ n: checkup }] = await q<any>(`select count(*)::int n from patients p where (p.last_checkup_at + make_interval(months => p.checkup_cycle_months))::date <= $1::date
      and not exists (select 1 from appointments a join procedures pr on pr.id=a.procedure_id where a.patient_id=p.id and a.status='예약' and a.start_at > now() and pr.needs_checkup)`, [today]);
    return { me, ...c, checkup };
  }

  // A3 예약 관리: 날짜별 · 의자별
  @Get('appointments') async appointments(@Headers('authorization') a: string, @Query('date') date: string) {
    await staff(a);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : kstDate();
    return q(`select a.id,a.start_at,a.end_at,a.status,a.confirm_status,a.source,c.id chair_id,c.name chair,p.name procedure,p.supplies,pt.id patient_id,pt.name patient,
        coalesce(pt.phone,pt.guardian_phone) phone,(pt.guardian_phone is not null) is_child
      from appointments a join chairs c on c.id=a.chair_id join procedures p on p.id=a.procedure_id join patients pt on pt.id=a.patient_id
      where a.start_at >= $1 and a.start_at < $2 and a.status <> '취소' order by a.start_at, c.id`, [kstAt(d, 0, 0), kstAt(addDays(d, 1), 0, 0)]);
  }
  @Get('procedures') async procedures(@Headers('authorization') a: string) { await staff(a); return q(`select id,name,duration_min,supplies from procedures order by id`); }
  @Get('chairs') async chairs(@Headers('authorization') a: string) { await staff(a); return q(`select id,name from chairs order by id`); }

  // A3-1 전화 · 네이버 예약 입력. 같은 의자 시간 겹침은 DB가 거절
  @Post('appointments') async create(@Headers('authorization') a: string, @Body() b: { patientId: number; procedureId: number; chairId: number; date: string; time: string; source: string }) {
    await staff(a, DESK);
    const [p] = await q<any>(`select id,duration_min from procedures where id=$1`, [Number(b?.procedureId)]);
    const m = /^(\d{2}):(\d{2})$/.exec(b?.time || '');
    if (!p || !m || !b?.patientId || !b?.chairId || !['전화', '네이버'].includes(b?.source)) throw new BadRequestException('환자, 시술, 의자, 시간, 경로를 모두 골라 주세요.');
    const t = Number(m[1]) * 60 + Number(m[2]);
    if (!openSlotsMin(b.date, p.duration_min).includes(t)) throw new BadRequestException('진료 시간 밖이거나 점심시간에 걸려요.');
    try {
      const [row] = await q(`insert into appointments(patient_id,chair_id,procedure_id,start_at,end_at,source,status) values ($1,$2,$3,$4,$5,$6,'예약') returning id`,
        [Number(b.patientId), Number(b.chairId), p.id, kstAt(b.date, 0, t), kstAt(b.date, 0, t + p.duration_min), b.source]);
      return row;
    } catch (e: any) {
      if (e?.code === '23P01') throw new ConflictException('그 의자는 그 시간에 이미 예약이 있어요. (DB가 막음)');
      throw e;
    }
  }
  @Post('appointments/:id/status') async setStatus(@Headers('authorization') a: string, @Param('id') id: string, @Body() b: { status?: string; confirm?: string }) {
    await staff(a, DESK);
    if (b?.status && !['완료', '노쇼', '취소'].includes(b.status)) throw new BadRequestException();
    if (b?.confirm && !['확인', '미확인'].includes(b.confirm)) throw new BadRequestException();
    const rows = await q(`update appointments set status=coalesce($1,status), confirm_status=coalesce($2,confirm_status) where id=$3 returning id,status,confirm_status`, [b?.status ?? null, b?.confirm ?? null, Number(id)]);
    if (!rows.length) throw new NotFoundException();
    return rows[0];
  }

  // A4 문의 답변: AI가 못 답한 질문 → 데스크 답변 → 환자 알림함
  @Get('questions') async questions(@Headers('authorization') a: string, @Query('status') status: string) {
    await staff(a, DESK);
    return q(`select c.id,c.question,c.category,c.status,c.ai_answer,c.desk_answer,c.asked_at,c.answered_at,p.name patient,(p.guardian_phone is not null) is_child,s.name answered_by
      from chat_questions c join patients p on p.id=c.patient_id left join staff s on s.id=c.answered_by
      where ($1::text is null or c.status=$1) order by c.asked_at desc limit 100`, [status || null]);
  }
  @Post('questions/:id/answer') async answer(@Headers('authorization') a: string, @Param('id') id: string, @Body() b: { answer: string }) {
    const me = await staff(a, DESK);
    const text = (b?.answer || '').trim();
    if (!text) throw new BadRequestException('답변을 입력해 주세요.');
    const [row] = await q<any>(`update chat_questions set status='데스크 답변', desk_answer=$1, answered_by=$2, answered_at=now() where id=$3 and status='데스크 대기' returning id,patient_id,question`, [text, me.id, Number(id)]);
    if (!row) throw new ConflictException('이미 답했거나 없는 질문이에요.');
    await q(`insert into notifications(patient_id,kind,ref_id,title,body) values ($1,'데스크 답변',$2,$3,$4)`, [row.patient_id, row.id, `문의에 답변이 왔어요: ${row.question.slice(0, 30)}`, text]);
    return { ok: true };
  }

  // A5 전날 확인: 내일 예약과 확인 상태, 확인 요청 보내기
  @Post('reminders/send') async sendReminders(@Headers('authorization') a: string) {
    await staff(a, DESK);
    const tomorrow = addDays(kstDate(), 1);
    const rows = await q<any>(`select a.id,a.patient_id,a.start_at,p.name procedure from appointments a join procedures p on p.id=a.procedure_id
      where a.status='예약' and a.confirm_status='미확인' and a.start_at >= $1 and a.start_at < $2
        and not exists (select 1 from notifications n where n.kind='전날 확인' and n.ref_id=a.id)`, [kstAt(tomorrow, 0, 0), kstAt(addDays(tomorrow, 1), 0, 0)]);
    for (const r of rows) {
      const k = new Date(new Date(r.start_at).getTime() + 9 * 3600e3);
      const hm = `${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
      await q(`insert into notifications(patient_id,kind,ref_id,title,body) values ($1,'전날 확인',$2,'내일 예약을 확인해 주세요',$3)`, [r.patient_id, r.id, `내일 ${hm} ${r.procedure} 예약이 있어요. 오실 수 있는지 알려 주세요.`]);
    }
    return { sent: rows.length };
  }

  // A6 정기 검진 대상: 검진 시기가 지났고 다가오는 검진 예약이 없는 환자
  @Get('checkups') async checkups(@Headers('authorization') a: string) {
    await staff(a, DESK);
    return q(`select p.id,p.name,coalesce(p.phone,p.guardian_phone) phone,(p.guardian_phone is not null) is_child,p.preferred_channel,p.last_checkup_at::text last_checkup_at,
        (p.last_checkup_at + make_interval(months => p.checkup_cycle_months))::date::text due,
        (select max(n.sent_at) from notifications n where n.patient_id=p.id and n.kind='검진 안내') last_notice
      from patients p where (p.last_checkup_at + make_interval(months => p.checkup_cycle_months))::date <= $1::date
        and not exists (select 1 from appointments a join procedures pr on pr.id=a.procedure_id where a.patient_id=p.id and a.status='예약' and a.start_at > now() and pr.needs_checkup)
      order by due limit 300`, [kstDate()]);
  }
  @Post('checkups/notify') async notifyCheckups(@Headers('authorization') a: string, @Body() b: { patientIds: number[] }) {
    await staff(a, DESK);
    const ids = (b?.patientIds || []).map(Number).filter(Boolean);
    if (!ids.length) throw new BadRequestException('안내할 환자를 골라 주세요.');
    const pts = await q<any>(`select id,name,guardian_phone from patients where id = any($1)`, [ids]);
    for (const p of pts) await q(`insert into notifications(patient_id,kind,title,body) values ($1,'검진 안내',$2,'마지막 검진 후 6개월이 지났어요. 편한 시간에 예약해 주세요.')`, [p.id, `${p.guardian_phone ? p.name + ' ' : ''}정기 검진 시기가 됐어요`]);
    return { sent: pts.length };
  }

  // A7 환자 검색 · 상세. 진료 기록 내용은 원장과 담당 위생사만
  @Get('patients') async patients(@Headers('authorization') a: string, @Query('q') qs: string) {
    await staff(a);
    const k = (qs || '').trim();
    if (!k) return [];
    return q(`select id,name,birth_date::text birth_date,coalesce(phone,guardian_phone) phone,(guardian_phone is not null) is_child from patients
      where name like $1 or phone like $2 or guardian_phone like $2 order by name limit 30`, [`%${k}%`, `%${k.replace(/\D/g, '') || '@'}%`]);
  }
  @Get('patients/:id') async patient(@Headers('authorization') a: string, @Param('id') id: string) {
    const me = await staff(a);
    const [p] = await q<any>(`select id,name,birth_date::text birth_date,phone,guardian_phone,preferred_channel,last_checkup_at::text last_checkup_at from patients where id=$1`, [Number(id)]);
    if (!p) throw new NotFoundException();
    const treatments = await q<any>(`select t.id,t.treated_at::text treated_at,pr.name procedure,d.name doctor,h.name hygienist,t.hygienist_id,t.record_note
      from treatments t join procedures pr on pr.id=t.procedure_id left join staff d on d.id=t.doctor_id left join staff h on h.id=t.hygienist_id where t.patient_id=$1 order by t.treated_at desc`, [p.id]);
    const appts = await q(`select a.id,a.start_at,a.status,a.confirm_status,pr.name procedure from appointments a join procedures pr on pr.id=a.procedure_id where a.patient_id=$1 order by a.start_at desc limit 20`, [p.id]);
    return {
      ...p, appointments: appts,
      treatments: treatments.map((t) => {
        const can = me.role === '원장' || (me.role === '위생사' && t.hygienist_id === me.id);
        return { ...t, record_note: can ? t.record_note : null, record_locked: !can };
      }),
    };
  }

  // A8 자료 관리: 주의사항 · 보험 기준 문서 올리기 (## 제목 단위로 나눔, 올리면 바로 답변에 반영)
  @Get('documents') async documents(@Headers('authorization') a: string) {
    await staff(a);
    return q(`select d.id,d.kind,d.title,d.edition_year,d.is_current,d.uploaded_at,s.name uploaded_by,(select count(*)::int from document_chunks c where c.document_id=d.id) chunks
      from documents d left join staff s on s.id=d.uploaded_by order by d.uploaded_at desc`);
  }
  @Post('documents') async upload(@Headers('authorization') a: string, @Body() b: { kind: string; title: string; year: number; text: string }) {
    const me = await staff(a, DESK);
    if (!['주의사항', '보험 기준'].includes(b?.kind) || !b?.title?.trim() || !b?.text?.trim() || !Number(b?.year)) throw new BadRequestException('종류, 제목, 연도, 내용을 모두 입력해 주세요.');
    const procs = await q<any>(`select id,name from procedures`);
    // "## [시술] 제목 (n쪽)" 단위로 나눔
    const parts = b.text.split(/\n(?=##\s)/).map((x) => x.trim()).filter((x) => x.startsWith('##'));
    if (!parts.length) throw new BadRequestException('"## [시술 이름] 제목 (쪽)" 형식의 단락이 하나 이상 있어야 해요.');
    // 같은 종류의 예전 판은 현재 판에서 내림 (보험은 올해 기준만 답변에 사용)
    await q(`update documents set is_current=false where kind=$1 and edition_year <= $2`, [b.kind, Number(b.year)]);
    const [d] = await q<any>(`insert into documents(kind,title,edition_year,is_current,uploaded_by) values ($1,$2,$3,true,$4) returning id`, [b.kind, b.title.trim(), Number(b.year), me.id]);
    for (const part of parts) {
      const [head, ...body] = part.split('\n');
      const m = /^##\s*(?:\[([^\]]+)\])?\s*(.*?)\s*(?:\((\d+)쪽\))?\s*$/.exec(head) || [];
      const proc = procs.find((p) => p.name === m[1]);
      await q(`insert into document_chunks(document_id,procedure_id,page,heading,content) values ($1,$2,$3,$4,$5)`, [d.id, proc?.id ?? null, Number(m[3] || 0), m[2] || head.replace(/^##\s*/, ''), body.join(' ').trim()]);
    }
    const dify = await pushToDify(b.title.trim(), b.kind, b.text).catch(() => false);
    return { id: d.id, chunks: parts.length, dify };
  }
}
