import { describe, it, expect } from 'vitest'
import { EVENTI_PERSISTITI, vaPersistito } from '@/lib/logging/logger'

// ── Osservabilità durevole del canale 'cassa' (RC3 / F-log-1) ─────────────────
// I SUCCESSI degli eventi critici vanno persistiti in app_log (AGENTS regola 5):
// senza, "nessuna riga cassa" non distingue "tutto ok" da "non è mai partito".
// Il canale gemello 'pagamento' è già whitelisted; 'cassa' deve seguirlo.
describe("EVENTI_PERSISTITI · canale 'cassa'", () => {
  it("include 'cassa' (i successi di cassa vengono persistiti in app_log)", () => {
    expect(EVENTI_PERSISTITI.has('cassa')).toBe(true)
  })

  it("vaPersistito('info','cassa') === true (successo cassa → app_log)", () => {
    expect(vaPersistito('info', 'cassa')).toBe(true)
  })

  it("non allarga la whitelist ad altri canali non critici", () => {
    // Sanity: un canale generico NON deve persistere i propri info.
    expect(vaPersistito('info', 'db')).toBe(false)
  })
})
