import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * NAT3d — i download del DOCENTE fuori dalla primaria, nell'app.
 *
 * Quattro punti scaricavano (o aprivano) con un gesto che nella WebView di Capacitor
 * non fa niente e non lancia: l'ancora `download` su un `blob:` (registro presenze
 * PDF), l'ancora `target="_blank"` (allegati dei compiti, certificato medico,
 * documento dell'archivio). Nell'app ora passano dall'helper unico
 * (`scaricaDocumento` / `apriDocumento` di `src/lib/native/scarica.ts`); sul WEB
 * resta tutto com'era, e questo file lo fissa in entrambi i sensi:
 *
 *  · APP → l'helper riceve la sorgente giusta, un nome CON estensione (senza,
 *    l'anteprima di iOS non sa che file sia), l'etichetta dei log; il gesto di
 *    default dell'ancora è annullato; un «non riuscito» si dice all'utente.
 *  · WEB → l'helper non si chiama, l'ancora fa il suo mestiere (nessun
 *    `preventDefault`), il PDF del registro esce ancora dall'ancora sul `blob:`.
 *
 * `fireEvent.click` restituisce `false` quando il gestore ha chiamato
 * `preventDefault`: è così che si distingue «l'app ha preso il gesto» da «il
 * browser lo fa da sé».
 */

vi.mock('@/lib/logging/client', () => ({
  logClient: vi.fn(),
  nomeErrore: (e: unknown) => (e instanceof Error ? e.name : 'Sconosciuto'),
}));
vi.mock('@/lib/push/native-register', () => ({ isNativeApp: vi.fn(() => false) }));
vi.mock('@/lib/native/scarica', () => ({
  scaricaDocumento: vi.fn(async () => ({ esito: 'nativo-file' })),
  apriDocumento: vi.fn(async () => ({ esito: 'nativo-anteprima' })),
}));
vi.mock('@/lib/auth/use-session-identity', () => ({
  useSessionIdentity: () => ({ userId: 'ut-docente-1', role: 'educator', ready: true }),
}));

import { isNativeApp } from '@/lib/push/native-register';
import { scaricaDocumento, apriDocumento, type RisultatoScaricoNativo } from '@/lib/native/scarica';
import { MonthlyAttendanceTable } from '@/components/features/teacher/attendance/MonthlyAttendanceTable';
import { TaskCard, type Task } from '@/components/features/teacher/tasks/TaskCard';
import { PannelloCertificatiMedici } from '@/components/features/teacher/PannelloCertificatiMedici';
import { DocumentiFirmatiPanel } from '@/components/features/documenti/DocumentiFirmatiPanel';
import itTasks from '../../messages/it/teacherTasks.json';
import itServizi from '../../messages/it/teacherServizi.json';
import itDocumenti from '../../messages/it/documenti.json';
import itPresenze from '../../messages/it/teacherPresenze.json';

const nativo = vi.mocked(isNativeApp);
const scarica = vi.mocked(scaricaDocumento);
const apri = vi.mocked(apriDocumento);

const json = (corpo: unknown, stato = 200): Response =>
  new Response(JSON.stringify(corpo), { status: stato, headers: { 'Content-Type': 'application/json' } });

const avviso = vi.fn();

/**
 * Una promessa che resta in volo finché il test non la risolve: è lo scarico nativo
 * che impiega secondi. Serve a provare la guardia del DOPPIO TOCCO — un secondo
 * scarico sullo stesso file in Cache, col primo foglio/anteprima ancora aperto,
 * verrebbe rifiutato da iOS e finirebbe «non riuscito» sopra un file che si è aperto.
 */
function inVolo() {
  let risolvi!: (r: RisultatoScaricoNativo) => void;
  const promessa = new Promise<RisultatoScaricoNativo>((r) => {
    risolvi = r;
  });
  return { promessa, risolvi };
}

beforeEach(() => {
  vi.clearAllMocks();
  nativo.mockReturnValue(false);
  scarica.mockResolvedValue({ esito: 'nativo-file' });
  apri.mockResolvedValue({ esito: 'nativo-anteprima' });
  vi.stubGlobal('alert', avviso);
});

const creaOriginale = URL.createObjectURL;
const revocaOriginale = URL.revokeObjectURL;
/** `createObjectURL` finto (jsdom non lo implementa), rimesso a posto dopo ogni test. */
function stubObjectURL(crea: (b: Blob) => string) {
  URL.createObjectURL = crea;
  URL.revokeObjectURL = vi.fn();
}

afterEach(() => {
  vi.unstubAllGlobals();
  URL.createObjectURL = creaOriginale;
  URL.revokeObjectURL = revocaOriginale;
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. Registro presenze PDF (MonthlyAttendanceTable, usato anche da admin/appello)
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('registro presenze PDF', () => {
  const SEZIONE = 'TEST Sezione';
  const NOME_DAL_SERVER = 'presenze_TEST_mese_2026.pdf';
  const ALUNNO = { id: 'cccc3333-0000-4000-8000-00000000000c', nome: 'Alunno', cognome: 'Finto' };

  function fetchRegistro(rispostaPdf: () => Response) {
    const f = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/diary/students')) return json([ALUNNO]);
      if (u.includes('/api/admin/registro-presenze/pdf')) return rispostaPdf();
      return json([]);
    });
    vi.stubGlobal('fetch', f);
    return f;
  }

  const pdfOk = () =>
    new Response('%PDF-finto', {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${NOME_DAL_SERVER}"`,
      },
    });

  async function esporta() {
    render(<MonthlyAttendanceTable sezione={SEZIONE} />);
    const bottone = await screen.findByRole('button', { name: itPresenze.esportaPdf });
    await waitFor(() => expect(bottone).not.toBeDisabled());
    fireEvent.click(bottone);
  }

  it('APP: il PDF va a scaricaDocumento come Blob, col nome dal server e il mime; nessuna ancora su blob:', async () => {
    nativo.mockReturnValue(true);
    const crea = vi.fn(() => 'blob:finto');
    stubObjectURL(crea);
    const f = fetchRegistro(pdfOk);

    await esporta();

    await waitFor(() => expect(scarica).toHaveBeenCalledTimes(1));
    const input = scarica.mock.calls[0][0];
    expect(input.nomeFile).toBe(NOME_DAL_SERVER);
    expect(input.mime).toBe('application/pdf');
    expect(input.etichetta).toBe('registro-presenze-pdf');
    // I byte sono quelli della risposta della route (che vuole i cookie): si passa il
    // Blob, non l'URL da rileggere.
    expect(typeof input.sorgente).toBe('object');
    expect(await (input.sorgente as Blob).text()).toBe('%PDF-finto');
    expect(crea).not.toHaveBeenCalled();
    // la richiesta al server è quella di sempre
    const chiamataPdf = f.mock.calls.find(([u]) => String(u).includes('/api/admin/registro-presenze/pdf'));
    expect(String(chiamataPdf?.[0])).toContain(`sezione=${encodeURIComponent(SEZIONE)}`);
  });

  it('APP: se l’helper non consegna niente, la maestra lo vede', async () => {
    nativo.mockReturnValue(true);
    scarica.mockResolvedValue({ esito: 'non-riuscito', motivo: 'http-500' });
    fetchRegistro(pdfOk);

    await esporta();

    expect(await screen.findByText(itPresenze.erroreCaricamento)).toBeInTheDocument();
  });

  it('APP: un ripiego sul foglio col link NON è un errore da mostrare', async () => {
    nativo.mockReturnValue(true);
    scarica.mockResolvedValue({ esito: 'ripiego-condivisione', motivo: 'plugin-assenti:filetransfer', binarioDaAggiornare: true });
    fetchRegistro(pdfOk);

    await esporta();

    await waitFor(() => expect(scarica).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(itPresenze.erroreCaricamento)).toBeNull();
  });

  it('WEB: resta l’ancora sul blob: col nome del server, e l’helper non si chiama', async () => {
    const crea = vi.fn(() => 'blob:finto');
    stubObjectURL(crea);
    const cliccate: { href: string; download: string }[] = [];
    const clickOriginale = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      cliccate.push({ href: this.getAttribute('href') ?? '', download: this.download });
    };
    try {
      fetchRegistro(pdfOk);
      await esporta();
      await waitFor(() => expect(cliccate).toHaveLength(1));
    } finally {
      HTMLAnchorElement.prototype.click = clickOriginale;
    }
    expect(cliccate[0]).toEqual({ href: 'blob:finto', download: NOME_DAL_SERVER });
    expect(crea).toHaveBeenCalledTimes(1);
    expect(scarica).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. Allegati dei compiti (TaskCard)
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('allegati dei compiti', () => {
  const URL_ALLEGATO = 'https://storage.example.test/storage/v1/object/sign/tasks/x/relazione.pdf?token=t';
  const TASK = {
    id: 'task-1',
    author_id: 'ut-2',
    assigned_to: 'ut-1',
    target_class: null,
    target_role: null,
    target_scope: 'single',
    titolo: 'TEST incarico',
    status: 'completed',
    priority: 'medium',
    category: 'altro',
    deadline: null,
    student_id: null,
    resolved_by: 'ut-1',
    resolution_notes: null,
    resolved_at: null,
    created_at: '2026-09-01T08:00:00.000Z',
    author: null,
    assignee: null,
    student: null,
    resolver: null,
    attachments: [{ name: 'relazione.pdf', url: URL_ALLEGATO, size: 2048, type: 'application/pdf' }],
  } as unknown as Task;

  function ancoraAllegato(): HTMLAnchorElement {
    render(
      <TaskCard
        task={TASK}
        index={0}
        currentUserId="ut-1"
        currentUserRole="educator"
        onTakeCharge={vi.fn()}
        onComplete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: new RegExp(itTasks.vediDettagli) }));
    return screen.getByTitle(itTasks.scaricaApri) as HTMLAnchorElement;
  }

  it('APP: l’allegato si apre nell’anteprima con apriDocumento, e l’ancora non parte', async () => {
    nativo.mockReturnValue(true);
    const ancora = ancoraAllegato();

    const nonAnnullato = fireEvent.click(ancora);

    expect(nonAnnullato).toBe(false);
    await waitFor(() => expect(apri).toHaveBeenCalledTimes(1));
    expect(apri.mock.calls[0][0]).toEqual({
      sorgente: URL_ALLEGATO,
      nomeFile: 'relazione.pdf',
      mime: 'application/pdf',
      etichetta: 'compito-allegato',
    });
    expect(avviso).not.toHaveBeenCalled();
  });

  it('APP: apertura non riuscita → avviso all’utente', async () => {
    nativo.mockReturnValue(true);
    apri.mockResolvedValue({ esito: 'non-riuscito', motivo: 'http-403' });
    fireEvent.click(ancoraAllegato());

    await waitFor(() => expect(avviso).toHaveBeenCalledWith(itTasks.allegatoNonApribile));
  });

  it('APP: doppio tocco mentre l’allegato è in volo → UNA sola apertura, e l’icona dice che lavora', async () => {
    nativo.mockReturnValue(true);
    const volo = inVolo();
    apri.mockReturnValueOnce(volo.promessa);
    const ancora = ancoraAllegato();

    expect(fireEvent.click(ancora)).toBe(false);
    // Il secondo tocco è annullato anch'esso (niente `target=_blank` a vuoto), ma non riparte.
    expect(fireEvent.click(ancora)).toBe(false);

    expect(apri).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(ancora).toHaveAttribute('aria-busy', 'true'));
    // Il nome accessibile resta quello.
    expect(ancora).toHaveAttribute('title', itTasks.scaricaApri);

    volo.risolvi({ esito: 'nativo-anteprima' });
    await waitFor(() => expect(ancora).not.toHaveAttribute('aria-busy'));
    expect(avviso).not.toHaveBeenCalled();

    // Finito il volo, un nuovo tocco riparte.
    fireEvent.click(ancora);
    await waitFor(() => expect(apri).toHaveBeenCalledTimes(2));
  });

  it('WEB: l’ancora resta quella di sempre e il clic non è annullato', () => {
    const ancora = ancoraAllegato();
    expect(ancora.getAttribute('href')).toBe(URL_ALLEGATO);
    expect(ancora.getAttribute('target')).toBe('_blank');
    expect(ancora.getAttribute('download')).toBe('relazione.pdf');

    const nonAnnullato = fireEvent.click(ancora);

    expect(nonAnnullato).toBe(true);
    expect(apri).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. Certificati medici (PannelloCertificatiMedici)
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('certificato medico', () => {
  const DOCENTE = 'ut-docente-1';
  const CERT = {
    id: 'cert-0001',
    alunno_id: 'alunno-0001',
    nome_alunno: 'Alunno',
    cognome_alunno: 'Finto',
    file_path: 'alunno-0001/file-0001.PDF',
    stato: 'in_validazione',
    note: '',
    creato_il: '2026-09-01T08:00:00.000Z',
  };
  const HREF = `/api/parent/medical-certificates/file?id=${CERT.id}&userId=${DOCENTE}`;
  const toast = vi.fn();

  async function ancoraCertificato(): Promise<HTMLAnchorElement> {
    vi.stubGlobal('fetch', vi.fn(async () => json({ success: true, data: [CERT] })));
    render(
      <PannelloCertificatiMedici
        teacherId={DOCENTE}
        sezioni={['TEST Sezione']}
        sezione="TEST Sezione"
        onSezione={vi.fn()}
        onToast={toast}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: itServizi.modulisticaValida }));
    return screen.getByRole('link', { name: new RegExp(itServizi.modulisticaApriDocumento) }) as HTMLAnchorElement;
  }

  beforeEach(() => toast.mockReset());

  it('APP: apriDocumento sulla route della stessa origine, nome generico con l’estensione del file vero', async () => {
    nativo.mockReturnValue(true);
    const ancora = await ancoraCertificato();

    expect(fireEvent.click(ancora)).toBe(false);

    await waitFor(() => expect(apri).toHaveBeenCalledTimes(1));
    expect(apri.mock.calls[0][0]).toEqual({
      sorgente: HREF,
      // La route risponde octet-stream: senza l'estensione dal percorso l'anteprima
      // non saprebbe che file sia. E nessun nome di bambino nel nome del file.
      nomeFile: 'certificato-medico.pdf',
      etichetta: 'certificato-medico',
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it('APP: apertura non riuscita → toast', async () => {
    nativo.mockReturnValue(true);
    apri.mockResolvedValue({ esito: 'non-riuscito', motivo: 'plugin-assenti:filesystem|link-non-condivisibile' });
    fireEvent.click(await ancoraCertificato());

    await waitFor(() => expect(toast).toHaveBeenCalledWith(itServizi.modulisticaDocumentoNonApribile));
  });

  it('APP: doppio tocco mentre il certificato è in volo → UNA sola apertura, niente toast falso', async () => {
    nativo.mockReturnValue(true);
    const volo = inVolo();
    apri.mockReturnValueOnce(volo.promessa);
    const ancora = await ancoraCertificato();

    expect(fireEvent.click(ancora)).toBe(false);
    expect(fireEvent.click(ancora)).toBe(false);

    expect(apri).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(ancora).toHaveAttribute('aria-busy', 'true'));
    expect(ancora).toHaveAccessibleName(new RegExp(itServizi.modulisticaApriDocumento));

    volo.risolvi({ esito: 'nativo-anteprima' });
    await waitFor(() => expect(ancora).not.toHaveAttribute('aria-busy'));
    expect(toast).not.toHaveBeenCalled();

    fireEvent.click(ancora);
    await waitFor(() => expect(apri).toHaveBeenCalledTimes(2));
  });

  it('WEB: stessa ancora di prima, clic non annullato, helper non chiamato', async () => {
    const ancora = await ancoraCertificato();
    expect(ancora.getAttribute('href')).toBe(HREF);
    expect(ancora.getAttribute('target')).toBe('_blank');

    expect(fireEvent.click(ancora)).toBe(true);
    expect(apri).not.toHaveBeenCalled();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. Archivio documenti (DocumentiFirmatiPanel)
 * ═══════════════════════════════════════════════════════════════════════════ */

describe('documento dell’archivio', () => {
  const URL_FIRMATO = 'https://storage.example.test/storage/v1/object/sign/fascicolo/a1/b2.pdf?token=t';
  const DOC = {
    id: 'fascicolo:doc-0001',
    fonte: 'fascicolo',
    rifId: 'doc-0001',
    alunnoId: 'alunno-0001',
    titolo: 'Modulo',
    tipo: 'altro',
    categoria: 'amministrativo',
    firmato: false,
    firmatoIl: null,
    creatoIl: '2026-09-01T08:00:00.000Z',
    scadeIl: null,
    nota: null,
  };

  async function ancoraScarica(fileName: string | null): Promise<HTMLAnchorElement> {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes('/api/documenti-firmati/dettaglio')) {
          return json({
            success: true,
            data: { id: DOC.id, fonte: 'fascicolo', categoria: 'amministrativo', titolo: 'Modulo', url: URL_FIRMATO, fileName },
          });
        }
        return json({
          success: true,
          data: [DOC],
          alunni: [{ id: DOC.alunnoId, nome: 'Alunno', cognome: 'Finto', classe_sezione: 'TEST', section_id: null, scuola_id: null }],
        });
      }),
    );
    render(<DocumentiFirmatiPanel />);
    fireEvent.click(await screen.findByRole('button', { name: itDocumenti.apri }));
    return (await screen.findByRole('link', { name: new RegExp(itDocumenti.scarica) })) as HTMLAnchorElement;
  }

  it('APP: scaricaDocumento sull’indirizzo firmato, col nome caricato più l’estensione vera', async () => {
    nativo.mockReturnValue(true);
    const ancora = await ancoraScarica('modulo iscrizione');

    expect(fireEvent.click(ancora)).toBe(false);

    await waitFor(() => expect(scarica).toHaveBeenCalledTimes(1));
    expect(scarica.mock.calls[0][0]).toEqual({
      sorgente: URL_FIRMATO,
      nomeFile: 'modulo iscrizione.pdf',
      etichetta: 'documento-alunno',
    });
  });

  it('APP: senza nome caricato → nome generico, mai il titolo', async () => {
    nativo.mockReturnValue(true);
    fireEvent.click(await ancoraScarica(null));

    await waitFor(() => expect(scarica).toHaveBeenCalledTimes(1));
    expect(scarica.mock.calls[0][0].nomeFile).toBe('documento-alunno.pdf');
  });

  it('APP: scarico non riuscito → avviso nel pannello', async () => {
    nativo.mockReturnValue(true);
    scarica.mockResolvedValue({ esito: 'non-riuscito', motivo: 'http-400|condivisione-non-riuscita' });
    fireEvent.click(await ancoraScarica('modulo.pdf'));

    expect(await screen.findByRole('alert')).toHaveTextContent(itDocumenti.scaricoNonRiuscito);
  });

  it('APP: doppio tocco mentre lo scarico è in volo → UN solo scarico, niente avviso falso', async () => {
    nativo.mockReturnValue(true);
    const volo = inVolo();
    scarica.mockReturnValueOnce(volo.promessa);
    const ancora = await ancoraScarica('modulo.pdf');

    expect(fireEvent.click(ancora)).toBe(false);
    expect(fireEvent.click(ancora)).toBe(false);

    expect(scarica).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(ancora).toHaveAttribute('aria-busy', 'true'));
    expect(ancora).toHaveAccessibleName(new RegExp(itDocumenti.scarica));

    volo.risolvi({ esito: 'nativo-file' });
    await waitFor(() => expect(ancora).not.toHaveAttribute('aria-busy'));
    expect(screen.queryByRole('alert')).toBeNull();

    fireEvent.click(ancora);
    await waitFor(() => expect(scarica).toHaveBeenCalledTimes(2));
  });

  it('WEB: stessa ancora di prima, clic non annullato, helper non chiamato', async () => {
    const ancora = await ancoraScarica('modulo.pdf');
    expect(ancora.getAttribute('href')).toBe(URL_FIRMATO);
    expect(ancora.getAttribute('target')).toBe('_blank');

    expect(fireEvent.click(ancora)).toBe(true);
    expect(scarica).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
