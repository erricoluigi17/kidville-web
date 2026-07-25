import { describe, it, expect } from 'vitest'
import { haCookieSessione } from '@/lib/auth/session-cookie'

// Funzione pura: si passa un finto cookie store, nessun mock.

function store(nomi: string[]) {
  return { getAll: () => nomi.map((name) => ({ name })) }
}

describe('haCookieSessione', () => {
  it('riconosce il cookie di sessione Supabase', () => {
    expect(haCookieSessione(store(['sb-abcdefgh-auth-token']))).toBe(true)
  })

  it('riconosce anche la forma SPEZZATA (token lungo)', () => {
    // `@supabase/ssr` spezza il cookie quando supera la dimensione massima:
    // senza questo caso, su un progetto con token lungo il flag sarebbe sempre
    // falso e il gate biometrico non si armerebbe mai.
    expect(haCookieSessione(store(['sb-abcdefgh-auth-token.0', 'sb-abcdefgh-auth-token.1']))).toBe(
      true,
    )
  })

  it('senza cookie di sessione → false', () => {
    expect(haCookieSessione(store(['kv_contrast', 'KV_LOCALE', 'kv-active-role']))).toBe(false)
  })

  it('un cookie che somiglia ma non è quello → false', () => {
    expect(haCookieSessione(store(['sb-abcdefgh-refresh', 'auth-token']))).toBe(false)
  })

  it('cookie non leggibili → false (default sicuro: niente lockout)', () => {
    const rotto = {
      getAll() {
        throw new Error('cookie non accessibili')
      },
    }
    expect(haCookieSessione(rotto)).toBe(false)
  })
})
