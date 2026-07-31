// tts.js — the speech engine.
//
// Reads a book chapter-by-chapter, one sentence at a time, using the
// device's built-in speech synthesis (on iPhone/iPad these are the same
// high-quality Siri voices). Speaking sentence-by-sentence is deliberate:
// it sidesteps Safari's long-utterance cutoff bug and lets us highlight and
// resume at sentence granularity.

const synth = window.speechSynthesis;

// Sentence segmentation returning character offsets into the (already
// whitespace-normalized) input. Prefer the platform Intl.Segmenter (accurate,
// Safari 16.4+); fall back to a punctuation regex. The "Original document"
// view relies on these offsets to line reading up with the words on the page.
export function splitSentencesWithOffsets(text) {
  const clean = text || '';
  if (!clean.trim()) return [];
  let raw = [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' });
      for (const s of seg.segment(clean)) raw.push({ start: s.index, end: s.index + s.segment.length });
    } catch (_) { raw = []; }
  }
  if (!raw.length) {
    const re = /[^.!?]+[.!?]+(?:["')\]]+)?|\S[^.!?]*$/g;
    let m;
    while ((m = re.exec(clean)) !== null) raw.push({ start: m.index, end: m.index + m[0].length });
    if (!raw.length) raw.push({ start: 0, end: clean.length });
  }
  // trim whitespace off each range, drop empties
  const trimmed = [];
  for (const r of raw) {
    let s = r.start, e = r.end;
    while (s < e && /\s/.test(clean[s])) s++;
    while (e > s && /\s/.test(clean[e - 1])) e--;
    if (e > s) trimmed.push({ start: s, end: e, text: clean.slice(s, e) });
  }
  return mergeTinyOffsets(trimmed);
}

// Merge very short fragments (headings, "1.", "e.g.") into the next sentence
// so playback doesn't stutter — keeping the merged character range.
function mergeTinyOffsets(items) {
  const out = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (prev && (it.text.length < 3 || prev.text.length < 3)) {
      prev.end = it.end;
      prev.text = (prev.text + ' ' + it.text).trim();
    } else {
      out.push({ ...it });
    }
  }
  return out;
}

function splitSentences(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  return splitSentencesWithOffsets(clean).map((s) => s.text);
}

export class Reader {
  constructor() {
    this.chapters = [];
    this.chapterIndex = 0;
    this.sentences = [];
    this.sentenceIndex = 0;

    this.rate = 1;
    this.pitch = 1;
    this.voice = null;

    this.playing = false; // user intends playback
    this.paused = false;

    this._token = 0; // guards against stale utterance callbacks
    this._errorStreak = 0;

    // callbacks (assigned by the UI)
    this.onSentenceChange = null; // (chapterIndex, sentenceIndex, sentenceText)
    this.onChapterChange = null;  // (chapterIndex)
    this.onStateChange = null;    // ('playing'|'paused'|'stopped'|'ended'|'error')
    this.onWord = null;           // (charIndex, charLength) within sentence
    this.onEnd = null;            // finished whole book
    this.onError = null;          // speech synthesis is failing

    this._startWatchdog();
  }

  // ---- setup ----
  load(chapters, position) {
    this.stop();
    this.chapters = chapters || [];
    this.setPosition(position?.chapterIndex || 0, position?.sentenceIndex || 0, false);
  }

  _loadChapter(i) {
    this.chapterIndex = Math.max(0, Math.min(i, this.chapters.length - 1));
    const ch = this.chapters[this.chapterIndex];
    // A chapter may carry a pre-computed sentence array (used by the
    // "Original document" view so highlight indices line up exactly).
    this.sentences = ch && ch.sentences ? ch.sentences : splitSentences(ch ? ch.text : '');
    if (this.onChapterChange) this.onChapterChange(this.chapterIndex);
  }

  setPosition(chapterIndex, sentenceIndex = 0, autoplay = false) {
    this._loadChapter(chapterIndex);
    this.sentenceIndex = Math.max(0, Math.min(sentenceIndex, Math.max(0, this.sentences.length - 1)));
    if (this.onSentenceChange) {
      this.onSentenceChange(this.chapterIndex, this.sentenceIndex, this.sentences[this.sentenceIndex] || '');
    }
    if (autoplay) this.play();
  }

  getSentences() { return this.sentences; }
  currentSentence() { return this.sentences[this.sentenceIndex] || ''; }

  // ---- voice/params ----
  setVoice(voice) {
    this.voice = voice;
    if (this.playing && !this.paused) this._speakCurrent(); // apply immediately
  }
  setRate(rate) {
    this.rate = rate;
    if (this.playing && !this.paused) this._speakCurrent();
  }
  setPitch(pitch) { this.pitch = pitch; }

  // ---- transport ----
  play() {
    if (!this.chapters.length) return;
    if (this.paused) { this.paused = false; }
    this._errorStreak = 0;
    this.playing = true;
    this._emit('playing');
    this._speakCurrent();
  }

  // Cancel-based pause: Safari's native pause()/resume() is unreliable, so we
  // stop synthesis and simply re-speak the current sentence on resume.
  pause() {
    this.paused = true;
    this.playing = false;
    this._token++;
    synth.cancel();
    this._emit('paused');
  }

  toggle() {
    if (this.playing && !this.paused) this.pause();
    else this.play();
  }

  stop() {
    this.playing = false;
    this.paused = false;
    this._token++;
    synth.cancel();
    this._emit('stopped');
  }

  nextSentence() {
    if (this.sentenceIndex < this.sentences.length - 1) {
      this.sentenceIndex++;
      this._afterSeek();
    } else {
      this.nextChapter();
    }
  }

  prevSentence() {
    if (this.sentenceIndex > 0) {
      this.sentenceIndex--;
      this._afterSeek();
    } else if (this.chapterIndex > 0) {
      this._loadChapter(this.chapterIndex - 1);
      this.sentenceIndex = Math.max(0, this.sentences.length - 1);
      this._afterSeek();
    }
  }

  nextChapter() {
    if (this.chapterIndex < this.chapters.length - 1) {
      this._loadChapter(this.chapterIndex + 1);
      this.sentenceIndex = 0;
      this._afterSeek();
    } else {
      this._finish();
    }
  }

  prevChapter() {
    this._loadChapter(Math.max(0, this.chapterIndex - 1));
    this.sentenceIndex = 0;
    this._afterSeek();
  }

  seek(chapterIndex, sentenceIndex = 0) {
    this._loadChapter(chapterIndex);
    this.sentenceIndex = Math.max(0, Math.min(sentenceIndex, Math.max(0, this.sentences.length - 1)));
    this._afterSeek();
  }

  _afterSeek() {
    if (this.onSentenceChange) {
      this.onSentenceChange(this.chapterIndex, this.sentenceIndex, this.currentSentence());
    }
    if (this.playing && !this.paused) this._speakCurrent();
  }

  // ---- engine ----
  _speakCurrent() {
    synth.cancel();
    const token = ++this._token;
    const text = this.currentSentence();

    if (this.onSentenceChange) {
      this.onSentenceChange(this.chapterIndex, this.sentenceIndex, text);
    }

    if (!text) { this._advance(token); return; }

    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = this.rate;
    u.pitch = this.pitch;

    u.onboundary = (e) => {
      if (token !== this._token) return;
      this._errorStreak = 0; // real progress
      if (this.onWord && e.name !== 'sentence') {
        this.onWord(e.charIndex, e.charLength || 0);
      }
    };
    u.onend = () => {
      if (token !== this._token) return;
      this._errorStreak = 0;
      this._lastActivity = now();
      this._advance(token);
    };
    u.onerror = (e) => {
      if (token !== this._token) return;
      const err = e && e.error;
      if (err === 'canceled' || err === 'interrupted') return;
      // Guard against a runaway: if synthesis keeps failing (e.g. the chosen
      // voice can't speak), don't silently blast through the whole document —
      // stop and let the UI surface it.
      this._errorStreak = (this._errorStreak || 0) + 1;
      if (this._errorStreak >= 4) { this._fail(); return; }
      this._advance(token); // otherwise skip this one problematic sentence
    };

    this._lastActivity = now();
    this._speaking = true;
    // Some engines need a tick after cancel() before speak() takes effect.
    setTimeout(() => { if (token === this._token) synth.speak(u); }, 0);
  }

  _advance(token) {
    if (token !== this._token) return;
    if (!this.playing || this.paused) return;
    if (this.sentenceIndex < this.sentences.length - 1) {
      this.sentenceIndex++;
      this._speakCurrent();
    } else if (this.chapterIndex < this.chapters.length - 1) {
      this._loadChapter(this.chapterIndex + 1);
      this.sentenceIndex = 0;
      this._speakCurrent();
    } else {
      this._finish();
    }
  }

  _finish() {
    this.playing = false;
    this.paused = false;
    this._token++;
    synth.cancel();
    this._emit('ended');
    if (this.onEnd) this.onEnd();
  }

  _fail() {
    this.playing = false;
    this.paused = false;
    this._token++;
    synth.cancel();
    this._emit('error');
    if (this.onError) this.onError();
  }

  _emit(state) {
    if (this.onStateChange) this.onStateChange(state);
  }

  // Watchdog: if synthesis silently dies mid-playback (a known mobile Safari
  // quirk), nudge it back to life so the book keeps reading.
  _startWatchdog() {
    this._lastActivity = now();
    setInterval(() => {
      if (!this.playing || this.paused) return;
      // Chrome's ~15s cutoff workaround.
      if (synth.speaking && !synth.paused) {
        synth.pause();
        synth.resume();
      }
      // Stall detector: intended to speak, but nothing is happening.
      if (!synth.speaking && !synth.pending && now() - this._lastActivity > 1500) {
        this._speakCurrent();
      }
    }, 4000);
  }
}

function now() {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now());
}

// ---- voice list helper ----
export function loadVoices() {
  return new Promise((resolve) => {
    let voices = synth.getVoices();
    if (voices && voices.length) return resolve(voices);
    const handler = () => {
      voices = synth.getVoices();
      if (voices && voices.length) {
        synth.onvoiceschanged = null;
        resolve(voices);
      }
    };
    synth.onvoiceschanged = handler;
    // Safari sometimes needs a poke.
    setTimeout(() => resolve(synth.getVoices() || []), 1000);
  });
}

export { splitSentences };
