import { notFound } from 'next/navigation'
import Link from 'next/link'
import { createAdminClient, createClient } from '@/lib/supabase/server-client'
import { WizardContainer } from '@/components/features/parent/forms/WizardContainer'
import { accessoConsentito } from '@/lib/forms/publish'
import type { FormSchemaConfig } from '@/types/database.types'

export const metadata = {
  title: 'Modulo — Kidville',
}

// Pagina pubblica di un modello pubblicato (DL-030). Token-scoped, anonima.
export default async function PublicFormPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  const admin = await createAdminClient()
  const { data: model } = await admin
    .from('form_models')
    .select('id, title, description, schema, requires_signature, published_at, access_mode')
    .eq('public_token', token)
    .maybeSingle()

  if (!model || !model.published_at) {
    notFound()
  }

  // Modalità `authenticated`: serve una sessione valida.
  let hasSession = false
  try {
    const session = await createClient()
    hasSession = !!(await session.auth.getUser()).data.user
  } catch {
    hasSession = false
  }

  if (!accessoConsentito(model, hasSession)) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ background: '#0b0f1f', color: '#f1f5f9' }}>
        <div className="max-w-sm text-center">
          <h1 className="text-xl font-semibold text-white">Accesso riservato</h1>
          <p className="text-sm text-slate-400 mt-2">
            Questo modulo è disponibile solo per gli utenti registrati. Accedi per compilarlo.
          </p>
          <Link
            href={`/auth/login?next=/m/${token}`}
            className="inline-block mt-6 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold transition-all"
          >
            Accedi
          </Link>
        </div>
      </div>
    )
  }

  return (
    <WizardContainer
      modelId={model.id}
      title={model.title}
      description={model.description}
      schema={model.schema as FormSchemaConfig}
      requiresSignature={model.requires_signature}
      userId={null}
      parentEmail={null}
      publicToken={token}
    />
  )
}
