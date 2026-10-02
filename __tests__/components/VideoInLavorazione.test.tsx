import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

import itServizi from '../../messages/it/teacherServizi.json'
import itShared from '../../messages/it/shared.json'

/**
 * V11 · CHE COSA VEDE UNA PERSONA MENTRE IL VIDEO SI PREPARA.
 *
 * ─── IL CRITERIO, PRIMA DEI TEST ────────────────────────────────────────────
 *
 * Una conversione può durare minuti: nel campione misurato il 2026-09-17, 180
 * secondi a 1080p sono costati 709 secondi di wall su due vCPU. In quei minuti
 * l'interfaccia non può dire «caricamento», e non per eleganza: **se dice
 * caricamento per otto minuti, qualcuno ricarica e carica due volte** — e allora
 * due conversioni, due video in galleria, due notifiche alle famiglie.
 *
 * Quindi le fasi qui sono distinte e lo dicono a parole:
 *  · il CARICAMENTO ha una percentuale, perché i byte si contano;
 *  · la PREPARAZIONE non ce l'ha davvero (l'avanzamento del server è a scalini:
 *     25 in coda, 60 in conversione) e dice la cosa che serve sapere — che si può
 *     chiudere l'app;
 *  · il PRONTO non è pubblicato: manca un gesto, e lo si vede.
 *
 * ─── E COSA SUCCEDE SE CHIUDE L'APP ─────────────────────────────────────────
 *
 * I byte riprendono da soli (lo fa l'uploader TUS). I TAG no: vivono nella
 * memoria della pagina, e una pagina chiusa li perde. Perciò al rientro la scheda
 * di un video pronto CHIEDE i bambini invece di pubblicare a vuoto o di buttare
 * via il video: è la sola forma onesta, e questo file la tiene ferma.
 */

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
  usePathname: () => '/teacher/gallery',
}))

import { VideoInLavorazione, type RigaVideoLavorazione } from '@/components/features/gallery/VideoInLavorazione'

const JOB_A = '22222222-0000-4000-8000-00000000000a'
const JOB_B = '22222222-0000-4000-8000-00000000000b'

function riga(sovrascrivi: Partial<RigaVideoLavorazione> = {}): RigaVideoLavorazione {
  return {
    jobId: JOB_A,
    nome: 'recita.mp4',
    fase: 'conversione',
    percentuale: null,
    messaggio: null,
    chiedeTag: false,
    tagScelti: 0,
    ...sovrascrivi,
  }
}

const azioni = {
  onPubblica: vi.fn(),
  onRiprendi: vi.fn(),
  onRimuovi: vi.fn(),
}

beforeEach(() => vi.clearAllMocks())

function montaggio(righe: RigaVideoLavorazione[], extra: Record<string, unknown> = {}) {
  return render(<VideoInLavorazione righe={righe} {...azioni} {...extra} />)
}

describe('l’attesa ha un nome, e non è «caricamento»', () => {
  it('durante la conversione dice che si può chiudere l’app', () => {
    montaggio([riga({ fase: 'conversione' })])
    expect(screen.getByText(itServizi.galleryVideoFaseConversione)).toBeInTheDocument()
    // Il testo della conversione NON deve essere quello del caricamento: sono due
    // attese diverse, e confonderle è il difetto da cui nasce questa scheda.
    expect(screen.queryByText(itServizi.galleryVideoFaseCaricamento)).toBeNull()
  })

  it('la coda e la conversione non dicono la stessa cosa', () => {
    montaggio([riga({ fase: 'in-coda' })])
    expect(screen.getByText(itServizi.galleryVideoFaseInCoda)).toBeInTheDocument()
    expect(itServizi.galleryVideoFaseInCoda).not.toBe(itServizi.galleryVideoFaseConversione)
  })

  it('la fase è annunciata a chi non guarda lo schermo', () => {
    const { container } = montaggio([riga({ fase: 'conversione' })])
    const vivo = container.querySelector('[aria-live="polite"]')
    expect(vivo, 'la fase cambia da sola: senza `aria-live` uno screen reader non lo sa').toBeTruthy()
    expect(vivo!.textContent).toContain(itServizi.galleryVideoFaseConversione)
  })
})

describe('la percentuale c’è solo quando significa qualcosa', () => {
  it('durante il caricamento la barra dichiara il suo valore', () => {
    montaggio([riga({ fase: 'caricamento', percentuale: 42 })])
    const barra = screen.getByRole('progressbar')
    expect(barra).toHaveAttribute('aria-valuenow', '42')
    expect(barra).toHaveAttribute('aria-valuemin', '0')
    expect(barra).toHaveAttribute('aria-valuemax', '100')
    // Un nome accessibile: «42» da solo non dice di che cosa sia la percentuale.
    expect(barra.getAttribute('aria-label') || barra.getAttribute('aria-labelledby')).toBeTruthy()
  })

  it('su un fallimento NON c’è nessuna barra: una barra su un errore è una bugia', () => {
    montaggio([riga({ fase: 'fallito', percentuale: null, messaggio: 'Non è riuscita' })])
    expect(screen.queryByRole('progressbar')).toBeNull()
  })
})

describe('pronto non è pubblicato', () => {
  it('offre il gesto che manca', () => {
    montaggio([riga({ fase: 'pronto' })])
    expect(screen.getByText(itServizi.galleryVideoFasePronto)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: itServizi.galleryVideoPubblica }))
    expect(azioni.onPubblica).toHaveBeenCalledWith(JOB_A)
  })

  it('al rientro nell’app chiede i bambini, perché i tag non sopravvivono alla chiusura', () => {
    const tagger = vi.fn((jobId: string) => <div data-testid={`tagger-${jobId}`}>tagger</div>)
    montaggio([riga({ fase: 'pronto', chiedeTag: true, tagScelti: 0 })], { renderTagger: tagger })

    expect(screen.getByTestId(`tagger-${JOB_A}`)).toBeInTheDocument()
    expect(screen.getByText(itServizi.galleryVideoChiediTag)).toBeInTheDocument()
    // Senza nemmeno un bambino scelto non si pubblica: è la stessa regola del
    // passo 2, dove il bottone resta spento finché ogni file non ha i suoi tag.
    expect(screen.getByRole('button', { name: itServizi.galleryVideoPubblica })).toBeDisabled()
  })

  it('con almeno un bambino scelto il gesto si sblocca', () => {
    const tagger = vi.fn(() => <div>tagger</div>)
    montaggio([riga({ fase: 'pronto', chiedeTag: true, tagScelti: 2 })], { renderTagger: tagger })
    expect(screen.getByRole('button', { name: itServizi.galleryVideoPubblica })).toBeEnabled()
  })

  it('quando i tag ci sono già il tagger NON compare: non si chiede due volte', () => {
    const tagger = vi.fn(() => <div data-testid="tagger">tagger</div>)
    montaggio([riga({ fase: 'pronto', chiedeTag: false })], { renderTagger: tagger })
    expect(screen.queryByTestId('tagger')).toBeNull()
  })
})

describe('il caricamento interrotto si riprende, non si ricomincia', () => {
  it('il pulsante «Riprendi» agisce sulla riga giusta anche quando ce ne sono due', () => {
    montaggio([
      riga({ jobId: JOB_A, fase: 'interrotto', percentuale: 30, nome: 'uno.mp4' }),
      riga({ jobId: JOB_B, fase: 'interrotto', percentuale: 70, nome: 'due.mp4' }),
    ])
    const schede = screen.getAllByRole('listitem')
    expect(schede).toHaveLength(2)
    fireEvent.click(within(schede[1]).getByRole('button', { name: itServizi.galleryVideoRiprendi }))
    expect(azioni.onRiprendi).toHaveBeenCalledWith(JOB_B)
    expect(azioni.onRiprendi).not.toHaveBeenCalledWith(JOB_A)
  })
})

describe('un fallimento dice che cosa fare, e si può togliere di mezzo', () => {
  it('mostra il messaggio già tradotto che gli arriva, non un codice', () => {
    montaggio([riga({ fase: 'fallito', messaggio: 'Questo video dura più di 3 minuti.' })])
    expect(screen.getByText('Questo video dura più di 3 minuti.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: itServizi.galleryVideoRimuovi }))
    expect(azioni.onRimuovi).toHaveBeenCalledWith(JOB_A)
  })
})

/**
 * «IL PROBLEMA È NOSTRO: LO STIAMO RIPROVANDO» — la scheda che racconta un ritentativo.
 *
 * La scheda non DECIDE niente: riceve il messaggio già tradotto da chi la monta (l'hook
 * `useVideoGalleria`, che lo sceglie dal flag `riprovaAutomatica` del server) e lo mostra
 * come un messaggio su una fase che NON è un fallimento. Quello che qui si tiene fermo è la
 * FORMA: sotto la fase, non rosso (non è un errore: non c'è niente che la persona debba
 * fare), e ANNUNCIATO — compare minuti dopo, da solo, e senza `aria-live` chi usa uno
 * screen reader resta convinto che la coda sia ferma.
 * Che il messaggio compaia SOLO mentre si ritenta lo provano i test dell'hook e della pagina.
 */
describe('un ritentativo automatico si legge, e si sente', () => {
  it.each([
    ['in-coda', itServizi.galleryVideoFaseInCoda],
    ['conversione', itServizi.galleryVideoFaseConversione],
  ] as const)('in fase %s il messaggio sta SOTTO la fase, che resta', (fase, testoFase) => {
    montaggio([riga({ fase, messaggio: itServizi.galleryVideoRiprovaAutomatica })])
    // La fase non sparisce: «in attesa» / «preparazione in corso» è ancora vero.
    expect(screen.getByText(testoFase)).toBeInTheDocument()
    const messaggio = screen.getByText(itServizi.galleryVideoRiprovaAutomatica)
    expect(messaggio).toBeInTheDocument()
    // Sotto la fase, non al suo posto: i due paragrafi sono fratelli e il messaggio viene dopo.
    const fasePar = screen.getByText(testoFase)
    expect(fasePar.compareDocumentPosition(messaggio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('il messaggio è ANNUNCIATO: `aria-live="polite"`, come la fase', () => {
    const { container } = montaggio([riga({ fase: 'conversione', messaggio: itServizi.galleryVideoRiprovaAutomatica })])
    const messaggio = screen.getByText(itServizi.galleryVideoRiprovaAutomatica)
    expect(
      messaggio,
      'compare da solo, minuti dopo: senza `aria-live` chi non guarda lo schermo non lo sa',
    ).toHaveAttribute('aria-live', 'polite')
    // Le regioni vive sono DUE (fase e messaggio) e nessuna è `assertive`: «lo stiamo
    // riprovando» non deve interrompere ciò che la persona sta facendo.
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(2)
    expect(container.querySelector('[aria-live="assertive"]')).toBeNull()
  })

  it('non è un errore rosso: non c’è niente che la persona debba fare', () => {
    montaggio([riga({ fase: 'in-coda', messaggio: itServizi.galleryVideoRiprovaAutomatica })])
    const messaggio = screen.getByText(itServizi.galleryVideoRiprovaAutomatica)
    expect(messaggio.className).toContain('text-kidville-sub')
    expect(messaggio.className).not.toContain('text-kidville-error')
    // E nessuna barra di errore o percentuale inventata: la barra resta quella delle fasi.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('senza messaggio la scheda non ha né il paragrafo né la seconda regione viva', () => {
    // L'assenza è vera solo se la presenza lo è: si controlla PRIMA che la fase sia a schermo.
    const { container } = montaggio([riga({ fase: 'in-coda', messaggio: null })])
    expect(screen.getByText(itServizi.galleryVideoFaseInCoda)).toBeInTheDocument()
    expect(screen.queryByText(itServizi.galleryVideoRiprovaAutomatica)).toBeNull()
    expect(container.querySelectorAll('[aria-live="polite"]')).toHaveLength(1)
  })

  it('un fallimento nostro mostra la frase finale UNA volta, nel paragrafo di fase, in rosso', () => {
    // Esauriti i tentativi il job è `failed`: la frase è quella del guasto nostro e NON si
    // aggiunge il messaggio «lo stiamo riprovando», che non è più vero.
    montaggio([riga({ fase: 'fallito', messaggio: itShared.erroreVideoGuastoNostro })])
    expect(screen.getAllByText(itShared.erroreVideoGuastoNostro)).toHaveLength(1)
    expect(screen.getByText(itShared.erroreVideoGuastoNostro).className).toContain('text-kidville-error')
    expect(screen.queryByText(itServizi.galleryVideoRiprovaAutomatica)).toBeNull()
  })
})

describe('le regole di casa', () => {
  it('senza righe non disegna un riquadro vuoto', () => {
    const { container } = montaggio([])
    expect(container.textContent).toBe('')
  })

  it('il nome del file si vede (serve a riconoscerlo) e nessun testo usa il grigio a 2,51:1', () => {
    const { container } = montaggio([riga({ nome: 'recita.mp4' })])
    expect(screen.getByText('recita.mp4')).toBeInTheDocument()
    expect(
      container.innerHTML.includes('text-kidville-muted'),
      '`text-kidville-muted` vale 2,51:1 su bianco: il token del testo secondario è `text-kidville-sub`',
    ).toBe(false)
  })
})
