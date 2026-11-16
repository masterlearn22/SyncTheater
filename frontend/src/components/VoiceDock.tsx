import React from 'react';
import { Mic, MicOff, PhoneCall, PhoneOff, Sliders, Volume2 } from 'lucide-react';

interface VoiceDockProps {
  isConnected: boolean;
  isMicMuted: boolean;
  autoDuckEnabled: boolean;
  partnerRms: number;
  isCurrentlyDucked: boolean;
  effectiveVideoVolume: number;
  onToggleConnect: () => void;
  onToggleMicMute: () => void;
  onToggleAutoDuck: () => void;
}

export const VoiceDock: React.FC<VoiceDockProps> = ({
  isConnected,
  isMicMuted,
  autoDuckEnabled,
  partnerRms,
  isCurrentlyDucked,
  effectiveVideoVolume,
  onToggleConnect,
  onToggleMicMute,
  onToggleAutoDuck,
}) => {
  const rmsPercent = Math.min(100, Math.round(partnerRms * 450));

  return (
    <div className="rounded-xl border border-zinc-800 bg-[#18181B]/80 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`w-2.5 h-2.5 rounded-full ${
              isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'
            }`}
          />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-300">
            Dual-Channel WebRTC Voice & Auto-Ducking
          </h3>
        </div>
        <span className="text-[11px] font-mono text-zinc-400">
          Opus 48kHz • EchoCancel ON
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onToggleConnect}
          className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition ${
            isConnected
              ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40 hover:bg-rose-500/30'
              : 'bg-emerald-600 hover:bg-emerald-500 text-white'
          }`}
        >
          {isConnected ? (
            <>
              <PhoneOff className="w-3.5 h-3.5" />
              <span>Putuskan Suara</span>
            </>
          ) : (
            <>
              <PhoneCall className="w-3.5 h-3.5" />
              <span>Hubungkan Voice P2P</span>
            </>
          )}
        </button>

        <button
          type="button"
          onClick={onToggleMicMute}
          className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition ${
            isMicMuted
              ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
              : 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800'
          }`}
        >
          {isMicMuted ? <MicOff className="w-3.5 h-3.5" /> : <Mic className="w-3.5 h-3.5" />}
          <span>{isMicMuted ? 'Unmute (M)' : 'Mute Mic (M)'}</span>
        </button>

        <button
          type="button"
          onClick={onToggleAutoDuck}
          className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-medium transition ${
            autoDuckEnabled
              ? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-300'
              : 'border-zinc-700 bg-zinc-900 text-zinc-400'
          }`}
        >
          <Sliders className="w-3.5 h-3.5" />
          <span>Auto-Ducking -30%: {autoDuckEnabled ? 'AKTIF' : 'NONAKTIF'}</span>
        </button>
      </div>

      <div className="space-y-1.5 pt-1">
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-zinc-400">
            Detektor Bicara Pasangan (AnalyserNode fftSize=256):
          </span>
          <span
            className={`font-mono font-medium ${
              isCurrentlyDucked ? 'text-amber-400' : 'text-emerald-400'
            }`}
          >
            {isCurrentlyDucked
              ? `Ducking Aktif (Vol Film ${Math.round(effectiveVideoVolume * 100)}%)`
              : `Normal (Vol Film ${Math.round(effectiveVideoVolume * 100)}%)`}
          </span>
        </div>
        <div className="w-full h-2 rounded-full bg-zinc-900 overflow-hidden border border-zinc-800">
          <div
            className={`h-full transition-all duration-75 ${
              isCurrentlyDucked ? 'bg-amber-400' : 'bg-indigo-500'
            }`}
            style={{ width: `${rmsPercent}%` }}
          />
        </div>
      </div>
    </div>
  );
};
