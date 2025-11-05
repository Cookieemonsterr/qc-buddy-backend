// server.js — QC Buddy backend (AI throttle + RAG + CSV QC)
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
app.use(cors());
app.use(bodyParser.json());

// ---- tiny global throttle (avoid 429s) ----
let _aiCalls = 0;
const MAX_PER_MIN = Number(process.env.GEMINI_MAX_CALLS_PER_MIN || 30);
setInterval(() => { _aiCalls = 0; }, 60_000);

function aiGatekeeper(req, _res, next) {
  const mode = (process.env.GEMINI_MODE || "flash").toLowerCase();
  if (!process.env.GEMINI_KEY || mode === "off") return next(); // AI disabled
  if (_aiCalls >= MAX_PER_MIN) { req.forceRAG = true; return next(); } // silent fallback
  _aiCalls++;
  next();
}
app.use(aiGatekeeper);

// ---- sanitize AI output so it can't dump JSON/long sections ----
function sanitizeAnswer(s) {
  if (!s) return s;
  s = s.replace(/```[\s\S]*?```/g, "");   // code blocks
  s = s.replace(/\{[\s\S]{200,}\}/g, ""); // big {...}
  s = s.replace(/\[[\s\S]{200,}\]/g, ""); // big [...]
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  if (s.length > 800) s = s.slice(0, 800) + " …";
  return s;
}

// ---- health ----
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "qc-buddy-backend",
    gemini: !!process.env.GEMINI_KEY,
    mode: (process.env.GEMINI_MODE || "flash").toLowerCase(),
    maxPerMin: MAX_PER_MIN
  });
});

// ---- chat /ask ----
app.post("/ask", async (req, res) => {
  try {
    const { message = "", market = "AUTO" } = req.body || {};
    const rag = buildAnswer({ question: message, marketPref: market });

    let finalAnswer = rag.text;

    if (!req.forceRAG && process.env.GEMINI_KEY) {
      const prompt = buildGroundedPrompt({
        question: message,
        marketPref: market,
        sources: rag.sources
      });
      const ai = await callGeminiAPI(prompt);
      if (ai && ai.trim()) finalAnswer = sanitizeAnswer(ai.trim());
    }

    res.json({ answer: finalAnswer, sources: rag.sources });
  } catch (err) {
    console.error("ASK error:", err);
    res.status(500).json({ error: "server_error", details: String(err) });
  }
});

// ---- /fix-file (CSV QC) ----
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
          issues
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

// ---- boot ----
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`QC Buddy backend running on http://localhost:${PORT}`);
});
