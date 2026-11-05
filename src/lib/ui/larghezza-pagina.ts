import type { FormatoGuscio } from '@/lib/ui/use-formato-guscio';

/**
 * LE LARGHEZZE DELLE PAGINE DI GENITORI E DOCENTI, in un posto solo.
 *
 * Sul telefono restano quelle di sempre: 430 px il genitore, 460 il docente. Da 744 px
 * (`tablet:`, l'iPad mini in verticale) la colonna di lettura sale a 720 px: prima ogni pagina
 * restava una striscia da telefono in mezzo all'iPad, con metà dello schermo vuota in verticale e
 * i due terzi in orizzontale. 720 e non «tutto»: è la misura che tiene leggibile una riga di
 * testo e un elenco di schede pensato per una colonna.
 *
 * Le pagine che vivono di larghezza (la chat a due riquadri, e dalla PR 2 le schermate che da
 * 1024 px si dispongono su due colonne) si dichiarano qui e arrivano a `max-w-5xl`.
 *
 * Le stringhe stanno qui per intero, mai montate a pezzi: Tailwind trova le classi leggendo il
 * sorgente, e una classe composta da frammenti non verrebbe generata. Il lock
 * `__tests__/architecture/colonna-tablet.test.ts` impedisce alle pagine di riscriversi a mano la
 * colonna da telefono.
 */

export const COLONNA_DOCENTE = 'mx-auto max-w-[460px] tablet:max-w-[720px]';
export const COLONNA_DOCENTE_LARGA = 'mx-auto max-w-[460px] tablet:max-w-5xl';

const COLONNA_GENITORE = 'max-w-[430px] tablet:max-w-[720px]';
const COLONNA_GENITORE_LARGA = 'max-w-[430px] tablet:max-w-5xl';

/** Larghe con le loro sottorotte: la chat a due riquadri. */
export const ROTTE_LARGHE_GENITORE: readonly string[] = ['/parent/chat'];

/**
 * Larghe SOLO in sé. Sono elenchi di schede che da 1024 px vanno su due colonne; le loro
 * sottorotte sono pagine da leggere (`/parent/news/<id>`, il digest) e restano a 720. Per
 * prefisso, `/parent` allargherebbe tutta l'area del genitore, e una pagina futura sotto
 * `/parent/pagamenti` nascerebbe larga senza che nessuno l'abbia deciso.
 */
export const ROTTE_LARGHE_GENITORE_ESATTE: readonly string[] = [
  '/parent',
  '/parent/gallery',
  '/parent/mensa',
  '/parent/pagamenti',
  '/parent/avvisi',
  '/parent/news',
];

export function classeColonnaGenitore(pathname: string): string {
  const larga =
    ROTTE_LARGHE_GENITORE_ESATTE.includes(pathname) ||
    ROTTE_LARGHE_GENITORE.some((r) => pathname === r || pathname.startsWith(`${r}/`));
  return larga ? COLONNA_GENITORE_LARGA : COLONNA_GENITORE;
}

/**
 * Due colonne da 1024 px, cioè dove compare la sidebar e lo spazio utile parte da 768 px: due
 * colonne da ~370. `items-start`: una scheda corta non si stira sull'altezza della vicina.
 *
 * Sotto `lg:` la colonna è UNA e va DICHIARATA (`grid-cols-1`, cioè `minmax(0, 1fr)`). Fino al
 * 2026-11-05 non lo era, e questo commento giurava che «una griglia a una colonna è identica
 * all'elenco impilato di prima». Non lo è: la colonna implicita di una griglia è `auto`, e una
 * colonna `auto` non scende mai sotto il min-content delle sue schede. Basta un `truncate`
 * (`white-space: nowrap`) con un testo lungo perché la colonna, e con lei OGNI scheda, si allarghi
 * quanto quel testo su una riga sola. È successo all'appello di Giugliano: il motivo d'assenza di
 * un genitore, 194 caratteri, ha portato le 26 righe a ~1.200 px, e i bottoni Presente/Assente sono
 * finiti oltre il bordo, tagliati dall'`overflow-hidden` della pagina. `minmax(0, …)` toglie quel
 * minimo: la colonna resta larga quanto lo schermo e il `truncate` mette i puntini.
 *
 * Il punto è `lg:` e non `tablet:`: sul binario (744–1023) lo spazio utile è ~650 px, e due
 * colonne da 320 stringerebbero schede pensate per un telefono da 390.
 */
export const DUE_COLONNE = 'grid grid-cols-1 gap-3 lg:grid-cols-2 lg:items-start';

/** Le schede per bambino degli editor del diario docente: stessa regola, passo più stretto. */
export const GRIGLIA_BAMBINI = 'grid grid-cols-1 gap-2 lg:grid-cols-2 lg:items-start';

const COLONNE_GALLERIA: Record<FormatoGuscio, 2 | 3 | 4> = { telefono: 2, binario: 3, sidebar: 4 };

/**
 * Quante colonne ha una galleria a tutta pagina. `MediaGrid` vuole che lo decida il chiamante e
 * non il viewport: questa funzione è il chiamante, uguale per genitori e docenti.
 */
export function colonneGalleria(formato: FormatoGuscio): 2 | 3 | 4 {
  return COLONNE_GALLERIA[formato];
}
