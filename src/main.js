const STORAGE_KEY = 'shopping-memo-items';
const API_KEY_STORAGE = 'shopping-memo-gemini-key';
const FLYER_PROXY_STORAGE = 'shopping-memo-flyer-proxy';
const FLYER_PROXY_SECRET_STORAGE = 'shopping-memo-flyer-proxy-secret';
const TAB_STORAGE_KEY = 'shopping-memo-active-tab';
const UNSET_STORE_LABEL = '未設定';

/** Built-in store flyer pages (resolved by the flyer proxy). */
const FLYER_PRESETS = [
  {
    id: 'uoroku-kandoji',
    url: 'https://www.uoroku.co.jp/shop/flyer/kandoji.html',
  },
  {
    id: 'aeon-toyano',
    url: 'https://www.aeon.com/store/%E3%82%A4%E3%82%AA%E3%83%B3/%E3%82%A4%E3%82%AA%E3%83%B3%E3%81%A8%E3%82%84%E3%81%AE%E5%BA%97/?is_browser=true',
  },
  {
    id: 'harashin-kurosaki',
    url: 'https://www.harashinnarus.jp/shops/kurosaki/',
  },
];

/** Primary + fallbacks if a model name is unavailable */
const GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-2.0-flash',
];

/** @typedef {{ id: string, name: string, qty: string, store: string, done: boolean }} Item */

const els = {
  app: document.getElementById('app'),
  appTitle: document.getElementById('app-title'),
  listToolbar: document.getElementById('list-toolbar'),
  flyerSubtitle: document.getElementById('flyer-subtitle'),
  panelMemo: document.getElementById('panel-memo'),
  panelFlyer: document.getElementById('panel-flyer'),
  tabMemo: document.getElementById('tab-memo'),
  tabFlyer: document.getElementById('tab-flyer'),
  form: document.getElementById('add-form'),
  input: document.getElementById('item-input'),
  qty: document.getElementById('qty-input'),
  store: document.getElementById('store-input'),
  storeSuggestions: document.getElementById('store-suggestions'),
  list: document.getElementById('item-list'),
  empty: document.getElementById('empty-state'),
  count: document.getElementById('item-count'),
  clearDone: document.getElementById('clear-done-btn'),
  mic: document.getElementById('mic-btn'),
  voiceStatus: document.getElementById('voice-status'),
  voiceNote: document.getElementById('voice-note'),
  settingsBtn: document.getElementById('settings-btn'),
  settingsDialog: document.getElementById('settings-dialog'),
  apiKeyInput: document.getElementById('api-key-input'),
  proxyUrlInput: document.getElementById('proxy-url-input'),
  proxySecretInput: document.getElementById('proxy-secret-input'),
  saveKeyBtn: document.getElementById('save-key-btn'),
  clearKeyBtn: document.getElementById('clear-key-btn'),
  settingsStatus: document.getElementById('settings-status'),
  aiBtn: document.getElementById('ai-organize-btn'),
  flyerFileInput: document.getElementById('flyer-file-input'),
  flyerUrlInput: document.getElementById('flyer-url-input'),
  flyerUrlBtn: document.getElementById('flyer-url-btn'),
  flyerPreviewWrap: document.getElementById('flyer-preview-wrap'),
  flyerPreview: document.getElementById('flyer-preview'),
  flyerPagePicker: document.getElementById('flyer-page-picker'),
  flyerPageList: document.getElementById('flyer-page-list'),
  flyerStatus: document.getElementById('flyer-status'),
  flyerReview: document.getElementById('flyer-review'),
  flyerCandidateList: document.getElementById('flyer-candidate-list'),
  flyerSelectAll: document.getElementById('flyer-select-all'),
  flyerDeselectAll: document.getElementById('flyer-deselect-all'),
  flyerAddBtn: document.getElementById('flyer-add-btn'),
  flyerClearBtn: document.getElementById('flyer-clear-btn'),
  flyerMealBtn: document.getElementById('flyer-meal-btn'),
  flyerMeals: document.getElementById('flyer-meals'),
  flyerMealList: document.getElementById('flyer-meal-list'),
};

/** @type {Item[]} */
let items = loadItems();
let recognition = null;
let listening = false;
let aiBusy = false;
let flyerBusy = false;
let mealBusy = false;
/** Bumped when the flyer review is cleared so an in-flight meal response is dropped. */
let mealEpoch = 0;
/** @type {{ mimeType: string, data: string } | null} */
let flyerImagePayload = null;
/** @type {string | null} */
let flyerPreviewUrl = null;
/** @type {'memo' | 'flyer'} */
let activeTab = loadActiveTab();

function loadActiveTab() {
  try {
    const v = localStorage.getItem(TAB_STORAGE_KEY);
    return v === 'flyer' ? 'flyer' : 'memo';
  } catch {
    return 'memo';
  }
}

function saveActiveTab(tab) {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch {
    /* ignore */
  }
}

/**
 * @param {'memo' | 'flyer'} tab
 */
function setActiveTab(tab) {
  if (tab !== 'memo' && tab !== 'flyer') tab = 'memo';
  activeTab = tab;
  saveActiveTab(tab);
  els.app.dataset.tab = tab;

  const isMemo = tab === 'memo';
  els.panelMemo.hidden = !isMemo;
  els.panelFlyer.hidden = isMemo;
  els.listToolbar.hidden = !isMemo;
  els.flyerSubtitle.hidden = isMemo;

  els.appTitle.textContent = isMemo ? '買い物メモ' : 'チラシ';
  document.title = isMemo ? '買い物メモ' : 'チラシ｜買い物メモ';

  els.tabMemo.classList.toggle('active', isMemo);
  els.tabFlyer.classList.toggle('active', !isMemo);
  els.tabMemo.setAttribute('aria-selected', isMemo ? 'true' : 'false');
  els.tabFlyer.setAttribute('aria-selected', isMemo ? 'false' : 'true');
  els.tabMemo.tabIndex = isMemo ? 0 : -1;
  els.tabFlyer.tabIndex = isMemo ? -1 : 0;

  // Stop listening mic when leaving memo
  if (!isMemo && listening && recognition) {
    try {
      recognition.stop();
    } catch {
      /* ignore */
    }
  }
}

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStore(value) {
  return String(value || '').trim();
}

function loadItems() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => x && typeof x.name === 'string')
      .map((x) => ({
        id: String(x.id || uid()),
        name: String(x.name).trim(),
        qty: String(x.qty || '').trim(),
        // Migration: old items without store → empty string
        store: normalizeStore(x.store),
        done: Boolean(x.done),
      }))
      .filter((x) => x.name);
  } catch {
    return [];
  }
}

function saveItems() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function getApiKey() {
  try {
    return (localStorage.getItem(API_KEY_STORAGE) || '').trim();
  } catch {
    return '';
  }
}

function setApiKey(key) {
  const trimmed = (key || '').trim();
  if (trimmed) {
    localStorage.setItem(API_KEY_STORAGE, trimmed);
  } else {
    localStorage.removeItem(API_KEY_STORAGE);
  }
}

function getFlyerProxyUrl() {
  try {
    return (localStorage.getItem(FLYER_PROXY_STORAGE) || '').trim().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function setFlyerProxyUrl(url) {
  const trimmed = (url || '').trim().replace(/\/$/, '');
  if (trimmed) {
    localStorage.setItem(FLYER_PROXY_STORAGE, trimmed);
  } else {
    localStorage.removeItem(FLYER_PROXY_STORAGE);
  }
}

function getFlyerProxySecret() {
  try {
    return (localStorage.getItem(FLYER_PROXY_SECRET_STORAGE) || '').trim();
  } catch {
    return '';
  }
}

function setFlyerProxySecret(secret) {
  const trimmed = (secret || '').trim();
  if (trimmed) {
    localStorage.setItem(FLYER_PROXY_SECRET_STORAGE, trimmed);
  } else {
    localStorage.removeItem(FLYER_PROXY_SECRET_STORAGE);
  }
}

function setStatus(text, isError = false) {
  els.voiceStatus.textContent = text;
  els.voiceStatus.classList.toggle('error', isError);
}

function setSettingsStatus(text, isError = false) {
  els.settingsStatus.textContent = text;
  els.settingsStatus.classList.toggle('error', isError);
}

/** Recent / used store names for suggestions (non-empty, unique, sorted ja). */
function getUsedStores() {
  const set = new Set();
  for (const item of items) {
    const s = normalizeStore(item.store);
    if (s) set.add(s);
  }
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
}

function refreshStoreSuggestions() {
  if (!els.storeSuggestions) return;
  els.storeSuggestions.innerHTML = '';
  for (const store of getUsedStores()) {
    const opt = document.createElement('option');
    opt.value = store;
    els.storeSuggestions.appendChild(opt);
  }
}

/**
 * Group items by store. Non-empty stores sorted alphabetically (ja);
 * 「未設定」(empty) last. Within a group, preserve items[] order.
 * @returns {{ key: string, label: string, items: Item[] }[]}
 */
function groupItemsByStore(list) {
  /** @type {Map<string, Item[]>} */
  const map = new Map();
  for (const item of list) {
    const key = normalizeStore(item.store);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  const keys = [...map.keys()].sort((a, b) => {
    if (!a && !b) return 0;
    if (!a) return 1; // 未設定 last
    if (!b) return -1;
    return a.localeCompare(b, 'ja');
  });
  return keys.map((key) => ({
    key,
    label: key || UNSET_STORE_LABEL,
    items: map.get(key),
  }));
}

function render() {
  els.list.innerHTML = '';
  const remaining = items.filter((i) => !i.done).length;
  const doneCount = items.filter((i) => i.done).length;

  if (items.length === 0) {
    els.empty.classList.remove('hidden');
    els.count.textContent = '';
  } else {
    els.empty.classList.add('hidden');
    els.count.textContent =
      doneCount > 0
        ? `残り ${remaining} / 合計 ${items.length}`
        : `${items.length} 件`;
  }

  els.clearDone.disabled = doneCount === 0;
  refreshStoreSuggestions();

  const groups = groupItemsByStore(items);
  for (const group of groups) {
    const header = document.createElement('li');
    header.className = 'store-group-header';
    header.setAttribute('role', 'presentation');
    const title = document.createElement('span');
    title.className = 'store-group-title';
    title.textContent = group.label;
    const badge = document.createElement('span');
    badge.className = 'store-group-count';
    badge.textContent = `${group.items.length}`;
    header.append(title, badge);
    els.list.appendChild(header);

    for (const item of group.items) {
      els.list.appendChild(createItemElement(item));
    }
  }
}

function createItemElement(item) {
  const li = document.createElement('li');
  li.className = `item${item.done ? ' done' : ''}`;
  li.dataset.id = item.id;

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'toggle-btn';
  toggle.setAttribute(
    'aria-label',
    item.done ? `${item.name}を未完了に戻す` : `${item.name}を完了にする`,
  );
  toggle.textContent = '✓';
  toggle.addEventListener('click', () => toggleItem(item.id));

  const body = document.createElement('div');
  body.className = 'item-body';
  const name = document.createElement('span');
  name.className = 'item-name';
  name.textContent = item.name;
  body.appendChild(name);
  if (item.qty) {
    const qty = document.createElement('span');
    qty.className = 'item-qty';
    qty.textContent = item.qty;
    body.appendChild(qty);
  }

  const storeBtn = document.createElement('button');
  storeBtn.type = 'button';
  storeBtn.className = `item-store${item.store ? '' : ' unset'}`;
  storeBtn.textContent = item.store
    ? `📍 ${item.store}`
    : `📍 ${UNSET_STORE_LABEL}`;
  storeBtn.setAttribute(
    'aria-label',
    item.store
      ? `${item.name}の購入先（${item.store}）。タップして変更`
      : `${item.name}の購入先を設定`,
  );
  storeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    beginStoreEdit(li, item);
  });
  body.appendChild(storeBtn);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'delete-btn';
  del.setAttribute('aria-label', `${item.name}を削除`);
  del.textContent = '×';
  del.addEventListener('click', () => deleteItem(item.id));

  li.append(toggle, body, del);
  return li;
}

/** Inline edit for an item's store (mobile-friendly). */
function beginStoreEdit(li, item) {
  const existing = li.querySelector('.store-edit');
  if (existing) {
    existing.querySelector('input')?.focus();
    return;
  }

  const body = li.querySelector('.item-body');
  const storeBtn = body?.querySelector('.item-store');
  if (!body || !storeBtn) return;

  storeBtn.hidden = true;

  const wrap = document.createElement('div');
  wrap.className = 'store-edit';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'store-edit-input';
  input.value = item.store || '';
  input.placeholder = '購入先（空で未設定）';
  input.maxLength = 40;
  input.setAttribute('list', 'store-suggestions');
  input.setAttribute('aria-label', `${item.name}の購入先`);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'store-edit-save';
  saveBtn.textContent = '保存';

  wrap.append(input, saveBtn);
  body.appendChild(wrap);
  input.focus();
  input.select();

  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    if (commit) {
      updateItemStore(item.id, input.value);
    } else {
      render();
    }
  };

  saveBtn.addEventListener('click', () => finish(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(false);
    }
  });
  input.addEventListener('blur', () => {
    // Allow save button click to fire first
    setTimeout(() => {
      if (!finished && !wrap.contains(document.activeElement)) {
        finish(true);
      }
    }, 120);
  });
}

function addItem(name, qty = '', store = '') {
  const trimmed = name.trim();
  if (!trimmed) return;
  items.unshift({
    id: uid(),
    name: trimmed,
    qty: qty.trim(),
    store: normalizeStore(store),
    done: false,
  });
  saveItems();
  render();
}

function addItemsFromAi(extracted) {
  const added = [];
  for (const raw of extracted) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || '').trim();
    if (!name) continue;
    const qty = String(raw.quantity ?? raw.qty ?? '').trim();
    const store = normalizeStore(raw.store ?? raw.destination ?? '');
    const key = name.toLowerCase();
    const exists = items.some(
      (i) =>
        !i.done &&
        i.name.toLowerCase() === key &&
        (i.qty || '') === qty &&
        (i.store || '') === store,
    );
    if (exists) continue;
    items.unshift({
      id: uid(),
      name,
      qty,
      store,
      done: false,
    });
    added.push(name);
  }
  if (added.length) {
    saveItems();
    render();
  }
  return added.length;
}

function updateItemStore(id, store) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  item.store = normalizeStore(store);
  saveItems();
  render();
}

function toggleItem(id) {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  item.done = !item.done;
  saveItems();
  render();
}

function deleteItem(id) {
  items = items.filter((i) => i.id !== id);
  saveItems();
  render();
}

function clearDone() {
  items = items.filter((i) => !i.done);
  saveItems();
  render();
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  addItem(els.input.value, els.qty.value, els.store.value);
  els.input.value = '';
  els.qty.value = '';
  // Keep store value for consecutive adds to the same destination
  els.input.focus();
});

els.clearDone.addEventListener('click', () => {
  if (items.some((i) => i.done)) clearDone();
});

/* ---------- Settings ---------- */

function openSettings() {
  els.apiKeyInput.value = getApiKey();
  els.proxyUrlInput.value = getFlyerProxyUrl();
  els.proxySecretInput.value = getFlyerProxySecret();
  const parts = [];
  parts.push(getApiKey() ? 'APIキー設定済' : 'APIキー未設定');
  parts.push(getFlyerProxyUrl() ? 'プロキシ設定済' : 'プロキシ未設定');
  setSettingsStatus(parts.join(' / '));
  els.settingsDialog.showModal();
  els.apiKeyInput.focus();
}

els.settingsBtn.addEventListener('click', openSettings);

els.saveKeyBtn.addEventListener('click', () => {
  const key = els.apiKeyInput.value.trim();
  const proxyRaw = els.proxyUrlInput.value.trim();
  const proxySecret = els.proxySecretInput.value.trim();

  if (proxyRaw) {
    let proxyUrl;
    try {
      proxyUrl = new URL(proxyRaw);
    } catch {
      setSettingsStatus('プロキシURLの形式が正しくありません', true);
      return;
    }
    if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') {
      setSettingsStatus('プロキシURLは http または https にしてください', true);
      return;
    }
  }

  // Persist whatever is currently in the form (empty clears that field)
  if (key) {
    setApiKey(key);
  }
  setFlyerProxyUrl(proxyRaw);
  setFlyerProxySecret(proxySecret);

  if (!getApiKey() && !getFlyerProxyUrl()) {
    setSettingsStatus('APIキーまたはプロキシURLを入力して保存してください', true);
    return;
  }

  const parts = [];
  parts.push(getApiKey() ? 'APIキー保存済' : 'APIキー未設定');
  parts.push(getFlyerProxyUrl() ? 'プロキシ保存済' : 'プロキシ未設定');
  setSettingsStatus(parts.join(' / '));
});

els.clearKeyBtn.addEventListener('click', () => {
  setApiKey('');
  setFlyerProxyUrl('');
  setFlyerProxySecret('');
  els.apiKeyInput.value = '';
  els.proxyUrlInput.value = '';
  els.proxySecretInput.value = '';
  setSettingsStatus('APIキーとプロキシ設定を削除しました');
});

els.settingsDialog.addEventListener('click', (e) => {
  if (e.target === els.settingsDialog) {
    els.settingsDialog.close();
  }
});

/* ---------- Gemini AI organize ---------- */

function buildOrganizePrompt(text) {
  return [
    'あなたは買い物リスト整理アシスタントです。',
    '次の日本語の自由文・音声認識テキストから、買い物アイテムだけを抽出してください。',
    '雑談や買い物以外の内容は無視し、似たアイテムは合理的にまとめてください。',
    '数量が分かる場合は quantity に短い日本語（例: "2個", "1パック"）で入れてください。分からなければ空文字か省略。',
    '購入先（店名・行き先）が文中で明確な場合のみ store に入れてください。',
    '例: 「イオンで牛乳と卵」→ [{"name":"牛乳","store":"イオン"},{"name":"卵","store":"イオン"}]',
    '例: 「原信で豆腐、洗剤も」→ 豆腐は store:"原信"。洗剤の購入先が不明なら store は空か省略。',
    '推測や一般論で店名を付けないでください。不明なら store を省略または空文字。',
    '出力は JSON 配列のみ。形式: [{"name":"牛乳","quantity":"1本","store":"イオン"},{"name":"卵"}]',
    'アイテムが無い場合は [] を返してください。説明文やコードフェンスは付けないでください。',
    '',
    '【テキスト】',
    text,
  ].join('\n');
}

function extractJsonArray(text) {
  const cleaned = String(text || '')
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.items)) return parsed.items;
  } catch {
    /* fall through */
  }
  const match = cleaned.match(/\[[\s\S]*\]/);
  if (match) {
    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed)) return parsed;
  }
  throw new Error('parse');
}

function mapGeminiError(status, bodyText) {
  const lower = (bodyText || '').toLowerCase();
  if (status === 400 && (lower.includes('api key') || lower.includes('api_key'))) {
    return 'APIキーが無効です。設定で正しいキーを保存してください。';
  }
  if (status === 401 || status === 403) {
    return 'APIキーが無効か、利用が許可されていません。設定を確認してください。';
  }
  if (status === 429) {
    return '利用上限（クォータ）に達しました。しばらく待ってから再試行してください。';
  }
  if (status >= 500) {
    return 'Geminiサーバーでエラーが発生しました。しばらく待って再試行してください。';
  }
  if (lower.includes('not found') || lower.includes('is not found')) {
    return 'model_not_found';
  }
  return null;
}

/**
 * @param {string} apiKey
 * @param {string} model
 * @param {string} userText
 */
async function callGemini(apiKey, model, userText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildOrganizePrompt(userText) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: 'low' },
      },
    }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    const mapped = mapGeminiError(res.status, bodyText);
    const err = new Error(mapped || `HTTP ${res.status}`);
    err.code = mapped === 'model_not_found' ? 'model_not_found' : 'http';
    err.status = res.status;
    err.body = bodyText;
    throw err;
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    const err = new Error('レスポンスの解析に失敗しました。');
    err.code = 'parse';
    throw err;
  }

  const textOut =
    data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || '')
      .join('') || '';

  if (!textOut) {
    const block = data?.promptFeedback?.blockReason;
    const err = new Error(
      block
        ? `リクエストがブロックされました（${block}）。`
        : 'AIから有効な応答がありませんでした。',
    );
    err.code = 'empty';
    throw err;
  }

  return extractJsonArray(textOut);
}

async function callGeminiWithFallback(apiKey, userText) {
  let lastError = null;
  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i];
    try {
      return await callGemini(apiKey, model, userText);
    } catch (err) {
      lastError = err;
      const retry =
        err.code === 'model_not_found' ||
        err.status === 404 ||
        (typeof err.body === 'string' &&
          /not found|NOT_FOUND|unsupported/i.test(err.body));
      if (retry && i < GEMINI_MODELS.length - 1) {
        continue;
      }
      // Some models may reject thinkingConfig — retry once without it
      if (
        typeof err.body === 'string' &&
        /thinking/i.test(err.body) &&
        !err._retriedNoThinking
      ) {
        try {
          return await callGeminiPlain(apiKey, model, userText);
        } catch (err2) {
          lastError = err2;
          if (i < GEMINI_MODELS.length - 1) continue;
          throw err2;
        }
      }
      throw err;
    }
  }
  throw lastError || new Error('Gemini呼び出しに失敗しました。');
}

/** Same as callGemini but without thinkingConfig (older flash models). */
async function callGeminiPlain(apiKey, model, userText) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildOrganizePrompt(userText) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
      },
    }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    const mapped = mapGeminiError(res.status, bodyText);
    const err = new Error(mapped || `HTTP ${res.status}`);
    err.code = mapped === 'model_not_found' ? 'model_not_found' : 'http';
    err.status = res.status;
    err.body = bodyText;
    err._retriedNoThinking = true;
    throw err;
  }

  const data = JSON.parse(bodyText);
  const textOut =
    data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || '')
      .join('') || '';
  if (!textOut) {
    const err = new Error('AIから有効な応答がありませんでした。');
    err.code = 'empty';
    throw err;
  }
  return extractJsonArray(textOut);
}

function friendlyAiError(err) {
  if (!err) return 'AI整理に失敗しました。';
  if (err.message && !err.message.startsWith('HTTP') && err.message !== 'parse') {
    if (err.message === 'model_not_found') {
      return '利用可能なGeminiモデルが見つかりませんでした。';
    }
    return err.message;
  }
  if (err.code === 'parse' || err.message === 'parse') {
    return 'AIの応答を解析できませんでした。もう一度試してください。';
  }
  if (err.name === 'TypeError' || /failed to fetch|network/i.test(String(err.message))) {
    return 'ネットワークエラーです。接続を確認して再試行してください。';
  }
  return 'AI整理に失敗しました。しばらくしてから再試行してください。';
}

async function organizeWithAi() {
  if (aiBusy) return;

  const text = els.input.value.trim();
  if (!text) {
    setStatus('整理するテキストを入力してください', true);
    return;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    setStatus('APIキーが未設定です。設定を開いてください。', true);
    openSettings();
    return;
  }

  aiBusy = true;
  els.aiBtn.disabled = true;
  els.aiBtn.classList.add('busy');
  setStatus('AIが整理しています…');

  try {
    const extracted = await callGeminiWithFallback(apiKey, text);
    // If composer has a store set and AI omitted store, apply as fallback
    const fallbackStore = normalizeStore(els.store.value);
    if (fallbackStore) {
      for (const raw of extracted) {
        if (!raw || typeof raw !== 'object') continue;
        if (!normalizeStore(raw.store ?? raw.destination ?? '')) {
          raw.store = fallbackStore;
        }
      }
    }
    const count = addItemsFromAi(extracted);
    if (count === 0) {
      setStatus('買い物アイテムが見つかりませんでした', true);
    } else {
      els.input.value = '';
      els.qty.value = '';
      setStatus(`${count} 件をリストに追加しました`);
    }
  } catch (err) {
    setStatus(friendlyAiError(err), true);
  } finally {
    aiBusy = false;
    els.aiBtn.disabled = false;
    els.aiBtn.classList.remove('busy');
  }
}

els.aiBtn.addEventListener('click', () => {
  organizeWithAi();
});


/* ---------- Flyer (チラシ) import ---------- */

const FLYER_CORS_ERROR =
  'このURLの画像を直接取得できませんでした。スクショか保存した画像を『写真・ギャラリー』から選んでください。';

function setFlyerStatus(text, isError = false) {
  els.flyerStatus.textContent = text;
  els.flyerStatus.classList.toggle('error', isError);
}

function buildFlyerPrompt() {
  return [
    'あなたはスーパー・ドラッグストアなどのチラシ（広告チラシ）から買い物アイテムを抽出するアシスタントです。',
    '画像に写っている特売・商品名だけを抽出してください。',
    '商品でない広告文言・注意書き・クーポン条件・店の営業案内などは無視してください。',
    '似た商品行はまとめてください。最大40件まで。',
    '各要素:',
    '- name: 必須。商品名（短い日本語）',
    '- quantity: 数量・容量が読み取れる場合のみ短い日本語（例: "2パック", "500g"）。なければ空文字',
    '- store: チラシ上に店名・チェーン名が読み取れる場合のみ。なければ空文字。推測しない',
    '- price: 価格が読み取れる場合は短い文字列（例: "198円", "半額"）。なければ空文字。必須ではない',
    '出力は JSON 配列のみ。形式: [{"name":"牛乳","quantity":"1本","store":"イオン","price":"198円"}]',
    'アイテムが無い場合は [] 。説明文やコードフェンスは付けないでください。',
  ].join('\n');
}

/**
 * Resize/compress image Blob for Gemini inlineData.
 * @param {Blob} blob
 * @returns {Promise<{ mimeType: string, data: string, previewUrl: string }>}
 */
async function prepareImageForGemini(blob) {
  if (!blob || !blob.type || !blob.type.startsWith('image/')) {
    // Some cameras omit type; try decoding anyway
    if (blob && (!blob.type || blob.type === 'application/octet-stream')) {
      /* continue */
    } else {
      throw new Error('画像ファイルを選択してください。');
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await loadImage(objectUrl);
    const maxEdge = 1600;
    let { width, height } = img;
    if (!width || !height) {
      throw new Error('画像を読み込めませんでした。');
    }
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('画像の処理に失敗しました。');
    ctx.drawImage(img, 0, 0, w, h);

    const srcType = (blob.type || '').toLowerCase();
    const preferPng = srcType.includes('png') && blob.size < 400_000 && scale === 1;
    const mimeType = preferPng ? 'image/png' : 'image/jpeg';
    const quality = preferPng ? undefined : 0.85;

    const outBlob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('画像の圧縮に失敗しました。'))),
        mimeType,
        quality,
      );
    });

    const data = await blobToBase64Data(outBlob);
    const previewUrl = URL.createObjectURL(outBlob);
    return { mimeType, data, previewUrl };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('画像を読み込めませんでした。'));
    img.src = src;
  });
}

function blobToBase64Data(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('画像の読み込みに失敗しました。'));
    reader.readAsDataURL(blob);
  });
}

function clearFlyerPreview() {
  if (flyerPreviewUrl) {
    URL.revokeObjectURL(flyerPreviewUrl);
    flyerPreviewUrl = null;
  }
  flyerImagePayload = null;
  els.flyerPreview.removeAttribute('src');
  els.flyerPreviewWrap.hidden = true;
}

function clearFlyerPagePicker() {
  if (!els.flyerPageList) return;
  // Revoke any thumb object URLs stored on buttons
  for (const btn of els.flyerPageList.querySelectorAll('.flyer-page-btn')) {
    const thumbUrl = btn.dataset.thumbObjectUrl;
    if (thumbUrl) {
      try {
        URL.revokeObjectURL(thumbUrl);
      } catch {
        /* ignore */
      }
    }
  }
  els.flyerPageList.innerHTML = '';
  if (els.flyerPagePicker) els.flyerPagePicker.hidden = true;
}

function clearMealPlan() {
  mealEpoch += 1;
  if (els.flyerMealList) els.flyerMealList.innerHTML = '';
  if (els.flyerMeals) els.flyerMeals.hidden = true;
}

function clearFlyerReview() {
  els.flyerCandidateList.innerHTML = '';
  els.flyerReview.hidden = true;
  els.flyerAddBtn.disabled = true;
  clearMealPlan();
}

function resetFlyerPanelState() {
  clearFlyerPreview();
  clearFlyerPagePicker();
  clearFlyerReview();
  setFlyerStatus('');
  els.flyerFileInput.value = '';
  els.flyerUrlInput.value = '';
}

/**
 * @param {string} apiKey
 * @param {string} model
 * @param {{ mimeType: string, data: string }} image
 * @param {boolean} [withThinking]
 */
async function callGeminiVision(apiKey, model, image, withThinking = true) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;

  /** @type {Record<string, unknown>} */
  const generationConfig = {
    responseMimeType: 'application/json',
  };
  if (withThinking) {
    generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inlineData: { mimeType: image.mimeType, data: image.data } },
            { text: buildFlyerPrompt() },
          ],
        },
      ],
      generationConfig,
    }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    const mapped = mapGeminiError(res.status, bodyText);
    const err = new Error(mapped || `HTTP ${res.status}`);
    err.code = mapped === 'model_not_found' ? 'model_not_found' : 'http';
    err.status = res.status;
    err.body = bodyText;
    if (!withThinking) err._retriedNoThinking = true;
    throw err;
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    const err = new Error('レスポンスの解析に失敗しました。');
    err.code = 'parse';
    throw err;
  }

  const textOut =
    data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || '')
      .join('') || '';

  if (!textOut) {
    const block = data?.promptFeedback?.blockReason;
    const err = new Error(
      block
        ? `リクエストがブロックされました（${block}）。`
        : 'AIから有効な応答がありませんでした。',
    );
    err.code = 'empty';
    throw err;
  }

  return extractJsonArray(textOut);
}

async function callGeminiVisionWithFallback(apiKey, image) {
  let lastError = null;
  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i];
    try {
      return await callGeminiVision(apiKey, model, image, true);
    } catch (err) {
      lastError = err;
      const retry =
        err.code === 'model_not_found' ||
        err.status === 404 ||
        (typeof err.body === 'string' &&
          /not found|NOT_FOUND|unsupported/i.test(err.body));
      if (retry && i < GEMINI_MODELS.length - 1) {
        continue;
      }
      if (
        typeof err.body === 'string' &&
        /thinking/i.test(err.body) &&
        !err._retriedNoThinking
      ) {
        try {
          return await callGeminiVision(apiKey, model, image, false);
        } catch (err2) {
          lastError = err2;
          if (i < GEMINI_MODELS.length - 1) continue;
          throw err2;
        }
      }
      throw err;
    }
  }
  throw lastError || new Error('Gemini呼び出しに失敗しました。');
}

function normalizeFlyerCandidates(extracted) {
  const fallbackStore = normalizeStore(els.store.value);
  const out = [];
  const seen = new Set();
  for (const raw of extracted) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || '').trim();
    if (!name) continue;
    let qty = String(raw.quantity ?? raw.qty ?? '').trim();
    let store = normalizeStore(raw.store ?? raw.destination ?? '');
    const price = String(raw.price || '').trim();
    if (!store && fallbackStore) store = fallbackStore;
    const key = `${name.toLowerCase()}|${qty}|${store}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, qty, store, price });
    if (out.length >= 40) break;
  }
  return out;
}

function renderFlyerCandidates(candidates) {
  clearMealPlan();
  els.flyerCandidateList.innerHTML = '';
  if (!candidates.length) {
    els.flyerReview.hidden = true;
    els.flyerAddBtn.disabled = true;
    return;
  }
  els.flyerReview.hidden = false;

  for (const cand of candidates) {
    const li = document.createElement('li');
    li.className = 'flyer-candidate';
    li.dataset.price = cand.price || '';

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'flyer-candidate-check';
    check.checked = true;
    check.setAttribute('aria-label', `${cand.name}を追加`);

    const fields = document.createElement('div');
    fields.className = 'flyer-candidate-fields';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'flyer-cand-input flyer-cand-name';
    nameInput.value = cand.name;
    nameInput.maxLength = 80;
    nameInput.setAttribute('aria-label', '商品名');
    nameInput.placeholder = '商品名';

    const meta = document.createElement('div');
    meta.className = 'flyer-cand-meta';

    const qtyInput = document.createElement('input');
    qtyInput.type = 'text';
    qtyInput.className = 'flyer-cand-input flyer-cand-qty';
    qtyInput.value = cand.qty;
    qtyInput.maxLength = 40;
    qtyInput.placeholder = '数量';
    qtyInput.setAttribute('aria-label', '数量');

    const storeInput = document.createElement('input');
    storeInput.type = 'text';
    storeInput.className = 'flyer-cand-input flyer-cand-store';
    storeInput.value = cand.store;
    storeInput.maxLength = 40;
    storeInput.placeholder = '購入先';
    storeInput.setAttribute('list', 'store-suggestions');
    storeInput.setAttribute('aria-label', '購入先');

    meta.append(qtyInput, storeInput);
    fields.append(nameInput, meta);

    if (cand.price) {
      const priceEl = document.createElement('p');
      priceEl.className = 'flyer-cand-price';
      priceEl.textContent = `参考価格: ${cand.price}`;
      fields.appendChild(priceEl);
    }

    check.addEventListener('change', updateFlyerAddButtonState);
    nameInput.addEventListener('input', updateFlyerAddButtonState);

    li.append(check, fields);
    els.flyerCandidateList.appendChild(li);
  }

  updateFlyerAddButtonState();
}

function updateFlyerAddButtonState() {
  const rows = [...els.flyerCandidateList.querySelectorAll('.flyer-candidate')];
  const any = rows.some((row) => {
    const checked = row.querySelector('.flyer-candidate-check')?.checked;
    const name = row.querySelector('.flyer-cand-name')?.value.trim();
    return checked && name;
  });
  els.flyerAddBtn.disabled = !any || flyerBusy;
}

function setFlyerBusy(busy) {
  flyerBusy = busy;
  els.flyerUrlBtn.disabled = busy;
  els.flyerFileInput.disabled = busy;
  for (const btn of document.querySelectorAll('.flyer-preset-btn')) {
    btn.disabled = busy;
  }
  els.flyerClearBtn.disabled = busy;
  els.tabMemo.disabled = busy;
  els.tabFlyer.disabled = busy;
  els.flyerAddBtn.disabled = busy || els.flyerAddBtn.disabled;
  if (els.flyerMealBtn) {
    els.flyerMealBtn.disabled = busy || mealBusy;
    els.flyerMealBtn.classList.toggle('busy', busy || mealBusy);
  }
  if (els.flyerPageList) {
    for (const btn of els.flyerPageList.querySelectorAll('.flyer-page-btn')) {
      btn.disabled = busy;
    }
  }
  if (!busy) updateFlyerAddButtonState();
}

async function analyzeFlyerImage(prepared) {
  clearFlyerPreview();
  clearFlyerReview();
  flyerImagePayload = { mimeType: prepared.mimeType, data: prepared.data };
  flyerPreviewUrl = prepared.previewUrl;
  els.flyerPreview.src = prepared.previewUrl;
  els.flyerPreviewWrap.hidden = false;

  const apiKey = getApiKey();
  if (!apiKey) {
    setFlyerStatus('画像は取得できました。APIキーが未設定です。設定を開いてください。', true);
    openSettings();
    setFlyerBusy(false);
    return;
  }

  setFlyerBusy(true);
  setFlyerStatus('チラシを解析しています…');

  try {
    const extracted = await callGeminiVisionWithFallback(apiKey, flyerImagePayload);
    const candidates = normalizeFlyerCandidates(extracted);
    if (!candidates.length) {
      setFlyerStatus('商品が見つかりませんでした。別の画像を試してください。', true);
      return;
    }
    renderFlyerCandidates(candidates);
    setFlyerStatus(`${candidates.length} 件見つかりました。追加するものを選んでください`);
  } catch (err) {
    setFlyerStatus(friendlyAiError(err), true);
  } finally {
    setFlyerBusy(false);
  }
}

async function handleFlyerFile(file) {
  if (!file) return;
  if (file.type && !file.type.startsWith('image/')) {
    setFlyerStatus('画像ファイルを選択してください。', true);
    return;
  }
  setFlyerBusy(true);
  setFlyerStatus('画像を準備しています…');
  clearFlyerPagePicker();
  clearFlyerReview();
  try {
    const prepared = await prepareImageForGemini(file);
    await analyzeFlyerImage(prepared);
  } catch (err) {
    setFlyerStatus(err?.message || '画像の処理に失敗しました。', true);
    setFlyerBusy(false);
  }
}

/**
 * Build Worker endpoint for image fetch (?url=) or viewer resolve (?resolve=).
 * @param {'url' | 'resolve'} mode
 * @param {string} target
 * @returns {string}
 */
function buildFlyerProxyEndpoint(mode, target) {
  const proxyBase = getFlyerProxyUrl();
  if (!proxyBase) {
    throw new Error(
      'ビューアURLの解析にはプロキシ設定が必要です。設定でチラシ画像プロキシURLを保存してください。',
    );
  }
  let u;
  try {
    u = new URL(proxyBase);
  } catch {
    throw new Error('設定のプロキシURLが不正です。設定を確認してください。');
  }
  const path = u.pathname.replace(/\/$/, '') || '';
  const param = mode === 'resolve' ? 'resolve' : 'url';
  return `${u.origin}${path}/?${param}=${encodeURIComponent(target)}`;
}

function proxyRequestHeaders() {
  /** @type {Record<string, string>} */
  const headers = {};
  const secret = getFlyerProxySecret();
  if (secret) headers['X-Proxy-Secret'] = secret;
  return headers;
}

/**
 * @param {URL} parsed
 */
function isDirectImageUrl(parsed) {
  return /\.(jpe?g|png|gif|webp|bmp|avif|heic)(\?|#|$)/i.test(parsed.pathname);
}

/**
 * Aeon chirashi viewer: host + /viewer/ + s_id + f_id
 * @param {URL} parsed
 */
function isAeonViewerUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  if (host !== 'chirashi.otoku.aeonsquare.net') return false;
  if (!parsed.pathname.includes('/viewer/')) return false;
  const sId = parsed.searchParams.get('s_id');
  const fId = parsed.searchParams.get('f_id');
  return Boolean(sId && fId);
}

/**
 * Uoroku store flyer page (embeds Kurashiru widget)
 * @param {URL} parsed
 */
function isUorokuFlyerPageUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith('uoroku.co.jp')) return false;
  return parsed.pathname.includes('/shop/flyer/');
}

/**
 * Aeon STORE page (www.aeon.com/store/...). Worker reads data-flyer-id.
 * @param {URL} parsed
 */
function isAeonStorePageUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  if (host !== 'www.aeon.com' && host !== 'aeon.com') return false;
  return /^\/store\/[^/].+/i.test(parsed.pathname) && !parsed.pathname.includes('..');
}

/**
 * Harashin shop page with embedded flyer images.
 * @param {URL} parsed
 */
function isHarashinShopUrl(parsed) {
  const host = parsed.hostname.toLowerCase();
  if (host !== 'www.harashinnarus.jp' && host !== 'harashinnarus.jp') return false;
  return /^\/shops\/[a-z0-9_-]+\/?$/i.test(parsed.pathname);
}

/**
 * Kurashiru chirashi widget or store page
 * @param {URL} parsed
 */
function isKurashiruWidgetOrStoreUrl(parsed) {
  if (parsed.hostname.toLowerCase() !== 'chirashi.kurashiru.com') return false;
  const path = parsed.pathname || '';
  if (/^\/widgets\/[^/]+\/leaflets\/?$/i.test(path)) return true;
  if (/^\/stores\/[^/]+/i.test(path)) return true;
  return false;
}

/**
 * Viewer / store URLs the Worker can resolve to an image list
 * @param {URL} parsed
 */
function isResolvableFlyerViewerUrl(parsed) {
  return (
    isAeonViewerUrl(parsed) ||
    isAeonStorePageUrl(parsed) ||
    isUorokuFlyerPageUrl(parsed) ||
    isKurashiruWidgetOrStoreUrl(parsed) ||
    isHarashinShopUrl(parsed)
  );
}

/**
 * Fetch an image blob either via configured Cloudflare Worker proxy
 * or direct browser fetch (CORS-limited).
 * @param {string} imageUrl
 * @returns {Promise<Blob>}
 */
async function fetchFlyerImageBlob(imageUrl) {
  const proxyBase = getFlyerProxyUrl();
  if (proxyBase) {
    let proxyEndpoint;
    try {
      proxyEndpoint = buildFlyerProxyEndpoint('url', imageUrl);
    } catch (err) {
      throw new Error(err?.message || '設定のプロキシURLが不正です。設定を確認してください。');
    }

    const headers = proxyRequestHeaders();

    let res;
    try {
      res = await fetch(proxyEndpoint, { method: 'GET', mode: 'cors', headers });
    } catch {
      throw new Error(
        'プロキシ経由で画像を取得できませんでした。プロキシURL・ネットワークを確認するか、写真から追加してください。',
      );
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok) {
      let detail = '';
      if (contentType.includes('application/json')) {
        try {
          const j = await res.json();
          detail = j.message || j.error || '';
        } catch {
          /* ignore */
        }
      }
      if (res.status === 401) {
        throw new Error(
          'プロキシ認証に失敗しました。設定のシークレットを確認してください。',
        );
      }
      throw new Error(
        detail ||
          `プロキシが画像を取得できませんでした（HTTP ${res.status}）。写真から追加してください。`,
      );
    }

    if (
      contentType &&
      !contentType.startsWith('image/') &&
      !contentType.includes('octet-stream')
    ) {
      throw new Error(
        'プロキシの応答が画像ではありません。画像の直リンクを指定してください。',
      );
    }
    const blob = await res.blob();
    if (
      blob.type &&
      !blob.type.startsWith('image/') &&
      blob.type !== 'application/octet-stream'
    ) {
      throw new Error(
        'プロキシの応答が画像ではありません。画像の直リンクを指定してください。',
      );
    }
    return blob;
  }

  // Direct fetch (often blocked by CORS)
  let res;
  try {
    res = await fetch(imageUrl, { mode: 'cors' });
  } catch {
    throw new Error(FLYER_CORS_ERROR);
  }
  if (!res.ok) {
    throw new Error(FLYER_CORS_ERROR);
  }
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (
    contentType &&
    !contentType.startsWith('image/') &&
    !contentType.includes('octet-stream')
  ) {
    throw new Error(
      'このURLは画像ではないようです。画像の直リンクを指定するか、写真から追加してください。',
    );
  }
  const blob = await res.blob();
  if (
    blob.type &&
    !blob.type.startsWith('image/') &&
    blob.type !== 'application/octet-stream'
  ) {
    throw new Error(
      'このURLは画像ではないようです。画像の直リンクを指定するか、写真から追加してください。',
    );
  }
  return blob;
}

/**
 * Ask Worker to resolve a flyer viewer URL into image list.
 * @param {string} viewerUrl
 * @returns {Promise<{ source: string, title?: string, images: { url: string, thumbUrl?: string, label?: string }[] }>}
 */
async function resolveFlyerViewerViaProxy(viewerUrl) {
  const endpoint = buildFlyerProxyEndpoint('resolve', viewerUrl);
  const headers = proxyRequestHeaders();

  let res;
  try {
    res = await fetch(endpoint, { method: 'GET', mode: 'cors', headers });
  } catch {
    throw new Error(
      'ビューアの解析に失敗しました。プロキシURL・ネットワークを確認するか、写真から追加してください。',
    );
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  let body = null;
  if (contentType.includes('application/json')) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        'プロキシ認証に失敗しました。設定のシークレットを確認してください。',
      );
    }
    const detail =
      (body && (body.message || body.error)) ||
      `ビューアの解析に失敗しました（HTTP ${res.status}）。写真から追加してください。`;
    throw new Error(String(detail));
  }

  if (!body || !Array.isArray(body.images) || !body.images.length) {
    throw new Error(
      'チラシ画像が見つかりませんでした。URLを確認するか、写真から追加してください。',
    );
  }
  return body;
}

/**
 * @param {string} imageUrl
 */
async function analyzeFlyerImageFromUrl(imageUrl) {
  clearFlyerPagePicker();
  const viaProxy = Boolean(getFlyerProxyUrl());
  setFlyerBusy(true);
  setFlyerStatus(
    viaProxy ? 'プロキシ経由で画像を取得しています…' : 'URLから画像を取得しています…',
  );
  clearFlyerReview();
  try {
    const blob = await fetchFlyerImageBlob(imageUrl);
    const prepared = await prepareImageForGemini(blob);
    await analyzeFlyerImage(prepared);
  } catch (err) {
    const msg =
      err?.message === FLYER_CORS_ERROR
        ? FLYER_CORS_ERROR
        : err?.message || FLYER_CORS_ERROR;
    setFlyerStatus(msg, true);
    setFlyerBusy(false);
  }
}

/**
 * @param {{ url: string, thumbUrl?: string, label?: string }[]} images
 * @param {string} [title]
 */
function renderFlyerPagePicker(images, title) {
  clearFlyerPagePicker();
  if (!els.flyerPagePicker || !els.flyerPageList) return;

  const titleEl = els.flyerPagePicker.querySelector('.flyer-page-picker-title');
  if (titleEl) {
    titleEl.textContent = title
      ? `「${title}」のページを選んでください`
      : 'ページを選んでください';
  }

  els.flyerPagePicker.hidden = false;

  images.forEach((img, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'flyer-page-btn';
    btn.setAttribute('role', 'listitem');
    const label = img.label || `${index + 1}枚目`;
    btn.setAttribute('aria-label', label);

    const labelEl = document.createElement('span');
    labelEl.className = 'flyer-page-label';
    labelEl.textContent = label;
    btn.appendChild(labelEl);

    btn.addEventListener('click', () => {
      if (flyerBusy) return;
      analyzeFlyerImageFromUrl(img.url);
    });

    els.flyerPageList.appendChild(btn);

    // Optional thumb via proxy (supports secret header)
    const thumbSrc = img.thumbUrl || img.url;
    if (thumbSrc && getFlyerProxyUrl()) {
      fetchFlyerImageBlob(thumbSrc)
        .then((blob) => {
          if (!btn.isConnected) return;
          const objectUrl = URL.createObjectURL(blob);
          btn.dataset.thumbObjectUrl = objectUrl;
          const thumb = document.createElement('img');
          thumb.className = 'flyer-page-thumb';
          thumb.alt = '';
          thumb.src = objectUrl;
          btn.insertBefore(thumb, labelEl);
        })
        .catch(() => {
          /* thumbs are optional */
        });
    }
  });
}

/**
 * Resolve a supported flyer viewer/store URL via Worker, then show page picker.
 * @param {string} viewerHref
 */
async function handleFlyerViewerUrl(viewerHref) {
  if (!getFlyerProxyUrl()) {
    setFlyerStatus(
      'ビューアURLの解析にはプロキシ設定が必要です。設定でチラシ画像プロキシURLを保存するか、写真から追加してください。',
      true,
    );
    openSettings();
    return;
  }

  setFlyerBusy(true);
  clearFlyerPagePicker();
  clearFlyerReview();
  clearFlyerPreview();
  setFlyerStatus('ビューアからチラシ画像を探しています…');

  try {
    const resolved = await resolveFlyerViewerViaProxy(viewerHref);
    const images = resolved.images.filter((x) => x && x.url);
    if (!images.length) {
      setFlyerStatus(
        'チラシ画像が見つかりませんでした。URLを確認するか、写真から追加してください。',
        true,
      );
      setFlyerBusy(false);
      return;
    }

    setFlyerStatus(`${images.length}枚見つかりました`);

    if (images.length === 1) {
      await analyzeFlyerImageFromUrl(images[0].url);
      return;
    }

    setFlyerBusy(false);
    renderFlyerPagePicker(images, resolved.title || '');
  } catch (err) {
    setFlyerStatus(
      err?.message ||
        'ビューアの解析に失敗しました。写真から追加してください。',
      true,
    );
    setFlyerBusy(false);
  }
}

async function handleFlyerUrl() {
  const raw = els.flyerUrlInput.value.trim();
  if (!raw) {
    setFlyerStatus('画像またはビューアのURLを入力してください。', true);
    return;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    setFlyerStatus('URLの形式が正しくありません。', true);
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    setFlyerStatus('http または https のURLを指定してください。', true);
    return;
  }

  // Viewer / store URL takes priority over treating it as a (non-image) page
  if (isResolvableFlyerViewerUrl(parsed)) {
    await handleFlyerViewerUrl(parsed.href);
    return;
  }

  // Direct image URL (extension) or unknown URL → existing image fetch flow
  const viaProxy = Boolean(getFlyerProxyUrl());
  if (!isDirectImageUrl(parsed) && !viaProxy) {
    setFlyerStatus(
      '画像の直リンク、またはイオン／ウオロク／クラシル／原信のチラシURLを指定してください。プロキシ未設定の場合は写真から追加もできます。',
      true,
    );
    return;
  }

  await analyzeFlyerImageFromUrl(parsed.href);
}


function buildMealPrompt(candidates) {
  const lines = candidates.map((c) => {
    const parts = [`name: ${c.name}`];
    if (c.qty) parts.push(`qty: ${c.qty}`);
    if (c.store) parts.push(`store: ${c.store}`);
    if (c.price) parts.push(`price: ${c.price}`);
    return `- ${parts.join(', ')}`;
  });
  return [
    'あなたは家庭の夕食献立を提案するアシスタントです。',
    '次の特売候補だけを手がかりに、夜の食事（夕食）を提案してください。',
    '夕食はちょうど3日分、各2人分です。',
    '特売品は主材料でなくてもかまいません。副菜、汁物、添え、調味としての使い方でもよいです。',
    '各日は、与えられた特売品を少なくとも1つ使ってください。特売品を1つも使わない日は作らないでください。',
    '価格や合計金額を捏造しないでください。価格に触れる場合は、入力の price 文字列をそのまま写すだけにしてください。',
    '足りない主食・調味料・買い足しは extras に入れてください。チラシにあるかのように装わないでください。',
    'uses.name は入力の name をそのままコピーしてください。別の商品名に言い換えないでください。',
    'uses.store は、その特売の store が入力にあるときだけ、その文字列をコピーしてください。無ければ空文字。',
    'extras.store は店が分かるときだけ入れ、不明なら空文字にしてください。',
    'steps は各日ちょうど3つにしてください。',
    '出力は JSON のみ。マークダウンのコードフェンスは付けないでください。',
    '形式: {"days":[{"title":"料理名","uses":[{"name":"特売品名","store":"店"}],"extras":[{"name":"買い足し","store":"店または空","why":"短い理由"}],"steps":["手順","手順","手順"]}]}',
    '',
    '【特売候補】',
    lines.join('\n'),
  ].join('\n');
}

function extractJsonObject(text) {
  const cleaned = String(text || '')
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    /* fall through */
  }
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    const parsed = JSON.parse(match[0]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }
  throw new Error('parse');
}

/**
 * Text generateContent. No image parts.
 * HTTP >= 500 is a hard failure (caller must not fall through to another model).
 * @param {string} apiKey
 * @param {string} model
 * @param {string} promptText
 * @param {boolean} withThinking
 */
async function callGeminiGenerate(apiKey, model, promptText, withThinking) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model,
  )}:generateContent`;

  /** @type {Record<string, unknown>} */
  const generationConfig = {
    responseMimeType: 'application/json',
  };
  if (withThinking) {
    generationConfig.thinkingConfig = { thinkingLevel: 'low' };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: promptText }] }],
      generationConfig,
    }),
  });

  const bodyText = await res.text();
  if (!res.ok) {
    const mapped = mapGeminiError(res.status, bodyText);
    const err = new Error(mapped || `HTTP ${res.status}`);
    err.code = mapped === 'model_not_found' ? 'model_not_found' : 'http';
    err.status = res.status;
    err.body = bodyText;
    if (!withThinking) err._retriedNoThinking = true;
    throw err;
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    const err = new Error('レスポンスの解析に失敗しました。');
    err.code = 'parse';
    throw err;
  }

  const textOut =
    data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || '')
      .join('') || '';

  if (!textOut) {
    const block = data?.promptFeedback?.blockReason;
    const err = new Error(
      block
        ? `リクエストがブロックされました（${block}）。`
        : 'AIから有効な応答がありませんでした。',
    );
    err.code = 'empty';
    throw err;
  }

  return textOut;
}

/** Model-not-found / 404 / unsupported only. Never when HTTP >= 500. */
function canFallbackGeminiModel(err) {
  if (typeof err?.status === 'number' && err.status >= 500) return false;
  return (
    err?.code === 'model_not_found' ||
    err?.status === 404 ||
    (typeof err?.body === 'string' &&
      /not found|NOT_FOUND|unsupported/i.test(err.body))
  );
}

function isThinkingConfigRejection(err) {
  if (typeof err?.status === 'number' && err.status >= 500) return false;
  return (
    typeof err?.body === 'string' &&
    /thinking/i.test(err.body) &&
    !err._retriedNoThinking
  );
}

async function callGeminiJsonWithFallback(apiKey, promptText) {
  let lastError = null;
  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i];
    try {
      const textOut = await callGeminiGenerate(apiKey, model, promptText, true);
      return extractJsonObject(textOut);
    } catch (err) {
      lastError = err;
      if (isThinkingConfigRejection(err)) {
        try {
          const textOut = await callGeminiGenerate(apiKey, model, promptText, false);
          return extractJsonObject(textOut);
        } catch (err2) {
          lastError = err2;
          if (canFallbackGeminiModel(err2) && i < GEMINI_MODELS.length - 1) {
            continue;
          }
          throw err2;
        }
      }
      if (canFallbackGeminiModel(err) && i < GEMINI_MODELS.length - 1) {
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('Gemini呼び出しに失敗しました。');
}

/**
 * @param {string} name
 * @param {string} store
 * @param {{ name: string, qty: string, store: string, price: string }[]} candidates
 */
function findSaleCandidate(name, store, candidates) {
  const n = String(name || '').trim();
  if (!n) return null;
  const s = normalizeStore(store);
  if (s) {
    const exact = candidates.find(
      (c) => c.name === n && normalizeStore(c.store) === s,
    );
    if (exact) return exact;
  }
  const sameName = candidates.filter((c) => c.name === n);
  if (sameName.length === 1) return sameName[0];
  if (sameName.length > 1 && !s) return sameName[0];
  return null;
}

/**
 * Keep only days that use at least one provided sale name (copied, not paraphrased).
 * @param {unknown} parsed
 * @param {{ name: string, qty: string, store: string, price: string }[]} candidates
 */
function normalizeMealDays(parsed, candidates) {
  const rawDays = parsed && Array.isArray(parsed.days) ? parsed.days : [];
  const saleNames = new Set(candidates.map((c) => c.name));
  const days = [];
  for (const raw of rawDays) {
    if (!raw || typeof raw !== 'object') continue;
    const title = String(raw.title || '').trim();
    if (!title) continue;

    const uses = [];
    const seenUse = new Set();
    const useList = Array.isArray(raw.uses) ? raw.uses : [];
    for (const u of useList) {
      const src = findSaleCandidate(u?.name, u?.store, candidates);
      if (!src) continue;
      const key = `${src.name}|${src.qty}|${src.store}`;
      if (seenUse.has(key)) continue;
      seenUse.add(key);
      uses.push({ name: src.name, store: normalizeStore(src.store) });
    }
    if (!uses.length) continue;

    const extras = [];
    const seenExtra = new Set();
    const extraList = Array.isArray(raw.extras) ? raw.extras : [];
    for (const e of extraList) {
      const name = String(e?.name || '').trim();
      if (!name || saleNames.has(name)) continue;
      const key = name.toLowerCase();
      if (seenExtra.has(key)) continue;
      seenExtra.add(key);
      extras.push({
        name,
        store: normalizeStore(e?.store),
        why: String(e?.why || '').trim(),
      });
    }

    const steps = (Array.isArray(raw.steps) ? raw.steps : [])
      .map((s) => String(s || '').trim())
      .filter(Boolean)
      .slice(0, 3);

    days.push({ title, uses, extras, steps });
    if (days.length >= 3) break;
  }
  return days;
}

/** If every use that day has the same non-empty store, return it. */
function sharedUseStore(uses) {
  if (!uses.length) return '';
  const stores = uses.map((u) => normalizeStore(u.store));
  if (stores.every((s) => s && s === stores[0])) return stores[0];
  return '';
}

function resolveExtraStore(extra, day) {
  const given = normalizeStore(extra.store);
  if (given) return given;
  return sharedUseStore(day.uses);
}

function friendlyMealError(err) {
  const msg = friendlyAiError(err);
  if (
    msg === 'AI整理に失敗しました。' ||
    msg === 'AI整理に失敗しました。しばらくしてから再試行してください。'
  ) {
    return '献立の作成に失敗しました。しばらくしてから再試行してください。';
  }
  return msg;
}

function renderMealPlan(days) {
  els.flyerMealList.innerHTML = '';
  els.flyerMeals.hidden = false;

  days.forEach((day, index) => {
    const card = document.createElement('article');
    card.className = 'meal-day';

    const title = document.createElement('h3');
    title.className = 'meal-day-title';
    title.textContent = `${index + 1}日目　${day.title}`;

    const usesLabel = document.createElement('p');
    usesLabel.className = 'meal-label';
    usesLabel.textContent = '使う特売';
    const usesList = document.createElement('ul');
    usesList.className = 'meal-uses';
    for (const u of day.uses) {
      const li = document.createElement('li');
      li.textContent = u.store ? `${u.name}（${u.store}）` : u.name;
      usesList.appendChild(li);
    }

    const extrasLabel = document.createElement('p');
    extrasLabel.className = 'meal-label';
    extrasLabel.textContent = '買い足し';
    const extrasList = document.createElement('ul');
    extrasList.className = 'meal-extras';
    if (!day.extras.length) {
      const li = document.createElement('li');
      li.className = 'meal-none';
      li.textContent = 'なし';
      extrasList.appendChild(li);
    } else {
      for (const extra of day.extras) {
        const li = document.createElement('li');
        const store = resolveExtraStore(extra, day);
        let text = extra.name;
        if (store) text += `（${store}）`;
        if (extra.why) text += ` — ${extra.why}`;
        li.textContent = text;
        extrasList.appendChild(li);
      }
    }

    const stepsLabel = document.createElement('p');
    stepsLabel.className = 'meal-label';
    stepsLabel.textContent = '手順';
    const stepsList = document.createElement('ol');
    stepsList.className = 'meal-steps';
    for (const step of day.steps) {
      const li = document.createElement('li');
      li.textContent = step;
      stepsList.appendChild(li);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'meal-add-btn';
    if (!day.extras.length) {
      addBtn.disabled = true;
      addBtn.textContent = '買い足しはありません';
    } else {
      addBtn.textContent = 'この日の買い足しをメモに追加';
      addBtn.addEventListener('click', () => addDayExtras(day, addBtn));
    }

    card.append(
      title,
      usesLabel,
      usesList,
      extrasLabel,
      extrasList,
      stepsLabel,
      stepsList,
      addBtn,
    );
    els.flyerMealList.appendChild(card);
  });
}

function addDayExtras(day, btn) {
  if (btn.disabled) return;
  const already = new Set(
    (btn.dataset.addedNames || '').split('\n').filter(Boolean),
  );
  const pending = day.extras.filter((extra) => {
    const name = String(extra.name || '').trim();
    return name && !already.has(name);
  });
  if (!pending.length) {
    btn.disabled = true;
    btn.textContent = '追加済み';
    return;
  }
  btn.disabled = true;
  const added = [];
  for (const extra of pending) {
    const name = extra.name.trim();
    addItem(name, '', resolveExtraStore(extra, day));
    already.add(name);
    added.push(name);
  }
  btn.dataset.addedNames = [...already].join('\n');
  btn.textContent = '追加しました';
  setFlyerStatus(`買い足し ${added.length} 件をメモに追加しました`);
}

function syncMealButtonBusy() {
  if (!els.flyerMealBtn) return;
  els.flyerMealBtn.disabled = flyerBusy || mealBusy;
  els.flyerMealBtn.classList.toggle('busy', flyerBusy || mealBusy);
}

async function proposeMealsFromFlyer() {
  if (mealBusy || flyerBusy) return;

  const selected = collectCheckedFlyerCandidates();
  if (!selected.length) {
    setFlyerStatus('献立に使う特売を選択してください。', true);
    return;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    setFlyerStatus('APIキーが未設定です。設定を開いてください。', true);
    openSettings();
    return;
  }

  const epoch = mealEpoch;
  mealBusy = true;
  syncMealButtonBusy();
  setFlyerStatus('献立を考えています…');

  try {
    const parsed = await callGeminiJsonWithFallback(apiKey, buildMealPrompt(selected));
    if (epoch !== mealEpoch) return;
    const days = normalizeMealDays(parsed, selected);
    if (!days.length) {
      clearMealPlan();
      // clearMealPlan bumps epoch; keep the message after that
      setFlyerStatus('特売を使った献立を作れませんでした。もう一度試してください。', true);
      return;
    }
    renderMealPlan(days);
    if (days.length < 3) {
      setFlyerStatus(
        `${days.length}日分だけ作れました。特売の組み合わせを変えて再試行できます。`,
      );
    } else {
      setFlyerStatus('3日分の献立です。買い足しだけメモに追加できます。');
    }
  } catch (err) {
    if (epoch !== mealEpoch) return;
    setFlyerStatus(friendlyMealError(err), true);
  } finally {
    mealBusy = false;
    syncMealButtonBusy();
  }
}

function collectCheckedFlyerCandidates() {
  const rows = [...els.flyerCandidateList.querySelectorAll('.flyer-candidate')];
  const result = [];
  for (const row of rows) {
    const checked = row.querySelector('.flyer-candidate-check')?.checked;
    if (!checked) continue;
    const name = row.querySelector('.flyer-cand-name')?.value.trim() || '';
    if (!name) continue;
    const qty = row.querySelector('.flyer-cand-qty')?.value.trim() || '';
    const store = normalizeStore(row.querySelector('.flyer-cand-store')?.value || '');
    const price = String(row.dataset.price || '').trim();
    result.push({ name, qty, store, price });
  }
  return result;
}

function collectCheckedFlyerItems() {
  const rows = [...els.flyerCandidateList.querySelectorAll('.flyer-candidate')];
  const result = [];
  for (const row of rows) {
    const checked = row.querySelector('.flyer-candidate-check')?.checked;
    if (!checked) continue;
    const name = row.querySelector('.flyer-cand-name')?.value.trim() || '';
    if (!name) continue;
    const qty = row.querySelector('.flyer-cand-qty')?.value.trim() || '';
    const store = row.querySelector('.flyer-cand-store')?.value || '';
    result.push({ name, quantity: qty, store });
  }
  return result;
}

function addSelectedFlyerItems() {
  const selected = collectCheckedFlyerItems();
  if (!selected.length) {
    setFlyerStatus('追加するアイテムを選択してください。', true);
    return;
  }
  const count = addItemsFromAi(selected);
  resetFlyerPanelState();
  setActiveTab('memo');
  if (count === 0) {
    setStatus('すでに同じ内容がリストにあるため追加されませんでした', true);
  } else {
    setStatus(`チラシから ${count} 件をリストに追加しました`);
  }
}

function onTabClick(tab) {
  if (flyerBusy && tab !== activeTab) {
    setFlyerStatus('解析中です。完了するまでお待ちください。', true);
    return;
  }
  if (tab === 'flyer') {
    const apiKey = getApiKey();
    if (!apiKey) {
      setStatus('APIキーが未設定です。設定を開いてください。', true);
      openSettings();
      // Still allow switching so user can see the tab after saving key
    }
  }
  setActiveTab(tab);
}

els.tabMemo.addEventListener('click', () => onTabClick('memo'));
els.tabFlyer.addEventListener('click', () => onTabClick('flyer'));

els.tabMemo.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    onTabClick('flyer');
    els.tabFlyer.focus();
  }
});
els.tabFlyer.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    onTabClick('memo');
    els.tabMemo.focus();
  }
});

els.flyerFileInput.addEventListener('change', () => {
  const file = els.flyerFileInput.files?.[0];
  // Clear so the same file can be re-selected later
  els.flyerFileInput.value = '';
  if (file) {
    if (!getApiKey()) {
      setFlyerStatus('APIキーが未設定です。設定を開いてください。', true);
      openSettings();
      return;
    }
    handleFlyerFile(file);
  }
});

els.flyerUrlBtn.addEventListener('click', () => {
  if (!getApiKey()) {
    setFlyerStatus('APIキーが未設定です。設定を開いてください。', true);
    openSettings();
    return;
  }
  handleFlyerUrl();
});

for (const btn of document.querySelectorAll('.flyer-preset-btn')) {
  btn.addEventListener('click', () => {
    if (flyerBusy) return;
    const preset = FLYER_PRESETS.find((p) => p.id === btn.dataset.flyerPreset);
    if (!preset) return;
    if (!getApiKey()) {
      setFlyerStatus('APIキーが未設定です。設定を開いてください。', true);
      openSettings();
      return;
    }
    els.flyerUrlInput.value = preset.url;
    handleFlyerUrl();
  });
}

els.flyerUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!getApiKey()) {
      setFlyerStatus('APIキーが未設定です。設定を開いてください。', true);
      openSettings();
      return;
    }
    handleFlyerUrl();
  }
});

els.flyerSelectAll.addEventListener('click', () => {
  for (const cb of els.flyerCandidateList.querySelectorAll('.flyer-candidate-check')) {
    cb.checked = true;
  }
  updateFlyerAddButtonState();
});

els.flyerDeselectAll.addEventListener('click', () => {
  for (const cb of els.flyerCandidateList.querySelectorAll('.flyer-candidate-check')) {
    cb.checked = false;
  }
  updateFlyerAddButtonState();
});

els.flyerAddBtn.addEventListener('click', () => {
  addSelectedFlyerItems();
});

els.flyerMealBtn.addEventListener('click', () => {
  proposeMealsFromFlyer();
});

els.flyerClearBtn.addEventListener('click', () => {
  if (flyerBusy) return;
  resetFlyerPanelState();
  setFlyerStatus('クリアしました');
});

/* ---------- Voice ---------- */

function initVoice() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    els.mic.hidden = true;
    els.voiceNote.hidden = false;
    els.voiceNote.textContent =
      '音声入力はこのブラウザでは使えません（Chrome / Safari 推奨）';
    return;
  }

  els.mic.hidden = false;
  recognition = new SpeechRecognition();
  recognition.lang = 'ja-JP';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    listening = true;
    els.mic.classList.add('listening');
    els.mic.setAttribute('aria-pressed', 'true');
    setStatus('聞いています… 話してください');
  };

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    els.input.value = transcript.trim();
    if (event.results[event.results.length - 1].isFinal) {
      setStatus(
        '認識しました。「追加」または「AIで整理」を押してください',
      );
    }
  };

  recognition.onerror = (event) => {
    listening = false;
    els.mic.classList.remove('listening');
    els.mic.setAttribute('aria-pressed', 'false');
    const err = event.error;
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      setStatus(
        'マイクの使用が許可されていません。ブラウザの設定で許可してください。',
        true,
      );
    } else if (err === 'no-speech') {
      setStatus('音声が聞こえませんでした。もう一度試してください。', true);
    } else if (err === 'aborted') {
      setStatus('');
    } else {
      setStatus(`音声認識エラー（${err}）`, true);
    }
  };

  recognition.onend = () => {
    listening = false;
    els.mic.classList.remove('listening');
    els.mic.setAttribute('aria-pressed', 'false');
    if (els.voiceStatus.textContent === '聞いています… 話してください') {
      setStatus('');
    }
  };

  els.mic.addEventListener('click', () => {
    if (!recognition) return;
    if (listening) {
      try {
        recognition.stop();
      } catch {
        /* ignore */
      }
      return;
    }
    setStatus('');
    try {
      recognition.start();
    } catch {
      setStatus('音声認識を開始できませんでした。', true);
    }
  });
}

initVoice();
setActiveTab(activeTab);
render();
