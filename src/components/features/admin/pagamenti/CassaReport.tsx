'use client';

// ─── Report di cassa (solo admin) ─────────────────────────────────────────────
// Entrate aggregate per CATEGORIA DI PAGAMENTO (con breakdown per metodo, tutti i
// metodi, storni netti) e uscite per categoria di cassa, filtrabili per periodo.
// Selezionando una categoria di pagamento con «Intero importo, tutti i mesi» il
// totale è cross-mese per intero (es. quota «Saggio» in 3 acconti su 3 mesi).
// Export CSV via link diretto (?format=csv, con userId per l'auth del GET).
// Solo token `kidville-*`; importi con formatEuro.
//
// Multi-sede (P4a, contratti K3 §4 e K2 §1). `scuolaId` è null quando le sedi
// selezionate sono più d'una: allora NESSUNA GET porta `scuola_id` (mai
// `scuola_id=null` nell'URL) e il server legge tutte le sedi attive. In cima restano
// gli aggregati di tutte le sedi lette (e il CSV, che il server scrive su quelli),
// sotto il conto di ciascuna sede (`per_sede`): ogni sede è un cassetto a sé.
// Le categorie di pagamento arrivano da tutte le sedi: due «Gita» omonime di sedi
// diverse sono due voci con `id` diversi, e il filtro deve prendere quella giusta.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BarChart3, Download, Printer, X } from 'lucide-react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { formatEuro } from '@/lib/format/valuta';
import { cx } from '@/lib/ui/cx';
import { StatCard, TABLE_WRAP, TABLE, TH, TD, TROW } from '@/components/ui/cockpit';
import { Modal } from '@/components/ui/Modal';
import { hdr, card, h3, input, label } from '../settings/ui';
import { BTN_SECONDARY, MODAL_CARD_QUASI_SCHERMO, MODAL_SHADOW } from './ui';
import { CassaDettaglio } from './CassaDettaglio';
import { CassaStampaModal } from './CassaStampaModal';
import { LinkDocumento } from './LinkDocumento';
import { FiltriSedeMensilitaCassa, useFiltriCassa } from './FiltriSedeMensilitaCassa';
import { metodoLabel, meseItaliano } from '@/lib/cassa/tipi';
import type { SedeCassa } from './CassaSede';

interface Props {
  userId: string;
  /** La sede della pagina, o null quando le sedi selezionate sono più d'una. */
  scuolaId: string | null;
  /** Le sedi del cockpit: servono solo a dare un nome a una sede che il server non ha nominato. */
  sedi?: readonly SedeCassa[];
}

interface EntrataCat {
  categoria_id: string | null;
  categoria_nome: string | null;
  totale: number;
  per_metodo?: Record<string, number>;
}
interface UscitaCat {
  categoria_id: string | null;
  categoria_nome: string | null;
  totale: number;
  contanti?: number;
}
interface MeseRiga {
  mese: string;
  entrate?: number;
  uscite?: number;
}
interface ReportDiSede {
  scuola_id: string;
  scuola_nome: string | null;
  entrate_per_categoria?: EntrataCat[];
  uscite_per_categoria?: UscitaCat[];
  mensile?: MeseRiga[];
}
interface ReportData {
  disponibile: boolean;
  entrate_per_categoria?: EntrataCat[];
  uscite_per_categoria?: UscitaCat[];
  mensile?: MeseRiga[];
  per_sede?: ReportDiSede[];
}
interface CategoriaPag { id: string; nome: string; slug?: string; scuola_id?: string | null }
type ApriCategoria = (tipo: 'entrata' | 'uscita', categoria: { categoria_id: string | null; categoria_nome: string | null }, scuolaId: string | null, bottone: HTMLButtonElement) => void;

const NESSUNA_SEDE: readonly SedeCassa[] = [];
/** Id dell'avviso «categorie non lette», a cui il filtro rimanda con `aria-describedby`. */
const CATEGORIE_NON_LETTE_ID = 'report-cat-non-lette';

const somma = (righe: { totale: number }[] | undefined) => (righe ?? []).reduce((s, r) => s + (Number(r.totale) || 0), 0);

/**
 * Le categorie del filtro sono distinte per UUID, anche quando una categoria
 * globale e una locale condividono lo slug. I pagamenti storici possono usare
 * entrambe: rimuoverne una dal filtro renderebbe irraggiungibili i suoi incassi.
 */
export function categorieDelFiltro(dati: readonly CategoriaPag[]): CategoriaPag[] {
  const perChiave = new Map<string, CategoriaPag>();
  for (const c of dati) {
    perChiave.set(c.id, c);
  }
  return [...perChiave.values()];
}

export function CassaReport({ userId, scuolaId: sedePagina, sedi = NESSUNA_SEDE }: Props) {
  const t = useTranslations('adminContabilita');
  const { scuolaId, scegliSede, mensilita, scegliMensilita, da, a, setDa, setA } = useFiltriCassa(sedePagina, sedi);
  const piuSedi = scuolaId == null;
  /** Il nome di una sede: quello del server, poi quello del selettore, poi l'uuid. */
  const nomeSede = (id: string, dalServer?: string | null) => dalServer?.trim() || sedi.find((s) => s.id === id)?.nome.trim() || id;
  // Con più sedi la query NON porta `scuola_id`: la route legge le sedi attive (K3).
  const sedeQ = scuolaId ? `&scuola_id=${encodeURIComponent(scuolaId)}` : '';
  const [categoriaPag, setCategoriaPag] = useState('');
  const [intero, setIntero] = useState(false);
  const [rispostaCategorie, setRispostaCategorie] = useState<{ sedeQ: string; righe: CategoriaPag[] } | null>(null);
  const categoriePag = rispostaCategorie?.sedeQ === sedeQ ? rispostaCategorie.righe : [];
  // Categorie NON lette (GET rifiutata, rete caduta, corpo senza `success`) ≠ «nessuna
  // categoria»: il filtro resta con il solo «Tutte», e la pagina dice perché.
  const [categorieNonLette, setCategorieNonLette] = useState(false);
  const [risposta, setRisposta] = useState<{ filtro: object; dati?: ReportData; stato?: number } | null>(null);
  const [dettaglio, setDettaglio] = useState<{ filtro: object; tipo: 'entrata' | 'uscita'; categoriaId: string | null; nome: string; scuolaId: string | null } | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const triggerStampa = useRef<HTMLButtonElement | null>(null);
  const [stampa, setStampa] = useState<{ filtro: object } | null>(null);

  // Categorie di PAGAMENTO (per il filtro entrate cross-mese).
  useEffect(() => {
    let active = true;
    // Senza `scuola_id` la GET risponde con le categorie di TUTTE le sedi attive (K2).
    fetch(`/api/admin/settings/categorie?userId=${userId}${sedeQ}`, { headers: hdr(userId) })
      .then(async (r) => {
        const d = r.ok ? ((await r.json()) as { success?: boolean; data?: CategoriaPag[] }) : null;
        if (!r.ok || d?.success !== true) {
          // Un 403/500 (o un corpo senza `success`) non è «nessuna categoria».
          logClient({ livello: 'error', evento: 'fetch', messaggio: 'cassa-report-categorie-lettura-rifiutata', route: '/admin/pagamenti', stato: r.status });
          if (active) { setRispostaCategorie({ sedeQ, righe: [] }); setCategorieNonLette(true); }
          return;
        }
        if (!active) return;
        setRispostaCategorie({ sedeQ, righe: categorieDelFiltro(d.data ?? []) });
        setCategorieNonLette(false);
      })
      .catch((err) => {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-report-categorie-caricamento-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
        if (active) { setRispostaCategorie({ sedeQ, righe: [] }); setCategorieNonLette(true); }
      });
    return () => { active = false; };
  }, [userId, sedeQ]);

  // Query dei filtri correnti (intero azzera il periodo → totale cross-mese).
  const querystring = useCallback((formatCsv = false) => {
    const p = new URLSearchParams();
    p.set('userId', userId);
    if (scuolaId) p.set('scuola_id', scuolaId);
    if (!intero && da) p.set('da', da);
    if (!intero && a) p.set('a', a);
    if (categoriaPag) p.set('categoria_pagamento_id', categoriaPag);
    if (formatCsv) p.set('format', 'csv');
    return p.toString();
  }, [userId, scuolaId, da, a, categoriaPag, intero]);
  const query = querystring();
  // Ogni cambio di query ha una nuova identità, anche A→B→A: il vecchio risultato A
  // non può ricomparire mentre la nuova lettura di A è ancora in corso.
  const filtro = useMemo(() => ({ query }), [query]);
  const corrente = risposta?.filtro === filtro ? risposta : null;
  const dati = corrente?.dati ?? null;
  const errore = corrente?.stato != null;
  const periodoInvalido = !intero && !!(da && a && da > a);

  useEffect(() => {
    let active = true;
    if (periodoInvalido) return;
    // setState solo DENTRO l'IIFE async (dopo l'await): niente setState sincrono
    // nel corpo dell'effetto (react-hooks/set-state-in-effect).
    (async () => {
      try {
        const r = await fetch(`/api/pagamenti/cassa/report?${filtro.query}`, { headers: hdr(userId) });
        if (!r.ok) {
          // 403 `SEDE_NON_ACCESSIBILE` o 500: prima diventava un report vuoto, cioè
          // «nessuna entrata nel periodo», che è un'altra cosa.
          logClient({ livello: 'error', evento: 'fetch', messaggio: 'cassa-report-lettura-rifiutata', route: '/admin/pagamenti', stato: r.status });
          if (active) setRisposta({ filtro, stato: r.status });
          return;
        }
        const d = (await r.json()) as ReportData;
        if (active) setRisposta({ filtro, dati: d });
      } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-report-caricamento-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
        if (active) setRisposta({ filtro, stato: 0 });
      }
    })();
    return () => { active = false; };
  }, [filtro, userId, periodoInvalido]);

  const csvHref = useMemo(() => `/api/pagamenti/cassa/report?${querystring(true)}`, [querystring]);

  const disponibile = dati?.disponibile !== false;
  const entrate = dati?.entrate_per_categoria ?? [];
  const uscite = dati?.uscite_per_categoria ?? [];
  const mensile = dati?.mensile ?? [];
  // Il dettaglio per sede ha senso solo quando le sedi lette sono più d'una.
  const perSede = piuSedi ? (dati?.per_sede ?? []) : [];
  /** Con più sedi una categoria di sede porta il nome della sede (le globali no). */
  const etichettaCategoria = (c: CategoriaPag) => {
    const omonima = categoriePag.some((altra) => altra.id !== c.id && altra.nome === c.nome);
    if (c.scuola_id && (piuSedi || omonima)) return t('cassaMsRepCategoriaDiSede', { categoria: c.nome, nome: nomeSede(c.scuola_id) });
    return omonima ? t('cassaRepCategoriaGlobale', { categoria: c.nome }) : c.nome;
  };
  const apri: ApriCategoria = (tipo, r, sede, bottone) => {
    trigger.current = bottone;
    setDettaglio({ filtro, tipo, categoriaId: r.categoria_id, nome: r.categoria_nome ?? t('cassaRepSenzaCategoria'), scuolaId: sede });
  };

  return (
    <section className={card}>
      <h3 className={h3}><BarChart3 size={16} /> {t('cassaRepTitolo')}</h3>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <FiltriSedeMensilitaCassa prefisso="report" sedi={sedi} scuolaId={scuolaId} onSede={(id) => { scegliSede(id); setCategoriaPag(''); setIntero(false); }} mensilita={mensilita} onMensilita={(mese) => { scegliMensilita(mese); setIntero(false); }} disabled={intero} />
        <div>
          <label htmlFor="report-da" className={label}>{t('cassaRepDal')}</label>
          <input id="report-da" type="date" value={da} onChange={(e) => setDa(e.target.value)} disabled={intero} className={cx(input, intero && 'opacity-50')} />
        </div>
        <div>
          <label htmlFor="report-a" className={label}>{t('cassaRepAl')}</label>
          <input id="report-a" type="date" value={a} onChange={(e) => setA(e.target.value)} disabled={intero} className={cx(input, intero && 'opacity-50')} />
        </div>
        <div>
          <label htmlFor="report-cat" className={label}>{t('cassaRepCategoriaPag')}</label>
          <select
            id="report-cat"
            value={categoriaPag}
            onChange={(e) => { setCategoriaPag(e.target.value); if (!e.target.value) setIntero(false); }}
            className={cx(input, 'cursor-pointer')}
            {...(categorieNonLette ? { 'aria-describedby': CATEGORIE_NON_LETTE_ID } : {})}
          >
            <option value="">{t('cassaRepTutte')}</option>
            {categoriePag.map((c) => <option key={c.id} value={c.id}>{etichettaCategoria(c)}</option>)}
          </select>
          {categorieNonLette && (
            <p id={CATEGORIE_NON_LETTE_ID} role="alert" className="mt-1 max-w-xs font-maven text-xs text-kidville-error-strong">
              {t('cassaMsRepCategorieNonLette')}
            </p>
          )}
        </div>
        {categoriaPag && (
          <label className="flex items-center gap-2 pb-2">
            <input type="checkbox" checked={intero} onChange={(e) => setIntero(e.target.checked)} className="h-4 w-4 rounded accent-kidville-green" />
            <span className="font-maven text-xs text-kidville-green">{t('cassaRepInteroImporto')}</span>
          </label>
        )}
        {dati?.disponibile && !periodoInvalido && <button type="button" ref={triggerStampa} onClick={() => setStampa({ filtro })} className={cx(BTN_SECONDARY, 'ml-auto')}><Printer size={14} /> {t('cassaStampaTitolo')}</button>}
        {dati?.disponibile && !periodoInvalido && <LinkDocumento href={csvHref} modo="scarica" nomeFile="report-cassa.csv" mime="text/csv" etichetta="report-cassa" className={BTN_SECONDARY}><Download size={14} /> {t('cassaRepScaricaCsv')}</LinkDocumento>}
      </div>

      {periodoInvalido ? <p role="alert" className="font-maven text-sm text-kidville-error-strong">{t('cassaDetPeriodoInvalido')}</p> : dati === null && !errore ? (
        <p className="py-6 text-center font-maven text-sm text-kidville-sub">{t('cassaRepCaricamento')}</p>
      ) : errore ? (
        <p role="alert" className="font-maven text-sm text-kidville-error-strong">{t('cassaRepErrore')}</p>
      ) : !disponibile ? (
        <p className="font-maven text-sm text-kidville-sub">{t('cassaRepNonAttivo')}</p>
      ) : (
        <div className="space-y-6">
          <div data-testid="cassa-report-totali" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard label={t('cassaRepTotEntrate')} value={formatEuro(somma(entrate))} />
            <StatCard label={t('cassaRepTotUscite')} value={formatEuro(somma(uscite))} />
            <StatCard label={t(categoriaPag ? 'cassaRepDifferenzaSelezione' : 'cassaRepDifferenza')} value={formatEuro(somma(entrate) - somma(uscite))} />
          </div>
          <p className="font-maven text-sm text-kidville-sub">{t('cassaRepContanteSpiegazione')}</p>
          {categoriaPag && <p role="status" className="font-maven text-sm text-kidville-sub">{t('cassaRepFiltroSoloEntrate')}</p>}
          <TabellaEntrate righe={entrate} apri={apri} scuolaId={scuolaId} />
          <TabellaUscite righe={uscite} apri={apri} scuolaId={scuolaId} />
          {mensile.length > 0 && <TabellaMensile righe={mensile} />}
          {perSede.length > 1 && <DettaglioPerSede perSede={perSede} nomeSede={nomeSede} apri={apri} />}
        </div>
      )}
      {stampa?.filtro === filtro && !errore && !periodoInvalido && <CassaStampaModal
        userId={userId} scuolaId={scuolaId}
        nomiSedi={scuolaId ? [nomeSede(scuolaId, dati?.per_sede?.find((s) => s.scuola_id === scuolaId)?.scuola_nome)] : (dati?.per_sede ?? []).map((s) => nomeSede(s.scuola_id, s.scuola_nome))}
        da={intero ? undefined : da} a={intero ? undefined : a}
        categorie={categoriePag.map((c) => ({ id: c.id, etichetta: etichettaCategoria(c) }))}
        onClose={() => setStampa(null)} returnFocusRef={triggerStampa}
      />}
      {dettaglio && dettaglio.filtro === filtro && !errore && !periodoInvalido && <Modal open safeArea title={t('cassaRepDetTitolo', { categoria: dettaglio.nome })} onClose={() => setDettaglio(null)} returnFocusRef={trigger} className={MODAL_CARD_QUASI_SCHERMO} style={{ boxShadow: MODAL_SHADOW }}>
        <div className="flex shrink-0 items-center justify-between gap-3 px-5 pt-5"><h2 className={h3}>{t('cassaRepDetTitolo', { categoria: dettaglio.nome })}</h2><button type="button" onClick={() => setDettaglio(null)} aria-label={t('cassaDetChiudi')} className={BTN_SECONDARY}><X size={18} /></button></div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5"><CassaDettaglio userId={userId} scuolaId={dettaglio.scuolaId} tipo={dettaglio.tipo} categoriaId={dettaglio.categoriaId} da={intero ? undefined : da} a={intero ? undefined : a} /></div>
      </Modal>}
    </section>
  );
}

/**
 * Il conto di ciascuna sede: una riga di totali per sede, poi (a richiesta) le sue
 * categorie. Le somme di entrate e uscite sono quelle che il server ha già attribuito
 * alla sede (entrata = sede del pagamento, uscita = sede del movimento).
 */
function DettaglioPerSede({ perSede, nomeSede, apri }: { perSede: ReportDiSede[]; nomeSede: (id: string, dalServer?: string | null) => string; apri: ApriCategoria }) {
  const t = useTranslations('adminContabilita');
  return (
    <div data-testid="cassa-report-per-sede">
      <h4 className="mb-1 font-barlow text-xs font-black uppercase tracking-wide text-kidville-green">{t('cassaMsRepPerSedeTitolo')}</h4>
      <p className="mb-2 font-maven text-xs text-kidville-sub">{t('cassaMsRepPerSedeSub')}</p>
      <div className={TABLE_WRAP}>
        <table className={TABLE}>
          <thead>
            <tr>
              <th scope="col" className={TH}>{t('cassaMsThSede')}</th>
              <th scope="col" className={cx(TH, 'text-right')}>{t('cassaRepThEntrate')}</th>
              <th scope="col" className={cx(TH, 'text-right')}>{t('cassaRepThUscite')}</th>
            </tr>
          </thead>
          <tbody>
            {perSede.map((s) => (
              <tr key={s.scuola_id} data-testid={`cassa-report-sede-${s.scuola_id}`} className={TROW}>
                <th scope="row" className={cx(TD, 'text-left font-normal')}><span className="font-maven text-sm text-kidville-ink">{nomeSede(s.scuola_id, s.scuola_nome)}</span></th>
                <td className={cx(TD, 'text-right')}><span className="font-maven text-sm text-kidville-green">{formatEuro(somma(s.entrate_per_categoria))}</span></td>
                <td className={cx(TD, 'text-right')}><span className="font-maven text-sm text-kidville-error-strong">{formatEuro(somma(s.uscite_per_categoria))}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 space-y-2">
        {perSede.map((s) => (
          <details key={s.scuola_id} className="rounded-card border-[1.5px] border-kidville-line px-3 py-2">
            <summary className="cursor-pointer font-maven text-sm font-bold text-kidville-green">
              {t('cassaMsRepDettaglioSede', { nome: nomeSede(s.scuola_id, s.scuola_nome) })}
            </summary>
            <div className="mt-3 space-y-4">
              <TabellaEntrate righe={s.entrate_per_categoria ?? []} apri={apri} scuolaId={s.scuola_id} />
              <TabellaUscite righe={s.uscite_per_categoria ?? []} apri={apri} scuolaId={s.scuola_id} />
              {(s.mensile ?? []).length > 0 && <TabellaMensile righe={s.mensile ?? []} />}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

function TabellaEntrate({ righe, apri, scuolaId }: { righe: EntrataCat[]; apri: ApriCategoria; scuolaId: string | null }) {
  const t = useTranslations('adminContabilita');
  return (
    <div>
      <h4 className="mb-2 font-barlow text-xs font-black uppercase tracking-wide text-kidville-green">{t('cassaRepEntrateTitolo')}</h4>
      {righe.length === 0 ? (
        <p className="font-maven text-sm text-kidville-sub">{t('cassaRepNessunaEntrata')}</p>
      ) : (
        <div className={TABLE_WRAP}>
          <table className={TABLE}>
            <thead>
              <tr><th scope="col" className={TH}>{t('cassaRepThCategoria')}</th><th scope="col" className={TH}>{t('cassaRepThPerMetodo')}</th><th scope="col" className={cx(TH, 'text-right')}>{t('cassaRepContanteIncassato')}</th><th scope="col" className={cx(TH, 'text-right')}>{t('cassaRepAltriMetodi')}</th><th scope="col" className={cx(TH, 'text-right')}>{t('cassaRepThTotale')}</th></tr>
            </thead>
            <tbody>
              {righe.map((r, i) => (
                <tr key={r.categoria_id ?? `e${i}`} className={TROW}>
                  <td className={TD}><button type="button" onClick={(e) => apri('entrata', r, scuolaId, e.currentTarget)} aria-label={t('cassaRepVediEntrate', { categoria: r.categoria_nome ?? t('cassaRepSenzaCategoria') })} className="min-h-11 text-left font-maven text-sm font-bold text-kidville-green underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-kidville-green">{r.categoria_nome ?? t('cassaRepSenzaCategoria')}</button></td>
                  <td className={TD}>
                    <span className="font-maven text-xs text-kidville-sub">
                      {r.per_metodo && Object.keys(r.per_metodo).length > 0
                        ? Object.entries(r.per_metodo).map(([m, v]) => `${metodoLabel(m)}: ${formatEuro(v)}`).join(' · ')
                        : '—'}
                    </span>
                  </td>
                  <td className={cx(TD, 'text-right')}><span className="font-maven text-sm text-kidville-ink">{formatEuro(r.per_metodo?.contanti ?? 0)}</span></td>
                  <td className={cx(TD, 'text-right')}><span className="font-maven text-sm text-kidville-ink">{formatEuro(r.totale - (r.per_metodo?.contanti ?? 0))}</span></td>
                  <td className={cx(TD, 'text-right')}><span className="font-barlow font-bold text-kidville-green">{formatEuro(r.totale)}</span></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><th scope="row" className={TD} colSpan={2}>{t('cassaRepThTotale')}</th><td className={cx(TD, 'text-right')}>{formatEuro(righe.reduce((s, r) => s + (r.per_metodo?.contanti ?? 0), 0))}</td><td className={cx(TD, 'text-right')}>{formatEuro(righe.reduce((s, r) => s + r.totale - (r.per_metodo?.contanti ?? 0), 0))}</td><td className={cx(TD, 'text-right font-bold')}>{formatEuro(somma(righe))}</td></tr></tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function TabellaUscite({ righe, apri, scuolaId }: { righe: UscitaCat[]; apri: ApriCategoria; scuolaId: string | null }) {
  const t = useTranslations('adminContabilita');
  return (
    <div>
      <h4 className="mb-2 font-barlow text-xs font-black uppercase tracking-wide text-kidville-green">{t('cassaRepUsciteTitolo')}</h4>
      {righe.length === 0 ? (
        <p className="font-maven text-sm text-kidville-sub">{t('cassaRepNessunaUscita')}</p>
      ) : (
        <div className={TABLE_WRAP}>
          <table className={TABLE}>
            <thead>
              <tr><th scope="col" className={TH}>{t('cassaRepThCategoria')}</th><th scope="col" className={cx(TH, 'text-right')}>{t('cassaRepThDiCuiContanti')}</th><th scope="col" className={cx(TH, 'text-right')}>{t('cassaRepAltriMetodi')}</th><th scope="col" className={cx(TH, 'text-right')}>{t('cassaRepThTotale')}</th></tr>
            </thead>
            <tbody>
              {righe.map((r, i) => (
                <tr key={r.categoria_id ?? `u${i}`} className={TROW}>
                  <td className={TD}><button type="button" onClick={(e) => apri('uscita', r, scuolaId, e.currentTarget)} aria-label={t('cassaRepVediUscite', { categoria: r.categoria_nome ?? t('cassaRepSenzaCategoria') })} className="min-h-11 text-left font-maven text-sm font-bold text-kidville-green underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-kidville-green">{r.categoria_nome ?? t('cassaRepSenzaCategoria')}</button></td>
                  <td className={cx(TD, 'text-right')}><span className="font-maven text-xs text-kidville-sub">{r.contanti != null ? formatEuro(r.contanti) : '—'}</span></td>
                  <td className={cx(TD, 'text-right')}><span className="font-maven text-xs text-kidville-sub">{r.contanti != null ? formatEuro(r.totale - r.contanti) : '—'}</span></td>
                  <td className={cx(TD, 'text-right')}><span className="font-barlow font-bold text-kidville-error-strong">{formatEuro(r.totale)}</span></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><th scope="row" className={TD}>{t('cassaRepThTotale')}</th><td className={cx(TD, 'text-right')}>{formatEuro(righe.reduce((s, r) => s + (r.contanti ?? 0), 0))}</td><td className={cx(TD, 'text-right')}>{formatEuro(righe.reduce((s, r) => s + r.totale - (r.contanti ?? 0), 0))}</td><td className={cx(TD, 'text-right font-bold')}>{formatEuro(somma(righe))}</td></tr></tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

function TabellaMensile({ righe }: { righe: MeseRiga[] }) {
  const t = useTranslations('adminContabilita');
  return (
    <div>
      <h4 className="mb-2 font-barlow text-xs font-black uppercase tracking-wide text-kidville-green">{t('cassaRepMensileTitolo')}</h4>
      <div className={TABLE_WRAP}>
        <table className={TABLE}>
          <thead>
            <tr><th scope="col" className={TH}>{t('cassaRepThMese')}</th><th scope="col" className={cx(TH, 'text-right')}>{t('cassaRepThEntrate')}</th><th scope="col" className={cx(TH, 'text-right')}>{t('cassaRepThUscite')}</th></tr>
          </thead>
          <tbody>
            {righe.map((r) => (
              <tr key={r.mese} className={TROW}>
                <td className={TD}><span className="font-maven text-sm text-kidville-ink">{meseItaliano(r.mese)}</span></td>
                <td className={cx(TD, 'text-right')}><span className="font-maven text-sm text-kidville-green">{formatEuro(r.entrate ?? 0)}</span></td>
                <td className={cx(TD, 'text-right')}><span className="font-maven text-sm text-kidville-error-strong">{formatEuro(r.uscite ?? 0)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
