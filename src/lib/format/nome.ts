// Formattazione display dei nomi (solo presentazione, NON altera i dati nel DB).
//
// I nomi anagrafici possono arrivare in minuscolo ("esposito gaia") o in
// MAIUSCOLO: per la UI li normalizziamo con iniziale maiuscola per ogni parola,
// gestendo spazi, trattini e apostrofi (es. "d'angelo" → "D'Angelo",
// "anna-maria" → "Anna-Maria").

/** Iniziale maiuscola per ogni parola di un singolo campo (nome o cognome). */
export function titleCaseNome(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .toLocaleLowerCase('it-IT')
    .replace(/(^|[\s'’\-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toLocaleUpperCase('it-IT'));
}

/** Compone "Cognome Nome" (o "Nome Cognome") già normalizzati, senza spazi doppi. */
export function nomeCompleto(
  nome: string | null | undefined,
  cognome: string | null | undefined,
  order: 'nome-cognome' | 'cognome-nome' = 'nome-cognome',
): string {
  const n = titleCaseNome(nome);
  const c = titleCaseNome(cognome);
  const parts = order === 'cognome-nome' ? [c, n] : [n, c];
  return parts.filter(Boolean).join(' ');
}
