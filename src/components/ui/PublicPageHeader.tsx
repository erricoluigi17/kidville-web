import type { ReactNode } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { PublicContrastButton } from '@/components/ui/PublicContrastButton'
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
        {/* ── IL MARCHIO, E PERCHÉ STA QUI E NON IN OGNI PAGINA ─────────────────
            Stessa ragione del comando di Alto Contrasto e del link di ritorno, ed
            è il terzo pezzo che entra in questo componente: finché ogni pagina
            pubblica ridisegna la propria testata, la prossima nasce con la propria
            copia — che è esattamente come sono nate le tre che divergevano.

            ⚠️ L'ASSET È `logo-kidville.png`, NON `logo_green.png`.
            In `public/` ci sono DUE file con lo stesso wordmark verde, e sceglierne
            uno a caso è un difetto che non dà nessun errore. `logo_green.png` è
            6000×3375 con il marchio confinato nel terzo centrale e tutto il resto
            bianco: reso a 24 px di altezza, il wordmark ne misurerebbe otto — un
            logo che sembra sparito, senza un avviso da nessuna parte.
            `logo-kidville.png` è 2227×571, ritagliato, ed è già quello del login
            (`src/app/auth/login/page.tsx`). Il lock
            `__tests__/components/PublicPageHeader-logo.test.tsx` lo pretende.

            ⚠️ NON È UN LINK, e non è una dimenticanza. Queste schermate hanno UNA
            sola via d'uscita — il ritorno qui a sinistra — ed è ciò che le rende
            leggibili: chi si perde sa dove guardare. Un secondo bersaglio
            cliccabile a un dito di distanza, che porta altrove, gliela toglie.

            ── LE DUE MISURE, PRESE SULLA PAGINA VIVA IL 19/08/2026 ──────────────
            Playwright su Chrome, `/lavora-con-noi` e `/privacy`, altezza della
            testata al variare della larghezza:

                larghezza   senza logo   con logo   il marchio va a capo
                360 px         46 px      102 px    sì   (SE, 12/13 mini)
                390 px         46 px      102 px    sì   (iPhone 12/13/14)
                414 px         46 px       46 px    no
                430/640/768    46 px       46 px    no

            ⚠️ SOTTO I 414 px LA TESTATA RADDOPPIA, ed è una scelta consapevole del
            titolare (19/08/2026), non una svista da correggere. A quelle larghezze
            le tre cose NON CI STANNO: «Torna indietro» misura 111 px e «Alto
            contrasto» 148×46, quindi su 328 px utili ne restano 49 per il marchio
            — che con la proporzione 2227:571 ≈ 3,9:1 vorrebbe dire un wordmark
            alto 12 px, cioè illeggibile. Non è un valore da regolare: è che a 360
            px qualcosa deve andare a capo, e fra il marchio e un comando si è
            scelto di far scendere il marchio.

            ⚠️ NON PROVARE A RISOLVERLO CON `order-first`. È già stato provato e
            MISURATO lo stesso giorno: il marchio non sale sulla prima riga, finisce
            in basso a SINISTRA (top 97, right 110 a 390 px), cioè nell'angolo
            opposto a quello richiesto. Peggiora, e sembra un miglioramento finché
            non lo si guarda.

            Il contrasto, misurato sui PIXEL del file e non sul token di marca —
            l'inchiostro reale del PNG è `#007055`, non `#006A5F`:
                · Alto Contrasto (fondo bianco):  6,09:1
                · normale (fondo crema #FEF1E4):  5,48:1
            La soglia WCAG 1.4.11 per la grafica non testuale è 3:1. Passa in
            entrambi i modi, quindi NON serve il ripiego su `logo-light.png` sotto
            `[data-contrast="high"]` — che era la contromisura prevista se non
            avesse retto, e che si sarebbe aggiunta senza servire a niente.

            `w-auto` accanto a `h-*` è ciò che tiene la proporzione: `next/image`
            vuole `width`/`height` per riservare lo spazio ed evitare il salto di
            impaginazione, e senza `w-auto` quei 2227 px diventerebbero la
            larghezza resa.

            `priority={false}`: il marchio non è la cosa che si aspetta. In cima a
            queste pagine c'è un modulo, e la banda serve a lui. */}
        <Image
          src="/logo-kidville.png"
          alt="Kidville"
          width={2227}
          height={571}
          priority={false}
          className="h-6 w-auto sm:h-7"
        />
      </div>
    </div>
  )
}
