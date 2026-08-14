'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileText, HeartPulse, PenLine, Search, X, AlertCircle, Download } from 'lucide-react';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { useDateFormat } from '@/lib/i18n/date';
import { TABLE, TABLE_WRAP, TD, TH, TONE } from '@/components/ui/cockpit';
import type { DocumentoAlunno } from '@/lib/documenti/registro';

/**
 * L'archivio dei documenti di ogni alunno — una schermata sola, usata sia dalla
 * segreteria sia dalle insegnanti.
 *
 * Il perimetro NON lo decide questo componente: lo decide la route. Un'insegnante
 * riceve già solo i bambini delle proprie sezioni, e i documenti sanitari solo di
 * quelli di cui è contitolare. Qui non c'è nessun ramo «se sei admin allora…»,
 * ed è voluto: un filtro di visibilità scritto nel browser è un filtro che si
 * disattiva con gli strumenti da sviluppatore.
 */

interface AlunnoElenco {
  id: string;
  nome: string | null;
  cognome: string | null;
  classe_sezione: string | null;
  section_id: string | null;
  scuola_id: string | null;
}

interface RispostaElenco {
  success?: boolean;
  data?: DocumentoAlunno[];
  alunni?: AlunnoElenco[];
  riepilogo?: { totale: number; firmati: number; sanitari: number; inScadenza: number };
  totale?: number;
  troncato?: boolean;
  fonti_cadute?: string[];
  error?: string;
}

/**
 * La chiamata sta FUORI dal componente ed è `async` per un motivo preciso:
 * `fetch` può lanciare in modo sincrono (URL malformato), e allora il `try` che
 * lo racchiude verrebbe eseguito sincronicamente dentro l'effetto — che è ciò
 * che `react-hooks/set-state-in-effect` vieta. Chiamare una funzione `async`
 * trasforma qualunque guasto in una promise respinta: nessun ramo sincrono.
 */
async function richiedi<T>(url: string, userId: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { 'x-user-id': userId } });
    return (await res.json().catch(() => null)) as T | null;
  } catch {
    // Il guasto di rete si trasforma in `null` QUI, fuori dal componente, così
    // chi chiama usa un `try/finally` senza `catch`: un `catch` con setState nel
    // corpo di una funzione chiamata da un effetto resta un ramo sincrono, e la
    // regola `set-state-in-effect` lo respinge. `null` diventa il messaggio
    // d'errore in pagina — nessun errore viene ingoiato.
    return null;
  }
}

interface Dettaglio {
  id: string;
  fonte: string;
  categoria: 'sanitario' | 'amministrativo';
  titolo?: string;
  url?: string | null;
  fileAssente?: boolean;
  risposte?: Record<string, unknown> | null;
  firma?: Record<string, unknown> | null;
  firmatoIl?: string | null;
  descrizione?: string | null;
  fileName?: string | null;
  dal?: string | null;
  al?: string | null;
  stato?: string | null;
}

export function DocumentiFirmatiPanel({ conFiltroSede = false }: { conFiltroSede?: boolean }) {
  const t = useTranslations('documenti');
  const { dataBreve } = useDateFormat();
  const { userId, ready } = useSessionIdentity();

  const [documenti, setDocumenti] = useState<DocumentoAlunno[]>([]);
  const [alunni, setAlunni] = useState<AlunnoElenco[]>([]);
  const [riepilogo, setRiepilogo] = useState({ totale: 0, firmati: 0, sanitari: 0, inScadenza: 0 });
  const [totale, setTotale] = useState(0);
  const [troncato, setTroncato] = useState(false);
  const [fontiCadute, setFontiCadute] = useState<string[]>([]);
  const [caricamento, setCaricamento] = useState(true);
  const [errore, setErrore] = useState<string | null>(null);

  const [classe, setClasse] = useState('');
  const [alunnoId, setAlunnoId] = useState('');
  const [categoria, setCategoria] = useState('');
  const [soloFirmati, setSoloFirmati] = useState(false);
  const [ricerca, setRicerca] = useState('');

  const [dettaglio, setDettaglio] = useState<Dettaglio | null>(null);
  const [dettaglioInCorso, setDettaglioInCorso] = useState(false);

  const carica = useCallback(async () => {
    // Finché l'identità non è risolta non si chiede niente: `ready` distingue
    // «non lo so ancora» da «non c'è nessuno», e senza questa riga la prima
    // chiamata partirebbe senza `x-user-id` prendendosi un 401 evitabile.
    if (!ready || !userId) return;
    // Niente `setCaricamento(true)` qui: sarebbe un setState SINCRONO dentro
    // l'effetto che chiama questa funzione, e la regola `set-state-in-effect`
    // lo vieta — a ragione, perché innesca render a cascata. Lo stato parte già
    // acceso e si spegne nel `finally`, come nel resto del cockpit.
    // I parametri si compongono PRIMA del try: dentro, il primo statement deve
    // essere l'`await`, o `catch`/`finally` — che chiamano setState — tornano a
    // essere raggiungibili in modo sincrono dall'effetto.
    const p = new URLSearchParams();
    if (classe) p.set('classe', classe);
    if (alunnoId) p.set('alunnoId', alunnoId);
    if (categoria) p.set('categoria', categoria);
    if (soloFirmati) p.set('soloFirmati', '1');
    if (ricerca.trim()) p.set('ricerca', ricerca.trim());

    try {
      const json = await richiedi<RispostaElenco>(`/api/documenti-firmati?${p.toString()}`, userId);
      if (!json?.success) {
        setErrore(json?.error ?? t('erroreCaricamento'));
        setDocumenti([]);
        return;
      }
      setErrore(null);
      setDocumenti(json.data ?? []);
      setAlunni(json.alunni ?? []);
      setRiepilogo(json.riepilogo ?? { totale: 0, firmati: 0, sanitari: 0, inScadenza: 0 });
      setTotale(json.totale ?? (json.data?.length ?? 0));
      setTroncato(!!json.troncato);
      setFontiCadute(json.fonti_cadute ?? []);
    } finally {
      // `finally`, non `catch`: se il caricamento resta acceso su un errore, la
      // schermata mente dicendo che sta ancora lavorando.
      setCaricamento(false);
    }
  }, [ready, userId, classe, alunnoId, categoria, soloFirmati, ricerca, t]);

  useEffect(() => {
    carica();
  }, [carica]);

  const apri = useCallback(
    async (doc: DocumentoAlunno) => {
      if (!userId) return;
      setDettaglioInCorso(true);
      setDettaglio(null);
      try {
        const p = new URLSearchParams({ fonte: doc.fonte, id: doc.rifId });
        const json = await richiedi<{ success?: boolean; data?: Dettaglio; error?: string }>(
          `/api/documenti-firmati/dettaglio?${p.toString()}`,
          userId,
        );
        if (json?.success && json.data) setDettaglio(json.data);
        else setErrore(json?.error ?? t('erroreCaricamento'));
      } catch {
        setErrore(t('erroreCaricamento'));
      } finally {
        setDettaglioInCorso(false);
      }
    },
    [userId, t],
  );

  const nomeAlunno = useCallback(
    (id: string) => {
      const a = alunni.find((x) => x.id === id);
      if (!a) return '—';
      return [a.cognome, a.nome].filter(Boolean).join(' ') || '—';
    },
    [alunni],
  );

  const classi = useMemo(() => {
    const set = new Set<string>();
    for (const a of alunni) if (a.classe_sezione) set.add(a.classe_sezione);
    return [...set].sort((x, y) => x.localeCompare(y, 'it'));
  }, [alunni]);

  const alunniOrdinati = useMemo(
    () =>
      [...alunni].sort((a, b) =>
        `${a.cognome ?? ''} ${a.nome ?? ''}`.localeCompare(`${b.cognome ?? ''} ${b.nome ?? ''}`, 'it'),
      ),
    [alunni],
  );

  return (
    <div className="space-y-4">
      {/* Riepilogo */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Contatore icona={FileText} etichetta={t('totale')} valore={riepilogo.totale} />
        <Contatore icona={PenLine} etichetta={t('firmati')} valore={riepilogo.firmati} />
        <Contatore icona={HeartPulse} etichetta={t('sanitari')} valore={riepilogo.sanitari} tono="warn" />
        <Contatore icona={AlertCircle} etichetta={t('conScadenza')} valore={riepilogo.inScadenza} tono="info" />
      </div>

      {/* Filtri */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-kidville-line bg-kidville-white p-3">
        <div className="relative min-w-[200px] flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-kidville-sub" />
          <input
            type="search"
            value={ricerca}
            onChange={(e) => setRicerca(e.target.value)}
            placeholder={t('filtroRicerca')}
            aria-label={t('filtroRicerca')}
            className="w-full rounded-pill border border-kidville-line py-2 pl-9 pr-3 text-sm text-kidville-ink"
          />
        </div>

        <Selettore
          etichetta={t('filtroClasse')}
          value={classe}
          onChange={setClasse}
          opzioni={[{ value: '', label: t('tutte') }, ...classi.map((c) => ({ value: c, label: c }))]}
        />

        <Selettore
          etichetta={t('filtroAlunno')}
          value={alunnoId}
          onChange={setAlunnoId}
          opzioni={[
            { value: '', label: t('tutti') },
            ...alunniOrdinati.map((a) => ({
              value: a.id,
              label: [a.cognome, a.nome].filter(Boolean).join(' ') || a.id,
            })),
          ]}
        />

        <Selettore
          etichetta={t('filtroCategoria')}
          value={categoria}
          onChange={setCategoria}
          opzioni={[
            { value: '', label: t('tutti') },
            { value: 'amministrativo', label: t('categoriaAmministrativo') },
            { value: 'sanitario', label: t('categoriaSanitario') },
          ]}
        />

        <label className="flex items-center gap-2 px-2 text-sm text-kidville-ink">
          <input
            type="checkbox"
            checked={soloFirmati}
            onChange={(e) => setSoloFirmati(e.target.checked)}
            className="h-4 w-4 accent-kidville-green"
          />
          {t('soloFirmati')}
        </label>
      </div>

      {conFiltroSede && (
        <p className="text-xs text-kidville-sub">{t('filtroSede')}: {t('tutte')}</p>
      )}

      {troncato && (
        <p className="rounded-xl border border-kidville-yellow bg-kidville-cream px-3 py-2 text-sm text-kidville-ink">
          {t('troncato', { mostrati: documenti.length, totale })}
        </p>
      )}

      {fontiCadute.length > 0 && (
        <p className="rounded-xl border border-kidville-yellow bg-kidville-cream px-3 py-2 text-sm text-kidville-ink">
          {t('fontiCadute')}
        </p>
      )}

      {errore && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span>{errore}</span>
          <button type="button" onClick={() => void carica()} className="font-bold underline">
            {t('riprova')}
          </button>
        </div>
      )}

      {/* Elenco */}
      {ready && !userId ? (
        <p className="py-8 text-center text-sm text-kidville-sub">{t('erroreCaricamento')}</p>
      ) : caricamento ? (
        <p className="py-8 text-center text-sm text-kidville-sub">{t('caricamento')}</p>
      ) : documenti.length === 0 && !errore ? (
        <div className="rounded-2xl border border-dashed border-kidville-line px-6 py-10 text-center">
          <FileText size={28} className="mx-auto mb-3 text-kidville-sub" />
          <p className="font-barlow text-base font-bold text-kidville-ink">{t('vuotoTitolo')}</p>
          <p className="mx-auto mt-1 max-w-xl text-sm text-kidville-sub">{t('vuotoTesto')}</p>
        </div>
      ) : (
        <div className={TABLE_WRAP}>
          <table className={TABLE}>
            <thead>
              <tr>
                <th className={TH}>{t('colonnaAlunno')}</th>
                <th className={TH}>{t('colonnaDocumento')}</th>
                <th className={TH}>{t('colonnaTipo')}</th>
                <th className={TH}>{t('colonnaStato')}</th>
                <th className={TH}>{t('colonnaScadenza')}</th>
                <th className={TH} aria-label={t('apri')} />
              </tr>
            </thead>
            <tbody>
              {documenti.map((d) => (
                <tr key={d.id}>
                  <td className={TD}>
                    <span className="font-semibold text-kidville-ink">{nomeAlunno(d.alunnoId)}</span>
                  </td>
                  <td className={TD}>{d.titolo}</td>
                  <td className={TD}>
                    <span
                      className={`inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[12px] font-bold ${
                        d.categoria === 'sanitario'
                          ? `${TONE.warn.chipBg} ${TONE.warn.text}`
                          : `${TONE.neutral.chipBg} ${TONE.neutral.text}`
                      }`}
                    >
                      {d.categoria === 'sanitario' && <HeartPulse size={12} />}
                      {d.categoria === 'sanitario' ? t('categoriaSanitario') : t('categoriaAmministrativo')}
                    </span>
                  </td>
                  <td className={TD}>
                    {d.firmato ? (
                      <span className={`inline-flex items-center gap-1 font-semibold ${TONE.success.text}`}>
                        <PenLine size={13} />
                        {t('statoFirmato')}
                        {d.firmatoIl ? ` · ${dataBreve(d.firmatoIl)}` : ''}
                      </span>
                    ) : (
                      <span className="text-kidville-sub">
                        {d.fonte === 'modulo_firmato' ? t('statoNonFirmato') : t('statoCaricato')}
                      </span>
                    )}
                  </td>
                  <td className={TD}>{d.scadeIl ? dataBreve(d.scadeIl) : '—'}</td>
                  <td className={TD}>
                    <button
                      type="button"
                      onClick={() => void apri(d)}
                      className="rounded-pill border border-kidville-green px-3 py-1 text-[13px] font-bold text-kidville-green transition-colors hover:bg-kidville-green hover:text-kidville-white"
                    >
                      {t('apri')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(dettaglio || dettaglioInCorso) && (
        <PannelloDettaglio
          dettaglio={dettaglio}
          inCorso={dettaglioInCorso}
          onChiudi={() => setDettaglio(null)}
        />
      )}
    </div>
  );
}

function Contatore({
  icona: Icona,
  etichetta,
  valore,
  tono = 'green',
}: {
  icona: typeof FileText;
  etichetta: string;
  valore: number;
  tono?: 'green' | 'warn' | 'info';
}) {
  return (
    <div className={`rounded-2xl border ${TONE[tono].border} bg-kidville-white p-3`}>
      <div className="flex items-center gap-2">
        <Icona size={16} className={TONE[tono].text} />
        <span className="font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
          {etichetta}
        </span>
      </div>
      <p className="mt-1 font-barlow text-2xl font-black text-kidville-ink">{valore}</p>
    </div>
  );
}

function Selettore({
  etichetta,
  value,
  onChange,
  opzioni,
}: {
  etichetta: string;
  value: string;
  onChange: (v: string) => void;
  opzioni: { value: string; label: string }[];
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="sr-only">{etichetta}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={etichetta}
        className="rounded-pill border border-kidville-line px-3 py-2 text-sm text-kidville-ink"
      >
        {opzioni.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function PannelloDettaglio({
  dettaglio,
  inCorso,
  onChiudi,
}: {
  dettaglio: Dettaglio | null;
  inCorso: boolean;
  onChiudi: () => void;
}) {
  const t = useTranslations('documenti');

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-6">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl bg-kidville-white p-5 sm:rounded-3xl">
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="font-barlow text-lg font-black text-kidville-ink">
            {dettaglio?.titolo ?? t('dettaglioTitolo')}
          </h2>
          <button type="button" onClick={onChiudi} aria-label={t('chiudi')} className="rounded-full p-1 text-kidville-sub hover:bg-kidville-cream">
            <X size={20} />
          </button>
        </div>

        {inCorso && <p className="py-6 text-center text-sm text-kidville-sub">{t('caricamento')}</p>}

        {dettaglio && (
          <div className="space-y-4">
            {dettaglio.categoria === 'sanitario' && (
              <p className="flex items-center gap-2 rounded-xl border border-kidville-yellow bg-kidville-cream px-3 py-2 text-sm text-kidville-ink">
                <HeartPulse size={16} /> {t('sanitarioAvviso')}
              </p>
            )}

            {dettaglio.url && (
              <a
                href={dettaglio.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-pill bg-kidville-green px-4 py-2 font-barlow text-sm font-bold uppercase text-kidville-white"
              >
                <Download size={16} /> {t('scarica')}
              </a>
            )}

            {dettaglio.fileAssente && dettaglio.fonte !== 'modulo_firmato' && (
              <p className="rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
                {t('dettaglioFileMancante')}
              </p>
            )}

            {dettaglio.fonte === 'modulo_firmato' && (
              <p className="rounded-xl border border-kidville-line bg-kidville-cream px-3 py-2 text-sm text-kidville-ink">
                {t('dettaglioNessunFile')}
              </p>
            )}

            {dettaglio.firma && (
              <section>
                <h3 className="mb-1 font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
                  {t('dettaglioFirma')}
                </h3>
                <dl className="rounded-xl border border-kidville-line p-3 text-sm">
                  {Object.entries(dettaglio.firma).map(([k, v]) => (
                    <div key={k} className="flex gap-2 py-0.5">
                      <dt className="min-w-[110px] text-kidville-sub">{k}</dt>
                      <dd className="text-kidville-ink">{String(v)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {dettaglio.risposte && typeof dettaglio.risposte === 'object' && (
              <section>
                <h3 className="mb-1 font-barlow text-[12px] font-bold uppercase tracking-[0.06em] text-kidville-sub">
                  {t('dettaglioRisposte')}
                </h3>
                <dl className="rounded-xl border border-kidville-line p-3 text-sm">
                  {Object.entries(dettaglio.risposte as Record<string, unknown>).map(([k, v]) => (
                    <div key={k} className="flex gap-2 py-0.5">
                      <dt className="min-w-[110px] text-kidville-sub">{k}</dt>
                      <dd className="text-kidville-ink">
                        {typeof v === 'boolean' ? (v ? '✓' : '—') : String(v ?? '—')}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
