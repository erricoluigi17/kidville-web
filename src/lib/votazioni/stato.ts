import type { StatoVotazione } from './tipi'

/**
 * LO STATO DI UNA VOTAZIONE, RICAVATO E NON SALVATO.
 *
 * `aperta` se e solo se la votazione non è stata chiusa a mano (`chiusaIl === null`) e l’istante di
 * adesso è PRIMA della scadenza. Alla scadenza esatta è già `chiusa`: la scadenza non è inclusa.
 *
 * Non c’è una colonna «stato»: ne servirebbe un job che la aggiorni, e fino al suo passaggio una pagina
 * lasciata aperta oltre le 18:00 accetterebbe ancora voti. Qui ogni lettura e ogni voto rifanno il
 * conto con l’orologio del server.
 *
 * Una proroga riapre una votazione scaduta solo spostando `scadenza`: `chiusaIl` resta nullo. Una
 * chiusura a mano è invece DEFINITIVA e vince su qualunque scadenza.
 *
 * Una scadenza illeggibile vale `chiusa`: nel dubbio non si accettano voti (il database la vuole
 * `timestamptz NOT NULL`, quindi qui è un caso che non dovrebbe esistere).
 */
export function statoVotazione(
  v: { scadenza: string; chiusaIl: string | null },
  adesso: Date = new Date(),
): StatoVotazione {
  if (v.chiusaIl !== null) return 'chiusa'
  const scadenza = Date.parse(v.scadenza)
  if (Number.isNaN(scadenza)) return 'chiusa'
  return adesso.getTime() < scadenza ? 'aperta' : 'chiusa'
}
