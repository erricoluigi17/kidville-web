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

    it('elenca il dominio dell’app e localhost (richiesto da Capacitor)', () => {
        expect(plist).toContain('<string>kidville.it</string>');
        expect(plist).toContain('<string>localhost</string>');
    });

    it('resta entro il massimo di 10 domini imposto da Apple', () => {
        const blocco = plist.split('<key>WKAppBoundDomains</key>')[1].split('</array>')[0];
        const domini = blocco.match(/<string>/g)?.length ?? 0;
        expect(domini).toBeGreaterThan(0);
        expect(domini).toBeLessThanOrEqual(10);
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
