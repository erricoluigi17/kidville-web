import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react'
import { useState } from 'react'

/**
 * LA FOTO DELLA CHAT SI APRE A TUTTO SCHERMO (spec 2026-11-03, Compito 4).
 *
 * Oggi toccare una foto in chat non fa niente: l'`<img>` è nudo e ritagliato a `max-h-48`, quindi la
 * foto intera non si vede mai e non si salva. Qui si prova il pezzo che manca, con
 * `ChatMessageArea` VERA e il visore vero (`VisoreMedia` + `ComandiMedia`): il tocco sulla miniatura,
 * le frecce fra le sole foto mostrabili, i pulsanti per superficie, e le tre proprietà che la
 * revisione del piano ha messo in primo piano —
 *
 *  1. DUE `ChatMessageArea` montate insieme (desktop + mobile, sempre entrambe nel DOM): il tocco
 *     apre UN visore solo, e Indietro di Android chiude solo quello;
 *  2. FIRMA SCADUTA col visore aperto a lungo: il polling rifirma gli URL a ogni giro, e l'indirizzo
 *     nuovo deve arrivare ai comandi (Scarica, Condividi) ma NON all'`<img>`, che altrimenti si
 *     ricaricherebbe sotto gli occhi di chi guarda;
 *  4. un messaggio col PERCORSO GREZZO (arrivato dal realtime, non ancora firmato) non è nel visore e
 *     non si può toccare finché non è firmato.
 *
 * `@/lib/native/scarica` è finto (le due azioni e la capacità di condividere un file): ciò che conta
 * qui è CHI lo chiama, con quale indirizzo e con quale nome. Il nome del file resta il VERO
 * `nomeFileScarico`, perché è metà della correzione: il nome originale dell'allegato non deve
 * finire nel file scaricato. Nomi e URL sono di fantasia: in questo repo non entrano dati di bambini.
 */

const h = vi.hoisted(() => ({
  scaricaMedia: vi.fn<(input: Record<string, unknown>) => Promise<{ esito: string; motivo?: string }>>(),
  condividiMedia: vi.fn<(input: Record<string, unknown>) => Promise<{ esito: string; motivo?: string }>>(),
  puoCondividere: vi.fn<() => boolean>(),
  logClient: vi.fn(),
}))

vi.mock('@/lib/native/scarica', async () => {
  const vero = await vi.importActual<typeof import('@/lib/native/scarica')>('@/lib/native/scarica')
  return {
    ...vero,
    scaricaMedia: h.scaricaMedia,
    condividiMedia: h.condividiMedia,
    puoCondividereFileMedia: h.puoCondividere,
  }
})
vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.constructor.name : 'Sconosciuto'),
}))
// L'hook vero, ma osservabile: nella supervisione conta CON QUALE etichetta lo si chiama.
vi.mock('@/components/features/media/useAzioniMedia', async () => {
  const vero = await vi.importActual<typeof import('@/components/features/media/useAzioniMedia')>(
    '@/components/features/media/useAzioniMedia',
  )
  return { ...vero, useAzioniMedia: vi.fn(vero.useAzioniMedia) }
})

import { ChatMessageArea, type ChatMessage } from '@/components/features/chat/ChatMessageArea'
import { VisoreFotoChat } from '@/components/features/chat/VisoreFotoChat'
import { useAzioniMedia } from '@/components/features/media/useAzioniMedia'
import { chiudiOverlayInCima } from '@/lib/mobile/overlay-indietro'
import itChat from '../../messages/it/parentChat.json'
import itShared from '../../messages/it/shared.json'

const APRI = itChat.chatApriFoto
const NOME_DIALOGO = (n: number, totale: number) => `Foto ${n} di ${totale} della conversazione`

const URL_A = 'https://firmato.test/storage/v1/object/sign/chat-allegati/th-1/aaaa-nome-originale-segreto.jpg?token=a1'
const URL_B = 'https://firmato.test/storage/v1/object/sign/chat-allegati/th-1/bbbb-seconda.jpg?token=b1'
const URL_C = 'https://firmato.test/storage/v1/object/sign/chat-allegati/th-1/cccc-terza.jpg?token=c1'
const PERCORSO_GREZZO = 'th-1/bbbb-seconda.jpg'

const base: Omit<ChatMessage, 'id'> = {
  thread_id: 'th-1',
  sender_id: 'doc-1',
  content: 'Ecco',
  attachment_url: null,
  attachment_type: null,
  read_at: '2026-11-03T08:00:00.000Z',
  created_at: '2026-11-03T07:59:00.000Z',
}

/** Un minuto in più a ogni messaggio: l'ordine cronologico è quello dell'array. */
let contatore = 0
function messaggio(id: string, attachment_url: string | null, attachment_type: string | null): ChatMessage {
  contatore += 1
  const minuti = String(contatore).padStart(2, '0')
  return { ...base, id, attachment_url, attachment_type, created_at: `2026-11-03T08:${minuti}:00.000Z` }
}
const fotoA = () => messaggio('m-a', URL_A, 'image')
const fotoB = (url: string = URL_B) => messaggio('m-b', url, 'image')
const fotoC = () => messaggio('m-c', URL_C, 'image')
const documento = () => messaggio('m-doc', 'https://firmato.test/storage/v1/object/sign/chat-allegati/th-1/scheda.pdf?token=d1', 'document')

function chat(messages: ChatMessage[], azioniFoto: 'genitore' | 'staff' = 'genitore') {
  return <ChatMessageArea messages={messages} currentUserId="gen-1" otherUserName="Maestra" firstUnreadId={null} azioniFoto={azioniFoto} />
}

beforeAll(() => {
  // jsdom non implementa scrollIntoView: gli effetti di scorrimento lo chiamano al montaggio.
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  contatore = 0
  vi.clearAllMocks()
  h.puoCondividere.mockReturnValue(true)
  h.scaricaMedia.mockResolvedValue({ esito: 'web-blob' })
  h.condividiMedia.mockResolvedValue({ esito: 'nativo-foglio' })
  vi.spyOn(window, 'alert').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Il tasto Indietro di Android: lo chiama il gestore nativo, fuori da React. */
function premiIndietro(): boolean {
  let consumato = false
  act(() => {
    consumato = chiudiOverlayInCima()
  })
  return consumato
}

const miniature = () => screen.queryAllByRole('button', { name: APRI })

describe('Chat — la miniatura è un comando che apre il visore', () => {
  it('toccare la miniatura apre il visore su quella foto', () => {
    render(chat([fotoA(), fotoB()]))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: APRI })[0])

    const dialogo = screen.getByRole('dialog', { name: NOME_DIALOGO(1, 2) })
    expect(dialogo.getAttribute('aria-modal')).toBe('true')
    expect(within(dialogo).getByAltText(itChat.attachmentAlt).getAttribute('src')).toBe(URL_A)
  })

  it('toccare la seconda miniatura apre il visore sulla seconda foto', () => {
    render(chat([fotoA(), fotoB()]))
    fireEvent.click(screen.getAllByRole('button', { name: APRI })[1])
    const dialogo = screen.getByRole('dialog', { name: NOME_DIALOGO(2, 2) })
    expect(within(dialogo).getByAltText(itChat.attachmentAlt).getAttribute('src')).toBe(URL_B)
  })

  it('la miniatura è un <button> vero con la stessa immagine di prima (stesse classi, stesso alt)', () => {
    render(chat([fotoA()]))
    const pulsante = screen.getByRole('button', { name: APRI })
    expect(pulsante.tagName).toBe('BUTTON')
    expect(pulsante.getAttribute('type')).toBe('button')
    const img = within(pulsante).getByAltText(itChat.attachmentAlt)
    expect(img.getAttribute('src')).toBe(URL_A)
    // Il lock `media-con-rapporto-daspetto` tiene queste classi: tetto d'altezza + object-fit.
    expect(img.className).toContain('w-full h-auto max-h-48 object-cover')
  })

  it('un documento non diventa una miniatura e un messaggio senza allegato nemmeno', () => {
    render(chat([documento(), messaggio('m-t', null, null)]))
    expect(miniature()).toHaveLength(0)
  })

  it('è raggiungibile da tastiera: un <button> vero, che il browser attiva da sé con Invio e Spazio', () => {
    // jsdom non traduce Invio/Spazio in clic: non si può provare il gesto, si prova la FORMA che lo
    // rende possibile — un <button> con il fuoco, non un <div onClick> che da tastiera non esiste.
    render(chat([fotoA()]))
    const pulsante = screen.getByRole('button', { name: APRI })
    pulsante.focus()
    expect(document.activeElement).toBe(pulsante)
    expect(pulsante.getAttribute('tabindex')).not.toBe('-1')
  })
})

describe('Chat — le frecce passano solo fra le foto mostrabili', () => {
  it('foto A, documento, foto B col percorso grezzo, foto C: da A la freccia porta a C', () => {
    render(chat([fotoA(), documento(), fotoB(PERCORSO_GREZZO), fotoC()]))

    // Il percorso grezzo non si può toccare: due miniature, A e C. E non c'è un'immagine rotta.
    expect(miniature()).toHaveLength(2)
    for (const img of document.querySelectorAll('img')) {
      expect(img.getAttribute('src')?.startsWith('http'), 'una <img> con un percorso grezzo').toBe(true)
    }

    fireEvent.click(miniature()[0])
    expect(screen.getByRole('dialog', { name: NOME_DIALOGO(1, 2) })).toBeTruthy()
    expect(screen.queryByTitle(itShared.mediaPrecedente)).toBeNull()

    fireEvent.click(screen.getByTitle(itShared.mediaSuccessiva))
    const dialogo = screen.getByRole('dialog', { name: NOME_DIALOGO(2, 2) })
    expect(within(dialogo).getByAltText(itChat.attachmentAlt).getAttribute('src')).toBe(URL_C)
    expect(screen.queryByTitle(itShared.mediaSuccessiva)).toBeNull()

    fireEvent.click(screen.getByTitle(itShared.mediaPrecedente))
    expect(screen.getByRole('dialog', { name: NOME_DIALOGO(1, 2) })).toBeTruthy()
  })

  it('le frecce da tastiera fanno lo stesso, Escape chiude', () => {
    render(chat([fotoA(), fotoB(), fotoC()]))
    fireEvent.click(miniature()[0])
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    expect(screen.getByRole('dialog', { name: NOME_DIALOGO(2, 3) })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    expect(screen.getByRole('dialog', { name: NOME_DIALOGO(1, 3) })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('quando il percorso grezzo viene firmato la foto entra nel visore, nel suo posto cronologico', () => {
    const iniziali = [fotoA(), fotoB(PERCORSO_GREZZO), fotoC()]
    const { rerender } = render(chat(iniziali))
    expect(miniature()).toHaveLength(2)

    // Il polling porta il link firmato: stesso messaggio, stesso id, URL vero.
    rerender(chat([iniziali[0], { ...iniziali[1], attachment_url: URL_B }, iniziali[2]]))
    expect(miniature()).toHaveLength(3)

    fireEvent.click(miniature()[1])
    const dialogo = screen.getByRole('dialog', { name: NOME_DIALOGO(2, 3) })
    expect(within(dialogo).getByAltText(itChat.attachmentAlt).getAttribute('src')).toBe(URL_B)
  })

  it('la ✕ e il tocco fuori chiudono il visore', () => {
    render(chat([fotoA(), fotoB()]))
    fireEvent.click(miniature()[0])
    fireEvent.click(screen.getByText('✕'))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(miniature()[0])
    fireEvent.click(screen.getByTestId('visore-scorrimento'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('Chat — chi ha quali pulsanti', () => {
  it('genitore: Scarica e Condividi', () => {
    render(chat([fotoA()], 'genitore'))
    fireEvent.click(miniature()[0])
    const dialogo = screen.getByRole('dialog')
    expect(within(dialogo).getByRole('button', { name: itShared.mediaScarica })).toBeTruthy()
    expect(within(dialogo).getByRole('button', { name: itShared.mediaCondividi })).toBeTruthy()
  })

  it('staff (docente): solo Scarica, anche se il dispositivo saprebbe condividere un file', () => {
    expect(h.puoCondividere()).toBe(true)
    render(chat([fotoA()], 'staff'))
    fireEvent.click(miniature()[0])
    const dialogo = screen.getByRole('dialog')
    expect(within(dialogo).getByRole('button', { name: itShared.mediaScarica })).toBeTruthy()
    expect(within(dialogo).queryByRole('button', { name: itShared.mediaCondividi })).toBeNull()
  })

  it('genitore su un dispositivo che non condivide file (web senza canShare): Condividi non c’è', () => {
    h.puoCondividere.mockReturnValue(false)
    render(chat([fotoA()], 'genitore'))
    fireEvent.click(miniature()[0])
    const dialogo = screen.getByRole('dialog')
    expect(within(dialogo).getByRole('button', { name: itShared.mediaScarica })).toBeTruthy()
    expect(within(dialogo).queryByRole('button', { name: itShared.mediaCondividi })).toBeNull()
  })

  it('in chat non ci sono didascalia, Segnala né Elimina', () => {
    render(chat([fotoA()], 'genitore'))
    fireEvent.click(miniature()[0])
    const dialogo = screen.getByRole('dialog')
    expect(within(dialogo).queryByText(itShared.mediaSegnala)).toBeNull()
    expect(within(dialogo).queryByText(new RegExp(itShared.galleryEliminaMedia))).toBeNull()
    // Le uniche due cose cliccabili nella colonna sono i due comandi.
    const comandi = within(screen.getByTestId('visore-comandi')).getAllByRole('button')
    expect(comandi.map((b) => b.textContent?.trim())).toEqual([itShared.mediaScarica, itShared.mediaCondividi])
  })

  it('Scarica: etichetta «chat», nome kidville-foto.jpg — il nome originale dell’allegato non entra nel file', async () => {
    render(chat([fotoA()], 'staff'))
    fireEvent.click(miniature()[0])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: itShared.mediaScarica }))
    })

    expect(h.scaricaMedia).toHaveBeenCalledTimes(1)
    const chiamata = h.scaricaMedia.mock.calls[0][0]
    expect(chiamata).toMatchObject({ url: URL_A, tipo: 'foto', etichetta: 'chat', nomeFile: 'kidville-foto.jpg' })
    expect(JSON.stringify(chiamata.nomeFile)).not.toContain('segreto')
    expect(h.condividiMedia).not.toHaveBeenCalled()
  })

  it('Condividi: il FILE, con l’id del messaggio come chiave e il titolo neutro', async () => {
    render(chat([fotoA()], 'genitore'))
    fireEvent.click(miniature()[0])
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: itShared.mediaCondividi }))
    })

    expect(h.condividiMedia).toHaveBeenCalledTimes(1)
    expect(h.condividiMedia.mock.calls[0][0]).toMatchObject({
      url: URL_A,
      tipo: 'foto',
      etichetta: 'chat',
      chiave: 'm-a',
      nomeFile: 'kidville-foto.jpg',
      titolo: itShared.galleryFotoDaKidville,
    })
    expect(h.scaricaMedia).not.toHaveBeenCalled()
  })
})

describe('Chat — la firma si rinnova col visore aperto (il polling rifirma ogni 30 s)', () => {
  it('l’URL rifirmato non ricarica l’immagine ma arriva a Scarica', async () => {
    const URL_A_NUOVO = 'https://firmato.test/storage/v1/object/sign/chat-allegati/th-1/aaaa-nome-originale-segreto.jpg?token=a2'
    const a = fotoA()
    const { rerender } = render(chat([a, fotoB()], 'staff'))
    fireEvent.click(miniature()[0])
    const immagine = () => within(screen.getByRole('dialog')).getByAltText(itChat.attachmentAlt) as HTMLImageElement
    const nodo = immagine()
    expect(nodo.getAttribute('src')).toBe(URL_A)

    // Dieci minuti dopo: stesso messaggio, stesso id, indirizzo nuovo.
    rerender(chat([{ ...a, attachment_url: URL_A_NUOVO }, fotoB()], 'staff'))

    expect(immagine().getAttribute('src'), 'l’immagine a schermo si è ricaricata con l’indirizzo nuovo').toBe(URL_A)
    expect(immagine(), 'l’<img> è stato rimontato').toBe(nodo)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: itShared.mediaScarica }))
    })
    expect(h.scaricaMedia).toHaveBeenCalledTimes(1)
    expect(h.scaricaMedia.mock.calls[0][0].url, 'Scarica ha usato l’indirizzo scaduto').toBe(URL_A_NUOVO)
  })

  it('Condividi usa l’indirizzo più recente, e la chiave resta l’id del messaggio', async () => {
    const URL_A_NUOVO = `${URL_A}&ancora=1`
    const a = fotoA()
    const { rerender } = render(chat([a], 'genitore'))
    fireEvent.click(miniature()[0])
    rerender(chat([{ ...a, attachment_url: URL_A_NUOVO }], 'genitore'))

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: itShared.mediaCondividi }))
    })
    expect(h.condividiMedia.mock.calls[0][0]).toMatchObject({ url: URL_A_NUOVO, chiave: 'm-a' })
  })

  it('chiuso e riaperto, il visore riparte dall’indirizzo vivo (quello congelato si rilascia alla chiusura)', () => {
    const URL_A_NUOVO = `${URL_A}&ancora=3`
    const a = fotoA()
    const { rerender } = render(chat([a]))
    fireEvent.click(miniature()[0])
    rerender(chat([{ ...a, attachment_url: URL_A_NUOVO }]))
    fireEvent.click(screen.getByText('✕'))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(miniature()[0])
    expect(within(screen.getByRole('dialog')).getByAltText(itChat.attachmentAlt).getAttribute('src')).toBe(URL_A_NUOVO)
  })

  it('cambiando foto, la nuova foto parte dal SUO indirizzo più recente (non da uno congelato prima)', () => {
    const URL_B_NUOVO = `${URL_B}&ancora=2`
    const a = fotoA()
    const b = fotoB()
    const { rerender } = render(chat([a, b]))
    fireEvent.click(miniature()[0])

    // Mentre si guarda A, il polling rifirma B: quando ci si arriva, si deve vedere l'indirizzo vivo.
    rerender(chat([a, { ...b, attachment_url: URL_B_NUOVO }]))
    fireEvent.click(screen.getByTitle(itShared.mediaSuccessiva))
    expect(within(screen.getByRole('dialog')).getByAltText(itChat.attachmentAlt).getAttribute('src')).toBe(URL_B_NUOVO)
  })
})

describe('Chat — il messaggio sparisce o la conversazione cambia: il visore si chiude e non riapre', () => {
  it('il messaggio sparisce dalla lista: il visore si chiude', () => {
    const [a, b] = [fotoA(), fotoB()]
    const { rerender } = render(chat([a, b]))
    fireEvent.click(miniature()[0])
    expect(screen.getByRole('dialog')).toBeTruthy()

    rerender(chat([b]))
    expect(screen.queryByRole('dialog')).toBeNull()

    // Se l'id ritorna (la lista si ricarica) il visore NON deve riaprirsi da solo.
    rerender(chat([a, b]))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(miniature()).toHaveLength(2)
  })

  it('la conversazione si ricarica (spinner, lista vuota): il visore si chiude e non riapre al ritorno', () => {
    const messaggi = [fotoA(), fotoB()]
    const { rerender } = render(chat(messaggi))
    fireEvent.click(miniature()[0])
    expect(screen.getByRole('dialog')).toBeTruthy()

    rerender(<ChatMessageArea messages={[]} currentUserId="gen-1" otherUserName="Maestra" loading azioniFoto="genitore" />)
    expect(screen.queryByRole('dialog')).toBeNull()

    rerender(chat(messaggi))
    expect(screen.queryByRole('dialog'), 'il visore è riapparso quando i messaggi sono tornati').toBeNull()
  })

  it('chiuso il visore per sparizione, il tasto Indietro torna a navigare (l’overlay esce dal registro)', () => {
    const [a, b] = [fotoA(), fotoB()]
    const { rerender } = render(chat([a, b]))
    fireEvent.click(miniature()[0])
    rerender(chat([b]))
    expect(premiIndietro(), 'un visore sparito tiene ancora il tasto Indietro').toBe(false)
  })
})

describe('Chat — due ChatMessageArea montate insieme (desktop + mobile)', () => {
  it('il tocco nella prima apre un dialog solo, e Indietro lo chiude senza toccare altro', () => {
    const messaggi = [fotoA(), fotoB()]
    render(
      <>
        <div data-testid="desktop">{chat(messaggi)}</div>
        <div data-testid="mobile">{chat(messaggi)}</div>
      </>,
    )
    expect(screen.getAllByRole('button', { name: APRI })).toHaveLength(4)

    fireEvent.click(within(screen.getByTestId('desktop')).getAllByRole('button', { name: APRI })[0])
    expect(screen.getAllByRole('dialog'), 'un tocco ha aperto più di un visore').toHaveLength(1)

    expect(premiIndietro(), 'il visore non si è iscritto al tasto Indietro').toBe(true)
    expect(screen.queryAllByRole('dialog')).toHaveLength(0)
    expect(premiIndietro(), 'Indietro ha chiuso due overlay: ce n’era uno solo').toBe(false)
  })

  it('aperto nell’istanza mobile, l’istanza desktop resta chiusa', () => {
    const messaggi = [fotoA()]
    render(
      <>
        <div data-testid="desktop">{chat(messaggi)}</div>
        <div data-testid="mobile">{chat(messaggi)}</div>
      </>,
    )
    fireEvent.click(within(screen.getByTestId('mobile')).getByRole('button', { name: APRI }))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    // Un solo registro di overlay: un Indietro lo chiude, il secondo non trova niente.
    expect(premiIndietro()).toBe(true)
    expect(premiIndietro()).toBe(false)
  })
})

describe('Chat — fuori dalla conversazione a schermo intero (z-[60])', () => {
  it('il visore sta fuori dal contenitore fixed z-[60] della conversazione mobile', () => {
    render(
      <div data-testid="conversazione" className="fixed inset-0 z-[60]">
        {chat([fotoA()])}
      </div>,
    )
    fireEvent.click(miniature()[0])
    expect(screen.getByTestId('conversazione').contains(screen.getByRole('dialog'))).toBe(false)
    expect(screen.getByRole('dialog').parentElement).toBe(document.body)
  })
})

describe('VisoreFotoChat — la supervisione (azioni="vigilanza")', () => {
  const messaggi = [fotoA(), fotoB()]

  function Arnese({ onScaricaVigilanza }: { onScaricaVigilanza?: (id: string) => Promise<void> }) {
    const [id, setId] = useState<string | null>('m-a')
    return (
      <VisoreFotoChat
        messaggi={messaggi}
        apertoId={id}
        onCambia={setId}
        onChiudi={() => setId(null)}
        azioni="vigilanza"
        onScaricaVigilanza={onScaricaVigilanza}
      />
    )
  }

  it('solo Scarica, che passa da onScaricaVigilanza con l’id del messaggio e non scarica da sé', async () => {
    const onScaricaVigilanza = vi.fn().mockResolvedValue(undefined)
    render(<Arnese onScaricaVigilanza={onScaricaVigilanza} />)

    expect(screen.queryByRole('button', { name: itShared.mediaCondividi })).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: itShared.mediaScarica }))
    })

    expect(onScaricaVigilanza).toHaveBeenCalledTimes(1)
    expect(onScaricaVigilanza).toHaveBeenCalledWith('m-a')
    expect(h.scaricaMedia, 'uno scarico NON registrato è partito dalla supervisione').not.toHaveBeenCalled()
  })

  it('l’hook è chiamato con l’etichetta «chat-vigilanza»', () => {
    render(<Arnese onScaricaVigilanza={vi.fn().mockResolvedValue(undefined)} />)
    expect(vi.mocked(useAzioniMedia)).toHaveBeenCalledWith({ etichetta: 'chat-vigilanza' })
    expect(vi.mocked(useAzioniMedia)).not.toHaveBeenCalledWith({ etichetta: 'chat' })
  })

  it('senza onScaricaVigilanza Scarica non c’è: dalla supervisione non si scarica mai fuori dal registro', () => {
    render(<Arnese />)
    expect(screen.getByRole('dialog', { name: NOME_DIALOGO(1, 2) })).toBeTruthy()
    expect(screen.queryByRole('button', { name: itShared.mediaScarica })).toBeNull()
    expect(screen.queryByRole('button', { name: itShared.mediaCondividi })).toBeNull()
  })

  it('genitore e staff chiamano l’hook con l’etichetta «chat»', () => {
    render(chat([fotoA()], 'staff'))
    expect(vi.mocked(useAzioniMedia)).toHaveBeenCalledWith({ etichetta: 'chat' })
    expect(vi.mocked(useAzioniMedia)).not.toHaveBeenCalledWith({ etichetta: 'chat-vigilanza' })
  })
})
