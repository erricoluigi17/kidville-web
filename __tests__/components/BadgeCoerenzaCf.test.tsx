import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { axe, toHaveNoViolations } from 'jest-axe'

import { BadgeCoerenzaCf, ID_BADGE_COERENZA_CF } from '@/components/features/anagrafica/BadgeCoerenzaCf'
import type { EsitoCoerenza } from '@/lib/fiscale/coerenza'
import { mascheraSorgente } from '../fixtures/sorgente'

expect.extend(toHaveNoViolations)

// =============================================================================
// `BadgeCoerenzaCf` — la segnalazione che NON blocca.
//
// LE DUE COSE CHE QUESTO BANCO ESISTE PER DIMOSTRARE, in ordine di quanto costa
// sbagliarle:
//
//  1. **IL SALVA RESTA ABILITATO.** È una decisione del titolare, e una decisione
//     scritta solo in un commento è una decisione che il primo refactor cancella.
//     §5 monta un form finto col badge ROSSO e misura che il bottone Salva non sia
//     `disabled` e che la fetch di salvataggio parta davvero.
//
//  2. **I TRE STATI RESTANO TRE.** In produzione, l'11 agosto, 18 alunni su 33 e
//     27 genitori su 50 non hanno il codice fiscale. Se «manca il dato» si
//     confondesse con «i dati si contraddicono», metà archivio sarebbe rosso il
//     primo giorno e il pannello smetterebbe di essere guardato. §1-§3 misurano che
//     il rosso, il giallo e il neutro siano distinguibili SENZA guardare il colore
//     — icona e testo, come pretende WCAG 1.4.1.
//
// ⚠️ Nessun codice fiscale con checksum valida in questo file: il repository è
// PUBBLICO. I codici qui sotto sono deliberatamente inventati e non appartengono
// a nessuno; dove serve un esito, lo si COSTRUISCE a mano invece di farlo
// calcolare da `verificaCoerenza` su dati di persona.
// =============================================================================

/** Un esito «tutto a posto»: la base da cui si deriva ogni caso. */
const COERENTE: EsitoCoerenza = {
  coerente: true,
  motivi: [],
  nonVerificabili: [],
  codiceAtteso: 'AAAAAA00A00A000A',
  codiceEsaminato: 'AAAAAA00A00A000A',
}

const esito = (patch: Partial<EsitoCoerenza>): EsitoCoerenza => ({ ...COERENTE, ...patch })

// ── §1 · I TRE STATI ─────────────────────────────────────────────────────────

describe('§1 · i tre stati sono tre, e si distinguono senza guardare il colore', () => {
  it('coerente e tutto verificato → NON rende niente', () => {
    const { container } = render(<BadgeCoerenzaCf esito={COERENTE} />)
    expect(container.firstChild).toBeNull()
  })

  it('con dei motivi → ROSSO, con titolo esplicito e un’icona', () => {
    render(<BadgeCoerenzaCf esito={esito({ coerente: false, motivi: ['cf-checksum'] })} />)
    const badge = screen.getByRole('status')
    expect(badge).toHaveTextContent('Codice fiscale non coerente con i dati inseriti')
    // Il segnale non è solo cromatico: c'è un'icona (SVG) accanto al testo.
    expect(badge.querySelector('svg')).not.toBeNull()
  })

  it('con soli nonVerificabili (e il codice presente) → GIALLO, non rosso', () => {
    render(<BadgeCoerenzaCf esito={esito({ nonVerificabili: ['luogo-nascita'] })} />)
    const badge = screen.getByRole('status')
    expect(badge).toHaveTextContent('Non verificabile')
    expect(badge).toHaveTextContent('manca il codice catastale del comune di nascita')
    expect(badge).not.toHaveTextContent('non coerente')
  })

  /**
   * ⚠️ QUESTA FRASE HA DETTO IL FALSO, e la riga qui sotto esiste perché non
   * ritorni a dirlo. `coerenza.ts` mette `luogo-nascita` fra i non verificabili
   * quando manca il CODICE CATASTALE — il comune non lo legge nemmeno — mentre la
   * frase diceva «manca il comune di nascita». In produzione il comune c'era su 36
   * record su 83, ed era pure mostrato SCELTO nel campo del luogo di nascita, due
   * sezioni più sotto nello stesso pannello. La misura che li guarda insieme sta
   * in §9 di `LuogoNascitaFields.test.tsx`; qui si blocca la sola stringa.
   */
  it('il giallo del luogo di nascita nomina il CODICE CATASTALE, e dice l’azione', () => {
    render(<BadgeCoerenzaCf esito={esito({ nonVerificabili: ['luogo-nascita'] })} />)
    const testo = screen.getByRole('status').textContent ?? ''
    expect(testo).toContain('codice catastale')
    expect(testo).toContain('scegli il comune dall’elenco del luogo di nascita per registrarlo')
    // Il comune, sui 36 record veri, NON manca: dirlo era la contraddizione.
    expect(testo).not.toContain('manca il comune di nascita')
  })

  it('codice ASSENTE → nessun giallo: è «da compilare», lo stato neutro', () => {
    // Sono i 18 bambini su 33 senza codice fiscale. `verificaCoerenza` restituisce
    // tutti e cinque i campi fra i non verificabili: dipingerli di giallo
    // significherebbe accendere mezzo archivio.
    render(
      <BadgeCoerenzaCf
        esito={esito({
          nonVerificabili: ['cognome', 'nome', 'data-nascita', 'sesso', 'luogo-nascita'],
          codiceEsaminato: '',
          codiceAtteso: null,
        })}
      />,
    )
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('codice assente ma calcolabile → riquadro NEUTRO con la proposta, non un avviso', () => {
    render(
      <BadgeCoerenzaCf
        esito={esito({ nonVerificabili: ['cognome'], codiceEsaminato: '', codiceAtteso: 'BBBBBB00B00B000B' })}
        onUsaCalcolato={() => {}}
      />,
    )
    const badge = screen.getByRole('status')
    expect(badge).toHaveTextContent('Codice calcolato dai dati:')
    expect(badge).toHaveTextContent('BBBBBB00B00B000B')
    // Nessun titolo d'allarme: non c'è niente che non torni.
    expect(badge).not.toHaveTextContent('Non verificabile')
    expect(badge).not.toHaveTextContent('non coerente')
  })

  it('il rosso vince sul giallo quando ci sono entrambi', () => {
    render(
      <BadgeCoerenzaCf esito={esito({ coerente: false, motivi: ['cognome'], nonVerificabili: ['sesso'] })} />,
    )
    const badge = screen.getByRole('status')
    expect(badge).toHaveTextContent('Codice fiscale non coerente con i dati inseriti')
    expect(badge).not.toHaveTextContent('manca il sesso')
  })
})

// ── §2 · I MOTIVI IN ITALIANO LEGGIBILE ──────────────────────────────────────

describe('§2 · i motivi si leggono in italiano, non in gergo', () => {
  it('ogni motivo ha una frase, e nessuna è il nome della chiave', () => {
    render(
      <BadgeCoerenzaCf
        esito={esito({
          coerente: false,
          motivi: ['cf-checksum', 'cf-lunghezza', 'cognome', 'nome', 'data-nascita', 'luogo-nascita'],
        })}
      />,
    )
    const punti = within(screen.getByRole('status')).getAllByRole('listitem').map((li) => li.textContent ?? '')
    expect(punti).toEqual([
      'la checksum non torna: l’ultimo carattere di controllo non corrisponde',
      'il codice non è lungo sedici caratteri',
      'le prime tre lettere non corrispondono al cognome dell’anagrafica',
      'le tre lettere del nome non corrispondono al nome dell’anagrafica',
      'la data scritta nel codice non è la data di nascita dell’anagrafica',
      'il comune scritto nel codice non è il luogo di nascita dell’anagrafica',
    ])
    // Se una chiave mancasse dal catalogo, il mock di next-intl renderebbe
    // «shared.cfMotivo…»: è il modo in cui un buco i18n si vede in un unit test.
    for (const p of punti) expect(p).not.toMatch(/^shared\./)
  })

  it('il sesso dice la DIREZIONE: «il codice dice femmina, l’anagrafica dice maschio»', () => {
    // Giorno 45 = 5 + 40: la scala femminile. Il codice è inventato e la checksum
    // non conta qui — `baseSenzaOmocodia` regge comunque la lettura del giorno.
    render(
      <BadgeCoerenzaCf
        esito={esito({ coerente: false, motivi: ['sesso'], codiceEsaminato: 'AAAAAA00A45A000A' })}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('il codice dice femmina, l’anagrafica dice maschio')
  })

  it('…e nell’altro verso quando il codice è maschile', () => {
    render(
      <BadgeCoerenzaCf
        esito={esito({ coerente: false, motivi: ['sesso'], codiceEsaminato: 'AAAAAA00A05A000A' })}
      />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('il codice dice maschio, l’anagrafica dice femmina')
  })

  it('quando il codice non è leggibile, il motivo resta generico invece di inventare', () => {
    render(<BadgeCoerenzaCf esito={esito({ coerente: false, motivi: ['sesso'], codiceEsaminato: 'TROPPOCORTO' })} />)
    expect(screen.getByRole('status')).toHaveTextContent('il sesso scritto nel codice non è quello dell’anagrafica')
  })
})

// ── §3 · «USA QUESTO» COMPILA, E BASTA ───────────────────────────────────────

describe('§3 · «Usa questo» compila il campo e non salva niente', () => {
  it('chiama `onUsaCalcolato` col codice proposto', () => {
    const spia = vi.fn()
    render(
      <BadgeCoerenzaCf
        esito={esito({ coerente: false, motivi: ['cf-checksum'], codiceAtteso: 'CCCCCC00C00C000C' })}
        onUsaCalcolato={spia}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Usa questo' }))
    expect(spia).toHaveBeenCalledTimes(1)
    expect(spia).toHaveBeenCalledWith('CCCCCC00C00C000C')
  })

  it('senza `onUsaCalcolato` il bottone non c’è (ma il codice calcolato si legge lo stesso)', () => {
    render(
      <BadgeCoerenzaCf esito={esito({ coerente: false, motivi: ['cf-checksum'], codiceAtteso: 'CCCCCC00C00C000C' })} />,
    )
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('CCCCCC00C00C000C')
  })

  it('su un codice COERENTE non si propone niente: l’omocodia è legittima', () => {
    // Un codice omocodico è coerente e DIVERSO dal codice calcolato: proporre di
    // sostituirlo significherebbe invitare a cancellare quello che l'Agenzia ha
    // davvero assegnato.
    const { container } = render(
      <BadgeCoerenzaCf
        esito={esito({ codiceEsaminato: 'AAAAAA00A00A00LA', codiceAtteso: 'AAAAAA00A00A000A' })}
        onUsaCalcolato={() => {}}
      />,
    )
    expect(container.firstChild).toBeNull()
  })
})

// ── §4 · RUOLO E ACCESSIBILITÀ ───────────────────────────────────────────────

/**
 * ⚠️ QUI C'ERA UN TEST SULLA VARIANTE «COMPATTA», ed è stato tolto insieme al
 * ramo che misurava. Il ramo non lo montava nessun chiamante — `grep -rn
 * 'compatto' src/` trova solo il `SedeSelector` di `cockpit.tsx`, che è un'altra
 * cosa — e la tabella per cui era stato pensato è stata scritta davvero
 * (`CodiciFiscaliDaVerificare.tsx`): NON usa questo componente, dipinge la propria
 * pillola con i propri cataloghi. Cioè il consumatore previsto esiste e ha scelto
 * un'altra strada.
 *
 * Un test verde su un ramo che il prodotto non rende è copertura che non si
 * incassa: dice «misurato» di una cosa che nessun utente vede. Se la tabella un
 * giorno vorrà questo badge, il ramo si riscrive — e i tre stati si misureranno
 * DENTRO la tabella, che è dove rischiano davvero di collassare in una pillola
 * colorata e muta.
 */
describe('§4 · ruolo e accessibilità', () => {
  it('è `role="status"`, non `role="alert"`: è un’osservazione, non un errore di compilazione', () => {
    render(<BadgeCoerenzaCf esito={esito({ coerente: false, motivi: ['cf-checksum'] })} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('ha un `id` stabile, così il campo del codice fiscale può puntarci con aria-describedby', () => {
    const { rerender } = render(<BadgeCoerenzaCf esito={esito({ coerente: false, motivi: ['cf-checksum'] })} />)
    expect(screen.getByRole('status')).toHaveAttribute('id', ID_BADGE_COERENZA_CF)
    rerender(<BadgeCoerenzaCf id="cf-alunno-esito" esito={esito({ coerente: false, motivi: ['cf-checksum'] })} />)
    expect(screen.getByRole('status')).toHaveAttribute('id', 'cf-alunno-esito')
  })

  it('⚠️ il contenuto cambia a OGNI battuta: per questo la regione live non è persistente', () => {
    // La domanda posta in revisione è giusta: un `role="status"` che nasce
    // insieme al proprio testo, di norma, non annuncia. La risposta però non è
    // renderlo persistente — è questa misura.
    //
    // `esito` lo ricalcola il chiamante a ogni tasto premuto sul campo del codice
    // fiscale (`useMemo` sul valore del campo, in tutti e sei i punti di
    // montaggio). Una regione live persistente pronuncerebbe OGNI stato qui sotto
    // mentre l'utente sta ancora scrivendo, sopra l'eco della propria digitazione.
    // Montare e smontare il riquadro è ciò che tiene il badge zitto durante la
    // battitura; la via dichiarata per SENTIRLO è `aria-describedby` (§5), che
    // parla quando l'utente arriva sul campo — una volta, e al momento giusto.
    const battute = [
      esito({ coerente: false, motivi: ['cf-lunghezza'], codiceEsaminato: 'AAAAAA00A00A0' }),
      esito({ coerente: false, motivi: ['cf-forma'], codiceEsaminato: 'AAAAAA00A00A000?' }),
      esito({ coerente: false, motivi: ['cf-checksum'], codiceEsaminato: 'AAAAAA00A00A000B' }),
      esito({ coerente: false, motivi: ['cf-checksum', 'sesso'], codiceEsaminato: 'AAAAAA00A45A000B' }),
    ]
    const { rerender } = render(<BadgeCoerenzaCf esito={battute[0]} />)
    const detti = new Set<string>()
    for (const b of battute) {
      rerender(<BadgeCoerenzaCf esito={b} />)
      detti.add(screen.getByRole('status').textContent ?? '')
    }
    // Quattro battute, quattro testi DIVERSI: quattro annunci non richiesti.
    expect(detti.size).toBe(battute.length)
  })

  it('nessuna violazione axe, nei tre stati', async () => {
    for (const caso of [
      esito({ coerente: false, motivi: ['cf-checksum', 'sesso'] }),
      esito({ nonVerificabili: ['luogo-nascita', 'sesso'] }),
      esito({ codiceEsaminato: '', codiceAtteso: 'DDDDDD00D00D000D' }),
    ]) {
      const { container, unmount } = render(<BadgeCoerenzaCf esito={caso} onUsaCalcolato={() => {}} />)
      expect(await axe(container)).toHaveNoViolations()
      unmount()
    }
  })
})

// ── §5 · LA PROVA CHE CONTA: IL SALVA RESTA ABILITATO ────────────────────────

/**
 * Il form finto: un campo, il badge, un Salva che chiama `fetch`. È volutamente
 * MINIMO — non c'è nessuno zod, nessun `setErrors`, nessuna riga che colleghi
 * l'esito al bottone — perché è esattamente ciò che si vuole dimostrare: il badge
 * si può montare accanto a un modulo senza che il modulo cambi comportamento.
 */
function FormFinto({ esitoCf }: { esitoCf: EsitoCoerenza }) {
  const [cf, setCf] = useState('AAAAAA00A00A000B')
  const [inviato, setInviato] = useState(false)
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        void fetch('/api/finta/anagrafica', { method: 'POST', body: JSON.stringify({ cf }) })
        setInviato(true)
      }}
    >
      <label htmlFor="cf-finto">Codice fiscale</label>
      <input
        id="cf-finto"
        value={cf}
        aria-describedby={ID_BADGE_COERENZA_CF}
        onChange={(ev) => setCf(ev.target.value)}
      />
      <BadgeCoerenzaCf esito={esitoCf} onUsaCalcolato={setCf} />
      <button type="submit">Salva</button>
      {inviato && <p role="status">Inviato</p>}
    </form>
  )
}

describe('§5 · il badge rosso NON blocca il salvataggio (decisione del titolare)', () => {
  const rosso = esito({
    coerente: false,
    motivi: ['cf-checksum', 'sesso'],
    codiceAtteso: 'EEEEEE00E00E000E',
    codiceEsaminato: 'AAAAAA00A00A000B',
  })

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('il bottone Salva è abilitato e la fetch di salvataggio parte davvero', async () => {
    render(<FormFinto esitoCf={rosso} />)

    // Il badge è rosso: la contraddizione c'è ed è scritta.
    expect(screen.getByText('Codice fiscale non coerente con i dati inseriti')).toBeInTheDocument()

    const salva = screen.getByRole('button', { name: 'Salva' })
    expect(salva).toBeEnabled()
    expect(salva).not.toHaveAttribute('aria-disabled')

    fireEvent.click(salva)

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/finta/anagrafica')
    expect(screen.getByText('Inviato')).toBeInTheDocument()
  })

  it('«Usa questo» compila il campo e NON manda niente in rete', () => {
    render(<FormFinto esitoCf={rosso} />)
    const campo = screen.getByLabelText('Codice fiscale')
    expect(campo).toHaveValue('AAAAAA00A00A000B')

    fireEvent.click(screen.getByRole('button', { name: 'Usa questo' }))

    expect(campo).toHaveValue('EEEEEE00E00E000E')
    expect(fetch).not.toHaveBeenCalled()
    expect(screen.queryByText('Inviato')).toBeNull()
  })

  it('il campo del codice fiscale punta al badge con `aria-describedby`', () => {
    render(<FormFinto esitoCf={rosso} />)
    const campo = screen.getByLabelText('Codice fiscale')
    const descritto = campo.getAttribute('aria-describedby')
    expect(descritto).toBe(ID_BADGE_COERENZA_CF)
    expect(document.getElementById(descritto as string)).toBe(screen.getByRole('status'))
  })
})

// ── §6 · IL LOCK DI FORMA ────────────────────────────────────────────────────

describe('§6 · il sorgente non contiene i due modi di bloccare un modulo', () => {
  /**
   * §5 misura il COMPORTAMENTO su un form finto; questo misura la FORMA sul
   * sorgente. Servono tutti e due: un form finto dimostra che oggi non blocca,
   * un lock di forma impedisce che domani qualcuno «migliori» il componente
   * facendogli restituire un `disabled` o scrivere dentro `setErrors` — che è il
   * modo naturale in cui una decisione di prodotto viene ribaltata per distrazione.
   */
  // ⚠️ Si guarda il CODICE, non i commenti: questo file spiega a parole che non
  // emette nessun `disabled`, e una grep sul testo grezzo troverebbe proprio
  // quella spiegazione. È lo stesso falso positivo che gli altri lock di forma di
  // questo repo evitano con `mascheraSorgente`.
  const sorgente = mascheraSorgente(
    readFileSync(join(process.cwd(), 'src/components/features/anagrafica/BadgeCoerenzaCf.tsx'), 'utf8'),
  ).senzaCommenti

  it('nessun `disabled` e nessun `setErrors` nel codice del componente', () => {
    expect(sorgente).not.toMatch(/\bdisabled\b/)
    expect(sorgente).not.toMatch(/\bsetErrors\b/)
    expect(sorgente).not.toMatch(/aria-disabled/)
  })

  it('la sonda vede davvero un `disabled`, se c’è (altrimenti il lock è un fantoccio)', () => {
    expect(mascheraSorgente('const a = <button disabled>Salva</button>').senzaCommenti).toMatch(/\bdisabled\b/)
    // …e non lo vede quando sta in un commento, che è il falso positivo evitato.
    expect(mascheraSorgente('// qui non esce nessun disabled\nconst a = 1').senzaCommenti).not.toMatch(/\bdisabled\b/)
  })
})
