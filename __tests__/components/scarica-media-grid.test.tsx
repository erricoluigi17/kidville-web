import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'

/**
 * I DUE PULSANTI DELLA GALLERIA DEVONO ESSERE LO STESSO PULSANTE.
 *
 * ─── IL DIFETTO ──────────────────────────────────────────────────────────────
 * «Scarica» e «Condividi» erano scritti DUE VOLTE in `MediaGrid`: una sulla card
 * e una nel visore. Le due copie erano già divergenti — quella della card non
 * aveva nemmeno un `logClient` — e questo è il motivo per cui in trenta giorni
 * di `app_log` esiste UNA sola riga sullo scarico, e viene dal visore.
 *
 * Questo file blocca ciò che rende il difetto irripetibile:
 *  1. i due punti chiamano la STESSA funzione, con lo STESSO argomento;
 *  2. l'esito finisce sempre in `app_log` — successo compreso, perché senza
 *     «nessun log» non distingue «tutto ok» da «non è mai partito niente»;
 *  3. il nome del file ha un'estensione (prima era la didascalia nuda).
 */

// I doppi sono TIPIZZATI: senza gli argomenti dichiarati, `mock.calls[0][0]` è
// una tupla vuota per TypeScript e il gate `tsc --noEmit` cade — cioè il lock
// più importante di questo file non compilerebbe nemmeno.
const scaricaMock = vi.hoisted(() =>
  vi.fn<(input: { url: string; nomeFile: string; titolo?: string }) => Promise<{ esito: string; motivo?: string }>>(),
)
const condividiLinkMock = vi.hoisted(() =>
  vi.fn<(input: { url?: string; title?: string; text?: string }) => Promise<string>>(),
)
const logClientMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/native/scarica', async () => {
  // `nomeFileScarico` NON si finge: il nome del file è metà della correzione, e
  // un doppio finto lo direbbe giusto qualunque cosa faccia il vero.
  const vero = await vi.importActual<typeof import('@/lib/native/scarica')>('@/lib/native/scarica')
  return { ...vero, scarica: scaricaMock }
})
vi.mock('@/lib/native/share', () => ({ condividiLink: condividiLinkMock }))
vi.mock('@/lib/logging/client', () => ({ logClient: logClientMock, nomeErrore: () => 'Error' }))
vi.mock('@/components/features/segnalazioni/SegnalaContenuto', () => ({
  SegnalaContenuto: () => null,
}))

/** next-intl con il catalogo VERO: le etichette devono esistere davvero. */
vi.mock('next-intl', async () => {
  const shared = (await import('../../messages/it/shared.json')).default as Record<string, string>
  const useTranslations = () => {
    const t = (chiave: string) => shared[chiave] ?? chiave
    return Object.assign(t, { rich: t, markup: t, raw: t, has: () => true })
  }
  return { useTranslations }
})

import { MediaGrid, type MediaItem } from '@/components/features/gallery/MediaGrid'

const URL_FIRMATO =
  'https://esempio.supabase.co/storage/v1/object/sign/gallery/uploads/abc/foto.jpg?token=xyz'

const VOCE: MediaItem = {
  id: 'm1',
  file_url: URL_FIRMATO,
  file_type: 'foto',
  // Didascalia di fantasia: in questo repo non entrano nomi veri di bambini.
  caption: 'Laboratorio dei colori',
  tag_students: [],
  is_broadcast: false,
  created_at: new Date().toISOString(),
  uploader_name: 'Insegnante',
}

describe('MediaGrid — lo scarico lato genitore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    scaricaMock.mockResolvedValue({ esito: 'web-blob' })
    condividiLinkMock.mockResolvedValue('foglio')
    vi.spyOn(window, 'alert').mockImplementation(() => {})
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('la card e il visore chiamano la STESSA funzione con lo STESSO argomento', async () => {
    render(<MediaGrid items={[VOCE]} showActions />)

    // 1) Il pulsante sulla card (si distingue per il `title`, prima che il
    //    visore esista: dopo ce ne sarebbero due con lo stesso nome).
    const sullaCard = screen.getByTitle('Scarica')
    fireEvent.click(sullaCard)
    await waitFor(() => expect(scaricaMock).toHaveBeenCalledTimes(1))

    // 2) Si apre il visore e si preme il suo «Scarica», che è un ALTRO elemento.
    fireEvent.click(screen.getByAltText('Laboratorio dei colori'))
    const tutti = await screen.findAllByRole('button', { name: 'Scarica' })
    const nelVisore = tutti.find((b) => b !== sullaCard)
    expect(nelVisore).toBeDefined()
    fireEvent.click(nelVisore!)
    await waitFor(() => expect(scaricaMock).toHaveBeenCalledTimes(2))

    // È il lock: due punti, un solo comportamento.
    expect(scaricaMock.mock.calls[1][0]).toEqual(scaricaMock.mock.calls[0][0])
  })

  it('il file scaricato ha un nome CON estensione (prima era la didascalia nuda)', async () => {
    render(<MediaGrid items={[VOCE]} showActions />)

    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(scaricaMock).toHaveBeenCalledTimes(1))

    expect(scaricaMock.mock.calls[0][0]).toEqual({
      url: URL_FIRMATO,
      nomeFile: 'Laboratorio dei colori.jpg',
      titolo: 'Laboratorio dei colori',
    })
  })

  it('anche il SUCCESSO lascia una riga: senza, il silenzio sembra salute', async () => {
    render(<MediaGrid items={[VOCE]} showActions />)

    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(logClientMock).toHaveBeenCalledTimes(1))

    // ⚠️ NESSUN campo `route`, ed è la parte che questa asserzione custodisce.
    // Fino al 2026-09-06 queste righe dichiaravano `route: '/gallery'`, una pagina che
    // NON ESISTE: `MediaGrid` è montata su `/parent/gallery`, `/parent/diary`,
    // `/teacher/gallery` e `/admin/gallery`, e nessuna delle quattro si chiama così.
    // `logClient` il luogo se lo legge da sé (`e.route || pagina()`, cioè
    // `location.pathname` già redatto): passare una costante SOPPRIMEVA il luogo vero e
    // rendeva indistinguibili in `app_log` quattro superfici diverse. `toHaveBeenCalledWith`
    // pretende l'oggetto ESATTO, quindi se qualcuno rimette il campo questo test diventa
    // rosso — che è il motivo per cui l'asserzione è scritta così e non con
    // `objectContaining`.
    expect(logClientMock).toHaveBeenCalledWith({
      livello: 'warn',
      evento: 'fetch',
      messaggio: 'gallery-scarico-riuscito:web-blob',
    })
  })

  it('il ripiego si legge nel log, COL MOTIVO (la riga di ieri non lo aveva)', async () => {
    scaricaMock.mockResolvedValue({
      esito: 'ripiego-condivisione',
      motivo: 'plugin-filesystem-assente',
    })
    const avviso = vi.spyOn(window, 'alert').mockImplementation(() => {})
    render(<MediaGrid items={[VOCE]} showActions />)

    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(logClientMock).toHaveBeenCalledTimes(1))

    expect(logClientMock.mock.calls[0][0]).toMatchObject({
      livello: 'warn',
      messaggio: 'gallery-scarico-ripiego-condivisione: plugin-filesystem-assente',
    })
    // E QUI NON SI AVVISA: il foglio di sistema si è aperto, l'utente lo sta
    // guardando. Un popup sopra un foglio già visibile è un secondo gesto che
    // nessuno ha chiesto — la metà «negativa» del lock qui sotto, senza la quale
    // «avvisa sempre» passerebbe verde.
    expect(avviso).not.toHaveBeenCalled()
  })

  it('lo scarico finito NEGLI APPUNTI avvisa: una copia muta si legge come un pulsante rotto', async () => {
    // È il ramo del genitore su Firefox desktop (niente Web Share API) con
    // l'indirizzo firmato scaduto: `scarica` ripiega, il link finisce negli
    // appunti, e sullo schermo non cambia niente. Ha premuto «Scarica» e non ha
    // il file: senza questo avviso il pulsante torna a sembrare rotto.
    scaricaMock.mockResolvedValue({ esito: 'ripiego-appunti', motivo: 'http-403' })
    const avviso = vi.spyOn(window, 'alert').mockImplementation(() => {})
    render(<MediaGrid items={[VOCE]} showActions />)

    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(avviso).toHaveBeenCalledTimes(1))

    // Il testo viene dal catalogo VERO (`messages/it/shared.json`): una chiave
    // inventata qui direbbe «avvisato» mostrando il nome della chiave.
    expect(avviso).toHaveBeenCalledWith('Link copiato negli appunti!')
    // E il ripiego resta un TOKEN SUO in `app_log`: contarlo insieme al foglio
    // nasconderebbe proprio il ramo che si è dovuto rendere parlante.
    expect(logClientMock.mock.calls[0][0]).toMatchObject({
      livello: 'warn',
      messaggio: 'gallery-scarico-ripiego-appunti: http-403',
    })
  })

  it('quando l’utente non ottiene NIENTE il livello è `error`, e lo stato http sta nel messaggio', async () => {
    scaricaMock.mockResolvedValue({
      esito: 'non-riuscito',
      motivo: 'http-403|condivisione-non-riuscita',
    })
    render(<MediaGrid items={[VOCE]} showActions />)

    fireEvent.click(screen.getByTitle('Scarica'))
    await waitFor(() => expect(logClientMock).toHaveBeenCalledTimes(1))

    const evento = logClientMock.mock.calls[0][0]
    expect(evento).toMatchObject({
      livello: 'error',
      messaggio: 'gallery-scarico-non-riuscito: http-403|condivisione-non-riuscita',
    })
    // Lo `stato` NON si dichiara: `livelloEvento()` applicherebbe la politica di
    // `livelloFetch`, che per un 403 risponde «non spedire» — e la riga appena
    // aggiunta verrebbe scartata in silenzio, che è il difetto di partenza.
    expect(evento).not.toHaveProperty('stato')
  })

  it('la pressione scartata perché uno scarico è già in corso lascia una riga', async () => {
    /**
     * «UNO SCARICO ALLA VOLTA» NON PUÒ ESSERE UN `return` MUTO.
     *
     * `scarica()` non lancia mai, ma può NON RISOLVERE: la `fetch` verso
     * l'indirizzo firmato è cross-origin e nella WebView può accettare e tacere —
     * è la riga di produzione del 2026-09-05 con `stato_http = 0`. Qui la si
     * riproduce con una promessa appesa: da quel momento il `finally` non gira
     * mai, il ref resta alzato per tutta la vita della pagina e OGNI pressione
     * successiva esce dalla guardia. Senza la riga di log, «pulsante incagliato»
     * e «nessuno l'ha mai premuto» sarebbero lo stesso silenzio in `app_log`.
     */
    scaricaMock.mockReturnValue(new Promise<{ esito: string }>(() => {}))
    render(<MediaGrid items={[VOCE]} showActions />)

    const bottone = screen.getByTitle('Scarica')
    fireEvent.click(bottone)
    fireEvent.click(bottone)

    await waitFor(() => expect(logClientMock).toHaveBeenCalledTimes(1))
    // La guardia ha tenuto: `scarica` è partita UNA volta sola…
    expect(scaricaMock).toHaveBeenCalledTimes(1)
    // …e l'unica riga in tabella è quella della pressione scartata, perché la
    // prima non è mai arrivata a un esito.
    // Anche qui senza `route`: vedi la ragione per esteso nel test del successo.
    expect(logClientMock).toHaveBeenCalledWith({
      livello: 'warn',
      evento: 'fetch',
      messaggio: 'gallery-scarico-gia-in-corso',
    })
  })

  it('la condivisione passa dal modulo nativo, non da `navigator.share` riscritto a mano', async () => {
    render(<MediaGrid items={[VOCE]} showActions />)

    fireEvent.click(screen.getByTitle('Condividi'))
    await waitFor(() => expect(condividiLinkMock).toHaveBeenCalledTimes(1))

    expect(condividiLinkMock).toHaveBeenCalledWith({
      url: URL_FIRMATO,
      title: 'Laboratorio dei colori',
    })
  })

  it('la copia negli appunti è muta: si avvisa l’utente, altrimenti sembra rotto', async () => {
    condividiLinkMock.mockResolvedValueOnce('appunti')
    const avviso = vi.spyOn(window, 'alert').mockImplementation(() => {})
    render(<MediaGrid items={[VOCE]} showActions />)

    fireEvent.click(screen.getByTitle('Condividi'))
    await waitFor(() => expect(avviso).toHaveBeenCalledTimes(1))
  })
})
