import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createTranslator } from 'next-intl'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireDocente } from '@/lib/auth/require-staff'
import { assertClasseNomeInScope, resolveScuoleAttive } from '@/lib/auth/scope'
import { parseQuery } from '@/lib/validation/http'
import { applicaCartaIntestata } from '@/lib/carta'
import {
  buildRegistroPresenzePdf,
  type RigaRegistro,
  type StatoCella,
} from '@/lib/presenze/registro-pdf'
import { COLONNE_SORGENTE, eFattoDelRegistro } from '@/lib/presenze/finestra-trascorsa'
import { oggiFiscaleISO } from '@/lib/format/fiscal-date'
import { DEFAULT_LOCALE, LOCALES, formattaIstante, intlDateTime, meseCivile } from '@/i18n/config'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

/**
 * GET /api/admin/registro-presenze/pdf?year=2026&month=5&sezione=<classe>&locale=it
 *
 * ─── PERCHÉ QUESTA ROTTA ESISTE ────────────────────────────────────────────────
 *
 * Fino al 2026-08-16 il registro presenze mensile si generava NEL BROWSER, dentro
 * `MonthlyAttendanceTable.tsx`, con `jspdf-autotable` importato a richiesta. Sulla carta
 * intestata non poteva restarci: l'asset della carta pesa **1,1 MB**, e importarlo da un
 * componente client vorrebbe dire 1,1 MB scaricati da ogni tablet della scuola — ogni
 * volta, anche da chi il PDF non lo stampa mai. Servire l'asset da una rotta e comporre nel
 * browser è l'alternativa scartata: scaricherebbe quegli stessi 1,1 MB a ogni stampa e
 * lascerebbe un sesto motore fuori dal motore comune della carta.
 *
 * ─── E IL SERVER NON È SOLO UN POSTO PIÙ COMODO ────────────────────────────────
 *
 * I gate arrivano con lui. Il PDF che il browser produceva nasceva da ciò che il browser
 * aveva già in memoria; qui i dati si rileggono con `requireDocente`, con
 * `assertClasseNomeInScope({ soloSezioniAssegnate: true })` — che è ciò che impedisce a un
 * `educator` di stampare il registro di una classe non sua — e dentro le sedi attive. Con
 * tre plessi la stessa `classe_sezione` esiste in più sedi, e senza il filtro il registro
 * mescolerebbe i bambini di Giugliano con quelli di Aversa.
 *
 * ─── LA REGOLA DI CONTEGGIO È QUELLA DEL PRODOTTO, NON UNA COPIA ───────────────
 *
 * `eFattoDelRegistro` (`@/lib/presenze/finestra-trascorsa`): si conta ciò che è già
 * accaduto, e un'assenza soltanto ANNUNCIATA dal genitore per oggi non entra nei totali
 * finché il giorno non è concluso. È la stessa funzione che usa lo schermo, non un suo
 * gemello — due copie della stessa regola divergono, e qui divergerebbero sul numero di
 * assenze scritto su un registro.
 *
 * Le colonne del PDF sono P/A/R e basta: il monte ORE non ci finisce, ed è una fortuna,
 * perché `calcolaOreAssenza` legge l'ora locale del PROCESSO (su Vercel UTC) e su un
 * ritardo darebbe due ore di differenza rispetto allo schermo del docente.
 */

/** Intero da query string con la semantica storica di parseInt ('' → NaN → 400). */
const zIntParseInt = (inner: z.ZodNumber) =>
  z.preprocess((v) => (typeof v === 'string' ? parseInt(v, 10) : v), inner)

const getQuerySchema = z.object({
  year: zIntParseInt(z.number().int().min(2000).max(2100)).optional(),
  month: zIntParseInt(z.number().int().min(1).max(12)).optional(),
  // Nessun default a un nome sezione reale: param omesso → '' → 400 dal gate di scope.
  // Il `max` non è decorazione: il nome della sezione finisce nella riga di contesto in
  // testa a OGNI pagina del PDF, e una stringa senza limite è una stringa che prima o poi
  // arriva. Il motore la manda a capo e al limite la accorcia coi puntini, ma un modulo
  // che accetta duemila caratteri e poi li butta via è una cortesia che non serve a
  // nessuno: qui si rifiuta, con un 400 che dice cosa non va.
  sezione: z.string().max(120).default(''),
  locale: z.enum(LOCALES).default(DEFAULT_LOCALE),
})

type Locale = (typeof LOCALES)[number]

/** I giorni del mese in ISO, senza mai costruire un istante: la data è una stringa. */
function giorniDelMese(anno: number, mese: number): string[] {
  const ultimo = new Date(Date.UTC(anno, mese, 0)).getUTCDate()
  return Array.from(
    { length: ultimo },
    (_, i) => `${anno}-${String(mese).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`
  )
}

/** I sette nomi dei giorni, indicizzati come `getUTCDay()` (0 = domenica). */
function nomiGiorni(locale: string): string[] {
  const fmt = intlDateTime(locale, { weekday: 'short', timeZone: 'UTC' })
  // 2023-01-01 è una domenica. A mezzogiorno UTC, così nessun fuso può farla scivolare.
  return Array.from({ length: 7 }, (_, i) => {
    const s = fmt.format(new Date(Date.UTC(2023, 0, 1 + i, 12)))
    return s.charAt(0).toUpperCase() + s.slice(1)
  })
}

function nomeMese(locale: string, anno: number, mese: number): string {
  const s = intlDateTime(locale, { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(anno, mese - 1, 15))
  )
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Un nome file che sta dentro un header HTTP.
 *
 * `Content-Disposition` non ammette accenti né caratteri di controllo, e i nomi delle
 * sezioni li hanno («3 ANNI», ma anche «PRIMAVERA À»): un byte fuori tabella qui non
 * produce un nome brutto, produce un header che il browser rifiuta e un download che non
 * parte, senza dire perché.
 */
function nomeFileSicuro(pezzi: string[]): string {
  return (
    pezzi
      .join('_')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 100) || 'registro'
  )
}

/** Le etichette del PDF, tradotte dal namespace che usa anche la schermata. */
async function etichette(locale: Locale, anno: number, mese: number, sezione: string) {
  const messaggi = (await import(`../../../../../../messages/${locale}/teacherPresenze.json`))
    .default as Record<string, string>
  const t = createTranslator({
    locale,
    messages: { teacherPresenze: messaggi },
    namespace: 'teacherPresenze',
  })
  return {
    t,
    etichette: {
      titolo: t('pdfTitolo', { mese: nomeMese(locale, anno, mese).toUpperCase(), anno }),
      meta: t('pdfMeta', { sezione, data: formattaIstante(new Date(), locale) }),
      studente: t('studente'),
      abbrevP: t('abbrevP'),
      abbrevA: t('abbrevA'),
      abbrevR: t('abbrevR'),
      simboli: {
        presente: t('abbrevP'),
        assente: t('abbrevA'),
        ritardo: t('abbrevR'),
        uscita_anticipata: t('abbrevU'),
      },
      giorni: nomiGiorni(locale),
      piePagina: (n: number, tot: number) => t('pdfPiePagina', { n, tot }),
    },
  }
}

export const GET = withRoute('admin/registro-presenze/pdf:GET', async (request: NextRequest) => {
  try {
    const auth = await requireDocente(request)
    if (auth.response) return auth.response

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    // Il mese di default è quello ITALIANO, non quello del processo: su Vercel gira in
    // UTC, e fra mezzanotte e le due del primo del mese la stampa uscirebbe sul mese
    // sbagliato — cioè un registro vuoto consegnato come se fosse quello del mese.
    const [annoCorrente, meseCorrente] = meseCivile().split('-').map(Number)
    const year = q.data.year ?? annoCorrente
    const month = q.data.month ?? meseCorrente
    const sezione = q.data.sezione

    const supabase = await createAdminClient()

    // Gate per SEZIONE ASSEGNATA: `requireDocente` verifica il RUOLO, non la classe.
    // Senza, un `educator` stamperebbe il registro mensile di qualunque classe del
    // proprio plesso, comprese quelle non sue. Risponde 400 con la sezione vuota.
    const scopeErr = await assertClasseNomeInScope(supabase, auth.user, sezione, {
      soloSezioniAssegnate: true,
    })
    if (scopeErr) return scopeErr

    const plessi = await resolveScuoleAttive(request, supabase, auth.user)
    if (plessi.length === 0) {
      return NextResponse.json(
        { error: 'Nessun plesso associato', codice: 'SEDE_NON_ACCESSIBILE' },
        { status: 403 }
      )
    }

    const { data: alunniData, error: alunniError } = await supabase
      .from('alunni')
      .select('id, nome, cognome, classe_sezione')
      .eq('classe_sezione', sezione)
      .in('scuola_id', plessi)
    if (alunniError) {
      // PostgREST non lancia: senza questo ramo si proseguirebbe con un elenco vuoto e la
      // maestra riceverebbe un registro SENZA ALUNNI, che sembra un mese senza iscritti.
      // Il `message` non esce verso il client: è prosa inglese con dentro nomi di colonne.
      logErrore(
        { operazione: 'admin/registro-presenze/pdf:GET', stato: 500, evento: 'db' },
        alunniError
      )
      return NextResponse.json(
        { error: 'Errore recupero alunni.', codice: 'REGISTRO_ALUNNI_NON_LETTI' },
        { status: 500 }
      )
    }
    const alunni = (alunniData ?? []) as { id: string; nome: string; cognome: string }[]
    if (alunni.length === 0) {
      // Un 404, non un PDF con le colonne dei giorni e nessuna riga: un foglio vuoto è
      // indistinguibile da un guasto, e chi lo tiene in mano non può sapere quale dei due sia.
      return NextResponse.json(
        { error: 'Nessun alunno nella sezione', codice: 'REGISTRO_SEZIONE_VUOTA' },
        { status: 404 }
      )
    }

    const giorni = giorniDelMese(year, month)
    const { data: presenzeData, error: presenzeError } = await supabase
      .from('presenze')
      .select(`alunno_id, data, ${COLONNE_SORGENTE}`)
      .in(
        'alunno_id',
        alunni.map((a) => a.id)
      )
      .gte('data', giorni[0])
      .lte('data', giorni[giorni.length - 1])
    if (presenzeError) {
      logErrore(
        { operazione: 'admin/registro-presenze/pdf:GET', stato: 500, evento: 'db' },
        presenzeError
      )
      return NextResponse.json(
        { error: 'Errore recupero presenze.', codice: 'PRESENZE_NON_LETTE' },
        { status: 500 }
      )
    }

    // `oggi` si calcola UNA volta per tutta la stampa: due righe dello stesso foglio non
    // possono cadere in due giorni diversi perché la mezzanotte è passata a metà `map`.
    const oggi = oggiFiscaleISO()
    const perAlunno = new Map<string, RigaRegistro>()
    for (const a of alunni) {
      perAlunno.set(a.id, {
        cognome: a.cognome,
        nome: a.nome,
        giorni: {},
        riepilogo: { presenze: 0, assenze: 0, ritardi: 0 },
      })
    }
    for (const riga of (presenzeData ?? []) as {
      alunno_id: string
      data: string
      stato: string
      registrato_da: string | null
      giustificata_da: string | null
    }[]) {
      const voce = perAlunno.get(riga.alunno_id)
      if (!voce) continue
      const stato = riga.stato as StatoCella
      // Il CALENDARIO mostra anche le assenze comunicate in anticipo — è il motivo per cui
      // il genitore le comunica — ma i CONTEGGI contano solo i fatti del registro.
      voce.giorni[String(riga.data).slice(0, 10)] = stato
      if (!eFattoDelRegistro(riga, oggi)) continue
      if (stato === 'presente') voce.riepilogo.presenze++
      else if (stato === 'assente') voce.riepilogo.assenze++
      else if (stato === 'ritardo') voce.riepilogo.ritardi++
    }

    const righe = [...perAlunno.values()].sort((a, b) =>
      `${a.cognome} ${a.nome}`.localeCompare(`${b.cognome} ${b.nome}`)
    )

    const { t, etichette: labels } = await etichette(q.data.locale, year, month, sezione)
    // La carta intestata reale sotto ogni pagina: il motore impagina il solo contenuto,
    // dentro le due colonne che la carta girata lascia libere (245 mm su 297).
    const pdf = await applicaCartaIntestata(
      buildRegistroPresenzePdf({ giorni, righe, etichette: labels })
    )

    // Un evento critico logga anche il SUCCESSO: senza, «nessun log» non distingue «il
    // registro esce» da «non l'ha mai stampato nessuno» — ed è l'ambiguità che ha nascosto
    // per mesi il guasto delle email. Il canale è `registro`, che è in `EVENTI_PERSISTITI`:
    // gli `info` arrivano in tabella e la domanda «questo mese qualcuno ha stampato il
    // registro?» ha una risposta in SQL. Nessun dato personale: conteggi e numeri.
    logEvento('registro', 'info', {
      operazione: 'admin/registro-presenze/pdf:GET',
      esito: 'generato',
      anno: year,
      mese: month,
      alunni: righe.length,
      byte: pdf.byteLength,
    })

    const nomeFile = `${nomeFileSicuro([
      t('pdfPrefissoFile'),
      sezione,
      nomeMese(q.data.locale, year, month).toLowerCase(),
      String(year),
    ])}.pdf`

    return new NextResponse(new Uint8Array(pdf), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${nomeFile}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    logErrore({ operazione: 'admin/registro-presenze/pdf:GET', stato: 500 }, err)
    return NextResponse.json(
      { error: 'Errore interno del server.', codice: 'REGISTRO_NON_GENERATO' },
      { status: 500 }
    )
  }
})
