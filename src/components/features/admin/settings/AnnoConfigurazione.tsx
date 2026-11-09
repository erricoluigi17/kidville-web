'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Tabs } from '@/components/ui/cockpit';
import { formatEuro } from '@/lib/format/valuta';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { btnPrimary, hint, input, label } from './ui';

/**
 * QUOTE, MODULI, POSTI E CLASSI DELL'ANNO CHE SI STA PREPARANDO (PR 4.5, compito 4.5.3).
 *
 * È ciò che manca perché il pulsante «Apri le iscrizioni» (PR 4.2) possa accendersi: la segreteria scrive qui le due quote,
 * i moduli per ciascuna lista e i posti autorizzati. Le regole stanno nel database e nelle route
 * `/api/admin/anni/[annoSedeId]/{quote,moduli,posti,sezioni}`; qui si fa vedere ciò che rispondono, con le parole della segreteria.
 *
 * ─── COSE CHE NON SI TOCCANO ─────────────────────────────────────────────────
 *  · NESSUN importo, data o titolo predefinito: ogni campo parte vuoto o da ciò che il database ha già. Le quote le decide la segreteria.
 *  · Un rifiuto non cancella ciò che si stava digitando: i campi tengono la bozza, l'errore sta sotto il blocco.
 *  · Lo stato d'errore è un CODICE (`ErroreUi`) tradotto al render.
 *  · La retta mensile (PR 4.6) sta nella scheda «Rette»: importo per fascia o per tutte, e i mesi in cui si genera. Il servizio mensile
 *    ha la sua route ma non una schermata: vuole una categoria da scegliere.
 *  · Nel messaggio di un rifiuto passano solo parole del catalogo: mai righe di bambini (qui non ce ne sono).
 */

type Scheda = 'quote' | 'rette' | 'moduli' | 'posti';
type Lista = 'conferma' | 'nuova';
type VoceQuota = 'quota_conferma' | 'quota_nuova';

type ErroreUi = { tipo: 'rete' } | { tipo: 'permesso' } | { tipo: 'campo'; chiave: 'importo' | 'titolo' | 'posti' | 'mesi' } | { tipo: 'risposta'; corpo: unknown };
type EsitoUi = { area: string; tipo: 'ok'; testo: string } | { area: string; tipo: 'errore'; errore: ErroreUi };

type Risposta = { stato: number; corpo: unknown };

type RigaQuota = { voce: VoceQuota; fascia: string | null; importo: number | null; scadenza: string | null };
type RigaModulo = { lista: Lista; codice: string; titolo: string; ordine: number };
type RigaRetta = { voce: string; fascia: string | null; payment_category_id: string | null; importo: number | null; mesi: number[] | null };
type LetturaRette = { rette: RigaRetta[]; mesiEffettivi: number[]; fasceInUso: string[] };
type RigaPosti = { fascia: string; posti: number; fonte: string | null };
type RigaClasse = { id: string; name: string; school_type: string; fascia: string | null };

const FASCE = ['nido_1', 'nido_2', 'primavera', 'infanzia', 'primaria', 'spazio_bambini'] as const;
type Fascia = (typeof FASCE)[number];
const TUTTE = '';

/** '2027-02-15' → '15/2/2027'. Stringa su stringa: nessun fuso, nessuna `Date`. */
function dataBreve(ymd: string): string {
  const [a, m, g] = ymd.split('-').map(Number);
  return `${g}/${m}/${a}`;
}

/** Una chiamata alle route dell'anno. Non lancia mai: una rete caduta è `stato: 0`, e ogni esito non riuscito si registra (fisso, senza dati). */
async function chiama(metodo: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE', url: string, userId: string, corpo?: Record<string, unknown>): Promise<Risposta> {
  const operazione = `admin/anni/configurazione:${metodo}`;
  try {
    const res = await fetch(url, {
      method: metodo,
      headers: corpo ? { 'Content-Type': 'application/json', 'x-user-id': userId } : { 'x-user-id': userId },
      ...(corpo ? { body: JSON.stringify(corpo) } : {}),
    });
    const letto: unknown = await res.json().catch(() => null);
    if (!res.ok) logClient({ livello: 'warn', evento: 'fetch', messaggio: `${operazione} — richiesta non riuscita`, stato: res.status });
    return { stato: res.status, corpo: letto };
  } catch (err: unknown) {
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `${operazione} — ${nomeErrore(err)}` });
    return { stato: 0, corpo: null };
  }
}

const riuscita = (r: Risposta) => r.stato >= 200 && r.stato < 300;
const erroreDa = (r: Risposta): ErroreUi => (r.stato === 0 ? { tipo: 'rete' } : r.stato === 403 ? { tipo: 'permesso' } : { tipo: 'risposta', corpo: r.corpo });
const dataDi = (r: Risposta): Record<string, unknown> | null => {
  const d = (r.corpo as { data?: unknown } | null)?.data;
  return d !== null && typeof d === 'object' && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
};

/** '120,50' o '120.5' → 120.5. Vuoto, testo o zero → `null` (la schermata lo rifiuta prima di chiamare il server). */
function importoDa(testo: string): number | null {
  const pulito = testo.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(pulito)) return null;
  const n = Number(pulito);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Il codice stabile di un modulo, dal titolo: minuscole, cifre e trattini bassi (fino a 60). Mai vuoto. */
function codiceDaTitolo(titolo: string, presenti: string[]): string {
  const base =
    titolo
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 54) || 'modulo';
  let codice = base;
  for (let n = 2; presenti.includes(codice); n += 1) codice = `${base}_${n}`;
  return codice;
}

type Lettura<T> = { fase: 'carico' } | { fase: 'ok'; dati: T } | { fase: 'errore'; errore: ErroreUi };

/**
 * Legge un elenco dalla route. Si rilegge quando cambia `versione` (dopo ogni scrittura riuscita). Una risposta che non ha
 * la forma attesa è un errore di lettura, non un elenco vuoto: una lista vuota inventata farebbe credere che manchi tutto.
 */
function useLettura<T>(url: string, userId: string, versione: number, estrai: (d: Record<string, unknown>) => T | null): Lettura<T> {
  const [stato, setStato] = useState<{ chiave: string; lettura: Lettura<T> } | null>(null);
  const chiave = `${url}#${versione}`;
  // `estrai` è una funzione dichiarata fuori dal componente: stabile fra un render e l'altro.
  useEffect(() => {
    let active = true;
    chiama('GET', url, userId).then((r) => {
      if (!active) return;
      if (!riuscita(r)) return setStato({ chiave, lettura: { fase: 'errore', errore: erroreDa(r) } });
      const d = dataDi(r);
      const dati = d ? estrai(d) : null;
      setStato({ chiave, lettura: dati ? { fase: 'ok', dati } : { fase: 'errore', errore: { tipo: 'risposta', corpo: null } } });
    });
    return () => {
      active = false;
    };
  }, [url, userId, chiave, estrai]);
  if (stato && stato.chiave === chiave) return stato.lettura;
  // Mentre si rilegge dopo un salvataggio resta in vista l'elenco di prima: se sparisse, le bozze degli altri blocchi andrebbero perse.
  if (stato && stato.lettura.fase === 'ok') return stato.lettura;
  return { fase: 'carico' };
}

const estraiQuote = (d: Record<string, unknown>) =>
  Array.isArray(d.quote) ? { quote: d.quote as RigaQuota[] } : null;
const estraiRette = (d: Record<string, unknown>): LetturaRette | null => {
  const mesi = (d.mesi_effettivi as { retta?: unknown } | null | undefined)?.retta;
  return Array.isArray(d.rette) && Array.isArray(mesi) && Array.isArray(d.fasce_in_uso)
    ? { rette: (d.rette as RigaRetta[]).filter((r) => r.voce === 'retta'), mesiEffettivi: mesi as number[], fasceInUso: d.fasce_in_uso as string[] }
    : null;
};
const estraiModuli = (d: Record<string, unknown>) => (Array.isArray(d.moduli) ? (d.moduli as RigaModulo[]) : null);
const estraiPosti = (d: Record<string, unknown>) => (Array.isArray(d.posti) ? (d.posti as RigaPosti[]) : null);
const estraiClassi = (d: Record<string, unknown>) => (Array.isArray(d.sezioni) ? (d.sezioni as RigaClasse[]) : null);

export function AnnoConfigurazione({
  userId,
  annoSedeId,
  stato,
  onCambiata,
}: {
  userId: string;
  annoSedeId: string;
  stato: 'in_preparazione' | 'iscrizioni_aperte';
  /** Qualcosa è cambiato nel database: chi sta sopra rilegge «che cosa manca» per aprire le iscrizioni. */
  onCambiata: () => void;
}) {
  const t = useTranslations('annoListino');
  const base = `/api/admin/anni/${annoSedeId}`;
  const [scheda, setScheda] = useState<Scheda>('quote');
  const [versione, setVersione] = useState(0);
  const [inCorso, setInCorso] = useState<string | null>(null);
  const [esito, setEsito] = useState<EsitoUi | null>(null);

  // `vivo`: se si cambia anno con una scrittura in volo, il pannello smontato non riceve più stato.
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  /**
   * Una scrittura: segna «in corso» su un'area, chiama, mostra l'esito sotto quell'area, rilegge l'elenco e avvisa chi sta sopra.
   * Restituisce `true` se il server ha detto di sì (chi chiama svuota allora il proprio modulo).
   */
  const scrivi = useCallback(
    async (area: string, metodo: 'PUT' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo: Record<string, unknown> | undefined, testo: (dati: Record<string, unknown> | null) => string) => {
      setInCorso(area);
      setEsito(null);
      const r = await chiama(metodo, url, userId, metodo === 'PUT' || metodo === 'PATCH' ? corpo : undefined);
      const ok = riuscita(r);
      // Il database è già cambiato: si rilegge anche se il pannello è stato smontato in volo.
      if (ok) onCambiata();
      if (!vivo.current) return false;
      setInCorso(null);
      if (!ok) {
        setEsito({ area, tipo: 'errore', errore: erroreDa(r) });
        return false;
      }
      setVersione((v) => v + 1);
      setEsito({ area, tipo: 'ok', testo: testo(dataDi(r)) });
      return true;
    },
    [userId, onCambiata],
  );

  const fasciaNome = (f: string | null): string => {
    switch (f) {
      case 'nido_1': return t('fasciaNido1');
      case 'nido_2': return t('fasciaNido2');
      case 'primavera': return t('fasciaPrimavera');
      case 'infanzia': return t('fasciaInfanzia');
      case 'primaria': return t('fasciaPrimaria');
      case 'spazio_bambini': return t('fasciaSpazioBambini');
      default: return t('fasciaTutte');
    }
  };

  const testoErrore = (e: ErroreUi): string => {
    if (e.tipo === 'rete') return t('erroreRete');
    if (e.tipo === 'permesso') return t('errorePermesso');
    if (e.tipo === 'campo') return e.chiave === 'importo' ? t('importoNonValido') : e.chiave === 'titolo' ? t('moduloTitoloVuoto') : e.chiave === 'mesi' ? t('retteMesiVuoti') : t('postiNonValidi');
    return messaggioDaCorpo(e.corpo, t('erroreGenerico'));
  };

  const esitoDi = (area: string) => {
    if (!esito || esito.area !== area) return null;
    if (esito.tipo === 'errore') {
      return (
        <p role="alert" className="mt-2 font-maven text-sm text-kidville-error">
          {testoErrore(esito.errore)}
        </p>
      );
    }
    return (
      <p role="status" className="mt-2 font-maven text-sm text-kidville-success">
        {esito.testo}
      </p>
    );
  };

  const scegli = (id: string) => {
    setEsito(null);
    setScheda(id as Scheda);
  };

  const comuni = { userId, base, versione, inCorso, scrivi, esitoDi, fasciaNome, setEsito };

  return (
    <fieldset className="mt-5 border-t border-kidville-line pt-4">
      <legend className={sottoTitolo}>{t('configurazioneTitolo')}</legend>
      <p className="font-maven text-sm text-kidville-sub">{t('introConfigurazione')}</p>
      {stato === 'iscrizioni_aperte' && <p className={hint}>{t('dopoApertura')}</p>}
      <Tabs
        className="mt-4"
        value={scheda}
        onChange={scegli}
        options={[
          { id: 'quote', label: t('schedaQuote') },
          { id: 'rette', label: t('schedaRette') },
          { id: 'moduli', label: t('schedaModuli') },
          { id: 'posti', label: t('schedaPosti') },
        ]}
      />
      {scheda === 'quote' && <SchedaQuote {...comuni} />}
      {scheda === 'rette' && <SchedaRette {...comuni} />}
      {scheda === 'moduli' && <SchedaModuli {...comuni} />}
      {scheda === 'posti' && <SchedaPosti {...comuni} />}

      <BloccoClassi c={comuni} stato={stato} />
    </fieldset>
  );
}

type Comuni = {
  userId: string;
  base: string;
  versione: number;
  inCorso: string | null;
  scrivi: (area: string, metodo: 'PUT' | 'POST' | 'PATCH' | 'DELETE', url: string, corpo: Record<string, unknown> | undefined, testo: (dati: Record<string, unknown> | null) => string) => Promise<boolean>;
  esitoDi: (area: string) => React.ReactNode;
  fasciaNome: (f: string | null) => string;
  setEsito: (e: EsitoUi | null) => void;
};

/** L'elenco di una scheda mentre arriva, o l'errore di lettura. */
function StatoLettura({ lettura, testoErrore }: { lettura: { fase: 'carico' } | { fase: 'errore'; errore: ErroreUi }; testoErrore: (e: ErroreUi) => string }) {
  const t = useTranslations('annoListino');
  if (lettura.fase === 'carico') return <p className="font-maven text-sm text-kidville-sub">{t('caricamento')}</p>;
  return (
    <p role="alert" className="font-maven text-sm text-kidville-error">
      {testoErrore(lettura.errore)}
    </p>
  );
}

const sottoTitolo = 'font-barlow text-sm font-extrabold uppercase tracking-wide text-kidville-green';
const rigaClasse = 'flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-kidville-line py-2 font-maven text-sm text-kidville-ink';
const btnSecondario =
  'rounded-pill px-3 py-1 font-barlow text-xs font-extrabold uppercase text-kidville-green ring-[1.5px] ring-inset ring-kidville-line hover:ring-kidville-green/50 disabled:pointer-events-none disabled:opacity-45';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Quote
// ─────────────────────────────────────────────────────────────────────────────────────────────

function SchedaQuote(c: Comuni) {
  const t = useTranslations('annoListino');
  const lettura = useLettura(`${c.base}/quote`, c.userId, c.versione, estraiQuote);
  if (lettura.fase !== 'ok') return <StatoLettura lettura={lettura} testoErrore={(e) => (e.tipo === 'rete' ? t('erroreRete') : e.tipo === 'permesso' ? t('errorePermesso') : messaggioDaCorpo(e.tipo === 'risposta' ? e.corpo : null, t('erroreLettura')))} />;
  const { quote } = lettura.dati;
  return (
    <div>
      <BloccoQuota c={c} voce="quota_conferma" titolo={t('quotaConfermaTitolo')} nota={t('quotaConfermaNota')} righe={quote.filter((q) => q.voce === 'quota_conferma')} />
      <BloccoQuota c={c} voce="quota_nuova" titolo={t('quotaNuovaTitolo')} nota={t('quotaNuovaNota')} righe={quote.filter((q) => q.voce === 'quota_nuova')} />
    </div>
  );
}

function BloccoQuota({ c, voce, titolo, nota, righe }: { c: Comuni; voce: VoceQuota; titolo: string; nota: string; righe: RigaQuota[] }) {
  const t = useTranslations('annoListino');
  const id = useId();
  const area = `quote-${voce}`;
  // Le bozze partono vuote: nessun importo, nessuna data, nessuna fascia scelta per la segreteria.
  const [fascia, setFascia] = useState<string>(TUTTE);
  const [importo, setImporto] = useState('');
  const [scadenza, setScadenza] = useState('');
  const occupato = c.inCorso !== null;

  const salva = async () => {
    const n = importoDa(importo);
    if (n === null) return c.setEsito({ area, tipo: 'errore', errore: { tipo: 'campo', chiave: 'importo' } });
    const ok = await c.scrivi(area, 'PUT', `${c.base}/quote`, { voce, fascia: fascia === TUTTE ? null : fascia, importo: n, scadenza: scadenza === '' ? null : scadenza }, (d) =>
      d?.cambiato === false ? t('nessunaModifica') : t('quotaSalvata'),
    );
    if (ok) {
      setImporto('');
      setScadenza('');
    }
  };
  const togli = (r: RigaQuota) =>
    void c.scrivi(area, 'PUT', `${c.base}/quote`, { voce, fascia: r.fascia, importo: null, scadenza: null }, () => t('quotaTolta'));
  const modifica = (r: RigaQuota) => {
    c.setEsito(null);
    setFascia(r.fascia ?? TUTTE);
    setImporto(r.importo === null ? '' : String(r.importo).replace('.', ','));
    setScadenza(r.scadenza ?? '');
  };

  return (
    <fieldset className="mt-4 border-t border-kidville-line pt-4 first:mt-0 first:border-t-0 first:pt-0">
      <legend className={sottoTitolo}>{titolo}</legend>
      <p className={hint}>{nota}</p>
      {righe.length === 0 ? (
        <p className="mt-2 font-maven text-sm text-kidville-sub">{t('quotaNessuna')}</p>
      ) : (
        <ul className="mt-2">
          {righe.map((r) => (
            <li key={`${r.fascia ?? 'tutte'}`} className={rigaClasse}>
              <strong>{c.fasciaNome(r.fascia)}</strong>
              <span>{r.importo === null ? '' : formatEuro(r.importo)}</span>
              <span>{r.scadenza ? t('quotaScade', { data: dataBreve(r.scadenza) }) : t('quotaScadenzaAutomatica')}</span>
              <button type="button" className={btnSecondario} disabled={occupato} onClick={() => modifica(r)}>
                {t('modifica')}
              </button>
              <button type="button" className={btnSecondario} disabled={occupato} onClick={() => togli(r)}>
                {t('togli')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3">
        <div>
          <label htmlFor={`${id}-fascia`} className={label}>{t('etichettaFascia')}</label>
          <select id={`${id}-fascia`} value={fascia} onChange={(e) => setFascia(e.target.value)} className={input}>
            <option value={TUTTE}>{t('fasciaTutte')}</option>
            {FASCE.map((f: Fascia) => (
              <option key={f} value={f}>{c.fasciaNome(f)}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-importo`} className={label}>{t('etichettaImporto')}</label>
          <input id={`${id}-importo`} type="text" inputMode="decimal" autoComplete="off" value={importo} onChange={(e) => setImporto(e.target.value)} className={`${input} w-32`} />
        </div>
        <div>
          <label htmlFor={`${id}-scadenza`} className={label}>{t('etichettaScadenza')}</label>
          <input id={`${id}-scadenza`} type="date" value={scadenza} onChange={(e) => setScadenza(e.target.value)} aria-describedby={`${id}-scadenza-hint`} className={input} />
        </div>
        <button type="button" onClick={() => void salva()} disabled={occupato} className={btnPrimary}>
          {c.inCorso === area ? t('salvataggioInCorso') : t('salva')}
        </button>
      </div>
      <p id={`${id}-scadenza-hint`} className={hint}>{t('scadenzaNota')}</p>
      {c.esitoDi(area)}
    </fieldset>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Rette
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** I mesi dell'anno scolastico, da settembre ad agosto: l'ordine in cui la segreteria li legge. */
const MESI_ANNO = [9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7, 8] as const;

const stessiMesi = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((m) => b.includes(m));

function SchedaRette(c: Comuni) {
  const t = useTranslations('annoListino');
  const lettura = useLettura(`${c.base}/rette`, c.userId, c.versione, estraiRette);
  if (lettura.fase !== 'ok') return <StatoLettura lettura={lettura} testoErrore={(e) => (e.tipo === 'rete' ? t('erroreRete') : e.tipo === 'permesso' ? t('errorePermesso') : messaggioDaCorpo(e.tipo === 'risposta' ? e.corpo : null, t('erroreLettura')))} />;
  return <BloccoRetta c={c} dati={lettura.dati} />;
}

function BloccoRetta({ c, dati }: { c: Comuni; dati: LetturaRette }) {
  const t = useTranslations('annoListino');
  const lingua = useLocale();
  const id = useId();
  const area = 'rette';
  const { rette, mesiEffettivi, fasceInUso } = dati;
  // La bozza parte vuota (nessun importo scelto per la segreteria); i mesi partono da quelli che valgono ora, decisi dal database.
  const [fascia, setFascia] = useState<string>(TUTTE);
  const [importo, setImporto] = useState('');
  const [mesi, setMesi] = useState<number[]>(mesiEffettivi);
  const occupato = c.inCorso !== null;
  const nomeMese = (m: number) => new Intl.DateTimeFormat(lingua, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2027, m - 1, 1)));

  const salva = async () => {
    const n = importoDa(importo);
    if (n === null) return c.setEsito({ area, tipo: 'errore', errore: { tipo: 'campo', chiave: 'importo' } });
    // I mesi si scelgono solo per la riga «Tutte le fasce», e si mandano solo se sono cambiati: lasciati com'erano restano «come sempre».
    const perTutte = fascia === TUTTE;
    if (perTutte && mesi.length === 0) return c.setEsito({ area, tipo: 'errore', errore: { tipo: 'campo', chiave: 'mesi' } });
    const mandaMesi = perTutte && !stessiMesi(mesi, mesiEffettivi);
    const corpo = { voce: 'retta', fascia: perTutte ? null : fascia, importo: n, ...(mandaMesi ? { mesi: [...mesi].sort((a, b) => a - b) } : {}) };
    const ok = await c.scrivi(area, 'PUT', `${c.base}/rette`, corpo, (d) => (d?.cambiato === false ? t('nessunaModifica') : t('retteSalvata')));
    if (ok) setImporto('');
  };
  const togli = (r: RigaRetta) => void c.scrivi(area, 'PUT', `${c.base}/rette`, { voce: 'retta', fascia: r.fascia, importo: null }, () => t('retteTolta'));
  const modifica = (r: RigaRetta) => {
    c.setEsito(null);
    setFascia(r.fascia ?? TUTTE);
    setImporto(r.importo === null ? '' : String(r.importo).replace('.', ','));
  };
  const scegliMese = (m: number, acceso: boolean) => setMesi((prima) => (acceso ? [...prima, m] : prima.filter((x) => x !== m)));
  // Un 150,00 è quasi sempre l'importo copiato dal listino precedente: una nota neutra, mai un blocco.
  const copiata = rette.some((r) => r.importo === 150);

  return (
    <fieldset className="mt-4 first:mt-0">
      <legend className={sottoTitolo}>{t('retteTitolo')}</legend>
      <p className={hint}>{t('retteNota')}</p>
      {fasceInUso.length === 0 && <p className={hint}>{t('retteSenzaFasce')}</p>}
      {copiata && <p className={hint}>{t('retteCopiata')}</p>}
      {rette.length === 0 ? (
        <p className="mt-2 font-maven text-sm text-kidville-sub">{t('retteNessuna')}</p>
      ) : (
        <ul className="mt-2">
          {rette.map((r) => (
            <li key={r.fascia ?? 'tutte'} className={rigaClasse}>
              <strong>{c.fasciaNome(r.fascia)}</strong>
              <span>{r.importo === null ? '' : formatEuro(r.importo)}</span>
              <button type="button" className={btnSecondario} disabled={occupato} onClick={() => modifica(r)}>
                {t('modifica')}
              </button>
              <button type="button" className={btnSecondario} disabled={occupato} onClick={() => togli(r)}>
                {t('togli')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3">
        <div>
          <label htmlFor={`${id}-fascia`} className={label}>{t('etichettaFascia')}</label>
          <select id={`${id}-fascia`} value={fascia} onChange={(e) => setFascia(e.target.value)} className={input}>
            <option value={TUTTE}>{t('fasciaTutte')}</option>
            {FASCE.map((f: Fascia) => (
              <option key={f} value={f}>{c.fasciaNome(f)}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-importo`} className={label}>{t('etichettaImporto')}</label>
          <input id={`${id}-importo`} type="text" inputMode="decimal" autoComplete="off" value={importo} onChange={(e) => setImporto(e.target.value)} className={`${input} w-32`} />
        </div>
        <button type="button" onClick={() => void salva()} disabled={occupato} className={btnPrimary}>
          {c.inCorso === area ? t('salvataggioInCorso') : t('salva')}
        </button>
      </div>
      {fascia === TUTTE && (
        <fieldset className="mt-4">
          <legend className={label}>{t('retteMesiTitolo')}</legend>
          <p className={hint}>{t('retteMesiNota')}</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {MESI_ANNO.map((m) => (
              <label key={m} className="flex items-center gap-1.5 font-maven text-sm text-kidville-ink">
                <input type="checkbox" checked={mesi.includes(m)} onChange={(e) => scegliMese(m, e.target.checked)} />
                {nomeMese(m)}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {c.esitoDi(area)}
    </fieldset>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Moduli
// ─────────────────────────────────────────────────────────────────────────────────────────────

function SchedaModuli(c: Comuni) {
  const t = useTranslations('annoListino');
  const lettura = useLettura(`${c.base}/moduli`, c.userId, c.versione, estraiModuli);
  if (lettura.fase !== 'ok') return <StatoLettura lettura={lettura} testoErrore={(e) => (e.tipo === 'rete' ? t('erroreRete') : e.tipo === 'permesso' ? t('errorePermesso') : messaggioDaCorpo(e.tipo === 'risposta' ? e.corpo : null, t('erroreLettura')))} />;
  return (
    <div>
      <BloccoModuli c={c} lista="conferma" titolo={t('moduliConfermaTitolo')} righe={lettura.dati.filter((m) => m.lista === 'conferma')} />
      <BloccoModuli c={c} lista="nuova" titolo={t('moduliNuovaTitolo')} righe={lettura.dati.filter((m) => m.lista === 'nuova')} />
    </div>
  );
}

function BloccoModuli({ c, lista, titolo, righe }: { c: Comuni; lista: Lista; titolo: string; righe: RigaModulo[] }) {
  const t = useTranslations('annoListino');
  const id = useId();
  const area = `moduli-${lista}`;
  const [testo, setTesto] = useState('');
  // Il modulo di cui si sta cambiando il titolo: il suo codice non cambia mai.
  const [inModifica, setInModifica] = useState<string | null>(null);
  const occupato = c.inCorso !== null;

  const salva = async () => {
    const pulito = testo.trim();
    if (pulito === '' || pulito.length > 120) return c.setEsito({ area, tipo: 'errore', errore: { tipo: 'campo', chiave: 'titolo' } });
    const codice = inModifica ?? codiceDaTitolo(pulito, righe.map((m) => m.codice));
    const corpo: Record<string, unknown> = { lista, codice, titolo: pulito };
    // Un modulo nuovo va in fondo; uno già presente tiene il suo posto (senza `ordine` il database non lo tocca).
    if (inModifica === null) corpo.ordine = righe.reduce((massimo, m) => Math.max(massimo, m.ordine), 0) + 1;
    const ok = await c.scrivi(area, 'PUT', `${c.base}/moduli`, corpo, (d) => (d?.cambiato === false ? t('nessunaModifica') : t('moduloSalvato')));
    if (ok) {
      setTesto('');
      setInModifica(null);
    }
  };
  const togli = (m: RigaModulo) => {
    const query = new URLSearchParams({ lista: m.lista, codice: m.codice }).toString();
    void c.scrivi(area, 'DELETE', `${c.base}/moduli?${query}`, undefined, () => t('moduloTolto'));
  };

  return (
    <fieldset className="mt-4 border-t border-kidville-line pt-4 first:mt-0 first:border-t-0 first:pt-0">
      <legend className={sottoTitolo}>{titolo}</legend>
      {righe.length === 0 ? (
        <p className="mt-2 font-maven text-sm text-kidville-sub">{t('moduliNessuno')}</p>
      ) : (
        <ol className="mt-2">
          {righe.map((m) => (
            <li key={m.codice} className={rigaClasse}>
              <span className="min-w-0 flex-1 break-words">{m.titolo}</span>
              <button
                type="button"
                className={btnSecondario}
                disabled={occupato}
                onClick={() => {
                  c.setEsito(null);
                  setInModifica(m.codice);
                  setTesto(m.titolo);
                }}
              >
                {t('moduloCambiaTitolo')}
              </button>
              <button type="button" className={btnSecondario} disabled={occupato} onClick={() => togli(m)}>
                {t('togli')}
              </button>
            </li>
          ))}
        </ol>
      )}
      {righe.length > 0 && <p className={hint}>{t('moduloToglierePerde')}</p>}
      <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <label htmlFor={`${id}-titolo`} className={label}>{t('moduloTitoloEtichetta')}</label>
          <input id={`${id}-titolo`} type="text" maxLength={120} value={testo} onChange={(e) => setTesto(e.target.value)} className={`${input} w-full`} />
        </div>
        <button type="button" onClick={() => void salva()} disabled={occupato} className={btnPrimary}>
          {c.inCorso === area ? t('salvataggioInCorso') : inModifica === null ? t('moduloAggiungi') : t('salva')}
        </button>
        {inModifica !== null && (
          <button
            type="button"
            className={btnSecondario}
            onClick={() => {
              setInModifica(null);
              setTesto('');
              c.setEsito(null);
            }}
          >
            {t('annulla')}
          </button>
        )}
      </div>
      {c.esitoDi(area)}
    </fieldset>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Posti
// ─────────────────────────────────────────────────────────────────────────────────────────────

function SchedaPosti(c: Comuni) {
  const t = useTranslations('annoListino');
  const lettura = useLettura(`${c.base}/posti`, c.userId, c.versione, estraiPosti);
  if (lettura.fase !== 'ok') return <StatoLettura lettura={lettura} testoErrore={(e) => (e.tipo === 'rete' ? t('erroreRete') : e.tipo === 'permesso' ? t('errorePermesso') : messaggioDaCorpo(e.tipo === 'risposta' ? e.corpo : null, t('erroreLettura')))} />;
  return (
    <div>
      <p className="font-maven text-sm text-kidville-sub">{t('postiIntro')}</p>
      {FASCE.map((f) => (
        <RigaFascia key={f} c={c} fascia={f} attuale={lettura.dati.find((p) => p.fascia === f) ?? null} />
      ))}
    </div>
  );
}

function RigaFascia({ c, fascia, attuale }: { c: Comuni; fascia: Fascia; attuale: RigaPosti | null }) {
  const t = useTranslations('annoListino');
  const id = useId();
  const area = `posti-${fascia}`;
  // Parte da ciò che il database ha già; una fascia senza riga parte vuota.
  const [posti, setPosti] = useState(attuale ? String(attuale.posti) : '');
  const [fonte, setFonte] = useState(attuale?.fonte ?? '');
  const occupato = c.inCorso !== null;

  const salva = () => {
    if (!/^\d{1,6}$/.test(posti.trim())) return c.setEsito({ area, tipo: 'errore', errore: { tipo: 'campo', chiave: 'posti' } });
    void c.scrivi(area, 'PUT', `${c.base}/posti`, { fascia, posti: Number(posti.trim()), fonte: fonte.trim() === '' ? null : fonte.trim() }, (d) =>
      d?.cambiato === false ? t('nessunaModifica') : t('postiSalvati'),
    );
  };
  const togli = () => void c.scrivi(area, 'PUT', `${c.base}/posti`, { fascia, posti: null }, () => t('postiTolti'));

  return (
    <fieldset className="mt-4 border-t border-kidville-line pt-4">
      <legend className={sottoTitolo}>{c.fasciaNome(fascia)}</legend>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div>
          <label htmlFor={`${id}-posti`} className={label}>{t('postiEtichetta')}</label>
          <input id={`${id}-posti`} type="text" inputMode="numeric" autoComplete="off" value={posti} onChange={(e) => setPosti(e.target.value)} className={`${input} w-24`} />
        </div>
        <div className="min-w-0 flex-1">
          <label htmlFor={`${id}-fonte`} className={label}>{t('postiFonteEtichetta')}</label>
          <input id={`${id}-fonte`} type="text" maxLength={200} value={fonte} onChange={(e) => setFonte(e.target.value)} className={`${input} w-full`} />
        </div>
        <button type="button" onClick={salva} disabled={occupato} className={btnPrimary}>
          {c.inCorso === area ? t('salvataggioInCorso') : t('salva')}
        </button>
        {attuale && (
          <button type="button" className={btnSecondario} disabled={occupato} onClick={togli}>
            {t('togli')}
          </button>
        )}
      </div>
      {c.esitoDi(area)}
    </fieldset>
  );
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Classi
// ─────────────────────────────────────────────────────────────────────────────────────────────

function BloccoClassi({ c, stato }: { c: Comuni; stato: 'in_preparazione' | 'iscrizioni_aperte' }) {
  const t = useTranslations('annoListino');
  const area = 'classi';
  const areaFascia = 'classi-fascia';
  const lettura = useLettura(`${c.base}/sezioni`, c.userId, c.versione, estraiClassi);
  const copia = () =>
    void c.scrivi(area, 'POST', `${c.base}/sezioni`, undefined, (d) =>
      t('classiEsito', { copiate: typeof d?.copiate === 'number' ? d.copiate : 0, presenti: typeof d?.gia_presenti === 'number' ? d.gia_presenti : 0 }),
    );
  const scegli = (classe: RigaClasse, valore: string) =>
    void c.scrivi(areaFascia, 'PATCH', `${c.base}/sezioni`, { section_id: classe.id, fascia: valore === TUTTE ? null : valore }, () => t('classiFasciaSalvata'));
  const senzaFascia = lettura.fase === 'ok' ? lettura.dati.filter((x) => x.fascia === null).length : 0;
  return (
    <fieldset className="mt-5 border-t border-kidville-line pt-4">
      <legend className={sottoTitolo}>{t('classiTitolo')}</legend>
      <p className="font-maven text-sm text-kidville-sub">{stato === 'in_preparazione' ? t('classiNotaPreparazione') : t('classiNotaAperte')}</p>
      <div className="mt-3">
        <button type="button" onClick={copia} disabled={c.inCorso !== null} className={btnPrimary}>
          {c.inCorso === area ? t('salvataggioInCorso') : t('classiCopia')}
        </button>
      </div>
      {c.esitoDi(area)}

      <div className="mt-4">
        <p className={hint}>{t('classiFasciaIntro')}</p>
        {lettura.fase !== 'ok' ? (
          <StatoLettura lettura={lettura} testoErrore={(e) => (e.tipo === 'rete' ? t('erroreRete') : e.tipo === 'permesso' ? t('errorePermesso') : messaggioDaCorpo(e.tipo === 'risposta' ? e.corpo : null, t('erroreLettura')))} />
        ) : lettura.dati.length === 0 ? (
          <p className="mt-2 font-maven text-sm text-kidville-sub">{t('classiElencoVuoto')}</p>
        ) : (
          <>
            <p role="status" className={`mt-2 font-maven text-sm ${senzaFascia > 0 ? 'text-kidville-error' : 'text-kidville-success'}`}>
              {senzaFascia > 0 ? t('classiSenzaFascia', { n: senzaFascia }) : t('classiTutteConFascia')}
            </p>
            <ul className="mt-2">
              {lettura.dati.map((classe) => (
                <ClasseFascia key={classe.id} classe={classe} c={c} onScegli={scegli} />
              ))}
            </ul>
            {c.esitoDi(areaFascia)}
          </>
        )}
      </div>
    </fieldset>
  );
}

function ClasseFascia({ classe, c, onScegli }: { classe: RigaClasse; c: Comuni; onScegli: (classe: RigaClasse, valore: string) => void }) {
  const t = useTranslations('annoListino');
  const id = useId();
  return (
    <li className={rigaClasse}>
      <strong className="min-w-0 flex-1 break-words">{classe.name}</strong>
      <label htmlFor={`${id}-fascia`} className="sr-only">{t('classiFasciaEtichetta', { classe: classe.name })}</label>
      <select id={`${id}-fascia`} value={classe.fascia ?? TUTTE} disabled={c.inCorso !== null} onChange={(e) => onScegli(classe, e.target.value)} className={input}>
        <option value={TUTTE}>{t('classiFasciaNessuna')}</option>
        {FASCE.map((f: Fascia) => (
          <option key={f} value={f}>{c.fasciaNome(f)}</option>
        ))}
      </select>
    </li>
  );
}
