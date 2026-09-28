/**
 * ─── LA RETTA A CARICO DI UN FRATELLO, VISTA DALLA CONTABILITÀ ─────────────────
 *
 * `alunni.retta_a_carico_di` (dal 2026-08-16) dice che la retta di un bambino la paga un
 * fratello: entrambe le strade che generano le rette lo SALTANO. Fino al 2026-09-28 la
 * vista Rette lo mostrava comunque come «Non generata», cioè come un bambino dimenticato,
 * e «Genera mancanti» lo contava senza mai poterlo generare.
 *
 * Questo modulo è PURO: tipi, testi, anomalie. Il testo italiano qui sotto è lo stesso
 * del catalogo `it` (`adminContabilita.dashACarico`): lo usa l'export Excel, e un lock
 * (`__tests__/pagamenti/rette-a-carico.test.ts`) verifica che schermo ed Excel dicano
 * la stessa frase.
 */

export type SessoPagante = 'M' | 'F' | null

export interface PaganteRetta {
  id: string
  nome: string
  cognome: string
  sesso: SessoPagante
  classe_sezione: string | null
  /** `stato === 'iscritto'` e nessuna data di archiviazione. */
  iscritto: boolean
  scuola_id: string | null
}

export interface LegameRetta {
  /** Il bambino A CARICO. */
  alunno_id: string
  /** La sede del bambino a carico. */
  scuola_id: string | null
  pagante: PaganteRetta
}

export type AnomaliaPagante = 'non-iscritto' | 'altra-sede' | null

/** Fra chi paga e lo stato della sua retta: identico a schermo e nell'Excel. */
export const SEPARATORE_STATO = ' · '

export function sessoDa(gender: unknown): SessoPagante {
  if (typeof gender !== 'string') return null
  const g = gender.trim().toUpperCase()
  return g === 'M' || g === 'F' ? g : null
}

export function nomePagante(p: Pick<PaganteRetta, 'nome' | 'cognome'>): string {
  return `${p.nome ?? ''} ${p.cognome ?? ''}`.replace(/\s+/g, ' ').trim()
}

/** «Mario Rossi (Sez. C)»; senza classe, solo il nome (D5). */
export function nomeConClasse(p: Pick<PaganteRetta, 'nome' | 'cognome' | 'classe_sezione'>): string {
  const nome = nomePagante(p)
  const classe = p.classe_sezione?.trim()
  return classe ? `${nome} (${classe})` : nome
}

/** I valori del messaggio ICU `dashACarico`/`dashACaricoVerifica`: ICU vuole una stringa, «nd» = sesso assente. */
export function valoriPrefisso(p: Pick<PaganteRetta, 'nome' | 'cognome' | 'classe_sezione' | 'sesso'>): { sesso: string; nome: string } {
  return { sesso: p.sesso ?? 'nd', nome: nomeConClasse(p) }
}

/** Il prefisso in italiano (D1): la stessa frase del catalogo `it`. */
export function prefissoPaganteIt(p: Pick<PaganteRetta, 'nome' | 'cognome' | 'classe_sezione' | 'sesso'>): string {
  const nome = nomeConClasse(p)
  if (p.sesso === 'M') return `Paga il fratello ${nome}`
  if (p.sesso === 'F') return `Paga la sorella ${nome}`
  return `A carico di ${nome}`
}

/** Prefisso + « · stato» (D2). Senza stato, il solo prefisso. */
export function componiBadge(prefisso: string, stato?: string | null): string {
  return stato ? `${prefisso}${SEPARATORE_STATO}${stato}` : prefisso
}

/** Il testo intero in italiano: la colonna «Stato» dell'export (D14). */
export function testoPaganteIt(p: Pick<PaganteRetta, 'nome' | 'cognome' | 'classe_sezione' | 'sesso'>, stato?: string | null): string {
  return componiBadge(prefissoPaganteIt(p), stato)
}

/**
 * D12. Il non iscritto vince: se chi paga è uscito, che sia anche in un'altra sede è un
 * dettaglio. Le sedi si confrontano come arrivano dal database (forma canonica).
 */
export function anomaliaPagante(l: LegameRetta): AnomaliaPagante {
  if (!l.pagante.iscritto) return 'non-iscritto'
  if (l.pagante.scuola_id !== l.scuola_id) return 'altra-sede'
  return null
}

export function indicizzaLegami(legami: readonly LegameRetta[]): Map<string, LegameRetta> {
  return new Map(legami.map((l) => [l.alunno_id, l]))
}

/**
 * Il corpo della GET, controllato. `null` = forma inattesa: è un GUASTO, non «nessun
 * legame», e il chiamante lo dice a schermo. Le voci malformate si scartano una a una.
 */
export function legamiDaRisposta(data: unknown): LegameRetta[] | null {
  if (!Array.isArray(data)) return null
  return data.filter((x): x is LegameRetta => {
    if (!x || typeof x !== 'object') return false
    const l = x as Partial<LegameRetta>
    const p = l.pagante as Partial<PaganteRetta> | undefined
    return typeof l.alunno_id === 'string' && !!p && typeof p === 'object'
      && typeof p.id === 'string' && typeof p.nome === 'string' && typeof p.cognome === 'string'
  })
}
