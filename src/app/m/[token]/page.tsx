import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { createAdminClient, createClient } from '@/lib/supabase/server-client'
import { WizardContainer } from '@/components/features/parent/forms/WizardContainer'
import { accessoConsentito } from '@/lib/forms/publish'
import type { FormSchemaConfig } from '@/types/database.types'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('public')
  return { title: t('moduloMetaTitolo') }
}

// Pagina pubblica di un modello pubblicato (DL-030). Token-scoped, anonima.
export default async function PublicFormPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const t = await getTranslations('public')

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
          <h1 className="text-xl font-semibold text-white">{t('moduloAccessoRiservato')}</h1>
          <p className="text-sm text-slate-400 mt-2">
            {t('moduloAccessoCorpo')}
          </p>
          <Link
            href={`/auth/login?next=/m/${token}`}
            className="inline-block mt-6 px-5 py-2.5 rounded-xl bg-kidville-success hover:bg-kidville-success-soft0 text-white text-sm font-semibold transition-all"
          >
            {t('moduloAccedi')}
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
