// 화면 제어. 사용자 데이터는 모두 textContent 로만 넣습니다 (innerHTML 사용 안 함).
import {
  analyzeContract, redact, buildNegotiationEmail, buildMarkdownReport, buildFindingsCsv,
  makeReviewRecord, reviewToResult, parseBackup, makeBackupJson, mergeReviews,
  CONTRACT_TYPES, SAMPLE_CONTRACT, CONSTANTS, typeLabel,
} from './logic.js';
import { buildAiPayload, parseAiReply, isPlausibleKey, localExplanation, extractReplyText } from './ai.js';

const $ = (id) => document.getElementById(id);
const SEV_RANK = { 높음: 0, 중간: 1, 참고: 2 };
const API_URL = 'https://api.anthropic.com/v1/messages';
const THEME_KEY = 'clausecheck-theme';
const MAX_SAVED = 100;

const state = {
  review: null,      // { id, title, type, text, result, createdAt }
  anchors: new Map(), // finding id -> <mark> element
  reviews: [],       // 저장 기록
  negoRules: new Map(), // ruleId -> item (협상 이메일 항목)
  aiChoices: new Map(), // finding id -> finding (AI 설명 후보)
};

// ───────────── 작은 도우미 ─────────────
function safeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function safeSet(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } }
function safeRemove(key) { try { localStorage.removeItem(key); } catch { /* 저장 불가 환경 */ } }

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'checked') node.checked = !!value;
    else if (key === 'disabled') node.disabled = !!value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

const sevClass = (sev) => `sev-${sev}`;
const badge = (sev) => el('span', { class: `sev-badge ${sevClass(sev)}`, text: sev });
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function setMsg(id, text, isError = false) {
  const node = $(id);
  node.textContent = text;
  node.style.color = isError ? 'var(--sev-high-ink)' : '';
}

let toastTimer = null;
function toast(text) {
  const node = $('toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 2600);
}

function todayStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function download(name, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = el('a', { href: url, download: name, class: 'visually-hidden', tabindex: -1 });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 아래 대체 방법 */ }
  const ta = el('textarea', { 'aria-hidden': 'true' });
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function maskOptions() {
  const names = $('mask-names').value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  return {
    rrn: $('mask-rrn').checked,
    phone: $('mask-phone').checked,
    email: $('mask-email').checked,
    account: $('mask-account').checked,
    amount: $('mask-amount').checked,
    names,
  };
}

// AI 로 보내는 텍스트는 가리기 설정과 무관하게 항상 전부 가립니다.
function aiMaskOptions() {
  return { ...maskOptions(), rrn: true, phone: true, email: true, account: true, amount: true };
}

// ───────────── 저장소 ─────────────
function loadReviews() {
  const raw = safeGet(CONSTANTS.STORAGE_KEY);
  if (!raw) return [];
  const parsed = parseBackup(JSON.stringify({ app: 'clausecheck', reviews: JSON.parse(raw) }));
  return parsed.ok ? parsed.reviews : [];
}

function persistReviews() {
  const ok = safeSet(CONSTANTS.STORAGE_KEY, JSON.stringify(state.reviews));
  if (!ok) toast('브라우저 저장 공간이 부족하거나 저장이 꺼져 있습니다.');
  return ok;
}

// ───────────── 초기화 ─────────────
function init() {
  const typeSelect = $('contract-type');
  for (const t of CONTRACT_TYPES) typeSelect.append(el('option', { value: t.key, text: t.label }));
  typeSelect.value = 'freelance';

  applySavedTheme();
  state.reviews = loadReviews();
  if (safeGet(CONSTANTS.AI_KEY_STORAGE)) {
    $('ai-forget').hidden = false;
    setMsg('ai-msg', '이 브라우저에 저장된 API 키를 사용합니다.');
  }

  bindEvents();
  renderHistory();
  updateCount();
  updateAiPreview();
}

function applySavedTheme() {
  const saved = safeGet(THEME_KEY);
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
}

function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === 'light' || set === 'dark') return set;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function bindEvents() {
  $('theme-toggle').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    safeSet(THEME_KEY, next);
  });

  $('contract-text').addEventListener('input', updateCount);
  $('sample-btn').addEventListener('click', () => {
    $('contract-text').value = SAMPLE_CONTRACT;
    $('contract-type').value = 'freelance';
    if (!$('review-title').value.trim()) $('review-title').value = '샘플 계약 (홈페이지 용역)';
    updateCount();
    setMsg('input-msg', '샘플을 넣었습니다. 점검 실행을 누르세요.');
  });
  $('clear-btn').addEventListener('click', () => {
    $('contract-text').value = '';
    updateCount();
    setMsg('input-msg', '');
    $('contract-text').focus();
  });
  $('file-input').addEventListener('change', onFileChosen);

  $('input-form').addEventListener('submit', (e) => { e.preventDefault(); runCheck(); });

  // 탭
  const tabs = [$('tab-check'), $('tab-history')];
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => showTab(i === 0 ? 'check' : 'history'));
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const next = tabs[(i + 1) % 2];
        next.focus();
        showTab(next === tabs[0] ? 'check' : 'history');
      }
    });
  });

  // 결과 액션
  $('save-btn').addEventListener('click', saveCurrent);
  $('md-btn').addEventListener('click', () => {
    if (!state.review) return;
    const md = buildMarkdownReport(reportInput());
    download(`clausecheck-${todayStamp()}.md`, md, 'text/markdown;charset=utf-8');
  });
  $('csv-btn').addEventListener('click', () => {
    if (!state.review) return;
    download(`clausecheck-${todayStamp()}.csv`, buildFindingsCsv(state.review.result), 'text/csv;charset=utf-8');
  });
  $('print-btn').addEventListener('click', () => {
    if (!state.review) return;
    $('print-pre').textContent = buildMarkdownReport(reportInput());
    window.print();
  });
  $('mask-btn').addEventListener('click', showMaskPreview);
  $('copy-masked').addEventListener('click', async () => {
    const text = $('mask-preview').textContent;
    setMsg('mask-msg', (await copyText(text)) ? '가린 텍스트를 복사했습니다.' : '복사하지 못했습니다. 텍스트를 직접 선택해 복사하세요.');
  });

  // 발견 목록 (사이드바)
  $('finding-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-fid]');
    if (btn) jumpTo(btn.dataset.fid);
  });

  // 체크리스트 / 협상 / AI 선택 변경
  $('make-email').addEventListener('click', makeEmail);
  $('copy-email').addEventListener('click', async () => {
    setMsg('email-msg', (await copyText($('email-out').value)) ? '초안을 복사했습니다.' : '복사하지 못했습니다. 텍스트를 직접 선택하세요.');
  });
  $('ai-items').addEventListener('change', updateAiPreview);
  $('ai-run').addEventListener('click', runAi);
  $('ai-local').addEventListener('click', () => {
    const picked = selectedAiFindings();
    if (!picked.length) { setMsg('ai-msg', '설명받을 조항을 먼저 선택하세요.', true); return; }
    showLocalAi(buildAiItems(picked), '키 없이 규칙에 적힌 기본 설명을 보여 줍니다.');
  });
  $('ai-forget').addEventListener('click', () => {
    safeRemove(CONSTANTS.AI_KEY_STORAGE);
    $('ai-key').value = '';
    $('ai-key-save').checked = false;
    $('ai-forget').hidden = true;
    setMsg('ai-msg', '저장된 키를 지웠습니다.');
  });

  // 이력
  $('history-list').addEventListener('click', onHistoryClick);
  $('export-json').addEventListener('click', () => {
    download(`clausecheck-backup-${todayStamp()}.json`, makeBackupJson(state.reviews), 'application/json;charset=utf-8');
    setMsg('history-msg', `${state.reviews.length}건을 백업 파일로 받았습니다.`);
  });
  $('import-json').addEventListener('change', onImportChosen);
}

function showTab(name) {
  const isCheck = name === 'check';
  $('tab-check').setAttribute('aria-selected', String(isCheck));
  $('tab-history').setAttribute('aria-selected', String(!isCheck));
  $('tab-check').tabIndex = isCheck ? 0 : -1;
  $('tab-history').tabIndex = isCheck ? -1 : 0;
  $('panel-check').hidden = !isCheck;
  $('panel-history').hidden = isCheck;
  if (!isCheck) renderHistory();
}

function updateCount() {
  const n = $('contract-text').value.length;
  const over = n > CONSTANTS.MAX_INPUT_CHARS;
  $('text-count').textContent = `${n.toLocaleString('ko-KR')}자 / 최대 ${CONSTANTS.MAX_INPUT_CHARS.toLocaleString('ko-KR')}자${over ? ' (앞부분만 분석)' : ''}`;
}

async function onFileChosen(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const isTxt = /\.txt$/i.test(file.name) || file.type === 'text/plain';
  if (!isTxt) { setMsg('input-msg', '.txt 파일만 읽을 수 있습니다. PDF·워드는 내용을 복사해 붙여넣어 주세요.', true); return; }
  if (file.size > CONSTANTS.MAX_FILE_BYTES) { setMsg('input-msg', `파일이 너무 큽니다. ${Math.round(CONSTANTS.MAX_FILE_BYTES / 1024)}KB 이하 파일을 사용하세요.`, true); return; }
  let text;
  try {
    text = await file.text();
  } catch {
    setMsg('input-msg', '파일을 읽지 못했습니다. 다시 시도하거나 내용을 붙여넣어 주세요.', true);
    return;
  }
  $('contract-text').value = text;
  if (!$('review-title').value.trim()) $('review-title').value = file.name.replace(/\.txt$/i, '').slice(0, 80);
  updateCount();
  setMsg('input-msg', text.includes('�')
    ? '일부 글자가 깨졌을 수 있습니다. UTF-8 인코딩으로 저장한 파일을 사용해 주세요.'
    : '파일을 불러왔습니다. 계약 유형을 확인하고 점검 실행을 누르세요.');
}

// ───────────── 점검 실행 / 결과 ─────────────
function defaultTitle(type) {
  return `${typeLabel(type)} ${formatDate(new Date().toISOString())}`;
}

function runCheck() {
  const text = $('contract-text').value;
  if (!text.trim()) {
    setMsg('input-msg', '계약서 텍스트를 붙여넣거나 .txt 파일을 불러와 주세요.', true);
    $('contract-text').focus();
    return;
  }
  const type = $('contract-type').value;
  const title = $('review-title').value.trim().slice(0, 80) || defaultTitle(type);
  const result = analyzeContract(text, type);
  state.review = { id: null, title, type, text, result, createdAt: new Date().toISOString() };
  setMsg('input-msg', '');
  renderResult();
  const box = $('result');
  box.hidden = false;
  box.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  $('result-title').focus({ preventScroll: true });
}

function reportInput() {
  return { title: state.review.title, type: state.review.type, createdAt: state.review.createdAt, result: state.review.result };
}

function renderResult() {
  const rv = state.review;
  const r = rv.result;
  $('result-title').textContent = rv.title;
  const meta = [typeLabel(rv.type), formatDate(rv.createdAt), rv.id ? '저장됨' : '저장 전'].filter(Boolean).join(' · ');
  $('result-meta').textContent = meta;

  $('score-num').textContent = String(r.score);
  $('grade').textContent = r.grade;
  $('save-btn').disabled = !!rv.id;
  $('save-btn').textContent = rv.id ? '저장됨' : '이 기록 저장';

  const chips = $('chips');
  chips.textContent = '';
  for (const sev of ['높음', '중간', '참고']) {
    chips.append(el('li', { class: `chip ${sevClass(sev)}`, text: `${sev} ${r.counts[sev]}` }));
  }
  chips.append(el('li', { class: 'chip sev-참고', text: `누락 ${r.counts.누락}` }));

  const trunc = $('truncate-note');
  trunc.hidden = !r.truncated;
  trunc.textContent = r.truncated ? `원문이 ${CONSTANTS.MAX_INPUT_CHARS.toLocaleString('ko-KR')}자를 넘어 앞부분만 분석했습니다.` : '';

  renderFindingList(r);
  renderContract(r);
  renderChecklist(r);
  renderNegotiation(r);
  renderAiChoices(r);
  $('email-out').value = '';
  $('copy-email').disabled = true;
  setMsg('email-msg', '');
  $('mask-block').hidden = true;
  setMsg('ai-msg', safeGet(CONSTANTS.AI_KEY_STORAGE) ? '이 브라우저에 저장된 API 키를 사용합니다.' : '');
  updateAiPreview();
}

function renderFindingList(r) {
  const list = $('finding-list');
  list.textContent = '';
  if (!r.findings.length) {
    list.append(el('li', { class: 'finding-empty', text: '위험 문구로 찾은 항목이 없습니다. 아래 누락 체크리스트도 확인하세요.' }));
    return;
  }
  for (const f of r.findings) {
    const hasText = r.clauses.length > 0;
    const btn = el('button', {
      type: 'button', class: 'finding-item', 'data-fid': f.id, disabled: !hasText,
    },
      el('span', { class: 'fi-row' }, badge(f.severity), ' ', el('span', { class: 'fi-title', text: f.title })),
      el('span', { class: 'fi-where', text: `조항 ${f.clauseNo ?? '-'} 부근` }),
      el('span', { class: 'fi-matched', text: `“${f.matched}”` }));
    list.append(el('li', {}, btn));
  }
}

function renderContract(r) {
  const view = $('contract-view');
  view.textContent = '';
  state.anchors = new Map();
  if (!r.clauses.length) {
    view.append(el('p', { class: 'fine', text: '원문을 저장하지 않아 조항 본문은 표시하지 않습니다. 발견 목록과 체크리스트를 확인하세요.' }));
    return;
  }
  for (const c of r.clauses) {
    const p = el('p', { class: 'clause', id: `clause-${c.no}` });
    p.append(el('span', { class: 'clause-no', 'aria-hidden': 'true', text: String(c.no) }));
    const cf = r.findings.filter((f) => f.clauseNo === c.no && f.start < c.end && f.end > c.start);
    const rel = (x) => Math.min(Math.max(x - c.start, 0), c.text.length);
    const bounds = new Set([0, c.text.length]);
    for (const f of cf) { bounds.add(rel(f.start)); bounds.add(rel(f.end)); }
    const pts = [...bounds].sort((a, b) => a - b);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (a === b) continue;
      const seg = c.text.slice(a, b);
      const covering = cf
        .filter((f) => rel(f.start) <= a && rel(f.end) >= b)
        .sort((x, y) => SEV_RANK[x.severity] - SEV_RANK[y.severity]);
      if (!covering.length) {
        p.append(document.createTextNode(seg));
        continue;
      }
      const mark = el('mark', {
        class: `hl ${sevClass(covering[0].severity)}`,
        text: seg,
        'data-findings': covering.map((f) => f.id).join(' '),
        title: covering.map((f) => `${f.severity}: ${f.title}`).join(' / '),
        tabindex: -1,
      });
      for (const f of covering) {
        if (rel(f.start) === a && !state.anchors.has(f.id)) state.anchors.set(f.id, mark);
      }
      p.append(mark);
    }
    view.append(p);
  }
}

function jumpTo(fid) {
  const mark = state.anchors.get(fid);
  document.querySelectorAll('.finding-item[aria-current]').forEach((b) => b.removeAttribute('aria-current'));
  const btn = document.querySelector(`.finding-item[data-fid="${CSS.escape(fid)}"]`);
  if (btn) btn.setAttribute('aria-current', 'true');
  if (!mark) { toast('원문 위치를 찾을 수 없습니다.'); return; }
  const clause = mark.closest('.clause');
  mark.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
  document.querySelectorAll('mark.hl.active').forEach((m) => m.classList.remove('active'));
  mark.classList.add('active');
  if (clause) {
    clause.classList.remove('flash');
    void clause.offsetWidth;
    clause.classList.add('flash');
  }
  mark.focus({ preventScroll: true });
  setTimeout(() => mark.classList.remove('active'), 2400);
}

function renderChecklist(r) {
  const ul = $('checklist');
  ul.textContent = '';
  if (!r.absences.length) {
    ul.append(el('li', {}, el('span', { class: 'ck-box', 'aria-hidden': 'true', text: '✓' }), el('span', { class: 'ck-title', text: '확인한 보호 조항 문구가 모두 있습니다.' })));
    return;
  }
  for (const a of r.absences) {
    ul.append(el('li', {},
      el('span', { class: 'ck-box', 'aria-hidden': 'true', text: '□' }),
      el('div', {}, el('span', { class: 'ck-title' }, badge(a.severity), ' ', a.title)),
      el('p', { class: 'ck-why', text: a.why }),
      el('p', { class: 'ck-why', text: `확인 질문: ${a.question}` })));
  }
}

function uniqueRuleItems(r) {
  const seen = new Map();
  for (const f of r.findings) if (!seen.has(f.ruleId)) seen.set(f.ruleId, f);
  for (const a of r.absences) if (!seen.has(a.ruleId)) seen.set(a.ruleId, a);
  return seen;
}

function renderNegotiation(r) {
  const box = $('nego-list');
  box.textContent = '';
  state.negoRules = uniqueRuleItems(r);
  for (const [ruleId, item] of state.negoRules) {
    box.append(el('label', {},
      el('input', { type: 'checkbox', value: ruleId, checked: true }),
      el('span', {}, `[${item.severity}] ${item.title}`)));
  }
  if (!state.negoRules.size) box.append(el('p', { class: 'fine', text: '이메일에 넣을 항목이 없습니다.' }));
}

function makeEmail() {
  if (!state.review) return;
  const checked = new Set([...$('nego-list').querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value));
  const r = state.review.result;
  const findings = r.findings.filter((f) => checked.has(f.ruleId));
  const absences = r.absences.filter((a) => checked.has(a.ruleId));
  const mail = buildNegotiationEmail({
    result: { findings, absences },
    senderName: $('sender-name').value.trim() || '[본인 성함]',
    receiverName: $('receiver-name').value.trim() || '[상대방 성함]',
    contractTitle: state.review.title,
  });
  $('email-out').value = mail;
  $('copy-email').disabled = false;
  setMsg('email-msg', '초안을 만들었습니다. 내용을 확인한 뒤 보내세요.');
}

function showMaskPreview() {
  if (!state.review || !state.review.text) {
    toast('원문이 없는 기록은 가린 미리보기를 만들 수 없습니다.');
    return;
  }
  const { text, counts } = redact(state.review.text, maskOptions());
  $('mask-preview').textContent = text;
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}건`);
  $('mask-counts').textContent = parts.length ? `가린 항목: ${parts.join(', ')}` : '가린 항목이 없습니다. 원문에 해당 정보가 없거나 가리기 설정이 꺼져 있습니다.';
  $('mask-block').hidden = false;
  $('mask-block').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'nearest' });
  setMsg('mask-msg', '');
}

// ───────────── 저장 / 이력 ─────────────
function saveCurrent() {
  if (!state.review || state.review.id) return;
  const rv = state.review;
  const rec = makeReviewRecord({
    title: rv.title, type: rv.type, text: rv.text, keepText: $('keep-text').checked, result: rv.result,
  });
  const before = state.reviews;
  state.reviews = [rec, ...before].slice(0, MAX_SAVED);
  if (!persistReviews()) { state.reviews = before; return; }
  rv.id = rec.id;
  renderResult();
  toast('이 브라우저에 저장했습니다.');
}

function renderHistory() {
  const list = $('history-list');
  list.textContent = '';
  $('history-empty').hidden = state.reviews.length > 0;
  for (const rec of state.reviews) {
    list.append(el('li', {},
      el('div', {},
        el('p', { class: 'hi-title', text: rec.title || '(제목 없음)' }),
        el('p', { class: 'hi-meta', text: `${typeLabel(rec.type)} · ${formatDate(rec.createdAt)} · 점수 ${rec.score} (${rec.grade})${rec.text ? '' : ' · 원문 미저장'}` })),
      el('div', { class: 'hi-actions' },
        el('button', { type: 'button', class: 'btn ghost small', 'data-action': 'open', 'data-id': rec.id, text: '열기' }),
        el('button', { type: 'button', class: 'btn ghost small', 'data-action': 'delete', 'data-id': rec.id, text: '삭제' }))));
  }
}

function onHistoryClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const rec = state.reviews.find((r) => r.id === btn.dataset.id);
  if (!rec) return;
  if (btn.dataset.action === 'open') {
    state.review = {
      id: rec.id, title: rec.title, type: rec.type, text: rec.text,
      result: reviewToResult(rec), createdAt: rec.createdAt,
    };
    $('contract-type').value = rec.type;
    $('review-title').value = rec.title;
    $('contract-text').value = rec.text || '';
    updateCount();
    renderResult();
    showTab('check');
    $('result').hidden = false;
    $('result').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  } else if (btn.dataset.action === 'delete') {
    if (!window.confirm('이 저장 기록을 삭제할까요? 되돌릴 수 없습니다.')) return;
    state.reviews = state.reviews.filter((r) => r.id !== rec.id);
    persistReviews();
    if (state.review && state.review.id === rec.id) {
      state.review.id = null;
      if ($('result').hidden === false) renderResult();
    }
    renderHistory();
    setMsg('history-msg', '기록을 삭제했습니다.');
  }
}

async function onImportChosen(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { setMsg('history-msg', '백업 파일이 5MB를 넘습니다.', true); return; }
  let text;
  try { text = await file.text(); } catch { setMsg('history-msg', '파일을 읽지 못했습니다.', true); return; }
  const parsed = parseBackup(text);
  if (!parsed.ok) { setMsg('history-msg', parsed.error, true); return; }
  const merged = mergeReviews(state.reviews, parsed.reviews).slice(0, 300);
  const before = state.reviews;
  state.reviews = merged;
  if (!persistReviews()) { state.reviews = before; return; }
  renderHistory();
  setMsg('history-msg', `${parsed.reviews.length}건을 확인해 합쳤습니다. 저장된 기록은 총 ${merged.length}건입니다.`);
}

// ───────────── AI 설명 패널 ─────────────
function selectedAiFindings() {
  const ids = [...$('ai-items').querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value);
  return ids.map((id) => state.aiChoices.get(id)).filter(Boolean).slice(0, CONSTANTS.AI_MAX_CLAUSES);
}

// 같은 조항은 한 번만 보냅니다. 가리기를 적용한 조항 텍스트만 사용합니다.
function buildAiItems(findings) {
  const seen = new Set();
  const items = [];
  for (const f of findings) {
    if (seen.has(f.clauseNo)) continue;
    seen.add(f.clauseNo);
    const clause = state.review.result.clauses.find((c) => c.no === f.clauseNo);
    const clauseText = clause ? redact(clause.text, aiMaskOptions()).text : '';
    items.push({ finding: f, clauseNo: f.clauseNo, title: f.title, severity: f.severity, why: f.why, clauseText });
  }
  return items;
}

function renderAiChoices(r) {
  const box = $('ai-items');
  box.textContent = '';
  state.aiChoices = new Map();
  const risks = r.findings;
  const hasClauses = r.clauses.length > 0;
  if (!risks.length || !hasClauses) {
    box.append(el('p', { class: 'fine', text: hasClauses ? '설명할 위험 조항이 없습니다.' : '원문이 없는 기록은 AI 설명을 쓸 수 없습니다.' }));
    $('ai-run').disabled = true;
    $('ai-local').disabled = true;
    return;
  }
  $('ai-run').disabled = false;
  $('ai-local').disabled = false;
  let preChecked = 0;
  for (const f of risks.slice(0, 40)) {
    state.aiChoices.set(f.id, f);
    const checked = f.severity === '높음' && preChecked < 3;
    if (checked) preChecked++;
    box.append(el('label', {},
      el('input', { type: 'checkbox', value: f.id, checked }),
      el('span', {}, `[${f.severity}] ${f.title} (조항 ${f.clauseNo})`)));
  }
}

function updateAiPreview() {
  const preview = $('ai-preview');
  if (!state.review || !state.review.result.clauses.length) {
    preview.textContent = '';
    return;
  }
  const picked = selectedAiFindings();
  if (!picked.length) {
    preview.textContent = '선택한 조항이 없습니다. 조항을 고르면 전송될 내용이 여기에 표시됩니다.';
    return;
  }
  const items = buildAiItems(picked);
  const payload = buildAiPayload(items.map((it) => ({ title: it.title, severity: it.severity, why: it.why, clauseText: it.clauseText })));
  preview.textContent = `[전송 대상 모델] ${payload.model}\n[고정 지시문] 계약 조항을 쉽게 설명하고 부드러운 대체 문구를 JSON으로 답하도록 요청합니다.\n\n${payload.userText}`;
}

function renderAiOutput(items, parsed) {
  const out = $('ai-out');
  out.textContent = '';
  if (!parsed) {
    showLocalAiInto(items);
    return;
  }
  if (!parsed.items.length && parsed.fallbackText) {
    out.append(el('li', {},
      el('p', { class: 'ai-label', text: 'AI 응답 (형식이 맞지 않아 원문 일부를 보여 줍니다)' }),
      el('p', { text: parsed.fallbackText })));
  }
  items.forEach((it, i) => {
    const got = parsed.items.find((p) => p.no === i + 1);
    if (got) {
      out.append(aiItemNode('AI 설명', got.explanation, '더 부드러운 표현 제안', got.alternative, it));
    } else {
      const local = localExplanation(it.finding);
      out.append(aiItemNode('기본 설명 (규칙 내장)', local.explanation, '협상 제안 문구', local.alternative, it));
    }
  });
}

function aiItemNode(label1, text1, label2, text2, it) {
  return el('li', {},
    el('p', { class: 'ai-label', text: `[${it.severity}] ${it.title} · 조항 ${it.clauseNo}` }),
    el('p', { class: 'ai-label', text: label1 }),
    el('p', { text: text1 || '(내용 없음)' }),
    el('p', { class: 'ai-label', text: label2 }),
    el('p', { text: text2 || '(내용 없음)' }));
}

function showLocalAi(items, note) {
  setMsg('ai-msg', note);
  showLocalAiInto(items);
}

function showLocalAiInto(items) {
  const out = $('ai-out');
  out.textContent = '';
  for (const it of items) {
    const local = localExplanation(it.finding);
    out.append(aiItemNode('기본 설명 (규칙 내장, AI 미사용)', local.explanation, '협상 제안 문구', local.alternative, it));
  }
}

function setAiBusy(busy) {
  $('ai-run').disabled = busy;
  $('ai-run').textContent = busy ? '요청 중…' : '선택한 조항 설명 받기';
}

async function runAi() {
  if (!state.review) return;
  const picked = selectedAiFindings();
  if (!picked.length) { setMsg('ai-msg', '설명받을 조항을 하나 이상 선택하세요.', true); return; }
  const items = buildAiItems(picked);
  const payload = buildAiPayload(items.map((it) => ({ title: it.title, severity: it.severity, why: it.why, clauseText: it.clauseText })));

  const typed = $('ai-key').value.trim();
  const saved = safeGet(CONSTANTS.AI_KEY_STORAGE) || '';
  const key = typed || saved;
  if (typed && $('ai-key-save').checked) {
    if (isPlausibleKey(typed) && safeSet(CONSTANTS.AI_KEY_STORAGE, typed)) $('ai-forget').hidden = false;
  }
  if (!key) { showLocalAi(items, 'API 키가 없어 규칙에 적힌 기본 설명을 보여 줍니다.'); return; }
  if (!isPlausibleKey(key)) { setMsg('ai-msg', '키 형식이 맞지 않습니다. sk-ant- 로 시작하는 키를 확인하세요.', true); return; }

  setAiBusy(true);
  setMsg('ai-msg', '선택한 조항만 보내는 중입니다…');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: payload.model, max_tokens: payload.max_tokens, system: payload.system, messages: payload.messages }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const why = res.status === 401 ? '키가 올바르지 않습니다.'
        : res.status === 429 ? '요청이 많아 잠시 제한되었습니다.'
          : `요청이 실패했습니다 (${res.status}).`;
      throw new Error(why);
    }
    const body = await res.json();
    const parsed = parseAiReply(extractReplyText(body));
    setMsg('ai-msg', 'AI 설명을 받았습니다. 내용은 참고용입니다.');
    renderAiOutput(items, parsed);
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? '응답 시간이 초과되었습니다.' : (err && err.message) || '알 수 없는 오류';
    showLocalAi(items, `${reason} 기본 설명을 대신 보여 줍니다.`);
  } finally {
    clearTimeout(timer);
    setAiBusy(false);
  }
}

// ───────────── 시작 ─────────────
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}

