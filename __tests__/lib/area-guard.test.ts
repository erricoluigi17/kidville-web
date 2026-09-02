import { describe, it, expect } from 'vitest'

// M4B.4 — decisione pura della guardia d'area: profili + cookie ruolo attivo
// + area richiesta → null (ok) oppure path di redirect. Copre i casi smoke
// del MILESTONE GATE M4B (docente su /parent → /teacher; doppio → picker).

import { decideAreaAccess, decideRootLanding } from '@/lib/auth/area-guard'
import type { Profilo } from '@/lib/auth/profili'

const educator: Profilo[] = [{ ruolo: 'educator', area: 'teacher' }]
const genitore: Profilo[] = [{ ruolo: 'genitore', area: 'parent' }]
const segreteria: Profilo[] = [{ ruolo: 'segreteria', area: 'admin' }]
const doppio: Profilo[] = [
  { ruolo: 'educator', area: 'teacher' },
  { ruolo: 'genitore', area: 'parent' },
]

describe('decideAreaAccess', () => {
  it('anonimo o non collegato → login (difesa in profondità oltre il middleware)', () => {
    expect(decideAreaAccess(null, null, 'parent')).toBe('/auth/login')
    expect(decideAreaAccess([], null, 'teacher')).toBe('/auth/login')
  })

  it('ruolo unico senza cookie: fallback sul proprio ruolo', () => {
    expect(decideAreaAccess(educator, null, 'teacher')).toBeNull()
    expect(decideAreaAccess(genitore, null, 'parent')).toBeNull()
  })

  it('SMOKE: docente su /parent → redirect /teacher', () => {
    expect(decideAreaAccess(educator, null, 'parent')).toBe('/teacher')
    expect(decideAreaAccess(educator, 'educator', 'parent')).toBe('/teacher')
  })

  it('genitore su /teacher o /admin → redirect /parent', () => {
    expect(decideAreaAccess(genitore, null, 'teacher')).toBe('/parent')
    expect(decideAreaAccess(genitore, null, 'admin')).toBe('/parent')
  })

  it('staff di gestione: /admin e /teacher ok (eccezione preservata), /parent → /admin', () => {
    expect(decideAreaAccess(segreteria, null, 'admin')).toBeNull()
    expect(decideAreaAccess(segreteria, null, 'teacher')).toBeNull()
    expect(decideAreaAccess(segreteria, null, 'parent')).toBe('/admin')
  })

  it('SMOKE: doppio profilo senza ruolo attivo → login per la scelta', () => {
    expect(decideAreaAccess(doppio, null, 'parent')).toBe('/auth/login?scegli=1&next=/parent')
    expect(decideAreaAccess(doppio, null, 'teacher')).toBe('/auth/login?scegli=1&next=/teacher')
  })

  it('doppio profilo con ruolo attivo: naviga la propria area, l\'altra reindirizza', () => {
    expect(decideAreaAccess(doppio, 'educator', 'teacher')).toBeNull()
    expect(decideAreaAccess(doppio, 'educator', 'parent')).toBe('/teacher')
    expect(decideAreaAccess(doppio, 'genitore', 'parent')).toBeNull()
    expect(decideAreaAccess(doppio, 'genitore', 'teacher')).toBe('/parent')
  })

  it('cookie con ruolo NON tra i profili: ignorato (niente escalation)', () => {
    expect(decideAreaAccess(educator, 'admin', 'admin')).toBe('/teacher')
    expect(decideAreaAccess(genitore, 'educator', 'teacher')).toBe('/parent')
    expect(decideAreaAccess(doppio, 'admin', 'teacher')).toBe('/auth/login?scegli=1&next=/teacher')
  })

  it('cuoca: /admin ok, altrove → /admin', () => {
    const cuoca: Profilo[] = [{ ruolo: 'cuoca', area: 'admin' }]
    expect(decideAreaAccess(cuoca, null, 'admin')).toBeNull()
    expect(decideAreaAccess(cuoca, null, 'teacher')).toBe('/admin')
  })

  it('anti-loop: ruolo fuori matrice non viene mai reindirizzato alla stessa area', () => {
    const legacy = [{ ruolo: 'maestra', area: 'parent' }] as unknown as Profilo[]
    // home di fallback = /parent: su /parent sarebbe un giro infinito → login
    expect(decideAreaAccess(legacy, null, 'parent')).toBe('/auth/login')
    expect(decideAreaAccess(legacy, null, 'teacher')).toBe('/parent')
    expect(decideAreaAccess(legacy, null, 'admin')).toBe('/parent')
  })
})

describe('decideRootLanding', () => {
  it('anonimo o nessun profilo → login', () => {
    expect(decideRootLanding(null, null)).toBe('/auth/login')
    expect(decideRootLanding([], null)).toBe('/auth/login')
  })

  it('profilo unico → home del ruolo (anche senza cookie)', () => {
    expect(decideRootLanding(educator, null)).toBe('/teacher')
    expect(decideRootLanding(genitore, null)).toBe('/parent')
    expect(decideRootLanding(segreteria, null)).toBe('/admin')
  })

  it('doppio profilo con ruolo attivo valido → home di QUEL ruolo', () => {
    expect(decideRootLanding(doppio, 'educator')).toBe('/teacher')
    expect(decideRootLanding(doppio, 'genitore')).toBe('/parent')
  })

  it('doppio profilo senza ruolo attivo → login per la scelta', () => {
    expect(decideRootLanding(doppio, null)).toBe('/auth/login?scegli=1')
  })

  it('cookie con ruolo NON tra i profili è ignorato (niente escalation)', () => {
    // profilo unico: si ricade sul proprio ruolo, non su quello del cookie
    expect(decideRootLanding(genitore, 'admin')).toBe('/parent')
    // doppio profilo: cookie estraneo → resta ambiguo → scelta
    expect(decideRootLanding(doppio, 'admin')).toBe('/auth/login?scegli=1')
  })

  it('cuoca (home sotto /admin) → /admin', () => {
    const cuoca: Profilo[] = [{ ruolo: 'cuoca', area: 'admin' }]
    expect(decideRootLanding(cuoca, null)).toBe('/admin')
  })
})

/* ────────────────────────────────────────────────────────────────────────────
 * LA RISOLUZIONE DEL RUOLO ATTIVO ORA VIVE IN UN POSTO SOLO
 *
 * Stava scritta due volte — `decideAreaAccess` e `decideRootLanding` —
 * IDENTICA carattere per carattere. Due copie della stessa decisione divergono
 * al primo ritocco, e questa decisione è di sicurezza: dice quale veste una
 * persona sta indossando. Ora entrambe chiamano `risolviRuoloAttivo`
 * (`active-role.ts`), che è la stessa funzione usata dai gate API.
 *
 * I casi qui sotto sono AGGIUNTI: non riscrivono niente di quelli sopra, e
 * verificano ciò che prima nessuno verificava — che le due strade CONCORDINO.
 * ──────────────────────────────────────────────────────────────────────────── */

describe('le due decisioni concordano sempre sul ruolo attivo', () => {
  const casi: Array<[string, Profilo[], string | null]> = [
    ['profilo unico, nessun cookie', educator, null],
    ['profilo unico, cookie estraneo', genitore, 'admin'],
    ['doppio profilo, cookie valido', doppio, 'genitore'],
    ['doppio profilo, cookie valido (l\'altro)', doppio, 'educator'],
    ['doppio profilo, nessun cookie', doppio, null],
    ['doppio profilo, cookie estraneo', doppio, 'admin'],
  ]

  for (const [nome, profili, cookie] of casi) {
    it(`${nome}: chi va alla radice atterra dove la guardia d'area lo lascerebbe entrare`, () => {
      const landing = decideRootLanding(profili, cookie)
      // Ambiguo di qua = ambiguo di là: la scelta si chiede in entrambi i casi.
      if (landing.startsWith('/auth/login?scegli=1')) {
        expect(decideAreaAccess(profili, cookie, 'parent')).toBe(
          '/auth/login?scegli=1&next=/parent',
        )
        return
      }
      // Altrimenti: l'area di atterraggio è un'area in cui la guardia lo fa ENTRARE
      // (`null` = accesso ok). Se le due copie divergessero, qui uscirebbe un redirect.
      const area = landing.slice(1) as 'admin' | 'teacher' | 'parent'
      expect(decideAreaAccess(profili, cookie, area)).toBeNull()
    })
  }
})

describe('il cookie passa da una lista CHIUSA di ruoli', () => {
  it('un valore inventato non viene mai onorato, nemmeno se combacia con un profilo legacy', () => {
    // `parseActiveRole` gira PRIMA del confronto coi profili: il cookie è input del
    // client e non può nominare un ruolo che l'app non conosce. Con due profili
    // legacy e un cookie fuori lista, la scelta resta AMBIGUA invece di essere
    // decisa da una stringa arbitraria arrivata dal browser.
    const legacy = [{ ruolo: 'maestra' }, { ruolo: 'bidella' }] as unknown as Profilo[]
    expect(decideRootLanding(legacy, 'maestra')).toBe('/auth/login?scegli=1')
  })

  it('un profilo legacy UNICO resta però risolvibile: è il ruolo vero di quella persona', () => {
    // Regressione sull'anti-loop già coperto sopra: il ripiego «profilo unico» non
    // passa da `parseActiveRole` e continua a restituire il ruolo così com'è in `utenti`.
    const legacy = [{ ruolo: 'maestra' }] as unknown as Profilo[]
    expect(decideRootLanding(legacy, null)).toBe('/parent')
  })
})
