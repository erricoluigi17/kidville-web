import { NextRequest } from 'next/server'
import { expect, vi } from 'vitest'
import { improntaToken } from '@/lib/crm/ai/token'
import { SEDE_A, SEDE_B } from './sedi'

export const TOKEN_A = 'kvai_' + 'A'.repeat(43)
export const TOKEN_B = 'kvai_' + 'B'.repeat(43)
export const TOKEN_REVOCATO = 'kvai_' + 'R'.repeat(43)
export const INTEGRAZIONE_A = '50000000-0000-4000-8000-00000000000a'
export const INTEGRAZIONE_B = '50000000-0000-4000-8000-00000000000b'
export const INTEGRAZIONE_REVOCATA = '50000000-0000-4000-8000-0000000000ff'
export const ADMIN_AI = '20000000-0000-4000-8000-0000000000ad'

export function integrazioniFinte(): Record<string, unknown>[] {
  return [
    { id: INTEGRAZIONE_A, scuola_id: SEDE_A, nome: 'Assistente', token_impronta: improntaToken(TOKEN_A), token_coda: 'AAAA',
      creata_da: ADMIN_AI, creata_il: '2026-11-10T09:00:00.000Z', revocata_il: null, revocata_da: null, ultimo_uso_il: null },
    { id: INTEGRAZIONE_B, scuola_id: SEDE_B, nome: 'Assistente', token_impronta: improntaToken(TOKEN_B), token_coda: 'BBBB',
      creata_da: ADMIN_AI, creata_il: '2026-11-10T09:00:00.000Z', revocata_il: null, revocata_da: null, ultimo_uso_il: null },
    { id: INTEGRAZIONE_REVOCATA, scuola_id: SEDE_A, nome: 'Vecchia', token_impronta: improntaToken(TOKEN_REVOCATO), token_coda: 'RRRR',
      creata_da: ADMIN_AI, creata_il: '2026-11-01T09:00:00.000Z', revocata_il: '2026-11-09T09:00:00.000Z', revocata_da: ADMIN_AI, ultimo_uso_il: null },
  ]
}

export function richiestaAi(
  percorso: string,
  { metodo = 'GET', token = TOKEN_A, corpo, chiave }: {
    metodo?: 'GET' | 'POST' | 'DELETE'
    token?: string | null
    corpo?: unknown
    chiave?: string
  } = {},
): NextRequest {
  const headers = new Headers()
  if (token !== null) headers.set('authorization', 'Bearer ' + token)
  if (chiave !== undefined) headers.set('idempotency-key', chiave)
  if (corpo !== undefined) headers.set('content-type', 'application/json')
  return new NextRequest('http://localhost' + percorso, { method: metodo, headers, body: JSON.stringify(corpo) })
}

export function accendiAi(sedi: string[]): void {
  vi.stubEnv('CRM_AI_ATTIVO', '1')
  vi.stubEnv('CRM_AI_SEDI_AMMESSE', sedi.join(','))
}

export function nessunNomeIn(json: unknown, parole: string[]): void {
  const testo = JSON.stringify(json)
  for (const parola of parole) expect(testo).not.toContain(parola)
}
