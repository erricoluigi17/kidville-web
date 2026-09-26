import { describe, it, expect } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { useForm, type FieldValues } from 'react-hook-form'
import { FieldRenderer } from '@/components/features/forms/FieldRenderer'
import { CHILD_FIELDS, ADULT_FIELDS } from '@/lib/forms/enrollment-template'
import { validaCodiceFiscale } from '@/lib/fiscale/validazione'
import type { FormField } from '@/types/database.types'
import itCampi from '../../messages/it/parentForms.json'

// =============================================================================
// IL CODICE FISCALE OMOCODICO, NEL CAMPO VERO DEL MODULO D'ISCRIZIONE (26/09/2026)
//
// Il wizard pubblico valida sul client con la STESSA `validateField` del server,
// passandole il campo così come lo dichiara lo schema — pattern compreso. Fino a
// oggi il pattern dei campi `CHILD_FIELDS.codice_fiscale` e
// `ADULT_FIELDS.fiscal_code` era a sole cifre nelle posizioni numeriche: un codice
// OMOCODICO (cifre sostituite dall'Agenzia con L M N P Q R S T U V), con il
// carattere di controllo giusto, restava fermo su «Inserisci un codice fiscale
// valido (16 caratteri)» e la famiglia non poteva andare avanti.
//
// Qui si monta il campo nel FieldRenderer con react-hook-form, si scrive il
// codice e si fa ciò che fa «Avanti» (`trigger()`). L'esito di `trigger` è reso a
// schermo e si aspetta la sua PRESENZA: un'attesa sull'assenza del messaggio
// d'errore sarebbe vera anche prima che la validazione giri.
//
// I codici sono costruiti da uno che non è di nessuno (`Z999` non è un luogo):
// `XQQYKV19CLTZVVVR` ha giorno e catastale in lettere d'omocodia e il controllo
// ricalcolato; `…VVVS` è lo stesso con il controllo sbagliato.
// =============================================================================

const CF_OMOCODICO = 'XQQYKV19CLTZVVVR'
const CF_OMOCODICO_SBAGLIATO = 'XQQYKV19CLTZVVVS'
const MSG_FORMA = 'Inserisci un codice fiscale valido (16 caratteri)'

function Harness({ field }: { field: FormField }) {
  const { register, control, trigger, formState: { errors } } = useForm<FieldValues>({ mode: 'onTouched' })
  const [esito, setEsito] = useState<string | null>(null)
  return (
    <form>
      <FieldRenderer field={field} modelId="m" register={register} control={control} error={errors[field.id]} />
      <button type="button" onClick={() => { void trigger().then((ok) => setEsito(ok ? 'passo-valido' : 'passo-non-valido')) }}>
        Avanti
      </button>
      {esito && <output>{esito}</output>}
    </form>
  )
}

const CAMPI: { nome: string; field: FormField }[] = [
  { nome: 'bambino (CHILD_FIELDS.codice_fiscale)', field: CHILD_FIELDS.find((c) => c.id === 'codice_fiscale')! },
  { nome: 'adulto (ADULT_FIELDS.fiscal_code)', field: ADULT_FIELDS.find((c) => c.id === 'fiscal_code')! },
]

const scriviEAvanti = (valore: string) => {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: valore } })
  fireEvent.click(screen.getByRole('button', { name: 'Avanti' }))
}

describe('FieldRenderer · codice fiscale omocodico nel modulo d’iscrizione', () => {
  it('i codici di prova sono quello che dicono, e i campi portano un pattern', () => {
    expect(validaCodiceFiscale(CF_OMOCODICO)).toMatchObject({ valido: true, omocodia: true })
    expect(validaCodiceFiscale(CF_OMOCODICO_SBAGLIATO).motivi).toEqual(['checksum'])
    for (const { nome, field } of CAMPI) expect(field?.validation?.pattern, nome).toBeTruthy()
    // Il messaggio del controllo è quello del catalogo: se la chiave sparisse, il test
    // sotto confronterebbe il nome della chiave.
    expect(itCampi.codiceFiscaleNonValido).toBe('Il codice fiscale non è valido: controlla lettere e numeri')
  })

  it.each(CAMPI)('$nome: omocodico con controllo giusto → il passo è valido', async ({ field }) => {
    render(<Harness field={field} />)
    scriviEAvanti(CF_OMOCODICO)
    expect(await screen.findByText('passo-valido')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each(CAMPI)('$nome: omocodico con controllo sbagliato → fermato dal CONTROLLO, non dalla forma', async ({ field }) => {
    render(<Harness field={field} />)
    scriviEAvanti(CF_OMOCODICO_SBAGLIATO)
    expect(await screen.findByText('passo-non-valido')).toBeInTheDocument()
    const avviso = await screen.findByRole('alert')
    expect(avviso).toHaveTextContent(itCampi.codiceFiscaleNonValido)
    expect(avviso).not.toHaveTextContent(MSG_FORMA)
  })
})
