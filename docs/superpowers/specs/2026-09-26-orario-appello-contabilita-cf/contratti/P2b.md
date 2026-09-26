# P2b — Badge Sede su agenda, card mobile e drawer

Contratto per chi integra (P2, `PaymentsDashboard`). Nessuna route toccata: la sede arriva già su
ogni riga di `GET /api/pagamenti` come `scuola_nome` (null se la sede non ha nome).

## Prop comune

`mostraSede?: boolean` — **default `false`**. Da passare `true` quando le sedi effettive
(`useSediAttive`) sono **più di una**. Con `false` (o assente) il rendering è **identico** a prima.

Come lo verificano i test, componente per componente:

- **tutti e tre**: l'`innerHTML` con `mostraSede` assente e con `mostraSede={false}`, su una riga
  **con** `scuola_nome`, è uguale (`toBe`) a quello di una riga **senza** `scuola_nome`. Questo
  prova che il nome della sede non finisce nel markup, né come testo né come attributo;
- **agenda e card**: P2b vi aggiunge soltanto un elemento condizionato (`{mostraSede && …}`) e
  non tocca la struttura esistente, quindi il confronto sopra basta;
- **drawer**: qui il ramo `false` è uno dei due lati di un ternario, e un cambio di struttura che
  colpisse tutti e tre i render con la prop spenta (per esempio un `<span>` attorno al Badge di
  stato) sfuggirebbe a un confronto fra di loro. Per questo lo scheletro della prima riga del
  riepilogo (tag e testo, senza classi) si confronta anche con un **riferimento fisso** preso
  dal markup di prima di P2b: `<div><span>Pagato</span><span><span>Da fatturare</span></span></div>`.
  Gli id di `useId`, che cambiano a ogni montaggio, sono normalizzati prima del confronto, e
  solo quelli.

Con `true` una riga senza `scuola_nome` (o con soli spazi) non resta mai un vuoto: compare
**«Sede non indicata»**. La **forma** però cambia da componente a componente, e chi integra non
deve dare per scontato un tono:

- **card e drawer**: è un `BadgeSede` con tono **`warn`** (`bg-kidville-warn-soft`); con un nome
  valido il tono è **`neutral`** (`bg-kidville-neutral-soft`). I test lo verificano in entrambi i
  versi;
- **agenda**: **nessun badge e nessun tono `warn`**. «Sede non indicata» è una voce di testo della
  ripartizione, in fondo, con lo stesso stile delle altre (`text-kidville-sub`). Vedi sotto.

## `AgendaScadenze`

```ts
pagamenti: (AgingPagamento & { scuola_nome?: string | null })[]
mostraSede?: boolean   // nuovo
```

I bucket sono aggregati: con `mostraSede` sotto il numero compare la ripartizione per sede
(«Kidville Aversa 1 · Kidville Giugliano 2»), in ordine alfabetico, con le righe senza sede in
fondo come «Sede non indicata» — testo semplice come le altre voci (`text-kidville-sub`), **senza**
Badge e **senza** tono `warn`. Un bucket a zero non mostra la ripartizione. Il clic sul bucket
non cambia. Contenitore: `data-testid="agenda-sedi"`, con due figli: una frase `sr-only`
per lo screen reader e la riga visiva (nomi, numeri e «·») tutta `aria-hidden`. La frase letta
viene interamente dal catalogo: la cornice `sedeRipartizione` («Ripartizione per sede: {elenco}»),
ogni voce `sedeRipartizioneVoce` («{nome} {n}»), e la congiunzione fra le voci da
`Intl.ListFormat(locale, { type: 'conjunction' })` sulla lingua corrente (`useLocale()`):
«Ripartizione per sede: Kidville Aversa 1 e Kidville Giugliano 2», con tre voci
«…Aversa 1, Kidville Cesa 1 e Kidville Giugliano 2». Nessuna punteggiatura cablata nel JSX.

## `PagamentoCardMobile`

```ts
pagamento: PagamentoRow & { scadenza?: string | null } & ConSede
mostraSede?: boolean   // nuovo
```

Badge sotto alunno/sezione. `data-testid="sede-badge"`. Tono `neutral` con un nome, `warn` con
«Sede non indicata».

## `PagamentoDrawer`

```ts
pagamento: PagamentoRow & { scadenza?: string | null } & ConSede
mostraSede?: boolean   // nuovo
```

Badge accanto al badge di stato nel riepilogo. La sede viene dalla **riga** passata, non dal
dettaglio `GET /api/pagamenti/[id]`. Tono `neutral` con un nome, `warn` con «Sede non indicata».

## Esportati da `PagamentoCardMobile.tsx`

- `type ConSede = { scuola_nome?: string | null }` — `PagamentoRow` (in `RegistraIncassoModal.tsx`)
  **non** è stato toccato: il campo è aggiunto per intersezione nei tre componenti.
- `BadgeSede({ nome, className })` — badge `neutral` (`warn` se `nome` è assente o di soli spazi,
  con il testo «Sede non indicata») con icona `MapPin`, nome troncato. Con un nome lo screen
  reader legge la frase ICU `sedeBadge` («Sede: {nome}», `sr-only`) e il nome visibile è
  `aria-hidden`, così è letto una volta sola; senza nome si legge **solo** «Sede non indicata»,
  senza prefisso (niente «Sede Sede non indicata»). Riutilizzabile in tabella (P2). Resta
  **maiuscolo** come ogni Badge del design system: non passargli `normal-case`/`tracking-*` da
  `className`, perché fra utility di pari specificità decide l'ordine nel foglio di stile.

## i18n (`adminContabilita`, it + en)

`sedeBadge` («Sede: {nome}»/«Location: {nome}»), `sedeBadgeNonIndicata` («Sede non
indicata»/«Location not set»), `sedeRipartizione` («Ripartizione per sede: {elenco}»/«Breakdown
by location: {elenco}»), `sedeRipartizioneVoce` («{nome} {n}» in entrambe).
