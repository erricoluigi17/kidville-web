import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useForm, type FieldValues } from 'react-hook-form'
import { FieldRenderer } from '@/components/features/forms/FieldRenderer'
import type { FormField } from '@/types/database.types'

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

function Harness({ field }: { field: FormField }) {
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
      />
      <button type="button" onClick={() => void trigger()}>Valida</button>
      {/* Il wizard fa esattamente questo dopo un «Avanti» fallito:
          `setFocus(primoCampoInErrore.id)`. */}
      <button type="button" onClick={() => setFocus(field.id)}>Fuoco</button>
    </form>
  )
}

const classi = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)

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
    await screen.findByText('Campo obbligatorio')

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
    const msg = await screen.findByText('Campo obbligatorio')
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
    expect(classi(spunta.closest('label')!)).toContain('bg-kidville-white')
    fireEvent.click(spunta)
    await waitFor(() =>
      expect(classi(screen.getByRole('checkbox').closest('label')!)).toContain('bg-kidville-green-soft'),
    )
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

  it('CONTROLLO POSITIVO: dove il `ref` non arriva, il fuoco NON si sposta', async () => {
    // Il campo `file` disegna una <label> e un input nascosto, e il `Controller`
    // non gli passa nessun `ref`: è la situazione in cui stavano consenso e
    // caselle prima dell'11/08/2026. Serve a dimostrare che i due `expect` qui
    // sopra non passerebbero comunque, qualunque cosa faccia `setFocus`.
    render(<Harness field={{ id: 'doc', type: 'file', label: 'Documento' }} />)
    fireEvent.click(screen.getByRole('button', { name: /fuoco/i }))
    await new Promise((r) => setTimeout(r, 0))
    const nascosto = document.querySelector('input[type="file"]')
    expect(nascosto).toBeTruthy()
    expect(document.activeElement).not.toBe(nascosto)
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
    await screen.findByText('Campo obbligatorio')
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
    // Il bersaglio: `py-3` + interlinea di `text-sm` = 44px, sopra i 24 di 2.5.8.
    const c = classi(a)
    expect(c).toContain('py-3')
    expect(c).toContain('text-sm')
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
  const card = (controllo: Element) => controllo.closest('label')!
  /** Il consenso ha una <label> sola e il nome accessibile porta anche l'asterisco. */
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
