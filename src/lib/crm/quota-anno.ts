import { annoScolasticoCorrente } from '@/lib/anno-scolastico'
import type { AnnoIngresso } from './tipi'

/**
 * CRM DELLA SEGRETERIA · L'ANNO DELLA QUOTA, LA PARTE CHE SI PUÒ USARE ANCHE NEL BROWSER.
 *
 * Sta in un file suo perché `quota.ts` importa il logger del server (e, con lui, `next/headers`): un
 * componente client che lo importasse non si costruirebbe. Qui non c'è altro che calcolo puro. `quota.ts`
 * le ripubblica con lo stesso nome, quindi le route e i test continuano a importarle da lì.
 *
 *  · l'ANNO si ricava dall'anno di ingresso del bambino (`in_corso` → primo anno dell'anno scolastico
 *    corrente, `prossimo` → quello dopo) e si SALVA come intero, calcolato al momento in cui si segna: ad
 *    agosto «in corso» cambia significato e una quota già segnata non deve cambiare anno da sola;
 *  · l'ETICHETTA («2027/28») ne discende.
 */

/**
 * L'anno d'apertura dell'anno scolastico della quota: 2027 per il 2027/28. `non_indicato` non ne ha uno
 * (`null`): il CRM chiede di indicarlo prima di salvare. Il giorno si conta a Roma (`annoScolasticoCorrente`).
 */
export function annoDellaQuota(annoIngresso: AnnoIngresso, adesso: Date = new Date()): number | null {
  if (annoIngresso !== 'in_corso' && annoIngresso !== 'prossimo') return null
  const apertura = Number.parseInt(annoScolasticoCorrente(adesso).split('/')[0], 10)
  if (!Number.isFinite(apertura)) return null
  return annoIngresso === 'prossimo' ? apertura + 1 : apertura
}

/** 2027 → `2027/28`; 2099 → `2099/00`. */
export function etichettaAnno(anno: number): string {
  return `${anno}/${String((anno + 1) % 100).padStart(2, '0')}`
}
