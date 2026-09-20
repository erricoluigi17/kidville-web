/**
 * Costanti di stile della Contabilità (modali + form), su token dell'app.
 *
 * Stesso approccio di `features/admin/settings/ui.ts`: un solo posto dove vive la
 * pelle, allineata alle primitive cockpit (`Toolbar`/`CockpitSelect`/`Drawer`) e
 * al bottone-pillola `Btn`. Nessun hex, nessun `bg-white`/`text-white` nudo:
 * `@theme inline` non li remappa in Alto Contrasto, i token `kidville-*` sì.
 */
import { SHADOW_FLOAT } from '@/components/ui/Card';

/** Ombra del pannello fluttuante (modali), come il Drawer cockpit. */
export const MODAL_SHADOW = SHADOW_FLOAT;

/** Scrim del modale: inchiostro tenue come il Drawer cockpit (non `bg-black`). */
export const MODAL_OVERLAY = 'fixed inset-0 z-50 flex items-center justify-center bg-kidville-ink/40 p-4';

/** Card del modale: bianca, raggio card. Applicare `style={{ boxShadow: MODAL_SHADOW }}`. */
export const MODAL_CARD = 'w-full max-w-md rounded-card bg-kidville-white p-5';

/**
 * La card del popup che è un BANCO DI LAVORO, non un messaggio: quasi a tutto
 * schermo (~95%), margine sottile, e resta un popup — non una pagina, non un
 * pannello laterale. Il suo unico consumatore è il popup del movimento della
 * Riconciliazione, dove nella stessa card stanno causale, avvisi, suggerimenti,
 * l'intero form di composizione e la lista dei pagamenti aperti: a 512px quella
 * roba scorreva tutta insieme, «Chiudi» compreso.
 *
 * `MODAL_CARD` resta quello che è: lo usano gli altri modali di Contabilità, che
 * sono messaggi brevi e a 448/512px stanno benissimo.
 *
 * ⚠️ `h-[95dvh]` È L'INTENZIONE, `max-h-full` È LA GUARDIA, e non sono un
 * doppione del vecchio `max-h-[calc(100dvh-2rem)]`. Quel `calc` sottraeva a mano
 * l'imbottitura del contenitore di `Modal` — `p-4`, cioè 2rem fra sopra e sotto —
 * e con `safeArea` attivo quell'imbottitura diventa
 * `max(1rem, env(safe-area-inset-*))`: una misura che QUI non si può scrivere,
 * perché dipende dal telefono. `max-h-full` non la scrive: una percentuale su un
 * figlio flex si risolve sul CONTENT BOX del contenitore, cioè su ciò che resta
 * TOLTA l'imbottitura qualunque essa sia. La card non può finire sotto il notch o
 * sopra l'home indicator, e non c'è nessun numero da tenere allineato a mano.
 *
 * `dvh` e non `vh`: su iOS `vh` conta anche la barra degli indirizzi che poi si
 * ritira, cioè misura una finestra che non c'è.
 *
 * Nessun `p-*`: qui dentro la spaziatura è delle tre fasce (testa fissa, corpo
 * che scorre, piede fisso). Un padding sulla card farebbe scorrere il contenuto
 * dentro una cornice, che è il difetto che questa card chiude.
 */
export const MODAL_CARD_QUASI_SCHERMO =
  'flex h-[95dvh] max-h-full w-full max-w-[95%] flex-col overflow-hidden rounded-card bg-kidville-white';

/** Input testo/numero/data/textarea: raggio input, bordo 1.5, focus verde con ring. */
export const INPUT =
  'w-full rounded-input border-[1.5px] border-kidville-line bg-kidville-white px-3 py-2 font-maven text-sm text-kidville-ink outline-none transition-colors focus:border-kidville-green focus:ring-2 focus:ring-kidville-green/15';

/** Select native brandizzata (INPUT + cursore pointer). */
export const SELECT = `${INPUT} cursor-pointer hover:border-kidville-green/50`;

/** Bottone primario pillola: verde + giallo come `Btn` primary dell'app. */
export const BTN_PRIMARY =
  'inline-flex items-center justify-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2.5 font-maven text-sm font-bold text-kidville-yellow transition-colors hover:bg-kidville-green-dark disabled:opacity-50';

/**
 * CTA primaria AA della feature Riconciliazione: come `BTN_PRIMARY` ma testo
 * BIANCO su verde (≈6,5:1) invece del giallo-su-verde (~4:1, sotto AA). Locale
 * alla feature per non toccare il `Btn` globale dell'app.
 */
export const BTN_PRIMARY_AA =
  'inline-flex items-center justify-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2.5 font-maven text-sm font-bold text-kidville-white transition-colors hover:bg-kidville-green-dark disabled:opacity-50';

/** Bottone secondario pillola: bordo line, testo sub, AA a riposo (annulla/chiudi). */
export const BTN_SECONDARY =
  'inline-flex items-center justify-center gap-1.5 rounded-pill border-[1.5px] border-kidville-line bg-kidville-white px-5 py-2.5 font-maven text-sm font-bold text-kidville-sub transition-colors hover:border-kidville-green hover:text-kidville-green disabled:opacity-50';
