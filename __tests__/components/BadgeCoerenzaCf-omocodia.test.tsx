import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

import { SEDE_A } from '../fixtures/sedi'
import itShared from '../../messages/it/shared.json'
import { badgeHaQualcosaDaDire } from '@/components/features/anagrafica/BadgeCoerenzaCf'
import { calcolaCodiceFiscale, carattereControllo, type DatiAnagraficiCf } from '@/lib/fiscale/calcolo'
import { verificaCoerenza } from '@/lib/fiscale/coerenza'
import { OMOCODIA_DA_CIFRA, POSIZIONI_NUMERICHE } from '@/lib/fiscale/tabelle'
import { validaCodiceFiscale } from '@/lib/fiscale/validazione'

// =============================================================================
// Il badge del codice fiscale sulle SCHEDE (alunno e genitore) davanti a un
// codice OMOCODICO — decisioni del titolare del 26/09/2026:
//
//  (a) omocodia coerente con l'anagrafica → nessun avviso;
//  (b) codice valido ma diverso dal calcolato per altri motivi → avviso, e
//      «Usa questo» RESTA.
//
// Un omocodico l'ha assegnato l'Agenzia quando due persone collidono: è
// legittimo, ed è per costruzione DIVERSO dal codice calcolato dai dati. Se il
// badge lo confrontasse alla lettera, ogni omocodico sarebbe «non coerente» e si
// vedrebbe proporre «Usa questo» — cioè la sostituzione del proprio codice vero.
//
// ⚠️ Nessun codice fiscale scritto in questo file (repository PUBBLICO): si
// COSTRUISCONO a runtime con `src/lib/fiscale` su nomi inventati. §1 usa il
// codice catastale `Z999` (serie non assegnata a nessuno stato, la convenzione di
// `coerenza.test.ts`); §2 e §3 usano `H501` perché le schede lo devono trovare
// nell'elenco dei comuni finto — e, nei casi (c), il catastale NULL, che è la forma
// in cui la colonna sta su TUTTE le righe di produzione.
// =============================================================================

vi.mock('@/lib/auth/current-teacher', () => ({ getCurrentTeacherId: () => null }))
vi.mock('@/components/features/admin/StudentEconomicSection', () => ({
  StudentEconomicSection: () => null,
}))
vi.mock('@/lib/logging/client', () => ({ logClient: vi.fn(), nomeErrore: () => 'e' }))

import { StudentDetailPanel } from '@/components/features/admin/StudentDetailPanel'
import { ParentDetailPanel } from '@/components/features/admin/ParentDetailPanel'

function calcola(dati: DatiAnagraficiCf): string {
  const esito = calcolaCodiceFiscale(dati)
  if (!esito.ok) throw new Error(`fixture non calcolabile: ${esito.motivo}`)
  return esito.codice
}

/** Omocodia dell'Agenzia sulle ultime `quante` posizioni numeriche, da destra; controllo ricalcolato. */
function omocodico(codice: string, quante: number): string {
  const caratteri = [...codice.slice(0, 15)]
  for (const posizione of [...POSIZIONI_NUMERICHE].reverse().slice(0, quante)) {
    caratteri[posizione] = OMOCODIA_DA_CIFRA[caratteri[posizione]]!
  }
  const primi15 = caratteri.join('')
  return primi15 + carattereControllo(primi15)
}

// ── §1 · LA REGOLA, SU TUTTI I LIVELLI DI OMOCODIA ───────────────────────────

describe('§1 · verificaCoerenza + badge: ogni livello di omocodia, maschio e femmina', () => {
  const PERSONE: DatiAnagraficiCf[] = [
    { cognome: 'XQQWZ', nome: 'YJKVB', sesso: 'M', dataNascita: '2019-03-07', codiceBelfiore: 'Z999' },
    { cognome: 'XQQWZ', nome: 'YJKVB', sesso: 'F', dataNascita: '1985-12-28', codiceBelfiore: 'Z998' },
  ]

  for (const persona of PERSONE) {
    for (let livello = 1; livello <= POSIZIONI_NUMERICHE.length; livello++) {
      const cf = omocodico(calcola(persona), livello)

      it(`${persona.sesso}, omocodia su ${livello} posizioni, coerente → nessun badge e nessuna proposta`, () => {
        // Premessa: è un omocodico VALIDO, non un codice scritto male.
        const v = validaCodiceFiscale(cf)
        expect(v.valido).toBe(true)
        expect(v.omocodia).toBe(true)
        expect(cf).not.toBe(calcola(persona))

        const esito = verificaCoerenza(cf, persona)
        expect(esito.coerente).toBe(true)
        expect(esito.motivi).toEqual([])
        expect(esito.nonVerificabili).toEqual([])
        expect(badgeHaQualcosaDaDire(esito)).toBe(false)
      })

      it(`${persona.sesso}, omocodia su ${livello} posizioni, cognome diverso → rosso con la proposta`, () => {
        const esito = verificaCoerenza(cf, { ...persona, cognome: 'ZZWQP' })
        expect(esito.coerente).toBe(false)
        expect(esito.motivi).toEqual(['cognome'])
        expect(esito.codiceAtteso).toBe(calcola({ ...persona, cognome: 'ZZWQP' }))
        expect(badgeHaQualcosaDaDire(esito)).toBe(true)
      })
    }
  }
})

// ── Le due schede, montate davvero ───────────────────────────────────────────

const COMUNI = [{ belfiore: 'H501', nome: 'NAPOLI', sigla: 'NA', attivo: true }]
const ID_GENITORE = '00000000-0000-4000-8000-0000000000c1'

const ALUNNA: DatiAnagraficiCf = {
  cognome: 'Omobamba', nome: 'Primina', sesso: 'F', dataNascita: '2019-03-07', codiceBelfiore: 'H501',
}
const GENITORE: DatiAnagraficiCf = {
  cognome: 'Omopadre', nome: 'Adulto', sesso: 'M', dataNascita: '1984-02-17', codiceBelfiore: 'H501',
}

let genitoreInRete: Record<string, unknown> = {}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/anagrafiche/comuni')) {
        return new Response(JSON.stringify({ comuni: COMUNI }), { status: 200 })
      }
      if (url.includes('/api/admin/parents/')) {
        return new Response(JSON.stringify(genitoreInRete), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }),
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * `codice_belfiore_nascita` come arriva dalla riga. In PRODUZIONE vale `null` su tutte
 * le righe (lo scrive anche `route.ts` dei codici fiscali): è la forma dei dati VERA, ed
 * è quella che manda il badge nel ramo giallo del luogo di nascita.
 */
type BelfioreRiga = string | null

function montaAlunno(codiceFiscale: string, dati: DatiAnagraficiCf = ALUNNA, belfiore: BelfioreRiga = 'H501') {
  render(
    <StudentDetailPanel
      student={{
        id: 'al-omo-1',
        nome: dati.nome,
        cognome: dati.cognome,
        gender: dati.sesso,
        data_nascita: dati.dataNascita,
        scuola_id: SEDE_A,
        birth_city: 'NAPOLI',
        birth_province: 'NA',
        birth_nation: 'Italia',
        codice_belfiore_nascita: belfiore,
        codice_fiscale: codiceFiscale,
      }}
      onClose={vi.fn()}
      onSave={vi.fn()}
      onArchive={vi.fn(async () => ({ ok: true }))}
      onRiattiva={vi.fn(async () => ({ ok: true }))}
      variant="page"
    />,
  )
}

async function montaGenitore(codiceFiscale: string, dati: DatiAnagraficiCf = GENITORE, belfiore: BelfioreRiga = 'H501') {
  genitoreInRete = {
    id: ID_GENITORE,
    first_name: dati.nome,
    last_name: dati.cognome,
    gender: dati.sesso,
    birth_date: dati.dataNascita,
    birth_city: 'NAPOLI',
    birth_province: 'NA',
    birth_nation: 'Italia',
    codice_belfiore_nascita: belfiore,
    fiscal_code: codiceFiscale,
    emails: [],
    phone_numbers: [],
    residence_address: '',
    residence_city: '',
    zip_code: '',
  }
  render(<ParentDetailPanel parentBasicInfo={{ id: ID_GENITORE }} onClose={() => {}} onSave={vi.fn()} variant="page" />)
  // Si aspetta la PRESENZA del codice nel campo: è il segno che il record è arrivato.
  await waitFor(() => expect(screen.getByLabelText(/Codice Fiscale/)).toHaveValue(codiceFiscale))
}

/**
 * Il testo INTERO del badge giallo (titolo + elenco dei dati mancanti), preso dal suo
 * contenitore `role="status"` a partire dal titolo: così si confronta il badge e non un
 * sosia qualunque della pagina.
 */
function testoBadgeGiallo(): string {
  const titolo = screen.getByText(itShared.cfNonVerificabileTitolo)
  const badge = titolo.closest('[role="status"]')
  expect(badge).not.toBeNull()
  return badge!.textContent ?? ''
}

/**
 * Lascia arrivare le risposte in volo (l'elenco dei comuni compreso): il badge si legge
 * DOPO, così un eventuale riempimento del codice catastale a partire dal comune non
 * può cambiare il verdetto alle spalle dell'asserzione.
 */
async function lasciaArrivareLaRete() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

// ── §2 · SCHEDA ALUNNO ───────────────────────────────────────────────────────

describe('§2 · scheda alunno', () => {
  it('(a) omocodico coerente: nessun rosso, nessun giallo, nessun «Usa questo»', () => {
    const cf = omocodico(calcola(ALUNNA), 3)
    montaAlunno(cf)
    // Premessa positiva: il campo porta DAVVERO l'omocodico, non un vuoto.
    expect(document.getElementById('dettaglio-codice-fiscale')).toHaveValue(cf)
    expect(screen.queryByText(itShared.cfIncoerenteTitolo)).toBeNull()
    expect(screen.queryByText(itShared.cfNonVerificabileTitolo)).toBeNull()
    expect(screen.queryByRole('button', { name: itShared.cfUsaQuesto })).toBeNull()
  })

  it('(b) omocodico di un’altra persona (cognome diverso): rosso, e «Usa questo» propone il calcolato', () => {
    const altrui = omocodico(calcola({ ...ALUNNA, cognome: 'Altrabamba' }), 2)
    montaAlunno(altrui)
    expect(screen.getByText(itShared.cfIncoerenteTitolo)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: itShared.cfUsaQuesto })).toBeInTheDocument()
    expect(screen.getByText(calcola(ALUNNA))).toBeInTheDocument()
  })

  it('(c) codice catastale NULL come in produzione: omocodico coerente = stesso giallo del gemello senza omocodia, niente rosso, niente «Usa questo»', async () => {
    // Omocodia su 5 posizioni: tocca anche le cifre del GIORNO (posizioni 9 e 10), che col
    // catastale assente sono le uniche cifre ancora confrontate. Un'omocodia sulle sole
    // ultime 3 posizioni cadrebbe tutta nel catastale, cioè nel campo non verificabile, e
    // il test non potrebbe accorgersi di un confronto alla lettera.
    const cf = omocodico(calcola(ALUNNA), 5)
    expect(validaCodiceFiscale(cf).omocodia).toBe(true)

    // Il gemello: stessa anagrafica, stesso catastale NULL, codice NON omocodico.
    montaAlunno(calcola(ALUNNA), ALUNNA, null)
    await lasciaArrivareLaRete()
    expect(document.getElementById('dettaglio-codice-fiscale')).toHaveValue(calcola(ALUNNA))
    const giallaDelGemello = testoBadgeGiallo()
    expect(giallaDelGemello).toContain(itShared.cfMancaLuogoNascita)
    cleanup()

    montaAlunno(cf, ALUNNA, null)
    await lasciaArrivareLaRete()
    // Premessa positiva: il campo porta DAVVERO l'omocodico.
    expect(document.getElementById('dettaglio-codice-fiscale')).toHaveValue(cf)
    expect(screen.queryByText(itShared.cfIncoerenteTitolo)).toBeNull()
    expect(screen.getByText(itShared.cfNonVerificabileTitolo)).toBeInTheDocument()
    expect(testoBadgeGiallo()).toBe(giallaDelGemello)
    expect(screen.queryByRole('button', { name: itShared.cfUsaQuesto })).toBeNull()
  })
})

// ── §3 · SCHEDA GENITORE ─────────────────────────────────────────────────────

describe('§3 · scheda genitore', () => {
  it('(a) omocodico coerente: nessun rosso, nessun giallo, nessun «Usa questo»', async () => {
    await montaGenitore(omocodico(calcola(GENITORE), 7))
    expect(screen.queryByText(itShared.cfIncoerenteTitolo)).toBeNull()
    expect(screen.queryByText(itShared.cfNonVerificabileTitolo)).toBeNull()
    expect(screen.queryByRole('button', { name: itShared.cfUsaQuesto })).toBeNull()
  })

  it('(b) omocodico di un’altra persona (nome diverso): rosso, e «Usa questo» propone il calcolato', async () => {
    await montaGenitore(omocodico(calcola({ ...GENITORE, nome: 'Diverso' }), 1))
    expect(screen.getByText(itShared.cfIncoerenteTitolo)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: itShared.cfUsaQuesto })).toBeInTheDocument()
    expect(screen.getByText(calcola(GENITORE))).toBeInTheDocument()
  })

  it('(c) codice catastale NULL come in produzione: omocodico coerente = stesso giallo del gemello senza omocodia, niente rosso, niente «Usa questo»', async () => {
    // Omocodia su tutte e 7 le posizioni: data compresa (vedi il caso (c) dell'alunno).
    const cf = omocodico(calcola(GENITORE), 7)
    expect(validaCodiceFiscale(cf).omocodia).toBe(true)

    await montaGenitore(calcola(GENITORE), GENITORE, null)
    await lasciaArrivareLaRete()
    const giallaDelGemello = testoBadgeGiallo()
    expect(giallaDelGemello).toContain(itShared.cfMancaLuogoNascita)
    cleanup()

    // `montaGenitore` aspetta la PRESENZA dell'omocodico nel campo prima di tornare.
    await montaGenitore(cf, GENITORE, null)
    await lasciaArrivareLaRete()
    expect(screen.queryByText(itShared.cfIncoerenteTitolo)).toBeNull()
    expect(screen.getByText(itShared.cfNonVerificabileTitolo)).toBeInTheDocument()
    expect(testoBadgeGiallo()).toBe(giallaDelGemello)
    expect(screen.queryByRole('button', { name: itShared.cfUsaQuesto })).toBeNull()
  })
})
