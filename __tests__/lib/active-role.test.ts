import { describe, it, expect } from 'vitest'

// M4B.2 — regole PURE dello smistamento per ruolo: area "casa" di ogni ruolo,
// matrice ruolo-attivo → area (eccezione: staff di gestione può aprire anche
// /teacher), parsing del cookie `kv-active-role`, area di un pathname.

import {
  ACTIVE_ROLE_COOKIE,
  areaForRole,
  areaFromPath,
  homePathForArea,
  homePathForRole,
  isAreaAllowed,
  parseActiveRole,
} from '@/lib/auth/active-role'

describe('areaForRole — area "casa" di ogni ruolo', () => {
  it('staff di gestione → admin (cuoca inclusa: report in /admin/mensa/cucina)', () => {
    expect(areaForRole('admin')).toBe('admin')
    expect(areaForRole('coordinator')).toBe('admin')
    expect(areaForRole('segreteria')).toBe('admin')
    expect(areaForRole('cuoca')).toBe('admin')
  })

  it('educator → teacher, genitore → parent, ignoto → parent (area meno privilegiata)', () => {
    expect(areaForRole('educator')).toBe('teacher')
    expect(areaForRole('genitore')).toBe('parent')
    expect(areaForRole('ruolo-ignoto')).toBe('parent')
  })
})

describe('isAreaAllowed — matrice ruolo attivo → area', () => {
  it('staff di gestione: admin + teacher (eccezione preservata), NON parent', () => {
    for (const staff of ['admin', 'coordinator', 'segreteria']) {
      expect(isAreaAllowed(staff, 'admin')).toBe(true)
      expect(isAreaAllowed(staff, 'teacher')).toBe(true)
      expect(isAreaAllowed(staff, 'parent')).toBe(false)
    }
  })

  it('educator: solo teacher', () => {
    expect(isAreaAllowed('educator', 'teacher')).toBe(true)
    expect(isAreaAllowed('educator', 'admin')).toBe(false)
    expect(isAreaAllowed('educator', 'parent')).toBe(false)
  })

  it('genitore: solo parent', () => {
    expect(isAreaAllowed('genitore', 'parent')).toBe(true)
    expect(isAreaAllowed('genitore', 'teacher')).toBe(false)
    expect(isAreaAllowed('genitore', 'admin')).toBe(false)
  })

  it('cuoca: solo admin', () => {
    expect(isAreaAllowed('cuoca', 'admin')).toBe(true)
    expect(isAreaAllowed('cuoca', 'teacher')).toBe(false)
    expect(isAreaAllowed('cuoca', 'parent')).toBe(false)
  })

  it('ruolo ignoto: nessuna area', () => {
    expect(isAreaAllowed('hacker', 'admin')).toBe(false)
    expect(isAreaAllowed('', 'parent')).toBe(false)
  })
})

describe('parseActiveRole — validazione del cookie', () => {
  it('accetta solo ruoli noti', () => {
    expect(parseActiveRole('educator')).toBe('educator')
    expect(parseActiveRole('genitore')).toBe('genitore')
    expect(parseActiveRole('superadmin')).toBeNull()
    expect(parseActiveRole('')).toBeNull()
    expect(parseActiveRole(null)).toBeNull()
    expect(parseActiveRole(undefined)).toBeNull()
  })

  it('il nome del cookie è kv-active-role', () => {
    expect(ACTIVE_ROLE_COOKIE).toBe('kv-active-role')
  })
})

describe('areaFromPath / homePath*', () => {
  it('riconosce le tre aree, anche in sotto-rotte', () => {
    expect(areaFromPath('/parent')).toBe('parent')
    expect(areaFromPath('/teacher/registro')).toBe('teacher')
    expect(areaFromPath('/admin/mensa/cucina')).toBe('admin')
  })

  it('fuori area → null (nessun falso positivo su prefissi simili)', () => {
    expect(areaFromPath('/')).toBeNull()
    expect(areaFromPath('/auth/login')).toBeNull()
    expect(areaFromPath('/parents')).toBeNull()
    expect(areaFromPath('/administrator')).toBeNull()
  })

  it('home coerenti col ruolo', () => {
    expect(homePathForArea('teacher')).toBe('/teacher')
    expect(homePathForRole('genitore')).toBe('/parent')
    expect(homePathForRole('segreteria')).toBe('/admin')
  })
})
