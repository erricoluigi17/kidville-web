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

// ── Osservabilità durevole dei canali C5 · 'chat' / 'gdpr' / 'segnalazione' ───
// Segnalato dal tester-opus-log dopo l'implementazione di C5: i successi di
// sospensione/riapertura conversazione, cancellazione account pubblica, prova di
// accettazione Termini e creazione segnalazione finivano SOLO su Vercel (1 giorno),
// mai in app_log (30 giorni) — la stessa asimmetria "solo errori" di RC3/F-log-1,
// stavolta su una feature di sicurezza/UGC e di valore legale (art. 1341 c.c.).
// Verificato prima di allargare: nessuna delle tre categorie logga un evento 'info'
// per OGNI richiesta ad alto volume (es. l'invio di un normale messaggio chat non
// logga 'chat' — solo i tentativi bloccati e le azioni di moderazione, rare per
// natura), quindi persistere i loro successi non introduce un'esplosione di righe.
describe("EVENTI_PERSISTITI · canali C5 ('chat', 'gdpr', 'segnalazione')", () => {
  it("include 'chat' (sospensione/riapertura conversazione)", () => {
    expect(EVENTI_PERSISTITI.has('chat')).toBe(true)
    expect(vaPersistito('info', 'chat')).toBe(true)
  })

  it("include 'gdpr' (cancellazione account pubblica, prova consenso Termini)", () => {
    expect(EVENTI_PERSISTITI.has('gdpr')).toBe(true)
    expect(vaPersistito('info', 'gdpr')).toBe(true)
  })

  it("include 'segnalazione' (creazione/gestione segnalazioni UGC)", () => {
    expect(EVENTI_PERSISTITI.has('segnalazione')).toBe(true)
    expect(vaPersistito('info', 'segnalazione')).toBe(true)
  })
})
