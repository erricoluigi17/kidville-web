import {
  annoAttivoDelCalendario,
  etichettaAnno as etichettaAnnoModulo,
  type Calendario,
  type RigaCalendario,
} from '@/lib/anno-scolastico'
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
 *
 * Dalla PR 4.5 la scheda dichiara il SUO anno (`crm_bambini.anno_id`): `annoDellaScheda` lo traduce nell'anno d'apertura cercandolo
 * fra gli anni della sede, e la quota lo segue qualunque sia il giorno di oggi. `annoDellaQuota` (l'etichetta relativa) resta per le
 * schede che non hanno un anno, come prima.
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

/**
 * L'anno d'apertura (2027 per il 2027/28) dell'anno che la scheda dichiara con `anno_id`, cercato fra gli anni della sua sede
 * (`anni_sede` + `anni_scolastici`, cioè il calendario). `null` se la scheda non ha un anno, se la sede non lo ha o se il calendario
 * non c'è: allora si ricade su `annoDellaQuota`. Gli uuid si confrontano senza badare alle maiuscole. Non legge mai «oggi».
 */
export function annoDellaScheda(
  annoId: string | null | undefined,
  anniDellaSede: Calendario | null | undefined,
): number | null {
  if (!annoId || !anniDellaSede) return null
  const cercato = annoId.toLowerCase()
  const riga = anniDellaSede.find((r) => r.annoId.toLowerCase() === cercato)
  return riga ? riga.annoInizio : null
}

/**
 * L'etichetta relativa che resta coerente con l'anno scelto, per le schede e le viste che leggono ancora `anno_ingresso` (la PR 5
 * la toglie): `in_corso` per l'anno attivo della sede (e per uno ancora aperto prima di lui), `prossimo` per i successivi. Senza un
 * anno attivo, un anno in preparazione o con le iscrizioni aperte è `prossimo`.
 */
export function annoIngressoDaAnno(riga: RigaCalendario, anniDellaSede: Calendario | null | undefined): Exclude<AnnoIngresso, 'non_indicato'> {
  const attivo = annoAttivoDelCalendario(anniDellaSede)
  if (attivo) return riga.annoInizio > attivo.annoInizio ? 'prossimo' : 'in_corso'
  return riga.stato === 'in_preparazione' || riga.stato === 'iscrizioni_aperte' ? 'prossimo' : 'in_corso'
}

/** 2027 → `2027/28`; 2099 → `2099/00`. Vive nel modulo dell'anno: qui si richiama. */
export function etichettaAnno(anno: number): string {
  return etichettaAnnoModulo(anno, 'breve')
}
