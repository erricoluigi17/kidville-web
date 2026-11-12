import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { dataCivile } from '@/i18n/config'
import { notificaVisitaAssegnata } from '@/lib/crm/agenda'
import { assertSedeDelToken, chiudiChiamataAi, requireIntegrazioneAi, rifiutoAi, type CodiceAi } from '@/lib/crm/ai/accesso'
import { candidatiPer, caricaAgendaAi, sedeCopre } from '@/lib/crm/ai/disponibilita'
import { gradiPerNascita, meseDiNascita } from '@/lib/crm/ai/eta'
import { chiaveIdempotenza, improntaCorpo } from '@/lib/crm/ai/idempotenza'
import { normalizzaEmail, normalizzaTelefono } from '@/lib/crm/contatti'
import { rispostaCrmNonRiuscita, rispostaErroreDbSchema } from '@/lib/crm/errori'
import { ORIGINI, type EsitoPrenotaAi } from '@/lib/crm/tipi'
import { logErrore, logEvento } from '@/lib/logging/logger'
import { withRoute } from '@/lib/logging/with-route'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { createAdminClient } from '@/lib/supabase/server-client'
import { zDataYMD, zOpzionale, zUuid } from '@/lib/validation/common'
import { parseBody, validationError } from '@/lib/validation/http'

const op = 'crm/ai/prenota'
const istante = z.iso.datetime({ offset: true })
  // Gli orari offerti sono rappresentabili con Date senza arrotondare frazioni di millisecondo.
  .refine((valore) => !/\.\d{3}\d*[1-9]/.test(valore), 'Precisione dell’istante non ammessa')

// Le chiavi sconosciute possono contenere testo privato, anche dentro bambini.
const campiAmmessi = { error: (issue: { code: string }) =>
  issue.code === 'unrecognized_keys' ? 'Sono presenti campi non ammessi' : undefined }
const nota = zOpzionale(z.string().trim().max(2000))
const bodySchema = z.strictObject({
  sede: zUuid,
  inizio: istante,
  fine: istante,
  genitoreNome: z.string().trim().min(1).max(120),
  telefono: z.string().trim().min(6).max(40),
  email: zOpzionale(z.string().trim().max(200)),
  origine: z.enum(ORIGINI),
  bambini: z.array(z.strictObject({
    nome: z.string().trim().min(1).max(100),
    dataNascita: zDataYMD,
  }, campiAmmessi)).min(1).max(6),
  routine: nota,
  paura: nota,
  desiderio: nota,
}, campiAmmessi).refine((b) => Date.parse(b.fine) > Date.parse(b.inizio), {
  path: ['fine'], message: 'La fine deve essere successiva all’inizio',
})

type RigaRegistro = { impronta: string; risposta: EsitoPrenotaAi | null }
type RispostaEsito = { risposta: NextResponse; codice?: CodiceAi; entitaId?: string }

function rispostaDaEsito(dati: EsitoPrenotaAi | null, ripetuta: boolean): RispostaEsito {
  switch (dati?.esito) {
    case 'creata':
      return {
        risposta: NextResponse.json({
          id: dati.appuntamento_id,
          inizio: new Date(dati.inizio).toISOString(),
          fine: new Date(dati.fine).toISOString(),
          schedaId: dati.scheda_id,
          schedaCreata: dati.scheda_creata,
          ripetuta,
        }, { status: ripetuta ? 200 : 201 }),
        entitaId: dati.appuntamento_id,
      }
    case 'gia_prenotato':
      return {
        risposta: rifiutoAi('GIA_PRENOTATO', 409, {
          id: dati.appuntamento_id,
          inizio: new Date(dati.inizio).toISOString(),
          fine: new Date(dati.fine).toISOString(),
        }),
        codice: 'GIA_PRENOTATO',
        entitaId: dati.appuntamento_id,
      }
    case 'slot_occupato':
      return { risposta: rifiutoAi('SLOT_OCCUPATO', 409), codice: 'SLOT_OCCUPATO' }
    case 'fuori_disponibilita':
      return { risposta: rifiutoAi('FUORI_DISPONIBILITA', 422), codice: 'FUORI_DISPONIBILITA' }
    case 'chiave_riusata':
      return { risposta: rifiutoAi('CHIAVE_RIUSATA', 422), codice: 'CHIAVE_RIUSATA' }
    case 'in_corso':
      return { risposta: rifiutoAi('CRM_OPERAZIONE_NON_RIUSCITA', 409), codice: 'CRM_OPERAZIONE_NON_RIUSCITA' }
    case 'token_non_valido': {
      const risposta = rifiutoAi('TOKEN_NON_VALIDO', 401)
      risposta.headers.set('WWW-Authenticate', 'Bearer')
      return { risposta, codice: 'TOKEN_NON_VALIDO' }
    }
    default:
      logErrore({ operazione: op, stato: 500 }, new Error('Esito inatteso da crm_ai_prenota'))
      return { risposta: rispostaCrmNonRiuscita(), codice: 'CRM_OPERAZIONE_NON_RIUSCITA' }
  }
}

export const POST = withRoute('crm/ai/prenota:POST', async (request: NextRequest) => {
  const g = await requireIntegrazioneAi(request, 'prenota')
  if ('response' in g) return g.response
  const { ai } = g

  const b = await parseBody(request, bodySchema)
  if ('response' in b) return chiudiChiamataAi(ai, b.response)

  const altraSede = assertSedeDelToken(ai, b.data.sede)
  if (altraSede) return chiudiChiamataAi(ai, altraSede, { codice: 'SEDE_NON_ACCESSIBILE' })

  const chiave = chiaveIdempotenza(request)
  if (chiave === null) {
    return chiudiChiamataAi(ai, validationError([
      { path: ['Idempotency-Key'], message: 'Header Idempotency-Key mancante o non valido' },
    ]))
  }

  const rifiuta = (codice: CodiceAi, stato: number) => chiudiChiamataAi(ai, rifiutoAi(codice, stato), { codice })
  const telefonoNorm = normalizzaTelefono(b.data.telefono)
  if (telefonoNorm === null) return rifiuta('CONTATTO_OBBLIGATORIO', 422)
  const emailNorm = normalizzaEmail(b.data.email)
  const inizio = new Date(b.data.inizio).toISOString()
  const fine = new Date(b.data.fine).toISOString()
  const routine = b.data.routine || null
  const paura = b.data.paura || null
  const desiderio = b.data.desiderio || null
  const impronta = improntaCorpo({
    ...b.data, sede: ai.scuolaId, inizio, fine, telefono: telefonoNorm, email: emailNorm, routine, paura, desiderio,
  })

  const supabase = await createAdminClient()
  const leggiRegistro = () => supabase.from('crm_ai_richieste')
    .select('impronta, risposta')
    .eq('scuola_id', ai.scuolaId)
    .eq('integrazione_id', ai.integrazioneId)
    .eq('chiave', chiave)
    .maybeSingle<RigaRegistro>()

  const prenota = async (candidate: string[], durataMin: number) => {
    const { data, error } = await supabase.rpc('crm_ai_prenota', {
      p_integrazione_id: ai.integrazioneId,
      p_scuola_id: ai.scuolaId,
      p_chiave: chiave,
      p_impronta: impronta,
      p_inizio: inizio,
      p_durata_min: durataMin,
      p_candidati: candidate,
      p_telefono: b.data.telefono,
      p_telefono_norm: telefonoNorm,
      p_email: b.data.email ?? null,
      p_email_norm: emailNorm,
      p_genitore_nome: b.data.genitoreNome,
      p_origine: b.data.origine,
      p_bambini: b.data.bambini.map(({ nome, dataNascita }) => ({ nome, data_nascita: dataNascita })),
      p_routine: routine,
      p_paura: paura,
      p_desiderio: desiderio,
    })
    if (error) return chiudiChiamataAi(ai, rispostaErroreDbSchema(erroreDbSoloCodice(error), op))

    const esito = data as EsitoPrenotaAi | null
    const ripetuta = esito?.esito === 'creata' && esito.ripetuta === true
    const { risposta, codice, entitaId } = rispostaDaEsito(esito, ripetuta)
    if (esito?.esito === 'creata' && !ripetuta) {
      await notificaVisitaAssegnata(supabase, {
        scuolaId: ai.scuolaId,
        appuntamentoId: esito.appuntamento_id,
        inizio: esito.inizio,
        destinatario: esito.assegnata_a,
      })
      logEvento('crm', 'info', {
        operazione: op, esito: 'ai-visita-fissata', scuola_id: ai.scuolaId, entita_id: esito.appuntamento_id,
      })
    }
    return chiudiChiamataAi(ai, risposta, { codice, entitaId })
  }

  const riprova = (riga: RigaRegistro) => {
    if (riga.impronta !== impronta) return rifiuta('CHIAVE_RIUSATA', 422)
    if (riga.risposta === null) {
      // La funzione rilegge il registro sotto blocco. Senza la riga non può creare una visita.
      return prenota([], 0)
    }
    const { risposta, codice, entitaId } = rispostaDaEsito(riga.risposta, true)
    return chiudiChiamataAi(ai, risposta, { codice, entitaId })
  }

  const registro = await leggiRegistro()
  if (registro.error) return chiudiChiamataAi(ai, rispostaErroreDbSchema(erroreDbSoloCodice(registro.error), op))
  if (registro.data) return riprova(registro.data)

  const rifiutaSeNuova = async (codice: 'ETA_NON_COPERTA' | 'FUORI_DISPONIBILITA') => {
    // Una richiesta concorrente può aver concluso mentre leggevamo copertura e agenda.
    const ultimo = await leggiRegistro()
    if (ultimo.error) return chiudiChiamataAi(ai, rispostaErroreDbSchema(erroreDbSoloCodice(ultimo.error), op))
    return ultimo.data ? riprova(ultimo.data) : rifiuta(codice, 422)
  }

  const adesso = new Date()
  const oggi = dataCivile(adesso)
  const gradi = [...new Set(b.data.bambini.flatMap(({ dataNascita }) =>
    gradiPerNascita(meseDiNascita(dataNascita) ?? '', oggi),
  ))]
  const copertura = await sedeCopre(supabase, ai.scuolaId, gradi, op)
  if ('response' in copertura) return chiudiChiamataAi(ai, copertura.response)
  if (!copertura.coperta) return rifiutaSeNuova('ETA_NON_COPERTA')

  const giorno = dataCivile(new Date(inizio))
  const agenda = await caricaAgendaAi(supabase, ai.scuolaId, giorno, giorno, adesso, op)
  if ('response' in agenda) return chiudiChiamataAi(ai, agenda.response)

  // Se l'orario risulta occupato, la funzione decide sotto blocco se è un replay o un conflitto.
  const slot = candidatiPer(agenda.liberi, inizio, fine) ?? candidatiPer(agenda.inFascia, inizio, fine)
  if (!slot) return rifiutaSeNuova('FUORI_DISPONIBILITA')
  return prenota(slot.candidati, slot.durataMin)
})
