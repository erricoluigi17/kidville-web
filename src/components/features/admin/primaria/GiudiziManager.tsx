'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { logClient, nomeErrore } from '@/lib/logging/client';
import { messaggioErrore } from '@/lib/ui/esito-fetch';

interface ScalaItem { id: string; etichetta: string; ordine: number; valore_numerico: number | null; giudizio_descrittivo: string | null; attivo: boolean }
interface TemplateItem { id: string; scuola_id: string | null; dimensione: string; valore: string; frammento: string }

export function GiudiziManager({ scuolaId, userId }: { scuolaId: string; userId: string }) {
  const t = useTranslations('adminPrimaria');
  const [scala, setScala] = useState<ScalaItem[]>([]);
  const [template, setTemplate] = useState<TemplateItem[]>([]);
  const [nuova, setNuova] = useState('');
  // L'esito dell'ultima mutazione. Prima non esisteva: le sei mutazioni qui
  // sotto scartavano la risposta e chiamavano `load()`, quindi un rifiuto
  // ricaricava i valori vecchi e sembrava che l'operatore non avesse mai
  // premuto niente. La scala giudizi è PER SEDE: con tre plessi il rifiuto è
  // la risposta normale a una sede sbagliata, non un caso di laboratorio.
  const [errore, setErrore] = useState('');

  const load = useCallback(async () => {
    let next: { scala: ScalaItem[]; template: TemplateItem[] } | null = null;
    try {
      const r = await fetch(`/api/admin/primaria/giudizi?scuolaId=${scuolaId}`, { headers: { 'x-user-id': userId } });
      const d = await r.json();
      if (d.success) next = { scala: d.data.scala, template: d.data.template };
    } finally {
      if (next) { setScala(next.scala); setTemplate(next.template); }
    }
  }, [scuolaId, userId]);

  useEffect(() => { load(); }, [load]);

  /**
   * Esegue una mutazione e ne RIPORTA l'esito (`true` = riuscita).
   *
   * Log obbligatorio sul rifiuto: lo `stato` è un numero (lista bianca di
   * `redact`) ed è l'unica cosa che, dai log, distingue «sede non tua» (403) da
   * «sede ambigua» (400) da «giudizio già in uso» (409). Il corpo NON si logga:
   * i frammenti descrittivi sono testo libero su un minore.
   */
  const muta = async (url: string, init: RequestInit, evento: string): Promise<boolean> => {
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        logClient({ livello: 'error', evento: 'fetch', messaggio: evento, route: '/admin/impostazioni', stato: res.status });
        setErrore(await messaggioErrore(res, t('giudiziErroreOperazione')));
        load();
        return false;
      }
      setErrore('');
      load();
      return true;
    } catch (err) {
      logClient({ livello: 'error', evento: 'fetch', messaggio: `${evento}: ${nomeErrore(err)}`, route: '/admin/impostazioni' });
      setErrore(t('giudiziErroreOperazione'));
      return false;
    }
  };

  const postScala = (body: unknown, evento: string, action = 'scala') => muta(
    `/api/admin/primaria/giudizi?action=${action}&userId=${userId}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-user-id': userId }, body: JSON.stringify(body) },
    evento,
  );

  const addScala = async () => {
    if (!nuova) return;
    // Il testo si azzera SOLO se il server ha accettato: cancellarlo su un
    // rifiuto obbligherebbe a riscriverlo per riprovare.
    if (await postScala({ scuolaId, etichetta: nuova, ordine: scala.length + 1 }, 'giudizi-scala-nuova-respinta')) {
      setNuova('');
    }
  };

  const removeScala = async (id: string) => {
    await muta(
      `/api/admin/primaria/giudizi?tipo=scala&id=${id}&userId=${userId}`,
      { method: 'DELETE', headers: { 'x-user-id': userId } },
      'giudizi-scala-elimina-respinta',
    );
  };

  // Aggiorna valore numerico / giudizio descrittivo di un giudizio della scala
  // (upsert per etichetta — pattern onBlur come per i frammenti template).
  const updateScala = async (s: ScalaItem, campo: 'valoreNumerico' | 'giudizioDescrittivo', valore: string) => {
    await postScala({ scuolaId, etichetta: s.etichetta, ordine: s.ordine, [campo]: valore }, 'giudizi-scala-aggiorna-respinta');
  };

  // Rinomina l'etichetta (UPDATE-by-id lato API, con cascade sui giudizi descrittivi).
  const renameScala = async (s: ScalaItem, etichetta: string) => {
    await postScala({ scuolaId, id: s.id, etichetta }, 'giudizi-scala-rinomina-respinta', 'scala-rename');
  };

  const toggleAttivo = async (s: ScalaItem) => {
    await postScala({ scuolaId, etichetta: s.etichetta, ordine: s.ordine, attivo: !s.attivo }, 'giudizi-scala-attivo-respinto');
  };

  const saveFrammento = async (t: TemplateItem, frammento: string) => {
    await postScala({ scuolaId, dimensione: t.dimensione, valore: t.valore, frammento }, 'giudizi-template-respinto', 'template');
  };

  return (
    <div className="grid gap-6 md:grid-cols-2">
      {errore && (
        <div role="alert" className="md:col-span-2 flex items-start gap-2 rounded-2xl bg-kidville-error-soft px-3 py-2.5 font-maven text-sm text-kidville-error">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" strokeWidth={1.8} />
          <span>{errore}</span>
        </div>
      )}
      <section>
        <h3 className="font-barlow text-base font-bold text-kidville-ink mb-2">{t('giudiziScalaTitolo')}</h3>
        <p className="font-maven text-xs text-kidville-muted mb-3">{t('giudiziScalaSottotitolo')}</p>
        <ul className="divide-y divide-kidville-line mb-3">
          {scala.map((s) => (
            <li key={s.id} className={`py-2 ${s.attivo ? '' : 'opacity-50'}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  <span className="font-maven text-sm text-kidville-muted shrink-0">{s.ordine}.</span>
                  <input
                    key={`${s.id}-${s.etichetta}`}
                    defaultValue={s.etichetta}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== s.etichetta) renameScala(s, v); }}
                    className="font-maven flex-1 min-w-0 rounded border border-transparent px-1.5 py-0.5 text-sm text-kidville-ink hover:border-kidville-line focus:border-kidville-muted focus:outline-none"
                  />
                </div>
                <label className="font-maven inline-flex items-center gap-1 text-[11px] text-kidville-muted shrink-0">
                  <input type="checkbox" checked={s.attivo} onChange={() => toggleAttivo(s)} />
                  {t('giudiziAttivo')}
                </label>
                <button onClick={() => removeScala(s.id)} aria-label={t('giudiziElimina')} className="text-kidville-muted hover:text-kidville-error shrink-0"><Trash2 size={15} /></button>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                <label className="font-maven text-[11px] text-kidville-muted w-14 shrink-0">{t('giudiziValore')}</label>
                <input
                  type="number"
                  step="0.5"
                  defaultValue={s.valore_numerico ?? ''}
                  onBlur={(e) => { if (e.target.value !== String(s.valore_numerico ?? '')) updateScala(s, 'valoreNumerico', e.target.value); }}
                  className="font-maven w-20 rounded border border-kidville-line px-2 py-1 text-xs"
                />
                <input
                  defaultValue={s.giudizio_descrittivo ?? ''}
                  placeholder={t('giudiziPlaceholderDescrittivo')}
                  onBlur={(e) => { if (e.target.value !== (s.giudizio_descrittivo ?? '')) updateScala(s, 'giudizioDescrittivo', e.target.value); }}
                  className="font-maven flex-1 rounded border border-kidville-line px-2 py-1 text-xs"
                />
              </div>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <input value={nuova} onChange={(e) => setNuova(e.target.value)} placeholder={t('giudiziPlaceholderNuovo')} className="font-maven flex-1 rounded-pill border border-kidville-line px-3 py-1.5 text-sm" />
          <button onClick={addScala} aria-label={t('giudiziAggiungi')} className="font-maven inline-flex items-center gap-1 rounded-pill bg-kidville-green px-3 py-1.5 text-sm text-kidville-yellow"><Plus size={14} /></button>
        </div>
      </section>

      <section>
        <h3 className="font-barlow text-base font-bold text-kidville-ink mb-2">{t('giudiziTemplateTitolo')}</h3>
        <p className="font-maven text-xs text-kidville-muted mb-3">{t('giudiziTemplateSottotitolo')}</p>
        <div className="space-y-1.5">
          {template.map((t) => (
            <div key={t.id} className="flex items-center gap-2">
              <span className="font-maven text-[11px] text-kidville-muted w-28 shrink-0">{t.dimensione}={t.valore}</span>
              <input
                defaultValue={t.frammento}
                onBlur={(e) => { if (e.target.value !== t.frammento) saveFrammento(t, e.target.value); }}
                className="font-maven flex-1 rounded border border-kidville-line px-2 py-1 text-xs"
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
