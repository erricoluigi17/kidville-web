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
import { meseDellaVoce } from '@/lib/pagamenti/selezione-voci';

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

// ─── Fine / eliminazione di un'iscrizione: quali voci già generate ne sono colpite ─────────────

/** I campi di una voce di pagamento che servono a decidere se esce dal periodo e se è eliminabile. */
export interface VoceServizio {
  id: string;
  tipo: string;
  importo: number | string | null;
  importo_pagato: number | string | null;
  stato: string | null;
  periodo_competenza: string | null;
  scadenza: string | null;
  fattura_stato: string | null;
  fattura_aruba_id: string | null;
}

/**
 * Perché una voce non si tocca mai.
 *  · `manuale`    senza `periodo_competenza`: l'ha scritta una persona prima che esistessero i
 *                 servizi (o fuori da essi). Il mese si ricava dalla scadenza e basta a
 *                 *proporla*, ma non a *cancellarla*: i solleciti ne dipendono (ON DELETE CASCADE);
 *  · `rateizzata` padre/split: hanno rate o quote figlie;
 *  · `pagata` · `parziale` · `incassi` · `fatturata` · `in_coda`: denaro o fisco.
 */
export type MotivoIntoccabile =
  | 'manuale'
  | 'rateizzata'
  | 'pagata'
  | 'parziale'
  | 'incassi'
  | 'fatturata'
  | 'in_coda';

/**
 * Le voci che il cambio di periodo lascia fuori: il loro mese (`meseDellaVoce`) era coperto dal
 * periodo VECCHIO e non lo è più dal NUOVO. `nuovo = null`: l'iscrizione sparisce, quindi tutte
 * quelle del periodo vecchio. Una voce senza mese ricavabile non si può collocare: non è colpita.
 */
export function vociFuoriPeriodo<T extends Pick<VoceServizio, 'periodo_competenza' | 'scadenza'>>(
  voci: readonly T[],
  vecchio: PeriodoIscrizione,
  nuovo: PeriodoIscrizione | null,
): T[] {
  return voci.filter((v) => {
    const mese = meseDellaVoce(v);
    if (!mese) return false;
    const periodo = `${mese}-01`;
    return attivaNel(vecchio, periodo) && (nuovo === null || !attivaNel(nuovo, periodo));
  });
}

/** Che cosa si sa di una voce oltre alla sua riga: le letture di sicurezza su `incassi`, fatture e coda. */
export interface ContestoVoce {
  conIncassi: boolean;
  conFatturaEmessa: boolean;
  inCodaFatture: boolean;
}

/**
 * Il motivo per cui la voce NON si cancella, o `null` se è eliminabile. L'ordine è quello della
 * gravità: prima ciò che non si può nemmeno proporre (manuale, rate), poi il denaro, poi il fisco.
 */
export function motivoIntoccabile(v: VoceServizio, ctx: ContestoVoce): MotivoIntoccabile | null {
  if (!v.periodo_competenza) return 'manuale';
  if (v.tipo !== 'singolo') return 'rateizzata';
  if (v.stato === 'pagato') return 'pagata';
  if (v.stato === 'parziale' || Number(v.importo_pagato ?? 0) > 0) return 'parziale';
  if (ctx.conIncassi) return 'incassi';
  if (v.fattura_aruba_id || (v.fattura_stato && v.fattura_stato !== 'non_richiesta') || ctx.conFatturaEmessa) {
    return 'fatturata';
  }
  if (ctx.inCodaFatture) return 'in_coda';
  return null;
}
