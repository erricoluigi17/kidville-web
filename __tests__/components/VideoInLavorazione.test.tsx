import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'

import itServizi from '../../messages/it/teacherServizi.json'
import itShared from '../../messages/it/shared.json'
import { formatData } from '@/lib/i18n/date'

/**
 * V11 · CHE COSA VEDE UNA PERSONA MENTRE IL VIDEO SI PREPARA.
 *
 * ─── IL CRITERIO, PRIMA DEI TEST ────────────────────────────────────────────
 *
 * Una conversione può durare minuti: in un campione misurato il 2026-09-17, un filmato di 180
 * secondi a 1080p è costato 709 secondi di wall su due vCPU. In quei minuti
 * l'interfaccia non può dire «caricamento», e non per eleganza: **se dice
 * caricamento per otto minuti, qualcuno ricarica e carica due volte** — e allora
 * due conversioni, due video in galleria, due notifiche alle famiglie.
 *
 * Quindi le fasi qui sono distinte e lo dicono a parole:
 *  · il CARICAMENTO ha una percentuale, perché i byte si contano, e dice la verità sul TUS: continua
 *    finché l'app è aperta, e riprende da solo alla riapertura;
 *  · la PREPARAZIONE non ce l'ha davvero (l'avanzamento del server è a scalini) e dice la cosa che
 *    serve sapere — che si può chiudere l'app;
 *  · il PRONTO non chiede più niente: i bambini li ha scelti prima, e a pubblicare è il server.
 *
 * ─── DUE REGIONI VIVE, SEMPRE NEL DOM ───────────────────────────────────────
 *
 * Secondario #36: VoiceOver spesso non annuncia una regione `aria-live` che entra nel documento già
 * piena, e le insegnanti dell'incidente erano su iOS. Il paragrafo del messaggio c'è SEMPRE, e cambia
 * solo il suo testo: è la forma robusta, e questo file la tiene ferma.
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
    creatoIl: '2026-10-02T10:00:00.000Z',
    fase: 'conversione',
    percentuale: null,
    messaggio: null,
    riprovaPossibile: false,
    ...sovrascrivi,
  }
}

const azioni = {
  onRiprendi: vi.fn(),
  onRimuovi: vi.fn(),
  onRiprova: vi.fn(),
}

beforeEach(() => vi.clearAllMocks())

function montaggio(righe: RigaVideoLavorazione[]) {
  return render(<VideoInLavorazione righe={righe} {...azioni} />)
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

  it.each([
    ['caricamento', itServizi.galleryVideoFaseCaricamento],
    ['in-fila', itServizi.galleryVideoFaseInFila],
    ['interrotto', itServizi.galleryVideoFaseInterrotto],
    ['altro-dispositivo', itServizi.galleryVideoFaseAltroDispositivo],
    ['in-coda', itServizi.galleryVideoFaseInCoda],
    ['conversione', itServizi.galleryVideoFaseConversione],
    ['in-riprova', itServizi.galleryVideoRiprovaAutomatica],
    ['pronto', itServizi.galleryVideoFasePronto],
    ['non-pubblicato', itServizi.galleryVideoNonPubblicato],
    ['fallito', itServizi.galleryVideoNonPubblicato],
    ['da-ricaricare', itServizi.galleryVideoDaRicaricare],
    ['annullato', itServizi.galleryVideoFaseAnnullato],
  ] as const)('la fase %s si legge con la sua frase', (fase, testo) => {
    montaggio([riga({ fase })])
    expect(screen.getByText(testo)).toBeInTheDocument()
  })

  it('un video pronto NON chiede niente: né i bambini né un pulsante «Pubblica»', () => {
    montaggio([riga({ fase: 'pronto' })])
    expect(screen.getByText(itServizi.galleryVideoFasePronto)).toBeInTheDocument()
    // I bambini li ha scelti prima, e a pubblicare è il server: l'unico gesto che resta è ritirare.
    expect(screen.queryByRole('button', { name: /pubblica/i })).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('il testo del TUS è onesto: continua finché l’app è aperta, e non promette ciò che non fa', () => {
    expect(itServizi.galleryVideoCaricamentoTus).toMatch(/finché l’app è aperta/)
    expect(itServizi.galleryVideoCaricamentoTus).toMatch(/riprende da solo/)
    // «Puoi chiudere l'app» a trasferimento in corso sarebbe falso con TUS: il testo dell'invio non lo dice.
    expect(itServizi.galleryVideoAvviato).not.toMatch(/puoi chiudere/i)
  })
})

describe('le regioni vive stanno SEMPRE nel DOM (secondario #36)', () => {
  it('ogni scheda ha due regioni `polite`, anche senza nessun messaggio', () => {
    const { container } = montaggio([riga({ fase: 'in-coda', messaggio: null })])
    expect(screen.getByText(itServizi.galleryVideoFaseInCoda)).toBeInTheDocument()
    const vive = container.querySelectorAll('[aria-live]')
    expect(vive).toHaveLength(2)
    expect([...vive].every((v) => v.getAttribute('aria-live') === 'polite')).toBe(true)
    // La seconda è vuota: c'è, e non dice niente.
    expect(vive[1].textContent).toBe('')
  })

  it('il messaggio compare DENTRO la regione che c’era già: lo stesso nodo, non uno nuovo', () => {
    const { container, rerender } = montaggio([riga({ fase: 'caricamento', percentuale: 10 })])
    const prima = container.querySelectorAll('[aria-live]')[1]
    expect(prima.textContent).toBe('')

    rerender(
      <VideoInLavorazione
        righe={[riga({ fase: 'caricamento', percentuale: 10, messaggio: itServizi.galleryVideoCaricamentoTus })]}
        {...azioni}
      />,
    )
    const dopo = container.querySelectorAll('[aria-live]')[1]
    // ⚠️ È QUESTO IL PUNTO: un elemento montato a condizione «entra nel DOM già pieno», e VoiceOver
    // spesso non lo annuncia. Lo stesso nodo che cambia testo, sì.
    expect(dopo).toBe(prima)
    expect(dopo.textContent).toBe(itServizi.galleryVideoCaricamentoTus)
  })

  it('la fase è annunciata a chi non guarda lo schermo', () => {
    const { container } = montaggio([riga({ fase: 'conversione' })])
    const vivo = container.querySelector('[aria-live="polite"]')
    expect(vivo, 'la fase cambia da sola: senza `aria-live` uno screen reader non lo sa').toBeTruthy()
    expect(vivo!.textContent).toContain(itServizi.galleryVideoFaseConversione)
    expect(container.querySelector('[aria-live="assertive"]')).toBeNull()
  })

  it('un messaggio su una fase che NON è un fallimento è sotto la fase, non rosso, e non è un errore', () => {
    montaggio([riga({ fase: 'in-coda', messaggio: 'Una nota' })])
    const messaggio = screen.getByText('Una nota')
    const fasePar = screen.getByText(itServizi.galleryVideoFaseInCoda)
    expect(fasePar.compareDocumentPosition(messaggio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(messaggio.className).toContain('text-kidville-sub')
    expect(messaggio.className).not.toContain('text-kidville-error')
    expect(screen.queryByRole('alert')).toBeNull()
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

describe('il caricamento interrotto si riprende, non si ricomincia', () => {
  it('il pulsante «Riprendi» agisce sulla riga giusta anche quando ce ne sono due', () => {
    montaggio([
      riga({ jobId: JOB_A, fase: 'interrotto', nome: 'uno.mp4' }),
      riga({ jobId: JOB_B, fase: 'interrotto', nome: 'due.mp4' }),
    ])
    const schede = screen.getAllByRole('listitem')
    expect(schede).toHaveLength(2)
    fireEvent.click(within(schede[1]).getByRole('button', { name: itServizi.galleryVideoRiprendi }))
    expect(azioni.onRiprendi).toHaveBeenCalledWith(JOB_B)
    expect(azioni.onRiprendi).not.toHaveBeenCalledWith(JOB_A)
  })

  it('«Riprendi» c’è SOLO sul caricamento fermo', () => {
    montaggio([riga({ fase: 'caricamento', percentuale: 5 })])
    expect(screen.queryByRole('button', { name: itServizi.galleryVideoRiprendi })).toBeNull()
  })
})

describe('«Riprova»: solo se il server, premuto, direbbe di sì', () => {
  it('su un non pubblicato che il server riprenderebbe offre «Riprova», sulla riga giusta', () => {
    montaggio([
      riga({ jobId: JOB_A, fase: 'non-pubblicato', messaggio: itShared.erroreVideoPubblicazioneNonRiuscita, riprovaPossibile: true }),
      riga({ jobId: JOB_B, fase: 'non-pubblicato', messaggio: itShared.erroreVideoPubblicazioneNonRiuscita, riprovaPossibile: true }),
    ])
    const schede = screen.getAllByRole('listitem')
    fireEvent.click(within(schede[1]).getByRole('button', { name: itServizi.galleryVideoRiprova }))
    expect(azioni.onRiprova).toHaveBeenCalledTimes(1)
    expect(azioni.onRiprova).toHaveBeenCalledWith(JOB_B)
  })

  it('senza `riprovaPossibile` il pulsante non c’è: un «Riprova» che risponde 409 è un pulsante che mente', () => {
    montaggio([riga({ fase: 'non-pubblicato', messaggio: itShared.erroreVideoNessunDestinatario, riprovaPossibile: false })])
    expect(screen.getByText(itShared.erroreVideoNessunDestinatario)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: itServizi.galleryVideoRiprova })).toBeNull()
  })

  it('il pulsante c’è solo su un NON PUBBLICATO, anche se la riga arrivasse con il flag acceso', () => {
    montaggio([riga({ fase: 'pronto', riprovaPossibile: true })])
    expect(screen.queryByRole('button', { name: itServizi.galleryVideoRiprova })).toBeNull()
  })
})

describe('ciò che è andato male dice perché, e si toglie di mezzo', () => {
  it.each(['non-pubblicato', 'fallito', 'da-ricaricare', 'annullato'] as const)(
    'in fase %s il gesto si chiama «Togli», non «Rimuovi»',
    (fase) => {
      montaggio([riga({ fase, messaggio: 'Perché' })])
      fireEvent.click(screen.getByRole('button', { name: itServizi.galleryVideoTogli }))
      expect(azioni.onRimuovi).toHaveBeenCalledWith(JOB_A)
      expect(screen.queryByRole('button', { name: itServizi.galleryVideoRimuovi })).toBeNull()
    },
  )

  it.each(['caricamento', 'in-fila', 'interrotto', 'altro-dispositivo', 'in-coda', 'conversione', 'in-riprova', 'pronto'] as const)(
    'in fase %s si può ancora «Rimuovere»: chi ha caricato il filmato sbagliato lo ritira prima che esca',
    (fase) => {
      montaggio([riga({ fase })])
      fireEvent.click(screen.getByRole('button', { name: itServizi.galleryVideoRimuovi }))
      expect(azioni.onRimuovi).toHaveBeenCalledWith(JOB_A)
    },
  )

  it('un fallimento dice «non pubblicato» e il MOTIVO una volta sola, in rosso', () => {
    montaggio([riga({ fase: 'fallito', messaggio: itShared.erroreVideoGuastoNostro })])
    expect(screen.getByText(itServizi.galleryVideoNonPubblicato)).toBeInTheDocument()
    expect(screen.getAllByText(itShared.erroreVideoGuastoNostro)).toHaveLength(1)
    expect(screen.getByText(itShared.erroreVideoGuastoNostro).className).toContain('text-kidville-error')
    expect(screen.getByText(itServizi.galleryVideoNonPubblicato).className).toContain('text-kidville-error')
  })

  it('un fallimento senza una frase non lascia una scheda muta: il ripiego generico', () => {
    montaggio([riga({ fase: 'fallito', messaggio: null })])
    expect(screen.getByText(itServizi.galleryErrCaricamentoGenerico)).toBeInTheDocument()
  })

  it('«da ricaricare» non porta un motivo inventato: la frase di fase basta', () => {
    const { container } = montaggio([riga({ fase: 'da-ricaricare', messaggio: null })])
    expect(screen.getByText(itServizi.galleryVideoDaRicaricare)).toBeInTheDocument()
    expect(screen.queryByText(itServizi.galleryErrCaricamentoGenerico)).toBeNull()
    expect(container.querySelectorAll('[aria-live]')[1].textContent).toBe('')
  })
})

describe('il nome del video', () => {
  it('si vede (serve a riconoscerlo)', () => {
    montaggio([riga({ nome: 'recita.mp4' })])
    expect(screen.getByText('recita.mp4')).toBeInTheDocument()
  })

  it('un video mandato da un altro dispositivo non ha nome: la scheda dice quando è stato inviato', () => {
    montaggio([riga({ nome: null, creatoIl: '2026-10-02T10:00:00.000Z', fase: 'altro-dispositivo' })])
    const quando = formatData('2026-10-02T10:00:00.000Z', 'it', 'dataOra')
    expect(quando).toContain('2026')
    expect(screen.getByText(`Video inviato il ${quando}`)).toBeInTheDocument()
    expect(screen.getByText(itServizi.galleryVideoFaseAltroDispositivo)).toBeInTheDocument()
  })
})

describe('le regole di casa', () => {
  it('senza righe non disegna un riquadro vuoto', () => {
    const { container } = montaggio([])
    expect(container.textContent).toBe('')
  })

  it('nessun testo usa il grigio a 2,51:1', () => {
    const { container } = montaggio([riga({ fase: 'in-coda', messaggio: 'x' }), riga({ jobId: JOB_B, fase: 'fallito', messaggio: 'y' })])
    expect(
      container.innerHTML.includes('text-kidville-muted'),
      '`text-kidville-muted` vale 2,51:1 su bianco: il token del testo secondario è `text-kidville-sub`',
    ).toBe(false)
  })
})
