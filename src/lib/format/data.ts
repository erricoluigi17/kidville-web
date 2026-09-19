// Helper puri per il formato data italiano (gg/mm/aaaa) ↔ ISO (yyyy-mm-dd).
// Deterministici (niente dipendenza dal locale del browser/OS), testabili.

/** ISO 'yyyy-mm-dd' → 'gg/mm/aaaa' (stringa vuota se non valida). */
export function isoToIt(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** 'gg/mm/aaaa' → ISO 'yyyy-mm-dd', oppure null se incompleta/non valida (con check di calendario). */
export function itToIso(it: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((it ?? '').trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const giorno = Number(dd), mese = Number(mm);
  if (mese < 1 || mese > 12 || giorno < 1 || giorno > 31) return null;
  const iso = `${yyyy}-${mm}-${dd}`;
  const dt = new Date(`${iso}T12:00:00`);
  // Rifiuta date impossibili (es. 31/02): il rollover cambierebbe mese/giorno.
  if (Number.isNaN(dt.getTime()) || dt.getMonth() + 1 !== mese || dt.getDate() !== giorno) return null;
  return iso;
}

/**
 * ISO 'yyyy-mm-dd' spostato di `n` giorni (anche negativi), sempre ISO.
 *
 * ⚠️ DUE DETTAGLI CHE SEMBRANO PIGNOLI E NON LO SONO.
 *
 * 1. Si parsa a **MEZZOGIORNO** (`T12:00:00`), non a mezzanotte: nelle notti del
 *    cambio d'ora legale un giorno dura 23 o 25 ore, e mezzogiorno lascia dodici
 *    ore di margine da entrambi i lati. In `Europe/Rome` il cambio scatta alle
 *    03:00 e la mezzanotte esiste comunque, quindi qui la differenza non si vede:
 *    serve nei fusi in cui la mezzanotte locale NON ESISTE (il salto in avanti
 *    avviene a 00:00) e rende innocua anche una futura ricomposizione in UTC. È
 *    difesa in profondità, ed è la convenzione già usata qui sopra da `itToIso`
 *    e da `AppelloGiornaliero`. ⚠️ Il test non la separa dalla mezzanotte: chi la
 *    cambia non troverà un rosso, troverà questa riga.
 *
 * 2. Si ricompone con `getFullYear/getMonth/getDate` — cioè in ora **LOCALE** — e
 *    non con `toISOString()`, che è UTC. Questa sì è sorvegliata: il lock di
 *    `__tests__/lib/format-data.test.ts` la prova con `TZ=Pacific/Kiritimati`
 *    (UTC+14), dove mezzogiorno locale è già il giorno prima in UTC. È la famiglia
 *    di difetti che questo repo ha già pagato quattro volte.
 *
 * Se `iso` non ha la forma di una data, torna indietro invariato: spostare di un
 * giorno una cosa che non è un giorno non ha una risposta giusta, e inventarne
 * una qui la farebbe finire in una query.
 *
 * 3. L'ANNO SI RIEMPIE A QUATTRO CIFRE, e non è un vezzo di formattazione. Mese e
 *    giorno avevano il loro `padStart` dal primo giorno; l'anno no, e
 *    `getFullYear()` di un 202 d.C. stampa `202`: da `'0202-06-15'` (che è
 *    raggiungibile dalla tastiera del campo mascherato battendo `15060202`)
 *    usciva `'202-06-16'`, di forma NON ISO, che la regola qui sopra avrebbe poi
 *    rifiutato al giro successivo — un valore che entra ma non può più muoversi.
 *
 * ⚠️ QUELLO CHE IL RIEMPIMENTO NON FA: il tetto. `'9999-12-31' + 1` giorno resta
 * `'10000-01-01'`, cinque cifre d'anno, perché troncarlo a quattro qui direbbe una
 * data falsa (`'0000-01-01'`) e restituire l'ingresso invariato fingerebbe che il
 * giorno non sia cambiato. Chi propaga il risultato all'esterno controlla la sua
 * USCITA, non solo il suo ingresso: lo fa `NavigatoreData` sulle frecce
 * (`giornoNavigabile(prossimo)`), che a 9999 semplicemente non si muove.
 */
export function addGiorni(iso: string, n: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso ?? '')) return iso;
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setDate(d.getDate() + n);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const gg = String(d.getDate()).padStart(2, '0');
  return `${String(d.getFullYear()).padStart(4, '0')}-${mm}-${gg}`;
}

/** Applica la maschera gg/mm/aaaa mentre si digita (solo cifre, con gli slash). */
export function maskItDate(raw: string): string {
  const digits = (raw ?? '').replace(/\D/g, '').slice(0, 8);
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean);
  return parts.join('/');
}
