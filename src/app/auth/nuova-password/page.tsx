'use client'

import { Suspense, useId } from 'react'
import Image from 'next/image'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { KeyRound } from 'lucide-react'
import { LanguageSwitcher } from '@/components/features/i18n/LanguageSwitcher'
import { SfondoAuth } from '@/components/features/auth/SfondoAuth'
import { CambiaPasswordCard } from '@/components/features/account/CambiaPasswordCard'
import { useAccessibility } from '@/lib/accessibility/useAccessibility'
import { areaFromPath } from '@/lib/auth/active-role'

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * L’INTERSTIZIALE DEL PRIMO ACCESSO — `/auth/nuova-password`
 *
 * Ci arriva chi ha appena fatto l’accesso con una password che ha la FORMA di una
 * temporanea (quella spedita per email). La decisione si prende dentro
 * `destinazione()` in `auth/login/page.tsx`, in un posto solo, e la destinazione
 * vera viaggia in `?next=`.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * PERCHÉ STA SOTTO `/auth` E NON DENTRO `(dashboard)`
 *
 * Perché non è una schermata dell’app: è l’ultimo passo dell’accesso. Sotto
 * `(dashboard)` erediterebbe AppBar, BottomNav e la guardia d’area — cioè tre cose
 * che parlano di un posto in cui la persona non è ancora entrata, e una guardia che
 * la rimanderebbe al login se il ruolo attivo non fosse ancora a posto. Qui non c’è
 * niente da navigare: c’è una cosa da fare, o da rimandare.
 *
 * Conseguenza dichiarata: `CampoNonCoperto` NON è montato (vive nei tre layout con
 * `[data-kv-shell]`) e non serve, perché qui non c’è nessuna barra sticky sopra i
 * campi. Il margine che tiene il campo staccato dal bordo quando la tastiera si apre
 * lo mette `scroll-mt-24` dentro `CambiaPasswordCard`, più il padding di questa
 * pagina — che comprende la safe-area del notch.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * «NON ORA» NON È UNA DEBOLEZZA: È LA VALVOLA.
 *
 * È ciò che rende impossibile chiudere fuori qualcuno. Senza, un difetto qualunque
 * di questa schermata — un 429, un campo che su un telefono non si compila, una
 * password che il provider rifiuta per un motivo suo — diventerebbe un muro fra 560
 * account e il proprio registro, messo lì da noi. Chi la preme rivede l’invito al
 * prossimo accesso e trova comunque il comando nel proprio profilo.
 *
 * ⚠️ `?next=` NON SI SEGUE GREZZO. Arriva dalla barra degli indirizzi, e questa è la
 * schermata che si apre appena dopo l’accesso — cioè il momento in cui una persona è
 * più disposta a fidarsi di quello che vede. Si onora solo se è un percorso interno
 * alle aree (`areaFromPath`), altrimenti si va alla radice e le guardie server-side
 * fanno il loro lavoro. È la stessa regola del degrado nella login, e per lo stesso
 * motivo.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * ⚠️ IL MARCHIO SOPRA LA CARD NON È DECORAZIONE, ED È IL RILIEVO PIÙ GRAVE CHE IL
 * CONFRONTO CIECO HA TROVATO SU QUESTA PAGINA.
 *
 * Il genitore arriva **da un’email**, con una password copiata da quell’email, e la
 * schermata che gliela chiede era l’unica del percorso **senza il logo della
 * scuola**. È lo schema esatto di una pagina di phishing: chi ha imparato a
 * diffidare vede sparire l’àncora d’identità proprio nel punto in cui gli si chiede
 * un segreto. L’ancora si toglie da tutte le schermate o da nessuna — e comunque mai
 * da questa. Stesso file e stessa misura della login (`/logo-kidville.png`, 208px,
 * `max-width: 62%`), così le due schermate che la stessa persona vede a trenta
 * secondi di distanza portano lo stesso marchio, alla stessa taglia.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

function Interstiziale() {
  const t = useTranslations('password')
  const router = useRouter()
  const params = useSearchParams()
  const { highContrast } = useAccessibility()
  const idNota = useId()

  const next = params.get('next')
  /** Mai `next` grezzo: solo un percorso interno alle aree, altrimenti la radice. */
  const dove = next && areaFromPath(next) ? next : '/'

  // `replace` e non `push`: tornare indietro non deve rimettere davanti il muro che
  // la persona ha appena scelto di rimandare.
  const rimanda = () => router.replace(dove)

  return (
    /*
     * ⚠️ IN ALTO CONTRASTO QUESTA PAGINA RESTA CHIARA, E NON È UNA DIMENTICANZA:
     * è una misura, e va detta perché sorprende.
     *
     * `@theme inline` INLINA gli hex dentro le utility di Tailwind (verificato sul
     * CSS costruito: `.bg-kidville-cream{background-color:#fef1e4}`, nessun `var()`),
     * quindi il rimappaggio dei token dentro `[data-contrast="high"]` non le tocca.
     * Conseguenza: qui il fondo resta crema e la carta bianca — esattamente come le
     * TRE shell dell'app (`parent`, `teacher` e `admin` dichiarano tutte
     * `bg-kidville-cream` sul proprio guscio), i cui contrasti sono già misurati e
     * lockati.
     *
     * La login invece diventa NERA, perché il suo fondo vive in un CSS module che
     * legge `var(--color-kidville-cream)` e ha un override esplicito. Quindi in Alto
     * Contrasto c'è un salto fra login e questa schermata — lo stesso salto che c'è
     * fra la login e qualunque dashboard, cioè quello che ogni utente incontra già
     * oggi. Allinearsi alla login vorrebbe dire ribaltare a mano OGNI inchiostro di
     * questa pagina (le utility non si ribaltano da sole), cioè scrivere una seconda
     * palette d'Alto Contrasto per una schermata sola: la strada che porta a due
     * linguaggi che divergono. Le coppie usate qui sono misurate e ≥4,5:1 in
     * entrambe le modalità — `__tests__/a11y/contrasto-barra-forza-password.test.ts`.
     */
    /*
     * ⚠️ `min-h-dvh` E NON `h-dvh`, e qui accanto c’è `overflow-hidden`: i due insieme
     * decidono se la via d’uscita esiste. Misurato il 2026-09-02 sulla pagina servita:
     * la schermata chiede **975,6px** di altezza contro gli **801** del portatile su cui
     * i critici l’hanno guardata. Con un’altezza MINIMA il guscio cresce e la pagina
     * scorre; con un’altezza FISSA `overflow-hidden` taglierebbe via quei 174px — e lì
     * dentro c’è «Non ora», cioè l’unica cosa che impedisce a un difetto di questa
     * schermata di diventare un muro. Nessun test di contenuto se ne accorgerebbe: il
     * nodo nel DOM ci sarebbe lo stesso.
     *
     * `pt-12` NON scende: sotto i 48px il logo (centrato, 62% di larghezza sui telefoni)
     * entra nella banda del selettore di lingua, che sta a `top: max(12px, safe-area)`.
     * Il respiro in BASSO invece è aria pura, e paga: `pb-6` restituisce 24px.
     */
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-kidville-cream px-4 pt-12 pb-6">
      {!highContrast && <SfondoAuth />}

      {/* Come nella login: il selettore di lingua sta FUORI dal flusso, nell’angolo,
          così la card resta in una schermata sola. */}
      <div className="absolute right-3 z-10" style={{ top: 'max(12px, env(safe-area-inset-top))' }}>
        <LanguageSwitcher />
      </div>

      {/* IL MARCHIO — vedi la testata: è l’àncora d’identità, e questa è la
          schermata in cui si digita un segreto arrivandoci da un’email. */}
      <div className="relative z-[1] mb-3 w-[208px] max-w-[62%]">
        <Image src="/logo-kidville.png" alt="Kidville" width={2227} height={571} priority className="h-auto w-full" />
      </div>

      <main className="relative z-[1] w-full max-w-md rounded-card border border-kidville-line bg-kidville-white p-5 shadow-sm">
        <div className="text-center">
          <KeyRound className="mx-auto mb-1.5 text-kidville-green" size={30} aria-hidden="true" />
          {/* L’occhiello dice DOVE si è, il titolo COSA si sta per fare: sono due
              informazioni diverse, e messe insieme in una riga sola nessuna delle due
              si legge. Stesso schema del `PageHeader` del cockpit. */}
          <p className="font-barlow text-[11px] font-bold uppercase tracking-[0.14em] text-kidville-yellow-strong">
            {t('interstizialeOcchiello')}
          </p>
          <h1 className="font-barlow text-2xl font-black uppercase tracking-wide text-kidville-green">
            {t('interstizialeTitolo')}
          </h1>
          {/* UNA frase sola, ed è quella che chiude il cerchio con l’email delle
              credenziali — che quella promessa la fa già da mesi. */}
          <p className="mt-2 font-maven text-sm leading-relaxed text-kidville-sub">
            {t('interstizialeIntro')}
          </p>
        </div>

        <div className="mt-4">
          <CambiaPasswordCard
            origine="primo-accesso"
            // È il momento in cui l’utente la password temporanea ce l’ha ancora
            // negli appunti: chiamarla «password attuale» lo manderebbe a cercare
            // una password che non ha mai scelto.
            etichettaAttuale={t('labelAttualeTemporanea')}
            // Serve solo se la sessione REGGESSE al cambio. Oggi non regge mai
            // (GoTrue revoca tutte le sessioni, compresa questa) e il comando che si
            // vede è «Vai all’accesso» — ma il ramo esiste perché la fonte è la
            // risposta del server, non una nostra convinzione su di lui.
            onProsegui={() => router.replace(dove)}
          />
        </div>

        {/* ── LA VALVOLA, DECLASSATA A VALVOLA ────────────────────────────────────
            ⚠️ ERANO DUE PRIMARI. «Non ora» aveva la stessa larghezza e la stessa
            altezza dell’azione richiesta (41px contro 40), uno sotto l’altro: chi
            arriva confuso trovava una via d’uscita larga quanto la cosa da fare, con
            la nota che lo rassicurava che non perdeva niente. Una quota di quelle 560
            famiglie avrebbe premuto lì, e l’obiettivo sarebbe fallito in silenzio.

            Meno peso, MAI meno accessibile: resta un `<button>` vero, visibile,
            raggiungibile da tastiera, sottolineato (mai il solo colore, WCAG 1.4.1),
            con un bersaglio dichiarato di 44px (WCAG 2.5.8) — solo non è più a piena
            larghezza né riempito col verde del primario.

            ⚠️ E LA NOTA VIENE PRIMA. Stava dopo il bottone (y 684 contro y 634): chi
            usa uno screen reader ATTIVAVA il comando prima di sentirne la
            conseguenza. Ora la precede nel DOM, e `aria-describedby` la lega comunque
            al comando per chi ci arriva saltando da un controllo all’altro.

            ⚠️ IL BERSAGLIO ERA GIÀ A NORMA, E I DUE CRITICI HANNO MISURATO IL
            CONTRARIO — AVENDO RAGIONE LO STESSO. Misurato il 2026-09-02 con
            `getBoundingClientRect` sulla pagina servita:
                bersaglio premibile … 84,5 × 44,0 px   → WCAG 2.5.8 già rispettato
                inchiostro visibile … 52,5 × 16,5 px   → è il «50×15» che hanno letto
            I due numeri non si contraddicono: la norma misura l’area PREMIBILE, una
            persona mira a quella VISIBILE. Con 32 dei 44px d’altezza e 32 degli 84,5 di
            larghezza fatti di padding trasparente, il comando è conforme e sembra una
            nota a piè di pagina — e la nota a piè di pagina è l’unica via d’uscita.
            Il lock precedente era verde per tutto il tempo, perché asseriva
            `min-h-[44px]`: leggeva il contenitore e non l’inchiostro.

            ⚠️ IL RIMEDIO NON È RIDARGLI IL RANGO. Nel giro precedente era un bottone
            pieno 348×36 accanto a un primario da 54, cioè due primari, e l’obiettivo
            falliva in silenzio. Si tiene l’aspetto subordinato — niente riempimento,
            niente bordo, resta sottolineato (WCAG 1.4.1) — e si riprende l’AREA: corpo
            a 16px (che è anche la soglia sotto cui iOS zooma la pagina) e bersaglio
            dichiarato in ENTRAMBE le direzioni, non solo in altezza.
            Lock: `__tests__/pages/auth-nuova-password.test.tsx`. */}
        <div className="mt-4 border-t border-kidville-line pt-3 text-center">
          <p id={idNota} className="font-maven text-[13px] leading-snug text-kidville-sub">
            {t('interstizialeNonOraNota')}
          </p>
          <button
            type="button"
            onClick={rimanda}
            aria-describedby={idNota}
            className="mt-2 inline-flex min-h-[44px] min-w-[140px] items-center justify-center rounded-pill px-4 font-maven text-base font-semibold text-kidville-green underline decoration-2 underline-offset-4 hover:text-kidville-green-dark"
          >
            {t('interstizialeNonOra')}
          </button>
        </div>
      </main>
    </div>
  )
}

/**
 * ⚠️ IL `<Suspense>` NON È DECORATIVO: questa pagina legge `useSearchParams()` ed è
 * prerenderizzabile. Senza confine di sospensione `npm run build` cade con
 * `missing-suspense-with-csr-bailout` — oggi non cadrebbe, ma solo perché
 * `src/app/layout.tsx` fa `await cookies()`, cioè per un appoggio silenzioso su un
 * altro file. Lock: `__tests__/architecture/use-search-params-con-suspense.test.ts`.
 */
export default function NuovaPasswordPage() {
  return (
    <Suspense fallback={null}>
      <Interstiziale />
    </Suspense>
  )
}
