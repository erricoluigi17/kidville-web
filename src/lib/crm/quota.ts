import type { SupabaseClient } from '@supabase/supabase-js'
import { dataCivile } from '@/i18n/config'
import { logEvento } from '@/lib/logging/logger'
import { CODICI_SCHEMA_CRM_ASSENTE, codiceErroreDb } from './errori'
import {
  QUOTA_MOTIVI_BLOCCO,
  type MetodoQuota,
  type MotivoBloccoQuota,
  type StatoQuota,
} from './tipi'

/**
 * CRM DELLA SEGRETERIA · LA QUOTA D'ISCRIZIONE, LA PARTE CHE NON TOCCA IL DATABASE (E UNA CHE LO TOCCA).
 *
 * Le regole di calcolo stanno qui, in funzioni pure, perché sono quelle che sbagliano in silenzio:
 *
 *  · l'ANNO si ricava dall'anno di ingresso del bambino (`in_corso` → primo anno dell'anno scolastico
 *    corrente, `prossimo` → quello dopo) e si SALVA come intero, calcolato al momento in cui si segna: ad
 *    agosto «in corso» cambia significato e una quota già segnata non deve cambiare anno da sola;
 *  · l'ETICHETTA («2027/28») e la COMPETENZA (`2027-09-01`) ne discendono. La competenza non è un
 *    dettaglio: la fatturazione sceglie la serie dall'anno di competenza;
 *  · il METODO: il CRM conosce `carta`, l'enum `incasso_metodo` no → in contabilità è `pos`;
 *  · la CASSA CHIUSA: un'entrata in contanti datata a un giorno già chiuso conterebbe due volte quei soldi
 *    (la chiusura registra la differenza col contato come rettifica).
 *
 * `passaQuotaInContabilita` è l'unico punto di questo file che parla col database, e ha la regola di
 * `collegamento.ts`: NON LANCIA MAI. L'import delle domande lo chiama a cose fatte, e un guasto del CRM non
 * deve far fallire un import che per le famiglie è andato a buon fine: ogni guasto è una riga di log e un
 * esito.
 */

// ── Anno, etichetta, competenza, metodo ──────────────────────────────────────

// `annoDellaQuota` e `etichettaAnno` vivono in `quota-anno.ts` (calcolo puro, usabile anche dai componenti
// client: questo file importa il logger del server). Qui si ripubblicano con lo stesso nome.
export { annoDellaQuota, etichettaAnno } from './quota-anno'

/** Il 1° settembre dell'anno d'apertura: 2027 → `2027-09-01`. */
export function competenzaDellaQuota(anno: number): string {
  return `${anno}-09-01`
}

/** Il metodo del CRM nell'enum `incasso_metodo`: `carta` → `pos`. */
export function metodoIncasso(m: MetodoQuota): 'contanti' | 'pos' | 'bonifico' {
  return m === 'carta' ? 'pos' : m
}

/**
 * Per i contanti: il giorno del pagamento è ammesso se cade DOPO il giorno civile (a Roma) dell'ultima
 * chiusura di cassa della sede, oppure se è OGGI (soldi arrivati dopo la chiusura di oggi). Senza nessuna
 * chiusura ogni giorno va bene. Una chiusura che non si sa leggere chiude il giorno: meglio un rifiuto, che
 * si risolve scegliendo oggi, che un incasso contato due volte.
 *
 * `giorno` e `oggi` sono `yyyy-mm-dd`; `ultimaChiusuraIl` è il timestamp di `cassa_chiusure.eseguita_il`.
 */
export function giornoContantiAmmesso(giorno: string, ultimaChiusuraIl: string | null, oggi: string): boolean {
  if (giorno === oggi) return true
  if (ultimaChiusuraIl === null) return true
  const chiusura = new Date(ultimaChiusuraIl)
  if (Number.isNaN(chiusura.getTime())) return false
  return giorno > dataCivile(chiusura)
}

/**
 * Da quanti giorni una quota aspetta: i giorni CIVILI fra il giorno del pagamento (`yyyy-mm-dd`, la colonna
 * `quota_saldata_il` è una `date`) e `oggi` (`yyyy-mm-dd`, a Roma: lo dà `dataCivile()`).
 *
 * Si contano sulle date e non sugli istanti: due giorni di calendario distano sempre un numero intero di
 * giorni, anche attraverso il cambio dell'ora legale, dove un conto in millisecondi su orari locali darebbe
 * 23 o 25 ore. Nullo se il giorno manca o non è una data; mai negativo (un giorno che sembra nel futuro, per
 * un orologio sfasato, vale zero e non «-3 giorni di attesa»).
 */
export function giorniDiAttesa(giorno: string | null | undefined, oggi: string): number | null {
  const da = /^(\d{4})-(\d{2})-(\d{2})$/.exec(giorno ?? '')
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(oggi)
  if (!da || !a) return null
  const mezzanotteUtc = (m: RegExpExecArray) => Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const giorni = Math.round((mezzanotteUtc(a) - mezzanotteUtc(da)) / 86_400_000)
  return Math.max(0, giorni)
}

// ── L'esito del passaggio in contabilità ─────────────────────────────────────

export type EsitoPassaggio =
  | { esito: 'ok'; pagamentoId: string; incassoId: string | null; voceNuova: boolean }
  | { esito: 'bloccata'; motivo: MotivoBloccoQuota }
  | { esito: 'gia_in_contabilita'; pagamentoId: string }
  | { esito: 'non_pronta' | 'non_trovato' | 'sede_diversa' | 'categoria_assente' | 'non_installato' | 'errore' }

const ESITI_SENZA_DATI = ['non_pronta', 'non_trovato', 'sede_diversa', 'categoria_assente'] as const

const stringaNonVuota = (v: unknown): v is string => typeof v === 'string' && v !== ''

/**
 * Dal jsonb che restituisce `crm_quota_passa` (o il campo `passaggio` di `crm_quota_segna`) al tipo.
 * Ciò che non si riconosce è `errore`: una forma imprevista non diventa mai un successo né un'eccezione.
 */
export function esitoPassaggioDa(json: unknown): EsitoPassaggio {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { esito: 'errore' }
  const j = json as Record<string, unknown>

  switch (j.esito) {
    case 'ok': {
      if (!stringaNonVuota(j.pagamento_id)) return { esito: 'errore' }
      // Il bonifico non genera un incasso: `incasso_id` è nullo. Qualunque altra cosa che non sia un id no.
      if (j.incasso_id != null && !stringaNonVuota(j.incasso_id)) return { esito: 'errore' }
      return {
        esito: 'ok',
        pagamentoId: j.pagamento_id,
        incassoId: j.incasso_id == null ? null : j.incasso_id,
        voceNuova: j.voce_nuova === true,
      }
    }
    case 'bloccata': {
      const motivo = (QUOTA_MOTIVI_BLOCCO as readonly unknown[]).includes(j.motivo) ? (j.motivo as MotivoBloccoQuota) : null
      return motivo ? { esito: 'bloccata', motivo } : { esito: 'errore' }
    }
    case 'gia_in_contabilita':
      return stringaNonVuota(j.pagamento_id) ? { esito: 'gia_in_contabilita', pagamentoId: j.pagamento_id } : { esito: 'errore' }
    default: {
      const senzaDati = ESITI_SENZA_DATI.find((e) => e === j.esito)
      return senzaDati ? { esito: senzaDati } : { esito: 'errore' }
    }
  }
}

/** Lo stato della quota dopo che `crm_quota_segna` ha provato il passaggio (`null` = il bambino non è ancora alunno). */
export function statoDopoPassaggio(passaggio: EsitoPassaggio | null): StatoQuota {
  if (passaggio?.esito === 'ok' || passaggio?.esito === 'gia_in_contabilita') return 'in_contabilita'
  if (passaggio?.esito === 'bloccata') return 'bloccata'
  return 'in_attesa'
}

// ── Il log del passaggio ─────────────────────────────────────────────────────

/**
 * UNA riga di log per ogni esito del passaggio, con l'id del bambino e basta. Il passaggio in contabilità è
 * un evento critico: logga anche il SUCCESSO («nessun log» non distingue «tutto ok» da «non è partito niente»).
 *
 * ⚠️ Il motivo del blocco sta DENTRO `esito` (`quota-bloccata:gia_pagata`), non in un campo `motivo`: il
 * logger redige ogni chiave che contiene «motivo» (è il nome con cui viaggia il testo libero), e un avviso
 * che non dice perché la quota è bloccata non serve a nessuno.
 */
export function registraEsitoPassaggio(esito: EsitoPassaggio, bambinoId: string, operazione: string): void {
  const base = { operazione, entita_id: bambinoId }
  switch (esito.esito) {
    case 'ok':
      logEvento('crm', 'info', {
        ...base,
        esito: 'quota-in-contabilita',
        pagamento_id: esito.pagamentoId,
        voce_nuova: esito.voceNuova,
      })
      return
    case 'bloccata':
      logEvento('crm', 'warn', { ...base, esito: `quota-bloccata:${esito.motivo}` })
      return
    case 'gia_in_contabilita':
      logEvento('crm', 'info', { ...base, esito: 'quota-gia-in-contabilita', pagamento_id: esito.pagamentoId })
      return
    case 'non_pronta':
      logEvento('crm', 'info', { ...base, esito: 'quota-non-pronta' })
      return
    case 'non_trovato':
      logEvento('crm', 'warn', { ...base, esito: 'quota-bambino-non-trovato' })
      return
    case 'sede_diversa':
      // L'alunno collegato è di un'altra sede: non è un guasto, è un dato da guardare. La quota non passa.
      logEvento('crm', 'warn', { ...base, esito: 'quota-sede-diversa' })
      return
    case 'categoria_assente':
      // Manca la categoria di sistema «iscrizione»: un incidente di configurazione, mai una nota a piè di pagina.
      logEvento('crm', 'error', { ...base, esito: 'quota-categoria-assente' })
      return
    case 'non_installato':
      logEvento('crm', 'warn', { ...base, esito: 'schema-crm-assente' })
      return
    case 'errore':
      logEvento('crm', 'error', { ...base, esito: 'quota-risposta-illeggibile' })
      return
  }
}

function esitoDaErrore(err: unknown, bambinoId: string, operazione: string): EsitoPassaggio {
  if (CODICI_SCHEMA_CRM_ASSENTE.has(codiceErroreDb(err))) {
    logEvento('crm', 'warn', { operazione, esito: 'schema-crm-assente', entita_id: bambinoId }, err)
    return { esito: 'non_installato' }
  }
  logEvento('crm', 'error', { operazione, esito: 'errore', entita_id: bambinoId }, err)
  return { esito: 'errore' }
}

const OP_PASSA = 'crm/quota:passaQuotaInContabilita'

/**
 * Chiama `crm_quota_passa`: la quota del bambino diventa la voce «Iscrizione AAAA/AA» dell'alunno (o si lega
 * a quella che l'alunno ha già, o resta bloccata con un motivo). Una transazione sola, nel database.
 *
 * `eseguitoDa` è chi ha premuto «riprova»; `null` quando lo fa il sistema (l'import della domanda), e allora
 * lo storico scrive «sistema». NON LANCIA MAI: tabella o funzione assente → `non_installato` (warn), ogni
 * altro guasto → `errore` (error); il chiamante guarda l'esito.
 */
export async function passaQuotaInContabilita(
  supabase: SupabaseClient,
  bambinoId: string,
  eseguitoDa: string | null,
): Promise<EsitoPassaggio> {
  try {
    const { data, error } = await supabase.rpc('crm_quota_passa', { p_bambino_id: bambinoId, p_eseguito_da: eseguitoDa })
    if (error) return esitoDaErrore(error, bambinoId, OP_PASSA)
    const esito = esitoPassaggioDa(data)
    registraEsitoPassaggio(esito, bambinoId, OP_PASSA)
    return esito
  } catch (err) {
    return esitoDaErrore(err, bambinoId, OP_PASSA)
  }
}
