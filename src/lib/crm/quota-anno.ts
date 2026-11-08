import { etichettaAnno as etichettaAnnoModulo } from '@/lib/anno-scolastico'
import type { AnnoIngresso } from './tipi'

/**
 * CRM DELLA SEGRETERIA · L'ANNO DELLA QUOTA, LA PARTE CHE SI PUÒ USARE ANCHE NEL BROWSER.
 *
 * Sta in un file suo perché `quota.ts` importa il logger del server (e, con lui, `next/headers`): un
 * componente client che lo importasse non si costruirebbe. Qui non c'è altro che calcolo puro. `quota.ts`
 * le ripubblica con lo stesso nome, quindi le route e i test continuano a importarle da lì.
 *
 *  · l'ANNO si ricava dall'anno di ingresso del bambino (`in_corso` → l'anno in corso, `prossimo` → quello
 *    dopo) e si SALVA come intero, calcolato al momento in cui si segna: ad agosto «in corso» cambia
 *    significato e una quota già segnata non deve cambiare anno da sola. Quale sia l'anno in corso NON lo
 *    decide questo file: lo dice chi chiama, dal modulo dell'anno (`annoDi` sul server, `useAnnoDi` nel
 *    browser), così la soglia e il calendario della sede vivono in un posto solo;
 *  · l'ETICHETTA («2027/28») ne discende.
 */

/**
 * L'anno d'apertura dell'anno scolastico della quota: 2027 per il 2027/28. `annoInCorso` è l'anno d'apertura
 * dell'anno in corso (`AnnoDelGiorno.annoInizio`). `non_indicato` non ne ha uno (`null`): il CRM chiede di
 * indicarlo prima di salvare.
 */
export function annoDellaQuota(annoIngresso: AnnoIngresso, annoInCorso: number): number | null {
  if (annoIngresso === 'in_corso') return annoInCorso
  if (annoIngresso === 'prossimo') return annoInCorso + 1
  return null
}

/** 2027 → `2027/28`; 2099 → `2099/00`. Vive nel modulo dell'anno: qui si richiama. */
export function etichettaAnno(anno: number): string {
  return etichettaAnnoModulo(anno, 'breve')
}
