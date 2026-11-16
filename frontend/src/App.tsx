import React, { useEffect, useRef, useState } from 'react';
import { Radio, ShieldCheck, Users } from 'lucide-react';
import { VideoStage } from './components/VideoStage';
import { VoiceDock } from './components/VoiceDock';
import { MediaSelector } from './components/MediaSelector';
import { SubtitleDrop } from './components/SubtitleDrop';
import { SyncEngine } from './core/SyncEngine';
import { WebRTCManager } from './core/WebRTCManager';
import { AudioAutoDucker } from './core/AudioAutoDucker';
import { MediaMode, RoomPeer, SyncTelemetry, UserRole } from './types/protocol';

export function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);

  const [role, setRole] = useState<UserRole>('HOST');
  const [roomId, setRoomId] = useState('cinema-1');
  const [mediaMode, setMediaMode] = useState<MediaMode>('LOCAL_HTTP');
  const [streamUrl, setStreamUrl] = useState<string>('');
  const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
  const [subtitleName, setSubtitleName] = useState<string | null>(null);
  const [peers, setPeers] = useState<RoomPeer[]>([]);

  const [isVoiceConnected, setIsVoiceConnected] = useState(false);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [autoDuckEnabled, setAutoDuckEnabled] = useState(true);
  const [partnerRms, setPartnerRms] = useState(0);
  const [isDucked, setIsDucked] = useState(false);
  const [effectiveVolume, setEffectiveVolume] = useState(1.0);

  const [telemetry, setTelemetry] = useState<SyncTelemetry>({
    rttMs: 14,
    oneWayLatencyMs: 7,
    clockOffsetMs: 0,
    driftSeconds: 0,
    activePlaybackRate: 1.0,
    zone: 'LOCKED_SYNC',
    samplesCollected: 5,
  });

  const syncEngineRef = useRef<SyncEngine | null>(null);
  const rtcManagerRef = useRef<WebRTCManager | null>(null);
  const autoDuckerRef = useRef<AudioAutoDucker | null>(null);

  useEffect(() => {
    const peerId = `${role}-${Math.random().toString(36).substring(2, 7)}`;
    const ducker = new AudioAutoDucker((rms, ducked, vol) => {
      setPartnerRms(rms);
      setIsDucked(ducked);
      setEffectiveVolume(vol);
    });
    ducker.attachVideo(videoRef.current);
    autoDuckerRef.current = ducker;

    const engine = new SyncEngine(roomId, role, peerId, {
      onTelemetry: (t) => setTelemetry(t),
      onPresence: (p) => setPeers(p),
      onMediaChange: (url) => setStreamUrl(url),
      onSignal: (sig) => rtcManagerRef.current?.handleSignal(sig),
    });
    engine.attachVideo(videoRef.current);
    engine.connect();
    syncEngineRef.current = engine;

    const rtc = new WebRTCManager(engine, {
      onRemoteVoice: (stream) => {
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = stream;
          remoteAudioRef.current.play().catch(() => {});
        }
        ducker.connectStream(stream);
        setIsVoiceConnected(true);
      },
      onRemoteScreen: (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
        setMediaMode('WEBRTC_SCREEN');
      },
    });
    rtcManagerRef.current = rtc;

    return () => {
      ducker.stop();
      rtc.stopAll();
      engine.disconnect();
    };
  }, [roomId]);

  const handleRoleSwitch = (nextRole: UserRole) => {
    setRole(nextRole);
    syncEngineRef.current?.setRole(nextRole);
  };

  return (
    <div className="min-h-screen bg-[#09090B] text-zinc-100 flex flex-col">
      <header className="border-b border-zinc-800/80 bg-[#18181B]/70 backdrop-blur-md px-6 py-3 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-600/30">
            ST
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight flex items-center gap-2">
              <span>SyncTheater</span>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 font-mono">
                HTTP 206 + NTP-Lite + Opus 192k
              </span>
            </h1>
            <p className="text-[11px] text-zinc-400">
              Laptop-as-Host Single-Binary Server • Anti-Layar Hitam & Anti-Lag
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-lg bg-zinc-900 p-1 border border-zinc-800 text-xs">
            <button
              type="button"
              onClick={() => handleRoleSwitch('HOST')}
              className={`px-3 py-1 rounded-md font-medium transition ${
                role === 'HOST' ? 'bg-indigo-600 text-white' : 'text-zinc-400'
              }`}
            >
              Host (Laptop)
            </button>
            <button
              type="button"
              onClick={() => handleRoleSwitch('GUEST')}
              className={`px-3 py-1 rounded-md font-medium transition ${
                role === 'GUEST' ? 'bg-indigo-600 text-white' : 'text-zinc-400'
              }`}
            >
              Guest (Pasangan)
            </button>
          </div>

          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs text-zinc-300">
            <Users className="w-3.5 h-3.5 text-emerald-400" />
            <span>{ Math.max(1, peers.length) } Terhubung</span>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 md:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 space-y-4">
          <VideoStage
            videoRef={videoRef}
            streamUrl={streamUrl}
            subtitleUrl={subtitleUrl}
            telemetry={telemetry}
            isMicMuted={isMicMuted}
            onUserPlay={() =>
              syncEngineRef.current?.sendSyncAction(
                'PLAY',
                videoRef.current?.currentTime || 0
              )
            }
            onUserPause={() =>
              syncEngineRef.current?.sendSyncAction(
                'PAUSE',
                videoRef.current?.currentTime || 0
              )
            }
            onUserSeek={(t) => syncEngineRef.current?.sendSyncAction('SEEK', t)}
            onVolumeChange={(v) => autoDuckerRef.current?.setBaseVolume(v)}
            onToggleMicShortcut={() => {
              const next = !isMicMuted;
              setIsMicMuted(next);
              rtcManagerRef.current?.setMicMuted(next);
            }}
          />
          <audio ref={remoteAudioRef} autoPlay className="hidden" />
        </div>

        <div className="lg:col-span-4 space-y-4">
          <VoiceDock
            isConnected={isVoiceConnected}
            isMicMuted={isMicMuted}
            autoDuckEnabled={autoDuckEnabled}
            partnerRms={partnerRms}
            isCurrentlyDucked={isDucked}
            effectiveVideoVolume={effectiveVolume}
            onToggleConnect={async () => {
              if (isVoiceConnected) {
                rtcManagerRef.current?.stopAll();
                setIsVoiceConnected(false);
              } else {
                const stream = await rtcManagerRef.current?.startVoiceChat();
                if (stream) {
                  autoDuckerRef.current?.connectStream(stream);
                  setIsVoiceConnected(true);
                }
              }
            }}
            onToggleMicMute={() => {
              const next = !isMicMuted;
              setIsMicMuted(next);
              rtcManagerRef.current?.setMicMuted(next);
            }}
            onToggleAutoDuck={() => {
              const next = !autoDuckEnabled;
              setAutoDuckEnabled(next);
              autoDuckerRef.current?.setEnabled(next);
            }}
          />

          <MediaSelector
            activeMode={mediaMode}
            onSelectLocalStream={(url) => {
              setMediaMode('LOCAL_HTTP');
              setStreamUrl(url);
              syncEngineRef.current?.sendSyncAction('MEDIA_CHANGE', 0, url);
            }}
            onSelectExternalUrl={(url) => {
              setMediaMode('EXTERNAL_URL');
              setStreamUrl(url);
              syncEngineRef.current?.sendSyncAction('MEDIA_CHANGE', 0, url);
            }}
            onStartScreenShare={async () => {
              const stream = await rtcManagerRef.current?.startRawTabShare();
              if (stream && videoRef.current) {
                videoRef.current.srcObject = stream;
                setMediaMode('WEBRTC_SCREEN');
              }
            }}
          />

          <SubtitleDrop
            activeSubtitleName={subtitleName}
            onSubtitleReady={(url, name) => {
              setSubtitleUrl(url);
              setSubtitleName(name);
            }}
          />

          <div className="rounded-xl border border-zinc-800 bg-[#18181B]/80 p-4 text-xs space-y-2 text-zinc-400">
            <div className="flex items-center gap-2 text-zinc-200 font-semibold">
              <ShieldCheck className="w-4 h-4 text-indigo-400" />
              <span>Pintasan Keyboard Dark Theater</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 text-[11px]">
              <div><kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-200">Spasi</kbd> Play / Pause</div>
              <div><kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-200">← / →</kbd> Seek ±5 dtk</div>
              <div><kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-200">↑ / ↓</kbd> Volume Film</div>
              <div><kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-200">M</kbd> Mute Mic • <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-200">F</kbd> Fullscreen</div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
