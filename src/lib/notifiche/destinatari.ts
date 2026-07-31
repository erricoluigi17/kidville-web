import type { SupabaseClient } from '@supabase/supabase-js'
import { getGenitoriDiAlunni } from '@/lib/anagrafiche/legami'
import { isScuolaE2E } from '@/lib/scuole/reali'
import { logEvento } from '@/lib/logging/logger'

/** Codici PostgREST/Postgres di «schema non ancora migrato» (DB E2E della CI). */
const SCHEMA_ASSENTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])

// =============================================================================
// Risoluzione destinatari per le notifiche (id utenti). Tutte le funzioni sono
// best-effort: su errore tornano [] (la notifica semplicemente non parte).
// Fonte genitori: l'UNIONE runtime `legame_genitori_alunni` + anagrafica
// `student_parents` (via ponte `parents.auth_user_id`), risolta da
// `@/lib/anagrafiche/legami` — mai utenti.scuola_id, non affidabile per i
// genitori. Fonte docenti: utenti_sezioni.
// =============================================================================

/**
 * Genitori (account `utenti.id`) collegati agli alunni dati, distinti.
 *
 * È la funzione da cui passano quasi tutte le notifiche ai genitori (avvisi,
 * galleria, news, promemoria, triggers). Leggeva SOLO `legame_genitori_alunni`:
 * per un bambino il cui legame vive solo in anagrafica il risultato era una
 * lista vuota — cioè la notifica non partiva, e «zero destinatari» non si
 * distingue da «nessun tutore a sistema». Una query in più (3 fisse, mai N+1)
 * in cambio di avvisi che arrivano davvero.
 */
export async function genitoriDiAlunni(supabase: SupabaseClient, alunnoIds: string[]): Promise<string[]> {
  if (!alunnoIds || alunnoIds.length === 0) return []
  try {
    const mappa = await getGenitoriDiAlunni(supabase, alunnoIds)
    const out = new Set<string>()
    for (const account of mappa.values()) for (const id of account) out.add(id)
    return [...out]
  } catch (e) {
    // Gli errori PostgREST li segnala già `getGenitoriDiAlunni` (che NON lancia);
    // qui arriva solo un guasto vero (rete, DNS). Degradare a "nessun
    // destinatario" IN SILENZIO renderebbe invisibile una notifica mai partita.
    logEvento('notifica', 'error', {
      operazione: 'notifiche/destinatari:genitoriDiAlunni',
      esito: 'destinatari-non-risolti',
      n: alunnoIds.length,
    }, e)
    return []
  }
}

/** Opzioni comuni ai risolutori per classe/scuola. */
export interface OpzioniDestinatari {
  /**
   * «Tutte le sedi», CHIESTO. Senza questo flag una sede assente vale «non so
   * dove sono»: si nega e si logga. Il caso globale legittimo (una news per tutti
   * i plessi) deve poterlo DIRE — e oggi lo dice espandendo su `sediReali`, sede
   * per sede, non lasciando cadere il filtro.
   */
  tutteLeSedi?: boolean
  /** Nome del chiamante, per ritrovare la riga in `app_log`. */
  operazione?: string
}

/**
 * Genitori degli alunni iscritti delle classi date (alunni.classe_sezione).
 *
 * SCOPE VUOTO ⇒ NEGA. Fino al 2026-07-31 qui c'era `if (scuolaId) q = q.eq(…)`:
 * la forma «se ho lo scope filtro, altrimenti no». Con una sola sede era
 * innocua; con tre, il nome della classe non è più una chiave — «2 ANNI» esiste
 * a Giugliano, ad Aversa e a Cesa — e una sede mancante significava notificare
 * i genitori di TUTTI i plessi. La gemella `genitoriDiScuola` negava già: due
 * significati opposti dello stesso `null` nello stesso file.
 */
export async function genitoriDiClassi(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined,
  classi: string[],
  opzioni: OpzioniDestinatari = {},
): Promise<string[]> {
  if (!classi || classi.length === 0) return []
  if (!scuolaId && !opzioni.tutteLeSedi) {
    logEvento('notifica', 'warn', {
      operazione: opzioni.operazione ?? 'notifiche/destinatari:genitoriDiClassi',
      esito: 'sede-non-risolta',
      n: classi.length,
    })
    return []
  }
  try {
    let q = supabase.from('alunni').select('id').in('classe_sezione', classi)
    if (scuolaId) q = q.eq('scuola_id', scuolaId)
    const { data, error } = await q
    // PostgREST NON lancia: ritorna `{ error }`. Senza questo controllo una query
    // rotta si travestiva da «nessun destinatario» e la notifica non partiva.
    if (error) {
      logEvento('notifica', 'error', {
        operazione: opzioni.operazione ?? 'notifiche/destinatari:genitoriDiClassi',
        esito: 'alunni-non-letti',
        sede_id: scuolaId ?? null,
      }, error)
      return []
    }
    return genitoriDiAlunni(supabase, (data ?? []).map((a) => a.id as string))
  } catch (e) {
    logEvento('notifica', 'error', {
      operazione: opzioni.operazione ?? 'notifiche/destinatari:genitoriDiClassi',
      esito: 'alunni-non-letti',
      sede_id: scuolaId ?? null,
    }, e)
    return []
  }
}

/** Genitori di tutti gli alunni della scuola (avvisi a scope globale). */
export async function genitoriDiScuola(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined,
  opzioni: OpzioniDestinatari = {},
): Promise<string[]> {
  const operazione = opzioni.operazione ?? 'notifiche/destinatari:genitoriDiScuola'
  if (!scuolaId) {
    // Negava già, ma in silenzio: ed è il ramo su cui finiva una news «tutte le
    // sedi», che veniva poi marcata «inviata» con zero destinatari.
    logEvento('notifica', 'warn', { operazione, esito: 'sede-non-risolta' })
    return []
  }
  try {
    const { data, error } = await supabase.from('alunni').select('id').eq('scuola_id', scuolaId)
    if (error) {
      logEvento('notifica', 'error', { operazione, esito: 'alunni-non-letti', sede_id: scuolaId }, error)
      return []
    }
    return genitoriDiAlunni(supabase, (data ?? []).map((a) => a.id as string))
  } catch (e) {
    logEvento('notifica', 'error', { operazione, esito: 'alunni-non-letti', sede_id: scuolaId }, e)
    return []
  }
}

/**
 * Staff della scuola con uno dei ruoli dati (schema legacy doppio: il ruolo può
 * stare su `role` O `ruolo` — stesso pattern di panic-alert e mensa).
 *
 * Multi-sede: NON basta `utenti.scuola_id`. La Direzione è multi-plesso attraverso
 * la tabella ponte `utenti_scuole` (è la stessa definizione che usa `scuoleDiUtente`
 * per decidere su quali plessi un utente può operare). Guardando la sola colonna,
 * una sede appena aperta — dove nessuno ha ancora quella sede come primaria —
 * risultava SENZA staff: le iscrizioni arrivavano e non le annunciava nessuno,
 * perché `notificaEvento` con zero destinatari esce in silenzio.
 *
 * SEDE NULL ⇒ SI LOGGA, POI SI NEGA. Il `return []` stava PRIMA di tutta la
 * strumentazione della funzione, e sette catene `X ?? Y ?? scuolaUnicaReale()`
 * finivano esattamente lì: nei log «non so a quale sede appartiene» e «avvisati
 * tutti» si leggevano identici. È `error` e non `warn` perché una notifica che
 * non sa dove andare è un guasto di configurazione, non una normalità.
 */
export async function staffScuola(
  supabase: SupabaseClient,
  scuolaId: string | null | undefined,
  ruoli: string[],
): Promise<string[]> {
  if (!scuolaId) {
    logEvento('notifica', 'error', {
      operazione: 'staffScuola', esito: 'sede-non-risolta', ruoli: ruoli.join(','),
    })
    return []
  }
  if (ruoli.length === 0) {
    // Nessun ruolo richiesto: non è un dato mancante, è una chiamata sbagliata.
    logEvento('notifica', 'warn', {
      operazione: 'staffScuola', esito: 'ruoli-non-indicati', sede_id: scuolaId,
    })
    return []
  }
  try {
    const ammessi = new Set(ruoli)
    const ids = new Set<string>()

    const { data: primari, error: errPrimari } = await supabase
      .from('utenti').select('id, role, ruolo').eq('scuola_id', scuolaId)
    if (errPrimari) {
      logEvento('notifica', 'error', {
        operazione: 'staffScuola', esito: 'utenti-non-letti', sede_id: scuolaId,
      }, errPrimari)
    }
    for (const u of primari ?? []) {
      if (ammessi.has((u.role as string) ?? '') || ammessi.has((u.ruolo as string) ?? '')) {
        ids.add(u.id as string)
      }
    }

    // Ponte multi-plesso. Se la tabella non esiste (DB E2E non migrato) si degrada
    // ai soli primari: `42P01`/`42703` non sono un incidente, l'assenza di risposta sì.
    const { data: ponte, error: errPonte } = await supabase
      .from('utenti_scuole').select('utente_id').eq('scuola_id', scuolaId)
    if (errPonte) {
      const codice = (errPonte as { code?: string }).code ?? ''
      logEvento('notifica', SCHEMA_ASSENTE.has(codice) ? 'info' : 'error', {
        operazione: 'staffScuola', esito: 'ponte-non-letto', sede_id: scuolaId,
      }, errPonte)
    }
    const daPonte = (ponte ?? []).map((r) => r.utente_id as string).filter(Boolean)
    if (daPonte.length > 0) {
      const { data: utentiPonte, error: errUtentiPonte } = await supabase
        .from('utenti').select('id, role, ruolo').in('id', daPonte)
      if (errUtentiPonte) {
        logEvento('notifica', 'error', {
          operazione: 'staffScuola', esito: 'utenti-ponte-non-letti', sede_id: scuolaId,
        }, errUtentiPonte)
      }
      for (const u of utentiPonte ?? []) {
        if (ammessi.has((u.role as string) ?? '') || ammessi.has((u.ruolo as string) ?? '')) {
          ids.add(u.id as string)
        }
      }
    }

    // Zero destinatari non è un errore in sé (può esserlo il ruolo richiesto), ma
    // `notificaEvento` esce in silenzio: senza questa riga «nessuno è stato avvisato»
    // e «tutto a posto» sono indistinguibili nei log. Solo uuid, ruoli e conteggi.
    if (ids.size === 0) {
      logEvento('notifica', 'warn', {
        operazione: 'staffScuola', esito: 'nessun-destinatario',
        sede_id: scuolaId, ruoli: ruoli.join(','),
      })
    }
    return [...ids]
  } catch (e) {
    // Un catch muto qui significa notifiche che non partono senza che nessuno lo sappia.
    logEvento('notifica', 'error', {
      operazione: 'staffScuola', esito: 'eccezione', sede_id: scuolaId,
    }, e)
    return []
  }
}

/**
 * Id dell'unica scuola reale del deployment. Null se ambiguo — fallback per i
 * flussi pubblici/anonimi dove la scuola non è deducibile dal contesto.
 *
 * Il predicato "sede di TEST" NON è più scritto qui: è `isScuolaE2E` in
 * `@/lib/scuole/reali`, lo stesso che usano `POST /api/iscrizione` e
 * `GET /api/iscrizione/sedi`. Duplicarlo significava poter cambiare l'euristica
 * in un posto solo e ritrovarsi le segnalazioni o le richieste di cancellazione
 * attribuite a una sede diversa da quella su cui si iscrivono i bambini.
 *
 * NB: qui NON si applica il filtro `scuole.attiva` di `sediReali`: questa
 * funzione risponde a «qual è l'unica sede di questo deployment», e una sede
 * disattivata di recente resta il posto giusto dove instradare una notifica
 * che riguarda i suoi dati.
 *
 * @deprecated DAL 2026-07-29 IL DEPLOYMENT HA TRE SEDI: questa funzione
 * restituisce sempre `null`, e la sua precondizione non tornerà. Era l'ultimo
 * anello di sette catene `X ?? Y ?? scuolaUnicaReale(…)` usate come rete di
 * sicurezza senza mai verificarne l'esito. Ogni chiamante deve ricavare la sede
 * dal DATO che ce l'ha (il modello di modulo, i figli del genitore, la sede
 * dell'entità), non da «quante sedi esistono». Finché resta un chiamante, il
 * ritorno `null` lascia una riga: l'anello morto non è più invisibile.
 */
export async function scuolaUnicaReale(supabase: SupabaseClient): Promise<string | null> {
  try {
    const { data, error } = await supabase.from('schools').select('id, nome')
    if (error) {
      logEvento('multi_sede', 'error', {
        operazione: 'notifiche/destinatari:scuolaUnicaReale',
        esito: 'schools-non-leggibile',
      }, error)
      return null
    }
    const tutte = (data ?? []) as { id: string; nome: string }[]
    const reali = tutte.filter((s) => !isScuolaE2E(s))
    if (reali.length === 1) return reali[0].id
    if (tutte.length === 1) return tutte[0].id
    logEvento('multi_sede', 'warn', {
      operazione: 'notifiche/destinatari:scuolaUnicaReale',
      esito: 'sede-non-univoca',
      n: reali.length,
    })
    return null
  } catch (e) {
    logEvento('multi_sede', 'error', {
      operazione: 'notifiche/destinatari:scuolaUnicaReale',
      esito: 'schools-non-leggibile',
    }, e)
    return null
  }
}

/** L'altro partecipante di un thread chat (genitore ↔ docente). */
export async function controparteThread(
  supabase: SupabaseClient,
  threadId: string,
  senderId: string,
): Promise<{ utenteId: string; versoGenitore: boolean } | null> {
  try {
    const { data } = await supabase
      .from('chat_threads')
      .select('teacher_id, parent_id')
      .eq('id', threadId)
      .maybeSingle()
    if (!data) return null
    if (senderId === data.teacher_id && data.parent_id) return { utenteId: data.parent_id as string, versoGenitore: true }
    if (senderId === data.parent_id && data.teacher_id) return { utenteId: data.teacher_id as string, versoGenitore: false }
    return null
  } catch {
    return null
  }
}
