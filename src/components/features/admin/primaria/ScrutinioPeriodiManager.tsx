'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDateFormat } from '@/lib/i18n/date';
import { Plus, Trash2, GraduationCap, Archive, ArchiveRestore } from 'lucide-react';
import { DateField } from '@/components/ui/DateField';
import { creaMuta } from '@/lib/ui/muta';
import { dataCivile } from '@/i18n/config';
import { useAnnoDi } from '@/lib/context/calendario-context';
import { useCorrezioneAnno } from '@/components/features/anno/useCorrezioneAnno';

interface Periodo {
  id: string; nome: string; anno_scolastico: string; ordine: number;
  data_inizio: string | null; data_fine: string | null; attivo: boolean;
  /** Fase 4 della robustezza: un periodo archiviato esce dall'elenco, e niente di suo si perde. */
  archiviato_il?: string | null;
}

// `scuolaId` arriva da <SedeRequired> (una sede sola, mai ambigua) e va
// DICHIARATO al server: la route non scrive più su `utenti.scuola_id`, e con tre
// plessi dedurre la sede dal solo cookie `sedi_attive` è un canale implicito —
// se il cookie è stantìo o assente il periodo finirebbe nel plesso sbagliato, o
// la scrittura verrebbe rifiutata con un 400 che l'utente non sa spiegarsi.
export function ScrutinioPeriodiManager({ scuolaId, userId }: { scuolaId: string; userId: string }) {
  const t = useTranslations('adminPrimaria');
  const f = useDateFormat();
  const [periodi, setPeriodi] = useState<Periodo[]>([]);
  // L'anno proposto è quello del calendario della sede per il giorno di Roma; chi scrive nella casella lo vince
  // (stato derivato: nessun effetto copia il calendario nello stato, e un valore a mano non viene sovrascritto).
  const [oggi] = useState(() => dataCivile());
  const annoProposto = useAnnoDi(scuolaId)(oggi).etichetta;
  const [annoScelto, setAnnoScelto] = useState<string | null>(null);
  const anno = annoScelto ?? annoProposto;
  // Un periodo di un anno già chiuso si crea come CORREZIONE (PR 4.9): il server risponde 409 con `correzione_possibile`.
  const { inviaConCorrezione, dialogo } = useCorrezioneAnno(anno);
  const [nome, setNome] = useState('');
  const [dataInizio, setDataInizio] = useState('');
  const [dataFine, setDataFine] = useState('');
  const [msg, setMsg] = useState('');
  const [mostraArchiviati, setMostraArchiviati] = useState(false);
  // Spec D4: per questa sede e questo anno non c'è un periodo attivo, o ne manca una data. Il server lo calcola solo
  // se la richiesta dichiara sede E anno (la GET qui sotto li manda entrambi) e risponde `null` altrimenti: solo
  // `true` accende il promemoria, `false` e `null` lo spengono.
  const [dateMancanti, setDateMancanti] = useState(false);

  const load = useCallback(async () => {
    let next: Periodo[] | null = null;
    let mancanti = false;
    try {
      const archiviati = mostraArchiviati ? '&archiviati=si' : '';
      const r = await fetch(`/api/admin/primaria/scrutinio-periodi?scuolaId=${scuolaId}&annoScolastico=${anno}&userId=${userId}${archiviati}`, { headers: { 'x-user-id': userId } });
      const d = await r.json();
      if (d.success) { next = d.data; mancanti = d.dateMancanti === true; }
    } finally {
      // Elenco e promemoria si aggiornano insieme, e solo se la risposta è buona: una GET fallita non deve
      // spegnere né accendere il promemoria che c'era.
      if (next) { setPeriodi(next); setDateMancanti(mancanti); }
    }
  }, [scuolaId, anno, userId, mostraArchiviati]);

  useEffect(() => { load(); }, [load]);

  /**
   * «Aggiungi periodo» mostrava il rifiuto; «elimina» e il pulsante
   * attivo/disattivo no. Quest'ultimo è il più insidioso dei tre: un periodo
   * che resta «attivo» a schermo ma disattivo nel database è ciò che decide se
   * uno scrutinio si può compilare, e il docente lo scopre altrove.
   *
   * I due ripieghi sono distinti perché dicono in che STATO è rimasto il dato.
   */
  const { mutaSalva, mutaElimina } = useMemo(() => {
    // Il server può salvare le date e non riuscire a riassegnare i voti ai quadrimestri (`ricalcolo: 'non-riuscito'`): il dato è
    // salvato, ma chi ha premuto il pulsante deve saperlo (il motivo è già nel log del server).
    const avvisoDalSuccesso = (corpo: unknown) =>
      (corpo as { ricalcolo?: unknown } | null)?.ricalcolo === 'non-riuscito' ? t('periodiRicalcoloNonRiuscito') : null;
    const comuni = { route: '/admin/impostazioni', ricarica: load, setErrore: setMsg, inviaConCorrezione, avvisoDalSuccesso };
    return {
      mutaSalva: creaMuta({ ...comuni, fallback: t('comuneErroreSalvataggio') }),
      mutaElimina: creaMuta({ ...comuni, fallback: t('comuneErroreEliminazione') }),
    };
  }, [load, t, inviaConCorrezione]);

  const aggiungi = async () => {
    setMsg('');
    if (!nome.trim()) { setMsg(t('periodiInserisciNome')); return; }
    // I tre campi si svuotano SOLO se il server ha accettato.
    const ok = await mutaSalva(
      `/api/admin/primaria/scrutinio-periodi?userId=${userId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ scuolaId, annoScolastico: anno, nome: nome.trim(), ordine: periodi.length + 1, dataInizio: dataInizio || null, dataFine: dataFine || null }),
      },
      'primaria-scrutinio-periodo-nuovo-respinto',
    );
    if (ok) { setNome(''); setDataInizio(''); setDataFine(''); }
  };

  const rimuovi = async (p: Periodo) => {
    if (!confirm(t('periodiConfermaElimina'))) return;
    await mutaElimina(
      `/api/admin/primaria/scrutinio-periodi?id=${p.id}&userId=${userId}`,
      // Un DELETE non ha corpo: lo mandiamo JSON (vuoto) perché su un anno chiuso la correzione viaggia lì dentro, mai nella URL.
      { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'x-user-id': userId }, body: JSON.stringify({}) },
      'primaria-scrutinio-periodo-elimina-respinto',
      p.nome,
    );
  };

  /**
   * Archiviare non cancella: il periodo esce dall'elenco e non si compila più, e scrutini e
   * pagelle restano. È l'uscita per un periodo che non si può eliminare perché ha scrutini.
   */
  const archivia = async (p: Periodo, archiviato: boolean) => {
    if (archiviato && !confirm(t('periodiConfermaArchivia'))) return;
    await mutaSalva(
      `/api/admin/primaria/scrutinio-periodi?userId=${userId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ id: p.id, archiviato }),
      },
      archiviato ? 'primaria-scrutinio-periodo-archivia-respinto' : 'primaria-scrutinio-periodo-ripristina-respinto',
      p.nome,
    );
  };

  const toggleAttivo = async (p: Periodo) => {
    await mutaSalva(
      `/api/admin/primaria/scrutinio-periodi?userId=${userId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ id: p.id, attivo: !p.attivo }),
      },
      'primaria-scrutinio-periodo-attivo-respinto',
      p.nome,
    );
  };

  return (
    <div>
      <h3 className="font-barlow text-base font-bold text-kidville-ink mb-1 flex items-center gap-2">
        <GraduationCap size={16} className="text-kidville-green" /> {t('periodiTitolo')}
      </h3>
      <p className="font-maven text-xs text-kidville-muted mb-4">{t('periodiSottotitolo')}</p>

      {msg && (
        <p role="alert" className="font-maven mb-4 rounded-card bg-kidville-error/10 px-4 py-2 text-sm text-kidville-error">{msg}</p>
      )}

      {dateMancanti && (
        <p role="status" className="font-maven mb-4 rounded-card bg-kidville-warn-soft px-4 py-2 text-sm text-kidville-warn-strong">{t('periodiPromemoriaDate')}</p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="font-maven text-sm text-kidville-ink">{t('periodiAnnoScolastico')}</label>
        <input value={anno} onChange={(e) => setAnnoScelto(e.target.value)} className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm w-28" />
        <label className="font-maven ml-auto inline-flex items-center gap-1.5 text-xs text-kidville-sub">
          <input type="checkbox" checked={mostraArchiviati} onChange={(e) => setMostraArchiviati(e.target.checked)} />
          {t('periodiMostraArchiviati')}
        </label>
      </div>

      <ul className="divide-y divide-kidville-line mb-4">
        {periodi.length === 0 && <li className="py-2 font-maven text-sm text-kidville-muted">{t('periodiNessuno')}</li>}
        {periodi.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2 py-2.5">
            <div>
              <span className="font-maven text-sm font-semibold text-kidville-ink">{p.ordine}. {p.nome}</span>
              {p.archiviato_il && (
                <span className="font-maven ml-2 rounded-pill bg-kidville-line px-2 py-0.5 text-[11px] text-kidville-sub">{t('periodiArchiviatoBadge')}</span>
              )}
              {(p.data_inizio || p.data_fine) && (
                <span className="font-maven text-xs text-kidville-muted ml-2">
                  {p.data_inizio ? f.dataBreve(p.data_inizio) : '…'} – {p.data_fine ? f.dataBreve(p.data_fine) : '…'}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {p.archiviato_il ? (
                <button onClick={() => archivia(p, false)} aria-label={t('periodiRipristina')} title={t('periodiRipristina')} className="text-kidville-sub hover:text-kidville-green"><ArchiveRestore size={15} /></button>
              ) : (
                <>
                  <button onClick={() => toggleAttivo(p)} className={`font-maven rounded-pill px-2.5 py-0.5 text-[11px] ${p.attivo ? 'bg-kidville-success-soft text-kidville-success' : 'bg-kidville-line text-kidville-muted'}`}>
                    {p.attivo ? t('periodiAttivo') : t('periodiDisattivo')}
                  </button>
                  <button onClick={() => archivia(p, true)} aria-label={t('periodiArchivia')} title={t('periodiArchivia')} className="text-kidville-sub hover:text-kidville-ink"><Archive size={15} /></button>
                  <button onClick={() => rimuovi(p)} aria-label={t('periodiElimina')} className="text-kidville-muted hover:text-kidville-error"><Trash2 size={15} /></button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="rounded-card bg-kidville-cream/40 p-3">
        <p className="font-maven text-xs text-kidville-muted mb-2">{t('periodiNuovoTitolo')}</p>
        <div className="grid gap-2 md:grid-cols-3">
          <input value={nome} onChange={(e) => setNome(e.target.value)} placeholder={t('periodiPlaceholderNome')} className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm" />
          <DateField value={dataInizio} onChange={setDataInizio} aria-label={t('periodiAriaDataInizio')} className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm" />
          <DateField value={dataFine} onChange={setDataFine} aria-label={t('periodiAriaDataFine')} className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm" />
        </div>
        <button onClick={aggiungi} className="font-maven mt-2 inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow">
          <Plus size={14} /> {t('periodiAggiungiPeriodo')}
        </button>
      </div>
      {dialogo}
    </div>
  );
}
