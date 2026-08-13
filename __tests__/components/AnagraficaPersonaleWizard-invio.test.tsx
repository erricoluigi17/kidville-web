import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import itPublic from '../../messages/it/public.json'
import itShared from '../../messages/it/shared.json'
import { PERSONALE_FIELDS, CONSENSI_PERSONALE_FIELDS } from '@/lib/forms/personale-template'
import {
  ALFA, BETA, OGGI, PERCORSO_SCANSIONE, PERCORSO_SCANSIONE_RETRO, compilaFinoAlRiepilogo,
  invia, reteFinta, type FintaFetch,
} from '../fixtures/anagrafica-personale'

/**
 * `/anagrafica-personale` — CHE COSA PARTE DAVVERO, E CHE COSA NON RESTA INDIETRO.
 *
 * ─── PERCHÉ SI ASSERISCE IL CORPO DEL POST, E NON «l'invio è andato» ────────
 *
 * Perché il difetto già pagato su questo repo non era un invio fallito: era un
 * invio RIUSCITO con dentro meno di quello che era stato scritto. Sul modulo
 * fratello ogni pezzo funzionava — la casella, la validazione, la prova
 * archiviata — e il collegamento fra penultimo e ultimo passo no: le spunte
 * venivano raccolte e buttate via prima dell'invio, e il server rifiutava
 * (giustamente) una candidatura senza presa visione. Un collaudo che si ferma al
 * pannello di conferma è verde su tutto questo.
 *
 * Qui il carico è di trentadue campi, e comprende il codice fiscale e la
 * scansione di un documento d'identità: un campo che non parte è un dato che la
 * Segreteria dovrà chiedere di nuovo, a una persona che l'ha già scritto.
 *
 * ─── LE ALTRE QUATTRO COSE CHE QUESTO FILE DIFENDE ──────────────────────────
 *
 *  · **il guardiano del doppio tocco.** `disabled={inviando}` si arma DOPO un
 *    confine asincrono: tre tocchi rapidi facevano partire tre POST. Il tetto
 *    pubblico è per INDIRIZZO IP, e il modo previsto di usare questo modulo è più
 *    maestre che compilano lo stesso pomeriggio dietro il NAT della stessa sede:
 *    un doppio tocco brucia la dotazione oraria di tutte;
 *  · **nessuna bozza in `localStorage`.** Qui i campi sono il codice fiscale e il
 *    numero del documento. Una bozza li lascerebbe in chiaro nel browser — spesso
 *    condiviso, spesso di scuola — senza scadenza e fuori da ogni termine di
 *    conservazione dichiarato nelle prese visione;
 *  · **la guardia `beforeunload`**, che è ciò che sta al posto della bozza;
 *  · **la prosa del server non arriva a schermo.** I codici dichiarati si
 *    traducono dal catalogo; la prosa nasce dove il locale non esiste ed è
 *    italiana per costruzione (difetto T10-F1).
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { AnagraficaPersonaleWizard } from '@/components/features/public/AnagraficaPersonaleWizard'

interface CorpoInvio {
  scuola_id: string
  data: Record<string, unknown>
  sito_web?: string
}

async function montaEArrivaAlRiepilogo(
  rete = reteFinta(),
  opzioni: Parameters<typeof compilaFinoAlRiepilogo>[0] = {},
) {
  vi.stubGlobal('fetch', rete.fetch)
  render(<AnagraficaPersonaleWizard oggi={OGGI} />)
  await compilaFinoAlRiepilogo({ sede: ALFA.id, ...opzioni })
  return rete
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AnagraficaPersonaleWizard — il corpo del POST', () => {
  it('porta la SEDE, TUTTI i campi del template e TUTTE le prese visione', async () => {
    const rete = await montaEArrivaAlRiepilogo(reteFinta(), { sede: BETA.id })
    invia()

    await waitFor(() => expect(rete.inviati).toHaveLength(1))
    const corpo = rete.inviati[0] as CorpoInvio

    expect(corpo.scuola_id).toBe(BETA.id)
    // ⚠️ Nessuna chiave del template può mancare: una chiave assente è un `null`
    // in tabella su cui nessun controllo di forma si accorge di niente.
    for (const f of PERSONALE_FIELDS) {
      expect(Object.keys(corpo.data), `il campo «${f.id}» non è partito`).toContain(f.id)
    }
    for (const c of CONSENSI_PERSONALE_FIELDS) {
      expect(corpo.data[c.id], `la presa visione «${c.id}» non è partita`).toBe(true)
    }
  })

  it('i valori sono quelli scritti, nelle forme che il server si aspetta', async () => {
    const rete = await montaEArrivaAlRiepilogo()
    invia()
    await waitFor(() => expect(rete.inviati).toHaveLength(1))
    const d = (rete.inviati[0] as CorpoInvio).data

    expect(d.nome).toBe('Prova')
    expect(d.cognome).toBe('Esempio')
    expect(d.gender).toBe('F')
    // Le due date viaggiano in ISO, che è la forma di una colonna `date`: quella
    // della scadenza passa da `DateField`, che la converte da gg/mm/aaaa.
    expect(d.birth_date).toBe('1985-03-07')
    expect(d.document_expiry).toBe('2030-01-01')
    // Il luogo di nascita arriva dalla CASCATA: il codice catastale non lo digita
    // nessuno, e senza di esso il codice fiscale non sarebbe verificabile.
    expect(d.codice_belfiore_nascita).toBe('H501')
    expect(d.birth_place).toBe('NAPOLI')
    expect(d.birth_province).toBe('NA')
    expect(d.birth_nation).toBe('Italia')
    // Le fasce sono un array, come le vuole il `check (cardinality(gradi) >= 1)`.
    expect(d.gradi).toEqual(['infanzia'])
    // I percorsi delle DUE scansioni sono quelli che la rotta di caricamento ha
    // restituito: il modulo non li costruisce e non li ritocca. Sono due chiavi
    // distinte dal 12/08/2026 (migrazione `20260812194501`), e vanno asserite
    // entrambe: una sola direbbe che il documento è partito quando ne è partita
    // metà — e metà documento è una pratica che la Segreteria rimanda indietro.
    expect(d.documento_fronte_path).toBe(PERCORSO_SCANSIONE)
    expect(d.documento_retro_path).toBe(PERCORSO_SCANSIONE_RETRO)
    // I facoltativi non compilati partono vuoti, non spariscono.
    expect(Object.keys(d)).toContain('emergenza_nome')
  })

  it('l’ESCA parte, e parte vuota', async () => {
    const rete = await montaEArrivaAlRiepilogo()
    invia()
    await waitFor(() => expect(rete.inviati).toHaveLength(1))
    // Un modulo che l'esca non la rende affatto è una difesa che non scatta mai.
    expect((rete.inviati[0] as CorpoInvio).sito_web).toBe('')
  })

  it('e se l’esca è piena, parte piena: è la rotta a decidere che farne', async () => {
    const rete = await montaEArrivaAlRiepilogo()
    // Un compilatore automatico riempie ogni `input`, esca compresa.
    const esca = document.getElementById('sito_web') as HTMLInputElement
    fireEvent.change(esca, { target: { value: 'http://spam.example' } })
    invia()
    await waitFor(() => expect(rete.inviati).toHaveLength(1))
    expect((rete.inviati[0] as CorpoInvio).sito_web).toBe('http://spam.example')
  })
})

describe('AnagraficaPersonaleWizard — il guardiano del doppio tocco', () => {
  it('tre tocchi rapidi su «Invia» fanno UN SOLO POST', async () => {
    const rete = await montaEArrivaAlRiepilogo()
    const bottone = screen.getByRole('button', { name: itPublic.persInvia })

    fireEvent.click(bottone)
    fireEvent.click(bottone)
    fireEvent.click(bottone)

    await waitFor(() => expect(screen.getByText(itPublic.persInviata)).toBeInTheDocument())
    expect(rete.inviati).toHaveLength(1)
  })
})

describe('AnagraficaPersonaleWizard — la conferma', () => {
  it('sostituisce i passi, si ANNUNCIA e si prende il fuoco', async () => {
    await montaEArrivaAlRiepilogo()
    invia()

    await waitFor(() => expect(screen.getByText(itPublic.persInviata)).toBeInTheDocument())
    // Il bottone appena premuto è stato smontato: senza queste due cose il fuoco
    // cade su `<body>` e chi usa uno screen reader non sente niente — cioè
    // l'invio riuscito è indistinguibile da una pagina che si è rotta.
    const conferma = screen.getByText(itPublic.persInviata)
    expect(conferma.closest('[role="status"]')).not.toBeNull()
    expect(document.activeElement).toBe(conferma)
    expect(screen.queryByRole('button', { name: itPublic.persInvia })).not.toBeInTheDocument()
  })
})

describe('AnagraficaPersonaleWizard — i rifiuti del server', () => {
  it('400 con `campi`: il messaggio va SOTTO il campo, e si torna al suo passo', async () => {
    const rete = reteFinta({
      invii: [
        {
          tipo: 'http',
          stato: 400,
          corpo: {
            error: 'Alcuni campi non sono validi.',
            codice: 'PRATICA_NON_INVIATA',
            campi: { telefono: 'Numero non valido: controllalo' },
          },
        },
      ],
    })
    await montaEArrivaAlRiepilogo(rete)
    invia()

    await waitFor(() => expect(screen.getByLabelText(/^Numero di cellulare/)).toBeInTheDocument())
    expect(screen.getByText('Numero non valido: controllalo')).toBeInTheDocument()
    // Non si resta sul riepilogo davanti a una frase generica: chi compila deve
    // avere il campo sbagliato sotto le mani.
    expect(screen.queryByText(itPublic.persRiepilogoSede)).not.toBeInTheDocument()
  })

  it('400 con `consensi`: si torna alle prese visione, con LA frase di sempre', async () => {
    const rete = reteFinta({
      invii: [
        {
          tipo: 'http',
          stato: 400,
          corpo: {
            error: 'Per proseguire è necessario spuntare tutte le dichiarazioni.',
            codice: 'PRATICA_NON_INVIATA',
            consensi: ['dichiarazione_veridicita'],
          },
        },
      ],
    })
    await montaEArrivaAlRiepilogo(rete)
    invia()

    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: /dati sono veri/i })).toBeInTheDocument(),
    )
    // Il server manda gli id senza testo: il testo giusto ce l'ha già il client,
    // ed è lo stesso che comparirebbe se la spunta mancasse qui.
    expect(screen.getAllByText('Devi accettare per proseguire').length).toBeGreaterThan(0)
  })

  it('⚠️ 503: si legge la frase del CATALOGO, non la prosa del server', async () => {
    const rete = reteFinta({
      invii: [
        {
          tipo: 'http',
          stato: 503,
          corpo: {
            error: 'PROSA ITALIANA DEL SERVER CHE NON DEVE COMPARIRE',
            codice: 'PRATICHE_NON_DISPONIBILI',
          },
        },
      ],
    })
    await montaEArrivaAlRiepilogo(rete)
    invia()

    await waitFor(() =>
      expect(screen.getByText(itShared.errorePratichePersonaleNonDisponibili)).toBeInTheDocument(),
    )
    expect(screen.queryByText('PROSA ITALIANA DEL SERVER CHE NON DEVE COMPARIRE')).not.toBeInTheDocument()
    // E il log porta un'etichetta STABILE, non la frase del server: su un 400
    // quella nomina i campi respinti, e da lì finirebbe archiviata.
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ messaggio: 'anagrafica-personale-invio-fallito', stato: 503 }),
    )
  })

  it('rete caduta: pannello in pagina (mai un `alert()`), dati salvi, e un log', async () => {
    const rete = reteFinta()
    await montaEArrivaAlRiepilogo(rete)

    // La rete cade SOLO sull'invio: l'elenco delle sedi è già arrivato, e farlo
    // cadere adesso misurerebbe un'altra cosa.
    const originale = rete.fetch.getMockImplementation() as FintaFetch
    rete.fetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/iscrizione/personale') && init?.method === 'POST') {
        return Promise.reject(new TypeError('Failed to fetch'))
      }
      return originale(input, init)
    })

    invia()

    await waitFor(() => expect(screen.getByText(itPublic.persErroreInvioTitolo)).toBeInTheDocument())
    expect(screen.getByText(itPublic.persErroreInvioDatiSalvi)).toBeInTheDocument()
    // Si è ancora sul riepilogo, con tutto quello che si era scritto.
    expect(screen.getByText(itPublic.persRiepilogoSede)).toBeInTheDocument()
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ messaggio: expect.stringContaining('anagrafica-personale-invio-fallito') }),
    )
  })
})

describe('AnagraficaPersonaleWizard — nessuna bozza, e una guardia al suo posto', () => {
  it('⚠️ NIENTE finisce in `localStorage` o in `sessionStorage`', async () => {
    // Qui i campi sono il codice fiscale e il numero del documento: una bozza li
    // lascerebbe in chiaro in un browser spesso condiviso, senza scadenza e fuori
    // da ogni termine di conservazione dichiarato nelle prese visione.
    const rete = await montaEArrivaAlRiepilogo()
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)

    invia()
    await waitFor(() => expect(screen.getByText(itPublic.persInviata)).toBeInTheDocument())
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
    expect(rete.inviati).toHaveLength(1)
  })

  it('a modulo SPORCO chiudere la pagina chiede conferma; a modulo pulito no', async () => {
    const rete = reteFinta()
    vi.stubGlobal('fetch', rete.fetch)
    render(<AnagraficaPersonaleWizard oggi={OGGI} />)

    await waitFor(() => expect(screen.getAllByRole('radio').length).toBeGreaterThan(0))

    // Nessun campo toccato: chiudere non costa niente, e un avviso qui è solo un
    // ostacolo che si impara a chiudere senza leggerlo.
    expect(chiudendoLaPagina().defaultPrevented).toBe(false)

    fireEvent.click(document.getElementById(`pers-sede-${ALFA.id}`) as HTMLElement)
    fireEvent.click(screen.getByRole('button', { name: itPublic.persAvanti }))
    await waitFor(() => expect(screen.getByPlaceholderText('Es. Maria')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Es. Maria'), { target: { value: 'Prova' } })

    // Adesso c'è qualcosa da perdere, e non c'è nessuna bozza che lo recuperi.
    expect(chiudendoLaPagina().defaultPrevented).toBe(true)
  })

  it('a invio riuscito la guardia si toglie: non c’è più niente da perdere', async () => {
    await montaEArrivaAlRiepilogo()
    expect(chiudendoLaPagina().defaultPrevented).toBe(true)

    invia()
    await waitFor(() => expect(screen.getByText(itPublic.persInviata)).toBeInTheDocument())
    expect(chiudendoLaPagina().defaultPrevented).toBe(false)
  })
})

/** Simula la chiusura della scheda e restituisce l'evento, per leggerne l'esito. */
function chiudendoLaPagina(): Event {
  const evento = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(evento)
  return evento
}
