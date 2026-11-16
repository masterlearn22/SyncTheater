# SyncTheater (`nobar-sync`) — Aplikasi Nobar Real-Time Anti-Lag

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
