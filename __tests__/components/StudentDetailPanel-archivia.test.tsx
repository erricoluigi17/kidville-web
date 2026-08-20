import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'

/**
 * IL PULSANTE CHE FALLIVA, E IL MESSAGGIO CHE NESSUNO LEGGEVA.
 *
 * ─── I DUE FATTI, misurati il 2026-08-12 ────────────────────────────────────
 *
 *  1. «Elimina Alunno (GDPR)» chiamava `DELETE /api/admin/students` e per **28
 *     alunni su 33** riceveva un 409: `alunni` ha sette foreign key senza
 *     `ON DELETE CASCADE`, e quasi ogni bambino ha pagamenti e un genitore
 *     collegato. Tre tentativi veri, alle 11:17:24 / 11:17:53 / 11:18:07 UTC,
 *     tutti respinti.
 *  2. Il motivo del rifiuto — «l'alunno ha ancora dati collegati» — il server lo
 *     mandava, e il client **non leggeva mai `res.json()`**: a schermo compariva
 *     `❌ Errore nell'eliminazione`, e 900 ms dopo `flash` faceva `router.push`
 *     verso la lista. L'operatore veniva portato via dalla scheda con in mano un
 *     errore senza causa e senza niente da fare.
 *
 * Il primo fatto lo chiude l'archiviazione (reversibile, nessuna FK toccata). Il
 * secondo lo chiude questo file, e §2 è il suo cuore: **sul fallimento non si
 * naviga**. È la stessa correzione già fatta sul ramo dei genitori
 * (`handleSaveParent`) e mai propagata a questo — per questo si misura sulla
 * PAGINA vera, non su una funzione finta: è la pagina che possiede il router.
 */

const IDENTITA_ALUNNO = {
  id: 'alu-1',
  nome: 'Aurora',
  cognome: 'Verdi',
  scuola_id: 'sc-1',
  classe_sezione: '3 ANNI',
  stato: 'iscritto',
}

vi.mock('@/lib/auth/current-teacher', () => ({ getCurrentTeacherId: () => null }))
// La sezione economica fa fetch per conto suo e non c'entra con l'archiviazione.
vi.mock('@/components/features/admin/StudentEconomicSection', () => ({
  StudentEconomicSection: () => null,
}))

const nav = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'alu-1' }),
  useRouter: () => ({ push: nav.push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/admin/students/alu-1',
}))

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  fetchMock.mockImplementation((url: string) => {
    if (String(url).startsWith('/api/admin/students/alu-1')) {
      return Promise.resolve({ ok: true, json: async () => IDENTITA_ALUNNO })
    }
    return Promise.resolve({ ok: true, json: async () => [] })
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

import { StudentDetailPanel } from '@/components/features/admin/StudentDetailPanel'
import AnagraficaDetailPage from '@/app/(dashboard)/admin/students/[id]/page'
import catalogoIt from '../../messages/it/adminStudents.json'

const ETICHETTA_RIPOSO = 'Sposta fra i non iscritti'
const ETICHETTA_CONFERMA = /Conferma: sposta fra i non iscritti/

const bottoneArchivia = () =>
  screen.getByRole('button', { name: new RegExp(`(${ETICHETTA_RIPOSO}|Conferma: sposta)`) })

type Gesto = (id: string) => Promise<{ ok: boolean; errore?: string | null }>

function montaPannello(onArchive: Gesto, student: Record<string, unknown> = IDENTITA_ALUNNO, onRiattiva: Gesto = async () => ({ ok: true })) {
  return render(
    <StudentDetailPanel
      variant="page"
      student={student as never}
      onClose={() => {}}
      onSave={() => {}}
      onArchive={onArchive}
      onRiattiva={onRiattiva}
    />,
  )
}

describe('StudentDetailPanel — «Sposta fra i non iscritti»', () => {
  it('§1 il primo clic CHIEDE, il secondo FA: `onArchive` chiamato una volta sola', async () => {
    const onArchive = vi.fn(async () => ({ ok: true }))
    montaPannello(onArchive)

    // A riposo: nessun riquadro, nessuna chiamata.
    expect(screen.queryByText(/Cosa succede/)).toBeNull()
    expect(bottoneArchivia().textContent).toContain(ETICHETTA_RIPOSO)

    fireEvent.click(bottoneArchivia())

    // Primo clic: cambia il testo e compare il riquadro. NIENTE è ancora partito —
    // è tutto il senso della conferma in due tempi.
    expect(bottoneArchivia().textContent).toMatch(ETICHETTA_CONFERMA)
    expect(screen.getByText(/Cosa succede/)).toBeTruthy()
    expect(onArchive).not.toHaveBeenCalled()

    fireEvent.click(bottoneArchivia())

    await waitFor(() => expect(onArchive).toHaveBeenCalledTimes(1))
    expect(onArchive).toHaveBeenCalledWith('alu-1')
  })

  it('§1b «Annulla» riporta il bottone a riposo senza archiviare niente', async () => {
    const onArchive = vi.fn(async () => ({ ok: true }))
    montaPannello(onArchive)

    fireEvent.click(bottoneArchivia())
    fireEvent.click(screen.getByRole('button', { name: 'Annulla' }))

    expect(bottoneArchivia().textContent).toContain(ETICHETTA_RIPOSO)
    expect(screen.queryByText(/Cosa succede/)).toBeNull()
    expect(onArchive).not.toHaveBeenCalled()
  })

  it('§2a il rifiuto del server è a schermo, testualmente, dentro un `role="alert"`', async () => {
    const MOTIVO = 'Questo alunno è già fra i non più iscritti dal 3 marzo'
    const onArchive = vi.fn(async () => ({ ok: false, errore: MOTIVO }))
    montaPannello(onArchive)

    fireEvent.click(bottoneArchivia())
    fireEvent.click(bottoneArchivia())

    const avviso = await screen.findByRole('alert')
    // Il testo DEL SERVER, non una frase generica: è l'unica cosa che dice
    // all'operatore che cosa è successo e se può rimediare.
    expect(avviso.textContent).toContain(MOTIVO)
  })

  it('§2b senza `errore` nel corpo si dice comunque qualcosa (mai il silenzio del successo)', async () => {
    const onArchive = vi.fn(async () => ({ ok: false, errore: null }))
    montaPannello(onArchive)

    fireEvent.click(bottoneArchivia())
    fireEvent.click(bottoneArchivia())

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toMatch(/non è stato possibile/i)
  })

  it('§3 il riquadro dice cosa RESTA e cosa se ne VA, per esteso', async () => {
    montaPannello(vi.fn(async () => ({ ok: true })))
    fireEvent.click(bottoneArchivia())

    const riquadro = screen.getByText(/Cosa succede/).parentElement as HTMLElement
    const testo = riquadro.textContent ?? ''

    // 1. l'anagrafica resta INTATTA — è il perno del modello: senza il nome, i
    //    registri di ogni anno passato diventano illeggibili.
    expect(testo).toMatch(/anagrafica resta/i)
    expect(testo).toMatch(/codice fiscale/i)
    // 2. lo storico resta, e i due nomi che l'operatore cerca sono «presenze» e
    //    «pagamenti»: sono le due cose che il vecchio riquadro dichiarava
    //    cancellate, e che si conservano dieci anni.
    expect(testo).toMatch(/presenze/i)
    expect(testo).toMatch(/pagamenti/i)
    expect(testo).toMatch(/dieci anni/i)
    // 3. da dove esce
    expect(testo).toMatch(/appello/i)
    expect(testo).toMatch(/mensa/i)
    // 4. ⚠️ ciò che invece se ne va, ed è l'unica parte non reversibile: la
    //    retention notturna azzera il motivo dell'assenza scritto dalla famiglia
    //    entro 24 ore (`presenze-giustificazioni-retention`, 04:59 UTC).
    expect(testo).toMatch(/24 ore/i)
    expect(testo).toMatch(/motivo delle assenze/i)
    // 5. ⚠️ il GRUPPO MENSA, che `archivia` azzera e nessuna colonna ricorda,
    //    e la CLASSE, che al rientro torna solo se esiste ancora. Fino al
    //    2026-08-13 il riquadro non le diceva: prometteva «è reversibile» e la
    //    testata di `riattiva` elencava TRE cose che non tornano indietro.
    expect(testo).toMatch(/gruppo mensa/i)
    expect(testo).toMatch(/riassegnat/i)
    expect(testo).toMatch(/classe torna solo se esiste ancora/i)
    // 6. ed è reversibile — ma la frase non è più assoluta
    expect(testo).toMatch(/reversibile/i)

    // E NON dice più le due cose false del riquadro precedente.
    expect(testo).not.toMatch(/irreversibile/i)
    expect(testo).not.toMatch(/cancellerà tutti i dati/i)
  })
})

/**
 * ─── LA SCHEDA DI UN BAMBINO GIÀ ARCHIVIATO ─────────────────────────────────
 *
 * È la scheda a cui manda il bottone «Apri scheda» dell'elenco dei «non più
 * iscritti», e fino al 2026-08-13 offriva soltanto il comando sbagliato:
 * l'interfaccia `Student` non portava `archiviato_il`, il pannello non lo leggeva
 * mai (`grep -n "archiviato" StudentDetailPanel.tsx` → nessuna occorrenza), quindi
 * «Sposta fra i non iscritti» compariva sempre e — premuto — rispondeva 409 DOPO
 * che l'operatore aveva letto le promesse e confermato. Il ritorno non c'era. E
 * l'unica cosa che gli «funzionava» era la tendina «Stato», cioè la strada che
 * rimette `iscritto` senza restituire la classe e fa sparire il bambino da ogni
 * elenco per sezione.
 */
const ALUNNO_ARCHIVIATO = {
  ...IDENTITA_ALUNNO,
  stato: 'ritirato',
  classe_sezione: null,
  archiviato_il: '2026-08-01T10:00:00.000Z',
  archiviato_classe_sezione: '2 ANNI',
  spazio_liberato_il: null,
}

describe('StudentDetailPanel — la scheda di un ARCHIVIATO offre il comando giusto', () => {
  it('⚠️ non offre più «Sposta fra i non iscritti»: quel comando gli risponderebbe 409', async () => {
    montaPannello(vi.fn(async () => ({ ok: true })), ALUNNO_ARCHIVIATO)

    expect(screen.queryByRole('button', { name: new RegExp(ETICHETTA_RIPOSO) })).toBeNull()
    expect(screen.queryByText(/Cosa succede/)).toBeNull()
  })

  it('offre «Riporta fra gli iscritti», e chiama `onRiattiva` con un clic solo', async () => {
    // Niente doppio clic: questa operazione RIMETTE dentro un bambino ed è a sua
    // volta annullabile. La conferma in due tempi è per chi lo toglie.
    const onRiattiva = vi.fn(async () => ({ ok: true }))
    montaPannello(vi.fn(async () => ({ ok: true })), ALUNNO_ARCHIVIATO, onRiattiva)

    fireEvent.click(screen.getByRole('button', { name: /Riporta fra gli iscritti/ }))

    await waitFor(() => expect(onRiattiva).toHaveBeenCalledTimes(1))
    expect(onRiattiva).toHaveBeenCalledWith('alu-1')
  })

  it('dice DA QUANDO è fuori e DA QUALE classe: lo stato non è invisibile a chi preme', async () => {
    montaPannello(vi.fn(async () => ({ ok: true })), ALUNNO_ARCHIVIATO)

    // Testo ESATTO: la spiegazione della tendina spenta contiene anch'essa la
    // frase «non più iscritto», e una regex larga prenderebbe tutte e due.
    const titolo = screen.getByText('Non più iscritto')
    const riquadro = titolo.parentElement as HTMLElement
    const testo = riquadro.textContent ?? ''

    // La data è formattata secondo il locale (`01/08/2026` in italiano), quindi si
    // cerca l'anno e non la stringa ISO, che è un dettaglio di trasporto.
    expect(testo).toMatch(/Dal:/)
    expect(testo).toMatch(/2026/)
    expect(testo).not.toMatch(/Data non registrata/)
    // …e la classe da cui è uscito: senza, il ritorno è un indovinello anche per
    // chi ha la scheda davanti.
    expect(testo).toMatch(/Era in:/)
    expect(testo).toMatch(/2 ANNI/)
  })

  it('senza la data in archivio si dichiara l\'assenza invece di lasciare il vuoto', async () => {
    // Il vuoto a schermo è indistinguibile da un dato mai scritto: si dice.
    montaPannello(
      vi.fn(async () => ({ ok: true })),
      { ...ALUNNO_ARCHIVIATO, archiviato_il: '', archiviato_classe_sezione: null },
    )

    // `archiviato_il: ''` NON è archiviato (`!= null` è vero solo per la stringa
    // valorizzata o vuota: qui la scheda resta in stato archiviato ma senza data).
    const titolo = screen.getByText('Non più iscritto')
    expect((titolo.parentElement as HTMLElement).textContent).toMatch(/Data non registrata/)
    // Nessuna classe ricordata ⇒ la riga «Era in» non compare affatto: un'etichetta
    // con accanto il nulla è peggio dell'assenza dell'etichetta.
    expect((titolo.parentElement as HTMLElement).textContent).not.toMatch(/Era in:/)
  })

  it('⚠️ la tendina «Stato» è SPENTA, ed è scritto perché: era la seconda strada di ritorno', async () => {
    montaPannello(vi.fn(async () => ({ ok: true })), ALUNNO_ARCHIVIATO)

    const tendina = screen.getByLabelText('Stato') as HTMLSelectElement
    expect(tendina.disabled, 'la tendina «Stato» è ancora azionabile su un archiviato').toBe(true)
    // Un comando spento senza motivo è un guasto agli occhi di chi lo preme: la
    // spiegazione è legata alla tendina con `aria-describedby`, non messa lì vicino.
    const idSpiegazione = tendina.getAttribute('aria-describedby')
    expect(idSpiegazione).toBeTruthy()
    expect(document.getElementById(idSpiegazione!)?.textContent).toMatch(/Riporta fra gli iscritti/)
  })

  it('CONTROLLO POSITIVO — su un bambino iscritto la tendina resta azionabile e il comando è l\'archiviazione', async () => {
    // Senza, i due test qui sopra sarebbero verdi anche con la tendina spenta
    // per tutti e il ritorno offerto a chiunque.
    montaPannello(vi.fn(async () => ({ ok: true })))

    expect((screen.getByLabelText('Stato') as HTMLSelectElement).disabled).toBe(false)
    expect(screen.queryByRole('button', { name: /Riporta fra gli iscritti/ })).toBeNull()
    expect(screen.getByRole('button', { name: new RegExp(ETICHETTA_RIPOSO) })).toBeTruthy()
  })

  it('DB non migrato (CI): senza `archiviato_il` la scheda è quella di sempre', async () => {
    // Il DB E2E della CI è un progetto separato e non migrato: là la colonna non
    // arriva affatto. `undefined` non è «archiviato», ed è la lettura giusta su
    // un database dove l'archiviazione non esiste ancora.
    const senzaColonne = { ...ALUNNO_ARCHIVIATO }
    delete (senzaColonne as { archiviato_il?: unknown }).archiviato_il

    montaPannello(vi.fn(async () => ({ ok: true })), senzaColonne)

    expect((screen.getByLabelText('Stato') as HTMLSelectElement).disabled).toBe(false)
    expect(screen.getByRole('button', { name: new RegExp(ETICHETTA_RIPOSO) })).toBeTruthy()
  })

  it('il rifiuto del ritorno resta a schermo in un `role="alert"`, come quello dell\'archiviazione', async () => {
    const MOTIVO = 'Questo bambino è già fra gli iscritti: ricarica l’elenco'
    montaPannello(vi.fn(async () => ({ ok: true })), ALUNNO_ARCHIVIATO, vi.fn(async () => ({ ok: false, errore: MOTIVO })))

    fireEvent.click(screen.getByRole('button', { name: /Riporta fra gli iscritti/ }))

    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toContain(MOTIVO)
  })

  it('se «libera spazio» è già passato, la scheda lo dice in parole', async () => {
    montaPannello(
      vi.fn(async () => ({ ok: true })),
      { ...ALUNNO_ARCHIVIATO, spazio_liberato_il: '2026-08-05T09:00:00.000Z' },
    )

    expect(screen.getByText(/Foto, video e messaggi.*già.*cancellati/i)).toBeTruthy()
  })
})

/**
 * ─── IL CUORE DELLA CORREZIONE ──────────────────────────────────────────────
 *
 * Qui si monta la PAGINA, non il pannello: `router.push` lo chiama lei, dentro
 * `flash`, e il difetto era proprio lì — `flash` veniva invocata su ENTRAMBI i
 * rami, quindi il fallimento portava via l'operatore dopo 900 ms. Un test sul
 * solo pannello sarebbe verde anche con quel difetto intatto.
 */
describe('/admin/students/[id] — sul fallimento NON si naviga', () => {
  it('il 409 del server resta a schermo e `router.push` non viene mai chiamato', async () => {
    const MOTIVO_SERVER = 'Alunno già archiviato: aggiorna la pagina'
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url) === '/api/admin/students/archivia') {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({ error: MOTIVO_SERVER, codice: undefined }),
        })
      }
      if (String(url).startsWith('/api/admin/students/alu-1')) {
        return Promise.resolve({ ok: true, json: async () => IDENTITA_ALUNNO })
      }
      void init
      return Promise.resolve({ ok: true, json: async () => [] })
    })

    render(<AnagraficaDetailPage />)

    const bottone = await screen.findByRole('button', { name: new RegExp(ETICHETTA_RIPOSO) })
    fireEvent.click(bottone)
    fireEvent.click(screen.getByRole('button', { name: ETICHETTA_CONFERMA }))

    // La rotta chiamata è quella nuova, col corpo che si è concordato.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === '/api/admin/students/archivia')).toBe(true),
    )
    const chiamata = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/admin/students/archivia')!
    expect((chiamata[1] as RequestInit).method).toBe('POST')
    expect(JSON.parse(String((chiamata[1] as RequestInit).body))).toEqual({ alunno_id: 'alu-1' })

    // Il messaggio del server è a schermo…
    const avviso = await screen.findByRole('alert')
    expect(avviso.textContent).toContain(MOTIVO_SERVER)

    // …e ci resta: `flash` avrebbe navigato dopo 900 ms. Si aspetta oltre quel
    // termine invece di fidarsi dell'istante subito dopo il clic — altrimenti il
    // test sarebbe verde anche col difetto, che era un `setTimeout`.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200))
    })
    expect(nav.push).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain(MOTIVO_SERVER)
  })

  it('e sul successo invece si annuncia col NOME e si torna alla lista', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url) === '/api/admin/students/archivia') {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true }) })
      }
      if (String(url).startsWith('/api/admin/students/alu-1')) {
        return Promise.resolve({ ok: true, json: async () => IDENTITA_ALUNNO })
      }
      return Promise.resolve({ ok: true, json: async () => [] })
    })

    render(<AnagraficaDetailPage />)

    fireEvent.click(await screen.findByRole('button', { name: new RegExp(ETICHETTA_RIPOSO) }))
    fireEvent.click(screen.getByRole('button', { name: ETICHETTA_CONFERMA }))

    // Il segno di spunta distingue l'annuncio dal riquadro di conferma, che
    // nomina anch'esso i «non più iscritti» ed è ancora in pagina.
    const conferma = await screen.findByText(/✅/)
    expect(conferma.textContent).toMatch(/non più iscritti/i)

    /**
     * ⚠️ IL NOME ORA SI ASSERISCE, e questo blocco raccontava il contrario.
     *
     * Diceva: «il nome non si può asserire qui, il mock di next-intl restituisce
     * la stringa GREZZA senza interpolare — a schermo resta `{nome}` letterale»,
     * e ripiegava sul verificare che il CATALOGO il segnaposto ce l'avesse. Era
     * una descrizione fedele del banco di prova, non del prodotto: significava
     * che nessuno provava la cosa che la nota dichiara importante — che la
     * segreteria, con più schede aperte, legga CHI è stato spostato.
     *
     * Dal 2026-08-20 il mock formatta quando arrivano dei valori, e si pretende
     * il nome vero. Il controllo sul catalogo resta: se qualcuno togliesse il
     * segnaposto dalla frase, la prima asserzione cadrebbe e la seconda direbbe
     * perché.
     */
    expect(conferma.textContent).toContain('Aurora Verdi')
    expect(catalogoIt.detailPageArchiviato).toContain('{nome}')

    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200))
    })
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/admin/students'))
  })
})
