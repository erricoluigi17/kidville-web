import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useDiaryDay } from '@/components/features/teacher/diary/DiaryEventEditor'

// =============================================================================
// L'ALERT ALLERGIE DEL PRANZO PARTIVA DALLE NOTE MEDICHE.
//
// `useDiaryDay` costruiva `DiaryStudent.allergie` così:
//     allergie: a.note_mediche ? a.note_mediche.split(',').map(s => s.trim()) : []
// cioè spezzava sulle virgole la casella che il modulo d'iscrizione etichetta
// «Note Mediche (BES, DSA, patologie)» e la mostrava, dentro `MealDetailInline`,
// come l'elenco delle allergie del bambino a cui si sta segnando il pranzo.
// Misurato in produzione: ZERO delle 41 note mediche nomina un allergene.
//
// `MealDetailInline` è una superficie OPERATIVA — decide cosa finisce nel piatto —
// quindi qui vale la regola larga: allergeni spuntati (etichettati) PIÙ il testo
// libero così com'è. «fragole» non è fra i 14 UE e non si perde. Esce solo la
// negazione.
//
// ⚠️ E LA NOTA MEDICA NON SPARISCE: CAMBIA GRUPPO. La prima stesura la toglieva e
// basta, e questo elenco perdeva 29 bambini — misurati in produzione il 2026-09-07:
// 657 iscritti, 44 con nota medica, e 29 di loro hanno `allergies` vuota o negata,
// quindi da `etichetteAllergie` non escono. Erano bambini che comparivano nel
// riquadro rosso della schermata pranzo (sotto un'etichetta sbagliata, ma
// c'erano) e da cui l'insegnante leggeva «terapia salvavita». `DiaryStudent`
// porta perciò DUE campi: `allergie` (dalle allergie) e `notaMedica` (dalla nota,
// con la sua etichetta e il suo colore in `MealDetailInline`).
//
// Fixture SINTETICHE: nomi inventati, nessun dato reale di minori.
// =============================================================================

interface JsonRes { ok: boolean; status: number; json: () => Promise<unknown> }
const jsonRes = (data: unknown): JsonRes => ({ ok: true, status: 200, json: async () => data })

const NOTA = 'BES, terapia sintetica di prova'

const ALUNNI = [
  { id: 'a1', nome: 'Alfa', cognome: 'Uno', note_mediche: null, allergeni: ['glutine'], allergies: null },
  { id: 'a2', nome: 'Beta', cognome: 'Due', note_mediche: null, allergeni: [], allergies: 'fragole' },
  { id: 'a3', nome: 'Gamma', cognome: 'Tre', note_mediche: NOTA, allergeni: [], allergies: null },
  { id: 'a4', nome: 'Delta', cognome: 'Quattro', note_mediche: null, allergeni: [], allergies: 'Nessuna' },
  { id: 'a5', nome: 'Epsilon', cognome: 'Cinque', note_mediche: null, allergeni: ['latte'], allergies: 'lattosio, fragole' },
  // Chiave in archivio fuori dalle 14 UE: `normalizzaAllergeni` la scartava in
  // SILENZIO, e senza testo libero l'alert del pranzo restava vuoto. Il
  // prestampato di banco, sulla stessa colonna, la stampa — due superfici
  // operative sullo stesso dato con due regole opposte.
  { id: 'a6', nome: 'Zeta', cognome: 'Sei', note_mediche: null, allergeni: ['nichel'], allergies: null },
  // Nota medica che NEGA: «nessuna» non è una nota da leggere a pranzo, e la regola
  // che lo decide è `isNegazione` del motore, non una `/nessuna/` scritta a mano.
  { id: 'a7', nome: 'Theta', cognome: 'Sette', note_mediche: 'Nessuna', allergeni: [], allergies: null },
]

const fetchMock = vi.fn(async (url: string | URL) => {
  const u = String(url)
  if (u.includes('/api/diary/config')) return jsonRes({ routine_attive: [] })
  if (u.includes('/api/diary/students')) return jsonRes(ALUNNI)
  if (u.includes('/api/diary/entries')) return jsonRes([])
  return jsonRes(null)
})

beforeEach(() => {
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals() })

async function allergieDi(id: string): Promise<string[]> {
  const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli'))
  await waitFor(() => expect(result.current.students).toHaveLength(ALUNNI.length))
  return result.current.students.find((s) => s.id === id)!.allergie
}

async function notaDi(id: string): Promise<string | null> {
  const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli'))
  await waitFor(() => expect(result.current.students).toHaveLength(ALUNNI.length))
  return result.current.students.find((s) => s.id === id)!.notaMedica
}

describe('useDiaryDay — le allergie del diario vengono dalle ALLERGIE', () => {
  it('allergene spuntato → etichetta canonica', async () => {
    expect(await allergieDi('a1')).toEqual(['Glutine'])
  })

  it('testo fuori dai 14 UE → resta com\'è: nel piatto conta', async () => {
    expect(await allergieDi('a2')).toEqual(['fragole'])
  })

  it('SOLO nota medica → elenco VUOTO: non è un\'allergia', async () => {
    // È il difetto: qui usciva `['BES', 'terapia sintetica di prova']`, spezzato
    // sulle virgole, sotto la parola «Allergie» dell\'alert del pranzo.
    expect(await allergieDi('a3')).toEqual([])
  })

  it('«Nessuna» → elenco vuoto', async () => {
    expect(await allergieDi('a4')).toEqual([])
  })

  it('etichette e testo convivono: niente si sovrascrive e niente si perde', async () => {
    expect(await allergieDi('a5')).toEqual(['Latte / lattosio', 'lattosio, fragole'])
  })

  it('una chiave FUORI dalle 14 UE non sparisce dal piatto', async () => {
    // ⚠️ Il matcher non è secco per colpa del mock di next-intl (`test/setup.ts`):
    // `t.has()` risponde sempre `true`, quindi il ripiego di `useAllergeneLabel`
    // — chiave sconosciuta → la chiave grezza — qui non si percorre e al suo posto
    // esce il nome della chiave i18n. Ciò che si sorveglia è che la chiave arrivi
    // fino all'elenco invece di essere scartata; che il ripiego dia «nichel» lo
    // misura `etichetteAllergie` in `__tests__/lib/allergeni-motore.test.ts`.
    expect(await allergieDi('a6')).toEqual([expect.stringContaining('nichel')])
  })

  it('🔴 LA NOTA MEDICA NON SPARISCE: esce da `allergie` ed entra in `notaMedica`', async () => {
    // Il difetto della prima correzione: la nota veniva tolta dall'alert del pranzo e
    // non rimessa da nessuna parte. In produzione (2026-09-07) sono 29 bambini su 657
    // che avevano una riga nel riquadro rosso della schermata pranzo — con dentro
    // cose come una terapia salvavita — e che smettevano di averla.
    expect(await allergieDi('a3')).toEqual([])
    expect(await notaDi('a3')).toBe(NOTA)
  })

  it('una nota che NEGA non è una nota da leggere: `notaMedica` resta vuota', async () => {
    expect(await notaDi('a7')).toBeNull()
  })

  it('chi non ha nota medica ha `notaMedica` nulla, non la stringa vuota', async () => {
    expect(await notaDi('a1')).toBeNull()
  })

  it('la nota medica non compare in NESSUN elenco di allergie', async () => {
    const { result } = renderHook(() => useDiaryDay('u1', 'Girasoli'))
    await waitFor(() => expect(result.current.students).toHaveLength(ALUNNI.length))
    const tutte = result.current.students.flatMap((s) => s.allergie).join(' | ')
    expect(tutte).not.toContain('BES')
    expect(tutte).not.toContain(NOTA)
  })
})
