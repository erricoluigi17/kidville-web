import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { useForm, type FieldValues } from 'react-hook-form'
import { FieldRenderer } from '@/components/features/forms/FieldRenderer'
import { MSG_CAMPO_OBBLIGATORIO, MSG_ALLEGA_FILE } from '@/lib/forms/validate-fields'
import type { FormField } from '@/types/database.types'
import itCampi from '../../messages/it/parentForms.json'
import enCampi from '../../messages/en/parentForms.json'
import itPublic from '../../messages/it/public.json'
import enPublic from '../../messages/en/public.json'

/**
 * ─── LA FRASE CHE FERMA QUALCUNO SI LEGGE NELLA SUA LINGUA ──────────────────
 *
 * MISURATO il 2026-08-25 su `/lavora-con-noi` con `KV_LOCALE=en`: sotto un campo
 * etichettato «Curriculum», e sopra una nota inglese, compariva in rosso «Allega
 * un file per proseguire». Fino al 24/08 quel campo era facoltativo e quell'errore
 * non fermava nessuno; da quel giorno è l'unico che blocca il passo.
 *
 * ⚠️ E NON ERA L'UNICA STRINGA, che è il motivo per cui il rimedio non è una
 * chiave dedicata al campo file. `validateField` ritorna italiano per OGNI
 * predicato: nella stessa schermata inglese «Titolo di studio» e «Per quali
 * posizioni ti proponi» dicevano già «Campo obbligatorio». Tradurre il solo
 * messaggio nuovo avrebbe prodotto una pagina inglese con una riga italiana
 * accanto — mezza traduzione, cioè una voce in più, non una in meno.
 *
 * Il residuo (email, data, numero, pattern) resta dichiarato in `validate-fields`
 * ed è fuori dal perimetro di questo lavoro: qui si chiude l'OBBLIGO, che è il
 * messaggio che si legge per primo e che compare su ogni campo.
 */
afterEach(() => cleanup())

function Banco({ field }: { field: FormField }) {
  const {
    register,
    control,
    trigger,
    formState: { errors },
  } = useForm<FieldValues>({ mode: 'onTouched' })
  return (
    <form>
      <FieldRenderer field={field} modelId="m" register={register} control={control} error={errors[field.id]} />
      <button type="button" onClick={() => void trigger()}>Valida</button>
    </form>
  )
}

const RADICE = process.cwd()
/** Dove vive la mappatura costante → catalogo: un posto solo, e questo. */
const MAPPATURA = 'src/components/features/forms/messaggio-campo.ts'

describe('i18n — l’obbligo di un campo', () => {
  it('le due frasi stanno in ENTRAMBI i cataloghi, e in inglese sono davvero inglesi', () => {
    for (const chiave of ['campoObbligatorio', 'allegaFile'] as const) {
      expect(itCampi[chiave], `manca in italiano: ${chiave}`).toBeTruthy()
      expect(enCampi[chiave], `manca in inglese: ${chiave}`).toBeTruthy()
      // Il difetto vero non è la chiave assente: è la chiave presente con dentro
      // l'italiano. Un catalogo inglese che ricopia l'italiano passa ogni lock di
      // parità (le chiavi ci sono, e sono simmetriche) e mente a schermo.
      expect(enCampi[chiave], `l’inglese ricopia l’italiano: ${chiave}`).not.toBe(itCampi[chiave])
    }
  })

  /*
   * ── IL CATALOGO NON È LA COSTANTE, ED È LA COSA CHE RENDE VERI GLI ALTRI TEST ─
   *
   * Fino al quinto giro qui c'era scritto il contrario: `itCampi.campoObbligatorio`
   * DOVEVA essere identico a `MSG_CAMPO_OBBLIGATORIO`, «altrimenti il confronto
   * smette di scattare». Era falso, e nel modo peggiore — falso in favore di sé.
   * Il confronto che scatta è `errGrezzo === MSG_CAMPO_OBBLIGATORIO` dentro
   * `FieldRenderer`: mette a fronte il ritorno della regola e la COSTANTE, e il
   * catalogo non ci entra. Pretendere che le due stringhe coincidessero non
   * proteggeva niente e impediva l'unica cosa che serviva: dare al messaggio una
   * frase migliore di quella che il server risponde.
   *
   * ⚠️ E FACEVA DI PEGGIO: rendeva incapace di fallire il test qui sotto («a
   * schermo esce la voce del CATALOGO, non il ritorno grezzo»). Con catalogo e
   * costante identici, `findByText(itCampi.campoObbligatorio)` è verde tanto se la
   * sostituzione avviene quanto se `FieldRenderer` lascia passare la stringa
   * grezza: la prova c'era ed era quella che mentiva. Dal 2026-08-25 le due
   * stringhe DIVERGONO, e quel test ha i denti.
   * PROVATO PER MUTAZIONE: riportando il ramo di `FieldRenderer` a `errGrezzo`
   * il test «…e lo stesso vale per il campo che non è un allegato» diventa rosso.
   *
   * Resta invece legittimo — e voluto — che `allegaFile` coincida con la sua
   * costante: lì la frase umana è stata messa da questo stesso lavoro su ENTRAMBI
   * i lati, server compreso. La coincidenza è il risultato, non il vincolo.
   */
  it('il catalogo italiano NON ricopia la risposta grezza della regola', () => {
    // «Campo obbligatorio» è la risposta di un database: è ciò che il server
    // risponde e ciò che `FieldRenderer` deve SOSTITUIRE, non ciò che si legge.
    expect(
      itCampi.campoObbligatorio,
      'il catalogo è tornato a ricopiare la risposta grezza: a schermo si legge di nuovo la frase del database',
    ).not.toBe(MSG_CAMPO_OBBLIGATORIO)
    // …e la frase del catalogo è della stessa famiglia delle altre tre
    // dell'obbligo, che chiudono tutte con «per proseguire» / «to continue».
    expect(itCampi.campoObbligatorio).toMatch(/per proseguire$/)
    expect(enCampi.campoObbligatorio).toMatch(/to continue$/)
    expect(itCampi.allegaFile).toBe(MSG_ALLEGA_FILE)
  })

  it('`validateField` non cabla più le due frasi: le espone come costanti', () => {
    const codice = fs.readFileSync(path.join(RADICE, 'src/lib/forms/validate-fields.ts'), 'utf8')
    const corpo = codice.slice(codice.indexOf('export function validateField'))
    expect(corpo, 'la frase è di nuovo ribattuta dentro la funzione').not.toContain(`'${MSG_ALLEGA_FILE}'`)
    expect(corpo).not.toContain(`'${MSG_CAMPO_OBBLIGATORIO}'`)
  })

  it('la mappatura non ribatte le due frasi: importa le costanti', () => {
    // ⚠️ IL FILE È CAMBIATO IL 25/08 (settimo giro) e il lock lo segue: la
    // mappatura costante → catalogo NON sta più dentro `FieldRenderer`, perché non
    // era vero che «passa tutto da lì» (vedi il lock «un solo lettore del messaggio
    // grezzo» in fondo a questo file). Vive in `messaggio-campo.ts`, che è anche
    // l'unico posto dove la sostituzione può essere aggiunta o tolta.
    const senzaCommenti = fs
      .readFileSync(path.join(RADICE, MAPPATURA), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(senzaCommenti).toContain('MSG_ALLEGA_FILE')
    expect(senzaCommenti).toContain('MSG_CAMPO_OBBLIGATORIO')
    expect(senzaCommenti, 'la frase è ribattuta a mano invece che importata').not.toContain(
      `'${MSG_ALLEGA_FILE}'`,
    )
    // ⚠️ E LE COSTANTI DEVONO ESSERE USATE, non solo importate. Provato per
    // mutazione: riportando `errMsg` al ritorno grezzo della regola, i due nomi
    // restavano nel file (l'`import` non si cancella da solo) e questo lock
    // sarebbe rimasto verde su una schermata inglese con dentro l'italiano. Le
    // due righe qui sotto sono la cosa che cade.
    expect(senzaCommenti, 'la costante è importata ma nessuno la scambia col catalogo').toContain(
      "t('allegaFile')",
    )
    expect(senzaCommenti).toContain("t('campoObbligatorio')")
  })

  it('a schermo esce la voce del CATALOGO, non il ritorno grezzo della regola', async () => {
    // Il mock di next-intl risolve sull'italiano reale: se la chiave sparisse dal
    // catalogo, qui comparirebbe la stringa «parentForms.allegaFile».
    render(<Banco field={{ id: 'cv_path', type: 'file', label: 'Curriculum', required: true }} />)
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    expect(await screen.findByText(itCampi.allegaFile)).toBeInTheDocument()
    expect(screen.queryByText('parentForms.allegaFile')).toBeNull()
  })

  it('…e lo stesso vale per il campo che non è un allegato', async () => {
    render(<Banco field={{ id: 'titolo', type: 'text', label: 'Titolo di studio', required: true }} />)
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    expect(await screen.findByText(itCampi.campoObbligatorio)).toBeInTheDocument()
    expect(screen.queryByText('parentForms.campoObbligatorio')).toBeNull()
  })
})

/**
 * ─── E L'OBBLIGO NON PARLA DUE DIALETTI SULLA STESSA SCHERMATA ──────────────
 *
 * Rilievo del critico di lingua, 2026-08-25, MISURATO leggendo insieme i tre
 * `[role=alert]` del passo «Il tuo profilo» dopo un «Avanti» a passo vuoto:
 *   ["Campo obbligatorio", "Campo obbligatorio", "Allega un file per proseguire"]
 *
 * «Campo obbligatorio» è la risposta di un database. Il lavoro del 24/08 l'aveva
 * riconosciuto — e aveva dato la frase umana a UN TIPO SOLO. Il risultato è
 * peggiore del punto di partenza in un aspetto: a mezzo metro di distanza sulla
 * stessa colonna il prodotto dimostra di saper parlare a una persona e sceglie di
 * non farlo due volte su tre.
 *
 * ⚠️ E LA FRASE GIUSTA IL PRODOTTO CE L'HA GIÀ SCRITTA, al passo 1 dello stesso
 * wizard: `candSedeErrore` = «Scegli almeno una sede per proseguire». Stesso
 * predicato («almeno uno di N»), stessa cadenza. Non si inventa un registro
 * nuovo: si copia quello che il modulo usa già.
 */
describe('i18n — l’obbligo parla la stessa lingua su tutti i tipi di campo', () => {
  it('scelta multipla e menu hanno la loro frase, in entrambi i cataloghi', () => {
    for (const chiave of ['scegliOpzione', 'scegliDaElenco'] as const) {
      expect(itCampi[chiave], `manca in italiano: ${chiave}`).toBeTruthy()
      expect(enCampi[chiave], `manca in inglese: ${chiave}`).toBeTruthy()
      expect(enCampi[chiave], `l’inglese ricopia l’italiano: ${chiave}`).not.toBe(itCampi[chiave])
    }
  })

  it('…e sono ESATTAMENTE quelle che `validateField` ritorna', async () => {
    const { MSG_SCEGLI_OPZIONE, MSG_SCEGLI_DA_ELENCO } = await import('@/lib/forms/validate-fields')
    // ⚠️ PRIMA CHE ESISTANO, `undefined === undefined` è VERO: senza queste due
    // righe il confronto qui sotto approverebbe due costanti mai scritte. È la
    // stessa trappola del filtro `-t` che non trova niente ed esce zero.
    expect(MSG_SCEGLI_OPZIONE, 'la costante non esiste').toBeTruthy()
    expect(MSG_SCEGLI_DA_ELENCO, 'la costante non esiste').toBeTruthy()
    expect(itCampi.scegliOpzione).toBe(MSG_SCEGLI_OPZIONE)
    expect(itCampi.scegliDaElenco).toBe(MSG_SCEGLI_DA_ELENCO)
  })

  it('un gruppo a spunta vuoto non dice più «Campo obbligatorio»', async () => {
    render(
      <Banco
        field={{
          id: 'posizioni', type: 'checkbox', label: 'Per quali posizioni ti proponi', required: true,
          options: [{ value: 'a', label: 'Insegnante' }, { value: 'b', label: 'Educatrice' }],
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    expect(await screen.findByText(itCampi.scegliOpzione)).toBeInTheDocument()
    expect(screen.queryByText(itCampi.campoObbligatorio)).toBeNull()
  })

  it('…e un menu vuoto nemmeno', async () => {
    render(
      <Banco
        field={{
          id: 'titolo_studio', type: 'select', label: 'Titolo di studio', required: true,
          options: [{ value: 'diploma', label: 'Diploma' }],
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    expect(await screen.findByText(itCampi.scegliDaElenco)).toBeInTheDocument()
    expect(screen.queryByText(itCampi.campoObbligatorio)).toBeNull()
  })

  it('CONTROLLO NEGATIVO: un campo di testo continua a cadere sul ramo di default', async () => {
    // Senza questa riga il ramo nuovo potrebbe inghiottire ogni tipo e il test
    // sopra resterebbe verde. `campoObbligatorio` deve restare la risposta di
    // default, non diventare codice morto.
    // ⚠️ IL TITOLO NON DICE PIÙ «Campo obbligatorio» perché dal 2026-08-25 non è
    // più quello che si legge: la costante resta la risposta del server, il
    // catalogo dice «Compila questo campo per proseguire». L'asserzione guarda il
    // catalogo, che è ciò che una persona legge.
    render(<Banco field={{ id: 'nome', type: 'text', label: 'Nome', required: true }} />)
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    expect(await screen.findByText(itCampi.campoObbligatorio)).toBeInTheDocument()
  })
})

/**
 * ─── LE DUE LINGUE DICONO LA STESSA COSA, NON SOLO LE STESSE CHIAVI ─────────
 *
 * Un lock di parità verifica che `it` ed `en` abbiano le stesse chiavi. Due
 * cataloghi possono essere perfettamente simmetrici e dire cose diverse: è
 * successo qui, e nel verso peggiore — l'italiano, che è la lingua della quasi
 * totalità di chi si candida, riceveva MENO informazione dell'inglese.
 */
describe('i18n — parità di SIGNIFICATO sulle voci del curriculum', () => {
  it('il collegamento nomina il documento in tutte e due le lingue', () => {
    // EN diceva «Read the full privacy notice» — nomina il documento. IT diceva
    // «Leggi l'informativa completa»: non dice mai DI CHE COSA, e «completa»
    // promette che qui sopra ce ne sia una breve (qui sopra c'è una nota sui
    // formati dei file). Sul passo 3 la parola «privacy» non compare altrove.
    expect(itCampi.leggiInformativaCompleta.toLowerCase()).toContain('privacy')
    expect(enCampi.leggiInformativaCompleta.toLowerCase()).toContain('privacy')
  })

  it('l’attesa dice anche COSA FARE, e non porta un punto che i suoi vicini non hanno', () => {
    // Il passo NON avanza da solo a caricamento finito: bisogna ripremere
    // «Avanti». Un messaggio che dice solo cos'è successo manda a tentativi
    // proprio chi sta caricando una fotografia da rete mobile.
    expect(itCampi.attendiCaricamento).toMatch(/riprova/i)
    expect(enCampi.attendiCaricamento).toMatch(/try again/i)
    // Lo stesso `<p role="alert">` alterna questa frase e «Allega un file per
    // proseguire»: due messaggi punteggiati in due modi nello stesso nodo.
    for (const [lingua, testo] of [['it', itCampi.attendiCaricamento], ['en', enCampi.attendiCaricamento]] as const) {
      expect(testo.endsWith('.'), `${lingua}: punto finale che i vicini non hanno`).toBe(false)
    }
    expect(itCampi.allegaFile.endsWith('.')).toBe(false)
  })

  /*
   * ── IL MENU E IL SUO ERRORE CHIAMANO IL GESTO CON LO STESSO VERBO ──────────
   *
   * Rilievo del quarto giro (2026-08-25). Il segnaposto del menu a tendina dice
   * «Seleziona…»; l'errore dello STESSO campo diceva «Scegli un'opzione per
   * proseguire». Due verbi per lo stesso gesto a venti pixel di distanza, e in
   * inglese uguale: «Select…» contro «Choose an option to continue». Sul passo
   * «Il tuo profilo» succede letteralmente sotto «Titolo di studio».
   *
   * La cadenza era stata copiata da `candSedeErrore` («Scegli almeno una sede per
   * proseguire»), che però è un gruppo di schede da spuntare: lì non c'è nessun
   * segnaposto che dica un'altra parola, e infatti `scegliOpzione` resta con
   * «Scegli» ed è giusto così.
   *
   * ⚠️ DAL 25/08 (ottavo giro) `scegliOpzione` VALE PER IL SOLO `checkbox`. Il
   * `radio` è passato sul ramo del menu: `FieldRenderer` lo rende come
   * `role="radiogroup"`, che accetta ESATTAMENTE UNA opzione, e «Scegli almeno
   * un'opzione» gli faceva promettere che se ne potessero prendere più d'una. Il
   * predicato del gruppo a scelta singola è quello del menu — uno e uno solo fra N.
   *
   * ⚠️ IL VERBO SI LEGGE DAL SEGNAPOSTO, NON SI RIBATTE QUI: se domani
   * «Seleziona…» diventa un'altra parola, questo test lo pretende anche
   * nell'errore invece di restare verde su una coppia che ha smesso di
   * corrispondere.
   */
  it('il menu a tendina e il suo errore usano il verbo del segnaposto', () => {
    for (const [lingua, campi] of [['it', itCampi], ['en', enCampi]] as const) {
      const verbo = campi.seleziona.replace(/[…....]+$/u, '').trim()
      expect(verbo.length, `${lingua}: il segnaposto del menu è vuoto`).toBeGreaterThan(2)
      expect(
        campi.scegliDaElenco.toLowerCase().startsWith(verbo.toLowerCase()),
        `${lingua}: il menu dice «${campi.seleziona}» e il suo errore «${campi.scegliDaElenco}»`,
      ).toBe(true)
    }
    // …e il gruppo a spunta NON segue: lì «Scegli» è la parola giusta, e la
    // cadenza è quella di `candSedeErrore`. Senza questa riga si potrebbe
    // «uniformare» anche quello e perdere la distinzione.
    expect(itCampi.scegliOpzione.toLowerCase().startsWith('scegli')).toBe(true)
  })

  /*
   * ── LE DUE FRASI LUNGHE NUOVE SI ARTICOLANO ALLO STESSO MODO NELLE DUE LINGUE ─
   *
   * Rilievo del quarto giro. `attendiCaricamento` e `candCvNota` usavano i DUE
   * PUNTI in italiano e la LINEETTA in inglese. Sono le uniche due righe dei due
   * cataloghi che divergano così, e divergono nello stesso verso: il resto
   * accoppia sempre due punti con due punti (`candRiepilogoControllaEmail`,
   * `candContestoTempi`, `candSediErroreCorpo`). È il tipo di scarto che il lock
   * di parità delle CHIAVI non può vedere, perché le chiavi sono in parità.
   *
   * ⚠️ E LA REGOLA SI DERIVA DALL'ITALIANO, non si scrive «due punti» qui: se un
   * giorno la frase italiana cambia articolazione, l'inglese deve seguirla, non
   * restare ancorato a una scelta di oggi.
   */
  it('le frasi lunghe si articolano allo stesso modo in italiano e in inglese', () => {
    const coppie: [string, string, string][] = [
      ['attendiCaricamento', itCampi.attendiCaricamento, enCampi.attendiCaricamento],
      ['candCvNota', itPublic.candCvNota, enPublic.candCvNota],
    ]
    for (const [nome, it, en] of coppie) {
      expect(it.includes(':'), `${nome}: l'italiano ha smesso di usare i due punti`).toBe(true)
      expect(en.includes(':'), `${nome}: l'inglese si articola con un segno diverso dall'italiano`).toBe(true)
      expect(en.includes('—'), `${nome}: lineetta in inglese dove l'italiano ha i due punti`).toBe(false)
    }
  })

  /*
   * ── E LA RIPROVA INGLESE DICE «PLEASE» COME LE SUE VICINE ──────────────────
   * `caricamentoNonRiuscito` («Upload failed. Please try again.») compare sotto
   * lo STESSO riquadro di `attendiCaricamento`. Le due frasi si alternano a un
   * centimetro l'una dall'altra: una chiede per favore e l'altra no.
   * Derivato dalla vicina, non ribattuto.
   */
  it('in inglese la riprova del file chiede «please» come la sua vicina di riquadro', () => {
    expect(enCampi.caricamentoNonRiuscito).toMatch(/please/i)
    expect(
      enCampi.attendiCaricamento,
      'sotto lo stesso riquadro una riprova chiede per favore e l’altra no',
    ).toMatch(/please/i)
  })

  it('riquadro, errore e nota chiamano il gesto con lo stesso verbo', () => {
    // Tre nomi per lo stesso gesto, tutti visibili insieme in quattro righe:
    // «Seleziona un file», «Allega un file per proseguire», «l'allegato». Un
    // messaggio d'errore indica un controllo: se gli dice di fare una cosa con un
    // verbo diverso da quello scritto DENTRO il controllo, chi legge in fretta
    // cerca due comandi invece di uno.
    expect(itCampi.selezionaFile.toLowerCase()).toContain('allega')
    expect(enCampi.selezionaFile.toLowerCase()).toContain('attach')
  })
})

/**
 * ─── LO STESSO COLLEGAMENTO HA UNA SOLA SORGENTE DI TESTO ───────────────────
 *
 * Prima del 25/08 il modulo aveva UN collegamento all'informativa (i consensi);
 * l'obbligo del curriculum ne ha aggiunto un secondo, un passo prima. I due
 * nascevano da sorgenti diverse: il campo dalla chiave del catalogo, i consensi
 * da `link_label` cablato in italiano dentro i template. In italiano coincidono;
 * con `KV_LOCALE=en` il passo 3 dice «Read the full privacy notice» e il passo 4
 * «Leggi l'informativa completa». Due rese della stessa frase, a un passo di
 * distanza, nello stesso componente.
 */
describe('i18n — una sola resa per lo stesso collegamento', () => {
  it('nessun template cabla più l’etichetta dell’informativa', () => {
    const cartella = path.join(RADICE, 'src/lib/forms')
    const colpevoli = fs
      .readdirSync(cartella)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /^\s*link_label:/m.test(fs.readFileSync(path.join(cartella, f), 'utf8')))
    expect(colpevoli, 'un template cabla di nuovo l’etichetta in italiano').toEqual([])
  })

  it('il ripiego del ramo consenso è la stessa chiave del ramo di campo', () => {
    // Il ramo `consent` ripiegava su `leggiInformativa` («Leggi l'informativa» /
    // «Read the policy»), il ramo generico su `leggiInformativaCompleta`. Tolti i
    // `link_label`, due rami dello stesso componente avrebbero cominciato a
    // scrivere due frasi diverse per lo stesso collegamento — e in italiano la
    // resa dei consensi sarebbe pure CAMBIATA rispetto a prima.
    const codice = fs.readFileSync(
      path.join(RADICE, 'src/components/features/forms/FieldRenderer.tsx'),
      'utf8',
    )
    const senzaCommenti = codice.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const ripieghi = [...senzaCommenti.matchAll(/etichetta=\{[^}]*t\('(leggiInformativa\w*)'\)/g)].map(
      (m) => m[1],
    )
    expect(ripieghi.length, 'nessun ripiego trovato: il collegamento ha cambiato forma').toBeGreaterThan(1)
    expect(new Set(ripieghi).size, 'due rami, due etichette per lo stesso collegamento').toBe(1)
    expect(ripieghi[0]).toBe('leggiInformativaCompleta')
  })

  it('la chiave rimasta senza consumatori è stata portata via con lui', () => {
    // `leggiInformativa` era il ripiego del solo ramo consenso. Cambiato quello,
    // nessuna riga di codice la nomina più: due stringhe che nessuno mostrerà mai.
    // È la regola del lock `messaggi-chiavi-orfane`, applicata a mano qui perché
    // `parentForms` non è ancora nel suo perimetro.
    expect('leggiInformativa' in itCampi, 'chiave morta rimasta in italiano').toBe(false)
    expect('leggiInformativa' in enCampi, 'chiave morta rimasta in inglese').toBe(false)
  })
})

/**
 * ─── UN SOLO LETTORE DEL MESSAGGIO GREZZO ───────────────────────────────────
 *
 * Il rimedio del 25/08 (quinto giro) scambiava la costante con la voce del
 * catalogo dentro `FieldRenderer`, e il ragionamento era «passa tutto da lì».
 * Non era vero, e la misura è arrivata da un critico due giri dopo.
 *
 * ⚠️ MISURATO su `/anagrafica-personale`, passo «I tuoi dati», dopo un «Avanti» a
 * passo vuoto, leggendo insieme i nove `[role=alert]` della stessa colonna:
 *   it → 8 frasi umane + «Campo obbligatorio»
 *   en → 8 frasi INGLESI  + «Campo obbligatorio»
 * Il sesto campo è il codice fiscale, reso a mano per potergli legare un
 * `aria-describedby` in più; provincia e comune di nascita e la scadenza del
 * documento sono nella stessa condizione. Quattro campi leggevano `.message`
 * grezzo e non passavano dalla sostituzione: su una pagina inglese si leggeva una
 * riga italiana, cioè la «mezza traduzione» che il quinto giro dichiarava chiusa.
 *
 * Da qui questo lock, che non guarda una stringa ma il NUMERO DI LETTORI: la
 * mappatura riceve l'oggetto d'errore e fa da sé la lettura di `.message`, quindi
 * il cast grezzo deve esistere in UN FILE SOLO. Un quinto campo reso a mano non
 * potrà ricomparire in silenzio.
 */
describe('i18n — la sostituzione ha un solo lettore del messaggio grezzo', () => {
  /** Le tre cartelle in cui si rende un campo di modulo a una persona. */
  const CARTELLE = [
    'src/components/features/forms',
    'src/components/features/public',
    'src/components/features/anagrafica',
  ]
  /** Il cast che legge il messaggio della regola senza passare dal catalogo. */
  const LETTURA_GREZZA = /as \{ message\?: string \}/

  function tuttiIFile(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((v) => {
      const intero = path.join(dir, v.name)
      if (v.isDirectory()) return tuttiIFile(intero)
      return /\.tsx?$/.test(v.name) ? [intero] : []
    })
  }

  it('il cast `as { message?: string }` esiste in un file solo, ed è la mappatura', () => {
    const file = CARTELLE.flatMap((c) => tuttiIFile(path.join(RADICE, c)))
    // ⚠️ PRIMA LA PROVA POSITIVA: se il censimento non trovasse niente (cartella
    // rinominata, estensione cambiata), l'elenco dei colpevoli sarebbe vuoto e
    // questo lock approverebbe qualunque cosa. È la trappola del filtro che non
    // trova niente ed esce zero.
    expect(file.length, 'il censimento non trova più i file dei moduli').toBeGreaterThanOrEqual(8)
    const lettori = file
      .filter((f) => LETTURA_GREZZA.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(RADICE, f))
    expect(lettori, 'la mappatura non legge più il messaggio grezzo: il lock guarda nel vuoto').toContain(
      MAPPATURA,
    )
    expect(
      lettori.filter((f) => f !== MAPPATURA),
      'un campo reso a mano legge il messaggio della regola senza passare dal catalogo: su una pagina inglese si leggerà «Campo obbligatorio»',
    ).toEqual([])
  })

  it('i campi resi a mano chiamano la mappatura', () => {
    // Il conteggio dei lettori dice che nessuno legge il grezzo; questa riga dice
    // che i tre file che PRIMA lo leggevano adesso chiamano la mappatura. Senza,
    // si potrebbe soddisfare il lock qui sopra cancellando il messaggio d'errore.
    for (const f of [
      'src/components/features/forms/FieldRenderer.tsx',
      'src/components/features/public/AnagraficaPersonaleWizard.tsx',
      'src/components/features/anagrafica/DocumentoIdentitaFields.tsx',
    ]) {
      const codice = fs.readFileSync(path.join(RADICE, f), 'utf8')
      expect(codice, `${f} non chiama più la mappatura`).toContain('useMessaggioCampo')
    }
  })
})
