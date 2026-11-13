/**
 * CRM ASSISTENTE FAMIGLIE · INTERRUTTORE E SEDI.
 *
 * Il canale è spento salvo attivazione esplicita. Anche quando è acceso, una sede
 * senza UUID nell'elenco configurato resta fuori: una voce vuota non apre tutte le sedi.
 */

import { formaConfronto } from '@/lib/auth/scope'

const FORMA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function crmAiAttivo(): boolean {
  return process.env.CRM_AI_ATTIVO === '1'
}

export function sediAmmesseAi(): string[] {
  const sedi = (process.env.CRM_AI_SEDI_AMMESSE ?? '').split(',').map(formaConfronto)
  return [...new Set(sedi.filter((sede) => FORMA_UUID.test(sede)))]
}

export function sedeAmmessaAi(scuolaId: string): boolean {
  return sediAmmesseAi().includes(formaConfronto(scuolaId))
}
