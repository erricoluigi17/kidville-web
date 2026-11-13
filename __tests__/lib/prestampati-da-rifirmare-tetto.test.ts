// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  TETTO_DA_RIFIRMARE,
  limitaDaRifirmare,
  soloFirmeRinnovabili,
  type FirmaArchiviata,
  type GruppoDaRifirmare,
} from '@/lib/prestampati/da-rifirmare'

/**
 * LA LETTURA DEL FASCICOLO PER «DA RIFIRMARE»: filtro sul tipo, ordine, tetto (compito 4.8.6).
 *
 * Il filtro sul tipo sta qui e non nella query: sul DB della CI uno slug fuori dall'enumerazione
 * risponde `22P02`, quindi la query legge tutte le righe del fascicolo (due colonne: tipo e data) e si
 * scarta subito, prima di raggruppare, tutto ciò che non si rifirma.
 *
 * Nessun dato reale: uuid e date sono inventati.
 */

const firma = (document_type: string | null, created_at: string | null): FirmaArchiviata => ({ document_type, created_at })

describe('il filtro sul tipo', () => {
  it('tiene solo i moduli che si rinnovano: i sanitari (fino a revoca) e gli atti puntuali restano fuori', () => {
    const tutte = [
      firma('delega_ritiro', '2026-10-10T08:00:00Z'),
      firma('scheda_sanitaria', '2026-10-10T08:00:00Z'),
      firma('autorizzazione_farmaci', '2026-10-10T08:00:00Z'),
      firma('dieta_speciale', '2026-10-10T08:00:00Z'),
      firma('permesso_orario', '2026-10-10T08:00:00Z'),
      firma('autorizzazione_uscita', '2026-10-10T08:00:00Z'),
      firma('certificato_iscrizione_frequenza', '2026-10-10T08:00:00Z'),
      firma('documento_sconosciuto', '2026-10-10T08:00:00Z'),
      firma(null, '2026-10-10T08:00:00Z'),
    ]
    expect(soloFirmeRinnovabili(tutte).map((f) => f.document_type)).toEqual(['delega_ritiro'])
  })

  it('uno slug con spazi attorno vale come lo slug (la stessa tolleranza del calcolo)', () => {
    expect(soloFirmeRinnovabili([firma(' delega_ritiro ', '2026-10-10T08:00:00Z')])).toHaveLength(1)
  })

  it('un elenco vuoto resta vuoto', () => {
    expect(soloFirmeRinnovabili([])).toEqual([])
  })
})

describe('il tetto', () => {
  const gruppo = (id: string, giorni: string[]): GruppoDaRifirmare => ({
    alunno_id: id,
    moduli: giorni.map((g) => ({
      slug: 'delega_ritiro' as const,
      chiaveEtichetta: 'modelli.delegaRitiro',
      ultimaFirma: g,
    })),
  })

  it('il tetto è di 20 moduli', () => {
    expect(TETTO_DA_RIFIRMARE).toBe(20)
  })

  it('sotto il tetto non toglie niente e il totale è il conto vero', () => {
    const r = limitaDaRifirmare([gruppo('a', ['2026-10-02']), gruppo('b', ['2026-10-01'])])
    expect(r.totale).toBe(2)
    expect(r.gruppi.map((g) => g.alunno_id)).toEqual(['b', 'a'])
  })

  it('ORDINE: il più vecchio scaduto va per primo, fra i figli', () => {
    const r = limitaDaRifirmare([
      gruppo('recente', ['2027-01-15']),
      gruppo('vecchio', ['2026-09-02']),
      gruppo('medio', ['2026-11-20']),
    ])
    expect(r.gruppi.map((g) => g.alunno_id)).toEqual(['vecchio', 'medio', 'recente'])
  })

  it('oltre il tetto: i primi 20 (i più vecchi) più il totale vero', () => {
    const gruppi = Array.from({ length: 25 }, (_, i) =>
      // più alto è l'indice, più vecchia la firma: l'ordine in ingresso è il contrario di quello atteso
      gruppo(`f${i}`, [`2026-10-${String(30 - i).padStart(2, '0')}`]),
    )
    const r = limitaDaRifirmare(gruppi)
    const consegnati = r.gruppi.flatMap((g) => g.moduli)
    expect(consegnati).toHaveLength(20)
    expect(r.totale).toBe(25)
    // sono i 20 più vecchi: f24 … f5
    expect(r.gruppi[0].alunno_id).toBe('f24')
    expect(r.gruppi.map((g) => g.alunno_id)).not.toContain('f0')
    expect(r.gruppi.map((g) => g.alunno_id)).not.toContain('f4')
    expect(r.gruppi.map((g) => g.alunno_id)).toContain('f5')
  })

  it('il tetto taglia anche dentro un figlio, senza lasciare gruppi vuoti', () => {
    const r = limitaDaRifirmare([gruppo('a', ['2026-09-01', '2026-09-02', '2026-09-03']), gruppo('b', ['2026-09-04'])], 2)
    expect(r.totale).toBe(4)
    expect(r.gruppi).toEqual([
      {
        alunno_id: 'a',
        moduli: [
          { slug: 'delega_ritiro', chiaveEtichetta: 'modelli.delegaRitiro', ultimaFirma: '2026-09-01' },
          { slug: 'delega_ritiro', chiaveEtichetta: 'modelli.delegaRitiro', ultimaFirma: '2026-09-02' },
        ],
      },
    ])
  })

  it('a pari data l’ordine è stabile (per figlio e poi per modulo): stessa risposta a ogni lettura', () => {
    const a = limitaDaRifirmare([gruppo('z', ['2026-09-01']), gruppo('y', ['2026-09-01'])])
    const b = limitaDaRifirmare([gruppo('y', ['2026-09-01']), gruppo('z', ['2026-09-01'])])
    expect(a.gruppi.map((g) => g.alunno_id)).toEqual(['y', 'z'])
    expect(b).toEqual(a)
  })

  it('nessun gruppo: totale 0 e niente', () => {
    expect(limitaDaRifirmare([])).toEqual({ gruppi: [], totale: 0 })
  })
})
