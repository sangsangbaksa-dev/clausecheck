import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RULES } from '../rules.js';
import {
  analyzeContract, splitClauses, redact, buildNegotiationEmail, buildMarkdownReport,
  buildFindingsCsv, makeReviewRecord, parseBackup, makeBackupJson, mergeReviews,
  computeScore, gradeOf, SAMPLE_CONTRACT, CONSTANTS, CONTRACT_TYPES, escapeRegExp, reviewToResult,
  STATUSES, STATUS_UNSET, itemKey, statusOf, setStatus, sanitizeStatuses, summarizeStatuses,
  compareContracts, buildReportModel, DISCLAIMER,
} from '../logic.js';
import { buildAiPayload, parseAiReply, isPlausibleKey, localExplanation, extractReplyText } from '../ai.js';

// 규칙별 예시. 위험 규칙은 positive 문장에서 발견, negative 문장에서는 발견되지 않아야 합니다.
// 누락 규칙은 neutral(보호 문구 없는 문장)에서 누락으로 나오고, protect 문장이 있으면 누락이 아닙니다.
const RISK_EXAMPLES = {
  'auto-renew': {
    pos: '이 계약은 1년마다 자동 갱신되며, 해지 시 위약금이 발생합니다.',
    neg: '이 계약은 1년마다 상호 합의하여 갱신할 수 있다.',
  },
  'notice-period-long': {
    pos: '해지를 원하면 3개월 전에 서면으로 통보하여야 한다.',
    neg: '해지를 원하면 14일 전에 통보한다.',
  },
  'penalty-no-cap': {
    pos: '을이 납기를 지키지 못하면 위약금으로 대금의 10%를 지급한다.',
    neg: '위약금은 계약 대금의 10%를 한도로 한다.',
  },
  'unlimited-liability': {
    pos: '을은 간접손해를 포함하여 모든 손해를 배상한다.',
    neg: '간접손해는 제외한다.',
  },
  'unilateral-termination': {
    pos: '갑은 언제든지 본 계약을 해지할 수 있다.',
    neg: '계약 당사자는 상호 합의에 의해 본 계약을 해지할 수 있다.',
  },
  'unilateral-change': {
    pos: '갑은 을과 협의 없이 일방적으로 계약 내용을 변경할 수 있다.',
    neg: '계약 내용의 변경은 쌍방이 서면으로 합의한 경우에만 효력이 있다.',
  },
  'payment-over-60': {
    pos: '대금은 발행일로부터 90일 이내에 지급한다.',
    neg: '대금은 검수 완료일로부터 30일 이내에 지급한다.',
  },
  'payment-conditional-acceptance': {
    pos: '대금은 검수 완료 후 지급한다.',
    neg: '대금은 검수 완료 후 10일 이내에 지급한다.',
  },
  'ip-full-transfer': {
    pos: '산출물의 저작재산권은 갑에게 양도한다.',
    neg: '산출물의 저작재산권은 대금 전액 지급 후 갑에게 양도한다.',
  },
  'derivative-works': {
    pos: '2차 저작물에 대한 권리는 갑에게 있다.',
    neg: '을은 결과물을 납품한다.',
  },
  'portfolio-ban': {
    pos: '을은 작업물을 포트폴리오에 게재할 수 없다.',
    neg: '을은 작업물을 포트폴리오로 사용할 수 있다.',
  },
  'nda-indefinite': {
    pos: '을은 비밀유지 의무를 기간의 제한 없이 부담한다.',
    neg: '을은 본 계약 종료 후 3년간 비밀유지 의무를 부담한다.',
  },
  'non-compete': {
    pos: '을은 계약 기간 중 동종 업종에 종사하는 것을 금지한다.',
    neg: '을은 자유롭게 다른 업무를 수행할 수 있다.',
  },
  'subcontract-ban': {
    pos: '을은 재하도급을 할 수 없다.',
    neg: '을은 필요한 경우 협의하여 업무를 나눌 수 있다.',
  },
  'jurisdiction-counterparty': {
    pos: '관할 법원은 갑의 본점 소재지 법원으로 한다.',
    neg: '관할 법원은 을의 주소지 법원으로 한다.',
  },
  'dispute-cost-shift': {
    pos: '소송 비용은 을이 전부 부담한다.',
    neg: '소송 비용은 각자 부담한다.',
  },
  'acceptance-vague': {
    pos: '검수는 갑이 재량으로 판단한다.',
    neg: '검수는 별첨 명세서 기준으로 7일 이내에 진행한다.',
  },
  'unlimited-revisions': {
    pos: '을은 수정 작업을 횟수에 관계없이 진행한다.',
    neg: '무상 수정은 2회까지 제공한다.',
  },
  'deposit-deduction': {
    pos: '보증금은 퇴거 시 반환하지 않는다.',
    neg: '보증금에서 미납 임대료를 공제한 뒤 나머지를 반환한다.',
  },
  'restoration-scope': {
    pos: '임차인은 퇴거 시 원상복구 일체를 부담한다.',
    neg: '통상의 손모를 제외한 원상복구를 한다.',
  },
  'rent-unilateral-increase': {
    pos: '임대료 인상은 임대인이 일방적으로 정할 수 있다.',
    neg: '임대료는 매년 상호 협의하여 정한다.',
  },
  'probation-long': {
    pos: '수습 기간은 6개월로 한다.',
    neg: '수습 기간은 3개월로 한다.',
  },
  'labor-at-will-dismissal': {
    pos: '회사는 언제든지 근로자를 해고할 수 있다.',
    neg: '회사는 정당한 이유가 있는 경우에 한하여 해고할 수 있다.',
  },
  'disguised-employment': {
    pos: '근로자는 출근 시간을 준수해야 한다.',
    neg: '을은 결과물 납품 일정을 준수한다.',
  },
  'subscription-cancel-restriction': {
    pos: '해지는 고객센터 전화로만 가능합니다.',
    neg: '해지는 앱 또는 홈페이지에서 언제든지 할 수 있습니다.',
  },
  'no-refund': {
    pos: '이용료는 환불하지 않습니다.',
    neg: '이용료는 환불 요청 시 일할 계산하여 환불합니다.',
  },
  'franchise-fee-no-refund': {
    pos: '가맹금은 어떠한 경우에도 반환하지 않는다.',
    neg: '가맹금 반환 기준은 계약서 별지에 따른다.',
  },
  'franchise-territory': {
    pos: '영업지역을 보장하지 않으며 본부는 직영점을 낼 수 있다.',
    neg: '가맹점은 지정된 영업지역 안에서 영업할 권리를 갖는다.',
  },
  'warranty-unlimited': {
    pos: '하자보수 책임은 기간의 제한 없이 을이 부담한다.',
    neg: '하자보수 기간은 납품일로부터 3개월로 한다.',
  },
  'set-off-unilateral': {
    pos: '갑은 대금에서 손해배상금을 상계할 수 있다.',
    neg: '대금은 상호 합의한 경우에만 상계한다.',
  },
  'subscription-trial-autocharge': {
    pos: '무료 체험 기간이 끝나면 자동으로 유료 전환됩니다.',
    neg: '무료 체험 기간은 14일이며 체험 후 이용 여부는 이용자가 정합니다.',
  },
  'franchise-price-fixing': {
    pos: '가맹점은 본부가 지정한 판매 가격을 준수하여야 한다.',
    neg: '가맹점은 판매 가격을 자율적으로 정한다.',
  },
  'labor-overtime-included': {
    pos: '연장·야간 수당은 월 급여에 포함된 것으로 본다.',
    neg: '연장근로수당은 시급에 따라 별도로 지급한다.',
  },
  'nda-scope-broad': {
    pos: '갑이 공유한 모든 정보는 비밀로 본다.',
    neg: '비밀정보는 서면으로 지정한 자료에 한정하며 공개된 정보는 제외한다.',
  },
};

const NEUTRAL = '제1조 (목적)\n갑은 을에게 업무를 맡긴다.';
const ABSENT_EXAMPLES = {
  'absent-payment-due-date': { protect: '대금 지급일은 익월 10일로 한다.' },
  'absent-termination': { protect: '본 계약은 해지 사유가 발생한 경우 종료한다.' },
  'absent-liability-cap': { protect: '을의 손해배상 책임은 계약 대금 범위 내로 한다.' },
  'absent-ip-clause': { protect: '산출물의 저작권은 갑에게 귀속한다.' },
  'absent-advance-payment': { protect: '계약금은 대금의 30%로 한다.' },
  'absent-acceptance-criteria': { protect: '검수 기준은 별첨 명세서에 따른다.' },
  'absent-contract-period': { protect: '계약 기간은 2026년 12월 31일까지로 한다.' },
  'absent-deposit-return-timing': { protect: '보증금은 퇴거 후 14일 이내에 반환한다.' },
  'absent-dispute-venue': { protect: '준거법은 대한민국 법으로 한다.' },
  'absent-franchise-disclosure': { protect: '가맹희망자는 정보공개서를 수령하였음을 확인한다.' },
  'absent-revision-limit': { protect: '무상 수정은 2회까지 제공한다.' },
  'absent-return-materials': { protect: '비밀정보는 계약 종료 시 반환하거나 파기한다.' },
};

const ruleById = (id) => RULES.find((r) => r.id === id);
const hasRisk = (text, id, type = 'other') =>
  analyzeContract(text, type).findings.some((f) => f.ruleId === id);
const hasAbsence = (text, id, type = 'other') =>
  analyzeContract(text, type).absences.some((a) => a.ruleId === id);

describe('rule data', () => {
  test('at least 25 rules, unique ids, valid severities', () => {
    assert.ok(RULES.length >= 25, `rule count ${RULES.length}`);
    const ids = new Set(RULES.map((r) => r.id));
    assert.equal(ids.size, RULES.length);
    for (const r of RULES) {
      assert.ok(['높음', '중간', '참고'].includes(r.severity), r.id);
      assert.ok(r.title && r.why && r.negotiation && r.question, `${r.id} missing text`);
      assert.ok(Array.isArray(r.types) && r.types.length > 0, r.id);
    }
  });

  test('every rule has positive and negative examples', () => {
    for (const r of RULES) {
      if (r.kind === 'risk') assert.ok(RISK_EXAMPLES[r.id], `missing risk examples for ${r.id}`);
      else assert.ok(ABSENT_EXAMPLES[r.id], `missing absent examples for ${r.id}`);
    }
  });

  test('every regex is global-capable and has no nested quantifier', () => {
    const nested = /\((?:[^()\\]|\\.)*[+*}]\)[+*{]/;
    for (const r of RULES) {
      for (const re of [...(r.patterns || []), ...(r.protects || [])]) {
        assert.ok(re instanceof RegExp, r.id);
        assert.ok(!nested.test(re.source), `possible nested quantifier in ${r.id}: ${re.source}`);
      }
    }
  });
});

describe('risk rules: positive / negative examples', () => {
  for (const r of RULES.filter((x) => x.kind === 'risk')) {
    const ex = RISK_EXAMPLES[r.id];
    test(`${r.id}: flags positive example`, () => {
      assert.ok(hasRisk(ex.pos, r.id), `expected ${r.id} on: ${ex.pos}`);
    });
    test(`${r.id}: does not flag negative example`, () => {
      assert.ok(!hasRisk(ex.neg, r.id), `did not expect ${r.id} on: ${ex.neg}`);
    });
  }
});

describe('absence rules (missing protections)', () => {
  for (const r of RULES.filter((x) => x.kind === 'absent')) {
    const ex = ABSENT_EXAMPLES[r.id];
    test(`${r.id}: reported as missing when protection text is absent`, () => {
      assert.ok(hasAbsence(NEUTRAL, r.id), `expected missing ${r.id}`);
    });
    test(`${r.id}: not reported when protection text is present`, () => {
      assert.ok(!hasAbsence(`${NEUTRAL}\n${ex.protect}`, r.id), `${r.id} should be satisfied`);
    });
  }

  test('absence checklist is built only for applicable contract types', () => {
    const leaseAbsences = analyzeContract(NEUTRAL, 'lease').absences.map((a) => a.ruleId);
    assert.ok(leaseAbsences.includes('absent-deposit-return-timing'));
    assert.ok(!leaseAbsences.includes('absent-advance-payment'), 'freelance-only rule leaked into lease');
    const nda = analyzeContract(NEUTRAL, 'nda').absences.map((a) => a.ruleId);
    assert.ok(!nda.includes('absent-liability-cap'));
  });

  test('type "other" applies all rules', () => {
    const ids = analyzeContract(NEUTRAL, 'other').absences.map((a) => a.ruleId);
    assert.ok(ids.includes('absent-deposit-return-timing'));
    assert.ok(ids.includes('absent-advance-payment'));
  });
});

describe('legal-reference flags (확인 필요)', () => {
  const LEGAL_IDS = [
    'payment-over-60', 'notice-period-long', 'probation-long', 'labor-at-will-dismissal',
    'disguised-employment', 'deposit-deduction', 'rent-unilateral-increase', 'franchise-fee-no-refund',
    'no-refund', 'subscription-cancel-restriction', 'subscription-trial-autocharge',
    'franchise-price-fixing', 'labor-overtime-included', 'absent-franchise-disclosure',
    'absent-deposit-return-timing',
  ];

  test('rules that cite a legal norm or threshold are flagged legalRef', () => {
    for (const id of LEGAL_IDS) assert.equal(ruleById(id)?.legalRef, true, id);
    const flagged = RULES.filter((r) => r.legalRef).map((r) => r.id).sort();
    assert.deepEqual(flagged, [...LEGAL_IDS].sort());
  });

  test('legalRef and kind reach the analysis output', () => {
    const r = analyzeContract('대금은 발행일로부터 90일 이내에 지급한다.', 'freelance');
    const f = r.findings.find((x) => x.ruleId === 'payment-over-60');
    assert.ok(f);
    assert.equal(f.legalRef, true);
    assert.equal(f.kind, 'risk');
    const a = analyzeContract(NEUTRAL, 'lease').absences.find((x) => x.ruleId === 'absent-deposit-return-timing');
    assert.equal(a.legalRef, true);
    assert.equal(a.kind, 'absent');
    const plain = analyzeContract('갑은 언제든지 본 계약을 해지할 수 있다.', 'other').findings[0];
    assert.equal(plain.legalRef, false);
  });

  test('rule count matches the documented totals (위험 34, 누락 12)', () => {
    assert.equal(RULES.filter((r) => r.kind === 'risk').length, 34);
    assert.equal(RULES.filter((r) => r.kind === 'absent').length, 12);
  });
});

describe('rule applicability', () => {
  test('lease-only risk rule is not reported for freelance contracts', () => {
    const text = '보증금은 퇴거 시 반환하지 않는다.';
    assert.ok(hasRisk(text, 'deposit-deduction', 'lease'));
    assert.ok(!hasRisk(text, 'deposit-deduction', 'freelance'));
  });
});

describe('clause splitting', () => {
  test('splits on 제N조 headings and keeps offsets exact', () => {
    const src = '제1조 (목적)\n본문 가.\n\n제2조 (대금)\n대금은 30일 이내.';
    const cs = splitClauses(src);
    assert.equal(cs.length, 2);
    for (const c of cs) assert.equal(src.slice(c.start, c.end), c.text);
    assert.match(cs[1].title, /제2조/);
  });

  test('splits numbered list items', () => {
    const src = '1. 첫째 항목입니다.\n2. 둘째 항목입니다.\n3) 셋째 항목입니다.';
    const cs = splitClauses(src);
    assert.equal(cs.length, 3);
  });

  test('handles English Article N headings', () => {
    const src = 'Article 1 Purpose\nThe parties agree.\n\nArticle 2 Fees\nFees are due in 30 days.';
    const cs = splitClauses(src);
    assert.equal(cs.length, 2);
    assert.match(cs[1].text, /^Article 2/);
  });

  test('blank lines separate paragraphs', () => {
    const cs = splitClauses('첫 문단입니다.\n\n둘째 문단입니다.\n\n\n셋째 문단입니다.');
    assert.equal(cs.length, 3);
  });

  test('a heading-only line joins the following paragraph', () => {
    const cs = splitClauses('제3조 (대금)\n\n대금은 검수 후 지급한다.');
    assert.equal(cs.length, 1);
    assert.match(cs[0].text, /^제3조/);
    assert.match(cs[0].text, /대금은 검수 후 지급한다/);
  });

  test('empty and non-string input give no clauses', () => {
    assert.deepEqual(splitClauses(''), []);
    assert.deepEqual(splitClauses(null), []);
  });

  test('CRLF line endings do not break offsets', () => {
    const src = '제1조 본문\r\n\r\n제2조 본문';
    const cs = splitClauses(src);
    assert.equal(cs.length, 2);
    for (const c of cs) assert.equal(src.slice(c.start, c.end), c.text);
  });
});

describe('analysis output', () => {
  test('finding spans match the matched text in the original contract', () => {
    const r = analyzeContract(SAMPLE_CONTRACT, 'freelance');
    assert.ok(r.findings.length > 5);
    for (const f of r.findings) {
      assert.equal(SAMPLE_CONTRACT.slice(f.start, f.end), f.matched);
    }
  });

  test('sample contract yields high-risk items and some missing protections', () => {
    const r = analyzeContract(SAMPLE_CONTRACT, 'freelance');
    assert.ok(r.counts.높음 >= 3);
    assert.ok(r.score >= 45);
    assert.equal(r.grade, '높음');
  });

  test('score counts each rule once and is capped', () => {
    assert.equal(computeScore(['auto-renew', 'auto-renew']), 15);
    assert.equal(computeScore(RULES.map((x) => x.id)), CONSTANTS.SCORE_MAX);
    assert.equal(gradeOf(0), '낮음');
    assert.equal(gradeOf(20), '보통');
    assert.equal(gradeOf(45), '높음');
  });

  test('empty and non-string inputs do not throw', () => {
    for (const v of ['', null, undefined, 123, {}]) {
      const r = analyzeContract(v, 'freelance');
      assert.equal(r.clauses.length, 0);
    }
  });

  test('very long input is truncated and flagged', () => {
    const big = '제1조 본문입니다. '.repeat(Math.ceil((CONSTANTS.MAX_INPUT_CHARS + 10) / 10));
    const r = analyzeContract(big, 'other');
    assert.equal(r.truncated, true);
  });

  test('contract types list has the required keys', () => {
    const keys = CONTRACT_TYPES.map((t) => t.key);
    for (const k of ['freelance', 'franchise', 'lease', 'labor', 'nda', 'subscription', 'other']) {
      assert.ok(keys.includes(k), k);
    }
  });
});

describe('performance: adversarial input', () => {
  test('200KB adversarial string analyzes in under 200ms', () => {
    const unit = '해지 지급 검수 관할 수정 자동 갱신 위약금 비밀유지 일방적으로 ';
    const one = unit.repeat(Math.ceil(200000 / unit.length)).slice(0, 200000);
    const pieces = ['지급 ', '해지 ', '검수 ', '수정 ', '보증금 ', '원상복구 ', '관할 ', '간접 '];
    const many = pieces.map((p) => p.repeat(Math.ceil(200000 / p.length))).join('').slice(0, 200000);
    const digitsRun = '지급 ' + '1'.repeat(200000);
    const lines = ('1. ' + '해지 '.repeat(20) + '\n').repeat(Math.ceil(200000 / 100)).slice(0, 200000);
    const inputs = { one, many, digitsRun, lines };
    for (const [name, s] of Object.entries(inputs)) {
      const t0 = performance.now();
      analyzeContract(s, 'other');
      const ms = performance.now() - t0;
      assert.ok(ms < 200, `${name} took ${ms.toFixed(1)}ms`);
    }
  });
});

describe('redaction', () => {
  test('masks resident registration number, phone, email', () => {
    const { text, counts } = redact('주민번호 900101-1234567, 연락처 010-1234-5678, 메일 kim.a+1@example.co.kr');
    assert.equal(text, '주민번호 [주민번호], 연락처 [전화번호], 메일 [이메일]');
    assert.equal(counts.주민번호, 1);
    assert.equal(counts.전화번호, 1);
    assert.equal(counts.이메일, 1);
  });

  test('masks account numbers with context and standalone dashed forms', () => {
    const r = redact('계좌번호: 110-123-456789 로 입금하세요. 기타 3333-01-1234567');
    assert.ok(!/110-123-456789|3333-01-1234567/.test(r.text));
    assert.match(r.text, /계좌번호: \[계좌번호\]/);
    assert.ok(r.counts.계좌번호 >= 2);
  });

  test('masks amounts in KRW notation', () => {
    const r = redact('대금 5,000,000원 및 위약금 300만원을 지급한다. 기간은 30일이다.');
    assert.equal(r.text, '대금 [금액] 및 위약금 [금액]을 지급한다. 기간은 30일이다.');
    assert.equal(r.counts.금액, 2);
  });

  test('masks user-provided names and escapes regex characters', () => {
    const r = redact('갑 홍길동(주)와 김.철 씨가 합의했다.', { names: ['홍길동(주)', '김.철', ''] });
    assert.equal(r.text, '갑 [이름]와 [이름] 씨가 합의했다.');
    assert.equal(r.counts.이름, 2);
  });

  test('options can turn categories off, and input is never mutated', () => {
    const src = '010-1234-5678 와 5,000원';
    const r = redact(src, { phone: false, amount: false });
    assert.equal(r.text, src);
    assert.equal(redact(null).text, '');
  });

  test('redaction runs in linear time on long digit strings', () => {
    const s = '1'.repeat(200000) + '-' + '0'.repeat(200000);
    const t0 = performance.now();
    redact(s, { names: ['a'] });
    assert.ok(performance.now() - t0 < 200);
  });

  test('escapeRegExp escapes metacharacters', () => {
    assert.equal(escapeRegExp('a.b*(c)'), 'a\\.b\\*\\(c\\)');
  });
});

describe('outputs', () => {
  const result = analyzeContract(SAMPLE_CONTRACT, 'freelance');

  test('negotiation email lists one item per rule and uses the placeholder names', () => {
    const mail = buildNegotiationEmail({ result, contractTitle: '홈페이지 용역' });
    assert.match(mail, /\[상대방 성함\] 님/);
    assert.match(mail, /홈페이지 용역/);
    const items = mail.split('\n').filter((l) => /^\d+\. /.test(l));
    assert.equal(items.length, new Set([...result.findings, ...result.absences].map((f) => f.ruleId)).size);
  });

  test('markdown report has disclaimer, score and findings', () => {
    const md = buildMarkdownReport({ title: 't', type: 'freelance', createdAt: new Date().toISOString(), result });
    assert.match(md, /법률 자문이 아닙니다/);
    assert.match(md, /위험 점수: \d+ \/ 100/);
    assert.match(md, /## 누락된 보호 조항 체크리스트/);
  });

  test('CSV neutralises spreadsheet formulas and escapes quotes', () => {
    const csv = buildFindingsCsv({
      findings: [{ severity: '높음', title: '=cmd', clauseNo: 1, matched: 'a"b', question: 'q', negotiation: 'n' }],
      absences: [],
    });
    assert.match(csv, /"'=cmd"/);
    assert.match(csv, /"a""b"/);
  });
});

describe('storage and backup', () => {
  const result = analyzeContract(SAMPLE_CONTRACT, 'freelance');

  test('review record drops text when keepText is false but keeps the summary', () => {
    const rec = makeReviewRecord({ title: 'x', type: 'freelance', text: SAMPLE_CONTRACT, keepText: false, result });
    assert.equal(rec.text, '');
    assert.equal(rec.findings.length, result.findings.length);
    const back = reviewToResult(rec);
    assert.equal(back.score, result.score);
    assert.equal(back.clauses.length, 0);
  });

  test('a saved review with text is re-analyzed on open', () => {
    const rec = makeReviewRecord({ title: 'x', type: 'freelance', text: SAMPLE_CONTRACT, keepText: true, result });
    const back = reviewToResult(rec);
    assert.equal(back.findings.length, result.findings.length);
    assert.equal(back.clauses.length, result.clauses.length);
  });

  test('backup round-trips and drops invalid entries', () => {
    const rec = makeReviewRecord({ title: 'x', type: 'bogus', text: SAMPLE_CONTRACT, keepText: true, result });
    const json = makeBackupJson([rec, { id: 5 }]);
    const parsed = parseBackup(json);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.reviews.length, 1);
    assert.equal(parsed.reviews[0].type, 'other');
    assert.equal(parsed.reviews[0].text, SAMPLE_CONTRACT);
    assert.equal(parsed.reviews[0].findings.length, rec.findings.length);
  });

  test('backup parser rejects foreign or broken files', () => {
    assert.equal(parseBackup('not json').ok, false);
    assert.equal(parseBackup('{"app":"other","reviews":[]}').ok, false);
    assert.equal(parseBackup('{"app":"clausecheck","reviews":"x"}').ok, false);
  });

  test('merge keeps the newer copy per id', () => {
    const a = { id: '1', createdAt: '2026-01-01T00:00:00.000Z', title: 'old' };
    const b = { id: '1', createdAt: '2026-01-01T00:00:00.000Z', title: 'new' };
    const c = { id: '2', createdAt: '2026-02-01T00:00:00.000Z', title: 'c' };
    const merged = mergeReviews([a], [b, c]);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].id, '2');
    assert.equal(merged[1].title, 'new');
  });
});

describe('ai helpers (no network)', () => {
  test('payload contains only the given redacted clause text and caps sizes', () => {
    const p = buildAiPayload([
      { title: '위약금', severity: '높음', why: '이유', clauseText: '위약금은 [금액]이다.' },
      { title: 'x'.repeat(200), severity: '중간', why: 'y'.repeat(900), clauseText: 'z'.repeat(5000) },
    ]);
    assert.equal(p.model, 'claude-haiku-5-5');
    assert.ok(p.max_tokens <= 700);
    assert.ok(p.userText.includes('위약금은 [금액]이다.'));
    assert.ok(!p.userText.includes('5,000,000'));
    assert.ok(p.userText.length < 4000);
    assert.equal(p.messages[0].content, p.userText);
  });

  test('payload limits the number of clauses', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, severity: '높음', why: 'w', clauseText: 'c' }));
    assert.equal(buildAiPayload(many).count, CONSTANTS.AI_MAX_CLAUSES);
  });

  test('parses a clean JSON array reply', () => {
    const r = parseAiReply('[{"no":1,"explanation":"설명입니다.","alternative":"대안 문구입니다."}]');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].explanation, '설명입니다.');
  });

  test('parses JSON wrapped in prose or code fences', () => {
    const r = parseAiReply('다음은 결과입니다.\n```json\n[{"no":2,"explanation":"a","alternative":"b"}]\n```');
    assert.equal(r.items[0].no, 2);
  });

  test('rejects malformed replies and falls back to capped plain text', () => {
    const r = parseAiReply('<script>alert(1)</script> 그냥 텍스트 ' + 'x'.repeat(5000));
    assert.equal(r.items.length, 0);
    assert.ok(r.fallbackText.length <= 1200);
  });

  test('ignores entries with wrong types', () => {
    const r = parseAiReply('[{"explanation": 5}, null, {"explanation":"ok"}]');
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].alternative, '');
  });

  test('key plausibility check', () => {
    assert.equal(isPlausibleKey('sk-ant-api03-abcdefghijklmnopqrstuvwxyz'), true);
    assert.equal(isPlausibleKey('sk-ant-short'), false);
    assert.equal(isPlausibleKey('sk-proj-abcdefghijklmnopqrstuvwxyz'), false);
    assert.equal(isPlausibleKey(''), false);
    assert.equal(isPlausibleKey(undefined), false);
  });

  test('local fallback uses the rule text', () => {
    const f = analyzeContract('갑은 언제든지 본 계약을 해지할 수 있다.', 'other').findings[0];
    const ex = localExplanation(f);
    assert.equal(ex.source, 'local');
    assert.equal(ex.explanation, ruleById(f.ruleId).why);
  });

  test('extracts only text blocks from a response body', () => {
    const t = extractReplyText({ content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] });
    assert.equal(t, 'a\nb');
    assert.equal(extractReplyText(null), '');
  });
});

describe('per-clause status', () => {
  const result = analyzeContract(SAMPLE_CONTRACT, 'freelance');
  const risk = result.findings[0];
  const absent = result.absences[0];

  test('keys are stable across re-analysis of the same text', () => {
    const again = analyzeContract(SAMPLE_CONTRACT, 'freelance');
    assert.equal(itemKey(again.findings[0]), itemKey(risk));
    assert.equal(itemKey(absent), itemKey(absent));
    assert.notEqual(itemKey(risk), itemKey(absent));
  });

  test('setStatus is immutable and unset value removes the key', () => {
    const base = {};
    const one = setStatus(base, risk, '협상 필요');
    assert.equal(statusOf(one, risk), '협상 필요');
    assert.equal(statusOf(base, risk), STATUS_UNSET);
    const cleared = setStatus(one, risk, '');
    assert.equal(statusOf(cleared, risk), STATUS_UNSET);
    assert.deepEqual(cleared, {});
  });

  test('only the three allowed statuses are accepted', () => {
    assert.equal(statusOf(setStatus({}, risk, 'hacked'), risk), STATUS_UNSET);
    assert.deepEqual(STATUSES, ['확인함', '협상 필요', '수용']);
  });

  test('sanitize drops invalid values and caps the count', () => {
    const many = {};
    for (let i = 0; i < 700; i++) many[`k${i}`] = '확인함';
    many.bad = 'nope';
    many.num = 3;
    const clean = sanitizeStatuses({ ...many });
    assert.ok(Object.keys(clean).length <= 500);
    assert.ok(!('bad' in clean) && !('num' in clean));
    assert.deepEqual(sanitizeStatuses(['x']), {});
    assert.deepEqual(sanitizeStatuses(null), {});
  });

  test('summary counts every finding and absence exactly once', () => {
    let st = setStatus({}, risk, '수용');
    st = setStatus(st, absent, '확인함');
    const s = summarizeStatuses(result, st);
    assert.equal(s.수용, 1);
    assert.equal(s.확인함, 1);
    const total = result.findings.length + result.absences.length;
    assert.equal(s.수용 + s.확인함 + s[STATUS_UNSET] + s['협상 필요'], total);
  });

  test('statuses survive a saved record and a backup round-trip', () => {
    const st = setStatus({}, risk, '협상 필요');
    const rec = makeReviewRecord({ title: 'x', type: 'freelance', text: '', keepText: false, result, statuses: st });
    assert.equal(statusOf(rec.statuses, rec.findings[0]), '협상 필요');
    const parsed = parseBackup(makeBackupJson([rec]));
    assert.equal(parsed.reviews[0].statuses[itemKey(rec.findings[0])], '협상 필요');
    const bad = parseBackup(JSON.stringify({ app: 'clausecheck', reviews: [{ ...rec, statuses: { x: 'bogus' } }] }));
    assert.deepEqual(bad.reviews[0].statuses, {});
  });

  test('records written before statuses existed still load', () => {
    const old = makeReviewRecord({ title: 'x', type: 'freelance', text: '', keepText: false, result });
    delete old.statuses;
    const parsed = parseBackup(JSON.stringify({ app: 'clausecheck', reviews: [old] }));
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.reviews[0].statuses, {});
  });

  test('legalRef is kept in saved records', () => {
    const rec = makeReviewRecord({ title: 'x', type: 'freelance', text: '', keepText: false, result });
    const flagged = result.findings.find((f) => f.ruleId === 'payment-over-60') || result.absences.find((a) => a.legalRef);
    if (flagged) assert.equal(rec.findings.concat(rec.absences).find((x) => x.ruleId === flagged.ruleId).legalRef, true);
  });
});

describe('version comparison', () => {
  const base = '제1조 (목적)\n갑은 을에게 업무를 맡긴다.';
  const addTerm = '\n\n제2조 (해지)\n갑은 언제든지 본 계약을 해지할 수 있다.';

  test('identical texts show no added or removed risk and no score change', () => {
    const c = compareContracts(SAMPLE_CONTRACT, SAMPLE_CONTRACT, 'freelance');
    assert.equal(c.scoreDelta, 0);
    assert.deepEqual(c.added, []);
    assert.deepEqual(c.removed, []);
    assert.deepEqual(c.changed, []);
    assert.deepEqual(c.newlyMissing, []);
    assert.deepEqual(c.resolved, []);
  });

  test('a clause added in the new version is reported as added risk and resolves a missing protection', () => {
    const c = compareContracts(base, base + addTerm, 'other');
    assert.ok(c.added.some((x) => x.ruleId === 'unilateral-termination'));
    assert.ok(c.rawDelta > 0);
    assert.ok(c.resolved.some((x) => x.ruleId === 'absent-termination'));
    const hit = c.added.find((x) => x.ruleId === 'unilateral-termination');
    assert.equal(hit.count, 1);
    assert.match(hit.samples[0].matched, /언제든지/);
  });

  test('removing a risky clause reports it as removed and a newly missing protection', () => {
    const c = compareContracts(base + addTerm, base, 'other');
    assert.ok(c.removed.some((x) => x.ruleId === 'unilateral-termination'));
    assert.ok(c.newlyMissing.some((x) => x.ruleId === 'absent-termination'));
    assert.ok(c.rawDelta < 0);
  });

  test('a rule whose hit count changes is reported as changed, not added', () => {
    const one = base + addTerm;
    const two = one + '\n\n제3조 (추가)\n갑은 언제든지 계약을 해지할 수 있다.';
    const c = compareContracts(one, two, 'other');
    assert.deepEqual(c.added.map((x) => x.ruleId).filter((id) => id === 'unilateral-termination'), []);
    const ch = c.changed.find((x) => x.ruleId === 'unilateral-termination');
    assert.ok(ch);
    assert.equal(ch.before, 1);
    assert.equal(ch.after, 2);
  });

  test('empty inputs compare without throwing', () => {
    const c = compareContracts('', '', 'other');
    assert.equal(c.scoreDelta, 0);
    assert.equal(c.truncated, false);
  });
});

describe('negotiation email options', () => {
  const result = analyzeContract(SAMPLE_CONTRACT, 'freelance');

  test('deadline, extra note and sender/receiver names are placed in the draft', () => {
    const mail = buildNegotiationEmail({
      result, receiverName: '김OO', senderName: '이OO', contractTitle: '홈페이지 용역',
      deadline: '2026년 11월 20일', extraNote: '첫 제안이므로 전화 협의도 환영합니다.',
    });
    assert.match(mail, /^김OO 님/);
    assert.match(mail, /회신 희망일: 2026년 11월 20일/);
    assert.match(mail, /전화 협의도 환영합니다/);
    assert.ok(mail.trimEnd().endsWith('이OO'));
  });

  test('questions are included only when asked for, and item count is unchanged', () => {
    const plain = buildNegotiationEmail({ result });
    const withQ = buildNegotiationEmail({ result, includeQuestions: true });
    assert.ok(!plain.includes('확인하고 싶은 점'));
    assert.ok(withQ.includes('확인하고 싶은 점'));
    const count = (m) => m.split('\n').filter((l) => /^\d+\. /.test(l)).length;
    assert.equal(count(plain), count(withQ));
  });

  test('legal-reference items are marked 확인 필요 in the draft', () => {
    const mail = buildNegotiationEmail({ result: analyzeContract('대금은 발행일로부터 90일 이내에 지급한다.', 'freelance') });
    assert.match(mail, /\[확인 필요\]/);
  });

  test('extra input is trimmed and newlines in names are flattened', () => {
    const mail = buildNegotiationEmail({ result, receiverName: '홍\n길동', extraNote: 'x'.repeat(2000) });
    assert.match(mail, /^홍 길동 님/);
    assert.ok(mail.length < 3000);
  });
});

describe('printable report model and markdown', () => {
  const result = analyzeContract(SAMPLE_CONTRACT, 'freelance');
  const review = { title: '테스트', type: 'freelance', createdAt: '2026-11-07T01:02:03.000Z', result };

  test('model carries disclaimer, as-of note, score and statuses', () => {
    const st = setStatus({}, result.findings[0], '수용');
    const m = buildReportModel(review, st);
    assert.equal(m.disclaimer, DISCLAIMER);
    assert.match(m.asOf, /2026년 11월/);
    assert.match(m.legalNote, /확인 필요/);
    assert.equal(m.date, '2026-11-07');
    assert.equal(m.findings[0].status, '수용');
    assert.equal(m.statusSummary.수용, 1);
    assert.equal(m.findings.length, result.findings.length);
  });

  test('markdown shows status and 확인 필요 labels', () => {
    const st = setStatus({}, result.findings[0], '협상 필요');
    const md = buildMarkdownReport(review, st);
    assert.match(md, /- 상태: 협상 필요/);
    assert.match(md, /확인 필요/);
    assert.match(md, /확인 상태: 협상 필요 1/);
  });

  test('csv includes status and 확인 필요 columns', () => {
    const csv = buildFindingsCsv(result, setStatus({}, result.findings[0], '확인함'));
    assert.match(csv.split('\r\n')[0], /상태/);
    assert.match(csv, /"확인함"/);
  });
});
