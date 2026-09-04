'use client'

import { useTranslations } from 'next-intl'
import { IdCard } from 'lucide-react'
import { CambiaPasswordCard } from '@/components/features/account/CambiaPasswordCard'
import { ContrastSwitch } from '@/components/ui/ContrastSwitch'

/**
 * IL PROFILO DEL DOCENTE — la gemella magra di quello del genitore.
 *
 * ─── PERCHÉ ESISTE ADESSO E NON PRIMA ───────────────────────────────────────
 *
 * Lo slot c’era già: `TeacherBottomNav` dichiarava la voce «Profilo» con
 * `href: null, soon: true`, cioè un riquadro grigio con scritto «In arrivo». Era
 * onesto finché non c’era niente da metterci dentro.
 *
 * Col cambio password smette di esserlo, e non per un pelo: **un’insegnante non ha
 * un profilo genitore da cui passare**. Se il comando vivesse solo nel profilo del
 * genitore e nelle impostazioni della segreteria, chi insegna e basta non avrebbe
 * NESSUNA strada per cambiare la password che le è arrivata via email — e la
 * schermata sarebbe esistita senza che nessuno potesse aprirla.
 *
 * ─── PERCHÉ È MAGRA, E PERCHÉ IL FORM È APERTO ──────────────────────────────
 *
 * Qui dentro c’è una cosa sola. L’accordion del profilo genitore esiste perché
 * quella pagina è lunga e perché un campo password sempre montato invita i gestori
 * di password del telefono a offrire un salvataggio che nessuno ha chiesto; su una
 * schermata che contiene soltanto quel form, un accordion sarebbe un clic in più e
 * nient’altro — e nasconderebbe l’unica ragione per cui la pagina si apre.
 *
 * L’uscita, l’alto contrasto e il cambio di veste non si ripetono qui: stanno nel
 * menu della bottom nav, che è persistente e che si vede da OGNI schermata docente.
 * Ricopiarli avrebbe voluto dire due posti da tenere allineati per gli stessi tre
 * comandi.
 */
export default function TeacherProfiloPage() {
  const t = useTranslations('password')

  return (
    <div className="mx-auto max-w-xl px-4 py-6 pb-28 space-y-5">
      <header className="text-center">
        <IdCard className="mx-auto mb-2 text-kidville-green" size={34} aria-hidden="true" />
        <h1 className="font-barlow text-2xl font-black uppercase tracking-wide text-kidville-green">
          {t('profiloDocenteTitolo')}
        </h1>
        {/* `text-kidville-sub` e non `-muted`: quest'ultimo vale 2,51:1 su bianco e
            c'è un lock che lo vieta (`__tests__/a11y/testo-muted-allowlist.test.ts`). */}
        <p className="mt-1 font-maven text-sm text-kidville-sub">{t('profiloDocenteSottotitolo')}</p>
      </header>

      <section
        aria-labelledby="sicurezza-accesso"
        className="rounded-card border border-kidville-line bg-kidville-white p-5 shadow-sm"
      >
        <h2 id="sicurezza-accesso" className="font-barlow text-sm font-extrabold uppercase text-kidville-green">
          {t('sezioneTitolo')}
        </h2>
        <p className="mt-1 mb-4 font-maven text-[13px] leading-relaxed text-kidville-sub">
          {t('sezioneDescrizione')}
        </p>
        <CambiaPasswordCard origine="self-service" />
      </section>

      {/* Accessibilita: vedi il commento in `ContrastSwitch`. */}
      <ContrastSwitch />
    </div>
  )
}
