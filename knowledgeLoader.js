// knowledgeLoader.js — robust loader that works with or without /knowledge
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
  try {
    const s = fs.readFileSync(p, "utf-8");
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function flattenUnknownJSON(json, fallbackTopic) {
  // Normalize ANY JSON into [{title, market, topic, text}]
  const out = [];

  const pushChunk = (text, topic = fallbackTopic, title = "", market = "ALL") => {
    const t = String(text || "").trim();
    if (!t) return;
    out.push({ title: title || "SOP", market, topic, text: t });
  };

  if (Array.isArray(json)) {
    // Could already be chunk objects OR strings
    for (const item of json) {
      if (item && typeof item === "object" && (item.text || item.body)) {
        pushChunk(item.text || item.body, item.topic || fallbackTopic, item.title || "", item.market || "ALL");
      } else if (typeof item === "string") {
        pushChunk(item, fallbackTopic);
      }
    }
  } else if (json && typeof json === "object") {
    // Arbitrary object: collect all string leaves
    const leaves = [];
    (function walk(x) {
      if (typeof x === "string") {
        const s = x.trim();
        if (s) leaves.push(s);
      } else if (Array.isArray(x)) {
        x.forEach(walk);
      } else if (x && typeof x === "object") {
        Object.values(x).forEach(walk);
      }
    })(json);
    if (leaves.length) pushChunk(leaves.join(" • "), fallbackTopic);
  }

  return out;
}

function guessTopicFromName(name) {
  const n = name.toLowerCase();
  if (n.includes("company")) return "company";
  if (n.includes("tags_guideline")) return "tags";
  if (n.includes("tags_sop") || n.includes("tags")) return "tags";
  if (n.includes("writing")) return "writing";
  if (n.includes("image")) return "images";
  if (n.includes("zone")) return "zones";
  if (n.includes("step_by_step") || n.includes("qc")) return "misc";
  if (n.includes("basechunks") || n.includes("chunk")) return "misc";
  return "misc";
}

export function getKnowledge() {
  if (_cache) return _cache;

  const results = [];
  const seen = new Set();

  for (const dir of CANDIDATE_DIRS) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".json"));
    } catch {
      continue;
    }
    for (const f of files) {
      const key = path.join(dir, f);
      if (seen.has(key)) continue;
      seen.add(key);

      const json = safeReadJSON(key);
      if (!json) continue;

      const topic = guessTopicFromName(f);
      const normalized = flattenUnknownJSON(json, topic);
      for (const c of normalized) {
        // attach filename as title if missing
        if (!c.title) c.title = f;
        results.push(c);
      }
    }
  }

  _cache = results;
  console.log(`[knowledgeLoader] Loaded ${results.length} chunks from ${CANDIDATE_DIRS.join(" | ")}`);
  return _cache;
}
