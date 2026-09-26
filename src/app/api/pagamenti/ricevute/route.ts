import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { parseQuery } from '@/lib/validation/http'
import { resolveScuoleAttive } from '@/lib/auth/scope'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { aBlocchi, ID_PER_QUERY } from '@/lib/db/blocchi'

const getQuerySchema = z.object({
  anno: z.coerce.number().int().min(2000).max(2100).optional(),
})

// Registro/colonne assenti (DB e2e CI non migrato) → lista vuota, mai crash.
const SCHEMA_MANCANTE = new Set(['42P01', '42703', 'PGRST204', 'PGRST205'])

// Con più sedi il registro mescola numerazioni diverse: il numero è UNIQUE per
// (scuola_id, anno, numero), quindi "n. 7/2026" esiste una volta PER SEDE. Ogni riga
// porta con sé scuola_id e il nome della sede (FK ricevute_emesse_scuola_id_fkey →
// schools), altrimenti due ricevute con lo stesso numero sono indistinguibili.
//
// 🔴 L'alunno NON si incorpora: su `ricevute_emesse.alunno_id` non esiste alcuna FK
// (20260710130000 la dichiara `uuid` senza REFERENCES; misurato su pg_constraint il
// 2026-09-26). L'embed `alunni:alunno_id ( nome, cognome )` che c'era prima faceva
// rispondere PostgREST con PGRST200 a OGNI apertura del registro: 14 occorrenze a 500 in
// app_log, l'ultima il 2026-09-23. Si legge `alunno_id` e i nomi arrivano da `alunni`
// con una seconda query (vedi la lettura a blocchi di `alunni` più sotto, nella GET, che
// riempie la mappa `nomi` passata a `perContratto`).
const COLONNE_BASE =
  'id, pagamento_id, scuola_id, alunno_id, numero, anno, importo, periodo_competenza, metodi, tracciabile, bollo, ' +
  'annullata_il, annullo_motivo, creato_il'
const COLONNE = `${COLONNE_BASE}, schools:scuola_id ( nome )`

// ⚠️ `PGRST200` — «Could not find a relationship … in the schema cache». L'embed `schools`
// dipende dalla FK `ricevute_emesse_scuola_id_fkey`: sul DB E2E della CI, non migrato, la
// tabella c'è ma «mancheranno solo i vincoli» (20260731122800_fk_scuola_id.sql). NON lo si
// mette in SCHEMA_MANCANTE, che svuoterebbe un registro che esiste: si rifà la stessa query
// senza l'embed della sede e si risponde con `scuola_nome: null`.
// Il ripiego scatta SOLO se il PGRST200 riguarda la sede. PostgREST nomina nel messaggio la
// colonna dell'embed («… between 'ricevute_emesse' and 'scuola_id' …»), non l'alias: si
// accettano entrambe. Un PGRST200 su qualunque altra relazione è un difetto della route e va
// al 500, senza un warn che dia la colpa alla tabella sbagliata.
const RELAZIONE_SEDE = /'(schools|scuola_id)'/

type ErrorePg = { code?: string; message?: string; details?: string | null }
function relazioneSedeAssente(error: ErrorePg | null): boolean {
  if (error?.code !== 'PGRST200') return false
  return RELAZIONE_SEDE.test(`${error.message ?? ''} ${error.details ?? ''}`)
}

type Uno<T> = T | T[] | null | undefined
const primo = <T,>(v: Uno<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

type NomeAlunno = { nome: string | null; cognome: string | null }
type RigaRicevuta = Record<string, unknown> & {
  alunno_id?: string | null
  schools?: Uno<{ nome: string | null }>
}

/**
 * Forma del contratto: l'embed grezzo `schools` diventa `scuola_nome`, e `alunno_id` diventa
 * `alunni: { nome, cognome } | null` (la stessa forma che aveva l'embed di prima).
 */
function perContratto({ schools, alunno_id, ...resto }: RigaRicevuta, nomi: Map<string, NomeAlunno>) {
  return {
    ...resto,
    scuola_nome: primo(schools)?.nome ?? null,
    alunni: (alunno_id && nomi.get(alunno_id)) || null,
  }
}

// GET /api/pagamenti/ricevute?anno=&userId= — registro ricevute emesse (staff).
// Include le annullate (numero bruciato + motivo): il registro resta coerente.
export const GET = withRoute('pagamenti/ricevute:GET', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request)
    if (auth.response) return auth.response
    const { user } = auth

    const q = parseQuery(request, getQuerySchema)
    if ('response' in q) return q.response

    const supabase = await createAdminClient()
    const sediAttive = await resolveScuoleAttive(request, supabase, user)

    // Un solo punto di uscita per gli errori di DB (registro e nomi degli alunni).
    const erroreDb = (err: unknown) => {
      logErrore({ operazione: 'pagamenti/ricevute:GET', stato: 500, evento: 'db' }, err)
      return NextResponse.json({ error: 'Errore nel recupero del registro ricevute' }, { status: 500 })
    }

    const leggi = (colonne: string) => {
      let query = supabase
        .from('ricevute_emesse')
        .select(colonne)
        .in('scuola_id', sediAttive)
        .order('anno', { ascending: false })
        .order('numero', { ascending: false })
        .limit(500)
      if (q.data.anno) query = query.eq('anno', q.data.anno)
      return query
    }

    let { data, error } = await leggi(COLONNE)
    if (relazioneSedeAssente(error)) {
      // `warn`, non `error`: il registro esce lo stesso, manca solo il nome della sede.
      // Muto no: senza questa riga «la colonna Sede è vuota» non ha spiegazione.
      logEvento(
        'db',
        'warn',
        { operazione: 'pagamenti/ricevute:GET', esito: 'sede-senza-nome-fk-assente' },
        error,
      )
      ;({ data, error } = await leggi(COLONNE_BASE))
    }
    if (error) {
      if (SCHEMA_MANCANTE.has(error.code ?? '')) {
        return NextResponse.json({ success: true, data: [], disponibile: false })
      }
      return erroreDb(error)
    }

    const righe = (data ?? []) as unknown as RigaRicevuta[]

    // Nomi degli alunni: seconda lettura, a blocchi (gli id vanno nell'URL di `.in()`).
    // Anche questa lettura dichiara la sua sede: un alunno oggi iscritto in una sede fuori
    // perimetro esce con `alunni: null` (la ricevuta resta, con numero e sede). Misurato il
    // 2026-09-26: 2 ricevute su 144 hanno l'alunno oggi in un'altra sede.
    const ids = [...new Set(righe.map((r) => r.alunno_id).filter((id): id is string => !!id))]
    const nomi = new Map<string, NomeAlunno>()
    for (const blocco of aBlocchi(ids, ID_PER_QUERY)) {
      const { data: alunni, error: errAlunni } = await supabase
        .from('alunni')
        .select('id, nome, cognome')
        .in('id', blocco)
        .in('scuola_id', sediAttive)
      if (errAlunni) return erroreDb(errAlunni)
      for (const a of (alunni ?? []) as { id: string; nome: string | null; cognome: string | null }[]) {
        nomi.set(a.id, { nome: a.nome, cognome: a.cognome })
      }
    }

    return NextResponse.json({ success: true, data: righe.map((r) => perContratto(r, nomi)) })
  } catch (err) {
    logErrore({ operazione: 'pagamenti/ricevute:GET', stato: 500 }, err)
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})
