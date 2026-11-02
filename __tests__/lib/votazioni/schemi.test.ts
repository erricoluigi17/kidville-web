import { describe, expect, it } from 'vitest'
import {
  azioneVotazioneSchema,
  creaVotazioneSchema,
  elencoQuerySchema,
  genitoriQuerySchema,
  scadenzaInIstante,
  votoSchema,
} from '@/lib/votazioni/schemi'
import { TITOLO_MAX } from '@/lib/votazioni/tipi'

/**
 * GLI SCHEMI ZOD DELLE VOTAZIONI.
 *
 * Qui si prova il confine fra ciò che il client può mandare e ciò che le route accettano. Due regole
 * pesano più delle altre: il voto di classe porta sempre la classe e il voto d’istituto non la porta mai,
 * e l’elettore NON è un campo del body (è `auth.user.id`: se il client ne manda uno, zod lo scarta).
 *
 * Solo uuid inventati.
 */

const SEDE = '10000000-0000-4000-8000-000000000001'
const C1 = '20000000-0000-4000-8000-000000000001'
const C2 = '20000000-0000-4000-8000-000000000002'
const G1 = '30000000-0000-4000-8000-000000000001'
const G2 = '30000000-0000-4000-8000-000000000002'

const base = {
  titolo: 'Elezione di prova',
  scadenza: '2026-11-20T18:00',
  sectionIds: [C1],
  rappresentanteIstituto: false,
}

describe('votoSchema', () => {
  it('accetta un voto di classe con la classe', () => {
    const r = votoSchema.safeParse({ ambito: 'classe', sectionId: C1, candidatoId: G1 })
    expect(r.success).toBe(true)
  })

  it('accetta un voto d’istituto senza classe (null)', () => {
    const r = votoSchema.safeParse({ ambito: 'istituto', sectionId: null, candidatoId: G1 })
    expect(r.success).toBe(true)
  })

  it('accetta un voto d’istituto con `sectionId` omesso, e lo porta a null', () => {
    const r = votoSchema.safeParse({ ambito: 'istituto', candidatoId: G1 })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.sectionId).toBeNull()
  })

  it('RIFIUTA ambito `classe` con `sectionId` null', () => {
    expect(votoSchema.safeParse({ ambito: 'classe', sectionId: null, candidatoId: G1 }).success).toBe(false)
  })

  it('RIFIUTA ambito `classe` con `sectionId` omesso', () => {
    expect(votoSchema.safeParse({ ambito: 'classe', candidatoId: G1 }).success).toBe(false)
  })

  it('RIFIUTA ambito `istituto` con `sectionId` valorizzato', () => {
    expect(votoSchema.safeParse({ ambito: 'istituto', sectionId: C1, candidatoId: G1 }).success).toBe(false)
  })

  it('rifiuta un ambito che non esiste, un candidato che non è un uuid e un candidato mancante', () => {
    expect(votoSchema.safeParse({ ambito: 'plesso', sectionId: null, candidatoId: G1 }).success).toBe(false)
    expect(votoSchema.safeParse({ ambito: 'classe', sectionId: C1, candidatoId: 'abc' }).success).toBe(false)
    expect(votoSchema.safeParse({ ambito: 'classe', sectionId: C1 }).success).toBe(false)
  })

  it('scarta i campi che non conosce: l’elettore del body non arriva alla route', () => {
    const r = votoSchema.safeParse({
      ambito: 'classe',
      sectionId: C1,
      candidatoId: G1,
      elettoreId: G2,
      elettore_id: G2,
      scuolaId: SEDE,
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(Object.keys(r.data).sort()).toEqual(['ambito', 'candidatoId', 'sectionId'])
    }
  })
})

describe('creaVotazioneSchema', () => {
  it('accetta il body minimo e mette `candidatiIstituto` a []', () => {
    const r = creaVotazioneSchema.safeParse(base)
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.candidatiIstituto).toEqual([])
      expect(r.data.scuolaId).toBeUndefined()
    }
  })

  it('accetta il body completo, con sede e candidati', () => {
    const r = creaVotazioneSchema.safeParse({
      ...base,
      scuolaId: SEDE,
      rappresentanteIstituto: true,
      candidatiIstituto: [G1, G2],
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.candidatiIstituto).toEqual([G1, G2])
  })

  it('toglie gli spazi dal titolo e rifiuta un titolo vuoto o fatto di soli spazi', () => {
    const ok = creaVotazioneSchema.safeParse({ ...base, titolo: '   Elezione   ' })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.titolo).toBe('Elezione')
    expect(creaVotazioneSchema.safeParse({ ...base, titolo: '' }).success).toBe(false)
    expect(creaVotazioneSchema.safeParse({ ...base, titolo: '     ' }).success).toBe(false)
  })

  it(`accetta un titolo di ${TITOLO_MAX} caratteri e rifiuta uno di ${TITOLO_MAX + 1}`, () => {
    expect(creaVotazioneSchema.safeParse({ ...base, titolo: 'a'.repeat(TITOLO_MAX) }).success).toBe(true)
    expect(creaVotazioneSchema.safeParse({ ...base, titolo: 'a'.repeat(TITOLO_MAX + 1) }).success).toBe(false)
  })

  it('la scadenza è `YYYY-MM-DDTHH:MM`: niente ISO con fuso, niente secondi, niente orari impossibili', () => {
    expect(creaVotazioneSchema.safeParse({ ...base, scadenza: '2026-11-20T18:00' }).success).toBe(true)
    expect(creaVotazioneSchema.safeParse({ ...base, scadenza: '2026-11-20T17:00:00.000Z' }).success).toBe(false)
    expect(creaVotazioneSchema.safeParse({ ...base, scadenza: '2026-11-20T99:99' }).success).toBe(false)
    expect(creaVotazioneSchema.safeParse({ ...base, scadenza: '2026-02-30T10:00' }).success).toBe(false)
    expect(creaVotazioneSchema.safeParse({ ...base, scadenza: '' }).success).toBe(false)
    expect(creaVotazioneSchema.safeParse({ ...base, scadenza: undefined }).success).toBe(false)
  })

  it('deduplica `sectionIds` (anche se cambia solo la maiuscola: in Postgres è lo stesso uuid)', () => {
    const r = creaVotazioneSchema.safeParse({ ...base, sectionIds: [C1, C2, C1, C1.toUpperCase()] })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.sectionIds).toEqual([C1, C2])
  })

  it('deduplica anche `candidatiIstituto`: due volte lo stesso candidato sarebbe un 23505 sulla chiave', () => {
    const r = creaVotazioneSchema.safeParse({
      ...base,
      rappresentanteIstituto: true,
      candidatiIstituto: [G1, G1, G2],
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.candidatiIstituto).toEqual([G1, G2])
  })

  it('`sectionIds` può essere vuoto (la route risponde VOTAZIONE_SENZA_SCHEDE), ma deve esserci', () => {
    expect(creaVotazioneSchema.safeParse({ ...base, sectionIds: [] }).success).toBe(true)
    const { sectionIds: _senza, ...resto } = base
    void _senza
    expect(creaVotazioneSchema.safeParse(resto).success).toBe(false)
  })

  it('al massimo 100 classi e 200 candidati', () => {
    const uuid = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    const classi = (n: number) => Array.from({ length: n }, (_, i) => uuid(i + 1))
    expect(creaVotazioneSchema.safeParse({ ...base, sectionIds: classi(100) }).success).toBe(true)
    expect(creaVotazioneSchema.safeParse({ ...base, sectionIds: classi(101) }).success).toBe(false)
    expect(
      creaVotazioneSchema.safeParse({ ...base, rappresentanteIstituto: true, candidatiIstituto: classi(200) }).success,
    ).toBe(true)
    expect(
      creaVotazioneSchema.safeParse({ ...base, rappresentanteIstituto: true, candidatiIstituto: classi(201) }).success,
    ).toBe(false)
  })

  it('rifiuta id che non sono uuid e un `rappresentanteIstituto` che non è un booleano', () => {
    expect(creaVotazioneSchema.safeParse({ ...base, sectionIds: ['x'] }).success).toBe(false)
    expect(creaVotazioneSchema.safeParse({ ...base, scuolaId: 'x' }).success).toBe(false)
    expect(creaVotazioneSchema.safeParse({ ...base, candidatiIstituto: ['x'] }).success).toBe(false)
    expect(creaVotazioneSchema.safeParse({ ...base, rappresentanteIstituto: 'true' }).success).toBe(false)
    expect(creaVotazioneSchema.safeParse({ ...base, rappresentanteIstituto: undefined }).success).toBe(false)
  })
})

describe('azioneVotazioneSchema', () => {
  it('`chiudi` non porta altro', () => {
    expect(azioneVotazioneSchema.safeParse({ azione: 'chiudi' }).success).toBe(true)
  })

  it('`proroga` vuole la scadenza, nel formato locale', () => {
    expect(azioneVotazioneSchema.safeParse({ azione: 'proroga', scadenza: '2026-11-25T18:00' }).success).toBe(true)
    expect(azioneVotazioneSchema.safeParse({ azione: 'proroga' }).success).toBe(false)
    expect(azioneVotazioneSchema.safeParse({ azione: 'proroga', scadenza: '2026-11-25T18:00:00Z' }).success).toBe(false)
  })

  it('un’azione che non esiste è rifiutata', () => {
    expect(azioneVotazioneSchema.safeParse({ azione: 'riapri' }).success).toBe(false)
    expect(azioneVotazioneSchema.safeParse({}).success).toBe(false)
  })
})

describe('elencoQuerySchema e genitoriQuerySchema', () => {
  it('`scuolaId` è facoltativo, ma se c’è è un uuid', () => {
    expect(elencoQuerySchema.safeParse({}).success).toBe(true)
    expect(elencoQuerySchema.safeParse({ scuolaId: SEDE }).success).toBe(true)
    expect(elencoQuerySchema.safeParse({ scuolaId: 'x' }).success).toBe(false)
  })

  it('la ricerca dei genitori toglie gli spazi e ha un tetto di 60 caratteri', () => {
    const ok = genitoriQuerySchema.safeParse({ scuolaId: SEDE, q: '  alfa  ' })
    expect(ok.success).toBe(true)
    if (ok.success) expect(ok.data.q).toBe('alfa')
    expect(genitoriQuerySchema.safeParse({}).success).toBe(true)
    expect(genitoriQuerySchema.safeParse({ q: 'a'.repeat(60) }).success).toBe(true)
    expect(genitoriQuerySchema.safeParse({ q: 'a'.repeat(61) }).success).toBe(false)
    expect(genitoriQuerySchema.safeParse({ scuolaId: 'x' }).success).toBe(false)
  })
})

describe('scadenzaInIstante', () => {
  it('in ora solare (novembre) 18:00 a Roma sono le 17:00Z', () => {
    expect(scadenzaInIstante('2026-11-20T18:00')).toBe('2026-11-20T17:00:00.000Z')
  })

  it('in ora legale (luglio) 18:00 a Roma sono le 16:00Z', () => {
    expect(scadenzaInIstante('2026-07-20T18:00')).toBe('2026-07-20T16:00:00.000Z')
  })

  it('una forma illeggibile o una data inesistente danno null, mai un’eccezione', () => {
    expect(scadenzaInIstante('')).toBeNull()
    expect(scadenzaInIstante('domani alle sei')).toBeNull()
    expect(scadenzaInIstante('2026-11-20T17:00:00.000Z')).toBeNull()
    expect(scadenzaInIstante('2026-02-30T10:00')).toBeNull()
  })
})
