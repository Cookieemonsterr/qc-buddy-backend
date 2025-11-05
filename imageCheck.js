import probe from "probe-image-size";

// Allowed sizes
const ALLOWED = new Set(["1200x1200", "1125x780"]);

export async function checkImageUrl(url) {
  try {
    const info = await probe(url);
    const key = `${info.width}x${info.height}`;
    return {
      ok: ALLOWED.has(key),
      width: info.width,
      height: info.height,
      expected: ["1200x1200", "1125x780"],
    };
  } catch (e) {
    return { ok: false, error: "unreadable_image", details: String(e) };
  }
}
