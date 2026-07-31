// docview.js — "Original document" view.
//
// Renders the real PDF, page by page, into a scrolling container, and lays an
// invisible, glyph-aligned text layer over each page. The reading engine reads
// the whole document as one continuous flow, and we highlight the actual words
// on the page as they're spoken — the document's layout stays exactly intact.

import { splitSentencesWithOffsets } from './tts.js';

const pdfjsLib = window.pdfjsLib;
if (pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdf.worker.min.js';

function normItem(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// Build the whole view. Returns:
//   { fullText, sentences, sentenceEls, destroy }
// where sentenceEls[i] is the array of <span> elements that make up sentence i.
export async function buildPdfView(container, arrayBuffer, onSpanClick) {
  container.innerHTML = '';
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  // Fit pages to the container width (capped for readability on big screens).
  const cssWidth = Math.min(container.clientWidth || window.innerWidth, 900);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  const items = []; // { span, start, end } — offsets into fullText
  let fullText = '';
  const pageDivs = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const scale = cssWidth / base.width;
    const viewport = page.getViewport({ scale });

    const pageDiv = document.createElement('div');
    pageDiv.className = 'pdf-page';
    pageDiv.style.width = viewport.width + 'px';
    pageDiv.style.height = viewport.height + 'px';

    const canvas = document.createElement('canvas');
    canvas.className = 'pdf-canvas';
    canvas.width = Math.floor(viewport.width * dpr);
    canvas.height = Math.floor(viewport.height * dpr);
    canvas.style.width = viewport.width + 'px';
    canvas.style.height = viewport.height + 'px';
    pageDiv.appendChild(canvas);

    const textLayer = document.createElement('div');
    textLayer.className = 'pdf-text';
    pageDiv.appendChild(textLayer);

    // Text layer: one transparent span per text run, positioned over the glyphs.
    const content = await page.getTextContent();
    for (const item of content.items) {
      const str = normItem(item.str);
      if (!str) continue;
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]) || 12;
      const left = tx[4];
      const top = tx[5] - fontHeight;
      const width = (item.width || 0) * scale;

      const span = document.createElement('span');
      span.textContent = str;
      span.style.left = left + 'px';
      span.style.top = top + 'px';
      span.style.height = fontHeight + 'px';
      if (width > 0) span.style.width = width + 'px';
      span.style.fontSize = fontHeight + 'px';
      textLayer.appendChild(span);

      const start = fullText.length;
      fullText += str + ' ';
      items.push({ span, start, end: start + str.length });
    }

    pageDiv._page = page;
    pageDiv._viewport = viewport;
    pageDiv._canvas = canvas;
    pageDiv._dpr = dpr;
    pageDiv._rendered = false;
    container.appendChild(pageDiv);
    pageDivs.push(pageDiv);
  }

  fullText = fullText.replace(/\s+$/,'');

  // Map sentences -> the spans that fall inside them.
  const sentences = splitSentencesWithOffsets(fullText);
  const sentenceEls = sentences.map(() => []);
  let cursor = 0;
  for (const it of items) {
    // advance to the sentence whose range contains this item's start
    while (cursor < sentences.length - 1 && it.start >= sentences[cursor].end) cursor++;
    const s = sentences[cursor];
    if (it.start < s.end && it.end > s.start) {
      sentenceEls[cursor].push(it.span);
      it.span.dataset.si = cursor;
    }
  }

  // Click any word to start reading there.
  container.addEventListener('click', (e) => {
    const span = e.target.closest('.pdf-text span');
    if (span && span.dataset.si != null && onSpanClick) {
      onSpanClick(parseInt(span.dataset.si, 10));
    }
  });

  // Lazily rasterize pages as they approach the viewport (keeps memory sane
  // for long PDFs and makes first paint fast).
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const div = entry.target;
      if (div._rendered) { io.unobserve(div); continue; }
      div._rendered = true;
      io.unobserve(div);
      const ctx = div._canvas.getContext('2d');
      ctx.scale(div._dpr, div._dpr);
      div._page.render({ canvasContext: ctx, viewport: div._viewport });
    }
  }, { root: null, rootMargin: '1200px 0px' });
  pageDivs.forEach((d) => io.observe(d));

  const destroy = () => {
    io.disconnect();
    try { pdf.cleanup(); pdf.destroy(); } catch (_) { /* ignore */ }
    container.innerHTML = '';
  };

  return { fullText, sentences: sentences.map((s) => s.text), sentenceEls, destroy };
}
