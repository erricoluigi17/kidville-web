import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertSezioneInScope } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'

const ENTITA_TIPI = ['registro', 'valutazione', 'nota'] as const

/**
 * Le colonne che PostgREST può non conoscere: `sblocchi_audit` le riceve dalla
 * migrazione `…_sblocchi_audit_per_slot`, e il database E2E della CI è un
 * progetto separato che non viene migrato. Su un INSERT che le nomina risponde
 * `PGRST204`; `42703` è la forma che arriva da Postgres. Vedi il ripiego sotto.
 */
const COLONNA_ASSENTE = new Set(['PGRST204', '42703'])

/**
 * L'ora della campanella: lo stesso intervallo del vincolo
 * `registro_orario_ora_lezione_check` (1..8). Fuori da lì una lezione non esiste,
 * quindi non c'è niente da sbloccare: meglio un 400 qui che una riga d'audit che
 * autorizza uno slot impossibile — e che nessuno ricollegherebbe mai a un'ora vera.
 *
 * `coerce` perché il client manda il numero d'ordine della campanella talvolta
 * come stringa (`primaria/registro:POST` accetta entrambe le forme).
 */
const zOraLezione = z.coerce
  .number({ error: 'oraLezione non valida' })
  .int('oraLezione deve essere un numero intero')
  .min(1, 'oraLezione fuori dalla campanella (1..8)')
  .max(8, 'oraLezione fuori dalla campanella (1..8)')

// ─── Schemi di validazione input (M3) ────────────────────────────────────────
//
// DUE MODI DI INDIRIZZARE LO SBLOCCO, e sono alternativi:
//
//  · `entitaId`            → una riga che ESISTE già (registro firmato in ritardo
//                            da correggere, valutazione, nota);
//  · `sectionId+data+oraLezione` → uno SLOT, cioè un'ora che non è MAI stata
//                            firmata e che quindi una riga non ce l'ha.
//
// Il secondo caso è la ragione per cui questa route è stata riscritta: finché
// pretendeva `entitaId`, chi non aveva firmato in tempo non poteva più farlo
// (`primaria/registro:POST` risponde 423) e il dirigente non poteva autorizzarlo,
// perché l'uuid da sbloccare non esisteva. Il ciclo era chiuso.
const postBodySchemaBase = z.object({
  entitaTipo: z.enum(ENTITA_TIPI, { error: `entitaTipo in ${ENTITA_TIPI.join('/')}` }),
  entitaId: zUuid.optional(),
  sectionId: zUuid.optional(),
  data: zDataYMD.optional(),
  oraLezione: zOraLezione.optional(),
  motivazione: z.string().min(1, 'motivazione obbligatoria'),
})

const postBodySchema = postBodySchemaBase.superRefine((b, ctx) => {
  const slot = [b.sectionId, b.data, b.oraLezione]
  const pezziSlot = slot.filter((v) => v !== undefined).length
  if (b.entitaId && pezziSlot > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['entitaId'],
      message: 'Indica la riga (entitaId) OPPURE lo slot (sectionId+data+oraLezione), non entrambi',
    })
    return
  }
  if (!b.entitaId && pezziSlot === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['entitaId'],
      message: 'Indica la riga (entitaId) oppure lo slot (sectionId+data+oraLezione)',
    })
    return
  }
  if (!b.entitaId && pezziSlot < 3) {
    // Uno slot a metà è la richiesta più pericolosa che possa arrivare: «sblocca
    // quella classe», senza dire quando. Si rifiuta invece di indovinare.
    ctx.addIssue({
      code: 'custom',
      path: ['oraLezione'],
      message: 'Lo slot va indicato per intero: sectionId, data e oraLezione',
    })
    return
  }
  // Una valutazione e una nota non stanno in un'ora di lezione: hanno una riga o
  // non esistono. Accettare lo slot lì significherebbe scrivere un'autorizzazione
  // che nessuna route andrà mai a cercare.
  if (!b.entitaId && b.entitaTipo !== 'registro') {
    ctx.addIssue({
      code: 'custom',
      path: ['entitaTipo'],
      message: 'Lo sblocco per slot vale solo per il registro: per gli altri indica entitaId',
    })
  }
})

/** Le coordinate con cui il registro ritrova un'autorizzazione senza conoscere l'uuid. */
interface Slot {
  data: string
  oraLezione: number
}

/**
 * L'UNICA risposta di guasto di questa route: un `logErrore` solo, un corpo solo.
 *
 * Perché una funzione e non due `NextResponse.json` scritte accanto ai due punti
 * in cui si guasta: la prosa di PostgREST non deve MAI arrivare a chi sta
 * lavorando («Could not find the 'section_id' column of 'sblocchi_audit' in the
 * schema cache» è inglese, e racconta com'è fatto lo schema), e una regola scritta
 * in due posti diverge al primo ritocco. Il messaggio vero resta nel log, dove
 * serve, insieme all'`evento` che dice QUALE passo è caduto.
 *
 * `schemaIncompleto` separa due guasti che si somigliano e si curano in modo
 * opposto: uno **schema non aggiornato** non è un difetto del server ma una
 * funzione che su quel database non c'è ancora (il progetto E2E della CI non
 * viene migrato), e un 503 lo distingue dai 500 veri quando si contano in
 * `app_log`.
 */
function guasto(evento: string, err: unknown, schemaIncompleto = false): NextResponse {
  const stato = schemaIncompleto ? 503 : 500
  logErrore({ operazione: 'primaria/sblocca:POST', stato, evento }, err)
  return NextResponse.json(
    {
      error: schemaIncompleto
        ? "Sblocco di un'ora mai firmata non disponibile su questo ambiente: schema non aggiornato"
        : 'Sblocco non registrato',
    },
    { status: stato },
  )
}

// POST /api/primaria/sblocca?userId=
// Override del dirigente sul vincolo temporale. Riservato alla dirigenza
// (admin/coordinator). Registra la motivazione in `sblocchi_audit`.
// body: { entitaTipo, motivazione } + { entitaId } | { sectionId, data, oraLezione }
//
// ⚠️ VINCOLO DI RILASCIO — QUESTA ROUTE SCRIVE, E NON SI LEGGE DA SOLA.
// La riga d'audit ha un solo lettore in tutto il repo, ed è
// `primaria/registro:POST`. Finché quel lettore cerca l'override soltanto per
// `entita_id` (dentro `if (esistente)`), uno sblocco per SLOT risponde 200 e non
// sblocca niente: il dirigente legge «autorizzato» e la maestra continua a
// prendere 423. Un'operazione che dichiara successo senza fare nulla è il guasto
// che questo repo ha già pagato più volte, e qui sarebbe invisibile — nessun
// errore, nessun log, nessuna differenza per chi guarda.
// Il contratto fra le due route è collaudato in
// `__tests__/api/primaria-sblocco-slot-contratto-registro.test.ts`, che resta
// ROSSO finché il lettore per slot non esiste. **Non si rilascia questa route —
// né il bottone che la chiama — con quel test rosso.**
export const POST = withRoute('primaria/sblocca:POST', async (request: NextRequest) => {
  try {
    const auth = await requireStaff(request, ['admin', 'coordinator'])
    if (auth.response) return auth.response

    const b = await parseBody(request, postBodySchema)
    if ('response' in b) return b.response
    const { entitaTipo, entitaId, motivazione } = b.data

    const supabase = await createAdminClient()

    // ─── 1. Si risolve la SEZIONE (e, per il registro, lo slot) ──────────────
    // Lo scope si verifica PRIMA di scrivere audit o lock: niente sblocchi
    // cross-plesso, e niente righe d'audit su id inesistenti.
    let sectionId: string
    let slot: Slot | null = null

    if (entitaId) {
      const entitaTable =
        entitaTipo === 'registro' ? 'registro_orario' : entitaTipo === 'valutazione' ? 'valutazioni' : 'note_disciplinari'
      // Del registro servono anche le coordinate: registrandole nell'audit, il
      // registro ritrova l'autorizzazione con UNA sola interrogazione — per slot —
      // sia che la riga esistesse già, sia che non esista ancora.
      const colonne = entitaTipo === 'registro' ? 'id, section_id, data, ora_lezione' : 'id, section_id'
      // PostgREST NON lancia: senza questo controllo una lettura fallita sarebbe
      // indistinguibile da «entità inesistente», e il dirigente leggerebbe un 404
      // che gli dice di aver sbagliato lui.
      const { data: entita, error: letturaErr } = await supabase
        .from(entitaTable)
        .select(colonne)
        .eq('id', entitaId)
        .maybeSingle<{ id: string; section_id: string; data?: string; ora_lezione?: number }>()
      if (letturaErr) return guasto('sblocco_entita_non_letta', letturaErr)
      if (!entita) return NextResponse.json({ error: 'Entità da sbloccare non trovata' }, { status: 404 })
      sectionId = entita.section_id
      if (entitaTipo === 'registro' && entita.data && entita.ora_lezione != null) {
        slot = { data: entita.data, oraLezione: Number(entita.ora_lezione) }
      }
    } else {
      // Lo slot arriva dal corpo già validato: `superRefine` garantisce che i tre
      // pezzi ci siano tutti e che il tipo sia `registro`.
      sectionId = b.data.sectionId as string
      slot = { data: b.data.data as string, oraLezione: b.data.oraLezione as number }
    }

    const scopeErr = await assertSezioneInScope(supabase, auth.user, sectionId)
    if (scopeErr) return scopeErr

    // ─── 2. La riga d'audit ─────────────────────────────────────────────────
    const rigaAudit: Record<string, unknown> = {
      entita_tipo: entitaTipo,
      entita_id: entitaId ?? null,
      dirigente_id: auth.user.id,
      motivazione,
    }
    if (slot) {
      rigaAudit.section_id = sectionId
      rigaAudit.data = slot.data
      rigaAudit.ora_lezione = slot.oraLezione
    }

    let ins = await supabase.from('sblocchi_audit').insert(rigaAudit).select().single()

    // DEGRADAZIONE sul database non migrato (il progetto E2E della CI è separato
    // e non riceve le migrazioni): le tre colonne dello slot non esistono e
    // PostgREST risponde `PGRST204` nominandone una. Se c'è un `entitaId` si
    // riprova SENZA di esse — è esattamente lo sblocco di prima, e la forma
    // storica non deve regredire per una colonna che quel database non ha.
    if (ins.error && COLONNA_ASSENTE.has((ins.error as { code?: string }).code ?? '') && entitaId) {
      logEvento('registro', 'info', {
        operazione: 'primaria/sblocca:POST',
        esito: 'sblocco-colonne-slot-assenti-ripiego-riga',
        entita_tipo: entitaTipo,
      })
      ins = await supabase
        .from('sblocchi_audit')
        .insert({ entita_tipo: entitaTipo, entita_id: entitaId, dirigente_id: auth.user.id, motivazione })
        .select()
        .single()
    }

    if (ins.error) {
      // Qui ci arriva anche lo slot puro su un database non migrato: là il
      // ripiego non esiste, perché non c'è nessuna riga da indirizzare al posto
      // delle coordinate. Meglio un 503 dichiarato che un 200 che non ha
      // registrato niente — e che farebbe credere al dirigente di aver autorizzato.
      const schemaIncompleto = COLONNA_ASSENTE.has((ins.error as { code?: string }).code ?? '')
      return guasto(
        schemaIncompleto ? 'sblocco_schema_incompleto' : 'sblocco_non_registrato',
        ins.error,
        schemaIncompleto,
      )
    }

    // ─── 3. Il lock persistito ──────────────────────────────────────────────
    // Il blocco effettivo è calcolato in API (`isOltreScadenza`) e l'esistenza
    // della riga d'audit fa da override: azzerare `locked_il` è pulizia, non il
    // presidio. Un errore qui NON annulla lo sblocco — ma si logga, perché
    // resterebbe una riga marcata bloccata che nessuno riscriverà.
    const tabellaLock =
      entitaTipo === 'registro' ? 'registro_orario' : entitaTipo === 'valutazione' ? 'valutazioni' : null
    if (entitaId && tabellaLock) {
      const { error: lockErr } = await supabase.from(tabellaLock).update({ locked_il: null }).eq('id', entitaId)
      if (lockErr) {
        logEvento(
          'registro',
          'warn',
          {
            operazione: 'primaria/sblocca:POST',
            esito: 'lock-persistito-non-azzerato',
            entita_tipo: entitaTipo,
            sezione: sectionId,
          },
          lockErr,
        )
      }
    }

    // Il SUCCESSO si logga: `sblocchi_audit` conta 0 righe in produzione, quindi
    // «nessun log» oggi significa insieme «nessuno ha mai sbloccato niente» e «gli
    // sblocchi non partono» — l'ambiguità che questo repo ha già pagato una volta.
    // La MOTIVAZIONE non entra: è testo libero scritto su una classe di minori.
    logEvento('registro', 'info', {
      operazione: 'primaria/sblocca:POST',
      esito: 'sblocco-registrato',
      entita_tipo: entitaTipo,
      per_slot: !entitaId,
      sezione: sectionId,
      data: slot?.data ?? null,
      ordine: slot?.oraLezione ?? null,
      dirigente: auth.user.id,
    })

    return NextResponse.json({ success: true, data: ins.data })
  } catch (err) {
    logErrore({ operazione: 'primaria/sblocca:POST', stato: 500 }, err)
    const msg = err instanceof Error ? err.message : 'Errore interno'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
})
