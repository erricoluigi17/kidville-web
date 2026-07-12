'use client';

/**
 * REGISTRO PROTOCOLLI (spec docs/superpowers/specs/2026-07-12-registro-protocolli-design.md)
 * Cockpit admin+segreteria: registrazioni immutabili con numero 0000042/2026,
 * fascia di segnatura sul PDF, originale+timbrato scaricabili, categorie,
 * allegati, emergenza, collegamenti, generatore documenti su richiesta.
 * Flusso "Protocolla documento" in 3 passi guidati; upload DIRETTO allo
 * storage via URL firmato (file fino a 25 MB). Eliminazione totale solo admin.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Stamp, Inbox, Send, RefreshCw, Hash, Plus, FileText, Download, ShieldCheck,
  AlertTriangle, Search, Trash2, Ban, Link2, Paperclip, Settings2, X, FileDown,
  FileSpreadsheet, Loader2, CheckCircle2, UploadCloud, Siren,
} from 'lucide-react';
import {
  CockpitPage, PageHeader, StatCard, Drawer, Toolbar, CockpitSelect,
  TABLE, TABLE_WRAP, TD, TH, TROW, Toggle,
} from '@/components/ui/cockpit';
import { SaveCheck } from '@/components/ui/SaveConfirmation';
import { DateField } from '@/components/ui/DateField';
import { useSessionIdentity } from '@/lib/auth/use-session-identity';
import { useAdminIdentity } from '@/lib/context/admin-identity';
import { cx } from '@/lib/ui/cx';

// ============================ Tipi ============================
type TipoProt = 'ingresso' | 'uscita' | 'interno';

interface Categoria { id: string; nome: string; ordine: number; attivo: boolean }
interface AllegatoRec { id: string; nome: string; mime: string | null; size: number | null; ordine: number }
interface RifProt { id: string; anno: number; numero: number; tipo: TipoProt; oggetto: string }
interface Protocollo {
  id: string; anno: number; numero: number; tipo: TipoProt; data_registrazione: string;
  oggetto: string; mittente: string | null; destinatario: string | null; mezzo: string | null;
  rif_prot_mittente: string | null; rif_data_mittente: string | null; impronta_sha256: string;
  categoria_id: string | null; collegato_a_id: string | null; note_interne: string | null;
  emergenza: boolean; emergenza_dichiarata_il: string | null;
  annullata_at: string | null; annullo_motivo: string | null;
  file_nome_originale: string | null; allegati_descrizione: string | null;
  categoria: { id: string; nome: string } | null;
  allegati: AllegatoRec[] | null;
  collegato?: RifProt | null; risposte?: RifProt[];
}
interface Stats { totale: number; ingresso: number; uscita: number; interno: number; annullate: number; ultimoNumero: number }
interface Alunno { id: string; nome: string; cognome: string; classe_sezione: string | null }

const STATS_ZERO: Stats = { totale: 0, ingresso: 0, uscita: 0, interno: 0, annullate: 0, ultimoNumero: 0 };

// ============================ Helper ============================
function urlP(userId: string | null, path: string) {
  const base = `/api/admin/protocolli${path ? `/${path}` : ''}`;
  return `${base}${userId ? `${base.includes('?') || path.includes('?') ? '&' : '?'}userId=${encodeURIComponent(userId)}` : ''}`;
}
async function jfull<T = Record<string, unknown>>(userId: string | null, path: string): Promise<T | null> {
  try { const r = await fetch(urlP(userId, path)); return r.ok ? ((await r.json()) as T) : null; } catch { return null; }
}
async function jsend(userId: string | null, path: string, method: string, body?: unknown): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const r = await fetch(urlP(userId, path), {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, data: j.data, error: j.error };
  } catch { return { ok: false, error: 'Errore di rete' }; }
}

const MIME_OK = ['application/pdf', 'image/jpeg', 'image/png'];
const EXT_MIME: Record<string, string> = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
function mimeDaFile(f: File): string | null {
  if (MIME_OK.includes(f.type)) return f.type;
  const ext = (f.name.split('.').pop() ?? '').toLowerCase();
  return EXT_MIME[ext] ?? null;
}
const MAX_MB = 25;

function numeroFmt(numero: number, anno: number) { return `${String(numero).padStart(7, '0')}/${anno}`; }
function dataIt(s?: string | null) { return s ? new Date(s).toLocaleDateString('it-IT') : ''; }
function oraIt(s?: string | null) { return s ? new Date(s).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : ''; }

const TIPO_LABEL: Record<TipoProt, string> = { ingresso: 'In arrivo', uscita: 'In partenza', interno: 'Interno' };
const TIPO_BADGE: Record<TipoProt, string> = {
  ingresso: 'bg-kidville-info-soft text-kidville-info',
  uscita: 'bg-kidville-green-soft text-kidville-green',
  interno: 'bg-kidville-neutral-soft text-kidville-neutral',
};
const MEZZI = ['PEC', 'Email', 'Consegna a mano', 'Posta ordinaria', 'Posta raccomandata', 'Fax', 'Altro'];

// piccoli mattoni UI (stesse costanti del cockpit merchandise)
const CARD = 'rounded-card bg-kidville-white p-4 shadow-sm';
const INPUT = 'w-full rounded-input border border-kidville-line px-3 py-2 font-maven text-sm text-kidville-ink outline-none focus:border-kidville-green';
const LABEL = 'font-maven text-xs font-semibold text-kidville-ink/70';
const BTN_PRIMARY = 'inline-flex items-center justify-center gap-2 rounded-pill bg-kidville-green px-4 py-2.5 font-barlow text-sm font-bold uppercase text-kidville-yellow transition-all active:scale-[0.98] disabled:opacity-50';
const BTN_GHOST = 'inline-flex items-center gap-1.5 rounded-pill border border-kidville-line px-3 py-1.5 font-maven text-xs font-semibold text-kidville-ink/80 hover:border-kidville-green disabled:opacity-50';
const BTN_DANGER = 'inline-flex items-center gap-1.5 rounded-pill border border-kidville-error px-3 py-1.5 font-maven text-xs font-semibold text-kidville-error hover:bg-kidville-error-soft disabled:opacity-50';

function Spinner({ label = 'Caricamento…' }: { label?: string }) {
  return <div className="flex items-center gap-3 py-6"><div className="h-5 w-5 animate-spin rounded-full border-[3px] border-kidville-green/20 border-t-kidville-green" /><p className="font-maven text-sm text-kidville-muted">{label}</p></div>;
}

/** Indicatore di passo del wizard "Protocolla documento". */
function PassoDot({ corrente, n, label }: { corrente: number; n: number; label: string }) {
  return (
    <div className={cx('flex items-center gap-1.5', corrente === n ? 'text-kidville-green' : 'text-kidville-neutral')}>
      <span className={cx('flex h-6 w-6 items-center justify-center rounded-pill font-barlow text-[12px] font-black', corrente >= n ? 'bg-kidville-green text-kidville-yellow' : 'bg-kidville-neutral-soft text-kidville-neutral')}>{n}</span>
      <span className="font-barlow text-[12px] font-bold uppercase">{label}</span>
    </div>
  );
}

/** Coppia etichetta/valore della scheda di dettaglio. */
function Campo({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="font-barlow text-[11px] font-bold uppercase tracking-[0.05em] text-kidville-neutral">{label}</div>
      <div className="font-maven text-sm text-kidville-ink">{value ?? '—'}</div>
    </div>
  );
}
function TipoBadge({ tipo }: { tipo: TipoProt }) {
  return <span className={cx('whitespace-nowrap rounded-pill px-2 py-0.5 font-maven text-[11px] font-semibold', TIPO_BADGE[tipo])}>{TIPO_LABEL[tipo]}</span>;
}

// ============================ Upload diretto ============================
async function caricaSuStaging(userId: string | null, file: File, scopo: 'principale' | 'allegato'): Promise<{ path: string } | { error: string }> {
  const mime = mimeDaFile(file);
  if (!mime) return { error: 'Formato non ammesso: carica un PDF o una foto JPG/PNG' };
  if (file.size > MAX_MB * 1024 * 1024) return { error: `File troppo grande (max ${MAX_MB} MB)` };
  const prep = await jsend(userId, 'upload-url', 'POST', { nome: file.name, mime, size: file.size, scopo });
  if (!prep.ok || !prep.data) return { error: prep.error ?? 'Preparazione upload non riuscita' };
  const { signedUrl, path } = prep.data as { signedUrl: string; path: string };
  try {
    const put = await fetch(signedUrl, { method: 'PUT', headers: { 'content-type': mime, 'x-upsert': 'false' }, body: file });
    if (!put.ok) return { error: `Caricamento non riuscito (HTTP ${put.status})` };
  } catch { return { error: 'Caricamento non riuscito (rete)' }; }
  return { path };
}

// ============================ Pagina ============================
function ProtocolliInner() {
  const { userId } = useSessionIdentity();
  const { ruolo } = useAdminIdentity();
  const isAdmin = ruolo === 'admin';

  const annoCorrente = new Date().getFullYear();
  const [anno, setAnno] = useState(annoCorrente);
  const [tipo, setTipo] = useState('');
  const [categoriaId, setCategoriaId] = useState('');
  const [da, setDa] = useState('');
  const [a, setA] = useState('');
  const [q, setQ] = useState('');

  const [records, setRecords] = useState<Protocollo[]>([]);
  const [stats, setStats] = useState<Stats>(STATS_ZERO);
  const [categorie, setCategorie] = useState<Categoria[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonMigrato, setNonMigrato] = useState(false);

  const [drawerNuovo, setDrawerNuovo] = useState(false);
  const [drawerGenera, setDrawerGenera] = useState(false);
  const [drawerTitolario, setDrawerTitolario] = useState(false);
  const [dettaglioId, setDettaglioId] = useState<string | null>(null);

  const [toast, setToast] = useState('');
  const mostraToast = useCallback((msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3500); }, []);

  const filtriQuery = useMemo(() => {
    const p = new URLSearchParams();
    p.set('anno', String(anno));
    if (tipo) p.set('tipo', tipo);
    if (categoriaId) p.set('categoria_id', categoriaId);
    if (da) p.set('da', da);
    if (a) p.set('a', a);
    return p;
  }, [anno, tipo, categoriaId, da, a]);

  // Niente setState SINCRONO nelle funzioni chiamate dagli effect (lint
  // react-hooks 7): tutti i setState avvengono dopo l'await, con try/finally.
  const reload = useCallback(async () => {
    try {
      const p = new URLSearchParams(filtriQuery);
      if (q.trim()) p.set('q', q.trim());
      p.set('limit', '200');
      const res = await jfull<{ success?: boolean; data?: Protocollo[]; stats?: Stats; nonMigrato?: boolean }>(userId, `?${p.toString()}`);
      setRecords(res?.data ?? []);
      if (res?.stats) setStats(res.stats);
      setNonMigrato(Boolean(res?.nonMigrato));
    } finally {
      setLoading(false);
    }
  }, [userId, filtriQuery, q]);

  const reloadCategorie = useCallback(async () => {
    let dati: Categoria[] = [];
    try {
      const res = await jfull<{ data?: Categoria[] }>(userId, 'categorie');
      dati = res?.data ?? [];
    } finally {
      setCategorie(dati);
    }
  }, [userId]);

  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { reloadCategorie(); }, [reloadCategorie]);

  const categorieAttive = useMemo(() => categorie.filter((c) => c.attivo), [categorie]);
  const anni = useMemo(() => {
    const base = [annoCorrente, annoCorrente - 1, annoCorrente - 2, annoCorrente - 3];
    return anno && !base.includes(anno) ? [anno, ...base] : base;
  }, [annoCorrente, anno]);

  const exportUrl = (formato: 'xlsx' | 'pdf') => urlP(userId, `export?${filtriQuery.toString()}&formato=${formato}`);

  return (
    <CockpitPage>
      <PageHeader
        icon={Stamp}
        title="Registro protocolli"
        subtitle="Corrispondenza in arrivo, in partenza e atti interni — numerazione a norma DPR 445/2000"
        actions={
          <>
            <button type="button" className={BTN_GHOST} onClick={() => window.open(exportUrl('xlsx'), '_blank')}>
              <FileSpreadsheet size={14} /> Excel
            </button>
            <button type="button" className={BTN_GHOST} onClick={() => window.open(exportUrl('pdf'), '_blank')}>
              <FileDown size={14} /> PDF registro
            </button>
            <button type="button" className={BTN_GHOST} onClick={() => setDrawerTitolario(true)}>
              <Settings2 size={14} /> Categorie
            </button>
            <button type="button" className={cx(BTN_PRIMARY, 'px-3.5 py-2')} onClick={() => setDrawerGenera(true)}>
              <FileText size={15} /> Genera documento
            </button>
            <button type="button" className={cx(BTN_PRIMARY, 'px-3.5 py-2')} onClick={() => setDrawerNuovo(true)}>
              <Plus size={16} /> Protocolla documento
            </button>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard icon={Stamp} label={`Registrazioni ${anno}`} value={stats.totale} tone="green" />
        <StatCard icon={Inbox} label="In arrivo" value={stats.ingresso} tone="info" />
        <StatCard icon={Send} label="In partenza" value={stats.uscita} tone="success" />
        <StatCard icon={RefreshCw} label="Interni" value={stats.interno} tone="neutral" />
        <StatCard icon={Hash} label="Ultimo numero" value={stats.ultimoNumero > 0 ? numeroFmt(stats.ultimoNumero, anno) : '—'} tone="yellow" />
      </div>

      <Toolbar search={q} onSearch={setQ} placeholder="Cerca per oggetto, mittente, destinatario o numero…">
        <CockpitSelect value={String(anno)} onChange={(v) => setAnno(Number(v))} options={anni.map((y) => ({ value: String(y), label: `Anno ${y}` }))} />
        <CockpitSelect value={tipo} onChange={setTipo} options={[{ value: '', label: 'Tutti i tipi' }, { value: 'ingresso', label: 'In arrivo' }, { value: 'uscita', label: 'In partenza' }, { value: 'interno', label: 'Interni' }]} />
        <CockpitSelect value={categoriaId} onChange={setCategoriaId} options={[{ value: '', label: 'Tutte le categorie' }, ...categorieAttive.map((c) => ({ value: c.id, label: c.nome }))]} />
        <div className="w-[130px]"><DateField value={da} onChange={setDa} placeholder="Dal gg/mm/aaaa" className={INPUT} /></div>
        <div className="w-[130px]"><DateField value={a} onChange={setA} placeholder="Al gg/mm/aaaa" className={INPUT} /></div>
        {(tipo || categoriaId || da || a || q) && (
          <button type="button" className={BTN_GHOST} onClick={() => { setTipo(''); setCategoriaId(''); setDa(''); setA(''); setQ(''); }}>
            <X size={13} /> Pulisci filtri
          </button>
        )}
      </Toolbar>

      <div className={CARD}>
        {loading ? (
          <Spinner />
        ) : records.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <Stamp size={34} className="text-kidville-neutral" />
            <p className="font-barlow text-lg font-extrabold uppercase text-kidville-green">
              {nonMigrato ? 'Registro non ancora attivo' : 'Nessuna registrazione'}
            </p>
            <p className="max-w-md font-maven text-sm text-kidville-muted">
              {nonMigrato
                ? 'Le tabelle del registro non sono presenti su questo database.'
                : 'Non ci sono protocolli per i filtri scelti. Premi «Protocolla documento» in alto per registrare il primo.'}
            </p>
          </div>
        ) : (
          <div className={TABLE_WRAP}>
            <table className={TABLE}>
              <thead>
                <tr>
                  <th className={TH}>Numero</th>
                  <th className={TH}>Data</th>
                  <th className={TH}>Tipo</th>
                  <th className={TH}>Oggetto</th>
                  <th className={TH}>Mittente / Destinatario</th>
                  <th className={TH}>Categoria</th>
                  <th className={TH}></th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id} className={cx(TROW, 'cursor-pointer', r.annullata_at && 'opacity-60')} onClick={() => setDettaglioId(r.id)}>
                    <td className={cx(TD, 'whitespace-nowrap font-mono text-[13px] font-bold text-kidville-green')}>{numeroFmt(r.numero, r.anno)}</td>
                    <td className={cx(TD, 'whitespace-nowrap font-maven text-[13px] text-kidville-ink')}>{dataIt(r.data_registrazione)} <span className="text-kidville-muted">{oraIt(r.data_registrazione)}</span></td>
                    <td className={TD}><TipoBadge tipo={r.tipo} /></td>
                    <td className={cx(TD, 'max-w-[380px] font-maven text-sm text-kidville-ink')}>
                      <span className={cx('block truncate', r.annullata_at && 'line-through')}>{r.oggetto}</span>
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        {r.annullata_at && <span className="rounded-pill bg-kidville-error-soft px-2 py-0.5 font-maven text-[10.5px] font-semibold text-kidville-error">ANNULLATA</span>}
                        {r.emergenza && <span className="rounded-pill bg-kidville-warn-soft px-2 py-0.5 font-maven text-[10.5px] font-semibold text-kidville-warn">DA EMERGENZA</span>}
                        {(r.allegati?.length ?? 0) > 0 && <span className="inline-flex items-center gap-0.5 rounded-pill bg-kidville-neutral-soft px-2 py-0.5 font-maven text-[10.5px] font-semibold text-kidville-neutral"><Paperclip size={10} /> {r.allegati?.length}</span>}
                        {r.collegato_a_id && <span className="inline-flex items-center gap-0.5 rounded-pill bg-kidville-info-soft px-2 py-0.5 font-maven text-[10.5px] font-semibold text-kidville-info"><Link2 size={10} /> collegato</span>}
                      </span>
                    </td>
                    <td className={cx(TD, 'max-w-[220px] truncate font-maven text-[13px] text-kidville-ink/85')}>{r.mittente ?? r.destinatario ?? '—'}</td>
                    <td className={cx(TD, 'whitespace-nowrap font-maven text-[12.5px] text-kidville-muted')}>{r.categoria?.nome ?? '—'}</td>
                    <td className={cx(TD, 'text-right')}>
                      <button
                        type="button"
                        className={BTN_GHOST}
                        onClick={async (e) => {
                          e.stopPropagation();
                          const res = await jfull<{ data?: { url: string } }>(userId, `file?id=${r.id}&versione=timbrato`);
                          if (res?.data?.url) window.open(res.data.url, '_blank');
                          else mostraToast('❌ Download non riuscito');
                        }}
                      >
                        <Download size={13} /> Timbrato
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {drawerNuovo && (
        <NuovoProtocolloDrawer
          userId={userId}
          categorie={categorieAttive}
          recenti={records}
          onClose={() => setDrawerNuovo(false)}
          onFatto={() => { void reload(); }}
        />
      )}
      {drawerGenera && (
        <GeneraDocumentoDrawer
          userId={userId}
          onClose={() => setDrawerGenera(false)}
          onFatto={() => { void reload(); }}
          mostraToast={mostraToast}
        />
      )}
      {drawerTitolario && (
        <TitolarioDrawer
          userId={userId}
          categorie={categorie}
          onClose={() => setDrawerTitolario(false)}
          onChange={() => { void reloadCategorie(); }}
          mostraToast={mostraToast}
        />
      )}
      {dettaglioId && (
        <DettaglioDrawer
          key={dettaglioId}
          userId={userId}
          id={dettaglioId}
          isAdmin={isAdmin}
          categorie={categorieAttive}
          onApri={(id) => setDettaglioId(id)}
          onClose={() => setDettaglioId(null)}
          onChange={() => { void reload(); }}
          mostraToast={mostraToast}
        />
      )}

      {toast && (
        <div className="fixed bottom-5 right-5 z-[120] rounded-card bg-kidville-green px-4 py-3 font-maven text-sm font-semibold text-kidville-white shadow-lg">
          {toast}
        </div>
      )}
    </CockpitPage>
  );
}

// ============================ Drawer: Protocolla documento ============================
type PassoNuovo = 1 | 2 | 3;
interface AllegatoStaging { path: string; nome: string; mime: string; size: number }
interface Suggerimenti { oggetto?: string; mittente?: string; rifProtMittente?: string; rifDataMittente?: string }
interface Duplicato { numeroFormattato: string; dataRegistrazione: string; oggetto: string }

function NuovoProtocolloDrawer({ userId, categorie, recenti, onClose, onFatto }: {
  userId: string | null; categorie: Categoria[]; recenti: Protocollo[];
  onClose: () => void; onFatto: () => void;
}) {
  const [passo, setPasso] = useState<PassoNuovo>(1);
  const [busy, setBusy] = useState('');
  const [errore, setErrore] = useState('');

  const [fileNome, setFileNome] = useState('');
  const [fileMime, setFileMime] = useState('');
  const [stagingPath, setStagingPath] = useState('');
  const [duplicato, setDuplicato] = useState<Duplicato | null>(null);

  const [tipo, setTipo] = useState<TipoProt>('ingresso');
  const [oggetto, setOggetto] = useState('');
  const [mittente, setMittente] = useState('');
  const [destinatario, setDestinatario] = useState('');
  const [mezzo, setMezzo] = useState('');
  const [rifProt, setRifProt] = useState('');
  const [rifData, setRifData] = useState('');
  const [categoriaId, setCategoriaId] = useState('');
  const [collegatoAId, setCollegatoAId] = useState('');
  const [note, setNote] = useState('');
  const [emergenza, setEmergenza] = useState(false);
  const [emergenzaQuando, setEmergenzaQuando] = useState('');
  const [allegati, setAllegati] = useState<AllegatoStaging[]>([]);
  const [allegatiDescr, setAllegatiDescr] = useState('');

  const [esito, setEsito] = useState<{ numeroFormattato: string; downloadTimbrato: string | null } | null>(null);

  const scegliFile = async (file: File | null) => {
    if (!file) return;
    setErrore('');
    setBusy('Carico il file…');
    const up = await caricaSuStaging(userId, file, 'principale');
    if ('error' in up) { setErrore(up.error); setBusy(''); return; }
    setFileNome(file.name);
    const mime = mimeDaFile(file) as string;
    setFileMime(mime);
    setStagingPath(up.path);
    setBusy('Leggo il documento…');
    const analisi = await jsend(userId, 'analizza', 'POST', { stagingPath: up.path, mime });
    if (analisi.ok && analisi.data) {
      const d = analisi.data as { duplicato: Duplicato | null; suggerimenti: Suggerimenti };
      setDuplicato(d.duplicato);
      if (d.suggerimenti.oggetto) setOggetto(d.suggerimenti.oggetto);
      if (d.suggerimenti.mittente) setMittente(d.suggerimenti.mittente);
      if (d.suggerimenti.rifProtMittente) setRifProt(d.suggerimenti.rifProtMittente);
      if (d.suggerimenti.rifDataMittente) setRifData(d.suggerimenti.rifDataMittente);
    }
    setBusy('');
    setPasso(2);
  };

  const aggiungiAllegato = async (file: File | null) => {
    if (!file) return;
    setErrore('');
    setBusy(`Carico l'allegato ${file.name}…`);
    const up = await caricaSuStaging(userId, file, 'allegato');
    setBusy('');
    if ('error' in up) { setErrore(up.error); return; }
    const nuovo = [...allegati, { path: up.path, nome: file.name, mime: mimeDaFile(file) as string, size: file.size }];
    setAllegati(nuovo);
    setAllegatiDescr(`${nuovo.length} allegat${nuovo.length === 1 ? 'o' : 'i'}: ${nuovo.map((x) => x.nome).join(', ')}`.slice(0, 480));
  };

  const registra = async () => {
    setErrore('');
    if (!oggetto.trim()) { setErrore("Scrivi l'oggetto del documento"); return; }
    if (tipo === 'ingresso' && !mittente.trim()) { setErrore('Indica il mittente (chi ti ha inviato il documento)'); return; }
    if (tipo === 'uscita' && !destinatario.trim()) { setErrore('Indica il destinatario (a chi mandi il documento)'); return; }
    if (emergenza && !emergenzaQuando) { setErrore("Indica data e ora dell'evento annotato nel registro di emergenza"); return; }
    setBusy('Assegno il numero e applico il timbro…');
    const res = await jsend(userId, '', 'POST', {
      stagingPath, nomeFile: fileNome, mime: fileMime, tipo,
      oggetto: oggetto.trim(),
      mittente: mittente.trim() || undefined,
      destinatario: destinatario.trim() || undefined,
      mezzo: mezzo || undefined,
      rifProtMittente: rifProt.trim() || undefined,
      rifDataMittente: rifData || undefined,
      categoriaId: categoriaId || undefined,
      collegatoAId: collegatoAId || undefined,
      noteInterne: note.trim() || undefined,
      emergenza,
      emergenzaDichiarataIl: emergenza && emergenzaQuando ? new Date(emergenzaQuando).toISOString() : undefined,
      allegatiDescrizione: allegatiDescr.trim() || undefined,
      allegati: allegati.map((x) => ({ stagingPath: x.path, nome: x.nome, mime: x.mime })),
    });
    setBusy('');
    if (!res.ok || !res.data) { setErrore(res.error ?? 'Registrazione non riuscita'); return; }
    const d = res.data as { numeroFormattato: string; downloadTimbrato: string | null };
    setEsito({ numeroFormattato: d.numeroFormattato, downloadTimbrato: d.downloadTimbrato });
    setPasso(3);
    onFatto();
  };

  return (
    <Drawer open onClose={onClose} title="Protocolla documento" subtitle="Carica il file, controlla i dati, ottieni il numero e il PDF timbrato" width={560}>
      <div className="mb-5 flex items-center gap-4">
        <PassoDot corrente={passo} n={1} label="File" /><span className="h-px flex-1 bg-kidville-line" />
        <PassoDot corrente={passo} n={2} label="Dati" /><span className="h-px flex-1 bg-kidville-line" />
        <PassoDot corrente={passo} n={3} label="Numero" />
      </div>

      {errore && <div className="mb-4 flex items-start gap-2 rounded-card bg-kidville-error-soft px-3 py-2.5 font-maven text-sm text-kidville-error"><AlertTriangle size={16} className="mt-0.5 shrink-0" />{errore}</div>}
      {busy && <div className="mb-4 flex items-center gap-2 rounded-card bg-kidville-green-soft px-3 py-2.5 font-maven text-sm text-kidville-green"><Loader2 size={16} className="animate-spin" />{busy}</div>}

      {passo === 1 && (
        <label className={cx('flex cursor-pointer flex-col items-center gap-3 rounded-card border-2 border-dashed border-kidville-line bg-kidville-cream/50 px-6 py-12 text-center transition-colors hover:border-kidville-green', busy && 'pointer-events-none opacity-60')}>
          <UploadCloud size={38} className="text-kidville-green" />
          <span className="font-barlow text-lg font-extrabold uppercase text-kidville-green">Scegli il documento</span>
          <span className="font-maven text-sm text-kidville-muted">PDF oppure foto JPG/PNG (le foto vengono convertite in PDF) — max {MAX_MB} MB.<br />Se il PDF contiene testo, oggetto e mittente si compilano da soli.</span>
          <span className={BTN_PRIMARY}>Sfoglia…</span>
          <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden" onChange={(e) => { void scegliFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
        </label>
      )}

      {passo === 2 && (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2 rounded-card bg-kidville-green-soft px-3 py-2 font-maven text-sm text-kidville-green">
            <FileText size={15} /> <span className="truncate">{fileNome}</span>
          </div>
          {duplicato && (
            <div className="flex items-start gap-2 rounded-card bg-kidville-warn-soft px-3 py-2.5 font-maven text-[13px] text-kidville-warn">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>Attenzione: questo file risulta GIÀ protocollato col n. <b>{duplicato.numeroFormattato}</b> del {dataIt(duplicato.dataRegistrazione)} («{duplicato.oggetto}»). Puoi comunque procedere.</span>
            </div>
          )}

          <div>
            <span className={LABEL}>Tipo di registrazione</span>
            <div className="mt-1 flex gap-2">
              {(['ingresso', 'uscita', 'interno'] as TipoProt[]).map((t) => (
                <button key={t} type="button" onClick={() => setTipo(t)}
                  className={cx('flex-1 rounded-pill border-2 px-3 py-2 font-barlow text-[13px] font-extrabold uppercase', tipo === t ? 'border-kidville-green bg-kidville-green text-kidville-yellow' : 'border-kidville-line bg-kidville-white text-kidville-ink/70')}>
                  {TIPO_LABEL[t]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className={LABEL}>Oggetto *</label>
            <input className={INPUT} value={oggetto} onChange={(e) => setOggetto(e.target.value)} placeholder="Di cosa parla il documento" maxLength={500} />
          </div>

          {tipo !== 'interno' && (
            <div>
              <label className={LABEL}>{tipo === 'ingresso' ? 'Mittente * (chi lo ha inviato)' : 'Destinatario * (a chi lo mandi)'}</label>
              {tipo === 'ingresso'
                ? <input className={INPUT} value={mittente} onChange={(e) => setMittente(e.target.value)} placeholder="Es. Comune di Giugliano" maxLength={300} />
                : <input className={INPUT} value={destinatario} onChange={(e) => setDestinatario(e.target.value)} placeholder="Es. USR Campania" maxLength={300} />}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>Mezzo</label>
              <CockpitSelect className="w-full" value={mezzo} onChange={setMezzo} options={[{ value: '', label: '—' }, ...MEZZI.map((m) => ({ value: m, label: m }))]} />
            </div>
            <div>
              <label className={LABEL}>Categoria</label>
              <CockpitSelect className="w-full" value={categoriaId} onChange={setCategoriaId} options={[{ value: '', label: '—' }, ...categorie.map((c) => ({ value: c.id, label: c.nome }))]} />
            </div>
          </div>

          {tipo === 'ingresso' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={LABEL}>Protocollo del mittente</label>
                <input className={INPUT} value={rifProt} onChange={(e) => setRifProt(e.target.value)} placeholder="Es. 12345/2026" maxLength={60} />
              </div>
              <div>
                <label className={LABEL}>Data documento mittente</label>
                <DateField value={rifData} onChange={setRifData} className={INPUT} />
              </div>
            </div>
          )}

          <div>
            <label className={LABEL}>Collegato a un protocollo esistente (es. risposta)</label>
            <CockpitSelect className="w-full" value={collegatoAId} onChange={setCollegatoAId}
              options={[{ value: '', label: '— nessun collegamento —' }, ...recenti.filter((r) => !r.annullata_at).slice(0, 60).map((r) => ({ value: r.id, label: `${numeroFmt(r.numero, r.anno)} — ${r.oggetto.slice(0, 60)}` }))]} />
          </div>

          <div>
            <span className={LABEL}>Allegati (facoltativi)</span>
            {allegati.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1">
                {allegati.map((x, i) => (
                  <li key={x.path} className="flex items-center justify-between gap-2 rounded-input bg-kidville-cream px-3 py-1.5 font-maven text-[13px] text-kidville-ink">
                    <span className="flex min-w-0 items-center gap-1.5"><Paperclip size={13} className="shrink-0 text-kidville-green" /><span className="truncate">{x.nome}</span></span>
                    <button type="button" aria-label={`Rimuovi ${x.nome}`} onClick={() => {
                      const rimasti = allegati.filter((_, j) => j !== i);
                      setAllegati(rimasti);
                      setAllegatiDescr(rimasti.length ? `${rimasti.length} allegat${rimasti.length === 1 ? 'o' : 'i'}: ${rimasti.map((y) => y.nome).join(', ')}`.slice(0, 480) : '');
                    }} className="text-kidville-error"><X size={14} /></button>
                  </li>
                ))}
              </ul>
            )}
            <label className={cx(BTN_GHOST, 'mt-1.5 cursor-pointer')}>
              <Plus size={13} /> Aggiungi allegato
              <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden" onChange={(e) => { void aggiungiAllegato(e.target.files?.[0] ?? null); e.target.value = ''; }} />
            </label>
            {allegati.length > 0 && (
              <div className="mt-2">
                <label className={LABEL}>Descrizione allegati (finisce nel registro)</label>
                <input className={INPUT} value={allegatiDescr} onChange={(e) => setAllegatiDescr(e.target.value)} maxLength={500} />
              </div>
            )}
          </div>

          <div className="rounded-card bg-kidville-warn-soft/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 font-maven text-sm font-semibold text-kidville-warn"><Siren size={15} /> Da registro di emergenza</span>
              <Toggle on={emergenza} onClick={() => setEmergenza(!emergenza)} />
            </div>
            {emergenza && (
              <div className="mt-2">
                <label className={LABEL}>Data e ora dell&apos;evento (dal registro cartaceo)</label>
                <input type="datetime-local" className={INPUT} value={emergenzaQuando} onChange={(e) => setEmergenzaQuando(e.target.value)} />
              </div>
            )}
          </div>

          <div>
            <label className={LABEL}>Note interne (modificabili anche dopo)</label>
            <textarea className={cx(INPUT, 'min-h-[64px]')} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            <button type="button" className={BTN_GHOST} onClick={() => { setPasso(1); setStagingPath(''); setFileNome(''); setDuplicato(null); }}>← Cambia file</button>
            <button type="button" className={BTN_PRIMARY} disabled={!!busy} onClick={() => void registra()}>
              <Stamp size={16} /> Registra e timbra
            </button>
          </div>
        </div>
      )}

      {passo === 3 && esito && (
        <div className="flex flex-col items-center gap-4 py-8 text-center">
          <SaveCheck size={44} />
          <div>
            <p className="font-maven text-sm text-kidville-muted">Numero di protocollo assegnato</p>
            <p className="font-barlow text-[40px] font-black leading-tight text-kidville-green">{esito.numeroFormattato}</p>
          </div>
          {esito.downloadTimbrato ? (
            <a href={esito.downloadTimbrato} target="_blank" rel="noreferrer" className={BTN_PRIMARY}>
              <Download size={16} /> Scarica il PDF timbrato
            </a>
          ) : (
            <p className="font-maven text-sm text-kidville-muted">Il PDF timbrato è archiviato: lo trovi nella scheda della registrazione.</p>
          )}
          <div className="flex gap-2">
            <button type="button" className={BTN_GHOST} onClick={() => {
              setPasso(1); setEsito(null); setStagingPath(''); setFileNome(''); setDuplicato(null);
              setOggetto(''); setMittente(''); setDestinatario(''); setMezzo(''); setRifProt(''); setRifData('');
              setCollegatoAId(''); setNote(''); setEmergenza(false); setEmergenzaQuando(''); setAllegati([]); setAllegatiDescr('');
            }}>
              <Plus size={13} /> Protocolla un altro documento
            </button>
            <button type="button" className={BTN_GHOST} onClick={onClose}>Chiudi</button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

// ============================ Drawer: Genera documento ============================
function GeneraDocumentoDrawer({ userId, onClose, onFatto, mostraToast }: {
  userId: string | null; onClose: () => void; onFatto: () => void; mostraToast: (m: string) => void;
}) {
  const [tipoDoc, setTipoDoc] = useState('frequenza');
  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [caricoAlunni, setCaricoAlunni] = useState(true);
  const [ricerca, setRicerca] = useState('');
  const [alunnoId, setAlunnoId] = useState('');
  const [titolo, setTitolo] = useState('');
  const [corpo, setCorpo] = useState('');
  const [busy, setBusy] = useState(false);
  const [errore, setErrore] = useState('');
  const [esito, setEsito] = useState<{ numeroFormattato: string; downloadTimbrato: string | null } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`/api/admin/students?limit=1000${userId ? `&userId=${encodeURIComponent(userId)}` : ''}`);
        const j = await r.json().catch(() => ({}));
        const lista = (j.data ?? j.students ?? []) as Alunno[];
        setAlunni(Array.isArray(lista) ? lista : []);
      } catch {
        setAlunni([]);
      } finally {
        setCaricoAlunni(false);
      }
    })();
  }, [userId]);

  const filtrati = useMemo(() => {
    const t = ricerca.trim().toLowerCase();
    const base = t ? alunni.filter((s) => `${s.cognome} ${s.nome}`.toLowerCase().includes(t)) : alunni;
    return base.slice(0, 30);
  }, [alunni, ricerca]);
  const scelto = alunni.find((s) => s.id === alunnoId) ?? null;

  const genera = async () => {
    setErrore('');
    if (!alunnoId) { setErrore("Scegli l'alunno"); return; }
    if (tipoDoc === 'libero' && (!titolo.trim() || !corpo.trim())) { setErrore('Per il documento libero servono titolo e testo'); return; }
    setBusy(true);
    const res = await jsend(userId, 'genera-documento', 'POST', {
      tipoDocumento: tipoDoc, alunnoId,
      titolo: titolo.trim() || undefined, corpo: corpo.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok || !res.data) { setErrore(res.error ?? 'Generazione non riuscita'); return; }
    const d = res.data as { numeroFormattato: string; downloadTimbrato: string | null };
    setEsito(d);
    onFatto();
    mostraToast(`✅ Documento protocollato: n. ${d.numeroFormattato}`);
  };

  return (
    <Drawer open onClose={onClose} title="Genera documento" subtitle="Certificati e nulla osta su carta intestata, protocollati in uscita in un click" width={560}>
      {esito ? (
        <div className="flex flex-col items-center gap-4 py-8 text-center">
          <CheckCircle2 size={44} className="text-kidville-success" />
          <div>
            <p className="font-maven text-sm text-kidville-muted">Documento generato e protocollato col numero</p>
            <p className="font-barlow text-[40px] font-black leading-tight text-kidville-green">{esito.numeroFormattato}</p>
          </div>
          {esito.downloadTimbrato && (
            <a href={esito.downloadTimbrato} target="_blank" rel="noreferrer" className={BTN_PRIMARY}><Download size={16} /> Scarica il PDF timbrato</a>
          )}
          <button type="button" className={BTN_GHOST} onClick={() => { setEsito(null); setAlunnoId(''); setTitolo(''); setCorpo(''); }}>Genera un altro documento</button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {errore && <div className="flex items-start gap-2 rounded-card bg-kidville-error-soft px-3 py-2.5 font-maven text-sm text-kidville-error"><AlertTriangle size={16} className="mt-0.5 shrink-0" />{errore}</div>}

          <div>
            <label className={LABEL}>Tipo di documento</label>
            <CockpitSelect className="w-full" value={tipoDoc} onChange={setTipoDoc} options={[
              { value: 'frequenza', label: 'Certificato di frequenza' },
              { value: 'iscrizione', label: 'Certificato di iscrizione' },
              { value: 'nulla_osta', label: 'Nulla osta al trasferimento' },
              { value: 'libero', label: 'Documento libero su carta intestata' },
            ]} />
          </div>

          <div>
            <label className={LABEL}>Alunno *</label>
            {scelto ? (
              <div className="flex items-center justify-between gap-2 rounded-input bg-kidville-green-soft px-3 py-2 font-maven text-sm text-kidville-green">
                <span className="truncate font-semibold">{scelto.cognome} {scelto.nome}{scelto.classe_sezione ? ` — ${scelto.classe_sezione}` : ''}</span>
                <button type="button" aria-label="Cambia alunno" onClick={() => setAlunnoId('')}><X size={15} /></button>
              </div>
            ) : caricoAlunni ? (
              <Spinner label="Carico gli alunni…" />
            ) : (
              <>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-kidville-neutral"><Search size={15} /></span>
                  <input className={cx(INPUT, 'pl-9')} value={ricerca} onChange={(e) => setRicerca(e.target.value)} placeholder="Cerca per cognome o nome…" />
                </div>
                <ul className="mt-1 max-h-[180px] overflow-y-auto rounded-input border border-kidville-line">
                  {filtrati.map((s) => (
                    <li key={s.id}>
                      <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left font-maven text-sm text-kidville-ink hover:bg-kidville-cream" onClick={() => setAlunnoId(s.id)}>
                        <span className="truncate">{s.cognome} {s.nome}</span>
                        <span className="shrink-0 text-[11.5px] text-kidville-muted">{s.classe_sezione ?? ''}</span>
                      </button>
                    </li>
                  ))}
                  {filtrati.length === 0 && <li className="px-3 py-2 font-maven text-sm text-kidville-muted">Nessun alunno trovato</li>}
                </ul>
              </>
            )}
          </div>

          {tipoDoc === 'libero' && (
            <>
              <div>
                <label className={LABEL}>Titolo del documento *</label>
                <input className={INPUT} value={titolo} onChange={(e) => setTitolo(e.target.value)} placeholder="Es. Attestazione di iscrizione al servizio mensa" maxLength={120} />
              </div>
              <div>
                <label className={LABEL}>Testo *</label>
                <textarea className={cx(INPUT, 'min-h-[140px]')} value={corpo} onChange={(e) => setCorpo(e.target.value)} maxLength={4000} placeholder="Scrivi il testo: verrà impaginato su carta intestata Kidville" />
              </div>
            </>
          )}

          <button type="button" className={BTN_PRIMARY} disabled={busy} onClick={() => void genera()}>
            {busy ? <Loader2 size={16} className="animate-spin" /> : <Stamp size={16} />} Genera e protocolla
          </button>
          <p className="font-maven text-xs text-kidville-muted">Il documento nasce su carta intestata, riceve numero e fascia di segnatura in uscita ed è archiviato nel registro come tutti gli altri.</p>
        </div>
      )}
    </Drawer>
  );
}

// ============================ Drawer: Titolario (categorie) ============================
function TitolarioDrawer({ userId, categorie, onClose, onChange, mostraToast }: {
  userId: string | null; categorie: Categoria[]; onClose: () => void; onChange: () => void; mostraToast: (m: string) => void;
}) {
  const [nuovo, setNuovo] = useState('');
  const [busy, setBusy] = useState(false);

  const aggiungi = async () => {
    if (!nuovo.trim()) return;
    setBusy(true);
    const res = await jsend(userId, 'categorie', 'POST', { nome: nuovo.trim() });
    setBusy(false);
    if (!res.ok) { mostraToast(`❌ ${res.error ?? 'Errore'}`); return; }
    setNuovo('');
    onChange();
  };

  return (
    <Drawer open onClose={onClose} title="Categorie del registro" subtitle="Il titolario: organizza le registrazioni per argomento" width={480}>
      <div className="flex flex-col gap-2">
        {categorie.map((c) => <RigaCategoria key={c.id} userId={userId} categoria={c} onChange={onChange} mostraToast={mostraToast} />)}
        <div className="mt-3 flex gap-2">
          <input className={INPUT} value={nuovo} onChange={(e) => setNuovo(e.target.value)} placeholder="Nuova categoria…" maxLength={80}
            onKeyDown={(e) => { if (e.key === 'Enter') void aggiungi(); }} />
          <button type="button" className={BTN_PRIMARY} disabled={busy || !nuovo.trim()} onClick={() => void aggiungi()}><Plus size={15} /></button>
        </div>
      </div>
    </Drawer>
  );
}

function RigaCategoria({ userId, categoria, onChange, mostraToast }: {
  userId: string | null; categoria: Categoria; onChange: () => void; mostraToast: (m: string) => void;
}) {
  const [nome, setNome] = useState(categoria.nome);
  const [salvato, setSalvato] = useState(false);
  const [busy, setBusy] = useState(false);

  const salva = async (patch: { nome?: string; attivo?: boolean }) => {
    setBusy(true);
    const res = await jsend(userId, 'categorie', 'PATCH', { id: categoria.id, ...patch });
    setBusy(false);
    if (!res.ok) { mostraToast(`❌ ${res.error ?? 'Errore'}`); return; }
    setSalvato(true); setTimeout(() => setSalvato(false), 1600);
    onChange();
  };

  return (
    <div className={cx('flex items-center gap-2 rounded-input border border-kidville-line px-2.5 py-1.5', !categoria.attivo && 'opacity-55')}>
      <input className="min-w-0 flex-1 bg-transparent font-maven text-sm text-kidville-ink outline-none" value={nome} maxLength={80}
        onChange={(e) => setNome(e.target.value)}
        onBlur={() => { if (nome.trim() && nome.trim() !== categoria.nome) void salva({ nome: nome.trim() }); }} />
      {salvato && <SaveCheck size={18} />}
      <Toggle on={categoria.attivo} disabled={busy} onClick={() => void salva({ attivo: !categoria.attivo })} />
    </div>
  );
}

// ============================ Drawer: Dettaglio ============================
function DettaglioDrawer({ userId, id, isAdmin, categorie, onApri, onClose, onChange, mostraToast }: {
  userId: string | null; id: string; isAdmin: boolean; categorie: Categoria[];
  onApri: (id: string) => void; onClose: () => void; onChange: () => void; mostraToast: (m: string) => void;
}) {
  const [rec, setRec] = useState<Protocollo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [verifica, setVerifica] = useState<null | { integro: boolean }>(null);
  const [annulloAperto, setAnnulloAperto] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [note, setNote] = useState('');
  const [noteSalvate, setNoteSalvate] = useState(false);

  const carica = useCallback(async () => {
    try {
      const res = await jfull<{ data?: Protocollo }>(userId, `?id=${id}`);
      setRec(res?.data ?? null);
      setNote(res?.data?.note_interne ?? '');
      setVerifica(null);
      setAnnulloAperto(false);
      setMotivo('');
    } finally {
      setLoading(false);
    }
  }, [userId, id]);
  useEffect(() => { carica(); }, [carica]);

  const scarica = async (versione: 'originale' | 'timbrato' | 'allegato', allegatoId?: string) => {
    const extra = allegatoId ? `&allegatoId=${allegatoId}` : '';
    const res = await jfull<{ data?: { url: string } }>(userId, `file?id=${id}&versione=${versione}${extra}`);
    if (res?.data?.url) window.open(res.data.url, '_blank');
    else mostraToast('❌ Download non riuscito');
  };

  const verificaIntegrita = async () => {
    setBusy(true);
    const res = await jsend(userId, 'verifica', 'POST', { id });
    setBusy(false);
    if (!res.ok || !res.data) { mostraToast(`❌ ${res.error ?? 'Verifica non riuscita'}`); return; }
    setVerifica(res.data as { integro: boolean });
  };

  const annulla = async () => {
    if (motivo.trim().length < 3) { mostraToast('❌ Scrivi il motivo dell’annullamento'); return; }
    setBusy(true);
    const res = await jsend(userId, '', 'PATCH', { id, azione: 'annulla', motivo: motivo.trim() });
    setBusy(false);
    if (!res.ok) { mostraToast(`❌ ${res.error ?? 'Annullamento non riuscito'}`); return; }
    mostraToast('Registrazione annullata (resta visibile a registro)');
    onChange();
    void carica();
  };

  const elimina = async () => {
    if (!window.confirm('Eliminare DEFINITIVAMENTE questa registrazione?\n\nSparirà dal registro insieme ai file e resterà un buco nella numerazione. L’operazione non lascia tracce e non è reversibile.')) return;
    if (!window.confirm('Confermi? Questa è l’ultima conferma.')) return;
    setBusy(true);
    const res = await jsend(userId, `?id=${id}`, 'DELETE');
    setBusy(false);
    if (!res.ok) { mostraToast(`❌ ${res.error ?? 'Eliminazione non riuscita'}`); return; }
    mostraToast('Registrazione eliminata definitivamente');
    onChange();
    onClose();
  };

  const salvaCampo = async (patch: { noteInterne?: string | null; categoriaId?: string | null; collegatoAId?: string | null }) => {
    setBusy(true);
    const res = await jsend(userId, '', 'PATCH', { id, azione: 'aggiorna', ...patch });
    setBusy(false);
    if (!res.ok) { mostraToast(`❌ ${res.error ?? 'Salvataggio non riuscito'}`); return; }
    if (patch.noteInterne !== undefined) { setNoteSalvate(true); setTimeout(() => setNoteSalvate(false), 1600); }
    onChange();
    void carica();
  };

  return (
    <Drawer open onClose={onClose} width={560}
      title={rec ? `Prot. n. ${numeroFmt(rec.numero, rec.anno)}` : 'Registrazione'}
      subtitle={rec ? `${TIPO_LABEL[rec.tipo]} · registrato il ${dataIt(rec.data_registrazione)} alle ${oraIt(rec.data_registrazione)}` : undefined}>
      {loading ? <Spinner /> : !rec ? (
        <p className="font-maven text-sm text-kidville-muted">Registrazione non trovata.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {rec.annullata_at && (
            <div className="rounded-card bg-kidville-error-soft px-3 py-2.5 font-maven text-sm text-kidville-error">
              <b>ANNULLATA</b> il {dataIt(rec.annullata_at)} alle {oraIt(rec.annullata_at)} — motivo: {rec.annullo_motivo ?? '—'}
              <span className="mt-0.5 block text-[12px]">La riga resta a registro come previsto dall&apos;art. 54 DPR 445/2000.</span>
            </div>
          )}
          {rec.emergenza && (
            <div className="rounded-card bg-kidville-warn-soft px-3 py-2 font-maven text-[13px] text-kidville-warn">
              <b>Da registro di emergenza</b>{rec.emergenza_dichiarata_il ? ` — evento del ${dataIt(rec.emergenza_dichiarata_il)} ore ${oraIt(rec.emergenza_dichiarata_il)}` : ''}
            </div>
          )}

          <Campo label="Oggetto" value={<span className={cx(rec.annullata_at && 'line-through')}>{rec.oggetto}</span>} />
          <div className="grid grid-cols-2 gap-3">
            {rec.mittente && <Campo label="Mittente" value={rec.mittente} />}
            {rec.destinatario && <Campo label="Destinatario" value={rec.destinatario} />}
            {rec.mezzo && <Campo label="Mezzo" value={rec.mezzo} />}
            {rec.rif_prot_mittente && <Campo label="Prot. mittente" value={`${rec.rif_prot_mittente}${rec.rif_data_mittente ? ` del ${dataIt(rec.rif_data_mittente)}` : ''}`} />}
            {rec.file_nome_originale && <Campo label="File originale" value={rec.file_nome_originale} />}
            {rec.allegati_descrizione && <Campo label="Allegati" value={rec.allegati_descrizione} />}
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" className={BTN_PRIMARY} onClick={() => void scarica('timbrato')}><Download size={14} /> PDF timbrato</button>
            <button type="button" className={BTN_GHOST} onClick={() => void scarica('originale')}><Download size={13} /> Originale</button>
            {(rec.allegati ?? []).map((al) => (
              <button key={al.id} type="button" className={BTN_GHOST} onClick={() => void scarica('allegato', al.id)}>
                <Paperclip size={12} /> {al.nome.length > 24 ? `${al.nome.slice(0, 22)}…` : al.nome}
              </button>
            ))}
          </div>

          <div className="rounded-card bg-kidville-cream/70 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="font-barlow text-[12px] font-bold uppercase text-kidville-neutral">Impronta del documento (art. 53)</span>
              <button type="button" className={BTN_GHOST} disabled={busy} onClick={() => void verificaIntegrita()}>
                <ShieldCheck size={13} /> Verifica integrità
              </button>
            </div>
            <p className="mt-1 break-all font-mono text-[11px] text-kidville-ink/70">{rec.impronta_sha256}</p>
            {verifica && (
              <p className={cx('mt-1.5 inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 font-maven text-[12.5px] font-bold', verifica.integro ? 'bg-kidville-success-soft text-kidville-success' : 'bg-kidville-error-soft text-kidville-error')}>
                {verifica.integro ? <><CheckCircle2 size={14} /> Integro: il file è identico a quello protocollato</> : <><AlertTriangle size={14} /> NON corrisponde: il file archiviato è stato alterato!</>}
              </p>
            )}
          </div>

          {(rec.collegato || (rec.risposte?.length ?? 0) > 0) && (
            <div>
              <div className="mb-1 font-barlow text-[11px] font-bold uppercase tracking-[0.05em] text-kidville-neutral">Collegamenti</div>
              <div className="flex flex-col gap-1">
                {rec.collegato && (
                  <button type="button" className="flex items-center gap-2 rounded-input bg-kidville-info-soft px-3 py-2 text-left font-maven text-[13px] text-kidville-info" onClick={() => onApri(rec.collegato!.id)}>
                    <Link2 size={13} className="shrink-0" /> Collegato a <b>{numeroFmt(rec.collegato.numero, rec.collegato.anno)}</b> — {rec.collegato.oggetto.slice(0, 50)}
                  </button>
                )}
                {(rec.risposte ?? []).map((x) => (
                  <button key={x.id} type="button" className="flex items-center gap-2 rounded-input bg-kidville-info-soft px-3 py-2 text-left font-maven text-[13px] text-kidville-info" onClick={() => onApri(x.id)}>
                    <Link2 size={13} className="shrink-0" /> Risposto da <b>{numeroFmt(x.numero, x.anno)}</b> — {x.oggetto.slice(0, 50)}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={LABEL}>Categoria</label>
              <CockpitSelect className="w-full" value={rec.categoria_id ?? ''} onChange={(v) => void salvaCampo({ categoriaId: v || null })}
                options={[{ value: '', label: '—' }, ...categorie.map((c) => ({ value: c.id, label: c.nome }))]} />
            </div>
            <div>
              <label className={cx(LABEL, 'flex items-center gap-1.5')}>Note interne {noteSalvate && <SaveCheck size={14} />}</label>
              <textarea className={cx(INPUT, 'min-h-[42px]')} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000}
                onBlur={() => { if ((rec.note_interne ?? '') !== note) void salvaCampo({ noteInterne: note || null }); }} />
            </div>
          </div>

          {!rec.annullata_at && (
            <div className="border-t border-kidville-line pt-3">
              {!annulloAperto ? (
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className={BTN_DANGER} onClick={() => setAnnulloAperto(true)}>
                    <Ban size={13} /> Annulla registrazione
                  </button>
                  {isAdmin && (
                    <button type="button" className={BTN_DANGER} disabled={busy} onClick={() => void elimina()}>
                      <Trash2 size={13} /> Elimina definitivamente
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-2 rounded-card bg-kidville-error-soft/50 p-3">
                  <label className={LABEL}>Motivo dell&apos;annullamento * (resterà visibile a registro)</label>
                  <input className={INPUT} value={motivo} onChange={(e) => setMotivo(e.target.value)} maxLength={500} placeholder="Es. errore di inserimento: oggetto sbagliato" />
                  <div className="flex gap-2">
                    <button type="button" className={BTN_DANGER} disabled={busy} onClick={() => void annulla()}><Ban size={13} /> Conferma annullamento</button>
                    <button type="button" className={BTN_GHOST} onClick={() => { setAnnulloAperto(false); setMotivo(''); }}>Lascia stare</button>
                  </div>
                </div>
              )}
            </div>
          )}
          {rec.annullata_at && isAdmin && (
            <div className="border-t border-kidville-line pt-3">
              <button type="button" className={BTN_DANGER} disabled={busy} onClick={() => void elimina()}>
                <Trash2 size={13} /> Elimina definitivamente (admin)
              </button>
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}

// ============================ Export default ============================
export default function ProtocolliPage() {
  return (
    <Suspense fallback={<CockpitPage><Spinner /></CockpitPage>}>
      <ProtocolliInner />
    </Suspense>
  );
}
