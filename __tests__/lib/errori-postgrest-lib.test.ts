import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { creaFintoSupabase, type DBFinto, type ErrorePostgrest } from '../fixtures/finto-supabase'

/**
 * FASE 11 («errori non ignorati») — i moduli di `src/lib` che non avevano un collaudo loro.
 *
 * PostgREST non lancia: `{ data: null, error }`. In ognuno di questi moduli il `null` di un
 * guasto diventava un valore — il cutoff di default, un menu vuoto (zero alert allergie), il
 * giorno di scadenza 5 riscritto sulle rette, «Kidville» timbrato nella segnatura, una pagella
 * «non trovata», un fascicolo «non tuo». Qui si prova, un caso per area, che il guasto ora si
 * FERMA (lancio o 500 secondo il contratto della funzione) o almeno si DICE, e che il ripiego
 * di prima resta solo dove è legittimo: lo schema della CI non migrato.
 */

const h = vi.hoisted(() => ({ logEvento: vi.fn() }))
vi.mock('@/lib/logging/logger', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/logging/logger')>()
  return { ...actual, logEvento: h.logEvento }
})

import { loadMensaConfig, loadResolveOptions, resolveMenuConfigId } from '@/lib/mensa/server'
import { controllaAllergiePerId } from '@/lib/mensa/allergie-check'
import { sincronizzaTestata } from '@/lib/merch/stati'
import { riallineaScadenzeRetteFuture } from '@/lib/pagamenti/scadenze'
import { denominazioneScuola, eliminaStagingBestEffort } from '@/lib/protocolli/server'
import { ensureStandardEnrollmentModel, STANDARD_ENROLLMENT_MODEL_ID } from '@/lib/forms/enrollment-default-schema'
import { puoAccedereFascicolo } from '@/lib/primaria/fascicolo-rbac'
import { renderGiudizioDescrittivo } from '@/lib/primaria/giudizio'
import { loadPagellaData } from '@/lib/primaria/pagella-store'
import { resolveScuolaId } from '@/lib/auth/parent-identity'

const GUASTO: ErrorePostgrest = { code: '57014', message: 'canceling statement due to statement timeout' }
const COLONNA_ASSENTE: ErrorePostgrest = { code: '42703', message: 'column does not exist' }

const SEDE = '5ede0000-0000-4000-8000-000000000001'
const ALUNNO = 'a1000000-0000-4000-8000-000000000001'
const UTENTE = 'u1000000-0000-4000-8000-000000000001'
const SEZIONE = '5e100000-0000-4000-8000-000000000001'
const SCRUTINIO = '5c100000-0000-4000-8000-000000000001'
const ORDINE = '0d100000-0000-4000-8000-000000000001'

const finto = (db: DBFinto, errori: Record<string, ErrorePostgrest> = {}) =>
  creaFintoSupabase(db, [], { errori })

/** C'è una riga di log con questo livello ed esito? */
const loggato = (livello: string, esito: string) =>
  h.logEvento.mock.calls.some(([, l, campi]) => l === livello && (campi as { esito?: string }).esito === esito)

beforeEach(() => h.logEvento.mockClear())

describe('mensa — il cutoff, il menu e la classe DECIDONO', () => {
  it('impostazioni non lette: lancia, non il cutoff 09:30 di default', async () => {
    await expect(loadMensaConfig(finto({ admin_settings: [] }, { admin_settings: GUASTO }), SEDE)).rejects.toThrow(
      /impostazioni-non-lette/,
    )
  })

  it('colonna assente (DB della CI non migrato): il default di sempre, con la riga `info`', async () => {
    const cfg = await loadMensaConfig(finto({ admin_settings: [] }, { admin_settings: COLONNA_ASSENTE }), SEDE)
    expect(cfg.cutoffOra).toBe('09:30')
    expect(loggato('info', 'impostazioni-non-lette')).toBe(true)
  })

  it('rotazione non letta: lancia invece di un menu vuoto (zero conflitti, zero alert)', async () => {
    const cfg = { cutoffOra: '09:30', giorniAttivi: [1, 2, 3, 4, 5], settimaneRotazione: 4, sogliaSaldoBasso: 5 }
    const s = finto({ mensa_menu_rotazione: [], mensa_menu_override: [] }, { mensa_menu_rotazione: GUASTO })
    await expect(loadResolveOptions(s, SEDE, cfg)).rejects.toThrow(/rotazione-non-letta/)
  })

  it('assegnazione del menu non letta: lancia invece del menu legacy', async () => {
    const s = finto({ mensa_class_menu_assignment: [] }, { mensa_class_menu_assignment: GUASTO })
    await expect(resolveMenuConfigId(s, SEDE, '3 anni A', '2026-10-19')).rejects.toThrow(/assegnazione-menu-non-letta/)
  })

  it('alunno non letto per l’avviso allergie: `false` come prima, ma con la riga `error`', async () => {
    const r = await controllaAllergiePerId(finto({ alunni: [] }, { alunni: GUASTO }), ALUNNO, '2026-10-19', SEDE)
    expect(r).toBe(false)
    expect(loggato('error', 'alunno-non-letto')).toBe(true)
  })
})

describe('merch — la testata non sincronizzata non si dà per fatta', () => {
  const db = () => ({
    divise_ordini_righe: [{ ordine_id: ORDINE, stato: 'consegnato' }],
    divise_ordini: [{ id: ORDINE, stato: 'confermato' }],
  })

  it('aggiornamento della testata respinto: `null` («non applicato») e la riga `error`', async () => {
    const r = await sincronizzaTestata(finto(db(), { 'divise_ordini:update': GUASTO }), ORDINE)
    expect(r).toBeNull()
    expect(loggato('error', 'testata-non-sincronizzata')).toBe(true)
  })

  it('righe non lette per un guasto vero: `error`; per una tabella assente: `info`', async () => {
    await sincronizzaTestata(finto(db(), { divise_ordini_righe: GUASTO }), ORDINE)
    expect(loggato('error', 'righe-non-lette')).toBe(true)
    h.logEvento.mockClear()
    await sincronizzaTestata(finto(db(), { divise_ordini_righe: { code: '42P01', message: 'relation does not exist' } }), ORDINE)
    expect(loggato('info', 'righe-schema-assente')).toBe(true)
  })

  it('caso riuscito: lo stato derivato, e la testata scritta', async () => {
    const d = db()
    expect(await sincronizzaTestata(finto(d), ORDINE)).toBe('consegnato')
    expect(d.divise_ordini[0].stato).toBe('consegnato')
  })
})

describe('pagamenti — il giorno di scadenza non si inventa', () => {
  it('impostazioni di sede non lette: nessuna retta riscritta sul giorno 5 di default', async () => {
    const mese = `${new Date().toISOString().slice(0, 8)}01`
    const d: DBFinto = {
      payment_categories: [{ id: 'cat-retta', slug: 'retta', scuola_id: null }],
      alunni: [{ id: ALUNNO, scuola_id: SEDE }],
      admin_settings: [{ scuola_id: SEDE, retta_giorno_scadenza: 10 }],
      pagamenti: [
        { id: 'p-1', alunno_id: ALUNNO, categoria_id: 'cat-retta', periodo_competenza: mese, stato: 'da_pagare', scadenza: `${mese.slice(0, 8)}10` },
      ],
    }
    const n = await riallineaScadenzeRetteFuture(finto(d, { admin_settings: GUASTO }), ALUNNO, undefined)
    expect(n).toBe(0)
    expect(d.pagamenti[0].scadenza).toBe(`${mese.slice(0, 8)}10`)
    expect(loggato('warn', 'giorno-di-sede-non-letto')).toBe(true)
  })
})

describe('protocolli — la segnatura e lo staging', () => {
  it('denominazione non letta: lancia con status 500, non timbra «Kidville»', async () => {
    const p = denominazioneScuola(finto({ schools: [] }, { schools: GUASTO }), SEDE)
    await expect(p).rejects.toMatchObject({ status: 500 })
  })

  it('denominazione letta: il nome della sede', async () => {
    expect(await denominazioneScuola(finto({ schools: [{ id: SEDE, nome: 'Kidville Aversa' }] }), SEDE)).toBe('Kidville Aversa')
  })

  it('staging non rimosso: non lancia e non tace (riga `warn` col conteggio)', async () => {
    const s = {
      storage: { from: () => ({ remove: async () => ({ data: null, error: { message: 'boom', statusCode: '500' } }) }) },
    } as unknown as SupabaseClient
    await expect(eliminaStagingBestEffort(s, ['staging/a.pdf', 'staging/b.pdf'])).resolves.toBeUndefined()
    expect(loggato('warn', 'staging-non-rimosso')).toBe(true)
  })
})

describe('forms — il modulo standard non risulta creato se non lo è', () => {
  it('lettura non riuscita: lancia (il reset non aggiorna più zero righe dicendo «fatto»)', async () => {
    await expect(ensureStandardEnrollmentModel(finto({ form_models: [] }, { 'form_models:select': GUASTO }))).rejects.toThrow(
      /Lettura del modulo/,
    )
  })

  it('insert respinto: lancia; insert in collisione (23505, creato da un’altra richiesta): va bene', async () => {
    await expect(ensureStandardEnrollmentModel(finto({ form_models: [] }, { 'form_models:insert': GUASTO }))).rejects.toThrow(
      /Creazione del modulo/,
    )
    await expect(
      ensureStandardEnrollmentModel(finto({ form_models: [] }, { 'form_models:insert': { code: '23505', message: 'dup' } })),
    ).resolves.toBeUndefined()
  })

  it('modello già presente: nessun insert', async () => {
    const d: DBFinto = { form_models: [{ id: STANDARD_ENROLLMENT_MODEL_ID }] }
    await ensureStandardEnrollmentModel(finto(d))
    expect(d.form_models).toHaveLength(1)
  })
})

describe('primaria — fascicolo, giudizio, pagella', () => {
  it('fascicolo: utente non letto ⇒ NEGATO (fail-closed), ma con motivo `errore` e la riga', async () => {
    const r = await puoAccedereFascicolo(finto({ utenti: [], alunni: [] }, { utenti: GUASTO }), UTENTE, ALUNNO)
    expect(r).toEqual({ consentito: false, ruolo: null, motivo: 'errore' })
    expect(loggato('error', 'utente-non-letto')).toBe(true)
  })

  it('fascicolo: alunno non letto per la segreteria ⇒ negato per guasto, non «cross-tenant»', async () => {
    const d: DBFinto = { utenti: [{ id: UTENTE, ruolo: 'segreteria', role: 'segreteria', scuola_id: SEDE }], alunni: [] }
    const r = await puoAccedereFascicolo(finto(d, { alunni: GUASTO }), UTENTE, ALUNNO)
    expect(r.consentito).toBe(false)
    expect(r.motivo).toBe('errore')
  })

  it('giudizio descrittivo: frammenti non letti ⇒ lancia, non un giudizio vuoto salvato sul voto', async () => {
    const s = finto({ giudizio_template: [] }, { giudizio_template: GUASTO })
    await expect(
      renderGiudizioDescrittivo(s, SEDE, { autonomia: true, continuita: true, tipologia: 'nota', risorse: 'interne' }),
    ).rejects.toThrow(/frammenti del giudizio/)
  })

  it('pagella: scrutinio non letto è 500, non il 404 «Scrutinio non trovato»', async () => {
    const r = await loadPagellaData(finto({ scrutini: [] }, { scrutini: GUASTO }), SCRUTINIO, ALUNNO)
    expect(r.status).toBe(500)
    expect(loggato('error', 'scrutinio-non-letto')).toBe(true)
  })

  it('pagella: scrutinio che non c’è resta 404', async () => {
    const r = await loadPagellaData(finto({ scrutini: [] }), SCRUTINIO, ALUNNO)
    expect(r.status).toBe(404)
  })

  it('pagella: firma del dirigente non letta è 500, non una pagella firmata da nessuno', async () => {
    const d: DBFinto = {
      scrutini: [{ id: SCRUTINIO, section_id: SEZIONE, periodo_id: 'per-1', stato: 'chiuso', chiuso_da: UTENTE, chiuso_il: '2026-06-10' }],
      sections: [{ id: SEZIONE, name: 'Prima A', scuola_id: null }],
      scrutinio_periodi: [{ id: 'per-1', nome: 'Secondo quadrimestre', anno_scolastico: '2025/2026' }],
      alunni: [{ id: ALUNNO, nome: 'Bimbo', cognome: 'Finto' }],
      materie: [],
      scrutinio_giudizi: [],
      scrutinio_comportamento: [],
      sezione_materia_obiettivo: [],
      utenti: [],
    }
    const r = await loadPagellaData(finto(d, { utenti: GUASTO }), SCRUTINIO, ALUNNO)
    expect(r.status).toBe(500)
    expect(r.data).toBeUndefined()
  })
})

describe('auth — `resolveScuolaId`', () => {
  it('sedi non lette: `null` come per «più sedi», ma con la riga `error` che le distingue', async () => {
    const r = await resolveScuolaId(finto({ schools: [] }, { schools: GUASTO }), null)
    expect(r).toBeNull()
    expect(loggato('error', 'sedi-non-lette')).toBe(true)
  })
})
