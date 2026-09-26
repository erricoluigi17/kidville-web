'use client';

// ─── Tab «Cassa» della Contabilità: registro di cassa contanti ─────────────────
// Contenitore della vista `?vista=cassa`. Ruolo client da `useAdminIdentity()`,
// puramente COSMETICO: il gate vero sono le API. La UI NON mostra saldo/totali se
// il payload di GET movimenti non contiene `totali` (il server decide chi vede i
// KPI). Su ambiente non migrato (disponibile:false) mostra un empty-state.
//
// Tutti gli staff: «Registra uscita» / «Entrata manuale» + lista movimenti
// (tabella desktop / card mobile) con storno SOLO sulle righe di cassa reali.
// Solo admin (server-confirmed via `totali`): StatCard KPI, «Svuota cassa»,
// report, storico svuotamenti, categorie e impostazioni.
// Solo token `kidville-*`; importi con formatEuro.
//
// Multi-sede (P4a, contratti K3 e P4b). `scuolaId` è null quando le sedi
// selezionate sono più d'una: allora le GET NON portano `scuola_id` (mai
// `scuola_id=null` nell'URL) e il server legge tutte le sedi attive. La lettura è
// unita, ma ogni sede resta un cassetto a sé: saldo, fondo, uscite del mese e
// ultimo svuotamento si mostrano PER SEDE più il totale, e movimenti e storico
// portano la colonna Sede. Le scritture restano di una sede sola: le finestre
// ricevono le sedi effettive e fanno scegliere la sede al loro interno.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { Wallet, TrendingDown, TrendingUp, Coins, CalendarDays, ArrowDownCircle, RotateCcw, Paperclip } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { StatCard, SectionTitle, TABLE_WRAP, TABLE, TH, TD, TROW } from '@/components/ui/cockpit';
import { cx } from '@/lib/ui/cx';
import { formatEuro } from '@/lib/format/valuta';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { useAdminIdentity } from '@/lib/context/admin-identity';
import { useSediAttive } from '@/lib/context/sede-context';
import { MODAL_CARD, MODAL_SHADOW, INPUT, BTN_PRIMARY_AA, BTN_SECONDARY } from './ui';
import { CassaMovimentoModal } from './CassaMovimentoModal';
import { CassaChiusuraModal } from './CassaChiusuraModal';
import { CassaReport } from './CassaReport';
import { CassaCategorieManager } from './CassaCategorieManager';
import { CassaImpostazioni } from './CassaImpostazioni';
import type { SedeCassa } from './CassaSede';
import { metodoLabel } from '@/lib/cassa/tipi';
import type { RigaMovimentoCassa, SaldoCassa, CassaChiusura, EntratoOggiVoce } from '@/lib/cassa/tipi';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { isNativeApp } from '@/lib/push/native-register';
import { AvvisoDocumentoNativo, useDocumentoNativo } from './LinkDocumento';

interface Props {
  userId: string;
  /** La sede della pagina, o null quando le sedi selezionate sono più d'una. */
  scuolaId: string | null;
}

/** Una riga della GET movimenti: dal K3 porta anche il nome della sede. */
type RigaMovimento = RigaMovimentoCassa & { scuola_nome?: string | null };
/** Uno svuotamento della GET chiusura, col nome della sede (K3 §3). */
type RigaChiusura = CassaChiusura & { scuola_nome?: string | null };

/**
 * «Uscite del mese» calcolate dal SERVER sul mese corrente (Europe/Rome), con
 * qualunque metodo e ignorando i filtri (K3 §1). `null` = lettura fallita.
 */
interface UsciteMese {
  da: string;
  a: string;
  totale: number;
  per_sede?: { scuola_id: string; scuola_nome: string | null; totale: number }[];
}

/** Il saldo di UNA sede, col suo fondo (K3 §2). */
type SaldoDiSede = { scuola_id: string; scuola_nome: string | null } & (SaldoCassa | { disponibile: false });
type RispostaSaldo = (SaldoCassa | { disponibile: false }) & { per_sede?: SaldoDiSede[] };

/** Totali della GET movimenti — presenti SOLO per l'admin (server decide). */
interface TotaliCassa {
  entrate: number;
  uscite_contanti: number;
  uscite_altre: number;
  prelievi: number;
  rettifiche: number;
}

const hdr = (u: string) => ({ 'Content-Type': 'application/json', 'x-user-id': u });

const TIPO_INFO: Record<string, { labelKey: string; tone: BadgeTone }> = {
  entrata: { labelKey: 'cassaTipoEntrata', tone: 'success' },
  uscita: { labelKey: 'cassaTipoUscita', tone: 'error' },
  prelievo: { labelKey: 'cassaTipoPrelievo', tone: 'neutral' },
  rettifica: { labelKey: 'cassaTipoRettifica', tone: 'warn' },
};

const stornabile = (r: RigaMovimentoCassa) =>
  r.origine === 'cassa' && !r.stornato_il && !r.storno_di && !r.chiusura_id;

/**
 * Direzione VISIVA del movimento (true = «−», denaro che esce dalla cassa).
 * I contro-movimenti di storno hanno lo STESSO `tipo` ma importo già NEGATO
 * (§3.1): lo storno di un'uscita è quindi una restituzione (segno «+»). Il segno
 * si deriva con uno XOR tipo×segno, mai anteponendo un «−»/«+» fisso a un importo
 * che porta già il proprio segno (era il doppio segno del ciclo 1, RC6).
 */
export function direzioneNegativa(r: Pick<RigaMovimentoCassa, 'tipo' | 'importo'>): boolean {
  if (r.tipo === 'rettifica') return r.importo < 0;
  const inUscita = r.tipo === 'uscita' || r.tipo === 'prelievo';
  return inUscita !== (r.importo < 0);
}

/** Importo con un solo segno derivato dalla direzione, valore sempre assoluto. */
export function importoSegnato(r: Pick<RigaMovimentoCassa, 'tipo' | 'importo'>): string {
  return `${direzioneNegativa(r) ? '−' : '+'} ${formatEuro(Math.abs(r.importo))}`;
}

/** Tono AA coerente col segno: entrate/restituzioni verdi, uscite rosse, rettifiche gialle. */
export function importoTone(r: Pick<RigaMovimentoCassa, 'tipo' | 'importo'>): string {
  if (r.tipo === 'rettifica') return 'text-kidville-warn-strong';
  return direzioneNegativa(r) ? 'text-kidville-error-strong' : 'text-kidville-success-strong';
}

/**
 * Il nome del giustificativo sul telefono: `giustificativo-cassa` più l'estensione
 * del file caricato. Del percorso (`<sede>/<anno>/<uuid>-<nome originale>`) si
 * tiene SOLO l'estensione: il nome originale lo ha scritto chi ha caricato, e può
 * contenere un nome di persona.
 */
export function nomeGiustificativo(path: string): string {
  const ultimo = (path ?? '').slice((path ?? '').lastIndexOf('/') + 1);
  const punto = ultimo.lastIndexOf('.');
  const estensione = punto > 0 ? ultimo.slice(punto + 1).toLowerCase() : '';
  return /^[a-z0-9]{1,5}$/.test(estensione) ? `giustificativo-cassa.${estensione}` : 'giustificativo-cassa';
}

export function CassaPanel({ userId, scuolaId }: Props) {
  const t = useTranslations('adminContabilita');
  const f = useDateFormat();
  // Data breve localizzata (IT identica a `toLocaleDateString('it-IT')`); '—' se assente.
  const dataIt = (d?: string | null) => (d ? f.dataBreve(d) : '—');
  const { ruolo } = useAdminIdentity();
  const isAdmin = ruolo === 'admin'; // cosmetico: il gate vero è `mostraKpi` (server)
  const { sedi: sediCockpit, effettive } = useSediAttive();
  const piuSedi = scuolaId == null;

  // Le sedi su cui si SCRIVE, per le finestre (P4b), come `FiscalePanel` fa con la
  // revisione fatture: con una sede la pagina l'ha già scelta; con più sedi sono le
  // sedi effettive del cockpit, e la finestra fa scegliere.
  const sediCassa: SedeCassa[] = useMemo(() => {
    if (scuolaId) return [{ id: scuolaId, nome: sediCockpit.find((s) => s.id === scuolaId)?.nome ?? '' }];
    return sediCockpit.filter((s) => effettive.includes(s.id)).map((s) => ({ id: s.id, nome: s.nome }));
  }, [scuolaId, sediCockpit, effettive]);

  const [disponibile, setDisponibile] = useState<boolean | null>(null);
  const [movimenti, setMovimenti] = useState<RigaMovimento[]>([]);
  const [totali, setTotali] = useState<TotaliCassa | null>(null);
  const [usciteMese, setUsciteMese] = useState<UsciteMese | null>(null);
  // `saldo` = le SOMME, solo quando tutte le sedi lette sono disponibili (K3 §2).
  const [saldo, setSaldo] = useState<SaldoCassa | null>(null);
  const [saldoPerSede, setSaldoPerSede] = useState<SaldoDiSede[]>([]);
  // Saldo NON letto (GET rifiutata o rete caduta) ≠ saldo non disponibile: nel primo
  // caso la pagina dice che la lettura è fallita, nel secondo che il dato non c'è.
  const [saldoLetto, setSaldoLetto] = useState(false);
  const [chiusure, setChiusure] = useState<RigaChiusura[]>([]);
  // Svuotamenti NON letti ≠ «mai svuotata»: con la GET rifiutata o la rete caduta non
  // si sa niente. Si parte da `false`: «letti» lo dice solo una risposta arrivata.
  const [chiusureLette, setChiusureLette] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [modalTipo, setModalTipo] = useState<'uscita' | 'entrata' | null>(null);
  const [modalChiusura, setModalChiusura] = useState(false);
  const [stornoTarget, setStornoTarget] = useState<RigaMovimentoCassa | null>(null);

  const giustificativo = useDocumentoNativo();

  const uscitaRef = useRef<HTMLButtonElement>(null);
  const entrataRef = useRef<HTMLButtonElement>(null);
  const svuotaRef = useRef<HTMLButtonElement>(null);

  const ricarica = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    let active = true;
    // Con più sedi nessun `scuola_id`: la route legge le sedi attive dell'utente (K3).
    const sedeQ = scuolaId ? `&scuola_id=${encodeURIComponent(scuolaId)}` : '';
    const rifiutata = (messaggio: string, stato: number) =>
      logClient({ livello: 'error', evento: 'fetch', messaggio, route: '/admin/pagamenti', stato });
    /**
     * Una lettura secondaria (saldo, svuotamenti) che non deve trascinare con sé le
     * altre: un rifiuto HTTP logga `<nome>-lettura-rifiutata` con lo stato, una rete
     * caduta (o un corpo illeggibile) `<nome>-caricamento-fallito` con stato 0. In
     * entrambi i casi `null` = «non letto», mai un elenco vuoto.
     */
    const leggi = async <T,>(url: string, nome: string): Promise<T | null> => {
      try {
        const r = await fetch(url, { headers: hdr(userId) });
        if (!r.ok) { rifiutata(`${nome}-lettura-rifiutata`, r.status); return null; }
        return (await r.json()) as T;
      } catch (err) {
        rifiutata(`${nome}-caricamento-fallito: ${nomeErrore(err)}`, 0);
        return null;
      }
    };
    (async () => {
      try {
        const rMov = await fetch(`/api/pagamenti/cassa/movimenti?userId=${userId}${sedeQ}`, { headers: hdr(userId) });
        if (!rMov.ok) {
          // Un 403 `SEDE_NON_ACCESSIBILE` (o un 500) non è «nessun movimento»: prima il
          // corpo d'errore diventava una cassa vuota e disponibile, senza un log.
          rifiutata('cassa-movimenti-lettura-rifiutata', rMov.status);
          if (active) setErrore('cassaErroreCaricamento');
          return;
        }
        const jMov = (await rMov.json()) as { disponibile?: boolean; movimenti?: RigaMovimento[]; totali?: TotaliCassa; uscite_mese?: UsciteMese | null };
        if (!active) return;
        const disp = jMov?.disponibile !== false;
        setErrore(null);
        setDisponibile(disp);
        setMovimenti(jMov?.movimenti ?? []);
        const tot = jMov?.totali ?? null;
        setTotali(tot);
        setUsciteMese(jMov?.uscite_mese ?? null);
        // KPI e sezioni admin SOLO se il server ha inviato `totali` (= admin).
        if (disp && tot) {
          // Ciascuna col suo esito: prima un `Promise.all` rifiutato dalla rete finiva nel
          // catch dei MOVIMENTI («Impossibile caricare i movimenti», che invece erano in
          // pagina) e lasciava gli svuotamenti «letti» e vuoti, cioè «Mai svuotata».
          const [jSaldo, jChius] = await Promise.all([
            leggi<RispostaSaldo>(`/api/pagamenti/cassa/saldo?userId=${userId}${sedeQ}`, 'cassa-saldo'),
            leggi<{ disponibile?: boolean; chiusure?: RigaChiusura[] }>(`/api/pagamenti/cassa/chiusura?userId=${userId}${sedeQ}`, 'cassa-chiusure'),
          ]);
          if (!active) return;
          // Anche UNA sola sede non disponibile toglie le somme (K3 §2): restano i dettagli.
          setSaldo(jSaldo && jSaldo.disponibile !== false ? (jSaldo as SaldoCassa) : null);
          setSaldoPerSede(jSaldo?.per_sede ?? []);
          setSaldoLetto(jSaldo !== null);
          setChiusure(jChius?.chiusure ?? []);
          setChiusureLette(jChius !== null);
        } else {
          // Niente KPI (non admin o cassa non attiva): saldo e svuotamenti non si leggono.
          setSaldo(null);
          setSaldoPerSede([]);
          setSaldoLetto(false);
          setChiusure([]);
          setChiusureLette(false);
        }
      } catch (err) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-movimenti-caricamento-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
        // Chiave i18n (non testo): l'effetto non dipende da `t`; si traduce al render.
        if (active) setErrore('cassaErroreCaricamento');
      }
    })();
    return () => { active = false; };
  }, [userId, scuolaId, refreshKey]);

  const mostraKpi = disponibile === true && !!totali;

  /** Il nome di una sede: quello del server, poi quello del selettore, poi l'uuid. */
  const nomeSede = (id: string | null | undefined, dalServer?: string | null): string =>
    dalServer?.trim() || (id ? sediCockpit.find((s) => s.id === id)?.nome.trim() : '') || id || '—';

  // Le sedi LETTE, nell'ordine del server (quello di `resolveScuoleAttive`): prima il
  // saldo, poi le uscite del mese, poi le sedi del cockpit e gli svuotamenti, così una
  // sede resta in tabella anche quando una delle letture è fallita.
  const sediLette = useMemo(() => {
    const ordine: string[] = [];
    const nomi = new Map<string, string | null>();
    const aggiungi = (id: string | null | undefined, nome?: string | null) => {
      if (!id) return;
      if (!ordine.includes(id)) ordine.push(id);
      if (nome && !nomi.get(id)) nomi.set(id, nome);
    };
    for (const s of saldoPerSede) aggiungi(s.scuola_id, s.scuola_nome);
    for (const s of usciteMese?.per_sede ?? []) aggiungi(s.scuola_id, s.scuola_nome);
    for (const s of sediCassa) aggiungi(s.id);
    for (const c of chiusure) aggiungi(c.scuola_id, c.scuola_nome);
    return ordine.map((id) => ({ id, nomeServer: nomi.get(id) ?? null }));
  }, [saldoPerSede, usciteMese, sediCassa, chiusure]);

  /** L'ultimo svuotamento di OGNI sede: la più recente delle sue, non la più recente di tutte. */
  const ultimaChiusura = useMemo(() => {
    const m = new Map<string, RigaChiusura>();
    for (const c of chiusure) {
      const prima = m.get(c.scuola_id);
      if (!prima || c.eseguita_il > prima.eseguita_il) m.set(c.scuola_id, c);
    }
    return m;
  }, [chiusure]);

  // Lo storico con più sedi è raggruppato per sede (ordine delle sedi lette); dentro
  // ogni sede resta l'ordine del server, `eseguita_il` decrescente (sort stabile).
  const storico = useMemo(() => {
    if (!piuSedi) return chiusure;
    const pos = new Map(sediLette.map((s, i) => [s.id, i]));
    return [...chiusure].sort((x, y) => (pos.get(x.scuola_id) ?? 1e9) - (pos.get(y.scuola_id) ?? 1e9));
  }, [chiusure, piuSedi, sediLette]);

  const apriGiustificativo = async (path: string) => {
    const nativo = isNativeApp();
    try {
      const r = await fetch(`/api/pagamenti/cassa/allegato?userId=${userId}&path=${encodeURIComponent(path)}`, { headers: hdr(userId) });
      const j = (await r.json()) as { url?: string };
      if (!j?.url) {
        // Prima taceva su entrambe le piattaforme: ora almeno lo stato resta nel log.
        logClient({ livello: 'warn', evento: 'fetch', messaggio: `cassa-allegato-url-assente: http-${r.status}`, route: '/admin/pagamenti', stato: r.status });
        // Il binario non c'entra: il server non ha dato l'URL (403, sessione scaduta…).
        if (nativo) giustificativo.setAvviso('riprova');
        return;
      }
      // Nell'app `window.open` non apre niente (la WebView non ha schede): anteprima
      // di sistema con l'helper unico, che logga da sé l'esito. Sul web, come prima.
      if (nativo) await giustificativo.esegui(j.url, { modo: 'apri', nomeFile: nomeGiustificativo(path), etichetta: 'giustificativo-cassa' });
      else window.open(j.url, '_blank', 'noopener');
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-allegato-apertura-fallita: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      if (nativo) giustificativo.setAvviso('riprova');
    }
  };

  if (disponibile === null && !errore) {
    return <p className="py-8 text-center font-maven text-sm text-kidville-sub">{t('cassaLoading')}</p>;
  }

  if (disponibile === false) {
    return (
      <div className="rounded-card bg-kidville-cream/60 px-4 py-10 text-center">
        <Wallet size={28} className="mx-auto mb-2 text-kidville-sub" />
        <p className="font-maven text-sm text-kidville-sub">{t('cassaNonAttivo')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Intestazione + azioni per tutti gli staff */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 font-barlow text-[19px] font-extrabold uppercase leading-none tracking-[0.01em] text-kidville-green">
            <Wallet size={20} /> {t('cassaTitolo')}
          </h2>
          <p className="mt-1 font-maven text-[12.5px] text-kidville-sub">
            {isAdmin ? t('cassaSottotitoloAdmin') : t('cassaSottotitoloStaff')}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button ref={uscitaRef} type="button" onClick={() => setModalTipo('uscita')} className={cx(BTN_PRIMARY_AA, 'min-h-[44px] py-2 px-4 text-xs')}>
            <TrendingDown size={15} /> {t('cassaRegistraUscita')}
          </button>
          <button ref={entrataRef} type="button" onClick={() => setModalTipo('entrata')} className={cx(BTN_SECONDARY, 'min-h-[44px] py-2 px-4 text-xs')}>
            <TrendingUp size={15} /> {t('cassaEntrataManuale')}
          </button>
          {mostraKpi && isAdmin && (
            <button ref={svuotaRef} type="button" onClick={() => setModalChiusura(true)} className={cx(BTN_SECONDARY, 'min-h-[44px] py-2 px-4 text-xs')}>
              <ArrowDownCircle size={15} /> {t('cassaSvuotaCassa')}
            </button>
          )}
        </div>
      </div>

      {errore && <p role="alert" className="rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong">{t(errore)}</p>}
      {giustificativo.avviso && <AvvisoDocumentoNativo tipo={giustificativo.avviso} className="block rounded-card bg-kidville-error-soft px-3 py-2 font-maven text-xs text-kidville-error-strong" />}

      {/* KPI: SOLO se il payload ha `totali` (server decide) */}
      {mostraKpi && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {/* Senza somme (`saldo` null) i due riquadri dicono «—» e PERCHÉ: saldo non
              letto (GET rifiutata o rete caduta) oppure non disponibile (con più sedi
              basta una sede senza schema, K3 §2). Mai «€ 0,00 · nessun incasso oggi»:
              sarebbe uno zero falso, lo stesso che «Uscite del mese» non dice più. */}
          <StatCard
            icon={Wallet}
            tone="green"
            label={t('cassaKpiSaldoAtteso')}
            value={saldo ? formatEuro(saldo.saldo_atteso) : '—'}
            sub={saldo
              ? `${t('cassaKpiFondo')} ${formatEuro(saldo.fondo)}${piuSedi ? ` · ${t('cassaMsSommaSedi')}` : ''}`
              : !saldoLetto
                ? <span role="alert" className="text-kidville-error-strong">{t('cassaMsSaldoNonLetto')}</span>
                : t('cassaMsNonDisponibile')}
          />
          <StatCard
            icon={Coins}
            tone="success"
            label={t('cassaKpiEntratoOggi')}
            value={saldo ? formatEuro(saldo.entrato_oggi.reduce((s, v) => s + v.totale, 0)) : '—'}
            sub={saldo
              ? <EntratoOggiSub voci={saldo.entrato_oggi} />
              : !saldoLetto
                ? <span className="text-kidville-error-strong">{t('cassaMsSaldoNonLetto')}</span>
                : t('cassaMsNonDisponibile')}
          />
          <StatCard
            icon={TrendingDown}
            tone="error"
            label={t('cassaKpiUsciteMese')}
            // Dal server, sul MESE corrente: prima era `uscite_contanti + uscite_altre`
            // dei totali, cioè le uscite di sempre (K3 §1). Non lette → «—», mai uno 0.
            value={usciteMese ? formatEuro(usciteMese.totale) : '—'}
            sub={!usciteMese ? t('cassaMsUsciteMeseNonLette') : piuSedi ? t('cassaMsSommaSedi') : undefined}
          />
        </div>
      )}

      {/* Lo svuotamento della cassa esisteva già ed era completo: bottone in alto,
          modale, RPC atomica, storico. Quello che mancava era il FATTO, scritto
          accanto al numero che l'operatore guarda — al 2026-09-07 il database
          aveva ZERO chiusure in tutta la sua storia, con 2.283,75 € di uscite
          registrate dal 20 luglio.

          NON si mettono qui «da ritirare» e «resta come fondo»: si calcolano su
          `contato`, che fuori dalla modale non esiste, e con `cassa_config` vuoto
          su tutte le sedi (`fondo ?? 0`) direbbero € 0,00 costante e un duplicato
          del KPI qui sopra.

          La condizione è la STESSA del bottone (`mostraKpi && isAdmin`) e NON
          guarda `saldo`: col saldo degradato questa riga deve restare, o
          sparirebbe proprio nel caso in cui serve capire cosa sta succedendo. */}
      {mostraKpi && isAdmin && !piuSedi && (
        <p data-testid="cassa-ultimo-svuotamento" className="flex flex-wrap items-center gap-x-2 gap-y-1 font-maven text-[12.5px] text-kidville-sub">
          <ArrowDownCircle size={14} className="shrink-0" />
          {!chiusureLette ? (
            <span>{t('cassaMsSvuotamentiNonLetti')}</span>
          ) : chiusure.length === 0 ? (
            <span>{t('cassaMaiSvuotata')}</span>
          ) : (
            <>
              <span>{t('cassaUltimoSvuotamentoEtichetta')}</span>
              <b className="text-kidville-ink">{dataIt(chiusure[0].eseguita_il)}</b>
              <span>·</span>
              <span>{t('cassaRitiratoEtichetta')}</span>
              <b className="text-kidville-ink">{formatEuro(chiusure[0].prelevato)}</b>
              <a href="#cassa-storico" className="underline decoration-kidville-green/40 underline-offset-2 hover:decoration-kidville-green">{t('cassaVediStorico')}</a>
            </>
          )}
        </p>
      )}

      {/* Più sedi: un cassetto per sede (K3). Saldo e fondo di ciascuna, le sue uscite
          del mese e il suo ultimo svuotamento, più il totale. La riga unica qui sopra
          non c'è: «ultimo svuotamento della cassa» con tre cassetti direbbe quello di
          una sede come se fosse di tutte. */}
      {mostraKpi && piuSedi && (
        <section data-testid="cassa-per-sede">
          <SectionTitle icon={Wallet} title={t('cassaMsPerSedeTitolo')} sub={t('cassaMsPerSedeSub')} />
          <div className={TABLE_WRAP}>
            <table className={TABLE}>
              <thead>
                <tr>
                  <th scope="col" className={TH}>{t('cassaMsThSede')}</th>
                  <th scope="col" className={cx(TH, 'text-right')}>{t('cassaStoricoSaldoAtteso')}</th>
                  <th scope="col" className={cx(TH, 'text-right')}>{t('cassaMsThFondo')}</th>
                  <th scope="col" className={cx(TH, 'text-right')}>{t('cassaKpiUsciteMese')}</th>
                  {isAdmin && <th scope="col" className={TH}>{t('cassaUltimoSvuotamentoEtichetta')}</th>}
                </tr>
              </thead>
              <tbody>
                {sediLette.map(({ id, nomeServer }) => {
                  const s = saldoPerSede.find((x) => x.scuola_id === id);
                  const u = usciteMese?.per_sede?.find((x) => x.scuola_id === id);
                  const ultima = ultimaChiusura.get(id);
                  return (
                    <tr key={id} data-testid={`cassa-per-sede-${id}`} className={TROW}>
                      <th scope="row" className={cx(TD, 'text-left font-normal')}><span className="font-maven text-sm font-bold text-kidville-ink">{nomeSede(id, nomeServer)}</span></th>
                      <td className={cx(TD, 'text-right')}>
                        <span className="whitespace-nowrap font-maven text-sm text-kidville-ink">
                          {s ? (s.disponibile ? formatEuro(s.saldo_atteso) : t('cassaMsNonDisponibile')) : '—'}
                        </span>
                      </td>
                      <td className={cx(TD, 'text-right')}><span className="whitespace-nowrap font-maven text-sm text-kidville-sub">{s && s.disponibile ? formatEuro(s.fondo) : '—'}</span></td>
                      <td className={cx(TD, 'text-right')}><span className="whitespace-nowrap font-maven text-sm text-kidville-ink">{u ? formatEuro(u.totale) : '—'}</span></td>
                      {isAdmin && (
                        <td className={TD}>
                          <span className="font-maven text-sm text-kidville-ink">
                            {!chiusureLette ? '—' : ultima ? `${dataIt(ultima.eseguita_il)} · ${t('cassaRitiratoEtichetta')} ${formatEuro(ultima.prelevato)}` : t('cassaMsMaiSvuotata')}
                          </span>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr data-testid="cassa-per-sede-totale" className={TROW}>
                  <th scope="row" className={cx(TD, 'text-left')}><span className="font-barlow text-sm font-black uppercase text-kidville-green">{t('cassaMsTotale')}</span></th>
                  {/* Somme solo se TUTTE le sedi sono disponibili: una somma parziale sarebbe sbagliata. */}
                  <td className={cx(TD, 'text-right')}><span className="whitespace-nowrap font-barlow font-bold text-kidville-ink">{saldo ? formatEuro(saldo.saldo_atteso) : '—'}</span></td>
                  <td className={cx(TD, 'text-right')}><span className="whitespace-nowrap font-maven text-sm text-kidville-sub">{saldo ? formatEuro(saldo.fondo) : '—'}</span></td>
                  <td className={cx(TD, 'text-right')}><span className="whitespace-nowrap font-barlow font-bold text-kidville-ink">{usciteMese ? formatEuro(usciteMese.totale) : '—'}</span></td>
                  {isAdmin && <td className={TD} />}
                </tr>
              </tfoot>
            </table>
          </div>
          {isAdmin && (
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-maven text-[12.5px] text-kidville-sub">
              <ArrowDownCircle size={14} className="shrink-0" />
              {!chiusureLette && <span role="alert" className="text-kidville-error-strong">{t('cassaMsSvuotamentiNonLetti')}</span>}
              <a href="#cassa-storico" className="underline decoration-kidville-green/40 underline-offset-2 hover:decoration-kidville-green">{t('cassaVediStorico')}</a>
            </p>
          )}
        </section>
      )}

      {/* Lista movimenti — tabella desktop + card mobile */}
      <div>
        <SectionTitle icon={CalendarDays} title={t('cassaSecMovimenti')} sub={t('cassaSecMovimentiSub')} />
        {movimenti.length === 0 ? (
          // Empty-state SOLO quando non c'è un errore di caricamento (l'alert
          // sopra ha già spiegato il fallimento): evita il fuorviante «nessun
          // movimento» quando in realtà la rete è caduta (P4).
          !errore && <p className="rounded-card bg-kidville-cream/40 px-3 py-6 text-center font-maven text-sm text-kidville-sub">{t('cassaNessunMovimento')}</p>
        ) : (
          <>
            <div className="hidden lg:block" data-testid="cassa-movimenti-tabella">
              <div className={TABLE_WRAP}>
                <table className={TABLE}>
                  <thead>
                    <tr>
                      <th scope="col" className={TH}>{t('cassaThData')}</th>
                      {piuSedi && <th scope="col" className={TH}>{t('cassaMsThSede')}</th>}
                      <th scope="col" className={TH}>{t('cassaThMovimento')}</th>
                      <th scope="col" className={TH}>{t('cassaThCategoria')}</th>
                      <th scope="col" className={TH}>{t('cassaThMetodo')}</th>
                      <th scope="col" className={TH}>{t('cassaThDescrizione')}</th>
                      <th scope="col" className={cx(TH, 'text-right')}>{t('cassaThImporto')}</th>
                      <th scope="col" className={cx(TH, 'text-right')}>{t('cassaThAzioni')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {movimenti.map((r) => {
                      const info = TIPO_INFO[r.tipo] ?? TIPO_INFO.entrata;
                      return (
                        <tr key={r.id} className={cx(TROW, r.stornato_il && 'opacity-55')}>
                          <td className={TD}><span className="whitespace-nowrap font-maven text-sm text-kidville-ink">{dataIt(r.data)}</span></td>
                          {piuSedi && <td className={TD}><span className="font-maven text-sm text-kidville-ink">{nomeSede(r.scuola_id, r.scuola_nome)}</span></td>}
                          <td className={TD}>
                            <span className="flex items-center gap-1.5">
                              <Badge tone={info.tone}>{t(info.labelKey)}</Badge>
                              {r.origine === 'incasso' && <Badge tone="info">{t('cassaBadgeDaIncasso')}</Badge>}
                              {r.storno_di && <Badge tone="neutral">{t('cassaBadgeStorno')}</Badge>}
                              {r.stornato_il && <Badge tone="neutral">{t('cassaBadgeStornato')}</Badge>}
                            </span>
                          </td>
                          <td className={TD}><span className="font-maven text-sm text-kidville-ink">{r.categoria_nome ?? '—'}</span></td>
                          <td className={TD}><span className="font-maven text-xs text-kidville-sub">{metodoLabel(r.metodo)}</span></td>
                          <td className={TD}>
                            <span className="flex items-center gap-1.5 font-maven text-sm text-kidville-ink">
                              {r.descrizione ?? '—'}
                              {r.allegato_path && (
                                <button type="button" onClick={() => apriGiustificativo(r.allegato_path as string)} aria-label={t('cassaApriGiustificativo')} className="text-kidville-green hover:text-kidville-green-dark"><Paperclip size={13} /></button>
                              )}
                            </span>
                          </td>
                          <td className={cx(TD, 'text-right')}><span className={cx('whitespace-nowrap font-barlow font-bold', importoTone(r))}>{importoSegnato(r)}</span></td>
                          <td className={cx(TD, 'text-right')}>
                            {stornabile(r) ? (
                              <button type="button" onClick={() => setStornoTarget(r)} className="inline-flex min-h-[32px] items-center gap-1 rounded-pill border-[1.5px] border-kidville-line px-2.5 py-1 font-maven text-xs font-bold text-kidville-sub transition-colors hover:border-kidville-error hover:text-kidville-error">
                                <RotateCcw size={12} /> {t('cassaStorna')}
                              </button>
                            ) : r.origine === 'incasso' ? (
                              <span className="font-maven text-[11px] text-kidville-sub">{t('cassaBadgeDaIncasso')}</span>
                            ) : (
                              <span className="font-maven text-[11px] text-kidville-sub">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="space-y-2 lg:hidden">
              {movimenti.map((r) => {
                const info = TIPO_INFO[r.tipo] ?? TIPO_INFO.entrata;
                return (
                  <div key={r.id} data-testid="cassa-movimento-card" className={cx('rounded-card border-[1.5px] border-kidville-line bg-kidville-white p-3', r.stornato_il && 'opacity-55')}>
                    <div className="flex items-start justify-between gap-2">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={info.tone}>{t(info.labelKey)}</Badge>
                        {r.origine === 'incasso' && <Badge tone="info">{t('cassaBadgeDaIncasso')}</Badge>}
                        {r.storno_di && <Badge tone="neutral">{t('cassaBadgeStorno')}</Badge>}
                        {r.stornato_il && <Badge tone="neutral">{t('cassaBadgeStornato')}</Badge>}
                      </span>
                      <span className={cx('whitespace-nowrap font-barlow font-bold', importoTone(r))}>{importoSegnato(r)}</span>
                    </div>
                    <p className="mt-1.5 font-maven text-sm text-kidville-ink">{r.descrizione ?? r.categoria_nome ?? '—'}</p>
                    <p className="mt-0.5 font-maven text-xs text-kidville-sub">
                      {dataIt(r.data)} · {piuSedi ? `${nomeSede(r.scuola_id, r.scuola_nome)} · ` : ''}{metodoLabel(r.metodo)}{r.categoria_nome ? ` · ${r.categoria_nome}` : ''}
                    </p>
                    <div className="mt-2 flex items-center justify-end gap-2">
                      {r.allegato_path && (
                        <button type="button" onClick={() => apriGiustificativo(r.allegato_path as string)} className="inline-flex items-center gap-1 font-maven text-xs font-bold text-kidville-green"><Paperclip size={12} /> {t('cassaGiustificativo')}</button>
                      )}
                      {stornabile(r) && (
                        <button type="button" onClick={() => setStornoTarget(r)} className="inline-flex min-h-[32px] items-center gap-1 rounded-pill border-[1.5px] border-kidville-line px-2.5 py-1 font-maven text-xs font-bold text-kidville-sub hover:border-kidville-error hover:text-kidville-error">
                          <RotateCcw size={12} /> {t('cassaStorna')}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Sezioni admin (server-confirmed via `totali`) */}
      {mostraKpi && (
        <>
          <CassaReport userId={userId} scuolaId={scuolaId} sedi={sediCassa} />

          {/* `scroll-mt-24`: l'ancora deve fermarsi SOTTO la barra fissa dell'admin,
              o il titolo della sezione finisce coperto. */}
          <div id="cassa-storico" className="scroll-mt-24">
            <SectionTitle icon={ArrowDownCircle} title={t('cassaStoricoTitolo')} />
            {!chiusureLette ? (
              <p className="rounded-card bg-kidville-error-soft px-3 py-6 text-center font-maven text-sm text-kidville-error-strong">{t('cassaMsSvuotamentiNonLetti')}</p>
            ) : chiusure.length === 0 ? (
              <p className="rounded-card bg-kidville-cream/40 px-3 py-6 text-center font-maven text-sm text-kidville-sub">{t('cassaStoricoVuoto')}</p>
            ) : (
            <div>
              <div className={TABLE_WRAP}>
                <table className={TABLE}>
                  <thead>
                    <tr>
                      {piuSedi && <th scope="col" className={TH}>{t('cassaMsThSede')}</th>}
                      <th scope="col" className={TH}>{t('cassaThData')}</th>
                      <th scope="col" className={cx(TH, 'text-right')}>{t('cassaStoricoSaldoAtteso')}</th>
                      <th scope="col" className={cx(TH, 'text-right')}>{t('cassaStoricoContato')}</th>
                      <th scope="col" className={cx(TH, 'text-right')}>{t('cassaStoricoDifferenza')}</th>
                      <th scope="col" className={cx(TH, 'text-right')}>{t('cassaStoricoPrelevato')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {storico.map((c) => (
                      <tr key={c.id} className={TROW}>
                        {piuSedi && <td className={TD}><span className="font-maven text-sm text-kidville-ink">{nomeSede(c.scuola_id, c.scuola_nome)}</span></td>}
                        <td className={TD}><span className="whitespace-nowrap font-maven text-sm text-kidville-ink">{dataIt(c.eseguita_il)}</span></td>
                        <td className={cx(TD, 'text-right')}><span className="font-maven text-sm text-kidville-ink">{formatEuro(c.saldo_atteso)}</span></td>
                        <td className={cx(TD, 'text-right')}><span className="font-maven text-sm text-kidville-ink">{formatEuro(c.contato)}</span></td>
                        <td className={cx(TD, 'text-right')}>
                          <span className="font-maven text-sm text-kidville-ink">
                            {c.differenza === 0 ? t('cassaQuadrata') : `${c.differenza > 0 ? t('cassaEccedenza') : t('cassaAmmanco')} ${formatEuro(Math.abs(c.differenza))}`}
                          </span>
                        </td>
                        <td className={cx(TD, 'text-right')}><span className="font-maven text-sm text-kidville-ink">{formatEuro(c.prelevato)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            )}
          </div>

          <CassaCategorieManager userId={userId} sedi={sediCassa} sedeIniziale={scuolaId} />
          <CassaImpostazioni userId={userId} sedi={sediCassa} sedeIniziale={scuolaId} />
        </>
      )}

      {/* Modali */}
      {modalTipo && (
        <CassaMovimentoModal
          userId={userId}
          sedi={sediCassa}
          sedeIniziale={scuolaId}
          tipoIniziale={modalTipo}
          returnFocusRef={modalTipo === 'uscita' ? uscitaRef : entrataRef}
          onClose={() => setModalTipo(null)}
          onDone={() => { setModalTipo(null); ricarica(); }}
        />
      )}
      {modalChiusura && (
        <CassaChiusuraModal
          userId={userId}
          sedi={sediCassa}
          sedeIniziale={scuolaId}
          returnFocusRef={svuotaRef}
          onClose={() => setModalChiusura(false)}
          onDone={() => { setModalChiusura(false); ricarica(); }}
        />
      )}
      {stornoTarget && (
        <StornoCassaModal
          userId={userId}
          movimento={stornoTarget}
          onClose={() => setStornoTarget(null)}
          onDone={() => { setStornoTarget(null); ricarica(); }}
        />
      )}
    </div>
  );
}

function EntratoOggiSub({ voci }: { voci: EntratoOggiVoce[] }) {
  const t = useTranslations('adminContabilita');
  if (voci.length === 0) return <>{t('cassaNessunIncassoOggi')}</>;
  return <>{voci.map((v) => `${metodoLabel(v.metodo)} ${formatEuro(v.totale)}`).join(' · ')}</>;
}

/** Modale di storno di un movimento di cassa: motivo obbligatorio (min 3), 409 gestito. */
function StornoCassaModal({ userId, movimento, onClose, onDone }: { userId: string; movimento: RigaMovimentoCassa; onClose: () => void; onDone: () => void }) {
  const t = useTranslations('adminContabilita');
  const STORNO_ERRORE_ID = 'cassa-storno-errore';
  const [motivo, setMotivo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [motivoInvalido, setMotivoInvalido] = useState(false);

  const conferma = async () => {
    setMotivoInvalido(false);
    if (motivo.trim().length < 3) { setError(t('cassaStornoMotivoCorto')); setMotivoInvalido(true); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pagamenti/cassa/movimenti/storno?userId=${userId}`, {
        method: 'POST', headers: hdr(userId),
        body: JSON.stringify({ movimento_id: movimento.id, motivo: motivo.trim() }),
      });
      const j = (await res.json()) as { error?: string };
      if (res.status === 409) { setError(messaggioDaCorpo(j, t('cassaStornoNoStorno'))); return; }
      if (!res.ok) { setError(messaggioDaCorpo(j, t('cassaStornoErrore'))); return; }
      onDone();
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `cassa-storno-fallito: ${nomeErrore(err)}`, route: '/admin/pagamenti', stato: 0 });
      setError(t('cassaErroreRete'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={t('cassaStornaMovimento')} labelledBy="cassa-storno-title" className={cx(MODAL_CARD, 'max-w-sm')} style={{ boxShadow: MODAL_SHADOW }}>
      <h3 id="cassa-storno-title" className="mb-2 font-barlow text-base font-black uppercase text-kidville-green">{t('cassaStornaMovimento')}</h3>
      <p className="mb-3 font-maven text-sm text-kidville-ink">
        {t('cassaStornoPre')}<strong>{formatEuro(movimento.importo)}</strong>{t('cassaStornoPost')}
      </p>
      <label htmlFor="cassa-storno-motivo" className="mb-1 block font-maven text-xs text-kidville-sub">{t('cassaMotivoStorno')}</label>
      <input id="cassa-storno-motivo" type="text" value={motivo} onChange={(e) => { setMotivo(e.target.value); if (motivoInvalido) setMotivoInvalido(false); }} className={INPUT} maxLength={300} {...(motivoInvalido ? { 'aria-invalid': true as const, 'aria-describedby': STORNO_ERRORE_ID } : {})} />
      {error && <p id={STORNO_ERRORE_ID} role="alert" className="mt-2 font-maven text-xs text-kidville-error-strong">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button onClick={onClose} className={cx(BTN_SECONDARY, 'flex-1')}>{t('cassaAnnulla')}</button>
        <button onClick={conferma} disabled={busy} className={cx(BTN_PRIMARY_AA, 'flex-1')}>{busy ? t('cassaStornoInCorso') : t('cassaConfermaStorno')}</button>
      </div>
    </Modal>
  );
}
