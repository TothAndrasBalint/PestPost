// /lib/constraints.js  (ESM)
export function parseConstraints(input = '') {
  const text = String(input || '').toLowerCase();

  const out = {
    // caption knobs
    length: undefined,       // 'short' | 'long'
    tone: undefined,         // 'formal' | 'casual'
    emoji: undefined,        // 'on' | 'off'
    hashtags: [],
    must_include: [],
    price: undefined,        // e.g., '1490 Ft'
    // optional image hints (not used yet)
    image: {}
  };

  // length
  if (/\b(short(er)?|rövidebb?|rövid)\b/.test(text)) out.length = 'short';
  if (/\b(long(er)?|hosszabb?|hosszú)\b/.test(text)) out.length = 'long';

  // tone
  if (/\b(formal|professional|professzionális|hivatalos)\b/.test(text)) out.tone = 'formal';
  if (/\b(casual|közvetlen|lazább)\b/.test(text)) out.tone = 'casual';

  // emoji
  if (/\b(no\s*emoji|nincs? emoji|ne legyen(ek)? emoji(k)?|emoji nélkül)\b/.test(text)) out.emoji = 'off';
  if (/\b(add|more)\s*emoji|legyen(ek)? emoji(k)?|több emoji\b/.test(text)) out.emoji = 'on';

  // hashtags  (#tag)
  const tagMatches = input.match(/#([\p{L}\p{N}_]+)/giu);
  if (tagMatches) out.hashtags = tagMatches.map(s => s.replace(/^#/, '')).slice(0, 10);

  // price (e.g., 1490 Ft, 1 490 Ft, 1.490 Ft, HUF 1490)
  const priceMatch = input.match(/(?:huf\s*)?(\d[\d\s\.,]{0,8})\s*(?:ft|huf)\b/i);
  if (priceMatch) {
    const raw = priceMatch[1].replace(/\s/g, '');
    out.price = `${raw.replace(',', '.')} Ft`;
  }

  // “mention …” / “említsd meg …”
  const mentionMatches = [];
  const en = input.match(/mention\s+([^.;\n]+)/gi);
  const hu = input.match(/említsd\s+meg\s+([^.;\n]+)/gi);
  for (const m of (en || [])) mentionMatches.push(m.replace(/mention\s+/i, '').trim());
  for (const m of (hu || [])) mentionMatches.push(m.replace(/említsd\s+meg\s+/i, '').trim());
  if (mentionMatches.length) out.must_include = mentionMatches.slice(0, 5);

  // simple image hints (not wired yet, but captured)
  if (/\bcrop\b.*\btight(er)?\b|\bszorosabb vágás\b/.test(text)) out.image.crop = 'tighter';
  const focus = input.match(/focus on\s+([^\.;\n]+)|fókusz(álj)?\s+(?:a|az)\s+([^\.;\n]+)/i);
  if (focus) out.image.focus = (focus[1] || focus[3] || '').trim();

  return out;
}
