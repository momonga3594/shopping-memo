const STORAGE_KEY = 'shopping-memo-items';
const API_KEY_STORAGE = 'shopping-memo-gemini-key';
const UNSET_STORE_LABEL = '未設定';

/** Primary + fallbacks if a model name is unavailable */
const GEMINI_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-2.0-flash',
];

/** @typedef {{ id: string, name: string, qty: string, store: string, done: boolean }} Item */

const els = {
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
  saveKeyBtn: document.getElementById('save-key-btn'),
  clearKeyBtn: document.getElementById('clear-key-btn'),
  settingsStatus: document.getElementById('settings-status'),
  aiBtn: document.getElementById('ai-organize-btn'),
};

/** @type {Item[]} */
let items = loadItems();
let recognition = null;
let listening = false;
let aiBusy = false;

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
  setSettingsStatus(
    getApiKey() ? 'APIキーが保存されています' : 'APIキー未設定',
  );
  els.settingsDialog.showModal();
  els.apiKeyInput.focus();
}

els.settingsBtn.addEventListener('click', openSettings);

els.saveKeyBtn.addEventListener('click', () => {
  const key = els.apiKeyInput.value.trim();
  if (!key) {
    setSettingsStatus('APIキーを入力してください', true);
    return;
  }
  setApiKey(key);
  setSettingsStatus('保存しました（このブラウザのみ）');
});

els.clearKeyBtn.addEventListener('click', () => {
  setApiKey('');
  els.apiKeyInput.value = '';
  setSettingsStatus('APIキーを削除しました');
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
render();
