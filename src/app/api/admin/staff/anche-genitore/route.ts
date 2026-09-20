import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { requireStaff } from '@/lib/auth/require-staff'
import { assertAlunnoInScope, assertUtenteInScope } from '@/lib/auth/scope'
import { parseBody } from '@/lib/validation/http'
import { zUuid } from '@/lib/validation/common'
import { withRoute } from '@/lib/logging/with-route'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { logScrittura } from '@/lib/audit/scrittura'
import { puoEliminareStaff } from '@/lib/personale/permessi-eliminazione'
import { linkOrCreateParent } from '@/lib/anagrafiche/parents'
import { RELAZIONI_FAMILIARI } from '@/lib/anagrafiche/legami-scrittura'

/**
 * ANCHE GENITORE — la maestra che ha un figlio iscritto qui.
 *
 * ─── PERCHÉ QUASI TUTTO ESISTE GIÀ ────────────────────────────────────────────
 *
 * Il doppio profilo NON va inventato: `CambiaProfiloMenuButton` (montato nei tre
 * menu), `areaForRole`/`risolviRuoloAttivo`, il cookie `kv-active-role` e la
 * guardia d'area lo reggono da mesi. E `getProfiliForAuthUid` lo deriva da un
 * fatto solo: esiste `parents.auth_user_id == auth.uid()`.
 *
 * Al 2026-09-20 dodici persone in produzione ce l'hanno già — tutte `educator`.
 * Questa rotta non aggiunge un meccanismo: aggiunge il COMANDO che oggi manca,
 * perché la strada esistente passa dalla scheda dell'alunno e chiede di «creare
 * un adulto nuovo» con l'email di uno che esiste già. Funziona, ma nessuno può
 * indovinarla.
 *
 * ─── PERCHÉ RIUSA `linkOrCreateParent` E NON SCRIVE `parents` DA SÉ ───────────
 *
 * Perché `parents.fiscal_code` e `parents.auth_user_id` sono entrambi UNIQUE, e
 * un `insert` cieco darebbe `23505` proprio nel caso più probabile: la persona
 * ha già una scheda d'anagrafica creata dall'import delle iscrizioni, con lo
 * stesso codice fiscale. `linkOrCreateParent` DEDUPLICA per CF e riusa quella
 * riga; `ensureParentIdentity`, che chiama a valle, ritrova l'`auth.users` dello
 * staff PER EMAIL e non tocca la riga `utenti` — quindi il ruolo di lavoro resta
 * quello che è. Nessuna email di credenziali parte: l'invio è condizionato alla
 * creazione di un account nuovo, e qui l'account c'è già.
 *
 * ─── IL FIGLIO SI PUÒ RIMANDARE ───────────────────────────────────────────────
 *
 * `alunnoId` è opzionale per scelta del titolare. Senza, la persona ottiene il
 * profilo e l'area famiglie resta VUOTA — non in errore:
 * `GET /api/parent/students` risponde 200 con `data: []`. È uno stato legittimo,
 * e il pannello lo dice invece di lasciarlo scoprire.
 */

const OPERAZIONE = 'admin/staff/anche-genitore:POST'

const postBodySchema = z.object({
  utenteId: zUuid,
  /** Opzionale: il legame col figlio si può creare adesso o dopo. */
  alunnoId: zUuid.optional(),
  relazione: z.enum(RELAZIONI_FAMILIARI).optional(),
})

export const POST = withRoute('admin/staff/anche-genitore:POST', async (request: NextRequest) => {
  const auth = await requireStaff(request)
  if (auth.response) return auth.response
  const b = await parseBody(request, postBodySchema)
  if ('response' in b) return b.response
  const { utenteId, alunnoId, relazione } = b.data

  try {
    const supabase = await createAdminClient()
    const fuoriScope = await assertUtenteInScope(supabase, auth.user, utenteId)
    if (fuoriScope) return fuoriScope
    // ⚠️ Il bambino ha il SUO gate: `assertUtenteInScope` guarda `utenti` e non
    // direbbe niente su un alunno di un altro plesso. Collegare come genitore
    // una persona a un bambino fuori sede è precisamente il modo in cui si apre
    // l'accesso alla scheda del figlio di qualcun altro.
    if (alunnoId) {
      const alunnoFuoriScope = await assertAlunnoInScope(supabase, auth.user, alunnoId)
      if (alunnoFuoriScope) return alunnoFuoriScope
    }

    const { data: bersaglio, error: errBersaglio } = await supabase
      .from('utenti')
      .select('id, nome, cognome, email, cellulare, ruolo, role, scuola_id')
      .eq('id', utenteId)
      .maybeSingle()
    if (errBersaglio) {
      logErrore({ operazione: OPERAZIONE, evento: 'lettura_bersaglio' }, errBersaglio)
      return risposta503()
    }
    const riga = bersaglio as {
      nome?: string | null
      cognome?: string | null
      email?: string | null
      cellulare?: string | null
      ruolo?: string | null
      role?: string | null
      scuola_id?: string | null
    } | null
    const ruoloGrezzo = riga?.ruolo ?? riga?.role ?? null

    const permesso = puoEliminareStaff(auth.user, utenteId, ruoloGrezzo)
    if (!permesso.consentito) {
      logEvento('auth', 'warn', {
        operazione: OPERAZIONE,
        esito: 'doppio-profilo-negato',
        tipo: permesso.motivo,
        ruolo: auth.user.role,
      })
      return rifiuto(permesso.motivo)
    }

    // Il ponte c'è già? Allora il profilo c'è già, e resta da fare solo il
    // legame col figlio — se è stato indicato. Rispondere «fatto» su un'azione
    // che non ha fatto niente sarebbe idempotenza, non silenzio.
    const { data: ponteEsistente, error: errPonte } = await supabase
      .from('parents')
      .select('id')
      .eq('auth_user_id', utenteId)
      .maybeSingle()
    if (errPonte) {
      logErrore({ operazione: OPERAZIONE, evento: 'lettura_ponte' }, errPonte)
      return risposta503()
    }

    // ⚠️ IL CODICE FISCALE SI PRENDE DAL FASCICOLO, quando c'è, e serve a UNA
    // cosa sola: far ritrovare a `linkOrCreateParent` la scheda d'anagrafica che
    // questa persona potrebbe già avere come genitore. Senza, si creerebbe un
    // DOPPIONE — ed è il difetto che questo repo ha già pagato sui bambini.
    const { data: fascicolo } = await supabase
      .from('anagrafica_personale')
      .select('utente_id, fiscal_code')
      .eq('utente_id', utenteId)
      .maybeSingle()
    const cf = (fascicolo as { fiscal_code?: string | null } | null)?.fiscal_code ?? null

    const esito = await linkOrCreateParent(supabase, auth.user, {
      studentId: alunnoId ?? null,
      payload: {
        first_name: riga?.nome ?? null,
        last_name: riga?.cognome ?? null,
        // `''` → `null`: `parents.fiscal_code` è UNIQUE, e una stringa vuota
        // ripetuta collide con sé stessa. È il difetto già commentato in
        // `src/lib/anagrafiche/parents.ts`.
        fiscal_code: cf && cf.trim() !== '' ? cf.trim() : null,
        email: riga?.email ?? null,
        phone: riga?.cellulare ?? null,
        role: relazione ?? 'delegate',
      },
    })

    await logScrittura(supabase, {
      attore: auth.user,
      entitaTipo: 'utente_staff',
      entitaId: utenteId,
      azione: 'update',
      scuolaId: riga?.scuola_id ?? null,
      valorePrima: { ponte_genitore: !!ponteEsistente },
      valoreDopo: {
        ponte_genitore: true,
        ruolo_staff_invariato: ruoloGrezzo,
        legame_creato: !!alunnoId,
      },
    })
    logEvento('anagrafica', 'warn', {
      operazione: OPERAZIONE,
      esito: 'staff-anche-genitore',
      entita_id: utenteId,
      sede_id: riga?.scuola_id ?? null,
      ruolo: ruoloGrezzo,
      gia_presente: !!ponteEsistente,
      con_figlio: !!alunnoId,
    })

    return NextResponse.json({
      success: true,
      data: {
        parentId: esito.parentId,
        ponteGiaPresente: !!ponteEsistente,
        legameCreato: !!alunnoId,
        // Senza figli collegati l'area famiglie è VUOTA, non rotta: il pannello
        // lo dice invece di lasciarlo scoprire a chi entra.
        areaFamigliaVuota: !alunnoId && !ponteEsistente,
      },
    })
  } catch (err) {
    logErrore({ operazione: OPERAZIONE, stato: 500 }, err)
    return NextResponse.json(
      { error: 'Non è stato possibile completare l’operazione', codice: 'PERSONALE_OPERAZIONE_NON_RIUSCITA' },
      { status: 500 },
    )
  }
})

function risposta503(): NextResponse {
  return NextResponse.json(
    { error: 'Una delle verifiche non è riuscita: niente è stato modificato', codice: 'STAFF_ELIMINAZIONE_NON_DECISA' },
    { status: 503 },
  )
}

function rifiuto(motivo: string): NextResponse {
  if (motivo === 'se-stessi') {
    return NextResponse.json(
      { error: 'Non puoi modificare i tuoi stessi profili', codice: 'STAFF_ELIMINAZIONE_SE_STESSI' },
      { status: 403 },
    )
  }
  if (motivo === 'bersaglio-direzione') {
    return NextResponse.json(
      { error: 'Gli account della Direzione non si modificano da qui', codice: 'STAFF_ELIMINAZIONE_BERSAGLIO_DIREZIONE' },
      { status: 403 },
    )
  }
  if (motivo === 'bersaglio-sconosciuto') {
    return NextResponse.json(
      { error: 'Non è stato possibile leggere questa persona', codice: 'STAFF_ELIMINAZIONE_NON_LETTA' },
      { status: 503 },
    )
  }
  return NextResponse.json(
    { error: 'Operazione riservata alla Direzione', codice: 'INCARICO_STAFF_RISERVATO' },
    { status: 403 },
  )
}
