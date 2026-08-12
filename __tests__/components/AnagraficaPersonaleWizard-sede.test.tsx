import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import itPublic from '../../messages/it/public.json'
import {
  ALFA, BETA, GAMMA, TRE_SEDI, OGGI, avanti, compilaFinoAlRiepilogo, reteFinta,
  valoreNelRiepilogo,
} from '../fixtures/anagrafica-personale'

/**
 * `/anagrafica-personale` — LA SEDE, E PERCHÉ IL SUO PASSO NON PUÒ SPARIRE.
 *
 * ─── IL DIFETTO CHE QUESTO FILE IMPEDISCE ───────────────────────────────────
 *
 * `useSediPubbliche` decide da sé se il passo della sede serve: `mostraSede` è
 * vero solo con PIÙ DI UN plesso in elenco. È la regola giusta per il modulo
 * delle candidature, dove la sede può arrivare da un link targato, ed è quella
 * SBAGLIATA qui — e il modo in cui sbaglia è silenzioso.
 *
 * Con un plesso solo in elenco (il database della CI, una sede disattivata per
 * manutenzione, un `sediReali` che ne esclude due) il passo sparirebbe: nessuna
 * card, nessun «Modifica» nel riepilogo, e chi compila consegnerebbe il proprio
 * CODICE FISCALE e la SCANSIONE DEL PROPRIO DOCUMENTO senza aver mai letto il
 * nome della sede a cui li sta consegnando. Non è un dettaglio d'interfaccia: è
 * l'unica informazione che dice DOVE finiscono tutte le altre.
 *
 * Perciò qui il passo c'è sempre, e questo file lo dimostra proprio nel caso in
 * cui il componente riusato direbbe di no.
 *
 * ─── E LE CARD DICONO IL PLESSO **E** LA CITTÀ ──────────────────────────────
 *
 * Aversa e Cesa distano sei chilometri e sono due sedi diverse della stessa
 * cooperativa. Tre righe che si distinguono per una parola sola si sbagliano —
 * e sbagliarle qui significa mandare l'anagrafica alla segreteria di un'altra
 * sede, che la vedrà arrivare senza sapere di chi sia, mentre quella giusta
 * crede che non sia mai stata inviata.
 */

const h = vi.hoisted(() => ({ logClient: vi.fn(), nomeErrore: () => 'TypeError' }))
vi.mock('@/lib/logging/client', () => ({ logClient: h.logClient, nomeErrore: h.nomeErrore }))

import { AnagraficaPersonaleWizard, cittaDelPlesso } from '@/components/features/public/AnagraficaPersonaleWizard'

/** Il primo campo del passo «I tuoi dati»: la sua presenza dice «si è passati». */
const PRIMO_CAMPO = 'Es. Maria'

/** Il 400 con cui la rotta rifiuta una sede che non riceve il modulo. */
const RIFIUTO_SEDE = {
  tipo: 'http' as const,
  stato: 400,
  corpo: { error: 'Indicare la sede in cui si lavora.', codice: 'SEDE_DA_SPECIFICARE' },
}

function montaConRete(rete: ReturnType<typeof reteFinta>) {
  vi.stubGlobal('fetch', rete.fetch)
  return render(<AnagraficaPersonaleWizard oggi={OGGI} />)
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('AnagraficaPersonaleWizard — il passo della sede c’è SEMPRE', () => {
  it('con TRE plessi: tre card, nessuna scelta, e «Avanti» non passa finché non se ne tocca una', async () => {
    montaConRete(reteFinta())

    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(3))
    expect(screen.queryByPlaceholderText(PRIMO_CAMPO)).not.toBeInTheDocument()

    avanti()

    await waitFor(() => expect(screen.getByText(itPublic.persSedeErrore)).toBeInTheDocument())
    // Il fuoco va DENTRO il gruppo che l'errore descrive: senza, chi naviga da
    // tastiera resta sul bottone mentre l'errore compare più in su, e deve
    // risalire la pagina col Tab per trovare la cosa da fare.
    expect(document.activeElement).toBe(screen.getAllByRole('radio')[0])
    expect(screen.queryByPlaceholderText(PRIMO_CAMPO)).not.toBeInTheDocument()
  })

  it('⚠️ con UN SOLO plesso il passo RESTA, e la card è già scelta', async () => {
    // È il caso in cui `useSediPubbliche` direbbe «non c'è niente da scegliere».
    // Il passo non è una scelta da fare: è la riga che dice a chi consegna il
    // proprio documento d'identità a QUALE sede lo sta consegnando.
    montaConRete(reteFinta({ sedi: [{ tipo: 'ok', sedi: [GAMMA] }] }))

    await waitFor(() => expect(screen.getByRole('radio', { name: /Kidville Giugliano/ })).toBeInTheDocument())
    expect(screen.getByRole('radio', { name: /Kidville Giugliano/ })).toBeChecked()
    // …e il modulo non è cominciato: prima si legge la sede, poi si compila.
    expect(screen.queryByPlaceholderText(PRIMO_CAMPO)).not.toBeInTheDocument()

    avanti()
    await waitFor(() => expect(screen.getByPlaceholderText(PRIMO_CAMPO)).toBeInTheDocument())
  })

  it('i passi sono SEI, e si contano sui pallini (non sulla frase, che qui non è resa)', async () => {
    // ⚠️ Il mock di next-intl in `test/setup.ts` NON interpreta l'ICU: «Passo
    // {corrente} di {totale}» esce con i segnaposto dentro, e asserire su quel
    // testo misurerebbe il mock invece del modulo. I pallini invece sono uno per
    // passo, li disegna `ContatorePassi` e il loro numero È il numero dei passi.
    montaConRete(reteFinta({ sedi: [{ tipo: 'ok', sedi: [GAMMA] }] }))

    await waitFor(() => expect(screen.getByRole('radio', { name: /Kidville/ })).toBeInTheDocument())
    const contatore = document.getElementById('pers-passo-contatore') as HTMLElement
    const pallini = contatore.querySelector('span[aria-hidden="true"]') as HTMLElement
    expect(pallini.children).toHaveLength(6)
  })
})

describe('AnagraficaPersonaleWizard — le card portano il plesso E la città', () => {
  it('«Kidville Aversa» e «Kidville Cesa» si distinguono anche a colpo d’occhio', async () => {
    montaConRete(reteFinta())

    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(3))
    for (const s of TRE_SEDI) {
      const radio = document.getElementById(`pers-sede-${s.id}`) as HTMLElement
      const card = radio.closest('label') as HTMLElement
      // Il nome intero è sulla card…
      expect(card).toHaveTextContent(s.nome)
      // …e la città compare come riga sua, non annegata nel marchio.
      const citta = cittaDelPlesso(s.nome)
      expect(citta).not.toBeNull()
      expect(card.querySelectorAll('span > span')[1]).toHaveTextContent(citta as string)
    }
  })

  it('la città si ricava dal NOME e non da una tabella: un nome senza comune non produce una riga vuota', () => {
    // Il giorno in cui nasce un quarto plesso, questa funzione non va aggiornata:
    // una tabella di sedi scritta nel wizard sarebbe la seconda fonte di verità,
    // cioè quella che nessuno aggiorna.
    expect(cittaDelPlesso('Kidville Aversa')).toBe('Aversa')
    expect(cittaDelPlesso('Kidville Giugliano in Campania')).toBe('Giugliano in Campania')
    expect(cittaDelPlesso('Kidville')).toBeNull()
    expect(cittaDelPlesso('  Kidville   ')).toBeNull()
    expect(cittaDelPlesso('')).toBeNull()
  })
})

describe('AnagraficaPersonaleWizard — l’elenco delle sedi e i suoi tre stati', () => {
  it('ELENCO NON OTTENUTO: il modulo non comincia, e si offre «Riprova»', async () => {
    // 429 non è un'eccezione: il `catch` di una promise non scatta, ed è da lì
    // che il rate-limit passava in silenzio sul modulo fratello. Senza sede non
    // esiste nessun invio possibile, quindi non si fa compilare niente.
    montaConRete(reteFinta({ sedi: [{ tipo: 'http', stato: 429 }, { tipo: 'ok', sedi: TRE_SEDI }] }))

    await waitFor(() => expect(screen.getByText(itPublic.persSediErroreTitolo)).toBeInTheDocument())
    expect(screen.queryByPlaceholderText(PRIMO_CAMPO)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: itPublic.persSediRiprova }))
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(3))
  })

  it('ELENCO VUOTO: frase diversa, e NESSUN «Riprova» (ricaricare darebbe la stessa risposta)', async () => {
    montaConRete(reteFinta({ sedi: [{ tipo: 'ok', sedi: [] }] }))

    await waitFor(() => expect(screen.getByText(itPublic.persSediVuoteTitolo)).toBeInTheDocument())
    expect(screen.queryByText(itPublic.persSediErroreTitolo)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: itPublic.persSediRiprova })).not.toBeInTheDocument()
  })

  it('CORPO SENZA `data`: un 200 illeggibile NON è «nessuna sede»', async () => {
    montaConRete(reteFinta({ sedi: [{ tipo: 'corpo-strano' }] }))
    await waitFor(() => expect(screen.getByText(itPublic.persSediErroreTitolo)).toBeInTheDocument())
    expect(screen.queryByText(itPublic.persSediVuoteTitolo)).not.toBeInTheDocument()
  })
})

describe('AnagraficaPersonaleWizard — la sede nel riepilogo, e il rifiuto del server', () => {
  it('la sede è la PRIMA card del riepilogo, col nome del plesso e il suo «Modifica»', async () => {
    montaConRete(reteFinta())
    await compilaFinoAlRiepilogo({ sede: BETA.id })

    const gruppi = screen.getAllByRole('heading', { level: 3 })
    expect(gruppi[0]).toHaveTextContent(itPublic.persSede)
    expect(valoreNelRiepilogo(itPublic.persRiepilogoSede)).toBe(BETA.nome)

    // Il nome accessibile del comando porta il gruppo: cinque «Modifica» in fila
    // sono, per chi li ascolta, cinque volte la stessa cosa.
    const modifica = screen.getByRole('button', {
      name: `${itPublic.persRiepilogoModifica} ${itPublic.persSede}`,
    })
    fireEvent.click(modifica)
    await waitFor(() => expect(screen.getAllByRole('radio')).toHaveLength(3))
    expect(document.getElementById(`pers-sede-${BETA.id}`)).toBeChecked()
  })

  it('⚠️ il rifiuto `SEDE_DA_SPECIFICARE` NON butta via il modulo compilato', async () => {
    // Il rifiuto arriva DAL RIEPILOGO, cioè dopo cinque passi. Riportare a un
    // pannello «non riusciamo a caricare le sedi» significherebbe far ricompilare
    // tutto — codice fiscale e scansione del documento compresi.
    const rete = reteFinta({
      sedi: [{ tipo: 'ok', sedi: TRE_SEDI }],
      invii: [RIFIUTO_SEDE, { tipo: 'ok' }],
    })
    montaConRete(rete)
    await compilaFinoAlRiepilogo({ sede: ALFA.id })

    fireEvent.click(screen.getByRole('button', { name: itPublic.persInvia }))

    await waitFor(() => expect(screen.getByText(itPublic.persSedeRifiutataCorpo)).toBeInTheDocument())
    // Si torna al passo «sede», che c'è ancora, con le card ricaricate…
    await waitFor(() => expect(screen.getAllByRole('radio').length).toBeGreaterThan(0))
    // …e il pannello dice che i dati non sono andati persi.
    expect(screen.getByRole('alert')).toHaveTextContent(itPublic.persSedeRifiutataNota)

    // La prova che il modulo è ancora tutto lì: si riparte da qui e si riarriva
    // al riepilogo senza ricompilare un solo campo.
    fireEvent.click(document.getElementById(`pers-sede-${GAMMA.id}`) as HTMLElement)
    avanti() // sede → dati
    await waitFor(() => expect(screen.getByPlaceholderText(PRIMO_CAMPO)).toHaveValue('Prova'))
  })

  it('sul rifiuto si logga un’etichetta stabile, e MAI l’uuid della sede', async () => {
    const rete = reteFinta({ invii: [RIFIUTO_SEDE] })
    montaConRete(rete)
    await compilaFinoAlRiepilogo({ sede: ALFA.id })
    fireEvent.click(screen.getByRole('button', { name: itPublic.persInvia }))

    await waitFor(() =>
      expect(h.logClient).toHaveBeenCalledWith(
        expect.objectContaining({ messaggio: 'anagrafica-personale-sede-rifiutata', livello: 'warn' }),
      ),
    )
    for (const [riga] of h.logClient.mock.calls) {
      expect(JSON.stringify(riga)).not.toContain(ALFA.id)
    }
  })

  it('lo slug dei log è SUO, non quello della candidatura (altrimenti si deducono a vicenda)', async () => {
    montaConRete(reteFinta({ sedi: [{ tipo: 'rete' }] }))
    await waitFor(() => expect(h.logClient).toHaveBeenCalled())
    const messaggi = h.logClient.mock.calls.map(([r]) => String((r as { messaggio: string }).messaggio))
    expect(messaggi.some((m) => m.startsWith('anagrafica-personale-'))).toBe(true)
    expect(messaggi.some((m) => m.startsWith('candidatura-'))).toBe(false)
  })
})
