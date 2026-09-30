import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useEffect, useState } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import itAdminComunicazioni from '../../messages/it/adminComunicazioni.json'
import enAdminComunicazioni from '../../messages/en/adminComunicazioni.json'

/**
 * «Maestre che non ricevono le notifiche» — la scheda della Direzione (C2).
 *
 * Il difetto che sta dietro: una maestra su Android ha ricevuto 137 messaggi in
 * 30 giorni senza una sola notifica, e non lo sapeva nessuno. Qui si collauda la
 * parte che la Direzione legge — compresi i due stati in cui una schermata mente
 * più facilmente: il VUOTO («tutte ricevono le notifiche») e l'ERRORE, che senza
 * un messaggio è indistinguibile dal vuoto.
 */

const h = vi.hoisted(() => ({ fetchMock: vi.fn(), logClient: vi.fn() }))

vi.mock('@/lib/logging/client', () => ({
  logClient: h.logClient,
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'sconosciuto'),
}))

import { DocentiSenzaNotifiche } from '@/components/features/admin/messaggi/DocentiSenzaNotifiche'

const ELENCO = [
  { id: 'd1', nome: 'Greco Fiora', ricevuti30g: 137, nonLetti: 12 },
  { id: 'd2', nome: 'Bianchi Anna', ricevuti30g: 3, nonLetti: 0 },
]

const risposta = (corpo: unknown, ok = true, status = 200) =>
  Promise.resolve({ ok, status, json: async () => corpo } as Response)

beforeEach(() => {
  vi.clearAllMocks()
  h.fetchMock.mockImplementation(() =>
    risposta({ success: true, data: ELENCO, totale: 2, docentiTotali: 12, giorni: 30 }),
  )
  vi.stubGlobal('fetch', h.fetchMock)
})

describe('DocentiSenzaNotifiche', () => {
  it('chiede l\'elenco alla propria route, e con il limite alto', async () => {
    render(<DocentiSenzaNotifiche />)
    await waitFor(() =>
      expect(h.fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/admin/chat/docenti-senza-push')),
    )
    // Il default della route è 100: senza `limite`, «240 maestre su 600» starebbe
    // sopra una tabella di cento righe, e la differenza non la spiegherebbe
    // nessuno.
    expect(String(h.fetchMock.mock.calls[0][0])).toContain('limite=500')
  })

  it('UNA sola richiesta per apertura, anche se `t` cambia a ogni render', async () => {
    // ⚠️ Ogni richiesta di questa scheda scrive righe nel registro di vigilanza
    // — una per sede. Con `t` fra le dipendenze dell'effetto, e `useTranslations`
    // che non promette un'identità stabile, la richiesta riparte a ogni render:
    // il revisore ne ha contate 33.934 in venti secondi. Qui si rende il caso
    // ESPLICITO — un padre che si ri-renderizza da solo — e si conta.
    function Padre() {
      const [n, setN] = useState(0)
      useEffect(() => {
        if (n < 5) setN(n + 1)
      }, [n])
      return <DocentiSenzaNotifiche key="fissa" data-giro={n} />
    }
    render(<Padre />)
    await screen.findByText('Greco Fiora')
    await waitFor(() => expect(h.fetchMock).toHaveBeenCalled())
    expect(h.fetchMock.mock.calls).toHaveLength(1)
  })

  it('200 con `success: false`: lo dice, e non mostra lo stato vuoto', async () => {
    // Una risposta che non ha detto no e non ha detto sì. Senza il suo ramo la
    // scheda mostrerebbe «tutte hanno almeno un dispositivo» su una risposta che
    // non l'ha mai affermato.
    h.fetchMock.mockImplementation(() => risposta({ success: false }))
    render(<DocentiSenzaNotifiche />)
    expect(await screen.findByRole('alert')).toHaveTextContent(itAdminComunicazioni.docentiSenzaPushErrore)
    expect(screen.queryByText(itAdminComunicazioni.docentiSenzaPushVuoto)).not.toBeInTheDocument()
  })

  it('il caricamento si annuncia (`role="status"`)', () => {
    h.fetchMock.mockImplementation(() => new Promise(() => {}))
    render(<DocentiSenzaNotifiche />)
    expect(screen.getByRole('status')).toHaveTextContent(itAdminComunicazioni.caricamento)
  })

  it('mostra nome, messaggi dei genitori e non letti di ogni maestra', async () => {
    render(<DocentiSenzaNotifiche />)
    expect(await screen.findByText('Greco Fiora')).toBeInTheDocument()
    const riga = screen.getByText('Greco Fiora').closest('tr') as HTMLElement
    expect(within(riga).getByText('137')).toBeInTheDocument()
    expect(within(riga).getByText('12')).toBeInTheDocument()
    expect(screen.getByText('Bianchi Anna')).toBeInTheDocument()
  })

  it('dice quante sono, e su quante', async () => {
    render(<DocentiSenzaNotifiche />)
    // ICU: «2 maestre su 12 non ricevono le notifiche».
    expect(await screen.findByText(/2 maestre su 12/)).toBeInTheDocument()
  })

  it('il numero è il TOTALE della route, non le righe della pagina', async () => {
    // La route pagina a 100: con `righe.length` la frase direbbe «100 maestre su
    // 240» alla centunesima, cioè un numero sbagliato proprio nel caso in cui
    // serve sapere quante sono. Qui la pagina ne porta due e il totale è cinque.
    h.fetchMock.mockImplementation(() =>
      risposta({ success: true, data: ELENCO, totale: 5, docentiTotali: 12, giorni: 30 }),
    )
    render(<DocentiSenzaNotifiche />)
    expect(await screen.findByText(/5 maestre su 12/)).toBeInTheDocument()
  })

  it('spiega cosa significa e cosa fare: non lascia un elenco di nomi senza contesto', async () => {
    render(<DocentiSenzaNotifiche />)
    await screen.findByText('Greco Fiora')
    expect(screen.getByText(itAdminComunicazioni.docentiSenzaPushSottotitolo)).toBeInTheDocument()
    expect(screen.getByText(itAdminComunicazioni.docentiSenzaPushNota)).toBeInTheDocument()
  })

  it('la nota manda al TELEFONO, e non promette un pulsante sul web', async () => {
    // ⚠️ Segue il passo 7, che è cambiato per una ragione di privacy: sul web
    // l'avviso alla maestra NON offre più l'attivazione, perché il logout web
    // non annulla l'iscrizione e su un PC condiviso le notifiche arriverebbero a
    // chi si siede dopo. La nota qui diceva «con il pulsante per attivarle»:
    // avrebbe mandato la Direzione a cercare, sullo schermo della maestra, un
    // pulsante che non esiste più — e a concludere che è un guasto.
    const nota = itAdminComunicazioni.docentiSenzaPushNota
    expect(nota).toMatch(/app sul telefono/i)
    expect(nota).not.toMatch(/con il pulsante/i)
    render(<DocentiSenzaNotifiche />)
    await screen.findByText('Greco Fiora')
    expect(screen.getByText(nota)).toBeInTheDocument()
  })

  it('la tabella ha intestazioni vere (non celle grassettate)', async () => {
    render(<DocentiSenzaNotifiche />)
    await screen.findByText('Greco Fiora')
    const intestazioni = screen.getAllByRole('columnheader')
    expect(intestazioni).toHaveLength(3)
    expect(intestazioni[0]).toHaveTextContent(itAdminComunicazioni.docentiSenzaPushColChi)
    // La finestra dei 30 giorni è detta NELL'intestazione dei ricevuti, non
    // lasciata implicita…
    expect(intestazioni[1]).toHaveTextContent(/30 giorni/)
    // …e la colonna dei non letti dice che periodo NON ha: l'arretrato non
    // scade, e due colonne accostate senza dirlo si leggono come omogenee.
    expect(intestazioni[2]).toHaveTextContent(/in tutto/i)
    expect(intestazioni[2].textContent ?? '').not.toMatch(/giorni/i)
  })

  it('in caricamento non dice «tutte ricevono le notifiche»', () => {
    h.fetchMock.mockImplementation(() => new Promise(() => {}))
    render(<DocentiSenzaNotifiche />)
    expect(screen.getByText(itAdminComunicazioni.caricamento)).toBeInTheDocument()
    expect(screen.queryByText(itAdminComunicazioni.docentiSenzaPushVuoto)).not.toBeInTheDocument()
  })

  it('elenco vuoto: dice che TUTTE hanno un dispositivo, non che le notifiche arrivano', async () => {
    // ⚠️ La frase non promette la RICEZIONE. Una riga in `push_subscriptions`
    // dice che un dispositivo è REGISTRATO: il permesso può essere stato
    // revocato dopo, il token può essere scaduto. «Tutte le maestre ricevono le
    // notifiche» sarebbe il difetto al rovescio — rassicurare senza sapere.
    h.fetchMock.mockImplementation(() =>
      risposta({ success: true, data: [], totale: 0, docentiTotali: 12, giorni: 30 }),
    )
    render(<DocentiSenzaNotifiche />)
    // ⚠️ L'asserzione è sul PARAGRAFO del vuoto, non sulla pagina: il titolo
    // della scheda contiene «non ricevono le notifiche», ed è giusto che lo
    // contenga — cercare quella frase a pagina intera pescherebbe lui.
    const vuoto = await screen.findByText(itAdminComunicazioni.docentiSenzaPushVuoto)
    expect(vuoto).toHaveTextContent(/dispositivo registrato/i)
    expect(vuoto.textContent ?? '').not.toMatch(/ricev(e|ono) le notifiche/i)
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('NESSUNA maestra nel perimetro: frase diversa da «tutte hanno un dispositivo»', async () => {
    // I due vuoti non sono lo stesso vuoto: «tutte a posto» detto di una sede
    // senza maestre rassicura su una verifica che nessuno ha fatto.
    h.fetchMock.mockImplementation(() =>
      risposta({ success: true, data: [], totale: 0, docentiTotali: 0, giorni: 30 }),
    )
    render(<DocentiSenzaNotifiche />)
    expect(await screen.findByText(itAdminComunicazioni.docentiSenzaPushNessunaDocente)).toBeInTheDocument()
    expect(screen.queryByText(itAdminComunicazioni.docentiSenzaPushVuoto)).not.toBeInTheDocument()
  })

  it('errore del server: mostra il messaggio del CODICE, tradotto, non un elenco vuoto', async () => {
    h.fetchMock.mockImplementation(() =>
      risposta({ error: "L'elenco non si è potuto leggere.", codice: 'LETTURA_FALLITA' }, false, 500),
    )
    render(<DocentiSenzaNotifiche />)
    const avviso = await screen.findByRole('alert')
    // `shared.erroreLetturaFallita`, cioè il catalogo: non la prosa del server.
    expect(avviso).toHaveTextContent('Non siamo riusciti a leggere i dati. Riprova fra poco.')
    expect(screen.queryByText(itAdminComunicazioni.docentiSenzaPushVuoto)).not.toBeInTheDocument()
  })

  it('503 «non tracciabile»: mostra ESATTAMENTE la frase di questa scheda', async () => {
    // Non una frase qualunque: né la prosa del server, né quella generica di
    // `LETTURA_FALLITA`, né quella del catalogo condiviso
    // (`shared.erroreVigilanzaNonTracciabile`), che finisce con «e per questo la
    // conversazione non è stata aperta» — qui nessuno stava aprendo una
    // conversazione, e chi legge andrebbe a cercare un problema che non c'è.
    h.fetchMock.mockImplementation(() =>
      risposta({ error: 'non registrata', codice: 'VIGILANZA_NON_TRACCIABILE' }, false, 503),
    )
    render(<DocentiSenzaNotifiche />)
    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(itAdminComunicazioni.docentiSenzaPushNonTracciabile)
    expect(avviso.textContent ?? '').not.toContain('non registrata')
    expect(avviso.textContent ?? '').not.toContain('conversazione')
    expect(avviso).not.toHaveTextContent(itAdminComunicazioni.docentiSenzaPushErrore)
  })

  it('guasto di rete: un avviso a schermo E una riga di log (mai un catch muto)', async () => {
    h.fetchMock.mockImplementation(() => Promise.reject(new TypeError('rete')))
    render(<DocentiSenzaNotifiche />)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(h.logClient).toHaveBeenCalledWith(
      expect.objectContaining({ livello: 'error', evento: 'fetch' }),
    )
  })

  it('le chiavi usate esistono in entrambi i cataloghi', () => {
    for (const k of [
      'messaggiTabNotificheDocenti', 'docentiSenzaPushTitolo', 'docentiSenzaPushSottotitolo',
      'docentiSenzaPushNota', 'docentiSenzaPushConteggio', 'docentiSenzaPushVuoto',
      'docentiSenzaPushErrore', 'docentiSenzaPushColChi', 'docentiSenzaPushColRicevuti',
      'docentiSenzaPushColNonLetti', 'docentiSenzaPushNessunaDocente',
      'docentiSenzaPushNonTracciabile',
    ]) {
      expect(itAdminComunicazioni, `manca in it: ${k}`).toHaveProperty(k)
      expect(enAdminComunicazioni, `manca in en: ${k}`).toHaveProperty(k)
    }
  })
})
