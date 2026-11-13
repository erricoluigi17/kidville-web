import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Le schede di Impostazioni in una riga che scorre (telefono) erano alte 36px: sotto l'area minima di
// tocco di 44px, e il dito ne sbagliava una vicina (collaudo 13/11, iPhone 16e). Il lock legge il sorgente.
const sorgente = readFileSync('src/app/(dashboard)/admin/impostazioni/page.tsx', 'utf8')

describe('Impostazioni: le schede della riga a scorrimento hanno almeno 44px di area di tocco', () => {
  it('il bottone della scheda dichiara min-h-[44px]', () => {
    const nav = sorgente.slice(sorgente.indexOf('<nav className="mb-6 lg:hidden'))
    const bottone = nav.slice(nav.indexOf('<button'), nav.indexOf('</button>'))
    expect(bottone).toContain('min-h-[44px]')
  })
})
