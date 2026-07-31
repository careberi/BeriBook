// ai.js — optional AI features powered by Claude.
//
// Runs entirely from the browser using the user's own Anthropic API key
// (stored on this device only). No BeriBook server is involved. The key and
// the document text go straight from your device to Anthropic's API.

const API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// Models offered in Settings. Opus 5 is the highest quality; the others are
// faster / cheaper. Haiku does not accept the `effort` parameter.
export const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus (highest quality)', effort: true },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet (faster)', effort: true },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku (fastest, cheapest)', effort: false },
];

export function getKey() {
  return localStorage.getItem('anthropicKey') || '';
}
export function setKey(k) {
  if (k) localStorage.setItem('anthropicKey', k.trim());
  else localStorage.removeItem('anthropicKey');
}
export function hasKey() {
  return !!getKey();
}
export function getModel() {
  const saved = localStorage.getItem('aiModel');
  return MODELS.some((m) => m.id === saved) ? saved : 'claude-opus-5';
}
export function setModel(id) {
  localStorage.setItem('aiModel', id);
}

// Keep prompt sizes sane. Claude models have large context windows, but there
// is no reason to send a whole novel to summarize one chapter.
const MAX_CHARS = 60000;
function clamp(text) {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS) + '\n\n[…document truncated for length…]';
}

function stripThinkTags(s) {
  return s.replace(/<\/?thinking>/gi, '').trim();
}

// Core streaming call. Calls onToken(textDelta) as text arrives; resolves with
// the full text. Throws a friendly Error on failure.
async function stream({ system, user, maxTokens, onToken, signal }) {
  const key = getKey();
  if (!key) throw new Error('Add your Claude API key in Settings to use AI features.');

  const model = getModel();
  const modelInfo = MODELS.find((m) => m.id === model) || MODELS[0];

  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    system,
    messages: [{ role: 'user', content: clamp(user) }],
  };
  if (modelInfo.effort) body.output_config = { effort: 'low' };

  let resp;
  try {
    resp = await fetch(API_URL, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error('Network error reaching Claude. Check your connection.');
  }

  if (!resp.ok) {
    let msg = `Claude API error (${resp.status}).`;
    try {
      const err = await resp.json();
      const detail = err?.error?.message || '';
      if (resp.status === 401) msg = 'Your API key was rejected. Check it in Settings.';
      else if (resp.status === 429) msg = 'Rate limited by Claude. Wait a moment and try again.';
      else if (resp.status === 400 && /credit|billing/i.test(detail)) msg = 'Your Claude account needs billing set up.';
      else if (detail) msg = detail;
    } catch (_) { /* ignore */ }
    throw new Error(msg);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let refused = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop(); // keep incomplete tail
    for (const evt of events) {
      const line = evt.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let json;
      try { json = JSON.parse(data); } catch (_) { continue; }
      if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
        const t = json.delta.text || '';
        full += t;
        if (onToken) onToken(t);
      } else if (json.type === 'message_delta' && json.delta?.stop_reason === 'refusal') {
        refused = true;
      } else if (json.type === 'error') {
        throw new Error(json.error?.message || 'Claude returned an error.');
      }
    }
  }

  if (refused && !full.trim()) {
    throw new Error('Claude declined to answer that request.');
  }
  return stripThinkTags(full);
}

// ---- public task helpers ----

export function summarizeChapter(title, text, onToken, signal) {
  return stream({
    system:
      'You are a helpful reading assistant. Summarize the given chapter of a document clearly and concisely for a listener who may hear this read aloud. Use plain sentences and short paragraphs. Do not use markdown headers, bullet characters, or asterisks.',
    user: `Summarize this chapter titled "${title}":\n\n${text}`,
    maxTokens: 1500,
    onToken,
    signal,
  });
}

export function keyPoints(title, text, onToken, signal) {
  return stream({
    system:
      'You are a helpful reading assistant. Extract the most important takeaways from the given chapter as a short numbered list (1., 2., 3., …). Each point is one clear sentence. No markdown symbols other than the numbers.',
    user: `List the key points from this chapter titled "${title}":\n\n${text}`,
    maxTokens: 1200,
    onToken,
    signal,
  });
}

export function askQuestion(bookTitle, contextText, question, onToken, signal) {
  return stream({
    system:
      `You are a helpful assistant answering questions about the document "${bookTitle}". Answer only from the provided text. If the answer is not in the text, say so plainly. Write in clear sentences suitable for being read aloud — no markdown symbols.`,
    user: `Document text:\n\n${contextText}\n\n---\n\nQuestion: ${question}`,
    maxTokens: 2000,
    onToken,
    signal,
  });
}
