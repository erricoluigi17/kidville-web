/**
 * Builder NEUTRI dei flussi SIDI (P5.3). Producono record normalizzati, NON il
 * wire-format finale (quello vive nei serializer, adapter sottili e sostituibili).
 * Tutta la logica di selezione è qui, testabile e indipendente dal tracciato.
 */

// ---- Fase A: allineamento strutturale (sedi/sezioni/classi/tempo scuola) ----

export interface FaseAReconcile {
  sedi: { id: string; nome: string }[]
  sezioni: { id: string; nome: string; school_type: string; tempoScuola: { modello: number; giorni: number } | null }[]
}

export function buildFaseAReconcile(input: {
  sedi?: { id: string; nome: string }[]
  sezioni: { id: string; name: string; school_type: string }[]
  tempoScuola: { section_id: string; modello: number; giorni_settimana: number; attivo: boolean }[]
}): FaseAReconcile {
  const tempoBySezione = new Map<string, { modello: number; giorni: number }>()
  for (const t of input.tempoScuola) {
    if (t.attivo) tempoBySezione.set(t.section_id, { modello: t.modello, giorni: t.giorni_settimana })
  }
  return {
    sedi: input.sedi ?? [],
    sezioni: input.sezioni.map((s) => ({
      id: s.id,
      nome: s.name,
      school_type: s.school_type,
      tempoScuola: tempoBySezione.get(s.id) ?? null,
    })),
  }
}

// ---- Frequentanti: alunni effettivamente iscritti, per classe ----

export interface FrequentantiFlusso {
  perClasse: {
    sectionId: string
    sezioneNome: string
    alunni: { id: string; codiceFiscale: string | null; cognome: string; nome: string }[]
  }[]
}

export function buildFrequentanti(input: {
  sezioni: { id: string; name: string }[]
  alunni: { id: string; section_id: string | null; codice_fiscale: string | null; nome: string; cognome: string; stato: string }[]
}): FrequentantiFlusso {
  const nomeBySezione = new Map(input.sezioni.map((s) => [s.id, s.name]))
  const perSezione = new Map<string, FrequentantiFlusso['perClasse'][number]>()
  for (const a of input.alunni) {
    if (a.stato !== 'iscritto' || !a.section_id) continue
    let g = perSezione.get(a.section_id)
    if (!g) {
      g = { sectionId: a.section_id, sezioneNome: nomeBySezione.get(a.section_id) ?? '', alunni: [] }
      perSezione.set(a.section_id, g)
    }
    g.alunni.push({ id: a.id, codiceFiscale: a.codice_fiscale, cognome: a.cognome, nome: a.nome })
  }
  return { perClasse: [...perSezione.values()] }
}

// ---- Genitori-Alunni (Piattaforma Unica): solo legami validati ----

export interface GenitoriAlunniFlusso {
  associazioni: { alunnoCF: string | null; genitoreCF: string | null; relazione: string; validato: boolean }[]
}

export function buildGenitoriAlunni(input: {
  legami: { student_cf: string | null; parent_cf: string | null; relation_type: string; validato: boolean }[]
}): GenitoriAlunniFlusso {
  return {
    associazioni: input.legami
      .filter((l) => l.validato === true)
      .map((l) => ({ alunnoCF: l.student_cf, genitoreCF: l.parent_cf, relazione: l.relation_type, validato: true })),
  }
}
