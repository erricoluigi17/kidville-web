package it.kidville.app.caricamenti;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.ImageDecoder;
import android.os.Build;
import android.util.Size;

import androidx.annotation.RequiresApi;

import it.kidville.app.caricamenti.RegistroNativo.ClasseErrore;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * LA RIDUZIONE DELLE FOTO: una foto scelta dal telefono diventa un JPEG di lato lungo al più 1920 px, dritto, senza metadati.
 * (spec 2026-10-03 «app 1.2: caricamenti nativi in background», §4.3 `scegliMedia`, §6.3 «Foto», §9; compito A3)
 *
 * ─── CHE COSA FA, E PERCHÉ ───────────────────────────────────────────────────────────────────
 * Le foto della 1.2 non passano più dalla tela di WebKit/Chromium: le riduce il nativo, che le consegna al JavaScript come base64
 * (`leggiFoto`) già pronte per il percorso foto di oggi. Tre garanzie, tutte e tre provate in JUnit:
 *  · LATO LUNGO ≤ `latoMassimo` (1920), mai ingrandita: una foto già piccola esce delle sue dimensioni;
 *  · SENZA METADATI: nessun EXIF, nessun GPS. `Bitmap.compress` non scrive EXIF, e la pipeline non riusa mai i byte dell'originale:
 *    una foto già piccola viene comunque ricodificata, mai copiata (la posizione di una famiglia non deve uscire dal telefono);
 *  · DRITTA: l'orientamento EXIF (la foto scattata «in piedi» è memorizzata per traverso, con `Orientation = 6`) è applicato
 *    UNA volta sola. La trasparenza va su fondo bianco (un PNG con alpha, in JPEG, diventerebbe nero).
 *
 * ─── I DUE RAMI, E L'ORIENTAMENTO ────────────────────────────────────────────────────────────
 * Da API 28 si decodifica con `ImageDecoder` (HEIF compreso), che applica da sé l'orientamento EXIF e dichiara dimensioni già
 * orientate; sotto API 28 con `BitmapFactory` (`inSampleSize` + ridimensionamento esatto), che l'orientamento lo IGNORA. Chi ruota,
 * e chi no, lo dice ogni decodificatore con `Decodificata.orientamentoApplicato`: se è già applicato la pipeline non tocca nulla,
 * altrimenti legge l'orientamento dall'EXIF del file e ruota lei. Due rami, un solo punto di decisione: ruotare due volte (o zero)
 * è il difetto che il test `un JPEG con EXIF 6 esce dritto su entrambi i rami` esiste per fermare.
 * L'orientamento si legge con un lettore EXIF NOSTRO (puro Java, provato sulla JVM) e non con `android.media.ExifInterface`: dice la
 * stessa cosa, e si può provare byte per byte senza un telefono.
 *
 * ─── COME È FATTA ────────────────────────────────────────────────────────────────────────────
 *  · LA LOGICA È PURA, IL MONDO È UN'INTERFACCIA. Riconoscere il formato dai primi byte, decidere se un HEIC si può leggere (da API
 *    28: sotto no), leggere l'orientamento, calcolare le dimensioni obiettivo e il campionamento, ruotare e appiattire i pixel, e
 *    codificare in base64 sono funzioni statiche senza `android.*`. Le tre sole operazioni che toccano Android — decodificare un file
 *    in pixel, passare da `Bitmap` a `int[]` e comprimere in JPEG — stanno dietro {@link Codec}; {@link CodecAndroid} le fa, e i
 *    test le sostituiscono con una JVM vera (`javax.imageio`) che legge e scrive JPEG e PNG davvero.
 *  · I PIXEL SONO UN `int[]` ARGB ({@link Raster}), come li dà `Bitmap.getPixels`: la rotazione EXIF e l'appiattimento sul bianco
 *    girano SEMPRE su questa rappresentazione, in produzione e nei test. È il codice provato che gira sul telefono, non una sua
 *    copia: il costo è una copia di ≤ 14 MB per foto, trascurabile accanto alla decodifica.
 *  · NIENTE `Log`: i guasti sono valori (`FotoRifiutata`) che chi chiama traduce in motivo di rifiuto e, se «nostri», in una riga di
 *    `media-nativo-preparazione-fallita` (`ClasseErrore`, mai un messaggio: potrebbe contenere un percorso).
 *  · NIENTE PERCORSI NEI MESSAGGI: le eccezioni di questa classe portano solo il nome di un enumerato.
 *
 * ─── COSA SI PROVA IN JUNIT, E COSA NO ───────────────────────────────────────────────────────
 * Si prova tutto ciò che sta sopra {@link Codec}: ogni riga della pipeline, con JPEG veri, EXIF veri e un PNG con trasparenza vera.
 * NON si prova (la JVM non ha `Bitmap` né `ImageDecoder`) la chiamata ai decodificatori di Android: che `ImageDecoder` raddrizzi da sé
 * e `BitmapFactory` no è un fatto della piattaforma, che il collaudo sull'emulatore (E1: «JPEG grande con EXIF ruotato → dritta»)
 * ricontrolla con foto vere.
 */
public final class ElaborazioneFoto {

    private ElaborazioneFoto() {
    }

    /** Da questo livello di API si decodifica con `ImageDecoder`: HEIF compreso, orientamento EXIF applicato dal decodificatore. */
    public static final int SDK_PRIMO_IMAGEDECODER = 28;
    /** Da questo livello di API `ImageDecoder` legge anche AVIF. */
    public static final int SDK_PRIMO_AVIF = 31;
    /** Quanti byte iniziali si leggono per riconoscere il formato e trovare l'EXIF: i metadati stanno prima dei pixel. */
    public static final int BYTE_DI_TESTA = 128 * 1024;
    /** L'orientamento «normale» (nessuna trasformazione), e il valore di chi non ne dichiara. */
    public static final int ORIENTAMENTO_NORMALE = 1;

    /* ────────────────────────────────────────────────────────────────────────────
     * IL FORMATO
     * ──────────────────────────────────────────────────────────────────────────── */

    /** I formati che si riconoscono dai primi byte, col livello di API da cui si decodificano. `SCONOSCIUTO` si prova comunque. */
    public enum Formato {
        JPEG(0),
        PNG(0),
        GIF(0),
        WEBP(0),
        BMP(0),
        /** HEIC e parenti (`ftyp` con marca `heic`, `heix`, `mif1`...): il decodificatore c'è da API 28. */
        HEIF(SDK_PRIMO_IMAGEDECODER),
        AVIF(SDK_PRIMO_AVIF),
        SCONOSCIUTO(0);

        /** Il primo livello di API che sa decodificarlo. */
        public final int sdkMinimo;

        Formato(int sdkMinimo) {
            this.sdkMinimo = sdkMinimo;
        }
    }

    private static final String[] MARCHE_HEIF = {"heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"};
    private static final String[] MARCHE_AVIF = {"avif", "avis"};

    private static int b(byte[] dati, int posizione) {
        return dati[posizione] & 0xFF;
    }

    private static boolean uguali(byte[] dati, int da, String testo) {
        for (int i = 0; i < testo.length(); i++) {
            if (b(dati, da + i) != testo.charAt(i)) return false;
        }
        return true;
    }

    /**
     * Il formato di un file dai suoi primi byte (la «firma»). Non guarda l'estensione né il MIME dichiarato: sono quelli che un
     * provider di file può sbagliare. Un file troppo corto, o con una firma che non si conosce, è `SCONOSCIUTO`.
     */
    public static Formato riconosciFormato(byte[] dati, int lunghezza) {
        int n = dati == null ? 0 : Math.min(lunghezza, dati.length);
        if (n >= 3 && b(dati, 0) == 0xFF && b(dati, 1) == 0xD8 && b(dati, 2) == 0xFF) return Formato.JPEG;
        if (n >= 8 && b(dati, 0) == 0x89 && uguali(dati, 1, "PNG") && b(dati, 4) == 0x0D && b(dati, 5) == 0x0A && b(dati, 6) == 0x1A
                && b(dati, 7) == 0x0A) {
            return Formato.PNG;
        }
        if (n >= 6 && uguali(dati, 0, "GIF8") && (b(dati, 4) == '7' || b(dati, 4) == '9') && b(dati, 5) == 'a') return Formato.GIF;
        if (n >= 12 && uguali(dati, 0, "RIFF") && uguali(dati, 8, "WEBP")) return Formato.WEBP;
        if (n >= 14 && uguali(dati, 0, "BM")) return Formato.BMP;
        if (n >= 12 && uguali(dati, 4, "ftyp")) {
            for (String marca : MARCHE_HEIF) {
                if (uguali(dati, 8, marca)) return Formato.HEIF;
            }
            for (String marca : MARCHE_AVIF) {
                if (uguali(dati, 8, marca)) return Formato.AVIF;
            }
        }
        return Formato.SCONOSCIUTO;
    }

    /** Vero se a questo livello di API il formato si può decodificare. Un HEIC sotto API 28 si rifiuta SUBITO: nessun decodificatore lo apre. */
    public static boolean formatoAmmesso(Formato formato, int sdk) {
        return sdk >= formato.sdkMinimo;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * L'ORIENTAMENTO EXIF
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * L'orientamento EXIF (1-8) di un JPEG, letto dai suoi primi byte; 1 se non c'è, se è fuori elenco o se il file non si lascia
     * leggere. NON LANCIA MAI: un EXIF illeggibile vale «dritta», non un rifiuto.
     *
     * Scorre i segmenti JPEG (`FF xx lunghezza`) finché non trova un APP1 che comincia con «Exif», ne legge l'intestazione TIFF
     * (little-endian `II` o big-endian `MM`) e cerca nella prima directory la voce `0x0112` di tipo SHORT. Si ferma al primo
     * segmento di scansione (`FF DA`): i metadati stanno prima dei pixel. Altri APP1 (per esempio quello di XMP) si saltano.
     */
    public static int orientamentoExif(byte[] dati, int lunghezza) {
        int fine = dati == null ? 0 : Math.min(lunghezza, dati.length);
        if (fine < 4 || b(dati, 0) != 0xFF || b(dati, 1) != 0xD8) return ORIENTAMENTO_NORMALE;
        int p = 2;
        while (p + 4 <= fine) {
            if (b(dati, p) != 0xFF) return ORIENTAMENTO_NORMALE;
            int marcatore = b(dati, p + 1);
            if (marcatore == 0xFF) {
                // Byte di riempimento prima di un marcatore.
                p++;
                continue;
            }
            if (marcatore == 0xD8 || marcatore == 0x01 || (marcatore >= 0xD0 && marcatore <= 0xD7)) {
                // Marcatori senza lunghezza.
                p += 2;
                continue;
            }
            if (marcatore == 0xDA || marcatore == 0xD9) return ORIENTAMENTO_NORMALE;
            int lunghezzaSegmento = (b(dati, p + 2) << 8) | b(dati, p + 3);
            if (lunghezzaSegmento < 2) return ORIENTAMENTO_NORMALE;
            if (marcatore == 0xE1) {
                int trovato = orientamentoDaApp1(dati, p + 4, Math.min(p + 2 + lunghezzaSegmento, fine));
                if (trovato != 0) return trovato;
            }
            p += 2 + lunghezzaSegmento;
        }
        return ORIENTAMENTO_NORMALE;
    }

    private static int leggi16(byte[] dati, int posizione, boolean piccoloFinale) {
        int primo = b(dati, posizione);
        int secondo = b(dati, posizione + 1);
        return piccoloFinale ? (secondo << 8) | primo : (primo << 8) | secondo;
    }

    private static long leggi32(byte[] dati, int posizione, boolean piccoloFinale) {
        long alto = leggi16(dati, piccoloFinale ? posizione + 2 : posizione, piccoloFinale);
        long basso = leggi16(dati, piccoloFinale ? posizione : posizione + 2, piccoloFinale);
        return (alto << 16) | basso;
    }

    /** 0 = in questo segmento non c'è l'orientamento (si cerca altrove); 1-8 = valore trovato (uno fuori elenco vale 1). */
    private static int orientamentoDaApp1(byte[] dati, int inizio, int fine) {
        if (inizio + 14 > fine || !uguali(dati, inizio, "Exif") || b(dati, inizio + 4) != 0 || b(dati, inizio + 5) != 0) return 0;
        int tiff = inizio + 6;
        boolean piccoloFinale;
        if (b(dati, tiff) == 'I' && b(dati, tiff + 1) == 'I') {
            piccoloFinale = true;
        } else if (b(dati, tiff) == 'M' && b(dati, tiff + 1) == 'M') {
            piccoloFinale = false;
        } else {
            return 0;
        }
        if (leggi16(dati, tiff + 2, piccoloFinale) != 42) return 0;
        long scarto = leggi32(dati, tiff + 4, piccoloFinale);
        if (scarto < 8 || tiff + scarto + 2 > fine) return 0;
        int directory = (int) (tiff + scarto);
        int voci = leggi16(dati, directory, piccoloFinale);
        for (int i = 0; i < voci && i < 512; i++) {
            int voce = directory + 2 + 12 * i;
            if (voce + 12 > fine) return 0;
            if (leggi16(dati, voce, piccoloFinale) != 0x0112) continue;
            // Solo il tipo SHORT (3) con un valore: il valore sta nei primi due byte del campo, allineato come dice l'endianness.
            if (leggi16(dati, voce + 2, piccoloFinale) != 3 || leggi32(dati, voce + 4, piccoloFinale) < 1L) return ORIENTAMENTO_NORMALE;
            int valore = leggi16(dati, voce + 8, piccoloFinale);
            return valore >= 1 && valore <= 8 ? valore : ORIENTAMENTO_NORMALE;
        }
        return 0;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LE DIMENSIONI, IL CAMPIONAMENTO, LA QUALITÀ
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Le dimensioni di uscita: il lato lungo vale ESATTAMENTE `latoMassimo` se l'immagine è più grande, altrimenti le dimensioni
     * restano quelle di partenza (mai ingrandire). L'altro lato segue la proporzione, arrotondato, almeno 1. Ruotare di 90° non
     * cambia il lato lungo: le dimensioni si possono calcolare prima o dopo l'orientamento.
     */
    public static int[] dimensioniObiettivo(int larghezza, int altezza, int latoMassimo) {
        if (larghezza <= 0 || altezza <= 0 || latoMassimo <= 0) throw new IllegalArgumentException("dimensioni non valide");
        int lungo = Math.max(larghezza, altezza);
        if (lungo <= latoMassimo) return new int[]{larghezza, altezza};
        double scala = latoMassimo / (double) lungo;
        int nuovaLarghezza = Math.max(1, (int) Math.round(larghezza * scala));
        int nuovaAltezza = Math.max(1, (int) Math.round(altezza * scala));
        if (larghezza >= altezza) {
            nuovaLarghezza = latoMassimo;
        } else {
            nuovaAltezza = latoMassimo;
        }
        return new int[]{nuovaLarghezza, nuovaAltezza};
    }

    /**
     * `inSampleSize` di `BitmapFactory`: la più grande potenza di due che lascia il lato lungo decodificato ancora ≥ `latoObiettivo`
     * (la riduzione finale, esatta, la fa un ridimensionamento a parte). Mai sotto 1.
     */
    public static int campionamento(int larghezza, int altezza, int latoObiettivo) {
        if (larghezza <= 0 || altezza <= 0 || latoObiettivo <= 0) return 1;
        int lungo = Math.max(larghezza, altezza);
        int campione = 1;
        while (lungo / (campione * 2) >= latoObiettivo && campione < (1 << 16)) campione *= 2;
        return campione;
    }

    /** La qualità JPEG di `Bitmap.compress` (1-100) da quella del contratto (0-1, 0,85): arrotondata, tenuta nell'intervallo. */
    public static int qualitaJpeg(double qualita) {
        if (Double.isNaN(qualita)) return 85;
        long cento = Math.round(qualita * 100.0);
        return (int) Math.max(1L, Math.min(100L, cento));
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * I PIXEL
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Un'immagine come elenco di pixel ARGB NON premoltiplicati, riga per riga (la forma di `Bitmap.getPixels`). Non si modifica: le
     * trasformazioni restituiscono un'immagine nuova.
     */
    public static final class Raster {
        public final int larghezza;
        public final int altezza;
        public final int[] argb;

        public Raster(int larghezza, int altezza, int[] argb) {
            if (larghezza <= 0 || altezza <= 0 || argb == null || (long) larghezza * (long) altezza != argb.length) {
                throw new IllegalArgumentException("raster non valido");
            }
            this.larghezza = larghezza;
            this.altezza = altezza;
            this.argb = argb;
        }

        /**
         * L'immagine dritta, dato l'orientamento EXIF con cui è memorizzata (1-8; fuori elenco vale 1). Le otto trasformazioni sono
         * quelle della tabella EXIF: 2 specchio orizzontale · 3 mezzo giro · 4 specchio verticale · 5 trasposizione · 6 un quarto di
         * giro orario · 7 trasposizione rovesciata · 8 un quarto di giro antiorario. Con 5-8 larghezza e altezza si scambiano.
         *
         * Ogni pixel dell'immagine memorizzata in `(x, y)` va in `(x', y')`; l'indice di arrivo è lineare in `x` e `y`
         * (`passoX · x + passoY · y + base`), così il ciclo non decide niente per pixel.
         */
        public Raster conOrientamento(int orientamento) {
            if (orientamento < 2 || orientamento > 8) return this;
            final int l = larghezza;
            final int a = altezza;
            final int passoX;
            final int passoY;
            final int base;
            final int nuovaLarghezza;
            final int nuovaAltezza;
            switch (orientamento) {
                case 2: // x' = L-1-x, y' = y
                    nuovaLarghezza = l;
                    nuovaAltezza = a;
                    passoX = -1;
                    passoY = l;
                    base = l - 1;
                    break;
                case 3: // x' = L-1-x, y' = A-1-y
                    nuovaLarghezza = l;
                    nuovaAltezza = a;
                    passoX = -1;
                    passoY = -l;
                    base = l * a - 1;
                    break;
                case 4: // x' = x, y' = A-1-y
                    nuovaLarghezza = l;
                    nuovaAltezza = a;
                    passoX = 1;
                    passoY = -l;
                    base = (a - 1) * l;
                    break;
                case 5: // x' = y, y' = x
                    nuovaLarghezza = a;
                    nuovaAltezza = l;
                    passoX = a;
                    passoY = 1;
                    base = 0;
                    break;
                case 6: // x' = A-1-y, y' = x
                    nuovaLarghezza = a;
                    nuovaAltezza = l;
                    passoX = a;
                    passoY = -1;
                    base = a - 1;
                    break;
                case 7: // x' = A-1-y, y' = L-1-x
                    nuovaLarghezza = a;
                    nuovaAltezza = l;
                    passoX = -a;
                    passoY = -1;
                    base = l * a - 1;
                    break;
                default: // 8: x' = y, y' = L-1-x
                    nuovaLarghezza = a;
                    nuovaAltezza = l;
                    passoX = -a;
                    passoY = 1;
                    base = (l - 1) * a;
                    break;
            }
            int[] arrivo = new int[argb.length];
            for (int y = 0; y < a; y++) {
                int sorgente = y * l;
                int destinazione = passoY * y + base;
                for (int x = 0; x < l; x++, destinazione += passoX) {
                    arrivo[destinazione] = argb[sorgente + x];
                }
            }
            return new Raster(nuovaLarghezza, nuovaAltezza, arrivo);
        }

        /**
         * L'immagine con la trasparenza stesa su fondo bianco, tutta opaca. Un pixel con alpha `a` diventa `(c·a + 255·(255-a)) / 255`
         * per canale (arrotondato): alpha 255 lascia il colore, alpha 0 dà bianco. Senza questo un PNG con sfondo trasparente, in
         * JPEG, esce nero.
         */
        public Raster appiattitaSuBianco() {
            int[] opaca = new int[argb.length];
            for (int i = 0; i < argb.length; i++) {
                int pixel = argb[i];
                int alfa = pixel >>> 24;
                if (alfa == 255) {
                    opaca[i] = pixel;
                    continue;
                }
                int rosso = (((pixel >> 16) & 0xFF) * alfa + 255 * (255 - alfa) + 127) / 255;
                int verde = (((pixel >> 8) & 0xFF) * alfa + 255 * (255 - alfa) + 127) / 255;
                int blu = ((pixel & 0xFF) * alfa + 255 * (255 - alfa) + 127) / 255;
                opaca[i] = 0xFF000000 | (rosso << 16) | (verde << 8) | blu;
            }
            return new Raster(larghezza, altezza, opaca);
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL CODEC: l'unico punto in cui si tocca Android
     * ──────────────────────────────────────────────────────────────────────────── */

    /** Ciò che un decodificatore restituisce: i pixel e se l'orientamento EXIF è GIÀ stato applicato. */
    public static final class Decodificata {
        public final Raster raster;
        /** Vero: il decodificatore ha già raddrizzato l'immagine (`ImageDecoder`). Falso: i pixel sono come memorizzati (`BitmapFactory`). */
        public final boolean orientamentoApplicato;

        public Decodificata(Raster raster, boolean orientamentoApplicato) {
            this.raster = raster;
            this.orientamentoApplicato = orientamentoApplicato;
        }
    }

    /** Perché una foto non entra. `FORMATO_NON_SUPPORTATO` e `ILLEGGIBILE` sono i due motivi di rifiuto del contratto che riguardano le foto. */
    public enum Rifiuto {
        FORMATO_NON_SUPPORTATO,
        ILLEGGIBILE
    }

    /**
     * La foto non si può ridurre. `daSegnalare` è la classe dell'errore quando il motivo è NOSTRO (un guasto di disco, la memoria
     * finita, un'eccezione inattesa: chi chiama scrive `media-nativo-preparazione-fallita`) e `null` quando è un rifiuto atteso (un
     * file corrotto, un formato che il telefono non legge): quello non si logga. Il messaggio è il nome dell'enumerato, mai un percorso.
     */
    public static final class FotoRifiutata extends Exception {
        public final Rifiuto rifiuto;
        public final ClasseErrore daSegnalare;

        public FotoRifiutata(Rifiuto rifiuto, ClasseErrore daSegnalare) {
            super(rifiuto.name());
            this.rifiuto = rifiuto;
            this.daSegnalare = daSegnalare;
        }
    }

    /** Le tre operazioni che toccano Android: leggere un file in pixel, e scrivere pixel in JPEG. */
    public interface Codec {
        /**
         * Decodifica `originale` con il lato lungo ridotto a `latoMassimo` (mai ingrandito). `formato` è quello riconosciuto dai primi
         * byte: serve a distinguere un file corrotto (formato noto) da uno che nessun decodificatore conosce (`SCONOSCIUTO`).
         *
         * @throws FotoRifiutata  il decodificatore non sa leggere quel file
         * @throws IOException    un guasto di lettura o di decodifica non classificabile (si traduce in `ILLEGGIBILE`, da segnalare)
         */
        Decodificata decodifica(File originale, int latoMassimo, Formato formato) throws IOException, FotoRifiutata;

        /** Scrive `raster` (tutto opaco) come JPEG di qualità `qualita` (1-100) in `uscita`, senza EXIF. */
        void scriviJpeg(Raster raster, int qualita, OutputStream uscita) throws IOException;
    }

    /** Il risultato di una riduzione: le dimensioni e il peso del JPEG scritto. */
    public static final class Riduzione {
        public final int larghezza;
        public final int altezza;
        public final long byteTotali;

        Riduzione(int larghezza, int altezza, long byteTotali) {
            this.larghezza = larghezza;
            this.altezza = altezza;
            this.byteTotali = byteTotali;
        }
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * LA PIPELINE
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * Riduce `originale` in un JPEG `destinazione` di lato lungo ≤ `latoMassimo`, dritto, senza metadati.
     *
     *  1. legge i primi byte e riconosce il formato; un formato che il livello di API non sa aprire (HEIC sotto API 28) è rifiutato
     *     SENZA chiamare il codec;
     *  2. decodifica col codec;
     *  3. se il decodificatore NON ha già raddrizzato e il file è un JPEG, ruota secondo l'EXIF (l'unico formato che lo porta nel file);
     *  4. stende la trasparenza sul bianco;
     *  5. scrive il JPEG.
     * Se qualcosa va storto `destinazione` non resta sul disco.
     *
     * @throws FotoRifiutata sempre, per ogni guasto: i motivi sono `Rifiuto`, la classe da segnalare è nel campo `daSegnalare`
     */
    public static Riduzione riduci(File originale, File destinazione, int latoMassimo, int qualita, int sdk, Codec codec)
            throws FotoRifiutata {
        boolean riuscito = false;
        try {
            byte[] testa = leggiTesta(originale, BYTE_DI_TESTA);
            Formato formato = riconosciFormato(testa, testa.length);
            if (!formatoAmmesso(formato, sdk)) throw new FotoRifiutata(Rifiuto.FORMATO_NON_SUPPORTATO, null);

            Decodificata decodificata = codec.decodifica(originale, latoMassimo, formato);
            Raster raster = decodificata.raster;
            if (raster.larghezza > latoMassimo || raster.altezza > latoMassimo) {
                // Un decodificatore che non rispetta il lato massimo è un difetto nostro: la foto non esce, e si dice perché.
                throw new FotoRifiutata(Rifiuto.ILLEGGIBILE, ClasseErrore.STATO_ILLEGALE);
            }
            if (!decodificata.orientamentoApplicato && formato == Formato.JPEG) {
                raster = raster.conOrientamento(orientamentoExif(testa, testa.length));
            }
            raster = raster.appiattitaSuBianco();

            try (OutputStream uscita = new FileOutputStream(destinazione)) {
                codec.scriviJpeg(raster, qualita, uscita);
            }
            long scritti = destinazione.length();
            if (scritti <= 0L) throw new IOException("JPEG vuoto");
            riuscito = true;
            return new Riduzione(raster.larghezza, raster.altezza, scritti);
        } catch (FotoRifiutata rifiuto) {
            throw rifiuto;
        } catch (IOException guasto) {
            throw new FotoRifiutata(Rifiuto.ILLEGGIBILE, ClasseErrore.di(guasto));
        } catch (OutOfMemoryError esaurita) {
            throw new FotoRifiutata(Rifiuto.ILLEGGIBILE, ClasseErrore.MEMORIA_ESAURITA);
        } catch (RuntimeException guasto) {
            throw new FotoRifiutata(Rifiuto.ILLEGGIBILE, ClasseErrore.di(guasto));
        } finally {
            if (!riuscito && destinazione.exists()) {
                // Una scrittura a metà non deve restare in `scelti/`: nessuno la nominerebbe più.
                destinazione.delete();
            }
        }
    }

    /** I primi `massimo` byte di un file (meno, se il file è più corto). */
    public static byte[] leggiTesta(File file, int massimo) throws IOException {
        byte[] buffer = new byte[massimo];
        int letti = 0;
        try (InputStream ingresso = new FileInputStream(file)) {
            while (letti < massimo) {
                int n = ingresso.read(buffer, letti, massimo - letti);
                if (n < 0) break;
                letti += n;
            }
        }
        if (letti == massimo) return buffer;
        byte[] corto = new byte[letti];
        System.arraycopy(buffer, 0, corto, 0, letti);
        return corto;
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL BASE64
     * ──────────────────────────────────────────────────────────────────────────── */

    private static final char[] ALFABETO_BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

    /**
     * Base64 standard, CON il suo padding e SENZA a capo (la forma `NO_WRAP` che il JavaScript rilegge: `schemaFotoLetta` confronta i byte
     * dichiarati con quelli che la stringa rappresenta). Fatto a mano e non con `android.util.Base64` (non esiste sulla JVM dei test)
     * né con `java.util.Base64` (da API 26, e il progetto parte da 24): è un algoritmo di venti righe, e un test lo confronta con
     * quello del JDK su ogni lunghezza.
     */
    public static String base64(byte[] dati) {
        StringBuilder testo = new StringBuilder(((dati.length + 2) / 3) * 4);
        int i = 0;
        for (; i + 3 <= dati.length; i += 3) {
            int blocco = ((dati[i] & 0xFF) << 16) | ((dati[i + 1] & 0xFF) << 8) | (dati[i + 2] & 0xFF);
            testo.append(ALFABETO_BASE64[(blocco >> 18) & 63]).append(ALFABETO_BASE64[(blocco >> 12) & 63])
                    .append(ALFABETO_BASE64[(blocco >> 6) & 63]).append(ALFABETO_BASE64[blocco & 63]);
        }
        int resto = dati.length - i;
        if (resto == 1) {
            int blocco = (dati[i] & 0xFF) << 16;
            testo.append(ALFABETO_BASE64[(blocco >> 18) & 63]).append(ALFABETO_BASE64[(blocco >> 12) & 63]).append("==");
        } else if (resto == 2) {
            int blocco = ((dati[i] & 0xFF) << 16) | ((dati[i + 1] & 0xFF) << 8);
            testo.append(ALFABETO_BASE64[(blocco >> 18) & 63]).append(ALFABETO_BASE64[(blocco >> 12) & 63])
                    .append(ALFABETO_BASE64[(blocco >> 6) & 63]).append('=');
        }
        return testo.toString();
    }

    /* ────────────────────────────────────────────────────────────────────────────
     * IL CODEC DI ANDROID (non si prova sulla JVM: lo coprono assembleDebug e il collaudo sull'emulatore)
     * ──────────────────────────────────────────────────────────────────────────── */

    /**
     * I decodificatori di Android. Il ramo si sceglie con {@link #usaImageDecoder}: da API 28 `ImageDecoder` (HEIF compreso, orientamento
     * EXIF già applicato), sotto `BitmapFactory` (orientamento ignorato: lo applica la pipeline). La scrittura è sempre `Bitmap.compress`,
     * che non scrive EXIF.
     */
    public static final class CodecAndroid implements Codec {
        private final int sdk;

        public CodecAndroid(int sdk) {
            this.sdk = sdk;
        }

        /** Il ramo del livello di API: `ImageDecoder` da 28. */
        public static boolean usaImageDecoder(int sdk) {
            return sdk >= SDK_PRIMO_IMAGEDECODER;
        }

        @Override
        public Decodificata decodifica(File originale, int latoMassimo, Formato formato) throws IOException, FotoRifiutata {
            if (usaImageDecoder(sdk)) return ConImageDecoder.decodifica(originale, latoMassimo, formato);
            return ConBitmapFactory.decodifica(originale, latoMassimo, formato);
        }

        @Override
        public void scriviJpeg(Raster raster, int qualita, OutputStream uscita) throws IOException {
            Bitmap bitmap = Bitmap.createBitmap(raster.argb, raster.larghezza, raster.altezza, Bitmap.Config.ARGB_8888);
            try {
                if (!bitmap.compress(Bitmap.CompressFormat.JPEG, qualita, uscita)) throw new IOException("compressione JPEG non riuscita");
            } finally {
                bitmap.recycle();
            }
        }
    }

    /** `Bitmap` (non hardware) → pixel ARGB non premoltiplicati nello spazio sRGB, come li dà `getPixels`. */
    static Raster rasterDa(Bitmap bitmap) {
        int larghezza = bitmap.getWidth();
        int altezza = bitmap.getHeight();
        int[] argb = new int[larghezza * altezza];
        bitmap.getPixels(argb, 0, larghezza, 0, 0, larghezza, altezza);
        return new Raster(larghezza, altezza, argb);
    }

    /** Un file che nessun decodificatore ha aperto: corrotto se la firma è di un formato noto, «non supportato» se non la conosciamo. */
    static FotoRifiutata rifiutoDiFormato(Formato formato) {
        return new FotoRifiutata(formato == Formato.SCONOSCIUTO ? Rifiuto.FORMATO_NON_SUPPORTATO : Rifiuto.ILLEGGIBILE, null);
    }

    /** API 28 e oltre. Una classe a parte, caricata solo da qui: un telefono più vecchio non la tocca mai. */
    @RequiresApi(Build.VERSION_CODES.P)
    private static final class ConImageDecoder {
        static Decodificata decodifica(File originale, final int latoMassimo, Formato formato) throws IOException, FotoRifiutata {
            Bitmap bitmap;
            try {
                bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(originale), (decoder, informazioni, sorgente) -> {
                    // `getSize()` è già la dimensione orientata: `ImageDecoder` applica l'EXIF da sé (e lo stesso fa col `irot` di HEIF).
                    Size dimensioni = informazioni.getSize();
                    int[] obiettivo = dimensioniObiettivo(dimensioni.getWidth(), dimensioni.getHeight(), latoMassimo);
                    decoder.setTargetSize(obiettivo[0], obiettivo[1]);
                    // Software: un `Bitmap` hardware non si può leggere con `getPixels`.
                    decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE);
                });
            } catch (ImageDecoder.DecodeException guasto) {
                if (formato == Formato.SCONOSCIUTO) throw new FotoRifiutata(Rifiuto.FORMATO_NON_SUPPORTATO, null);
                // Il sorgente non si è lasciato leggere (disco): è un guasto nostro. Dati incompleti o corrotti: rifiuto atteso.
                throw new FotoRifiutata(Rifiuto.ILLEGGIBILE,
                        guasto.getError() == ImageDecoder.DecodeException.SOURCE_EXCEPTION ? ClasseErrore.IO : null);
            } catch (IOException altro) {
                if (formato == Formato.SCONOSCIUTO) throw new FotoRifiutata(Rifiuto.FORMATO_NON_SUPPORTATO, null);
                throw altro;
            }
            try {
                return new Decodificata(rasterDa(bitmap), true);
            } finally {
                bitmap.recycle();
            }
        }
    }

    /** Sotto API 28: `BitmapFactory`, che ignora l'orientamento EXIF. */
    private static final class ConBitmapFactory {
        static Decodificata decodifica(File originale, int latoMassimo, Formato formato) throws FotoRifiutata {
            String percorso = originale.getPath();
            BitmapFactory.Options limiti = new BitmapFactory.Options();
            limiti.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(percorso, limiti);
            if (limiti.outWidth <= 0 || limiti.outHeight <= 0) throw rifiutoDiFormato(formato);

            BitmapFactory.Options opzioni = new BitmapFactory.Options();
            opzioni.inSampleSize = campionamento(limiti.outWidth, limiti.outHeight, latoMassimo);
            opzioni.inPreferredConfig = Bitmap.Config.ARGB_8888;
            Bitmap bitmap = BitmapFactory.decodeFile(percorso, opzioni);
            if (bitmap == null) throw rifiutoDiFormato(formato);
            try {
                int[] obiettivo = dimensioniObiettivo(bitmap.getWidth(), bitmap.getHeight(), latoMassimo);
                Bitmap finale = bitmap;
                if (obiettivo[0] != bitmap.getWidth() || obiettivo[1] != bitmap.getHeight()) {
                    finale = Bitmap.createScaledBitmap(bitmap, obiettivo[0], obiettivo[1], true);
                }
                try {
                    return new Decodificata(rasterDa(finale), false);
                } finally {
                    if (finale != bitmap) finale.recycle();
                }
            } finally {
                bitmap.recycle();
            }
        }
    }
}
