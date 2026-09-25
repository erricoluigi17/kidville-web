'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Hand } from 'lucide-react';
import { DateField } from '@/components/ui/DateField';
import { Btn } from '@/components/ui/Btn';
import { oggiFiscaleISO } from '@/lib/format/fiscal-date';
import { MOTIVO_MAX_CARATTERI } from '@/lib/presenze/limiti-testo';
import { erroreDaRisposta } from '@/lib/ui/esito-fetch';
import { logClient } from '@/lib/logging/client';
import { FUOCO_ESITO } from '@/lib/ui/fuoco';

/**
 * «Dichiara impreparato» — il modulo del genitore (primaria), per dichiarare e
 * per MODIFICARE una propria dichiarazione.
 *
 * ─── DA DOVE VIENE ──────────────────────────────────────────────────────────
 * Era la funzione `ImpreparatoForm` dentro `PrimariaParentView.tsx`, un
 * componente che nessuna pagina importava: scritto, tradotto e mai arrivato a
 * nessuno. Estratto qui e montato nella pagina Voti
 * (`/parent/primaria/valutazioni`, spec 2026-09-24 «2 Primaria»). La copia di
 * partenza è stata TOLTA da `PrimariaParentView`: di questo modulo ne esiste uno.
 *
 * ─── COSA CORREGGE RISPETTO ALL'ORIGINALE ───────────────────────────────────
 * L'originale dichiarava «Dichiarazione inviata ✓» dopo ogni `await`, anche
 * quando il server aveva rifiutato. Qui il successo si dichiara SOLO su `r.ok`;
 * un rifiuto mostra la frase di catalogo del suo `codice` (mai la prosa del
 * server, che è italiana e scritta per i log) e si logga con lo status.
 *
 * Il tipo non si sceglie: quello dichiarato dal genitore è sempre «Impreparato
 * giustificato», e lo scrive il server.
 *
 * ─── IL GIORNO ──────────────────────────────────────────────────────────────
 * Si dichiara «a priori»: oggi o un giorno successivo, in data di ROMA. La
 * PATCH del server rifiuta già una data passata (`IMPREPARATO_DATA_PASSATA`);
 * qui lo si dice prima di uscire dal dispositivo, anche per la POST.
 *
 * ─── IL FUOCO ───────────────────────────────────────────────────────────────
 * In modifica il modulo PRENDE IL POSTO del pulsante «Modifica» appena premuto:
 * senza uno spostamento esplicito il fuoco cadrebbe su `<body>` (WCAG 2.4.3).
 * All'apertura lo si porta sul titolo del modulo (`tabIndex={-1}`: raggiungibile
 * dal codice, non dal Tab). Il ritorno sul pulsante, dopo «Chiudi» o un
 * salvataggio, lo fa la pagina: è lei che rimonta la riga.
 */

export interface MateriaOpzione {
  id: string;
  nome: string;
}

/** La dichiarazione da modificare (solo i campi che il modulo riscrive). */
export interface ImpreparatoDaModificare {
  id: string;
  data: string;
  materiaId: string | null;
  materiaNome?: string | null;
  motivo: string | null;
}

export function ImpreparatoForm({
  studentId,
  parentId,
  materie,
  modifica = null,
  onSalvato,
  onChiudi,
}: {
  studentId: string | null;
  parentId: string | null;
  materie: MateriaOpzione[];
  /** Presente = modulo di MODIFICA di quella dichiarazione (PATCH); assente = nuova (POST). */
  modifica?: ImpreparatoDaModificare | null;
  /**
   * Chiamato SOLO dopo una risposta positiva del server, con i valori che il
   * server ha accettato (in modifica: già normalizzati, un campo vuoto è `null`).
   */
  onSalvato: (esito: { materiaId: string | null; data: string; motivo: string | null }) => void;
  /** Solo in modifica: chiude il modulo senza salvare. */
  onChiudi?: () => void;
}) {
  const t = useTranslations('parentPrimaria');
  const inModifica = modifica !== null;
  const [data, setData] = useState<string>(() => modifica?.data ?? oggiFiscaleISO());
  const [materiaId, setMateriaId] = useState<string>(modifica?.materiaId ?? '');
  const [motivo, setMotivo] = useState<string>(modifica?.motivo ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const titoloModifica = useRef<HTMLParagraphElement | null>(null);

  // Solo al montaggio del modulo di modifica: vedi «IL FUOCO» qui sopra.
  useEffect(() => {
    if (inModifica) titoloModifica.current?.focus();
  }, [inModifica]);

  // Una materia archiviata dopo la dichiarazione non è più fra quelle attive: la
  // si tiene fra le scelte, altrimenti la `<select>` mostrerebbe «facoltativa» e
  // il salvataggio la toglierebbe senza che il genitore l'abbia chiesto.
  const opzioni =
    modifica?.materiaId && !materie.some((m) => m.id === modifica.materiaId)
      ? [...materie, { id: modifica.materiaId, nome: modifica.materiaNome ?? '—' }]
      : materie;

  /**
   * Una riga di log per ogni esito negativo. `stato` è un numero e `cosa` una
   * costante: passano la lista bianca. Il corpo NON si logga — può contenere il
   * motivo, testo libero su un minore.
   */
  const segnala = (cosa: string, stato?: number, errore?: unknown) => {
    logClient({
      livello: 'error',
      evento: 'fetch',
      messaggio: `parent/impreparato: ${cosa}${errore instanceof Error ? ` (${errore.name})` : ''}`,
      stato,
    });
  };

  const salva = async () => {
    if (!studentId || !parentId || busy) return;
    setMsg('');
    if (!data) {
      setErr(t('impreparatoDataMancante'));
      return;
    }
    if (data < oggiFiscaleISO()) {
      setErr(t('impreparatoDataPassata'));
      return;
    }
    setErr('');
    setBusy(true);
    const fallback = inModifica ? t('impreparatoModificaNonRiuscita') : t('impreparatoInvioNonRiuscito');
    try {
      const r = modifica
        ? await fetch(`/api/parent/giustifiche-didattiche?userId=${parentId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
            // In modifica i campi vuoti CANCELLANO: il genitore vede il valore
            // attuale nel campo, e svuotarlo è una scelta esplicita.
            body: JSON.stringify({
              id: modifica.id,
              data,
              materiaId: materiaId || null,
              motivo: motivo.trim() === '' ? null : motivo,
            }),
          })
        : await fetch(`/api/parent/giustifiche-didattiche?userId=${parentId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-user-id': parentId },
            body: JSON.stringify({ studentId, data, motivo, ...(materiaId ? { materiaId } : {}) }),
          });
      if (!r.ok) {
        const esito = await erroreDaRisposta(r, fallback);
        setErr(esito.testo);
        segnala(esito.corpoLetto ? 'salvataggio-respinto' : 'salvataggio-respinto-senza-corpo', esito.stato);
        return;
      }
      if (!inModifica) {
        setMotivo('');
        setMsg(t('viewDichiarazioneInviata'));
      }
      onSalvato({ materiaId: materiaId || null, data, motivo: motivo.trim() === '' ? null : motivo });
    } catch (e) {
      // Rete caduta: non sappiamo se la dichiarazione è arrivata. Il modulo resta
      // compilato, con dentro ciò che il genitore ha scritto.
      setErr(fallback);
      segnala('salvataggio-non-riuscito', undefined, e);
    } finally {
      setBusy(false);
    }
  };

  const campi = (
    <div className="flex flex-col gap-2">
      <DateField
        value={data}
        onChange={(v) => {
          setData(v);
          setErr('');
        }}
        aria-label={t('viewImpreparatoDataAria')}
        className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm"
      />
      <select
        value={materiaId}
        onChange={(e) => setMateriaId(e.target.value)}
        aria-label={t('viewMateriaFacoltativa')}
        className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm"
      >
        <option value="">{t('viewMateriaFacoltativa')}</option>
        {opzioni.map((m) => (
          <option key={m.id} value={m.id}>
            {m.nome}
          </option>
        ))}
      </select>
      <input
        type="text"
        value={motivo}
        maxLength={MOTIVO_MAX_CARATTERI}
        onChange={(e) => setMotivo(e.target.value)}
        placeholder={t('viewMotivoFacoltativo')}
        aria-label={t('viewMotivoFacoltativo')}
        className="font-maven rounded-pill border border-kidville-line px-3 py-1.5 text-sm"
      />
      {msg && (
        <p role="status" className="font-maven text-xs text-kidville-success">
          {msg}
        </p>
      )}
      {err && (
        <p role="alert" className="font-maven text-xs text-kidville-error">
          {err}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Btn size="sm" onClick={salva} disabled={!studentId || !parentId} aria-disabled={busy || undefined}>
          {inModifica
            ? busy
              ? t('impreparatoSalvataggio')
              : t('impreparatoSalva')
            : busy
              ? t('viewInvio')
              : t('viewInviaDichiarazione')}
        </Btn>
        {inModifica && onChiudi && (
          <Btn size="sm" variant="ghost" onClick={onChiudi} disabled={busy}>
            {t('impreparatoChiudi')}
          </Btn>
        )}
      </div>
    </div>
  );

  if (inModifica) {
    return (
      <div className="mt-2 rounded-card bg-kidville-cream/50 p-3">
        <p
          ref={titoloModifica}
          tabIndex={-1}
          className={`mb-2 rounded-sm font-maven text-xs font-semibold text-kidville-ink ${FUOCO_ESITO}`}
        >
          {t('impreparatoModificaTitolo')}
        </p>
        {campi}
      </div>
    );
  }

  return (
    <section className="rounded-card bg-white p-5 shadow-sm">
      <h3 className="font-barlow text-lg font-bold text-kidville-ink flex items-center gap-2 mb-3">
        <Hand size={18} className="text-kidville-warn" /> {t('viewDichiaraImpreparato')}
      </h3>
      <p className="font-maven text-xs text-kidville-sub mb-3">{t('viewDichiaraImpreparatoHint')}</p>
      {campi}
    </section>
  );
}
