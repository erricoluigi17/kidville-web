import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { LanguageSwitcher } from '@/components/features/i18n/LanguageSwitcher'
import { CancellazioneForm } from './CancellazioneForm'

// Pagina PUBBLICA (nessun login) di cancellazione account (C5 §1 — Google Play
// Data safety). A differenza di /privacy, /termini, /assistenza (italiano
// hardcoded) è BILINGUE: il revisore e l'utente possono cambiare lingua.
//
// Il testo che spiega prerequisiti e retention è RIUSATO da profilo.json
// (chiave `eliminaSpiegazione`, la stessa mostrata in-app), non riscritto: copre
// esattamente i due punti che Google richiede.
//
// VINCOLO DI SICUREZZA: la pagina NON cancella nulla. Avvia una richiesta che la
// Direzione evade, con verifica d'identità via email prima che sia lavorabile.
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('public')
  return {
    title: t('cancMetaTitolo'),
    description: t('cancMetaDescrizione'),
  }
}

export default async function CancellazioneAccountPage() {
  const t = await getTranslations('public')
  const tc = await getTranslations('common')
  const tp = await getTranslations('profilo')

  return (
    <main className="min-h-screen bg-kidville-cream px-4 py-10 sm:py-12">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/"
            className="inline-flex items-center gap-1 font-maven text-sm font-semibold text-kidville-green hover:underline"
          >
            <span aria-hidden="true">←</span> {tc('tornaIndietro')}
          </Link>
          <LanguageSwitcher />
        </div>

        <article className="mt-6 rounded-card border border-kidville-line bg-white p-6 shadow-sm sm:p-8">
          <h1 className="font-barlow text-3xl font-black uppercase tracking-wide text-kidville-green sm:text-4xl">
            {t('cancTitolo')}
          </h1>

          <p className="mt-3 font-maven text-base leading-relaxed text-kidville-ink">
            {t('cancIntro')}
          </p>

          <p className="mt-4 font-maven text-[15px] leading-relaxed text-kidville-ink">
            {tp.rich('eliminaSpiegazione', {
              strong: (chunks: ReactNode) => <strong>{chunks}</strong>,
            })}
          </p>

          <div className="mt-8">
            <CancellazioneForm />
          </div>
        </article>
      </div>
    </main>
  )
}
