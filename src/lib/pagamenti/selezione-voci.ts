/**
 * Selezione delle voci di pagamento per KPI di Contabilità: più categorie × più
 * mesi di un anno scolastico. Logica pura, senza I/O.
 *
 * Regole:
 *  - il «mese di una voce» vale per tutte le categorie: `periodo_competenza` se
 *    presente, altrimenti il mese della `scadenza` (alcune rette ne sono prive);
 *  - l'anno scolastico `anno` va da settembre `anno` ad agosto `anno+1` (12 mesi:
 *    esistono voci con scadenza a luglio/agosto);
 *  - selezione vuota = tutto: `categorie: []` = tutte, `mesi: []` = «tutto l'anno»;
 *  - le voci `tipo === 'padre'` NON si escludono qui (lo fa `calcolaTotaliPagamenti`).
 */
import { intlDateTime } from '@/i18n/config';
import { mesiDelAnno } from '@/lib/anno-scolastico';

export interface SelezioneVoci {
  categorie: string[];
  anno: number;
  /** Mesi di calendario 1..12. */
  mesi: number[];
}

export interface VoceDatata {
  categoria_id?: string | null;
  periodo_competenza?: string | null;
  scadenza?: string | null;
}

/** I 12 primi del mese dell'anno scolastico `anno`, settembre → agosto: le posizioni, non i giorni (4.1.S4a). */
const dodiciMesi = (anno: number) => mesiDelAnno(anno, { da: 9, a: 8 });

/**
 * 'YYYY-MM-01' del mese di calendario `mese` (1..12) dell'anno scolastico `anno`: la risposta la dà il
 * modulo dell'anno (`mesiDelAnno`), qui non c'è nessuna soglia. Un `mese` fuori da 1..12 è un `RangeError`.
 */
export function periodoDi(anno: number, mese: number): string {
  if (!Number.isInteger(mese) || mese < 1 || mese > 12) {
    throw new RangeError('mese non valido: atteso un intero da 1 a 12');
  }
  const trovato = dodiciMesi(anno).find((p) => Number(p.slice(5, 7)) === mese);
  if (!trovato) throw new RangeError('mese non valido: atteso un intero da 1 a 12');
  return trovato;
}

/** I 12 mesi dell'anno scolastico, da settembre ad agosto. */
export function mesiAnnoScolastico(anno: number): { mese: number; periodo: string }[] {
  return dodiciMesi(anno).map((periodo) => ({ mese: Number(periodo.slice(5, 7)), periodo }));
}

const SOLO_ANNO_MESE = /^\d{4}-\d{2}/;

/** 'YYYY-MM' da `periodo_competenza`, altrimenti dalla `scadenza`, altrimenti null. */
export function meseDellaVoce(v: VoceDatata): string | null {
  for (const d of [v.periodo_competenza, v.scadenza]) {
    if (d && SOLO_ANNO_MESE.test(d)) return d.slice(0, 7);
  }
  return null;
}

/** Mese di calendario 1..12 della data civile 'YYYY-MM-DD'. */
export function meseDi(oggi: string): number {
  return Number(oggi.slice(5, 7));
}

/**
 * I mesi scelti come INSIEME: senza duplicati e solo interi 1..12. Unico punto in
 * cui si decide cosa conta come «mese scelto», usato da filtro, etichetta e vista
 * per alunno. Se non resta nessun mese valido (lista vuota o tutti fuori range) la
 * selezione vale «tutto l'anno», per il filtro e per l'etichetta (null).
 */
export function mesiValidi(mesi: number[]): number[] {
  return [...new Set(mesi.filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))];
}

export function filtraPerSelezione<T extends VoceDatata>(voci: T[], sel: SelezioneVoci): T[] {
  const categorie = new Set(sel.categorie);
  const tutteLeCategorie = categorie.size === 0;
  const validi = mesiValidi(sel.mesi);
  const mesiAmmessi = new Set(
    (validi.length === 0 ? mesiAnnoScolastico(sel.anno).map((m) => m.mese) : validi).map((mese) =>
      periodoDi(sel.anno, mese).slice(0, 7),
    ),
  );
  return voci.filter((v) => {
    if (!tutteLeCategorie && !(v.categoria_id && categorie.has(v.categoria_id))) return false;
    const mese = meseDellaVoce(v);
    return mese !== null && mesiAmmessi.has(mese);
  });
}

/** Vista «per alunno»: solo la retta e un solo mese (categorie e mesi come insiemi). */
export function eVistaPerAlunno(sel: SelezioneVoci, rettaId: string | undefined): boolean {
  if (rettaId === undefined) return false;
  const categorie = new Set(sel.categorie);
  return categorie.size === 1 && categorie.has(rettaId) && mesiValidi(sel.mesi).length === 1;
}

/** Settembre..giugno sì, luglio e agosto no. */
export function eMeseDiRetta(mese: number): boolean {
  return mese !== 7 && mese !== 8;
}

function formatoMese(periodo: string, locale: string, month: 'short' | 'long'): string {
  const anno = Number(periodo.slice(0, 4));
  const mese = Number(periodo.slice(5, 7));
  return intlDateTime(locale, { month, timeZone: 'UTC' }).format(new Date(Date.UTC(anno, mese - 1, 15)));
}

/** Abbreviazione come la dà Intl (maiuscole della lingua), senza punto finale (difensivo: it-IT ed en-GB non hanno il punto finale, altre lingue sì, es. fr «sept.»). */
function abbreviato(periodo: string, locale: string): string {
  return formatoMese(periodo, locale, 'short').replace(/\.$/, '');
}

/** 'corta' = «Ott 2026» (iniziale maiuscola, senza punto); 'lunga' = come Intl («ottobre 2026», «October 2026»). */
export function etichettaMese(periodo: string, locale: string, forma: 'corta' | 'lunga'): string {
  const anno = periodo.slice(0, 4);
  if (forma === 'lunga') return `${formatoMese(periodo, locale, 'long')} ${anno}`;
  const s = abbreviato(periodo, locale);
  return `${s.charAt(0).toUpperCase()}${s.slice(1)} ${anno}`;
}

/**
 * Etichetta dei mesi scelti, o null se nessun mese valido (vedi `mesiValidi`: il
 * chiamante scrive «tutto l'anno» con i18n). Un mese: «ottobre 2026». Più mesi:
 * intervalli contigui («set–ott 2026», «dic 2026–gen 2027»), mesi isolati
 * («nov 2026»), separati da «, ».
 */
export function etichettaMesi(sel: SelezioneVoci, locale: string): string | null {
  const scelti = new Set(mesiValidi(sel.mesi));
  const ordinati = mesiAnnoScolastico(sel.anno)
    .map((m, i) => ({ ...m, i }))
    .filter((m) => scelti.has(m.mese));
  if (ordinati.length === 0) return null;
  if (ordinati.length === 1) return etichettaMese(ordinati[0].periodo, locale, 'lunga');

  // Intervalli contigui nell'ordine set→ago.
  const gruppi: (typeof ordinati)[] = [];
  for (const m of ordinati) {
    const ultimo = gruppi[gruppi.length - 1];
    if (ultimo && m.i === ultimo[ultimo.length - 1].i + 1) ultimo.push(m);
    else gruppi.push([m]);
  }

  return gruppi
    .map((g) => {
      const da = g[0].periodo;
      const a = g[g.length - 1].periodo;
      if (g.length === 1) return `${abbreviato(da, locale)} ${da.slice(0, 4)}`;
      if (da.slice(0, 4) === a.slice(0, 4)) return `${abbreviato(da, locale)}\u2013${abbreviato(a, locale)} ${da.slice(0, 4)}`;
      return `${abbreviato(da, locale)} ${da.slice(0, 4)}\u2013${abbreviato(a, locale)} ${a.slice(0, 4)}`;
    })
    .join(', ');
}
