// rag.js — RAG + cached/backoff Gemini + strict grounded prompt
import "dotenv/config";
import { getKnowledge } from "./knowledgeLoader.js";
import levenshtein from "fast-levenshtein";

/* Topic detection */
function detectTopic(q = "") {
  const s = q.toLowerCase();
  if (/(company|cr\b|trade\s*license|tl\b|trn|vat|address)/.test(s)) return "company";
  if (/(tag|cuisine|fast\s*food|only on careem|new restaurant|c\+)/.test(s)) return "tags";
  if (/(capitalize|capitalisation|writing|description|customization|customisation|uppercase|lowercase)/.test(s)) return "writing";
  if (/(image|hero|1200|1125|780|dimension|size)/.test(s)) return "images";
  if (/(zone|radius|discovery|delivery area|coverage|plan\s*a)/.test(s)) return "zones";
  return "misc";
}

/* Rank chunks */
function scoreChunks(question, chunks, marketPref = "AUTO") {
  const q = (question || "").toLowerCase();
  const mkt = (marketPref || "AUTO").toUpperCase();

  return (chunks || []).map(c => {
    const t = (c.text || "").toLowerCase();
    const dist = levenshtein.get(q, t.slice(0, 300));
    const market = (c.market || "ALL").toUpperCase();
    const topic = (c.topic || "misc").toLowerCase();

    let score = Math.max(0, 60 - dist);
    if (market === mkt) score += 40;
    else if (market === "ALL" || mkt === "AUTO") score += 10;
    if (topic.includes(detectTopic(q))) score += 20;

    return { c, score };
  }).sort((a, b) => b.score - a.score);
}

/* Build RAG answer (concise + summary) */
export function buildAnswer({ question, marketPref = "AUTO" }) {
  const ALL = getKnowledge();
  if (!ALL?.length) {
    return { text: "I couldn’t find any SOP data yet.", sources: [] };
  }

  const topic = detectTopic(question);
  const ranked = scoreChunks(question, ALL, marketPref).slice(0, 3);
  const best = ranked[0]?.c;

  const summary =
    topic === "company"
      ? "Company: take data from official docs (AE: CR/TL; JO: CR). Remove ‘Sole Proprietorship’. Keep only ‘L.L.C’. Don’t invent."
      : topic === "tags"
      ? "Tags: Up to 3 cuisine tags; reflect ~50% of menu. Avoid ‘Fast Food’ unless true QSR."
      : topic === "writing"
      ? "Writing: Item names Title Case; descriptions sentence-style; options Every Word Capitalized."
      : topic === "images"
      ? "Images: item 1200×1200; hero 1125×780."
      : topic === "zones"
      ? "Zones: discovery/delivery radius depends on city/zone; ask a specific city."
      : "I’ll answer using the SOP context (company, tags, writing, images, or zones).";

  const text = `${summary}${best?.text ? `\n\n${best.text}` : ""}`.trim();

  const sources = ranked.map(r => ({
    title: r.c.title,
    market: r.c.market,
    topic: r.c.topic,
    text: r.c.text
  }));

  return { text, sources };
}

/* ---- normalize context so model won't regurgitate JSON ---- */
function normalizeContextText(t) {
  if (!t) return "";
  t = String(t);
  t = t.replace(/```[\s\S]*?```/g, ""); // remove code fences

  const s = t.trim();
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try {
      const obj = JSON.parse(s);
      const leafs = [];
      (function walk(x) {
        if (typeof x === "string") {
          const v = x.trim();
          if (v) leafs.push(v);
        } else if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === "object") Object.values(x).forEach(walk);
      })(obj);
      t = leafs.join(" • ");
    } catch { /* ignore */ }
  }

  t = t.replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (t.length > 1200) t = t.slice(0, 1200) + " …";
  return t;
}

/* ---- strict, trimmed grounded prompt ---- */
export function buildGroundedPrompt({ question, marketPref = "AUTO", sources = [] }) {
  const blocks = (sources || [])
    .slice(0, 3)
    .map((s, i) => `• ${s.title || `Source ${i+1}`} [${s.market || "ALL"}/${s.topic || "misc"}]: ${normalizeContextText(s.text || "")}`)
    .join("\n");

  return `
You are QC Buddy. Answer ONLY using the SOP facts below.
Output rules:
- 1–3 SHORT bullet points (max).
- DO NOT print lists, sections or JSON.
- If not covered, reply exactly: "I don't have this in the SOP."

Market: ${marketPref}
Question: ${question}

SOP facts:
${blocks}
`.trim();
}

/* ---- AI with cache + backoff + mode switch ---- */
const _aiCache = new Map();
function _cacheGet(key) {
  const ttl = Number(process.env.GEMINI_CACHE_TTL_MS || 600000);
  const v = _aiCache.get(key);
  if (!v) return null;
  if (Date.now() - v.at > ttl) { _aiCache.delete(key); return null; }
  return v.text;
}
function _cacheSet(key, text) {
  _aiCache.set(key, { at: Date.now(), text });
  if (_aiCache.size > 500) _aiCache.delete(_aiCache.keys().next().value);
}
const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function callGeminiAPI(prompt) {
  const key = process.env.GEMINI_KEY;
  const mode = (process.env.GEMINI_MODE || "flash").toLowerCase();
  if (!key || mode === "off") return null;

  const cacheKey = `${mode}:${prompt.slice(0, 1200)}`;
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;

  const models = (mode === "flash")
    ? ["gemini-2.0-flash","gemini-2.0-flash-lite","gemini-1.5-flash"]
    : ["gemini-2.5-flash","gemini-2.0-flash","gemini-2.0-flash-lite"];

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }]}],
    generationConfig: { temperature: 0.2, maxOutputTokens: 700 }
  };

  for (const m of models) {
    let delay = 400;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`;
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const d = await r.json();
        const txt = d?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (r.ok && txt) {
          console.log(`[Gemini] ✅ ${m} (attempt ${attempt})`);
          _cacheSet(cacheKey, txt);
          return txt;
        }

        const code = d?.error?.code || r.status;
        const msg = d?.error?.message || r.statusText;
        console.log(`[Gemini] ❌ ${m} -> ${code} ${msg}`);

        if (code === 429 || String(code).startsWith("5")) { await _sleep(delay); delay *= 2; continue; }
        break; // non-retryable => next model
      } catch (e) {
        console.log(`[Gemini] ❌ ${m} failed ->`, e.message);
        await _sleep(delay); delay *= 2;
      }
    }
  }
  return null; // caller uses RAG fallback
}
