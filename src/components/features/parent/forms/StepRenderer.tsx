'use client'

import {
  useWatch,
  type UseFormRegister,
  type FieldErrors,
  type Control,
  type FieldValues,
} from 'react-hook-form'
import { FieldRenderer } from '@/components/features/forms/FieldRenderer'
import { LegendaObbligatori } from '@/components/features/public/wizard/pezzi-wizard-pubblico'
import { campiVisibili } from '@/lib/forms/conditional'
import type { FormPage } from '@/types/database.types'

interface Props {
  page: FormPage
  modelId: string
  register: UseFormRegister<FieldValues>
  control: Control<FieldValues>
  errors: FieldErrors
  /** Endpoint per l'upload allegati (autenticato o pubblico token-scoped). */
  uploadEndpoint?: string
}

export function StepRenderer({ page, modelId, register, control, errors, uploadEndpoint = '/api/forms/upload' }: Props) {
  // Valori correnti del form → applica la logica condizionale (DL-024).
  const values = (useWatch({ control }) as Record<string, unknown>) ?? {}
  const visibili = campiVisibili(page.fields, values)

  return (
    <div className="space-y-6">
      {/* ── CHE COSA SIGNIFICA QUELL'ASTERISCO (25/08/2026) ────────────────────
          `FieldRenderer` stampa un `*` verde accanto a ogni etichetta
          obbligatoria — di qualunque modulo, perché il componente è di tutti — e
          fino a oggi questa strada non lo spiegava da nessuna parte. Non è un
          angolo interno: `StepRenderer` è ciò che rende un modello PUBBLICATO
          dalla Segreteria, cioè `/m/[token]`, che è pubblica e anonima (`/m` sta
          in `PUBLIC_PREFIXES`) e la apre chiunque abbia il collegamento. Chi la
          compila trovava glifi da indovinare esattamente come sui tre wizard
          pubblici, dove la riga è stata aggiunta lo stesso giorno.

          ⚠️ QUI, E NON IN `WizardContainer`. La legenda deve parlare dei campi
          che si vedono ADESSO: `visibili` è già il risultato della logica
          condizionale (DL-024), quindi un passo in cui l'unico campo obbligatorio
          è nascosto da una condizione non mostra una riga che non spiega niente.
          Il contenitore quei campi non li conosce.

          ⚠️ E DA QUI LA EREDITANO DUE SUPERFICI, non una: `/m/[token]` (anonima)
          e `/parent/forms/[id]` (in-app, autenticata). È la sola chiamata che non
          va ricopiata a mano — i tre wizard pubblici la scrivono passo per passo,
          e il presidio che tiene onesta questa differenza è
          `__tests__/components/legenda-obbligatori-ogni-modulo.test.tsx`.

          Il componente decide DA SÉ se comparire: con nessun campo `required`
          ritorna `null`, quindi un modello tutto facoltativo non guadagna una
          riga che non spiegherebbe nulla. */}
      <LegendaObbligatori campi={visibili} />
      {visibili.map(field => (
        <FieldRenderer
          key={field.id}
          field={field}
          modelId={modelId}
          register={register}
          control={control}
          error={errors[field.id]}
          uploadEndpoint={uploadEndpoint}
        />
      ))}
    </div>
  )
}
