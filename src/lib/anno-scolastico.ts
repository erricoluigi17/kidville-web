// Anno scolastico italiano: va da settembre a luglio (agosto fa già da ponte
// verso il nuovo anno). Regola: mese >= 8 (agosto) → `${y}/${y+1}`,
// altrimenti `${y-1}/${y}`. Es. 10 lug 2026 → "2025/2026"; 1 ago 2026 → "2026/2027".
export function annoScolasticoCorrente(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = d.getMonth() + 1 // 1..12
  return m >= 8 ? `${y}/${y + 1}` : `${y - 1}/${y}`
}
