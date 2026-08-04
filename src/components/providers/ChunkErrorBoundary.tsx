'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { btnClass } from '@/components/ui/Btn'
import { logClient, flush, nomeErrore } from '@/lib/logging/client'

/**
 * QUANDO UN PEZZO DEL PROGRAMMA NON ARRIVA, QUALCUNO DEVE DIRLO.
 *
 * ─── IL DIFETTO (collaudo 2026-08-03, T07-F2) ──────────────────────────────
 * L'app è un bundle spezzato in decine di file sotto `/_next/static/`. Se uno
 * di quei file non arriva — rete che cade a metà, WebView iOS che sospende la
 * richiesta, un deploy che ha appena sostituito i file mentre la pagina era
 * aperta — l'interfaccia resta ESATTAMENTE dov'era: il `GlobalLoader` mostra
 * «Caricamento…» e non lo toglie più, perché il codice che avrebbe dovuto
 * toglierlo è nel file che non è arrivato.
 *
 * Le boundary d'errore React ESISTONO già in questo repo, e non servono a
 * niente qui: React intercetta ciò che accade *durante un render*, mentre il
 * fallimento di uno `<script>` è un evento del DOM che non attraversa nessun
 * componente. E `window.addEventListener('error', …)` senza `capture` non lo
 * vede nemmeno: l'errore di una RISORSA non fa bubbling — si propaga solo in
 * discesa, nella fase di cattura. È la ragione per cui questa rete si installa
 * con `{ capture: true }`, e il test che lo dimostra è
 * `__tests__/providers/chunk-error-boundary.test.tsx`: togliendo quella sola
 * opzione, il test torna rosso.
 *
 * ─── COSA FA, E COSA NON FA ────────────────────────────────────────────────
 * Non ripara niente e non ci prova: un chunk mancante si risolve solo
 * ricaricando. Fa l'unica cosa che manca, cioè **dirlo** e offrire il gesto
 * che funziona — un bottone che ricarica. Sostituisce lo stato d'attesa invece
 * di affiancarlo.
 *
 * ─── IL PIANO: 9998, cioè SOTTO IL GATE BIOMETRICO ─────────────────────────
 * La prima stesura stava un piano sopra il gate, e la motivazione scritta era
 * «quando il programma è incompleto questo è l'unico messaggio azionabile che
 * abbia senso mostrare». Due lock l'hanno respinta —
 * `native-privacy-lock.test.ts` («il gate biometrico sta sopra a tutto») e
 * `AvvisoForm-a11y-modale.test.tsx` — e avevano ragione loro.
 *
 * Il gate biometrico (9999) non è una schermata come le altre: è ciò che
 * impedisce a chi prende in mano il telefono di vedere il diario di un bambino
 * mentre l'app torna dal background. Se questo pannello gli passasse sopra,
 * offrirebbe un bottone azionabile a qualcuno che il gate non l'ha ancora
 * superato. Il gesto in sé è innocuo — un reload — ma il principio no: la
 * schermata che protegge i dati di un minore viene prima di quella che spiega
 * un guasto tecnico. E il caso è tutt'altro che teorico: la WebView iOS che
 * sospende le richieste è proprio uno dei modi in cui un chunk non arriva, ed
 * è lo stesso momento in cui l'app va in background e il gate si alza.
 *
 * 9998 lascia questo pannello sopra ogni altra superficie dell'app (il loader
 * globale, le modali a 120) e sotto la sola cosa che deve stargli sopra.
 *
 * ─── PERCHÉ I TESTI SONO QUI E NON NEI CATALOGHI ───────────────────────────
 * Per la stessa ragione per cui `src/app/offline/page.tsx` porta con sé
 * entrambe le lingue: questa schermata deve reggere quando NON regge il resto,
 * e farla dipendere dal runtime di traduzione significherebbe farla dipendere
 * dalla macchina che sta fallendo. Le due lingue sono nel documento, e la
 * scelta si fa leggendo il cookie `KV_LOCALE` — lo stesso che usa il resto
 * dell'app. Nessun `useTranslations`, nessuna chiave nuova nei cataloghi.
 */

/** Il prefisso dei file del bundle. Tutto ciò che sta qui sotto è «programma». */
const PREFISSO_BUNDLE = '/_next/static/'

/**
 * Il nome che Next dà all'errore quando un `import()` dinamico non si carica, e
 * le forme testuali equivalenti dei vari browser. Arrivano come *promise
 * rifiutata*, non come errore di risorsa: sono la seconda porta dello stesso
 * guasto, e senza di loro resterebbe scoperta la navigazione fra pagine (dove i
 * chunk si caricano via `import()` e non via `<script>`).
 */
const TESTO_CHUNK = /chunkloaderror|loading chunk|loading css chunk|dynamically imported module|importing a module script failed/i

const TESTI = {
  it: {
    titolo: 'Non siamo riusciti a caricare tutto',
    corpo:
      'Una parte dell’app non è arrivata: può succedere con una connessione instabile, ' +
      'oppure subito dopo un aggiornamento. I tuoi dati sono al sicuro — basta ricaricare la pagina.',
    bottone: 'Ricarica la pagina',
  },
  en: {
    titolo: 'We couldn’t load everything',
    corpo:
      'Part of the app did not arrive: it can happen on an unstable connection, or right ' +
      'after an update. Your data is safe — just reload the page.',
    bottone: 'Reload the page',
  },
} as const

/** `it` salvo cookie `KV_LOCALE=en`. Non lancia: gira dentro un gestore d'errore. */
function linguaCorrente(): 'it' | 'en' {
  try {
    const m = document.cookie.match(/(?:^|; )KV_LOCALE=([^;]*)/)
    return m && decodeURIComponent(m[1]) === 'en' ? 'en' : 'it'
  } catch {
    return 'it'
  }
}

/** L'URL di una risorsa che ha fallito, se il bersaglio dell'evento ne ha uno. */
function urlDellaRisorsa(bersaglio: EventTarget | null): string | null {
  if (bersaglio === null || typeof bersaglio !== 'object') return null
  const el = bersaglio as Partial<HTMLScriptElement> & Partial<HTMLLinkElement> & { tagName?: string }
  // `src` per gli script, `href` per i CSS. Un `<img>` rotto ha `src` ma non sta
  // sotto `/_next/static/`: il filtro sul prefisso lo esclude da solo.
  const grezzo = typeof el.src === 'string' ? el.src : typeof el.href === 'string' ? el.href : null
  return grezzo !== null && grezzo.length > 0 ? grezzo : null
}

/** Solo il percorso: l'origine non aggiunge nulla e allunga il log. */
function percorsoDi(url: string): string {
  try {
    return new URL(url, window.location.href).pathname
  } catch {
    return url
  }
}

export function ChunkErrorBoundary() {
  const [guasto, setGuasto] = useState(false)
  const [lingua, setLingua] = useState<'it' | 'en'>('it')
  const bottone = useRef<HTMLButtonElement | null>(null)
  // Un chunk che manca ne fa mancare altri a cascata: il primo basta, e i
  // successivi non devono né riaprire il pannello né moltiplicare i log.
  const giaVisto = useRef(false)

  const segnala = useCallback((messaggio: string) => {
    if (giaVisto.current) return
    giaVisto.current = true
    // Un `catch` che non logga è un bug (AGENTS.md §6): qui il guasto è la
    // ragione stessa per cui il componente esiste, quindi si logga SEMPRE — e
    // si forza l'invio, perché il gesto immediatamente successivo dell'utente è
    // un reload, che porterebbe via la coda in memoria.
    // `logClient` non lancia mai e redige da sé i percorsi: nessun dato
    // personale può passare di qui (sono nomi di file del bundle).
    logClient({ livello: 'error', evento: 'js', messaggio, route: window.location.pathname })
    flush()
    setLingua(linguaCorrente())
    setGuasto(true)
  }, [])

  useEffect(() => {
    /**
     * `capture: true` NON è un dettaglio di stile: l'evento `error` di una
     * risorsa (`<script>`, `<link>`) non fa bubbling. Senza la fase di cattura
     * questo gestore non verrebbe MAI invocato per il caso che deve coprire.
     */
    const suErrore = (e: Event) => {
      const url = urlDellaRisorsa(e.target)
      if (url === null || !url.includes(PREFISSO_BUNDLE)) return
      segnala(`chunk-non-caricato: ${percorsoDi(url)}`)
    }
    window.addEventListener('error', suErrore, { capture: true })

    /**
     * La seconda porta: `import()` dinamico che non si risolve. Arriva come
     * promise rifiutata, con `ChunkLoadError` (Next/webpack) o con uno dei
     * testi dei browser.
     */
    const suRifiuto = (e: PromiseRejectionEvent) => {
      const motivo: unknown = e.reason
      const testo = motivo instanceof Error ? `${motivo.name}: ${motivo.message}` : String(motivo ?? '')
      if (!TESTO_CHUNK.test(testo)) return
      segnala(`chunk-non-caricato: ${nomeErrore(motivo)}`)
    }
    window.addEventListener('unhandledrejection', suRifiuto)

    return () => {
      window.removeEventListener('error', suErrore, { capture: true })
      window.removeEventListener('unhandledrejection', suRifiuto)
    }
  }, [segnala])

  // Il focus va sull'unica cosa da fare: chi naviga da tastiera o con uno
  // screen reader non deve cercarla in un documento che non risponde più.
  useEffect(() => {
    if (guasto) bottone.current?.focus()
  }, [guasto])

  if (!guasto) return null
  const t = TESTI[lingua]

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="kv-chunk-titolo"
      aria-describedby="kv-chunk-corpo"
      lang={lingua}
      data-testid="chunk-error"
      className="fixed inset-0 z-[9998] flex flex-col items-center justify-center gap-6 bg-kidville-green px-8 text-center"
    >
      <h1
        id="kv-chunk-titolo"
        className="font-barlow text-2xl font-black uppercase tracking-wide text-kidville-yellow"
      >
        {t.titolo}
      </h1>
      <p id="kv-chunk-corpo" className="max-w-md font-maven text-sm text-white">
        {t.corpo}
      </p>
      <button
        ref={bottone}
        type="button"
        className={btnClass('secondary', 'lg')}
        onClick={() => window.location.reload()}
      >
        {t.bottone}
      </button>
    </div>
  )
}
