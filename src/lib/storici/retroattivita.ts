import { haUnRuolo, type AppUser } from '@/lib/auth/predicati-ruolo'

/** La sede e la sezione restano verificate dai gate del chiamante. */
export function puoCorreggereStorico(attore: AppUser): boolean {
  return haUnRuolo(attore, ['admin', 'coordinator', 'segreteria'])
}

/** Utilità pura, importabile anche nell'editor client. */
export function oggiRoma(ora: Date = new Date()): string {
  return ora.toLocaleDateString('en-CA', { timeZone: 'Europe/Rome' })
}

export interface ContestoNotificaOperazione {
  giornoCompetenza: string
  giornoOperazioneRoma: string
  sopprimiGenitori: boolean
  giornoOriginale?: string
}

/** Solo dati dell'identità autenticata: nessun flag del body concede il silenzio. */
export function politicaNotificaOperazione({ attore, giornoCompetenza, giornoOriginale, ora = new Date() }: {
  attore: AppUser
  giornoCompetenza: string
  giornoOriginale?: string
  ora?: Date
}): ContestoNotificaOperazione {
  const giornoOperazioneRoma = oggiRoma(ora)
  return {
    giornoCompetenza,
    giornoOperazioneRoma,
    sopprimiGenitori: puoCorreggereStorico(attore) && (giornoCompetenza < giornoOperazioneRoma || (giornoOriginale != null && giornoOriginale < giornoOperazioneRoma)),
    ...(giornoOriginale ? { giornoOriginale } : {}),
  }
}

/** La decisione è dell'operazione originale: il dispatch di domani non la ricalcola. */
export function deveNotificareGenitori(operazione?: ContestoNotificaOperazione | null): boolean {
  return operazione?.sopprimiGenitori !== true
}

/** Mezzanotte locale calcolata con Intl, compresi i giorni di 23 e 25 ore. */
function mezzanotteRoma(giorno: string): number {
  const base = Date.parse(`${giorno}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(giorno) || !Number.isFinite(base)
    || new Date(base).toISOString().slice(0, 10) !== giorno) throw new RangeError('Data non valida')
  const formato = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  let istante = base
  for (let n = 0; n < 3; n += 1) {
    const parti = Object.fromEntries(formato.formatToParts(new Date(istante)).map(p => [p.type, p.value]))
    const locale = Date.parse(`${parti.year}-${parti.month}-${parti.day}T${parti.hour}:${parti.minute}:${parti.second}.000Z`)
    istante += base - locale
  }
  return istante
}

/** Estremi inclusivi UTC di un giorno civile romano. */
export function intervalloGiornoRoma(giorno: string): { startOfDay: string; endOfDay: string } {
  const inizio = mezzanotteRoma(giorno)
  const successivo = new Date(Date.parse(`${giorno}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10)
  return { startOfDay: new Date(inizio).toISOString(), endOfDay: new Date(mezzanotteRoma(successivo) - 1).toISOString() }
}

/** Conserva l'ora locale dell'istante fornito, sulla giornata scelta dall'operatore. */
export function istanteNelGiornoRoma(giorno: string, istante: Date = new Date()): string {
  const ora = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(istante)
  const target = Date.parse(`${giorno}T${ora}.000Z`)
  let valore = target
  const formato = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  for (let n = 0; n < 3; n += 1) {
    const locale = formato.format(new Date(valore)).replace(' ', 'T')
    valore += target - Date.parse(`${locale}Z`)
  }
  return new Date(valore).toISOString()
}
