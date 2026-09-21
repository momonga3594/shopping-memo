const STORAGE_KEY = 'shopping-memo-items';

/** @typedef {{ id: string, name: string, qty: string, done: boolean }} Item */

const els = {
  form: document.getElementById('add-form'),
  input: document.getElementById('item-input'),
  qty: document.getElementById('qty-input'),
  list: document.getElementById('item-list'),
  empty: document.getElementById('empty-state'),
  count: document.getElementById('item-count'),
  clearDone: document.getElementById('clear-done-btn'),
  mic: document.getElementById('mic-btn'),
  voiceStatus: document.getElementById('voice-status'),
  voiceNote: document.getElementById('voice-note'),
};

/** @type {Item[]} */
let items = loadItems();
let recognition = null;
let listening = false;

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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

function setVoiceStatus(text, isError = false) {
  els.voiceStatus.textContent = text;
  els.voiceStatus.classList.toggle('error', isError);
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

  for (const item of items) {
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

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'delete-btn';
    del.setAttribute('aria-label', `${item.name}を削除`);
    del.textContent = '×';
    del.addEventListener('click', () => deleteItem(item.id));

    li.append(toggle, body, del);
    els.list.appendChild(li);
  }
}

function addItem(name, qty = '') {
  const trimmed = name.trim();
  if (!trimmed) return;
  items.unshift({
    id: uid(),
    name: trimmed,
    qty: qty.trim(),
    done: false,
  });
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
  addItem(els.input.value, els.qty.value);
  els.input.value = '';
  els.qty.value = '';
  els.input.focus();
});

els.clearDone.addEventListener('click', () => {
  if (items.some((i) => i.done)) clearDone();
});

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
    setVoiceStatus('聞いています… 話してください');
  };

  recognition.onresult = (event) => {
    let transcript = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
    }
    els.input.value = transcript.trim();
    if (event.results[event.results.length - 1].isFinal) {
      setVoiceStatus('認識しました。必要なら数量を入れて「追加」を押してください');
    }
  };

  recognition.onerror = (event) => {
    listening = false;
    els.mic.classList.remove('listening');
    els.mic.setAttribute('aria-pressed', 'false');
    const err = event.error;
    if (err === 'not-allowed' || err === 'service-not-allowed') {
      setVoiceStatus(
        'マイクの使用が許可されていません。ブラウザの設定で許可してください。',
        true,
      );
    } else if (err === 'no-speech') {
      setVoiceStatus('音声が聞こえませんでした。もう一度試してください。', true);
    } else if (err === 'aborted') {
      setVoiceStatus('');
    } else {
      setVoiceStatus(`音声認識エラー（${err}）`, true);
    }
  };

  recognition.onend = () => {
    listening = false;
    els.mic.classList.remove('listening');
    els.mic.setAttribute('aria-pressed', 'false');
    if (els.voiceStatus.textContent === '聞いています… 話してください') {
      setVoiceStatus('');
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
    setVoiceStatus('');
    try {
      recognition.start();
    } catch {
      setVoiceStatus('音声認識を開始できませんでした。', true);
    }
  });
}

initVoice();
render();
