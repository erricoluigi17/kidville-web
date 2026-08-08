'use client'

import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { isNativeApp } from '@/lib/push/native-register'

// UN LINK A UNA SCHERMATA DI QUESTA APP, CHE NON BUTTA FUORI DALL'APP.
//
// ─── IL DIFETTO CHE CHIUDE (R25) ─────────────────────────────────────────────
// «Leggi l'informativa», nel modulo «Comunica un'assenza», era
// `<a href="/privacy" target="_blank">`. Sul web è innocuo: una scheda in più, e
// il modulo che si sta compilando resta dov'è. Dentro la WKWebView di Capacitor
// le schede NON esistono: il sistema consegna l'indirizzo a Safari, l'app passa
// in secondo piano, e per rientrare resta il breadcrumb «◀ Kidville» — che è un
// affordance di SISTEMA, non un comando dell'app. Misurato sul simulatore iOS.
//
// Il genitore che tocca quel link sta cercando di capire come viene trattato un
// dato sanitario del proprio figlio: è il momento peggiore per fargli perdere
// l'applicazione.
//
// ─── PERCHÉ IL COMPORTAMENTO RESTA DIVERSO SULLE DUE PIATTAFORME ─────────────
// Perché il difetto è del guscio, non del pattern. Sul web «apri di fianco»
// preserva il contesto ed è la cosa giusta; nel guscio nativo la stessa frase
// significa «esci». Quindi: sul web nulla cambia, nel guscio si naviga DENTRO e
// si torna da dove si è arrivati.
//
// ─── PERCHÉ IL RITORNO VIAGGIA IN `?da=` E NON NELLA HISTORY ─────────────────
// Perché la history di una WebView non è affidabile: deep link, riavvii, ripresa
// da background. `AppBar.tsx` porta la stessa annotazione da tempo («NIENTE
// router.back()»). Il percorso di partenza si dichiara, la pagina pubblica lo
// filtra (`ritornoInterno`) e lo usa come ritorno della propria riga di testa.
//
// ─── PERCHÉ IL MARKUP NON CAMBIA FRA SERVER E CLIENT ─────────────────────────
// `target="_blank"` resta SEMPRE nell'HTML e la scelta si fa nel gestore del
// tocco. Decidere l'attributo durante il render richiederebbe di sapere se si è
// nel guscio già in fase di idratazione — informazione che il server non ha — e
// produrrebbe un disallineamento di hydration su ogni schermata che monta il
// link. Se il JavaScript non è ancora idratato, il comportamento è quello di
// prima: sbagliato nel guscio, ma non rotto.
//
// ─── PERCHÉ `window.open(…, '_self')` E NON `useRouter().push` ───────────────
// `useRouter()` LANCIA quando il componente non sta dentro l'albero dell'App
// Router. Questo è un link accessorio montato dentro il modulo con cui una
// famiglia comunica un'assenza e dentro l'onboarding: farlo dipendere da un
// invariante di framework significa far cadere quelle schermate per un link di
// contorno. È lo stesso criterio con cui `PublicContrastButton` legge il
// contesto invece di usare l'hook che lancia — «un guasto dell'accessorio non
// può diventare un guasto del prodotto».
// Il prezzo è una navigazione a pagina intera invece che client-side: nel guscio
// resta dentro la WebView, che è ciò che il rilievo chiede.

/** L'indirizzo da aprire in-app: la pagina più il ritorno da cui si è arrivati. */
export function destinazioneInApp(href: string, percorso: string | null | undefined): string {
  const separatore = href.includes('?') ? '&' : '?'
  return `${href}${separatore}da=${encodeURIComponent(percorso || '/')}`
}

type Props = {
  /** Il percorso interno da aprire (es. `/privacy`). */
  href: string
  children: ReactNode
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'target' | 'rel'>

export function LinkInterno({ href, children, onClick, ...resto }: Props) {
  // `usePathname` e non `useRouter`: fuori dall'App Router restituisce `null`
  // invece di lanciare, e `null` qui vale «torna alla home».
  const percorso = usePathname()

  const alTocco = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    if (e.defaultPrevented) return
    if (!isNativeApp()) return
    e.preventDefault()
    window.open(destinazioneInApp(href, percorso), '_self')
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={alTocco} {...resto}>
      {children}
    </a>
  )
}
