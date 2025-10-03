// Shared lightweight risk engine for consistent scoring across modules (Vision parity-lite)
export function combineScores(parts){
  let wsum=0, ssum=0;
  parts.forEach(p=>{ const w=p.weight ?? 1; wsum+=w; ssum+=w*(p.score??0); });
  const out = wsum? Math.round(ssum/wsum) : 0;
  return Math.max(0, Math.min(100, out));
}
export function severityFromScore(s){
  return s>=70?'danger': s>=40?'warn':'ok';
}
