// ai.js — Gemini wrapper with safe fallback
import { GoogleGenerativeAI } from "@google/generative-ai";

const key = process.env.GEMINI_KEY;
let model = null;

export function getModel() {
  if (!key) throw new Error("GEMINI_KEY not set");
  if (!model) {
    const genAI = new GoogleGenerativeAI(key);
    model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
  }
  return model;
}

export async function askGemini({ question, context }) {
  try {
    const prompt = `
You are QC Buddy, a Careem QC assistant.
Answer clearly using ONLY the context below; if unsure, say you need clarification.
Keep answers concise and practical for QC tasks.

Context:
${context || "(no context provided)"}

Question: ${question}
Answer:
`.trim();

    const res = await getModel().generateContent(prompt);
    const text = res?.response?.text?.() || res?.response?.text || "";
    return text || "Sorry, I couldn't generate a response.";
  } catch (err) {
    console.error("Gemini error:", err?.message || err);
    return null; // let caller fall back to RAG
  }
}
