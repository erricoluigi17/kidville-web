package it.kidville.app.caricamenti;

import it.kidville.app.caricamenti.ElaborazioneFoto.Codec;
import it.kidville.app.caricamenti.ElaborazioneFoto.FotoRifiutata;
import it.kidville.app.caricamenti.RegistroNativo.ClasseErrore;
import it.kidville.app.caricamenti.RegistroNativo.MotivoPreparazione;
import it.kidville.app.caricamenti.RegistroNativo.TipoMedia;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;

/**
 * I finti con cui si prova il selettore dei media sulla JVM: un elemento scelto con byte veri, il «mondo» del telefono (spazio, orologio,
 * analisi dei video, riduzione delle foto) e chi ascolta l'avanzamento. Tutto ciò che sta SOTTO queste interfacce — la copia, l'impronta,
 * i file in `scelti/`, il registro — è codice vero che gira su una cartella temporanea vera.
 */
final class FintiDelSelettore {

    private FintiDelSelettore() {
    }

    /** Un elemento scelto: nome, tipo, peso dichiarato, durata e flusso decisi dal test. */
    static final class SorgenteDiProva implements SelettoreMedia.ElementoSorgente {
        String nome;
        String mime;
        byte[] contenuto;
        /** `-2` = quanto è lungo il contenuto; `-1` = «il fornitore non lo dice»; altro = quel valore, anche falso. */
        long dichiarati = -2L;
        long durataMs = -1L;
        Supplier<InputStream> flusso;
        IOException daLanciareAllApertura;
        RuntimeException daLanciareRuntimeAllApertura;
        int aperture;

        SorgenteDiProva(String nome, String mime, byte[] contenuto) {
            this.nome = nome;
            this.mime = mime;
            this.contenuto = contenuto;
        }

        SorgenteDiProva dichiara(long byteDichiarati) {
            this.dichiarati = byteDichiarati;
            return this;
        }

        SorgenteDiProva conDurata(long ms) {
            this.durataMs = ms;
            return this;
        }

        SorgenteDiProva conFlusso(Supplier<InputStream> nuovoFlusso) {
            this.flusso = nuovoFlusso;
            return this;
        }

        @Override
        public String nome() {
            return nome;
        }

        @Override
        public long byteDichiarati() {
            return dichiarati == -2L ? (contenuto == null ? -1L : contenuto.length) : dichiarati;
        }

        @Override
        public String mimeDichiarato() {
            return mime;
        }

        @Override
        public long durataMs() {
            return durataMs;
        }

        @Override
        public InputStream apri() throws IOException {
            aperture++;
            if (daLanciareAllApertura != null) throw daLanciareAllApertura;
            if (daLanciareRuntimeAllApertura != null) throw daLanciareRuntimeAllApertura;
            if (flusso != null) return flusso.get();
            return new ByteArrayInputStream(contenuto);
        }
    }

    /** Il «mondo» del telefono: spazio libero, orologio, analisi dei video, riduzione delle foto, segnalazione dei guasti. */
    static final class StrumentiDiProva implements SelettoreMedia.Strumenti {
        volatile long spazio = Long.MAX_VALUE / 4;
        final AtomicLong orologio = new AtomicLong(1_000L);
        MiniaturaVideo.Analisi analisi = new MiniaturaVideo.Analisi(-1L, null);
        RuntimeException analisiLancia;
        Codec codec = CodecDiProva.comeImageDecoder(null);
        int sdk = 33;
        FotoRifiutata riduciLancia;
        RuntimeException riduciLanciaRuntime;
        final List<String> segnalazioni = Collections.synchronizedList(new ArrayList<String>());
        final List<File> originaliVisti = Collections.synchronizedList(new ArrayList<File>());

        @Override
        public long spazioDisponibile(File cartella) {
            return spazio;
        }

        @Override
        public long adesso() {
            return orologio.get();
        }

        @Override
        public MiniaturaVideo.Analisi analizzaVideo(File copia) {
            if (analisiLancia != null) throw analisiLancia;
            return analisi;
        }

        @Override
        public ElaborazioneFoto.Riduzione riduciFoto(File originale, File destinazione, int latoMassimo, int qualita) throws FotoRifiutata {
            originaliVisti.add(originale);
            if (riduciLancia != null) throw riduciLancia;
            if (riduciLanciaRuntime != null) throw riduciLanciaRuntime;
            return ElaborazioneFoto.riduci(originale, destinazione, latoMassimo, qualita, sdk, codec);
        }

        @Override
        public void segnalaFallimento(TipoMedia tipo, MotivoPreparazione motivo, ClasseErrore classe) {
            segnalazioni.add(tipo.valore() + "/" + motivo.name() + "/" + classe.name());
        }
    }

    /** Raccoglie gli eventi `preparazione`. Può eseguire un gesto del test a ogni evento. */
    static final class RaccoltaEventi implements SelettoreMedia.Ascoltatore {
        final List<JSONObject> eventi = Collections.synchronizedList(new ArrayList<JSONObject>());
        java.util.function.Consumer<JSONObject> aOgniEvento;
        RuntimeException daLanciare;

        @Override
        public void preparazione(JSONObject evento) {
            eventi.add(evento);
            if (aOgniEvento != null) aOgniEvento.accept(evento);
            if (daLanciare != null) throw daLanciare;
        }
    }

    /** Un flusso che produce `totale` byte senza tenerli in memoria, a pezzi da `pezzo`, con un gesto a ogni lettura. */
    static final class FlussoGenerato extends InputStream {
        private final long totale;
        private final int pezzo;
        private long dati;
        int letture;
        Runnable aOgniLettura;
        IOException guastoDopo;
        long guastoDopoByte = -1L;

        FlussoGenerato(long totale, int pezzo) {
            this.totale = totale;
            this.pezzo = pezzo;
        }

        @Override
        public int read() throws IOException {
            byte[] uno = new byte[1];
            int n = read(uno, 0, 1);
            return n < 0 ? -1 : (uno[0] & 0xFF);
        }

        @Override
        public int read(byte[] buffer, int scarto, int lunghezza) throws IOException {
            letture++;
            if (aOgniLettura != null) aOgniLettura.run();
            if (guastoDopo != null && dati >= guastoDopoByte) throw guastoDopo;
            if (dati >= totale) return -1;
            int n = (int) Math.min(Math.min(lunghezza, pezzo), totale - dati);
            for (int i = 0; i < n; i++) buffer[scarto + i] = (byte) ((dati + i) * 31);
            dati += n;
            return n;
        }
    }

    /** L'impronta SHA-256 dei byte, esadecimale minuscola: l'oracolo dei test (calcolato qui, non dal codice sotto prova). */
    static String sha256(byte[] dati) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        StringBuilder testo = new StringBuilder();
        for (byte b : md.digest(dati)) testo.append(String.format("%02x", b));
        return testo.toString();
    }

    static byte[] casuali(int lunghezza, long seme) {
        byte[] dati = new byte[lunghezza];
        new java.util.Random(seme).nextBytes(dati);
        return dati;
    }
}
