import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { COMUNI_GREZZI, FONTE } from '@/lib/fiscale/dati/comuni-belfiore';
import {
  comuniDiProvincia,
  comunePerBelfiore,
  risolviComune,
  siglePresenti,
  type Comune,
} from '@/lib/fiscale/comuni';
import { PROVINCE } from '@/lib/anagrafiche/province';

/**
 * NESSUN CODICE FISCALE VERO IN QUESTO FILE. Il repository è pubblico: un codice
 * fiscale con checksum valida appartiene a una persona esistente. Qui si collaudano
 * comuni e codici catastali, che sono dati pubblici (ISTAT/Agenzia delle Entrate) e non
 * identificano nessuno.
 */

/** Il dataset riletto a mano, per confrontare l'API con la sua materia prima. */
const RIGHE = COMUNI_GREZZI.split('\n').map((r) => {
  const [belfiore, sigla, nome, attivo] = r.split('|');
  return { belfiore, sigla, nome, attivo: attivo === '1' };
});

describe('dataset comuni-belfiore (forma e integrità)', () => {
  it('ogni riga ha quattro campi nella forma attesa', () => {
    expect(RIGHE.length).toBeGreaterThan(13_000);
    const fuoriForma = RIGHE.filter(
      (r) =>
        !/^[A-Z][0-9]{3}$/.test(r.belfiore) ||
        !/^[A-Z]{2}$/.test(r.sigla) ||
        !r.nome ||
        r.nome !== r.nome.trim(),
    );
    expect(fuoriForma).toEqual([]);
  });

  it('dichiara la fonte, la licenza CC BY-SA 4.0 e la data', () => {
    expect(FONTE.nome).toBe('codice-fiscale-js');
    expect(FONTE.licenza).toBe('CC-BY-SA-4.0');
    expect(FONTE.versione).toMatch(/^\d+\.\d+\.\d+$/);
    expect(FONTE.aggiornato).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /**
   * Il dataset è FERMO A CIRCA IL 2022, e la fonte non lo dichiara: qui lo si misura.
   * Se un giorno la dipendenza viene aggiornata, questo test diventa rosso — ed è il
   * momento giusto per riscrivere l'avvertenza nell'intestazione del file generato,
   * invece di lasciarla mentire come è già successo altrove in questo repo.
   */
  it("MISILISCEMI (2022) c'è, UGGIATE CON RONAGO (2024) no: l'elenco è vecchio", () => {
    expect(RIGHE.some((r) => r.nome === 'MISILISCEMI' && r.attivo)).toBe(true);
    expect(RIGHE.some((r) => r.nome.replace(/-/g, ' ') === 'UGGIATE CON RONAGO')).toBe(false);
    const intestazione = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/fiscale/dati/comuni-belfiore.ts'),
      'utf8',
    );
    expect(intestazione).toContain('CC BY-SA 4.0');
    expect(intestazione).toContain('MISILISCEMI');
    expect(intestazione).toContain('UGGIATE CON RONAGO');

    /**
     * I CODICI CITATI NELL'INTESTAZIONE SI RILEGGONO SUL DATASET, uno per uno.
     *
     * Quel blocco dichiara di sé stesso «è stato MISURATO su questo stesso dataset, non
     * dedotto»: finché nessuno lo verifica, è una parola. E infatti ci ha già mentito —
     * diceva «RONAGO (H509)», mentre H509 è ROMANO / ROMANO DI LOMBARDIA in provincia di
     * BG e RONAGO è H521. Un codice Belfiore inventato scritto accanto alla parola
     * «MISURATO», in un repo pubblico, in un file di codici catastali, è esattamente il
     * documento che mente di cui questo repository ha già pagato il prezzo.
     * Da qui in avanti non può più sopravvivere alla rilettura: il codice si estrae
     * dall'intestazione e si confronta con la riga vera.
     */
    // L'intestazione cita i codici in due forme — «UGGIATE-TREVANO (L487)» e
    // «MISILISCEMI (TP, M432)» — e la sigla, quando c'è, precede il Belfiore.
    // Il nome si scherma: `UGGIATE-TREVANO` contiene un trattino, e domani un nome
    // potrebbe contenere un carattere che in una regex vuol dire altro.
    const citato = (nome: string): string | null => {
      const schermato = nome.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
      const m = new RegExp(`${schermato}\\s*\\((?:[A-Z]{2},\\s*)?([A-Z][0-9]{3})\\)`).exec(
        intestazione,
      );
      return m ? m[1] : null;
    };
    for (const nome of ['MISILISCEMI', 'UGGIATE-TREVANO', 'RONAGO']) {
      const belfiore = citato(nome);
      expect(belfiore, `l'intestazione non cita più un codice per ${nome}`).not.toBeNull();
      const righe = RIGHE.filter((r) => r.nome === nome);
      expect(righe.length, `${nome} non è nel dataset`).toBeGreaterThan(0);
      // Il codice citato è QUELLO di quel nome, e nessun altro nome lo occupa altrove.
      expect(righe.map((r) => r.belfiore)).toEqual(righe.map(() => belfiore));
    }
    // E la controprova sull'errore che c'era: H509 non è RONAGO, è un comune di BG.
    expect(RIGHE.filter((r) => r.belfiore === 'H509').map((r) => r.sigla)).not.toContain('CO');
  });

  it('i soppressi sono marcati attivo: false e sono migliaia', () => {
    const soppressi = RIGHE.filter((r) => !r.attivo);
    expect(soppressi.length).toBeGreaterThan(5_000);
    // ABANO BAGNI è la vecchia denominazione di ABANO TERME: stesso Belfiore, uno solo attivo.
    const abano = RIGHE.filter((r) => r.belfiore === 'A001');
    expect(abano.map((r) => `${r.nome}=${r.attivo}`).sort()).toEqual([
      'ABANO BAGNI=false',
      'ABANO TERME=true',
    ]);
    expect(comunePerBelfiore('A001')?.nome).toBe('ABANO TERME');
  });

  /**
   * Regola forte sui COMUNI ITALIANI: un Belfiore attivo identifica un comune e uno solo.
   * Sugli STATI ESTERI non vale, e non è un difetto del dataset: l'Agenzia delle Entrate
   * tiene più denominazioni attive per lo stesso codice (Z114 = «REGNO UNITO» e «GRAN
   * BRETAGNA E IRLANDA DEL NORD»). Sono sinonimi, non due luoghi: `comunePerBelfiore` ne
   * restituisce uno, e `risolviComune` li deduplica per Belfiore invece di dichiararli
   * ambigui. Il numero è misurato, così se cambia lo si vede.
   */
  it('nessun Belfiore duplicato fra i comuni italiani attivi', () => {
    const visti = new Set<string>();
    const duplicati: string[] = [];
    for (const r of RIGHE) {
      if (!r.attivo || r.sigla === 'EE') continue;
      if (visti.has(r.belfiore)) duplicati.push(r.belfiore);
      visti.add(r.belfiore);
    }
    expect(duplicati).toEqual([]);
    expect(visti.size).toBe(7902);
  });

  it('i soli Belfiore attivi ripetuti sono sinonimi di stati esteri', () => {
    const perBelfiore = new Map<string, string[]>();
    for (const r of RIGHE) {
      if (!r.attivo) continue;
      perBelfiore.set(r.belfiore, [...(perBelfiore.get(r.belfiore) ?? []), r.nome]);
    }
    const ripetuti = [...perBelfiore.entries()].filter(([, nomi]) => nomi.length > 1);
    expect(ripetuti.length).toBe(21);
    expect(ripetuti.every(([belfiore]) => belfiore.startsWith('Z'))).toBe(true);
    expect(perBelfiore.get('Z114')?.sort()).toEqual([
      'GRAN BRETAGNA E IRLANDA DEL NORD',
      'REGNO UNITO',
    ]);
  });
});

describe('sigle di provincia', () => {
  /**
   * Ogni sigla del dataset dev'essere una sigla che sappiamo spiegare. Le 107 attuali
   * stanno in `province.ts`; oltre a quelle il dataset ne usa tre, e ognuna ha una ragione:
   *  · EE  → estero: è la «provincia» degli stati esteri (Belfiore Z***);
   *  · PL  → Pola,  provincia italiana fino al 1947 (Istria);
   *  · ZA  → Zara,  provincia italiana fino al 1947 (Dalmazia).
   * PL e ZA compaiono SOLO su comuni soppressi, e il test lo verifica: se un giorno una
   * sigla nuova entrasse nel dataset senza una spiegazione, questo test la intercetta
   * invece di lasciarla passare dentro una tendina.
   */
  const STORICHE = ['PL', 'ZA'] as const;

  it('ogni sigla del dataset è nota: 107 province + EE + le storiche', () => {
    const attuali = new Set(PROVINCE.map((p) => p.sigla));
    expect(attuali.size).toBe(107);
    const note = new Set<string>([...attuali, 'EE', ...STORICHE]);
    const ignote = siglePresenti().filter((s) => !note.has(s));
    expect(ignote).toEqual([]);
    expect(siglePresenti().length).toBe(110);
  });

  it('le sigle storiche PL e ZA esistono solo su comuni soppressi', () => {
    for (const storica of STORICHE) {
      const tutte = comuniDiProvincia(storica, { soppressi: true });
      expect(tutte.length).toBeGreaterThan(0);
      expect(tutte.every((c) => !c.attivo)).toBe(true);
      expect(comuniDiProvincia(storica)).toEqual([]);
    }
  });

  it('gli stati esteri Z*** stanno tutti sotto la sigla EE, e sono 335', () => {
    const esteri = RIGHE.filter((r) => r.belfiore.startsWith('Z'));
    expect(esteri.length).toBe(335);
    expect(esteri.every((r) => r.sigla === 'EE')).toBe(true);
    // e viceversa: sotto EE non c'è nient'altro che stati esteri.
    expect(RIGHE.filter((r) => r.sigla === 'EE').length).toBe(335);
    expect(comuniDiProvincia('EE').every((c) => c.belfiore.startsWith('Z'))).toBe(true);
  });
});

describe('comuniDiProvincia', () => {
  it('NA non è vuota e contiene Napoli e Giugliano in Campania', () => {
    const napoletani = comuniDiProvincia('NA');
    expect(napoletani.length).toBe(92);
    expect(napoletani.map((c) => c.nome)).toContain('NAPOLI');
    expect(napoletani.map((c) => c.nome)).toContain('GIUGLIANO IN CAMPANIA');
    expect(napoletani.every((c) => c.sigla === 'NA' && c.attivo)).toBe(true);
  });

  it('restituisce i comuni in ordine alfabetico di nome', () => {
    const nomi = comuniDiProvincia('CE').map((c) => c.nome);
    expect(nomi).toEqual([...nomi].sort());
    expect(nomi).toContain('AVERSA');
    expect(nomi).toContain('CESA');
  });

  it('con { soppressi: true } l’elenco è più lungo e include i soppressi', () => {
    const soliAttivi = comuniDiProvincia('NA');
    const tutti = comuniDiProvincia('NA', { soppressi: true });
    expect(tutti.length).toBeGreaterThan(soliAttivi.length);
    expect(tutti.some((c) => !c.attivo)).toBe(true);
  });

  it('accetta la sigla in minuscolo, con spazi, o il nome esteso della provincia', () => {
    const atteso = comuniDiProvincia('NA').map((c) => c.belfiore);
    expect(comuniDiProvincia(' na ').map((c) => c.belfiore)).toEqual(atteso);
    expect(comuniDiProvincia('Napoli').map((c) => c.belfiore)).toEqual(atteso);
  });

  it('su una sigla inesistente restituisce un elenco vuoto, non un errore', () => {
    expect(comuniDiProvincia('XX')).toEqual([]);
    expect(comuniDiProvincia('')).toEqual([]);
  });
});

describe('comunePerBelfiore', () => {
  it('H501 è Roma', () => {
    const roma = comunePerBelfiore('H501');
    expect(roma).toEqual<Comune>({ belfiore: 'H501', sigla: 'RM', nome: 'ROMA', attivo: true });
  });

  it('normalizza spazi e minuscole', () => {
    expect(comunePerBelfiore(' h501 ')?.nome).toBe('ROMA');
  });

  it('preferisce la denominazione attiva quando il codice ne ha più di una', () => {
    const e054 = comunePerBelfiore('E054');
    expect(e054).toEqual<Comune>({
      belfiore: 'E054',
      sigla: 'NA',
      nome: 'GIUGLIANO IN CAMPANIA',
      attivo: true,
    });
    expect(comunePerBelfiore('A001')?.attivo).toBe(true);
  });

  it('restituisce null su un codice inesistente o fuori forma', () => {
    expect(comunePerBelfiore('Z999')).toBeNull();
    expect(comunePerBelfiore('ROMA')).toBeNull();
    expect(comunePerBelfiore('')).toBeNull();
  });
});

describe('risolviComune', () => {
  it('è insensibile a maiuscole, accenti, apostrofi e spazi doppi', () => {
    const atteso = { esito: 'trovato', comune: comunePerBelfiore('E054') };
    expect(risolviComune('giugliano in campania', 'NA')).toEqual(atteso);
    expect(risolviComune('  Giugliano   in  Campania  ', 'NA')).toEqual(atteso);

    // AGLIE' nel dataset, «Agliè» sul certificato: stessa cosa.
    const aglie = risolviComune('Agliè', 'TO');
    expect(aglie.esito).toBe('trovato');
    expect(aglie.esito === 'trovato' && aglie.comune.nome).toBe("AGLIE'");

    // L'apostrofo di SANT' non deve impedire il riconoscimento se manca.
    const sant = risolviComune("Sant'Antonio Abate", 'NA');
    expect(sant.esito).toBe('trovato');
    expect(risolviComune('SANTANTONIO ABATE', 'NA')).toEqual(sant);
  });

  /**
   * IL CUORE DI QUESTO MODULO. «Calliano» esiste in provincia di Asti e in provincia di
   * Trento, entrambi attivi, con due Belfiore diversi (B418 e B419). Senza la provincia
   * NON si può scegliere: scegliere sarebbe scrivere nel codice fiscale di un bambino il
   * comune di nascita sbagliato, in silenzio. Stessa regola d'oro di `province.ts`.
   */
  it('un nome presente in due province, senza sigla, è ambiguo — mai un tiro a indovinare', () => {
    const esito = risolviComune('Calliano');
    expect(esito.esito).toBe('ambiguo');
    if (esito.esito !== 'ambiguo') throw new Error('atteso ambiguo');
    expect(esito.candidati.map((c) => `${c.sigla}:${c.belfiore}`).sort()).toEqual([
      'AT:B418',
      'TN:B419',
    ]);
  });

  it('la stessa richiesta con la provincia si risolve senza ambiguità', () => {
    expect(risolviComune('Calliano', 'AT')).toEqual({
      esito: 'trovato',
      comune: { belfiore: 'B418', sigla: 'AT', nome: 'CALLIANO', attivo: true },
    });
    expect(risolviComune('calliano', 'tn')).toEqual({
      esito: 'trovato',
      comune: { belfiore: 'B419', sigla: 'TN', nome: 'CALLIANO', attivo: true },
    });
  });

  it('gli altri omonimi attivi sono ambigui allo stesso modo', () => {
    for (const nome of ['Castro', 'Livo', 'Peglio', 'Samone', 'San Teodoro']) {
      expect(risolviComune(nome).esito).toBe('ambiguo');
    }
  });

  /**
   * L'accento e lo spazio, quando ci sono, DISAMBIGUANO — e buttarli via sarebbe
   * fabbricare un'ambiguità che nei fatti non c'è. Due coppie misurate su questo dataset:
   *   · «PATERNO» (PZ, M269) e «PATERNO'» (CT, G371);
   *   · «TREVILLE» (AL, L403) e «TRE VILLE» (TN, M363).
   * Sulla chiave lasca collassano; sulla stretta no. Non è indovinare: è preferire, fra
   * candidati GIÀ TROVATI, quello che combacia carattere per carattere. Chi scrive
   * «Paternò» sta già dicendo Catania.
   */
  it("l'accento e lo spazio restringono: Paternò≠Paterno, Tre Ville≠Treville", () => {
    expect(risolviComune('Paternò')).toEqual({
      esito: 'trovato',
      comune: { belfiore: 'G371', sigla: 'CT', nome: "PATERNO'", attivo: true },
    });
    expect(risolviComune('Paterno')).toEqual({
      esito: 'trovato',
      comune: { belfiore: 'M269', sigla: 'PZ', nome: 'PATERNO', attivo: true },
    });
    const treVille = risolviComune('Tre Ville');
    expect(treVille.esito === 'trovato' && treVille.comune.sigla).toBe('TN');
    const treville = risolviComune('Treville');
    expect(treville.esito === 'trovato' && treville.comune.sigla).toBe('AL');
  });

  /**
   * Il rovescio della medaglia, e il motivo per cui la chiave stretta non basta da sola:
   * quando la corrispondenza stretta NON scioglie il dubbio — «Calliano» è scritto uguale
   * ad Asti e a Trento — l'esito resta `ambiguo`. La precisione in più non diventa mai
   * una scelta al posto dell'utente.
   */
  it('quando anche la corrispondenza esatta lascia due candidati, resta ambiguo', () => {
    const esito = risolviComune('CALLIANO');
    expect(esito.esito).toBe('ambiguo');
  });

  it('preferisce il comune attivo quando nome e provincia coincidono con un soppresso', () => {
    // ABANO TERME (attivo) e ABANO BAGNI (soppresso) condividono il Belfiore A001;
    // qui serve un caso di NOME UGUALE su due righe, attiva e soppressa.
    const doppioni = (() => {
      const perNomeSigla = new Map<string, typeof RIGHE>();
      for (const r of RIGHE) {
        const k = `${r.nome}|${r.sigla}`;
        perNomeSigla.set(k, [...(perNomeSigla.get(k) ?? []), r]);
      }
      return [...perNomeSigla.values()].filter(
        (g) => g.length > 1 && g.some((r) => r.attivo) && g.some((r) => !r.attivo),
      );
    })();
    expect(doppioni.length).toBeGreaterThan(0);
    for (const gruppo of doppioni) {
      const esito = risolviComune(gruppo[0].nome, gruppo[0].sigla);
      expect(esito.esito).toBe('trovato');
      if (esito.esito === 'trovato') expect(esito.comune.attivo).toBe(true);
    }
  });

  it('risolve gli stati esteri, e i sinonimi dello stesso codice non sono ambigui', () => {
    const uk = risolviComune('Regno Unito');
    expect(uk).toEqual({
      esito: 'trovato',
      comune: { belfiore: 'Z114', sigla: 'EE', nome: 'REGNO UNITO', attivo: true },
    });
    const gb = risolviComune('Gran Bretagna e Irlanda del Nord');
    expect(gb.esito === 'trovato' && gb.comune.belfiore).toBe('Z114');
    expect(risolviComune('Francia', 'EE').esito).toBe('trovato');
  });

  it('un nome sconosciuto, una provincia che non lo contiene e un input vuoto → sconosciuto', () => {
    expect(risolviComune('Kidvilleburgo')).toEqual({ esito: 'sconosciuto' });
    expect(risolviComune('Roma', 'NA')).toEqual({ esito: 'sconosciuto' });
    expect(risolviComune('')).toEqual({ esito: 'sconosciuto' });
    expect(risolviComune('   ')).toEqual({ esito: 'sconosciuto' });
    expect(risolviComune('Napoli', 'XX')).toEqual({ esito: 'sconosciuto' });
  });

  /**
   * «Provincia NON indicata» e «provincia indicata MALE» non sono la stessa cosa, ed è
   * una distinzione che si perde con facilità: basta una guardia scritta come
   * `typeof sigla === 'string' && …`, che su un valore non-stringa non rifiuta — SALTA.
   * Il vincolo evapora e la funzione risponde come se nessuno l'avesse messo.
   *
   * MISURATO prima della correzione: `risolviComune('Roma', 123)` restituiva
   * `trovato H501/RM/ROMA`, e così `['NA']` e `{}` — mentre `'NA'`, cioè la stessa
   * richiesta scritta bene, restituiva `sconosciuto`. Chi passa un tipo sbagliato (JSON
   * non validato, un campo di form letto grezzo) otteneva la risposta più pericolosa che
   * esista: quella giusta per una domanda che non aveva fatto.
   *
   * Un valore non-stringa non è normalizzabile e non è ignorabile: si dice che non si
   * sa, come già fa `comuniDiProvincia`, che sullo stesso input torna elenco vuoto.
   */
  it('provincia non indicata ≠ provincia indicata male', () => {
    // Non indicata: si cerca in tutta Italia, e Roma si trova.
    for (const nonIndicata of [undefined, null, '', '   ']) {
      const esito = risolviComune('Roma', nonIndicata);
      expect(esito.esito, `con ${JSON.stringify(nonIndicata)} ci si aspetta la ricerca su tutta Italia`).toBe('trovato');
      if (esito.esito !== 'trovato') throw new Error('atteso trovato');
      expect(esito.comune.belfiore).toBe('H501');
    }

    // Indicata male: sigla ignota, oppure un valore che non è nemmeno una stringa.
    // In entrambi i casi il vincolo c'è, non è comprensibile, e non si indovina.
    expect(risolviComune('Roma', 'XX')).toEqual({ esito: 'sconosciuto' });
    for (const malIndicata of [123, ['NA'], {}, true, 0]) {
      expect(
        risolviComune('Roma', malIndicata as unknown as string),
        `${JSON.stringify(malIndicata)} è un vincolo non comprensibile: non deve sparire`,
      ).toEqual({ esito: 'sconosciuto' });
      // La coerenza col fratello maggiore: stesso input, stessa postura.
      expect(comuniDiProvincia(malIndicata as unknown as string)).toEqual([]);
    }
  });

  it('trova anche un comune soppresso, marcandolo come tale', () => {
    const esito = risolviComune('Abano Bagni', 'PD');
    expect(esito.esito).toBe('trovato');
    if (esito.esito !== 'trovato') throw new Error('atteso trovato');
    expect(esito.comune).toEqual<Comune>({
      belfiore: 'A001',
      sigla: 'PD',
      nome: 'ABANO BAGNI',
      attivo: false,
    });
  });

  it('ogni comune attivo si ritrova a partire dal proprio nome + sigla', () => {
    const falliti: string[] = [];
    for (const r of RIGHE) {
      if (!r.attivo) continue;
      const esito = risolviComune(r.nome, r.sigla);
      if (esito.esito !== 'trovato' || esito.comune.belfiore !== r.belfiore) {
        falliti.push(`${r.belfiore}|${r.sigla}|${r.nome} → ${esito.esito}`);
      }
    }
    expect(falliti).toEqual([]);
  });
});

describe('riproducibilità del file generato', () => {
  /**
   * Il file generato è committato: dev'essere ESATTAMENTE ciò che lo script produce dalla
   * fonte presente in `node_modules`. Se qualcuno lo modifica a mano (o se la dipendenza
   * cambia senza rigenerare) questo test diventa rosso. La data di generazione viene
   * ripassata allo script, altrimenti il confronto fallirebbe ogni giorno per un motivo
   * che non è quello che si vuole misurare.
   */
  it('rilanciando lo script sulla fonte si riottiene lo stesso file', () => {
    const percorso = path.join(process.cwd(), 'src/lib/fiscale/dati/comuni-belfiore.ts');
    const attuale = fs.readFileSync(percorso, 'utf8');
    const rigenerato = execFileSync(
      process.execPath,
      [
        path.join(process.cwd(), 'scripts/genera-comuni.mjs'),
        '--stdout',
        `--data=${FONTE.aggiornato}`,
      ],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    );
    expect(rigenerato).toBe(attuale);
  });
});
