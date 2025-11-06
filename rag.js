import "dotenv/config";
import { getKnowledge } from "./knowledgeLoader.js";
import levenshtein from "fast-levenshtein";

function detectTopic(q = "") {
  const s = q.toLowerCase();
  if (/(company|cr\b|trade\s*license|tl\b|trn|vat|address|legal)/.test(s)) return "company";
  if (/(tag|cuisine|qsr|fast\s*food|labels?)/.test(s)) return "tags";
  if (/(capitalize|capitalisation|title case|description|uppercase|lowercase|style|writing)/.test(s)) return "writing";
  if (/(image|hero|1200|1125|780|dimension|size|photo|banner)/.test(s)) return "images";
  if (/(zone|radius|discovery|delivery|coverage|plan\s*a|area)/.test(s)) return "zones";
  return "misc";
}

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
  return (chunks || []).map(c => {
    const t = (c.text || "");
    const lev = levenshtein.get(q.slice(0, 160), t.slice(0, 160));
    let score = Math.max(0, 80 - lev);
    score += keywordScore(q, t) * 6;
    if ((c.topic || "misc") === topic) score += 25;
    // prefer sentences with punctuation/rules
    if (/[.!?]$/.test(t)) score += 8;
    if (/must|should|required|don’t|do not|avoid|use|set|add|dimensions?|CR|TL|VAT|tax|tags|1200|1125|780/i.test(t)) score += 10;
    return { c, score };
  }).sort((a,b)=>b.score-a.score);
}

export function buildAnswer({ question, marketPref = "AUTO" }) {
  const ALL = getKnowledge();
  if (!ALL?.length) return { text: "I couldn’t find any SOP data yet.", sources: [] };

  const ranked = scoreChunks(question, ALL, marketPref);
  const top = ranked.slice(0, 12).map(r => r.c.text);

  // extract up to 3 distinct rule lines
  const chosen = [];
  const seen = new Set();
  for (const line of top) {
    const key = line.toLowerCase().replace(/\W+/g," ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    chosen.push(line);
    if (chosen.length >= 3) break;
  }

  const sources = ranked.slice(0,3).map(r=>({
    title: r.c.title, market: r.c.market, topic: r.c.topic, text: r.c.text
  }));

  const text = chosen.length ? chosen.map(s => `- ${s}`).join("\n") : "";
  return { text, sources };
}

/* Keep your buildGroundedPrompt and callGeminiAPI from the previous message
   (the versions that forbid slide/file mentions). */
export { buildGroundedPrompt, callGeminiAPI } from "./rag_grounded_keep_prev.js";
