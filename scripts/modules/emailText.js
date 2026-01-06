// scripts/modules/emailText.js
import { combineScores, severityFromScore } from './riskEngine.js';

/**
 * Eagle Eye — Email/Text analysis
 * Drop-in build that:
 * - Detects sender-domain homoglyphs (Unicode + ASCII confusables) + non-ASCII/script-mix + punycode
 * - Extracts URLs from Subject/Message automatically (user doesn’t have to use the Links box)
 * - Normalizes common obfuscations: [.] and hxxp(s)://
 * - Flags: punycode/IDN, gov/civic impersonation, risky TLDs (e.g., .vip), payment lures, suspicious random subdomains, shorteners
 * - Scoring is “real” (0–100 signals weighted), so these indicators move the needle.
 */

// ------------------------------
// Unicode homoglyph map (existing)
// ------------------------------
const homoglyphMap = {
  a: ['а', 'ᴀ', 'ɑ', 'α', 'ạ', 'ă', 'â'],
  b: ['Ь', 'Ƅ', 'ƅ', 'ь'],
  c: ['с', 'ȼ', 'ḉ', 'ᴄ'],
  d: ['ԁ', 'đ', 'Ԁ'],
  e: ['е', 'ẹ', 'ê', 'ė', 'є', '℮'],
  f: ['ғ', 'ƒ'],
  g: ['ɡ', 'ġ'],
  h: ['һ', 'ḥ', 'ℎ'],
  i: ['і', 'í', 'ì', 'ï', 'ı', 'ɪ'],
  j: ['ј', 'ʝ'],
  k: ['κ', 'ᴋ'],
  l: ['ⅼ', 'Ɩ', 'ӏ', 'ı'],
  m: ['м', 'ṃ'],
  n: ['ո', 'ṅ', 'ᴎ'],
  o: ['о', 'ɵ', 'ọ', 'º', 'ο', 'օ'],
  p: ['р', 'ṕ', 'ƿ'],
  q: ['գ', 'զ'],
  r: ['ᴦ', 'ṙ'],
  s: ['ѕ', 'ṣ', 'ṡ'],
  t: ['τ', 'ṭ', '†'],
  u: ['υ', 'ų', 'ụ', 'ŭ'],
  v: ['ᴠ', 'ṿ'],
  w: ['ᴡ', 'ẅ'],
  x: ['х', 'ẋ', '×'],
  y: ['у', 'ÿ', 'ƴ'],
  z: ['ᴢ', 'ž'],
};

// ASCII confusables used in domains (paypaI.com)
const asciiLookalikes = [
  ['l', 'I', '1', '|'],
  ['O', '0'],
  ['S', '5'],
  ['B', '8'],
  ['Z', '2'],
];

function containsHomoglyphUnicode(str) {
  const n = (str || '').normalize('NFKC').toLowerCase();
  for (const list of Object.values(homoglyphMap)) {
    for (const ch of list) if (n.includes(ch)) return true;
  }
  return false;
}

function hostHasIDN(host) {
  return (host || '').split('.').some((p) => p.startsWith('xn--'));
}

function hasAsciiConfusable(domain) {
  const d = (domain || '').trim();
  if (!d) return false;

  const labels = d.split('.');
  for (const group of asciiLookalikes) {
    const charClass = group
      .map((c) => c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&'))
      .join('');
    const re = new RegExp('[' + charClass + ']');

    for (const label of labels) {
      if (label.length < 3) continue;
      const mid = label.slice(1, -1);
      if (re.test(mid)) return true;
    }
  }
  return false;
}

function hasNonAscii(domain) {
  return /[^\x00-\x7F]/.test(domain || '');
}

// ------------------------------
// URL extraction + normalization
// ------------------------------
function extractUrls(text) {
  // Captures:
  // - https://... / http://...
  // - hxxp:// / hxxps://
  // - domains with [.] obfuscation
  const t = text || '';
  return (
    t.match(
      /(?:hxxps?:\/\/|https?:\/\/)[^\s)]+|[a-z0-9\-._]+\[\.\][a-z]{2,}/gi
    ) || []
  );
}

function normalizeLink(raw) {
  if (!raw) return '';
  let s = raw.trim();

  // common obfuscations
  s = s.replace(/\[\.\]/g, '.'); // [.] -> .
  s = s.replace(/^hxxp(s?):\/\//i, 'http$1://'); // hxxp -> http

  // allow bare domains
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;

  // strip trailing punctuation that often follows links in text
  s = s.replace(/[),.;]+$/g, '');

  return s;
}

function safeURL(raw) {
  const s = normalizeLink(raw);
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

function getTld(host) {
  const parts = (host || '').split('.').filter(Boolean);
  return parts.length ? parts[parts.length - 1].toLowerCase() : '';
}

function looksRandomLabel(label) {
  const s = (label || '').toLowerCase();
  if (s.length < 6) return false;

  // heuristics: low vowels, digits, or generally "burner-ish"
  const vowelCount = (s.match(/[aeiou]/g) || []).length;
  const digitCount = (s.match(/[0-9]/g) || []).length;
  const weird = /[^a-z0-9-]/.test(s);

  // “random-ish”: very low vowels OR multiple digits, and not weird chars
  return !weird && (vowelCount <= 1 || digitCount >= 2);
}

// ------------------------------
// Spelling/grammar heuristic
// ------------------------------
function analyzeSpellingGrammar(text) {
  const DICT = new Set([
    'the','and','to','of','in','for','you','your','is','are','this','that','we','our','please',
    'account','payment','verify','now','today','immediately','final','notice','due','past','overdue',
    'support','service','customer','dear','hello','hi','bank','invoice','statement','security','update',
    'confirm','link','click','contact','information','within','hours','business','days','warning',
    'suspended','locked','urgent','request','action','required','thanks','regards'
  ]);

  const words =
    (text || '')
      .toLowerCase()
      .match(/[a-záéíóúüñçğşâêîôûäëïöü]+/g) || [];

  if (words.length === 0) return { score: 0, detail: { missRate: 0 } };

  let miss = 0;
  for (const w of words) {
    if (!DICT.has(w) && w.length > 3) miss++;
  }

  const missRate = miss / words.length;
  const score = Math.max(0, Math.min(100, Math.round(missRate * 100)));
  return { score, detail: { missRate } };
}

// ------------------------------
// Main analyzer
// ------------------------------
export function analyzeEmailText({ sender, subject, body, links, weights }) {
  const flags = [];
  const joined = (subject || '') + '\n' + (body || '');

  // Merge: Links box + URLs embedded in subject/body (users paste anywhere)
  const extracted = extractUrls(joined);
  const allLinks = [...(links || []), ...extracted]
    .map(normalizeLink)
    .filter(Boolean);

  // --- Urgency ---
  const urgency =
    /(urgent|immediately|final notice|last attempt|act now|24 hours|suspended|locked|verify now)/i.test(
      joined
    )
      ? 85
      : 0;
  if (urgency > 0)
    flags.push({
      sev: severityFromScore(urgency),
      msg: 'Urgency detected in subject/body',
    });

  // --- Payment demand ---
  const payment =
    /(pay now|overdue|past due|wire|zelle|gift card|bitcoin|crypto|cash app|western union|money order|cashier's check)/i.test(
      joined
    )
      ? 90
      : 0;
  if (payment > 0)
    flags.push({
      sev: severityFromScore(payment),
      msg: 'Demand-for-payment language detected',
    });

  // --- Sender domain homoglyph + IDN ---
  const domain = (sender || '').split('@')[1] || '';
  let senderHomog = 0,
    senderIDN = 0;

  if (domain) {
    const hits = [];

    if (containsHomoglyphUnicode(domain)) {
      senderHomog = Math.max(senderHomog, 95);
      hits.push('Unicode homoglyphs');
    }
    if (hasAsciiConfusable(domain)) {
      senderHomog = Math.max(senderHomog, 90);
      hits.push('ASCII look-alikes (I/l/1/|, O/0, etc.)');
    }
    if (hasNonAscii(domain)) {
      senderHomog = Math.max(senderHomog, 90);
      hits.push('Non-ASCII characters in domain');
    }

    const host = domain.toLowerCase();
    if (hostHasIDN(host)) {
      senderIDN = 80;
      hits.push('IDN punycode (xn--)');
    }

    if (hits.length) {
      flags.push({
        sev: senderHomog >= 90 ? 'danger' : 'warn',
        msg: `Sender domain suspicious: ${hits.join(', ')} (${domain})`,
      });
    }
  }

  // --- Link analysis (punycode, gov impersonation, risky TLD, payment lure, random subdomain, shorteners) ---
  let idnLink = false;
  let fakeGov = 0;
  let trueGov = false;
  let shortener = 0;

  let riskyTld = 0;
  let payPath = 0;
  let randomSub = 0;

  const riskyTlds = new Set([
    'vip','top','xyz','icu','shop','click','monster','live','buzz','work','loan','gq','tk','ml','cf','ga'
  ]);

  allLinks.forEach((raw) => {
    const u = safeURL(raw);
    if (!u) return;

    const host = (u.hostname || '').toLowerCase();
    const tld = getTld(host);

    // Punycode / IDN
    if (hostHasIDN(host)) idnLink = true;

    // Genuine gov/mil
    if (host.endsWith('.gov') || host.endsWith('.mil')) trueGov = true;

    // Expanded gov/civic impersonation keywords
    const looksGov = /(\b(us|usa|gov|state|county|city|municipal|district)\b|clerk|districtclerk|countyclerk|court|courts|judicial|tax|treasury|dmv|socialsecurity|medicare|medicaid|uscis|irs|fbi|police|sheriff|dps|attorneygeneral|publicrecords|voter)/i.test(
      host
    );

    const isNonGovTld = /\.(com|net|org|co|info|vip|top|xyz|icu|shop|click|live|buzz|work|loan)$/i.test(
      host
    );
    const isActuallyGov = host.endsWith('.gov') || host.endsWith('.mil');

    if (looksGov && isNonGovTld && !isActuallyGov) {
      fakeGov = Math.max(fakeGov, 95);
    }

    // Shorteners
    if (/(^|\.)((bit\.ly)|(tinyurl\.com)|(t\.co)|(goo\.gl))$/i.test(host)) {
      shortener = Math.max(shortener, 60);
    }

    // Risky TLD
    if (riskyTlds.has(tld)) riskyTld = Math.max(riskyTld, 85);

    // Payment lure
    const path = (u.pathname || '').toLowerCase();
    const query = (u.search || '').toLowerCase();
    const payLure =
      /(\/pay\b|\/payment\b|\/invoice\b|\/billing\b|\/checkout\b|\/verify\b|\/confirm\b)/.test(
        path
      ) || /(pay=|payment=|invoice=|billing=)/.test(query);
    if (payLure) payPath = Math.max(payPath, 90);

    // Random/burner subdomain indicator
    const labels = host.split('.');
    const hasRandom = labels.some((l) => looksRandomLabel(l));
    if (hasRandom) randomSub = Math.max(randomSub, 70);
  });

  // Clear user-facing flags ("badges")
  if (idnLink)
    flags.push({
      sev: 'danger',
      msg: 'Punycode/IDN link detected (xn--) — attackers use this to hide look-alike domains.',
    });

  if (fakeGov > 0)
    flags.push({
      sev: 'danger',
      msg: 'Government/civic impersonation link — government terms used on a non-.gov domain.',
    });

  if (riskyTld > 0)
    flags.push({
      sev: 'danger',
      msg: 'High-risk top-level domain often used in phishing (e.g., .vip, .top, .xyz).',
    });

  if (payPath > 0)
    flags.push({
      sev: 'danger',
      msg: 'Payment/checkout lure detected in the URL path/query.',
    });

  if (randomSub > 0)
    flags.push({
      sev: 'warn',
      msg: 'Suspicious/random subdomain pattern often used for burner phishing hosts.',
    });

  if (trueGov)
    flags.push({ sev: 'ok', msg: 'Contains genuine .gov/.mil link.' });

  if (shortener > 0)
    flags.push({
      sev: 'warn',
      msg: 'Shortened link detected — destination is obscured.',
    });

  // Spelling/grammar heuristic
  const sg = analyzeSpellingGrammar(joined);
  if (sg.score > 35)
    flags.push({
      sev: severityFromScore(sg.score),
      msg: `High error rate in spelling/grammar (miss ~${Math.round(
        sg.detail.missRate * 100
      )}%)`,
    });

  // Scoring: use true 0–100 signals; weights truly weight signals
  // NOTE: weights values are slider 0–100; we scale to reasonable weights.
  const wUrg = (weights?.urgency ?? 60) / 50; // ~1.2
  const wDem = (weights?.demand ?? 70) / 50; // ~1.4
  const wHom = (weights?.homoglyph ?? 80) / 50; // ~1.6
  const wGov = (weights?.gov ?? 80) / 45; // ~1.8
  const wSpl = (weights?.spell ?? 55) / 80; // ~0.7

  const idnScore = idnLink ? 85 : 0;
  const fakeGovScore = fakeGov > 0 ? 95 : 0;

  const combined = combineScores([
    { score: urgency,       weight: wUrg },
    { score: payment,       weight: wDem },
    { score: senderHomog,   weight: wHom },
    { score: fakeGovScore,  weight: wGov },
    { score: idnScore,      weight: 1.6 },
    { score: riskyTld,      weight: 1.2 },
    { score: payPath,       weight: 1.3 },
    { score: randomSub,     weight: 0.8 },
    { score: shortener,     weight: 0.6 },
    { score: senderIDN,     weight: 0.6 },
    { score: sg.score,      weight: wSpl },
  ]);

  return { score: combined, flags };
}
