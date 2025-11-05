// validators.js
import levenshtein from "fast-levenshtein";

export function fixItemNameCase(name) {
  if (!name) return name;
  const skip = ["a","an","the","of","and","or","in","on","with"];
  return name.toLowerCase().split(/\s+/).map((w,i)=>
    (skip.includes(w)&&i!==0) ? w : w.charAt(0).toUpperCase()+w.slice(1)
  ).join(" ");
}

export function cleanDescription(desc) {
  if (!desc) return desc;
  // 1) trim + remove trailing periods + collapse double spaces
  let out = desc.trim().replace(/\.+$/, "").replace(/\s{2,}/g, " ");
  // 2) ensure first character uppercase, preserve rest as-is
  if (out.length) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}

function isMostlyTitleCase(text) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  let titleish = 0;
  for (const w of words) {
    if (/^[A-Z][a-z]+$/.test(w)) titleish++;
  }
  return titleish / words.length >= 0.7; // 70% threshold
}

export function checkItemName(name) {
  if (!name) return [];
  const fixed = fixItemNameCase(name);
  return (fixed===name) ? [] : [{
    field:"item_name", type:"capitalization",
    message:`Item names are Title Case → "${fixed}"`, fix: fixed
  }];
}

export function checkDescription(desc) {
  if (!desc) return [];
  const issues = [];
  const cleaned = cleanDescription(desc);
  if (cleaned !== desc)
    issues.push({ field:"item_description", type:"punctuation/casing",
      message:"Descriptions: sentence style; no trailing period; no double spaces",
      fix: cleaned });
  if (isMostlyTitleCase(desc))
    issues.push({ field:"item_description", type:"style",
      message:"Descriptions should NOT be Title Case.", fix: cleaned });
  return issues;
}

// optional EN spelling using small dictionary list
function bestSuggestion(word, dict) {
  let best = { word:null, dist: 1e9 };
  for (const d of dict) {
    const dd = levenshtein.get(word.toLowerCase(), String(d).toLowerCase());
    if (dd < best.dist) best = { word:d, dist: dd };
    if (dd===0) break;
  }
  return best.dist <= 2 ? best.word : null;
}
export function checkSpellingEnglish(text, dictionary) {
  if (!text || !dictionary?.length) return [];
  const issues = [];
  for (const t of text.split(/\b/)) {
    if (!/^[A-Za-z]{3,}$/.test(t)) continue;
    const suggestion = bestSuggestion(t, dictionary);
    if (suggestion && suggestion.toLowerCase() !== t.toLowerCase()) {
      issues.push({ field:"english", type:"spelling",
        message:`"${t}" looks like a typo`, fix:suggestion });
    }
  }
  return issues;
}

// glossary pairs: { AE:[{en,ar}], JO:[{en,ar}] }
function glossaryExpect({ enText, arText, market, glossary }) {
  if (!enText || !arText) return [];
  const pairs = glossary?.[market] || [];
  const issues = [];
  for (const { en, ar } of pairs) {
    if (String(enText).toLowerCase().includes(String(en).toLowerCase())) {
      if (!String(arText).includes(String(ar))) {
        issues.push({
          type:"glossary_mismatch",
          message:`If "${en}" appears in EN, expect "${ar}" in AR (${market}).`,
          fix:`Use Arabic: ${ar}`
        });
      }
    }
  }
  return issues;
}

export function checkCategories(row, market, glossary) {
  const out = [];
  // Main category
  out.push(...glossaryExpect({
    enText: row.category_name || "",
    arText: row.category_localized_name || "",
    market, glossary
  }).map(x=>({ field:"category", ...x })));
  // Sub category
  out.push(...glossaryExpect({
    enText: row.sub_category_name || "",
    arText: row.sub_category_localized_name || "",
    market, glossary
  }).map(x=>({ field:"sub_category", ...x })));
  // Item name vs AR item name
  out.push(...glossaryExpect({
    enText: row.item_name || "",
    arText: row.item_localized_name || "",
    market, glossary
  }).map(x=>({ field:"item_name_pair", ...x })));
  return out;
}

export function checkTax(market, taxValue) {
  const expected = market==="JO" ? 16 : market==="AE" ? 5 : null;
  if (expected===null) return [];
  return (Number(taxValue)===expected) ? [] :
    [{ field:"tax", type:"tax",
       message:`Tax must be ${expected}% for ${market}`, fix: expected }];
}

export function qcCheckSingle({ name, desc, market, tax, englishDict, glossary, arName }) {
  let issues = [];
  issues.push(...checkItemName(name));
  issues.push(...checkDescription(desc));
  issues.push(...checkTax(market, tax));
  if (englishDict) issues.push(...checkSpellingEnglish(name, englishDict));
  if (glossary && arName) {
    issues.push(...glossaryExpect({ enText:name, arText:arName, market, glossary })
      .map(x=>({ field:"translation", ...x })));
  }
  return issues;
}

export function cleanRow(row) {
  const copy = { ...row };
  if (row.item_name) copy.item_name = fixItemNameCase(row.item_name);
  if (row.item_description) copy.item_description = cleanDescription(row.item_description);
  return copy;
}
