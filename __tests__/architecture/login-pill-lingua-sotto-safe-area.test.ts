import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// La pill della lingua della login sta in position:absolute a max(12px, safe-area) ed è alta ~32px.
// Il padding di testa della pagina deve stare sotto il suo bordo inferiore, altrimenti sui telefoni
// col notch (safe-area ~50px) la pill copre il logo (rilievo collaudo 13/11, iPhone 16e).
const css = readFileSync('src/app/auth/login/page.module.css', 'utf8')
const tsx = readFileSync('src/app/auth/login/page.tsx', 'utf8')

const switcher = readFileSync('src/components/features/i18n/LanguageSwitcher.tsx', 'utf8')

describe('login: la pill della lingua non copre il logo', () => {
  it('la pill sta a max(12px, safe-area) dall’alto', () => {
    expect(tsx).toContain("top: 'max(12px, env(safe-area-inset-top))'")
  })

  it('lo spazio sotto la pill (36px) si riserva solo sotto i 600px, in entrambi i padding di testa', () => {
    const base = css.match(/--kv-testa-login:\s*calc\(16px \+ env\(safe-area-inset-top\)\);/)
    expect(base, 'fuori dalla media query il padding di testa torna quello di sempre').not.toBeNull()
    const media = css.match(/@media \(max-width: 600px\)\s*\{\s*\.page\s*\{([^}]*)\}/)
    expect(media, 'manca la media query sotto i 600px').not.toBeNull()
    expect(media![1]).toMatch(/--kv-testa-login:\s*max\([^;]*max\(12px, env\(safe-area-inset-top\)\)\s*\+ 36px/)
    expect(media![1]).toMatch(/--kv-testa-login-bassa:\s*max\([^;]*max\(12px, env\(safe-area-inset-top\)\)\s*\+ 36px/)
    expect(css.match(/padding:\s*var\(--kv-testa-login\) 0/g) ?? []).toHaveLength(1)
    expect(css.match(/padding:\s*var\(--kv-testa-login-bassa\) 0/g) ?? []).toHaveLength(1)
    expect(css).not.toMatch(/padding:\s*calc\((?:12|16)px \+ env\(safe-area-inset-top\)\)/)
  })

  it('il 36 è legato all’altezza della pill: se il LanguageSwitcher cambia padding il lock cade', () => {
    expect(switcher).toContain('p-1')
    expect(switcher.match(/px-3 py-1 font-barlow text-xs/g) ?? []).toHaveLength(1)
    expect(switcher).toContain('lock `login-pill-lingua-sotto-safe-area`')
  })
})
