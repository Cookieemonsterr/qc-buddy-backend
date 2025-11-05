// server.js — QC Buddy backend (RAG + Gemini + CSV QC)
// ESM module (use "type":"module" in package.json)
import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import multer from "multer";
import csvParser from "csv-parser";
import fs from "fs";

import { buildAnswer, buildGroundedPrompt, callGeminiAPI } from "./rag.js";
import { qcCheckSingle } from "./validators.js";

const app = express();

// ---------- CORS (tight allow list) ----------
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

// ---------- Parsers ----------
app.use(bodyParser.json({ limit: "2mb" }));

// ---------- AI throttle (avoid 429s) ----------
let _aiCalls = 0;
const MAX_PER_MIN = Number(process.env.GEMINI_MAX_CALLS_PER_MIN || 30);
setInterval(() => {
  _aiCalls = 0;
}, 60_000);

function aiGatekeeper(req, _res, next) {
  const mode = (process.env.GEMINI_MODE || "flash").toLowerCase();
  if (!process.env.GEMINI_KEY || mode === "off") return next(); // AI disabled
  if (_aiCalls >= MAX_PER_MIN) {
    req.forceRAG = true; // switch to pure RAG silently
    return next();
  }
  _aiCalls++;
  next();
}
app.use(aiGatekeeper);

// ---------- Sanitizer ----------
function sanitizeAnswer(s) {
  if (!s) return s;
  s = s.replace(/```[\s\S]*?```/g, ""); // code blocks
  s = s.replace(/\{[\s\S]{200,}\}/g, ""); // big {...}
  s = s.replace(/\[[\s\S]{200,}\]/g, ""); // big [...]
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  if (s.length > 800) s = s.slice(0, 800) + " …";
  return s;
}

// ---------- Health ----------
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "qc-buddy-backend",
    gemini: !!process.env.GEMINI_KEY,
    mode: (process.env.GEMINI_MODE || "flash").toLowerCase(),
    maxPerMin: MAX_PER_MIN,
  });
});

// ---------- Core single-item answer using your RAG + optional Gemini ----------
async function answerOne(message, market, forceRAG = false) {
  const rag = buildAnswer({ question: message, marketPref: market });
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
    if (ai && ai.trim()) finalAnswer = sanitizeAnswer(ai.trim());
  }

  return {
    answer: finalAnswer || "Looks good ✅",
    sources: rag.sources || [],
    buddyMood: "happy",
  };
}

// ---------- Cute formatter for batch replies ----------
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

// ---------- Chat endpoints (single + multi-line) ----------
async function handleAsk(req, res) {
  try {
    const { message = "", market = "AUTO" } = req.body || {};
    const text = String(message).trim();
    if (!text) return res.status(400).json({ error: "missing_message" });

    const items = text.split("\n").map((s) => s.trim()).filter(Boolean);

    // Multi-line → batch cute mode
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

    // Single-line → normal
    const r = await answerOne(text, market, req.forceRAG);
    return res.json(r);
  } catch (err) {
    console.error("ASK error:", err);
    return res.status(500).json({ error: "server_error", details: String(err) });
  }
}

// Primary + compatibility routes
app.post("/ask", handleAsk);
app.post("/chat", handleAsk);
app.post("/api/ask", handleAsk);
app.post("/api/chat", handleAsk);

// ---------- Suggest tags (concise JSON; safe fallback) ----------
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

    const mode = (process.env.GEMINI_MODE || "flash").toLowerCase();
    const aiEnabled = !!process.env.GEMINI_KEY && mode !== "off";

    let parsed = null;
    if (aiEnabled && !req.forceRAG) {
      const prompt = [
        `You are a QC assistant for food menus (market: ${market}).`,
        `For the items below, suggest 1–3 concise cuisine tags (lowercase, no emojis).`,
        `Return JSON only: {"cuisineTags":["..."],"extraTags":["..."],"reasoning":["..."],"notes":["..."]}`,
        ``,
        `Items:`,
        ...items.map((s, i) => `${i + 1}. ${s}`),
      ].join("\n");

      const raw = await callGeminiAPI(prompt);
      const jsonish = (raw || "").replace(/```(?:json)?|```/g, "").trim();
      try {
        parsed = JSON.parse(jsonish);
      } catch {
        parsed = null;
      }
    }

    // Safe fallback if AI off/throttled/bad JSON
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

// ---------- CSV QC (/fix-file) ----------
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
          row["item_name"] ||
          row["name"] ||
          row["Item Name"] ||
          row["Name"] ||
          "";
        const desc =
          row["item_description"] ||
          row["description"] ||
          row["Item Description"] ||
          row["Description"] ||
          "";

        const rowIssues = qcCheckSingle({ name, desc, market, tax: null, row });
        if (rowIssues?.length) issues.push({ row, rowIssues });
      })
      .on("end", () => {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
        res.json({
          message: "File processed successfully",
          totalRows: rows.length,
          rowsWithIssues: issues.length,
          issues,
        });
      })
      .on("error", (e) => {
        try {
          fs.unlinkSync(req.file.path);
        } catch {}
        console.error("CSV parse error:", e);
        res
          .status(500)
          .json({ error: "file_parse_error", details: String(e) });
      });
  } catch (err) {
    console.error("FIX-FILE error:", err);
    res.status(500).json({ error: "file_process_error", details: String(err) });
  }
});

// ---------- Boot ----------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`QC Buddy backend running on http://localhost:${PORT}`);
});
