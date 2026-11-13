// 어드민에서 올린 자료를 Dify 지식에도 바로 추가 (지식 API 키와 지식 ID가 설정된 경우)
export async function pushToDify(title: string, kind: string, text: string): Promise<boolean> {
  const key = process.env.DIFY_DATASET_KEY, id = process.env.DIFY_DATASET_ID;
  if (!key || !id) return false;
  const prefix = kind === '보험 기준' ? '보험 기준 · ' : '주의사항 · ';
  const body = text.replace(/^##\s*/gm, `## ${prefix}`);
  const res = await fetch(`${process.env.DIFY_API_URL || 'https://api.dify.ai/v1'}/datasets/${id}/document/create-by-text`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `${title}.md`, text: body, indexing_technique: 'high_quality',
      process_rule: { mode: 'custom', rules: { pre_processing_rules: [{ id: 'remove_extra_spaces', enabled: true }], segmentation: { separator: '##', max_tokens: 500 } } },
    }),
  });
  return res.ok;
}
