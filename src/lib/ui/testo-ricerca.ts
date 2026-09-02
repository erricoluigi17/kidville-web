/**
 * IL TESTO SU CUI SI CONFRONTA — un posto solo, per il campo e per gli elenchi.
 *
 * Queste due funzioni sono nate dentro `src/components/ui/Combobox.tsx`, per
 * l'elenco dei 484 comuni della provincia di Torino. Servono identiche alla
 * ricerca della barra filtri, e ricopiarle sarebbe stato il modo di farle
 * divergere: la prima cosa che si aggiusta in una ricerca è proprio la
 * normalizzazione (un apostrofo in più, un trattino), e correggerla in un posto
 * su due lascia due campi che «cercano» in modo diverso nella stessa pagina.
 *
 * Modulo senza React e senza DOM: si prova senza montare niente.
 *
 * ⚠️ `Combobox` continua a esportarle (ri-esporto), perché sei moduli le
 * importano da lì e il suo banco di prova le misura per nome. `Combobox.tsx`
 * NON ne tiene una copia: importa e riesporta queste, e
 * `__tests__/lib/filtri-motore.test.ts` §13 verifica che siano lo STESSO
 * oggetto funzione — non due che si somigliano.
 */

const SEGNI_DIACRITICI = /[\u0300-\u036f]/g;
/** Apostrofo dritto, tipografico (iOS lo mette da solo), accenti gravi/acuti usati come apostrofo. */
const APOSTROFI = /[\u0027\u2018\u2019\u201A\u201B\u02BC\u0060\u00B4]/g;

/**
 * Il testo su cui si confronta: accenti sciolti con NFD e buttati via, apostrofi
 * ridotti a uno spazio, spazi collassati, minuscolo.
 *
 * L'apostrofo diventa SPAZIO e non sparisce: così «Sant'Agnello» si trova
 * digitando `sant'agnello`, `sant’agnello` e `sant agnello` — tre modi che a
 * seconda della tastiera arrivano tutti allo stesso posto — e in più
 * l'apostrofo continua a valere come confine di parola per il ranking.
 */
export function normalizzaTesto(testo: string): string {
  return testo
    .normalize('NFD')
    .replace(SEGNI_DIACRITICI, '')
    .replace(APOSTROFI, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const RANGO_PREFISSO = 0;
const RANGO_PAROLA = 1;
const RANGO_SOTTOSTRINGA = 2;

/**
 * Alfanumerico sul testo GIÀ normalizzato (minuscolo e senza accenti), quindi
 * `[a-z0-9]` basta e non serve `\p{L}` — che a `target: ES2017` TypeScript
 * rifiuterebbe (le property escape Unicode sono ES2018).
 */
function alfanumerico(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
}

/**
 * Quanto bene `query` (normalizzata) descrive `etichetta` (normalizzata):
 * `0` inizio stringa · `1` inizio di una parola · `2` dentro una parola ·
 * `null` non c'è. Si tiene l'occorrenza MIGLIORE, non la prima: in «Rivarolo
 * Canavese» la query `canav` compare una volta sola, ma in nomi ripetuti la
 * prima occorrenza può essere quella peggiore.
 */
export function rangoDiMatch(etichetta: string, query: string): number | null {
  if (query === '') return RANGO_PREFISSO;
  let migliore: number | null = null;
  for (let i = etichetta.indexOf(query); i >= 0; i = etichetta.indexOf(query, i + 1)) {
    const r = i === 0
      ? RANGO_PREFISSO
      : alfanumerico(etichetta[i - 1])
        ? RANGO_SOTTOSTRINGA
        : RANGO_PAROLA;
    if (migliore === null || r < migliore) migliore = r;
    if (migliore === RANGO_PREFISSO) break;
  }
  return migliore;
}

/**
 * `true` se `query` (testo grezzo dell'utente) descrive almeno uno dei testi
 * della riga. È la sola cosa che serve a un filtro: il RANGO ordina un elenco di
 * scelte, un filtro non ordina niente — tiene o scarta.
 *
 * Query vuota (o di soli spazi) ⇒ `true`: «non sto cercando niente» non può
 * voler dire «non mostrarmi niente».
 */
export function testoCorrisponde(
  testi: readonly (string | null | undefined)[],
  query: string,
): boolean {
  const q = normalizzaTesto(query);
  if (q === '') return true;
  for (const testo of testi) {
    if (!testo) continue;
    if (rangoDiMatch(normalizzaTesto(testo), q) !== null) return true;
  }
  return false;
}
