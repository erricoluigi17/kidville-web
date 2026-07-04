'use client'

import {
  useWatch,
  type UseFormRegister,
  type FieldErrors,
  type Control,
  type FieldValues,
} from 'react-hook-form'
import { FieldRenderer } from '@/components/features/forms/FieldRenderer'
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
