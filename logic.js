// 순수 로직 (DOM 없음). 테스트는 tests/logic.test.js 에서 직접 호출합니다.
import { RULES } from './rules.js';

// 모든 기준값은 이 객체에 둡니다. 법령·관행이 바뀌면 여기와 rules.js 를 함께 갱신하세요.
export const CONSTANTS = {
  기준일: '2026년 11월 (규칙 작성일 2026-11-06)',
  적용_안내: '규칙은 일반적인 계약 관행과 흔한 위험 문구를 기준으로 합니다. 법령 기준은 바뀔 수 있습니다.',
  SCORE_WEIGHTS: { 높음: 15, 중간: 8, 참고: 3 }, // 규칙 1개당 가중치 (같은 규칙이 여러 번 나와도 1회)
  SCORE_MAX: 100,
  GRADE_THRESHOLDS: { 높음: 45, 보통: 20 }, // 점수 이상이면 해당 등급
  MAX_INPUT_CHARS: 300000, // 이 길이를 넘는 원문은 앞부분만 분석
  MAX_FILE_BYTES: 1024 * 1024, // .txt 파일 최대 1MB
  MAX_FINDINGS_PER_RULE: 8, // 한 규칙이 조항 안에서 표시되는 최대 횟수
  AI_MODEL: 'claude-haiku-5-5',
  AI_MAX_TOKENS: 700,
  AI_MAX_CLAUSES: 5,
  AI_MAX_CHARS_PER_CLAUSE: 1200,
  STORAGE_KEY: 'clausecheck-reviews',
  AI_KEY_STORAGE: 'clausecheck-ai-key',
  BACKUP_VERSION: 1,
};

export const SEVERITIES = ['높음', '중간', '참고'];

export const CONTRACT_TYPES = [
  { key: 'freelance', label: '프리랜서 용역·외주' },
  { key: 'franchise', label: '프랜차이즈·가맹' },
  { key: 'lease', label: '임대차(상가·주택)' },
  { key: 'labor', label: '근로·위촉' },
  { key: 'nda', label: '비밀유지(NDA)' },
  { key: 'subscription', label: '구독·서비스 약관' },
  { key: 'other', label: '기타 (전체 규칙 적용)' },
];

export const DISCLAIMER =
  '참고용 자동 점검이며 법률 자문이 아닙니다. 중요한 계약은 반드시 변호사 등 전문가에게 확인하세요.';

export function typeLabel(key) {
  return (CONTRACT_TYPES.find((t) => t.key === key) || CONTRACT_TYPES[CONTRACT_TYPES.length - 1]).label;
}

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ───────────── 조항 나누기 ─────────────
// 시작 줄 패턴: 제N조 / Article N / 1. 또는 1) / (1) / ① / 가. 등
const HEADING_START = /^\s*(?:제\s?\d{1,3}\s?조|Article\s+\d{1,3}\b|\d{1,3}\s?[.)]\s|\(\d{1,3}\)|[①-⑳]|[가-하]\s?[.)]\s)/i;
// 제목만 있는 줄 (예: "제3조 (대금)") 은 다음 문단과 합칩니다.
const ARTICLE_ONLY = /^\s*(?:제\s?\d{1,3}\s?조(?:\s*\([^)]{1,30}\))?|Article\s+\d{1,3}(?:\s+[A-Za-z ]{1,30})?)\s*$/i;

/**
 * 원문을 조항 단위로 나눕니다. 빈 줄(문단), 제N조, 번호 목록 시작에서 나뉘며
 * 각 조항은 원문에서의 시작·끝 위치(start/end)를 가집니다. text === source.slice(start, end)
 */
export function splitClauses(source) {
  const src = typeof source === 'string' ? source : '';
  const lines = [];
  let pos = 0;
  for (const part of src.split('\n')) {
    lines.push({ s: pos, t: part });
    pos += part.length + 1;
  }

  const groups = [];
  let cur = null;
  let carry = null; // 제목만 있는 줄 (다음 조항에 붙임)
  const flush = () => {
    if (!cur) return;
    const onlyHeading = cur.lines.length === 1 && ARTICLE_ONLY.test(cur.lines[0].t);
    if (onlyHeading) carry = cur.lines[0];
    else groups.push(cur);
    cur = null;
  };
  for (const ln of lines) {
    if (!ln.t.trim()) { flush(); continue; }
    if (cur && HEADING_START.test(ln.t)) flush();
    if (!cur) {
      cur = { lines: [] };
      if (carry) { cur.lines.push(carry); carry = null; }
    }
    cur.lines.push(ln);
  }
  flush();
  if (carry) groups.push({ lines: [carry] });

  return groups.map((g, i) => {
    const first = g.lines[0];
    const last = g.lines[g.lines.length - 1];
    const lead = first.t.length - first.t.trimStart().length;
    const start = first.s + lead;
    const end = last.s + last.t.trimEnd().length;
    const text = src.slice(start, end);
    const oneLine = text.split('\n')[0].trim();
    const title = oneLine.length > 28 ? oneLine.slice(0, 28) + '…' : oneLine;
    return { index: i, no: i + 1, start, end, text, title };
  });
}

// ───────────── 규칙 엔진 ─────────────
function appliesTo(rule, typeKey) {
  if (!typeKey || typeKey === 'other') return true;
  return rule.types.includes('all') || rule.types.includes(typeKey);
}

// 전역(g) 플래그 복사본을 미리 만들어 둡니다 (matchAll 은 g 플래그 필요).
const COMPILED = RULES.map((rule) => ({
  rule,
  risk: (rule.patterns || []).map((re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')),
  protects: (rule.protects || []).map((re) => new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')),
}));

function publicRule(rule) {
  return {
    ruleId: rule.id,
    title: rule.title,
    severity: rule.severity,
    why: rule.why,
    negotiation: rule.negotiation,
    question: rule.question,
    kind: rule.kind,
    legalRef: !!rule.legalRef, // true 이면 '확인 필요' (임의 기준·기준일 표시 대상)
  };
}

/**
 * 계약서 텍스트를 점검합니다.
 * @returns {{ type, truncated, clauses, findings, absences, score, grade, counts, ruleHits }}
 *  findings : 조항 안에서 찾은 위험 문구 (start/end 는 원문 기준 위치)
 *  absences : 누락된 보호 조항 (체크리스트)
 */
export function analyzeContract(text, typeKey = 'other') {
  const raw = typeof text === 'string' ? text : '';
  const truncated = raw.length > CONSTANTS.MAX_INPUT_CHARS;
  const src = truncated ? raw.slice(0, CONSTANTS.MAX_INPUT_CHARS) : raw;
  const clauses = splitClauses(src);
  const findings = [];
  const absences = [];
  const hitRules = new Set();

  for (const { rule, risk, protects } of COMPILED) {
    if (!appliesTo(rule, typeKey)) continue;

    if (rule.kind === 'absent') {
      // 원문 전체에서 보호 문구를 하나라도 찾으면 누락이 아님
      const ok = protects.some((re) => src.search(re) !== -1);
      if (!ok) {
        absences.push(publicRule(rule));
        hitRules.add(rule.id);
      }
      continue;
    }

    let perRule = 0;
    for (const clause of clauses) {
      if (perRule >= CONSTANTS.MAX_FINDINGS_PER_RULE) break;
      for (const re of risk) {
        for (const m of clause.text.matchAll(re)) {
          if (perRule >= CONSTANTS.MAX_FINDINGS_PER_RULE) break;
          if (!m[0]) continue;
          if (rule.guard && !rule.guard(m, clause.text)) continue;
          const start = clause.start + m.index;
          findings.push({
            id: `${rule.id}-${findings.length}`,
            ...publicRule(rule),
            clauseIndex: clause.index,
            clauseNo: clause.no,
            start,
            end: start + m[0].length,
            matched: m[0],
            kind: 'risk',
          });
          hitRules.add(rule.id);
          perRule++;
        }
      }
    }
  }

  const sevRank = { 높음: 0, 중간: 1, 참고: 2 };
  findings.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.start - b.start);
  absences.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

  const score = computeScore(hitRules);
  const counts = { 높음: 0, 중간: 0, 참고: 0, 누락: absences.length };
  for (const f of findings) counts[f.severity]++;
  for (const a of absences) counts[a.severity]++;

  return {
    type: typeKey,
    truncated,
    clauses,
    findings,
    absences,
    score,
    grade: gradeOf(score),
    counts,
    ruleHits: [...hitRules],
  };
}

function ruleSeverity(id) {
  const r = RULES.find((x) => x.id === id);
  return r ? r.severity : '참고';
}

export function computeScore(hitRuleIds) {
  let total = 0;
  for (const id of new Set(hitRuleIds)) total += CONSTANTS.SCORE_WEIGHTS[ruleSeverity(id)] || 0;
  return Math.min(CONSTANTS.SCORE_MAX, total);
}

export function gradeOf(score) {
  if (score >= CONSTANTS.GRADE_THRESHOLDS.높음) return '높음';
  if (score >= CONSTANTS.GRADE_THRESHOLDS.보통) return '보통';
  return '낮음';
}

// ───────────── 마스킹 (가리기) ─────────────
const RRN_RE = /(?<!\d)\d{6}\s?-?\s?[1-8]\d{6}(?!\d)/g;
const PHONE_RE = /(?<![\d-])0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,4}/g;
const ACCOUNT_CTX_RE = /(계좌(?:번호)?|입금처|은행|account)([^\n\d]{0,12})(\d[\d-]{5,24}\d)/gi;
const ACCOUNT_DASH_RE = /(?<!\d)\d{3,6}-\d{2,6}-\d{4,8}(?!\d)/g;
const AMOUNT_RE = /(?<![\d,])\d{1,3}(?:,\d{3}){1,4}(?:\s?원)?|(?<![\d,])\d{1,12}\s?(?:만|억|천)?\s?원/g;

/**
 * 개인정보·금액을 가립니다. 원문을 바꾸지 않고 새 문자열을 돌려줍니다.
 * options: { rrn, phone, email, account, amount } (기본 true), names: 가릴 이름 배열
 */
export function redact(text, options = {}) {
  const opt = { rrn: true, phone: true, email: true, account: true, amount: true, ...options };
  const counts = { 주민번호: 0, 전화번호: 0, 이메일: 0, 계좌번호: 0, 금액: 0, 이름: 0 };
  let out = typeof text === 'string' ? text : '';

  const swap = (re, label, key) => {
    out = out.replace(re, () => { counts[key]++; return label; });
  };

  if (opt.rrn) swap(RRN_RE, '[주민번호]', '주민번호');
  if (opt.email) swap(EMAIL_RE, '[이메일]', '이메일');
  // 계좌는 전화번호보다 먼저 봅니다. 0 으로 시작하는 3-4-4 형태는 전화번호로 남겨 둡니다.
  if (opt.account) {
    out = out.replace(ACCOUNT_CTX_RE, (m, kw, mid) => { counts.계좌번호++; return `${kw}${mid}[계좌번호]`; });
    out = out.replace(ACCOUNT_DASH_RE, (m) => { if (m[0] === '0') return m; counts.계좌번호++; return '[계좌번호]'; });
  }
  if (opt.phone) swap(PHONE_RE, '[전화번호]', '전화번호');
  if (opt.amount) swap(AMOUNT_RE, '[금액]', '금액');

  const names = (opt.names || [])
    .map((n) => String(n || '').trim())
    .filter((n) => n.length > 0 && n.length <= 30)
    .slice(0, 20);
  if (names.length) {
    const re = new RegExp(names.map(escapeRegExp).join('|'), 'g');
    out = out.replace(re, () => { counts.이름++; return '[이름]'; });
  }
  return { text: out, counts };
}

// ───────────── 출력물 ─────────────
const SEV_ORDER = { 높음: 0, 중간: 1, 참고: 2 };

/** 협상 이메일 초안 (로컬 템플릿). 발견한 위험 조항 중 규칙별 중복 없이 사용합니다. */
export function buildNegotiationEmail({ result, senderName = '[본인 성함]', receiverName = '[상대방 성함]', contractTitle = '' }) {
  const items = [];
  const seen = new Set();
  const all = [...result.findings, ...result.absences];
  all.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  for (const f of all) {
    if (seen.has(f.ruleId)) continue;
    seen.add(f.ruleId);
    items.push(f);
  }
  const lines = [];
  lines.push(`${receiverName} 님, 안녕하세요.`);
  lines.push('');
  lines.push(`${contractTitle ? `"${contractTitle}" ` : ''}계약서를 검토하는 과정에서 아래 조항에 대해 조정을 요청드립니다.`);
  lines.push('');
  if (items.length === 0) {
    lines.push('(선택된 항목이 없습니다. 조정 요청 항목을 선택한 뒤 다시 만들어 주세요.)');
  }
  items.forEach((f, i) => {
    const where = f.kind === 'risk' ? ` (조항 ${f.clauseNo} 부근)` : ' (누락된 조항)';
    lines.push(`${i + 1}. ${f.title}${where}`);
    lines.push(`   - 제안: ${f.negotiation}`);
    lines.push('');
  });
  lines.push('위 내용을 반영한 수정안을 검토할 수 있도록 공유해 주시면 감사하겠습니다.');
  lines.push('');
  lines.push('감사합니다.');
  lines.push(senderName);
  return lines.join('\n');
}

/** 점검 결과를 Markdown 으로 만듭니다. 원문 전체는 넣지 않습니다. */
export function buildMarkdownReport(review) {
  const r = review.result;
  const out = [];
  out.push(`# 계약서 위험조항 점검 결과`);
  out.push('');
  out.push(`- 제목: ${review.title || '(제목 없음)'}`);
  out.push(`- 계약 유형: ${typeLabel(review.type)}`);
  out.push(`- 점검일: ${review.createdAt ? review.createdAt.slice(0, 10) : ''}`);
  out.push(`- 위험 점수: ${r.score} / 100 (${r.grade})`);
  out.push(`- 발견: 높음 ${r.counts.높음}, 중간 ${r.counts.중간}, 참고 ${r.counts.참고}, 누락 ${r.counts.누락}`);
  out.push('');
  out.push(`> ${DISCLAIMER}`);
  out.push('');
  out.push('## 위험 조항');
  if (r.findings.length === 0) out.push('- 발견된 위험 문구가 없습니다.');
  for (const f of r.findings) {
    out.push(`### [${f.severity}] ${f.title} (조항 ${f.clauseNo} 부근)`);
    out.push(`- 발견 문구: "${f.matched}"`);
    out.push(`- 위험 이유: ${f.why}`);
    out.push(`- 확인 질문: ${f.question}`);
    out.push(`- 협상 제안: ${f.negotiation}`);
    out.push('');
  }
  out.push('## 누락된 보호 조항 체크리스트');
  if (r.absences.length === 0) out.push('- 확인한 보호 조항이 모두 있습니다 (문구 기준).');
  for (const a of r.absences) {
    out.push(`- [ ] [${a.severity}] ${a.title}: ${a.why}`);
  }
  out.push('');
  out.push('---');
  out.push(`기준: ${CONSTANTS.기준일}. ${CONSTANTS.적용_안내}`);
  return out.join('\n');
}

/** CSV 셀 안전 처리 (수식 주입 방지 포함) */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

export function buildFindingsCsv(result) {
  const head = ['구분', '심각도', '항목', '조항번호', '발견 문구', '확인 질문', '협상 제안'];
  const rows = [head.map(csvCell).join(',')];
  for (const f of result.findings) {
    rows.push([ '위험 문구', f.severity, f.title, f.clauseNo, f.matched, f.question, f.negotiation ].map(csvCell).join(','));
  }
  for (const a of result.absences) {
    rows.push([ '누락', a.severity, a.title, '', '', a.question, a.negotiation ].map(csvCell).join(','));
  }
  return '﻿' + rows.join('\r\n');
}

// ───────────── 저장 / 백업 ─────────────
const slimFinding = (f) => ({
  id: String(f.id || ''), ruleId: f.ruleId, title: f.title, severity: f.severity, clauseNo: f.clauseNo ?? null,
  matched: f.matched ?? '', why: f.why, negotiation: f.negotiation, question: f.question, kind: f.kind || 'risk',
});
const slimAbsence = (a) => ({
  ruleId: a.ruleId, title: a.title, severity: a.severity, why: a.why, negotiation: a.negotiation, question: a.question, kind: 'absent',
});

/**
 * 저장 기록. 원문을 저장하도록 켠 경우 text 가 들어가고, 열 때 다시 분석합니다.
 * 원문을 끄면 발견 목록과 누락 목록(요약)만 남깁니다.
 */
export function makeReviewRecord({ title, type, text, keepText, result, now = new Date() }) {
  return {
    id: `r${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    title: String(title || '').slice(0, 80),
    type: CONTRACT_TYPES.some((t) => t.key === type) ? type : 'other',
    createdAt: now.toISOString(),
    text: keepText ? String(text || '').slice(0, CONSTANTS.MAX_INPUT_CHARS) : '',
    score: result.score,
    grade: result.grade,
    counts: result.counts,
    findings: result.findings.map(slimFinding),
    absences: result.absences.map(slimAbsence),
  };
}

/** 저장 기록을 화면용 결과 객체로 바꿉니다. 원문이 있으면 다시 분석해 조항 본문을 복원합니다. */
export function reviewToResult(record) {
  if (record.text) return analyzeContract(record.text, record.type);
  return {
    type: record.type, truncated: false, clauses: [], findings: record.findings || [],
    absences: record.absences || [], score: record.score, grade: record.grade, counts: record.counts,
    ruleHits: [],
  };
}

/** 백업 JSON 검증. 잘못된 항목은 버리고 유효한 것만 돌려줍니다. */
export function parseBackup(jsonText) {
  let data;
  try {
    data = JSON.parse(String(jsonText));
  } catch {
    return { ok: false, error: 'JSON 형식이 올바르지 않습니다.', reviews: [] };
  }
  if (!data || data.app !== 'clausecheck' || !Array.isArray(data.reviews)) {
    return { ok: false, error: 'clausecheck 백업 파일이 아닙니다.', reviews: [] };
  }
  const reviews = data.reviews.filter((r) =>
    r && typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 64 &&
    typeof r.createdAt === 'string' && typeof r.score === 'number' &&
    Array.isArray(r.findings) && Array.isArray(r.absences)
  ).map((r) => ({
    id: r.id,
    title: String(r.title || '').slice(0, 80),
    type: CONTRACT_TYPES.some((t) => t.key === r.type) ? r.type : 'other',
    createdAt: r.createdAt,
    text: typeof r.text === 'string' ? r.text.slice(0, CONSTANTS.MAX_INPUT_CHARS) : '',
    score: Math.max(0, Math.min(CONSTANTS.SCORE_MAX, r.score)),
    grade: ['높음', '보통', '낮음'].includes(r.grade) ? r.grade : gradeOf(r.score),
    counts: r.counts && typeof r.counts === 'object' ? r.counts : { 높음: 0, 중간: 0, 참고: 0, 누락: 0 },
    findings: r.findings.filter((f) => f && typeof f.title === 'string').map(slimFinding),
    absences: r.absences.filter((a) => a && typeof a.title === 'string').map(slimAbsence),
  }));
  return { ok: true, error: '', reviews };
}

export function makeBackupJson(reviews) {
  return JSON.stringify({ app: 'clausecheck', version: CONSTANTS.BACKUP_VERSION, exportedAt: new Date().toISOString(), reviews }, null, 2);
}

/** 기존 목록과 백업을 id 기준으로 합칩니다 (같은 id 는 백업 쪽을 우선). */
export function mergeReviews(existing, incoming) {
  const map = new Map();
  for (const r of existing) map.set(r.id, r);
  for (const r of incoming) map.set(r.id, r);
  return [...map.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// ───────────── 샘플 ─────────────
export const SAMPLE_CONTRACT = `제1조 (목적)
갑은 을에게 홈페이지 리뉴얼 용역을 위탁하고, 을은 이를 완성하여 갑에게 납품한다.

제2조 (계약 기간)
본 계약은 체결일로부터 효력이 발생한다.

제3조 (대금 및 지급)
1. 용역 대금은 총 5,000,000원(부가세 별도)으로 한다.
2. 대금은 검수 완료 후 지급한다.
3. 갑의 사정으로 지급이 늦어질 경우 90일 이내에 지급할 수 있다.

제4조 (검수)
갑은 검수 기준을 임의로 정하며, 검수 기간은 별도 통보 시까지 연장될 수 있다.

제5조 (수정)
을은 갑의 요청에 따라 수정 작업을 횟수에 관계없이 진행한다.

제6조 (지식재산권)
본 계약으로 생성되는 모든 산출물의 저작재산권 및 2차 저작물에 대한 권리 일체는 갑에게 양도되며, 을은 포트폴리오에 이를 게재할 수 없다.

제7조 (비밀유지)
을은 본 계약과 관련된 비밀유지 의무를 기간의 제한 없이 부담한다.

제8조 (손해배상)
을의 귀책으로 인한 손해는 간접손해를 포함하여 모든 손해를 배상하며, 위약금은 별도 상한 없이 적용한다.

제9조 (해지)
갑은 언제든지 본 계약을 해지할 수 있다.

제10조 (재하도급 및 관할)
을은 재하도급을 할 수 없으며, 본 계약에 관한 소송은 갑의 본점 소재지 법원을 관할 법원으로 한다.
`;
