'use client';

import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { oggiRoma } from '@/lib/storici/retroattivita';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { nomeCompleto } from '@/lib/format/nome';

interface Docente { id: string; nome: string; cognome: string; ruolo: string }

/** Contesto della nuova voce amministrativa: autore docente esplicito e giorno civile. */
export function CompetenzaStorica({ attiva, sectionId, userId, data, onData, docenteId, onDocente }: {
  attiva: boolean; sectionId: string; userId: string | null | undefined; data: string; onData: (v: string) => void;
  docenteId: string; onDocente: (v: string) => void;
}) {
  const t = useTranslations('teacherPrimaria');
  const campo = useId();
  const [risposta, setRisposta] = useState<{ classe: string; docenti: Docente[]; errore: boolean } | null>(null);
  useEffect(() => {
    if (!attiva || !userId || !sectionId) return;
    let attuale = true;
    void fetch(`/api/admin/sections/${sectionId}/teachers?userId=${userId}`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP${r.status}`);
        const d = await r.json();
        if (!d?.success || !Array.isArray(d.assigned)) throw new Error('RispostaNonValida');
        if (attuale) {
          setRisposta({ classe: sectionId, docenti: d.assigned.filter((p: Docente) => p.ruolo === 'educator'), errore: false });
          onDocente('');
        }
      })
      .catch((err: unknown) => {
        logClient({ livello: 'warn', evento: 'fetch', messaggio: `competenza-docenti-non-caricati: ${nomeErrore(err)}` });
        if (attuale) setRisposta({ classe: sectionId, docenti: [], errore: true });
      });
    return () => { attuale = false; };
  }, [attiva, sectionId, userId, onDocente]);
  if (!attiva) return null;
  const elenco = risposta?.classe === sectionId ? risposta : null;
  return <div className="mb-3 grid gap-3 rounded-card border border-kidville-line p-3 sm:grid-cols-2">
    <label htmlFor={`${campo}-data`} className="font-maven text-xs text-kidville-sub">
      {t('storicoDataCompetenza')}
      <input id={`${campo}-data`} type="date" required max={oggiRoma()} value={data}
        onChange={e => { if (e.target.value) onData(e.target.value); }}
        className="mt-1 block w-full rounded-pill border border-kidville-line px-3 py-2 text-sm" />
    </label>
    <label htmlFor={`${campo}-docente`} className="font-maven text-xs text-kidville-sub">
      {t('firmaModalDocenteTitolare')}
      <select id={`${campo}-docente`} required value={docenteId} onChange={e => onDocente(e.target.value)}
        className="mt-1 block w-full rounded-pill border border-kidville-line px-3 py-2 text-sm">
        <option value="">{t('firmaModalSeleziona')}</option>
        {(elenco?.docenti ?? []).map(d => <option key={d.id} value={d.id}>{nomeCompleto(d.nome, d.cognome, 'cognome-nome')}</option>)}
      </select>
    </label>
    <p className="font-maven text-xs text-kidville-sub sm:col-span-2">
      {elenco?.errore ? t('firmaModalDocentiNonCaricati') : elenco && elenco.docenti.length === 0 ? t('firmaModalNessunDocente') : t('firmaModalDocenteObbligatorio')}
    </p>
    {data < oggiRoma() && <p role="status" className="font-maven text-xs text-kidville-sub sm:col-span-2">{t('storicoSenzaAvvisiFamiglia')}</p>}
  </div>;
}
