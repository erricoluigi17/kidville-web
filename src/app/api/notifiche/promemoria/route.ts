import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { parseQuery } from '@/lib/validation/http'
import { getModuleConfig } from '@/lib/settings/module-config'
import { notificaEvento } from '@/lib/notifiche/triggers'
import { genitoriDiAlunni, genitoriDiClassi, genitoriDiScuola, staffScuola } from '@/lib/notifiche/destinatari'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'

// =============================================================================
// POST /api/notifiche/promemoria — giro promemoria GIORNALIERO.
// SERVICE-TO-SERVICE: header `x-cron-secret` (pattern /api/push/dispatch).
// Lo invoca pg_cron via notifiche_promemoria_tick() (migr 20260712180000).
//
// Tre scansioni, ognuna best-effort e gated dal proprio toggle notifiche:
//  1. moduli non compilati (avvisi con form_model_id, dopo N giorni —
//     admin_settings.modulistica_config.promemoria_giorni, default 3)
//  2. richieste armadietto pending mai ricordate (locker_requests,
//     reminder_inviato_il NULL — sostituisce la edge fn locker-reminder simulata)
//  3. documenti alunno in scadenza ≤30gg → segreteria (sostituisce la edge fn
//     document-expiry-alert, storicamente rotta: colonne inesistenti)
// Ogni tabella può mancare su ambienti non migrati (DB E2E CI) → skip.
// =============================================================================

const MS_GIORNO = 86_400_000

// Battito cardiaco del cron: pg_net chiama in fire-and-forget con `EXCEPTION WHEN OTHERS
// THEN null`, quindi un job che non parte non lascia traccia da nessuna parte — si
// sorveglia l'ASSENZA. `operazione` e non `job` (lista bianca di `redact`), e il nome nel
// `msg` perché `app_log` deduplica per (fingerprint, giorno) e il `contesto` NON è
// nell'impronta: senza il nome nel messaggio i cinque cron collasserebbero in una riga
// sola. La spiegazione per esteso è in `src/app/api/push/dispatch/route.ts`.
const JOB = 'notifiche-promemoria'

// Nessun parametro in ingresso (il body eventuale del cron non viene letto) —
// schema vuoto per il lock zod-coverage, come /api/push/dispatch.
const postQuerySchema = z.object({})

function tabellaMancante(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false
  return error.code === '42P01' || /does not exist|schema cache|could not find/i.test(error.message ?? '')
}

/**
 * PostgREST NON LANCIA: ritorna `{ error }` (regola 7 di AGENTS.md). Le tre scansioni di questo
 * file sono però GIÀ avvolte ognuna nel proprio try/catch che logga — quindi la via più corta
 * perché l'errore di una query finisca in quel log è TRASFORMARLO in un throw.
 *
 * La `cause` non è decorativa: `descriviErrore` la segue di un livello, ed è da lì che la riga
 * prende `code`, `details` e `hint` di PostgREST. Il corpo dell'errore di chi risponde non si
 * butta MAI via (regola 3): `PGRST301` non dice nulla, `PGRST301 "JWT expired"` dice tutto.
 *
 * Non si applica `tabellaMancante` qui: queste sono letture SECONDARIE, su tabelle che la
 * scansione ha appena letto (`locker_requests`) o su tabelle core (`notifiche`, `alunni`) — e
 * `form_submissions` esiste per costruzione, perché ci si arriva solo da un avviso che ha un
 * `form_model_id`. Su queste, «tabella assente» non è mai «ambiente non migrato»: è un guasto.
 */
function seFallita(error: { code?: string; message?: string } | null, azione: string): void {
  if (!error) return
  throw new Error(`${JOB}: ${azione} fallita`, { cause: error })
}

export const POST = withRoute('notifiche/promemoria:POST', async (request: Request) => {
  const t0 = Date.now()
  try {
    const secret = request.headers.get('x-cron-secret')
    if (!secret || secret !== process.env.CRON_SECRET) {
      // Si grida SOLO se l'header c'è ma non torna: quello è un cron che bussa con la chiave
      // sbagliata, ed è il guasto invisibile (chiave sbagliata e job non schedulato, da fuori, si
      // assomigliano: entrambi non mandano promemoria a nessuno). Sul POST ANONIMO si tace: la
      // route è pubblica e senza rate-limit, e una riga `error` per ogni `curl` fabbricherebbe dal
      // nulla proprio il segnale «il cron è rotto» che questa riga serve a portare.
      // Il messaggio separa i due incidenti veri (il secret nel Vault del DB; `CRON_SECRET` nelle
      // env var di Vercel — quest'ultimo già gridato dal preflight di `src/instrumentation.ts`).
      if (secret) {
        logEvento('cron', 'error', {
          operazione: JOB,
          esito: 'secret-errato',
          msg: process.env.CRON_SECRET
            ? `${JOB}: x-cron-secret non corrispondente`
            : `${JOB}: CRON_SECRET non configurato in questo ambiente`,
        })
      }
      return NextResponse.json({ error: 'Non autorizzato' }, { status: 401 })
    }
    logEvento('cron', 'info', { operazione: JOB, esito: 'avviato', msg: `${JOB}: avviato` })

    const q = parseQuery(request, postQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const oggi = new Date().toISOString().slice(0, 10)
    const esiti = { moduli: 0, armadietto: 0, documenti: 0 }
    // Quali delle tre scansioni sono cadute. Le scansioni restano BEST-EFFORT — una che salta non
    // deve impedire alle altre due di girare, ed è il motivo per cui ognuna ha il suo try/catch —
    // ma il battito di CHIUSURA non è best-effort: è la dichiarazione che il giro ha fatto il suo
    // lavoro. Con `esiti` a zero perché una scansione è morta, un «ok» direbbe «non c'era niente da
    // ricordare» invece di «non ho guardato»: le due frasi si leggono uguali e significano
    // l'opposto. Vedi il battito in fondo.
    const falliti: string[] = []

    // ── 1. Moduli non compilati ────────────────────────────────────────────────
    try {
      const { data: avvisi, error } = await supabase
        .from('avvisi')
        .select('id, titolo, target_scope, target_classes, scadenza, created_at, scuola_id, form_model_id')
        .not('form_model_id', 'is', null)
        .or(`scadenza.is.null,scadenza.gte.${oggi}`)
      if (error && !tabellaMancante(error)) throw error

      const cfgGiorni = new Map<string, number>()
      for (const avviso of (avvisi ?? []) as Array<{
        id: string; titolo: string; target_scope: string | null; target_classes: string[] | null
        created_at: string; scuola_id: string | null; form_model_id: string
      }>) {
        const scuolaId = avviso.scuola_id
        if (!cfgGiorni.has(scuolaId ?? '')) {
          const cfg = await getModuleConfig<{ promemoria_giorni?: number }>(supabase, 'modulistica_config', scuolaId)
          cfgGiorni.set(scuolaId ?? '', Number(cfg?.promemoria_giorni ?? 3))
        }
        const giorni = cfgGiorni.get(scuolaId ?? '') ?? 3
        if (giorni <= 0) continue // 0 = promemoria disattivati per la scuola
        if (Date.now() - Date.parse(avviso.created_at) < giorni * MS_GIORNO) continue

        // Destinatari target dell'avviso (stessa risoluzione della pubblicazione).
        const classi = (avviso.target_classes ?? []).filter(Boolean)
        const globale = (avviso.target_scope ?? 'globale') === 'globale' || classi.length === 0
        const target = globale
          ? await genitoriDiScuola(supabase, scuolaId)
          : await genitoriDiClassi(supabase, scuolaId, classi)
        if (target.length === 0) continue

        // Escludi chi ha già compilato il modulo…
        const { data: fatte, error: errFatte } = await supabase
          .from('form_submissions')
          .select('user_id')
          .eq('model_id', avviso.form_model_id)
        // Se questa lettura fallisce e si tira dritto, `compilatori` è vuoto e il promemoria
        // arriva anche a chi il modulo l'ha GIÀ compilato: non un dato mancante, un dato falso
        // spedito a tutti i genitori della scuola.
        seFallita(errFatte, 'lettura form_submissions')
        const compilatori = new Set((fatte ?? []).map((s) => s.user_id as string).filter(Boolean))
        // …e chi ha già ricevuto un promemoria negli ultimi N giorni (dedup su
        // `notifiche` stessa: nessuna colonna nuova).
        const cutoff = new Date(Date.now() - giorni * MS_GIORNO).toISOString()
        const { data: recenti, error: errRecenti } = await supabase
          .from('notifiche')
          .select('utente_id')
          .eq('tipo', 'modulo_promemoria')
          .eq('entita_id', avviso.id)
          .gte('creato_il', cutoff)
        // Questa query È la deduplica. Fallita in silenzio, `giaRicordati` resta vuoto e lo stesso
        // promemoria riparte ogni notte, per sempre: il modo più rapido di insegnare ai genitori a
        // ignorare le notifiche della scuola.
        seFallita(errRecenti, 'lettura notifiche già inviate')
        const giaRicordati = new Set((recenti ?? []).map((n) => n.utente_id as string))

        const destinatari = target.filter((uid) => !compilatori.has(uid) && !giaRicordati.has(uid))
        if (destinatari.length === 0) continue

        await notificaEvento(supabase, {
          tipo: 'modulo_promemoria',
          scuolaId,
          utenteIds: destinatari,
          titolo: `Promemoria: modulo da compilare`,
          corpo: `Il modulo «${avviso.titolo}» risulta ancora da compilare.`,
          link: '/parent/modulistica',
          entitaTipo: 'avviso',
          entitaId: avviso.id,
          bufferMin: 0,
        })
        esiti.moduli += destinatari.length
      }
    } catch (e) {
      // Una scansione che salta è il guasto peggiore di questo giro: senza questa riga la route
      // risponderebbe `success` con il contatore a zero, e «zero promemoria inviati» è
      // indistinguibile da «non c'era niente da ricordare». `azione` è nella lista bianca
      // di `redact`: dice QUALE delle tre scansioni è caduta anche nella riga persistita.
      logEvento('cron', 'error', { operazione: JOB, esito: 'scansione-fallita', azione: 'moduli' }, e)
      falliti.push('moduli')
    }

    // ── 2. Richieste armadietto pending ───────────────────────────────────────
    try {
      const { data: richieste, error } = await supabase
        .from('locker_requests')
        .select('id, alunno_id, quantita_residua, locker_catalog (nome, unita)')
        .eq('stato', 'pending')
        .is('reminder_inviato_il', null)
      if (error) {
        if (!tabellaMancante(error)) throw error
      } else {
        for (const r of (richieste ?? []) as Array<{
          id: string; alunno_id: string; quantita_residua: number | null
          locker_catalog: { nome?: string | null; unita?: string | null } | { nome?: string | null; unita?: string | null }[] | null
        }>) {
          const cat = Array.isArray(r.locker_catalog) ? r.locker_catalog[0] : r.locker_catalog
          const { data: alunno, error: errAlunno } = await supabase
            .from('alunni')
            .select('nome, scuola_id')
            .eq('id', r.alunno_id)
            .maybeSingle()
          // Fallita in silenzio, `alunno` è `null`: la notifica partirebbe lo stesso, ma senza
          // `scuola_id` (quindi fuori dal gating per sede) e con il nome del bambino sostituito
          // dal fallback «tuo figlio» — una notifica che sembra funzionante e non lo è.
          seFallita(errAlunno, 'lettura alunni (armadietto)')
          const genitori = await genitoriDiAlunni(supabase, [r.alunno_id])
          if (genitori.length > 0) {
            await notificaEvento(supabase, {
              tipo: 'locker_richiesta',
              scuolaId: (alunno?.scuola_id as string | undefined) ?? null,
              utenteIds: genitori,
              titolo: 'Materiale da portare a scuola',
              corpo: `${cat?.nome ?? 'Materiale'} in esaurimento per ${alunno?.nome ?? 'tuo figlio'}${r.quantita_residua != null ? ` (${r.quantita_residua} ${cat?.unita ?? 'pz'} rimasti)` : ''}.`,
              link: '/parent/locker',
              entitaTipo: 'locker_request',
              entitaId: r.id,
              bufferMin: 0,
            })
            esiti.armadietto += 1
          }
          const { error: errMarca } = await supabase
            .from('locker_requests')
            .update({ reminder_inviato_il: new Date().toISOString() })
            .eq('id', r.id)
          // Anche una UPDATE ritorna `{ error }` senza lanciare. Questa marcatura È la garanzia di
          // «un promemoria e uno solo»: se salta in silenzio, la stessa richiesta viene ricordata
          // ogni notte, all'infinito.
          seFallita(errMarca, 'marcatura locker_requests')
        }
      }
    } catch (e) {
      logEvento('cron', 'error', { operazione: JOB, esito: 'scansione-fallita', azione: 'armadietto' }, e)
      falliti.push('armadietto')
    }

    // ── 3. Documenti in scadenza (≤30 giorni) → segreteria ────────────────────
    try {
      const soglia = new Date(Date.now() + 30 * MS_GIORNO).toISOString().slice(0, 10)
      const { data: docs, error } = await supabase
        .from('student_documents')
        .select('id, student_id, document_type, expiry_date')
        .lte('expiry_date', soglia)
      if (error) {
        if (!tabellaMancante(error)) throw error
      } else {
        for (const doc of (docs ?? []) as Array<{ id: string; student_id: string; document_type: string | null; expiry_date: string | null }>) {
          // Dedup: un solo avviso per documento (qualsiasi data).
          const { data: gia, error: errGia } = await supabase
            .from('notifiche')
            .select('id')
            .eq('tipo', 'documenti_scadenza')
            .eq('entita_id', doc.id)
            .limit(1)
          // Questa query È la deduplica: fallita in silenzio, `gia` è `null` → il `continue` non
          // scatta → la segreteria riceve lo stesso avviso di scadenza ogni notte fino a che il
          // documento non viene rinnovato.
          seFallita(errGia, 'lettura notifiche (dedup documenti)')
          if (gia && gia.length > 0) continue

          const { data: alunno, error: errAlunnoDoc } = await supabase
            .from('alunni')
            .select('nome, cognome, scuola_id')
            .eq('id', doc.student_id)
            .maybeSingle()
          // Fallita in silenzio, `scuolaId` sarebbe `null` → `staffScuola(null)` non troverebbe
          // destinatari → `continue`: il documento in scadenza NON viene segnalato a nessuno, e il
          // giro chiude «ok». Un certificato medico scaduto che nessuno reclama è esattamente il
          // genere di guasto che questo cron esiste per impedire.
          seFallita(errAlunnoDoc, 'lettura alunni (documenti)')
          const scuolaId = (alunno?.scuola_id as string | undefined) ?? null
          const destinatari = await staffScuola(supabase, scuolaId, ['admin', 'coordinator', 'segreteria'])
          if (destinatari.length === 0) continue

          await notificaEvento(supabase, {
            tipo: 'documenti_scadenza',
            scuolaId,
            utenteIds: destinatari,
            titolo: `Documento in scadenza: ${(doc.document_type ?? 'documento').toUpperCase()}`,
            corpo: `Il documento di ${[alunno?.nome, alunno?.cognome].filter(Boolean).join(' ') || 'un alunno'} scade il ${doc.expiry_date ?? '—'}.`,
            link: '/admin/students',
            entitaTipo: 'documento',
            entitaId: doc.id,
            bufferMin: 0,
          })
          esiti.documenti += 1
        }
      }
    } catch (e) {
      logEvento('cron', 'error', { operazione: JOB, esito: 'scansione-fallita', azione: 'documenti' }, e)
      falliti.push('documenti')
    }

    // IL BATTITO NON PUÒ MENTIRE. Se anche una sola scansione è caduta, il giro NON è «ok»: i suoi
    // contatori a zero non dicono «non c'era niente da ricordare», dicono «non ho guardato» — e
    // chi sorveglia i cron cerca proprio l'`esito: 'ok'` per sapere che la notte è andata bene.
    // Emetterlo qui sarebbe peggio che non emettere nulla: senza battito il guasto è latente, con
    // un battito che mente è ATTIVAMENTE coperto.
    // Le scansioni restano best-effort (le altre due girano lo stesso, e i loro promemoria
    // partono davvero: i contatori qui sotto sono veri e vanno riportati); a non essere
    // best-effort è la dichiarazione finale.
    if (falliti.length > 0) {
      logEvento('cron', 'error', {
        operazione: JOB,
        esito: 'giro-incompleto',
        // `azione` è nella lista bianca di `redact`: anche in tabella si legge QUALI scansioni
        // sono cadute. Il dettaglio di ciascuna (codice PostgREST, messaggio) è nella riga
        // `scansione-fallita` che il rispettivo `catch` ha già emesso.
        azione: falliti.join('+'),
        ms: Date.now() - t0,
        moduli: esiti.moduli,
        armadietto: esiti.armadietto,
        documenti: esiti.documenti,
        msg: `${JOB}: giro incompleto (${falliti.join(', ')})`,
      })
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }

    // I tre contatori sono NUMERI: passano in chiaro anche in tabella. Un giro che parte
    // ogni notte e ricorda sempre zero moduli non è «tranquillo», è sospetto — e senza
    // questi tre numeri nella riga non ci sarebbe modo di distinguere i due casi.
    logEvento('cron', 'info', {
      operazione: JOB,
      esito: 'ok',
      ms: Date.now() - t0,
      moduli: esiti.moduli,
      armadietto: esiti.armadietto,
      documenti: esiti.documenti,
      msg: `${JOB}: ok`,
    })
    return NextResponse.json({ success: true, data: esiti })
  } catch (err) {
    // IL GIRO CHE MUORE PRIMA DI COMINCIARE, ed era l'unico dei cinque cron a non avere questa
    // rete. Le tre scansioni hanno ognuna il proprio try, ma il PREAMBOLO no: `parseQuery` (che
    // apre con un `new URL`) e soprattutto `await createAdminClient()` stanno fuori da tutti e
    // tre. `createAdminClient` costruisce il client con `SUPABASE_SERVICE_ROLE_KEY!` — quel `!`
    // è una promessa al type-checker, non al runtime: con la chiave assente o ruotata male
    // (rotazione a metà, env var non propagata a un ambiente) `createServerClient` lancia, e da
    // lì non gira più NIENTE. Nemmeno una delle tre scansioni.
    //
    // Senza questo catch l'eccezione risaliva a Next, che risponde 500 e la registra via
    // `onRequestError` — cioè con `evento: 'unhandled'`. Sembra un dettaglio di etichetta, ed è
    // invece il buco peggiore che questa route potesse avere: chi sorveglia i cron interroga
    // `where evento = 'cron'`, perché è lì che vivono i battiti («avviato», «ok»,
    // «giro-incompleto»). Il fallimento TOTALE del job — l'unico che li fa sparire tutti insieme
    // — sarebbe stato l'unico a finire in un flusso diverso: cioè l'unico che quella query NON
    // trova. Il giro dei promemoria poteva morire ogni notte lasciando come sola traccia un
    // 'avviato' senza 'ok' — un segnale che c'è, ma che si legge solo per ASSENZA, e solo da chi
    // già sospetta. Un guasto totale non può essere il più difficile da vedere.
    //
    // `evento: 'cron'` lo rimette nello stesso flusso di tutti gli altri battiti. `logErrore`
    // emette anche l'Error NATIVO con lo stack vero — che dice in quale riga si è rotto, cosa
    // che una riga logfmt da sola non porterebbe.
    logErrore({ operazione: JOB, evento: 'cron', ms: Date.now() - t0, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
