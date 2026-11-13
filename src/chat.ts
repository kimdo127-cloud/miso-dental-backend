import { q } from './db/db';
import { CLINIC, isClinicOpen } from './time';

// 증상 판단이 필요한 질문 (BR-03: "피가 안 멎어요"는 증상 질문)
const SYMPTOM = /(피가?\s*(안|계속|자꾸|많이)|출혈|안\s*멎|멈추지\s*않|아파|아프|통증|쑤시|욱신|부었|붓기가?\s*(안|더|계속|심)|열이|고름|시려서\s*잠|저려|감각이\s*없|냄새가?\s*나|흔들려|빠졌|이상해|정상인가|괜찮은\s*건가|괜찮을까|염증\s*같|터졌|부러졌|깨졌)/;
const INSURANCE = /(보험|급여|본인\s*부담|본인부담|비용|가격|얼마|실비|공단)/;

export type Source = { chunkId: number; document: string; edition: number; page: number; heading: string; excerpt: string };
export type ChatResult = { type: 'answer' | 'symptom' | 'handoff'; category: string; answer: string; sources: Source[]; clinic: { open: boolean; phone: string; hours: string; message: string } };

function bigrams(s: string): Set<string> {
  const t = s.replace(/[^가-힣a-zA-Z0-9]/g, '');
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function score(qs: Set<string>, text: string): number {
  const ts = bigrams(text);
  let n = 0;
  qs.forEach((b) => { if (ts.has(b)) n++; });
  return n / Math.max(qs.size, 1);
}

async function detectProcedure(question: string): Promise<{ id: number; name: string } | null> {
  const procs = await q<{ id: number; name: string; keywords: string }>(`select id,name,keywords from procedures`);
  // 더 구체적인 키워드(사랑니)가 일반 키워드(발치)보다 먼저 맞도록 긴 것부터 비교
  const pairs = procs.flatMap((p) => p.keywords.split(',').map((k) => ({ p, k: k.trim() }))).sort((a, b) => b.k.length - a.k.length);
  const hit = pairs.find(({ k }) => k && question.includes(k));
  return hit ? { id: hit.p.id, name: hit.p.name } : null;
}

// 환자가 쓰는 말 → 자료에 적힌 말
const SYNONYMS: [RegExp, string][] = [
  [/술|맥주|소주|와인|음주/, ' 음주'], [/담배|흡연|전자담배/, ' 흡연'], [/밥|먹|음식|식사/, ' 식사 음식'], [/양치|이\s*닦|칫솔/, ' 양치'],
  [/운동|헬스|사우나|목욕/, ' 운동 사우나'], [/빨대/, ' 빨대'], [/시려|시림/, ' 시림'], [/붓|부어/, ' 붓기'], [/실밥|봉합/, ' 실밥'], [/거즈|솜/, ' 거즈'],
];
function expand(question: string): string {
  return question + SYNONYMS.filter(([r]) => r.test(question)).map(([, w]) => w).join('');
}

async function retrieve(question: string, kind: '주의사항' | '보험 기준') {
  const proc = await detectProcedure(question);
  question = expand(question);
  // 현재 판(올해) 문서만 사용. 시술이 특정되면 그 시술 자료만 사용 (BR-02, BR-04)
  const rows = await q<any>(
    `select c.id, c.page, c.heading, c.content, c.procedure_id, d.title, d.edition_year
       from document_chunks c join documents d on d.id = c.document_id
      where d.kind = $1 and d.is_current = true
        and ($2::int is null or c.procedure_id = $2 or c.procedure_id is null)`,
    [kind, proc?.id ?? null],
  );
  const qs = bigrams(question);
  return rows
    .map((r) => ({ ...r, s: score(qs, r.heading + ' ' + r.content) + (proc && r.procedure_id === proc.id ? 0.3 : 0) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((r) => ({ ...r, procMatched: !!proc }));
}

async function askLLM(question: string, chunks: any[]): Promise<{ result: string; answer: string; sources: number[] } | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const context = chunks.map((c, i) => `[${i + 1}] ${c.title} ${c.page}쪽 · ${c.heading}\n${c.content}`).join('\n\n');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: [
          '당신은 미소치과의 안내 도우미입니다. 병원 내부 규정을 지킵니다.',
          '1. 아래 병원 자료에 적힌 내용만으로 답합니다. 자료에 없는 내용, 일반 상식, 추측은 쓰지 않습니다.',
          '2. 환자의 현재 증상이나 상태가 괜찮은지 판단해 달라는 질문은 진료이므로 답하지 않습니다.',
          '3. 질문한 시술의 자료만 씁니다. 다른 시술의 주의사항을 섞지 않습니다.',
          '4. 보험은 일반 기준만 안내하고, 환자 개인의 적용 여부는 판단하지 않습니다.',
          '응답은 JSON 하나: {"result":"ANSWER|NO_ANSWER|SYMPTOM","answer":"존댓말 2~3문장","sources":[근거로 쓴 자료 번호]}',
          '자료로 답할 수 없으면 result를 NO_ANSWER, 증상 판단이면 SYMPTOM으로 하고 answer는 빈 문자열로 둡니다.',
        ].join('\n') },
        { role: 'user', content: `병원 자료:\n${context}\n\n질문: ${question}` },
      ],
    }),
  });
  if (!res.ok) return null;
  const j: any = await res.json();
  try {
    const o = JSON.parse(j.choices?.[0]?.message?.content || '');
    return { result: String(o.result || ''), answer: String(o.answer || ''), sources: Array.isArray(o.sources) ? o.sources.map(Number) : [] };
  } catch { return null; }
}


// Dify 챗봇 (한빛수학과 같은 방식: 화면 → 백엔드 → Dify). 지식에는 올해 판 자료만 올린다
async function askDify(patientId: number, question: string): Promise<{ answer: string; resources: { document_name: string; content: string }[] } | null> {
  const key = process.env.DIFY_API_KEY;
  if (!key) return null;
  const res = await fetch(`${process.env.DIFY_API_URL || 'https://api.dify.ai/v1'}/chat-messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: {}, query: question, response_mode: 'blocking', user: `patient-${patientId}` }),
  }).catch(() => null);
  if (!res || !res.ok) { console.error('dify', res?.status, res && (await res.text()).slice(0, 300)); return null; }
  const out: any = await res.json();
  return { answer: String(out.answer || ''), resources: out.metadata?.retriever_resources ?? [] };
}

export async function answer(patientId: number, question: string): Promise<ChatResult> {
  const open = isClinicOpen();
  const clinic = {
    open,
    phone: CLINIC.phone,
    hours: CLINIC.hours,
    message: open ? `지금은 진료 시간이에요. 병원(${CLINIC.phone})으로 바로 전화해 주세요.` : CLINIC.emergency,
  };
  const save = async (category: string, status: string, ai: string | null, ids: number[]) => {
    await q(`insert into chat_questions(patient_id,question,category,status,ai_answer,source_chunk_ids) values ($1,$2,$3,$4,$5,$6)`, [patientId, question, category, status, ai, ids]);
  };

  if (SYMPTOM.test(question)) {
    const msg = '증상을 보고 판단하는 것은 진료라서 여기서는 답해 드릴 수 없어요.';
    await save('증상', '증상 안내', null, []);
    return { type: 'symptom', category: '증상', answer: msg, sources: [], clinic };
  }

  const category = INSURANCE.test(question) ? '보험' : '주의사항';

  const dify = await askDify(patientId, question);
  if (dify) {
    if (/증상 판단/.test(dify.answer)) {
      await save('증상', '증상 안내', null, []);
      return { type: 'symptom', category: '증상', answer: '증상을 보고 판단하는 것은 진료라서 여기서는 답해 드릴 수 없어요.', sources: [], clinic };
    }
    if (/병원 자료에 없는 내용/.test(dify.answer) || !dify.resources.length) {
      await save(category === '보험' ? '보험' : '기타', '데스크 대기', null, []);
      return { type: 'handoff', category, answer: '병원 자료에서 답을 찾지 못했어요. 질문을 데스크에 전달했어요. 다음 진료일 아침에 답변을 알림함으로 보내 드릴게요.', sources: [], clinic };
    }
    const sources: Source[] = dify.resources.slice(0, 3).map((r) => {
      const m = /\((\d+)쪽\)/.exec(r.content);
      const h = /^#+\s*(.+)$/m.exec(r.content);
      return { chunkId: 0, document: r.document_name.replace(/\.(md|txt|pdf)$/i, '').replace(/^\d+_/, ''), edition: 2026, page: m ? Number(m[1]) : 0, heading: h ? h[1].replace(/\(\d+쪽\)/, '').trim() : '', excerpt: r.content.replace(/^#+.*$/m, '').trim() };
    });
    let text = dify.answer;
    if (category === '보험' && !/데스크/.test(text)) text += ' 올해 이미 혜택을 받았는지 같은 개인별 적용 여부는 병원 데스크에서 확인해 드려요.';
    await save(category, 'AI 답변', text, []);
    return { type: 'answer', category, answer: text, sources, clinic };
  }
  const chunks = await retrieve(question, category === '보험' ? '보험 기준' : '주의사항');
  const best = chunks[0];
  const handoff = async (): Promise<ChatResult> => {
    await save(category === '보험' ? '보험' : '기타', '데스크 대기', null, []);
    return { type: 'handoff', category, answer: '병원 자료에서 답을 찾지 못했어요. 질문을 데스크에 전달했어요. 다음 진료일 아침에 답변을 알림함으로 보내 드릴게요.', sources: [], clinic };
  };
  const llm = !!process.env.OPENAI_API_KEY;
  // 시술이 특정되면 그 시술 자료를 GPT가 읽고 판단(없으면 NO_ANSWER). GPT가 없으면 점수로만 판단
  if (!best || (best.s < 0.12 && !(llm && best.procMatched))) return handoff();

  let used = llm && best.procMatched ? chunks : chunks.filter((c) => c.s >= Math.max(0.12, best.s * 0.6)).slice(0, 2);
  const ai = await askLLM(question, used).catch(() => null);
  if (ai?.result === 'SYMPTOM') {
    await save('증상', '증상 안내', null, []);
    return { type: 'symptom', category: '증상', answer: '증상을 보고 판단하는 것은 진료라서 여기서는 답해 드릴 수 없어요.', sources: [], clinic };
  }
  // 모델이 NO_ANSWER로 표시하고도 근거와 답을 채우는 경우가 있어, 답과 근거가 모두 있으면 답으로 본다
  if (ai?.result === 'NO_ANSWER' && !(ai.answer && ai.sources.length)) return handoff();
  let text = ai?.answer || '';
  if (ai && ai.sources.length) used = ai.sources.map((n) => used[n - 1]).filter(Boolean);
  if (!text) { used = used.filter((c) => c.s >= 0.12).slice(0, 2); if (!used.length) return handoff(); text = used.map((c) => c.content).join(' '); }
  if (category === '보험') text += ' 올해 이미 혜택을 받았는지 같은 개인별 적용 여부는 병원 데스크에서 확인해 드려요.';

  await save(category, 'AI 답변', text, used.map((c) => c.id));
  return {
    type: 'answer', category, answer: text, clinic,
    sources: used.map((c) => ({ chunkId: c.id, document: c.title, edition: c.edition_year, page: c.page, heading: c.heading, excerpt: c.content })),
  };
}
