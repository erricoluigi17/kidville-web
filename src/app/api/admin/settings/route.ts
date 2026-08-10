import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff, type AppUser } from '@/lib/auth/require-staff'
import { resolveScuolaScrittura, resolveScuoleAttive } from '@/lib/auth/scope'
import { parseBody, parseQuery } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
/**
 * scuola_id opzionale: qualunque valore falsy ('', null, assente) viene trattato
 * come "non fornito" così la scuola viene risolta dallo scope reale dell'admin
 * (resolveScuolaScrittura), usando l'eventuale scuola_id come sede preferita.
 */
const zScuolaId = z.preprocess((v) => v || undefined, zUuid.optional())

const getQuerySchema = z.object({ scuola_id: zScuolaId })

// Campi ammessi nel PATCH (upsert selettivo). Oggi sono accettati senza vincoli
// di tipo (tipi/CHECK li fa rispettare il DB): schema volutamente permissivo
// (z.unknown().optional() — l'.optional() è OBBLIGATORIO: in zod v4 z.unknown()
// nudo renderebbe la chiave required a runtime).
const ALLOWED_FIELDS = [
  'retta_default_importo',
  'retta_giorno_scadenza',
  'retta_giorno_visibilita',
  'retta_auto_enabled',
  'insoluto_tolleranza_giorni',
  'ticket_pacchetti',
  // `fattura_causale_template` NON è più ammesso, ed è la chiusura del difetto, non una
  // svista: era un modello unico per tutta la scuola che questa route accettava e
  // scriveva davvero in colonna, mentre l'emissione della fattura non lo leggeva mai.
  // La causale della fattura si configura per tipologia di pagamento e vive in
  // `fattura_causali_config` (vedi `@/lib/pagamenti/causale-fattura`). Una PATCH che lo
  // porti ancora viene semplicemente ignorata da zod: nessun campo scritto e poi
  // scartato, che è esattamente ciò che rendeva il difetto invisibile.
  'mensa_cutoff_ora',
  'mensa_giorni_attivi',
  'mensa_settimane_rotazione',
  'mensa_soglia_saldo_basso',
  'timelock_giorni_classe_orale',
  'timelock_giorni_scritto_pratico',
  'notif_buffer_valutazioni_min',
  'funzioni_matrice',
  'diario_config',
  'presenze_config',
  'note_config',
  'avvisi_config',
  'chat_config',
  'galleria_config',
  'armadietto_config',
  'modulistica_config',
  'segreteria_config',
  'fiscale_config',
  'solleciti_config',
  'notifiche_config',
  'rette_config',
  'causali_config',
  'fattura_causali_config',
  'cassa_config',
] as const

/**
 * I due JSONB dei modelli di causale (bonifico e fattura): stessa forma FLAT
 * (`{ default?, <slug-categoria>: }`) e quindi stesse regole di salvataggio.
 * Elencarli qui invece di ripetere un `if` per ciascuno è ciò che impedisce alla
 * gemella di nascere già priva del filtro sulle stringhe vuote.
 */
const CHIAVI_CAUSALI = ['causali_config', 'fattura_causali_config'] as const

/**
 * Colonne JSONB nate DOPO il baseline del DB E2E della CI, che non è migrato: là non
 * esistono, e PostgREST lo dice in due dialetti diversi — `PGRST204` quando si prova a
 * SCRIVERLE, `42703` quando si prova a LEGGERLE.
 */
const COLONNE_RECENTI: readonly string[] = ['rette_config', ...CHIAVI_CAUSALI]

/** Codice Postgres di «colonna inesistente», come arriva da PostgREST su una SELECT. */
const COLONNA_INESISTENTE = '42703'

/**
 * Legge i valori ATTUALI delle sole colonne JSONB in arrivo, per lo shallow-merge.
 *
 * Perché non è un `const { data } = await …`: PostgREST NON LANCIA (AGENTS.md, regola 7).
 * Se la SELECT fallisce, `data` è `null`, e senza guardare `error` il merge ripartirebbe
 * da `{}` per TUTTE le chiavi della stessa PATCH — riscrivendo la configurazione da zero
 * mentre l'utente crede di aggiornarne un pezzo, e senza una riga di log. Non è teorico:
 * basta UNA colonna mancante perché PostgREST faccia fallire l'INTERA select, comprese
 * le colonne che esistono.
 *
 * DEGRADAZIONE su `42703`. PostgREST non dice QUALE colonna manca, quindi non si può
 * indovinare: si rilegge **una colonna per volta**. Quelle che esistono conservano il
 * loro pregresso, quelle che non esistono valgono `{}` — che per una colonna inesistente
 * è la verità, non una perdita. Costa N interrogazioni, ma solo su un database in ritardo
 * di migrazioni: in produzione la prima select riesce e il ramo non viene mai percorso.
 * Filtrare per `COLONNE_RECENTI` invece di sondare NON basterebbe, ed è il motivo per cui
 * non si fa: `causali_config` è essa stessa recente, e una PATCH che porti insieme le due
 * chiavi delle causali su un DB dove solo la prima esiste tornerebbe a partire da `{}`
 * proprio per quella che c'era.
 *
 * @returns la riga letta (`{}` se la scuola non ne ha ancora una), oppure `null` se la
 *          lettura è fallita per un motivo che non sappiamo degradare: chi chiama deve
 *          FERMARSI, non proseguire come se il salvato fosse vuoto.
 */
async function leggiPregressoJsonb(
  supabase: SupabaseClient,
  scuolaId: string,
  colonne: string[],
): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from('admin_settings')
    .select(colonne.join(','))
    .eq('scuola_id', scuolaId)
    .maybeSingle()
  if (!error) return (data ?? {}) as Record<string, unknown>

  if (error.code !== COLONNA_INESISTENTE) {
    logEvento('config', 'error', {
      operazione: 'admin/settings:PATCH',
      esito: 'lettura-pregresso-fallita',
      error_code: error.code ?? null,
      n: colonne.length,
      stato: 500,
    }, error)
    return null
  }

  // Una sola colonna, e non esiste: niente da conservare.
  if (colonne.length === 1) {
    logEvento('config', 'warn', {
      operazione: 'admin/settings:PATCH',
      esito: 'lettura-pregresso-colonna-inesistente',
      error_code: error.code,
      recente: COLONNE_RECENTI.includes(colonne[0]),
      stato: 200,
    })
    return {}
  }

  logEvento('config', 'warn', {
    operazione: 'admin/settings:PATCH',
    esito: 'lettura-pregresso-ritento-per-colonna',
    error_code: error.code,
    n: colonne.length,
    stato: 200,
  })
  const riga: Record<string, unknown> = {}
  for (const c of colonne) {
    const parziale = await leggiPregressoJsonb(supabase, scuolaId, [c])
    if (parziale === null) return null
    Object.assign(riga, parziale)
  }
  return riga
}

// Configurazione rette (sconto fratelli + pro-rata iscrizione) — shape S6.
// Validazione conservativa: la shape è quella di `@/lib/pagamenti/rette-config`.
// zod scarta le chiavi ignote; i valori vengono comunque risanificati dalla SQL
// (`genera_rette_mensili` v2) e dal client (`normalizzaRetteConfig`).
const zScaglioneFratelli = z.object({
  posizione: z.coerce.number().int().min(2).max(50),
  valore: z.coerce.number().min(0).max(1_000_000),
})
const zScaglioneProRata = z.object({
  dal_giorno: z.coerce.number().int().min(1).max(31),
  percentuale: z.coerce.number().min(0).max(100),
})
const zRetteConfig = z.object({
  sconto_fratelli: z
    .object({
      enabled: z.boolean().optional(),
      modo: z.enum(['percentuale', 'importo']).optional(),
      scaglioni: z.array(zScaglioneFratelli).max(50).optional(),
    })
    .optional(),
  pro_rata_iscrizione: z
    .object({
      enabled: z.boolean().optional(),
      scaglioni: z.array(zScaglioneProRata).max(31).optional(),
    })
    .optional(),
})

const patchBodySchema = z.object({
  scuola_id: zScuolaId,
  ...Object.fromEntries(ALLOWED_FIELDS.map((f) => [f, z.unknown().optional()])),
  // Override della validazione permissiva: rette_config ha una shape nota.
  rette_config: zRetteConfig.optional(),
})

/**
 * La sede DICHIARATA dal client si VALIDA, non si ripiega.
 *
 * `admin_settings` ha UNA riga per sede: qui si decide quale plesso si sta
 * configurando. `resolveScuolaScrittura` però ignora una `preferita` fuori scope
 * e passa al ramo successivo, che per chi ha un solo plesso risponde sempre:
 * `scuola_id` di un'altra sede non veniva rifiutato, veniva **sostituito in
 * silenzio**. Chi credeva di configurare Aversa configurava Giugliano — con
 * `avvisi_config`, `presenze_config`, `chat_config` questo significa cambiare i
 * permessi del plesso sbagliato senza vederlo. Sede nominata e non attiva ⇒ 403.
 *
 * Il confronto è con `resolveScuoleAttive` (accessibili ∩ SedeSelector): questi
 * pannelli girano dentro `SedeRequired`, che manda esattamente la sede
 * selezionata, e scrivere su una sede appena tolta dal selettore è
 * indistinguibile dal difetto che si sta chiudendo.
 *
 * NB: gemella della funzione omonima in `admin/settings/categorie/route.ts`. Non
 * è ancora un helper condiviso di proposito — `@/lib/auth/scope.ts` è in mano ad
 * altri in questo ciclo; l'estrazione è annotata per il consolidamento finale.
 */
async function sedeDichiarataFuoriScope(
  request: NextRequest,
  supabase: SupabaseClient,
  user: AppUser,
  dichiarata: string | undefined,
  operazione: string,
): Promise<NextResponse | null> {
  if (!dichiarata) return null
  const sedi = await resolveScuoleAttive(request, supabase, user)
  if (sedi.includes(dichiarata)) return null
  // `warn` → persistito: una sede nominata e non posseduta è un segnale, non rumore.
  logEvento('multi_sede', 'warn', {
    tipo: 'sede-dichiarata-fuori-scope', azione: operazione,
    utente: user.id, ruolo: user.role, attive: sedi.length,
  })
  return rifiutoSede('SEDE_NON_ACCESSIBILE')
}

// GET /api/admin/settings?userId=&scuola_id=  (staff) — impostazioni della scuola
export const GET = withRoute('admin/settings:GET', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request)
      if (auth.response) return auth.response

      const q = parseQuery(request, getQuerySchema)
      if ('response' in q) return q.response

      const supabase = await createAdminClient()
      const dichiarata = (q.data.scuola_id as string | undefined) ?? undefined
      const fuori = await sedeDichiarataFuoriScope(request, supabase, auth.user, dichiarata, 'admin/settings:GET')
      if (fuori) return fuori
      const sw = await resolveScuolaScrittura(request, supabase, auth.user, dichiarata)
      if (sw.response) return sw.response
      const scuolaId = sw.scuolaId as string

      const { data, error } = await supabase
        .from('admin_settings')
        .select('*')
        .eq('scuola_id', scuolaId)
        .maybeSingle()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })

      // default se non esiste ancora
      const settings = data ?? {
        scuola_id: scuolaId,
        retta_default_importo: 150,
        retta_giorno_scadenza: 5,
        retta_giorno_visibilita: 25,
        retta_auto_enabled: true,
        insoluto_tolleranza_giorni: 7,
        ticket_pacchetti: [],
        aruba_config: {},
        mensa_cutoff_ora: '09:30',
        mensa_giorni_attivi: [1, 2, 3, 4, 5],
        mensa_settimane_rotazione: 4,
        mensa_soglia_saldo_basso: 5,
      }
      return NextResponse.json({ success: true, data: settings })
    } catch (err) {
      logErrore({ operazione: 'admin/settings:GET', stato: 500 }, err)
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
})

// PATCH /api/admin/settings  (staff) — upsert impostazioni
// Body: { userId, scuola_id?, retta_default_importo?, retta_giorno_scadenza?,
//         retta_auto_enabled?, insoluto_tolleranza_giorni?, ticket_pacchetti? }
// NB: aruba_config si gestisce dalla route dedicata /api/admin/settings/aruba
export const PATCH = withRoute('admin/settings:PATCH', async (request: NextRequest) => {
    try {
      const auth = await requireStaff(request)
      if (auth.response) return auth.response

      const b = await parseBody(request, patchBodySchema)
      if ('response' in b) return b.response
      const body = b.data as Record<string, unknown>

      const supabase = await createAdminClient()
      const dichiarata = (body.scuola_id as string | undefined) ?? undefined
      const fuori = await sedeDichiarataFuoriScope(request, supabase, auth.user, dichiarata, 'admin/settings:PATCH')
      if (fuori) return fuori
      const sw = await resolveScuolaScrittura(request, supabase, auth.user, dichiarata)
      if (sw.response) return sw.response
      const scuolaId = sw.scuolaId as string

      // Chiavi JSONB salvate in shallow-merge con l'esistente, così pannelli
      // diversi possono salvare indipendentemente senza sovrascriversi.
      const mergedKeys = [
        'funzioni_matrice',
        'diario_config',
        'presenze_config',
        'note_config',
        'avvisi_config',
        'chat_config',
        'galleria_config',
        'armadietto_config',
        'modulistica_config',
        'segreteria_config',
        'fiscale_config',
        'solleciti_config',
        'notifiche_config',
        'rette_config',
        ...CHIAVI_CAUSALI,
        'cassa_config',
      ]
      const updates: Record<string, unknown> = { scuola_id: scuolaId }
      for (const f of ALLOWED_FIELDS) if (body[f] !== undefined) updates[f] = body[f]

      const incomingMerged = mergedKeys.filter((k) => updates[k] !== undefined)
      if (incomingMerged.length > 0) {
        const existingRow = await leggiPregressoJsonb(supabase, scuolaId, incomingMerged)
        // Lettura fallita e non degradabile: si RIFIUTA la PATCH. Proseguire vorrebbe
        // dire riscrivere ogni chiave JSONB partendo da `{}`, cioè cancellare la
        // configurazione esistente credendo di aggiornarla.
        if (existingRow === null) {
          return NextResponse.json(
            {
              error: 'Impossibile rileggere le impostazioni già salvate: non è stato salvato niente',
              codice: 'CONFIG_PREGRESSO_NON_LETTO',
            },
            { status: 500 },
          )
        }
        for (const k of incomingMerged) {
          const prev = (existingRow[k] ?? {}) as Record<string, unknown>
          const next = updates[k] as Record<string, unknown>
          if (k === 'funzioni_matrice') {
            // merge per-grado: {primaria: {...prev, ...next}, ...}
            const merged: Record<string, unknown> = { ...prev }
            for (const grado of Object.keys(next)) {
              merged[grado] = {
                ...((prev[grado] as Record<string, unknown>) ?? {}),
                ...((next[grado] as Record<string, unknown>) ?? {}),
              }
            }
            updates[k] = merged
          } else {
            updates[k] = { ...prev, ...next }
            if ((CHIAVI_CAUSALI as readonly string[]).includes(k)) {
              // Solo stringhe NON vuote: una stringa vuota = reset al Predefinito
              // (si rimuove la chiave — lo shallow-merge da solo non potrebbe), e
              // nessun valore non-stringa (che farebbe esplodere renderCausale → 500).
              updates[k] = Object.fromEntries(
                Object.entries(updates[k] as Record<string, unknown>)
                  .filter(([, val]) => typeof val === 'string' && (val as string).trim() !== ''),
              )
            }
          }
        }
      }
      let { data, error } = await supabase
        .from('admin_settings')
        .upsert(updates, { onConflict: 'scuola_id' })
        .select()
        .single()

      // Degradazione: sul DB E2E CI (NON migrato) alcune colonne JSONB recenti
      // (rette_config, causali_config, fattura_causali_config) non esistono ancora →
      // PostgREST risponde PGRST204. Si rimuovono e si ritenta, salvando tutto il resto
      // best-effort (il flusso base resta invariato) con un warn. In produzione le
      // colonne esistono, quindi questo ramo non scatta mai. L'elenco è quello di
      // `COLONNE_RECENTI`, condiviso con la degradazione in LETTURA (`42703`).
      if (error && error.code === 'PGRST204' && COLONNE_RECENTI.some((c) => c in updates)) {
        logEvento('config', 'warn', {
          operazione: 'admin/settings:PATCH',
          esito: 'colonna_recente_non_disponibile_pgrst204',
          stato: 200,
        })
        const ridotto = { ...updates }
        for (const c of COLONNE_RECENTI) delete ridotto[c]
        ;({ data, error } = await supabase
          .from('admin_settings')
          .upsert(ridotto, { onConflict: 'scuola_id' })
          .select()
          .single())
      }
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })

      return NextResponse.json({ success: true, data })
    } catch (err) {
      logErrore({ operazione: 'admin/settings:PATCH', stato: 500 }, err)
      return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
    }
})
