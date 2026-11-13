import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Chi chiama `doLogout` per una SCELTA dell'utente deve passare da `ConfermaUscita`: un tocco sbagliato su
// «Esci» (successo nel collaudo del 13/11, foglio in scorrimento) chiude la sessione. Eccezioni dichiarate:
//  · `BiometricGate`: è l'ultima via d'uscita quando la biometria non passa, non deve diventare un vicolo cieco;
//  · `CambiaPasswordCard`: l'uscita lì è l'effetto obbligato del cambio password, non una scelta;
//  · `logout.ts`: dove `doLogout` è definita.
const ECCEZIONI = [
  'src/lib/auth/logout.ts',
  'src/components/providers/BiometricGate.tsx',
  'src/components/features/account/CambiaPasswordCard.tsx',
]

function file(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) file(p, out)
    else if (/\.tsx?$/.test(n)) out.push(p)
  }
  return out
}

describe('ogni uscita scelta dall\'utente passa dalla conferma', () => {
  const chiamanti = file('src').filter((p) => {
    if (ECCEZIONI.includes(p)) return false
    // chiamata vera (non un commento): `doLogout(` o `doLogout)`/`doLogout }` in import
    const righe = readFileSync(p, 'utf8').split('\n').filter((r) => !/^\s*(\*|\/\/|\/\*)/.test(r))
    return righe.some((r) => /\bdoLogout\s*\(/.test(r) || /\bonConferma=\{doLogout\}/.test(r) || /onConferma=\{\s*onLogout\s*\}/.test(r))
  })

  it('ci sono dei chiamanti (il lock non è cieco)', () => {
    expect(chiamanti.length).toBeGreaterThanOrEqual(3)
  })

  it.each(chiamanti)('%s usa ConfermaUscita', (p) => {
    expect(readFileSync(p, 'utf8')).toContain('ConfermaUscita')
  })

  it('nessun chiamante dentro un onClick diretto', () => {
    for (const p of chiamanti) {
      expect(readFileSync(p, 'utf8'), p).not.toMatch(/onClick=\{[^}]*doLogout/)
    }
  })
})

// Decisione di Luigi del 13/11/2026: «Esci» chiude la sessione SOLO su questo dispositivo. Il lato server
// dell'uscita non deve quindi chiudere sessioni (né `auth.admin.signOut` né una uscita globale): toglie
// solo i cookie di questo browser. Il client passa `scope: 'local'` (vedi `__tests__/lib/logout.test.ts`).
describe('l\'uscita non tocca le altre sessioni', () => {
  const route = readFileSync('src/app/api/auth/logout/route.ts', 'utf8')
    .split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n')
  it('POST /api/auth/logout non chiama nessun signOut', () => {
    expect(route).not.toMatch(/signOut|admin\./)
  })
  it('doLogout chiama signOut con scope local e mai senza', () => {
    // senza i commenti: quello in testa al file nomina `auth.signOut()` a parole
    const src = readFileSync('src/lib/auth/logout.ts', 'utf8')
      .split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n')
    expect(src).toContain("signOut({ scope: 'local' })")
    expect(src).not.toMatch(/signOut\(\s*\)/)
  })
})
