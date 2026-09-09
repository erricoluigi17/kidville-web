'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PenLine, BookOpen, Check, Paperclip, FileText, Image as ImageIcon } from 'lucide-react';
import { getCurrentTeacherId } from '@/lib/auth/current-teacher';
import { saveLocalRegistro, syncPendingRegistro } from '@/lib/offline/syncEngine';
import { nomeCompleto } from '@/lib/format/nome';
import { isoToIt } from '@/lib/format/data';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { DateField } from '@/components/ui/DateField';
import { ScattaFotoButton } from '@/components/features/native/ScattaFotoButton';

/** La rotta della PAGINA: è il luogo dell'incidente, non l'URL della fetch. */
const ROTTA = '/teacher/primaria/[sectionId]/registro';

interface Campanella { id: string; ordine: number; ora_inizio: string; ora_fine: string; tipo: string }
interface OrarioCella { campanella_id: string; materia_id: string | null; materie?: { nome: string } | null }
interface Firma { id: string; maestra_id: string; tipo_compresenza: string; argomento_proprio: string | null; compiti_propri: string | null; utenti?: { nome: string; cognome: string } | null }
interface Allegato { id: string; ambito: string; tipo: string; file_url: string; file_name: string | null }
/** Chi riceve i contenuti «propri» di UNA firma (assegnazione mirata). */
interface Destinatario { id: string; firma_id: string; alunno_id: string }
/**
 * La riga di registro come la RESTITUISCE la GET (`primaria/registro:GET`, select
 * alla riga 82 della route). Fino al 2026-09-09 questa interfaccia ne dichiarava
 * meno della metà: `materia_id`, `data_consegna_compiti` e `registro_destinatari`
 * arrivavano dal server a ogni caricamento e non esistevano per TypeScript, quindi
 * non esistevano per la pagina. La data di consegna dei compiti, in particolare, il
 * docente non l'ha mai vista da nessuna parte — né in elenco né riaprendo la modale.
 */
interface Riga {
  id: string;
  ora_lezione: number;
  materia: string | null;
  materia_id: string | null;
  argomento: string | null;
  compiti: string | null;
  data_consegna_compiti: string | null;
  materie?: { nome: string } | null;
  firme_docenti?: Firma[];
  registro_destinatari?: Destinatario[];
  allegati_registro?: Allegato[];
}
interface Materia { id: string; nome: string }
interface Alunno { id: string; nome: string; cognome: string }
/**
 * Un docente proponibile come TITOLARE della firma. `ruolo` non è decorazione:
 * `admin/sections/[id]/teachers` restituisce TUTTO il personale legato alla sezione
 * (`RUOLI_PERSONALE`: admin, coordinator, segreteria, cuoca compresi), e senza quel
 * campo la tendina «Docente titolare» proporrebbe la Segreteria a sé stessa.
 */
interface Docente { id: string; nome: string; cognome: string; ruolo: string }

/**
 * L'UNICO ruolo che può firmare il registro come titolare.
 *
 * Misurato in produzione il 2026-09-09, non dedotto: i ruoli esistenti su
 * `utenti_sezioni` sono `educator` (60 utenti, 92 legami), `segreteria` (2 utenti,
 * 6 legami) e `admin` (1 utente, 1 legame); su tutta `utenti` esistono solo
 * educator/segreteria/admin/coordinator/cuoca/genitore, e i nomi storici
 * (`maestra`, `insegnante`) che `RUOLI_PERSONALE` tiene in vita a scopo di elenco
 * non hanno NESSUNA riga. `AppRole` (`@/lib/auth/predicati-ruolo`) conosce un solo
 * ruolo docente, ed è questo.
 */
const RUOLO_DOCENTE = 'educator';

/**
 * L'assegnazione è MIRATA se la firma porta CONTENUTI individualizzati — non se ha
 * dei destinatari.
 *
 * ─── perché non i destinatari ───────────────────────────────────────────────
 * Il server cancella `registro_destinatari` unicamente dentro `if (haDestinatari)`
 * (`route.ts:573`): tornando a «Tutta la classe» (`destinatariIds: []`) azzera i
 * propri (`route.ts:527-528`) ma lascia le righe dei destinatari APPESE. Fidandosi
 * di quelle, la modale ripartirebbe da «Alunni selezionati» su una firma che di
 * individualizzato non ha più niente — e i due riquadri di CLASSE, che in quella
 * modalità non sono disegnati, renderebbero l'argomento mostrato in elenco
 * invisibile e non più modificabile da nessuna interfaccia. È lo stesso difetto (a)
 * che questa pagina ha appena finito di correggere, ricreato dalla porta accanto.
 *
 * ─── e perché nemmeno «destinatari E contenuti» ─────────────────────────────
 * Perché il verso opposto è RAGGIUNGIBILE, non teorico:
 * `registro_destinatari.alunno_id` ha una FK `ON DELETE CASCADE` verso `alunni`
 * (misurato il 2026-09-09: `confdeltype = 'c'`), quindi cancellare un alunno —
 * l'oblio GDPR, il ciclo alunno — porta via le sue righe di destinatario e lascia la
 * firma con i propri PIENI e zero destinatari. Pretendere entrambi aprirebbe quella
 * firma su «Tutta la classe», dove i riquadri dei propri non esistono: testo
 * invisibile, azzerato al primo salvataggio e in silenzio. Guardando il CONTENUTO,
 * invece, la modale si apre mirata e il bottone resta bloccato con
 * `firmaModalNessunDestinatario`: si sceglie un alunno, oppure si passa a «Tutta la
 * classe» e i propri si cancellano APPOSTA (`proprio()`).
 *
 * ⚠️ In produzione oggi le due regole coincidono: 18 firme, 1 assegnazione mirata
 * coerente, zero righe in entrambi i casi anomali. Si sceglie quella che non
 * nasconde niente, non quella che oggi basterebbe.
 */
function assegnazioneMirata(firma: Firma | null): boolean {
  return !!(firma?.argomento_proprio || firma?.compiti_propri);
}

type TipoFirma = 'principale' | 'compresenza' | 'cofirma' | 'sostegno';
const TIPI_FIRMA: TipoFirma[] = ['principale', 'compresenza', 'cofirma', 'sostegno'];
/** `firme_docenti.tipo_compresenza` è testo libero a DB: si normalizza, non si castà. */
function tipoFirmaDa(valore: string | null | undefined): TipoFirma {
  return TIPI_FIRMA.includes(valore as TipoFirma) ? (valore as TipoFirma) : 'principale';
}

function oggiIso() { return new Date().toISOString().slice(0, 10); }

/** L'esito di una GET applicativa: mai un'eccezione, sempre qualcosa da mostrare. */
interface Esito<T> { dati: T | null; errore: string | null }

/**
 * Una GET che non può sparire in silenzio.
 *
 * Tre modi di fallire, tre rami, e nessuno di loro è muto:
 *  · la fetch che non parte (rete giù, WebView in background) → `stato: 0`;
 *  · una risposta non-JSON (413/502 rispondono HTML: il `json()` LANCIA);
 *  · un `success: false` con status 200, che è la forma normale di questo repo.
 * Il livello dell'evento lo decide `logClient` in base allo `stato` (401/403/404
 * il server li vede e li logga già lui): qui si dichiara `error` e si lascia fare.
 */
async function chiediJson<T>(url: string, cosa: string): Promise<Esito<T>> {
  const res = await fetch(url).catch((e: unknown) => {
    logClient({ livello: 'warn', evento: 'fetch', messaggio: `${cosa}: ${nomeErrore(e)}`, route: ROTTA, stato: 0 });
    return null;
  });
  if (!res) return { dati: null, errore: '' };
  const corpo = await res.json().catch(() => null) as { success?: boolean; data?: T; error?: string } | null;
  if (res.ok && corpo?.success) return { dati: corpo.data ?? null, errore: null };
  logClient({ livello: 'error', evento: 'fetch', messaggio: cosa, route: ROTTA, stato: res.status });
  return { dati: null, errore: corpo?.error ?? '' };
}

export default function RegistroPage() {
  const t = useTranslations('teacherPrimaria');
  const params = useParams();
  const search = useSearchParams();
  const sectionId = params?.sectionId as string;
  const userId = getCurrentTeacherId(search);

  const [data, setData] = useState(oggiIso());
  const [campanelle, setCampanelle] = useState<Campanella[]>([]);
  const [orarioCelle, setOrarioCelle] = useState<OrarioCella[]>([]);
  const [righe, setRighe] = useState<Riga[]>([]);
  const [materie, setMaterie] = useState<Materia[]>([]);
  const [alunni, setAlunni] = useState<Alunno[]>([]);
  const [sezioni, setSezioni] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  // `null` = nessun guasto. `''` = guasto senza messaggio dal server (si traduce a schermo).
  const [erroreCaricamento, setErroreCaricamento] = useState<string | null>(null);
  /**
   * Il ruolo applicativo, da `GET /api/primaria/me`. Serve a UNA cosa sola: sapere se
   * la firma può restare di chi è collegato (`educator`) o se va attribuita a un
   * docente titolare (`risolviValutatore`, 422 «Seleziona il docente titolare…»).
   * `null` finché la risposta non arriva: in quel caso non si mostra la tendina e
   * non si blocca il bottone — meglio il 422 del server che un'interfaccia che
   * blocca un docente per una GET che non ha ancora risposto.
   */
  const [ruolo, setRuolo] = useState<string | null>(null);
  const [modal, setModal] = useState<{ ordine: number; materiaId: string; riga: Riga | null } | null>(null);

  // Elenco di tutte le sezioni primaria, per la "firma in un'altra classe" (supplenza).
  // La route filtra già per plesso (`resolveScuoleAttive`): qui non si restringe altro.
  useEffect(() => {
    let vivo = true;
    chiediJson<{ id: string; name: string }[]>(`/api/primaria/sezioni?userId=${userId}`, 'registro-sezioni-non-caricate')
      .then((e) => { if (vivo && e.dati) setSezioni(e.dati); });
    return () => { vivo = false; };
  }, [userId]);

  // Il ruolo di chi è collegato: decide se serve il selettore del docente titolare.
  useEffect(() => {
    let vivo = true;
    chiediJson<{ ruolo: string | null }>(`/api/primaria/me?userId=${userId}`, 'registro-ruolo-non-risolto')
      .then((e) => { if (vivo && e.dati?.ruolo) setRuolo(e.dati.ruolo); });
    return () => { vivo = false; };
  }, [userId]);

  const load = useCallback(async () => {
    // `try { … } finally { setLoading(false) }` e NIENTE blocco `catch`: il ramo
    // d'errore vive dentro `chiediJson`, che non lancia mai. Spostare il setter nel
    // corpo lineare fa scattare la regola sui setState dentro un effetto.
    try {
      const [reg, ctx] = await Promise.all([
        chiediJson<{ campanelle: Campanella[]; orarioCelle: OrarioCella[]; righe: Riga[] }>(
          `/api/primaria/registro?sectionId=${sectionId}&data=${data}&userId=${userId}`,
          'registro-giornata-non-caricata',
        ),
        chiediJson<{ materie?: Materia[]; alunni?: Alunno[] }>(
          `/api/primaria/classe/${sectionId}?userId=${userId}`,
          'registro-bundle-classe-non-caricato',
        ),
      ]);
      if (reg.dati) {
        // Teniamo TUTTE le campanelle (lezione + intervallo/mensa): le pause
        // vengono mostrate come righe non firmabili così la numerazione delle ore
        // non "salta" (lo slot escluso resta visibile). Firma/conteggi restano
        // sulle sole lezioni.
        setCampanelle(reg.dati.campanelle);
        setOrarioCelle(reg.dati.orarioCelle);
        setRighe(reg.dati.righe);
      }
      if (ctx.dati) {
        setMaterie(ctx.dati.materie ?? []);
        setAlunni(ctx.dati.alunni ?? []);
      }
      // Un 403 sul bundle classe lasciava la modale SENZA materie né alunni, muta:
      // la maestra apriva «Firma», trovava due tendine vuote e non c'era niente,
      // da nessuna parte, che dicesse perché.
      setErroreCaricamento(reg.errore ?? ctx.errore ?? null);
    } finally {
      setLoading(false);
    }
  }, [sectionId, data, userId]);

  useEffect(() => { load(); }, [load]);

  // Flush della coda registro al ritorno della connessione.
  useEffect(() => {
    const flush = () => syncPendingRegistro().then(load);
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, [load]);

  const uploadAllegato = async (registroId: string, file: File) => {
    if (!userId) { alert(t('comuneIdentitaNonRisolta')); return; }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('registroId', registroId);
    fd.append('userId', userId);
    // La rete che cade qui non lanciava un errore visibile: la promise rifiutata
    // usciva dal gestore dell'`onChange` e finiva nel raccoglitore globale delle
    // `unhandledrejection`. Il docente vedeva l'allegato semplicemente non comparire.
    const r = await fetch(`/api/primaria/allegati?userId=${userId}`, { method: 'POST', headers: { 'x-user-id': userId }, body: fd }).catch((e: unknown) => {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `registro-allegato-non-inviato: ${nomeErrore(e)}`, route: ROTTA, stato: 0 });
      return null;
    });
    if (!r) { alert(t('comuneErroreRete')); return; }
    if (r.ok) load();
    // `.catch(() => ({}))`: un 413 (file troppo grande) risponde HTML, non JSON,
    // e senza questo il parse lanciava una promise rifiutata non gestita.
    else {
      const d = await r.json().catch(() => ({} as { error?: string }));
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'registro-allegato-rifiutato', route: ROTTA, stato: r.status });
      alert(d.error || t('registroErroreUpload'));
    }
  };

  const rigaDi = (ordine: number) => righe.find((r) => r.ora_lezione === ordine);
  const plannedMateriaId = (camp: Campanella) =>
    orarioCelle.find((o) => o.campanella_id === camp.id)?.materia_id ?? '';
  // Solo le lezioni sono firmabili/contate; intervallo e mensa sono righe informative.
  const lezioni = campanelle.filter((c) => c.tipo === 'lezione');

  return (
    <div className="rounded-card bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-barlow text-lg font-bold text-kidville-ink">{t('registroTitolo')}</h2>
        <DateField
          value={data}
          onChange={setData}
          aria-label={t('registroDataAria')}
          className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm"
        />
      </div>

      {erroreCaricamento !== null && (
        <div role="alert" className="mb-4 rounded-card bg-kidville-error/10 px-3 py-2 font-maven text-sm text-kidville-error">
          {erroreCaricamento || t('registroErroreCaricamento')}
        </div>
      )}

      {!loading && lezioni.length > 0 && (() => {
        const firmate = lezioni.filter((c) => (rigaDi(c.ordine)?.firme_docenti?.length ?? 0) > 0).length;
        const tot = lezioni.length;
        return (
          <div className="mb-4 space-y-3">
            <div className="rounded-2xl bg-white p-4" style={{ boxShadow: 'inset 0 0 0 1.5px var(--color-kidville-line)' }}>
              <div className="flex items-end justify-between">
                <span className="font-barlow text-[11px] font-bold uppercase tracking-[0.1em] text-kidville-yellow-dark">{t('registroAvanzamentoFirme')}</span>
                <span className="font-barlow text-lg font-black text-kidville-green">
                  {firmate}<span className="text-kidville-muted">/{tot}</span>
                  <span className="ml-1 text-[11px] font-extrabold uppercase text-kidville-muted">{t('registroOreFirmate')}</span>
                </span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-kidville-cream-dark">
                <div className="h-full rounded-full bg-kidville-green transition-all" style={{ width: `${tot ? (firmate / tot) * 100 : 0}%` }} />
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-xl border border-kidville-info/20 bg-kidville-info-soft px-3 py-2.5">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-kidville-info" />
              <span className="font-maven text-[11.5px] leading-snug text-kidville-info">
                {t('registroInfoFirme')}
              </span>
            </div>
          </div>
        );
      })()}

      {loading ? (
        <p className="font-maven text-kidville-muted text-sm">{t('comuneCaricamento')}</p>
      ) : lezioni.length === 0 ? (
        <p className="font-maven text-kidville-muted text-sm">{t('registroNessunaOra')}</p>
      ) : (
        <ul className="space-y-2">
          {campanelle.map((camp) => {
            // Intervallo/mensa: riga informativa non firmabile (spiega il salto di numerazione).
            if (camp.tipo !== 'lezione') {
              return (
                <li key={camp.id} className="rounded-card border border-dashed border-kidville-line bg-kidville-cream/40 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-barlow text-[11px] font-bold uppercase tracking-[0.1em] text-kidville-muted">
                      {camp.tipo === 'mensa' ? t('registroMensa') : t('registroIntervallo')}
                    </span>
                    <span className="text-xs text-kidville-muted">{camp.ora_inizio?.slice(0, 5)}–{camp.ora_fine?.slice(0, 5)}</span>
                  </div>
                </li>
              );
            }
            const riga = rigaDi(camp.ordine);
            const plannedId = plannedMateriaId(camp);
            const plannedName = orarioCelle.find((o) => o.campanella_id === camp.id)?.materie?.nome;
            const materiaNome = riga?.materie?.nome || riga?.materia || plannedName;
            const firmata = (riga?.firme_docenti?.length ?? 0) > 0;
            return (
              <li key={camp.id} className="rounded-card border border-kidville-line p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-barlow text-sm font-bold text-kidville-green">{t('registroOra', { ora: camp.ordine })}</span>
                      <span className="text-xs text-kidville-muted">{camp.ora_inizio?.slice(0, 5)}–{camp.ora_fine?.slice(0, 5)}</span>
                      <span className={`font-maven text-sm ${materiaNome ? 'text-kidville-ink' : 'italic text-kidville-muted'}`}>
                        · {materiaNome || t('registroOrarioDaCompletare')}
                      </span>
                    </div>
                    {riga?.argomento && <p className="mt-1 font-maven text-sm text-kidville-ink">{riga.argomento}</p>}
                    {riga?.compiti && (
                      <p className="mt-1 rounded bg-kidville-yellow/20 px-2 py-1 font-maven text-xs text-kidville-ink">
                        {t('registroCompitiLabel')} {riga.compiti}
                      </p>
                    )}
                    {/* La data di consegna la GET la restituisce da sempre: fino al
                        2026-09-09 non compariva da nessuna parte, né qui né nella modale. */}
                    {riga?.data_consegna_compiti && (
                      <p className="mt-1 font-maven text-[11px] font-semibold text-kidville-yellow-dark">
                        {t('registroConsegnaEntro', { data: isoToIt(riga.data_consegna_compiti) })}
                      </p>
                    )}
                    {riga?.firme_docenti?.map((f) => (
                      <div key={f.id} className="mt-1 text-[11px] text-kidville-muted">
                        ✍ {f.utenti ? nomeCompleto(f.utenti.nome, f.utenti.cognome) : '—'} ({f.tipo_compresenza})
                        {f.argomento_proprio && <span className="ml-1 text-kidville-info">· {t('registroAttivitaIndividualizzata')}</span>}
                      </div>
                    ))}
                    {(riga?.allegati_registro?.length ?? 0) > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        {riga!.allegati_registro!.map((a) => (
                          <a key={a.id} href={a.file_url} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-pill bg-kidville-cream px-2 py-0.5 text-[11px] text-kidville-ink hover:bg-kidville-cream-dark">
                            {a.tipo === 'pdf' ? <FileText size={11} /> : <ImageIcon size={11} />}
                            {a.file_name || t('registroAllegato')}
                          </a>
                        ))}
                      </div>
                    )}
                    {riga && (
                      <div className="mt-1.5 flex items-center gap-3">
                        <label className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-kidville-green">
                          <Paperclip size={11} /> {t('registroAllega')}
                          <input
                            type="file"
                            accept="application/pdf,image/*"
                            className="hidden"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadAllegato(riga.id, f); }}
                          />
                        </label>
                        {/* Nativo: scatta la foto (compito/documento) come allegato. Su web non compare. */}
                        <ScattaFotoButton
                          onFile={(f) => uploadAllegato(riga.id, f)}
                          iconSize={11}
                          className="inline-flex items-center gap-1 text-[11px] text-kidville-green"
                        />
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => setModal({ ordine: camp.ordine, materiaId: plannedId, riga: riga ?? null })}
                    className={`font-maven inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-xs ${
                      firmata ? 'bg-kidville-cream text-kidville-green' : 'bg-kidville-green text-kidville-yellow'
                    }`}
                  >
                    {firmata ? <Check size={13} /> : <PenLine size={13} />}
                    {firmata ? t('registroModifica') : t('registroFirma')}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {modal && userId && (
        <FirmaModal
          // La modale è una schermata sui dati di UNA riga: cambiare riga la
          // rimonta, e l'idratazione riparte pulita invece di trascinarsi lo
          // stato dell'ora precedente.
          key={`${modal.ordine}-${modal.riga?.id ?? 'nuova'}`}
          sectionId={sectionId}
          userId={userId}
          ruolo={ruolo}
          data={data}
          ordine={modal.ordine}
          materie={materie}
          alunni={alunni}
          sezioni={sezioni}
          riga={modal.riga}
          defaultMateriaId={modal.materiaId}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
    </div>
  );
}

function FirmaModal({
  sectionId, userId, ruolo, data, ordine, materie, alunni, sezioni, riga, defaultMateriaId, onClose, onSaved,
}: {
  sectionId: string; userId: string; ruolo: string | null; data: string; ordine: number;
  materie: Materia[]; alunni: Alunno[]; sezioni: { id: string; name: string }[];
  riga: Riga | null; defaultMateriaId: string;
  onClose: () => void; onSaved: () => void;
}) {
  const t = useTranslations('teacherPrimaria');
  const uid = useId();
  const campo = (nome: string) => `${uid}-${nome}`;

  // Classe in cui si firma: di default quella corrente, ma il docente può
  // sceglierne un'altra (supplenza — un docente può firmare in qualunque classe
  // primaria del proprio plesso). Cambiando classe si azzera la materia
  // (le materie sono per-sezione e non sono caricate per le altre classi).
  const [targetSectionId, setTargetSectionId] = useState(sectionId);
  const altraClasse = targetSectionId !== sectionId;

  /**
   * CHI FIRMA. `risolviValutatore` (`src/lib/audit/valutatore.ts`) impone che la
   * firma resti del DOCENTE: per l'educator è sé stesso, per Segreteria e Direzione
   * va indicato il titolare in `docenteId`, altrimenti 422. Fino al 2026-09-09 in
   * questa pagina non esisteva nessun selettore e la POST non mandava mai quel
   * campo: il messaggio del server arrivava a schermo verbatim e chiedeva una cosa
   * che l'interfaccia non permetteva di fare.
   * `ruolo === null` = risposta non ancora arrivata: non si mostra niente e non si
   * blocca nessuno.
   */
  const serveDocente = ruolo !== null && ruolo !== 'educator';
  const [docenteId, setDocenteId] = useState('');
  const [docenti, setDocenti] = useState<Docente[]>([]);
  const [statoDocenti, setStatoDocenti] = useState<'attesa' | 'ok' | 'errore'>('attesa');
  /** L'autore della firma che si sta guardando: l'educator sé stesso, altrimenti il titolare scelto. */
  const autoreId = serveDocente ? docenteId : userId;

  const firmaDi = useCallback(
    (id: string) => (id ? riga?.firme_docenti?.find((f) => f.maestra_id === id) ?? null : null),
    [riga],
  );
  const destinatariDi = useCallback(
    (firma: Firma | null) =>
      firma ? (riga?.registro_destinatari ?? []).filter((d) => d.firma_id === firma.id).map((d) => d.alunno_id) : [],
    [riga],
  );

  const firmaIniziale = firmaDi(autoreId);
  const destIniziali = destinatariDi(firmaIniziale);

  // ─── IDRATAZIONE ────────────────────────────────────────────────────────────
  // Il bottone si chiama «Modifica» proprio quando la riga È firmata, e fino al
  // 2026-09-09 la modale si apriva comunque VUOTA. Non era solo scomodo: salvare
  // da lì AZZERAVA `argomento_proprio`/`compiti_propri` e i destinatari della firma
  // (upsert su `registro_id,maestra_id`) e riportava il tipo a «principale»,
  // declassando una firma di sostegno. I contenuti di CLASSE si idratano una volta
  // sola (sono della riga, non cambiano); quelli PROPRI seguono l'autore.
  const [materiaId, setMateriaId] = useState(riga?.materia_id || defaultMateriaId);
  const [argomento, setArgomento] = useState(riga?.argomento ?? '');
  const [compiti, setCompiti] = useState(riga?.compiti ?? '');
  const [dataConsegnaCompiti, setDataConsegnaCompiti] = useState(riga?.data_consegna_compiti ?? '');
  const [tipo, setTipo] = useState<TipoFirma>(tipoFirmaDa(firmaIniziale?.tipo_compresenza));
  const [argomentoProprio, setArgomentoProprio] = useState(firmaIniziale?.argomento_proprio ?? '');
  const [compitiPropri, setCompitiPropri] = useState(firmaIniziale?.compiti_propri ?? '');
  const [destinatari, setDestinatari] = useState<string[]>(destIniziali);
  // Toggle «Tutta la classe / Alunni selezionati» (P7/B1). Il sostegno è per
  // definizione individualizzato → per quel tipo l'assegnazione è forzata sugli alunni
  // selezionati. In supplenza (altra classe) resta di classe: gli alunni della sezione
  // in cui si firma non sono caricati, quindi la selezione non è disponibile.
  const [perAlunniSel, setPerAlunniSel] = useState(assegnazioneMirata(firmaIniziale));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  /**
   * Cambiare CLASSE cambia la RIGA di registro, e i contenuti condivisi sono di
   * quella riga: portarseli dietro scriverebbe l'argomento della 1ª A dentro la 2ª B.
   * Della classe altrui non sappiamo niente (la GET carica solo la propria), quindi si
   * riparte da vuoto — e `salva` non manda i campi vuoti, perché «non lo so» non è
   * «è vuoto» (vedi `condiviso`).
   */
  const [classeIdrata, setClasseIdrata] = useState(targetSectionId);
  if (classeIdrata !== targetSectionId) {
    setClasseIdrata(targetSectionId);
    const propria = targetSectionId === sectionId;
    setMateriaId(propria ? (riga?.materia_id || defaultMateriaId) : '');
    setArgomento(propria ? (riga?.argomento ?? '') : '');
    setCompiti(propria ? (riga?.compiti ?? '') : '');
    setDataConsegnaCompiti(propria ? (riga?.data_consegna_compiti ?? '') : '');
  }

  /**
   * Cambiare il docente titolare cambia LA FIRMA che si sta modificando, quindi i
   * campi «propri» vanno riletti dalla sua. Pattern «adjust state during render»
   * (lo stesso di `DateField`): niente setState dentro un effetto.
   */
  const [autoreIdrato, setAutoreIdrato] = useState(autoreId);
  if (autoreIdrato !== autoreId) {
    setAutoreIdrato(autoreId);
    const f = firmaDi(autoreId);
    const dest = destinatariDi(f);
    setTipo(tipoFirmaDa(f?.tipo_compresenza));
    setArgomentoProprio(f?.argomento_proprio ?? '');
    setCompitiPropri(f?.compiti_propri ?? '');
    setDestinatari(dest);
    setPerAlunniSel(assegnazioneMirata(f));
  }

  /**
   * I docenti titolari della classe in cui si firma.
   *
   * Si riusa l'endpoint che ESISTE GIÀ (`admin/sections/[id]/teachers`) invece di
   * crearne un altro: il suo `assigned` viene da `docentiDiSezione`, che legge
   * `utenti_sezioni` — cioè esattamente la tabella su cui `isTitolareSezione`
   * valida il `docenteId` inviato. Due elenchi diversi vorrebbero dire una tendina
   * che propone nomi che il server poi rifiuta con 422.
   * Il gate è `requireStaff(admin|coordinator|segreteria)`: per un educator sarebbe
   * 403, e infatti la chiamata non parte nemmeno. La classe è `targetSectionId`,
   * non `sectionId`: in supplenza il titolare da cercare è quello dell'ALTRA classe.
   */
  const caricaDocenti = useCallback(async (classeId: string): Promise<{ elenco: Docente[]; ok: boolean }> => {
    const res = await fetch(`/api/admin/sections/${classeId}/teachers?userId=${userId}`).catch((e: unknown) => {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `registro-docenti-non-caricati: ${nomeErrore(e)}`, route: ROTTA, stato: 0 });
      return null;
    });
    if (!res) return { elenco: [], ok: false };
    const corpo = await res.json().catch(() => null) as { success?: boolean; assigned?: Docente[] } | null;
    if (!res.ok || !corpo?.success) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'registro-docenti-non-caricati', route: ROTTA, stato: res.status });
      return { elenco: [], ok: false };
    }
    /*
     * SI FILTRA PER RUOLO, e il filtro è la sostanza di questa chiamata.
     *
     * `assigned` non è l'elenco dei docenti: è l'elenco del PERSONALE legato alla
     * sezione (`teachers/route.ts:60-64` → `RUOLI_PERSONALE`, che include admin,
     * coordinator, segreteria e cuoca). E poiché `isTitolareSezione`
     * (`valutatore.ts:24-43`) valida il `docenteId` sulla stessa `utenti_sezioni`,
     * il server ACCETTA la scelta: le due parti concordano, quindi nessuna delle
     * due ferma la firma forgiata. Senza questa riga la Segreteria potrebbe
     * attribuire a sé stessa — o alla Direzione, o alla cuoca — la firma che
     * `risolviValutatore` esiste per impedire («la firma resta del docente, non
     * della Segreteria», valutatore.ts:12-19), e per comparire in quella tendina le
     * basterebbe una POST sulla stessa route, che le è consentita.
     * Il ruolo assente vale come «non docente»: si esclude, mai il contrario.
     */
    const elenco = (corpo.assigned ?? []).filter((d) => d.ruolo === RUOLO_DOCENTE);
    return { elenco, ok: true };
  }, [userId]);

  useEffect(() => {
    if (!serveDocente) return;
    let vivo = true;
    caricaDocenti(targetSectionId).then(({ elenco, ok }) => {
      if (!vivo) return;
      setDocenti(elenco);
      setStatoDocenti(ok ? 'ok' : 'errore');
      // Cambiando classe il titolare scelto può non esserlo più: si azzera invece di
      // spedire un `docenteId` che il server rifiuterebbe con 422.
      setDocenteId((corrente) => (elenco.some((d) => d.id === corrente) ? corrente : ''));
    });
    return () => { vivo = false; };
  }, [serveDocente, targetSectionId, caricaDocenti]);

  const perAlunni = !altraClasse && (tipo === 'sostegno' ? true : perAlunniSel);
  /**
   * La firma VUOTA che si salvava con 200 e la spunta: con «Alunni selezionati» e
   * nessuna spunta il client mandava `argomento/compiti: undefined` e
   * `destinatariIds: []`, il server non scriveva niente e rispondeva 200. Per il
   * sostegno il toggle non è nemmeno disegnato, quindi era l'unica strada.
   */
  const senzaDestinatari = perAlunni && destinatari.length === 0;
  const senzaDocente = serveDocente && !docenteId;

  const toggleDest = (id: string) =>
    setDestinatari((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // Torna a "tutta la classe": azzera la selezione, così il submit non invia mai
  // destinatari residui quando l'assegnazione ridiventa di classe. I due riquadri
  // «propri» restano invece com'erano — un click sbagliato non deve cancellare il
  // testo — ma NON partono: chi lo impedisce è `proprio()`, sotto, che copre anche
  // le altre due uscite dalla modalità mirata (cambio tipo firma, supplenza).
  const scegliClasse = () => { setPerAlunniSel(false); setDestinatari([]); };
  const scegliAlunni = () => setPerAlunniSel(true);

  /**
   * Il valore di un campo CONDIVISO da mettere nel corpo, o `undefined` per non mandarlo.
   *
   * In supplenza la riga dell'ALTRA classe non è caricata: il textarea parte vuoto e NON
   * rappresenta il suo contenuto. Da quando il server scrive `'' → null` invece di ignorare
   * la stringa vuota, mandarlo CANCELLEREBBE l'argomento e i compiti scritti dal titolare di
   * quella classe — la regressione B1, riaperta dalla porta accanto. Nella PROPRIA classe il
   * campo è idratato, quindi un textarea vuoto vuole davvero dire «cancella» e si manda.
   */
  const condiviso = (valore: string) => (altraClasse && !valore ? undefined : valore);

  /**
   * Il valore di un campo PROPRIO (individualizzato) da mettere nel corpo.
   *
   * Simmetrico a `condiviso`, e per lo stesso motivo: **i propri viaggiano solo con
   * l'assegnazione MIRATA**, come i condivisi viaggiano solo con quella di classe.
   * Da quando i due riquadri sono IDRATATI dalla firma esistente, il loro stato
   * sopravvive a ogni uscita dalla modalità mirata — «Tutta la classe», il cambio di
   * tipo firma, la supplenza — e in tutti quei casi non sono nemmeno disegnati.
   * Spedirli pieni con `destinatariIds: []` è la richiesta che il server rifiuta con
   * 400 «Nessun alunno selezionato… oppure passa a "Tutta la classe"»
   * (`route.ts:386-393`): un errore che chiede una cosa che a schermo non c'è, sulla
   * stessa pagina che ha appena finito di correggerne uno identico.
   *
   * Tre casi, non due:
   *  · mirata            → il valore, così com'è;
   *  · di classe, QUI    → `''`, che il server (`route.ts:527-528`) scrive NULL.
   *    Ometterlo lascerebbe i propri a database, invisibili e non più modificabili;
   *  · di classe, ALTROVE (supplenza) → **niente**. Della firma del docente in
   *    quell'altra classe non sappiamo nulla: mandare `''` cancellerebbe la SUA
   *    attività individualizzata. «Non lo so» non è «è vuoto» — vedi `condiviso`.
   *
   * Sta nel corpo della richiesta e non nei setter di stato apposta: le strade che
   * escono dall'assegnazione mirata sono almeno tre, e una regola valida per più
   * strade vive in un posto solo. In cambio, un click sbagliato su «Tutta la classe»
   * non cancella il testo appena scritto: torna al click successivo.
   */
  const proprio = (valore: string) => (perAlunni ? valore : altraClasse ? undefined : '');

  const salva = async () => {
    if (senzaDestinatari || senzaDocente) return;
    setSaving(true);
    setError('');
    // Offline-first: senza rete si accoda SOLO la firma di classe (no destinatari): la
    // selezione degli alunni richiede la connessione (validazione + oscuramento lato server).
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      if (perAlunni) {
        setSaving(false);
        setError(t('firmaModalSelezioneOffline'));
        return;
      }
      // La coda offline non trasporta `docenteId` (`syncPendingRegistro`): una firma
      // di Segreteria accodata qui verrebbe rifiutata con 422 al primo flush, per
      // sempre e in silenzio. Meglio dirlo adesso.
      if (serveDocente) {
        setSaving(false);
        setError(t('firmaModalDocenteOffline'));
        return;
      }
      /*
       * LA SUPPLENZA OFFLINE SI RIFIUTA, e non è prudenza: è che la coda non sa dire
       * «questo campo non mandarlo».
       *
       * Due difetti in un colpo solo, misurati. (1) La riga accodata portava
       * `section_id: sectionId` — la classe della PAGINA, non quella firmata: la lezione
       * fatta in 2ª B finiva nel registro della 1ª A, con un «salvato» tranquillo.
       * `syncPendingRegistro` è scritto proprio per NON reinterpretare la sezione, quindi
       * nessuno a valle rimediava. (2) `LocalPrimariaRegistro.argomento` è
       * `string | null`, e `syncPendingRegistro` lo spedisce sempre: da quando il server
       * scrive `'' → null` invece di ignorare il vuoto, una supplenza accodata con i
       * campi vuoti — che è il caso NORMALE, perché della riga altrui non sappiamo niente —
       * CANCELLA argomento e compiti scritti dal titolare di quella classe.
       * Online il problema non si pone: lì il campo si OMETTE (vedi `condiviso`).
       */
      if (altraClasse) {
        setSaving(false);
        setError(t('firmaModalSupplenzaOffline'));
        return;
      }
      await saveLocalRegistro({
        // `targetSectionId` e non `sectionId`: in supplenza sono classi diverse, e la
        // sezione che si accoda dev'essere quella che si sta FIRMANDO. Qui le due
        // coincidono per forza (il ramo `altraClasse` è già uscito), ma scriverlo giusto
        // è ciò che impedisce al difetto di tornare se un domani il rifiuto cade.
        id: crypto.randomUUID(), section_id: targetSectionId, data, ora_lezione: ordine,
        materia_id: materiaId || null, argomento, compiti,
        // La data di consegna viaggia anche OFFLINE: il ramo online la spedisce da
        // sempre, questo la lasciava fuori dall'oggetto in coda e il docente vedeva
        // «salvato» mentre la scadenza spariva fra il telefono e il server.
        data_consegna_compiti: dataConsegnaCompiti || null,
        tipo_compresenza: tipo,
        creato_il: new Date().toISOString(),
      });
      setSaving(false);
      onSaved();
      return;
    }
    const r = await fetch(`/api/primaria/registro?userId=${userId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({
        sectionId: targetSectionId, data, oraLezione: ordine, materiaId: altraClasse ? null : (materiaId || null),
        // Argomento/compiti/consegna sono i contenuti CONDIVISI di classe: si inviano SOLO per
        // l'assegnazione a tutta la classe. In modalità «Alunni selezionati» (perAlunni) i
        // textarea condivisi non sono nemmeno mostrati e i loro stati restano vuoti: inviarli
        // sovrascriverebbe con stringhe vuote i contenuti scritti dal titolare sulla riga
        // condivisa (regressione B1). Coerente con la label «(solo per gli alunni selezionati)».
        argomento: perAlunni ? undefined : condiviso(argomento),
        compiti: perAlunni ? undefined : condiviso(compiti),
        dataConsegnaCompiti: perAlunni ? undefined : (altraClasse && !dataConsegnaCompiti ? undefined : (dataConsegnaCompiti || null)),
        tipoCompresenza: tipo,
        // I contenuti PROPRI: solo con l'assegnazione mirata, vuoti quando l'ora torna
        // di classe, ASSENTI in supplenza. I tre casi, e il perché, stanno in `proprio()`.
        argomentoProprio: proprio(argomentoProprio), compitiPropri: proprio(compitiPropri),
        // Destinatari inviati quando l'assegnazione è mirata e siamo nella classe corrente.
        destinatariIds: perAlunni && !altraClasse ? destinatari : [],
        // Segreteria/Direzione: la firma resta del docente titolare indicato.
        docenteId: serveDocente ? docenteId : undefined,
        // ── IL PATTO COL SERVER, e senza di lui metà della correzione non arriva ──
        // Un riquadro condiviso lasciato VUOTO vale «svuota» soltanto se chi lo manda
        // ha davvero letto ciò che c'era: altrimenti è «non lo so», e scriverlo
        // cancellerebbe il testo di un collega. Il server rifiuta l'azzeramento a chi
        // non lo dichiara (`condivisiIdratati`) — ed è la difesa che protegge dalla
        // coda offline, che i tre condivisi li spedisce sempre senza averli letti.
        // Qui la dichiarazione è VERA: dal 2026-09-09 gli stati nascono da `riga`.
        // Ma SOLO nella propria classe: in supplenza la GET non carica la riga
        // dell'altra sezione (`classeIdrata` riazzera i campi), e dichiararlo lì
        // significherebbe cancellare l'argomento di un'altra classe con un modulo
        // che non l'ha mai visto. Senza questa riga il compito assegnato per errore
        // resterebbe per sempre — cioè il difetto da cui è partito tutto.
        condivisiIdratati: !altraClasse,
      }),
    }).catch((e: unknown) => {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `registro-firma-non-inviata: ${nomeErrore(e)}`, route: ROTTA, stato: 0 });
      return null;
    });
    if (!r) { setSaving(false); setError(t('comuneErroreRete')); return; }
    // `.catch(() => ({}))`: 413 e 502 rispondono HTML, non JSON. Senza questo il
    // `json()` LANCIAVA prima di `setSaving(false)` e il bottone restava disabilitato
    // per sempre — la stessa lezione già imparata dieci righe più su, sugli allegati.
    const d = await r.json().catch(() => ({} as { error?: string; success?: boolean }));
    setSaving(false);
    if (!r.ok || d.success === false) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: 'registro-firma-rifiutata', route: ROTTA, stato: r.status });
      setError(d.error || t('comuneErrore'));
    } else onSaved();
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-kidville-ink/40 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby={campo('titolo')} className="flex max-h-[85dvh] w-full max-w-md flex-col rounded-card bg-white shadow-xl">
        <div className="flex items-center gap-2 rounded-t-card bg-kidville-green p-4 text-kidville-yellow">
          <BookOpen size={18} />
          <h3 id={campo('titolo')} className="font-barlow text-lg font-bold">{t('firmaModalTitolo', { ora: ordine })}</h3>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          {error && <div role="alert" className="rounded-card bg-kidville-error/10 text-kidville-error px-3 py-2 text-sm font-maven">{error}</div>}

          {/* Classe: di default la corrente, ma è possibile firmare in un'altra (supplenza). */}
          {sezioni.length > 1 && (
            <div>
              <label htmlFor={campo('classe')} className="block font-maven text-xs text-kidville-muted">{t('firmaModalClasse')}</label>
              <select id={campo('classe')} value={targetSectionId} onChange={(e) => setTargetSectionId(e.target.value)} className="font-maven w-full rounded-pill border border-kidville-line px-3 py-2 text-sm">
                {sezioni.map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === sectionId ? ` ${t('firmaModalQuestaClasse')}` : ''}</option>)}
              </select>
              {altraClasse && <p className="mt-1 font-maven text-[11px] text-kidville-warn">{t('firmaModalSupplenza')}</p>}
            </div>
          )}

          {/* Segreteria/Direzione: la firma è del docente, mai della Segreteria. */}
          {serveDocente && (
            <div>
              {/* `text-kidville-sub` e NON `muted`: quel token sta a 2,51:1 su bianco, sotto i
                  4,5:1 di WCAG AA, e il suo debito può solo calare (`__tests__/a11y/testo-muted-allowlist`).
                  Le etichette qui accanto lo usano perché sono più vecchie del lock, non perché vada bene. */}
              <label htmlFor={campo('docente')} className="block font-maven text-xs text-kidville-sub">{t('firmaModalDocenteTitolare')}</label>
              <select
                id={campo('docente')}
                required
                value={docenteId}
                onChange={(e) => setDocenteId(e.target.value)}
                className="font-maven w-full rounded-pill border border-kidville-line px-3 py-2 text-sm"
              >
                <option value="">{t('firmaModalSeleziona')}</option>
                {docenti.map((d) => (
                  <option key={d.id} value={d.id}>{nomeCompleto(d.nome, d.cognome, 'cognome-nome')}</option>
                ))}
              </select>
              <p className="mt-1 font-maven text-[11px] text-kidville-sub">
                {statoDocenti === 'errore'
                  ? t('firmaModalDocentiNonCaricati')
                  : statoDocenti === 'ok' && docenti.length === 0
                    ? t('firmaModalNessunDocente')
                    : t('firmaModalDocenteObbligatorio')}
              </p>
            </div>
          )}

          {!altraClasse && (
            <div>
              <label htmlFor={campo('materia')} className="block font-maven text-xs text-kidville-muted">{t('firmaModalMateria')}</label>
              <select id={campo('materia')} value={materiaId} onChange={(e) => setMateriaId(e.target.value)} className="font-maven w-full rounded-pill border border-kidville-line px-3 py-2 text-sm">
                <option value="">{t('firmaModalSeleziona')}</option>
                {materie.map((m) => <option key={m.id} value={m.id}>{m.nome}</option>)}
              </select>
            </div>
          )}

          <div>
            <label htmlFor={campo('tipo')} className="block font-maven text-xs text-kidville-muted">{t('firmaModalTipoFirma')}</label>
            <select id={campo('tipo')} value={tipo} onChange={(e) => setTipo(e.target.value as TipoFirma)} className="font-maven w-full rounded-pill border border-kidville-line px-3 py-2 text-sm">
              <option value="principale">{t('firmaModalTipoPrincipale')}</option>
              <option value="compresenza">{t('firmaModalTipoCompresenza')}</option>
              <option value="cofirma">{t('firmaModalTipoCofirma')}</option>
              <option value="sostegno">{t('firmaModalTipoSostegno')}</option>
            </select>
          </div>

          {/* Destinatari (P7/B1): compiti e argomento per TUTTA LA CLASSE o per ALUNNI
              SELEZIONATI. Il toggle vale per qualsiasi tipo di firma; per il sostegno è
              forzato (attività sempre individualizzata) e per questo non compare. In
              supplenza (altra classe) l'assegnazione resta di classe. */}
          {!altraClasse && tipo !== 'sostegno' && (
            <div>
              <label className="block font-maven text-xs text-kidville-muted">{t('firmaModalDestinatari')}</label>
              <div className="mt-1 inline-flex rounded-pill border border-kidville-line p-0.5" role="group" aria-label={t('firmaModalDestinatariAria')}>
                <button
                  type="button"
                  onClick={scegliClasse}
                  aria-pressed={!perAlunni}
                  className={`font-maven rounded-pill px-3 py-1 text-xs ${!perAlunni ? 'bg-kidville-green text-kidville-yellow' : 'text-kidville-ink'}`}
                >
                  {t('firmaModalTuttaClasse')}
                </button>
                <button
                  type="button"
                  onClick={scegliAlunni}
                  aria-pressed={perAlunni}
                  className={`font-maven rounded-pill px-3 py-1 text-xs ${perAlunni ? 'bg-kidville-green text-kidville-yellow' : 'text-kidville-ink'}`}
                >
                  {t('firmaModalAlunniSelezionati')}
                </button>
              </div>
            </div>
          )}

          {!perAlunni ? (
            <>
              <div>
                <label htmlFor={campo('argomento')} className="block font-maven text-xs text-kidville-muted">{t('firmaModalArgomentoClasse')}</label>
                <textarea id={campo('argomento')} value={argomento} onChange={(e) => setArgomento(e.target.value)} rows={2} className="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm" />
              </div>
              <div>
                <label htmlFor={campo('compiti')} className="block font-maven text-xs text-kidville-muted">{t('firmaModalCompitiClasse')}</label>
                <textarea id={campo('compiti')} value={compiti} onChange={(e) => setCompiti(e.target.value)} rows={2} className="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm" />
              </div>
            </>
          ) : (
            <div className="rounded-card bg-kidville-info-soft p-3">
              <p className="mb-2 font-maven text-xs text-kidville-info">
                {tipo === 'sostegno'
                  ? t('firmaModalInfoSostegno')
                  : t('firmaModalInfoSelezionati')}
              </p>
              <div className="mb-2 max-h-32 overflow-y-auto rounded bg-white p-2">
                {alunni.map((a) => (
                  <label key={a.id} className="flex items-center gap-2 py-0.5 font-maven text-sm">
                    <input type="checkbox" checked={destinatari.includes(a.id)} onChange={() => toggleDest(a.id)} />
                    {nomeCompleto(a.nome, a.cognome, 'cognome-nome')}
                  </label>
                ))}
              </div>
              {senzaDestinatari && (
                <p role="status" className="mb-2 font-maven text-[11px] font-semibold text-kidville-error">
                  {t('firmaModalNessunDestinatario')}
                </p>
              )}
              <label htmlFor={campo('argomento-propri')} className="block font-maven text-xs text-kidville-muted">{t('firmaModalArgomentoSelezionati')}</label>
              <textarea id={campo('argomento-propri')} value={argomentoProprio} onChange={(e) => setArgomentoProprio(e.target.value)} rows={2} className="mb-2 font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm" />
              <label htmlFor={campo('compiti-propri')} className="block font-maven text-xs text-kidville-muted">{t('firmaModalCompitiSelezionati')}</label>
              <textarea id={campo('compiti-propri')} value={compitiPropri} onChange={(e) => setCompitiPropri(e.target.value)} rows={2} className="font-maven w-full rounded-card border border-kidville-line px-3 py-2 text-sm" />
            </div>
          )}

          {/* Data di consegna compiti (facoltativa): è un campo di CLASSE
              (registro_orario.data_consegna_compiti) → solo per l'assegnazione a tutta la
              classe. La consegna per i singoli destinatari (data_consegna_propri) è rinviata. */}
          {!perAlunni && (
            <div>
              <label htmlFor={campo('consegna')} className="block font-maven text-xs text-kidville-muted">{t('firmaModalConsegnaCompiti')}</label>
              <DateField
                id={campo('consegna')}
                value={dataConsegnaCompiti}
                onChange={setDataConsegnaCompiti}
                aria-label={t('firmaModalConsegnaAria')}
                className="font-maven w-full rounded-pill border border-kidville-line px-3 py-2 text-sm"
              />
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-kidville-line p-4">
          <button onClick={onClose} className="font-maven rounded-pill bg-kidville-cream px-4 py-2 text-sm text-kidville-ink">{t('firmaModalAnnulla')}</button>
          <button onClick={salva} disabled={saving || senzaDestinatari || senzaDocente} className="font-maven rounded-pill bg-kidville-green px-4 py-2 text-sm text-kidville-yellow disabled:opacity-50">
            {saving ? t('comuneSalvataggio') : t('registroFirma')}
          </button>
        </div>
      </div>
    </div>
  );
}
