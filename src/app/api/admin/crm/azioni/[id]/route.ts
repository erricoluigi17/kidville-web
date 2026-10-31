import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/require-staff'
import { formaConfronto } from '@/lib/auth/scope'
import { createAdminClient } from '@/lib/supabase/server-client'
import { assertPersonaInScope, assertSchedaInScope, requireCrm } from '@/lib/crm/accesso'
import { rispostaErroreDb } from '@/lib/crm/errori'
import { registraEvento } from '@/lib/crm/eventi'
import { pianificaAzione, prossimaAzione, scadenzaRoma } from '@/lib/crm/follow-up'
import {
  ESITI_AZIONE,
  MOTIVI_PERDITA,
  ORA_FOLLOW_UP,
  type AzioneRow,
  type EsitoBambino,
  type MotivoPerdita,
  type TipoAzione,
} from '@/lib/crm/tipi'
import { dataCivile } from '@/i18n/config'
import { oraCivile } from '@/lib/format/confini-giorno'
import { logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { parseBody, parseData } from '@/lib/validation/http'
import { zDataYMD, zOraHHMM, zUuid } from '@/lib/validation/common'

/**
 * CRM della segreteria · un richiamo: segnarlo fatto, spostarlo, cancellarlo.
 *
 * `PATCH /api/admin/crm/azioni/[id]` con `{ azione: 'fatta' | 'sposta' | 'cancella', … }`.
 *
 * ── LA SEDE ────────────────────────────────────────────────────────────────────────────────────────────────
 * L'azione si legge per id, e la sua scheda passa da `assertSchedaInScope` (404 se non c'è, 403 se è di
 * un'altra sede). Da lì in poi OGNI scrittura porta `.eq('scuola_id', <sede verificata>)` nella stessa
 * istruzione: la sede è quella della scheda (il database garantisce che una figlia non cambi sede), mai
 * quella «primaria» di chi chiama.
 *
 * ── «FATTA» È UN PASSAGGIO DI PROPRIETÀ, NON UN SALVATAGGIO ─────────────────────────────────────────────────
 * Due segretarie (o un doppio clic) che segnano lo stesso richiamo non devono far nascere due passi
 * successivi. La difesa non è la lettura di prima ("era già fatta?": fra la lettura e la scrittura c'è il
 * tempo di un'altra richiesta) ma la clausola dentro l'`update`: `.is('fatta_il', null)` e
 * `.is('cancellata_il', null)`. Chi trova zero righe ha perso la corsa: 409 `GIA_FATTA`, e **nessun passo
 * viene pianificato**. Tutto ciò che segue (storico, bambini, passo nuovo) lo fa solo chi ha vinto.
 *
 * L'ordine dopo la vittoria è: storico `azione_fatta` → bambini → passo nuovo. I bambini vengono PRIMA del
 * passo nuovo perché il loro cambio è idempotente (`aperto → ci_pensa`, `→ perso` solo da stati non
 * conclusi): se qualcosa va storto più avanti, rifare l'operazione non rompe niente.
 *
 * Dopo la vittoria niente si annulla più: la riga è fatta. Se il passo nuovo o i bambini non si scrivono,
 * il guasto è già nel log (`pianificaAzione`, `crm/azioni/[id]`) e il client lo riceve in `avvisi`, così la
 * segreteria sa di dover aggiungere il richiamo a mano invece di credere che la catena sia andata avanti.
 */

const paramsSchema = z.object({ id: zUuid })

const corpoSchema = z.discriminatedUnion('azione', [
  z.object({
    azione: z.literal('fatta'),
    esito: z.enum(ESITI_AZIONE),
    motivoPerdita: z.enum(MOTIVI_PERDITA).optional(),
    motivoNota: z.string().trim().max(500).optional(),
  }),
  z.object({
    azione: z.literal('sposta'),
    giorno: zDataYMD,
    ora: zOraHHMM.optional(),
    responsabile: zUuid.optional(),
  }),
  z.object({ azione: z.literal('cancella') }),
])
type Corpo = z.output<typeof corpoSchema>

const COLONNE_AZIONE =
  'id, scuola_id, scheda_id, tipo, scadenza, responsabile, appuntamento_id, esito, fatta_da, fatta_il, cancellata_il, cancellata_da, creata_il'

/** I bambini che un «non interessato» chiude: tutti quelli ancora in gioco. Gli iscritti e i persi restano. */
const DA_PERDERE: EsitoBambino[] = ['aperto', 'ci_pensa', 'lista_attesa']
/** Un «ci pensa» muove solo chi era ancora «aperto»: non declassa chi è già in lista d'attesa. */
const DA_PENSARCI: EsitoBambino[] = ['aperto']

type Avviso = 'PROSSIMA_NON_PIANIFICATA' | 'BAMBINI_NON_AGGIORNATI'

// I `codice` sono LETTERALI, uno per risposta: il lock `errori-con-codice` li legge dal sorgente per verificare
// che siano dichiarati in `CODICI_ERRORE` e tradotti nelle due lingue.
const NON_TROVATA = () =>
  NextResponse.json({ error: 'Il richiamo non esiste più.', codice: 'SCHEDA_NON_TROVATA' }, { status: 404 })
const STATO_NON_AMMESSO = () =>
  NextResponse.json(
    { error: 'Questa operazione non è possibile nello stato attuale del richiamo.', codice: 'STATO_NON_AMMESSO' },
    { status: 409 },
  )
const MOTIVO_OBBLIGATORIO = () =>
  NextResponse.json(
    { error: 'Indica il motivo per cui la famiglia non è interessata.', codice: 'MOTIVO_OBBLIGATORIO' },
    { status: 422 },
  )

/** Il 409 del «già fatta»: è anche il segnale che il blocco del doppio clic ha lavorato, e lo si lascia scritto. */
function giaFatta(azione: AzioneRow) {
  logEvento('crm', 'info', {
    operazione: 'admin/crm/azioni/[id]:PATCH',
    esito: 'azione-gia-fatta',
    tipo: azione.tipo,
    scuola_id: azione.scuola_id,
    entita_id: azione.scheda_id,
  })
  return NextResponse.json(
    { error: 'Questo richiamo è già stato segnato come fatto.', codice: 'GIA_FATTA' },
    { status: 409 },
  )
}

export const PATCH = withRoute(
  'admin/crm/azioni/[id]:PATCH',
  async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const auth = await requireCrm(request)
    if (auth.response) return auth.response

    const p = parseData(paramsSchema, await ctx.params)
    if ('response' in p) return p.response
    const body = await parseBody(request, corpoSchema)
    if ('response' in body) return body.response

    const supabase = await createAdminClient()

    const { data, error } = await supabase.from('crm_azioni').select(COLONNE_AZIONE).eq('id', p.data.id).maybeSingle()
    if (error) return rispostaErroreDb(error, 'admin/crm/azioni/[id]:PATCH')
    if (!data) return NON_TROVATA()
    const azione = data as AzioneRow

    const gate = await assertSchedaInScope(supabase, auth.user, azione.scheda_id)
    if ('response' in gate) return gate.response
    const scuolaId = gate.scheda.scuola_id

    switch (body.data.azione) {
      case 'fatta':
        return segnaFatta(supabase, auth.user, azione, scuolaId, body.data)
      case 'sposta':
        return sposta(supabase, auth.user, azione, scuolaId, body.data)
      case 'cancella':
        return cancella(supabase, auth.user, azione, scuolaId)
    }
  },
)

// ── fatta ──────────────────────────────────────────────────────────────────────────────────────────────────

async function segnaFatta(
  supabase: SupabaseClient,
  user: AppUser,
  azione: AzioneRow,
  scuolaId: string,
  corpo: Extract<Corpo, { azione: 'fatta' }>,
) {
  // Le risposte «a occhio», prima di scrivere: il verdetto vero lo dà comunque l'`update` qui sotto.
  if (azione.cancellata_il) return STATO_NON_AMMESSO()
  if (azione.fatta_il) return giaFatta(azione)
  // Prima di toccare qualunque riga: un «non interessato» senza motivo non deve consumare il richiamo.
  if (corpo.esito === 'non_interessato' && !corpo.motivoPerdita) return MOTIVO_OBBLIGATORIO()

  const adesso = new Date().toISOString()
  const { data: toccate, error } = await supabase
    .from('crm_azioni')
    .update({ esito: corpo.esito, fatta_da: user.id, fatta_il: adesso })
    .eq('id', azione.id)
    .eq('scuola_id', scuolaId)
    .is('fatta_il', null)
    .is('cancellata_il', null)
    .select('id')
  if (error) return rispostaErroreDb(error, 'admin/crm/azioni/[id]:PATCH')
  // Nessuna riga cambiata: un'altra richiesta ha segnato (o cancellato) questo richiamo un istante fa.
  // Chi perde la corsa non pianifica niente.
  if (!toccate || toccate.length === 0) return giaFatta(azione)

  const avvisi: Avviso[] = []

  await registraEvento(supabase, {
    schedaId: azione.scheda_id,
    scuolaId,
    tipo: 'azione_fatta',
    autore: user.id,
    autoreVia: 'segreteria',
    dati: { azione_id: azione.id, tipo: azione.tipo, esito: corpo.esito },
  })

  // I bambini della scheda.
  const nuovoEsito: EsitoBambino | null =
    corpo.esito === 'non_interessato' ? 'perso' : corpo.esito === 'ci_pensa' ? 'ci_pensa' : null
  let bambiniAggiornati = 0
  if (nuovoEsito) {
    const aggiornati = await aggiornaBambini(supabase, user, azione, scuolaId, {
      a: nuovoEsito,
      da: nuovoEsito === 'perso' ? DA_PERDERE : DA_PENSARCI,
      motivo: nuovoEsito === 'perso' ? corpo.motivoPerdita : undefined,
      nota: nuovoEsito === 'perso' ? corpo.motivoNota : undefined,
      adesso,
    })
    if (aggiornati === null) avvisi.push('BAMBINI_NON_AGGIORNATI')
    else bambiniAggiornati = aggiornati
  }

  // Il passo successivo della catena. `oggi` è il giorno di Roma di adesso.
  const prossima = prossimaAzione({ da: azione.tipo, esito: corpo.esito, oggi: dataCivile() })
  let nata: { id: string; tipo: TipoAzione; giorno: string; scadenza: string; responsabile: string } | null = null
  if (prossima) {
    const creata = await pianificaAzione(supabase, {
      schedaId: azione.scheda_id,
      scuolaId,
      tipo: prossima.tipo,
      giorno: prossima.giorno,
      responsabile: azione.responsabile,
      appuntamentoId: azione.appuntamento_id,
      autore: user.id,
    })
    if (creata) {
      nata = {
        id: creata.id,
        tipo: prossima.tipo,
        giorno: prossima.giorno,
        scadenza: scadenzaRoma(prossima.giorno),
        responsabile: azione.responsabile,
      }
    } else {
      avvisi.push('PROSSIMA_NON_PIANIFICATA')
    }
  }

  return NextResponse.json({
    data: { id: azione.id, esito: corpo.esito, prossima: nata, bambini_aggiornati: bambiniAggiornati, avvisi },
  })
}

/**
 * Porta i bambini della scheda in `a`, ma solo quelli che stanno in uno degli esiti `da`. Torna quanti ne ha
 * cambiati, o `null` se la scrittura è fallita (già nel log). Un `esito_cambiato` per ciascun bambino
 * davvero cambiato: il registro dello storico non si scrive "a occhio" sui bambini letti prima, ma su quelli
 * che l'`update` ha restituito.
 */
async function aggiornaBambini(
  supabase: SupabaseClient,
  user: AppUser,
  azione: AzioneRow,
  scuolaId: string,
  c: { a: EsitoBambino; da: EsitoBambino[]; motivo?: MotivoPerdita; nota?: string; adesso: string },
): Promise<number | null> {
  const campi = { operazione: 'admin/crm/azioni/[id]:PATCH', esito: 'bambini-non-aggiornati', scuola_id: scuolaId, entita_id: azione.scheda_id }

  const { data: letti, error: errLettura } = await supabase
    .from('crm_bambini')
    .select('id, esito')
    .eq('scheda_id', azione.scheda_id)
    .eq('scuola_id', scuolaId)
    .in('esito', c.da)
  if (errLettura) {
    logEvento('crm', 'error', campi, errLettura)
    return null
  }
  if (!letti || letti.length === 0) return 0
  const prima = new Map(letti.map((b) => [b.id as string, b.esito as string]))

  const patch: Record<string, string | null> = {
    esito: c.a,
    esito_origine: 'manuale',
    esito_da: user.id,
    esito_il: c.adesso,
    aggiornata_il: c.adesso,
  }
  if (c.a === 'perso') {
    patch.motivo_perdita = c.motivo ?? null
    patch.motivo_nota = c.nota ? c.nota : null
  }
  // L'`esito` torna a essere filtrato qui: fra la lettura e questa scrittura un bambino può essere diventato
  // iscritto (collegamento automatico con la domanda), e un iscritto non si declassa.
  const { data: toccati, error: errScrittura } = await supabase
    .from('crm_bambini')
    .update(patch)
    .in('id', [...prima.keys()])
    .eq('scuola_id', scuolaId)
    .in('esito', c.da)
    .select('id')
  if (errScrittura) {
    logEvento('crm', 'error', campi, errScrittura)
    return null
  }

  for (const b of toccati ?? []) {
    const id = b.id as string
    await registraEvento(supabase, {
      schedaId: azione.scheda_id,
      scuolaId,
      tipo: 'esito_cambiato',
      autore: user.id,
      autoreVia: 'segreteria',
      dati: {
        bambino_id: id,
        azione_id: azione.id,
        da: prima.get(id) ?? null,
        a: c.a,
        ...(c.a === 'perso' && c.motivo ? { motivo: c.motivo } : {}),
      },
    })
  }
  return (toccati ?? []).length
}

// ── sposta ─────────────────────────────────────────────────────────────────────────────────────────────────

async function sposta(
  supabase: SupabaseClient,
  user: AppUser,
  azione: AzioneRow,
  scuolaId: string,
  corpo: Extract<Corpo, { azione: 'sposta' }>,
) {
  if (azione.fatta_il || azione.cancellata_il) return STATO_NON_AMMESSO()

  // Si controlla la persona solo se cambia: chi non è più della sede non deve bloccare lo spostamento
  // di un richiamo che resta suo.
  const cambiaResponsabile =
    corpo.responsabile !== undefined && formaConfronto(corpo.responsabile) !== formaConfronto(azione.responsabile)
  if (cambiaResponsabile) {
    const rifiuto = await assertPersonaInScope(supabase, corpo.responsabile as string, scuolaId)
    if (rifiuto) return rifiuto
  }

  // Senza `ora` si tiene quella che il richiamo aveva (di Roma): spostare di giorno non è riportarlo alle 10:30.
  const ora = corpo.ora ?? (oraCivile(azione.scadenza) || ORA_FOLLOW_UP)
  const patch: Record<string, string> = { scadenza: scadenzaRoma(corpo.giorno, ora) }
  if (cambiaResponsabile) patch.responsabile = corpo.responsabile as string

  const { data: toccate, error } = await supabase
    .from('crm_azioni')
    .update(patch)
    .eq('id', azione.id)
    .eq('scuola_id', scuolaId)
    .is('fatta_il', null)
    .is('cancellata_il', null)
    .select('id')
  if (error) return rispostaErroreDb(error, 'admin/crm/azioni/[id]:PATCH')
  if (!toccate || toccate.length === 0) return STATO_NON_AMMESSO()

  await registraEvento(supabase, {
    schedaId: azione.scheda_id,
    scuolaId,
    tipo: 'azione_spostata',
    autore: user.id,
    autoreVia: 'segreteria',
    dati: {
      azione_id: azione.id,
      tipo: azione.tipo,
      da: dataCivile(new Date(azione.scadenza)),
      a: corpo.giorno,
      ora,
      ...(cambiaResponsabile ? { responsabile_da: azione.responsabile, responsabile_a: corpo.responsabile as string } : {}),
    },
  })

  return NextResponse.json({
    data: { id: azione.id, scadenza: patch.scadenza, responsabile: cambiaResponsabile ? patch.responsabile : azione.responsabile },
  })
}

// ── cancella ───────────────────────────────────────────────────────────────────────────────────────────────

async function cancella(supabase: SupabaseClient, user: AppUser, azione: AzioneRow, scuolaId: string) {
  if (azione.fatta_il || azione.cancellata_il) return STATO_NON_AMMESSO()

  const { data: toccate, error } = await supabase
    .from('crm_azioni')
    .update({ cancellata_il: new Date().toISOString(), cancellata_da: user.id })
    .eq('id', azione.id)
    .eq('scuola_id', scuolaId)
    .is('fatta_il', null)
    .is('cancellata_il', null)
    .select('id')
  if (error) return rispostaErroreDb(error, 'admin/crm/azioni/[id]:PATCH')
  if (!toccate || toccate.length === 0) return STATO_NON_AMMESSO()

  await registraEvento(supabase, {
    schedaId: azione.scheda_id,
    scuolaId,
    tipo: 'azione_cancellata',
    autore: user.id,
    autoreVia: 'segreteria',
    dati: { azione_id: azione.id, tipo: azione.tipo },
  })

  return NextResponse.json({ data: { id: azione.id } })
}
