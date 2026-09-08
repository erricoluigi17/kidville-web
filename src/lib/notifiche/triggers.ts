import type { SupabaseClient } from '@supabase/supabase-js'
import { enqueueNotifiche } from '@/lib/push/enqueue'
import { isNotificaAbilitata } from '@/lib/notifiche/config'
import { genitoriDiAlunni } from '@/lib/notifiche/destinatari'
import { logEvento } from '@/lib/logging/logger'
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi'

// =============================================================================
// Wrapper unico per i trigger di notifica: toggle per scuola → risoluzione
// destinatari → debounce opzionale → enqueue (buffer + push via dispatch).
// SEMPRE best-effort: non lancia mai verso la route chiamante.
//
// "NON LANCIA MAI" NON VUOL DIRE "NON SI VEDE". Il contratto vale — un avviso non
// spedito non deve trasformare in 500 un salvataggio riuscito, e le 28 route ci
// contano — ma è precisamente per questo che qui dentro il guasto DEVE lasciare
// una riga: è l'unico posto in cui esiste. Chi sta sopra non lo vedrà mai, per
// costruzione. Prima c'erano due console.error: nessuno li redigeva, nessuno li
// leggeva, e in `app_log` non arrivava niente.
// =============================================================================

export interface NotificaEventoParams {
  /** Tipo canonico (catalogo src/lib/notifiche/tipi.ts) — decide anche il toggle. */
  tipo: string
  /** Scuola per il gate del toggle (assente = fail-open, notifica attiva). */
  scuolaId?: string | null
  /** Destinatari espliciti (id utenti)… */
  utenteIds?: string[]
  /** …e/o alunni di cui notificare i genitori (le due liste si sommano). */
  alunnoIds?: string[]
  titolo: string
  corpo?: string | null
  link?: string | null
  entitaTipo?: string | null
  entitaId?: string | null
  /** Minuti di buffer prima dell'invio push. Default 10 (finestra di modifica). */
  bufferMin?: number
  /**
   * Debounce: elimina le notifiche pending (push non ancora inviata) con lo
   * stesso tipo+entita_id prima di ri-accodare — le raffiche collassano in una.
   */
  debounce?: boolean
}

export async function notificaEvento(supabase: SupabaseClient, params: NotificaEventoParams): Promise<void> {
  try {
    if (!(await isNotificaAbilitata(supabase, params.tipo, params.scuolaId ?? null))) return

    const destinatari = new Set<string>(params.utenteIds ?? [])
    if (params.alunnoIds?.length) {
      for (const id of await genitoriDiAlunni(supabase, params.alunnoIds)) destinatari.add(id)
    }
    if (destinatari.size === 0) {
      // «ZERO DESTINATARI» È UN FATTO, E VA DETTO. Questo `return` era nudo, ed è l'imbuto
      // da cui passano TUTTE le notifiche alle famiglie: i cinque canali staff dicevano già
      // la loro (`staffScuola` emette `nessun-destinatario`), qui si usciva in silenzio. Due
      // commenti nel repo lo ammettevano senza rimediarci — `destinatari.ts` («notificaEvento
      // con zero destinatari esce in silenzio») e `fattura/sync/route.ts` («enqueueNotifiche
      // esce muto sulla lista vuota»).
      //
      // La condizione è VIVA in produzione: il 2026-07-31, 2 alunni su 25 a Giugliano non
      // hanno nessuna riga in `student_parents`. Un avviso di classe su quella sezione
      // notifica meno famiglie di quante ce ne siano, risponde 201 e non lascia traccia.
      //
      // `warn` e non `error`: può essere legittimo (una sezione senza iscritti, un debounce
      // che ha già coperto tutti). Va CONTATO, non deve svegliare nessuno — ma `sede_id` e
      // `tipo` ci sono perché con tre plessi «nessuno da avvisare» ad Aversa e a Giugliano
      // sono due incidenti diversi. Sono uuid e chiavi in lista bianca: sopravvivono a
      // `redact()` anche nella riga persistita.
      logEvento('notifica', 'warn', {
        operazione: 'notificaEvento',
        esito: 'nessun-destinatario',
        tipo: params.tipo,
        sede_id: params.scuolaId ?? null,
        n_alunni: params.alunnoIds?.length ?? 0,
      })
      return
    }

    if (params.debounce && params.entitaId) {
      // Il `try` resta, ma NON è più lui a portare il log: PostgREST non lancia, la `delete`
      // ritorna `{ error }`, e un log appeso solo al catch qui era codice morto. Il try copre
      // il guasto di trasporto e — soprattutto — garantisce che un debounce fallito non salti
      // l'enqueue qui sotto: meglio una notifica doppia che nessuna notifica.
      try {
        // `.in('utente_id', …)` NON È UN'OTTIMIZZAZIONE: È LA CORREZIONE.
        //
        // Senza, la delete cancella le pending di TUTTI i destinatari che
        // condividono `entita_id`. Per quattordici chiamanti su quindici non si
        // vede, perché la loro entità è un avviso, un thread, un alunno, un
        // pagamento: i destinatari sono lo stesso insieme a ogni chiamata. La
        // galleria invece passa `entitaId: uploaded_by` — l'INSEGNANTE — e una
        // foto è una POST: ogni foto cancellava gli avvisi generati dalle
        // precedenti, per famiglie che non c'entravano niente. Sopravviveva solo
        // l'ultima foto della raffica.
        //
        // Misurato in produzione il 7-8 settembre 2026, prima della correzione:
        // 298 coppie (insegnante, giorno, genitore) attese, 130 arrivate,
        // 168 perse, 153 genitori distinti mai avvisati. E la riga era
        // CANCELLATA, non soppressa: la famiglia non la trovava nemmeno nella
        // campanella, perché `notifiche.letta_il` è ciò che l'accende e una riga
        // che non esiste non accende niente.
        //
        // L'intento del debounce resta intatto — la raffica collassa ancora in
        // una notifica sola — ma PER FAMIGLIA, che è l'unità che ha sempre avuto
        // senso.
        //
        // A BLOCCHI, e non per prudenza. PostgREST mette `.in()` in QUERY STRING:
        // a Giugliano i genitori distinti sono 345 (misurato il 2026-09-08) e un
        // avviso di plesso li passerebbe tutti insieme, costruendo una riga di
        // richiesta da ~13 kB. Il repo questo muro l'ha già preso una volta e ha
        // scritto il tetto in `@/lib/db/blocchi` (`ID_PER_QUERY`): senza, questa
        // correzione si romperebbe da sola sulla sede più grande, e in silenzio —
        // il ramo `warn` qui sotto lascia partire la notifica lo stesso.
        //
        // Nessuna migrazione: su `notifiche` non esiste un indice
        // (tipo, entita_id) e questa delete era già una scansione, mentre
        // `idx_notifiche_utente (utente_id, letta_il)` c'è.
        const destinatariDelDebounce = [...destinatari]
        let nCancellate = 0
        let error: unknown = null
        for (const blocco of aBlocchi(destinatariDelDebounce, ID_PER_QUERY)) {
          // `.select('id')` e non `count: 'exact'`: è l'idioma già in uso sulla
          // stessa tabella (`@/lib/gdpr/esegui`), e restituisce le righe tolte,
          // quindi il conteggio è un fatto e non un'intestazione da interpretare.
          // Va per ULTIMO: dopo `.select()` il builder non espone più `.eq()`.
          const res = await supabase
            .from('notifiche')
            .delete()
            .eq('tipo', params.tipo)
            .eq('entita_id', params.entitaId)
            .in('utente_id', blocco)
            .is('push_inviata_il', null)
            .select('id')
          if (res.error) { error = res.error; break }
          nCancellate += (res.data ?? []).length
        }

        // QUANTE NE HA CANCELLATE, e soprattutto SE NE HA CANCELLATE TROPPE.
        //
        // Il difetto qui sopra è vissuto due mesi perché questa delete non
        // contava niente: un debounce che cancella dieci volte le righe che
        // riaccoda è indistinguibile da uno che funziona, se nessuno guarda il
        // numero. Col filtro per destinatario `nCancellate` non può superare
        // `destinatariDelDebounce.length`: se lo supera, il filtro NON sta
        // filtrando — cioè il difetto è tornato.
        //
        // `warn` proprio per quel caso, e non `info` per tutti: il canale
        // `notifica` non è in `EVENTI_PERSISTITI`, quindi un `info` non
        // arriverebbe mai in `app_log`; e promuovere l'intero canale per una riga
        // di routine avrebbe portato con sé la trappola della deduplicazione, che
        // tiene il `contesto` della PRIMA occorrenza del giorno — cioè un
        // `n_cancellate` quasi sempre sbagliato, che è peggio di nessun numero.
        // Un guardiano che tace quando tutto va bene e parla quando il difetto
        // torna è persistito d'ufficio, e non costa una riga al giorno.
        if (!error && nCancellate > destinatariDelDebounce.length) {
          logEvento('notifica', 'warn', {
            operazione: 'notificaEvento',
            esito: 'debounce-troppo-largo',
            tipo: params.tipo,
            sede_id: params.scuolaId ?? null,
            n_cancellate: nCancellate,
            n_destinatari: destinatariDelDebounce.length,
          })
        }
        if (error) {
          // `warn`, non `error`: il debounce è una comodità (collassa le raffiche in una
          // notifica sola). Se salta, la notifica parte lo stesso — il destinatario ne riceve
          // una in più, non una in meno. Il risultato è salvo, il contorno è degradato.
          logEvento('notifica', 'warn', {
            operazione: 'notificaEvento',
            esito: 'debounce-fallito',
            tipo: params.tipo,
          }, error)
        }
      } catch (e) {
        logEvento('notifica', 'warn', {
          operazione: 'notificaEvento',
          esito: 'debounce-non-eseguito',
          tipo: params.tipo,
        }, e)
      }
    }

    await enqueueNotifiche(supabase, {
      utenteIds: [...destinatari],
      tipo: params.tipo,
      titolo: params.titolo,
      corpo: params.corpo ?? null,
      link: params.link ?? null,
      entitaTipo: params.entitaTipo ?? null,
      entitaId: params.entitaId ?? null,
      bufferMin: params.bufferMin ?? 10,
      // Il toggle è già stato verificato qui sopra (config in cache: il
      // doppio check dentro enqueueNotifiche costa zero query).
      scuolaId: params.scuolaId ?? null,
    })
  } catch (err) {
    // Qui è saltata la PREPARAZIONE della notifica (toggle, lookup dei destinatari, enqueue):
    // il messaggio non partirà, e la route chiamante — che non vede l'eccezione, per contratto —
    // risponderà 200 come se tutto fosse andato a posto. È un dato perso: livello `error`.
    // Non si rilancia (il contratto è quello, e le route ci contano): si LOGGA e si torna.
    logEvento('notifica', 'error', {
      operazione: 'notificaEvento',
      esito: 'notifica-non-accodata',
      tipo: params.tipo,
    }, err)
  }
}

/**
 * Nome visualizzabile di un utente ("Nome Cognome", fallback su schema legacy).
 *
 * Stessa malattia degli altri: `{ data }` scartava `error` e il `catch` taceva. La lettura può
 * fallire — e allora il titolo della notifica esce con il nome generico, che è un degrado
 * accettabile ma NON invisibile (regola 6: un catch che non logga è un bug).
 */
export async function nomeUtente(supabase: SupabaseClient, utenteId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('utenti')
      .select('nome, cognome, first_name, last_name')
      .eq('id', utenteId)
      .maybeSingle()
    if (error) {
      // `warn`: la notifica parte comunque, con il fallback testuale. Risultato salvo.
      logEvento('db', 'warn', {
        operazione: 'nomeUtente',
        esito: 'utente-non-letto',
      }, error)
      return null
    }
    if (!data) return null
    const nome = [data.first_name || data.nome, data.last_name || data.cognome].filter(Boolean).join(' ').trim()
    return nome || null
  } catch (e) {
    logEvento('db', 'warn', {
      operazione: 'nomeUtente',
      esito: 'utente-non-letto',
    }, e)
    return null
  }
}
