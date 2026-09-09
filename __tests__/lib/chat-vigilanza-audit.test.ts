import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DBFinto } from '../fixtures/finto-supabase'
import { creaFintoSupabase } from '../fixtures/finto-supabase'
import { SEDE_A } from '../fixtures/sedi'
import { registraAccessoVigilanza } from '@/lib/chat/vigilanza-audit'
import * as logger from '@/lib/logging/logger'

// `registraAccessoVigilanza` scrive nel registro la parola che la segreteria ha
// cercato dentro le conversazioni delle famiglie. Quella parola è testo libero:
// sta in TABELLA (è ciò che rende il registro utile) e non deve MAI comparire in
// una riga di log — dove finirebbe su Vercel e, per gli eventi `chat`, anche in
// `app_log`. Stessa cosa per `user_agent` e `ip`.
//
// Qui si collauda il caso in cui il log ESISTE davvero, cioè quando l'INSERT
// fallisce: è l'unico momento in cui questa funzione parla.

const OPERATORE = { id: 'aaaaaaaa-0000-4000-8000-00000000000a', role: 'segreteria' as const }
const THREAD = 'dddddddd-0000-4000-8000-000000000004'
const TERMINE = 'PAROLA-CERCATA-CHE-NON-DEVE-FINIRE-NEI-LOG'
const AGENTE = 'Mozilla/5.0 IMPRONTA-DEL-BROWSER'

const dbBase = (): DBFinto => ({ chat_vigilanza_accessi: [] })

const richiesta = () =>
  new Request('http://localhost/x', {
    headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': AGENTE },
  })

let spiaEvento: ReturnType<typeof vi.spyOn>
let spiaErrore: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.restoreAllMocks()
  spiaEvento = vi.spyOn(logger, 'logEvento').mockImplementation(() => {})
  spiaErrore = vi.spyOn(logger, 'logErrore').mockImplementation(() => {})
})

const dumpLog = () => JSON.stringify([...spiaEvento.mock.calls, ...spiaErrore.mock.calls])

describe('registraAccessoVigilanza', () => {
  it('scrive la riga e prende il PRIMO indirizzo di x-forwarded-for', async () => {
    const db = dbBase()
    const supabase = creaFintoSupabase(db)
    const esito = await registraAccessoVigilanza(supabase, {
      operatore: OPERATORE,
      azione: 'ricerca',
      termine: TERMINE,
      scuolaId: SEDE_A,
      nMessaggi: 3,
      request: richiesta(),
    })
    expect(esito).toEqual({ tracciato: true })
    expect(db.chat_vigilanza_accessi).toHaveLength(1)
    expect(db.chat_vigilanza_accessi[0]).toMatchObject({
      azione: 'ricerca',
      esito: 'ok',
      termine: TERMINE,
      ip: '203.0.113.9',
      user_agent: AGENTE,
      n_messaggi: 3,
    })
  })

  it('quando l\'INSERT fallisce dice «non tracciato» e NON mette il termine nei log', async () => {
    const db = dbBase()
    const supabase = creaFintoSupabase(db, [], {
      errori: { 'chat_vigilanza_accessi:insert': { code: '23502', message: 'null value' } },
    })
    const esito = await registraAccessoVigilanza(supabase, {
      operatore: OPERATORE,
      azione: 'ricerca',
      termine: TERMINE,
      threadId: THREAD,
      request: richiesta(),
    })
    expect(esito).toEqual({ tracciato: false })

    const dump = dumpLog()
    expect(dump).toContain('vigilanza-non-tracciata')   // il log c'è
    expect(dump).toContain(THREAD)                       // e dice QUALE accesso
    expect(dump).not.toContain(TERMINE)                  // ma non cosa cercava
    expect(dump).not.toContain(AGENTE)                   // né con che browser
    expect(dump).not.toContain('203.0.113.9')            // né da dove
  })

  it('tabella assente (DB E2E della CI): «tracciato», e nessun rumore nei log', async () => {
    const db = dbBase()
    const supabase = creaFintoSupabase(db, [], {
      errori: { 'chat_vigilanza_accessi:insert': { code: '42P01', message: 'relation does not exist' } },
    })
    const esito = await registraAccessoVigilanza(supabase, {
      operatore: OPERATORE,
      azione: 'lettura',
      threadId: THREAD,
    })
    expect(esito).toEqual({ tracciato: true })
    expect(spiaEvento).not.toHaveBeenCalled()
    expect(spiaErrore).not.toHaveBeenCalled()
  })
})
