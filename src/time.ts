// 병원 시간은 모두 한국 시간(KST) 기준
const KST = 9 * 60 * 60 * 1000;

export function kstDate(d = new Date()): string {
  return new Date(d.getTime() + KST).toISOString().slice(0, 10);
}
export function addDays(date: string, n: number): string {
  const t = new Date(date + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}
export function kstAt(date: string, h: number, m: number): string {
  const total = h * 60 + m;
  const hh = String(Math.floor(total / 60)).padStart(2, '0');
  const mm = String(total % 60).padStart(2, '0');
  return `${date}T${hh}:${mm}:00+09:00`;
}
export function kstParts(d = new Date()) {
  const k = new Date(d.getTime() + KST);
  return { dow: k.getUTCDay(), min: k.getUTCHours() * 60 + k.getUTCMinutes() };
}

// 진료 시간: 평일 09:30~18:30 (점심 13:00~14:00), 토요일 09:30~13:00, 일요일 휴진
export function isClinicOpen(d = new Date()): boolean {
  const { dow, min } = kstParts(d);
  if (dow === 0) return false;
  if (dow === 6) return min >= 570 && min < 780;
  if (min >= 780 && min < 840) return false;
  return min >= 570 && min < 1110;
}
export const CLINIC = {
  name: '미소치과',
  phone: '02-1234-5678',
  hours: '평일 09:30~18:30 (점심 13:00~14:00) · 토요일 09:30~13:00 · 일요일 휴진',
  emergency: '피가 계속 나거나 붓기·통증이 심하면 가까운 응급실(119)이나 응급 진료가 가능한 치과를 찾으세요. 다음 진료일 아침에 병원으로 꼭 연락 주세요.',
};
