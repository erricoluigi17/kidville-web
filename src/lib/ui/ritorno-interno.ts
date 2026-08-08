/**
 * DOVE SI TORNA DA UNA PAGINA PUBBLICA — e perché il valore va filtrato.
 *
 * Le pagine legali (`/privacy`, `/termini`, `/assistenza`,
 * `/cancellazione-account`) si aprono anche DA DENTRO l'app: dal modulo
 * «Comunica un'assenza», dal profilo, dall'onboarding. Nel guscio nativo non
 * esistono le schede del browser, quindi non si aprono «di fianco»: si naviga, e
 * per rientrare serve un ritorno esplicito — la history di una WebView non è
 * affidabile (deep link, riavvii, `AppBar.tsx` lo annota da tempo).
 *
 * Il ritorno viaggia quindi nella query (`?da=/parent/attendance`), cioè in un
 * valore che scrive chiunque sappia comporre un URL. Senza filtro, «← Torna
 * indietro» diventerebbe un rimbalzo verso un sito qualunque partendo da una
 * pagina di `app.kidville.it` — l'open redirect, che su una pagina che parla di
 * dati sanitari di minori è anche il posto più credibile dove mettere una finta
 * schermata di accesso.
 *
 * La regola è a LISTA BIANCA, come la redazione dei log: passa solo ciò che ha
 * la forma di un percorso di questa applicazione, tutto il resto torna a `/`.
 */

/** Il percorso di ritorno, oppure la home se il valore non è interno. */
export function ritornoInterno(valore: string | null | undefined): string {
  if (typeof valore !== 'string' || valore === '') return '/'
  // Deve cominciare con una sola barra. `//host` è protocol-relative (il browser
  // lo risolve come `https://host`), e `\` viene normalizzato in `/` da alcuni
  // browser PRIMA della risoluzione: entrambe le forme sembrano interne e non lo
  // sono.
  if (!valore.startsWith('/')) return '/'
  if (valore.startsWith('//') || valore.startsWith('/\\')) return '/'
  return valore
}
