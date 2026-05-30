'use client'

import type {
  UseFormRegister,
  FieldErrors,
  Control,
  FieldValues,
} from 'react-hook-form'
import { FieldRenderer } from '@/components/features/forms/FieldRenderer'
import type { FormPage } from '@/types/database.types'

interface Props {
  page: FormPage
  modelId: string
  register: UseFormRegister<FieldValues>
  control: Control<FieldValues>
  errors: FieldErrors
}

export function StepRenderer({ page, modelId, register, control, errors }: Props) {
  return (
    <div className="space-y-6">
      {page.fields.map(field => (
        <FieldRenderer
          key={field.id}
          field={field}
          modelId={modelId}
          register={register}
          control={control}
          error={errors[field.id]}
        />
      ))}
    </div>
  )
}
