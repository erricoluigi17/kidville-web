import type { Metadata } from 'next'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { LanguageSwitcher } from '@/components/features/i18n/LanguageSwitcher'
import { ConfermaCancellazioneForm } from './ConfermaForm'

// Pagina di conferma della cancellazione via magic-link (C5 §1).
//
// ⚠️ IL GET NON MUTA NULLA. Nessun accesso al DB, nessuna richiesta registrata al
// solo caricamento: uno scanner email che prefetcha il link (comune nei client di
// posta aziendali) NON deve poter avviare la richiesta. La mutazione avviene solo
// col POST esplicito del bottone qui sotto (client component).
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('public')
  return { title: t('cancConfermaTitolo') + ' — Kidville' }
}

export default async function ConfermaCancellazionePage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string; code?: string; expiry?: string; ticket?: string }>
}) {
  const sp = await searchParams
  const t = await getTranslations('public')
  const tc = await getTranslations('common')

  const parametriPresenti = !!(sp.email && sp.code && sp.expiry && sp.ticket)

  return (
    /*
     * `kv-public` NON è decorazione, ed è la classe che questa pagina si era persa
     * per strada mentre la sorella (`/cancellazione-account`) ce l'aveva.
     *
     * In Alto Contrasto l'inchiostro del `body` è #FFFFFF e si EREDITA, ma la carta
     * non si ribalta con lui: `bg-kidville-cream` e `bg-white` sono utility con
     * l'hex INLINATO da `@theme inline`, che il rimappaggio dei token dentro
     * `[data-contrast="high"]` non tocca. Senza marcatore succedevano due cose
     * insieme, e la seconda è quella che si paga dopo:
     *   · il ribaltamento non arrivava affatto — il link «torna indietro» restava
     *     #006A5F sul crema (5,86:1) e l'h1 #006A5F sul bianco (6,51:1), cioè i
     *     colori della luce normale: chi accende l'Alto Contrasto non otteneva
     *     niente, su un adempimento GDPR che si apre da un'email;
     *   · `<main>` e l'`<article>` dipingono carta chiara senza dichiarare
     *     inchiostro, quindi il PROSSIMO nodo di testo nudo — o il primo `<input>`,
     *     che il preflight di Tailwind lascia a `color: inherit` — sarebbe caduto a
     *     1,11:1 sul crema e 1,00:1 sul bianco. Latente, invisibile a una misura
     *     fatta oggi.
     * Con `kv-public`: carta bianca, inchiostro nero pieno (21:1), e il bottone di
     * conferma diventa la coppia nero/#FFE500 (16,46:1) come sulle altre pubbliche.
     * Lock: `__tests__/architecture/guscio-chiaro-dichiara-la-superficie.test.ts`.
     */
    <main className="kv-public min-h-screen bg-kidville-cream px-4 py-10 sm:py-12">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/cancellazione-account"
            className="inline-flex items-center gap-1 font-maven text-sm font-semibold text-kidville-green hover:underline"
          >
            <span aria-hidden="true">←</span> {tc('tornaIndietro')}
          </Link>
          <LanguageSwitcher />
        </div>

        <article className="mt-6 rounded-card border border-kidville-line bg-white p-6 shadow-sm sm:p-8">
          <h1 className="font-barlow text-3xl font-black uppercase tracking-wide text-kidville-green sm:text-4xl">
            {t('cancConfermaTitolo')}
          </h1>

          {parametriPresenti ? (
            <>
              <p className="mt-3 font-maven text-[15px] leading-relaxed text-kidville-ink">
                {t('cancConfermaIntro')}
              </p>
              <div className="mt-8">
                <ConfermaCancellazioneForm
                  email={sp.email!}
                  code={sp.code!}
                  expiry={sp.expiry!}
                  ticket={sp.ticket!}
                />
              </div>
            </>
          ) : (
            <p className="mt-3 font-maven text-[15px] leading-relaxed text-kidville-error">
              {t('cancConfermaLinkNonValido')}
            </p>
          )}
        </article>
      </div>
    </main>
  )
}
