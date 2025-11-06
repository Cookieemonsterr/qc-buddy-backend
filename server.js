// server.js — QC Buddy backend (RAG + Gemini + CSV QC + cute batch + no slide refs)
import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import multer from "multer";
import csvParser from "csv-parser";
import fs from "fs";

import { buildAnswer, buildGroundedPrompt, callGeminiAPI } from "./rag.js";
import { getKnowledge } from "./knowledgeLoader.js";
import { qcCheckSingle } from "./validators.js";

const app = express();

/* ---------- CORS ---------- */
const ALLOW = [
  "http://localhost:5173",
  "https://cookieemonsterr.github.io",
  "https://cookieemonsterr.github.io/qc-buddy-frontend",
];
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || ALLOW.includes(origin)),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.options("*", cors());

/* ---------- Parsers ---------- */
app.use(bodyParser.json({ limit: "2mb" }));

/* ---------- AI throttle ---------- */
let _aiCalls = 0;
const MAX_PER_MIN = Number(process.env.GEMINI_MAX_CALLS_PER_MIN || 30);
setInterval(() => (_aiCalls = 0), 60_000);
function aiGatekeeper(req, _res, next) {
  const mode = (process.env.GEMINI_MODE || "flash").toLowerCase();
  if (!process.env.GEMINI_KEY || mode === "off") return next(); // AI disabled
  if (_aiCalls >= MAX_PER_MIN) req.forceRAG = true;
  else _aiCalls++;
  next();
}
app.use(aiGatekeeper);

/* ---------- Cleaners ---------- */
function sanitizeAnswer(s) {
  if (!s) return s;
  s = s.replace(/```[\s\S]*?```/g, ""); // code blocks
  s = s.replace(/\{[\s\S]{200,}\}/g, ""); // big {...}
  s = s.replace(/\[[\s\S]{200,}\]/g, ""); // big [...]
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  if (s.length > 900) s = s.slice(0, 900) + " …";
  return s;
}
function stripMetaRefs(s) {
  if (!s) return s;
  return s
    .replace(/^\s*[*\-•]\s*(slide\s*\d+|page\s*\d+|see\s+.*\.(pptx?|pdf|docx?)).*$/gim, "")
    .replace(/\bslide\s*\d+\b/gi, "")
    .replace(/\bpage\s*\d+\b/gi, "")
    .replace(/\b\S+\.(pptx?|pdf|docx?)\b/gi, "")
    .replace(/^\s*[*\-•]\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ---------- Health + Debug ---------- */
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "qc-buddy-backend",
    gemini: !!process.env.GEMINI_KEY,
    mode: (process.env.GEMINI_MODE || "flash").toLowerCase(),
    maxPerMin: MAX_PER_MIN,
  });
});
app.get("/debug/knowledge", (_req, res) => {
  const all = getKnowledge();
  res.json({
    count: all.length,
    sample: all.slice(0, 5).map((c) => ({
      title: c.title,
      topic: c.topic,
      market: c.market,
      textPreview: (c.text || "").slice(0, 160),
    })),
  });
});

/* ---------- Core single-item answer ---------- */
async function answerOne(message, market, forceRAG = false) {
  const rag = buildAnswer({ question: message, marketPref: market });

  // No SOP? Be honest. Do NOT call Gemini.
  if (!rag?.sources?.length) {
    return {
      answer: "I don't have this in the SOP.",
      sources: [],
      buddyMood: "confused",
    };
  }

  let finalAnswer = rag.text || "";
  const mode = (process.env.GEMINI_MODE || "flash").toLowerCase();
  const aiEnabled = !!process.env.GEMINI_KEY && mode !== "off";

  if (!forceRAG && aiEnabled) {
    const prompt = buildGroundedPrompt({
      question: message,
      marketPref: market,
      sources: rag.sources,
    });
    const ai = await callGeminiAPI(prompt);
    if (ai && ai.trim()) finalAnswer = ai.trim();
  }

  // Final cleanup
  finalAnswer = stripMetaRefs(finalAnswer || rag.text || "I don't have this in the SOP.");
  finalAnswer = sanitizeAnswer(finalAnswer);

  return {
    answer: finalAnswer,
    sources: rag.sources || [],
    buddyMood: finalAnswer.includes("I don't have this") ? "confused" : "happy",
  };
}

/* ---------- Cute batch formatter ---------- */
function cuteList(results) {
  const lines = results.map(({ label, answer }) => {
    const first = (answer || "").split("\n")[0].trim();
    return `• **${label}** — ${first || "Looks good ✅"}`;
  });
  return [
    "Here’s what I found ✨",
    "",
    ...lines,
    "",
    "Want me to suggest cuisine tags too? 😼",
  ].join("\n");
}

/* ---------- Chat (with boss easter egg) ---------- */
async function handleAsk(req, res) {
  try {
    const { message = "", market = "AUTO" } = req.body || {};
    const text = String(message).trim();
    if (!text) return res.status(400).json({ error: "missing_message" });

    // Easter egg
    const easterEggRe = /اذا\s+نمت\s+وانا\s+جوعان\s+شو\s+بتساوي[؟?]?\s*$/i;
    if (easterEggRe.test(text)) {
      return res.json({
        answer: "اوووووووووووووووووووو\n\n**بطلبلك اكل وبطعميك من ايدي** 😼",
        sources: [],
        buddyMood: "happy",
      });
    }

    const items = text.split("\n").map((s) => s.trim()).filter(Boolean);

    if (items.length > 1) {
      const results = [];
      for (const item of items) {
        const r = await answerOne(item, market, req.forceRAG);
        results.push({ label: item, answer: r.answer, sources: r.sources });
      }
      return res.json({
        answer: cuteList(results),
        sources: results.flatMap((r) => r.sources || []),
        buddyMood: "helpful",
      });
    }

    const r = await answerOne(text, market, req.forceRAG);
    return res.json(r);
  } catch (err) {
    console.error("ASK error:", err);
    return res.status(500).json({ error: "server_error", details: String(err) });
  }
}

/* Routes (compat aliases) */
app.post("/ask", handleAsk);
app.post("/chat", handleAsk);
app.post("/api/ask", handleAsk);
app.post("/api/chat", handleAsk);
app.post("/", handleAsk);

/* ---------- Suggest tags ---------- */
app.post("/suggest-tags", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const market = String(req.body?.market || "AUTO");
    if (!items.length) {
      return res.status(400).json({
        cuisineTags: [],
        extraTags: [],
        reasoning: [],
        notes: ["No items provided."],
      });
    }

    const prompt = [
      `You are QC Buddy. Market: ${market}.`,
      `For the items below, suggest 1–3 concise cuisine tags (lowercase, no emojis).`,
      `Return JSON only: {"cuisineTags":["..."],"extraTags":["..."],"reasoning":["..."],"notes":["..."]}`,
      ``,
      `Items:`,
      ...items.map((s, i) => `${i + 1}. ${s}`),
    ].join("\n");

    let parsed = null;
    const ai = await callGeminiAPI(prompt);
    if (ai) {
      const jsonish = ai.replace(/```(?:json)?|```/g, "").trim();
      try { parsed = JSON.parse(jsonish); } catch { parsed = null; }
    }

    if (!parsed || !Array.isArray(parsed.cuisineTags)) {
      return res.json({
        cuisineTags: [],
        extraTags: [],
        reasoning: [],
        notes: ["Couldn’t generate tags right now."],
      });
    }

    const clamp = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : []);
    return res.json({
      cuisineTags: clamp(parsed.cuisineTags, 12),
      extraTags: clamp(parsed.extraTags || [], 12),
      reasoning: clamp(parsed.reasoning || [], 8),
      notes: clamp(parsed.notes || [], 4),
    });
  } catch (err) {
    console.error("SUGGEST TAGS error:", err);
    return res.status(500).json({
      cuisineTags: [],
      extraTags: [],
      reasoning: [],
      notes: ["Server error generating tags."],
    });
  }
});

/* ---------- CSV QC (/fix-file) ---------- */
const upload = multer({ dest: "uploads/" });

app.post("/fix-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file?.path) return res.status(400).json({ error: "no_file" });
    const market = req.body?.market || "AUTO";

    const rows = [];
    const issues = [];

    fs.createReadStream(req.file.path)
      .pipe(csvParser())
      .on("data", (row) => {
        rows.push(row);

        const name =
          row["item_name"] || row["name"] || row["Item Name"] || row["Name"] || "";
        const desc =
          row["item_description"] || row["description"] ||
          row["Item Description"] || row["Description"] || "";

        const rowIssues = qcCheckSingle({ name, desc, market, tax: null, row });
        if (rowIssues?.length) issues.push({ row, rowIssues });
      })
      .on("end", () => {
        try { fs.unlinkSync(req.file.path); } catch {}
        res.json({
          message: "File processed successfully",
          totalRows: rows.length,
          rowsWithIssues: issues.length,
          issues,
        });
      })
      .on("error", (e) => {
        try { fs.unlinkSync(req.file.path); } catch {}
        console.error("CSV parse error:", e);
        res.status(500).json({ error: "file_parse_error", details: String(e) });
      });
  } catch (err) {
    console.error("FIX-FILE error:", err);
    res.status(500).json({ error: "file_process_error", details: String(err) });
  }
});

/* ---------- Boot ---------- */
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`QC Buddy backend running on http://localhost:${PORT}`);
});

