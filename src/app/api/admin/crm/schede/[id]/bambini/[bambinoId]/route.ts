import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/server-client'
import { assertSchedaInScope, requireCrm } from '@/lib/crm/accesso'
import { rispostaErroreDb } from '@/lib/crm/errori'
import { registraEvento } from '@/lib/crm/eventi'
import { ANNI_INGRESSO, ESITI_BAMBINO, MOTIVI_PERDITA } from '@/lib/crm/tipi'
import { withRoute } from '@/lib/logging/with-route'
import { zDataYMD, zUuid } from '@/lib/validation/common'
import { parseBody, parseData } from '@/lib/validation/http'

/**
 * CRM della segreteria · un bambino della scheda: nome, nascita, anno ed ESITO.
 *
 * `PATCH /api/admin/crm/schede/[id]/bambini/[bambinoId]` → `200 { id, modificato }`.
 *
 * ⚠️ La QUOTA non si segna più da qui (dal 31/10/2026): la vecchia spunta `quotaSaldata`/`quotaSaldataIl`
 * è stata sostituita dalla quota con importo, metodo e giorno (`PUT …/quota`), che passa in contabilità.
 * Il corpo di un vecchio client con la sola spunta non scrive niente: i campi sono ignorati, il corpo
 * resta «vuoto» e la risposta è 400.
 *
 * ── L'esito ─────────────────────────────────────────────────────────────────────────────────────
 *  · «perso» richiede il motivo (422 `MOTIVO_OBBLIGATORIO`): «non si è iscritto» senza il perché è
 *    un numero che nessuno saprà più leggere;
 *  · uscendo da «perso» il motivo e la nota si svuotano: non restano a descrivere un esito che non c'è più;
 *  · ogni cambio d'esito fatto da qui è MANUALE: `esito_origine`, `esito_da` (chi) ed `esito_il` (quando)
 *    lo dicono. Il piano li prescrive per «iscritto»; li scrivo per ogni cambio perché altrimenti, dopo
 *    un «iscritto» arrivato in automatico dal collegamento alla domanda e poi corretto a mano in «ci
 *    pensa», la riga continuerebbe a dire `automatico` per un esito che l'ha messo una persona.
 *  · un motivo di perdita su un bambino che non è (e non diventa) «perso» è 409 `STATO_NON_AMMESSO`.
 *
 * ── Il salvataggio è condizionato all'esito che si è letto ─────────────────────────────────────
 * L'update porta `.eq('esito', <quello letto>)`: se nel frattempo il collegamento automatico alla
 * domanda (Sessione 4) o un'altra persona lo ha cambiato, l'update non colpisce nessuna riga e la
 * risposta è 409 `STATO_NON_AMMESSO` — non una sovrascrittura silenziosa.
 *
 * ── Lo storico ──────────────────────────────────────────────────────────────────────────────────
 * `esito_cambiato` ({ bambino_id, da, a }) e `bambino_modificato` ({ bambino_id, campi }, i soli NOMI dei
 * campi). Mai nomi di minori né note.
 */

const OPERAZIONE = 'admin/crm/schede/[id]/bambini/[bambinoId]:PATCH'

const dataOppureNulla = z.preprocess((v) => (v === '' ? null : v), z.union([zDataYMD, z.null()]).optional())

const patchBodySchema = z
  .object({
    nome: z.string().trim().min(1).max(100).optional(),
    dataNascita: dataOppureNulla,
    annoIngresso: z.enum(ANNI_INGRESSO).optional(),
    esito: z.enum(ESITI_BAMBINO).optional(),
    motivoPerdita: z.enum(MOTIVI_PERDITA).nullable().optional(),
    motivoNota: z
      .union([z.string().max(500), z.null()])
      .optional()
      .transform((v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v)),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Nessun campo da modificare' })

const nonTrovato = () => NextResponse.json({ error: 'Scheda non trovata.', codice: 'SCHEDA_NON_TROVATA' }, { status: 404 })
const statoNonAmmesso = () =>
  NextResponse.json(
    { error: 'Questa operazione non è possibile nello stato attuale.', codice: 'STATO_NON_AMMESSO' },
    { status: 409 },
  )

export const PATCH = withRoute(
  'admin/crm/schede/[id]/bambini/[bambinoId]:PATCH',
  async (request: NextRequest, context: { params: Promise<{ id: string; bambinoId: string }> }) => {
    const auth = await requireCrm(request)
    if (auth.response) return auth.response

    const parametri = await context.params
    const idP = parseData(zUuid, parametri.id)
    if ('response' in idP) return idP.response
    const bambinoP = parseData(zUuid, parametri.bambinoId)
    if ('response' in bambinoP) return bambinoP.response
    const body = await parseBody(request, patchBodySchema)
    if ('response' in body) return body.response
    const b = body.data

    const supabase = await createAdminClient()
    const ambito = await assertSchedaInScope(supabase, auth.user, idP.data)
    if ('response' in ambito) return ambito.response
    const { id: schedaId, scuola_id: scuolaId } = ambito.scheda
    const bambinoId = bambinoP.data

    const { data: corrente, error: erroreLettura } = await supabase
      .from('crm_bambini')
      .select('*')
      .eq('id', bambinoId)
      .eq('scheda_id', schedaId)
      .eq('scuola_id', scuolaId)
      .maybeSingle()
    if (erroreLettura) return rispostaErroreDb(erroreLettura, OPERAZIONE)
    if (!corrente) return nonTrovato()

    const esitoAttuale = corrente.esito as string
    const cambiaEsito = b.esito !== undefined && b.esito !== esitoAttuale
    const esitoFinale = b.esito ?? esitoAttuale

    const patch: Record<string, string | boolean | null> = {}
    const campiModificati: string[] = []

    // nome · nascita · anno: i campi anagrafici, nell'ordine in cui entrano nello storico
    if (b.nome !== undefined && b.nome !== corrente.nome) {
      patch.nome = b.nome
      campiModificati.push('nome')
    }
    if (b.dataNascita !== undefined && b.dataNascita !== ((corrente.data_nascita as string | null) ?? null)) {
      patch.data_nascita = b.dataNascita
      campiModificati.push('data_nascita')
    }
    if (b.annoIngresso !== undefined && b.annoIngresso !== corrente.anno_ingresso) {
      patch.anno_ingresso = b.annoIngresso
      campiModificati.push('anno_ingresso')
    }

    // esito e motivo
    if (esitoFinale === 'perso') {
      const motivo = b.motivoPerdita !== undefined ? b.motivoPerdita : ((corrente.motivo_perdita as string | null) ?? null)
      // Il motivo si pretende quando l'esito CAMBIA o quando lo si tocca: un bambino «perso» di prima, senza
      // motivo, non impedisce di correggerne il nome.
      if (motivo === null && (cambiaEsito || b.motivoPerdita !== undefined)) {
        return NextResponse.json(
          { error: 'Indica il motivo.', codice: 'MOTIVO_OBBLIGATORIO' },
          { status: 422 },
        )
      }
      if (b.motivoPerdita !== undefined && b.motivoPerdita !== ((corrente.motivo_perdita as string | null) ?? null)) {
        patch.motivo_perdita = b.motivoPerdita
        if (!cambiaEsito) campiModificati.push('motivo_perdita')
      }
      if (b.motivoNota !== undefined && b.motivoNota !== ((corrente.motivo_nota as string | null) ?? null)) {
        patch.motivo_nota = b.motivoNota
        if (!cambiaEsito) campiModificati.push('motivo_nota')
      }
    } else {
      // Un motivo di perdita su un bambino che non è «perso»: l'operazione non ha senso nello stato attuale.
      if ((b.motivoPerdita ?? null) !== null || (b.motivoNota ?? null) !== null) return statoNonAmmesso()
      if (cambiaEsito && esitoAttuale === 'perso') {
        patch.motivo_perdita = null
        patch.motivo_nota = null
      }
    }
    if (cambiaEsito) {
      patch.esito = esitoFinale
      patch.esito_origine = 'manuale'
      patch.esito_da = auth.user.id
      patch.esito_il = new Date().toISOString()
    }

    // niente di davvero cambiato: nessuna scrittura, nessuna riga di storico
    if (Object.keys(patch).length === 0) return NextResponse.json({ id: bambinoId, modificato: false })

    const { data: scritte, error: erroreScrittura } = await supabase
      .from('crm_bambini')
      .update({ ...patch, aggiornata_il: new Date().toISOString() })
      .eq('id', bambinoId)
      .eq('scheda_id', schedaId)
      .eq('scuola_id', scuolaId)
      .eq('esito', esitoAttuale)
      .select('id')
    if (erroreScrittura) return rispostaErroreDb(erroreScrittura, OPERAZIONE)
    if (!scritte || scritte.length === 0) return statoNonAmmesso()

    const evento = { schedaId, scuolaId, autore: auth.user.id, autoreVia: 'segreteria' } as const
    if (cambiaEsito) {
      await registraEvento(supabase, {
        ...evento,
        tipo: 'esito_cambiato',
        dati: { bambino_id: bambinoId, da: esitoAttuale, a: esitoFinale },
      })
    }
    if (campiModificati.length > 0) {
      await registraEvento(supabase, {
        ...evento,
        tipo: 'bambino_modificato',
        dati: { bambino_id: bambinoId, campi: campiModificati.join(',') },
      })
    }

    return NextResponse.json({ id: bambinoId, modificato: true })
  },
)
