// @vitest-environment node
/**
 * `accorcia()` — il taglio che si dichiara, misurato sulla larghezza e non sui caratteri.
 *
 * Esiste perché il 2026-08-16 due motori dello stesso lotto tagliavano in due modi diversi:
 * il registro presenze misurava e metteva i puntini, l'ordine al fornitore faceva
 * `slice(0, 60)` — sessanta CARATTERI, cioè un numero che non ha niente a che vedere con i
 * millimetri della colonna. Con nomi da catalogo scolastico veri quel taglio stampava il
 * nome dell'articolo sopra la taglia e, con maiuscole larghe, fuori dal foglio.
 *
 * Il doppio qui sotto non è una finzione comoda: `getTextWidth` è l'unica cosa che serve, e
 * misurarla con larghezze note è ciò che rende il lock capace di fallire su un carattere
 * qualunque invece che solo su Helvetica.
 */
import { describe, it, expect } from 'vitest'
import { jsPDF } from 'jspdf'
import { accorcia, type MisuraTesto } from '@/lib/carta/testo'

/** Un carattere a larghezza fissa: ogni carattere vale `passo` millimetri. */
const monospazio = (passo: number): MisuraTesto => ({
  getTextWidth: (testo: string) => testo.length * passo,
})

describe('accorcia', () => {
  it('lascia intatto ciò che ci sta', () => {
    expect(accorcia(monospazio(1), 'GREMBIULE', 20)).toBe('GREMBIULE')
    // Al millimetro esatto ci sta ancora: il limite è la larghezza della colonna, non un
    // millimetro prima «per sicurezza».
    expect(accorcia(monospazio(1), 'GREMBIULE', 9)).toBe('GREMBIULE')
  })

  it('taglia sulla LARGHEZZA e lo dichiara coi puntini', () => {
    // 10 caratteri da 1 mm in 8 mm: ci stanno 5 lettere più i tre puntini.
    expect(accorcia(monospazio(1), 'ABCDEFGHIJ', 8)).toBe('ABCDE...')
    expect(accorcia(monospazio(1), 'ABCDEFGHIJ', 8).length * 1).toBeLessThanOrEqual(8)
  })

  it('non lascia lo spazio prima dei puntini', () => {
    // «GREMBIULE ...» si legge come un refuso, non come un taglio.
    expect(accorcia(monospazio(1), 'GREMBIULE BIANCO', 13)).toBe('GREMBIULE...')
  })

  it('non produce mai niente di più largo del limite', () => {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    const nomi = [
      'GREMBIULE SCOLASTICO COTONE BIANCO RICAMATO LOGO KIDVILLE GIUGLIANO',
      'FELPA CAPPUCCIO ZIP KIDVILLE PRIMARIA BLU NAVY RICAMO FRONTE E RETRO',
      'ZAINETTO ASILO NIDO KIDVILLE PERSONALIZZATO NOME BAMBINO COLORE ROSSO',
      'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW',
    ]
    for (const nome of nomi) {
      for (const larghezza of [106, 40, 12, 3]) {
        const uscita = accorcia(doc, nome, larghezza)
        expect(
          `${nome.slice(0, 12)}… in ${larghezza}mm → ${doc.getTextWidth(uscita).toFixed(2)}mm`
        ).toBe(`${nome.slice(0, 12)}… in ${larghezza}mm → ${doc.getTextWidth(uscita).toFixed(2)}mm`)
        expect(doc.getTextWidth(uscita)).toBeLessThanOrEqual(larghezza)
      }
    }
  })

  it('degrada senza lanciare su una larghezza nulla o negativa', () => {
    // Una colonna larga zero è una svista di chi impagina, non un motivo per far cadere la
    // generazione di un ordine d'acquisto.
    expect(accorcia(monospazio(1), 'GREMBIULE', 0)).toBe('')
    expect(accorcia(monospazio(1), 'GREMBIULE', -5)).toBe('')
  })

  it('quando non ci sta nemmeno una lettera restano i puntini, non una cella vuota', () => {
    // Dire «qui c'era qualcosa e non ci sta» è più onesto di una cella che sembra vuota per
    // scelta: su un ordine d'acquisto una riga senza articolo è una riga da rifare.
    expect(accorcia(monospazio(2), 'GREMBIULE', 3)).toBe('...')
  })
})
