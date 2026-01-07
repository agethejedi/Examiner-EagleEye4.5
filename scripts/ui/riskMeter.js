// scripts/ui/riskMeter.js (v2 shaded/thick)
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function sevToRGB(sev) {
  if (sev === 'danger') return [255, 132, 86]; // orange/red
  if (sev === 'warn')   return [255, 191, 76]; // amber
  if (sev === 'ok')     return [0, 229, 255];  // neon aqua
  return [120, 160, 190];
}

function sevToAlpha(sev) {
  if (sev === 'danger') return 0.98;
  if (sev === 'warn')   return 0.88;
  if (sev === 'ok')     return 0.72;
  return 0.55;
}

function inferSegmentsFromFlags(flags = [], score = 0) {
  const segments = [];
  const rules = [
    { key: /urgency/i,                                    w: 12 },
    { key: /(demand|payment|pay\b|service fee)/i,         w: 18 },
    { key: /(government|civic|imperson)/i,                w: 22 },
    { key: /(punycode|idn|xn--)/i,                        w: 14 },
    { key: /(high-risk top-level|tld)/i,                  w: 14 },
    { key: /(checkout|invoice|billing|payment\/|\/pay)/i, w: 14 },
    { key: /(shorten|shortened)/i,                        w: 8  },
    { key: /(random subdomain|burner)/i,                  w: 10 },
    { key: /(spelling|grammar)/i,                         w: 7  },
    { key: /(homoglyph|look-alike|non-ascii)/i,           w: 12 },
  ];

  for (const f of flags) {
    const msg = f?.msg || '';
    const sev = f?.sev || 'neutral';
    let w = 10;
    for (const r of rules) { if (r.key.test(msg)) { w = r.w; break; } }

    if (sev === 'danger') w *= 1.20;
    else if (sev === 'warn') w *= 1.05;
    else if (sev === 'ok') w *= 0.85;

    segments.push({ label: msg, sev, w });
  }

  if (!segments.length) segments.push({ label: 'No notable signals', sev: 'neutral', w: 100 });

  const sum = segments.reduce((a, s) => a + s.w, 0) || 1;
  segments.forEach(s => { s.p = (s.w / sum) * 100; });

  const intensity = clamp(score / 100, 0, 1);
  return { segments, intensity };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  const rad = (a) => (Math.PI / 180) * a;
  const x1 = cx + r * Math.cos(rad(startAngle));
  const y1 = cy + r * Math.sin(rad(startAngle));
  const x2 = cx + r * Math.cos(rad(endAngle));
  const y2 = cy + r * Math.sin(rad(endAngle));
  const largeArc = (endAngle - startAngle) <= 180 ? 0 : 1;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`;
}

export function renderRiskMeter(el, { score = 0, flags = [], label = 'RISK SCORE' } = {}) {
  if (!el) return;

  const size = 240;
  const cx = size / 2, cy = size / 2;

  const ringR = 92;
  const ringW = 22; // thicker band

  const { segments, intensity } = inferSegmentsFromFlags(flags, score);

  const gapDeg = 18;
  const startDeg = -90 + gapDeg / 2;
  const usableDeg = 360 - gapDeg;

  let cursor = startDeg;

  const segPaths = segments.map((s, idx) => {
    const segDeg = (s.p / 100) * usableDeg;
    const a0 = cursor;
    const a1 = cursor + segDeg;
    cursor = a1;

    const [r, g, b] = sevToRGB(s.sev);
    const alpha = sevToAlpha(s.sev) * (0.62 + 0.38 * intensity);

    // We draw each segment twice:
    // 1) base stroke with color
    // 2) overlay stroke using a subtle highlight gradient (gives “shaded band”)
    const seg = `
      <path d="${describeArc(cx, cy, ringR, a0, a1)}"
            fill="none"
            stroke="rgb(${r},${g},${b})"
            stroke-width="${ringW}"
            stroke-linecap="butt"
            opacity="${alpha}" />

      <path d="${describeArc(cx, cy, ringR, a0, a1)}"
            fill="none"
            stroke="url(#rxStrokeShade)"
            stroke-width="${ringW}"
            stroke-linecap="butt"
            opacity="${0.55 + 0.35 * intensity}" />
    `;

    // Softer separator notch
    const sep = `
      <path d="${describeArc(cx, cy, ringR, a1 - 0.12, a1)}"
            fill="none"
            stroke="rgba(6,12,18,0.55)"
            stroke-width="${ringW + 3}"
            stroke-linecap="butt" />
    `;

    return seg + sep;
  }).join('\n');

  const progDeg = startDeg + usableDeg * clamp(score, 0, 100) / 100;

  el.innerHTML = `
    <div class="rx-meter">
      <svg viewBox="0 0 ${size} ${size}" role="img" aria-label="Risk meter">
        <defs>
          <!-- Neon bloom -->
          <filter id="rxNeon" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="6" result="b"/>
            <feColorMatrix in="b" type="matrix"
              values="1 0 0 0 0
                      0 1 0 0 0
                      0 0 1 0 0
                      0 0 0 0.55 0" />
            <feMerge>
              <feMergeNode/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>

          <!-- Center -->
          <radialGradient id="rxCenterGlow" cx="50%" cy="40%" r="70%">
            <stop offset="0%" stop-color="rgba(40,85,105,0.60)"/>
            <stop offset="70%" stop-color="rgba(10,20,32,0.92)"/>
            <stop offset="100%" stop-color="rgba(6,10,16,0.98)"/>
          </radialGradient>

          <!-- Stroke shading to emulate glossy band -->
          <linearGradient id="rxStrokeShade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(255,255,255,0.20)"/>
            <stop offset="35%" stop-color="rgba(255,255,255,0.05)"/>
            <stop offset="75%" stop-color="rgba(0,0,0,0.10)"/>
            <stop offset="100%" stop-color="rgba(0,0,0,0.22)"/>
          </linearGradient>
        </defs>

        <!-- Track -->
        <circle cx="${cx}" cy="${cy}" r="${ringR}"
                fill="none"
                stroke="rgba(38,66,86,0.95)"
                stroke-width="${ringW}"
                opacity="0.55"/>

        <!-- Segments -->
        <g filter="url(#rxNeon)">
          ${segPaths}
        </g>

        <!-- Thin progress highlight (cyan) -->
        <path d="${describeArc(cx, cy, ringR, startDeg, progDeg)}"
              fill="none"
              stroke="rgba(0,229,255,0.60)"
              stroke-width="4"
              stroke-linecap="round"
              filter="url(#rxNeon)" />

        <!-- Inner ring shadow -->
        <circle cx="${cx}" cy="${cy}" r="${ringR - ringW/2 - 10}"
                fill="none"
                stroke="rgba(0,0,0,0.35)"
                stroke-width="10" />

        <!-- Center disk -->
        <circle cx="${cx}" cy="${cy}" r="68" fill="url(#rxCenterGlow)"/>

        <!-- Text -->
        <text x="${cx}" y="${cy-18}" text-anchor="middle" class="rxm-label">${label}</text>
        <text x="${cx}" y="${cy+20}" text-anchor="middle" class="rxm-value">${Math.round(score)}</text>
        <text x="${cx}" y="${cy+42}" text-anchor="middle" class="rxm-sub">/ 100</text>
      </svg>
    </div>
  `;
}
