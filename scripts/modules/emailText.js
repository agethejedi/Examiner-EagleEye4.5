// scripts/modules/emailText.js
import { combineScores, severityFromScore } from './riskEngine.js';

/**
 * Eagle Eye 4.5 — Email/Text analysis (Truthful contributions)
 *
 * Adds:
 * - flag.points (true contribution to score) for ring segmentation
 * - calibration segment if critical floor boosts score
 */

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

function extractUrls(text) {
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
  s = s.replace(/\[\.\]/g, '.');
  s = s.replace(/^hxxp(s?):\/\//i, 'http$1://');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
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
  const vowelCount = (s.match(/[aeiou]/g) || []).length;
  const digitCount = (s.match(/[0-9]/g) || []).length;
  const weird = /[^a-z0-9-]/.test(s);
  return !weird && (vowelCount <= 1 || digitCount >= 2);
}

function analyzeSpellingGrammar(text) {
  const DICT = new Set([
    'the','and','to','of','in','for','you','your','is','are','this','that','we','our','please',
    'account','payment','verify','now','today','immediately','final','notice','due','past','overdue',
    'support','service','customer','dear','hello','hi','bank','invoice','statement','security','update',
    'confirm','link','click','contact','information','within','hours','business','days','warning',
    'suspended','locked','urgent','request','action','required','thanks','regards',
    'texas','administrative','code','ticket','registration','license','enforcement','begins',
    'september','prosecuted','credit','score','affected','reply','reopen','browser'
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

export function analyzeEmailText({ sender, subject, body, links, weights }) {
  const flags = [];
  const joined = (subject || '') + '\n' + (body || '');

  // Build flags that also carry scoring fields (raw + weight)
  function addScoredFlag({ sev, msg, raw, weight }) {
    flags.push({ sev, msg, _raw: raw, _w: weight });
  }
  function addInfoFlag({ sev, msg }) {
    flags.push({ sev, msg, points: 0 });
  }

  const extracted = extractUrls(joined);
  const allLinks = [...(links || []), ...extracted].map(normalizeLink).filter(Boolean);

  // Weights scaled for combineScores usage
  const wUrg = (weights?.urgency ?? 60) / 50;      // ~1.2
  const wDem = (weights?.demand ?? 70) / 50;       // ~1.4
  const wHom = (weights?.homoglyph ?? 80) / 50;    // ~1.6
  const wGov = (weights?.gov ?? 80) / 45;          // ~1.8
  const wSpl = (weights?.spell ?? 55) / 80;        // ~0.7

  // --- Urgency ---
  const urgency =
    /(urgent|immediately|final notice|last attempt|act now|24 hours|suspended|locked|verify now|enforcement begins)/i.test(joined)
      ? 85
      : 0;
  if (urgency > 0) {
    addScoredFlag({
      sev: severityFromScore(urgency),
      msg: 'Urgency detected in subject/body',
      raw: urgency,
      weight: wUrg,
    });
  }

  // --- Payment demand ---
  const payment =
    /(pay now|payment|overdue|past due|wire|zelle|gift card|bitcoin|crypto|cash app|western union|money order|cashier's check|service fee)/i.test(joined)
      ? 90
      : 0;
  if (payment > 0) {
    addScoredFlag({
      sev: severityFromScore(payment),
      msg: 'Demand-for-payment language detected',
      raw: payment,
      weight: wDem,
    });
  }

  // --- Sender domain homoglyph + IDN ---
  const domain = (sender || '').split('@')[1] || '';
  let senderHomog = 0;
  let senderIDN = 0;

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

    if (senderHomog > 0) {
      addScoredFlag({
        sev: senderHomog >= 90 ? 'danger' : 'warn',
        msg: `Sender domain suspicious: ${hits.join(', ')} (${domain})`,
        raw: senderHomog,
        weight: wHom,
      });
    }
  }

  // --- Link analysis ---
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

    if (hostHasIDN(host)) idnLink = true;
    if (host.endsWith('.gov') || host.endsWith('.mil')) trueGov = true;

    const looksGov =
      /(\b(us|usa|gov|state|county|city|municipal|district)\b|clerk|districtclerk|countyclerk|court|courts|judicial|tax|treasury|dmv|socialsecurity|medicare|medicaid|uscis|irs|fbi|police|sheriff|dps|attorneygeneral|publicrecords|voter)/i.test(host);

    const isActuallyGov = host.endsWith('.gov') || host.endsWith('.mil');
    if (looksGov && !isActuallyGov) fakeGov = Math.max(fakeGov, 95);

    if (/(^|\.)((bit\.ly)|(tinyurl\.com)|(t\.co)|(goo\.gl))$/i.test(host)) {
      shortener = Math.max(shortener, 60);
    }

    if (riskyTlds.has(tld)) riskyTld = Math.max(riskyTld, 85);

    const path = (u.pathname || '').toLowerCase();
    const query = (u.search || '').toLowerCase();
    const payLure =
      /(\/pay\b|\/payment\b|\/invoice\b|\/billing\b|\/checkout\b|\/verify\b|\/confirm\b)/.test(path) ||
      /(pay=|payment=|invoice=|billing=)/.test(query);

    if (payLure) payPath = Math.max(payPath, 90);

    const labels = host.split('.');
    if (labels.some((l) => looksRandomLabel(l))) randomSub = Math.max(randomSub, 70);
  });

  const idnScore = idnLink ? 85 : 0;
  const fakeGovScore = fakeGov > 0 ? 95 : 0;

  if (idnScore > 0) {
    addScoredFlag({
      sev: 'danger',
      msg: 'Punycode/IDN link detected (xn--) — attackers use this to hide look-alike domains.',
      raw: idnScore,
      weight: 1.6,
    });
  }

  if (fakeGovScore > 0) {
    addScoredFlag({
      sev: 'danger',
      msg: 'Government/civic impersonation link — government terms used on a non-.gov domain.',
      raw: fakeGovScore,
      weight: wGov,
    });
  }

  if (riskyTld > 0) {
    addScoredFlag({
      sev: 'danger',
      msg: 'High-risk top-level domain often used in phishing (e.g., .vip, .top, .xyz).',
      raw: riskyTld,
      weight: 1.2,
    });
  }

  if (payPath > 0) {
    addScoredFlag({
      sev: 'danger',
      msg: 'Payment/checkout lure detected in the URL path/query.',
      raw: payPath,
      weight: 1.3,
    });
  }

  if (randomSub > 0) {
    addScoredFlag({
      sev: 'warn',
      msg: 'Suspicious/random subdomain pattern often used for burner phishing hosts.',
      raw: randomSub,
      weight: 0.8,
    });
  }

  if (trueGov) {
    addInfoFlag({ sev: 'ok', msg: 'Contains genuine .gov/.mil link.' });
  }

  if (shortener > 0) {
    addScoredFlag({
      sev: 'warn',
      msg: 'Shortened link detected — destination is obscured.',
      raw: shortener,
      weight: 0.6,
    });
  }

  // Spelling/grammar heuristic
  const sg = analyzeSpellingGrammar(joined);
  if (sg.score > 35) {
    addScoredFlag({
      sev: severityFromScore(sg.score),
      msg: `High error rate in spelling/grammar (miss ~${Math.round(sg.detail.missRate * 100)}%)`,
      raw: sg.score,
      weight: wSpl,
    });
  }

  // Build combineScores inputs from scored flags
  const scored = flags.filter(f => typeof f._raw === 'number' && typeof f._w === 'number');
  const combineInputs = scored.map(f => ({ score: f._raw, weight: f._w }));

  const combined = combineScores(combineInputs);

  // Convert each scored flag into true contribution points:
  // contribution = (raw * w) / sumWeights, which sums to "combined" (assuming weighted avg)
  const sumW = scored.reduce((a, f) => a + (f._w || 0), 0) || 1;
  scored.forEach(f => {
    f.points = (f._raw * f._w) / sumW;
    delete f._raw;
    delete f._w;
  });

  // ---- Option A: critical-stack floors ----
  const criticalCount =
    (urgency > 0 ? 1 : 0) +
    (payment > 0 ? 1 : 0) +
    (fakeGovScore > 0 ? 1 : 0) +
    (riskyTld > 0 ? 1 : 0) +
    (payPath > 0 ? 1 : 0) +
    (idnScore > 0 ? 1 : 0) +
    (senderHomog > 0 ? 1 : 0);

  let finalScore = combined;

  if (fakeGovScore > 0 && payPath > 0) finalScore = Math.max(finalScore, 85);
  if (criticalCount >= 2) finalScore = Math.max(finalScore, 75);
  if (criticalCount >= 4) finalScore = Math.max(finalScore, 90);

  // If calibration boosted score above combined, add a calibration segment so ring totals to finalScore.
  if (finalScore > combined + 0.01) {
    flags.push({
      sev: 'danger',
      msg: 'Calibration: critical-risk stack floor applied.',
      points: finalScore - combined,
    });
  }

  // Ensure every flag has points numeric (for UI safety)
  flags.forEach(f => { if (typeof f.points !== 'number') f.points = 0; });

  return { score: finalScore, flags };
}
