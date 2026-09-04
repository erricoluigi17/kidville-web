import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import { SEDE_A, SEDE_B, SEDE_C, SEDE_E2E } from '../../fixtures/sedi'
import { creaFintoSupabase, type DBFinto } from '../../fixtures/finto-supabase'
import { redact } from '@/lib/logging/redact'

// =============================================================================
// VERSO QUALI SEDI SI PUÒ SPOSTARE UNA PERSONA.
//
// La domanda ha due risposte diverse e non intercambiabili:
//  · la DIREZIONE muove fra TUTTE le sedi reali — anche quelle che non sono
//    fra le proprie: è il caso d'uso, il bambino che passa da Cesa ad Aversa;
//  · la SEGRETERIA muove solo dentro le sedi a cui ha già accesso. Se potesse
//    spostare altrove, sposterebbe un'anagrafica in un plesso che poi non può
//    più nemmeno leggere — e nessuno di quel plesso saprebbe che è arrivata.
//
// Fail-closed su tutto il resto: un ruolo che questo modulo non conosce non è
// «staff generico», è NEGATO. Stessa regola di `puoRigenerareCredenzialiStaff`.
//
// Regola di questa famiglia di test: si asserisce l'elenco ESATTO, mai
// `not.toContain(...)` come unico controllo — un elenco vuoto passerebbe
// qualunque `not.toContain`.
// =============================================================================

const logEvento = vi.fn()
vi.mock('@/lib/logging/logger', () => ({
  logEvento: (...a: unknown[]) => logEvento(...a),
  logErrore: vi.fn(),
  logOk: vi.fn(),
}))

import {
  destinazioniConsentite,
  destinazioneConsentita,
  destinazioniDiTrasferimento,
} from '@/lib/sedi/trasferimento'

const NOME_A = 'Kidville Uno'
const NOME_B = 'Kidville Due'
const NOME_C = 'Kidville Tre'

/** Le tre sedi reali del deployment, nella forma che arriva da `schools`. */
const REALI = [
  { id: SEDE_A, nome: NOME_A },
  { id: SEDE_B, nome: NOME_B },
  { id: SEDE_C, nome: NOME_C },
]

const utente = (role: AppUser['role'], scuola: string | null, ruoli?: AppUser['ruoli']): AppUser => ({
  id: '11111111-0000-4000-8000-000000000001',
  role,
  ruoli,
  scuola_id: scuola,
})

beforeEach(() => {
  logEvento.mockClear()
})

describe('destinazioniConsentite · chi può spostare dove', () => {
  it('la Direzione ottiene sedi che NON sono fra le proprie: è il caso d\'uso', () => {
    // Admin con UNA sola sede propria. Se le destinazioni fossero le sue sedi,
    // il trasferimento fra plessi non esisterebbe proprio.
    const dest = destinazioniConsentite('admin', [SEDE_A], REALI)
    expect(dest.map((s) => s.id)).toEqual([SEDE_A, SEDE_B, SEDE_C])
    expect(dest.map((s) => s.nome)).toEqual([NOME_A, NOME_B, NOME_C])
  })

  it('«Direzione» sono DUE ruoli: anche `coordinator` muove ovunque', () => {
    // `RUOLI_DIREZIONE` = ['admin','coordinator']. Scrivere solo `admin` qui
    // toglierebbe il potere a chi nell'app si chiama letteralmente «Direzione».
    expect(destinazioniConsentite('coordinator', [SEDE_B], REALI).map((s) => s.id))
      .toEqual([SEDE_A, SEDE_B, SEDE_C])
  })

  it('la segreteria resta dentro le sedi che già ha: Cesa non sposta ad Aversa', () => {
    const dest = destinazioniConsentite('segreteria', [SEDE_A], REALI)
    expect(dest.map((s) => s.id)).toEqual([SEDE_A])
  })

  it('la segreteria di due plessi ottiene quei due, nell\'ordine delle sedi reali', () => {
    expect(destinazioniConsentite('segreteria', [SEDE_C, SEDE_A], REALI).map((s) => s.id))
      .toEqual([SEDE_A, SEDE_C])
  })

  it.each([
    ['educator', 'educator'],
    ['cuoca', 'cuoca'],
    ['genitore', 'genitore'],
    ['ruolo sconosciuto', 'capo-supremo'],
    ['stringa vuota', ''],
  ])('fail-closed: %s non ottiene nessuna destinazione', (_etichetta, ruolo) => {
    expect(destinazioniConsentite(ruolo, [SEDE_A, SEDE_B], REALI)).toEqual([])
  })

  it('fail-closed anche su ruolo nullo o assente: si nega ciò che non si è letto', () => {
    expect(destinazioniConsentite(null, [SEDE_A], REALI)).toEqual([])
    expect(destinazioniConsentite(undefined, [SEDE_A], REALI)).toEqual([])
  })

  it('la sede E2E non è MAI una destinazione, nemmeno per la Direzione', () => {
    // Difesa in profondità: `sediReali` l'ha già tolta, ma questa funzione è
    // pura e domani qualcuno potrebbe passarle l'elenco GREZZO di `schools`.
    const conE2E = [...REALI, { id: SEDE_E2E, nome: 'Kidville E2E' }]
    expect(destinazioniConsentite('admin', [SEDE_A], conE2E).map((s) => s.id))
      .toEqual([SEDE_A, SEDE_B, SEDE_C])
  })

  it('la sede E2E non è una destinazione nemmeno per chi ci ha accesso', () => {
    const conE2E = [...REALI, { id: SEDE_E2E, nome: 'Kidville E2E' }]
    expect(destinazioniConsentite('segreteria', [SEDE_E2E, SEDE_A], conE2E).map((s) => s.id))
      .toEqual([SEDE_A])
  })

  it('una sede propria che NON è fra le reali (disattivata) non è destinazione', () => {
    // `sediReali` toglie le sedi con `attiva=false`: una segreteria che ne ha
    // ancora l'accesso non deve poterci spostare nessuno.
    expect(destinazioniConsentite('segreteria', [SEDE_B], [{ id: SEDE_A, nome: NOME_A }]))
      .toEqual([])
  })

  it('gli uuid si confrontano senza distinzione di maiuscole, e si torna la forma del DATABASE', () => {
    // In Postgres `uuid` è un TIPO: 'AAAA…' e 'aaaa…' sono lo stesso valore. In
    // JavaScript no, e questo repo ha già pagato quel difetto con un 403 sulla
    // PROPRIA sede (vedi `formaConfronto` in scope.ts).
    const dest = destinazioniConsentite('segreteria', [SEDE_A.toUpperCase()], REALI)
    expect(dest.map((s) => s.id)).toEqual([SEDE_A])
  })

  it('elenco di sedi reali vuoto ⇒ nessuna destinazione, per chiunque', () => {
    expect(destinazioniConsentite('admin', [SEDE_A], [])).toEqual([])
  })
})

describe('destinazioneConsentita · la sede chiesta è fra quelle ammesse?', () => {
  const dest = [
    { id: SEDE_A, nome: NOME_A },
    { id: SEDE_C, nome: NOME_C },
  ]

  it('restituisce la sede in forma CANONICA, anche se chiesta in maiuscolo', () => {
    expect(destinazioneConsentita(dest, SEDE_C.toUpperCase())).toEqual({ id: SEDE_C, nome: NOME_C })
  })

  it('una sede fuori elenco è `null`, non un ripiego sulla prima', () => {
    expect(destinazioneConsentita(dest, SEDE_B)).toBeNull()
  })

  it('sede assente è `null`: «non me l\'hai detta» non è «vale la prima»', () => {
    expect(destinazioneConsentita(dest, null)).toBeNull()
    expect(destinazioneConsentita(dest, undefined)).toBeNull()
    expect(destinazioneConsentita(dest, '  ')).toBeNull()
  })
})

// ── la funzione di SERVIZIO: gli elenchi veri, letti dal database ────────────

function db(): DBFinto {
  return {
    schools: [
      { id: SEDE_A, nome: NOME_A },
      { id: SEDE_B, nome: NOME_B },
      { id: SEDE_C, nome: NOME_C },
      { id: SEDE_E2E, nome: 'Kidville E2E' },
    ],
    scuole: [
      { id: SEDE_A, attiva: true },
      { id: SEDE_B, attiva: false },
      { id: SEDE_C, attiva: true },
    ],
    utenti_scuole: [],
  }
}

describe('destinazioniDiTrasferimento · gli elenchi si leggono, non si indovinano', () => {
  it('riusa `sediReali`: fuori la sede E2E e fuori quella disattivata', async () => {
    const dati = db()
    dati.utenti_scuole = [
      { utente_id: '11111111-0000-4000-8000-000000000001', scuola_id: SEDE_C },
    ]
    const supabase = creaFintoSupabase(dati) as unknown as SupabaseClient
    const esito = await destinazioniDiTrasferimento(supabase, utente('admin', SEDE_A), 'prova:PATCH')
    // SEDE_B è disattivata, SEDE_E2E è la sede finta della CI: nessuna delle due.
    //
    // ⚠️ L'ORDINE È ALFABETICO PER NOME, e non è un dettaglio del fixture: lo
    // impone `sediReali`, che legge `schools` con `.order('nome')` perché quello
    // è l'ordine in cui l'elenco va MOSTRATO. Qui i nomi sono di proposito
    // disallineati dagli id — 'Kidville Tre' (C) viene prima di 'Kidville Uno'
    // (A) — così questa riga diventa rossa il giorno in cui qualcuno toglie
    // l'ordinamento da `sediReali` e l'utente si ritrova la tendina a caso.
    expect(esito.sedi.map((s) => s.id)).toEqual([SEDE_C, SEDE_A])
    expect(esito.sedi.map((s) => s.nome)).toEqual([NOME_C, NOME_A])
    expect(esito.error).toBeNull()
  })

  it('la segreteria ottiene solo il proprio plesso, anche se le sedi reali sono tre', async () => {
    const supabase = creaFintoSupabase(db()) as unknown as SupabaseClient
    const esito = await destinazioniDiTrasferimento(supabase, utente('segreteria', SEDE_A), 'prova:PATCH')
    expect(esito.sedi.map((s) => s.id)).toEqual([SEDE_A])
  })

  it('l\'AUTORIZZAZIONE guarda i ruoli REALI, non la veste indossata adesso', async () => {
    // Una direttrice che sta guardando l'app come genitore non perde il potere
    // di trasferire: `role` è presentazione, `ruoli` è autorizzazione.
    const supabase = creaFintoSupabase(db()) as unknown as SupabaseClient
    const esito = await destinazioniDiTrasferimento(
      supabase,
      utente('genitore', SEDE_A, ['genitore', 'coordinator']),
      'prova:PATCH',
    )
    // Ordine alfabetico per nome, come sopra: lo decide `sediReali`.
    expect(esito.sedi.map((s) => s.id)).toEqual([SEDE_C, SEDE_A])

    /* ─── E IL LOG DEVE DIRE CHI HA DECISO, NON COME È VESTITO ──────────────
     *
     * La riga di successo scriveva `ruolo: user.role`, cioè la VESTE: per questa
     * direttrice usciva `destinazioni-risolte · ruolo: 'genitore' · n: 2`. Ma
     * queste righe sono dichiarate «un segnale di sicurezza da contare», e un
     * genitore che risolve due destinazioni di trasferimento è un falso allarme
     * — o, peggio, il travestimento perfetto di un allarme vero.
     */
    const riga = logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string }).esito === 'destinazioni-risolte',
    )
    expect(riga).toBeDefined()
    expect(riga?.[2]).toMatchObject({ ruolo: 'coordinator', stato: 'genitore' })

    /* Le due chiavi devono anche SOPRAVVIVERE alla redazione, che è a lista
     * bianca: fuori da `CHIAVI_IN_CHIARO` il valore uscirebbe `[redatto:str/8]`
     * e in `app_log` la riga direbbe che un ruolo c'era, non QUALE — per un
     * segnale di sicurezza è come non averlo. La veste viaggia su `stato` e non
     * su `ruolo_attivo` proprio per questo: `ruolo_attivo` non è in lista bianca
     * e non va aggiunta «perché sarebbe comodo vederla» (AGENTS.md, regola 8).
     * Qui gira la redazione VERA, non il suo elenco: se domani `stato` uscisse
     * dalla lista bianca, questa riga diventerebbe rossa. */
    expect(redact(riga?.[2])).toMatchObject({ ruolo: 'coordinator', stato: 'genitore' })
  })

  it('un educator non ottiene destinazioni, e la cosa resta scritta', async () => {
    const supabase = creaFintoSupabase(db()) as unknown as SupabaseClient
    const esito = await destinazioniDiTrasferimento(supabase, utente('educator', SEDE_A), 'prova:PATCH')
    expect(esito.sedi).toEqual([])
    const righe = logEvento.mock.calls.filter((c) => c[1] === 'warn')
    expect(righe.map((c) => (c[2] as { esito?: string }).esito)).toContain('destinazioni-nessuna')
  })

  it('FAIL-CLOSED sul guasto: `schools` illeggibile ⇒ nessuna destinazione, e si dice', async () => {
    const supabase = creaFintoSupabase(db(), [], {
      errori: { schools: { code: '42501', message: 'permission denied' } },
    }) as unknown as SupabaseClient
    const esito = await destinazioniDiTrasferimento(supabase, utente('admin', SEDE_A), 'prova:PATCH')
    expect(esito.sedi).toEqual([])
    // Un elenco vuoto per GUASTO non è un elenco vuoto per ruolo: il chiamante
    // deve poterli distinguere, altrimenti mostra «nessuna sede» su un errore.
    expect(esito.error?.code).toBe('42501')
  })

  it('scope illeggibile ⇒ la segreteria non ottiene niente (nessun ripiego)', async () => {
    // `scuoleDiUtente` è fail-closed sull\'errore del ponte solo per admin; per
    // la segreteria lo scope È la sede primaria. Senza sede primaria: niente.
    const supabase = creaFintoSupabase(db()) as unknown as SupabaseClient
    const esito = await destinazioniDiTrasferimento(supabase, utente('segreteria', null), 'prova:PATCH')
    expect(esito.sedi).toEqual([])
  })

  it('il calcolo dell\'elenco lascia una riga: «è stato chiesto, ed era di N sedi»', async () => {
    const supabase = creaFintoSupabase(db()) as unknown as SupabaseClient
    await destinazioniDiTrasferimento(supabase, utente('segreteria', SEDE_A), 'prova:PATCH')
    const ok = logEvento.mock.calls.find(
      (c) => (c[2] as { esito?: string }).esito === 'destinazioni-risolte',
    )
    expect(ok).toBeDefined()
    expect(ok?.[1]).toBe('info')
    expect((ok?.[2] as { n?: number }).n).toBe(1)
  })

  it('nei log non finisce nessun dato personale: solo uuid, ruolo, conteggi', async () => {
    const supabase = creaFintoSupabase(db()) as unknown as SupabaseClient
    await destinazioniDiTrasferimento(supabase, utente('educator', SEDE_A), 'prova:PATCH')
    for (const [, , campi] of logEvento.mock.calls) {
      const testo = JSON.stringify(campi)
      // I NOMI delle sedi non escono: la riga porta conteggi, non anagrafica.
      expect(testo).not.toContain(NOME_A)
      expect(testo).not.toContain(NOME_B)
    }
  })
})
