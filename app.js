// 화면 제어. 사용자 데이터는 모두 textContent 로만 넣습니다 (innerHTML 사용 안 함).
import {
  analyzeContract, redact, buildNegotiationEmail, buildMarkdownReport, buildFindingsCsv,
  makeReviewRecord, reviewToResult, parseBackup, makeBackupJson, mergeReviews,
  compareContracts, buildReportModel, itemKey, statusOf, setStatus, summarizeStatuses,
  STATUSES, STATUS_UNSET, STATUS_FILTERS, filterByStatus, CONTRACT_TYPES, SAMPLE_CONTRACT, CONSTANTS, typeLabel, DISCLAIMER,
} from './logic.js';
import { buildAiPayload, parseAiReply, isPlausibleKey, localExplanation, extractReplyText } from './ai.js';

const $ = (id) => document.getElementById(id);
const SEV_RANK = { 높음: 0, 중간: 1, 참고: 2 };
const API_URL = 'https://api.anthropic.com/v1/messages';
const THEME_KEY = 'clausecheck-theme';
const MAX_SAVED = 100;
const TABS = ['check', 'compare', 'history'];
// 비교 데모용 두 번째 버전: 샘플에서 해지 조항을 고치고, 지급 기한을 줄이고, 자동 갱신 조항을 더합니다.
const SAMPLE_V2 = SAMPLE_CONTRACT
  .replace('갑은 언제든지 본 계약을 해지할 수 있다.', '갑과 을은 서면 합의로만 본 계약을 해지할 수 있다.')
  .replace('90일 이내에 지급할 수 있다.', '30일 이내에 지급할 수 있다.')
  + '\n제11조 (자동 갱신)\n본 계약은 기간 만료 후 자동 갱신되며, 갱신된 계약을 해지하면 위약금을 부담한다.\n';

const state = {
  review: null,          // { id, title, type, text, result, createdAt, statuses }
  anchors: new Map(),    // finding id -> <mark> element
  marks: [],             // 원문의 <mark> 목록 (수용 표시 갱신용)
  findingById: new Map(),
  itemMap: new Map(),    // itemKey -> 항목 (상태 선택 변경 시 찾기용)
  reviews: [],           // 저장 기록
  negoRules: new Map(),  // ruleId -> item (협상 이메일 항목)
  aiChoices: new Map(),  // finding id -> finding (AI 설명 후보)
  findingFilter: '전체', // 발견 목록의 확인 상태 필터
  emailEdited: false,    // 초안을 사용자가 고쳤는지
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
const flag = () => el('span', { class: 'flag-inline', text: '확인 필요', title: '법령·관행 기준을 참고한 임의 기준입니다 (기준일 2026년 11월)' });
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const STATUS_CLASS = { '협상 필요': 'st-negotiate', 확인함: 'st-checked', 수용: 'st-accepted', [STATUS_UNSET]: 'st-none' };

function setMsg(id, text, isError = false) {
  const node = $(id);
  node.textContent = text;
  node.classList.toggle('is-error', !!isError);
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
  try {
    const parsed = parseBackup(JSON.stringify({ app: 'clausecheck', reviews: JSON.parse(raw) }));
    return parsed.ok ? parsed.reviews : [];
  } catch {
    return [];
  }
}

function persistReviews() {
  const ok = safeSet(CONSTANTS.STORAGE_KEY, JSON.stringify(state.reviews));
  if (!ok) toast('브라우저 저장 공간이 부족하거나 저장이 꺼져 있습니다.');
  return ok;
}

// ───────────── 초기화 ─────────────
function init() {
  for (const id of ['contract-type', 'cmp-type']) {
    const select = $(id);
    for (const t of CONTRACT_TYPES) select.append(el('option', { value: t.key, text: t.label }));
    select.value = 'freelance';
  }

  applySavedTheme();
  updateThemeButton();
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

function updateThemeButton() {
  $('theme-toggle').textContent = currentTheme() === 'dark' ? '라이트 모드' : '다크 모드';
}

function bindEvents() {
  $('theme-toggle').addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    safeSet(THEME_KEY, next);
    updateThemeButton();
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

  // 탭 (화살표 키로 이동)
  TABS.forEach((name, i) => {
    const tab = $(`tab-${name}`);
    tab.addEventListener('click', () => showTab(name));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
      $(`tab-${next}`).focus();
      showTab(next);
    });
  });

  // 결과 액션
  $('save-btn').addEventListener('click', saveCurrent);
  $('md-btn').addEventListener('click', () => {
    if (!state.review) return;
    download(`clausecheck-${todayStamp()}.md`, buildMarkdownReport(reportSource(), state.review.statuses), 'text/markdown;charset=utf-8');
  });
  $('csv-btn').addEventListener('click', () => {
    if (!state.review) return;
    download(`clausecheck-${todayStamp()}.csv`, buildFindingsCsv(state.review.result, state.review.statuses), 'text/csv;charset=utf-8');
  });
  $('print-btn').addEventListener('click', () => {
    if (!state.review) return;
    renderPrintReport();
    window.print();
  });
  window.addEventListener('afterprint', () => { $('print-area').textContent = ''; });
  $('mask-btn').addEventListener('click', showMaskPreview);
  $('copy-masked').addEventListener('click', async () => {
    const text = $('mask-preview').textContent;
    setMsg('mask-msg', (await copyText(text)) ? '가린 텍스트를 복사했습니다.' : '복사하지 못했습니다. 텍스트를 직접 선택해 복사하세요.');
  });

  // 발견 목록: 위치 이동 버튼과 상태 선택
  $('finding-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-fid]');
    if (btn) jumpTo(btn.dataset.fid);
  });
  $('finding-list').addEventListener('change', onStatusChange);
  $('finding-filters').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]');
    if (!btn || !state.review) return;
    state.findingFilter = btn.dataset.filter;
    renderFindingList(state.review.result);
  });
  $('checklist').addEventListener('change', onStatusChange);

  // 협상 이메일
  $('make-email').addEventListener('click', makeEmail);
  $('email-out').addEventListener('input', () => { state.emailEdited = true; $('copy-email').disabled = !$('email-out').value; });
  $('copy-email').addEventListener('click', async () => {
    setMsg('email-msg', (await copyText($('email-out').value)) ? '초안을 복사했습니다.' : '복사하지 못했습니다. 텍스트를 직접 선택하세요.');
  });

  // 버전 비교
  $('cmp-run').addEventListener('click', runCompare);
  $('cmp-sample').addEventListener('click', () => {
    $('cmp-old').value = SAMPLE_CONTRACT;
    $('cmp-new').value = SAMPLE_V2;
    $('cmp-type').value = 'freelance';
    setMsg('cmp-msg', '샘플 두 버전을 넣었습니다. 비교하기를 누르세요.');
  });
  $('cmp-use-current').addEventListener('click', () => {
    const text = $('contract-text').value;
    if (!text.trim()) { setMsg('cmp-msg', '새 점검 탭의 원문이 비어 있습니다.', true); return; }
    $('cmp-new').value = text;
    $('cmp-type').value = $('contract-type').value;
    setMsg('cmp-msg', '새 점검 탭의 원문을 새 버전으로 넣었습니다. 이전 버전을 넣고 비교하세요.');
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
  for (const t of TABS) {
    const active = t === name;
    $(`tab-${t}`).setAttribute('aria-selected', String(active));
    $(`tab-${t}`).tabIndex = active ? 0 : -1;
    $(`panel-${t}`).hidden = !active;
  }
  if (name === 'history') renderHistory();
}

function updateCount() {
  const n = $('contract-text').value.length;
  const over = n > CONSTANTS.MAX_INPUT_CHARS;
  $('text-count').textContent = `${n.toLocaleString('ko-KR')}자 / 최대 ${CONSTANTS.MAX_INPUT_CHARS.toLocaleString('ko-KR')}자${over ? ' (앞부분만 분석)' : ''}`;
}

// .txt 파일을 읽어 원문 입력란에 넣습니다.
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
  state.review = { id: null, title, type, text, result, createdAt: new Date().toISOString(), statuses: {} };
  setMsg('input-msg', '');
  renderResult();
  const box = $('result');
  box.hidden = false;
  box.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  $('result-title').focus({ preventScroll: true });
}

// 보고서 입력: 점검 결과와 제목·유형·날짜
function reportSource() {
  const rv = state.review;
  return { title: rv.title, type: rv.type, createdAt: rv.createdAt, result: rv.result };
}

function renderResult() {
  const rv = state.review;
  const r = rv.result;
  state.findingFilter = '전체';
  $('result-title').textContent = rv.title;
  updateResultMeta();

  $('score-num').textContent = String(r.score);
  $('grade').textContent = r.grade;

  const chips = $('chips');
  chips.textContent = '';
  for (const sev of ['높음', '중간', '참고']) {
    chips.append(el('li', { class: `chip ${sevClass(sev)}`, text: `${sev} ${r.counts[sev]}` }));
  }
  chips.append(el('li', { class: 'chip sev-참고', text: `누락 ${r.counts.누락}` }));

  const trunc = $('truncate-note');
  trunc.hidden = !r.truncated;
  trunc.textContent = r.truncated ? `원문이 ${CONSTANTS.MAX_INPUT_CHARS.toLocaleString('ko-KR')}자를 넘어 앞부분만 분석했습니다.` : '';

  state.itemMap = new Map();
  for (const f of [...r.findings, ...r.absences]) state.itemMap.set(itemKey(f), f);

  renderFindingList(r);
  renderContract(r);
  renderStatusSummary();
  renderChecklist(r);
  renderNegotiation(r);
  renderAiChoices(r);
  $('email-out').value = '';
  $('copy-email').disabled = true;
  state.emailEdited = false;
  setMsg('email-msg', '');
  $('mask-block').hidden = true;
  setMsg('ai-msg', safeGet(CONSTANTS.AI_KEY_STORAGE) ? '이 브라우저에 저장된 API 키를 사용합니다.' : '');
  updateAiPreview();
}

function updateResultMeta() {
  const rv = state.review;
  const meta = [typeLabel(rv.type), formatDate(rv.createdAt), rv.id ? '저장됨' : '저장 전'].filter(Boolean).join(' · ');
  $('result-meta').textContent = meta;
  $('save-btn').disabled = !!rv.id;
  $('save-btn').textContent = rv.id ? '저장됨' : '이 기록 저장';
}

function renderStatusSummary() {
  const rv = state.review;
  const s = summarizeStatuses(rv.result, rv.statuses);
  const box = $('status-summary');
  box.textContent = '';
  for (const key of ['협상 필요', '확인함', '수용', STATUS_UNSET]) {
    box.append(el('li', { class: `chip ${STATUS_CLASS[key]}`, text: `${key} ${s[key]}` }));
  }
  refreshMarks();
}

// 발견 목록: 위치 이동 버튼 + 상태 선택
function renderFindingList(r) {
  const list = $('finding-list');
  list.textContent = '';
  state.findingById = new Map(r.findings.map((f) => [f.id, f]));
  renderFindingFilters(r);
  if (!r.findings.length) {
    list.append(el('li', { class: 'finding-empty', text: '위험 문구로 찾은 항목이 없습니다. 아래 누락 체크리스트도 확인하세요.' }));
    return;
  }
  const shown = filterByStatus(r.findings, state.review && state.review.statuses, state.findingFilter);
  if (!shown.length) {
    list.append(el('li', { class: 'finding-empty', text: '이 상태로 표시한 위험 문구가 없습니다.' }));
    return;
  }
  for (const f of shown) {
    const hasText = r.clauses.length > 0;
    const btn = el('button', {
      type: 'button', class: 'finding-item', 'data-fid': f.id, disabled: !hasText,
    },
      el('span', { class: 'fi-row' }, badge(f.severity), ' ', el('span', { class: 'fi-title', text: f.title }), f.legalRef ? flag() : null),
      el('span', { class: 'fi-where', text: `조항 ${f.clauseNo ?? '-'} 부근` }),
      el('span', { class: 'fi-matched', text: `“${f.matched}”` }));
    list.append(el('li', { class: 'finding-row' }, btn, statusSelect(f, `${f.title} 확인 상태`)));
  }
}

// 상태별 보기 버튼. 각 버튼에 해당 항목 수를 함께 씁니다.
function renderFindingFilters(r) {
  const group = $('finding-filters');
  group.textContent = '';
  const statuses = state.review && state.review.statuses;
  for (const f of STATUS_FILTERS) {
    const count = filterByStatus(r.findings, statuses, f).length;
    const pressed = f === state.findingFilter;
    group.append(el('button', {
      type: 'button', class: 'filter-chip', 'data-filter': f, 'aria-pressed': pressed ? 'true' : 'false',
    }, f === '전체' ? '전체' : f === STATUS_UNSET ? '미확인' : f, ` ${count}`));
  }
}

function statusSelect(item, label) {
  const current = statusOf(state.review && state.review.statuses, item);
  const sel = el('select', { class: 'status-select', 'data-key': itemKey(item), 'aria-label': label });
  for (const v of [STATUS_UNSET, ...STATUSES]) {
    const opt = el('option', { value: v === STATUS_UNSET ? '' : v, text: v });
    if (v === current) opt.selected = true;
    sel.append(opt);
  }
  return sel;
}

function onStatusChange(e) {
  const sel = e.target.closest('select.status-select');
  if (!sel || !state.review) return;
  const item = state.itemMap.get(sel.dataset.key);
  if (!item) return;
  setItemStatus(item, sel.value);
}

function setItemStatus(item, value) {
  const rv = state.review;
  rv.statuses = setStatus(rv.statuses, item, value);
  if (state.findingFilter !== '전체') renderFindingList(rv.result);
  if (rv.id) {
    const rec = state.reviews.find((x) => x.id === rv.id);
    if (rec) {
      rec.statuses = { ...rv.statuses };
      persistReviews();
    }
  }
  renderStatusSummary();
}

// 수용으로 정한 위험 문구는 원문에서 흐리게 보입니다.
function refreshMarks() {
  const rv = state.review;
  if (!rv) return;
  for (const mark of state.marks) {
    const items = (mark.dataset.findings || '').split(' ').map((id) => state.findingById.get(id)).filter(Boolean);
    const accepted = items.length > 0 && items.every((f) => statusOf(rv.statuses, f) === '수용');
    mark.classList.toggle('is-accepted', accepted);
  }
}

function renderContract(r) {
  const view = $('contract-view');
  view.textContent = '';
  state.anchors = new Map();
  state.marks = [];
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
      state.marks.push(mark);
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
    ul.append(el('li', { class: 'ck-done' }, el('span', { class: 'ck-box', 'aria-hidden': 'true', text: '✓' }), el('span', { class: 'ck-title', text: '확인한 보호 조항 문구가 모두 있습니다.' })));
    return;
  }
  for (const a of r.absences) {
    ul.append(el('li', {},
      el('span', { class: 'ck-box', 'aria-hidden': 'true', text: '□' }),
      el('div', { class: 'ck-main' },
        el('p', { class: 'ck-title' }, badge(a.severity), ' ', a.title, a.legalRef ? flag() : null),
        el('p', { class: 'ck-why', text: a.why }),
        el('p', { class: 'ck-why', text: `확인 질문: ${a.question}` })),
      statusSelect(a, `${a.title} 확인 상태`)));
  }
}

function uniqueRuleItems(r) {
  const seen = new Map();
  for (const f of r.findings) if (!seen.has(f.ruleId)) seen.set(f.ruleId, f);
  for (const a of r.absences) if (!seen.has(a.ruleId)) seen.set(a.ruleId, a);
  return seen;
}

// 협상 필요 또는 미확인 항목은 기본으로 고르고, 수용으로 정한 항목은 뺍니다.
function renderNegotiation(r) {
  const box = $('nego-list');
  box.textContent = '';
  state.negoRules = uniqueRuleItems(r);
  for (const [ruleId, item] of state.negoRules) {
    const st = statusOf(state.review.statuses, item);
    box.append(el('label', {},
      el('input', { type: 'checkbox', value: ruleId, checked: st !== '수용' }),
      el('span', {}, `[${item.severity}] ${item.title}${item.legalRef ? ' [확인 필요]' : ''} · ${st}`)));
  }
  if (!state.negoRules.size) box.append(el('p', { class: 'fine', text: '이메일에 넣을 항목이 없습니다.' }));
}

function makeEmail() {
  if (!state.review) return;
  if (state.emailEdited && !window.confirm('고친 초안이 있습니다. 다시 만들면 고친 내용이 사라집니다. 계속할까요?')) return;
  const checked = new Set([...$('nego-list').querySelectorAll('input[type="checkbox"]:checked')].map((i) => i.value));
  const r = state.review.result;
  const findings = r.findings.filter((f) => checked.has(f.ruleId));
  const absences = r.absences.filter((a) => checked.has(a.ruleId));
  const mail = buildNegotiationEmail({
    result: { findings, absences },
    senderName: $('sender-name').value.trim() || '[본인 성함]',
    receiverName: $('receiver-name').value.trim() || '[상대방 성함]',
    contractTitle: state.review.title,
    deadline: $('email-deadline').value.trim(),
    extraNote: $('email-extra').value,
    includeQuestions: $('email-questions').checked,
  });
  $('email-out').value = mail;
  state.emailEdited = false;
  $('copy-email').disabled = false;
  setMsg('email-msg', '초안을 만들었습니다. 내용을 확인하고 필요하면 고쳐 쓰세요.');
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

// 인쇄용 보고서: 텍스트 노드로만 만들고, 인쇄가 끝나면 비웁니다.
function renderPrintReport() {
  const rv = state.review;
  const m = buildReportModel(reportSource(), rv.statuses);
  const area = $('print-area');
  const item = (x) => el('div', { class: 'rp-item' },
    el('h3', {}, `[${x.severity}] ${x.title}`, x.legalRef ? ' (확인 필요)' : ''),
    el('p', { class: 'rp-meta', text: `${x.kind === 'absent' ? '누락 항목' : `조항 ${x.clauseNo ?? '-'} 부근 · 발견 문구 “${x.matched}”`} · 상태: ${x.status}` }),
    el('p', { text: `위험 이유: ${x.why}` }),
    el('p', { text: `확인 질문: ${x.question}` }),
    el('p', { text: `협상 제안: ${x.negotiation}` }));
  area.textContent = '';
  area.append(el('article', { class: 'report' },
    el('header', { class: 'rp-head' },
      el('p', { class: 'rp-kicker', text: 'ClauseCheck · 계약서 위험조항 점검 보고서' }),
      el('h1', { text: m.title }),
      el('p', { class: 'rp-meta', text: `계약 유형: ${m.type} · 점검일: ${m.date} · 기준일: ${m.asOf}` })),
    el('section', { class: 'rp-section' },
      el('h2', { text: '요약' }),
      el('p', { text: `위험 점수 ${m.score} / 100 (위험도 ${m.grade})` }),
      el('p', { text: `발견: 높음 ${m.counts.높음} · 중간 ${m.counts.중간} · 참고 ${m.counts.참고} · 누락 ${m.counts.누락}` }),
      el('p', { text: `확인 상태: 협상 필요 ${m.statusSummary['협상 필요']} · 확인함 ${m.statusSummary.확인함} · 수용 ${m.statusSummary.수용} · 미확인 ${m.statusSummary[STATUS_UNSET]}` }),
      m.truncated ? el('p', { text: `원문이 ${CONSTANTS.MAX_INPUT_CHARS.toLocaleString('ko-KR')}자를 넘어 앞부분만 분석했습니다.` }) : null),
    el('section', { class: 'rp-section' },
      el('h2', { text: '위험 조항' }),
      m.findings.length ? m.findings.map(item) : el('p', { text: '발견된 위험 문구가 없습니다.' })),
    el('section', { class: 'rp-section' },
      el('h2', { text: '누락된 보호 조항 체크리스트' }),
      m.absences.length
        ? el('ul', { class: 'rp-check' }, m.absences.map((a) => el('li', {}, `☐ [${a.severity}] ${a.title}${a.legalRef ? ' (확인 필요)' : ''} · 상태: ${a.status}`, el('br'), a.why)))
        : el('p', { text: '확인한 보호 조항 문구가 모두 있습니다 (문구 기준).' })),
    el('footer', { class: 'rp-foot' },
      el('p', { text: DISCLAIMER }),
      el('p', { text: m.legalNote }),
      el('p', { text: `기준: ${m.asOf}. ${m.basis}` }))));
}

// ───────────── 저장 / 이력 ─────────────
function saveCurrent() {
  if (!state.review || state.review.id) return;
  const rv = state.review;
  const rec = makeReviewRecord({
    title: rv.title, type: rv.type, text: rv.text, keepText: $('keep-text').checked, result: rv.result, statuses: rv.statuses,
  });
  const before = state.reviews;
  state.reviews = [rec, ...before].slice(0, MAX_SAVED);
  if (!persistReviews()) { state.reviews = before; return; }
  rv.id = rec.id;
  updateResultMeta();
  toast('이 브라우저에 저장했습니다.');
}

function renderHistory() {
  const list = $('history-list');
  list.textContent = '';
  $('history-empty').hidden = state.reviews.length > 0;
  for (const rec of state.reviews) {
    const need = Object.values(rec.statuses || {}).filter((v) => v === '협상 필요').length;
    const meta = [
      typeLabel(rec.type), formatDate(rec.createdAt), `점수 ${rec.score} (${rec.grade})`,
      need ? `협상 필요 ${need}` : '', rec.text ? '' : '원문 미저장',
    ].filter(Boolean).join(' · ');
    list.append(el('li', {},
      el('div', {},
        el('p', { class: 'hi-title', text: rec.title || '(제목 없음)' }),
        el('p', { class: 'hi-meta', text: meta })),
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
      result: reviewToResult(rec), createdAt: rec.createdAt, statuses: { ...(rec.statuses || {}) },
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
      if ($('result').hidden === false) updateResultMeta();
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

// ───────────── 버전 비교 ─────────────
function runCompare() {
  const oldText = $('cmp-old').value;
  const newText = $('cmp-new').value;
  if (!oldText.trim() || !newText.trim()) {
    setMsg('cmp-msg', '이전 버전과 새 버전을 모두 입력하세요.', true);
    return;
  }
  const c = compareContracts(oldText, newText, $('cmp-type').value);
  renderCompare(c);
  setMsg('cmp-msg', '비교를 마쳤습니다. 결과는 저장되지 않습니다.');
}

function signed(n) { return n > 0 ? `+${n}` : String(n); }

function renderCompare(c) {
  const out = $('cmp-out');
  out.textContent = '';
  const metric = (label, value) => el('div', { class: 'metric' },
    el('p', { class: 'metric-label', text: label }), el('p', { class: 'metric-value', text: value }));
  out.append(el('div', { class: 'metric-grid' },
    metric('점수 변화', `${c.before.score} → ${c.after.score} (${signed(c.scoreDelta)})`),
    metric('새로 생긴 위험', `${c.added.length}개`),
    metric('사라진 위험', `${c.removed.length}개`),
    metric('새로 빠진 보호 조항', `${c.newlyMissing.length}개`),
    metric('채워진 보호 조항', `${c.resolved.length}개`)));
  if (c.capped) {
    out.append(el('p', { class: 'notice-warn', text: `점수는 100점에서 멈춥니다. 상한 없이 더한 차이는 ${signed(c.rawDelta)}입니다.` }));
  }
  if (c.truncated) {
    out.append(el('p', { class: 'notice-warn', text: `원문이 ${CONSTANTS.MAX_INPUT_CHARS.toLocaleString('ko-KR')}자를 넘어 앞부분만 비교했습니다.` }));
  }

  const row = (x, extra) => el('li', { class: 'cmp-row' },
    el('div', {}, badge(x.severity), ' ', el('span', { class: 'fi-title', text: x.title }), x.legalRef ? flag() : null),
    x.samples ? x.samples.map((s) => el('p', { class: 'fi-matched', text: `조항 ${s.clauseNo ?? '-'}: “${s.matched}”` })) : null,
    extra ? el('p', { class: 'fine', text: extra }) : null);
  const group = (title, rows, render) => el('section', { class: 'cmp-group' },
    el('h4', { text: `${title} (${rows.length})` }),
    rows.length ? el('ul', { class: 'cmp-list' }, rows.map(render)) : el('p', { class: 'fine', text: '해당 없음' }));

  out.append(
    group('새로 생긴 위험', c.added, (x) => row(x)),
    group('사라진 위험', c.removed, (x) => row(x)),
    group('발견 횟수가 바뀐 위험', c.changed, (x) => row(x, `${x.before}개 → ${x.after}개`)),
    group('새로 빠진 보호 조항', c.newlyMissing, (x) => row(x, x.why)),
    group('채워진 보호 조항', c.resolved, (x) => row(x, '이전 버전에 빠져 있던 보호 문구가 새 버전에 있습니다.')));
  if (!c.added.length && !c.removed.length && !c.changed.length && !c.newlyMissing.length && !c.resolved.length) {
    out.append(el('p', { class: 'fine', text: '규칙 기준으로 달라진 항목이 없습니다.' }));
  }
  out.append(el('p', { class: 'fine', text: '규칙 단위로 비교합니다. 문장 위치가 바뀌어도 같은 규칙이면 같은 항목으로 봅니다. 문구의 법적 차이는 판단하지 않습니다.' }));
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
