/**
 * INERZIA DELLO SFONDO — un solo pezzo, due consumatori.
 *
 * Questa funzione viveva dentro `src/components/ui/Modal.tsx`, non esportata. Il
 * collaudo del 2026-08-03 (rilievo T09-F1) ha misurato che il `PageLoader` — l'overlay
 * opaco a tutta pagina che compare a ogni navigazione lenta — **non** inertizzava
 * niente: con l'overlay a schermo il `Tab` continuava a girare sui comandi della pagina
 * sottostante, invisibili ma attivabili con `Invio` (WCAG 2.2 §2.4.11 *Focus Not
 * Obscured*, AA). Il repo aveva già il pezzo giusto e non lo usava: da qui l'estrazione.
 *
 * Il modulo è deliberatamente senza dipendenze da React: è DOM puro, e il registro dei
 * nodi marcati è condiviso fra TUTTI i consumatori. È questa condivisione a reggere il
 * caso «modale aperta mentre parte una navigazione»: se ognuno tenesse il proprio
 * registro, il primo dei due a chiudersi toglierebbe l'inerzia anche all'altro.
 */

/**
 * REGISTRO DEI NODI RESI INERTI — perché il conteggio, e non un booleano.
 *
 * Con due overlay sovrapposti gli stessi nodi di sfondo vengono marcati due volte:
 * se il secondo che si chiude togliesse l'attributo d'ufficio, la pagina tornerebbe
 * raggiungibile *sotto* un overlay ancora aperto — cioè il difetto che stiamo
 * chiudendo, ricomparso al secondo dialogo. Si tiene quindi un conteggio per
 * elemento e si ripristina solo quando torna a zero, ricordando anche lo stato
 * ORIGINALE (un nodo può essere già `inert` di suo: non glielo si toglie).
 */
const inerti = new Map<
  HTMLElement,
  { conteggio: number; aveaInert: boolean; ariaHiddenOriginale: string | null }
>()

/**
 * `true` se il motore implementa `inert` per davvero.
 *
 * ⚠️ In **jsdom 29.1.1 è `false`**: `'inert' in HTMLElement.prototype` non esiste e
 * l'attributo non toglie nulla dal giro del focus. Non è un dettaglio da nota a piè
 * di pagina — è il motivo per cui i test di questo modulo asseriscono sugli ATTRIBUTI
 * applicati e sul loro ripristino, e non su «il Tab non arriva al bottone»: quella
 * seconda asserzione, sotto jsdom, sarebbe verde per il motivo sbagliato.
 */
export const supportaInert = (): boolean =>
  typeof HTMLElement !== 'undefined' && 'inert' in HTMLElement.prototype

/**
 * Rende inerte tutto il documento TRANNE il sottoalbero del contenitore passato, e
 * restituisce la funzione che ripristina.
 *
 * PERCHÉ SERVE (misurato su Android il 2026-07-31). `aria-modal="true"` su un `div`
 * non esclude niente: Chromium lo onora solo per il top layer (`<dialog>` +
 * `showModal()`). Con la modale «Nuovo avviso» aperta, il dump dell'albero di
 * accessibilità conteneva ancora l'elenco degli avvisi con i suoi bottoni
 * «Modifica» ed «Elimina»: con TalkBack lo swipe portava fuori dalla modale, e i
 * comandi della pagina sotto restavano attivabili.
 *
 * PERCHÉ SI RISALE FINO A `document.body` MARCANDO I FRATELLI A OGNI LIVELLO, invece
 * di marcare i soli figli del `body`. La modale è renderizzata IN LINEA nell'albero
 * React (nessun portale): il suo contenitore è annidato in profondità dentro la
 * pagina, quindi i «fratelli a livello di body» sarebbero uno solo — il guscio che
 * contiene ANCHE la modale. Marcare i fratelli a ogni livello isola davvero il
 * sottoalbero del dialogo, senza cambiare dove la modale viene montata (un portale
 * avrebbe rotto i 15 consumatori e i loro test).
 *
 * `inert` E, SOLO DOVE NON ESISTE, `aria-hidden`. `inert` è la forma giusta: toglie
 * dall'albero di accessibilità E dal giro del focus. Dove il motore non lo conosce
 * (WebKit < 15.5; Chromium ce l'ha dalla 102) l'attributo resta comunque scritto —
 * costa nulla e diventa attivo il giorno in cui il browser si aggiorna — e si
 * affianca `aria-hidden="true"`, che almeno lo screen reader onora. Il ripiego NON
 * si applica dove `inert` esiste: `aria-hidden` su un sottoalbero ancora focusabile
 * sarebbe la violazione `aria-hidden-focus`, e lì il sottoalbero focusabile non
 * c'è più. Lo stato ORIGINALE di entrambi gli attributi si ricorda e si ripristina:
 * un nodo può essere già `inert`, o già `aria-hidden` perché decorativo, e non gli
 * si tocca niente.
 */
export function rendiInerteFuoriDa(contenitore: HTMLElement): () => void {
  const marcati: HTMLElement[] = []
  const ripiego = !supportaInert()
  let nodo: HTMLElement = contenitore
  while (nodo !== document.body && nodo.parentElement) {
    for (const fratello of Array.from(nodo.parentElement.children)) {
      if (fratello === nodo || fratello.nodeType !== 1) continue
      const el = fratello as HTMLElement
      const stato = inerti.get(el)
      if (stato) {
        stato.conteggio += 1
      } else {
        inerti.set(el, {
          conteggio: 1,
          aveaInert: el.hasAttribute('inert'),
          ariaHiddenOriginale: el.getAttribute('aria-hidden'),
        })
        el.setAttribute('inert', '')
        if (ripiego) el.setAttribute('aria-hidden', 'true')
      }
      marcati.push(el)
    }
    nodo = nodo.parentElement
  }

  return () => {
    for (const el of marcati) {
      const stato = inerti.get(el)
      if (!stato) continue
      stato.conteggio -= 1
      if (stato.conteggio > 0) continue
      inerti.delete(el)
      if (!stato.aveaInert) el.removeAttribute('inert')
      if (stato.ariaHiddenOriginale === null) el.removeAttribute('aria-hidden')
      else el.setAttribute('aria-hidden', stato.ariaHiddenOriginale)
    }
  }
}

/**
 * Rende inerte lo sfondo E si ricorda chi aveva il focus, per rimetterlo lì al
 * ripristino.
 *
 * PERCHÉ NON BASTA `rendiInerteFuoriDa` DA SOLA, e perché questo non è un fronzolo.
 * Nel browser vero, marcare `inert` l'antenato dell'elemento con focus lo fa perdere:
 * `document.activeElement` diventa `<body>`, e quando l'inerzia viene tolta il focus
 * NON torna da solo. Sul `PageLoader` l'overlay compare a ogni navigazione lenta e
 * resta a schermo almeno 700 ms: senza questo salvataggio si sarebbe scambiato un
 * difetto AA (focus nascosto sotto l'overlay) con una perdita di focus a ogni cambio
 * pagina — che per chi naviga da tastiera è peggio, perché lo rispedisce in cima al
 * documento ogni volta.
 *
 * IL FOCUS SI RIMETTE SOLO SE È DAVVERO CADUTO SUL `body`. Se nel frattempo il focus
 * è finito altrove (l'utente ha cliccato, la pagina nuova ha messo a fuoco il proprio
 * contenuto), riportarlo indietro sarebbe rubarlo. E solo se l'elemento è ancora
 * attaccato al documento: dopo una navigazione quasi sempre non lo è più, e
 * `.focus()` su un nodo staccato è un no-op silenzioso.
 */
export function rendiInerteFuoriDaConFocus(contenitore: HTMLElement): () => void {
  const attivoPrima = (document.activeElement as HTMLElement | null) ?? null
  const ripristinaInerzia = rendiInerteFuoriDa(contenitore)

  return () => {
    // L'inerzia si toglie PRIMA di restituire il focus: un elemento `inert` non può
    // riceverlo, e il ripristino fallirebbe in silenzio.
    ripristinaInerzia()
    if (!attivoPrima || attivoPrima === document.body) return
    if (!attivoPrima.isConnected) return
    const attivoOra = document.activeElement
    if (attivoOra && attivoOra !== document.body) return
    attivoPrima.focus()
  }
}
