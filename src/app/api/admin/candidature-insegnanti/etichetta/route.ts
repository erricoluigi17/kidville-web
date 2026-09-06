import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { logScrittura } from '@/lib/audit/scrittura'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zOpzionale, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

// =============================================================================
// L'ETICHETTA DI SELEZIONE INTERNA — e la rotta che la scrive.
//
// ─── LA COSA PIÙ IMPORTANTE DI QUESTO FILE ───────────────────────────────────
//
// **Cambiare etichetta non manda nessuna email.** Non «di solito»: mai, e non
// perché qui dentro nessuno la chiami, ma perché questo modulo non può
// RAGGIUNGERE un percorso d'invio — nemmeno passando per tre import. È un
// invariante sorvegliato da
// `__tests__/architecture/etichetta-candidatura-senza-email.test.ts`, che
// ricostruisce il grafo degli import a partire da questo file e diventa rosso se
// da qui si arriva a `@/lib/email/**`, a `inviaCopiaAllaSede`, a `externalFetch`
// verso un provider di posta, o alla rotta grossa che quei percorsi li contiene.
//
// Perché serve un lock e non un commento: i tre punti di invio del flusso
// candidature sono a poche righe di distanza da qui —
//   1. `iscrizione/insegnanti:POST`      conferma alla candidata, alla ricezione;
//   2. `lib/candidature/copia-alla-sede` copia con CV alla casella del plesso;
//   3. `admin/candidature-insegnanti:PATCH` esito, e SOLO con `action:'rifiuta'`
//      e la casella `inviaEmailEsito` spuntata (spenta di default).
// — e la strada più corta per «riusare quello che c'è già» sarebbe far passare
// l'etichetta da uno di quei tre. «Non idonea» segnato per la Direzione e «non
// idonea» recapitato alla persona sono due fatti diversi, e il secondo non si
// annulla.
//
// ⚠️ E NON SI TOCCA `copia_inviata_il`. Riportarla a NULL è un gesto che sembra
// innocuo — «rimetto la riga com'era» — e invece rimette la candidatura nella
// coda di `inoltro-arretrato`, che rispedirebbe alla casella del plesso il
// modulo compilato e il curriculum. Questa rotta scrive TRE colonne e nessun'altra.
//
// ─── PERCHÉ UNA COLONNA NUOVA E NON `stato` ─────────────────────────────────
//
// `candidature_insegnanti.stato` è un AGGREGATO: dal 2026-08-19 lo ricalcola il
// trigger `candidature_ricalcola_stato()` sulle righe di `candidature_sedi`. Una
// etichetta scritta lì verrebbe sovrascritta alla prima decisione di una
// qualunque sede, senza errore e senza log. E oggi non distingue nulla: misurate
// il 2026-09-05 in produzione, 461 candidature di cui 460 `pending` e 1
// `rifiutata` — che è esattamente il buco che l'etichetta riempie.
//
// ─── PERCHÉ LA ROTTA È SUA E NON UN RAMO DI QUELLA GROSSA ───────────────────
//
// Perché l'invariante di sopra si possa DIMOSTRARE. Un `action: 'etichetta'`
// dentro `admin/candidature-insegnanti:PATCH` starebbe nello stesso modulo che
// importa `sendEmailDetailed` e `messaggioEsitoCandidatura`: nessun lock potrebbe
// più distinguere «non manda email» da «non manda email oggi».
// =============================================================================

/**
 * I nomi delle due operazioni, per i log.
 *
 * ⚠️ In `withRoute(...)` il nome è scritto per ESTESO e non passa di qui: il lock
 * `__tests__/architecture/logging-coverage.test.ts` lo confronta con il percorso
 * del file, e per farlo deve poterlo leggere come stringa letterale. Una
 * costante lo renderebbe illeggibile a quel controllo — che è il controllo che
 * impedisce a una route di loggarsi col nome di un'altra.
 */
const OPERAZIONE_GET = 'admin/candidature-insegnanti/etichetta:GET'
const OPERAZIONE_PATCH = 'admin/candidature-insegnanti/etichetta:PATCH'

/**
 * I codici d'errore, gli STESSI della rotta sorella: il pannello li traduce da
 * `CODICI_ERRORE` (`src/lib/ui/esito-fetch.ts`), e un codice nuovo per lo stesso
 * fatto vorrebbe dire una frase in più da tradurre per dire la stessa cosa.
 */
const CODICE_NON_TROVATA = 'CANDIDATURA_NON_TROVATA'
const CODICE_OPERAZIONE_NON_RIUSCITA = 'CANDIDATURE_OPERAZIONE_NON_RIUSCITA'

const TABELLA = 'candidature_insegnanti'

/**
 * L'embed che RESTRINGE alle sedi di chi guarda.
 *
 * Scritto per esteso e ripetuto in entrambi i rami, come nella rotta sorella:
 * il criterio di sede deve essere leggibile nel punto in cui si applica — da una
 * persona come dai lock di copertura — e un'indirezione in più è un'indirezione
 * in cui il filtro può sparire senza che si veda.
 *
 * ⚠️ Il perimetro è `candidature_sedi`, NON `candidature_insegnanti.scuola_id`:
 * quella è la sede di PRIMO ARRIVO, un dato storico dal 2026-08-19. Una
 * candidatura arrivata a Giugliano e rivolta anche ad Aversa è di entrambe, e
 * filtrare sulla colonna della madre la nasconderebbe ad Aversa.
 */
const EMBED_FILTRO = 'candidature_sedi!inner(scuola_id)'

/**
 * IL VOCABOLARIO, chiuso. Lo stesso elenco sta nel CHECK della migrazione
 * `20260906013119_candidature_etichetta_selezione.sql`: qui difende la porta
 * HTTP, là difende la tabella anche da chi scrive con `psql`.
 *
 * I due elenchi (più quello del client, in `filtri-candidature.ts`) non possono
 * essere una costante sola — SQL, server e browser non se la passano — quindi li
 * tiene allineati un lock: `__tests__/architecture/etichetta-candidatura-vocabolario.test.ts`
 * risolve questo `z.enum`, legge `etichetta in (…)` del CHECK e l'array del
 * client, e diventa rosso appena divergono di una voce.
 */
export const ETICHETTE_CANDIDATURA = [
  'gia_chiamata',
  'non_idonea',
  'da_richiamare',
  'in_valutazione',
  'assunta',
] as const

/** Le colonne che questa rotta scrive. Tre, e nessun'altra. */
const COLONNE_SCRITTE = ['etichetta', 'etichetta_aggiornata_il', 'etichetta_aggiornata_da'] as const

/**
 * Il tetto della mappa delle etichette.
 *
 * ⚠️ NON È UNA PAGINAZIONE DECORATIVA. Il pannello usa questa risposta per due
 * cose: disegnare l'etichetta di ogni riga e sapere QUALI righe hanno
 * un'etichetta. Se la mappa fosse tagliata a metà senza dirlo, il filtro
 * mostrerebbe meno candidature di quante ne esistono — e sarebbe la specie di
 * bugia che si nota solo contando a mano. Per questo la risposta porta sempre
 * `total`: quando `total > data.length` il client SPEGNE il filtro invece di
 * mostrarne uno che non trova tutto.
 *
 * 2000 è largo: le candidature in produzione sono 461 al 2026-09-05, e solo una
 * minoranza sarà etichettata.
 */
const LIMITE_ETICHETTE_DEFAULT = 2000
const LIMITE_ETICHETTE_MAX = 5000

/** PostgREST: la colonna non esiste (SELECT) / non è nella cache (scrittura). */
const COLONNA_ASSENTE = new Set(['42703', 'PGRST204'])
const codiceDi = (err: unknown): string | null => (err as { code?: string } | null)?.code ?? null

const getQuerySchema = z
  .object({
    /** Restringe la mappa a una sola etichetta. Assente = tutte quelle scritte. */
    etichetta: zOpzionale(z.enum(ETICHETTE_CANDIDATURA)),
    limit: z.coerce
      .number({ error: 'Limite non valido' })
      .int('Il limite deve essere un numero intero')
      .min(1, 'Il limite deve essere almeno 1')
      .max(LIMITE_ETICHETTE_MAX, `Il limite non può superare ${LIMITE_ETICHETTE_MAX}`)
      .default(LIMITE_ETICHETTE_DEFAULT),
  })
  .strict()

const patchBodySchema = z
  .object({
    id: zUuid,
    /**
     * `null` TOGLIE l'etichetta, e non è la stessa cosa di ometterla: «segnata e
     * poi ripensata» è un gesto che la Direzione fa, e senza il `null` esplicito
     * l'unico modo di disfarlo sarebbe una UPDATE a mano sul database di
     * produzione — che è precisamente il difetto da cui nasce questo lavoro.
     */
    etichetta: z.enum(ETICHETTE_CANDIDATURA).nullable(),
  })
  .strict()

const nonDisponibile = (messaggio: string) =>
  NextResponse.json({ error: messaggio, codice: CODICE_OPERAZIONE_NON_RIUSCITA }, { status: 503 })

// ─── GET — la mappa delle etichette delle candidature in scope ───────────────
//
// Non è un secondo elenco delle candidature: torna `id` + etichetta e basta.
// Nessun nome, nessun recapito. Il pannello ha già le righe dalla rotta sorella
// e ci appende l'etichetta per `id`.
export const GET = withRoute('admin/candidature-insegnanti/etichetta:GET', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  try {
    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response
    const supabase = await createAdminClient()
    // Scope vuoto ⇒ mappa vuota: `.in()` incondizionato, mai `if (scuole.length)`.
    const scuole = await resolveScuoleAttive(request, supabase, auth.user)

    let query = supabase
      .from(TABELLA)
      .select(`id, etichetta, etichetta_aggiornata_il, ${EMBED_FILTRO}`, { count: 'exact' })
      .in('candidature_sedi.scuola_id', scuole)
      // `not.is.null`: le righe senza etichetta sono la stragrande maggioranza e
      // non hanno niente da dire al pannello. Escluderle qui è ciò che rende la
      // mappa piccola abbastanza da poter essere INTERA — e una mappa intera è
      // l'unica su cui un filtro possa dire il vero.
      .not('etichetta', 'is', null)
    if (q.data.etichetta) query = query.eq('etichetta', q.data.etichetta)

    const { data, error, count } = await query
      .order('etichetta_aggiornata_il', { ascending: false })
      .limit(q.data.limit)

    if (error) {
      // DEGRADO DICHIARATO, e solo per la colonna assente: il database E2E della
      // CI è un progetto separato e non è migrato. Lì «nessuna etichetta» è la
      // verità, non un guasto — e la risposta lo DICE (`colonnaAssente`), così il
      // pannello nasconde il menu invece di mostrarne uno che non salva niente.
      if (COLONNA_ASSENTE.has(codiceDi(error) ?? '')) {
        logEvento('candidatura', 'warn', {
          operazione: OPERAZIONE_GET,
          esito: 'colonna-etichetta-assente',
          entita_tipo: TABELLA,
          error_code: codiceDi(error),
        })
        return NextResponse.json({ data: [], total: 0, colonnaAssente: true })
      }
      // PostgREST non lancia: un errore ritornato che non si guarda diventa una
      // mappa vuota indistinguibile da «nessuno ha etichettato niente».
      logEvento(
        'candidatura',
        'error',
        {
          operazione: OPERAZIONE_GET,
          esito: 'etichette-non-lette',
          entita_tipo: TABELLA,
          error_code: codiceDi(error),
        },
        error,
      )
      return nonDisponibile('Le etichette non sono consultabili in questo momento: riprovare fra poco.')
    }

    const righe = (data ?? []) as unknown as { id: string; etichetta: string | null; etichetta_aggiornata_il: string | null }[]
    return NextResponse.json({
      data: righe.map((r) => ({
        id: r.id,
        etichetta: r.etichetta,
        etichetta_aggiornata_il: r.etichetta_aggiornata_il,
      })),
      // Il conteggio ESATTO, che può essere maggiore delle righe tornate: è il
      // solo modo che il client ha di sapere che la mappa è tagliata.
      total: typeof count === 'number' ? count : righe.length,
      colonnaAssente: false,
    })
  } catch (err) {
    logErrore({ operazione: OPERAZIONE_GET, stato: 503 }, err)
    return nonDisponibile('Le etichette non sono consultabili in questo momento: riprovare fra poco.')
  }
})

// ─── PATCH — scrivi (o togli) l'etichetta di una candidatura ─────────────────
export const PATCH = withRoute('admin/candidature-insegnanti/etichetta:PATCH', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const user = auth.user
  try {
    const corpo = await parseBody(request, patchBodySchema)
    if ('response' in corpo) return corpo.response
    const { id, etichetta } = corpo.data
    const supabase = await createAdminClient()
    const scuole = await resolveScuoleAttive(request, supabase, user)

    // ─── PRIMA IL PERIMETRO, POI LA SCRITTURA ─────────────────────────────────
    // Si legge QUELLA riga con il filtro di sede nella STESSA query, e solo dopo
    // si scrive. L'`UPDATE` non può portare il filtro di sede da sé: la colonna
    // `scuola_id` della madre è la sede di primo arrivo, e usarla qui negherebbe
    // l'etichetta ad Aversa su una candidatura arrivata a Giugliano.
    const { data: riga, error: errLettura } = await supabase
      .from(TABELLA)
      .select(`id, scuola_id, etichetta, ${EMBED_FILTRO}`)
      .eq('id', id)
      .in('candidature_sedi.scuola_id', scuole)
      .maybeSingle()

    if (errLettura) {
      if (COLONNA_ASSENTE.has(codiceDi(errLettura) ?? '')) {
        logEvento('candidatura', 'warn', {
          operazione: OPERAZIONE_PATCH,
          esito: 'colonna-etichetta-assente',
          entita_tipo: TABELLA,
          error_code: codiceDi(errLettura),
        })
        return nonDisponibile("Le etichette non sono ancora attive su questo ambiente: la migrazione non è stata applicata.")
      }
      logEvento(
        'candidatura',
        'error',
        {
          operazione: OPERAZIONE_PATCH,
          esito: 'candidatura-non-letta',
          entita_tipo: TABELLA,
          error_code: codiceDi(errLettura),
        },
        errLettura,
      )
      return nonDisponibile("L'etichetta non è stata salvata: riprovare fra poco.")
    }

    if (!riga) {
      // 404 anche quando la candidatura ESISTE ma è di un altro plesso: dire
      // «non hai i permessi» direbbe anche «questa esiste», che è un dato in più
      // su una persona. Il warn resta, ed è il segnale di sicurezza da leggere.
      logEvento('multi_sede', 'warn', {
        operazione: OPERAZIONE_PATCH,
        esito: 'candidatura-non-in-scope',
        utente: user.id,
        ruolo: user.role,
        entita_tipo: TABELLA,
        entita_id: id,
        sedi_attive: scuole.length,
      })
      return NextResponse.json(
        { error: 'Candidatura non trovata', codice: CODICE_NON_TROVATA },
        { status: 404 },
      )
    }

    const precedente = (riga as { etichetta?: string | null }).etichetta ?? null
    const adesso = new Date().toISOString()
    const { data: aggiornata, error: errScrittura } = await supabase
      .from(TABELLA)
      .update({
        etichetta,
        // I due «quando» e «chi» seguono l'etichetta anche quando la si TOGLIE:
        // «mai etichettata» e «etichettata e poi ripulita» sono due fatti diversi,
        // e la seconda ha un autore che l'audit deve poter nominare.
        etichetta_aggiornata_il: adesso,
        etichetta_aggiornata_da: user.id,
      })
      .eq('id', id)
      .select('id, etichetta, etichetta_aggiornata_il')
      .maybeSingle()

    if (errScrittura) {
      const codice = codiceDi(errScrittura)
      logEvento(
        'candidatura',
        'error',
        {
          operazione: OPERAZIONE_PATCH,
          esito: COLONNA_ASSENTE.has(codice ?? '') ? 'colonna-etichetta-assente' : 'etichetta-non-scritta',
          entita_tipo: TABELLA,
          entita_id: id,
          error_code: codice,
        },
        errScrittura,
      )
      return nonDisponibile("L'etichetta non è stata salvata: riprovare fra poco.")
    }

    // L'audit porta il PRIMA e il DOPO: la domanda che qualcuno farà a questo
    // registro è «chi l'ha marcata non idonea, e quando».
    await logScrittura(supabase, {
      attore: user,
      entitaTipo: 'candidatura',
      entitaId: id,
      azione: 'update',
      scuolaId: (riga as { scuola_id?: string | null }).scuola_id ?? null,
      valorePrima: { etichetta: precedente },
      valoreDopo: { etichetta },
    })

    // IL SUCCESSO SI LOGGA, non solo l'errore: con i soli errori «nessun log» non
    // distingue «nessuno etichetta» da «il salvataggio non parte più».
    // `azione` è in lista bianca ed è enumerata: ci sta il valore dell'etichetta,
    // che è un token chiuso e non un giudizio in testo libero.
    logEvento('candidatura', 'info', {
      operazione: OPERAZIONE_PATCH,
      esito: 'etichetta-aggiornata',
      azione: etichetta ?? 'rimossa',
      entita_tipo: TABELLA,
      entita_id: id,
      utente: user.id,
      ruolo: user.role,
    })

    return NextResponse.json({
      data: aggiornata ?? { id, etichetta, etichetta_aggiornata_il: adesso },
      colonneScritte: COLONNE_SCRITTE,
    })
  } catch (err) {
    logErrore({ operazione: OPERAZIONE_PATCH, stato: 503 }, err)
    return nonDisponibile("L'etichetta non è stata salvata: riprovare fra poco.")
  }
})
