// /lib/generate.js  (ESM)
// Minimal, safe caption + hashtag generator using OpenAI.
// Exports: generateCaptionAndTags({ seedText, constraints={}, clientPrefs={} })

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Optional: set a default model via env; otherwise a sensible small model.
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function buildPrompt(seedText, constraints = {}, clientPrefs = {}) {
  // Normalize simple knobs
  const tone = constraints.tone || clientPrefs.tone || 'casual';
  const length = constraints.length || clientPrefs.length || 'short';
  const emoji = constraints.emoji ?? clientPrefs.emoji ?? 'on';
  const mustInclude = constraints.must_include || [];
  const hashtags = constraints.hashtags || clientPrefs.hashtags || [];
  const price = constraints.price || null;

  // Convert to short instruction lines
  const lines = [];
  lines.push(`Tone: ${tone}. Length: ${length}. Emojis: ${emoji}.`);
  if (price) lines.push(`Include price: ${price}.`);
  if (mustInclude.length) lines.push(`Must include (verbatim): ${mustInclude.join(' | ')}`);
  if (hashtags.length) lines.push(`Seed hashtags: ${hashtags.map(t => '#' + String(t).replace(/^#/, '')).join(' ')}`);

  return [
    `You are a marketing copywriter for small local businesses on Instagram/Facebook.`,
    `Given a brief seed from the user, produce a single engaging caption and a tight set of hashtags.`,
    `Hard rules:`,
    `- Output JSON ONLY with keys: "caption_final" (string) and "hashtags" (array of strings).`,
    `- Caption must be platform-friendly (<= 500 chars), no profanity, no hard-sell.`,
    `- If emoji=off, use none. If tone=formal, avoid slang. If length=short, aim <= 180 chars.`,
    `- Never invent prices or claims not given.`,
    `- Respect "must include" terms exactly.`,
    ``,
    `Constraints:`,
    ...lines,
    ``,
    `Seed: ${seedText}`
  ].join('\n');
}

function sanitizeHashtags(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    let tag = String(raw || '').trim();
    if (!tag) continue;
    tag = tag.startsWith('#') ? tag.slice(1) : tag;
    tag = tag.replace(/[^\p{Letter}\p{Number}_]/gu, '');
    if (!tag) continue;
    const lower = tag.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push('#' + tag);
    if (out.length >= 8) break; // keep it tight
  }
  return out;
}

export async function generateCaptionAndTags({ seedText, constraints = {}, clientPrefs = {} } = {}) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing');
  }
  const prompt = buildPrompt(seedText || '', constraints, clientPrefs);

  const body = {
    model: OPENAI_MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You return STRICT JSON only. No prose, no code fences.' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    max_tokens: 400
  };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const json = await res.json();
  if (!res.ok) {
    throw new Error(`OpenAI error: ${res.status} ${JSON.stringify(json)}`);
  }

  // Extract assistant JSON
  const content = json?.choices?.[0]?.message?.content || '{}';
  let parsed;
  try { parsed = JSON.parse(content); } catch { parsed = {}; }

  let caption = String(parsed.caption_final || '').slice(0, 500);
  if (!caption) {
    // Fallback if model went off-format
    caption = String((Array.isArray(parsed) ? parsed[0] : '') || ''); 
    caption = caption.slice(0, 500);
  }

  const tags = sanitizeHashtags(parsed.hashtags || []);
  return { caption_final: caption, hashtags: tags };
}
