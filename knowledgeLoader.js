// knowledgeLoader.js — load JSON from root or /knowledge, keep only policy-ish lines
import fs from "fs";
import path from "path";
import url from "url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const CANDIDATE_DIRS = [
  process.cwd(),
  path.join(process.cwd(), "knowledge"),
  __dirname,
  path.join(__dirname, "knowledge"),
];

let _cache = null;

function safeReadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); }
  catch { return null; }
}

function isHeading(s) {
  const t = s.trim();
  if (!t) return true;
  // very short, few words, or ends without punctuation
  const words = t.split(/\s+/);
  const looksTitleCase = /^[A-Z][A-Za-z0-9]+(?:\s+[A-Z][A-Za-z0-9]+)*$/.test(t);
  return (
    t.length < 35 ||
    words.length <= 4 ||
    looksTitleCase ||
    /^[*•-]\s*$/.test(t)
  );
}
function isRuleLike(s) {
  const t = s.trim();
  if (t.length < 40) return false;
  if (!/[.!?]$/.test(t)) return false;
  return /(must|should|required|don’t|do not|avoid|use|set|add|choose|is|are|dimensions?|size|1200|1125|780|CR|TL|VAT|tax|tags)/i.test(t);
}

function explodeToLines(x) {
  // Flatten any JSON into individual lines
  const lines = [];
  (function walk(v) {
    if (typeof v === "string") {
      v.split(/\r?\n/).forEach(line => {
        const t = line.trim();
        if (t) lines.push(t);
      });
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  })(x);
  return lines;
}

function normalizeFileToChunks(json, fallbackTopic, filename) {
  const lines = explodeToLines(json)
    // remove bullets markers
    .map(s => s.replace(/^\s*[*•-]\s*/, "").trim())
    // drop slide/page/file meta
    .map(s => s.replace(/\bslide\s*\d+\b|\bpage\s*\d+\b|\b\S+\.(pptx?|pdf|docx?)\b/gi, "").trim())
    // filter out headings
    .filter(s => !isHeading(s));

  const rules = lines.filter(isRuleLike);
  const texts = rules.length ? rules : lines; // fallback if rules are scarce

  return texts.map(t => ({
    title: filename,
    market: "ALL",
    topic: fallbackTopic,
    text: t
  }));
}

function guessTopicFromName(name) {
  const n = name.toLowerCase();
  if (n.includes("company")) return "company";
  if (n.includes("tags_guideline") || n.includes("tags_sop") || n.includes("tags")) return "tags";
  if (n.includes("writing")) return "writing";
  if (n.includes("image")) return "images";
  if (n.includes("zone")) return "zones";
  return "misc";
}

export function getKnowledge() {
  if (_cache) return _cache;

  const results = [];
  const seenFiles = new Set();

  for (const dir of CANDIDATE_DIRS) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".json")); }
    catch { continue; }

    for (const f of files) {
      const full = path.join(dir, f);
      if (seenFiles.has(full)) continue;
      seenFiles.add(full);

      const json = safeReadJSON(full);
      if (!json) continue;

      const topic = guessTopicFromName(f);
      const chunks = normalizeFileToChunks(json, topic, f);
      results.push(...chunks);
    }
  }

  _cache = results;
  console.log(`[knowledgeLoader] Loaded ${results.length} policy lines`);
  return _cache;
}
