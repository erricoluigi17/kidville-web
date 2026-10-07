/**
 * Servizi mensili (pomeridiano, doposcuola, pulmino…): un bambino si iscrive a un
 * servizio con un importo mensile e un periodo `dal` (obbligatorio) – `al`
 * (facoltativo, compreso). Logica pura, senza I/O, condivisa da route e interfaccia.
 *
 * Regole:
 *  - le date di iscrizione sono SEMPRE il primo del mese ('YYYY-MM-01');
 *  - `al` nullo = iscrizione senza fine; `al` è un mese COMPRESO;
 *  - due iscrizioni si sovrappongono se hanno almeno un mese in comune: stesso esito
 *    del vincolo SQL `daterange(dal, al + 1 mese, '[)') &&` (mesi adiacenti: no).
 *
 * Le date 'YYYY-MM-01' si confrontano come stringhe: l'ordine lessicografico
 * coincide con quello cronologico.
 */
import { z } from 'zod';

/** Mese 'YYYY-MM'. */
export const zMese = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mese non valido (atteso AAAA-MM)');

/** Periodo di un'iscrizione: date 'YYYY-MM-01', `al` compreso e facoltativo. */
export interface PeriodoIscrizione {
  dal: string;
  al: string | null;
}

const PRIMO_DEL_MESE = /^\d{4}-(0[1-9]|1[0-2])-01$/;

/** Da 'YYYY-MM' (o 'YYYY-MM-DD') a 'YYYY-MM-01'. */
export function primoDelMese(mese: string): string {
  return `${mese.slice(0, 7)}-01`;
}

/** Vero se l'iscrizione è attiva nel `periodo` ('YYYY-MM-01'). */
export function attivaNel(iscr: PeriodoIscrizione, periodo: string): boolean {
  return iscr.dal <= periodo && (iscr.al === null || iscr.al >= periodo);
}

/** Vero se i due intervalli di mesi (estremi compresi, `al` nullo = senza fine) hanno un mese in comune. */
export function periodiSovrapposti(a: PeriodoIscrizione, b: PeriodoIscrizione): boolean {
  const aIniziaPrimaCheBFinisca = b.al === null || a.dal <= b.al;
  const bIniziaPrimaCheAFinisca = a.al === null || b.dal <= a.al;
  return aIniziaPrimaCheBFinisca && bIniziaPrimaCheAFinisca;
}

/** `dal` primo del mese; `al` nullo oppure primo del mese e >= `dal`. */
export function periodoValido(p: PeriodoIscrizione): boolean {
  if (!PRIMO_DEL_MESE.test(p.dal)) return false;
  if (p.al === null) return true;
  return PRIMO_DEL_MESE.test(p.al) && p.al >= p.dal;
}

/** I periodi 'YYYY-MM-01' dell'intervallo [daPeriodo, aPeriodo] coperti dall'iscrizione. */
export function mesiCoperti(p: PeriodoIscrizione, daPeriodo: string, aPeriodo: string): string[] {
  const out: string[] = [];
  let anno = Number(daPeriodo.slice(0, 4));
  let mese = Number(daPeriodo.slice(5, 7));
  for (;;) {
    const periodo = `${anno}-${String(mese).padStart(2, '0')}-01`;
    if (periodo > aPeriodo) break;
    if (attivaNel(p, periodo)) out.push(periodo);
    mese += 1;
    if (mese > 12) {
      mese = 1;
      anno += 1;
    }
  }
  return out;
}
