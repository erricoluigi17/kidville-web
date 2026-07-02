import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server-client'
import { resolveSessionAppId } from '@/lib/auth/require-staff'
import { WizardContainer } from '@/components/features/parent/forms/WizardContainer'
import type { FormSchemaConfig } from '@/types/database.types'

// Identità: ?userId= esplicito → sessione (cookie Supabase) → null.
// Nessun fallback demo (M4): senza identità la firma OTP resta disabilitata
// (parentEmail null), il modulo è comunque consultabile.
export default async function ParentFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ userId?: string }>
}) {
  const { id } = await params
  const { userId } = await searchParams
  const parentId = userId || (await resolveSessionAppId())

  const supabase = await createClient()

  const { data: model, error } = await supabase
    .from('form_models')
    .select('id, title, description, schema, is_active, requires_signature, signature_mode')
    .eq('id', id)
    .maybeSingle()

  if (error || !model) {
    notFound()
  }

  // Email del genitore per la firma OTP
  const { data: parent } = parentId
    ? await supabase
        .from('utenti')
        .select('email, nome, cognome')
        .eq('id', parentId)
        .maybeSingle()
    : { data: null }

  const schema = model.schema as FormSchemaConfig

  return (
    <WizardContainer
      modelId={model.id}
      title={model.title}
      description={model.description}
      schema={schema}
      requiresSignature={model.requires_signature}
      signatureMode={model.signature_mode === 'joint' ? 'joint' : 'single'}
      userId={parentId}
      parentEmail={parent?.email ?? null}
    />
  )
}
