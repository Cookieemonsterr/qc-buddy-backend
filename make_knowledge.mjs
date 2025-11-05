// make_knowledge.mjs
// Convert .docx/.pptx/.xlsx SOPs into RAG-ready JSON (smart, not dump).
// Usage: node make_knowledge.mjs [--mode smart|full]

import fs from "fs";
import path from "path";
import fg from "fast-glob";
import mammoth from "mammoth";
import xlsx from "xlsx";
import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";

// ---------- config ----------
const RAW_DIR = path.resolve("./knowledge_raw");
const OUT_DIR = path.resolve("./knowledge");
const MODE = (process.argv.find(a => a.startsWith("--mode="))?.split("=")[1] || "smart").toLowerCase();
// smart: preserve every detail but split by sections, limit chunk length
// full:  keep everything verbatim per slide/section with minimal splitting

// Topic & market hints (extend as needed)
const TOPIC_HINTS = [
  { rx: /company|step[_\s-]*by[_\s-]*step|cr|trn|vat|license/i, topic: "company" },
  { rx: /tag|cuisine|policy|g1|g2/i, topic: "tags" },
  { rx: /writing|capital|custom/i, topic: "writing" },
  { rx: /image|hero|1200|1125|780|asset/i, topic: "images" },
  { rx: /zone|radius|discovery|coverage/i, topic: "zones" }
];
const MARKET_HINTS = [
  { rx: /\buae|dubai|abu\s*dhabi|sharjah|ajman|uae\b/i, market: "AE" },
  { rx: /\bjordan|amman|irbid|zarqa|jo\b/i, market: "JO" },
  { rx: /\bksa|riyadh|jeddah|sa\b/i, market: "SA" }
];

// chunking sizes
const MAX_CHARS_SMART = 1200; // aim for ~1–2 paragraphs per chunk
const MAX_CHARS_FULL  = 3000;

// ---------- helpers ----------
function ensureDirs() {
  if (!fs.existsSync(RAW_DIR)) fs.mkdirSync(RAW_DIR, { recursive: true });
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}

function norm(s){ return String(s || "").replace(/\u00A0/g," ").replace(/\s{2,}/g," ").trim(); }

function detectTopic(name, text) {
  const hay = `${name}\n${text}`.toLowerCase();
  for (const h of TOPIC_HINTS) if (h.rx.test(hay)) return h.topic;
  return "misc";
}
function detectMarket(name, text) {
  const hay = `${name}\n${text}`.toLowerCase();
  for (const h of MARKET_HINTS) if (h.rx.test(hay)) return h.market;
  return "ALL";
}
function outPathForTopic(topic) {
  const map = {
    company: "company_sop.json",
    tags: "tags_sop.json",
    writing: "writing_sop.json",
    images: "images_sop.json",
    zones: "zones_sop.json",
    misc: "misc_sop.json",
  };
  return path.join(OUT_DIR, map[topic] || "misc_sop.json");
}

function pushEntry(buckets, topic, entry){
  const outPath = outPathForTopic(topic);
  if (!buckets.has(outPath)) buckets.set(outPath, []);
  buckets.get(outPath).push(entry);
}

function splitSmartBySentences(text, maxChars) {
  const parts = [];
  let buf = "";
  const sentences = String(text).split(/(?<=[.!?])\s+(?=[^\s])/g);
  for (const s of sentences) {
    if ((buf + " " + s).length > maxChars) {
      if (buf.trim()) parts.push(buf.trim());
      buf = s;
    } else {
      buf = buf ? buf + " " + s : s;
    }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

function asBullets(array) {
  return array.map(t => (t.startsWith("•") || t.startsWith("-")) ? t : `• ${t}`).join("\n");
}

// ---------- DOCX ----------
async function docxToSections(file) {
  // Use mammoth to get raw text; we will approximate sections by headings/bullets
  const res = await mammoth.convertToMarkdown({ path: file }); // markdown preserves headers/lists
  const md = String(res.value || "").trim();

  // Split by headings (## or #). Keep heading line as section title.
  const blocks = md.split(/\n(?=#+\s)/g).filter(Boolean);

  const sections = [];
  let sectionIdx = 0;
  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const heading = lines[0].replace(/^#+\s*/,"").trim();
    const body = lines.slice(1).join("\n");
    const clean = body
      .replace(/^\s*-\s+/gm, "• ")
      .replace(/^\s*\*\s+/gm, "• ")
      .replace(/\s+$/g, "")
      .trim();
    sections.push({
      title: `${path.basename(file)} — ${heading || "Section " + (++sectionIdx)}`,
      text: clean || heading
    });
  }

  // If file had no headings, fallback to entire doc
  if (!sections.length && md) {
    sections.push({
      title: `${path.basename(file)} — Document`,
      text: md.replace(/^\s*-\s+/gm, "• ").replace(/^\s*\*\s+/gm, "• ")
    });
  }
  return sections.map(s => ({ ...s, text: norm(s.text) })).filter(s=>s.text);
}

// ---------- PPTX ----------
function parsePptxToSlides(file) {
  // unzip and parse slide XMLs for <a:t> text and table cells
  const zip = new AdmZip(file);
  const entries = zip.getEntries();
  const parser = new XMLParser({ ignoreAttributes:false, trimValues:true });

  const readXml = (p) => {
    try { return parser.parse(zip.readAsText(p)); }
    catch { return null; }
  };

  const slidePaths = entries.map(e=>e.entryName).filter(p => p.startsWith("ppt/slides/slide") && p.endsWith(".xml"));
  const slideTitles = new Map(); // slideN -> title text (if in layout)
  const slides = [];

  // helper: collect all a:t nodes
  const collectText = (node, out=[]) => {
    if (!node || typeof node !== "object") return out;
    for (const [k,v] of Object.entries(node)) {
      if (k === "a:t" && typeof v === "string") out.push(v);
      else if (typeof v === "object") collectText(v, out);
    }
    return out;
  };

  for (const p of slidePaths) {
    const xml = readXml(p);
    if (!xml) continue;
    const texts = collectText(xml, []);
    const idx = p.match(/slide(\d+)\.xml/i)?.[1] || "?";
    slides.push({ index: Number(idx), title: `Slide ${idx}`, bullets: texts });
  }

  slides.sort((a,b)=>a.index-b.index);
  return slides.map(s => ({
    title: `${path.basename(file)} — ${s.title}`,
    text: asBullets(s.bullets.map(norm).filter(Boolean))
  })).filter(s=>s.text);
}

// ---------- XLSX ----------
function readXlsx(filePath) {
  const wb = xlsx.readFile(filePath, { cellDates:false });
  const data = {};
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    data[name] = xlsx.utils.sheet_to_json(ws, { defval:"" });
  }
  return data;
}

function buildGlossaryJSON(xlsxData) {
  const out = { AE: [], JO: [] };
  for (const rows of Object.values(xlsxData)) {
    for (const r of rows) {
      const en = norm(r.en || r.EN || r.english || r.English || "");
      const ar = norm(r.ar || r.AR || r.arabic || r.Arabic || "");
      const m  = norm(r.market || r.Market || r.country || r.Country || "");
      if (!en || !ar) continue;
      const M = m.toUpperCase();
      if (!M) { out.AE.push({ en, ar }); out.JO.push({ en, ar }); continue; }
      if (M.includes("AE")) out.AE.push({ en, ar });
      if (M.includes("JO")) out.JO.push({ en, ar });
    }
  }
  return out;
}

function buildTagsJSON(xlsxData) {
  const result = { cuisine: [], extra: [] };
  for (const rows of Object.values(xlsxData)) {
    for (const r of rows) {
      const tag = norm(r.tag || r.Tag || r.TAG);
      const type = norm(r.type || r.Type).toLowerCase();
      const keywords = norm(r.keywords || r.Keywords)
        .toLowerCase().split(",").map(s=>s.trim()).filter(Boolean);
      if (!tag) continue;
      const rec = { tag, keywords };
      if (type.includes("cuisine")) result.cuisine.push(rec); else result.extra.push(rec);
    }
  }
  return result;
}

// ---------- main ----------
async function main() {
  ensureDirs();

  const files = await fg(["**/*.docx", "**/*.pptx", "**/*.xlsx"], { cwd: RAW_DIR, absolute:true });
  if (!files.length) {
    console.log(`No files in ${RAW_DIR}. Put your SOPs there and re-run.`);
    return;
  }

  const buckets = new Map(); // outPath -> entries

  for (const file of files) {
    const name = path.basename(file);

    // Excel first (glossary / tags / zone extensions)
    if (/\.xlsx$/i.test(file)) {
      const data = readXlsx(file);
      const lower = name.toLowerCase();

      if (lower.includes("glossary")) {
        const glossary = buildGlossaryJSON(data);
        fs.writeFileSync(path.join(OUT_DIR, "glossary.json"), JSON.stringify(glossary, null, 2), "utf-8");
        console.log(`✅ glossary.json — AE:${glossary.AE.length} JO:${glossary.JO.length}`);
        continue;
      }
      if (lower.includes("cuisine") || lower.includes("tag")) {
        const tags = buildTagsJSON(data);
        fs.writeFileSync(path.join(OUT_DIR, "tags.json"), JSON.stringify(tags, null, 2), "utf-8");
        console.log(`✅ tags.json — cuisine:${tags.cuisine.length} extra:${tags.extra.length}`);
        continue;
      }
      // If you need zone_extensions.json later, add similar handler here.
      console.log(`(xlsx not recognized pattern): ${name}`);
      continue;
    }

    // DOCX / PPTX → sections
    let sections = [];
    try {
      if (/\.docx$/i.test(file)) sections = await docxToSections(file);
      else if (/\.pptx$/i.test(file)) sections = parsePptxToSlides(file);
    } catch (e) {
      console.warn(`Skipping ${name}: ${e.message}`);
      continue;
    }

    if (!sections.length) continue;

    for (const sec of sections) {
      const title = sec.title;
      const fullText = sec.text;
      const market = detectMarket(name, fullText);
      const topic = detectTopic(name, fullText);

      if (MODE === "full") {
        pushEntry(buckets, topic, { title, topic, market, text: fullText });
        continue;
      }

      // SMART mode: keep headings & bullets, but split long bodies by sentences
      const maxLen = MAX_CHARS_SMART;
      if (fullText.length <= maxLen) {
        pushEntry(buckets, topic, { title, topic, market, text: fullText });
      } else {
        const parts = splitSmartBySentences(fullText, maxLen);
        parts.forEach((p, idx) =>
          pushEntry(buckets, topic, {
            title: `${title} (part ${idx+1})`,
            topic, market, text: p
          })
        );
      }
    }

    console.log(`• ${name} → ${sections.length} section(s)`);
  }

  // write grouped JSONs
  for (const [outPath, entries] of buckets.entries()) {
    // stable ordering: market > title
    entries.sort((a,b)=>
      (a.market||"").localeCompare(b.market||"") ||
      (a.title||"").localeCompare(b.title||"")
    );
    fs.writeFileSync(outPath, JSON.stringify(entries, null, 2), "utf-8");
    console.log(`✅ wrote ${entries.length} → ${path.relative(process.cwd(), outPath)}`);
  }

  console.log(`\nMode: ${MODE.toUpperCase()} — finished. Restart backend to load new knowledge.`);
}

main().catch(err => { console.error(err); process.exit(1); });
