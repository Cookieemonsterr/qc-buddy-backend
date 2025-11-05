// knowledgeLoader.js — loads ./knowledge/*.json into {title,market,topic,text}[]
import fs from "fs";
import path from "path";

const DIR = path.resolve("knowledge");

function toChunks(doc, filename) {
  const chunks = [];

  // If already an array of chunks
  if (Array.isArray(doc)) {
    for (const c of doc) {
      chunks.push({
        title: c.title || filename.replace(".json",""),
        market: (c.market || "ALL").toUpperCase(),
        topic: (c.topic || "misc").toLowerCase(),
        text: typeof c.text === "string" ? c.text : JSON.stringify(c.text ?? c, null, 2)
      });
    }
    return chunks;
  }

  // If it's an object: flatten to one chunk
  const guessTopic = /tag/i.test(filename) ? "tags"
                   : /writ/i.test(filename) ? "writing"
                   : /company|step|qc/i.test(filename) ? "company"
                   : "misc";
  const text = typeof doc === "string" ? doc : JSON.stringify(doc, null, 2);

  chunks.push({
    title: doc?.meta?.title || filename.replace(".json",""),
    market: "ALL",
    topic: guessTopic,
    text
  });
  return chunks;
}

export function getKnowledge() {
  if (!fs.existsSync(DIR)) return [];
  const files = fs.readdirSync(DIR).filter(f => f.endsWith(".json"));
  const all = [];
  for (const f of files) {
    try {
      const raw = fs.readFileSync(path.join(DIR, f), "utf-8");
      const doc = JSON.parse(raw);
      all.push(...toChunks(doc, f));
    } catch (e) {
      console.error("Knowledge load error:", f, e.message);
    }
  }
  return all;
}
