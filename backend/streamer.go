package main

import (
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

type VideoStreamer struct {
	BaseDir string
}

func NewVideoStreamer(baseDir string) *VideoStreamer {
	return &VideoStreamer{BaseDir: baseDir}
}

func (vs *VideoStreamer) ServeVideo(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	rawFile := r.URL.Query().Get("file")
	if rawFile == "" {
		http.Error(w, "Parameter 'file' wajib diisi", http.StatusBadRequest)
		return
	}

	// Sanitasi nama file menggunakan filepath.Clean untuk mencegah directory traversal
	cleanRel := filepath.Clean(rawFile)
	if strings.Contains(cleanRel, "..") || filepath.IsAbs(cleanRel) {
		http.Error(w, "Akses ditolak: Path tidak valid", http.StatusForbidden)
		return
	}

	targetPath := filepath.Join(vs.BaseDir, cleanRel)
	relCheck, err := filepath.Rel(vs.BaseDir, targetPath)
	if err != nil || strings.HasPrefix(relCheck, "..") {
		http.Error(w, "Akses di luar folder media ditolak", http.StatusForbidden)
		return
	}

	ext := strings.ToLower(filepath.Ext(targetPath))
	if ext != ".mp4" && ext != ".webm" && ext != ".mkv" {
		http.Error(w, "Ekstensi file tidak didukung (hanya .mp4, .webm, .mkv)", http.StatusUnsupportedMediaType)
		return
	}

	file, err := os.Open(targetPath)
	if err != nil {
		if os.IsNotExist(err) {
			http.Error(w, "File film tidak ditemukan", http.StatusNotFound)
			return
		}
		log.Printf("[Streamer] Gagal membuka file %s: %v", targetPath, err)
		http.Error(w, "Gagal membuka file media", http.StatusInternalServerError)
		return
	}
	defer file.Close()

	stat, err := file.Stat()
	if err != nil || stat.IsDir() {
		http.Error(w, "File tidak valid", http.StatusBadRequest)
		return
	}

	// Set MIME type eksplisit agar elemen <video> HTML5 memproses stream dengan benar
	contentType := mime.TypeByExtension(ext)
	if contentType == "" {
		switch ext {
		case ".mp4":
			contentType = "video/mp4"
		case ".webm":
			contentType = "video/webm"
		case ".mkv":
			contentType = "video/x-matroska"
		}
	}

	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Access-Control-Allow-Origin", "*")

	// Zero-RAM Buffering: http.ServeContent menangani header Range: bytes=start-end (HTTP 206 Partial Content)
	http.ServeContent(w, r, stat.Name(), stat.ModTime(), file)
}
