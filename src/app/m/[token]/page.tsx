import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { createAdminClient, createClient } from '@/lib/supabase/server-client'
import { WizardContainer } from '@/components/features/parent/forms/WizardContainer'
import { btnClass } from '@/components/ui/Btn'
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
    // ── Stato «accesso riservato» — superficie PUBBLICA (T08-F1 + T08-F5) ──────
    // Prima era un residuo del tema scuro da cui viene tutto questo file: fondo
    // `#0b0f1f` cablato, `text-slate-400`, e un CTA `bg-kidville-success` con
    // `text-white` — misurato 3,30:1 (formula WCAG 2.1 su sRGB linearizzato),
    // SOTTO la soglia AA di 4,5:1 per il testo normale. L'`hover` era la classe
    // `hover:bg-kidville-success-soft0`, che non esiste fra i token e che Tailwind
    // scarta in silenzio: il bottone non aveva alcuno stato sotto il puntatore.
    // NB: `bg-kidville-success-soft` (senza lo zero) sarebbe stato PEGGIO di
    // nessun hover — è una fascia CHIARA (#E7F3E8) e il testo bianco ci sparisce
    // sopra (1,26:1).
    // Ora la pagina monta il design system come le quattro pagine legali:
    // `kv-public` (che le dà l'Alto Contrasto per-superficie) + fondo `cream` +
    // card bianca + `btnClass('primary')`. Contrasti misurati:
    //   · titolo   green   #006A5F su bianco  6,51:1
    //   · corpo    sub     #55615C su bianco  6,46:1
    //   · CTA      yellow-ink #FFDA5C su green #006A5F 4,78:1 (hover green-dark 6,51:1)
    return (
      <main lang="it" className="kv-public min-h-screen bg-kidville-cream flex items-center justify-center px-4 py-10">
        <div className="w-full max-w-sm rounded-card border border-kidville-line bg-white p-6 text-center shadow-sm">
          <h1 className="font-barlow text-2xl font-black uppercase tracking-wide text-kidville-green">
            {t('moduloAccessoRiservato')}
          </h1>
          <p className="mt-3 font-maven text-sm leading-relaxed text-kidville-sub">
            {t('moduloAccessoCorpo')}
          </p>
          <Link href={`/auth/login?next=/m/${token}`} className={btnClass('primary', 'md', 'mt-6 w-full')}>
            {t('moduloAccedi')}
          </Link>
        </div>
      </main>
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
