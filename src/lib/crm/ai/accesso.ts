import { NextResponse } from 'next/server'
import catalogoIt from '../../../../messages/it/shared.json'
import { rifiutoSede } from '@/lib/auth/rifiuto-sede'
import { formaConfronto } from '@/lib/auth/scope'
import { rispostaErroreDb, rispostaErroreDbSchema } from '@/lib/crm/errori'
import { logEvento } from '@/lib/logging/logger'
import { rateLimit } from '@/lib/security/rate-limit'
import { erroreDbSoloCodice } from '@/lib/supabase/errore-tecnico'
import { createAdminClient } from '@/lib/supabase/server-client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CODICI_ERRORE } from '@/lib/ui/esito-fetch'
import { crmAiAttivo, sedeAmmessaAi, sediAmmesseAi } from './interruttore'
import { improntaToken, tokenDaRichiesta } from './token'

export type OperazioneAi = 'slot' | 'prenota' | 'annulla' | 'contatto' | 'contatto_stato' | 'contatti_nuovi' | 'richiamo'

/** La sede della chiave è l'unica su cui la chiamata può lavorare. */
export interface ContestoAi {
  integrazioneId: string
  scuolaId: string
  operazione: OperazioneAi
  inizioMs: number
}

export const LIMITE_CHIAMATE_AI = { limit: 60, windowMs: 60_000 } as const

export type CodiceAi =
  | 'CRM_AI_SPENTO' | 'TOKEN_NON_VALIDO' | 'SEDE_NON_AMMESSA' | 'TROPPE_RICHIESTE'
  | 'GIA_PRENOTATO' | 'SLOT_OCCUPATO' | 'FUORI_DISPONIBILITA' | 'CHIAVE_RIUSATA' | 'ETA_NON_COPERTA'
  | 'NESSUN_RESPONSABILE' | 'CONTATTO_OBBLIGATORIO' | 'SCHEDA_NON_TROVATA' | 'ELEMENTO_NON_TROVATO'
  | 'STATO_NON_AMMESSO' | 'INTEGRAZIONE_ESISTENTE' | 'CRM_OPERAZIONE_NON_RIUSCITA'

export function rifiutoAi(
  codice: CodiceAi,
  stato: number,
  extra?: Record<string, string | boolean | null>,
): NextResponse {
  return NextResponse.json({ ...extra, error: catalogoIt[CODICI_ERRORE[codice]], codice }, { status: stato })
}

const SILENZIO_LOG_MS = 60_000
let ultimoLogAnonimo: number | null = null

function rifiutoAnonimo(op: string, codice: 'CRM_AI_SPENTO' | 'TOKEN_NON_VALIDO'): NextResponse {
  const stato = codice === 'CRM_AI_SPENTO' ? 404 : 401
  const ora = Date.now()
  if (ultimoLogAnonimo === null || ora - ultimoLogAnonimo >= SILENZIO_LOG_MS) {
    ultimoLogAnonimo = ora
    // A interruttore spento anche il logger deve lasciare il database inattivo.
    const opzioni = codice === 'CRM_AI_SPENTO' ? { persisti: false } : undefined
    logEvento('crm', 'warn', { operazione: op, esito: 'ai-rifiutata', error_code: codice, stato }, undefined, opzioni)
  }
  const risposta = rifiutoAi(codice, stato)
  if (stato === 401) risposta.headers.set('WWW-Authenticate', 'Bearer')
  return risposta
}

/** Il gate comune: interruttore, chiave, sede ammessa, limite. */
export async function requireIntegrazioneAi(
  request: Request,
  operazione: OperazioneAi,
): Promise<{ ai: ContestoAi } | { response: NextResponse }> {
  const inizioMs = Date.now()
  const op = 'crm/ai:' + operazione
  if (!crmAiAttivo()) return { response: rifiutoAnonimo(op, 'CRM_AI_SPENTO') }

  const token = tokenDaRichiesta(request)
  if (token === null) return { response: rifiutoAnonimo(op, 'TOKEN_NON_VALIDO') }

  const supabase = await createAdminClient()
  const { data: riga, error } = await supabase
    .from('crm_integrazioni')
    .select('id, scuola_id, revocata_il')
    .eq('token_impronta', improntaToken(token))
    .maybeSingle()
  // Il testo di un errore può contenere il valore cercato: al registro passa solo il codice.
  if (error) return { response: rispostaErroreDb(erroreDbSoloCodice(error), 'crm/ai/accesso:requireIntegrazioneAi') }
  if (!riga || riga.revocata_il !== null) return { response: rifiutoAnonimo(op, 'TOKEN_NON_VALIDO') }

  const identita = { integrazione_id: riga.id, scuola_id: riga.scuola_id }
  if (sediAmmesseAi().length === 0) {
    logEvento('crm', 'error', { operazione: op, esito: 'ai-sedi-ammesse-vuote', stato: 403, ...identita })
    return { response: rifiutoAi('SEDE_NON_AMMESSA', 403) }
  }
  if (!sedeAmmessaAi(riga.scuola_id)) {
    logEvento('crm', 'warn', { operazione: op, esito: 'ai-rifiutata', error_code: 'SEDE_NON_AMMESSA', stato: 403, ...identita })
    return { response: rifiutoAi('SEDE_NON_AMMESSA', 403) }
  }

  const limite = await rateLimit('crm-ai:' + riga.id, LIMITE_CHIAMATE_AI)
  if (!limite.ok) {
    logEvento('crm', 'warn', { operazione: op, esito: 'ai-rifiutata', error_code: 'TROPPE_RICHIESTE', stato: 429, ...identita })
    const risposta = rifiutoAi('TROPPE_RICHIESTE', 429)
    risposta.headers.set('Retry-After', String(Math.ceil(limite.retryAfterMs / 1000)))
    return { response: risposta }
  }

  const { error: erroreUso } = await supabase
    .from('crm_integrazioni')
    .update({ ultimo_uso_il: new Date().toISOString() })
    .eq('id', riga.id)
    .eq('scuola_id', riga.scuola_id)
  if (erroreUso) {
    logEvento('crm', 'error', { operazione: op, esito: 'ai-ultimo-uso-non-scritto', ...identita }, erroreDbSoloCodice(erroreUso))
  }

  return { ai: { integrazioneId: riga.id, scuolaId: riga.scuola_id, operazione, inizioMs } }
}

/**
 * Le rotte di lettura ricontrollano in SQL, con la stessa funzione di prenota, annulla e richiamo, che la chiave
 * sia ancora attiva per la sua sede: una revoca arrivata dopo il gate non lascia leggere. Torna la risposta già
 * chiusa e registrata, oppure `null` se si può proseguire. Un guasto del controllo non lascia passare.
 */
export async function ricontrollaChiaveAttiva(
  supabase: SupabaseClient, ai: ContestoAi,
): Promise<NextResponse | null> {
  const { data, error } = await supabase.rpc('crm_ai_token_attivo', {
    p_integrazione_id: ai.integrazioneId,
    p_scuola_id: ai.scuolaId,
  })
  if (error) return chiudiChiamataAi(ai, rispostaErroreDbSchema(erroreDbSoloCodice(error), 'crm/ai:' + ai.operazione))
  if (data === true) return null
  const risposta = rifiutoAi('TOKEN_NON_VALIDO', 401)
  risposta.headers.set('WWW-Authenticate', 'Bearer')
  return chiudiChiamataAi(ai, risposta, { codice: 'TOKEN_NON_VALIDO' })
}

export function assertSedeDelToken(ai: ContestoAi, sedeDichiarata: string): NextResponse | null {
  if (formaConfronto(ai.scuolaId) === formaConfronto(sedeDichiarata)) return null
  logEvento('multi_sede', 'warn', {
    operazione: 'crm/ai:' + ai.operazione,
    esito: 'ai-sede-diversa-dalla-chiave',
    integrazione_id: ai.integrazioneId,
    sede_id: ai.scuolaId,
  })
  return rifiutoSede('SEDE_NON_ACCESSIBILE')
}

/** Registra l'esito di una chiamata che ha passato il gate. */
export function chiudiChiamataAi(
  ai: ContestoAi,
  risposta: NextResponse,
  extra?: { codice?: string; entitaId?: string | null },
): NextResponse {
  const stato = risposta.status
  const livello = stato >= 500 ? 'error' : stato >= 400 ? 'warn' : 'info'
  logEvento('crm', livello, {
    operazione: 'crm/ai:' + ai.operazione,
    esito: 'ai-chiamata',
    stato,
    error_code: extra?.codice ?? null,
    scuola_id: ai.scuolaId,
    integrazione_id: ai.integrazioneId,
    entita_id: extra?.entitaId ?? null,
    ms: Date.now() - ai.inizioMs,
  })
  return risposta
}
