package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed all:dist
var embeddedFiles embed.FS

type Config struct {
	Port     int
	MediaDir string
}

type MovieItem struct {
	Name       string `json:"name"`
	Size       int64  `json:"size"`
	ModifiedAt int64  `json:"modifiedAt"`
	StreamURL  string `json:"streamUrl"`
}

func main() {
	port := flag.Int("port", 8080, "Port HTTP server untuk aplikasi SyncTheater")
	mediaDir := flag.String("media-dir", "./movies", "Direktori lokal penyimpanan file film (.mp4, .webm, .mkv)")
	flag.Parse()

	absMediaDir, err := filepath.Abs(*mediaDir)
	if err != nil {
		log.Fatalf("Gagal membaca path media-dir: %v", err)
	}

	if err := os.MkdirAll(absMediaDir, 0755); err != nil {
		log.Fatalf("Gagal membuat direktori media %s: %v", absMediaDir, err)
	}

	hub := NewRoomHub()
	go hub.Run()

	streamer := NewVideoStreamer(absMediaDir)
	mux := http.NewServeMux()

	// 1. Endpoint HTTP Range Video Streamer (/stream?file=nama.mp4)
	mux.HandleFunc("/stream", streamer.ServeVideo)

	// 2. Endpoint Daftar File Film di --media-dir (/api/movies)
	mux.HandleFunc("/api/movies", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")

		entries, err := os.ReadDir(absMediaDir)
		if err != nil {
			http.Error(w, `{"error":"Gagal membaca direktori media"}`, http.StatusInternalServerError)
			return
		}

		var movies []MovieItem
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			ext := strings.ToLower(filepath.Ext(entry.Name()))
			if ext == ".mp4" || ext == ".webm" || ext == ".mkv" {
				info, err := entry.Info()
				if err != nil {
					continue
				}
				movies = append(movies, MovieItem{
					Name:       entry.Name(),
					Size:       info.Size(),
					ModifiedAt: info.ModTime().UnixMilli(),
					StreamURL:  "/stream?file=" + entry.Name(),
				})
			}
		}
		if movies == nil {
			movies = []MovieItem{}
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"mediaDir": absMediaDir,
			"movies":   movies,
		})
	})

	// 3. Endpoint WebSocket Hub & WebRTC Signaling (/ws?room=default&role=HOST)
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		ServeWs(hub, w, r)
	})

	// 4. Embedded Static UI (React Build di dalam folder dist/)
	distFS, err := fs.Sub(embeddedFiles, "dist")
	if err != nil {
		log.Fatalf("Gagal memuat embedded dist filesystem: %v", err)
	}
	fileServer := http.FileServer(http.FS(distFS))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = "index.html"
		}
		if _, err := fs.Stat(distFS, path); os.IsNotExist(err) {
			r.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, r)
	})

	addr := fmt.Sprintf(":%d", *port)
	server := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("=============================================================")
	log.Printf(" SyncTheater (Nobar Real-Time Anti-Lag) Aktif!")
	log.Printf(" Lokal URL   : http://localhost:%d", *port)
	log.Printf(" Folder Film : %s", absMediaDir)
	log.Printf(" Gunakan 'cloudflared tunnel --url http://localhost:%d' untuk HTTPS Guest", *port)
	log.Printf("=============================================================")

	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("Server berhenti: %v", err)
	}
}
