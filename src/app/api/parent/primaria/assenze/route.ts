import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireParentOfStudent } from '@/lib/auth/require-parent'
import { parseQuery } from '@/lib/validation/http'
import { zLimite } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import { limitaAiFatti } from '@/lib/presenze/finestra-trascorsa'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// studentId lasco (niente zUuid): un valore non-GUID oggi produce lista vuota
// dalla query su `presenze` — stesso criterio di parent/competenze.
// `limit`: default storico 60, ma VALIDATO — vedi `zLimite`. Fino al 2026-08-08 era
// `z.string().optional()` + `parseInt` senza clamp, e il valore arrivava tale e quale a
// PostgREST: `?limit=-1` rispondeva 200 con `letto:false` («non ho potuto leggere», detto
// per un errore del client) e lasciava DUE righe `error` in `app_log` per richiesta —
// cinque richieste bastavano a far dichiarare `degradato` /api/health. Non è zPaginazione:
// quella cambierebbe il default e imporrebbe un `offset` che questa rotta non ha.
const getQuerySchema = z.object({
  studentId: z.string({ error: 'studentId obbligatorio' }).min(1, 'studentId obbligatorio'),
  limit: zLimite({ predefinito: 60, max: 200 }),
})

// Stati contati nel riepilogo. `presente` INCLUSO di proposito: senza, un bambino
// presente resta indistinguibile da un appello non ancora fatto (falla del collaudo).
const STATI_RIEPILOGO = ['presente', 'assente', 'ritardo', 'uscita_anticipata'] as const
type StatoRiepilogo = (typeof STATI_RIEPILOGO)[number]

// GET /api/parent/primaria/assenze?studentId=&userId=&limit=30
// Restituisce:
//  - `data`: la cronologia dettagliata dei SOLI stati negativi (assenze, ritardi,
//    uscite anticipate) — quelli su cui il genitore può agire (giustifica);
//  - `riepilogo`: i conteggi per stato (incluso `presente`) calcolati con COUNT
//    aggregato lato DB, SENZA scaricare i ~180 giorni di presenza dell'anno.
export const GET = withRoute('parent/primaria/assenze:GET', async (request: NextRequest) => {
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const { studentId, limit } = q.data

    const auth = await requireParentOfStudent(request, studentId)
    if (auth.response) return auth.response

    const supabase = await createAdminClient()

    // ═══ SI CONTA CIÒ CHE È GIÀ ACCADUTO ═════════════════════════════════════
    //
    // Il contatore «Assenze» della pagina genitore passava da 1 a 2 nel momento
    // in cui si comunicava un'assenza per il 31/12/2099, e la riga compariva
    // nella cronologia: il bambino risultava assente per un giorno che non è
    // ancora arrivato.
    //
    // NON È UN ERRORE DI CALCOLO, è un'assunzione infranta. Fino al 2026-08-07
    // `presenze` aveva UNA sola sorgente di scrittura — il docente, sul giorno
    // corrente — quindi «una riga di presenze è un giorno già trascorso» era vero
    // per costruzione, e tutti i consumatori sono stati scritti su quel
    // presupposto. «Comunica un'assenza» ne introduce una seconda che scrive
    // `data >= oggi`. Un solo consumatore era stato adeguato
    // (`parent/presenze:GET`, che usa `.lte('data', oggi)` sul riepilogo): questo
    // no, ed è quello che alimenta il contatore che il genitore vede.
    //
    // ─── PERCHÉ `.lte` E NON `.lt`: OGGI CONTA ──────────────────────────────
    //
    // Due ragioni che tirano dalla stessa parte. (1) È la definizione già scelta
    // dalla route sorella per il riepilogo dei 30 giorni: due idee diverse di
    // «trascorso» dentro la stessa app si contraddirebbero proprio nelle due
    // schermate che le mostrano vicine. (2) Con `.lt`, l'appello che la maestra
    // fa stamattina resterebbe invisibile al genitore fino a domani — si
    // toglierebbe un dato VERO per nascondere un dato futuro.
    //
    // «Oggi» è quello ITALIANO (`oggiFiscaleISO`, `Europe/Rome`): il runtime gira
    // in UTC, e fra mezzanotte e le due del mattino `new Date().toISOString()`
    // restituisce ancora ieri.
    const oggi = oggiFiscaleISO()

    // ─── E IL TEMPO DA SOLO NON BASTA (Q4) ──────────────────────────────────
    //
    // `.lte('data', oggi)` non può, per costruzione, escludere una riga che cade
    // su OGGI: `oggi <= oggi` è vero sempre. E «oggi» è il giorno PREIMPOSTATO
    // dal modulo «Comunica un'assenza», cioè il caso più frequente, non un
    // bordo. Il secondo asse — la SORGENTE — sta in `limitaAiFatti`, con la
    // misura che spiega perché la polarità è «si nomina l'annuncio», e non
    // «è un fatto solo se `registrato_da IS NOT NULL`».
    //
    // Vale anche per la CRONOLOGIA e non solo per i conteggi: qui il genitore
    // giustifica, e non si giustifica un'assenza che non è ancora avvenuta.
    // Ciò che ha comunicato lo rivede — e può annullarlo — in `comunicate`
    // (`parent/presenze:GET`).
    //
    // ─── E L'ANNUNCIO SCADE (R15) ───────────────────────────────────────────
    //
    // Il filtro dei conteggi si può tenere sull'ELENCO solo perché da R15
    // l'annuncio ha una fine. Prima no: `annuncio` era una proprietà permanente
    // della riga, quindi un'assenza VERA di luglio — di quelle senza
    // `registrato_da` — usciva da questa cronologia nell'istante in cui il
    // genitore la giustificava. Cioè spariva per il gesto che questa stessa
    // schermata gli chiede di fare, che è il modo più diretto per fargli credere
    // che la giustifica non sia arrivata.
    //
    // Ciò che oggi resta fuori dall'elenco è una riga sola: l'assenza annunciata
    // PER OGGI e non ancora lavorata dall'appello. Non ha niente da giustificare
    // (nasce già giustificata, con la firma del genitore) e il genitore la vede —
    // e la ritira — fra le «assenze comunicate» della home. Dal giorno dopo entra
    // qui insieme a tutte le altre.
    const { data: presenze, error: presenzeErr } = await limitaAiFatti(
      supabase
        .from('presenze')
        .select('id, data, stato, orario_entrata, orario_uscita, giustificata, giustificazione_testo, giustificata_il, note_appello')
        .eq('alunno_id', studentId)
        .in('stato', ['assente', 'ritardo', 'uscita_anticipata']),
      'data',
      oggi,
    )
      .order('data', { ascending: false })
      .limit(limit)

    if (presenzeErr) {
      // PostgREST non lancia: senza questo controllo una lettura fallita usciva
      // come `data: []` dentro un 200 valido — «non hai assenze» detto a chi ne
      // ha, e il ramo d'errore della schermata non veniva MAI raggiunto perché
      // la risposta era formalmente buona.
      logEvento('registro', 'error', {
        operazione: 'parent/primaria/assenze:GET',
        esito: 'assenze-non-lette',
        alunno_id: studentId,
      }, presenzeErr)
    }

    // Riepilogo: una query di conteggio per stato (`head: true` → nessuna riga
    // scaricata, solo il COUNT). PostgREST non lancia: su tabella/colonna assente
    // (E2E CI non migrato) `error` è valorizzato e `count` è null → il conteggio
    // degrada pulito a 0, e la risposta resta 200.
    const conteggi = await Promise.all(
      STATI_RIEPILOGO.map((stato) =>
        limitaAiFatti(
          supabase
            .from('presenze')
            .select('id', { count: 'exact', head: true })
            .eq('alunno_id', studentId)
            .eq('stato', stato),
          'data',
          oggi,
        ),
      ),
    )
    const riepilogo = STATI_RIEPILOGO.reduce((acc, stato, i) => {
      acc[stato] = conteggi[i]?.count ?? 0
      return acc
    }, {} as Record<StatoRiepilogo, number>)

    // ═══ IL 200 DEVE DICHIARARE SE HA LETTO ══════════════════════════════════
    //
    // T31 del terzo collaudo. Il guasto di lettura qui sopra era LOGGATO — e va
    // bene — ma la risposta restava `200 {success:true, data:[]}`: dal client,
    // «non l'ho potuto leggere» e «non ne hai» sono la stessa identica risposta.
    // La schermata mostrava «nessuna assenza» e quattro zeri a un genitore il cui
    // figlio poteva averne dieci.
    //
    // La forma è quella già scelta dalla rotta sorella (`comunicateLette` in
    // `parent/presenze:GET`): il campo dice se quel pezzo è stato letto, e il
    // client lo tratta come guasto SOLO quando vale esplicitamente `false` —
    // `undefined` è «un server più vecchio non lo dichiara», che non è «dichiara
    // di no». Una regola valida per due rotte, scritta nello stesso modo.
    //
    // Il riepilogo si degrada a 0 per costruzione (`head: true` + `count` nullo
    // sul DB E2E non migrato): anche quello va dichiarato, perché quattro zeri
    // sono una frase, non l'assenza di una frase.
    const riepilogoLetto = conteggi.every((c) => !c.error)
    return NextResponse.json({
      success: true,
      data: presenze ?? [],
      letto: !presenzeErr,
      riepilogo,
      riepilogoLetto,
    })
  } catch (err) {
    logErrore({ operazione: 'parent/primaria/assenze:GET', stato: 500 }, err)
    // Il messaggio dell'eccezione NON esce verso il genitore: è la terza rotta di
    // questa famiglia con la stessa forma (dopo `attendance/daily` e
    // `giustifica`), e il `message` di PostgREST riecheggia filtri e colonne.
    // Resta nel log, intero, che è dove dice perché.
    return NextResponse.json(
      // `PRESENZE_NON_LETTE` esiste già, è tradotto in entrambe le lingue e dice
      // esattamente questo: un codice nuovo sarebbe una seconda frase per lo
      // stesso fatto, cioè il modo in cui due messaggi divergono.
      { error: 'Errore interno', codice: 'PRESENZE_NON_LETTE' },
      { status: 500 },
    )
  }
})
