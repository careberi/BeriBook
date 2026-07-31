// ingest.js — turn an uploaded PDF or Word file into a structured book:
//   { id, title, type, createdAt, chapters: [{ title, text }] }
//
// PDFs are parsed with pdf.js and split into chapters using a font-size /
// heading heuristic. Word files (.docx) are converted to HTML with mammoth
// and split on their real heading styles. Both fall back to fixed-size
// chunking when no usable structure is found.

// pdf.js and mammoth are loaded as globals via <script> tags in index.html.
const pdfjsLib = window.pdfjsLib;
const mammoth = window.mammoth;

if (pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdf.worker.min.js';
}

function uid() {
  return 'b_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---- text helpers -------------------------------------------------------

function fixHyphenation(text) {
  // join words broken across a line: "exam- ple" -> "example"
  return text.replace(/(\w)-\s+(\w)/g, '$1$2');
}

// Some PDFs render small-caps / letter-spaced headings so that pdf.js sees a
// gap after the first letter: "K EY A REA OF P ERFORMANCE". Rejoin a lone
// capital that is glued to a following ALL-CAPS word so speech doesn't spell
// it out. Only triggers on all-caps runs, so normal prose is untouched.
function fixLetterSpacing(text) {
  return text.replace(/\b([A-Z]) (?=[A-Z]{2,}\b)/g, '$1');
}

// Collapse table-of-contents "leader" dots (". . . . . ." or "……") that
// speech would otherwise read aloud as "dot dot dot".
function stripLeaderDots(text) {
  return text
    .replace(/[.…](?:\s*[.…]){2,}/g, ' ')
    .replace(/[ \t]{2,}/g, ' ');
}

function cleanText(text) {
  return stripLeaderDots(fixLetterSpacing(fixHyphenation(text)));
}

function collapseWs(s) {
  return s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

function wordCount(s) {
  const m = s.trim().match(/\S+/g);
  return m ? m.length : 0;
}

const CHAPTER_WORD_TARGET = 1400;

function chunkByWords(text, baseTitle) {
  const words = text.split(/\s+/);
  const chapters = [];
  for (let i = 0; i < words.length; i += CHAPTER_WORD_TARGET) {
    const slice = words.slice(i, i + CHAPTER_WORD_TARGET).join(' ');
    chapters.push({
      title: `${baseTitle} ${chapters.length + 1}`,
      text: slice,
    });
  }
  return chapters.length ? chapters : [{ title: baseTitle + ' 1', text }];
}

// ---- heading heuristics -------------------------------------------------

const HEADING_PATTERNS = [
  /^(chapter|section|part|appendix|article|standard|module|unit|lesson)\b/i,
  /^\d+(\.\d+)*[.)]?\s+\S/,          // "1  Title" / "1.2 Title" / "3) Title"
  /^[IVXLCDM]+\.\s+\S/,             // Roman numeral headings
];

function looksLikeHeadingText(text) {
  const t = text.trim();
  if (!t) return false;
  if (wordCount(t) > 16) return false;
  if (HEADING_PATTERNS.some((re) => re.test(t))) return true;
  // ALL CAPS (allowing digits/punctuation), reasonable length
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 3 && letters === letters.toUpperCase() && t.length <= 70) {
    return true;
  }
  return false;
}

// ---- PDF ----------------------------------------------------------------

async function extractPdfLines(arrayBuffer, onProgress) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const numPages = pdf.numPages;
  const lines = []; // { text, size, bold, page, y }

  for (let p = 1; p <= numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map(); // key: rounded y -> { items:[], size, bold, yRaw }

    for (const item of content.items) {
      if (!item.str || !item.str.trim()) continue;
      const tr = item.transform;
      const size = Math.hypot(tr[1], tr[3]) || item.height || 10;
      const y = tr[5];
      const key = Math.round(y / 2) * 2; // bucket close baselines together
      if (!rows.has(key)) rows.set(key, { items: [], size: 0, bold: false, y });
      const row = rows.get(key);
      row.items.push({ x: tr[4], str: item.str });
      row.size = Math.max(row.size, size);
      const fn = (item.fontName || '').toLowerCase();
      if (/bold|black|semibold|heavy/.test(fn)) row.bold = true;
    }

    const pageRows = [...rows.values()]
      .sort((a, b) => b.y - a.y) // top -> bottom (PDF y grows upward)
      .map((r) => {
        const text = r.items.sort((a, b) => a.x - b.x).map((i) => i.str).join(' ');
        return { text: collapseWs(text), size: r.size, bold: r.bold, page: p, y: r.y };
      })
      .filter((r) => r.text);

    lines.push(...pageRows);
    if (onProgress) onProgress(p / numPages);
  }

  return { lines, numPages };
}

function dropRunningHeadersFooters(lines, numPages) {
  if (numPages < 4) return lines;
  const counts = new Map();
  for (const l of lines) {
    if (wordCount(l.text) > 8) continue;
    counts.set(l.text, (counts.get(l.text) || 0) + 1);
  }
  const threshold = Math.max(3, numPages * 0.3);
  const repeated = new Set(
    [...counts.entries()].filter(([, c]) => c >= threshold).map(([t]) => t)
  );
  return lines.filter((l) => {
    if (/^\s*(page\s+)?\d+\s*$/i.test(l.text)) return false; // bare page numbers
    return !repeated.has(l.text);
  });
}

function bodyFontSize(lines) {
  const hist = new Map();
  for (const l of lines) {
    const bucket = Math.round(l.size * 2) / 2;
    hist.set(bucket, (hist.get(bucket) || 0) + wordCount(l.text));
  }
  let best = 10, bestCount = 0;
  for (const [size, count] of hist) {
    if (count > bestCount) { bestCount = count; best = size; }
  }
  return best;
}

function pdfToChapters(lines, numPages) {
  lines = dropRunningHeadersFooters(lines, numPages);
  const body = bodyFontSize(lines);

  // classify each line as heading or not, with a size.
  // A line noticeably larger than body text is a heading on size alone
  // (titles are often mixed-case and won't match any text pattern). The
  // text-pattern test is only a fallback for bold lines at body size.
  const marked = lines.map((l) => {
    const ratio = l.size / body;
    const words = wordCount(l.text);
    const bigHeading = ratio >= 1.35 && words <= 20;
    const medHeading = ratio >= 1.12 && words <= 18;
    const boldShort = l.bold && ratio >= 1.02 && words <= 12 &&
      !/[.,;:]$/.test(l.text) && looksLikeHeadingText(l.text);
    const isHeading = bigHeading || medHeading || boldShort;
    return { ...l, isHeading, headSize: isHeading ? l.size : 0 };
  });

  // Group into chapters given a chapter-boundary font size. Consecutive
  // heading lines with no body between them form one multi-line title.
  const groupAt = (chosen) => {
    const chapters = [];
    let current = null;
    const preamble = [];
    for (const m of marked) {
      const isChapterHead = m.isHeading && Math.round(m.headSize * 2) / 2 >= chosen;
      if (isChapterHead) {
        if (current && current.lines.length === 0) {
          current.title = cleanText((current.title + ' ' + m.text).trim()).slice(0, 140);
        } else {
          current = { title: cleanText(m.text).slice(0, 140), lines: [] };
          chapters.push(current);
        }
      } else if (current) {
        current.lines.push(m.text);
      } else {
        preamble.push(m.text);
      }
    }
    return { chapters, preamble };
  };

  // Candidate chapter tiers, coarsest first. Pick the coarsest tier that
  // yields a healthy number of real chapters (avoids latching onto a cover
  // page's giant title, and avoids exploding on every sub-heading).
  const headSizes = [...new Set(marked.filter((m) => m.isHeading).map((m) => Math.round(m.headSize * 2) / 2))]
    .sort((a, b) => b - a);

  let chosen = null;
  for (const min of [4, 3, 2]) {
    for (const size of headSizes) {
      const n = groupAt(size).chapters.length;
      if (n >= min && n <= 60) { chosen = size; break; }
    }
    if (chosen != null) break;
  }

  if (chosen == null) {
    const all = cleanText(lines.map((l) => l.text).join('\n'));
    return chunkByWords(all, 'Part');
  }

  const { chapters, preamble } = groupAt(chosen);
  if (preamble.length && wordCount(preamble.join(' ')) > 40) {
    chapters.unshift({ title: 'Introduction', lines: preamble });
  }

  return chapters.map((c) => ({
    title: c.title,
    text: cleanText(collapseWs(c.lines.join('\n'))),
  })).filter((c) => c.text.trim().length > 0);
}

async function ingestPdf(file, onProgress) {
  const buf = await file.arrayBuffer();
  const { lines, numPages } = await extractPdfLines(buf, onProgress);
  let chapters = pdfToChapters(lines, numPages);
  if (!chapters.length) {
    chapters = [{ title: 'Full Document', text: cleanText(lines.map((l) => l.text).join('\n')) }];
  }
  return chapters;
}

// ---- DOCX ---------------------------------------------------------------

async function ingestDocx(file) {
  const buf = await file.arrayBuffer();
  const result = await mammoth.convertToHtml({ arrayBuffer: buf });
  const doc = new DOMParser().parseFromString(result.value, 'text/html');

  const blocks = [...doc.body.children];
  const chapters = [];
  let current = null;
  let preamble = [];

  const pushText = (target, el) => {
    const t = collapseWs(el.textContent || '');
    if (t) target.push(t);
  };

  for (const el of blocks) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'h1' || tag === 'h2') {
      const heading = collapseWs(el.textContent);
      if (current && current.lines.length === 0 && heading) {
        current.title = (current.title + ' — ' + heading).slice(0, 140);
      } else {
        current = { title: heading || `Chapter ${chapters.length + 1}`, lines: [] };
        chapters.push(current);
      }
    } else if (current) {
      pushText(current.lines, el);
    } else {
      pushText(preamble, el);
    }
  }

  if (preamble.length && wordCount(preamble.join(' ')) > 40) {
    chapters.unshift({ title: 'Introduction', lines: preamble });
  }

  let out = chapters
    .map((c) => ({ title: c.title, text: collapseWs(c.lines.join('\n')) }))
    .filter((c) => c.text.trim().length > 0);

  if (out.length < 2) {
    const all = collapseWs(doc.body.textContent || '');
    out = chunkByWords(all, 'Part');
  }
  return out;
}

// ---- public API ---------------------------------------------------------

export async function ingestFile(file, onProgress) {
  const name = file.name || 'Untitled';
  const lower = name.toLowerCase();
  let type, chapters;

  if (lower.endsWith('.pdf') || file.type === 'application/pdf') {
    type = 'pdf';
    chapters = await ingestPdf(file, onProgress);
  } else if (lower.endsWith('.docx')) {
    type = 'docx';
    chapters = await ingestDocx(file);
  } else if (lower.endsWith('.doc')) {
    throw new Error('Legacy .doc files are not supported. Please re-save as .docx or PDF and try again.');
  } else {
    throw new Error('Unsupported file type. Please upload a PDF or a .docx Word document.');
  }

  if (!chapters.length) throw new Error('No readable text was found in this file.');

  const title = name.replace(/\.(pdf|docx|doc)$/i, '');
  const words = chapters.reduce((n, c) => n + wordCount(c.text), 0);

  return {
    id: uid(),
    title,
    type,
    createdAt: Date.now(),
    chapters,
    wordCount: words,
    hasOriginal: type === 'pdf', // the real file can be rendered in "Original" view
    progress: { chapterIndex: 0, sentenceIndex: 0 },
    docProgress: 0,
  };
}
