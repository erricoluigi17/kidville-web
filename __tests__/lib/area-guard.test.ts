import { describe, it, expect } from 'vitest'

// M4B.4 — decisione pura della guardia d'area: profili + cookie ruolo attivo
// + area richiesta → null (ok) oppure path di redirect. Copre i casi smoke
// del MILESTONE GATE M4B (docente su /parent → /teacher; doppio → picker).

import { decideAreaAccess } from '@/lib/auth/area-guard'
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
