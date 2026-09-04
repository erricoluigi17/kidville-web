import { describe, it, expect } from 'vitest'
import type { AppUser } from '@/lib/auth/predicati-ruolo'
import {
  puoModificareIncaricoStaff,
  type CambiIncarico,
} from '@/lib/auth/incarico-staff'

/* ════════════════════════════════════════════════════════════════════════════
 * CHI PUÒ CAMBIARE COSA NELL'INCARICO DI UN COLLEGA.
 *
 * Il predicato risponde a UNA domanda sola: dato chi chiede, che ruolo ha il
 * bersaglio e quali campi cambierebbero DAVVERO, si può?
 *
 * ─── PERCHÉ «CAMBIEREBBERO DAVVERO» E NON «SONO NEL CORPO» ──────────────────
 *
 * La scheda del personale salva il FORM INTERO: manda sempre `ruolo` e
 * `section_ids`, anche quando l'operatore ha toccato solo la tendina della sede
 * (`StaffDetailPanel.tsx`, il `body` della PATCH). Un predicato che guardasse la
 * PRESENZA della chiave direbbe «stai cambiando il ruolo» a ogni salvataggio, e
 * la Segreteria non riuscirebbe mai a spostare nessuno. Il chiamante confronta
 * col valore attuale e passa qui dei booleani: qui si decide, non si legge.
 *
 * ─── PERCHÉ È PURO E STA IN UN MODULO SUO ───────────────────────────────────
 *
 * Stessa ragione di `credenziali-staff.ts`, che gli sta accanto: 296 file di
 * test sostituiscono `@/lib/auth/require-staff` per intero, e un predicato
 * scritto lì dentro verrebbe mockato via insieme all'I/O — verificato finto.
 * ════════════════════════════════════════════════════════════════════════════ */

const NIENTE: CambiIncarico = { sede: false, ruolo: false, gradi: false, sezioni: false }
const SOLO_SEDE: CambiIncarico = { ...NIENTE, sede: true }

const attore = (role: AppUser['role'], ruoli?: AppUser['ruoli']): AppUser => ({
  id: 'aaaa0000-0000-4000-8000-000000000001',
  role,
  ...(ruoli ? { ruoli } : {}),
})

describe('puoModificareIncaricoStaff — la Direzione', () => {
  it('cambia ruolo, gradi, classi e sede di chiunque non sia Direzione', () => {
    for (const r of ['admin', 'coordinator'] as const) {
      expect(
        puoModificareIncaricoStaff(attore(r), 'educator', {
          sede: true, ruolo: true, gradi: true, sezioni: true,
        }),
      ).toEqual({ consentito: true })
    }
  })

  it('tocca anche un altro account di Direzione (il freno lì è il self-lockout, non questo)', () => {
    expect(puoModificareIncaricoStaff(attore('admin'), 'coordinator', { ...NIENTE, ruolo: true }))
      .toEqual({ consentito: true })
  })
})

describe('puoModificareIncaricoStaff — la Segreteria', () => {
  it('sposta di sede un membro dello staff', () => {
    expect(puoModificareIncaricoStaff(attore('segreteria'), 'educator', SOLO_SEDE))
      .toEqual({ consentito: true })
  })

  it('NON cambia il ruolo: è ciò che rende non aggirabile la riserva sulle credenziali', () => {
    expect(puoModificareIncaricoStaff(attore('segreteria'), 'educator', { ...SOLO_SEDE, ruolo: true }))
      .toEqual({ consentito: false, motivo: 'riservato-direzione' })
  })

  it('NON cambia i gradi: `utenti.gradi` apre le funzioni di un grado (requireFunzione)', () => {
    expect(puoModificareIncaricoStaff(attore('segreteria'), 'educator', { ...NIENTE, gradi: true }))
      .toEqual({ consentito: false, motivo: 'riservato-direzione' })
  })

  it('NON cambia le classi assegnate: decidono quali BAMBINI vede un educator', () => {
    expect(puoModificareIncaricoStaff(attore('segreteria'), 'educator', { ...NIENTE, sezioni: true }))
      .toEqual({ consentito: false, motivo: 'riservato-direzione' })
  })

  it('NON tocca un account di Direzione, nemmeno per la sola sede', () => {
    for (const bersaglio of ['admin', 'coordinator']) {
      expect(puoModificareIncaricoStaff(attore('segreteria'), bersaglio, SOLO_SEDE))
        .toEqual({ consentito: false, motivo: 'bersaglio-direzione' })
    }
  })

  it('il diniego sul bersaglio di Direzione VIENE PRIMA di quello sui campi', () => {
    // Non è un dettaglio estetico: `motivo` finisce nei log ed è il modo di
    // contare i tentativi verso un account di Direzione. Se vincesse l'altro
    // ramo, quel contatore perderebbe proprio i casi che deve vedere.
    expect(puoModificareIncaricoStaff(attore('segreteria'), 'admin', { ...SOLO_SEDE, ruolo: true }))
      .toEqual({ consentito: false, motivo: 'bersaglio-direzione' })
  })

  it('un salvataggio che non cambia niente passa (il form intero rimanda i valori di prima)', () => {
    expect(puoModificareIncaricoStaff(attore('segreteria'), 'educator', NIENTE))
      .toEqual({ consentito: true })
  })
})

describe('puoModificareIncaricoStaff — fail-closed', () => {
  it('ruolo bersaglio nullo o vuoto: si nega, anche alla Direzione', () => {
    for (const bersaglio of [null, undefined, '']) {
      expect(puoModificareIncaricoStaff(attore('admin'), bersaglio, SOLO_SEDE))
        .toEqual({ consentito: false, motivo: 'bersaglio-sconosciuto' })
    }
  })

  it('ruolo bersaglio SCONOSCIUTO: si nega ciò che non si è capito', () => {
    // Un ruolo nuovo aggiunto alla colonna senza passare da qui dev'essere
    // NEGATO finché qualcuno non decide che cosa farne — non ammesso «perché è
    // comunque uno staff».
    expect(puoModificareIncaricoStaff(attore('admin'), 'direttore_didattico', SOLO_SEDE))
      .toEqual({ consentito: false, motivo: 'bersaglio-sconosciuto' })
  })

  it('chi non è né Direzione né Segreteria non modifica nessun incarico', () => {
    for (const r of ['educator', 'cuoca', 'genitore'] as const) {
      expect(puoModificareIncaricoStaff(attore(r), 'educator', NIENTE))
        .toEqual({ consentito: false, motivo: 'ruolo-non-abilitato' })
    }
  })
})

describe('puoModificareIncaricoStaff — AUTORIZZAZIONE, non presentazione', () => {
  it('la direttrice che guarda l\'app come genitore mantiene i poteri della Direzione', () => {
    // `role` è la VESTE indossata ora, `ruoli` sono i ruoli REALI del database.
    // Il gate `requireStaff` la fa passare sui ruoli reali (`haUnRuolo`): un
    // predicato che guardasse `role` le negherebbe qui ciò che il gate le ha
    // appena concesso — un 403 su una persona autorizzata.
    const direttriceGenitore = attore('genitore', ['admin', 'genitore'])
    expect(puoModificareIncaricoStaff(direttriceGenitore, 'educator', { ...SOLO_SEDE, ruolo: true }))
      .toEqual({ consentito: true })
  })

  it('la segretaria che guarda l\'app come genitore resta segretaria', () => {
    const segretariaGenitore = attore('genitore', ['segreteria', 'genitore'])
    expect(puoModificareIncaricoStaff(segretariaGenitore, 'educator', SOLO_SEDE))
      .toEqual({ consentito: true })
    expect(puoModificareIncaricoStaff(segretariaGenitore, 'educator', { ...NIENTE, ruolo: true }))
      .toEqual({ consentito: false, motivo: 'riservato-direzione' })
  })

  it('il GENITORE puro resta fuori: avere il ruolo `genitore` non è una veste che concede', () => {
    expect(puoModificareIncaricoStaff(attore('genitore', ['genitore']), 'educator', SOLO_SEDE))
      .toEqual({ consentito: false, motivo: 'ruolo-non-abilitato' })
  })
})
