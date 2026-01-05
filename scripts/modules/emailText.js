import { combineScores, severityFromScore } from './riskEngine.js';

// --- Unicode homoglyph map (your existing table) ---
const homoglyphMap = {
  'a':['а','ᴀ','ɑ','α','ạ','ă','â'],
  'b':['Ь','Ƅ','ƅ','ь'],
  'c':['с','ȼ','ḉ','ᴄ'],
  'd':['ԁ','đ','Ԁ'],
  'e':['е','ẹ','ê','ė','є','℮'],
  'f':['ғ','ƒ'],
  'g':['ɡ','ġ'],
  'h':['һ','ḥ','ℎ'],
  'i':['і','í','ì','ï','ı','ɪ'],
  'j':['ј','ʝ'],
  'k':['κ','ᴋ'],
  'l':['ⅼ','Ɩ','ӏ','ı'],
  'm':['м','ṃ'],
  'n':['ո','ṅ','ᴎ'],
  'o':['о','ɵ','ọ','º','ο','օ'],
  'p':['р','ṕ','ƿ'],
  'q':['գ','զ'],
  'r':['ᴦ','ṙ'],
  's':['ѕ','ṣ','ṡ'],
  't':['τ','ṭ','†'],
  'u':['υ','ų','ụ','ŭ'],
  'v':['ᴠ','ṿ'],
  'w':['ᴡ','ẅ'],
  'x':['х','ẋ','×'],
  'y':['у','ÿ','ƴ'],
  'z':['ᴢ','ž']
};

// --- ASCII confusables frequently used in domains (paypaI.com) ---
const asciiLookalikes = [
  ['l','I','1','|'],
  ['O','0'],
  ['S','5'],
  ['B','8'],
  ['Z','2'],
];

function containsHomoglyphUnicode(str){
  const n = (str || '').normalize('NFKC').toLowerCase();
  for (const list of Object.values(homoglyphMap)) {
    for (const ch of list) {
      if (n.includes(ch)) return true;
    }
  }
  return false;
}

function hostHasIDN(host){
  return (host || '').split('.').some(p => p.startsWith('xn--'));
}

// flag if domain contains suspicious ASCII confusables in the middle of a label
function hasAsciiConfusable(domain){
  const d = (domain || '').trim();
  if (!d) return false;

  for (const group of asciiLookalikes) {
    const charClass = group.map(c => c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('');
    const re = new RegExp('[' + charClass + ']');

    if (re.test(d)) {
      const labels = d.split('.');
      for (const label of labels) {
        if (label.length < 3) continue;
        const mid = label.slice(1, -1);
        if (re.test(mid)) return true;
      }
    }
  }
  return false;
}

// any non-ASCII chars in the domain (script-mix risk)
function hasNonAscii(domain){
  return /[^\x00-\x7F]/.test(domain || '');
}

// ------------------------------
// NEW: URL extraction + normalization
// ------------------------------
function extractUrls(text){
  // Grab:
  // - normal URLs (https://...)
  // - hxxp:// obfuscation
  // - domain[.]tld obfuscation
  const t = text || '';
  const hits = t.match(/(?:hxxps?:\/\/|https?:\/\/)[^\s)]+|[a-z0-9\-._]+\[\.\][a-z]{2,}/gi) || [];
  return hits;
}

function normalizeLink(raw){
  if(!raw) return '';
  let s = raw.trim();
  s = s.replace(/\[\.\]/g, '.');                 // fbi-security[.]com -> fbi-security.com
  s = s.replace(/^hxxp(s?):\/\//i, 'http$1://'); // hxxp:// -> http://
  if(!/^https?:\/\//i.test(s)) s = 'http://' + s; // allow bare domains
  return s;
}

function safeURL(raw){
  const s = normalizeLink(raw);
  try { return new URL(s); } catch { return null; }
}

function analyzeSpellingGrammar(text){
  const DICT = new Set([
    'the','and','to','of','in','for','you','your','is','are','this','that','we','our','please',
    'account','payment','verify','now','today','immediately','final','notice','due','past','overdue',
    'support','service','customer','dear','hello','hi','bank','invoice','statement','security','update',
    'confirm','link','click','contact','information','within','hours','business','days','warning',
    'suspended','locked','urgent','request','action','required','thanks','regards'
  ]);
  const words = (text||'').toLowerCase().match(/[a-záéíóúüñçğşâêîôûäëïöü]+/g) || [];
  if(words.length===0) return { score:0, detail:{ missRate:0 } };
  let miss=0;
  for(const w of words){
    if(!DICT.has(w) && w.length>3) miss++;
  }
  const missRate = miss/words.length;
  const score = Math.max(0, Math.min(100, Math.round(missRate*100)));
  return { score, detail:{ missRate } };
}

export function analyzeEmailText({ sender, subject, body, links, weights }){
  const flags = [];
  const joined = (subject||'') + '\n' + (body||'');

  // Merge links from Links box + URLs embedded in message/subject
  const extracted = extractUrls(joined);
  const allLinks = [...(links||[]), ...extracted].map(normalizeLink).filter(Boolean);

  const urgency = /(urgent|immediately|final notice|last attempt|act now|24 hours|suspended|locked|verify now)/i
    .test(joined) ? 85 : 0;
  if(urgency>0) flags.push({ sev: severityFromScore(urgency), msg:'Urgency detected in subject/body' });

  const payment = /(pay now|overdue|past due|wire|zelle|gift card|bitcoin|crypto|cash app|western union|money order|cashier's check)/i
    .test(joined) ? 90 : 0;
  if(payment>0) flags.push({ sev: severityFromScore(payment), msg:'Demand-for-payment language detected' });

  // ===== Sender domain homoglyph & IDN (stronger) =====
  const domain = (sender || '').split('@')[1] || '';
  let senderHomog = 0, senderIDN = 0;

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
        msg: `Sender domain suspicious: ${hits.join(', ')} (${domain})`
      });
    }
  }

  // ===== Link analysis (explicit punycode + gov impersonation + obfuscation support) =====
  let idnLink = false;
  let fakeGov = 0;
  let trueGov = false;
  let shortener = 0;

  allLinks.forEach(raw => {
    const u = safeURL(raw);
    if(!u) return;

    const host = (u.hostname || '').toLowerCase();

    // Punycode / IDN
    if(hostHasIDN(host)) idnLink = true;

    // Genuine .gov/.mil
    if(host.endsWith('.gov') || host.endsWith('.mil')) trueGov = true;

    // Gov impersonation pattern: gov words on non-gov TLD
    const looksGov = /(irs|ssa|uscis|fbi|cdc|treasury|usps|va|dot|ed|hhs|medicare|medicaid|state)\b/.test(host);
    const isNonGovTld = /\.(com|net|org|co|info)$/i.test(host);
    const isActuallyGov = host.endsWith('.gov') || host.endsWith('.mil');

    if(looksGov && isNonGovTld && !isActuallyGov){
      fakeGov = Math.max(fakeGov, 95);
    }

    if (/(^|\.)((bit\.ly)|(tinyurl\.com)|(t\.co)|(goo\.gl))$/i.test(host)) {
      shortener = Math.max(shortener, 60);
    }
  });

  // Clear, user-facing flags
  if(idnLink) flags.push({
    sev:'danger',
    msg:'Punycode/IDN link detected (xn--) — attackers use this to hide look-alike domains.'
  });

  if(fakeGov>0) flags.push({
    sev:'danger',
    msg:'Government impersonation link — government terms used on a non-.gov domain.'
  });

  if(trueGov) flags.push({ sev:'ok', msg:'Contains genuine .gov/.mil link.' });
  if(shortener>0) flags.push({ sev:'warn', msg:'Shortened link detected — destination is obscured.' });

  const sg = analyzeSpellingGrammar(joined);
  if(sg.score>35) flags.push({
    sev: severityFromScore(sg.score),
    msg: `High error rate in spelling/grammar (miss ~${Math.round(sg.detail.missRate*100)}%)`
  });

  // Make link risks move the needle (scores remain 0-100; weights weight them)
  const idnScore = idnLink ? 85 : 0;
  const fakeGovScore = fakeGov > 0 ? 95 : 0;

  const combined = combineScores([
    { score: urgency,      weight: (weights?.urgency ?? 60)/50 },      // ~1.2
    { score: payment,      weight: (weights?.demand  ?? 70)/50 },      // ~1.4
    { score: senderHomog,  weight: (weights?.homoglyph ?? 80)/50 },    // ~1.6
    { score: fakeGovScore, weight: (weights?.gov ?? 80)/45 },          // ~1.8
    { score: idnScore,     weight: 1.6 },
    { score: shortener,    weight: 0.6 },
    { score: senderIDN,    weight: 0.6 },
    { score: sg.score,     weight: (weights?.spell ?? 55)/80 }         // lighter
  ]);

  return { score: combined, flags };
}
