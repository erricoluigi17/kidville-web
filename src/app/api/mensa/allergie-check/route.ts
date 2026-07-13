import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { loadResolveOptions } from '@/lib/mensa/server'
import { controllaAllergie } from '@/lib/mensa/allergie-check'
import type { ResolveOptions } from '@/lib/mensa/resolveMenu'
import { parseData, parseQuery } from '@/lib/validation/http'
import { zDataYMD } from '@/lib/validation/common'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'

// Battito cardiaco del cron: pg_net chiama in fire-and-forget con `EXCEPTION WHEN OTHERS
// THEN null`, quindi un job che non parte non lascia traccia — si sorveglia l'ASSENZA.
// `operazione` e non `job` (lista bianca di `redact`), e il nome nel `msg` perché
// `app_log` deduplica per (fingerprint, giorno) e il `contesto` NON è nell'impronta.
// La spiegazione per esteso è in `src/app/api/push/dispatch/route.ts`.
const JOB = 'mensa-allergie-check'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
// '' è ammesso per retro-compatibilità: ?data= (vuoto) equivale ad assente.
// Default dinamico (oggi) calcolato nell'handler.
const postQuerySchema = z.object({
  data: zDataYMD.or(z.literal('')).optional(),
})

// Body opzionale { data? }: letto solo se il query param è assente. Il body può
// mancare del tutto (il cron chiama senza body), quindi JSON assente/malformato
// resta tollerato come prima; se il JSON c'è, il campo `data` viene validato.
const postBodySchema = z.object({
  data: zDataYMD.nullish(),
})

interface AlunnoRow {
  id: string
  nome: string
  cognome: string
  classe_sezione: string | null
  section_id: string | null
  scuola_id: string | null
  allergies: string | null
  allergeni: string[] | null
}

/**
 * Query fallita → riga d'errore parlante + 500, e NESSUN battito «ok».
 *
 * PostgREST non lancia, ritorna `{ error }` (regola 7 di AGENTS.md): il `try/catch` di questo
 * handler non scatta mai su una query rotta. Ignorare `error` qui significa `pren` a `null` →
 * `ids` vuoto → ramo «nessuna prenotazione» → battito `esito: 'ok'`: **un bambino allergico non
 * riceve l'alert e la sorveglianza vede verde**. La spiegazione per esteso è in
 * `src/app/api/push/dispatch/route.ts`.
 */
function queryFallita(azione: string, error: unknown, t0: number, canale: string): NextResponse {
  logEvento(
    'cron',
    'error',
    {
      operazione: JOB,
      esito: 'query-fallita',
      azione,
      canale,
      ms: Date.now() - t0,
      msg: `${JOB}: ${azione} fallita`,
    },
    error,
  )
  return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
}

// POST /api/mensa/allergie-check
//   Job giornaliero: per ogni prenotazione attiva di `data` (default: oggi),
//   verifica i conflitti allergia↔menu e avvisa segreteria/cuoca/insegnanti.
//   Auth: header `x-cron-secret` (chiamata dal cron) OPPURE staff (manuale).
//   Idempotente per (alunno, data) grazie al dedup in notificaAllergie.
export const POST = withRoute('mensa/allergie-check:POST', async (request: Request) => {
  const t0 = Date.now()
  try {
    const secret = request.headers.get('x-cron-secret')
    const isCron = !!secret && secret === process.env.CRON_SECRET
    if (!isCron) {
      // Si grida SOLO se l'header c'è ma non torna: quello è un cron che bussa con la
      // chiave sbagliata, ed è il guasto invisibile. Se l'header manca del tutto non c'è
      // nessun cron di cui parlare — è lo staff che lancia il giro a mano, e il gate che
      // segue (`requireStaff`) è il suo. Il gate non si tocca: si logga e basta.
      if (secret) {
        logEvento('cron', 'error', {
          operazione: JOB,
          esito: 'secret-errato',
          msg: process.env.CRON_SECRET
            ? `${JOB}: x-cron-secret non corrispondente`
            : `${JOB}: CRON_SECRET non configurato in questo ambiente`,
        })
      }
      const auth = await requireStaff(request)
      if (auth.response) return auth.response
    }

    // `canale` (lista bianca) distingue il giro schedulato dal lancio manuale dello staff,
    // ed è ripetuto nel `msg` perché è il MESSAGGIO a entrare nell'impronta: senza, la
    // prova fatta a mano da un operatore e il giro notturno vero finirebbero nella stessa
    // riga deduplicata — e la sorveglianza dell'assenza direbbe «tutto bene» proprio nel
    // caso che deve scoprire (il cron è fermo, ma qualcuno l'ha lanciato a mano).
    const canale = isCron ? 'cron' : 'manuale'
    logEvento('cron', 'info', {
      operazione: JOB,
      esito: 'avviato',
      canale,
      msg: `${JOB}: avviato (canale ${canale})`,
    })

    const q = parseQuery(request, postQuerySchema)
    if ('response' in q) return q.response

    let data: string | null = q.data.data || null
    if (!data) {
      let raw: unknown = null
      try { raw = await request.json() } catch { raw = null }
      if (raw !== null && raw !== undefined) {
        const b = parseData(postBodySchema, raw)
        if ('response' in b) return b.response
        data = b.data.data ?? null
      }
    }
    data = data ?? new Date().toISOString().slice(0, 10)

    const supabase = await createAdminClient()

    // prenotazioni attive per la data
    const { data: pren, error: errPren } = await supabase
      .from('mensa_prenotazioni')
      .select('alunno_id')
      .eq('data', data)
      .eq('stato', 'prenotato')
    // Senza questo controllo, «la query è fallita» e «nessuno mangia a mensa oggi» sono lo
    // stesso ramo, e il secondo chiude con un «ok».
    if (errPren) return queryFallita('lettura mensa_prenotazioni', errPren, t0, canale)
    const ids = [...new Set((pren ?? []).map(p => p.alunno_id as string))]
    if (ids.length === 0) {
      // Anche il giro a vuoto si chiude con un «ok»: senza, il caso più frequente (nessuna
      // prenotazione) sembrerebbe un job partito e mai finito, e la sorveglianza
      // griderebbe al lupo tutti i giorni. `data` è una data ISO: `redact` la lascia in
      // chiaro (è auto-descrittiva), quindi in tabella si legge PER QUALE giorno si è
      // controllato — che non è per forza oggi.
      logEvento('cron', 'info', {
        operazione: JOB,
        esito: 'ok',
        canale,
        ms: Date.now() - t0,
        data,
        prenotati: 0,
        alert: 0,
        msg: `${JOB}: ok (canale ${canale})`,
      })
      return NextResponse.json({ success: true, data: { data, prenotati: 0, alert: 0 } })
    }

    // anagrafica + allergie dei prenotati
    const { data: alunni, error: errAlunni } = await supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione, section_id, scuola_id, allergies, allergeni')
      .in('id', ids)
    // È QUI che stanno le allergie. Una lettura fallita e ignorata darebbe `rows` vuoto: zero
    // conflitti trovati, zero alert inviati, `prenotati: 0` — e un «ok» in fondo. La riga di
    // errore + il 500 sono l'unica cosa che separa «oggi nessuno rischiava nulla» da «oggi non
    // abbiamo controllato».
    if (errAlunni) return queryFallita('lettura alunni', errAlunni, t0, canale)
    const rows = (alunni ?? []) as AlunnoRow[]

    // opzioni menu per scuola (cache per evitare riletture)
    const optsCache = new Map<string, ResolveOptions>()
    let alert = 0
    for (const a of rows) {
      const scuolaId = a.scuola_id as string
      let opts = optsCache.get(scuolaId)
      if (!opts) { opts = await loadResolveOptions(supabase, scuolaId); optsCache.set(scuolaId, opts) }
      const inviata = await controllaAllergie(supabase, a, data, scuolaId, opts)
      if (inviata) alert++
    }

    // I contatori sono NUMERI: passano in chiaro anche in tabella. `alert` a zero su
    // centinaia di prenotati è un dato; `prenotati` a zero tutti i giorni è un guasto.
    logEvento('cron', 'info', {
      operazione: JOB,
      esito: 'ok',
      canale,
      ms: Date.now() - t0,
      data,
      prenotati: rows.length,
      alert,
      msg: `${JOB}: ok (canale ${canale})`,
    })
    return NextResponse.json({ success: true, data: { data, prenotati: rows.length, alert } })
  } catch (err) {
    // `evento: 'cron'` (e non il 'route' di default): il fallimento totale del job deve
    // stare nello stesso flusso dei battiti (`where evento = 'cron'`), non in un rivolo
    // separato che chi sorveglia i cron non sa di dover guardare. `logErrore` emette anche
    // l'Error nativo con lo stack VERO, che il `console.error` sul solo messaggio non dava.
    logErrore({ operazione: JOB, evento: 'cron', ms: Date.now() - t0, stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
