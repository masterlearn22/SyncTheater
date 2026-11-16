<!--  --># SyncTheater (`nobar-sync`) — Aplikasi Nobar Real-Time Anti-Lag

Implementasi lengkap arsitektur **Laptop-as-Host Single-Binary Server** untuk menonton film bersama secara *real-time* dalam kualitas asli (`1080p`/`4K`) tanpa layar hitam DRM, tanpa *re-encoding lag*, dan dilengkapi suara obrolan jernih berfitur *Auto-Ducking*.

## Struktur Monorepo

```text
nobar-sync/
├── backend/
│   ├── main.go                 # Entry point, routing HTTP, & embed build frontend
│   ├── hub.go                  # Manajemen room, koneksi WebSocket, & broadcast state
│   ├── streamer.go             # HTTP Range video streamer & proteksi direktori
│   ├── signaling.go            # Relay pesan SDP Offer/Answer & ICE Candidate
│   └── go.mod
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── VideoStage.tsx       # Pemutar HTML5, auto-hide HUD, & shortcut keyboard
│   │   │   ├── VoiceDock.tsx        # Kontrol mic, indikator suara, & pengaturan ducking
│   │   │   ├── MediaSelector.tsx    # Pemilih sumber (File Lokal, URL/HLS, Screen Share)
│   │   │   └── SubtitleDrop.tsx     # Konverter drag-and-drop subtitle .srt ke .vtt
│   │   ├── core/
│   │   │   ├── SyncEngine.ts        # Kalibrasi jam NTP-lite & koreksi playbackRate 3 zona
│   │   │   ├── WebRTCManager.ts     # Koneksi P2P, SDP munging stereo 192k, & media tracks
│   │   │   └── AudioAutoDucker.ts   # Deteksi suara bicara & penurunan volume film halus
│   │   ├── types/
│   │   │   └── protocol.ts          # Definisi tipe payload WebSocket & WebRTC
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── package.json
│   └── tailwind.config.js
└── scripts/
    ├── prep-movie.sh           # Skrip FFmpeg remux cepat untuk Linux/macOS
    └── prep-movie.bat          # Skrip FFmpeg remux cepat untuk Windows
```

## Fitur Unggulan WebRTC High-Bitrate & Anti-Burik (4 - 5 Mbps)

Untuk mode **Screen Share** dan **Live Stream P2P**, sistem kini telah dioptimalkan secara mendalam:
1. **Bitrate Video WebRTC Dikunci ke 4-5 Mbps (4000 - 5000 kbps)**: Mengatasi bitrate bawaan browser yang biasanya hanya 1 - 1.5 Mbps.
2. **SDP Munging Bandwidth (b=AS:5000 & b=TIAS:5000000)**: Memaksa encoder browser (Chrome/Edge/Firefox) mengalokasikan bitrate tinggi sejak detik pertama (`x-google-start-bitrate=4500`).
3. **Anti-Burik (maintain-resolution & contentHint='detail')**: Mencegah browser menurunkan resolusi video ke 360p/480p saat mendeteksi gerakan atau fluktuasi jaringan.
4. **Jitter Buffer Anti-Stutter (180ms playoutDelayHint)**: Mencegah video tersendat atau *freeze* akibat jitter paket data di jaringan Wi-Fi/Internet rumah.
5. **Selector Kualitas & Bitrate Interaktif**: Terdapat tombol pengatur bitrate langsung di layar nobar (2.5 Mbps, 4.0 Mbps, 5.0 Mbps, hingga 8.0 Mbps) serta pilihan mode *Resolusi Tajam* vs *Gerakan 60 FPS*.

---

## 2 Cara Nobar di SyncTheater (Pilih yang Paling Cocok):

| Mode | Cara Kerja | Kualitas Video | Beban Jaringan & Lag |
| :--- | :--- | :--- | :--- |
| **Mode 1: Direct File / HTTP 206 (Sangat Direkomendasikan)** | Host & Pasangan sama-sama memilih file film `.mp4` lokal (atau stream via `nobar.exe` + Cloudflare). Mesin `SyncEngine` menyamakan detik film secara otomatis. | **100% Kualitas Asli Film (1080p/4K bitrate 10-20 Mbps)** | **0% Lag / 0% Burik** (tidak ada re-encode, kuota sangat hemat karena video di-buffer secara lokal). |
| **Mode 2: WebRTC Screen Share (Stream Film Ini)** | Host menangkap tab/layar dan mentransmisikannya lewat WebRTC P2P ke browser pasangan. | **Full HD Tajam (Bitrate 4 - 5 Mbps)** | Butuh koneksi internet stabil (upload Host minimal 6-10 Mbps). Cocok jika pasangan tidak memiliki file film di HP/laptopnya. |

---

## Cara Build Menjadi Single Binary (`nobar.exe` / `nobar`)

1. **Build Frontend React ke `backend/dist`:**
   ```bash
   cd frontend
   npm install
   npm run build
   ```

2. **Kompilasi Single-Binary Go:**
   ```bash
   cd ../backend
   go mod tidy
   go build -o ../nobar.exe .
   ```

## Cara Menjalankan untuk Nobar Bersama Pasangan

1. **(Opsional) Remux Film `.mkv` ke `.mp4` (AAC Stereo 192kbps) dalam ±5 Detik:**
   ```bash
   ./scripts/prep-movie.bat "D:\Movies\film_asli.mkv" "D:\Movies\film_siap_nobar.mp4"
   ```

2. **Terminal 1 — Jalankan Server SyncTheater:**
   ```bash
   ./nobar.exe --port 8080 --media-dir "D:\Movies"
   ```

3. **Terminal 2 — Buka Akses HTTPS Gratis via Cloudflare Tunnel:**
   ```bash
   cloudflared tunnel --url http://localhost:8080
   ```
   Salin tautan `https://*.trycloudflare.com` yang muncul di Terminal 2 dan kirimkan ke pasangan.
