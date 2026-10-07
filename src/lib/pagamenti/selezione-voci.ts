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

const dueCifre = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-01' del mese dell'anno scolastico `anno`: set-dic nell'anno, gen-ago nel successivo. */
export function periodoDi(anno: number, mese: number): string {
  return `${mese >= 9 ? anno : anno + 1}-${dueCifre(mese)}-01`;
}

/** I 12 mesi dell'anno scolastico, da settembre ad agosto. */
export function mesiAnnoScolastico(anno: number): { mese: number; periodo: string }[] {
  return [9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8].map((mese) => ({ mese, periodo: periodoDi(anno, mese) }));
}

const SOLO_ANNO_MESE = /^\d{4}-\d{2}/;

/** 'YYYY-MM' da `periodo_competenza`, altrimenti dalla `scadenza`, altrimenti null. */
export function meseDellaVoce(v: VoceDatata): string | null {
  for (const d of [v.periodo_competenza, v.scadenza]) {
    if (d && SOLO_ANNO_MESE.test(d)) return d.slice(0, 7);
  }
  return null;
}

/** Anno scolastico (anno d'inizio) a cui appartiene la data 'YYYY-MM-DD'. */
export function annoScolasticoDi(oggi: string): number {
  const anno = Number(oggi.slice(0, 4));
  return meseDi(oggi) >= 9 ? anno : anno - 1;
}

/** Mese di calendario 1..12 della data 'YYYY-MM-DD'. */
export function meseDi(oggi: string): number {
  return Number(oggi.slice(5, 7));
}

export function filtraPerSelezione<T extends VoceDatata>(voci: T[], sel: SelezioneVoci): T[] {
  const categorie = new Set(sel.categorie);
  const tutteLeCategorie = categorie.size === 0;
  const mesiAmmessi = new Set(
    (sel.mesi.length === 0
      ? mesiAnnoScolastico(sel.anno)
      : sel.mesi.map((mese) => ({ mese, periodo: periodoDi(sel.anno, mese) }))
    ).map((m) => m.periodo.slice(0, 7)),
  );
  return voci.filter((v) => {
    if (!tutteLeCategorie && !(v.categoria_id && categorie.has(v.categoria_id))) return false;
    const mese = meseDellaVoce(v);
    return mese !== null && mesiAmmessi.has(mese);
  });
}

/** Vista «per alunno»: solo la retta e un solo mese. */
export function eVistaPerAlunno(sel: SelezioneVoci, rettaId: string | undefined): boolean {
  return (
    rettaId !== undefined &&
    sel.categorie.length === 1 &&
    sel.categorie[0] === rettaId &&
    sel.mesi.length === 1
  );
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

/** 'corta' = «Ott 2026» (iniziale maiuscola); 'lunga' = come Intl («ottobre 2026», «October 2026»). */
export function etichettaMese(periodo: string, locale: string, forma: 'corta' | 'lunga'): string {
  const anno = periodo.slice(0, 4);
  if (forma === 'lunga') return `${formatoMese(periodo, locale, 'long')} ${anno}`;
  const s = formatoMese(periodo, locale, 'short');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)} ${anno}`;
}

/** Abbreviazione come la dà Intl (maiuscole della lingua), senza punto finale («sept.» → «sept»). */
function abbreviato(periodo: string, locale: string): string {
  return formatoMese(periodo, locale, 'short').replace(/\.$/, '');
}

/**
 * Etichetta dei mesi scelti, o null con `mesi` vuoto (il chiamante scrive «tutto
 * l'anno» con i18n). Un mese: «ottobre 2026». Più mesi: intervalli contigui
 * («set–ott 2026», «dic 2026–gen 2027»), mesi isolati («nov 2026»), separati da «, ».
 */
export function etichettaMesi(sel: SelezioneVoci, locale: string): string | null {
  const scelti = new Set(sel.mesi);
  const ordinati = mesiAnnoScolastico(sel.anno).filter((m) => scelti.has(m.mese));
  if (ordinati.length === 0) return null;
  if (ordinati.length === 1) return etichettaMese(ordinati[0].periodo, locale, 'lunga');

  // Intervalli contigui nell'ordine set→ago.
  const indice = new Map(mesiAnnoScolastico(sel.anno).map((m, i) => [m.periodo, i]));
  const gruppi: { periodo: string }[][] = [];
  for (const m of ordinati) {
    const ultimo = gruppi[gruppi.length - 1];
    if (ultimo && indice.get(m.periodo)! === indice.get(ultimo[ultimo.length - 1].periodo)! + 1) ultimo.push(m);
    else gruppi.push([m]);
  }

  return gruppi
    .map((g) => {
      const da = g[0].periodo;
      const a = g[g.length - 1].periodo;
      if (g.length === 1) return `${abbreviato(da, locale)} ${da.slice(0, 4)}`;
      if (da.slice(0, 4) === a.slice(0, 4)) return `${abbreviato(da, locale)}–${abbreviato(a, locale)} ${da.slice(0, 4)}`;
      return `${abbreviato(da, locale)} ${da.slice(0, 4)}–${abbreviato(a, locale)} ${a.slice(0, 4)}`;
    })
    .join(', ');
}
