import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { useForm, type FieldValues } from 'react-hook-form'
import { FieldRenderer, SCELTA_ERRORE, SCELTA_PRESA, spezzaNomeFile } from '@/components/features/forms/FieldRenderer'
import type { FormField } from '@/types/database.types'
import itCampi from '../../messages/it/parentForms.json'

// =============================================================================
// GLI STATI DI UN CAMPO SI VEDONO — rilievi del critico visivo dell'11/08/2026.
//
// `FieldRenderer` è UNO e serve TRE superfici: il modulo pubblico d'iscrizione
// (`EnrollmentWizard`, da cui arrivano domande di famiglie vere), la candidatura
// insegnanti (`CandidaturaInsegnanteWizard`) e la modulistica condivisibile a
// token (`WizardContainer`). Ogni difetto qui sotto le riguardava tutte e tre.
//
// Quattro stati che il componente CONOSCEVA e non DICEVA:
//  1. campo in errore  → `aria-invalid` c'era, il bordo no: #55615C, identico a
//     un campo valido. L'unico segnale era la riga rossa sotto.
//  2. opzione spuntata → `checked` era già calcolato e non veniva usato per
//     niente: card crema su fondo crema, immutata alla spunta.
//  3. select non compilato → «Seleziona…» nel VERDE dei valori: un menu vuoto
//     aveva l'aspetto di un menu compilato.
//  4. titolo e corpo del consenso → stesso colore dopo il rimappaggio pubblico.
//
// I test guardano le CLASSI e non i pixel di proposito: il colore vero lo
// misurano già `__tests__/a11y/contrasto-*`, che risolvono la cascata di
// `globals.css`. Qui si verifica che lo stato arrivi fino al DOM.
// =============================================================================

function Harness({ field, nota }: { field: FormField; nota?: string }) {
  const {
    register,
    control,
    trigger,
    setFocus,
    formState: { errors },
  } = useForm<FieldValues>({ mode: 'onTouched' })
  return (
    <form>
      <FieldRenderer
        field={field}
        modelId="m"
        register={register}
        control={control}
        error={errors[field.id]}
        // La nota del campo. Dal 25/08/2026 il chiamante passa il TESTO e il
        // renderer rende il `<p>` e ne DERIVA l'`id` (`<idCampo>-nota`): è la forma
        // che usa `CandidaturaInsegnanteWizard` per `candCvNota` e
        // `candPosizioniAiuto`. Serve al collaudo del gruppo qui sotto.
        nota={nota}
      />
      <button type="button" onClick={() => void trigger()}>Valida</button>
      {/* Il wizard fa esattamente questo dopo un «Avanti» fallito:
          `setFocus(primoCampoInErrore.id)`. */}
      <button type="button" onClick={() => setFocus(field.id)}>Fuoco</button>
    </form>
  )
}

/**
 * Lo stesso banco, ma con un valore GIÀ nel modulo e il nome dell'allegato che il
 * chiamante si è tenuto: è la condizione in cui il wizard rimonta il passo dopo un
 * «Modifica» premuto dal riepilogo.
 */
function HarnessConNome({ field, valore, nome }: { field: FormField; valore: string; nome: string }) {
  const {
    register,
    control,
    formState: { errors },
  } = useForm<FieldValues>({ mode: 'onTouched', defaultValues: { [field.id]: valore } })
  return (
    <form>
      <FieldRenderer
        field={field}
        modelId="m"
        register={register}
        control={control}
        error={errors[field.id]}
        nomeAllegatoIniziale={nome}
      />
    </form>
  )
}

const classi = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)

/**
 * La card di scelta che contiene un controllo.
 *
 * NON `closest('label')`: dal 12/08/2026 la card del CONSENSO è un `<div>` — la
 * `<label>` dentro copre il solo titolo, perché il corpo dell'informativa non
 * deve né entrare nel nome accessibile né spuntare la casella quando lo si
 * seleziona (§4bis). La card si riconosce da ciò che la rende una card: il
 * raggio. Così la stessa sonda vale per le due famiglie — quelle che SONO il
 * comando (opzioni, fasce, sedi) e quella che lo contiene.
 */
const cardDiScelta = (controllo: Element) => controllo.closest('[class*="rounded-card"]')!

// ── WCAG §1.4.3 — il rapporto di contrasto fra due colori opachi ─────────────
const canale = (c: number) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}
const luminanza = (hex: string) => {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16))
  return 0.2126 * canale(r) + 0.7152 * canale(g) + 0.0722 * canale(b)
}
const contrasto = (a: string, b: string) => {
  const [x, y] = [luminanza(a), luminanza(b)]
  const [alto, basso] = x > y ? [x, y] : [y, x]
  return Math.round(((alto + 0.05) / (basso + 0.05)) * 100) / 100
}

// =============================================================================
describe('§1 · un campo sbagliato NON ha lo stesso aspetto di un campo giusto', () => {
  const nome: FormField = { id: 'nome', type: 'text', label: 'Nome', required: true }

  it('CONTROLLO POSITIVO: a riposo il contorno è quello di brand, non il rosso', () => {
    render(<Harness field={nome} />)
    const c = classi(screen.getByRole('textbox'))
    expect(c).toContain('border-kidville-green/15')
    expect(c).not.toContain('border-kidville-error')
  })

  it('in errore il contorno diventa `border-kidville-error` a 1,5px', async () => {
    render(<Harness field={nome} />)
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    await screen.findByText(itCampi.campoObbligatorio)

    const c = classi(screen.getByRole('textbox'))
    expect(c, 'il campo in errore non dichiara il rosso').toContain('border-kidville-error')
    expect(c).toContain('border-[1.5px]')
    // ⚠️ La sfumatura di brand deve SPARIRE, non affiancarsi: la regola dei
    // contorni deboli di `globals.css` aggancia `input[class*="border-kidville-green/"]`
    // e, se restasse, ridipingerebbe di grigio il rosso appena messo.
    expect(
      c.some((x) => x.startsWith('border-kidville-green/')),
      'il bordo di brand è rimasto accanto al rosso: globals.css lo sovrascrive',
    ).toBe(false)
  })

  it('il messaggio d\'errore è in peso 700 (il segnale che sopravvive all\'Alto Contrasto)', async () => {
    render(<Harness field={nome} />)
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    const msg = await screen.findByText(itCampi.campoObbligatorio)
    expect(classi(msg)).toContain('font-bold')
  })

  it('e in Alto Contrasto il campo in errore ha il bordo DOPPIO (globals.css)', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8')
    const blocco = css.match(
      /\[data-contrast="high"\] input\[aria-invalid="true"\][\s\S]{0,400}?\{([\s\S]*?)\}/,
    )
    expect(blocco, 'nessuna regola HC agganciata ad `aria-invalid`').toBeTruthy()
    expect(blocco![1]).toMatch(/border-style:\s*double/)
    // `double` sotto i 3px disegna una linea sola: la larghezza fa parte del segnale.
    const larghezza = blocco![1].match(/border-width:\s*(\d+)px/)
    expect(Number(larghezza?.[1] ?? 0)).toBeGreaterThanOrEqual(3)
  })
})

// =============================================================================
describe('§2 · un solo linguaggio di scelta: le opzioni sono card come le sedi', () => {
  const fasce: FormField = {
    id: 'fasce',
    type: 'checkbox',
    label: 'Fasce',
    options: [
      { label: 'Nido', value: 'nido' },
      { label: 'Infanzia', value: 'infanzia' },
    ],
  }
  const genere: FormField = {
    id: 'genere',
    type: 'radio',
    label: 'Genere',
    options: [
      { label: 'M', value: 'M' },
      { label: 'F', value: 'F' },
    ],
  }

  const card = (controllo: Element) => controllo.closest('label')!

  it.each([
    ['checkbox', fasce, 'Nido'],
    ['radio', genere, 'M'],
  ] as const)('%s: la card è bianca, a raggio di card, col controllo da 16px', (_tipo, field, etichetta) => {
    render(<Harness field={field} />)
    const controllo = screen.getByLabelText(etichetta)
    expect(classi(controllo)).toEqual(expect.arrayContaining(['h-4', 'w-4']))
    const c = classi(card(controllo))
    expect(c).toContain('rounded-card')
    expect(c).toContain('bg-kidville-white')
    expect(c, 'crema su crema: era il difetto').not.toContain('bg-kidville-cream')
  })

  it.each([
    ['checkbox', fasce, 'Nido'],
    ['radio', genere, 'M'],
  ] as const)('%s: spuntandola la card CAMBIA (fondo verde tenue, bordo verde, etichetta semigrassetta)', async (_tipo, field, etichetta) => {
    render(<Harness field={field} />)
    const controllo = screen.getByLabelText(etichetta)
    expect(classi(card(controllo))).toContain('border-kidville-neutral')

    fireEvent.click(controllo)

    await waitFor(() => {
      const c = classi(card(screen.getByLabelText(etichetta)))
      expect(c).toContain('bg-kidville-green-soft')
      expect(c).toContain('border-kidville-green')
    })
    expect(classi(screen.getByText(etichetta))).toContain('font-semibold')
  })

  it('checkbox: le opzioni NON scelte restano libere (lo stato è per-opzione, non per-gruppo)', async () => {
    render(<Harness field={fasce} />)
    fireEvent.click(screen.getByLabelText('Nido'))
    await waitFor(() =>
      expect(classi(screen.getByLabelText('Nido').closest('label')!)).toContain('bg-kidville-green-soft'),
    )
    expect(classi(screen.getByLabelText('Infanzia').closest('label')!)).toContain('bg-kidville-white')
  })
})

// =============================================================================
describe('§3 · un menu non compilato non sembra compilato', () => {
  const genere: FormField = {
    id: 'genere',
    type: 'select',
    label: 'Genere',
    options: [
      { label: 'Maschio', value: 'M' },
      { label: 'Femmina', value: 'F' },
    ],
  }

  it('vuoto → inchiostro `hint` (il grigio del suggerimento); scelto → verde del valore', async () => {
    render(<Harness field={genere} />)
    const select = screen.getByLabelText('Genere') as HTMLSelectElement
    expect(classi(select)).toContain('text-kidville-hint')
    expect(classi(select)).not.toContain('text-kidville-green')

    fireEvent.change(select, { target: { value: 'M' } })

    await waitFor(() => {
      const c = classi(screen.getByLabelText('Genere'))
      expect(c).toContain('text-kidville-green')
      expect(c).not.toContain('text-kidville-hint')
    })
  })

  it('i due inchiostri non convivono mai sullo stesso elemento (l\'ordine lo decide il foglio, non la stringa)', () => {
    render(<Harness field={genere} />)
    const c = classi(screen.getByLabelText('Genere'))
    expect(c.filter((x) => x === 'text-kidville-hint' || x === 'text-kidville-green')).toHaveLength(1)
  })

  it('…e la distinzione NON è solo cromatica: vuoto in corsivo, scelto tondo', async () => {
    // CONTROLLO POSITIVO dell'inchiostro di ieri: fra `sub` #55615C e il verde
    // dei valori #006A5F corrono 1,01:1 — due tinte, non due chiarezze — e in
    // Alto Contrasto convergono sullo stesso nero. Il colore oggi è `hint`
    // (misurato nel §6bis qui sotto), ma il corsivo resta e resta necessario:
    // è l'unico segnale che sopravvive dove il colore non c'è.
    expect(contrasto('#55615C', '#006A5F')).toBeLessThan(1.1)

    render(<Harness field={genere} />)
    expect(classi(screen.getByLabelText('Genere'))).toContain('italic')

    fireEvent.change(screen.getByLabelText('Genere'), { target: { value: 'M' } })

    await waitFor(() => {
      const c = classi(screen.getByLabelText('Genere'))
      expect(c).toContain('not-italic')
      expect(c).not.toContain('italic')
    })
  })
})

// =============================================================================
describe('§4 · il consenso: titolo e corpo sono due cose diverse', () => {
  const consenso: FormField = {
    id: 'privacy',
    type: 'consent',
    label: 'Informativa privacy',
    required: true,
    text: 'Autorizzo il trattamento dei dati personali per le finalità indicate nell\'informativa.',
  }

  it('il corpo usa un token che il rimappaggio pubblico NON appiattisce sul titolo', () => {
    render(<Harness field={consenso} />)
    const corpo = screen.getByText(/Autorizzo il trattamento/)
    const c = classi(corpo)
    // `.kv-public [class*="text-kidville-green/"]` porta OGNI alfa del verde a
    // #006A5F: titolo e corpo finivano identici. `sub` non è agganciato da
    // quella regola e resta distinto (5,82:1 su crema, 6,46:1 su bianco).
    expect(c).toContain('text-kidville-sub')
    expect(c.some((x) => x.startsWith('text-kidville-green/'))).toBe(false)
  })

  it('la riga del corpo è larga quanto DICHIARA: la misura è in rem, non in `ch`', () => {
    // `max-w-[60ch]` c'era, e prometteva «sotto i 78-80 caratteri». Misurato nel
    // browser a 1456px con un `Range` riga per riga: 85 · 86 · 87 · 75 · 74,
    // cioè un MASSIMO di 87 — più degli 82 che il vincolo doveva correggere.
    // `ch` è la larghezza dello ZERO, che in Maven Pro è più largo della
    // minuscola media: 60ch = 542,64px, e in 542,64px ci stanno 87 caratteri.
    // Un'unità che sembra parlare di caratteri e parla d'altro.
    render(<Harness field={consenso} />)
    const c = classi(screen.getByText(/Autorizzo il trattamento/))
    expect(
      c.some((x) => /^max-w-\[.*ch\]$/.test(x)),
      '`ch` non misura i caratteri: il vincolo va scritto in px/rem',
    ).toBe(false)
    expect(c).toContain('max-w-[29rem]')
  })

  it('il titolo è semigrassetto sul verde pieno', () => {
    render(<Harness field={consenso} />)
    const titolo = screen.getByText('Informativa privacy').closest('span')!
    expect(classi(titolo)).toContain('font-semibold')
  })

  it('spuntato, il consenso cambia aspetto come ogni altra scelta', async () => {
    render(<Harness field={consenso} />)
    const spunta = screen.getByRole('checkbox')
    expect(classi(cardDiScelta(spunta))).toContain('bg-kidville-white')
    fireEvent.click(spunta)
    await waitFor(() =>
      expect(classi(cardDiScelta(screen.getByRole('checkbox')))).toContain('bg-kidville-green-soft'),
    )
  })
})

// =============================================================================
// §4bis — IL NOME DELLA CASELLA È IL TITOLO. IL RESTO È UNA DESCRIZIONE.
//
// MISURATO il 12/08/2026 sul passo «Informativa e dichiarazioni» di
// `/anagrafica-personale`, con `label.textContent` sui tre consensi resi: il
// NOME ACCESSIBILE delle caselle era lungo 564 · 292 · 379 caratteri, perché la
// `<label>` avvolgeva titolo E corpo dell'informativa; il titolo ci compariva
// due volte; `aria-describedby` era null e `id` vuoto su tutte e tre. Chi
// ascolta si sentiva leggere l'informativa intera come «nome» del controllo,
// invece di «Ho letto l'informativa sulla privacy, casella di controllo,
// obbligatorio» — il nome è ciò che serve a decidere, e stava sepolto sotto la
// cosa su cui si decide.
//
// La stessa misura sulla MIRA: la `<label>` occupava 328×373 / 328×211 /
// 328×279 px contro una casella di 16×16 — fino a 477 volte l'area del
// controllo — e tutto quel testo era cliccabile: provare a selezionare una riga
// dell'informativa per rileggerla spuntava il consenso.
//
// È il componente CONDIVISO: il difetto valeva identico su `/iscrizione` e
// `/lavora-con-noi`, già in produzione.
// =============================================================================
describe('§4bis · il consenso: il nome è il titolo, il corpo è una descrizione', () => {
  const consenso: FormField = {
    id: 'privacy',
    type: 'consent',
    label: 'Ho letto l’informativa sulla privacy',
    required: true,
    text: 'Dichiaro di aver preso visione dell’informativa sul trattamento dei dati personali.',
  }

  it('il nome accessibile è il solo titolo (più l’asterisco), non l’informativa intera', () => {
    render(<Harness field={consenso} />)
    const spunta = screen.getByRole('checkbox')
    const nome = spunta.closest('label')!.textContent ?? ''
    expect(nome).toContain('Ho letto l’informativa sulla privacy')
    expect(nome, 'il corpo dell’informativa è tornato dentro il nome').not.toContain(
      'Dichiaro di aver preso visione',
    )
    // 564 caratteri era la misura del difetto: il titolo più l'asterisco ne fa 38.
    expect(nome.trim().length).toBeLessThan(80)
  })

  it('il corpo è agganciato come DESCRIZIONE, e il riferimento punta a qualcosa', () => {
    render(<Harness field={consenso} />)
    const spunta = screen.getByRole('checkbox')
    const rif = spunta.getAttribute('aria-describedby')
    expect(rif, 'nessun `aria-describedby`: il corpo non è descrizione di niente').toBeTruthy()
    const bersagli = rif!.split(/\s+/).map((id) => document.getElementById(id))
    expect(bersagli.every(Boolean), '`aria-describedby` punta nel vuoto').toBe(true)
    expect(bersagli.map((n) => n!.textContent).join(' ')).toContain('Dichiaro di aver preso visione')
  })

  it('l’obbligatorietà è detta anche a chi l’asterisco non lo vede', () => {
    render(<Harness field={consenso} />)
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-required', 'true')
  })

  it('il corpo NON è più dentro la `<label>`: leggerlo e selezionarlo non spunta niente', () => {
    render(<Harness field={consenso} />)
    const corpo = screen.getByText(/Dichiaro di aver preso visione/)
    expect(corpo.closest('label'), 'il corpo è di nuovo un bersaglio che spunta').toBeNull()
    // La card resta la card — stesso disegno — ma non è più il comando: senza
    // questo, il dito a freccia continuerebbe a promettere un clic che non c'è.
    expect(classi(cardDiScelta(screen.getByRole('checkbox')))).not.toContain('cursor-pointer')
  })

  it('la riga del titolo è un bersaglio da 24px in su (WCAG 2.2 §2.5.8)', () => {
    render(<Harness field={consenso} />)
    const riga = screen.getByRole('checkbox').closest('label')!
    const c = classi(riga)
    expect(c).toContain('cursor-pointer')
    // 20px di interlinea + `py-1.5` due volte = 32px; `-my-1.5` li restituisce al
    // flusso, quindi il bersaglio cresce e l'impaginazione non si muove.
    expect(c).toContain('py-1.5')
    expect(c).toContain('-my-1.5')
  })

  it('spuntandolo dal titolo il consenso si accende (la label è ancora la label)', async () => {
    render(<Harness field={consenso} />)
    fireEvent.click(screen.getByText('Ho letto l’informativa sulla privacy'))
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked())
  })
})

// =============================================================================
// §5 — Il fuoco arriva anche dentro un `Controller`.
//
// Misura dell'11/08/2026: al passo dei consensi, premendo «Avanti» senza la
// spunta obbligatoria il fuoco restava sul bottone; al passo 2 andava
// correttamente sul primo campo. Causa: `FieldRenderer` non passava `rhf.ref`
// all'elemento disegnato dentro `Controller`, quindi il nodo non entrava nel
// registro di RHF e `setFocus()` non aveva niente da mettere a fuoco.
// =============================================================================
describe('§5 · `setFocus` raggiunge i controlli disegnati dentro `Controller`', () => {
  // `setFocus` mette a fuoco dentro un `setTimeout` (sorgente RHF 7.76): senza
  // `waitFor` la sonda misurerebbe l'istante prima, e direbbe sempre di no.
  it('consenso: il fuoco va sulla spunta', async () => {
    render(<Harness field={{ id: 'privacy', type: 'consent', label: 'Informativa', required: true }} />)
    fireEvent.click(screen.getByRole('button', { name: /fuoco/i }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('checkbox')))
  })

  it('gruppo di caselle: il fuoco va sulla PRIMA opzione', async () => {
    render(
      <Harness
        field={{
          id: 'fasce',
          type: 'checkbox',
          label: 'Fasce',
          options: [
            { label: 'Nido', value: 'nido' },
            { label: 'Infanzia', value: 'infanzia' },
          ],
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /fuoco/i }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Nido')))
  })

  it('caricamento: il fuoco va sull’input del FILE — che fino al 12/08/2026 non lo prendeva', async () => {
    // ⚠️ QUESTO COLLAUDO ERA IL CONTRARIO, e diceva la verità di allora: «dove il
    // `ref` non arriva, il fuoco NON si sposta», col campo `file` come esempio.
    // Era l'ultimo tipo rimasto senza `ref`, ed era anche l'unico il cui controllo
    // stava a `display:none` — cioè fuori dalla tastiera e fuori dall'albero di
    // accessibilità. MISURATO sul passo «Documento d'identità» di
    // `/anagrafica-personale`: premendo «Avanti» con la SOLA scansione mancante,
    // `document.activeElement` restava sul campo precedente (valido), `scrollY` 0,
    // e il giro del Tab non si fermava mai sul caricamento.
    // Ora l'input è `sr-only` e porta `ref`/`id`: il fuoco ci arriva, e con lui
    // chi compila.
    render(<Harness field={{ id: 'doc', type: 'file', label: 'Documento' }} />)
    fireEvent.click(screen.getByRole('button', { name: /fuoco/i }))
    const input = document.querySelector('input[type="file"]')
    expect(input).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(input))
  })

  it('CONTROLLO POSITIVO: su un blocco senza controlli il fuoco NON si sposta', async () => {
    // Serve a dimostrare che i tre `expect` qui sopra non passerebbero comunque,
    // qualunque cosa faccia `setFocus`. Il soggetto è un `paragraph`: un blocco
    // che non rende nessun controllo, quindi non è registrato e non ha `ref` —
    // che è la situazione in cui stavano consenso, caselle e file prima delle
    // correzioni dell'11 e del 12/08/2026.
    render(<Harness field={{ id: 'nota', type: 'paragraph', label: 'Una nota' }} />)
    const bottone = screen.getByRole('button', { name: /fuoco/i })
    fireEvent.click(bottone)
    await new Promise((r) => setTimeout(r, 0))
    expect(document.querySelector('input')).toBeNull()
    expect(document.activeElement).not.toBe(document.querySelector('input'))
  })
})

// =============================================================================
describe('§6 · il segnaposto ha un segnale NON cromatico (corsivo)', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8')

  it('`.kv-public ::placeholder` è in corsivo', () => {
    const blocco = css.match(/\.kv-public ::placeholder\s*\{([^}]*)\}/)
    expect(blocco, 'la regola pubblica del segnaposto non c\'è più').toBeTruthy()
    expect(blocco![1]).toMatch(/font-style:\s*italic/)
  })

  it('…e in Alto Contrasto vale ovunque, perché là il colore non distingue niente', () => {
    const blocco = css.match(/\[data-contrast="high"\] ::placeholder\s*\{([^}]*)\}/)
    expect(blocco, 'nessuna regola HC generale sul segnaposto').toBeTruthy()
    expect(blocco![1]).toMatch(/font-style:\s*italic/)
  })

  it('in Alto Contrasto il segnaposto NON è lo stesso nero del valore digitato', () => {
    // Il difetto che questo lock chiude: `[data-contrast="high"] .kv-public
    // ::placeholder` portava il segnaposto a #000000, cioè al nero del valore.
    // 21:1 tutti e due sul bianco, 1,00:1 fra loro: un campo obbligatorio vuoto
    // aveva l'aspetto di un campo compilato, e restava un segnale solo (il
    // corsivo) proprio nella modalità pensata per chi ci vede peggio.
    const blocco = css.match(/\[data-contrast="high"\] \.kv-public ::placeholder\s*\{([^}]*)\}/)
    expect(blocco, 'nessuna regola HC del segnaposto pubblico').toBeTruthy()
    const colore = blocco![1].match(/color:\s*(#[0-9A-Fa-f]{6})/)?.[1]
    expect(colore, 'il colore del segnaposto HC non è un hex leggibile').toBeTruthy()
    // Il VALORE in Alto Contrasto è nero pieno (blocco «2 · L'inchiostro»).
    expect(contrasto(colore!, '#000000'), `${colore} contro il valore nero`).toBeGreaterThanOrEqual(3)
    // …e resta comunque testo: 1.4.3 chiede 4,5:1 sulla carta, che qui è bianca.
    expect(contrasto(colore!, '#FFFFFF'), `${colore} sulla carta bianca`).toBeGreaterThanOrEqual(4.5)
  })

  it('il commento che sosteneva il contrario è stato corretto insieme al codice', () => {
    // Il repo ha già pagato una volta il prezzo di un documento che descriveva
    // una protezione inesistente. La frase «il segnaposto continua a leggersi
    // come suggerimento, non come contenuto» diceva il falso: fra `sub` e il
    // verde dei valori corrono 1,01:1, e in Alto Contrasto 1,00:1. Il blocco che
    // la conteneva ora RIPORTA la misura, e questo lock impedisce che la si
    // cancelli lasciando in piedi l'affermazione.
    const blocco = css.slice(css.indexOf('Il SEGNAPOSTO dei campi pubblici'), css.indexOf('.kv-public ::placeholder'))
    expect(blocco, 'la misura che smentisce la frase non è più scritta accanto alla regola').toContain('1,01:1')
    expect(blocco).toContain('1,00:1')
  })
})

// =============================================================================
// §6bis · IN LUCE NORMALE IL COLORE C'È, E VA USATO (11/08/2026).
//
// La prima riparazione aveva aggiunto il CORSIVO e si era fermata lì: misurato
// prima e dopo, il segnaposto contro il valore restava a 1,01:1 in luce normale
// (e 1,00:1 in Alto Contrasto). Il paradosso: in Alto Contrasto — dove il colore
// «non è disponibile» — il segnaposto era stato separato dal valore (#595959,
// 3,00:1), mentre in luce normale, dove il colore c'è tutto, no.
//
// Questo blocco fissa il rimedio cromatico con i NUMERI, non con l'aggettivo
// «più chiaro» che aveva già mentito una volta: il token del segnaposto tiene
// AA sul fondo vero dei campi e si stacca dal valore digitato — e il test
// dimostra anche PERCHÉ la soglia dello stacco non può essere più alta.
// =============================================================================
describe('§6bis · il segnaposto ha una chiarezza sua, e regge comunque sul fondo', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8')
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src/components/features/forms/FieldRenderer.tsx'),
    'utf8',
  )
  const codice = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '')

  const token = (nome: string) =>
    css.match(new RegExp(`--color-kidville-${nome}:\\s*(#[0-9A-Fa-f]{6})`))?.[1]

  const BIANCO = '#FFFFFF' // `bg-kidville-white`: il fondo VERO di ogni campo
  const CREMA = '#FEF1E4' // il fondo della pagina, sotto le carte
  const VALORE = '#006A5F' // `text-kidville-green`: l'inchiostro del digitato

  it('il token del segnaposto esiste ed è dichiarato in `@theme inline`', () => {
    expect(token('hint'), '`--color-kidville-hint` non è dichiarato in globals.css').toMatch(
      /^#[0-9A-Fa-f]{6}$/,
    )
  })

  it('CONTROLLO POSITIVO: l\'inchiostro di ieri era indistinguibile dal valore', () => {
    // `sub` è ineccepibile sul FONDO (6,46:1) e inutile contro il VALORE: sono
    // due misure diverse, ed è la confusione fra le due che aveva prodotto la
    // frase falsa nel commento di `globals.css`.
    expect(contrasto(token('sub')!, BIANCO)).toBeGreaterThanOrEqual(4.5)
    expect(contrasto(token('sub')!, VALORE)).toBeLessThan(1.05)
  })

  it('sul fondo vero dei campi (bianco) e sul crema della pagina regge AA', () => {
    expect(contrasto(token('hint')!, BIANCO), `${token('hint')} sul bianco del campo`).toBeGreaterThanOrEqual(4.5)
    expect(contrasto(token('hint')!, CREMA), `${token('hint')} sul crema della pagina`).toBeGreaterThanOrEqual(4.5)
  })

  it('…e dal valore digitato si stacca davvero (1,28:1 contro 1,01:1)', () => {
    expect(contrasto(token('hint')!, VALORE)).toBeGreaterThanOrEqual(1.25)
    // La chiarezza L* è la misura che descrive quel che si vede: fra `sub` e il
    // valore c'erano 0,2 punti, ora sono 6,7.
    const lstar = (hex: string) => {
      const y = luminanza(hex)
      return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y
    }
    expect(Math.abs(lstar(token('sub')!) - lstar(VALORE))).toBeLessThan(1)
    expect(Math.abs(lstar(token('hint')!) - lstar(VALORE))).toBeGreaterThan(5)
  })

  it('la soglia dello stacco NON è timida: 1,45:1 è il massimo che il fondo consente', () => {
    // Il valore sta a 6,51:1 dal bianco. Un inchiostro che debba restare a
    // ≥4,5:1 dallo STESSO bianco non può allontanarsene di più: il colore a
    // 4,5:1 esatti ha luminanza 1,05/4,5 − 0,05, e il rapporto col valore è
    // quello che segue. Chiedere 3:1 fra i due inchiostri, come si fa fra un
    // testo e il suo fondo, significherebbe pretendere un segnaposto sotto
    // soglia — cioè illeggibile, che è il difetto peggiore dei due.
    const massimo = (1.05 / 4.5) / (luminanza(VALORE) + 0.05)
    expect(Math.round(massimo * 100) / 100).toBe(1.45)
    expect(contrasto(token('hint')!, VALORE)).toBeLessThanOrEqual(1.45)
  })

  it('il componente scrive il token, non più l\'alfa del verde (1,92:1 su bianco)', () => {
    expect(codice).not.toContain('placeholder-kidville-green/40')
    expect(codice).toContain('placeholder-kidville-hint')
    // Il secondo segnale viaggia col CAMPO, non con la superficie: la regola del
    // corsivo di `globals.css` è scopata a `.kv-public`, e misurata fuori di lì
    // (moduli in-app, dove scrivono famiglie e segreteria) il segnaposto tornava
    // `font-style: normal`. Stesso componente, due trattamenti.
    expect(codice).toContain('placeholder:italic')
    // Il menu a tendina è lo stesso caso senza `::placeholder`: l'opzione non
    // ancora scelta usa lo stesso inchiostro del segnaposto.
    expect(codice).toContain('text-kidville-hint')
  })

  it('la regola pubblica del segnaposto legge quel token, e in HC ha il suo hex', () => {
    const pubblica = css.match(/\.kv-public ::placeholder\s*\{([^}]*)\}/)
    expect(pubblica![1]).toContain('var(--color-kidville-hint)')
    // In Alto Contrasto il token NON si ribalta (vive su carta bianca anche là):
    // la regola dedicata porta il segnaposto a #595959, che è già misurato nel §6.
    const hc = css.match(/\[data-contrast="high"\] \.kv-public ::placeholder\s*\{([^}]*)\}/)
    expect(hc![1]).toMatch(/color:\s*#/)
  })

  it('il commento accanto alla regola porta i numeri NUOVI, non solo quelli vecchi', () => {
    // Stessa ragione del lock del §6: un commento che descrive una protezione
    // inesistente è peggio di nessun commento. Qui si pretende che accanto alla
    // regola ci siano le misure di OGGI, quelle che chiunque può rifare.
    const blocco = css.slice(
      css.indexOf('Il SEGNAPOSTO dei campi pubblici'),
      css.indexOf('.kv-public ::placeholder'),
    )
    expect(blocco, 'manca il rapporto sul fondo vero del campo').toContain('5,08:1')
    expect(blocco, 'manca il rapporto col valore digitato').toContain('1,28:1')
    expect(blocco, 'manca il tetto che rende quella misura leggibile').toContain('1,45:1')
  })
})

// =============================================================================
describe('§7 · debito di token: i campi non scrivono più valori generici', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src/components/features/forms/FieldRenderer.tsx'),
    'utf8',
  )
  // Il sorgente senza commenti: la prosa cita i nomi vecchi per spiegarli.
  const codice = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '')

  it('`rounded-xl` (12px per coincidenza) è stato sostituito da `rounded-input`/`rounded-card`', () => {
    expect(codice).not.toContain('rounded-xl')
    expect(codice).toContain('rounded-input')
  })

  it('`bg-white` è stato sostituito dal token `bg-kidville-white`', () => {
    expect(codice).not.toMatch(/\bbg-white\b/)
    expect(codice).toContain('bg-kidville-white')
  })

  it('nessun colore fuori dalla palette del tema (niente `text-gray-*`)', () => {
    expect(codice).not.toMatch(/\b(?:text|bg|border)-gray-\d{3}\b/)
  })
})

// =============================================================================
// §8 — Il fuoco disegna UNA linea sola, e l'errore non se ne va.
//
// Misurato nel browser sul passo 2 di `/lavora-con-noi` (11/08/2026):
//  · campo a fuoco → `outline: 2px solid rgb(0,106,95)` + `box-shadow:
//    rgb(255,255,255) 0 0 0 2px` + `border-top: 1px rgb(0,106,95)`: due linee
//    verdi di pari peso separate da un filo bianco, cioè una linea sdoppiata;
//  · campo in errore E a fuoco → `border-top: 1.5px rgb(0,106,95)`, mentre lo
//    stesso campo in errore e non a fuoco è `1.5px rgb(229,57,53)`. Il rosso
//    spariva proprio mentre lo si stava ricorreggendo.
// Una `focus:border-*` scritta nel pezzo COMUNE vince sul bordo di STATO scritto
// nel pezzo suo: la cura è togliere il fuoco dalla struttura, non aggiungere
// eccezioni all'errore.
// =============================================================================
describe('§8 · il fuoco non ridipinge il campo (e non cancella l\'errore)', () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), 'src/components/features/forms/FieldRenderer.tsx'),
    'utf8',
  )
  const codice = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '')
  const nome: FormField = { id: 'nome', type: 'text', label: 'Nome', required: true }

  it('la STRUTTURA non dichiara più nessun bordo di fuoco (era il verde n. 2)', () => {
    expect(codice).not.toMatch(/focus:border-kidville-green/)
    // …e nemmeno l'anello che non ha mai disegnato niente: `globals.css` mette
    // `box-shadow: 0 0 0 2px #FFFFFF` su `:focus-visible`, non-layered, e
    // sostituisce l'ombra della utility. Misurato: `rgb(255,255,255) 0 0 0 2px`.
    expect(codice).not.toMatch(/focus:ring-kidville-green/)
  })

  it('il contorno al fuoco è DICHIARATO, non lasciato cadere sulla utility grezza', () => {
    // La regola dei contorni deboli di `globals.css` si sfila con `:not(:focus)`:
    // senza una `focus:border-*`, al fuoco il bordo tornerebbe a
    // `border-kidville-green/15` = #D9E9E7, 1,25:1 — misurato con una sonda
    // nella pagina vera. `sub` #55615C tiene 6,46:1 sul bianco del campo.
    render(<Harness field={nome} />)
    expect(classi(screen.getByRole('textbox'))).toContain('focus:border-kidville-sub')
    expect(contrasto('#55615C', '#FFFFFF')).toBeGreaterThanOrEqual(3)
    expect(contrasto('#55615C', '#FEF1E4')).toBeGreaterThanOrEqual(3)
  })

  it('il campo in ERRORE non porta nessun bordo di fuoco: il rosso resta rosso', async () => {
    render(<Harness field={nome} />)
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    await screen.findByText(itCampi.campoObbligatorio)
    const c = classi(screen.getByRole('textbox'))
    expect(c).toContain('border-kidville-error')
    expect(
      c.some((x) => x.startsWith('focus:border-')),
      'una `focus:border-*` sul campo in errore lo ridipinge appena lo si tocca',
    ).toBe(false)
  })

  it('CONTROLLO POSITIVO: fuori dall\'errore la `focus:border-*` c\'è (non è sparita per sbaglio)', () => {
    render(<Harness field={{ id: 'note', type: 'textarea', label: 'Note' }} />)
    expect(
      classi(screen.getByRole('textbox')).some((x) => x.startsWith('focus:border-')),
    ).toBe(true)
  })
})

// =============================================================================
// §9 — «Leggi l'informativa completa»: un bersaglio, non una postilla.
//
// Era un `<a>` alto 16px DENTRO la <label> che spunta il consenso: un pollice
// che lo manca colpisce un bersaglio alto 325px che fa un'altra cosa. WCAG 2.2
// §2.5.8 chiede 24×24px e qui non vale l'eccezione «inline» (sta su una riga
// sua) né quella di spaziatura (il cerchio da 24px ricade dentro la card del
// consenso). È anche l'unica via verso l'informativa su un modulo che raccoglie
// dati personali — e nel guscio Capacitor `target="_blank"` significa «esci
// dall'app» (R25, già chiuso sullo stesso testo in `ComunicaAssenzaCard`).
// =============================================================================
describe('§9 · il collegamento all\'informativa è fuori dalla label e si può centrare', () => {
  const consenso: FormField = {
    id: 'privacy',
    type: 'consent',
    label: 'Informativa privacy',
    required: true,
    text: 'Testo del consenso.',
    link: '/privacy',
    link_label: 'Leggi l’informativa completa',
  }

  it('non sta più dentro la <label> del consenso (né come HTML valido, né come mira)', () => {
    render(<Harness field={consenso} />)
    const a = screen.getByRole('link', { name: /informativa completa/i })
    expect(a.closest('label'), 'un `<a>` dentro `<label>` è anche fuori specifica HTML').toBeNull()
    // Il bersaglio resta 44px, sopra i 24 di WCAG 2.2 §2.5.8 — ma da DOVE arrivano
    // quei 44 è cambiato due volte in un giorno, e la seconda è quella buona.
    // Con `text-sm` (riga 20px) li faceva `py-3`; con `text-xs` (riga 16) li
    // faceva `py-3.5`, riempimento nel flusso più un `-mt-3.5` a pagarlo. Poi il
    // hit-test ha detto che di quei 44 ne arrivavano 38, perché il testo del
    // vicino di sopra si dipinge dopo un box di blocco non posizionato e gli passa
    // davanti. Ora l'ingrandimento è uno `::before` assoluto su un elemento
    // `relative`: fuori dal flusso (nessun contenitore da accordare) e dipinto in
    // fase 8 (nessun vicino che glielo rubi). MISURATO dopo: 44 su 44, in questo
    // ramo come in quello di campo. Il dettaglio sta in §12 (i).
    const c = classi(a)
    expect(c).toContain('relative')
    expect(c).toContain('before:-inset-y-3.5')
    expect(c).toContain('text-xs')
  })

  /*
   * ── E NON PESA PIÙ DI CIÒ CHE ACCOMPAGNA (25/08/2026) ─────────────────────
   *
   * MISURATO nella pagina viva, passo 3 di `/lavora-con-noi` a 900 px, prima della
   * correzione: il collegamento era 14px / peso 500 / #006A5F / sottolineato —
   * cioè la resa esatta dell'ETICHETTA del campo («Curriculum *», 14px / 500 /
   * #006A5F) più una sottolineatura e un'icona — e più GRANDE del messaggio
   * d'errore (12px / 700). Nell'unico campo che blocca il passo, un rimando legale
   * a piè di campo urlava più forte del campo e della ragione per cui non si
   * prosegue.
   *
   * Si assertisce la PROPRIETÀ, non la stringa: il collegamento non deve portare
   * la taglia dell'etichetta né il suo peso. Il verso positivo (`text-xs`) sta nel
   * test qui sopra; qui c'è il divieto, che è la metà che regge se domani qualcuno
   * «riallinea» il link all'etichetta.
   */
  it('il collegamento NON ha la taglia né il peso di un\'etichetta di campo', () => {
    render(<Harness field={consenso} />)
    const c = classi(screen.getByRole('link', { name: /informativa completa/i }))
    expect(c, 'il link è tornato alla taglia dell\'etichetta (14px)').not.toContain('text-sm')
    expect(c, 'il link è tornato al peso dell\'etichetta (500)').not.toContain('font-medium')
    // La sottolineatura resta: è l'affordance, e senza colore non basterebbe il verde.
    expect(c).toContain('underline')
  })

  /*
   * ── L'ERRORE STA PRIMA DEL LINK, QUI COME NEL RAMO GENERICO (25/08/2026) ──
   *
   * Lo stesso componente rendeva la coppia «collegamento + messaggio d'errore» in
   * ordine OPPOSTO nei suoi due rami: sul consenso l'errore sotto il link, sul
   * curriculum sopra. Due passi dello stesso wizard, lo stesso `/privacy`, lo
   * stesso `role="alert"`, due impaginazioni. Un sistema di design ha una risposta
   * sola alla domanda «dove va il messaggio d'errore rispetto al resto della
   * pila», e quella giusta è: il più vicino possibile al controllo.
   */
  it('in errore il messaggio viene PRIMA del collegamento, come nel ramo generico', async () => {
    render(<Harness field={consenso} />)
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    const messaggio = await screen.findByRole('alert')
    const collegamento = screen.getByRole('link', { name: /informativa completa/i })
    expect(
      messaggio.compareDocumentPosition(collegamento) & Node.DOCUMENT_POSITION_FOLLOWING,
      'il collegamento all\'informativa precede ancora il messaggio d\'errore',
    ).toBeTruthy()
    // E resta fuori dalla <label>: spostarlo non doveva rimetterlo dentro il bersaglio.
    expect(collegamento.closest('label')).toBeNull()
  })

  it('cliccarlo NON spunta più niente: non c\'è nessun `stopPropagation` da ricordarsi', () => {
    render(<Harness field={consenso} />)
    const spunta = screen.getByRole('checkbox') as HTMLInputElement
    expect(spunta.checked).toBe(false)
    fireEvent.click(screen.getByRole('link', { name: /informativa completa/i }))
    expect(spunta.checked, 'il collegamento ha spuntato il consenso').toBe(false)
  })

  it('un indirizzo INTERNO passa da `LinkInterno` (nel guscio nativo non si esce dall\'app)', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/components/features/forms/FieldRenderer.tsx'),
      'utf8',
    )
    const codice = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '')
    expect(codice).toContain('LinkInterno')
    // Sul web resta una scheda nuova: il modulo compilato non si perde.
    render(<Harness field={consenso} />)
    expect(screen.getByRole('link', { name: /informativa completa/i }).getAttribute('target')).toBe('_blank')
  })
})

// =============================================================================
// §10 — Un GRUPPO in errore non ha l'aspetto di un gruppo valido.
//
// Il difetto è quello di §1, sopravvissuto nei gruppi a spunta. MISURATO nella
// pagina viva (passo 3 di `/lavora-con-noi`, fasce d'età svuotate, «Avanti»
// premuto): le tre card `border-top-color: rgb(138,149,143)`, `border-top-width:
// 1px` — cioè lo stato di riposo, identico a tre card mai toccate — mentre il
// messaggio, il fuoco e `aria-invalid` c'erano tutti. L'errore era detto a chi
// ascolta e taciuto a chi guarda.
// =============================================================================
describe('§10 · il gruppo obbligatorio vuoto lo dice anche sulle card', () => {
  const fasce: FormField = {
    id: 'fasce',
    type: 'checkbox',
    label: 'Fasce',
    required: true,
    options: [
      { label: 'Nido', value: 'nido' },
      { label: 'Infanzia', value: 'infanzia' },
    ],
  }
  const genere: FormField = {
    id: 'genere',
    type: 'radio',
    label: 'Genere',
    required: true,
    options: [
      { label: 'M', value: 'M' },
      { label: 'F', value: 'F' },
    ],
  }
  const consenso: FormField = {
    id: 'privacy',
    type: 'consent',
    label: 'Informativa privacy',
    required: true,
  }
  const card = cardDiScelta
  /** Il consenso ha una casella sola e il nome accessibile porta anche l'asterisco. */
  const primoControllo = (tipo: string) =>
    tipo === 'consenso' ? screen.getByRole('checkbox') : screen.getAllByRole(tipo === 'radio' ? 'radio' : 'checkbox')[0]

  it.each([
    ['caselle', fasce],
    ['radio', genere],
    ['consenso', consenso],
  ] as const)('%s: dopo «Avanti» le card non scelte prendono il rosso a 1,5px', async (tipo, field) => {
    render(<Harness field={field} />)
    // CONTROLLO POSITIVO: a riposo il contorno è quello di una card libera.
    expect(classi(card(primoControllo(tipo)))).toContain('border-kidville-neutral')

    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    await screen.findByRole('alert')

    const c = classi(card(primoControllo(tipo)))
    expect(c, 'la card di un gruppo in errore è identica a una valida').toContain('border-kidville-error')
    expect(c).toContain('border-[1.5px]')
    expect(c, 'il grigio di riposo è rimasto accanto al rosso').not.toContain('border-kidville-neutral')
    // Il peso del bordo fa parte dello stato: `border` (1px) e `border-[1.5px]`
    // sullo stesso elemento si risolvono nell'ordine del FOGLIO, non della stringa.
    expect(c).not.toContain('border')
  })


  /*
   * L'OBBLIGO DI UN GRUPPO STA SUL GRUPPO — E I DUE GRUPPI NON LO DICHIARANO
   * ALLO STESSO MODO, PERCHÉ ARIA NON LO PERMETTE.
   *
   * ⚠️ REGRESSIONE MISURATA IL 2026-08-25, nata il giorno prima. Per dare
   * `aria-required` al curriculum obbligatorio di `/lavora-con-noi`, l'attributo
   * era stato messo nell'oggetto CONDIVISO `ariaProps` di `FieldRenderer` — «una
   * riga sola, vale per tutti i campi». Vale per tutti i campi e non per tutti i
   * CONTROLLI: `ariaProps` viene sparso su OGNI opzione dentro i `map` dei due
   * gruppi, quindi tutte e sette le caselle di «Per quali posizioni ti proponi»
   * dichiaravano `aria-required="true"`. Su `role="checkbox"` quell'attributo
   * significa «questa casella va spuntata»: il modulo diceva a chi ascolta che
   * andavano spuntate tutte e sette, mentre ne basta una.
   *
   * I due gruppi si correggono in modo DIVERSO, e la differenza è nella specifica:
   *   · `radiogroup` AMMETTE `aria-required` (ARIA 1.2, «Supported States and
   *     Properties») → l'obbligo va lì, e NON sulle singole radio;
   *   · `group` NON lo ammette → sul gruppo a spunta l'attributo non va da nessuna
   *     parte, e l'obbligo continua ad arrivare dall'asterisco dentro il NOME del
   *     gruppo (`aria-labelledby` punta la <label> che lo stampa) e dal messaggio
   *     d'errore. Metterlo sul `role="group"` scambierebbe un difetto semantico con
   *     una violazione formale, che `axe` segnala come `aria-allowed-attr`.
   *
   * ⚠️ `jest-axe` NON VEDE il difetto originale: `aria-required` su `role="checkbox"`
   * è consentito. Per questo le asserzioni sono scritte a mano, e stanno QUI — sul
   * renderer generico — e non solo sul modulo delle candidature: il difetto tocca
   * ogni modulo guidato da template, `gradi` di `personale-template.ts` compreso.
   */
  it('il `radiogroup` porta `aria-required`, il `role="group"` no, e nessuna OPZIONE lo porta mai', async () => {
    // ── Scelta multipla: `role="group"`, dove ARIA non ammette l'attributo ─────
    render(<Harness field={fasce} />)
    const gruppo = screen.getByRole('group')
    expect(
      gruppo,
      '`aria-required` non è ammesso su `role="group"`: sarebbe una violazione `aria-allowed-attr`',
    ).not.toHaveAttribute('aria-required')
    for (const casella of screen.getAllByRole('checkbox')) {
      expect(
        casella,
        'una casella del gruppo si dichiara obbligatoria: a chi ascolta il modulo chiede di spuntarle TUTTE',
      ).not.toHaveAttribute('aria-required')
    }
    // L'obbligo arriva lo stesso: sta nel NOME del gruppo.
    expect(gruppo).toHaveAccessibleName(/Fasce\s*\*/)
    cleanup()

    // ── Scelta singola: `radiogroup`, che l'attributo lo ammette ───────────────
    render(<Harness field={genere} />)
    const radiogruppo = screen.getByRole('radiogroup')
    expect(
      radiogruppo,
      'il gruppo a scelta singola non dichiara di essere obbligatorio',
    ).toHaveAttribute('aria-required', 'true')
    for (const opzione of screen.getAllByRole('radio')) {
      expect(
        opzione,
        'l’obbligo è ripetuto su ogni opzione: su un `radiogroup` lo porta il gruppo',
      ).not.toHaveAttribute('aria-required')
    }
    cleanup()

    // ── CONTROLLO NEGATIVO: un gruppo FACOLTATIVO non lo porta ────────────────
    // Senza, «toglierlo sempre» passerebbe l'asserzione qui sopra.
    render(<Harness field={{ ...genere, required: false }} />)
    expect(
      screen.getByRole('radiogroup'),
      'un gruppo facoltativo si dichiara obbligatorio: il segnale non distingue più niente',
    ).not.toHaveAttribute('aria-required')
  })

  /*
   * E LA NOTA DEL GRUPPO SI ANNUNCIA UNA VOLTA SOLA.
   *
   * `notaId` è nato il 2026-08-24 dentro lo stesso `ariaProps`, quindi finiva su
   * ogni opzione: la nota di «posizioni» («Puoi sceglierne più d'una…») si
   * annunciava SETTE volte, una per casella, e il contenitore — che è il posto in
   * cui una descrizione del gruppo appartiene — non la portava affatto. Alle
   * opzioni resta il solo messaggio d'errore, che è ciò che portavano prima del
   * 24/08 e che va ripetuto: è la risposta alla domanda «perché questo è rosso?».
   */
  it('la nota di un gruppo sta sul GRUPPO, non su ognuna delle opzioni', async () => {
    // `fasce-nota` non si passa più: lo deriva il renderer da `field.id`.
    render(<Harness field={fasce} nota="Puoi sceglierne più d’una" />)
    const gruppo = screen.getByRole('group')
    expect(gruppo.getAttribute('aria-describedby'), 'la nota non è agganciata al gruppo').toBe('fasce-nota')
    for (const casella of screen.getAllByRole('checkbox')) {
      expect(
        casella.getAttribute('aria-describedby') ?? '',
        'la nota del gruppo si annuncia una volta per casella',
      ).not.toContain('fasce-nota')
    }

    // In errore: il gruppo dice errore + nota, in quest'ordine; le opzioni il solo
    // errore — perché è ciò che spiega il rosso su QUELLA card.
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    await screen.findByRole('alert')
    expect(gruppo.getAttribute('aria-describedby')).toBe('fasce-error fasce-nota')
    for (const casella of screen.getAllByRole('checkbox')) {
      expect(casella.getAttribute('aria-describedby')).toBe('fasce-error')
    }
  })

  it('la card GIÀ spuntata resta verde: l\'errore è del gruppo vuoto, non della scelta fatta', async () => {
    render(<Harness field={fasce} />)
    fireEvent.click(screen.getByLabelText('Nido'))
    await waitFor(() =>
      expect(classi(card(screen.getByLabelText('Nido')))).toContain('bg-kidville-green-soft'),
    )
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))

    const scelta = classi(card(screen.getByLabelText('Nido')))
    expect(scelta).toContain('border-kidville-green')
    expect(scelta).not.toContain('border-kidville-error')
  })

  it('spuntando, il rosso se ne va da tutte (il gruppo torna valido)', async () => {
    render(<Harness field={fasce} />)
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    await screen.findByRole('alert')
    expect(classi(card(screen.getByLabelText('Infanzia')))).toContain('border-kidville-error')

    fireEvent.click(screen.getByLabelText('Nido'))

    await waitFor(() =>
      expect(classi(card(screen.getByLabelText('Infanzia')))).not.toContain('border-kidville-error'),
    )
  })

  it('in Alto Contrasto il rosso sparisce, e la card in errore porta il marcatore che la salva', async () => {
    // `.kv-public [class*="border-kidville-"]` porta ogni contorno a #000000:
    // là il colore non distingue più niente, e serve il secondo segnale.
    render(<Harness field={fasce} />)
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    await screen.findByRole('alert')
    expect(card(screen.getByLabelText('Nido')).getAttribute('data-scelta-invalida')).toBe('true')

    const css = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8')
    const blocco = css.match(
      /\[data-contrast="high"\] \[data-scelta-invalida="true"\]\s*\{([^}]*)\}/,
    )
    expect(blocco, 'nessuna regola HC agganciata a `data-scelta-invalida`').toBeTruthy()
    expect(blocco![1]).toMatch(/border-style:\s*double/)
    const larghezza = blocco![1].match(/border-width:\s*(\d+)px/)
    expect(Number(larghezza?.[1] ?? 0)).toBeGreaterThanOrEqual(3)
  })

  it('il marcatore NON compare sulla card scelta né su un gruppo valido', async () => {
    render(<Harness field={fasce} />)
    expect(card(screen.getByLabelText('Nido')).hasAttribute('data-scelta-invalida')).toBe(false)
    fireEvent.click(screen.getByLabelText('Nido'))
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    await waitFor(() =>
      expect(card(screen.getByLabelText('Nido')).hasAttribute('data-scelta-invalida')).toBe(false),
    )
  })

  it('il rosso della card è lo STESSO del campo di testo in errore, e regge sul bianco', () => {
    // `--color-kidville-error` #E53935: 4,23:1 sul bianco della card. Il numero
    // non si copia a mano — si rilegge dal token.
    const css = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8')
    const hex = css.match(/--color-kidville-error:\s*(#[0-9A-Fa-f]{6})/)?.[1]
    expect(hex, 'il token dell\'errore non è più dichiarato').toBeTruthy()
    expect(contrasto(hex!, '#FFFFFF')).toBeGreaterThanOrEqual(3)
  })
})

// =============================================================================
describe('§11 · il riquadro del CARICAMENTO in errore cambia aspetto come tutti', () => {
  /**
   * ─── IL DIFETTO, MISURATO IL 12/08/2026 ───────────────────────────────────
   * Al passo «Documento d'identità» di `/anagrafica-personale`, premuto «Avanti»
   * a passo vuoto: `document_type`, `document_number` e la scadenza prendevano il
   * bordo rosso pieno a 1,5 px (rgb(229,57,53), 4,23:1 sul bianco). Il riquadro
   * del file — che aveva `aria-invalid="true"` e «Campo obbligatorio» scritto
   * sotto — restava con `border-kidville-green/20` a 1 px: composto sul crema,
   * **1,35:1**. WCAG 1.4.11 chiede ≥ 3:1 per gli indicatori non testuali, quindi
   * quello non era un contorno debole: era nessun contorno.
   *
   * Perché proprio qui costa di più: è il campo che chiede di alzarsi, fotografare
   * il documento e allegarlo — l'unico che costa fatica, e quindi il primo che si
   * salta. Chi rilegge la schermata dopo un «Avanti» fallito cerca il rosso: vedeva
   * tre caselle rosse e il riquadro del documento immutato, e concludeva che quello
   * fosse a posto.
   */
  const scansione: FormField = {
    id: 'documento_path',
    type: 'file',
    label: 'Scansione o foto del documento',
    required: true,
  }
  /** Il riquadro è la `<label>` che avvolge il controllo `sr-only`. */
  const riquadro = () => document.querySelector('input[type="file"]')!.closest('label')!

  /*
   * ─── …E A RIPOSO NON POTEVA RESTARE INVISIBILE (25/08/2026) ────────────────
   * Il ramo a riposo era `bg-kidville-cream` + `border-kidville-green/20`.
   * MISURATO nella pagina viva, passo 3 di `/lavora-con-noi` a 900 px: fondo del
   * riquadro `rgb(254,241,228)`, cioè IDENTICO al fondo della pagina, e contorno
   * `lab(39.62 -29.33 -1.64 / 0.2)` ≈ **1,35:1**. Un `<select>` nello stesso passo
   * mostrava riempimento bianco e contorno `rgb(85,97,92)`. Il campo che dal 24/08
   * blocca il passo era l'unico controllo della schermata che non si vedeva.
   * Non è sfuggito per caso al rimedio centrale di `globals.css`: quelle regole
   * agganciano `input|select|textarea[class*="border-kidville-green/"]` e
   * `label[class*="border-kidville-neutral"]`, e questa `<label>` con
   * `border-kidville-green/20` cadeva fra le due famiglie.
   * Ora porta i token delle CARD DI SCELTA (`SCELTA_LIBERA`), quindi il rimedio
   * per superficie lo prende: sulla crema `neutral` → `sub` (5,82:1), in hover →
   * verde pieno, in Alto Contrasto → nero.
   */
  it('CONTROLLO POSITIVO: a riposo è un CONTROLLO — bianco su crema, col contorno delle card', () => {
    render(<Harness field={scansione} />)
    const c = classi(riquadro())
    expect(c, 'il riquadro non porta il contorno delle card di scelta').toContain('border-kidville-neutral')
    expect(c).toContain('border')
    expect(c).toContain('bg-kidville-white')
    // ⚠️ IL DIFETTO CHE QUESTA RIGA CHIUDE: il fondo del riquadro non può essere
    // quello della PAGINA. Con `bg-kidville-cream` il campo e la superficie erano
    // lo stesso colore e l'unico confine era un contorno a 1,35:1.
    expect(c, 'il riquadro è di nuovo dello stesso colore della pagina').not.toContain('bg-kidville-cream')
    // La sfumatura debole non deve tornare: è quella che nessuna regola raccoglie.
    expect(
      c.some((x) => x.startsWith('border-kidville-green/') && !x.startsWith('hover:')),
      'è tornato un contorno di brand a bassa alfa, che nessuna regola di globals.css raccoglie',
    ).toBe(false)
    expect(c).not.toContain('border-kidville-error')
    // ⚠️ E IL TRATTEGGIO NON C'È PIÙ, poche ore dopo essere stato tolto dal solo
    // stato d'errore. Era difeso come «l'affordance della zona di rilascio», ma
    // `grep -rnE 'onDrop|onDragOver' src` trova due sole occorrenze in tutto il
    // prodotto, entrambe in `MediaUploader.tsx`: su questo riquadro trascinare un
    // file non allega niente, e non l'ha mai fatto. Il perché per esteso sta nel
    // commento del riquadro e in §12.
    expect(c, 'il tratteggio è tornato a promettere un rilascio che non esiste').not.toContain('border-dashed')
  })

  it('in errore prende lo STESSO rosso a 1,5px degli altri campi del passo', async () => {
    render(<Harness field={scansione} />)
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    await screen.findByText('Allega un file per proseguire')

    const c = classi(riquadro())
    expect(c, 'il riquadro del file resta identico a uno valido').toContain('border-kidville-error')
    expect(c).toContain('border-[1.5px]')
    // La sfumatura di brand deve SPARIRE, non affiancarsi: è la regola già
    // dichiarata per gli `input` nella testata di `FieldRenderer` (righe 41-44).
    expect(
      c.some((x) => x.startsWith('border-kidville-green/')),
      'il contorno debole è rimasto accanto al rosso',
    ).toBe(false)
    // E il peso non si somma: `border` (1px) e `border-[1.5px]` sullo stesso
    // elemento si risolvono nell'ordine del FOGLIO, non della stringa.
    expect(c).not.toContain('border')
  })

  /*
   * ─── LO STESSO ROSSO, E ANCHE LA STESSA LINEA (25/08/2026) ─────────────────
   * `border-dashed` stava nella base INCONDIZIONATA della classe, quindi
   * sopravviveva al ramo d'errore: MISURATO in Chromium sul passo 3 di
   * `/lavora-con-noi` dopo un «Avanti» a vuoto — `#titolo_studio`
   * `rgb(229,57,53)` **solid**, card «posizioni» `rgb(229,57,53)` **solid**,
   * riquadro «Curriculum» `rgb(229,57,53)` **dashed**. Stesso rosso, stesso
   * raggio, stesso messaggio sotto, contorno di un'altra lingua — e per giunta il
   * segnale più debole possibile (una linea a metà duty cycle) sull'unico campo
   * che blocca il passo. Le due stringhe che il resto del sistema usa per lo stato
   * d'errore (`BORDO_ERRORE`, `SCELTA_ERRORE`) non dichiarano lo stile e restano
   * `solid`: qui il ramo d'errore è ora LETTERALMENTE `SCELTA_ERRORE`.
   * ⚠️ Fino al 24/08 questo stato era IRRAGGIUNGIBILE sul modulo insegnanti
   * (`required: false` → `validateField` usciva a `if (vuoto) return null`): è
   * l'obbligo del curriculum ad averlo messo sulla strada di tutti.
   */
  it('in errore il contorno è PIENO come quello degli altri campi, non tratteggiato', async () => {
    render(<Harness field={scansione} />)
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    await screen.findByText('Allega un file per proseguire')

    const c = classi(riquadro())
    expect(
      c,
      'il campo in errore disegna un tratteggio dove ogni altro campo disegna una linea piena',
    ).not.toContain('border-dashed')
    // Ed è ESATTAMENTE la stringa di stato che il file esporta, non una copia.
    for (const pezzo of SCELTA_ERRORE.split(' ')) expect(c).toContain(pezzo)
  })

  /*
   * ─── E L'ANELLO DEL FUOCO RESTA UNO SOLO, ANCHE SU UN CAMPO SBAGLIATO ─────
   *
   * ⚠️ QUESTO TEST PRETENDEVA L'OPPOSTO FINO AL 25/08, E LA MISURA CHE L'HA
   * RIBALTATO VALE PIÙ DELLA RIGA CHE DIFENDEVA. La stesura di stamattina
   * dipingeva l'anello di ROSSO in errore, col ragionamento che «un anello verde
   * attorno a un bordo rosso è una contraddizione». La premessa è sbagliata: le
   * due cornici non rispondono alla stessa domanda. Il bordo dice «questo campo è
   * sbagliato» e lo dice anche senza fuoco; l'anello dice «sei qui», ed è l'unico
   * segnale che ha quel mestiere. Un anello che cambia colore col contenuto
   * smette di essere il segnale del fuoco e diventa il terzo segnale d'errore
   * sullo stesso campo — e nessun altro controllo del prodotto lo fa: l'`outline`
   * di `:focus-visible` è verde su un input valido e su uno in errore.
   *
   * E c'era una seconda misura, più dura da discutere: `ring-kidville-error`
   * compila al LETTERALE #E53935 e NON segue il ribaltamento del token in Alto
   * Contrasto (dove `--color-kidville-error` vale #FF5252). MISURATO con
   * `data-contrast="high"` sulla pagina viva: input e select a fuoco rispondono
   * `rgb(255,229,0)`, il riquadro in errore rispondeva `rgb(229,57,53)`. Chi
   * accende l'Alto Contrasto lo fa per non dover interpretare i colori.
   */
  it('in errore l\'anello resta quello del fuoco: il rosso lo dicono bordo e messaggio', async () => {
    render(<Harness field={scansione} />)
    expect(classi(riquadro()), 'a riposo l\'anello dev\'essere verde').toContain('focus-within:ring-kidville-green')

    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    await screen.findByText('Allega un file per proseguire')

    const c = classi(riquadro())
    expect(c, 'il fuoco si è messo a dire «errore» al posto di dire «sei qui»').not.toContain('focus-within:ring-kidville-error')
    expect(c, 'in errore il riquadro perde l\'anello del fuoco').toContain('focus-within:ring-kidville-green')
    // …e il bordo, che è chi l'errore lo deve dire, è rimasto rosso: senza questa
    // riga il test passerebbe anche su un campo che non segnala più niente.
    for (const pezzo of SCELTA_ERRORE.split(' ')) expect(c).toContain(pezzo)
  })

  it('in Alto Contrasto il rosso sparisce, e il riquadro porta il marcatore che lo salva', async () => {
    // Stessa rete di sicurezza delle card di scelta (§10): là il contorno diventa
    // nero come tutti, e il secondo segnale è il bordo DOPPIO. `aria-invalid` non
    // può servire — sta sull'`input` `sr-only` da 1×1 px, non sulla `<label>` che
    // disegna il contorno.
    render(<Harness field={scansione} />)
    expect(riquadro().hasAttribute('data-scelta-invalida')).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    await screen.findByText('Allega un file per proseguire')
    expect(riquadro().getAttribute('data-scelta-invalida')).toBe('true')
  })

  it('caricato il file il rosso se ne va: l\'errore era l\'assenza, non l\'allegato', async () => {
    const fetchFinta = vi.fn(async () => new Response(JSON.stringify({ path: 'documenti/a/b.pdf' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchFinta)
    try {
      render(<Harness field={scansione} />)
      fireEvent.click(screen.getByRole('button', { name: /valida/i }))
      await screen.findByText('Allega un file per proseguire')

      const file = new File(['%PD'], 'documento.pdf', { type: 'application/pdf' })
      fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [file] },
      })
      // ⚠️ Il nome vive in DUE `<span>` (radice `truncate` + coda `shrink-0`, vedi
      // `spezzaNomeFile`): `findByText` cerca un nodo di testo unico e qui non c'è.
      // Si guarda la riga intera, che è ciò che una persona legge.
      await waitFor(() =>
        expect(riquadro().textContent).toContain('documento.pdf'),
      )

      // La rivalidazione la chiede il banco, come la chiede il wizard vero
      // (`accendiRivalidazione`): qui `mode: 'onTouched'` non rivaluta un campo
      // che ha preso il rosso da `trigger` e non ha mai avuto un blur.
      fireEvent.click(screen.getByRole('button', { name: /valida/i }))
      await waitFor(() => expect(classi(riquadro())).not.toContain('border-kidville-error'))
      expect(riquadro().hasAttribute('data-scelta-invalida')).toBe(false)

      // ⚠️ E LO STATO «ALLEGATO» È LO STATO «SCELTO» DEL SISTEMA (25/08/2026).
      // Portava `border-kidville-green/40` su `bg-kidville-green-light`, una coppia
      // che non esiste da nessun'altra parte — e con la correzione del ramo a
      // riposo sarebbe diventata più DEBOLE di quella di un riquadro vuoto
      // (`neutral` → `sub`, 5,82:1): un campo compilato meno definito di uno
      // vuoto. Ora è `SCELTA_PRESA`, la stessa di una card spuntata.
      const pieno = classi(riquadro())
      for (const pezzo of SCELTA_PRESA.split(' ')) expect(pieno).toContain(pezzo)
      expect(
        pieno.some((x) => x.startsWith('border-kidville-green/')),
        'lo stato «allegato» è tornato a un contorno di brand a bassa alfa',
      ).toBe(false)
      // Nemmeno con il file dentro: vedi §12, non c'è nessun rilascio da annunciare.
      expect(pieno).not.toContain('border-dashed')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// =============================================================================
// §12 · IL RIQUADRO DEL CARICAMENTO PARLA LA LINGUA DEGLI ALTRI CONTROLLI
//
// Rilievi dei tre critici del 2026-08-25, tutti sullo stesso campo: il curriculum
// di `/lavora-con-noi`, che dal 24/08 è l'unico del passo che BLOCCA l'avanzamento.
// Finché era facoltativo ognuna di queste differenze costava poco; da quando è il
// cancello, ognuna si paga sul percorso più frequente del modulo.
// =============================================================================
describe('§12 · il riquadro del file non è più l’unico controllo che parla da solo', () => {
  const cv: FormField = { id: 'cv_path', type: 'file', label: 'Curriculum', required: true }
  const riquadroCv = () => document.querySelector('input[type="file"]')!.closest('label')!
  /** La riga di contenuto del riquadro: il primo `<span>` dentro la `<label>`. */
  const riga = () => riquadroCv().querySelector('span')!

  /** Un `fetch` che risponde solo quando lo si scioglie: serve allo stato «in volo». */
  function fetchSospeso() {
    let sciogli!: () => void
    const atteso = new Promise<void>((r) => { sciogli = r })
    const finto = vi.fn(async () => {
      await atteso
      return new Response(JSON.stringify({ path: 'candidature/x-cv.pdf' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    return { finto, sciogli }
  }

  async function allega(nome = 'cv-di-prova.pdf') {
    const file = new File(['%PD'], nome, { type: 'application/pdf' })
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    })
  }

  /**
   * Il nome VISIBILE: la concatenazione delle due metà `aria-hidden` (radice
   * `truncate` + coda `shrink-0`). NON `textContent` della riga, che contiene
   * anche la copia `sr-only` del nome intero — quella esiste per l'albero di
   * accessibilità, e sommarla direbbe il nome due volte.
   */
  const nomeVisibile = () =>
    [...riga().querySelectorAll('[aria-hidden="true"]')].map((s) => s.textContent).join('')

  /**
   * Il nome comparso nella riga — e NON `findByText`, che cerca un nodo di testo
   * unico: dal troncamento centrale il nome vive in due `<span>`.
   */
  const attesaNome = (nome: string) => waitFor(() => expect(nomeVisibile()).toBe(nome))

  /*
   * ── (a) LO STATO VUOTO NON SI SCRIVE NELL'INCHIOSTRO DEI VALORI ────────────
   * È il difetto che questo repo ha diagnosticato e chiuso l'11/08/2026 sul
   * `<select>` (§3 qui sopra), e che il riquadro del file non aveva mai
   * ricevuto: «Seleziona un file (PDF, JPG…)» usciva nel VERDE dei valori, cioè
   * un campo non compilato aveva l'aspetto di un campo compilato — a due campi
   * di distanza da un menu vuoto scritto in `hint` e in corsivo.
   */
  it('vuoto → inchiostro `hint` e corsivo, come il menu; con l’allegato → verde tondo', async () => {
    const fetchFinto = vi.fn(async () => new Response(JSON.stringify({ path: 'candidature/x-cv.pdf' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchFinto)
    try {
      render(<Harness field={cv} />)
      const vuoto = classi(riga())
      expect(vuoto, 'il segnaposto del file è ancora nel verde dei valori').toContain('text-kidville-hint')
      expect(vuoto).toContain('italic')
      expect(vuoto.some((x) => x.startsWith('text-kidville-green'))).toBe(false)

      await allega()
      await attesaNome('cv-di-prova.pdf')
      const pieno = classi(riga())
      expect(pieno).toContain('text-kidville-green')
      expect(pieno).toContain('not-italic')
      expect(pieno).not.toContain('text-kidville-hint')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  /*
   * ── (b) E LA RIGA HA LA TAGLIA DEI VALORI, NON QUELLA DELLE ETICHETTE ──────
   * `text-sm` (14 px) contro i 16 px di ogni altro controllo del passo: il campo
   * che decide se il modulo parte era l'unico a parlare sottovoce, e a essere
   * un gradino più basso (46 px contro 50).
   */
  it('la riga di contenuto è `text-base`, la taglia di ciò che si compila', () => {
    render(<Harness field={cv} />)
    const c = classi(riga())
    expect(c, 'la riga del file usa ancora la taglia delle etichette').toContain('text-base')
    expect(c).not.toContain('text-sm')
  })

  /*
   * ── (c) IL TRATTEGGIO PROMETTEVA UN GESTO CHE NON ESISTE ───────────────────
   * `grep -rnE 'onDrop|onDragOver' src` trova DUE occorrenze in tutto il
   * prodotto, entrambe in `MediaUploader.tsx`, che non c'entra con questi
   * moduli: trascinare un file su questo riquadro non allega niente. Il
   * commento che difendeva il tratteggio come «affordance della zona di
   * rilascio» affermava un fatto falso, ed era sull'unico controllo della
   * schermata senza contorno pieno.
   */
  it('nessuno stato del riquadro promette più una zona di rilascio che non esiste', async () => {
    const fetchFinto = vi.fn(async () => new Response(JSON.stringify({ path: 'candidature/x-cv.pdf' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchFinto)
    try {
      render(<Harness field={cv} />)
      expect(classi(riquadroCv()), 'a riposo il riquadro è ancora tratteggiato').not.toContain('border-dashed')
      await allega()
      await attesaNome('cv-di-prova.pdf')
      expect(classi(riquadroCv()), 'con l’allegato il riquadro è ancora tratteggiato').not.toContain('border-dashed')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('CONTROLLO POSITIVO: il codice non ha nessun gestore di trascinamento da cui il tratteggio dipenda', () => {
    const codice = fs.readFileSync(
      path.join(process.cwd(), 'src/components/features/forms/FieldRenderer.tsx'),
      'utf8',
    )
    // Se un giorno il rilascio si implementa davvero, questo test va ROSSO ed è
    // il momento di rimettere il tratteggio — con il comportamento sotto.
    expect(codice).not.toMatch(/onDrop=|onDragOver=/)
  })

  /*
   * ── (d) CHI STA ASPETTANDO NON STA SBAGLIANDO ──────────────────────────────
   * Con l'upload in volo il riquadro prendeva il bordo rosso + l'anello rosso e
   * sotto compariva un testo in `error-strong` peso 700 con l'icona d'allarme.
   * La FRASE era già stata corretta; il colore e l'icona no. È il momento in cui
   * la persona sta facendo esattamente la cosa giusta.
   */
  it('mentre il file sale, il campo NON è dipinto come sbagliato', async () => {
    const { finto, sciogli } = fetchSospeso()
    vi.stubGlobal('fetch', finto)
    try {
      render(<Harness field={cv} />)
      // Prima l'errore vero: è la strada che l'obbligo apre a tutti
      // (premi Avanti → ti dice di allegare → alleghi).
      fireEvent.click(screen.getByRole('button', { name: /valida/i }))
      await screen.findByText(itCampi.allegaFile)
      expect(classi(riquadroCv())).toContain('border-kidville-error')

      await allega()
      // In volo: il messaggio cambia mestiere, e con lui la vernice.
      const avviso = await screen.findByText(itCampi.attendiCaricamento)
      const ca = classi(avviso)
      expect(ca, 'il messaggio d’attesa è ancora dipinto come un errore').not.toContain('text-kidville-error-strong')
      expect(ca).not.toContain('font-bold')
      expect(ca).toContain('text-kidville-sub')
      expect(avviso.querySelector('.animate-spin'), 'l’icona è ancora quella dell’allarme').not.toBeNull()
      // …e il riquadro torna neutro finché il file sale.
      expect(classi(riquadroCv()), 'il riquadro resta rosso mentre il file sale').not.toContain('border-kidville-error')
      expect(riquadroCv().hasAttribute('data-scelta-invalida')).toBe(false)

      sciogli()
      await attesaNome('cv-di-prova.pdf')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  /*
   * ── (e) LA CODA DEL NOME È LA PARTE CHE DICE «È IL FILE GIUSTO» ────────────
   * `truncate` taglia in fondo e si mangia l'estensione: a 390 px
   * «Curriculum Vitae Europass Anna Maria Verdi aggiornato…» perde il «.pdf»,
   * cioè l'unico pezzo che distingue il curriculum dallo screenshot della chat.
   */
  it('il nome lungo si tronca al CENTRO: l’estensione resta leggibile', async () => {
    const fetchFinto = vi.fn(async () => new Response(JSON.stringify({ path: 'candidature/x-cv.pdf' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchFinto)
    const NOME = 'Curriculum Vitae Europass Anna Maria Verdi aggiornato settembre 2026 definitivo.pdf'
    try {
      render(<Harness field={cv} />)
      await allega(NOME)
      await attesaNome(NOME)
      // La coda non si accorcia mai: è l'unico pezzo `shrink-0` della riga.
      const coda = Array.from(riga().querySelectorAll('span')).find((s) => classi(s).includes('shrink-0'))
      expect(coda, 'la coda del nome può ancora essere troncata via').toBeTruthy()
      expect(coda!.textContent!.endsWith('.pdf')).toBe(true)
      expect(riga().getAttribute('title'), 'il nome intero non è più recuperabile').toBe(NOME)
      // ⚠️ E IL NOME ARRIVA INTERO A CHI ASCOLTA. Spezzarlo in due elementi
      // inline spezza anche il NOME ACCESSIBILE: il calcolo inserisce uno spazio
      // fra due inline adiacenti, e misurato in Chromium il controllo si chiamava
      // «Curriculum * cv-di-pr ova.pdf». Le due metà visibili sono `aria-hidden`,
      // e una copia `sr-only` porta il nome intero in un nodo solo.
      const perChiAscolta = riga().querySelector('.sr-only')
      expect(perChiAscolta, 'il nome intero non arriva più all’albero di accessibilità').not.toBeNull()
      expect(perChiAscolta!.textContent).toBe(NOME)
      expect(
        Array.from(riga().querySelectorAll('span')).filter((s) => !s.hasAttribute('aria-hidden') && !classi(s).includes('sr-only')),
        'una metà visibile del nome è tornata dentro il nome accessibile',
      ).toHaveLength(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  /*
   * ── (e-bis) IL TAGLIO CADE DOPO UNO SPAZIO, E LO SPAZIO NON DEVE SPARIRE ───
   * MISURATO in Chromium riproducendo la riga vera (flex, radice + coda): con
   * `whitespace-nowrap` le due metà rendono 280,42 px contro i 284,61 px del nome
   * intero in un nodo solo — 4,19 px, cioè esattamente uno spazio — e a schermo si
   * legge «Curriculum Vitae Europeodefinitivo.pdf». Causa: `nowrap` COLLASSA lo
   * spazio in fondo alla riga, e ogni figlio di un flex è una riga sua; `pre` lo
   * conserva (284,61 px, il nome esatto).
   *
   * ⚠️ QUESTO TEST GUARDA LA CLASSE, NON LA LARGHEZZA, e non è un ripiego: in jsdom
   * non c'è impaginazione, quindi `textContent` delle due metà contiene lo spazio
   * ANCHE quando a schermo è sparito. Il lock vicino («il nome lungo si tronca al
   * centro») è verde in entrambi i casi per questo motivo, e la sua fixture
   * («cv-anna.pdf», col trattino) è per giunta l'unico taglio che non sbaglia mai.
   * La cosa che jsdom sa vedere è la classe, ed è quella che si pretende.
   */
  it('il nome tagliato DOPO uno spazio conserva lo spazio: la radice è `whitespace-pre`', async () => {
    const fetchFinto = vi.fn(async () => new Response(JSON.stringify({ path: 'candidature/x-cv.pdf' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchFinto)
    const NOME = 'Curriculum Vitae Europeo definitivo.pdf'
    try {
      // Prima la premessa: senza questa riga il test proverebbe una regola su un
      // nome che non ha nessuno spazio al punto di taglio, cioè su niente.
      const [radiceAttesa] = spezzaNomeFile(NOME)
      expect(radiceAttesa.endsWith(' '), 'la fixture non taglia più dopo uno spazio').toBe(true)
      render(<Harness field={cv} />)
      await allega(NOME)
      await attesaNome(NOME)
      const radice = Array.from(riga().querySelectorAll('span')).find(
        (s) => s.textContent === radiceAttesa && s.getAttribute('aria-hidden') === 'true',
      )
      expect(radice, 'la radice del nome non si trova più').toBeTruthy()
      expect(
        classi(radice!),
        'la radice collassa di nuovo lo spazio finale: le due metà si saldano a schermo',
      ).toContain('whitespace-pre')
      expect(classi(radice!)).not.toContain('whitespace-nowrap')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  /*
   * ── (f) SU UN CAMPO CHE BLOCCA, «SI PUÒ CAMBIARE» VA DETTO ─────────────────
   * Allegato il file, niente diceva che si può sostituirlo: il riquadro resta
   * cliccabile (è la `<label>` dell'input) ma l'affordance era implicita.
   */
  it('con l’allegato dentro, il riquadro dice che si può sostituire', async () => {
    const fetchFinto = vi.fn(async () => new Response(JSON.stringify({ path: 'candidature/x-cv.pdf' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchFinto)
    try {
      render(<Harness field={cv} />)
      expect(screen.queryByText(itCampi.sostituisci), 'lo dice anche a riquadro vuoto').toBeNull()
      await allega()
      await attesaNome('cv-di-prova.pdf')
      const parola = screen.getByText(itCampi.sostituisci)
      // Dentro il bersaglio che già esiste: nessun secondo controllo da mantenere.
      expect(parola.closest('label')).toBe(riquadroCv())
    } finally {
      vi.unstubAllGlobals()
    }
  })

  /*
   * ── (g) UNA PILA, UNA DISTANZA ─────────────────────────────────────────────
   * Il commento della nota (righe ~955) scrive la regola: «Niente `mt-*`: la
   * distanza la dà lo `space-y-2` del blocco… tre distanze diverse (8 · 6 · 6 px)
   * dentro la stessa pila». Il 6 px che quel commento cita come esito da evitare
   * viveva duecento righe più in basso, nello stesso componente.
   */
  it('dentro `FileField` nessuna distanza è scritta a mano: la dà la pila', () => {
    const codice = fs.readFileSync(
      path.join(process.cwd(), 'src/components/features/forms/FieldRenderer.tsx'),
      'utf8',
    )
    const inizio = codice.indexOf('export function FileField')
    expect(inizio).toBeGreaterThan(0)
    // ⚠️ I COMMENTI SI TOLGONO PRIMA DI CERCARE, e non è un dettaglio: il
    // commento che spiega questa correzione CITA le due classi tolte («`mt-2`
    // sul bottone, `mt-1.5` sul messaggio»). Cercandole nel sorgente grezzo il
    // test resterebbe rosso per colpa della propria spiegazione — ed è la stessa
    // trappola per cui un lock si era immunizzato col proprio commento (14/08).
    const corpo = codice
      .slice(inizio)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(corpo, 'una spaziatura scritta a mano è tornata dentro `FileField`').not.toMatch(/\bmt-1\.5\b/)
    expect(corpo, 'il bottone «Scatta foto» si è ripreso il proprio margine').not.toMatch(/\bmt-2\b/)
    expect(corpo, 'il contenitore di `FileField` non è una pila spaziata').toContain('space-y-2')
  })

  /*
   * ── (h) IL NOME DEL FILE SOPRAVVIVE AL «MODIFICA» DEL RIEPILOGO ────────────
   * Il wizard rende un passo alla volta: tornando al passo dal riepilogo questo
   * componente si RIMONTA e `fileName` ripartiva da ''. Risultato misurato: il
   * riepilogo diceva «cv-di-prova.pdf» e il campo, a due clic di distanza e
   * nello stesso istante, «Allegato caricato».
   */
  it('rimontato con un valore, il riquadro dice ANCORA quale file è', () => {
    render(
      <HarnessConNome field={cv} valore="candidature/x-cv.pdf" nome="cv-di-prova.pdf" />,
    )
    expect(nomeVisibile()).toBe('cv-di-prova.pdf')
    // ⚠️ Cercato NELLA RIGA e non nella pagina: la regione viva `sr-only` del
    // campo annuncia «Allegato caricato», ed è il suo mestiere. Il difetto era
    // che lo dicesse il riquadro VISIBILE, al posto del nome.
    expect(riga().textContent).not.toContain(itCampi.allegatoCaricato)
  })

  /*
   * ── (i) IL COLLEGAMENTO CHIUDE LA PILA, E I 44 px SONO VERI ────────────────
   *
   * Nella pila del campo gli stacchi dichiarati sono tutti 8 px, ma fra la nota
   * e il TESTO del link ce n'erano 23: i 14 px di riempimento che davano al
   * collegamento il bersaglio da 44 px. La prima correzione li ha pagati con un
   * `-mt-3.5`, e il QUARTO giro di critica (2026-08-25) ha misurato che quella
   * moneta era falsa in due modi.
   *
   *  1. IL BERSAGLIO NON ERA 44, ERA 38. MISURATO a 390 px con
   *     `document.elementFromPoint` un pixel alla volta lungo l'asse del link:
   *     la SCATOLA va da y=451,5 a y=495,5 (44 px esatti, come dichiarato), ma
   *     dal 451 al 457 chi risponde è il `<p>` della nota — e la `<a>` solo dal
   *     458 in giù. 38 px, cioè meno dei 40 da cui il commento del componente
   *     metteva in guardia. Il motivo è l'ordine di pittura: il link era un box
   *     di blocco NON posizionato (fase 4) e il testo della nota è contenuto
   *     inline (fase 7), che gli passa sopra. `getBoundingClientRect` diceva 44,
   *     il hit-test 38: è il hit-test che ha ragione.
   *  2. IL -14 px LEGAVA UN COMPONENTE FOGLIA AL SUO CONTENITORE. La prova è che
   *     per applicarlo si era dovuto accordare lo `space-y-*` di un ALTRO ramo
   *     dello stesso file. Un componente che per essere corretto pretende un
   *     valore preciso dal genitore non è un componente del sistema.
   *
   * Rimedio: l'ingrandimento esce dal modello a scatole. La `<a>` torna alta
   * quanto il suo testo — quindi nessun contenitore deve accordarsi con lei, in
   * nessuno dei tre moduli che la usano — e i 44 px li dà uno `::before`
   * assoluto a ±14 px, che essendo su un elemento POSIZIONATO viene dipinto in
   * fase 8, cioè sopra il testo della nota. È lo stesso schema già in casa in
   * `AvvisoCard.tsx` (`after:absolute after:inset-0 after:content-['']`).
   * Verificato nella pagina viva dopo la correzione: bersaglio 44 px su 44.
   */
  it('il collegamento allarga il bersaglio FUORI dal flusso, senza compensazioni', () => {
    render(<Harness field={{ ...cv, link: '/privacy' }} />)
    const link = document.querySelector('a[href="/privacy"], [href="/privacy"]')!
    const c = classi(link)
    // ⚠️ IL VERSO NEGATIVO PER PRIMO: è quello che è costato la misura. Una
    // compensazione dentro un componente foglia va cercata e vietata, perché
    // rimetterla è la correzione «ovvia» del prossimo che vedrà 23 px di stacco.
    expect(
      c.filter((x) => /^-m[tby]?-/.test(x)),
      'è tornata una compensazione a margine negativo: il contenitore deve di nuovo essere d’accordo',
    ).toEqual([])
    expect(c, 'il riempimento è tornato nel flusso: il testo si stacca dalla pila').not.toContain(
      'py-3.5',
    )
    // …e il verso positivo: i 44 px ci sono, e stanno fuori dal flusso.
    expect(c, 'senza `relative` lo pseudo-elemento non si àncora al link').toContain('relative')
    expect(c).toContain('before:absolute')
    expect(c, 'sparito l’ingrandimento verticale: il bersaglio torna alto quanto il testo').toContain(
      'before:-inset-y-3.5',
    )
    expect(c, 'senza `content` lo pseudo-elemento non esiste').toContain("before:content-['']")
    // ⚠️ `flex w-fit` E NON `inline-flex`: `w-fit` impedisce al bersaglio di
    // diventare tutta la colonna, e `before:inset-x-0` lo tiene largo quanto il
    // testo invece che quanto la riga.
    expect(c).toContain('flex')
    expect(c).not.toContain('inline-flex')
    expect(c, 'senza `w-fit` il bersaglio diventa tutta la colonna').toContain('w-fit')
    expect(c).toContain('before:inset-x-0')
    expect(c).toContain('text-xs')
  })

  /*
   * ── (j) IL PRIMO CLIC SUL COLLEGAMENTO NON SI PERDE ────────────────────────
   *
   * ⚠️ MISURATO IN CHROMIUM il 2026-08-25 su http://localhost:3100/lavora-con-noi,
   * a 1280×950 e a 390×844, in ENTRAMBI i punti in cui questo collegamento
   * compare — passo 3 (la nota del curriculum) e passo 4 (il consenso). Con il
   * fuoco dentro il campo obbligatorio ancora vuoto, un solo clic sul link NON
   * APRIVA NIENTE. Registro degli eventi alle sue coordinate:
   *     passo 3 · mousedown@A → mouseup@P#cv_path-nota                → click@DIV
   *     passo 4 · mousedown@A → mouseup@P#presa_visione_informativa-error → click@DIV
   * `mousedown` sulla `<a>`, `mouseup` VENTIQUATTRO PIXEL PIÙ IN BASSO su un
   * altro elemento, e quindi un `click` emesso sull'antenato comune — mai sul
   * link. Schede aperte: ZERO al primo clic, UNA al secondo.
   *
   * È LO STESSO DIFETTO, E LA STESSA CATENA, già cacciata sui due comandi del
   * wizard: la dottrina per intero — perché il rimedio stia sul gesto di
   * pressione e non nel campo, e che prezzo si paga — è nel blocco
   * «IL PRIMO CLIC NON SI PERDE» di
   * `src/components/features/public/wizard/pezzi-wizard-pubblico.tsx`. Là era
   * stata applicata ai due bottoni e non a questo collegamento, che vive nello
   * stesso flusso e sotto lo stesso `mode: 'onTouched'`.
   *
   * ⚠️ IL PREZZO DI UN LINK NON È QUELLO DI UN BOTTONE, ed è stato misurato prima
   * di scegliere (Chromium, pagina viva, sonda con controllo positivo):
   *   · selezione del testo trascinando  → invariata, e invariata perché NON
   *     ESISTE nemmeno oggi: una `<a href>` è trascinabile di suo, e il
   *     trascinamento nativo vince sulla selezione. Il controllo positivo della
   *     sonda — lo stesso gesto sul `<p>` della nota, due righe più su — seleziona
   *     («…PDF oppure una foto del curriculum, purché si legga t»), quindi il
   *     «non selezionabile» sul link non è un difetto della misura;
   *   · tasto centrale e cmd-clic (apertura in scheda nuova) → non solo intatti:
   *     RIPARATI. Senza il rimedio si perdevano anch'essi — `auxclick`/`click`
   *     mai emessi sul link — perché il bersaglio si sposta per tutti e tre i
   *     bottoni allo stesso modo;
   *   · trascinare il LINK (verso i preferiti, un'altra finestra) → questo sì, si
   *     perde: `dragstart` non parte più. È l'unico prezzo, ed è dichiarato.
   *
   * ⚠️ QUESTO TEST NON PUÒ VEDERE IL DIFETTO: jsdom non ha layout, il link non si
   * sposta e il clic arriva sempre. Asserisce l'unica cosa che jsdom sa misurare
   * — che il gesto di pressione sia neutralizzato — e serve a impedire che quella
   * riga sparisca in silenzio.
   */
  it.each([
    ['interno (LinkInterno)', '/privacy'],
    ['esterno (<a>)', 'https://example.invalid/informativa'],
  ])('il gesto di pressione sul collegamento %s non sposta il fuoco', (_nome, href) => {
    render(<Harness field={{ ...cv, link: href }} />)
    const link = document.querySelector(`[href="${href}"]`)!
    const consumato = fireEvent.mouseDown(link)
    expect(
      consumato,
      'il `mousedown` sul collegamento non è prevenuto: il fuoco si sposta, il campo si blura, il messaggio compare e il link scende fra la pressione e il rilascio',
    ).toBe(false)
    // …e resta un collegamento: il clic vero non è toccato, altrimenti si
    // chiuderebbe il difetto rendendo il link inerte.
    expect(
      fireEvent.click(link),
      'il clic sul collegamento è prevenuto: il link non porta più da nessuna parte',
    ).toBe(true)
  })
})

// =============================================================================
// §13 · IL RIQUADRO DEL FILE RICEVE IL FUOCO DEL SISTEMA, NON UNO SUO
//
// Rilievi del terzo giro di critica (2026-08-25), tutti misurati in Chromium
// sulla pagina viva prima di essere scritti qui. Il filo che li lega è lo stesso
// di §12 — «il campo che blocca il passo parla diverso dai suoi pari» — ma un
// gradino più in basso: non il testo né l'inchiostro, il FUOCO, cioè il segnale
// che una persona usa per sapere dove si trova.
// =============================================================================
describe('§13 · il fuoco del riquadro è quello del sistema, in tutte le modalità', () => {
  const cv: FormField = { id: 'cv_path', type: 'file', label: 'Curriculum', required: true }
  const riquadroCv = () => document.querySelector('input[type="file"]')!.closest('label')!

  /*
   * ── (a) LO STACCO È QUELLO DEGLI ALTRI CAMPI ───────────────────────────────
   * MISURATO a 900 px, `getComputedStyle` sulla pagina viva:
   *   · input e select a fuoco → `outline: 2px solid #006A5F` + `box-shadow
   *     0 0 0 2px #FFFFFF` (regola globale `:focus-visible`, globals.css:588):
   *     lo stacco bianco è 2 px e l'anello finisce a +4.
   *   · riquadro CV a fuoco → `box-shadow: 0 0 0 1px #FFFFFF, 0 0 0 3px #006A5F`:
   *     stesso verde, stesso spessore, ma stacco 1 px e anello a +3.
   * Quattro pixel su un solo controllo di una colonna di sei: l'alone stringe il
   * riquadro più di ogni altro campo del passo.
   */
  it('lo stacco dell’anello è 2 px come l’`outline-offset` di ogni altro campo', () => {
    render(<Harness field={cv} />)
    const c = classi(riquadroCv())
    expect(c, 'l’anello del riquadro stringe più di quello degli altri campi').toContain(
      'focus-within:ring-offset-2',
    )
    expect(c).not.toContain('focus-within:ring-offset-1')
  })

  /*
   * ── (b) L'ANELLO NON CAMBIA COLORE PER DIRE «ERRORE» ───────────────────────
   * Dire «errore» è mestiere del BORDO (`SCELTA_ERRORE`) e del messaggio. Il
   * fuoco risponde a un'altra domanda — «dove sono?» — e deve rispondere sempre
   * allo stesso modo.
   *
   * ⚠️ E IL MOTIVO NON È SOLO DOTTRINALE: `ring-kidville-error` compila al
   * LETTERALE #E53935, quindi NON segue il ribaltamento del token in Alto
   * Contrasto (dove `--color-kidville-error` vale #FF5252). Misurato in Alto
   * Contrasto, riquadro in errore e a fuoco: anello `rgb(229,57,53)` mentre ogni
   * altro campo della schermata risponde `rgb(255,229,0)`.
   *
   * ⚠️ IL RILIEVO È TORNATO AL QUINTO GIRO, CON UNA PREMESSA CHE LA MISURA
   * SMENTISCE. Diceva: «il fenomeno esiste anche su select e input, ma lì
   * l'outline è aderente e sottile e il rosso si legge; qui l'anello è staccato e
   * spesso e il rosso resta schiacciato dentro». MISURATO in Chromium sulla
   * pagina viva, 390 px, fuoco da tastiera, letto dopo 1,2 s di assestamento, con
   * i due controlli nello STESSO stato d'errore:
   *   · `#titolo_studio` → `outline: 2px solid rgb(0,106,95)`, `outline-offset:
   *     2px`, `box-shadow: rgb(255,255,255) 0 0 0 2px`, bordo `rgb(229,57,53)`.
   *     Cioè: bianco da 0 a 2 px, VERDE da 2 a 4, bordo rosso dentro.
   *   · riquadro del curriculum → `box-shadow: rgb(255,255,255) 0 0 0 2px,
   *     rgb(0,106,95) 0 0 0 4px`, bordo `rgb(229,57,53)`.
   *     Cioè: bianco da 0 a 2 px, VERDE da 2 a 4, bordo rosso dentro.
   * Sono la STESSA geometria, pixel per pixel — la divergenza dello stacco che
   * (a) descriveva è stata chiusa da `ring-offset-2`, e con lei è caduta la
   * premessa del rilievo. Il verde sopra il bordo rosso non è un'eccezione di
   * questo campo: è la risposta che ogni controllo del prodotto dà alla domanda
   * «dove sono», in errore come a riposo. Cambiarla QUI e solo qui rifarebbe
   * esattamente il difetto che §12 e §13 esistono per chiudere.
   */
  it('in errore l’anello resta quello di sempre: il rosso lo dicono bordo e messaggio', async () => {
    render(<Harness field={cv} />)
    fireEvent.click(screen.getByText('Valida'))
    await waitFor(() => expect(classi(riquadroCv())).toContain(SCELTA_ERRORE.split(' ')[0]))
    const c = classi(riquadroCv())
    expect(c, 'il fuoco si è messo a dire «errore» al posto di dire «sei qui»').not.toContain(
      'focus-within:ring-kidville-error',
    )
    expect(c, 'in errore il riquadro perde l’anello del fuoco').toContain(
      'focus-within:ring-kidville-green',
    )
  })

  /*
   * ── (c) …E IN ALTO CONTRASTO DIVENTA GIALLO, COME TUTTI ────────────────────
   * L'intero livello `[data-contrast="high"]` di `globals.css` esiste per ridurre
   * la tavolozza a poche cose non ambigue: contorni neri, e il GIALLO come unica
   * risposta alla domanda «dove sono col fuoco». L'anello del riquadro è disegnato
   * da Tailwind (`focus-within:ring-*`), che scrive `--tw-ring-color`: la regola
   * globale `[data-contrast="high"] input { outline-color: #FFE500 }` non lo
   * tocca, perché non è un `outline`. Serve la sua riga, con la stessa cardinalità
   * stretta già usata per le card di scelta.
   */
  it('la regola dell’Alto Contrasto raggiunge anche l’anello del riquadro', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8')
    const regola = /\[data-contrast="high"\][^{]*label\[class\*="focus-within:ring-"\]:focus-within[^{]*\{[^}]*--tw-ring-color:\s*#FFE500/i
    expect(
      regola.test(css),
      'in Alto Contrasto il riquadro del file è l’unico controllo che risponde al fuoco in verde',
    ).toBe(true)
  })

  /*
   * ── (d) …E CON LA STESSA GEOMETRIA, NON SOLO CON LA STESSA TINTA ───────────
   *
   * Il rilievo del QUARTO giro (2026-08-25), e la parte che (c) aveva lasciato
   * aperta: la tinta era stata ribaltata, la FORMA no. MISURATO in Chromium sulla
   * pagina viva a 900 px, `data-contrast="high"`, fuoco da tastiera, letto dopo
   * 1,4 s di assestamento (dentro i 150 ms di `transition-all` il `box-shadow`
   * torna trasparente e la misura mente):
   *   · `#titolo_studio` — e con lui ogni input, bottone e link, via
   *     `[data-contrast="high"] *:focus-visible` (globals.css ~425) →
   *     `outline: 3px solid rgb(255,229,0)`, `outline-offset: 2px`,
   *     `box-shadow: rgb(0,0,0) 0 0 0 2px`. Cioè: separatore NERO da 0 a 2 px,
   *     banda gialla SPESSA 3 px da 2 a 5.
   *   · riquadro del curriculum →
   *     `box-shadow: rgb(255,255,255) 0 0 0 2px, rgb(255,229,0) 0 0 0 4px`.
   *     Cioè: separatore BIANCO da 0 a 2 px, banda gialla da 2 px da 2 a 4.
   *
   * Due divergenze, e nessuna delle due è decorazione. Lo SPESSORE (2 contro 3)
   * su un anello che esiste per essere visto da chi ha acceso l'Alto Contrasto.
   * E il separatore: il commento che lo istituisce (globals.css ~428) dice che
   * serve «così l'anello giallo si stacca anche dai controlli a bordo/fondo
   * giallo» — #FFE500 contro il crema #FEF1E4 vale ~1,15:1, quindi senza il nero
   * la banda gialla non ha nessun bordo che la definisca dal lato interno.
   *
   * ⚠️ QUI SI GUARDA IL FOGLIO DI STILE E NON IL DOM, e il perché è nel test
   * qui sopra: l'anello lo compone Tailwind con `--tw-ring-*`, che in jsdom non
   * diventa nessun `box-shadow`. La prova a schermo è quella in Chromium citata
   * qui sopra; questo è il presidio che impedisce alla regola di tornare a metà.
   */
  it('in Alto Contrasto l’anello ha anche lo SPESSORE e il separatore degli altri', () => {
    const css = fs.readFileSync(path.join(process.cwd(), 'src/app/globals.css'), 'utf8')
    const blocco = css.match(
      /\[data-contrast="high"\]\s*label\[class\*="focus-within:ring-"\]:focus-within\s*\{([^}]*)\}/i,
    )?.[1]
    expect(blocco, 'sparita la regola che porta l’anello del riquadro in Alto Contrasto').toBeTruthy()
    expect(
      blocco,
      'lo stacco resta bianco: la banda gialla non ha un bordo che la definisca dall’interno',
    ).toMatch(/--tw-ring-offset-color:\s*#000000/i)
    expect(
      blocco,
      'la banda gialla resta da 2 px mentre ogni altro controllo la porta a 3',
    ).toMatch(/--tw-ring-shadow:[^;]*\b3px\b/i)
  })
})

// =============================================================================
// §14 · I TRE SEGNALI DELL'ATTESA DICONO LA STESSA COSA — ANCHE QUELLO CHE NON SI VEDE
// =============================================================================
describe('§14 · durante il caricamento il campo non è «non valido»', () => {
  const cv: FormField = { id: 'cv_path', type: 'file', label: 'Curriculum', required: true }

  /*
   * Il difetto: la dottrina scritta in §12 («un sistema con tre stati — riposo ·
   * attesa · errore — non ne dipinge due con la stessa tinta») era stata applicata
   * ai soli PIXEL. Misurato con l'upload rallentato: il riquadro porta il bordo
   * neutro e il messaggio passa al tono della nota, ma l'`<input>` continua a
   * dichiarare `aria-invalid="true"`. Vernice e icona dicono «aspetta», l'albero
   * di accessibilità dice ancora «campo non valido» — sull'unico campo che blocca
   * il passo, e proprio a chi sta facendo la cosa giusta.
   */
  it('`aria-invalid` segue lo stesso predicato della vernice, non solo la vernice', async () => {
    let sciogli!: () => void
    const atteso = new Promise<void>((r) => { sciogli = r })
    const fetchFinto = vi.fn(async () => {
      await atteso
      return new Response(JSON.stringify({ path: 'candidature/x-cv.pdf' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    })
    vi.stubGlobal('fetch', fetchFinto)
    try {
      render(<Harness field={cv} />)
      const input = () => document.querySelector('input[type="file"]') as HTMLInputElement

      // 1) l'errore vero: `aria-invalid` DEVE esserci (il controllo negativo che
      //    impedisce a questo test di passare per il motivo sbagliato).
      fireEvent.click(screen.getByText('Valida'))
      await waitFor(() => expect(input().getAttribute('aria-invalid')).toBe('true'))

      // 2) ora si allega: mentre il file sale l'errore è ancora nel modulo, ma il
      //    campo non è più «non valido» — è occupato.
      fireEvent.change(input(), {
        target: { files: [new File(['%PD'], 'cv-di-prova.pdf', { type: 'application/pdf' })] },
      })
      await waitFor(() => expect(input().getAttribute('aria-busy')).toBe('true'))
      expect(
        input().getAttribute('aria-invalid'),
        'chi ascolta sente «campo non valido» mentre sta caricando il file',
      ).toBeNull()

      sciogli()
      await waitFor(() => expect(input().getAttribute('aria-busy')).toBeNull())
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

// =============================================================================
// §15 · IL NOME TRONCATO AL CENTRO SI LEGGE COME UNA COSA SOLA
// =============================================================================
describe('§15 · fra i puntini e la coda non resta un buco', () => {
  const cv: FormField = { id: 'cv_path', type: 'file', label: 'Curriculum', required: true }
  const riga = () => document.querySelector('input[type="file"]')!.closest('label')!.querySelector('span')!

  /*
   * Il difetto, MISURATO a 390 px con «Curriculum Vitae Europass Anna Maria Verdi
   * aggiornato settembre 2026 definitivo.pdf»: la scatola della radice finisce a
   * x=222 e la coda parte esattamente da x=222 — le due metà si toccano — ma
   * `text-overflow: ellipsis` disegna i puntini dove il TESTO viene tagliato, non
   * a filo della scatola. Fra i puntini e la coda resta fino a un carattere di
   * bianco, e a schermo si legge «Curriculum Vitae Eu… nitivo.pdf»: due frammenti
   * invece di un nome elisso. A 900 px è quasi impercettibile, a 390 — il caso
   * d'uso vero, il modulo si compila dal telefono — è un carattere pieno.
   *
   * Il rimedio è togliere l'ellissi automatica e stamparla come nodo suo, così il
   * taglio è netto e i puntini stanno dove li mettiamo noi.
   */
  it('la radice taglia netto, e senza overflow non compare nessun puntino', async () => {
    const fetchFinto = vi.fn(async () => new Response(JSON.stringify({ path: 'candidature/x-cv.pdf' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchFinto)
    try {
      render(<Harness field={cv} />)
      fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(['%PD'], 'cv-anna.pdf', { type: 'application/pdf' })] },
      })
      const pezzi = () => [...riga().querySelectorAll('[aria-hidden="true"]')]
      await waitFor(() => expect(pezzi().length).toBeGreaterThan(0))
      const radice = pezzi()[0]
      expect(classi(radice), 'la radice usa ancora l’ellissi automatica del foglio').not.toContain('truncate')
      expect(classi(radice)).toContain('text-clip')
      expect(classi(radice)).toContain('overflow-hidden')

      // ⚠️ IL CONTROLLO CHE DIFENDE IL RIMEDIO SBAGLIATO. La prima stesura di
      // questa correzione stampava i puntini SEMPRE, perché `spezzaNomeFile`
      // divide sempre — non conosce la larghezza, solo il browser la conosce.
      // MISURATO a 900 px prima di accorgersene: «cv-anna.pdf», undici caratteri
      // dentro un riquadro largo 600, compariva come «cv-ann…a.pdf». Qui non c'è
      // overflow (jsdom non impagina: scrollWidth e clientWidth valgono 0), quindi
      // i puntini NON devono esserci.
      expect(
        pezzi().map((p) => p.textContent),
        'i puntini compaiono anche dove il nome ci starebbe intero',
      ).not.toContain('…')
      // …e il nome resta intero, byte per byte.
      expect(pezzi().map((p) => p.textContent).join('')).toBe('cv-anna.pdf')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  /*
   * E IL VERSO POSITIVO: quando la radice PERDE davvero dei caratteri, i puntini
   * ci sono. jsdom non impagina, quindi la misura si simula sul nodo — è l'unico
   * modo di provare il ramo in un test a componente, e senza questo il test qui
   * sopra passerebbe anche con i puntini cancellati del tutto.
   * La prova sulla pagina viva sta nel report del giro: a 390 px, con
   * «Curriculum Vitae Europass Anna Maria Verdi aggiornato settembre 2026
   * definitivo.pdf», i puntini tornano attaccati alla coda.
   */
  it('…e quando la radice perde davvero dei caratteri, i puntini compaiono', async () => {
    const fetchFinto = vi.fn(async () => new Response(JSON.stringify({ path: 'candidature/x-cv.pdf' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchFinto)
    // Un riquadro che taglia: la radice «scorre» più di quanto sia larga.
    const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth')
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 400 })
    // `ResizeObserver` non esiste in jsdom: il componente lo salta, e la misura
    // iniziale dell'effetto basta a questo collaudo.
    try {
      render(<Harness field={cv} />)
      fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
        target: { files: [new File(['%PD'], 'Curriculum Anna Maria Verdi definitivo.pdf', { type: 'application/pdf' })] },
      })
      await waitFor(() =>
        expect(
          [...riga().querySelectorAll('[aria-hidden="true"]')].map((p) => p.textContent),
        ).toContain('…'),
      )
      const pezzi = [...riga().querySelectorAll('[aria-hidden="true"]')]
      // I puntini stanno FRA le due metà, non in coda: è il troncamento centrale.
      expect(pezzi.findIndex((p) => p.textContent === '…')).toBe(1)
      // E non sono testo del nome: radice + coda resta la stringa intera.
      expect(pezzi.filter((p) => p.textContent !== '…').map((p) => p.textContent).join('')).toBe(
        'Curriculum Anna Maria Verdi definitivo.pdf',
      )
    } finally {
      if (scroll) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', scroll)
      vi.unstubAllGlobals()
    }
  })
})

// =============================================================================
// §16 · LA CODA DEL TRONCAMENTO CENTRALE COMINCIA DA UNA PAROLA, NON DA UNA SILLABA
//
// Rilievo del quarto giro (2026-08-25). `spezzaNomeFile` tagliava a un indice
// FISSO — gli ultimi 10 caratteri — e a 390 px, con
// «Curriculum Vitae Maria Giuseppina Esposito aggiornato settembre 2026.pdf»,
// a schermo si leggeva «Curriculum Vitae M…e 2026.pdf»: la coda cominciava con
// la «e» mozzata di «settembre». Il resto del campo è curato al millimetro (la
// coda esiste apposta perché l'estensione non si perda), e una sillaba tagliata
// a metà subito dopo i puntini si legge come un errore di rendering — proprio
// nel riquadro che conferma alla persona che il suo curriculum è arrivato.
//
// La regola nuova non è «taglia dove ti pare»: è «stessa lunghezza di prima,
// spostata al confine di parola più vicino, entro quattro caratteri». Il
// contratto resta quello di sempre — RADICE + CODA = il nome intero, byte per
// byte — ed è la prima cosa che questi test verificano.
// =============================================================================
describe('§16 · la coda del nome file comincia a inizio parola', () => {
  const NOMI = [
    'Curriculum Vitae Maria Giuseppina Esposito aggiornato settembre 2026.pdf',
    'Curriculum Vitae Europass Anna Maria Verdi aggiornato settembre 2026 definitivo.pdf',
    'Curriculum Anna Maria Verdi definitivo.pdf',
    'CurriculumVitaeAnnaMariaVerdi2026.pdf',
    'relazione finale del progetto.numbers',
    'IMG_20260825_120000.jpg',
    'cv-anna.pdf',
    'cv.pdf',
  ]

  /*
   * ⚠️ IL CONTRATTO PRIMA DI TUTTO, e non è cerimonia: il rimedio sposta un
   * indice, e un indice spostato male è un carattere perso o duplicato dentro il
   * nome di un file che una persona sta controllando prima di inviare la propria
   * candidatura. Questo test cade su QUALUNQUE errore di aritmetica, compresi
   * quelli che non si vedono a occhio.
   */
  it('RADICE + CODA resta il nome intero, byte per byte', () => {
    for (const nome of NOMI) {
      const [radice, coda] = spezzaNomeFile(nome)
      expect(radice + coda, `il nome «${nome}» si è rotto nel taglio`).toBe(nome)
    }
  })

  it('la coda non comincia mai a metà di una parola quando un confine è a portata', () => {
    // Il caso misurato a 390 px, quello del rilievo.
    expect(spezzaNomeFile('Curriculum Vitae Maria Giuseppina Esposito aggiornato settembre 2026.pdf')[1]).toBe(
      '2026.pdf',
    )
    // E il caso più lungo, già usato in §15: la coda passa da «nitivo.pdf» a una
    // parola intera.
    expect(
      spezzaNomeFile('Curriculum Vitae Europass Anna Maria Verdi aggiornato settembre 2026 definitivo.pdf')[1],
    ).toBe('definitivo.pdf')
    expect(spezzaNomeFile('Curriculum Anna Maria Verdi definitivo.pdf')[1]).toBe('definitivo.pdf')
  })

  /*
   * ── I TRE CONTROLLI NEGATIVI ───────────────────────────────────────────────
   * Senza questi, «cerca un confine» potrebbe diventare «cerca il confine più
   * comodo» e la coda allungarsi a piacere, che è il difetto opposto: la coda è
   * `shrink-0`, cioè non si accorcia mai, e una coda lunga si mangia la radice.
   */
  it('senza nessun confine a portata, il taglio resta quello di prima', () => {
    // Nessuno spazio, nessun trattino, nessun trattino basso: la finestra non
    // trova niente e la coda torna a essere di 10 caratteri esatti.
    expect(spezzaNomeFile('CurriculumVitaeAnnaMariaVerdi2026.pdf')[1]).toBe('di2026.pdf')
  })

  it('il punto dell’estensione NON è un confine', () => {
    // Se lo fosse, «relazione finale del progetto.numbers» darebbe coda
    // «numbers» — l'estensione senza il suo punto, cioè esattamente il pezzo che
    // il troncamento centrale esiste per proteggere.
    const [, coda] = spezzaNomeFile('relazione finale del progetto.numbers')
    expect(coda.startsWith('.'), 'la coda comincia con un punto orfano').toBe(false)
    expect(coda, 'l’estensione ha perso il proprio punto').toBe('to.numbers')
  })

  it('la coda non supera mai metà del nome, e i nomi corti non si spezzano', () => {
    for (const nome of NOMI) {
      const [radice, coda] = spezzaNomeFile(nome)
      if (nome.length <= 10) {
        expect(radice, `«${nome}» è corto e non va spezzato`).toBe('')
        continue
      }
      expect(
        coda.length,
        `la coda di «${nome}» si è presa più di metà nome: la radice non ha più spazio`,
      ).toBeLessThanOrEqual(Math.floor(nome.length / 2))
    }
  })
})
