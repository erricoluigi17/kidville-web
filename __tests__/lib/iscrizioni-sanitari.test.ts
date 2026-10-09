import { describe, it, expect } from 'vitest'
import {
  copiaSanitariPresente,
  haSanitari,
  normalizzaSanitario,
  sanitariDaScrivere,
} from '@/lib/iscrizioni/sanitari'
import { scrubSanitariDomanda } from '@/lib/gdpr/anonimizza'

// =============================================================================
// La regola dei dati sanitari fra domanda e scheda (2026-10-09).
// Il difetto: la re-iscrizione non portava allergie e note in scheda, e la
// domanda le perdeva comunque. Qui la regola, caso per caso. Solo testi di prova.
// =============================================================================

const IL_9_OTTOBRE = new Date('2026-10-09T10:00:00Z')

describe('sanitariDaScrivere — riempi il vuoto, non sovrascrivere, aggiungi ciò che è diverso', () => {
  it('scheda vuota: si scrive il testo della domanda, così com\'è (solo senza spazi ai bordi)', () => {
    expect(sanitariDaScrivere({ allergies: null, note_mediche: '' }, { allergies: '  Kiwi ', note_mediche: 'Asma' }, IL_9_OTTOBRE))
      .toEqual({ allergies: 'Kiwi', note_mediche: 'Asma' })
  })

  it('la scheda contiene già quel testo (spazi e maiuscole a parte): niente da scrivere', () => {
    expect(sanitariDaScrivere({ allergies: 'Arachidi, kiwi e fragole' }, { allergies: 'KIWI  e fragole' }, IL_9_OTTOBRE)).toEqual({})
  })

  it('la scheda dice altro: NON si sovrascrive, si aggiunge in coda con la data', () => {
    const out = sanitariDaScrivere({ allergies: 'Arachidi' }, { allergies: 'nessuna' }, IL_9_OTTOBRE)
    expect(out.allergies).toBe('Arachidi\nDalla domanda di iscrizione del 09/10/2026: nessuna')
    expect(out.allergies!.startsWith('Arachidi'), '«nessuna» ha cancellato un\'allergia vera').toBe(true)
  })

  it('domanda senza dati sanitari: nessun campo da scrivere, nemmeno vuoto', () => {
    expect(sanitariDaScrivere({ allergies: 'Arachidi' }, { allergies: '   ', note_mediche: null }, IL_9_OTTOBRE)).toEqual({})
    expect(sanitariDaScrivere({}, null, IL_9_OTTOBRE)).toEqual({})
  })

  it('la data è quella italiana (Europe/Rome), non quella UTC', () => {
    const mezzanotteItaliana = new Date('2026-10-08T22:30:00Z') // 00:30 del 9 a Roma
    expect(sanitariDaScrivere({ allergies: 'X' }, { allergies: 'Y' }, mezzanotteItaliana).allergies).toContain('09/10/2026')
  })
})

describe('copiaSanitariPresente — la condizione per togliere i sanitari dalla domanda', () => {
  it('vera solo se OGNI campo della domanda è nella scheda', () => {
    const figlio = { allergies: 'Kiwi', note_mediche: 'Asma' }
    expect(copiaSanitariPresente({ allergies: 'kiwi', note_mediche: 'asma lieve' }, figlio)).toBe(true)
    expect(copiaSanitariPresente({ allergies: 'kiwi', note_mediche: null }, figlio)).toBe(false)
    expect(copiaSanitariPresente({}, figlio)).toBe(false)
  })

  it('dopo `sanitariDaScrivere` la copia c\'è sempre (è la promessa su cui si toglie dalla domanda)', () => {
    const scheda = { allergies: 'Arachidi', note_mediche: null }
    const figlio = { allergies: 'Kiwi', note_mediche: 'Asma' }
    const dopo = { ...scheda, ...sanitariDaScrivere(scheda, figlio, IL_9_OTTOBRE) }
    expect(copiaSanitariPresente(dopo, figlio)).toBe(true)
  })

  it('un bambino senza dati sanitari ha sempre la copia «presente»', () => {
    expect(copiaSanitariPresente({}, { nome: 'Bimbo' })).toBe(true)
    expect(haSanitari({ allergies: ' ', note_mediche: null })).toBe(false)
    expect(haSanitari({ note_mediche: 'x' })).toBe(true)
  })

  it('la normalizzazione è la stessa del job SQL: spazi compressi e minuscole', () => {
    expect(normalizzaSanitario('  Uova\n\tE   LATTE ')).toBe('uova e latte')
    expect(normalizzaSanitario(null)).toBe('')
  })
})

describe('scrubSanitariDomanda — toglie solo dove la copia c\'è', () => {
  const data = {
    children: [
      { nome: 'A', allergies: 'Kiwi', note_mediche: null },
      { nome: 'B', allergies: 'Uova', note_mediche: 'Asma' },
      { nome: 'C', allergies: null, note_mediche: null },
    ],
  }

  it('il bambino senza copia resta intero, e si conta', () => {
    const out = scrubSanitariDomanda(data, '2026-10-09T10:00:00Z', (i) => i !== 1)
    const figli = out.data.children as Record<string, unknown>[]
    expect(figli[0].allergies).toBeNull()
    expect(figli[0].sanitari_rimossi_il).toBe('2026-10-09T10:00:00Z')
    expect(figli[1].allergies).toBe('Uova')
    expect(figli[1].sanitari_rimossi_il).toBeUndefined()
    expect(out).toMatchObject({ minoriScrubbati: 1, minoriConservati: 1 })
  })

  it('senza il predicato (l\'oblio) si toglie tutto, come prima', () => {
    const out = scrubSanitariDomanda(data, '2026-10-09T10:00:00Z')
    expect(out).toMatchObject({ minoriScrubbati: 2, minoriConservati: 0 })
  })
})
