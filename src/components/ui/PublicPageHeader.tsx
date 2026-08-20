import type { ReactNode } from 'react'
import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { PublicContrastButton } from '@/components/ui/PublicContrastButton'
import { MarchioKidville } from '@/components/ui/MarchioKidville'
import { ritornoInterno } from '@/lib/ui/ritorno-interno'

// LA RIGA DI TESTA DELLE PAGINE PUBBLICHE, IN UN POSTO SOLO.
//
// ─── PERCHÉ ESISTE ───────────────────────────────────────────────────────────
// Perché per mesi è esistita solo a metà. Il comando di Alto Contrasto era già
// un componente unico (`PublicContrastButton`) e il commento di ogni pagina
// dichiarava l'intento — «sta in un componente unico proprio perché queste
// cinque pagine non ricomincino a divergere» — ma il link di RITORNO, che è
// l'unica via d'uscita di quelle schermate, restava copiato in ogni file. Due
// pagine su cinque sono state portate al catalogo, tre no, e con l'app in
// inglese la riga rendeva «← Torna indietro» accanto a «High contrast»: metà
// tradotta, metà no, dentro un documento dichiarato `lang="en"` (R13).
//
// La causa non era la stringa sbagliata: era che la riga non era un componente.
// Finché ogni pagina la ridisegna, la prossima pagina pubblica nascerà con la
// propria copia — che è esattamente come sono nate quelle tre.
//
// ─── PERCHÉ IL LINK PORTA IL PROPRIO `lang` ──────────────────────────────────
// Le tre pagine legali dichiarano `<main lang="it">`, ed è corretto: il testo
// legale È italiano per scelta, e l'attributo serve a farlo pronunciare bene.
// Ma un comando di navigazione TRADOTTO dentro quel contenitore verrebbe letto
// da uno screen reader inglese con fonetica italiana — lo stesso WCAG 3.1.2 che
// l'attributo è nato per rispettare. Il comando dichiara quindi la lingua
// dell'interfaccia, che è quella in cui è scritto.
//
// ─── PERCHÉ IL RITORNO NON È SEMPRE `/` ──────────────────────────────────────
// Queste pagine si aprono anche da dentro l'app (dal modulo dell'assenza, dal
// profilo, dall'onboarding). Nel guscio nativo non ci sono schede: si naviga, e
// «torna indietro» deve riportare da dove si è arrivati, non alla home. Il
// mittente lo dichiara in `?da=`, e `ritornoInterno` lo filtra: da una pagina di
// `app.kidville.it` non si rimbalza altrove.

export async function PublicPageHeader({
  /** Il percorso da cui si è arrivati (`?da=`). Filtrato: solo percorsi interni. */
  ritorno,
  /** Comandi aggiuntivi a destra (es. il selettore di lingua). */
  children,
}: {
  ritorno?: string | null
  children?: ReactNode
}) {
  const tc = await getTranslations('common')
  const locale = await getLocale()
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Link
        href={ritornoInterno(ritorno)}
        lang={locale}
        /* ── `min-h-11` = 44 px, ed è l'UNICA via d'uscita di queste schermate ──
           MISURATO il 12/08/2026 a 360 px sulla pagina viva: il link era alto
           111×20 px, in una riga dove «Alto contrasto» misura 148×46 e, un dito
           più sotto, «Avanti» 109×44 — cioè il comando più piccolo della
           schermata era quello che riporta indietro. Non cambia l'impaginatura:
           la riga è `items-center` e il comando accanto è già più alto di così,
           quindi la testata resta alta 46 px come prima. */
        className="inline-flex min-h-11 items-center gap-1 font-maven text-sm font-semibold text-kidville-green hover:underline"
      >
        <span aria-hidden="true">←</span> {tc('tornaIndietro')}
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <PublicContrastButton />
        {children}
        {/* Il marchio. Sta in `MarchioKidville` e non qui dentro perché le
            testate pubbliche sono DUE: questa e quella di `/iscrizione`, che ha
            il contatore dei passi al posto del ritorno. Il file spiega il resto,
            misure e trappole comprese. */}
        <MarchioKidville />
      </div>
    </div>
  )
}
