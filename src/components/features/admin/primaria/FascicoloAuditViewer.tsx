'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { intlDateTime } from '@/i18n/config';
import { useDateFormat } from '@/lib/i18n/date';
import { FolderLock, RefreshCw } from 'lucide-react';
import { FINALITA_AUDIT_ANAGRAFICA } from '@/lib/anagrafiche/docente/tipi';
import { logClient, nomeErrore } from '@/lib/logging/client';

interface AuditRow {
  id: string;
  azione: string;
  finalita: string | null;
  ip: string | null;
  creato_il: string;
  utenti: { nome: string | null; cognome: string | null; ruolo?: string | null; role?: string | null } | null;
  alunni: { nome: string | null; cognome: string | null } | null;
}

// La chiave del record è il valore DB (r.azione); `lKey` è la chiave i18n dell'etichetta.
const AZIONE: Record<string, { lKey: string; cls: string }> = {
  list: { lKey: 'fascicoloAzioneList', cls: 'bg-kidville-line text-kidville-ink' },
  view: { lKey: 'fascicoloAzioneView', cls: 'bg-kidville-info-soft text-kidville-info' },
  download: { lKey: 'fascicoloAzioneDownload', cls: 'bg-kidville-warn-soft text-kidville-warn' },
  upload: { lKey: 'fascicoloAzioneUpload', cls: 'bg-kidville-success-soft text-kidville-success' },
  delete: { lKey: 'fascicoloAzioneDelete', cls: 'bg-kidville-error-soft text-kidville-error' },
};

/**
 * La lettura, fuori dal componente: restituisce le righe, oppure `null` se il registro
 * non ha risposto (rete giù o risposta senza `success`), e non tocca lo stato. Un errore
 * di rete si logga a `warn`, come fa il logger globale per una fetch mancata; un `!res.ok`
 * lo registra già il fetch strumentato.
 */
async function leggiRegistro(userId: string, conAnagrafica: boolean): Promise<AuditRow[] | null> {
  const filtro = conAnagrafica ? '&conAnagrafica=1' : '';
  const d: { success?: boolean; data?: AuditRow[] } | null = await fetch(
    `/api/admin/primaria/fascicolo-audit?limit=200&userId=${userId}${filtro}`,
    { headers: { 'x-user-id': userId } },
  )
    .then((r) => r.json())
    .catch((e: unknown) => {
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `registro accessi fascicolo non letto (${nomeErrore(e)})`, route: '/admin/primaria' });
      return null;
    });
  return d?.success && Array.isArray(d.data) ? d.data : null;
}

export function FascicoloAuditViewer({ userId }: { scuolaId: string; userId: string }) {
  const t = useTranslations('adminPrimaria');
  const f = useDateFormat();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Le aperture della scheda anagrafica dal docente sono decine al giorno: dentro una
  // finestra di 200 righe spingerebbero fuori le visioni vere di PEI/PDP. Si chiedono
  // a parte, con l'interruttore spento di default.
  const [conAnagrafica, setConAnagrafica] = useState(false);
  const [tentativo, setTentativo] = useState(0);
  // Una lettura fallita SVUOTA la tabella: le righe rimaste sarebbero quelle dell'altra
  // posizione dell'interruttore, cioè una risposta a una domanda diversa.
  const [erroreLettura, setErroreLettura] = useState(false);

  // Il `setState` sta nel `.then` (la forma che `react-hooks/set-state-in-effect`
  // accetta). `vivo` scarta la risposta di una lettura superata: accendendo e spegnendo
  // in fretta, una risposta vecchia arrivata in ritardo non copre quella giusta.
  useEffect(() => {
    let vivo = true;
    void leggiRegistro(userId, conAnagrafica).then((righe) => {
      if (!vivo) return;
      setRows(righe ?? []);
      setErroreLettura(righe === null);
      setLoading(false);
    });
    return () => {
      vivo = false;
    };
  }, [userId, conAnagrafica, tentativo]);

  const aggiorna = () => {
    setLoading(true);
    setTentativo((n) => n + 1);
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-barlow text-base font-bold text-kidville-ink flex items-center gap-2">
          <FolderLock size={16} className="text-kidville-green" /> {t('fascicoloTitolo')}
        </h3>
        <button onClick={aggiorna} className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green/10 px-3 py-1.5 text-xs text-kidville-green">
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> {t('fascicoloAggiorna')}
        </button>
      </div>
      <p className="font-maven text-xs text-kidville-muted mb-3">{t('fascicoloSottotitolo')}</p>
      <label className="mb-3 inline-flex items-center gap-2 font-maven text-xs text-kidville-ink">
        <input
          type="checkbox"
          checked={conAnagrafica}
          onChange={(e) => {
            setLoading(true);
            setConAnagrafica(e.target.checked);
          }}
        />
        {t('fascicoloIncludiAnagrafica')}
      </label>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left font-maven text-xs text-kidville-muted">
              <th className="py-2 pr-3">{t('fascicoloColData')}</th>
              <th className="py-2 pr-3">{t('fascicoloColAzione')}</th>
              <th className="py-2 pr-3">{t('fascicoloColUtente')}</th>
              <th className="py-2 pr-3">{t('fascicoloColAlunno')}</th>
              <th className="py-2 pr-3">{t('fascicoloColIp')}</th>
            </tr>
          </thead>
          <tbody>
            {/* «Nessun accesso registrato» solo se il registro ha risposto: dopo una lettura
                fallita sarebbe falso. */}
            {erroreLettura ? (
              <tr><td colSpan={5} className="py-3 font-maven text-sm text-kidville-error-strong">{t('fascicoloErroreLettura')}</td></tr>
            ) : rows.length === 0 && (
              <tr><td colSpan={5} className="py-3 font-maven text-sm text-kidville-muted">{t('fascicoloNessunAccesso')}</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-kidville-line font-maven">
                <td className="py-2 pr-3 text-kidville-ink whitespace-nowrap">{intlDateTime(f.locale, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(r.creato_il))}</td>
                <td className="py-2 pr-3">
                  <span className={`rounded-pill px-2 py-0.5 text-[11px] ${AZIONE[r.azione]?.cls ?? 'bg-kidville-line text-kidville-ink'}`}>{AZIONE[r.azione] ? t(AZIONE[r.azione].lKey) : r.azione}</span>
                  {/* Un'apertura della scheda anagrafica dal docente non è una visione dei
                      documenti del fascicolo (PEI/PDP, sanitari): lo si dice. Le altre
                      finalità restano come prima. */}
                  {r.finalita === FINALITA_AUDIT_ANAGRAFICA && (
                    <span className="ml-1.5 font-maven text-[11px] text-kidville-sub">
                      {t('fascicoloFinalitaAnagraficaDocente')}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3 text-kidville-ink">{r.utenti ? `${r.utenti.cognome ?? ''} ${r.utenti.nome ?? ''}`.trim() || '—' : '—'}</td>
                <td className="py-2 pr-3 text-kidville-ink">{r.alunni ? `${r.alunni.cognome ?? ''} ${r.alunni.nome ?? ''}`.trim() || '—' : '—'}</td>
                <td className="py-2 pr-3 text-kidville-muted text-xs">{r.ip ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
