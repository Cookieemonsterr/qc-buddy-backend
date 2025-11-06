import "dotenv/config";
import { getKnowledge } from "./knowledgeLoader.js";
import levenshtein from "fast-levenshtein";

/* ---------- Topic detection ---------- */
function detectTopic(q = "") {
  const s = q.toLowerCase();
  if (/(company|cr\b|trade\s*license|tl\b|trn|vat|address|legal)/.test(s)) return "company";
  if (/(tag|cuisine|qsr|fast\s*food|labels?)/.test(s)) return "tags";
  if (/(capitalize|capitalisation|title case|description|uppercase|lowercase|style|writing)/.test(s)) return "writing";
  if (/(image|hero|1200|1125|780|dimension|size|photo|banner)/.test(s)) return "images";
  if (/(zone|radius|discovery|delivery|coverage|plan\s*a|area)/.test(s)) return "zones";
  return "misc";
}

/* ---------- Ranking ---------- */
function keywordScore(q, t) {
  const qWords = q.toLowerCase().match(/[a-z0-9]+/g) || [];
  const tWords = new Set((t.toLowerCase().match(/[a-z0-9]+/g) || []));
  let hit = 0;
  for (const w of qWords) if (tWords.has(w)) hit++;
  return hit;
}
function scoreChunks(question, chunks, marketPref = "AUTO") {
  const q = (question || "").toLowerCase();
  const topic = detectTopic(q);
  return (chunks || [])
    .map((c) => {
      const t = c.text || "";
      const lev = levenshtein.get(q.slice(0, 160), t.slice(0, 160));
      let score = Math.max(0, 80 - lev);
      score += keywordScore(q, t) * 6;
      if ((c.topic || "misc") === topic) score += 25;
      if (/[.!?]$/.test(t)) score += 8;
      if (/must|should|required|don’t|do not|avoid|use|set|add|dimensions?|CR|TL|VAT|tax|tags|1200|1125|780/i.test(t)) score += 10;
      return { c, score };
    })
    .sort((a, b) => b.score - a.score);
}

/* ---------- Build RAG answer (up to 3 rule lines) ---------- */
export function buildAnswer({ question, marketPref = "AUTO" }) {
  const ALL = getKnowledge();
  if (!ALL?.length) return { text: "I couldn’t find any SOP data yet.", sources: [] };

  const ranked = scoreChunks(question, ALL, marketPref);
  const top = ranked.slice(0, 12).map((r) => r.c.text);

  const chosen = [];
  const seen = new Set();
  for (const line of top) {
    const key = line.toLowerCase().replace(/\W+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    chosen.push(line);
    if (chosen.length >= 3) break;
  }

  const sources = ranked.slice(0, 3).map((r) => ({
    title: r.c.title,
    market: r.c.market,
    topic: r.c.topic,
    text: r.c.text,
  }));

  const text = chosen.length ? chosen.map((s) => `- ${s}`).join("\n") : "";
  return { text, sources };
}

/* ---------- Normalize context + Grounded prompt ---------- */
function normalizeContextText(t) {
  if (!t) return "";
  t = String(t).replace(/```[\s\S]*?```/g, "");
  t = t
    .replace(/\bslide\s*\d+\b/gi, "")
    .replace(/\bpage\s*\d+\b/gi, "")
    .replace(/\b\S+\.(pptx?|pdf|docx?)\b/gi, "");
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
    } catch {}
  }
  t = t.replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (t.length > 1200) t = t.slice(0, 1200) + " …";
  return t;
}

export function buildGroundedPrompt({ question, marketPref = "AUTO", sources = [] }) {
  const blocks = (sources || [])
    .slice(0, 3)
    .map(
      (s, i) =>
        `• ${s.title || `Source ${i + 1}`} [${s.market || "ALL"}/${s.topic || "misc"}]: ${normalizeContextText(
          s.text || ""
        )}`
    )
    .join("\n");

  if (!blocks.trim()) {
    return `
You are QC Buddy. There are NO SOP facts for this question.
Reply EXACTLY with: "I don't have this in the SOP."
`.trim();
  }

  return `
You are QC Buddy — concise, friendly, playful but STRICT about SOP.
Answer ONLY using the SOP facts below.

Hard rules:
- Give the policy answer directly.
- DO NOT mention slides, filenames, pages, decks, or where to find info.
- Write 1–3 SHORT bullet points (max). No headings, no JSON.
- If the SOP doesn’t cover it, reply exactly: "I don't have this in the SOP." Then add ONE next step.

Market: ${marketPref}
Question: ${question}

SOP facts:
${blocks}
`.trim();
}

/* ---------- Gemini client (cache/backoff) ---------- */
const _aiCache = new Map();
function _cacheGet(key) {
  const ttl = Number(process.env.GEMINI_CACHE_TTL_MS || 600000);
  const v = _aiCache.get(key);
  if (!v) return null;
  if (Date.now() - v.at > ttl) {
    _aiCache.delete(key);
    return null;
  }
  return v.text;
}
function _cacheSet(key, text) {
  _aiCache.set(key, { at: Date.now(), text });
  if (_aiCache.size > 500) _aiCache.delete(_aiCache.keys().next().value);
}
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function callGeminiAPI(prompt) {
  const key = process.env.GEMINI_KEY;
  const mode = (process.env.GEMINI_MODE || "flash").toLowerCase();

  if (!key) { console.log("[Gemini] SKIP: no GEMINI_KEY"); return null; }
  if (mode === "off") { console.log("[Gemini] SKIP: GEMINI_MODE=off"); return null; }

  const cacheKey = `${mode}:${prompt.slice(0, 1200)}`;
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;

  const models =
    mode === "flash"
      ? ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash"]
      : ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.0-flash-lite"];

  const payload = {
    contents: [{ role: "user", parts: [{ text: prompt }]}],
    generationConfig: { temperature: 0.25, maxOutputTokens: 320 },
  };

  for (const m of models) {
    let delay = 500;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`;
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const d = await r.json().catch(() => ({}));
        const txt = d?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (r.ok && txt) {
          console.log(`[Gemini] ✅ ${m} (attempt ${attempt})`);
          _cacheSet(cacheKey, txt);
          return txt;
        }

        const code = d?.error?.code || r.status;
        const msg = d?.error?.message || r.statusText;
        console.log(`[Gemini] ❌ ${m} (attempt ${attempt}) -> ${code} ${msg}`);
        if (code === 429 || String(code).startsWith("5")) {
          await _sleep(delay);
          delay = Math.min(delay * 2, 4000);
          continue;
        }
        break;
      } catch (e) {
        console.log(`[Gemini] ❌ ${m} (attempt ${attempt}) exception ->`, e.message);
        await _sleep(delay);
        delay = Math.min(delay * 2, 4000);
      }
    }
  }
  console.log("[Gemini] All models failed; using RAG only.");
  return null;
}
