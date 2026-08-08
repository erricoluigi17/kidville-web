'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  useParentIdentity,
  fetchFigli,
  invalidaFigliCache,
  type FiglioAnagrafica,
} from '@/lib/auth/use-parent-identity';

type Figlio = FiglioAnagrafica;

function initials(nome: string, cognome: string) {
  return `${nome?.[0] ?? ''}${cognome?.[0] ?? ''}`.toUpperCase();
}

/**
 * Selettore del figlio per i genitori con più figli — chip ad avatar orizzontali
 * (design DR KvUI.ChildSwitcher). Persiste la scelta in localStorage
 * (kv_student_id) e ricarica, così tutte le pagine genitore mostrano il figlio
 * selezionato. Si nasconde se c'è meno di 2 figli.
 */
export function ChildSwitcher() {
  const { parentId, studentId, ready } = useParentIdentity();
  const [figli, setFigli] = useState<Figlio[]>([]);
  // Testo dell'aria-label del selettore dal namespace i18n «nav». I nomi dei
  // figli e la classe sono DATI: restano invariati, non si traducono.
  const t = useTranslations('nav');

  // L'elenco arriva dalla cache condivisa con `useParentIdentity`: è la STESSA
  // GET che l'identità sta già facendo per risolvere il figlio attivo. Farne
  // una propria era la quinta richiesta identica dello stesso caricamento.
  useEffect(() => {
    if (!parentId) return;
    let annullato = false;
    void fetchFigli(parentId).then((lista) => {
      if (!annullato) setFigli(lista ?? []);
    });
    return () => { annullato = true; };
  }, [parentId]);

  // Niente da scegliere: non mostrare nulla.
  if (!ready || figli.length < 2) return null;

  const onSelect = (id: string) => {
    if (!id || id === studentId) return;
    try { localStorage.setItem('kv_student_id', id); } catch { /* ignore */ }
    // La cache dell'elenco è di modulo: un ricaricamento vero la azzera da sé,
    // ma dentro la shell nativa (WebView) e nelle navigazioni SPA non è detto.
    // Invalidare qui è la differenza fra "riparte dal backend" e "riparte da
    // ciò che era vero per il figlio precedente".
    invalidaFigliCache();
    // Ricarico così ogni hook/identità rilegge il nuovo figlio.
    window.location.reload();
  };

  return (
    <div
      className="flex gap-2.5 overflow-x-auto px-5 pt-3 pb-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
      role="tablist"
      aria-label={t('ariaSelezionaFiglio')}
    >
      {figli.map((f) => {
        const on = f.id === studentId;
        return (
          /*
            ⚠️ I COLORI NON STANNO PIÙ NELLO `style` INLINE (2026-08-08).
            Erano scritti a mano — `background:'#006A5F'`, `color:'#FDC400'` —
            e uno stile inline batte qualunque foglio di stile senza
            `!important`: né la rete di `globals.css` sulla coppia di brand né
            il rimappaggio dell'Alto Contrasto potevano raggiungerli. Misurato
            dal collaudo (axe-core, impact «serious», 8 nodi): 4,05:1 su testo
            14px/bold e 10,5px/normal, e in Alto Contrasto lo stesso identico
            valore — l'unico elemento della schermata che non partecipava
            affatto al ribaltamento. Ed è l'unico posto che dice DI QUALE
            bambino si sta comunicando l'assenza.
            Coi token: `bg-kidville-green` + `text-kidville-yellow-ink`
            (#FFDA5C su #006A5F = 4,78:1). Padding e ombra restano inline —
            non sono colori e nessuna rete li deve raggiungere.
            Lock: `__tests__/a11y/contrasto-skip-link-e-selettore-figlio.test.tsx`.
          */
          <button
            key={f.id}
            type="button"
            onClick={() => onSelect(f.id)}
            role="tab"
            aria-selected={on}
            className={`flex flex-shrink-0 items-center gap-2.5 rounded-pill transition-all ${
              on ? 'bg-kidville-green' : 'bg-kidville-white'
            }`}
            style={{
              padding: on ? '6px 16px 6px 6px' : '6px',
              boxShadow: on ? '0 6px 16px -8px rgba(0,90,80,.5)' : '0 2px 8px -5px rgba(0,0,0,.18)',
            }}
          >
            <span className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-full bg-kidville-green font-barlow text-[14px] font-black text-kidville-yellow-ink">
              {initials(f.nome, f.cognome)}
            </span>
            {on && (
              <span className="text-left">
                <span className="block font-barlow text-sm font-extrabold uppercase leading-none tracking-wide text-white">
                  {f.nome}
                </span>
                {f.classe_sezione && (
                  <span className="block font-maven text-[10.5px] font-semibold text-kidville-yellow-ink">
                    {f.classe_sezione}
                  </span>
                )}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
