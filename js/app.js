// app.js — UI controller. Wires the library, the reader, the player, and
// settings together and drives the Reader speech engine.

import { DB } from './db.js';
import { ingestFile } from './ingest.js';
import { Reader, loadVoices } from './tts.js';
import * as AI from './ai.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const reader = new Reader();
const aiReader = new Reader(); // reads AI answers aloud, independent of the book
let currentBook = null;
let voices = [];
let saveTimer = null;

// ------------------------------------------------------------------ helpers
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 3200);
}

function showView(id) {
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === id));
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function fmtCount(n) {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}

function bookProgressPct(book) {
  const p = book.progress || { chapterIndex: 0, sentenceIndex: 0 };
  const total = book.chapters.length || 1;
  return Math.round(((p.chapterIndex) / total) * 100);
}

// ------------------------------------------------------------------ library
async function renderLibrary() {
  const books = await DB.listBooks();
  const list = $('#book-list');
  list.innerHTML = '';
  $('#empty-library').hidden = books.length > 0;

  for (const b of books) {
    const li = document.createElement('li');
    li.className = 'book-card';
    const pct = bookProgressPct(b);
    li.innerHTML = `
      <button class="book-open" data-id="${b.id}">
        <span class="book-badge ${b.type}">${b.type.toUpperCase()}</span>
        <span class="book-info">
          <span class="book-title">${escapeHtml(b.title)}</span>
          <span class="book-meta">${b.chapters.length} chapters · ${fmtCount(b.wordCount || 0)} words</span>
          <span class="book-progress"><span class="book-progress-bar" style="width:${pct}%"></span></span>
        </span>
      </button>
      <button class="book-del icon-btn" data-del="${b.id}" aria-label="Delete">🗑</button>
    `;
    list.appendChild(li);
  }

  list.querySelectorAll('.book-open').forEach((el) =>
    el.addEventListener('click', () => openBook(el.dataset.id)));
  list.querySelectorAll('.book-del').forEach((el) =>
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm('Delete this document from your library?')) {
        await DB.deleteBook(el.dataset.del);
        renderLibrary();
      }
    }));
}

// ------------------------------------------------------------------ import
async function handleFiles(fileList) {
  const files = [...fileList];
  for (const file of files) {
    const overlay = $('#import-overlay');
    overlay.hidden = false;
    $('#import-msg').textContent = `Reading “${file.name}”…`;
    $('#import-bar').style.width = '8%';
    try {
      const book = await ingestFile(file, (frac) => {
        $('#import-bar').style.width = Math.max(8, Math.round(frac * 90)) + '%';
      });
      $('#import-bar').style.width = '100%';
      await DB.saveBook(book);
      await renderLibrary();
      toast(`Added “${book.title}” — ${book.chapters.length} chapters`);
      overlay.hidden = true;
      openBook(book.id);
    } catch (err) {
      overlay.hidden = true;
      console.error(err);
      toast(err.message || 'Could not read that file.');
    }
  }
}

// ------------------------------------------------------------------ reader
async function openBook(id) {
  const book = await DB.getBook(id);
  if (!book) return;
  currentBook = book;

  $('#reader-title').textContent = book.title;
  reader.load(book.chapters, book.progress);
  applyVoiceSettings();
  buildChapterList();
  renderChapter(reader.chapterIndex);
  highlightSentence(reader.sentenceIndex);
  updateChapterMeta();
  updatePlayButton('stopped');
  showView('view-reader');
  window.scrollTo(0, 0);
}

function buildChapterList() {
  const ol = $('#chapter-list');
  ol.innerHTML = '';
  currentBook.chapters.forEach((ch, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<button data-ci="${i}"><span class="ch-num">${i + 1}</span><span class="ch-name">${escapeHtml(ch.title)}</span></button>`;
    ol.appendChild(li);
  });
  ol.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      reader.seek(parseInt(b.dataset.ci, 10), 0);
      reader.play();
      closeChapters();
    }));
}

function markActiveChapter(ci) {
  $$('#chapter-list button').forEach((b) =>
    b.classList.toggle('active', parseInt(b.dataset.ci, 10) === ci));
}

function renderChapter(ci) {
  const ch = currentBook.chapters[ci];
  const area = $('#reading-area');
  const sentences = reader.getSentences();
  area.innerHTML =
    `<h1 class="chapter-heading">${escapeHtml(ch.title)}</h1>` +
    sentences.map((s, i) => `<span class="sent" data-i="${i}">${escapeHtml(s)} </span>`).join('');
  area.querySelectorAll('.sent').forEach((el) =>
    el.addEventListener('click', () => {
      reader.seek(reader.chapterIndex, parseInt(el.dataset.i, 10));
      reader.play();
    }));
  markActiveChapter(ci);
  updateChapterMeta();
}

let activeSentenceEl = null;
function highlightSentence(i) {
  const area = $('#reading-area');
  if (activeSentenceEl) {
    activeSentenceEl.classList.remove('active');
    // restore plain text (remove any word <mark>)
    activeSentenceEl.textContent = activeSentenceEl.dataset.raw || activeSentenceEl.textContent;
  }
  const el = area.querySelector(`.sent[data-i="${i}"]`);
  if (!el) return;
  el.dataset.raw = el.textContent;
  el.classList.add('active');
  activeSentenceEl = el;
  // keep the active sentence comfortably in view
  const r = el.getBoundingClientRect();
  const body = $('#reader-body');
  const margin = window.innerHeight * 0.35;
  if (r.top < 90 || r.bottom > window.innerHeight - margin) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function highlightWord(charIndex, charLength) {
  const el = activeSentenceEl;
  if (!el) return;
  const raw = el.dataset.raw || el.textContent;
  let len = charLength;
  if (!len) {
    const m = raw.slice(charIndex).match(/^\S+/);
    len = m ? m[0].length : 0;
  }
  if (charIndex < 0 || charIndex >= raw.length || len <= 0) return;
  const before = escapeHtml(raw.slice(0, charIndex));
  const word = escapeHtml(raw.slice(charIndex, charIndex + len));
  const after = escapeHtml(raw.slice(charIndex + len));
  el.innerHTML = `${before}<mark class="word">${word}</mark>${after}`;
}

function updateChapterMeta() {
  const total = currentBook.chapters.length;
  const ci = reader.chapterIndex;
  $('#reader-sub').textContent = `Chapter ${ci + 1} of ${total} · ${currentBook.chapters[ci].title}`;
  const sents = reader.getSentences();
  const scrub = $('#scrubber');
  scrub.max = Math.max(1, sents.length - 1);
  scrub.value = reader.sentenceIndex;
}

function updatePlayButton(state) {
  const btn = $('#btn-play');
  const playing = state === 'playing';
  btn.textContent = playing ? '❚❚' : '►';
  btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#player-status').textContent =
    state === 'ended' ? 'Finished' : playing ? 'Reading…' : state === 'paused' ? 'Paused' : '';
}

function saveProgressSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!currentBook) return;
    const progress = { chapterIndex: reader.chapterIndex, sentenceIndex: reader.sentenceIndex };
    currentBook.progress = progress;
    DB.saveProgress(currentBook.id, progress);
  }, 600);
}

// ---- reader engine callbacks ----
reader.onChapterChange = (ci) => {
  if (!currentBook) return;
  renderChapter(ci);
};
reader.onSentenceChange = (ci, si) => {
  highlightSentence(si);
  $('#scrubber').value = si;
  saveProgressSoon();
};
reader.onWord = (charIndex, charLength) => highlightWord(charIndex, charLength);
reader.onStateChange = (state) => updatePlayButton(state);
reader.onEnd = () => toast('Finished reading.');

// ------------------------------------------------------------- chapter drawer
function openChapters() {
  markActiveChapter(reader.chapterIndex);
  $('#chapter-drawer').hidden = false;
  $('#drawer-scrim').hidden = false;
  requestAnimationFrame(() => $('#chapter-drawer').classList.add('open'));
}
function closeChapters() {
  $('#chapter-drawer').classList.remove('open');
  $('#drawer-scrim').hidden = true;
  setTimeout(() => { $('#chapter-drawer').hidden = true; }, 250);
}

// ------------------------------------------------------------------ settings
function populateModelSelect() {
  const sel = $('#sel-model');
  if (sel.options.length === 0) {
    for (const m of AI.MODELS) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label;
      sel.appendChild(o);
    }
  }
  sel.value = AI.getModel();
  $('#inp-apikey').value = AI.getKey();
}

function openSettings() {
  populateVoiceSelect();
  populateModelSelect();
  $('#sheet-settings').hidden = false;
  $('#sheet-scrim').hidden = false;
  requestAnimationFrame(() => $('#sheet-settings').classList.add('open'));
}
function closeSettings() {
  $('#sheet-settings').classList.remove('open');
  $('#sheet-scrim').hidden = true;
  setTimeout(() => { $('#sheet-settings').hidden = true; }, 250);
}

// Score a voice by how natural it's likely to sound. The device's premium /
// enhanced / Siri neural voices are the human-sounding ones; the default
// "compact" voices are the robotic fallback.
function voiceScore(v) {
  const n = (v.name || '').toLowerCase();
  let s = 0;
  if (/premium|neural/.test(n)) s += 45;
  else if (/enhanced/.test(n)) s += 35;
  if (/siri/.test(n)) s += 40;
  if (v.localService) s += 5; // on-device (works offline)
  if ((v.lang || '').toLowerCase().startsWith('en')) s += 12;
  return s;
}
function isNatural(v) {
  return /premium|enhanced|neural|siri/i.test(v.name || '');
}
function rankedVoices() {
  return [...voices].sort((a, b) => voiceScore(b) - voiceScore(a) || a.name.localeCompare(b.name));
}
function bestVoice() {
  const ranked = rankedVoices();
  return ranked.find((v) => (v.lang || '').startsWith('en')) || ranked[0] || null;
}

function populateVoiceSelect() {
  const sel = $('#sel-voice');
  const savedURI = localStorage.getItem('voiceURI');
  sel.innerHTML = '';
  let anyNatural = false;
  for (const v of rankedVoices()) {
    const o = document.createElement('option');
    o.value = v.voiceURI;
    const star = isNatural(v) ? ' ⭐ recommended' : '';
    if (isNatural(v)) anyNatural = true;
    o.textContent = `${v.name} (${v.lang})${star}`;
    if (v.voiceURI === savedURI) o.selected = true;
    sel.appendChild(o);
  }
  // Nudge the user toward downloading a better voice if none are installed.
  const hint = $('#voice-hint');
  if (hint) hint.hidden = anyNatural;
}

function applyVoiceSettings() {
  const savedURI = localStorage.getItem('voiceURI');
  const rate = parseFloat(localStorage.getItem('rate') || '1');
  const pitch = parseFloat(localStorage.getItem('pitch') || '1');
  // Prefer the saved voice; otherwise auto-pick the most natural one available.
  const v = voices.find((x) => x.voiceURI === savedURI) || bestVoice();
  if (v) reader.voice = v;
  reader.rate = rate;
  reader.pitch = pitch;
  $('#rng-rate').value = rate;
  $('#rate-val').textContent = rate.toFixed(1) + '×';
  $('#rng-pitch').value = pitch;
  $('#pitch-val').textContent = pitch.toFixed(1);
  $('#btn-speed').textContent = rate.toFixed(1) + '×';
}

function applyTheme() {
  const theme = localStorage.getItem('theme') || 'system';
  document.documentElement.dataset.theme = theme;
  $('#sel-theme').value = theme;
  const hl = localStorage.getItem('highlight') || '#ffe08a';
  document.documentElement.style.setProperty('--highlight', hl);
  $('#inp-highlight').value = hl;
}

// ------------------------------------------------------------------ AI panel
let aiAbort = null;
let aiLastText = '';

function refreshAiKeyState() {
  const has = AI.hasKey();
  $('#ai-nokey').hidden = has;
  $('#ai-tools').hidden = !has;
}

function openAI() {
  if (!currentBook) return;
  aiReader.stop();
  const ci = reader.chapterIndex;
  $('#ai-context').textContent = `Chapter ${ci + 1}: ${currentBook.chapters[ci].title}`;
  refreshAiKeyState();
  $('#sheet-ai').hidden = false;
  $('#ai-scrim').hidden = false;
  requestAnimationFrame(() => $('#sheet-ai').classList.add('open'));
}
function closeAI() {
  if (aiAbort) { aiAbort.abort(); aiAbort = null; }
  aiReader.stop();
  $('#sheet-ai').classList.remove('open');
  $('#ai-scrim').hidden = true;
  setTimeout(() => { $('#sheet-ai').hidden = true; }, 250);
}

function aiScope() {
  const el = document.querySelector('input[name="ai-scope"]:checked');
  return el ? el.value : 'chapter';
}
function chapterText() {
  return currentBook.chapters[reader.chapterIndex].text;
}
function bookText() {
  return currentBook.chapters.map((c) => `## ${c.title}\n${c.text}`).join('\n\n');
}

async function runAI(taskFn) {
  if (aiAbort) aiAbort.abort();
  aiReader.stop();
  aiAbort = new AbortController();
  const out = $('#ai-output');
  const wrap = $('#ai-output-wrap');
  wrap.hidden = false;
  out.textContent = '';
  aiLastText = '';
  $('#ai-speak').hidden = true;
  $('#ai-status').textContent = 'Thinking…';
  setAiBusy(true);

  const onToken = (t) => {
    $('#ai-status').textContent = 'Writing…';
    out.textContent += t;
    out.scrollTop = out.scrollHeight;
  };
  try {
    aiLastText = await taskFn(onToken, aiAbort.signal);
    $('#ai-status').textContent = '';
    if (aiLastText.trim()) $('#ai-speak').hidden = false;
  } catch (err) {
    if (err.name === 'AbortError') { $('#ai-status').textContent = ''; return; }
    out.textContent = '⚠️ ' + (err.message || 'Something went wrong.');
    $('#ai-status').textContent = '';
  } finally {
    setAiBusy(false);
    aiAbort = null;
  }
}

function setAiBusy(busy) {
  ['#ai-summary', '#ai-points', '#ai-ask', '#ai-question'].forEach((s) => {
    $(s).disabled = busy;
  });
}

function toggleAiSpeak() {
  if (aiReader.playing && !aiReader.paused) {
    aiReader.pause();
    return;
  }
  if (aiReader.paused) { aiReader.play(); return; }
  reader.pause(); // stop book audio
  aiReader.voice = reader.voice;
  aiReader.rate = reader.rate;
  aiReader.pitch = reader.pitch;
  aiReader.load([{ title: 'AI answer', text: aiLastText }]);
  aiReader.play();
}

aiReader.onStateChange = (state) => {
  const btn = $('#ai-speak');
  if (!btn) return;
  const playing = state === 'playing';
  btn.textContent = playing ? '❚❚ Pause' : (state === 'ended' ? '🔊 Read again' : '🔊 Read aloud');
};

// ------------------------------------------------------------------ speed cycle
const SPEEDS = [0.8, 1.0, 1.2, 1.5, 1.75, 2.0];
function cycleSpeed() {
  const cur = reader.rate;
  let idx = SPEEDS.findIndex((s) => Math.abs(s - cur) < 0.05);
  idx = (idx + 1) % SPEEDS.length;
  const rate = SPEEDS[idx];
  reader.setRate(rate);
  localStorage.setItem('rate', String(rate));
  $('#btn-speed').textContent = rate.toFixed(1) + '×';
  $('#rng-rate').value = rate;
  $('#rate-val').textContent = rate.toFixed(1) + '×';
}

// ------------------------------------------------------------------ wire up
function wireEvents() {
  // library / import
  $('#btn-add').addEventListener('click', () => $('#file-input').click());
  $('#dropzone').addEventListener('click', (e) => {
    if (e.target.id === 'btn-add') return;
    $('#file-input').click();
  });
  $('#file-input').addEventListener('change', (e) => {
    if (e.target.files.length) handleFiles(e.target.files);
    e.target.value = '';
  });
  const dz = $('#dropzone');
  ['dragover', 'dragenter'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => {
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
  });

  // settings
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-close-settings').addEventListener('click', closeSettings);
  $('#sheet-scrim').addEventListener('click', closeSettings);
  $('#sel-voice').addEventListener('change', (e) => {
    localStorage.setItem('voiceURI', e.target.value);
    const v = voices.find((x) => x.voiceURI === e.target.value);
    if (v) reader.setVoice(v);
  });
  $('#rng-rate').addEventListener('input', (e) => {
    const rate = parseFloat(e.target.value);
    $('#rate-val').textContent = rate.toFixed(1) + '×';
    $('#btn-speed').textContent = rate.toFixed(1) + '×';
    localStorage.setItem('rate', String(rate));
    reader.setRate(rate);
  });
  $('#rng-pitch').addEventListener('input', (e) => {
    const pitch = parseFloat(e.target.value);
    $('#pitch-val').textContent = pitch.toFixed(1);
    localStorage.setItem('pitch', String(pitch));
    reader.setPitch(pitch);
  });
  $('#sel-theme').addEventListener('change', (e) => {
    localStorage.setItem('theme', e.target.value);
    applyTheme();
  });
  $('#inp-highlight').addEventListener('input', (e) => {
    localStorage.setItem('highlight', e.target.value);
    applyTheme();
  });
  $('#btn-test-voice').addEventListener('click', () => {
    reader.load([{ title: 'Test', text: 'Hello! This is how BeriBook will read your documents to you.' }]);
    reader.play();
  });
  $('#inp-apikey').addEventListener('change', (e) => {
    AI.setKey(e.target.value);
    refreshAiKeyState();
  });
  $('#sel-model').addEventListener('change', (e) => AI.setModel(e.target.value));

  // reader nav
  $('#btn-back').addEventListener('click', () => {
    reader.stop();
    saveProgressSoon();
    renderLibrary();
    showView('view-library');
  });
  $('#btn-chapters').addEventListener('click', openChapters);
  $('#btn-close-chapters').addEventListener('click', closeChapters);
  $('#drawer-scrim').addEventListener('click', closeChapters);

  // AI panel
  $('#btn-ai').addEventListener('click', openAI);
  $('#btn-close-ai').addEventListener('click', closeAI);
  $('#ai-scrim').addEventListener('click', closeAI);
  $('#ai-open-settings').addEventListener('click', () => { closeAI(); openSettings(); });
  $('#ai-summary').addEventListener('click', () => {
    const t = currentBook.chapters[reader.chapterIndex].title;
    runAI((onTok, sig) => AI.summarizeChapter(t, chapterText(), onTok, sig));
  });
  $('#ai-points').addEventListener('click', () => {
    const t = currentBook.chapters[reader.chapterIndex].title;
    runAI((onTok, sig) => AI.keyPoints(t, chapterText(), onTok, sig));
  });
  const askHandler = () => {
    const q = $('#ai-question').value.trim();
    if (!q) return;
    const ctx = aiScope() === 'book' ? bookText() : chapterText();
    runAI((onTok, sig) => AI.askQuestion(currentBook.title, ctx, q, onTok, sig));
  };
  $('#ai-ask').addEventListener('click', askHandler);
  $('#ai-question').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); askHandler(); }
  });
  $('#ai-speak').addEventListener('click', toggleAiSpeak);

  // player
  $('#btn-play').addEventListener('click', () => { aiReader.stop(); reader.toggle(); });
  $('#btn-next').addEventListener('click', () => reader.nextSentence());
  $('#btn-prev').addEventListener('click', () => reader.prevSentence());
  $('#btn-next-ch').addEventListener('click', () => reader.nextChapter());
  $('#btn-prev-ch').addEventListener('click', () => reader.prevChapter());
  $('#btn-speed').addEventListener('click', cycleSpeed);
  $('#scrubber').addEventListener('input', (e) => {
    reader.seek(reader.chapterIndex, parseInt(e.target.value, 10));
  });

  // keyboard (nice on iPad with a keyboard)
  document.addEventListener('keydown', (e) => {
    if ($('#view-reader').classList.contains('is-active') && !e.target.matches('input,select,textarea')) {
      if (e.code === 'Space') { e.preventDefault(); reader.toggle(); }
      else if (e.code === 'ArrowRight') reader.nextSentence();
      else if (e.code === 'ArrowLeft') reader.prevSentence();
    }
  });

  // keep progress on the way out
  window.addEventListener('pagehide', () => {
    if (currentBook) {
      DB.saveProgress(currentBook.id, {
        chapterIndex: reader.chapterIndex, sentenceIndex: reader.sentenceIndex,
      });
    }
  });
}

// ------------------------------------------------------------------ boot
async function boot() {
  applyTheme();
  wireEvents();
  await renderLibrary();

  voices = await loadVoices();
  applyVoiceSettings();
  populateVoiceSelect();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
