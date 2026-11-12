import type { PersonaCrm } from '../accesso'

export const MOTIVI_PASSAGGIO = [
  'chiede_persona', 'prezzo', 'sconto', 'salute', 'reclamo', 'non_so', 'incomprensione', 'vocale', 'altro',
] as const
export type MotivoPassaggio = (typeof MOTIVI_PASSAGGIO)[number]

/** Frasi fisse del passaggio, usate dalla RPC per lo storico. */
export const ETICHETTA_PASSAGGIO: Record<MotivoPassaggio, string> = {
  chiede_persona: 'chiede di parlare con una persona',
  prezzo: 'insiste sul prezzo',
  sconto: 'chiede uno sconto',
  salute: 'messaggio sulla salute, da leggere in chat',
  reclamo: 'reclamo',
  non_so: 'domanda a cui l’assistente non sa rispondere',
  incomprensione: 'due scambi senza capirsi',
  vocale: 'vocale non chiaro',
  altro: 'altro',
}

/** Preferisce chi aveva l'ultima visita, poi la segreteria, poi la Direzione. */
export function scegliResponsabile(persone: PersonaCrm[], assegnatariaUltimaVisita: string | null): string | null {
  if (persone.some(({ id }) => id === assegnatariaUltimaVisita)) return assegnatariaUltimaVisita

  const ordinate = [...persone].sort((a, b) =>
    a.cognome.localeCompare(b.cognome, 'it') || a.nome.localeCompare(b.nome, 'it'))
  return (ordinate.find(({ ruolo }) => ruolo === 'segreteria') ?? ordinate[0])?.id ?? null
}
