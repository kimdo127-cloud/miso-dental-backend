# 미소치과 환자 케어 서비스 · 백엔드

NestJS + PostgreSQL. 해커톤 06 미소치과.

- `DATABASE_URL`이 없으면 로컬 파일 PostgreSQL(PGlite)로 실행
- 같은 의자 시간 겹침은 DB가 막음 (`EXCLUDE USING gist`)
- AI 상담: 증상 질문은 백엔드가 먼저 차단 → Dify(`DIFY_API_KEY`) 또는 GPT(`OPENAI_API_KEY`)로 병원 자료 근거 답변
- 시연 데이터는 가상 (환자 1,200명, 주의사항·보험 기준 가상 자료)

```
cp .env.example .env   # 키는 직접 입력, GitHub에 올리지 않음
npm install
npm run dev            # http://localhost:4100/api
```
Dify 지식 파일과 앱 설정: `docs/dify/`
