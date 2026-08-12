import { describe, it, expect } from 'vitest'
import { leggiAltriFigliIscritti } from '@/lib/gdpr/orfano'

/**
 * «Genitore orfano» = nessun altro figlio ancora presente a scuola. È la regola
 * che decide se, insieme al minore, si anonimizza anche l'adulto: nome, codice
 * fiscale, documento d'identità. Non ha un annulla.
 */

type Riga = { id: string; stato: string | null; anonimizzato_il: string | null }

/** Il guasto di lettura che PostgREST non lancia: lo RITORNA, come `{ data: null, error }`. */
type Guasto = { tabella: 'student_parents' | 'alunni'; code: string }

// Doppio minimo del client: `student_parents` risponde i legami, `alunni` le
// righe dei fratelli. Nessun filtro da applicare — la funzione legge `stato` e
// `anonimizzato_il` in memoria, ed è esattamente lì che si decide.
const client = (legami: string[], fratelli: Riga[], guasto?: Guasto) =>
  ({
    from: (table: string) => {
      const b: Record<string, unknown> = {}
      b.select = () => b
      b.eq = () => b
      b.in = () => b
      b.then = (res: (v: unknown) => unknown) =>
        Promise.resolve(
          guasto && guasto.tabella === table
            ? { data: null, error: { code: guasto.code, message: 'lettura non riuscita' } }
            : {
                data:
                  table === 'student_parents' ? legami.map((student_id) => ({ student_id })) : fratelli,
                error: null,
              },
        ).then(res)
      return b
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any

describe('gdpr/orfano — chi protegge il genitore dall’anonimizzazione', () => {
  it('un fratello ISCRITTO trattiene il genitore', async () => {
    const s = client(['al-1', 'al-2'], [{ id: 'al-2', stato: 'iscritto', anonimizzato_il: null }])
    expect(await leggiAltriFigliIscritti(s, 'p-1', 'al-1')).toEqual({ ok: true, haAltriFigli: true })
  })

  it('un fratello RITIRATO non trattiene il genitore', async () => {
    const s = client(['al-1', 'al-2'], [{ id: 'al-2', stato: 'ritirato', anonimizzato_il: null }])
    expect(await leggiAltriFigliIscritti(s, 'p-1', 'al-1')).toEqual({ ok: true, haAltriFigli: false })
  })

  // ⬇︎ REGRESSIONE — lo stesso difetto, dal lato che protegge.
  // Il controllo era `f.stato === 'iscritto'`: con un fratello soltanto SOSPESO
  // la funzione rispondeva «nessun altro figlio», e il genitore veniva
  // anonimizzato mentre un suo bambino frequentava ancora — restando senza il
  // nome di un adulto di riferimento in anagrafica.
  it('un fratello SOSPESO trattiene il genitore: è un bambino ancora presente', async () => {
    const s = client(['al-1', 'al-2'], [{ id: 'al-2', stato: 'sospeso', anonimizzato_il: null }])
    expect(await leggiAltriFigliIscritti(s, 'p-1', 'al-1')).toEqual({ ok: true, haAltriFigli: true })
  })

  it('un fratello già anonimizzato non trattiene nessuno', async () => {
    const s = client(['al-1', 'al-2'], [{ id: 'al-2', stato: 'iscritto', anonimizzato_il: '2026-01-01T00:00:00Z' }])
    expect(await leggiAltriFigliIscritti(s, 'p-1', 'al-1')).toEqual({ ok: true, haAltriFigli: false })
  })

  it('nessun altro figlio ⇒ genitore orfano', async () => {
    expect(await leggiAltriFigliIscritti(client(['al-1'], []), 'p-1', 'al-1')).toEqual({
      ok: true,
      haAltriFigli: false,
    })
  })

  // ⬇︎ IL DIFETTO PIÙ CARO CHE QUESTO FILE POSSA COPRIRE, e per un giorno è
  // stato aperto: le due letture buttavano via l'`error`.
  //
  // PostgREST NON LANCIA. Se la lettura fallisce ritorna `{ data: null, error }`,
  // e con l'errore ignorato `data ?? []` diventava una lista vuota: «questo
  // genitore non ha altri figli», cioè **orfano**, cioè da anonimizzare. Un
  // guasto di rete, un JWT scaduto, un timeout — e l'oblio cancellava nome,
  // codice fiscale e documento di un adulto il cui bambino frequenta ancora.
  // Nella direzione che non ha un annulla.
  //
  // Ora il guasto NON si travestre da risposta: esce come `{ ok: false }` e il
  // chiamante non può ignorarlo (TypeScript non lo lascia leggere `haAltriFigli`
  // senza aver prima guardato `ok`).
  it('legami non letti ⇒ NON si risponde «orfano»: si dichiara il guasto', async () => {
    const s = client(['al-1', 'al-2'], [{ id: 'al-2', stato: 'iscritto', anonimizzato_il: null }], {
      tabella: 'student_parents',
      code: 'PGRST301',
    })
    const esito = await leggiAltriFigliIscritti(s, 'p-1', 'al-1')
    expect(esito.ok).toBe(false)
    expect(esito).not.toHaveProperty('haAltriFigli')
  })

  it('fratelli non letti ⇒ NON si risponde «orfano»: si dichiara il guasto', async () => {
    // Il caso peggiore, e quello che la sonda del collaudo ha riprodotto: i
    // legami si leggono, i fratelli no. C'è un bambino `iscritto` dall'altra
    // parte, e prima di oggi la funzione rispondeva comunque «orfano».
    const s = client(['al-1', 'al-2'], [{ id: 'al-2', stato: 'iscritto', anonimizzato_il: null }], {
      tabella: 'alunni',
      code: 'PGRST301',
    })
    const esito = await leggiAltriFigliIscritti(s, 'p-1', 'al-1')
    expect(esito.ok).toBe(false)
    expect(esito).not.toHaveProperty('haAltriFigli')
  })

  it('il guasto viaggia con l’errore vero, non con un booleano', async () => {
    // Chi logga deve poter scrivere il CODICE del guasto: `403` non dice niente,
    // `PGRST301 "JWT expired"` dice tutto. Se qui tornasse solo `ok: false` il
    // log della route sarebbe una riga senza causa.
    const s = client(['al-1', 'al-2'], [], { tabella: 'alunni', code: 'PGRST301' })
    const esito = await leggiAltriFigliIscritti(s, 'p-1', 'al-1')
    expect(esito.ok).toBe(false)
    if (esito.ok) throw new Error('impossibile: il doppio ha dichiarato un guasto')
    expect((esito.errore as { code?: string }).code).toBe('PGRST301')
  })
})
