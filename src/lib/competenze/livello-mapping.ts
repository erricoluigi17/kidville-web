/**
 * Precompilazione euristica del Certificato delle Competenze a partire dai
 * giudizi sintetici di scrutinio. È un **suggerimento** sovrascrivibile dallo
 * staff (l'attribuzione del livello resta un atto del team docente/dirigente),
 * non un automatismo legale.
 *
 * Conversione di scala: la pagella (O.M. 172/2020) usa
 * Avanzato / Intermedio / Base / In via di prima acquisizione; il certificato
 * (D.M. 14/2024) usa A / B / C / D (Avanzato / Intermedio / Base / Iniziale).
 */

export type LivelloCodice = 'A' | 'B' | 'C' | 'D'

/** Discipline (materie.codice, slug minuscoli) che concorrono a ciascuna competenza. */
export const COMPETENZA_MATERIE: Record<string, string[]> = {
  comunicazione_alfabetica_funzionale: ['italiano'],
  comunicazione_multilinguistica: ['inglese', 'lingua_straniera', 'francese', 'spagnolo', 'tedesco'],
  competenza_matematica_scienze_tecnologia: ['matematica', 'scienze', 'tecnologia'],
  competenza_digitale: ['tecnologia'],
  competenza_personale_sociale_imparare: [],
  competenza_cittadinanza: ['storia', 'geografia', 'educazione_civica', 'ed_civica'],
  competenza_imprenditoriale: [],
  consapevolezza_espressione_culturali: ['arte', 'arte_immagine', 'musica', 'educazione_fisica'],
}

export interface GiudizioPerMateria {
  materia_codice: string
  giudizio_sintetico: string
}

// Scala pagella → ordinale (A=4 … D=1). Confronto case-insensitive e tollerante
// agli spazi; "In via di prima acquisizione" (anche abbreviata) → 1.
function giudizioToOrdinale(g: string): number | null {
  const s = g.trim().toLowerCase()
  if (s.startsWith('avanzato')) return 4
  if (s.startsWith('intermedio')) return 3
  if (s.startsWith('base')) return 2
  if (s.startsWith('in via di prima acquisizione') || s === 'iniziale') return 1
  return null
}

const ORDINALE_TO_LIVELLO: Record<number, LivelloCodice> = { 4: 'A', 3: 'B', 2: 'C', 1: 'D' }

/**
 * Suggerisce un livello A/B/C/D per una competenza, mediando i giudizi delle
 * materie pertinenti (vedi `COMPETENZA_MATERIE`). Ritorna `null` se nessun
 * giudizio pertinente è riconoscibile (la competenza va compilata a mano).
 */
export function suggerisciLivello(
  competenzaCodice: string,
  giudizi: GiudizioPerMateria[]
): LivelloCodice | null {
  const materie = COMPETENZA_MATERIE[competenzaCodice] ?? []
  if (materie.length === 0) return null
  const ordinali = giudizi
    .filter((g) => materie.includes(g.materia_codice))
    .map((g) => giudizioToOrdinale(g.giudizio_sintetico))
    .filter((o): o is number => o !== null)
  if (ordinali.length === 0) return null
  const media = ordinali.reduce((a, b) => a + b, 0) / ordinali.length
  const arrotondato = Math.max(1, Math.min(4, Math.round(media)))
  return ORDINALE_TO_LIVELLO[arrotondato]
}
