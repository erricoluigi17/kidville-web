// Saluto neutro (non di genere) coerente con l'ora locale. Estratto dalla
// home docente/genitore (era duplicato): va SEMPRE calcolato client-side via
// useClientValue per non creare hydration mismatch server-UTC vs browser.
export function greetingByHour(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Buongiorno';
  if (h < 18) return 'Buon pomeriggio';
  return 'Buonasera';
}
