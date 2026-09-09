'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus, Trash2 } from 'lucide-react';
import { creaMuta } from '@/lib/ui/muta';

interface Assegnazione {
  id: string;
  utente_id: string;
  materia_id: string;
  e_contitolare: boolean;
  utenti?: { nome: string; cognome: string } | null;
  materie?: { nome: string; codice: string } | null;
}
interface Materia { id: string; nome: string }
interface Docente { id: string; nome: string; cognome: string; gradi?: string[] }

interface SezioneOpt { id: string; name: string }

interface Props {
  sectionId: string;
  scuolaId: string;
  userId: string;
  // Fix 4: la classe è visibile "in entrambi i modi" — selettore in alto (nel
  // pannello) e tendina qui nel form. Condividono lo stesso `sectionId`.
  sezioni?: SezioneOpt[];
  sezioneName?: string;
  onSectionChange?: (id: string) => void;
}

export function DocentiMaterieManager({ sectionId, scuolaId, userId, sezioni = [], sezioneName, onSectionChange }: Props) {
  const t = useTranslations('adminPrimaria');
  const [assegnazioni, setAssegnazioni] = useState<Assegnazione[]>([]);
  const [materie, setMaterie] = useState<Materia[]>([]);
  const [docenti, setDocenti] = useState<Docente[]>([]);
  const [sel, setSel] = useState({ utenteId: '', materiaId: '', eContitolare: false });
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!sectionId) return;
    let next: { assegnazioni: Assegnazione[]; materie: Materia[]; docenti: Docente[] } | null = null;
    try {
      const [aRes, mRes, dRes] = await Promise.all([
        fetch(`/api/admin/primaria/docenti-materie?sectionId=${sectionId}`, { headers: { 'x-user-id': userId } }).then((r) => r.json()),
        fetch(`/api/admin/primaria/materie?sectionId=${sectionId}`, { headers: { 'x-user-id': userId } }).then((r) => r.json()),
        fetch(`/api/admin/primaria/docente-gradi?scuolaId=${scuolaId}`, { headers: { 'x-user-id': userId } }).then((r) => r.json()),
      ]);
      // Solo docenti abilitati alla primaria
      const docs: Docente[] = dRes.success ? dRes.data : [];
      next = {
        assegnazioni: aRes.success ? aRes.data : [],
        materie: mRes.success ? mRes.data : [],
        docenti: docs.filter((d) => (d.gradi ?? []).includes('primaria')),
      };
    } finally {
      if (next) {
        setAssegnazioni(next.assegnazioni);
        setMaterie(next.materie);
        setDocenti(next.docenti);
      }
    }
  }, [sectionId, scuolaId, userId]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Le due mutazioni della schermata. «Assegna» il rifiuto lo mostrava già,
   * «rimuovi» no — `await fetch(...)` nudo, e il `load()` finale rimetteva la
   * riga al suo posto: indistinguibile da «il click non è arrivato».
   *
   * I due ripieghi sono diversi perché dicono in che STATO è rimasto il dato:
   * dopo un'assegnazione rifiutata non è stato registrato niente, dopo una
   * rimozione rifiutata l'assegnazione è ancora attiva.
   */
  const { mutaSalva, mutaElimina } = useMemo(() => {
    const comuni = { route: '/admin/impostazioni', ricarica: load, setErrore: setError };
    return {
      mutaSalva: creaMuta({ ...comuni, fallback: t('comuneErroreSalvataggio') }),
      mutaElimina: creaMuta({ ...comuni, fallback: t('comuneErroreEliminazione') }),
    };
  }, [load, t]);

  const add = async () => {
    if (!sel.utenteId || !sel.materiaId) return;
    // La tripletta scelta si azzera SOLO se il server ha accettato: azzerarla su
    // un rifiuto obbligherebbe a ricomporla per riprovare.
    const ok = await mutaSalva(
      `/api/admin/primaria/docenti-materie?userId=${userId}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': userId },
        body: JSON.stringify({ utenteId: sel.utenteId, sectionId, materiaId: sel.materiaId, eContitolare: sel.eContitolare }),
      },
      'primaria-docenti-materie-nuova-respinta',
    );
    if (ok) setSel({ utenteId: '', materiaId: '', eContitolare: false });
  };

  const remove = async (a: Assegnazione) => {
    await mutaElimina(
      `/api/admin/primaria/docenti-materie?id=${a.id}&userId=${userId}`,
      { method: 'DELETE', headers: { 'x-user-id': userId } },
      'primaria-docenti-materie-elimina-respinta',
      // La riga per esteso, com'è scritta in elenco: in una lista di venti
      // assegnazioni è l'unica cosa che dice quale gesto rifare. Resta a
      // schermo — `muta` non la logga.
      `${a.utenti ? `${a.utenti.nome} ${a.utenti.cognome}` : a.utente_id} → ${a.materie?.nome ?? a.materia_id}`,
    );
  };

  if (!sectionId) return <p className="font-maven text-kidville-muted">{t('comuneSelezionaSezione')}</p>;

  return (
    <div className="space-y-4">
      {error && <div role="alert" className="rounded-card bg-kidville-error/10 text-kidville-error px-4 py-2 text-sm font-maven">{error}</div>}
      {docenti.length === 0 && (
        <div className="rounded-card bg-kidville-warn-soft text-kidville-warn px-4 py-2 text-sm font-maven">
          {t('docentiMaterieNessunClassificato')}
        </div>
      )}

      {sezioneName && (
        <p className="font-maven text-sm text-kidville-muted">
          {t.rich('docentiMaterieAssociazioniPer', { nome: sezioneName, b: (chunks) => <b className="text-kidville-green">{chunks}</b> })}
        </p>
      )}

      <ul className="divide-y divide-kidville-line">
        {assegnazioni.map((a) => (
          <li key={a.id} className="flex items-center justify-between py-2.5">
            <div className="font-maven text-sm text-kidville-ink">
              {a.utenti ? `${a.utenti.nome} ${a.utenti.cognome}` : a.utente_id}
              <span className="mx-2 text-kidville-muted">→</span>
              <span className="text-kidville-green">{a.materie?.nome ?? a.materia_id}</span>
              {sezioneName && <span className="ml-2 rounded-pill bg-kidville-cream text-kidville-muted px-2 py-0.5 text-[11px]">{sezioneName}</span>}
              {a.e_contitolare && <span className="ml-2 rounded-pill bg-kidville-green/10 text-kidville-green px-2 py-0.5 text-[11px]">{t('comuneContitolare')}</span>}
            </div>
            <button onClick={() => remove(a)} aria-label={t('docentiMaterieRimuovi')} className="text-kidville-muted hover:text-kidville-error">
              <Trash2 size={16} />
            </button>
          </li>
        ))}
        {assegnazioni.length === 0 && <li className="py-3 font-maven text-kidville-muted text-sm">{t('docentiMaterieNessunAssegnazione')}</li>}
      </ul>

      <div className="flex flex-wrap items-end gap-2 border-t border-kidville-line pt-4">
        {sezioni.length > 0 && (
          <div>
            <label className="block font-maven text-xs text-kidville-muted">{t('docentiMaterieLabelClasse')}</label>
            <select
              value={sectionId}
              onChange={(e) => onSectionChange?.(e.target.value)}
              className="font-maven rounded-pill border border-kidville-line bg-white px-3 py-1.5 text-sm"
            >
              {sezioni.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="block font-maven text-xs text-kidville-muted">{t('docentiMaterieLabelDocente')}</label>
          <select
            value={sel.utenteId}
            onChange={(e) => setSel((s) => ({ ...s, utenteId: e.target.value }))}
            className="font-maven rounded-pill border border-kidville-line bg-white px-3 py-1.5 text-sm"
          >
            <option value="">{t('comuneSeleziona')}</option>
            {docenti.map((d) => (
              <option key={d.id} value={d.id}>{d.nome} {d.cognome}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block font-maven text-xs text-kidville-muted">{t('docentiMaterieLabelMateria')}</label>
          <select
            value={sel.materiaId}
            onChange={(e) => setSel((s) => ({ ...s, materiaId: e.target.value }))}
            className="font-maven rounded-pill border border-kidville-line bg-white px-3 py-1.5 text-sm"
          >
            <option value="">{t('comuneSeleziona')}</option>
            {materie.map((m) => (
              <option key={m.id} value={m.id}>{m.nome}</option>
            ))}
          </select>
        </div>
        <label className="font-maven text-xs text-kidville-ink inline-flex items-center gap-1 pb-2">
          <input
            type="checkbox"
            checked={sel.eContitolare}
            onChange={(e) => setSel((s) => ({ ...s, eContitolare: e.target.checked }))}
          />
          {t('comuneContitolare')}
        </label>
        <button
          onClick={add}
          className="font-maven inline-flex items-center gap-1.5 rounded-pill bg-kidville-green px-4 py-1.5 text-sm text-kidville-yellow"
        >
          <Plus size={14} /> {t('docentiMaterieAssegna')}
        </button>
      </div>
    </div>
  );
}
