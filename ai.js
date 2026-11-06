// AI 설명 패널의 순수 로직 (네트워크 호출 없음). app.js 가 fetch 를 담당합니다.
import { CONSTANTS } from './logic.js';

const SYSTEM_PROMPT = [
  '당신은 계약서 조항을 일반인이 이해하기 쉽게 설명하는 도우미입니다.',
  '법률 자문을 하지 않으며, 각 조항의 의미와 위험 이유를 쉬운 한국어로 설명하고,',
  '상대방과 협상할 때 쓸 수 있는 조금 더 부드러운 대체 문구를 제안합니다.',
  '입력에 있는 [마스킹] 표시는 개인정보를 가린 것이므로 추측하지 마세요.',
  '반드시 JSON 배열만 출력하세요. 형식: [{"no": 1, "explanation": "...", "alternative": "..."}]',
  'explanation 과 alternative 는 각각 300자 이내의 한국어 문장이어야 합니다.',
].join(' ');

/**
 * 선택된 항목을 AI 에 보낼 최소 데이터로 정리합니다.
 * items: [{ no, title, severity, why, clauseText }]  (clauseText 는 호출 전에 마스킹되어 있어야 함)
 * 반환된 userText 가 실제 전송 내용이며, 화면 미리보기에도 같은 값을 씁니다.
 */
export function buildAiPayload(items) {
  const picked = (items || []).slice(0, CONSTANTS.AI_MAX_CLAUSES).map((it, i) => ({
    no: i + 1,
    title: String(it.title || '').slice(0, 60),
    severity: String(it.severity || ''),
    why: String(it.why || '').slice(0, 300),
    clauseText: String(it.clauseText || '').slice(0, CONSTANTS.AI_MAX_CHARS_PER_CLAUSE),
  }));
  const lines = [];
  lines.push('아래 계약 조항들을 설명해 주세요. 각 항목마다 explanation 과 alternative 를 작성하세요.');
  lines.push('');
  for (const p of picked) {
    lines.push(`--- 항목 ${p.no} ---`);
    lines.push(`점검 항목: ${p.title} (심각도: ${p.severity})`);
    lines.push(`점검 이유: ${p.why}`);
    lines.push('조항 원문(마스킹됨):');
    lines.push(p.clauseText);
    lines.push('');
  }
  const userText = lines.join('\n');
  return {
    model: CONSTANTS.AI_MODEL,
    max_tokens: CONSTANTS.AI_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userText }],
    userText,
    count: picked.length,
  };
}

/** 모델 응답 텍스트를 검증해 항목 배열로 바꿉니다. 실패하면 빈 배열과 원문 일부를 돌려줍니다. */
export function parseAiReply(text) {
  const raw = String(text || '');
  const capped = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
  let arr = null;
  const tryParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const a = raw.indexOf('['), b = raw.lastIndexOf(']');
  if (a !== -1 && b > a) arr = tryParse(raw.slice(a, b + 1));
  if (!Array.isArray(arr)) {
    const o = raw.indexOf('{'), p = raw.lastIndexOf('}');
    if (o !== -1 && p > o) {
      const one = tryParse(raw.slice(o, p + 1));
      if (one && typeof one === 'object') arr = [one];
    }
  }
  const items = [];
  if (Array.isArray(arr)) {
    for (const e of arr) {
      if (!e || typeof e !== 'object') continue;
      const explanation = typeof e.explanation === 'string' ? capped(e.explanation, 600) : '';
      const alternative = typeof e.alternative === 'string' ? capped(e.alternative, 600) : '';
      const no = Number.isInteger(e.no) && e.no > 0 && e.no <= CONSTANTS.AI_MAX_CLAUSES ? e.no : items.length + 1;
      if (explanation || alternative) items.push({ no, explanation, alternative });
    }
  }
  return { items, fallbackText: items.length ? '' : capped(raw, 1200) };
}

/** Anthropic 키 형식 확인 (서버 검증이 아니라 명백한 오입력만 거릅니다). */
export function isPlausibleKey(key) {
  return /^sk-ant-[A-Za-z0-9_-]{20,200}$/.test(String(key || '').trim());
}

/** AI 를 쓸 수 없을 때의 로컬 설명: 규칙에 들어 있는 문구를 그대로 씁니다. */
export function localExplanation(finding) {
  return {
    explanation: finding.why,
    alternative: finding.negotiation,
    source: 'local',
  };
}

/** 응답 본문(JSON)에서 텍스트 블록만 모읍니다. */
export function extractReplyText(body) {
  if (!body || !Array.isArray(body.content)) return '';
  return body.content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}
