import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LA ZONA PERICOLOSA — dire PRIMA che cosa succede, e non farlo per sbaglio ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ⚠️ TRAPPOLA 3 DI `.claude/rules/test.md`, e questo file la rispetta a lettere:
 * «non c'è il bottone» è vero anche mentre la fetch è ancora in volo. Su
 * `profilo-doppio` e `non-deciso` si asserisce quindi la PRESENZA della
 * spiegazione — che arriva solo a risposta ricevuta — e solo DOPO, a pagina
 * stabile, l'assenza del comando.
 *
 * ─── PROVA PER ROTTURA — eseguita il 2026-09-20 ───────────────────────────────
 *   • mostrato il bottone «Elimina» anche su `profilo-doppio`   → 2 rossi
 *   • sostituito `m.n === null ? 'non misurato' : m.n` con `m.n ?? 0` → 1 rosso
 *   • tolto `disabled={!cognomeOk}` dal bottone di conferma      → 1 rosso
 */

import { ZonaPericolosaStaff } from '@/components/features/admin/ZonaPericolosaStaff'

const STAFF_ID = 'b0000000-0000-4000-8000-0000000000b1'

type Anteprima = {
  decisione: string
  motivi: { chiave: string | null; n: number | null }[]
  ponteGenitore: boolean | null
  haAnagrafica: boolean
  haPraticaOrigine: boolean
  mantiene: string[]
}

let anteprima: Anteprima
let postChiamate: { url: string; corpo: unknown }[]

beforeEach(() => {
  postChiamate = []
  anteprima = {
    decisione: 'archivia',
    motivi: [{ chiave: 'tracciaDocenteDiario', n: 412 }],
    ponteGenitore: false,
    haAnagrafica: true,
    haPraticaOrigine: true,
    mantiene: ['archiviazioneMantieneRegistro'],
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postChiamate.push({ url, corpo: JSON.parse(String(init.body)) })
        return new Response(JSON.stringify({ success: true, data: { esito: 'archiviato' } }), {
          status: 200,
        })
      }
      if (String(url).includes('/eliminazione')) {
        return new Response(JSON.stringify({ success: true, data: anteprima }), { status: 200 })
      }
      return new Response(JSON.stringify({ alunni: [] }), { status: 200 })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function apri() {
  render(<ZonaPericolosaStaff staffId={STAFF_ID} cognome="Esempio" onFatto={() => {}} />)
  fireEvent.click(screen.getByTestId('zona-pericolosa-apri'))
}

describe("l'anteprima dice PRIMA che cosa succederà", () => {
  it('archivia: lo dice, e dice anche che cosa RESTA', async () => {
    apri()
    expect(await screen.findByTestId('zona-pericolosa-decisione')).toHaveTextContent(/ARCHIVIATO/i)
    expect(screen.getByText(/il registro resta intatto/i)).toBeInTheDocument()
  })

  it('dice PERCHÉ, con l’etichetta e il conteggio', async () => {
    apri()
    await screen.findByTestId('zona-pericolosa-decisione')
    expect(screen.getByText(/Eventi del diario: 412/)).toBeInTheDocument()
  })

  it('un conteggio non misurato NON diventa zero', async () => {
    anteprima = { ...anteprima, motivi: [{ chiave: 'tracciaDocenteDiario', n: null }] }
    apri()
    await screen.findByTestId('zona-pericolosa-decisione')
    expect(screen.getByText(/Eventi del diario: non misurato/)).toBeInTheDocument()
  })

  it('avvisa che sparisce anche il fascicolo del personale', async () => {
    apri()
    await screen.findByTestId('zona-pericolosa-decisione')
    expect(screen.getByText(/documento d’identità e il codice fiscale/i)).toBeInTheDocument()
  })
})

describe('profilo doppio — nessun comando, e la ragione per cui non c’è', () => {
  it('mostra la SPIEGAZIONE (e solo dopo si guarda che il comando non ci sia)', async () => {
    anteprima = { ...anteprima, decisione: 'profilo-doppio', motivi: [], ponteGenitore: true }
    apri()
    // PRIMA la presenza: è ciò che prova che la risposta è arrivata.
    const spiegazione = await screen.findByTestId('zona-pericolosa-decisione')
    expect(spiegazione).toHaveTextContent(/accesso di una famiglia/i)
    // Solo ORA l'assenza ha un significato.
    expect(screen.queryByTestId('zona-pericolosa-elimina')).not.toBeInTheDocument()
    // E il rimando al comando giusto c'è.
    expect(screen.getByTestId('zona-pericolosa-genitore')).toBeInTheDocument()
  })
})

describe('non deciso — nessun comando, e si dice perché', () => {
  it('mostra la spiegazione e non offre l’eliminazione', async () => {
    anteprima = { ...anteprima, decisione: 'non-deciso', motivi: [], ponteGenitore: false }
    apri()
    const spiegazione = await screen.findByTestId('zona-pericolosa-decisione')
    expect(spiegazione).toHaveTextContent(/verifiche non è riuscita/i)
    expect(screen.queryByTestId('zona-pericolosa-elimina')).not.toBeInTheDocument()
  })
})

describe('la conferma: si digita il cognome', () => {
  it('il bottone resta disabilitato finché il cognome non è quello giusto', async () => {
    apri()
    await screen.findByTestId('zona-pericolosa-decisione')
    fireEvent.click(screen.getByTestId('zona-pericolosa-elimina'))

    const conferma = screen.getByTestId('zona-pericolosa-conferma')
    expect(conferma).toBeDisabled()

    fireEvent.change(screen.getByTestId('zona-pericolosa-cognome'), { target: { value: 'Sbagliato' } })
    expect(conferma).toBeDisabled()

    fireEvent.change(screen.getByTestId('zona-pericolosa-cognome'), { target: { value: 'esempio' } })
    expect(conferma).toBeEnabled()
  })

  it('manda la decisione LETTA, non una qualunque', async () => {
    apri()
    await screen.findByTestId('zona-pericolosa-decisione')
    fireEvent.click(screen.getByTestId('zona-pericolosa-elimina'))
    fireEvent.change(screen.getByTestId('zona-pericolosa-cognome'), { target: { value: 'Esempio' } })
    fireEvent.click(screen.getByTestId('zona-pericolosa-conferma'))

    await waitFor(() => expect(postChiamate).toHaveLength(1))
    expect(postChiamate[0].corpo).toEqual({
      id: STAFF_ID,
      decisioneAttesa: 'archivia',
      conferma: true,
    })
  })
})

describe('anche genitore — il figlio si può rimandare', () => {
  it('senza bambino scelto avvisa che l’area famiglie resterà vuota', async () => {
    apri()
    await screen.findByTestId('zona-pericolosa-decisione')
    fireEvent.click(screen.getByTestId('zona-pericolosa-anche-genitore'))
    expect(screen.getByText(/area famiglie sarà vuota/i)).toBeInTheDocument()
  })

  it('manda il corpo senza alunnoId quando si rimanda', async () => {
    apri()
    await screen.findByTestId('zona-pericolosa-decisione')
    fireEvent.click(screen.getByTestId('zona-pericolosa-anche-genitore'))
    fireEvent.click(screen.getByTestId('zona-pericolosa-anche-genitore-conferma'))
    await waitFor(() => expect(postChiamate).toHaveLength(1))
    expect(postChiamate[0].corpo).toEqual({ utenteId: STAFF_ID })
  })
})
