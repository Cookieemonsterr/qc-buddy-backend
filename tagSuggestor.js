// tagSuggestor.js
import { loadTags } from "./knowledgeLoader.js";

const FALLBACK = [
  { tag: "Middle Eastern", keywords: ["shawarma","falafel","hummus","kebab","kofta","mansaf","fattoush","tahini"] },
  { tag: "Burgers",        keywords: ["burger","cheeseburger","beef patty","angus"] },
  { tag: "Sandwiches",     keywords: ["sandwich","sub","wrap","tortilla","panini"] },
  { tag: "Grills",         keywords: ["grilled","kebab","shish","bbq","charcoal"] },
  { tag: "Chicken",        keywords: ["chicken","nuggets","tenders","wings"] },
  { tag: "Italian",        keywords: ["pizza","pasta","penne","spaghetti","lasagna","margherita"] },
  { tag: "Desserts",       keywords: ["cheesecake","brownie","pudding","tiramisu","ice cream","kunafa","baklava"] },
  { tag: "Breakfast",      keywords: ["pancake","omelette","egg","foul","fatteh","manakish"] },
];

function score(items, defs) {
  const docs = items.map(s => String(s||"").toLowerCase());
  const scores = new Map();
  for (const { tag, keywords } of defs) {
    let s = 0;
    for (const kw of keywords) for (const it of docs) if (it.includes(kw)) s++;
    if (s>0) scores.set(tag, (scores.get(tag)||0)+s);
  }
  return [...scores.entries()].sort((a,b)=>b[1]-a[1]);
}

export function suggestTagsFromMenu({ items, market="AUTO" }) {
  const { cuisine } = loadTags();
  const defs = (cuisine?.length ? cuisine : []).map(d => ({
    tag: d.tag, keywords: (d.keywords||[]).map(String)
  }));
  // add fallback if sheet is weak/empty
  if (defs.length < 5) defs.push(...FALLBACK);

  // dedupe items
  const uniq = Array.from(new Set(items.map(s=>String(s||"").trim()).filter(Boolean)));

  const ranked = score(uniq, defs);
  const cuisineTags = ranked.slice(0,3).map(([tag])=>tag);

  const reasoning = ranked.slice(0,3).map(([tag,s])=>`Detected "${tag}" signals ${s}× across items`);
  const notes = [];
  if (market==="AE"||market==="AUTO") notes.push("UAE: Up to 3 cuisine tags; tags should reflect ~50% of the menu.");
  if (market==="JO"||market==="AUTO") notes.push("Jordan: Don’t combine unrelated cuisines together.");
  notes.push("Do not use 'Fast Food' unless true mass QSR (McDonald's, Burger King).");

  return { cuisineTags, extraTags: [], reasoning, notes };
}
