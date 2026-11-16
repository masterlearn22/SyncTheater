import React, { useEffect, useState } from 'react';
import { Film, FolderOpen, Globe, MonitorUp, RefreshCw } from 'lucide-react';
import { MediaMode } from '../types/protocol';

interface ServerMovie {
  name: string;
  size: number;
  streamUrl: string;
}

interface MediaSelectorProps {
  activeMode: MediaMode;
  onSelectLocalStream: (url: string, label: string) => void;
  onSelectExternalUrl: (url: string) => void;
  onStartScreenShare: () => void;
}

export const MediaSelector: React.FC<MediaSelectorProps> = ({
  activeMode,
  onSelectLocalStream,
  onSelectExternalUrl,
  onStartScreenShare,
}) => {
  const [serverMovies, setServerMovies] = useState<ServerMovie[]>([]);
  const [customUrl, setCustomUrl] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchServerMovies = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/movies');
      if (res.ok) {
        const data = await res.json();
        setServerMovies(data.movies || []);
      }
    } catch {
      // Abaikan jika dijalankan dalam mode standalone preview
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchServerMovies();
  }, []);

  const formatSize = (bytes: number) => {
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  return (
    <div className="rounded-xl border border-zinc-800 bg-[#18181B]/80 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Film className="w-4 h-4 text-indigo-400" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
            Sumber Media Pemutaran
          </h3>
        </div>
        <button
          type="button"
          onClick={fetchServerMovies}
          className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          <span>Muat Ulang Folder</span>
        </button>
      </div>

      {serverMovies.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-zinc-400">
            Daftar Film di Folder Server (HTTP 206 Range Stream):
          </p>
          <div className="grid grid-cols-1 gap-1.5 max-h-32 overflow-y-auto pr-1">
            {serverMovies.map((m) => (
              <button
                key={m.name}
                type="button"
                onClick={() => onSelectLocalStream(m.streamUrl, m.name)}
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-zinc-900/90 hover:bg-indigo-600/20 border border-zinc-800 hover:border-indigo-500/40 text-left text-xs transition"
              >
                <span className="truncate font-medium text-zinc-200">{m.name}</span>
                <span className="text-[11px] text-zinc-400 ml-2 shrink-0">
                  {formatSize(m.size)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
        <label className="cursor-pointer flex items-center justify-center gap-2 px-3 py-2 rounded-lg border border-zinc-700/80 bg-zinc-900 hover:bg-zinc-800 text-xs font-medium text-zinc-200 transition">
          <FolderOpen className="w-4 h-4 text-indigo-400" />
          <span>Buka File .MP4/.WebM Lokal</span>
          <input
            type="file"
            accept="video/mp4,video/webm,video/x-matroska"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) {
                const blobUrl = URL.createObjectURL(file);
                onSelectLocalStream(blobUrl, file.name);
              }
            }}
          />
        </label>

        <button
          type="button"
          onClick={onStartScreenShare}
          className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition ${
            activeMode === 'WEBRTC_SCREEN'
              ? 'border-indigo-500 bg-indigo-600/20 text-indigo-300'
              : 'border-zinc-700/80 bg-zinc-900 hover:bg-zinc-800 text-zinc-200'
          }`}
        >
          <MonitorUp className="w-4 h-4 text-emerald-400" />
          <span>Raw Tab / Screen Share (Opus 192k)</span>
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (customUrl.trim()) {
            onSelectExternalUrl(customUrl.trim());
          }
        }}
        className="flex gap-2"
      >
        <div className="relative flex-1">
          <Globe className="w-3.5 h-3.5 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="url"
            value={customUrl}
            onChange={(e) => setCustomUrl(e.target.value)}
            placeholder="Tempel URL stream langsung (.mp4 / .webm)..."
            className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <button
          type="submit"
          className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white transition"
        >
          Putar URL
        </button>
      </form>
    </div>
  );
};
