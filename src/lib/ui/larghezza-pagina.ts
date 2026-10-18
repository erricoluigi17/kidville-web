/**
 * LE LARGHEZZE DELLE PAGINE DI GENITORI E DOCENTI, in un posto solo.
 *
 * Sul telefono restano quelle di sempre: 430 px il genitore, 460 il docente. Da 744 px
 * (`tablet:`, l'iPad mini in verticale) la colonna di lettura sale a 720 px: prima ogni pagina
 * restava una striscia da telefono in mezzo all'iPad, con metà dello schermo vuoto in verticale e
 * i due terzi in orizzontale. 720 e non «tutto»: è la misura che tiene leggibile una riga di
 * testo e un elenco di schede pensato per una colonna.
 *
 * Le pagine che vivono di larghezza (la chat a due riquadri, che si apre da 768 px) si dichiarano
 * in `ROTTE_LARGHE_GENITORE` e arrivano a `max-w-5xl`.
 *
 * Le stringhe stanno qui per intero, mai montate a pezzi: Tailwind trova le classi leggendo il
 * sorgente, e una classe composta da frammenti non verrebbe generata. Il lock
 * `__tests__/architecture/colonna-tablet.test.ts` impedisce alle pagine di riscriversi a mano la
 * colonna da telefono.
 */

export const COLONNA_DOCENTE = 'mx-auto max-w-[460px] tablet:max-w-[720px]';

const COLONNA_GENITORE = 'max-w-[430px] tablet:max-w-[720px]';
const COLONNA_GENITORE_LARGA = 'max-w-[430px] tablet:max-w-5xl';

export const ROTTE_LARGHE_GENITORE: readonly string[] = ['/parent/chat'];

export function classeColonnaGenitore(pathname: string): string {
  const larga = ROTTE_LARGHE_GENITORE.some((r) => pathname === r || pathname.startsWith(`${r}/`));
  return larga ? COLONNA_GENITORE_LARGA : COLONNA_GENITORE;
}
