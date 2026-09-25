'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { Star, Check, Lock } from 'lucide-react';
import { dataCivile } from '@/i18n/config';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { suggerisciGiudizio } from '@/lib/primaria/suggerimento';
import { logClient } from '@/lib/logging/client';
import { messaggioDaCorpo } from '@/lib/ui/esito-fetch';
import { MOTIVO_MAX_CARATTERI } from '@/lib/presenze/limiti-testo';
import type { ScalaVoce } from '@/lib/primaria/media';
import {
  AzioniVoce,
  SceltaTipoImpreparato,
  tipoImpreparato,
  unisciVociRecenti,
  type ImpreparatoRecente,
  type TipoImpreparato,
  type ValutazioneRecente,
} from '@/components/features/primaria/VociValutazioni';

interface Alunno { id: string; nome: string; cognome: string }
interface Materia { id: string; nome: string }
interface Obiettivo { id: string; codice: string | null; descrizione: string; livello: number }

function paginaCorrente(): string | undefined {
  return typeof window !== 'undefined' ? window.location.pathname : undefined;
}

export default function ValutazioniPage() {
  const t = useTranslations('teacherPrimaria');
  const f = useDateFormat();
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);

  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [materie, setMaterie] = useState<Materia[]>([]);
  const [alunnoId, setAlunnoId] = useState('');
  const [materiaId, setMateriaId] = useState('');
  const [scala, setScala] = useState<string[]>([]);
  const [scalaValori, setScalaValori] = useState<ScalaVoce[]>([]);
  const [obiettivi, setObiettivi] = useState<Obiettivo[]>([]);
  const [obiettiviSel, setObiettiviSel] = useState<string[]>([]);
  const [recenti, setRecenti] = useState<ValutazioneRecente[]>([]);
  /** Gli impreparati dell'alunno: quelli della materia scelta più quelli senza materia. */
  const [impreparati, setImpreparati] = useState<ImpreparatoRecente[]>([]);
  /** `false` = il server ha dato l'elenco ma non i permessi: si vede, senza bottoni. */
  const [permessiDisponibili, setPermessiDisponibili] = useState(true);
  /** Una delle due letture delle «recenti» non è riuscita: l'elenco a schermo non è completo. */
  const [recentiIncomplete, setRecentiIncomplete] = useState(false);
  /** Il ruolo di chi guarda (`/api/primaria/me`): decide solo se «Sblocca» si mostra. */
  const [ruolo, setRuolo] = useState<string | null>(null);
  /** L'esito dell'ultima modifica/eliminazione, sopra l'elenco, con la selezione a cui appartiene. */
  const [esitoElenco, setEsitoElenco] = useState<{ testo: string; tipo: 'ok' | 'errore'; selezione: string } | null>(null);
  /**
   * Di quale «alunno|materia» sono le voci in `recenti`/`impreparati` (e l'avviso
   * di elenco incompleto). Si mostrano SOLO se è la selezione a schermo: cambiando
   * alunno, le voci del precedente — con Modifica ed Elimina attivi — spariscono
   * subito, mentre la lettura nuova è in volo e anche se fallisce. (Derivato al
   * render invece di svuotare lo stato nell'effetto: react-hooks/set-state-in-effect.)
   */
  const [recentiDi, setRecentiDi] = useState('');
  /** Solo l'ultima lettura delle «recenti» scrive lo stato: cambiando alunno in fretta, una risposta vecchia non sovrascrive la nuova. */
  const richiestaRecenti = useRef(0);

  // «Segna impreparato»
  const [tipoNuovoImpreparato, setTipoNuovoImpreparato] = useState<TipoImpreparato>('impreparato');
  const [motivoImpreparato, setMotivoImpreparato] = useState('');
  const [segnando, setSegnando] = useState(false);
  // L'esito porta l'alunno per cui è partita la POST: sotto un altro alunno non si mostra.
  const [esitoImpreparato, setEsitoImpreparato] = useState<{ testo: string; tipo: 'ok' | 'errore'; alunno: string } | null>(null);

  // form
  const [tipoProva, setTipoProva] = useState('orale');
  const [modalita, setModalita] = useState<'dimensioni' | 'sintetico'>('dimensioni');
  const [autonomia, setAutonomia] = useState(true);
  const [continuita, setContinuita] = useState(true);
  const [tipologia, setTipologia] = useState<'nota' | 'non_nota'>('nota');
  const [risorse, setRisorse] = useState<'interne' | 'esterne' | 'entrambe'>('interne');
  const [giudizioSintetico, setGiudizioSintetico] = useState('');
  const [giudizioTesto, setGiudizioTesto] = useState('');
  const [annotazioneNumerica, setAnnotazioneNumerica] = useState('');
  const [argomento, setArgomento] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetch(`/api/primaria/classe/${sectionId}?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setAlunni(d.data.alunni ?? []);
          setMaterie(d.data.materie ?? []);
        }
      });
  }, [sectionId, userId]);

  // Carica la scala dei giudizi sintetici per la materia/livello.
  const loadScala = useCallback(async () => {
    if (!materiaId) return;
    try {
      const r = await fetch(`/api/primaria/obiettivi?materiaId=${materiaId}&sectionId=${sectionId}&userId=${userId}`);
      const d = await r.json();
      if (d.success) {
        setScala(d.data.scala);
        setScalaValori(d.data.scalaValori ?? []);
        setObiettivi(d.data.obiettivi ?? []);
        setObiettiviSel([]);
        if (d.data.scala.length) setGiudizioSintetico(d.data.scala[0]);
      }
    } finally {
      // nessuno stato di caricamento da azzerare
    }
  }, [materiaId, sectionId, userId]);

  const toggleObiettivo = (id: string) =>
    setObiettiviSel((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  /**
   * «Valutazioni recenti»: le valutazioni dell'alunno nella materia E i suoi
   * impreparati (della materia più quelli senza materia), letti insieme.
   */
  const loadRecenti = useCallback(async () => {
    // Le voci della selezione di prima, con Modifica ed Elimina attivi, non
    // restano sotto il nome dell'alunno nuovo: lo garantisce `recentiDi` al
    // render, mentre la GET è in volo e anche dopo un suo guasto. Anche una
    // selezione svuotata supera la lettura in volo.
    const mia = ++richiestaRecenti.current;
    if (!alunnoId || !materiaId) return;
    const selezione = `${alunnoId}|${materiaId}`;
    const qs = `alunnoId=${alunnoId}&materiaId=${materiaId}&userId=${userId}`;
    const leggi = async () => {
      const [rv, rg] = await Promise.all([
        fetch(`/api/primaria/valutazioni?${qs}`),
        fetch(`/api/primaria/giustifiche-didattiche?sectionId=${sectionId}&${qs}`),
      ]);
      const [dv, dg] = await Promise.all([rv.json(), rg.json()]);
      if (mia !== richiestaRecenti.current) return;
      const okV = rv.ok && dv?.success === true;
      const okG = rg.ok && dg?.success === true;
      setRecenti(okV ? (dv.data ?? []) : []);
      setImpreparati(okG ? (dg.data ?? []) : []);
      setRecentiDi(selezione);
      setPermessiDisponibili((!okV || dv.statoVociDisponibile !== false) && (!okG || dg.statoVociDisponibile !== false));
      setRecentiIncomplete(!okV || !okG);
      if (!okV || !okG) {
        logClient({
          livello: 'error',
          evento: 'fetch',
          messaggio: `valutazioni-recenti-non-caricate: ${okV ? 'valutazioni-ok' : `valutazioni-${rv.status}`} ${okG ? 'impreparati-ok' : `impreparati-${rg.status}`}`,
          route: paginaCorrente(),
          stato: okV ? rg.status : rv.status,
        });
      }
    };
    await leggi().catch((err: unknown) => {
      // Rete giù o corpo non JSON. Si registra sempre; lo stato lo tocca solo
      // se questa è ancora l'ultima lettura: un guasto VECCHIO non accende
      // «incompleto» sopra un elenco nuovo caricato bene.
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `valutazioni-recenti-non-caricate: ${err instanceof Error ? err.name : 'errore'}${mia === richiestaRecenti.current ? '' : ' (superata)'}`,
        route: paginaCorrente(),
      });
      if (mia !== richiestaRecenti.current) return;
      setRecenti([]);
      setImpreparati([]);
      setRecentiDi(selezione);
      setRecentiIncomplete(true);
    });
  }, [alunnoId, materiaId, sectionId, userId]);

  /** Rilegge le «recenti»: gli errori li gestisce `loadRecenti`, qui si chiude la promessa. */
  const ricaricaRecenti = useCallback(() => {
    void loadRecenti();
  }, [loadRecenti]);

  /**
   * Dopo una scrittura asincrona (POST, modifica, eliminazione, sblocco) si rilegge
   * la selezione di ADESSO, non quella del clic: `ricaricaRecenti` catturata prima
   * dell'`await` rileggerebbe l'alunno di prima, marcherebbe le sue voci come
   * ultime e sotto l'alunno a schermo resterebbe un falso «Nessuna valutazione».
   * Il ref si aggiorna in fase di commit (layout), prima di qualunque risposta di
   * rete arrivata dopo il cambio di selezione.
   */
  const ricaricaRef = useRef(ricaricaRecenti);
  useLayoutEffect(() => { ricaricaRef.current = ricaricaRecenti; }, [ricaricaRecenti]);
  const ricaricaSelezioneAttuale = useCallback(() => { ricaricaRef.current(); }, []);

  useEffect(() => { loadScala(); }, [loadScala]);
  useEffect(() => { ricaricaRecenti(); }, [ricaricaRecenti]);

  // Il ruolo serve solo a mostrare «Sblocca» alla Direzione: senza risposta non
  // si mostra (fail-closed), e il gate vero resta sul server.
  useEffect(() => {
    let vivo = true;
    fetch(`/api/primaria/me?userId=${userId}`)
      .then((r) => r.json())
      .then((d) => { if (vivo && d?.success && typeof d.data?.ruolo === 'string') setRuolo(d.data.ruolo); })
      .catch((err) => {
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `valutazioni-ruolo-non-risolto: ${err instanceof Error ? err.name : 'errore'}`,
          route: paginaCorrente(),
        });
      });
    return () => { vivo = false; };
  }, [userId]);

  /** Dopo uno sblocco l'avviso «bloccata» sopra l'elenco è falso: si toglie, poi si rilegge. */
  const dopoSblocco = useCallback(() => {
    setEsitoElenco(null);
    ricaricaSelezioneAttuale();
  }, [ricaricaSelezioneAttuale]);

  // Il docente segna l'alunno selezionato impreparato OGGI (data di Roma), col
  // tipo scelto e il motivo facoltativo; la materia è quella selezionata, se c'è.
  const segnaImpreparato = async () => {
    if (segnando) return;
    // L'alunno al momento del clic: se a schermo cambia mentre la POST è in volo,
    // l'esito resta legato a questo e non compare sotto l'altro bambino.
    const alunnoInviato = alunnoId;
    setEsitoImpreparato(null);
    if (!alunnoInviato) { setEsitoImpreparato({ testo: t('valutazioniMsgSelezionaAlunno'), tipo: 'errore', alunno: alunnoInviato }); return; }
    if (!userId) { setEsitoImpreparato({ testo: t('comuneIdentitaNonRisolta'), tipo: 'errore', alunno: alunnoInviato }); return; }
    setSegnando(true);
    try {
      const motivo = motivoImpreparato.trim();
      const r = await fetch(`/api/primaria/giustifiche-didattiche?userId=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({
          sectionId,
          alunnoId: alunnoInviato,
          materiaId: materiaId || undefined,
          data: dataCivile(),
          tipo: tipoNuovoImpreparato,
          motivo: motivo || undefined,
        }),
      });
      let corpo: unknown = null;
      try {
        corpo = await r.json();
      } catch (errJson) {
        logClient({
          livello: 'warn',
          evento: 'fetch',
          messaggio: `impreparato-segna-risposta-non-json: ${errJson instanceof Error ? errJson.name : 'errore'}`,
          route: paginaCorrente(),
          stato: r.status,
        });
      }
      if (!r.ok) {
        // Il corpo non entra nel log: può riportare il motivo, testo libero su un minore.
        logClient({ livello: 'error', evento: 'fetch', messaggio: 'impreparato-segna-rifiutato', route: paginaCorrente(), stato: r.status });
        setEsitoImpreparato({ testo: messaggioDaCorpo(corpo, t('valutazioniImpreparatoErrore')), tipo: 'errore', alunno: alunnoInviato });
        return;
      }
      setEsitoImpreparato({ testo: t('valutazioniImpreparatoSegnato'), tipo: 'ok', alunno: alunnoInviato });
      setMotivoImpreparato('');
      ricaricaSelezioneAttuale();
    } catch (err) {
      logClient({
        livello: 'error',
        evento: 'fetch',
        messaggio: `impreparato-segna-non-inviato: ${err instanceof Error ? err.name : 'errore'}`,
        route: paginaCorrente(),
      });
      setEsitoImpreparato({ testo: t('valutazioniErroreRete'), tipo: 'errore', alunno: alunnoInviato });
    } finally {
      setSegnando(false);
    }
  };

  const selezioneCorrente = `${alunnoId}|${materiaId}`;
  const recentiDellaSelezione = recentiDi === selezioneCorrente;
  const vociRecenti = recentiDellaSelezione ? unisciVociRecenti(recenti, impreparati) : [];
  // L'esito («Valutazione eliminata ✓») resta per la rilettura che lo segue, ma
  // non sotto un altro alunno o un'altra materia.
  const esitoVisibile = esitoElenco?.selezione === selezioneCorrente ? esitoElenco : null;
  // Lo stesso per «Impreparato segnato ✓»: vale solo per l'alunno per cui è partita la POST.
  const esitoImpreparatoVisibile = esitoImpreparato?.alunno === alunnoId ? esitoImpreparato : null;

  const salva = async () => {
    setMsg('');
    if (!alunnoId || !materiaId) { setMsg(t('valutazioniSelezionaAlunnoMateria')); return; }
    if (!argomento.trim()) { setMsg(t('valutazioniInserisciArgomento')); return; }
    if (!userId) { setMsg(t('comuneIdentitaNonRisolta')); return; }
    // Collegamento obiettivo obbligatorio quando la materia/livello ne ha di configurati (DL-015).
    if (obiettivi.length > 0 && obiettiviSel.length === 0) { setMsg(t('valutazioniCollegaObiettivo')); return; }
    setSaving(true);
    const r = await fetch(`/api/primaria/valutazioni?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({
        alunnoId, sectionId, materiaId, tipoProva, modalita,
        dims: modalita === 'dimensioni' ? { autonomia, continuita, tipologia, risorse } : undefined,
        giudizioSintetico: modalita === 'sintetico' ? giudizioSintetico : undefined,
        giudizioTesto: giudizioTesto || undefined,
        annotazioneNumerica: annotazioneNumerica.trim() ? annotazioneNumerica.replace(',', '.') : undefined,
        argomento: argomento.trim(),
        obiettiviIds: obiettiviSel,
      }),
    });
    const d = await r.json();
    setSaving(false);
    if (!r.ok) setMsg(d.error || t('comuneErrore'));
    else {
      setMsg(t('valutazioniSalvata'));
      setGiudizioTesto('');
      setAnnotazioneNumerica('');
      setArgomento('');
      setObiettiviSel([]);
      ricaricaSelezioneAttuale();
    }
  };

  // Suggerimento (non vincolante) del giudizio a partire dall'annotazione numerica.
  const numAnnot = annotazioneNumerica.trim() === '' ? null : Number(annotazioneNumerica.replace(',', '.'));
  const giudizioSuggerito = numAnnot !== null && !Number.isNaN(numAnnot)
    ? suggerisciGiudizio(scalaValori, numAnnot)
    : null;

  // grid-cols-1 esplicito: minmax(0,1fr) clampa la colonna al contenitore
  // (senza template la colonna auto segue il min-content e sfora a 320px).
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {/* Banner conformità O.M. 3/2025 (DR) */}
      <div className="flex items-start gap-2.5 rounded-xl border border-kidville-warn/25 bg-kidville-warn-soft px-3.5 py-3 md:col-span-2">
        <Lock size={16} className="mt-0.5 shrink-0 text-kidville-warn" />
        <span className="font-maven text-[12px] leading-snug text-kidville-warn">
          {t.rich('valutazioniBanner', { strong: (c) => <strong>{c}</strong> })}
        </span>
      </div>

      <div className="rounded-card bg-white p-5 shadow-sm">
        <h2 className="font-barlow text-lg font-bold text-kidville-ink mb-3 flex items-center gap-2">
          <Star size={18} className="text-kidville-yellow-strong" /> {t('valutazioniTitolo')}
        </h2>

        <div className="grid grid-cols-2 gap-2 mb-3">
          {/* min-w-0: senza, il min-content delle option lunghe sfonda la grid a 320px */}
          <select value={alunnoId} onChange={(e) => setAlunnoId(e.target.value)} className="w-full min-w-0 font-maven rounded-pill border border-kidville-line px-3 py-2 text-sm">
            <option value="">{t('comuneAlunnoPlaceholder')}</option>
            {alunni.map((a) => <option key={a.id} value={a.id}>{a.cognome} {a.nome}</option>)}
          </select>
          <select value={materiaId} onChange={(e) => setMateriaId(e.target.value)} className="w-full min-w-0 font-maven rounded-pill border border-kidville-line px-3 py-2 text-sm">
            <option value="">{t('valutazioniMateriaPlaceholder')}</option>
            {materie.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
          </select>
        </div>

        {obiettivi.length > 0 && (
          <div className="mb-3 rounded-card border border-kidville-green/20 bg-kidville-cream/40 p-3">
            <label className="mb-1.5 block font-maven text-xs font-semibold text-kidville-ink">
              {t('valutazioniObiettiviLabel')} <span className="font-normal text-kidville-muted">{t('valutazioniObiettiviHint')}</span>
            </label>
            <div className="flex flex-col gap-1.5">
              {obiettivi.map((o) => (
                <label key={o.id} className="flex items-start gap-2 font-maven text-sm text-kidville-ink">
                  <input
                    type="checkbox"
                    checked={obiettiviSel.includes(o.id)}
                    onChange={() => toggleObiettivo(o.id)}
                    className="mt-0.5 accent-kidville-green"
                  />
                  <span>{o.codice ? <span className="text-kidville-muted">{o.codice} · </span> : null}{o.descrizione}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="mb-3">
          <label className="block font-maven text-xs text-kidville-muted mb-1">{t('valutazioniTipoProvaLabel')}</label>
          <div className="flex gap-1.5">
            {['orale', 'scritto', 'pratico'].map((tp) => (
              <button key={tp} onClick={() => setTipoProva(tp)} className={`font-maven rounded-pill px-3 py-1 text-xs capitalize ${tipoProva === tp ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream text-kidville-muted'}`}>{t(`valutazioniProva_${tp}`)}</button>
            ))}
          </div>
        </div>

        {/* Annotazione numerica privata (facoltativa) — strumento di lavoro del docente */}
        <div className="mb-3 rounded-card border border-kidville-warn/20 bg-kidville-warn-soft/60 p-3">
          <label className="mb-1 flex items-center gap-1.5 font-maven text-xs text-kidville-ink">
            <Lock size={12} className="text-kidville-warn" /> {t('valutazioniAnnotazioneLabel')}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="number"
              min={0}
              max={10}
              step={0.5}
              value={annotazioneNumerica}
              onChange={(e) => setAnnotazioneNumerica(e.target.value)}
              placeholder={t('valutazioniAnnotazionePlaceholder')}
              className="font-maven w-24 rounded-pill border border-kidville-line px-3 py-2 text-sm"
            />
            {giudizioSuggerito && (
              <div className="flex items-center gap-1.5">
                <span className="font-maven text-xs text-kidville-muted">{t('valutazioniSuggerito')}</span>
                <span className="font-maven rounded-pill border border-kidville-warn/30 bg-white px-2.5 py-1 text-xs font-semibold text-kidville-warn">{giudizioSuggerito}</span>
                <button
                  type="button"
                  onClick={() => { setModalita('sintetico'); setGiudizioSintetico(giudizioSuggerito); }}
                  className="font-maven rounded-pill bg-kidville-green px-3 py-1 text-xs text-kidville-yellow"
                >
                  {t('valutazioniUsa')}
                </button>
              </div>
            )}
          </div>
          <p className="mt-1 font-maven text-[11px] text-kidville-muted">
            {t('valutazioniAnnotazioneNota')}
          </p>
        </div>

        <div className="mb-3 flex gap-1.5">
          <button onClick={() => setModalita('dimensioni')} className={`font-maven rounded-pill px-3 py-1.5 text-xs ${modalita === 'dimensioni' ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream text-kidville-muted'}`}>{t('valutazioniPerDimensioni')}</button>
          <button onClick={() => setModalita('sintetico')} className={`font-maven rounded-pill px-3 py-1.5 text-xs ${modalita === 'sintetico' ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-cream text-kidville-muted'}`}>{t('valutazioniGiudizioSintetico')}</button>
        </div>

        {modalita === 'dimensioni' ? (
          <div className="space-y-2 rounded-card bg-kidville-cream/40 p-3 mb-3">
            <DimToggle label={t('valutazioniDimAutonomia')} value={autonomia} options={[{ label: t('comuneSi'), value: true }, { label: t('comuneNo'), value: false }]} onChange={(v) => setAutonomia(v as boolean)} />
            <DimToggle label={t('valutazioniDimContinuita')} value={continuita} options={[{ label: t('comuneSi'), value: true }, { label: t('comuneNo'), value: false }]} onChange={(v) => setContinuita(v as boolean)} />
            <DimToggle label={t('valutazioniDimTipologia')} value={tipologia} options={[{ label: t('valutazioniTipologiaNota'), value: 'nota' }, { label: t('valutazioniTipologiaNonNota'), value: 'non_nota' }]} onChange={(v) => setTipologia(v as 'nota' | 'non_nota')} />
            <DimToggle label={t('valutazioniDimRisorse')} value={risorse} options={[{ label: t('valutazioniRisorseInterne'), value: 'interne' }, { label: t('valutazioniRisorseEsterne'), value: 'esterne' }, { label: t('valutazioniRisorseEntrambe'), value: 'entrambe' }]} onChange={(v) => setRisorse(v as 'interne' | 'esterne' | 'entrambe')} />
            <textarea
              value={giudizioTesto}
              onChange={(e) => setGiudizioTesto(e.target.value)}
              rows={2}
              placeholder={t('valutazioniPlaceholderDescrittivo')}
              className="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm"
            />
          </div>
        ) : (
          <div className="mb-3">
            <label className="block font-maven text-xs text-kidville-muted mb-1">{t('valutazioniGiudizioSintetico')}</label>
            <select value={giudizioSintetico} onChange={(e) => setGiudizioSintetico(e.target.value)} className="font-maven w-full rounded-pill border border-kidville-line px-3 py-2 text-sm">
              {scala.map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>
        )}

        <div className="mb-3">
          <label className="block font-maven text-xs text-kidville-muted mb-1">{t('valutazioniArgomentoLabel')}</label>
          <input
            type="text"
            value={argomento}
            onChange={(e) => setArgomento(e.target.value)}
            placeholder={t('valutazioniArgomentoPlaceholder')}
            className="font-maven w-full rounded-pill border border-kidville-line px-3 py-2 text-sm"
          />
        </div>

        {msg && <p className={`font-maven text-sm mb-2 ${msg.includes('✓') ? 'text-kidville-success' : 'text-kidville-error'}`}>{msg}</p>}
        <button onClick={salva} disabled={saving} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-5 py-2 text-sm text-kidville-yellow disabled:opacity-50">
          <Check size={15} /> {saving ? t('comuneSalvataggio') : t('valutazioniSalvaValutazione')}
        </button>
      </div>

      <div className="rounded-card bg-white p-5 shadow-sm">
        <h3 className="font-barlow text-base font-bold text-kidville-ink mb-3">{t('valutazioniRecentiTitolo')}</h3>
        {!alunnoId || !materiaId ? (
          <p className="font-maven text-sm text-kidville-muted">{t('valutazioniRecentiVuoto')}</p>
        ) : (
          <>
            {recentiDellaSelezione && recentiIncomplete && (
              <p role="alert" className="mb-2 font-maven text-xs text-kidville-error">{t('valutazioniRecentiIncomplete')}</p>
            )}
            {!permessiDisponibili && vociRecenti.length > 0 && (
              <p className="mb-2 font-maven text-xs text-kidville-warn">{t('valutazioniAzioniNonDisponibili')}</p>
            )}
            {esitoVisibile && (
              <p
                role={esitoVisibile.tipo === 'errore' ? 'alert' : 'status'}
                className={`mb-2 font-maven text-sm ${esitoVisibile.tipo === 'ok' ? 'text-kidville-success' : 'text-kidville-error'}`}
              >
                {esitoVisibile.testo}
              </p>
            )}
            <ul className="divide-y divide-kidville-line">
              {vociRecenti.map((voce) => {
                const azioni = (
                  <AzioniVoce
                    voce={voce}
                    userId={userId ?? ''}
                    ruolo={ruolo}
                    permessiDisponibili={permessiDisponibili && !!userId}
                    scala={scala}
                    obiettivi={obiettivi}
                    materie={materie}
                    onCambiato={ricaricaSelezioneAttuale}
                    onEsito={(testo, tipo) => setEsitoElenco({ testo, tipo, selezione: selezioneCorrente })}
                    onApri={() => setEsitoElenco(null)}
                    onSbloccato={dopoSblocco}
                  />
                );
                if (voce.genere === 'impreparato') {
                  const g = voce.voce;
                  const tipo = tipoImpreparato(g);
                  return (
                    <li key={`impreparato-${g.id}`} className="py-2.5" data-testid={`voce-impreparato-${g.id}`}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-maven rounded-pill bg-kidville-warn-soft px-2 py-0.5 text-xs font-semibold text-kidville-warn">
                          {t(`valutazioniImpreparatoTipo_${tipo}`)}
                        </span>
                        <span className={`font-maven rounded-pill px-2 py-0.5 text-[11px] ${g.origine === 'genitore' ? 'bg-kidville-info-soft text-kidville-info' : 'bg-kidville-cream text-kidville-sub'}`}>
                          {g.origine === 'genitore' ? t('valutazioniDalGenitore') : t('valutazioniDalDocente')}
                        </span>
                        <span className="text-xs text-kidville-sub">{f.dataBreve(g.data)}</span>
                      </div>
                      {g.motivo && <p className="font-maven text-xs text-kidville-sub mt-0.5">{g.motivo}</p>}
                      {azioni}
                    </li>
                  );
                }
                const v = voce.voce;
                return (
                  <li key={`valutazione-${v.id}`} className="py-2.5" data-testid={`voce-valutazione-${v.id}`}>
                    <div className="flex items-center gap-2">
                      <span className="font-maven text-sm font-semibold text-kidville-green">
                        {v.giudizio_sintetico || (v.modalita === 'dimensioni' ? t('valutazioniPerDimensioni') : '—')}
                      </span>
                      <span className="text-xs text-kidville-sub capitalize">{v.tipo}</span>
                      {v.annotazione_numerica !== null && v.annotazione_numerica !== undefined && (
                        <span
                          title={t('valutazioniAnnotazionePrivataTitle')}
                          className="font-maven rounded-pill border border-kidville-warn/20 bg-kidville-warn-soft px-2 py-0.5 text-[11px] text-kidville-warn"
                        >
                          ✎ {String(v.annotazione_numerica).replace('.', ',')}
                        </span>
                      )}
                      <span className="text-xs text-kidville-sub">{f.dataBreve(v.creato_il)}</span>
                    </div>
                    {v.argomento && <p className="font-maven text-xs text-kidville-ink mt-0.5"><span className="text-kidville-sub">{t('valutazioniArgomentoRecente')}</span> {v.argomento}</p>}
                    {v.giudizio_testo && <p className="font-maven text-xs text-kidville-sub mt-0.5">{v.giudizio_testo}</p>}
                    {azioni}
                  </li>
                );
              })}
              {vociRecenti.length === 0 && <li className="py-2 font-maven text-sm text-kidville-sub">{t('valutazioniNessunaValutazione')}</li>}
            </ul>
          </>
        )}
      </div>

      {/* «Segna impreparato»: solo la creazione. L'elenco sta nelle «Valutazioni
          recenti» (alunno e materia scelti), con Modifica/Elimina: un secondo
          elenco qui sarebbe un doppione. */}
      <div className="rounded-card bg-white p-5 shadow-sm md:col-span-2">
        <h3 className="font-barlow text-base font-bold text-kidville-ink">{t('valutazioniImpreparatiTitolo')}</h3>
        <p className="mt-0.5 mb-3 font-maven text-xs text-kidville-sub">{t('valutazioniImpreparatiHint')}</p>
        <p className="mb-1 font-maven text-xs text-kidville-sub">{t('valutazioniImpreparatoTipoLabel')}</p>
        <SceltaTipoImpreparato
          valore={tipoNuovoImpreparato}
          onScegli={setTipoNuovoImpreparato}
          etichetta={t('valutazioniImpreparatoTipoLabel')}
        />
        <label htmlFor="impreparato-motivo" className="mt-3 block font-maven text-xs text-kidville-sub">
          {t('valutazioniImpreparatoMotivoLabel')}
        </label>
        <input
          id="impreparato-motivo"
          type="text"
          value={motivoImpreparato}
          onChange={(e) => setMotivoImpreparato(e.target.value)}
          maxLength={MOTIVO_MAX_CARATTERI}
          className="font-maven mt-1 mb-3 w-full rounded-pill border border-kidville-line px-3 py-2 text-sm"
        />
        {esitoImpreparatoVisibile && (
          <p
            role={esitoImpreparatoVisibile.tipo === 'errore' ? 'alert' : 'status'}
            className={`mb-2 font-maven text-sm ${esitoImpreparatoVisibile.tipo === 'ok' ? 'text-kidville-success' : 'text-kidville-error'}`}
          >
            {esitoImpreparatoVisibile.testo}
          </p>
        )}
        <button
          type="button"
          onClick={() => void segnaImpreparato()}
          aria-disabled={segnando}
          className="font-maven rounded-pill bg-kidville-warn-soft px-3 py-1.5 text-xs text-kidville-warn"
        >
          {segnando ? t('comuneSalvataggio') : t('valutazioniSegnaImpreparato')}
        </button>
      </div>
    </div>
  );
}

// L'etichetta del pulsante è tradotta (opt.label), ma l'evidenziazione dello stato
// attivo confronta SOLO opt.value col value corrente (il valore effettivo dello stato):
// così la traccia visiva resta corretta a prescindere dalla lingua del testo mostrato.
function DimToggle({ label, value, options, onChange }: {
  label: string; value: unknown; options: { label: string; value: unknown }[]; onChange: (v: unknown) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-y-1">
      <span className="font-maven text-sm text-kidville-ink">{label}</span>
      <div className="flex flex-wrap justify-end gap-1">
        {options.map((opt) => {
          const active = String(opt.value) === String(value);
          return (
            <button key={String(opt.value)} onClick={() => onChange(opt.value)} className={`font-maven rounded-pill px-2.5 py-1 text-xs ${active ? 'bg-kidville-green text-kidville-yellow' : 'bg-white text-kidville-muted border border-kidville-line'}`}>{opt.label}</button>
          );
        })}
      </div>
    </div>
  );
}
