/**
 * IL NOME DI UN DOCUMENTO QUANDO IL NOME NON PORTA L'ESTENSIONE.
 *
 * Nell'app, un file in Cache senza estensione non si apre: iOS non sa che anteprima
 * usare (`OS-PLUG-FLVW-0013`) e Android non sa con che app aprirlo. Certi punti non
 * hanno un nome di file con l'estensione — il certificato medico ha solo il percorso
 * nello Storage (`<uuid>/<uuid>.pdf`), il dettaglio di un documento del fascicolo ha
 * un `file_name` che può mancare — ma hanno il PERCORSO, o l'indirizzo firmato che lo
 * contiene, e l'estensione vera sta lì.
 *
 * Qui si prende SOLO l'estensione: il resto del percorso sono uuid, che nel nome di
 * un file mostrato a un genitore o a una maestra non dicono niente. La ripulitura del
 * nome (barre, `..`, lunghezza) e la lista delle estensioni riconosciute restano di
 * `nomeFileDocumento` in `./scarica`, che riceve quello che esce da qui.
 */

const ESTENSIONE_RX = /\.([a-z0-9]{1,5})$/i

/** L'estensione dell'ultimo segmento di un percorso o di un URL, minuscola; `null` se non c'è. */
export function estensioneDaPercorso(percorso: string | null | undefined): string | null {
  const senzaQuery = (percorso ?? '').split(/[?#]/)[0]
  const ultimo = senzaQuery.slice(senzaQuery.lastIndexOf('/') + 1)
  const trovata = ultimo.match(ESTENSIONE_RX)
  // Un segmento che È solo un'estensione (`.pdf`) è un file nascosto, non un nome.
  if (!trovata || trovata.index === 0) return null
  return trovata[1].toLowerCase()
}

/**
 * `base` con l'estensione del FILE VERO (quella di `percorso`), se `base` non finisce
 * già con quella. `base` vuoto o assente → `predefinito`.
 *
 * Il confronto è con l'estensione del percorso, non con «una qualunque»: in
 * «ricevuta n.12» il `12` non è un'estensione, e fidarsi di lui lascerebbe il PDF
 * senza `.pdf`. Senza estensione nel percorso, `base` resta com'è.
 */
export function nomeConEstensione(
  base: string | null | undefined,
  percorso: string | null | undefined,
  predefinito = 'kidville-documento',
): string {
  const nome = (base ?? '').trim() || predefinito
  const estensione = estensioneDaPercorso(percorso)
  if (!estensione || estensioneDaPercorso(nome) === estensione) return nome
  return `${nome}.${estensione}`
}
