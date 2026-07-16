import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useForm, type FieldValues } from 'react-hook-form'
import { FieldRenderer } from '@/components/features/forms/FieldRenderer'
import type { FormField } from '@/types/database.types'

// Harness minimale: un solo FieldRenderer dentro un form RHF + un bottone che
// forza la validazione (come fa il wizard alla pressione di "Avanti"). Serve a
// verificare in ISOLAMENTO la validazione per-campo, l'accessibilità e la UX
// provincia, senza trascinare l'intero wizard (framer-motion, fetch, ecc.).
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
      <button type="button" onClick={() => void trigger()}>
        Valida
      </button>
    </form>
  )
}

const provincia: FormField = {
  id: 'residence_province',
  type: 'text',
  label: 'Provincia di Residenza',
  required: true,
  placeholder: 'Es. RM',
  validation: { pattern: '^[A-Z]{2}$', min_length: 2, max_length: 2 },
}

describe('FieldRenderer — validazione e accessibilità', () => {
  it('(a) campo obbligatorio vuoto → messaggio visibile + aria-invalid + aria-describedby', async () => {
    render(<Harness field={{ id: 'nome', type: 'text', label: 'Nome', required: true }} />)
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))

    // Messaggio d'errore visibile (testo, non solo colore).
    const msg = await screen.findByText('Campo obbligatorio')
    expect(msg).toBeInTheDocument()
    // Il messaggio ha un id, l'input lo referenzia via aria-describedby.
    expect(msg).toHaveAttribute('id', 'nome-error')

    const input = screen.getByRole('textbox')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-describedby', 'nome-error')
  })

  it('(b) provincia "Napoli" → su blur diventa "NA"', async () => {
    render(<Harness field={provincia} />)
    const input = screen.getByPlaceholderText('Es. RM') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'Napoli' } })
    fireEvent.blur(input)

    await waitFor(() => expect(input.value).toBe('NA'))
  })

  it('(b2) provincia "na" minuscola → su blur diventa "NA"', async () => {
    render(<Harness field={provincia} />)
    const input = screen.getByPlaceholderText('Es. RM') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'na' } })
    fireEvent.blur(input)

    await waitFor(() => expect(input.value).toBe('NA'))
  })

  it('(c) provincia non riconoscibile → resta com\'è e la validazione la blocca', async () => {
    render(<Harness field={provincia} />)
    const input = screen.getByPlaceholderText('Es. RM') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'Zzz' } })
    fireEvent.blur(input)
    // Non riconoscibile: non viene troncata/indovinata (auto-MAIUSCOLO applicato).
    await waitFor(() => expect(input.value).toBe('ZZZ'))

    fireEvent.click(screen.getByRole('button', { name: /valida/i }))
    expect(await screen.findByText(/sigla della provincia/i)).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('(d) provincia valida "NA" → nessun errore', async () => {
    render(<Harness field={provincia} />)
    const input = screen.getByPlaceholderText('Es. RM') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'NA' } })
    fireEvent.blur(input)
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))

    // Dopo la validazione, nessun messaggio d'errore provincia.
    await waitFor(() => expect(input.value).toBe('NA'))
    expect(screen.queryByText(/sigla della provincia/i)).not.toBeInTheDocument()
    expect(input).not.toHaveAttribute('aria-invalid', 'true')
  })

  it('(e) pattern dichiarato (CAP) → valore non valido bloccato con messaggio dedicato', async () => {
    render(
      <Harness
        field={{
          id: 'zip_code',
          type: 'text',
          label: 'CAP',
          placeholder: '00100',
          validation: { pattern: '^[0-9]{5}$', min_length: 5, max_length: 5 },
        }}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '12' } })
    fireEvent.click(screen.getByRole('button', { name: /valida/i }))

    expect(await screen.findByText(/CAP/i)).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })
})

// La <label> deve essere ASSOCIATA al campo (htmlFor ↔ id): senza associazione
// uno screen reader non annuncia l'etichetta cliccando/tabbando sul campo, e il
// tocco sull'etichetta non porta il focus al controllo. getByLabelText trova il
// controllo solo se l'associazione esiste.
describe('FieldRenderer — associazione label ↔ campo', () => {
  it('(f) text: getByLabelText trova l\'input', () => {
    render(<Harness field={{ id: 'nome', type: 'text', label: 'Nome' }} />)
    expect(screen.getByLabelText('Nome')).toBeInstanceOf(HTMLInputElement)
  })
  it('(g) select: getByLabelText trova la select', () => {
    render(
      <Harness
        field={{ id: 'genere', type: 'select', label: 'Genere', options: [{ label: 'M', value: 'M' }, { label: 'F', value: 'F' }] }}
      />,
    )
    expect(screen.getByLabelText('Genere')).toBeInstanceOf(HTMLSelectElement)
  })
  it('(h) textarea: getByLabelText trova la textarea', () => {
    render(<Harness field={{ id: 'note', type: 'textarea', label: 'Note' }} />)
    expect(screen.getByLabelText('Note')).toBeInstanceOf(HTMLTextAreaElement)
  })
  it('(i) provincia (Controller): getByLabelText trova l\'input', () => {
    render(<Harness field={provincia} />)
    expect(screen.getByLabelText(/Provincia di Residenza/)).toBeInstanceOf(HTMLInputElement)
  })
})
