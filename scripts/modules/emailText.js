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

// --- NEW: ASCII confusables frequently used in domains (paypaI.com) ---
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

// NEW: flag if domain contains suspicious ASCII confusables in the middle of a label
function hasAsciiConfusable(domain){
  const d = (domain || '').trim();
  if (!d) return false;

  // If the domain has uppercase in the host portion, that's already suspicious for many user-entered domains.
  // But we focus on classic look-alike patterns.
  for (const group of asciiLookalikes) {
    const charClass = group.map(c => c.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')).join('');
    const re = new RegExp('[' + charClass + ']');

    if (re.test(d)) {
      // Stronger signal if it appears between alphanumerics in the host
      // e.g., "paypaI.com" => I is between a and . (still part of label)
      // We'll check each label
      const labels = d.split('.');
      for (const label of labels) {
        if (label.length < 3) continue;
        // confusable somewhere not at the very ends
        const mid = label.slice(1, -1);
        if (re.test(mid)) return true;
      }
    }
  }
  return false;
}

// NEW: any non-ASCII chars in the domain (script-mix risk)
function hasNonAscii(domain){
  return /[^\x00-\x7F]/.test(domain || '');
}

function isGovLike(url){
  try{
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isTrueGov = host.endsWith('.gov') || host.endsWith('.mil');
    const looksLike = /(irs|ssa|uscis|fbi|cdc|treasury|usps|va|dot|ed|hhs|medicare|medicaid|state)\b/.test(host);
    const fakeTld = /(\.com|\.net|\.org|\.co|\.info)$/i.test(host) && looksLike && !isTrueGov;
    return { isTrueGov, fakeTld, host, idn: hostHasIDN(host) };
  } catch(e) {
    return { isTrueGov:false, fakeTld:false, host:null, idn:false };
  }
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

  const urgency = /(urgent|immediately|final notice|last attempt|act now|24 hours|suspended|locked|verify now)/i
    .test(joined) ? 85 : 0;
  if(urgency>0) flags.push({ sev: severityFromScore(urgency), msg:'Urgency detected in subject/body' });

  const payment = /(pay now|overdue|past due|wire|zelle|gift card|bitcoin|crypto|cash app|western union|money order|cashier's check)/i
    .test(joined) ? 90 : 0;
  if(payment>0) flags.push({ sev: severityFromScore(payment), msg:'Demand-for-payment language detected' });

  // ===== REPLACED SECTION: Sender domain homoglyph & IDN (stronger) =====
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
  // ===== END REPLACED SECTION =====

  let fakeGov=0, trueGov=false, idnLink=false, shortener=0;
  (links||[]).forEach(l=>{
    const g = isGovLike(l);
    if(g.isTrueGov) trueGov=true;
    if(g.fakeTld) fakeGov=Math.max(fakeGov,95);
    if(g.idn) idnLink=true;
    try{
      const h = new URL(l).hostname;
      if(/(bit\.ly|tinyurl|t\.co|goo\.gl)$/i.test(h)) shortener=60;
    } catch {}
  });

  if(fakeGov>0) flags.push({ sev:'danger', msg:'Link pretends to be government (.com/.net with gov terms)' });
  if(trueGov)   flags.push({ sev:'ok',     msg:'Contains genuine .gov/.mil link' });
  if(idnLink)   flags.push({ sev:'warn',   msg:'Link hostname uses IDN punycode (xn--)' });
  if(shortener>0) flags.push({ sev:'warn', msg:'Shortened link present' });

  const sg = analyzeSpellingGrammar(joined);
  if(sg.score>35) flags.push({
    sev: severityFromScore(sg.score),
    msg: `High error rate in spelling/grammar (miss ~${Math.round(sg.detail.missRate*100)}%)`
  });

  const combined = combineScores([
    { score:(weights?.urgency ?? 60) * (urgency/100),     weight:1 },
    { score:(weights?.demand  ?? 70) * (payment/100),     weight:1 },
    { score:(weights?.homoglyph ?? 80) * (senderHomog/100), weight:1.1 },
    { score:(weights?.gov     ?? 80) * (fakeGov/100),     weight:1 },
    { score:(weights?.spell   ?? 55) * (sg.score/100),    weight:0.8 },
    { score: shortener,                                   weight:0.3 },
    { score: senderIDN,                                   weight:0.4 }
  ]);

  return { score: combined, flags };
}
