// tts.js — the speech engine.
//
// Reads a book chapter-by-chapter, one sentence at a time, using the
// device's built-in speech synthesis (on iPhone/iPad these are the same
// high-quality Siri voices). Speaking sentence-by-sentence is deliberate:
// it sidesteps Safari's long-utterance cutoff bug and lets us highlight and
// resume at sentence granularity.

const synth = window.speechSynthesis;

// Sentence segmentation: prefer the platform Intl.Segmenter (accurate, and
// available in Safari 16.4+), fall back to a punctuation regex.
function splitSentences(text) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' });
      const out = [];
      for (const { segment } of seg.segment(clean)) {
        const s = segment.trim();
        if (s) out.push(s);
      }
      if (out.length) return mergeTiny(out);
    } catch (_) { /* fall through */ }
  }
  const parts = clean.match(/[^.!?]+[.!?]+(?:["')\]]+)?|\S[^.!?]*$/g) || [clean];
  return mergeTiny(parts.map((s) => s.trim()).filter(Boolean));
}

// Merge very short fragments (headings, "1.", "e.g.") into the next sentence
// so playback doesn't stutter.
function mergeTiny(sentences) {
  const out = [];
  for (const s of sentences) {
    if (out.length && (s.length < 3 || out[out.length - 1].length < 3)) {
      out[out.length - 1] = (out[out.length - 1] + ' ' + s).trim();
    } else {
      out.push(s);
    }
  }
  return out;
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

    // callbacks (assigned by the UI)
    this.onSentenceChange = null; // (chapterIndex, sentenceIndex, sentenceText)
    this.onChapterChange = null;  // (chapterIndex)
    this.onStateChange = null;    // ('playing'|'paused'|'stopped'|'ended')
    this.onWord = null;           // (charIndex, charLength) within sentence
    this.onEnd = null;            // finished whole book

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
    this.sentences = splitSentences(ch ? ch.text : '');
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
      if (this.onWord && e.name !== 'sentence') {
        this.onWord(e.charIndex, e.charLength || 0);
      }
    };
    u.onend = () => {
      if (token !== this._token) return;
      this._lastActivity = now();
      this._advance(token);
    };
    u.onerror = (e) => {
      if (token !== this._token) return;
      if (e.error === 'canceled' || e.error === 'interrupted') return;
      this._advance(token); // skip a problematic sentence rather than stall
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
