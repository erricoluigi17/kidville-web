'use client';

import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { logClient } from '@/lib/logging/client';
import { apriDocumento } from '@/lib/native/scarica';
import { avvisoDocumento, type AvvisoDocumento } from '@/lib/native/documento-genitore';
import { isNativeApp } from '@/lib/push/native-register';

/**
 * L'ALLEGATO DI UNA LEZIONE DELLA PRIMARIA, APERTO ANCHE DALL'APP (spec 2026-09-24,
 * compito R5): il link degli allegati nel registro e nella linguetta «Compiti».
 *
 * ─── IL DIFETTO ─────────────────────────────────────────────────────────────────
 * Era un `<a href={indirizzo firmato} target="_blank">`. Sul web va: il browser apre
 * una scheda. Nella WebView Capacitor NO: `capacitor.config.ts` non abilita finestre
 * multiple, l'ancora non apre niente e non lancia — il docente tocca la scheda della
 * lavagna e non succede nulla, senza un log.
 *
 * ─── LA CORREZIONE ──────────────────────────────────────────────────────────────
 * Il markup resta l'ancora di prima (stesso `href`, stessa scheda nuova), quindi SUL
 * WEB NON CAMBIA NULLA: nessun `preventDefault`, e clic centrale e «copia indirizzo»
 * continuano a funzionare. Solo nell'app il clic si ferma e passa all'helper unico
 * `apriDocumento`: il file firmato (altra origine) va in Cache con `FileTransfer` e si
 * apre nell'ANTEPRIMA DI SISTEMA dentro l'app; se l'anteprima non c'è, il foglio di
 * condivisione col file. L'esito lo registra l'helper, successo compreso: qui non si
 * rilogga.
 *
 * Se il file non arriva il docente lo deve SAPERE: un avviso accanto al link, con il
 * guasto vero — «aggiorna l'app» solo sul binario 1.0 (`binarioDaAggiornare`), «riprova»
 * per tutto il resto. Un gesto annullato e il foglio col link non chiedono avviso.
 */

/** Le estensioni che il caricamento del registro ammette (PDF e immagini JPG/PNG/WEBP/GIF). */
const MIME_PER_ESTENSIONE: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
};

function estensioneAmmessa(testo: string | null | undefined): string | null {
  const percorso = (testo ?? '').split(/[?#]/, 1)[0];
  const segmento = percorso.slice(percorso.lastIndexOf('/') + 1);
  const punto = segmento.lastIndexOf('.');
  if (punto < 0) return null;
  const ext = segmento.slice(punto + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(MIME_PER_ESTENSIONE, ext) ? ext : null;
}

const ID_RX = /^[A-Za-z0-9-]{1,64}$/;

/** `true` solo per un indirizzo http(s) assoluto: quello firmato dello Storage. */
export function indirizzoFirmato(href: string | null | undefined): boolean {
  return typeof href === 'string' && /^https?:\/\//i.test(href);
}

/** La rotta della PAGINA per i log: il luogo dell'incidente, non la fetch. */
function rottaPagina(): string | undefined {
  return typeof window !== 'undefined' ? window.location.pathname : undefined;
}

/**
 * Nome e mime del file che arriva sul dispositivo.
 *
 * Il NOME NON è quello caricato né quello mostrato: è testo libero scritto su una
 * classe di minori («verifica di <nome>.pdf»), e nell'app il file resta nella Cache e
 * passa dal foglio «Salva su File». Solo `registro-allegato-<8 caratteri dell'uuid>`,
 * come fa il fascicolo (F3).
 *
 * L'ESTENSIONE serve all'anteprima (senza, iOS non sa che file sia): prima dal percorso
 * dell'indirizzo firmato — il bucket la prende dal file caricato
 * (`percorsoAllegato`) — poi dal nome, poi dal `tipo` della riga per il PDF. Una
 * immagine senza estensione riconosciuta resta SENZA: un `.jpg` inventato su un GIF
 * sarebbe un'affermazione falsa, e l'helper ripiega comunque sul foglio col file.
 */
export function fileAllegatoRegistro(
  allegato: { id: string; tipo: string | null; file_name: string | null },
  urlFirmato: string,
): { nomeFile: string; mime?: string } {
  const ext =
    estensioneAmmessa(urlFirmato) ??
    estensioneAmmessa(allegato.file_name) ??
    (allegato.tipo === 'pdf' ? 'pdf' : null);
  const id = ID_RX.test(allegato.id) ? allegato.id.slice(0, 8) : 'file';
  const base = `registro-allegato-${id}`;
  return ext ? { nomeFile: `${base}.${ext}`, mime: MIME_PER_ESTENSIONE[ext] } : { nomeFile: base };
}

export interface LinkAllegatoRegistroProps {
  allegato: { id: string; tipo: string | null; file_name: string | null };
  /** L'indirizzo FIRMATO (altra origine, a tempo): lo stesso `href` di prima. */
  href: string;
  /** Prefisso dei log dell'helper: un token (`registro-allegato`, `compiti-allegato`). */
  etichetta: string;
  /** Titolo del foglio di sistema nei ripieghi. Mai un nome di persona. */
  titolo: string;
  className: string;
  children: ReactNode;
}

export function LinkAllegatoRegistro({ allegato, href, etichetta, titolo, className, children }: LinkAllegatoRegistroProps) {
  const ts = useTranslations('shared');
  // Un secondo tocco mentre il primo scarica non apre una seconda anteprima.
  const inVoloRef = useRef(false);
  const [inVolo, setInVolo] = useState(false);
  const [avviso, setAvviso] = useState<AvvisoDocumento | null>(null);

  const apriSuNativo = (evento: MouseEvent<HTMLAnchorElement>) => {
    // Sul web l'ancora fa il suo mestiere, come prima.
    if (!isNativeApp()) return;
    evento.preventDefault();
    if (inVoloRef.current) return;
    if (!indirizzoFirmato(href)) {
      // Il registro legge gli allegati col PERCORSO del bucket e li firma solo con
      // la seconda GET (`/api/primaria/allegati`): finché non è arrivata, `href` è
      // un percorso relativo. Darlo all'helper sarebbe una `fetch` verso una pagina
      // nostra, che risponde HTML con 200 — un «documento» aperto che non è il file.
      // Si dice di riprovare, e lo si registra (l'helper qui non parte).
      logClient({ livello: 'warn', evento: 'fetch', messaggio: `${etichetta}-apertura-indirizzo-non-firmato`, route: rottaPagina() });
      setAvviso('riprova');
      return;
    }
    inVoloRef.current = true;
    setInVolo(true);
    setAvviso(null);
    const { nomeFile, mime } = fileAllegatoRegistro(allegato, href);
    // L'helper non lancia mai e registra da sé l'esito: il `.then` arriva sempre.
    void apriDocumento({
      sorgente: href,
      nomeFile,
      ...(mime ? { mime } : {}),
      titolo,
      etichetta,
    }).then((esito) => {
      inVoloRef.current = false;
      setInVolo(false);
      setAvviso(avvisoDocumento(esito));
    });
  };

  return (
    <>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={apriSuNativo}
        aria-busy={inVolo || undefined}
        className={`${className}${inVolo ? ' cursor-wait opacity-60' : ''}`}
      >
        {children}
      </a>
      {avviso && (
        <span role="alert" data-testid={`allegato-avviso-${allegato.id}`} className="font-maven text-[11px] text-kidville-error-strong">
          {avviso === 'aggiorna' ? ts('documentoAppDaAggiornare') : ts('documentoNonAperto')}
        </span>
      )}
    </>
  );
}
