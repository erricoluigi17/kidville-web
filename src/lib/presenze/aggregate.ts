/**
 * Aggregazione pura delle presenze del giorno per il monitoraggio multi-sede
 * del cockpit (M7.4). Nessun I/O: riceve le righe già lette (alunni iscritti
 * nei plessi in scope, presenze di oggi, sections, schools) e produce il
 * contratto { totale, sedi:[{ scuola, presenti, iscritti, classi }] }.
 *
 * Convenzioni:
 *  - "presente" = qualunque stato ≠ 'assente' (ritardo/uscita_anticipata sono
 *    fisicamente a scuola); "assente" = stato 'assente'.
 *  - appelli_mancanti = classi con iscritti > 0 e ZERO righe di presenza oggi.
 *  - Alunni senza sezione contano su sede/totale ma non generano una classe
 *    (nessun appello atteso); presenze di alunni fuori elenco sono ignorate.
 */

export interface AlunnoRow {
  id: string
  section_id: string | null
  scuola_id: string | null
}

export interface PresenzaRow {
  alunno_id: string
  stato: string | null
}

export interface SectionRow {
  id: string
  name: string | null
  scuola_id: string | null
}

export interface SchoolRow {
  id: string
  nome: string | null
}

export interface ClasseAggregata {
  section_id: string
  classe: string
  presenti: number
  iscritti: number
  assenti: number
  appello_fatto: boolean
}

export interface SedeAggregata {
  scuola_id: string
  scuola: string
  presenti: number
  iscritti: number
  assenti: number
  appelli_mancanti: number
  classi: ClasseAggregata[]
}

export interface TotaleAggregato {
  presenti: number
  iscritti: number
  assenti: number
  appelli_mancanti: number
}

export interface PresenzeAggregate {
  totale: TotaleAggregato
  sedi: SedeAggregata[]
}

export const TOTALE_VUOTO: TotaleAggregato = Object.freeze({
  presenti: 0,
  iscritti: 0,
  assenti: 0,
  appelli_mancanti: 0,
})

export function aggregaPresenze(
  alunni: AlunnoRow[],
  presenze: PresenzaRow[],
  sections: SectionRow[],
  schools: SchoolRow[]
): PresenzeAggregate {
  const alunnoIds = new Set(alunni.map((a) => a.id))
  // 1 riga per alunno/giorno (upsert su alunno_id,data): l'ultima vince.
  const statoByAlunno = new Map<string, string>()
  for (const p of presenze) {
    if (alunnoIds.has(p.alunno_id)) statoByAlunno.set(p.alunno_id, p.stato ?? '')
  }

  const sectionById = new Map(sections.map((s) => [s.id, s]))
  const schoolById = new Map(schools.map((s) => [s.id, s]))

  const sedi = new Map<string, SedeAggregata>()
  const classi = new Map<string, ClasseAggregata>()

  for (const a of alunni) {
    if (!a.scuola_id) continue
    let sede = sedi.get(a.scuola_id)
    if (!sede) {
      sede = {
        scuola_id: a.scuola_id,
        scuola: schoolById.get(a.scuola_id)?.nome || 'Sede',
        presenti: 0,
        iscritti: 0,
        assenti: 0,
        appelli_mancanti: 0,
        classi: [],
      }
      sedi.set(a.scuola_id, sede)
    }

    let classe: ClasseAggregata | null = null
    if (a.section_id && sectionById.has(a.section_id)) {
      classe = classi.get(a.section_id) ?? null
      if (!classe) {
        classe = {
          section_id: a.section_id,
          classe: sectionById.get(a.section_id)?.name || 'Classe',
          presenti: 0,
          iscritti: 0,
          assenti: 0,
          appello_fatto: false,
        }
        classi.set(a.section_id, classe)
        sede.classi.push(classe)
      }
    }

    sede.iscritti += 1
    if (classe) classe.iscritti += 1

    const stato = statoByAlunno.get(a.id)
    if (stato !== undefined) {
      if (classe) classe.appello_fatto = true
      if (stato === 'assente') {
        sede.assenti += 1
        if (classe) classe.assenti += 1
      } else {
        sede.presenti += 1
        if (classe) classe.presenti += 1
      }
    }
  }

  const elenco = [...sedi.values()].sort((a, b) => a.scuola.localeCompare(b.scuola))
  const totale: TotaleAggregato = { presenti: 0, iscritti: 0, assenti: 0, appelli_mancanti: 0 }
  for (const sede of elenco) {
    sede.classi.sort((a, b) => a.classe.localeCompare(b.classe))
    sede.appelli_mancanti = sede.classi.filter((c) => c.iscritti > 0 && !c.appello_fatto).length
    totale.presenti += sede.presenti
    totale.iscritti += sede.iscritti
    totale.assenti += sede.assenti
    totale.appelli_mancanti += sede.appelli_mancanti
  }

  return { totale, sedi: elenco }
}
