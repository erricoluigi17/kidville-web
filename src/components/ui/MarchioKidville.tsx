import Image from 'next/image'

// =============================================================================
// IL MARCHIO, IN UN COMPONENTE SOLO.
//
// ─── PERCHÉ NON STA DENTRO `PublicPageHeader` E BASTA ───────────────────────
// Perché le superfici pubbliche hanno DUE testate, non una, e il 2026-08-20 il
// collaudo ha misurato che una delle due era rimasta senza marchio.
//
//  · `PublicPageHeader` — «← Torna indietro» a sinistra, comandi a destra. La
//    usano `/lavora-con-noi`, `/privacy`, `/termini`, `/assistenza`,
//    `/cancellazione-account`, `/anagrafica-personale`.
//  · `EnrollmentWizard` (`/iscrizione`) — titolo e contatore dei passi a
//    sinistra, comandi a destra. Non ha un link di ritorno e non ne vuole uno:
//    è un modulo che si compila, non una pagina che si consulta.
//
// Convertire `/iscrizione` a `PublicPageHeader` avrebbe voluto dire rifarle la
// testata e aggiungerle una via d'uscita che nessuno ha chiesto, su una pagina
// da cui ~9 famiglie l'ora consegnano dati di minori. Estrarre il marchio costa
// un file e lo lascia definito UNA volta: le impaginazioni restano due, l'asset
// e le sue misure una sola.
//
// ⚠️ Il difetto che questo file chiude era doppio, e la seconda metà è la
// peggiore: `/iscrizione` non aveva il marchio, E il commento del lock
// `PublicPageHeader-logo.test.tsx` la elencava fra «le cinque pagine pubbliche»
// che lo prendono dal componente. Il lock restava verde perché prova il
// componente ISOLATO, senza mai rendere la pagina — immunizzato dal proprio
// commento. Chi legge questo file non fidi un elenco di pagine scritto in un
// commento: si controlla con `grep -rn "PublicPageHeader\|MarchioKidville" src`.
//
// ─── LE MISURE, PRESE SULLA PAGINA VIVA IL 19-20/08/2026 ────────────────────
// Playwright su Chrome. Il wordmark ha proporzione 2227:571 ≈ 3,9:1.
//
//     altezza    larghezza resa
//     24 px      94 px      (`h-6`, sotto `sm`)
//     28 px      109 px     (`h-7`, da `sm` in su)
//
// Su `PublicPageHeader` a 360 e 390 px il gruppo di destra va a capo e la
// testata passa da 46 a 102 px: scelta consapevole del titolare (marchio
// ovunque), perché a quelle larghezze «Torna indietro» (111 px) e «Alto
// contrasto» (148 px) lasciano 49 px, cioè un wordmark alto 12. Da 414 px in su
// il costo è zero.
//
// Contrasto misurato sui PIXEL del file — l'inchiostro reale è `#007055`, non il
// token `#006A5F`: 6,09:1 su bianco (Alto Contrasto), 5,48:1 sul crema. La
// soglia WCAG 1.4.11 per la grafica non testuale è 3:1: passa in entrambi i
// modi, e il ripiego su `logo-light.png` non serve.
//
// ⚠️ L'ASSET È `logo-kidville.png`, NON `logo_green.png`. Sono lo stesso wordmark
// verde, ma il secondo è 6000×3375 con il marchio confinato nel terzo centrale:
// reso a 24 px ne misurerebbe otto. Nessun errore, nessun avviso — solo un logo
// che sembra sparito.
//
// ⚠️ NON È UN LINK. Queste schermate hanno una sola via d'uscita, ed è ciò che
// le rende leggibili. Un secondo bersaglio cliccabile a un dito di distanza
// gliela toglie.
// =============================================================================

export function MarchioKidville({ className = '' }: { className?: string }) {
  return (
    <Image
      src="/logo-kidville.png"
      alt="Kidville"
      width={2227}
      height={571}
      priority={false}
      // `w-auto` accanto a `h-*` è ciò che tiene la proporzione: `next/image`
      // vuole `width`/`height` per riservare lo spazio ed evitare il salto di
      // impaginazione, e senza `w-auto` quei 2227 px diventerebbero la larghezza.
      className={`h-6 w-auto sm:h-7 ${className}`}
    />
  )
}
