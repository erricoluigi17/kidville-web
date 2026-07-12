/**
 * Segnatura di protocollo (art. 55 DPR 445/2000): formattazione del numero
 * (art. 57: ≥7 cifre, rinnovo annuale), data/ora italiana e righe del timbro.
 * Funzioni pure, senza I/O — testate in __tests__/lib/protocolli-segnatura.test.ts.
 */

export type TipoProtocollo = 'ingresso' | 'uscita' | 'interno'

export const TIPO_LABEL: Record<TipoProtocollo, string> = {
  ingresso: 'INGRESSO',
  uscita: 'USCITA',
  interno: 'INTERNO',
}

/** `0000042/2026` — progressivo ad almeno 7 cifre, rinnovato ogni anno solare. */
export function formatNumeroProtocollo(numero: number, anno: number): string {
  return `${String(numero).padStart(7, '0')}/${anno}`
}

/**
 * Data e ora italiane (Europe/Rome) qualunque sia il fuso del runtime:
 * su Vercel il processo gira in UTC, quindi niente toLocale* senza timeZone.
 */
export function dataOraItaliana(d: Date): { data: string; ora: string } {
  const parti = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (tipo: Intl.DateTimeFormatPartTypes) =>
    parti.find((p) => p.type === tipo)?.value ?? ''
  return {
    data: `${get('day')}/${get('month')}/${get('year')}`,
    ora: `${get('hour')}:${get('minute')}`,
  }
}

/** Le tre righe della fascia di segnatura: ente, numero+tipo, data e ora. */
export function righeSegnatura(input: {
  denominazione: string
  numero: number
  anno: number
  tipo: TipoProtocollo
  quando: Date
}): string[] {
  const { data, ora } = dataOraItaliana(input.quando)
  return [
    input.denominazione.toUpperCase(),
    `Prot. n. ${formatNumeroProtocollo(input.numero, input.anno)} · ${TIPO_LABEL[input.tipo]}`,
    `del ${data} ore ${ora}`,
  ]
}
