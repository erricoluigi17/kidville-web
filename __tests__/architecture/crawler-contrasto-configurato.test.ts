import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../../playwright.config';

/**
 * LOCK — il crawler di contrasto è CONFIGURATO come deve, e si controlla in locale.
 *
 * ─── PERCHÉ ESISTE ──────────────────────────────────────────────────────────
 * `e2e/contrasto-schermate.spec.ts` gira SOLO in CI: `.env.local` punta al
 * database di produzione e `npm run e2e` è in `deny`. Un errore nella sua
 * configurazione — un `testMatch` che non aggancia niente, i retry accesi, la
 * baseline sfasata rispetto alle rotte — costerebbe un giro di CI per essere
 * scoperto, e nei casi peggiori NON verrebbe scoperto affatto: un progetto che
 * matcha zero file è verde in un secondo e non prova nulla.
 * Qui si controlla tutto quello che si può controllare senza un browser, e
 * `npx vitest run` lo dice in due secondi.
 */

const RADICE = join(__dirname, '../..');
const SPEC = 'e2e/contrasto-schermate.spec.ts';
const BASELINE = 'docs/superpowers/contrasto-schermate-baseline.json';

const progetti = config.projects ?? [];
const contrasto = progetti.find((p) => p.name === 'contrasto');
const chromium = progetti.find((p) => p.name === 'chromium');

describe('lock — il crawler di contrasto è configurato come deve', () => {
  it('il progetto `contrasto` esiste', () => {
    expect(progetti.length, 'nessun progetto in playwright.config: il lock guarda altrove').toBeGreaterThan(2);
    expect(contrasto, 'manca il progetto `contrasto`: il crawler non verrebbe eseguito da nessuno').toBeTruthy();
    expect(contrasto!.dependencies, 'senza `setup` non esistono gli storageState e ogni rotta finisce sulla login').toContain('setup');
  });

  it('`retries: 0` ESPLICITO — è la ragione per cui il progetto è separato', () => {
    // La config globale usa `retries: 2` in CI. Un fallimento di contrasto non è
    // un caso: è un colore sbagliato, e sarà lo stesso al terzo tentativo. Con i
    // ripescaggi accesi un rosso su tre passerebbe per verde — è successo in
    // questo repo il 24/08 e l'01/09, due job «success» con dentro dei falliti.
    expect(contrasto!.retries, 'il progetto `contrasto` deve dichiarare retries: 0').toBe(0);
  });

  it('lo spec esiste e il `testMatch` lo aggancia davvero', () => {
    expect(existsSync(join(RADICE, SPEC)), `manca ${SPEC}`).toBe(true);
    const m = contrasto!.testMatch;
    const regex = m instanceof RegExp ? m : Array.isArray(m) ? m.find((x) => x instanceof RegExp) as RegExp : undefined;
    expect(regex, 'il testMatch non è una regex leggibile').toBeTruthy();
    expect(regex!.test(SPEC), `il testMatch ${regex} non aggancia ${SPEC}: il progetto sarebbe verde senza eseguire nulla`).toBe(true);
  });

  it('lo spec è ESCLUSO da `chromium`, altrimenti gira due volte', () => {
    // Senza questa esclusione lo spec verrebbe eseguito anche dal progetto
    // `chromium`, che eredita `retries: 2` — cioè proprio dentro la trappola che
    // il progetto separato esiste per evitare. La config documenta già lo stesso
    // incidente per `smoke-artefatto` (run 31276444497, «gli stessi tre test due volte»).
    const ign = chromium!.testIgnore;
    const lista = Array.isArray(ign) ? ign : [ign];
    const coperto = lista.some((x) => x instanceof RegExp && x.test(SPEC));
    expect(coperto, 'aggiungi /contrasto-schermate\\.spec\\.ts$/ al testIgnore del progetto chromium').toBe(true);
  });

  it('la baseline esiste, è ben formata e può solo rimpicciolirsi', () => {
    expect(existsSync(join(RADICE, BASELINE)), `manca ${BASELINE}`).toBe(true);
    const b = JSON.parse(readFileSync(join(RADICE, BASELINE), 'utf8'));
    expect(Array.isArray(b._leggimi), 'la baseline deve spiegarsi da sola a chi la trova in un rosso').toBe(true);
    expect(typeof b.aggiornato).toBe('string');
    expect(Array.isArray(b.rotte)).toBe(true);
    const viste = new Set<string>();
    for (const v of b.rotte) {
      expect(typeof v.rotta, `voce senza rotta: ${JSON.stringify(v)}`).toBe('string');
      expect(v.rotta.startsWith('/'), `rotta non assoluta: ${v.rotta}`).toBe(true);
      expect(viste.has(v.rotta), `rotta due volte in baseline: ${v.rotta}`).toBe(false);
      viste.add(v.rotta);
      for (const k of ['normale', 'altoContrasto', 'nodiMinimi']) {
        expect(Number.isInteger(v[k]) && v[k] >= 0, `${v.rotta}: ${k} non è un intero ≥ 0`).toBe(true);
      }
      expect(v.nodiMinimi, `${v.rotta}: nodiMinimi a 0 renderebbe indistinguibile «pulita» da «vuota»`).toBeGreaterThan(0);
      // ── I SALTATI, ED È UN CICLO SU DUE GRUPPI, NON SU UNO ──────────────────
      // Fino al 2026-09-06 questo ciclo guardava il solo `saltati`, mentre lo spec
      // pretendeva già `saltatiAlto` (`toEqual(voce.saltatiAlto)`): una voce scritta
      // a mano senza quel campo passava DI QUI in verde e falliva in CI con
      // `toEqual(undefined)` — cioè esattamente il giro di CI sprecato che questo
      // lock, per sua stessa testata, esiste per evitare.
      // `-1` è ammesso, ed è l'unico numero negativo che significa qualcosa:
      // «mai misurato». Un contatore non può essere negativo, quindi non può essere
      // scambiato per una misura vera; lo riempie il primo giro di CI.
      for (const gruppo of ['saltati', 'saltatiAlto']) {
        for (const k of ['gradiente', 'composizione', 'fondoIgnoto']) {
          expect(
            Number.isInteger(v[gruppo]?.[k]) && v[gruppo][k] >= -1,
            `${v.rotta}: ${gruppo}.${k} mancante o non è un intero ≥ -1 (−1 = «mai misurato»)`,
          ).toBe(true);
        }
      }

      // ── LA PROVA POSITIVA È OBBLIGATORIA, E NON PUÒ RESTARE UN SEGNAPOSTO ───
      // Senza, una rotta misurata sul GUSCIO passerebbe in silenzio: si
      // incollerebbero i numeri del guscio e resterebbe cieca per sempre, senza
      // nemmeno un rosso. Il criterio dice quale superficie va in scena SOLO a dati
      // arrivati, e quanti nodi la sonda deve contare fra i saltati per quella
      // superficie. Lo spec lo pretende a ogni run, sulle DUE passate.
      const pp = v.provaPositiva;
      expect(pp, `${v.rotta}: manca \`provaPositiva\`. Una rotta senza criterio può essere misurata sul guscio e nessuno se ne accorge: v. il \`_leggimi\` della baseline.`).toBeTruthy();
      expect(['gradiente', 'composizione', 'fondoIgnoto'], `${v.rotta}: provaPositiva.saltato non è uno dei tre contatori`).toContain(pp?.saltato);
      expect(Number.isInteger(pp?.minimo) && pp.minimo >= 1, `${v.rotta}: provaPositiva.minimo deve essere un intero ≥ 1. Il segnaposto \`-1\` che il bootstrap stampa va SOSTITUITO con il criterio vero, altrimenti la rotta resta cieca.`).toBe(true);
      expect((pp?.perche ?? '').length, `${v.rotta}: provaPositiva.perche deve dire QUALE superficie e perché compare solo a dati arrivati`).toBeGreaterThan(60);
    }
  });

  it('le rotte della baseline sono un SOTTOINSIEME di quelle dello spec', () => {
    // Una rotta in baseline che il crawler non visita più è un permesso aperto su
    // niente: fa sembrare il debito diverso da com'è e non protegge nulla.
    // (Il verso opposto — una rotta visitata e non in baseline — lo prende lo
    //  spec stesso, fallendo e stampando la voce da incollare.)
    const sorgente = readFileSync(join(RADICE, SPEC), 'utf8');
    const dichiarate = new Set([...sorgente.matchAll(/rotta:\s*'([^']+)'/g)].map((m) => m[1]));
    expect(dichiarate.size, 'nessuna rotta dichiarata nello spec: il crawler non guarderebbe niente').toBeGreaterThan(4);
    const b = JSON.parse(readFileSync(join(RADICE, BASELINE), 'utf8'));
    const orfane = b.rotte.map((v: { rotta: string }) => v.rotta).filter((r: string) => !dichiarate.has(r));
    expect(orfane, 'rotte in baseline che lo spec non visita più: togli la voce').toEqual([]);
  });

  it('il crawler misura ENTRAMBE le modalità, e lo prova sul proprio sorgente', () => {
    const s = readFileSync(join(RADICE, SPEC), 'utf8');
    // Tre asserzioni di attivazione: l'attributo, il CSS arrivato davvero, e in
    // modalità normale l'attributo ASSENTE (non "normal": `layout.tsx` scrive
    // `undefined`). Se qualcuno le togliesse, il crawler girerebbe due volte in
    // modalità normale senza dirlo.
    expect(s).toContain("toBe('high')");
    expect(s).toContain('toBeNull()');
    expect(s).toContain("rgb(0, 0, 0)");
    expect(s, 'manca il controllo che le due passate diano esiti DIVERSI').toContain('not.toBe(insieme(normale))');
  });

  it('lo spec PRETENDE la prova positiva, sulle due passate', () => {
    // Il criterio scritto in prosa dentro il `_leggimi` valeva per una rotta su
    // due, e la seconda sarebbe fallita in SILENZIO: se al primo giro fosse stata
    // misurata sul guscio, si sarebbero incollati i numeri del guscio e nessuno
    // avrebbe avuto niente da leggere. Portarlo dentro la voce non basta — deve
    // esistere l'expect che lo applica, altrimenti è di nuovo prosa.
    const s = readFileSync(join(RADICE, SPEC), 'utf8');
    expect(s, 'lo spec non legge `voce.provaPositiva`: il criterio resterebbe un commento').toContain('voce.provaPositiva');
    expect(s, 'manca l’expect che pretende il criterio').toContain('toBeGreaterThanOrEqual(pp.minimo)');
    // …e su ENTRAMBE le passate: una superficie che sparisce solo in Alto
    // Contrasto è precisamente il caso che `saltatiAlto` esiste per prendere.
    expect(s, 'il criterio va preteso anche sulla passata in Alto Contrasto').toMatch(/\['ALTO CONTRASTO', alto\]/);
  });

  it('il blocco «da incollare» esce SOLO dal bootstrap, mai coi numeri peggiorati', () => {
    // `daIncollare` è nato per la baseline VUOTA: un blocco solo da copiare invece
    // di nove frammenti. Appeso anche alle expect a regime, serviva su un piatto il
    // numero MISURATO — cioè quello peggiorato — proprio sotto la riga che dice «se
    // è SALITO hai aggiunto un contrasto sotto soglia». È la trappola che questo
    // repo si è già scritto in memoria come «abbassare la soglia di un lock lo
    // trasforma in decorazione», in forma nuova: non si abbassa una soglia, si
    // offre il valore alzato.
    const s = readFileSync(join(RADICE, SPEC), 'utf8');
    expect(s, 'manca il riconoscimento dei segnaposto').toContain('function haSegnaposto(');
    expect(s, '`daIncollare` non è condizionato al bootstrap').toContain('const daIncollare = inBootstrap ?');
    // Una sola sorgente per quel blocco: se ne comparisse una seconda, incondizionata,
    // la condizione qui sopra sarebbe vera e inutile insieme.
    expect(s.match(/Voce misurata in questa run/g) ?? [], 'il blocco da incollare è costruito in più punti: uno solo può essere condizionato').toHaveLength(1);
  });

  it('la quiete di rete si aspetta PRIMA del ciclo di stabilità', () => {
    // I due coprono momenti DIVERSI e non sono alternativi: il ciclo guarda il
    // rendering DOPO la risposta, `networkidle` la quiete PRIMA. Col solo ciclo, il
    // confine sta a `PASSO_STABILITA_MS` esatti — una fetch che risponde a 499 ms fa
    // leggere 18, 36, 36 (la pagina vera), una che risponde a 501 ms fa leggere
    // 18, 18 e chiama «stabile» il guscio. Su una macchina carica della CI mezzo
    // secondo è un budget sottile: `/teacher` risolve l'identità e poi fa TRE fetch
    // prima che il conteggio si muova.
    const s = readFileSync(join(RADICE, SPEC), 'utf8');
    const rete = s.indexOf("waitForLoadState('networkidle'");
    const ciclo = s.indexOf('while (Date.now() < scadenza)');
    expect(rete, 'manca l’attesa della quiete di rete prima del ciclo').toBeGreaterThan(-1);
    expect(ciclo, 'manca il ciclo di stabilità: il lock guarda altrove').toBeGreaterThan(-1);
    expect(rete, '`networkidle` deve stare PRIMA del ciclo: dopo non coprirebbe niente').toBeLessThan(ciclo);
  });

  it('il bootstrap stampa la baseline ASSEMBLATA, non nove frammenti', () => {
    // Il job `e2e` è un check OBBLIGATORIO su `main`: una baseline vuota BLOCCA
    // il merge finché non viene riempita. È il prezzo di un check che nasce
    // senza misure, e va pagato una volta sola e nel modo più corto — non
    // ricucendo nove messaggi d'errore. Se qualcuno toglie questa comodità, il
    // costo torna addosso a chi apre la PR, e in silenzio.
    const s = readFileSync(join(RADICE, SPEC), 'utf8');
    expect(s, 'manca la raccolta delle voci misurate').toContain('raccolta.push(misurato)');
    expect(s, 'manca l’assemblaggio finale in `afterAll`').toContain('test.afterAll(');
    expect(s, 'la baseline assemblata non viene stampata').toContain('BASELINE DI CONTRASTO');
    // …e non deve stampare nulla in regime normale: sarebbe rumore a ogni run.
    expect(s, 'il blocco va stampato SOLO quando mancano voci').toContain('if (!mancanti.length');
  });
});
