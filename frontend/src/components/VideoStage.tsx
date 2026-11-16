import React, { useEffect, useRef, useState } from 'react';
import {
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { SyncTelemetry } from '../types/protocol';

interface VideoStageProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  streamUrl: string;
  subtitleUrl: string | null;
  telemetry: SyncTelemetry;
  isMicMuted: boolean;
  onUserPlay: () => void;
  onUserPause: () => void;
  onUserSeek: (newTime: number) => void;
  onVolumeChange: (newVol: number) => void;
  onToggleMicShortcut: () => void;
}

export const VideoStage: React.FC<VideoStageProps> = ({
  videoRef,
  streamUrl,
  subtitleUrl,
  telemetry,
  onUserPlay,
  onUserPause,
  onUserSeek,
  onVolumeChange,
  onToggleMicShortcut,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const hideTimerRef = useRef<number | null>(null);

  const [hudVisible, setHudVisible] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);

  // Auto-hide HUD setelah kursor diam selama 3 detik
  const resetHudTimer = () => {
    setHudVisible(true);
    if (hideTimerRef.current) {
      window.clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = window.setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) {
        setHudVisible(false);
      }
    }, 3000);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      const vid = videoRef.current;
      if (!vid) return;

      switch (e.code) {
        case 'Space':
          e.preventDefault();
          if (vid.paused) {
            vid.play().catch(() => {});
            onUserPlay();
          } else {
            vid.pause();
            onUserPause();
          }
          resetHudTimer();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          vid.currentTime = Math.max(0, vid.currentTime - 5);
          onUserSeek(vid.currentTime);
          resetHudTimer();
          break;
        case 'ArrowRight':
          e.preventDefault();
          vid.currentTime = Math.min(vid.duration || 0, vid.currentTime + 5);
          onUserSeek(vid.currentTime);
          resetHudTimer();
          break;
        case 'ArrowUp':
          e.preventDefault();
          {
            const nextVol = Math.min(1, +(vid.volume + 0.05).toFixed(2));
            vid.volume = nextVol;
            setVolume(nextVol);
            onVolumeChange(nextVol);
            resetHudTimer();
          }
          break;
        case 'ArrowDown':
          e.preventDefault();
          {
            const nextVol = Math.max(0, +(vid.volume - 0.05).toFixed(2));
            vid.volume = nextVol;
            setVolume(nextVol);
            onVolumeChange(nextVol);
            resetHudTimer();
          }
          break;
        case 'KeyM':
          e.preventDefault();
          onToggleMicShortcut();
          resetHudTimer();
          break;
        case 'KeyF':
          e.preventDefault();
          toggleFullscreen();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  const formatTime = (sec: number) => {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = Math.floor(sec % 60);
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const driftMs = Math.round(telemetry.driftSeconds * 1000);

  return (
    <div
      ref={containerRef}
      onMouseMove={resetHudTimer}
      className="relative w-full aspect-video rounded-2xl overflow-hidden bg-black border border-zinc-800 shadow-2xl group select-none"
    >
      <video
        ref={videoRef}
        src={streamUrl}
        className="w-full h-full object-contain bg-black"
        playsInline
        crossOrigin="anonymous"
        onPlay={() => setIsPlaying(true)}
        onPause={() => {
          setIsPlaying(false);
          setHudVisible(true);
        }}
        onTimeUpdate={() => {
          if (videoRef.current) setCurrentTime(videoRef.current.currentTime);
        }}
        onLoadedMetadata={() => {
          if (videoRef.current) setDuration(videoRef.current.duration || 0);
        }}
      >
        {subtitleUrl && (
          <track
            kind="subtitles"
            src={subtitleUrl}
            srcLang="id"
            label="Subtitle Indonesia"
            default
          />
        )}
      </video>

      {/* Badge Telemetri Sinkronisasi Real-Time */}
      <div
        className={`absolute top-4 left-4 right-4 flex items-center justify-between pointer-events-none transition-opacity duration-300 ${
          hudVisible ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[#18181B]/80 backdrop-blur-md border border-zinc-700/70 text-xs">
          <span
            className={`w-2 h-2 rounded-full ${
              telemetry.zone === 'LOCKED_SYNC'
                ? 'bg-emerald-400'
                : telemetry.zone === 'SOFT_RATE_ADAPT'
                ? 'bg-amber-400'
                : 'bg-rose-400'
            }`}
          />
          <span className="font-medium text-zinc-200">
            {telemetry.zone === 'LOCKED_SYNC'
              ? 'Zona Sinkron (<50ms)'
              : telemetry.zone === 'SOFT_RATE_ADAPT'
              ? `Koreksi Halus (${telemetry.activePlaybackRate.toFixed(2)}x)`
              : 'Hard Seek Sync'}
          </span>
          <span className="text-zinc-400 font-mono">
            Drift: {driftMs >= 0 ? `+${driftMs}` : driftMs}ms | RTT: {telemetry.rttMs}ms
          </span>
        </div>

        <div className="px-3 py-1.5 rounded-full bg-[#18181B]/80 backdrop-blur-md border border-zinc-700/70 text-[11px] font-mono text-zinc-300">
          HTTP 206 Range • {telemetry.activePlaybackRate.toFixed(2)}x
        </div>
      </div>

      {/* Bottom Floating Control Bar (#18181B/80) */}
      <div
        className={`absolute bottom-0 inset-x-0 p-4 bg-gradient-to-t from-black/90 via-black/50 to-transparent transition-opacity duration-300 ${
          hudVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="rounded-xl bg-[#18181B]/80 backdrop-blur-md border border-zinc-800 p-3 space-y-2">
          <input
            type="range"
            min={0}
            max={duration || 100}
            step={0.1}
            value={currentTime}
            onChange={(e) => {
              const t = parseFloat(e.target.value);
              if (videoRef.current) {
                videoRef.current.currentTime = t;
              }
              setCurrentTime(t);
              onUserSeek(t);
            }}
            className="w-full accent-indigo-500 h-1.5 bg-zinc-700 rounded-lg cursor-pointer"
          />

          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const vid = videoRef.current;
                  if (!vid) return;
                  if (vid.paused) {
                    vid.play().catch(() => {});
                    onUserPlay();
                  } else {
                    vid.pause();
                    onUserPause();
                  }
                }}
                className="p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition"
              >
                {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </button>

              <button
                type="button"
                onClick={() => {
                  if (!videoRef.current) return;
                  const t = Math.max(0, videoRef.current.currentTime - 5);
                  videoRef.current.currentTime = t;
                  onUserSeek(t);
                }}
                className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition"
                title="Mundur 5 detik (Panah Kiri)"
              >
                <RotateCcw className="w-4 h-4" />
              </button>

              <button
                type="button"
                onClick={() => {
                  if (!videoRef.current) return;
                  const t = Math.min(
                    videoRef.current.duration || 0,
                    videoRef.current.currentTime + 5
                  );
                  videoRef.current.currentTime = t;
                  onUserSeek(t);
                }}
                className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition"
                title="Maju 5 detik (Panah Kanan)"
              >
                <RotateCw className="w-4 h-4" />
              </button>

              <span className="text-xs font-mono text-zinc-300 ml-1">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!videoRef.current) return;
                    videoRef.current.muted = !isMuted;
                    setIsMuted(!isMuted);
                  }}
                  className="text-zinc-300 hover:text-white"
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="w-4 h-4" />
                  ) : (
                    <Volume2 className="w-4 h-4" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.02}
                  value={isMuted ? 0 : volume}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (videoRef.current) {
                      videoRef.current.volume = v;
                      videoRef.current.muted = v === 0;
                    }
                    setVolume(v);
                    setIsMuted(v === 0);
                    onVolumeChange(v);
                  }}
                  className="w-20 accent-indigo-500 h-1 bg-zinc-700 rounded-lg cursor-pointer"
                />
              </div>

              <button
                type="button"
                onClick={toggleFullscreen}
                className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 transition"
                title="Layar Penuh (F)"
              >
                <Maximize2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
