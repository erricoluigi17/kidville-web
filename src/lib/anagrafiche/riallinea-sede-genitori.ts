/* ════════════════════════════════════════════════════════════════════════════
 * QUANDO UN BAMBINO CAMBIA PLESSO, L'ACCOUNT DI SUO PADRE RESTA NEL VECCHIO.
 *
 * `parents` non ha una colonna sede, e non deve averla: un genitore può avere
 * legittimamente due figli in due plessi. Ma l'ACCOUNT di login ce l'ha —
 * `utenti.scuola_id` è NOT NULL — ed è DERIVATO dai figli (`sedeDelGenitore`).
 * Finora nessuno lo ricalcolava dopo uno spostamento, per il semplice motivo
 * che fino al 2026-09-03 spostare non si poteva.
 *
 * Quella colonna non è cosmetica: è la sede con cui vengono registrate la
 * richiesta GDPR di cancellazione e la notifica dei moduli firmati. Un genitore
 * rimasto indietro riceve dal plesso di partenza, e la segreteria di arrivo non
 * lo vede — senza nessun errore da nessuna parte.
 *
 * ─── IL CASO CHE CONTA È QUELLO IN CUI NON SI SCRIVE ────────────────────────
 *
 * Due figli in due plessi è la condizione che il prodotto DEVE permettere: lì
 * non esiste una sede giusta, e sceglierne una sarebbe inventare un dato.
 * `sedeDelGenitore` risponde `ambigua`, e `ambigua` non è un guasto: è la
 * risposta corretta. Si lascia la sede di prima e si scrive nei log a livello
 * `info` — un `warn` su una condizione legittima insegna a chi guarda i log a
 * ignorare i warn.
 *
 * ─── FAIL-OPEN VERSO IL CHIAMANTE, MAI MUTO ─────────────────────────────────
 *
 * Questo modulo gira DOPO che il trasferimento è già avvenuto: un suo guasto non
 * deve far fallire l'operazione, che a quel punto sarebbe riuscita a metà. Ma
 * fail-open non vuol dire silenzioso — ogni ramo che rinuncia lascia una riga
 * con il motivo, e il riepilogo finale dice quanti sono stati letti, quanti
 * scritti e quanti lasciati stare.
 * ════════════════════════════════════════════════════════════════════════════ */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getGenitoriDiAlunni } from '@/lib/anagrafiche/legami'
import { sedeDelGenitore } from '@/lib/auth/parent-identity'
import { formaConfronto } from '@/lib/auth/scope'
import { logEvento } from '@/lib/logging/logger'

const OPERAZIONE = 'anagrafiche/riallinea-sede-genitori'

/** Quanti account sono stati toccati, e quanti no — con il perché diviso per tipo. */
export interface RiepilogoRiallineo {
  /** `utenti.scuola_id` riscritto. */
  aggiornati: number
  /** La sede era già quella giusta: nessuna scrittura. */
  invariati: number
  /** Figli in DUE o più plessi: lasciato com'era, di proposito. */
  ambigui: number
  /** Non si è potuto decidere o scrivere — anagrafica `parents` assente, ZERO
   *  figli in anagrafica, lettura o scrittura respinta: si è rinunciato,
   *  dicendolo. */
  saltati: number
}

const vuoto = (): RiepilogoRiallineo => ({ aggiornati: 0, invariati: 0, ambigui: 0, saltati: 0 })

/**
 * Il riepilogo, scritto nei log e restituito — anche quando non c'era niente da
 * fare, ed è il caso per cui questa funzione esiste.
 *
 * Uscire in silenzio quando nessun alunno spostato ha genitori collegati rende
 * «nessuna riga `riallineo-sedi-genitori`» indistinguibile fra «non c'era nessun
 * genitore da riallineare» e «il riallineo non è mai partito»: è l'ambiguità che
 * la regola 5 di AGENTS.md esiste per impedire — con i soli errori, «nessun log»
 * non distingue «tutto ok» da «non è partito niente».
 *
 * ⚠️ Restano fuori i due rami di LETTURA IN ERRORE (`parents`, `utenti`): non
 * sono silenziosi — lasciano una riga `error` col codice PostgREST — ma non
 * scrivono il riepilogo, quindi «una riga di riepilogo per ogni giro» NON è un
 * invariante su cui si possa contare in SQL. Chi lo vorrà dovrà farlo di
 * proposito, non darlo per scontato.
 */
function riepiloga(n: number, riepilogo: RiepilogoRiallineo): RiepilogoRiallineo {
  logEvento('multi_sede', 'info', {
    operazione: OPERAZIONE, esito: 'riallineo-sedi-genitori', n, ...riepilogo,
  })
  return riepilogo
}

/**
 * Riallinea `utenti.scuola_id` dei genitori degli alunni indicati.
 *
 * Va chiamata DOPO che `alunni.scuola_id` è stato scritto: legge la sede dai
 * figli, quindi prima del commit leggerebbe ancora quella vecchia.
 *
 * @param admin client con service-role (deve poter leggere `parents` e scrivere `utenti`).
 * @param alunnoIds gli alunni appena spostati.
 */
export async function riallineaSedeGenitori(
  admin: SupabaseClient,
  alunnoIds: readonly string[],
): Promise<RiepilogoRiallineo> {
  const riepilogo = vuoto()

  const alunni = [...new Set((alunnoIds ?? []).filter(Boolean))]
  // Nessun alunno, nessuna domanda: una query a vuoto è comunque una query.
  // È l'unica uscita muta rimasta, ed è muta di proposito: qui non è successo
  // niente perché il CHIAMANTE non ha chiesto niente — chi trasferisce passa
  // sempre almeno un alunno, e una riga qui direbbe solo che è stata chiamata
  // una funzione a vuoto.
  if (alunni.length === 0) return riepilogo

  // 1. Gli account genitore, dall'unione delle due tabelle ponte vive.
  const perAlunno = await getGenitoriDiAlunni(admin, alunni)
  const account = [...new Set([...perAlunno.values()].flat())]
  // Nessun genitore collegato è un ESITO, non un non-evento: si riepiloga a 0.
  if (account.length === 0) return riepiloga(0, riepilogo)

  // 2. Da `utenti.id` all'anagrafica `parents.id`: è `parents.id` che
  //    `sedeDelGenitore` sa interrogare.
  const { data: anagrafiche, error: errAnagrafiche } = await admin
    .from('parents')
    .select('id, auth_user_id')
    .in('auth_user_id', account)
  if (errAnagrafiche) {
    // PostgREST non lancia: se non si controlla il valore di ritorno, questo
    // ramo diventa «nessun genitore» — cioè un guasto travestito da fatto.
    logEvento('multi_sede', 'error', {
      operazione: OPERAZIONE, esito: 'riallineo-anagrafiche-non-lette', n: account.length,
    }, errAnagrafiche)
    return riepilogo
  }
  const parentPerAccount = new Map<string, string>()
  for (const r of (anagrafiche ?? []) as { id?: unknown; auth_user_id?: unknown }[]) {
    if (typeof r.id === 'string' && typeof r.auth_user_id === 'string') {
      parentPerAccount.set(r.auth_user_id, r.id)
    }
  }

  // 3. La sede con cui l'account è agganciato ADESSO: senza questa, ogni giro
  //    riscriverebbe la riga anche quando non è cambiato niente.
  const { data: righeUtenti, error: errUtenti } = await admin
    .from('utenti')
    .select('id, scuola_id')
    .in('id', account)
  if (errUtenti) {
    logEvento('multi_sede', 'error', {
      operazione: OPERAZIONE, esito: 'riallineo-utenti-non-letti', n: account.length,
    }, errUtenti)
    return riepilogo
  }
  const sedeAttuale = new Map<string, string | null>()
  for (const r of (righeUtenti ?? []) as { id?: unknown; scuola_id?: unknown }[]) {
    if (typeof r.id === 'string') {
      sedeAttuale.set(r.id, typeof r.scuola_id === 'string' ? r.scuola_id : null)
    }
  }

  for (const accountId of account) {
    const parentId = parentPerAccount.get(accountId)
    if (!parentId) {
      // Legame solo runtime, anagrafica assente. Dedurre la sede dall'alunno
      // scavalcherebbe proprio il controllo dell'ambiguità: si rinuncia.
      logEvento('multi_sede', 'warn', {
        operazione: OPERAZIONE, esito: 'sede-genitore-senza-anagrafica', utente: accountId,
      })
      riepilogo.saltati += 1
      continue
    }

    const { scuolaId, motivo, sediFigli } = await sedeDelGenitore(admin, parentId)

    /* ─── «AMBIGUA» ARRIVA DA DUE STRADE OPPOSTE, E UNA SOLA È LEGITTIMA ─────
     *
     * I genitori qui sopra li ha trovati `getGenitoriDiAlunni`, che li pesca
     * dall'UNIONE delle due tabelle ponte vive (`legame_genitori_alunni` +
     * `student_parents`). La loro sede la legge invece `sedeDelGenitore`, che
     * guarda SOLO `student_parents`. Per un genitore agganciato al figlio solo
     * per via runtime le due domande hanno due risposte diverse: la prima lo
     * trova, la seconda non gli vede nessun figlio e risponde `ambigua` con
     * `sediFigli: []` — lo stesso `motivo` di chi ha davvero due bambini in due
     * plessi, per la ragione esattamente opposta.
     *
     * Trattarli allo stesso modo faceva scrivere «figli in più plessi, lasciato
     * di proposito · n: 0» su un genitore che di figli in anagrafica non ne ha
     * NESSUNO: una riga che dice il contrario di ciò che è successo, cioè
     * peggio di nessuna riga. In produzione la casistica è reale e misurata il
     * 2026-09-03: 19 account con riga `parents` e almeno un figlio agganciato
     * solo per via runtime, 12 righe `parents` con account e zero figli in
     * `student_parents`.
     *
     * ⚠️ IL BUCO CHE RESTA APERTO, e perché non si chiude qui. Si potrebbe
     * dedurre la sede anche dai legami runtime, allineando `sedeDelGenitore`
     * alle due sorgenti. Non si fa in questa correzione perché non è una
     * correzione di diagnosi: è una SCELTA DI PRODOTTO — cambierebbe la sede
     * dell'account di famiglie vere basandosi su una tabella che il resto
     * dell'anagrafica non considera, e il controllo dell'ambiguità (due figli,
     * due plessi) andrebbe rifatto sull'unione, altrimenti si scriverebbe una
     * sede scegliendola fra due. Finché quella decisione non è presa, qui si
     * RINUNCIA dicendolo: `warn`, contato fra i saltati, con un esito proprio.
     */
    if (motivo === 'ambigua' && sediFigli.length === 0) {
      // `warn` e non `info`: è una condizione da GUARDARE (un account genitore
      // che nessuna anagrafica collega a un bambino), non una condizione
      // normale come l'ambiguità vera qui sotto.
      logEvento('multi_sede', 'warn', {
        operazione: OPERAZIONE, esito: 'sede-genitore-senza-figli-anagrafica',
        utente: accountId, stato: motivo, n: sediFigli.length,
      })
      riepilogo.saltati += 1
      continue
    }

    if (motivo === 'ambigua') {
      // Non è un guasto: è la condizione che il prodotto deve permettere, e da
      // qui in giù `sediFigli.length >= 2` — l'ambiguità VERA, quella in cui una
      // sede giusta non esiste.
      logEvento('multi_sede', 'info', {
        operazione: OPERAZIONE, esito: 'sede-genitore-ambigua-non-toccata',
        utente: accountId, stato: 'ambigua', n: sediFigli.length,
      })
      riepilogo.ambigui += 1
      continue
    }

    if (motivo !== 'figli' || !scuolaId) {
      // «Non ho potuto leggere» non è «non ha figli»: la seconda porterebbe a
      // scrivere una sede scelta da qualcun altro. Si scrive solo su `figli`.
      logEvento('multi_sede', 'warn', {
        operazione: OPERAZIONE, esito: 'sede-genitore-non-riallineata',
        utente: accountId, stato: motivo,
      })
      riepilogo.saltati += 1
      continue
    }

    const attuale = sedeAttuale.get(accountId) ?? null
    // `uuid` è un TIPO in Postgres: 'BBBB…' e 'bbbb…' sono lo stesso valore. Un
    // confronto fra stringhe riscriverebbe la riga a ogni giro e dichiarerebbe
    // un successo che non è successo niente.
    if (attuale && formaConfronto(attuale) === formaConfronto(scuolaId)) {
      riepilogo.invariati += 1
      continue
    }

    // Si scrive SOLO `scuola_id`: `utenti.role` è una colonna generata da
    // `ruolo` e non va mai toccata.
    const { error: errUpdate } = await admin
      .from('utenti')
      .update({ scuola_id: scuolaId })
      .eq('id', accountId)
    if (errUpdate) {
      logEvento('multi_sede', 'error', {
        operazione: OPERAZIONE, esito: 'sede-genitore-non-scritta',
        utente: accountId, sede: scuolaId,
      }, errUpdate)
      riepilogo.saltati += 1
      continue
    }

    logEvento('multi_sede', 'info', {
      operazione: OPERAZIONE, esito: 'sede-genitore-riallineata',
      utente: accountId, sede: scuolaId,
    })
    riepilogo.aggiornati += 1
  }

  return riepiloga(account.length, riepilogo)
}
