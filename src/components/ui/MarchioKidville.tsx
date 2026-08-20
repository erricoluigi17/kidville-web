import Image from 'next/image'

// =============================================================================
// IL MARCHIO, IN UN COMPONENTE SOLO.
//
// ─── PERCHÉ NON STA DENTRO `PublicPageHeader` E BASTA ───────────────────────
// Perché le impaginazioni pubbliche sono più d'una, e il 2026-08-20 il collaudo
// ha misurato che una era rimasta senza marchio.
//
//  · `PublicPageHeader` — «← Torna indietro» a sinistra, comandi a destra. La
//    usano `/lavora-con-noi`, `/privacy`, `/termini`, `/assistenza`,
//    `/cancellazione-account`, `/anagrafica-personale`.
//  · `EnrollmentWizard` (`/iscrizione`) — titolo e contatore dei passi a
//    sinistra, comandi a destra. Non ha un link di ritorno e non ne vuole uno:
//    è un modulo che si compila, non una pagina che si consulta.
//
// ⚠️ E NON SONO DUE. Questo commento diceva «DUE testate, non una» ed era falso
// il giorno in cui è stato scritto, misurato dalla verifica avversariale dello
// stesso giorno:
//
//  · `/cancellazione-account/conferma` ha una TERZA testata, ricopiata a mano
//    (`page.tsx:32-40`), che il marchio non ce l'ha;
//  · `src/app/auth/login/page.tsx:758` monta `<Image src="/logo-kidville.png"
//    width={2227} height={571}>` per conto suo, quindi nemmeno «lo lascia
//    definito UNA volta» è vero: le definizioni sono due, e la login non è in
//    nessuno dei due lock.
//
// Restano fuori di proposito (debito preesistente, non regressioni di questo
// lavoro: `git diff main...HEAD` non le tocca): `/cancellazione-account/conferma`
// e `/m/[token]`. Vanno chiuse insieme al lock derivato da `PUBLIC_PREFIXES`.
//
// Convertire `/iscrizione` a `PublicPageHeader` avrebbe voluto dire rifarle la
// testata e aggiungerle una via d'uscita che nessuno ha chiesto, su una pagina
// da cui ~9 famiglie l'ora consegnano dati di minori. Estrarre il marchio costa
// un file e riduce le definizioni da tre a due.
//
// ⚠️ Il difetto che questo file chiude era doppio, e la seconda metà è la
// peggiore: `/iscrizione` non aveva il marchio, E il commento del lock
// `PublicPageHeader-logo.test.tsx` la elencava fra «le cinque pagine pubbliche»
// che lo prendono dal componente. Il lock restava verde perché prova il
// componente ISOLATO, senza mai rendere la pagina — immunizzato dal proprio
// commento.
//
// ⚠️ E IL METODO CHE QUESTO STESSO BLOCCO PRESCRIVEVA ERA SBAGLIATO. Diceva: «si
// controlla con `grep -rn "PublicPageHeader\|MarchioKidville" src`». Quella
// grep può elencare soltanto le pagine che il marchio CE L'HANNO: per
// costruzione non può mostrare una pagina che non lo nomina, cioè non può
// rilevare la classe di difetto per cui questo file è nato. Il metodo giusto è
// quello di `__tests__/architecture/prefissi-pubblici.test.ts`: partire da
// `PUBLIC_PREFIXES` e camminare `src/app` cercando ogni `page.tsx`. Un
// rilevatore che parte dai presenti non trova mai un assente.
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
// ⚠️ QUELLA MISURA VALE PER `PublicPageHeader`, E BASTA — e per due giorni si è
// creduto valesse anche per l'altra testata. Non era così: `EnrollmentWizard`
// (`/iscrizione`) la riga di testa la costruisce per conto suo, e `flex-wrap`
// NON ce l'aveva. Misurato con Chromium sulla pagina viva il 2026-08-20,
// `document.documentElement.scrollWidth` contro `clientWidth`:
//
//     viewport   con il marchio, prima   dopo `flex-wrap`+`min-w-0`
//     320 px     394  ❌ trabocca        320 ✅   (testa 98 px)
//     360 px     423  ❌                 360 ✅   (testa 98 px)
//     390 px     437  ❌                 390 ✅   (testa 98 px)
//     414 px     448  ❌                 414 ✅   (testa 82 px)
//     768 px     —                       768 ✅   (testa 46 px, nessun a capo)
//
// Nascondendo il solo `<img>` l'eccedenza spariva a OGNI larghezza: la causa era
// il marchio, e la pagina scrollava in orizzontale. Il rilievo che l'aveva
// ipotizzata parlava di «250 px sotto i 360»: aveva ragione sulla causa e per
// difetto sulla portata, perché il blocco di sinistra non aveva `min-w-0` e il
// suo min-content spingeva fuori il resto a qualunque larghezza.
//
// La lezione è la ragione per cui questa tabella sta scritta qui: una misura
// presa su una delle due testate NON dice niente dell'altra, e usarla per
// entrambe è il modo in cui questo difetto è passato.
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
