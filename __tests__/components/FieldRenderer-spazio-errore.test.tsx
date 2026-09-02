import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useForm, type FieldValues } from 'react-hook-form'
import { FieldRenderer } from '@/components/features/forms/FieldRenderer'
import type { FormField } from '@/types/database.types'
import itCampi from '../../messages/it/parentForms.json'

// =============================================================================
// LO SPAZIO DEL MESSAGGIO D'ERRORE, UNA VOLTA PRESO, NON SI RESTITUISCE.
//
// ─── IL DIFETTO, MISURATO ────────────────────────────────────────────────────
// Passo «Consensi» di `/iscrizione`, WebKit (Safari e la WebView iOS dell'app),
// dal trace della CI:
//  1. «Avanti» senza spunta → `trigger()` scrive l'errore, `setFocus` porta il
//     fuoco sulla casella. Il `<p role="alert">` ENTRA NEL FLUSSO e spinge i
//     comandi giù di **31,99 px** (667,71 → 699,70);
//  2. il genitore spunta la casella con un tocco vero. WebKit NON assegna il
//     fuoco a un checkbox cliccato → il fuoco cade su `<body>` → **blur**;
//  3. `mode: 'onTouched'` valida al blur → il campo diventa valido → il
//     messaggio viene RIMOSSO (misurato: `errore:false` a t=0 ms su WebKit;
//     su Chromium resta `true` per 540 ms);
//  4. rimosso il messaggio, «Avanti» RISALE di **24,98 px** — più della sua
//     semi-altezza (20 px su 40);
//  5. il tocco in corso, calcolato sulla posizione *con* l'errore, cade fuori
//     dal pulsante. Il wizard resta fermo senza dire niente.
// Su Chromium i passi 2-4 non avvengono: nessun blur, nessuna rimozione,
// layout immobile. Da qui il «solo webkit» — e da qui il fatto che a pagarlo
// siano i genitori su iPhone, sul modulo che riceve ~6 domande al giorno.
//
// ─── LA REGOLA CHE QUESTI TEST FISSANO ───────────────────────────────────────
// Il messaggio può comparire e sparire quanto vuole: **i comandi non si
// muovono**. Lo spazio che il messaggio ha occupato resta riservato per tutta
// la vita del campo, con un'OMBRA — una copia identica del messaggio, resa
// `invisible` (che occupa lo spazio e non si vede) e `aria-hidden`.
//
// ⚠️ Perché pigra e non sempre riservata: un `min-h` incondizionato metterebbe
// spazio morto sotto OGNI campo di ogni modulo pubblico, anche in una pagina
// che non ha mai sbagliato niente — al passo dei consensi sono quattro campi.
// L'ombra nasce solo dopo che un errore c'è stato davvero: a riposo la pila è
// identica a prima (§1), dopo il primo errore non si muove più (§2).
//
// ⚠️ Perché una COPIA e non un `min-h` fisso: l'altezza del messaggio dipende
// da quante righe occupa. MISURATO nella pagina viva (build di produzione,
// sonda nel pannello del wizard di `/iscrizione`) restringendo la colonna:
// «Devi accettare per proseguire» sta su una riga (16 px) fino a 200 px e ne
// occupa DUE (32 px) a 150 px, dove il salto prima della correzione era di
// **41 px** invece di 25. Un `min-h-4` ne avrebbe riservati 16 su 32.
//
// jsdom non impagina: qui si verifica ciò che DETERMINA l'altezza (il nodo
// c'è, porta lo stesso testo, la stessa icona e le stesse classi
// tipografiche). La misura in pixel sta nel rapporto dell'intervento, presa
// nel browser sulla build di produzione.
// =============================================================================

function Harness({ field }: { field: FormField }) {
  const {
    register,
    control,
    trigger,
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
      {/* Il wizard fa esattamente questo su «Avanti»: valida il passo. */}
      <button type="button" onClick={() => void trigger()}>
        Valida
      </button>
    </form>
  )
}

const classi = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)

const CONSENSO: FormField = {
  id: 'presa_visione_informativa',
  type: 'consent',
  label: 'Ho letto l’informativa sulla privacy',
  required: true,
  text: 'Dichiaro di aver preso visione dell’informativa sul trattamento dei dati personali.',
  link: '/privacy',
}

const TESTO: FormField = { id: 'nome', type: 'text', label: 'Nome', required: true }

/**
 * I due casi, con il gesto che nel prodotto fa sparire il messaggio: la spunta
 * sul consenso, la digitazione sul campo di testo. È lo stesso `FieldRenderer`
 * in due rami diversi, e fino al 25/08/2026 i due rami hanno già impaginato la
 * stessa coppia in due modi: qui si pretende che rispondano uguale.
 */
/*
 * ⚠️ `click` E POI `blur`, e non è un dettaglio del banco di prova: è la catena
 * misurata. WebKit non assegna il fuoco a un checkbox cliccato, il fuoco cade su
 * `<body>`, e `mode: 'onTouched'` valida proprio al blur. È il blur — non il
 * click — che porta via il messaggio mentre il dito sta ancora scendendo.
 * (Verificato al primo giro di questo test: col solo `click`, in jsdom, RHF non
 * rivalida e il messaggio resta. Il test sarebbe stato verde per il motivo
 * sbagliato.)
 */
const CASI = [
  {
    nome: 'consenso (il campo su cui il difetto è stato misurato)',
    field: CONSENSO,
    messaggio: itCampi.devAccettare,
    correggi: () => {
      const c = screen.getByRole('checkbox')
      fireEvent.click(c)
      fireEvent.blur(c)
    },
    risbaglia: () => {
      const c = screen.getByRole('checkbox')
      fireEvent.click(c)
      fireEvent.blur(c)
    },
  },
  {
    nome: 'campo di testo (lo stesso componente, l’altro ramo)',
    field: TESTO,
    messaggio: itCampi.campoObbligatorio,
    correggi: () => {
      const i = screen.getByRole('textbox')
      fireEvent.change(i, { target: { value: 'Ines' } })
      fireEvent.blur(i)
    },
    risbaglia: () => {
      const i = screen.getByRole('textbox')
      fireEvent.change(i, { target: { value: '' } })
      fireEvent.blur(i)
    },
  },
] as const

describe('§1 · a riposo non c’è nessuno spazio riservato (la pagina sana resta com’era)', () => {
  it.each(CASI)('$nome: prima di qualunque errore il messaggio non esiste in nessuna forma', async ({ field, messaggio }) => {
    render(<Harness field={field} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(
      screen.queryByText(messaggio),
      'c’è spazio riservato in una pagina che non ha mai sbagliato niente',
    ).toBeNull()
  })
})

describe('§2 · quando il messaggio se ne va, il suo spazio resta', () => {
  it.each(CASI)('$nome: l’ombra porta testo, icona e classi del messaggio vero', async ({ field, messaggio, correggi }) => {
    render(<Harness field={field} />)

    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(messaggio)
    // Mentre il messaggio c'è, di copie ce n'è UNA: l'ombra non si somma.
    expect(screen.getAllByText(messaggio)).toHaveLength(1)
    const classiVere = classi(avviso)

    correggi()

    // Il messaggio non è più né annunciato né visibile…
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

    // …ma il suo spazio è ancora lì.
    const ombra = screen.getByText(messaggio)
    expect(
      ombra.getAttribute('aria-hidden'),
      'l’ombra è leggibile da chi ascolta: ripeterebbe un errore che non c’è più',
    ).toBe('true')
    const classiOmbra = classi(ombra)
    expect(classiOmbra, 'l’ombra si vede: doveva occupare lo spazio, non mostrarsi').toContain(
      'invisible',
    )
    // L'ALTEZZA è la stessa solo se lo è tutto ciò che la determina: la taglia
    // del testo, l'interlinea, il peso (che cambia la larghezza, quindi le
    // righe), la disposizione e l'icona.
    for (const c of classiVere) {
      expect(classiOmbra, `l’ombra non porta «${c}»: può impaginarsi diversamente`).toContain(c)
    }
    expect(ombra.querySelector('svg'), 'l’ombra è senza icona: 14 px di larghezza in meno').not.toBeNull()
  })

  it.each(CASI)('$nome: l’ombra non è un secondo `alert` vuoto né un doppione dell’`id`', async ({ field, correggi }) => {
    render(<Harness field={field} />)
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    await screen.findByRole('alert')
    correggi()
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

    // Nessuna live region in più negli snapshot di accessibilità: sulle pagine
    // pubbliche ce n'è già una in coda, e una seconda sempre presente
    // annuncerebbe (o farebbe annunciare) il vuoto.
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0)
    // `<id>-error` è il bersaglio di `aria-describedby`: due nodi con lo stesso
    // `id` renderebbero la descrizione del campo non deterministica.
    expect(document.querySelectorAll(`[id="${field.id}-error"]`).length).toBeLessThanOrEqual(1)
  })

  it.each(CASI)('$nome: quando l’errore torna, il nodo dell’`alert` è NUOVO (l’annuncio scatta)', async ({
    field,
    messaggio,
    correggi,
    risbaglia,
  }) => {
    render(<Harness field={field} />)
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    await screen.findByRole('alert')
    correggi()
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    const ombra = screen.getByText(messaggio)

    risbaglia()
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    const avviso = await screen.findByRole('alert')

    // Una regione viva che compare INSIEME al proprio contenuto è ciò che le
    // tecnologie assistive annunciano; trasformare in `alert` un nodo che era
    // già lì è comportamento non specificato. Il nodo dev'essere un altro.
    expect(avviso, 'l’ombra è stata riciclata in `alert`: l’annuncio può non partire').not.toBe(
      ombra,
    )
    expect(avviso).toHaveTextContent(messaggio)
    expect(screen.getAllByText(messaggio)).toHaveLength(1)
  })
})
