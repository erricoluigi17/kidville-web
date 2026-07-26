import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import config from '../../capacitor.config';

/**
 * Lock delle configurazioni native che proteggono i dati dei minori.
 *
 * Perché è un lock e non una checklist: una configurazione mancante non
 * fallisce, non rompe niente e non avvisa nessuno — si scopre solo con un
 * telefono in mano, e nel caso peggiore su un telefono altrui. È esattamente
 * quello che è successo: per un'intera fase il bridge di Capacitor ha stampato
 * nei log di sistema il dataUrl base64 delle foto scattate (EXIF compreso, GPS
 * compreso), e il gate era verde.
 */

const RADICE = process.cwd();

function leggi(rel: string): string {
    return fs.readFileSync(path.join(RADICE, rel), 'utf8');
}

/**
 * Contenuto dell'`<array>` che segue una `<key>`, con annidamenti bilanciati
 * (`NSPrivacyCollectedDataTypes` contiene dict che contengono altri array).
 * Un `indexOf('</array>')` ingenuo taglierebbe al primo array interno.
 */
function arrayDopo(xml: string, chiave: string): string {
    const i = xml.indexOf(`<key>${chiave}</key>`);
    if (i < 0) throw new Error(`chiave assente nel manifest: ${chiave}`);
    const apre = xml.indexOf('<array', i);
    if (apre < 0) throw new Error(`nessun <array> dopo ${chiave}`);
    if (xml.startsWith('<array/>', apre)) return '';
    const inizio = apre + '<array>'.length;
    let p = inizio;
    let livello = 1;
    while (livello > 0) {
        const su = xml.indexOf('<array>', p);
        const giu = xml.indexOf('</array>', p);
        if (giu < 0) throw new Error('manifest malformato: <array> mai chiuso');
        if (su >= 0 && su < giu) {
            livello += 1;
            p = su + '<array>'.length;
        } else {
            livello -= 1;
            if (livello === 0) return xml.slice(inizio, giu);
            p = giu + '</array>'.length;
        }
    }
    return '';
}

function dizionari(arr: string): string[] {
    return arr
        .split('<dict>')
        .slice(1)
        .map((d) => d.split('</dict>')[0]);
}

function stringhe(xml: string): string[] {
    return [...xml.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
}

function stringa(dict: string, chiave: string): string | undefined {
    return new RegExp(`<key>${chiave}</key>\\s*<string>([^<]*)</string>`).exec(dict)?.[1];
}

function booleano(dict: string, chiave: string): boolean | undefined {
    const m = new RegExp(`<key>${chiave}</key>\\s*<(true|false)\\s*/>`).exec(dict);
    return m ? m[1] === 'true' : undefined;
}

describe('lock — log del bridge Capacitor', () => {
    it('loggingBehavior è «none»: è il canale da cui è uscita la foto', () => {
        expect(config.loggingBehavior).toBe('none');
    });

    it('NON è «production» — il nome inganna', () => {
        // Nel codice nativo (CapConfig.java, CAPInstanceConfiguration.m)
        // `production` significa «log SEMPRE attivi, anche nelle build di
        // rilascio»: applicarlo peggiorerebbe il difetto invece di correggerlo.
        expect(config.loggingBehavior).not.toBe('production');
    });

    it('nessun override per piattaforma riapre il canale', () => {
        expect(config.android?.loggingBehavior ?? 'none').toBe('none');
        expect(config.ios?.loggingBehavior ?? 'none').toBe('none');
    });
});

describe('lock — Service Worker su iOS', () => {
    const plist = leggi('ios/App/App/Info.plist');

    it('WKAppBoundDomains esiste: senza, WKWebView non registra alcun SW', () => {
        expect(plist).toContain('<key>WKAppBoundDomains</key>');
    });

    // La lista INTERA, non «almeno questi». Una voce tolta non rompe nulla in
    // locale, non fa fallire alcun test funzionale e non si vede in code review:
    // si scopre su un telefono, con un embed nero o con il Service Worker morto.
    // E si ripara SOLO con un aggiornamento sullo store, cioè giorni.
    //   • kidville.it / app.kidville.it → l'app e i suoi sottodomini
    //   • localhost                    → schema locale di Capacitor (offline.html)
    //   • supabase.co                  → API e Storage (foto, documenti)
    //   • instagram.com / youtube-nocookie.com / vimeo.com → embed della sezione News
    const DOMINI_ATTESI = [
        'kidville.it',
        'app.kidville.it',
        'localhost',
        'supabase.co',
        'instagram.com',
        'youtube-nocookie.com',
        'vimeo.com',
    ];

    it('elenca ESATTAMENTE i 7 domini previsti, nessuno in meno', () => {
        const domini = stringhe(arrayDopo(plist, 'WKAppBoundDomains'));
        // Confronto ordinato: riordinare la lista è innocuo, toglierne una no.
        expect([...domini].sort()).toEqual([...DOMINI_ATTESI].sort());
    });

    it('resta entro il massimo di 10 domini imposto da Apple', () => {
        const domini = stringhe(arrayDopo(plist, 'WKAppBoundDomains'));
        expect(domini.length).toBeGreaterThan(0);
        expect(domini.length).toBeLessThanOrEqual(10);
    });

    it('il flag di navigazione è acceso solo contro il dominio di produzione', () => {
        // In dev CAP_SERVER_URL è un IP di LAN, che non può stare nella lista:
        // accendere il flag lì renderebbe l'app un muro.
        const sorgente = leggi('capacitor.config.ts');
        expect(sorgente).toContain('limitsNavigationsToAppBoundDomains');
        expect(sorgente).toContain('https://app.kidville.it');
    });
});

describe('lock — Face ID', () => {
    it('NSFaceIDUsageDescription esiste e non è un segnaposto', () => {
        // Senza questa chiave il plugin forza `isAvailable = false`: non è un
        // crash, è peggio — lo switch non compare e la UI dice «non disponibile
        // su questo dispositivo», anche al revisore Apple.
        const plist = leggi('ios/App/App/Info.plist');
        expect(plist).toContain('<key>NSFaceIDUsageDescription</key>');
        const testo = plist.split('<key>NSFaceIDUsageDescription</key>')[1].split('</string>')[0];
        expect(testo.replace(/[\s\S]*<string>/, '').trim().length).toBeGreaterThan(30);
    });
});

describe('lock — privacy manifest iOS (PrivacyInfo.xcprivacy)', () => {
    const manifest = leggi('ios/App/App/PrivacyInfo.xcprivacy');

    /**
     * I tipi di dato che l'app raccoglie DAVVERO, verificati sullo schema e sul
     * codice, non sulle intenzioni:
     *   • Name          → students.nome/cognome, parents.first_name/last_name
     *   • EmailAddress  → parents.emails, utenti.email, credenziali di accesso
     *   • PhoneNumber   → parents.phone_numbers (contatti di emergenza)
     *   • PhotosorVideos→ galleria_media, foto del diario, @capacitor/camera
     *                     (grafia di Apple con la «or» minuscola: è quella giusta)
     *   • PaymentInfo   → incassi.metodo (contanti/bonifico/pos/assegno) e
     *                     riconciliazione_movimenti.controparte
     *   • UserID        → utenti.id, parents.auth_user_id, push_subscriptions
     *   • CrashData / OtherDiagnosticData → app_log, alimentata anche da
     *                     window.onerror e unhandledrejection con lo stack
     *
     * Un manifest vuoto su un'app che tratta dati di minori non è una svista
     * formale: è la dichiarazione che non si raccoglie nulla.
     */
    const TIPI_ATTESI = [
        'NSPrivacyCollectedDataTypeName',
        'NSPrivacyCollectedDataTypeEmailAddress',
        'NSPrivacyCollectedDataTypePhoneNumber',
        'NSPrivacyCollectedDataTypePhotosorVideos',
        'NSPrivacyCollectedDataTypePaymentInfo',
        'NSPrivacyCollectedDataTypeUserID',
        'NSPrivacyCollectedDataTypeCrashData',
        'NSPrivacyCollectedDataTypeOtherDiagnosticData',
    ];

    /**
     * API a motivazione obbligatoria. I codici sono quelli di Apple, verificati
     * anche contro i manifest che le dipendenze già spediscono nel bundle
     * (GoogleUtilities, gRPC, leveldb, ion-ios-camera):
     *   • UserDefaults   CA92.1 → dati leggibili solo dall'app stessa
     *   • FileTimestamp  C617.1 → metadati di file dentro il container dell'app
     *   • DiskSpace      E174.1 → verifica dello spazio per scrivere e potatura
     *                             della cache quando lo spazio manca
     *   • SystemBootTime 35F9.1 → tempo trascorso fra eventi interni / timer
     *                             (il dato NON esce dal dispositivo)
     * Serve dichiararle a livello di app perché i manifest di Capacitor e
     * CapacitorCordova sono VUOTI: nessuno le copre al posto nostro.
     */
    const API_ATTESE: Record<string, string> = {
        NSPrivacyAccessedAPICategoryUserDefaults: 'CA92.1',
        NSPrivacyAccessedAPICategoryFileTimestamp: 'C617.1',
        NSPrivacyAccessedAPICategoryDiskSpace: 'E174.1',
        NSPrivacyAccessedAPICategorySystemBootTime: '35F9.1',
    };

    it('NSPrivacyCollectedDataTypes NON è vuoto', () => {
        expect(manifest).not.toMatch(/<key>NSPrivacyCollectedDataTypes<\/key>\s*<array\s*\/>/);
        expect(dizionari(arrayDopo(manifest, 'NSPrivacyCollectedDataTypes')).length).toBeGreaterThan(
            0,
        );
    });

    it('dichiara i tipi di dato che l’app raccoglie davvero', () => {
        const tipi = dizionari(arrayDopo(manifest, 'NSPrivacyCollectedDataTypes')).map((d) =>
            stringa(d, 'NSPrivacyCollectedDataType'),
        );
        for (const atteso of TIPI_ATTESI) expect(tipi).toContain(atteso);
        expect(new Set(tipi).size).toBe(tipi.length); // nessun doppione
    });

    it('ogni tipo è collegato all’identità, nessuno serve al tracciamento', () => {
        // «Linked» perché tutto passa da un account: il diario di un bambino non
        // è mai un dato anonimo. «Tracking» false perché non c'è pubblicità né
        // condivisione con data broker — e NSPrivacyTracking lo conferma.
        const dict = dizionari(arrayDopo(manifest, 'NSPrivacyCollectedDataTypes'));
        expect(dict.length).toBeGreaterThan(0);
        for (const d of dict) {
            const nome = stringa(d, 'NSPrivacyCollectedDataType');
            expect(nome, 'ogni voce dichiara il proprio tipo').toBeDefined();
            expect(booleano(d, 'NSPrivacyCollectedDataTypeLinked'), `${nome} · Linked`).toBe(true);
            expect(booleano(d, 'NSPrivacyCollectedDataTypeTracking'), `${nome} · Tracking`).toBe(
                false,
            );
            const scopi = stringhe(arrayDopo(d, 'NSPrivacyCollectedDataTypePurposes'));
            expect(scopi, `${nome} · Purposes`).toContain(
                'NSPrivacyCollectedDataTypePurposeAppFunctionality',
            );
        }
    });

    it('nessuna forma di tracciamento dichiarata', () => {
        expect(manifest).toMatch(/<key>NSPrivacyTracking<\/key>\s*<false\s*\/>/);
        expect(stringhe(arrayDopo(manifest, 'NSPrivacyTrackingDomains'))).toEqual([]);
    });

    it('le API a motivazione obbligatoria hanno il codice giusto', () => {
        const dict = dizionari(arrayDopo(manifest, 'NSPrivacyAccessedAPITypes'));
        const dichiarate = new Map(
            dict.map((d) => [
                stringa(d, 'NSPrivacyAccessedAPIType') ?? '',
                stringhe(arrayDopo(d, 'NSPrivacyAccessedAPITypeReasons')),
            ]),
        );
        for (const [categoria, motivo] of Object.entries(API_ATTESE)) {
            expect(dichiarate.has(categoria), `manca ${categoria}`).toBe(true);
            expect(dichiarate.get(categoria), `${categoria} · reason`).toContain(motivo);
        }
    });
});

describe('lock — backup Android', () => {
    const manifest = leggi('android/app/src/main/AndroidManifest.xml');

    it('allowBackup è disattivato: l’IndexedDB contiene dati di minori', () => {
        expect(manifest).toContain('android:allowBackup="false"');
    });

    it('dichiara entrambe le regole di estrazione', () => {
        expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
        expect(manifest).toContain('android:fullBackupContent="@xml/backup_rules"');
    });

    it('esclude anche il trasferimento fra dispositivi (Android 12+)', () => {
        // Su API 31+ `allowBackup="false"` chiude il cloud ma NON il
        // device-to-device: senza <device-transfer> i dati passerebbero comunque
        // al telefono nuovo.
        const regole = leggi('android/app/src/main/res/xml/data_extraction_rules.xml');
        expect(regole).toContain('<device-transfer>');
        expect(regole).toContain('<exclude domain="root" />');
        const vecchie = leggi('android/app/src/main/res/xml/backup_rules.xml');
        expect(vecchie).toContain('<exclude domain="root" />');
    });
});

describe('lock — z-index dell’overlay biometrico', () => {
    it('il gate sta sopra a tutto, e nessun altro file lo supera', () => {
        // A z-[100] veniva sormontato dalla chrome admin (105/110) e dai toast
        // (120): l'app risultava «bloccata» ma con pezzi di UI ancora sopra.
        const gate = leggi('src/components/providers/BiometricGate.tsx');
        expect(gate).toContain('z-[9999]');

        const file = elencaFile(path.join(RADICE, 'src'), /\.tsx?$/);
        for (const f of file) {
            if (f.endsWith('BiometricGate.tsx')) continue;
            for (const m of leggi(path.relative(RADICE, f)).matchAll(/z-\[(\d+)\]/g)) {
                expect(Number(m[1])).toBeLessThan(9999);
            }
        }
    });
});

function elencaFile(dir: string, filtro: RegExp): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...elencaFile(p, filtro));
        else if (filtro.test(e.name)) out.push(p);
    }
    return out;
}
