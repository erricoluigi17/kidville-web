/**
 * Serializer dei flussi SIDI in wire-format (P5.3). **Adapter sottili e
 * sostituibili**: il tracciato XML/flusso reale del SIDI non è noto finché non
 * si dispone dell'accreditamento e della documentazione ministeriale. Qui si
 * produce una rappresentazione XML neutra, deterministica; al tracciato reale
 * basterà riscrivere queste funzioni senza toccare i builder (`payload.ts`).
 */

import type { FaseAReconcile, FrequentantiFlusso, GenitoriAlunniFlusso } from './payload'

function esc(v: string | null | undefined): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function serializeFaseA(p: FaseAReconcile): string {
  const sezioni = p.sezioni
    .map(
      (s) =>
        `<sezione id="${esc(s.id)}" tipo="${esc(s.school_type)}" nome="${esc(s.nome)}"` +
        (s.tempoScuola ? ` modello="${s.tempoScuola.modello}" giorni="${s.tempoScuola.giorni}"` : '') +
        '/>'
    )
    .join('')
  const sedi = p.sedi.map((s) => `<sede id="${esc(s.id)}" nome="${esc(s.nome)}"/>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><faseA><sedi>${sedi}</sedi><sezioni>${sezioni}</sezioni></faseA>`
}

export function serializeFrequentanti(p: FrequentantiFlusso): string {
  const classi = p.perClasse
    .map((c) => {
      const alunni = c.alunni
        .map((a) => `<alunno cf="${esc(a.codiceFiscale)}" cognome="${esc(a.cognome)}" nome="${esc(a.nome)}"/>`)
        .join('')
      return `<classe sezione="${esc(c.sezioneNome)}">${alunni}</classe>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><frequentanti>${classi}</frequentanti>`
}

export function serializeGenitoriAlunni(p: GenitoriAlunniFlusso): string {
  const assoc = p.associazioni
    .map((a) => `<associazione alunnoCF="${esc(a.alunnoCF)}" genitoreCF="${esc(a.genitoreCF)}" relazione="${esc(a.relazione)}"/>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><genitoriAlunni>${assoc}</genitoriAlunni>`
}
