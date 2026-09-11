import { describe, it, expect } from 'vitest'
import { creaFintoSupabase, type DBFinto } from '../fixtures/finto-supabase'
import { risolviValutatore, isTitolareSezione, titolareDiMateria } from '@/lib/audit/valutatore'
import type { AppUser } from '@/lib/auth/predicati-ruolo'

/**
 * IL PRIMO TEST VERO DI `risolviValutatore` — e perché finora non ce n'era nessuno.
 *
 * ─── LA SCENA ───────────────────────────────────────────────────────────────
 *
 * Due file toccano questa funzione (`primaria-registro-destinatari.test.ts:60`,
 * `primaria-valutazioni.test.ts:51`) e tutti e due la sostituiscono con un mock
 * PIATTO che risponde sempre `{ valutatoreId: 'maestra-1' }`. Un mock piatto è
 * verde con la correzione e senza: certifica la route, non la regola. La regola —
 * «la firma resta del docente, mai della Segreteria» — non era misurata da niente.
 *
 * ─── LA DISTINZIONE CHE QUESTO FILE CUSTODISCE ──────────────────────────────
 *
 *   RUOLO REALE  = `utenti.ruolo` (+ `genitore` se esiste il ponte `parents`),
 *                  letto dal DATABASE → `haRuolo`
 *   RUOLO ATTIVO = la veste scelta col cookie `kv-active-role`, che
 *                  `require-staff.ts:341-348` (`conRuoloAttivo`) SCRIVE SOPRA
 *                  `user.role` prima che la route veda l'utente
 *
 * `risolviValutatore` chiedeva `attore.role === 'educator'`, cioè la VESTE. Ma la
 * domanda che stava facendo è «questa persona è un docente?», che è
 * AUTORIZZAZIONE, e l'autorizzazione non passa mai dal cookie. Il risultato
 * misurato: la maestra che è anche mamma, mentre guarda l'app come genitore,
 * supera `requireDocente` (che i ruoli reali li guarda: `predicati-ruolo.ts:87-89`)
 * e poi si sente chiedere di indicare «il docente titolare» — essendo lei.
 * In produzione **un educator di primaria ha il ponte genitore**: non è teorica.
 *
 * ⚠️ La direzione opposta è la parte che conta di più, ed è coperta in fondo: la
 * correzione NON deve trasformare il cookie in una chiave. Chi `educator` non lo è
 * nel database resta fuori, comunque si vesta.
 */

// Uuid veri: `zUuid` e i filtri del finto client non se ne accorgerebbero, ma le
// stringhe finte hanno già certificato route che in produzione rispondono 400.
const SEZIONE = '11111111-1111-4111-8111-111111111111'
const ALTRA_SEZIONE = '22222222-2222-4222-8222-222222222222'
const ITALIANO = 'aa111111-1111-4111-8111-111111111111'
const MATEMATICA = 'aa222222-2222-4222-8222-222222222222'

/** La maestra che è anche mamma: `utenti.ruolo = 'educator'` + ponte `parents`. */
const DOCENTE_GENITORE = '5d0ce07e-0000-4000-8000-000000000001'
/** Un educator senza ponte: i 617 utenti con un ruolo solo. */
const EDUCATOR_PURO = 'ed00ca70-0000-4000-8000-000000000002'
const SEGRETERIA = '5e6e7e00-0000-4000-8000-000000000003'
const TITOLARE_ITALIANO = 'd0ce0001-0000-4000-8000-000000000004'
const ESTRANEO = 'e57a0e00-0000-4000-8000-000000000005'
/** Un genitore puro con un cookie forgiato: non deve poter firmare niente. */
const GENITORE_PURO = '9e01704e-0000-4000-8000-000000000006'

function db(): DBFinto {
  return {
    utenti_sezioni: [
      { utente_id: DOCENTE_GENITORE, section_id: SEZIONE },
      { utente_id: EDUCATOR_PURO, section_id: SEZIONE },
      { utente_id: TITOLARE_ITALIANO, section_id: SEZIONE },
      { utente_id: ESTRANEO, section_id: ALTRA_SEZIONE },
    ],
    utenti_sezioni_materie: [
      { utente_id: TITOLARE_ITALIANO, section_id: SEZIONE, materia_id: ITALIANO },
      { utente_id: DOCENTE_GENITORE, section_id: SEZIONE, materia_id: MATEMATICA },
    ],
  }
}

/** La maestra-mamma COL COOKIE SU 'genitore': ruolo attivo ≠ ruoli reali. */
const inVesteDiGenitore: AppUser = {
  id: DOCENTE_GENITORE,
  role: 'genitore',
  ruoli: ['educator', 'genitore'],
}
/** La stessa persona, stessa riga di database, veste da maestra. */
const inVesteDiMaestra: AppUser = {
  id: DOCENTE_GENITORE,
  role: 'educator',
  ruoli: ['educator', 'genitore'],
}

describe('risolviValutatore — IL DIFETTO: si chiedeva la veste dove serviva il ruolo reale', () => {
  it('la maestra-mamma in veste di genitore firma A PROPRIO NOME, non riceve un 422', async () => {
    const r = await risolviValutatore(creaFintoSupabase(db()), inVesteDiGenitore, SEZIONE)

    // Prima della correzione qui arrivava la risposta 422 «Seleziona il docente
    // titolare», rivolta a una persona che il docente titolare È.
    expect(r.response, 'un educator non deve mai vedersi chiedere chi è il docente').toBeUndefined()
    expect(r.valutatoreId).toBe(DOCENTE_GENITORE)
  })

  it('…e ci arriva SENZA leggere il database: il ramo educator esce prima di ogni query', async () => {
    const letture: string[] = []
    await risolviValutatore(creaFintoSupabase(db(), letture), inVesteDiGenitore, SEZIONE)
    expect(letture, 'nessuna verifica di titolarità serve a chi firma per sé').toEqual([])
  })

  it('la veste non cambia il risultato: stessa persona, stessa firma, cookie o non cookie', async () => {
    const conCookie = await risolviValutatore(creaFintoSupabase(db()), inVesteDiGenitore, SEZIONE)
    const senzaCookie = await risolviValutatore(creaFintoSupabase(db()), inVesteDiMaestra, SEZIONE)
    expect(conCookie).toEqual(senzaCookie)
  })

  it('vale anche con `materiaId`: la maestra-mamma insegna matematica e la firma è sua', async () => {
    const r = await risolviValutatore(creaFintoSupabase(db()), inVesteDiGenitore, SEZIONE, {
      materiaId: MATEMATICA,
    })
    expect(r.response).toBeUndefined()
    expect(r.valutatoreId).toBe(DOCENTE_GENITORE)
  })
})

describe('risolviValutatore — la correzione NON apre una porta', () => {
  it('un genitore puro col cookie forgiato su `educator` non firma: `educator` non è fra i suoi ruoli', async () => {
    // Scena limite: `requireDocente` lo fermerebbe prima (`haUnRuolo` sui ruoli
    // reali), ma questa funzione non deve dipendere da chi la chiama. Il cookie
    // qui è già stato *onorato* — `role` dice 'educator' — e deve valere zero.
    const forgiato: AppUser = { id: GENITORE_PURO, role: 'educator', ruoli: ['genitore'] }
    const r = await risolviValutatore(creaFintoSupabase(db()), forgiato, SEZIONE)

    expect(r.valutatoreId, 'nessuna firma può nascere da un cookie').toBeUndefined()
    expect(r.response?.status).toBe(422)
  })

  it('la Segreteria che è anche mamma resta Segreteria: il ponte genitore non la promuove a docente', async () => {
    const segreteriaMamma: AppUser = { id: SEGRETERIA, role: 'genitore', ruoli: ['segreteria', 'genitore'] }
    const r = await risolviValutatore(creaFintoSupabase(db()), segreteriaMamma, SEZIONE)
    expect(r.valutatoreId).toBeUndefined()
    expect(r.response?.status).toBe(422)
  })
})

describe('risolviValutatore — i rami che c’erano già, e devono restare identici', () => {
  it('educator puro ⇒ sé stesso, zero letture', async () => {
    const letture: string[] = []
    const r = await risolviValutatore(
      creaFintoSupabase(db(), letture),
      { id: EDUCATOR_PURO, role: 'educator' },
      SEZIONE,
    )
    expect(r.valutatoreId).toBe(EDUCATOR_PURO)
    expect(letture).toEqual([])
  })

  it('Segreteria senza `docenteId` ⇒ 422 che spiega perché, non un 500 e non una firma sua', async () => {
    const r = await risolviValutatore(
      creaFintoSupabase(db()),
      { id: SEGRETERIA, role: 'segreteria' },
      SEZIONE,
    )
    expect(r.valutatoreId).toBeUndefined()
    expect(r.response?.status).toBe(422)
    const corpo = (await r.response?.json()) as { error: string }
    expect(corpo.error).toMatch(/docente titolare/i)
  })

  it('Segreteria con un `docenteId` NON titolare di questa classe ⇒ 422', async () => {
    const r = await risolviValutatore(
      creaFintoSupabase(db()),
      { id: SEGRETERIA, role: 'segreteria' },
      SEZIONE,
      { docenteId: ESTRANEO },
    )
    expect(r.valutatoreId).toBeUndefined()
    expect(r.response?.status).toBe(422)
    const corpo = (await r.response?.json()) as { error: string }
    expect(corpo.error).toMatch(/non è titolare/i)
  })

  it('Segreteria con il titolare giusto ⇒ la firma è del DOCENTE, mai della Segreteria', async () => {
    const r = await risolviValutatore(
      creaFintoSupabase(db()),
      { id: SEGRETERIA, role: 'segreteria' },
      SEZIONE,
      { docenteId: TITOLARE_ITALIANO, materiaId: ITALIANO },
    )
    expect(r.response).toBeUndefined()
    expect(r.valutatoreId).toBe(TITOLARE_ITALIANO)
    expect(r.valutatoreId, 'la Segreteria non firma nemmeno quando è lei a salvare').not.toBe(SEGRETERIA)
  })

  it('admin e coordinator seguono la stessa strada della Segreteria: nessuno di loro è un docente', async () => {
    for (const role of ['admin', 'coordinator'] as const) {
      const senza = await risolviValutatore(creaFintoSupabase(db()), { id: SEGRETERIA, role }, SEZIONE)
      expect(senza.response?.status, role).toBe(422)
      const con = await risolviValutatore(creaFintoSupabase(db()), { id: SEGRETERIA, role }, SEZIONE, {
        docenteId: TITOLARE_ITALIANO,
      })
      expect(con.valutatoreId, role).toBe(TITOLARE_ITALIANO)
    }
  })
})

describe('isTitolareSezione / titolareDiMateria — il fixture filtra davvero', () => {
  // Senza queste, i 422 qui sopra potrebbero essere verdi per un fixture che non
  // filtra invece che per la regola: un mock che tace certifica qualunque cosa.
  it('la titolarità è per SEZIONE, e un legame su un’altra sezione non conta', async () => {
    const s = creaFintoSupabase(db())
    expect(await isTitolareSezione(s, TITOLARE_ITALIANO, SEZIONE)).toBe(true)
    expect(await isTitolareSezione(s, ESTRANEO, SEZIONE)).toBe(false)
    expect(await isTitolareSezione(s, TITOLARE_ITALIANO, ALTRA_SEZIONE)).toBe(false)
  })

  it('con `materiaId` la contitolarità di sezione resta sufficiente: è il comportamento di oggi', async () => {
    // Documentato, non corretto: `isTitolareSezione` ricade su `utenti_sezioni`
    // quando la materia non combacia. Chi volesse stringere questa maglia lo
    // faccia sapendo che qui sotto c'è un test che glielo dirà.
    const s = creaFintoSupabase(db())
    expect(await isTitolareSezione(s, TITOLARE_ITALIANO, SEZIONE, ITALIANO)).toBe(true)
    expect(await isTitolareSezione(s, TITOLARE_ITALIANO, SEZIONE, MATEMATICA)).toBe(true)
    expect(await isTitolareSezione(s, ESTRANEO, SEZIONE, ITALIANO)).toBe(false)
  })

  it('`titolareDiMateria` risponde il titolare della materia, o null', async () => {
    const s = creaFintoSupabase(db())
    expect(await titolareDiMateria(s, SEZIONE, ITALIANO)).toBe(TITOLARE_ITALIANO)
    expect(await titolareDiMateria(s, ALTRA_SEZIONE, ITALIANO)).toBeNull()
  })
})
