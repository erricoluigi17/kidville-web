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
      for (const k of ['gradiente', 'composizione', 'fondoIgnoto']) {
        expect(Number.isInteger(v.saltati?.[k]), `${v.rotta}: saltati.${k} mancante`).toBe(true);
      }
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
});
