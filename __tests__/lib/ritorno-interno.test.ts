import { describe, it, expect } from 'vitest'
import { ritornoInterno } from '@/lib/ui/ritorno-interno'

/**
 * R25 — il ritorno da una pagina pubblica è un PERCORSO di questa app.
 *
 * Il valore arriva dalla query string (`/privacy?da=…`), cioè da chiunque sappia
 * scrivere un URL: se finisse tale e quale dentro un `href`, la riga «← Torna
 * indietro» dell'informativa privacy diventerebbe un rimbalzo verso un sito
 * qualunque — con la barra degli indirizzi che dice ancora `app.kidville.it`
 * finché il tocco non parte. È la forma classica dell'open redirect, e su una
 * pagina che parla di dati sanitari di minori è anche il posto più credibile
 * dove piazzare una finta schermata di login.
 *
 * La regola è per LISTA BIANCA come la redazione dei log: passa solo ciò che ha
 * la forma di un percorso interno; tutto il resto torna alla home.
 */
describe('ritornoInterno', () => {
  it('un percorso dell’app passa intero, query compresa', () => {
    expect(ritornoInterno('/parent/attendance')).toBe('/parent/attendance')
    expect(ritornoInterno('/parent/primaria/assenze?studentId=abc')).toBe('/parent/primaria/assenze?studentId=abc')
  })

  it('senza indicazione si torna alla home', () => {
    expect(ritornoInterno(undefined)).toBe('/')
    expect(ritornoInterno(null)).toBe('/')
    expect(ritornoInterno('')).toBe('/')
  })

  it('un URL assoluto NON è un ritorno', () => {
    expect(ritornoInterno('https://kidville.example/phishing')).toBe('/')
    expect(ritornoInterno('http://localhost:3100/parent')).toBe('/')
    expect(ritornoInterno('javascript:alert(1)')).toBe('/')
  })

  it('le due forme che SEMBRANO interne e non lo sono', () => {
    // `//host` è protocol-relative: il browser lo risolve come `https://host`.
    expect(ritornoInterno('//kidville.example/phishing')).toBe('/')
    // Le barre rovesciate: alcuni browser normalizzano `\` in `/` PRIMA di
    // risolvere l'URL, quindi `/\host` diventa `//host`.
    expect(ritornoInterno('/\\kidville.example')).toBe('/')
    expect(ritornoInterno('\\\\kidville.example')).toBe('/')
  })

  it('un valore che non è nemmeno una stringa non rompe niente', () => {
    expect(ritornoInterno(['/parent'] as unknown as string)).toBe('/')
    expect(ritornoInterno(42 as unknown as string)).toBe('/')
  })
})
