import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// La pill della lingua della login sta in position:absolute a max(12px, safe-area) ed è alta ~32px.
// Il padding di testa della pagina deve stare sotto il suo bordo inferiore, altrimenti sui telefoni
// col notch (safe-area ~50px) la pill copre il logo (rilievo collaudo 13/11, iPhone 16e).
const css = readFileSync('src/app/auth/login/page.module.css', 'utf8')
const tsx = readFileSync('src/app/auth/login/page.tsx', 'utf8')

describe('login: la pill della lingua non copre il logo', () => {
  it('la pill sta a max(12px, safe-area) dall’alto', () => {
    expect(tsx).toContain("top: 'max(12px, env(safe-area-inset-top))'")
  })

  it('il padding di testa riserva almeno 36px sotto quella posizione, anche nel ramo per schermi bassi', () => {
    const riga = css.match(/--kv-testa-login:\s*([^;]+);/)
    expect(riga).not.toBeNull()
    expect(riga![1]).toContain('max(12px, env(safe-area-inset-top))')
    expect(riga![1]).toMatch(/\+ 36px/)
    const usi = css.match(/padding:\s*var\(--kv-testa-login\)/g) ?? []
    expect(usi).toHaveLength(2)
    expect(css).not.toMatch(/padding:\s*calc\((?:12|16)px \+ env\(safe-area-inset-top\)\)/)
  })
})
