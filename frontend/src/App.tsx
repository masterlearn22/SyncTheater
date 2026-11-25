import React, { useState, useEffect, useRef, useCallback } from 'react';
import { AudioAutoDucker } from './core/AudioAutoDucker';
import { SyncEngine } from './core/SyncEngine';
import { DemoCanvas } from './components/DemoCanvas';
import {
  Play,
  Pause,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Maximize2,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Sliders,
  Film,
  FolderOpen,
  Subtitles,
  Upload,
  CheckCircle2,
  Terminal,
  Copy,
  Check,
  Radio,
  Sparkles,
  Users,
  ShieldCheck,
  Gauge,
  Waves,
  FileCode2,
  RefreshCw,
  LogOut,
  Send,
  MessageSquare,
  Heart,
  MonitorUp,
  Link2,
  HelpCircle,
  Columns,
  ArrowRight,
  Wrench,
  Globe,
  Tv,
  Zap,
} from 'lucide-react';

// ============================================================================
// 1. TIPE PROTOKOL & STATE
// ============================================================================
type UserRole = 'HOST' | 'GUEST';
type SyncAction = 'PLAY' | 'PAUSE' | 'SEEK' | 'HEARTBEAT' | 'MEDIA_CHANGE';
type SyncZone = 'LOCKED_SYNC' | 'SOFT_RATE_ADAPT' | 'HARD_SEEK';
type AppMode = 'USER_APP' | 'DEV_LAB';
type DevTab = 'DEPLOY_GUIDE' | 'SYNC_LAB' | 'SDP_CONSOLE' | 'CLI_GUIDE';

interface SyncTelemetry {
  rttMs: number;
  oneWayLatencyMs: number;
  clockOffsetMs: number;
  driftSeconds: number;
  activePlaybackRate: number;
  zone: SyncZone;
  samplesCollected: number;
}

interface SyncLogItem {
  id: string;
  time: string;
  action: SyncAction | 'NTP_PING' | 'AUTO_DUCK' | 'SRT_VTT' | 'ROOM_EVENT';
  detail: string;
  zone: SyncZone;
}

interface ChatMessage {
  id: string;
  sender: string;
  role: UserRole | 'SYSTEM';
  text: string;
  time: string;
}

interface FloatingReaction {
  id: string;
  emoji: string;
  leftPercent: number;
}

// ============================================================================
// 2. FUNGSI INTI: KOREKSI 3 ZONA, OPUS SDP MUNGING, & KONVERTER SRT -> VTT
// ============================================================================
function evaluateThreeZoneCorrection(
  deltaT: number,
  currentlySoftCorrecting: boolean
): {
  zone: SyncZone;
  playbackRate: number;
  isSoftCorrecting: boolean;
} {
  const absDelta = Math.abs(deltaT);

  if (absDelta > 1.0) {
    return {
      zone: 'HARD_SEEK',
      playbackRate: 1.0,
      isSoftCorrecting: false,
    };
  }

  const syncThreshold = currentlySoftCorrecting ? 0.03 : 0.05;
  if (absDelta < syncThreshold) {
    return {
      zone: 'LOCKED_SYNC',
      playbackRate: 1.0,
      isSoftCorrecting: false,
    };
  }

  return {
    zone: 'SOFT_RATE_ADAPT',
    playbackRate: deltaT > 0 ? 1.04 : 0.96,
    isSoftCorrecting: true,
  };
}

function mungeOpusStereoHighBitrate(sdp: string): string {
  const lines = sdp.split(/\r?\n/);
  let opusPayloadType: string | null = null;

  for (const line of lines) {
    const match = line.match(/^a=rtpmap:(\d+)\s+opus\/48000\/2/i);
    if (match) {
      opusPayloadType = match[1];
      break;
    }
  }
  if (!opusPayloadType) return sdp;

  const targetParams =
    'minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=192000;cbr=1';
  let fmtpFound = false;

  const updated = lines.map((line) => {
    if (line.startsWith(`a=fmtp:${opusPayloadType} `)) {
      fmtpFound = true;
      return `a=fmtp:${opusPayloadType} ${targetParams}`;
    }
    return line;
  });

  if (!fmtpFound) {
    const idx = updated.findIndex((l) => l.startsWith(`a=rtpmap:${opusPayloadType} `));
    if (idx !== -1) {
      updated.splice(idx + 1, 0, `a=fmtp:${opusPayloadType} ${targetParams}`);
    }
  }
  return updated.join('\r\n');
}

/**
 * Modifikasi baris SDP Video untuk mengunci batas bandwidth WebRTC ke 4-5 Mbps:
 * - b=AS:5000 (5000 kbps) & b=TIAS:5000000 (5 Mbps)
 * - x-google-min-bitrate=2500;x-google-max-bitrate=5000;x-google-start-bitrate=4500
 */
function mungeVideoBitrate(sdp: string, targetBitrateKbps = 3000): string {
  const lines = sdp.split(/\r?\n/);
  const minKbps = Math.min(400, Math.floor(targetBitrateKbps * 0.25));
  const startKbps = Math.max(minKbps, Math.floor(targetBitrateKbps * 0.7));
  const tiasBps = targetBitrateKbps * 1000;

  let inVideoSection = false;
  let videoPayloadTypes: string[] = [];
  const result: string[] = [];
  let bandwidthInserted = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('m=video ')) {
      inVideoSection = true;
      bandwidthInserted = false;
      const parts = line.split(' ');
      videoPayloadTypes = parts.slice(3);
      result.push(line);
      continue;
    } else if (line.startsWith('m=audio ') || line.startsWith('m=application ')) {
      inVideoSection = false;
    }

    if (inVideoSection) {
      if (line.startsWith('b=AS:') || line.startsWith('b=TIAS:')) {
        continue;
      }

      if (line.startsWith('a=') && !bandwidthInserted) {
        result.push(`b=AS:${targetBitrateKbps}`);
        result.push(`b=TIAS:${tiasBps}`);
        bandwidthInserted = true;
      }

      let modifiedLine = line;
      if (line.startsWith('a=fmtp:')) {
        const fmtpMatch = line.match(/^a=fmtp:(\d+)\s*(.*)$/);
        if (fmtpMatch && videoPayloadTypes.includes(fmtpMatch[1])) {
          const pt = fmtpMatch[1];
          let params = fmtpMatch[2] || '';
          params = params
            .split(';')
            .filter((p) => !p.trim().startsWith('x-google-'))
            .join(';');
          const googleBitrate = `x-google-min-bitrate=${minKbps};x-google-max-bitrate=${targetBitrateKbps};x-google-start-bitrate=${startKbps}`;
          const newParams = params ? `${params};${googleBitrate}` : googleBitrate;
          modifiedLine = `a=fmtp:${pt} ${newParams}`;
        }
      }
      result.push(modifiedLine);
    } else {
      result.push(line);
    }
  }

  return result.join('\r\n');
}

function mungeFullSdp(sdp: string, targetBitrateKbps = 5000): string {
  let res = mungeOpusStereoHighBitrate(sdp);
  res = mungeVideoBitrate(res, targetBitrateKbps);
  return res;
}

function convertSrtToWebVtt(srtContent: string): {
  vttText: string;
  cues: Array<{ start: number; end: number; text: string }>;
} {
  const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const blocks = normalized.split(/\n\n+/);
  const cues: Array<{ start: number; end: number; text: string }> = [];

  const parseSec = (hms: string, ms: string) => {
    const [h, m, s] = hms.split(':').map(Number);
    return h * 3600 + m * 60 + s + Number(ms) / 1000;
  };

  for (const block of blocks) {
    const lines = block.split('\n');
    const timeLineIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIdx !== -1) {
      const m = lines[timeLineIdx].match(
        /(\d{2}:\d{2}:\d{2})[,.](\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2})[,.](\d{3})/
      );
      if (m) {
        const start = parseSec(m[1], m[2]);
        const end = parseSec(m[3], m[4]);
        const text = lines.slice(timeLineIdx + 1).join('\n').trim();
        if (text) cues.push({ start, end, text });
      }
    }
  }

  const convertedBody = normalized.replace(
    /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/g,
    '$1.$2 --> $3.$4'
  );

  return {
    vttText: `WEBVTT\n\n${convertedBody}\n`,
    cues,
  };
}

const DEFAULT_SRT_SAMPLE = `1
00:00:00,500 --> 00:00:05,000
Selamat datang di Ruang Bioskop SyncTheater! 🍿

2
00:00:05,100 --> 00:00:10,500
Klik langsung pada layar video untuk Play atau Pause bersama pasanganmu.

3
00:00:10,600 --> 00:00:16,500
Saat salah satu berbicara di mikrofon, suara film otomatis mengecil 30% (Auto-Ducking).

4
00:00:16,600 --> 00:00:23,000
Kamu bisa pilih file film .MP4 dan subtitle .SRT dari laptopmu kapan saja di bawah layar!`;

const SAMPLE_SDP_BEFORE = `v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
m=audio 9 UDP/TLS/RTP/SAVPF 111
a=rtpmap:111 opus/48000/2
a=fmtp:111 minptime=10;useinbandfec=1`;

const SAMPLE_VIDEO_SDP_BEFORE = `v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
m=video 9 UDP/TLS/RTP/SAVPF 96 125
c=IN IP4 0.0.0.0
a=rtpmap:96 VP8/90000
a=rtpmap:125 H264/90000
a=fmtp:125 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f`;

// ============================================================================
// 3. KOMPONEN UTAMA SYNCTHEATER (USER-FRIENDLY ROOM + SEPARATED DEV LAB)
// ============================================================================
export default function App() {
  // Pemisahan Mode Penggunaan Utama vs Mode Pengujian Teknis
  const [appMode, setAppMode] = useState<AppMode>('USER_APP');
  const [devTab, setDevTab] = useState<DevTab>('DEPLOY_GUIDE');

  // State Lobby & Room ID ("Tinggal Pakai")
  const [inRoom, setInRoom] = useState<boolean>(false);
  const [role, setRole] = useState<UserRole>('HOST');
  const [nickname, setNickname] = useState<string>('Surya');
  const [hostNicknameInput, setHostNicknameInput] = useState<string>('Surya');
  const [guestNicknameInput, setGuestNicknameInput] = useState<string>('Adek');
  const [roomCodeInput, setRoomCodeInput] = useState<string>('SURYA-ADEK');
  const [joinCodeInput, setJoinCodeInput] = useState<string>('SURYA-ADEK');
  const [activeRoomCode, setActiveRoomCode] = useState<string>('SURYA-ADEK');
  const [p2pStatus, setP2pStatus] = useState<'READY' | 'CONNECTING' | 'CONNECTED' | 'ERROR'>('READY');
  const [peerErrorMsg, setPeerErrorMsg] = useState<string | null>(null);
  const [connectedPartnerName, setConnectedPartnerName] = useState<string>('Menunggu pasangan bergabung...');
  const [showSplitGuestPreview, setShowSplitGuestPreview] = useState<boolean>(false);
  const [showQuickGuideModal, setShowQuickGuideModal] = useState<boolean>(false);

  // State Pemutar Video & Media
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVoiceAudioRef = useRef<HTMLAudioElement | null>(null);
  const demoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const guestCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageContainerRef = useRef<HTMLDivElement | null>(null);

  const [localVideoUrl, setLocalVideoUrl] = useState<string | null>(null);
  const [localVideoName, setLocalVideoName] = useState<string>('Film Demo Bioskop (Klik Pilih Film .MP4 untuk Ganti)');
  const [externalUrlInput, setExternalUrlInput] = useState<string>('');
  const [showMediaModal, setShowMediaModal] = useState<boolean>(false);
  const [serverMovies, setServerMovies] = useState<Array<{ name: string; size: number; streamUrl: string }>>([]);

  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [playActionFeedback, setPlayActionFeedback] = useState<'PLAY' | 'PAUSE' | null>(null);
  const [hostTime, setHostTime] = useState<number>(0);
  const [clientTime, setClientTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(180);
  const [baseVolume, setBaseVolume] = useState<number>(1.0);
  const [effectiveVolume, setEffectiveVolume] = useState<number>(1.0);
  const [isVideoMuted, setIsVideoMuted] = useState<boolean>(false);
  const [hudVisible, setHudVisible] = useState<boolean>(true);

  // State Sinkronisasi 3 Zona
  const [isSoftCorrecting, setIsSoftCorrecting] = useState<boolean>(false);
  const [telemetry, setTelemetry] = useState<SyncTelemetry>({
    rttMs: 0,
    oneWayLatencyMs: 0,
    clockOffsetMs: 0,
    driftSeconds: 0,
    activePlaybackRate: 1.0,
    zone: 'LOCKED_SYNC',
    samplesCollected: 0,
  });

  // State Voice Chat & Auto-Ducking
  const [voiceConnected, setVoiceConnected] = useState<boolean>(false);
  const [isMicMuted, setIsMicMuted] = useState<boolean>(false);
  const [autoDuckEnabled, setAutoDuckEnabled] = useState<boolean>(true);
  const [partnerSpeakingSim, setPartnerSpeakingSim] = useState<boolean>(false);
  const [liveMicListening, setLiveMicListening] = useState<boolean>(false);
  const [isDucked, setIsDucked] = useState<boolean>(false);

  // State Subtitle (.SRT -> .VTT)
  const [srtRawText, setSrtRawText] = useState<string>(DEFAULT_SRT_SAMPLE);
  const [subtitleFileName, setSubtitleFileName] = useState<string>('Subtitle Bawaan Aktif (.SRT)');
  const [parsedCues, setParsedCues] = useState<Array<{ start: number; end: number; text: string }>>([]);
  const [vttBlobUrl, setVttBlobUrl] = useState<string | null>(null);
  const [vttPreviewText, setVttPreviewText] = useState<string>('');
  const [subtitlesEnabled, setSubtitlesEnabled] = useState<boolean>(true);

  // Pengaturan WebRTC Adaptif (Default 3 Mbps Balanced 30fps agar anti-lag)
  const [streamBitrateKbps, setStreamBitrateKbps] = useState<number>(3000);
  const [streamQualityMode, setStreamQualityMode] = useState<'BALANCED' | 'SHARP' | 'MOTION'>('BALANCED');
  const [showBitrateSettings, setShowBitrateSettings] = useState<boolean>(false);
  const streamBitrateRef = useRef<number>(3000);
  const streamQualityModeRef = useRef<'BALANCED' | 'SHARP' | 'MOTION'>('BALANCED');
  streamBitrateRef.current = streamBitrateKbps;
  streamQualityModeRef.current = streamQualityMode;

  // State Chat Room & Reaksi Emoji
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: 'msg-welcome',
      sender: 'Sistem Bioskop',
      role: 'SYSTEM',
      text: 'Ruang nobar siap! Saat kamu menekan Play, Pause, atau menggeser durasi film, layar pasanganmu otomatis tersinkronisasi.',
      time: '12:07',
    },
  ]);
  const [chatInput, setChatInput] = useState<string>('');
  const [floatingReactions, setFloatingReactions] = useState<FloatingReaction[]>([]);

  // State Log & Copy Feedback
  const [syncLogs, setSyncLogs] = useState<SyncLogItem[]>([
    {
      id: 'init-1',
      time: '12:07:02',
      action: 'NTP_PING',
      detail: 'Siap melakukan kalibrasi NTP-Lite saat terhubung ke pasangan.',
      zone: 'LOCKED_SYNC',
    },
  ]);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  // Referensi Audio, BroadcastChannel, Sync, & PeerJS P2P
  const hudTimeoutRef = useRef<number | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const autoDuckerRef = useRef<AudioAutoDucker | null>(null);
  const rmsBarRef = useRef<HTMLDivElement | null>(null);
  const lastDuckedStateRef = useRef<boolean>(false);
  const lastEffVolRef = useRef<number>(1.0);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);
  const peerInstanceRef = useRef<any>(null);
  const peerConnsRef = useRef<Map<string, any>>(new Map());
  const connectedGuestPeerIdRef = useRef<string | null>(null);
  const outgoingMediaStreamRef = useRef<MediaStream | null>(null);
  const activeMediaCallRef = useRef<any>(null);
  const activeVoiceCallRef = useRef<any>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const hostTimeRef = useRef<number>(0);
  const clientTimeRef = useRef<number>(0);
  const softCorrectingRef = useRef<boolean>(false);
  const clockOffsetMsRef = useRef<number>(0);
  const pingSamplesRef = useRef<Array<{ rtt: number; clockOffset: number }>>([]);
  const prevBlobUrlRef = useRef<string | null>(null);
  const isPlayingRef = useRef<boolean>(true);
  const localVideoUrlRef = useRef<string | null>(null);
  const hasRemoteVideoStreamRef = useRef<boolean>(false);
  const roleRef = useRef<UserRole>('HOST');
  const isVideoMutedRef = useRef<boolean>(false);

  const [isHostStreaming, setIsHostStreaming] = useState<boolean>(false);
  const [streamingSourceLabel, setStreamingSourceLabel] = useState<string>('');
  const [hasRemoteVideoStream, setHasRemoteVideoStream] = useState<boolean>(false);
  const remoteMediaStreamRef = useRef<MediaStream | null>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState<boolean>(false);

  isPlayingRef.current = isPlaying;
  localVideoUrlRef.current = localVideoUrl;
  hasRemoteVideoStreamRef.current = hasRemoteVideoStream;
  roleRef.current = role;
  isVideoMutedRef.current = isVideoMuted;

  const appendLog = useCallback((action: SyncLogItem['action'], detail: string, zone: SyncZone) => {
    const nowStr = new Date().toTimeString().slice(0, 8);
    setSyncLogs((prev) => [
      {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        time: nowStr,
        action,
        detail,
        zone,
      },
      ...prev.slice(0, 14),
    ]);
  }, []);

  const addSystemChat = useCallback((text: string) => {
    const time = new Date().toTimeString().slice(0, 5);
    setChatMessages((prev) => [
      ...prev,
      {
        id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sender: 'Sinkronisasi Otomatis',
        role: 'SYSTEM',
        text,
        time,
      },
    ]);
  }, []);

  // Muat library PeerJS dari CDN resmi (unpkg.com) untuk koneksi Room ID Serverless di GitHub Pages
  useEffect(() => {
    if ((window as any).Peer) return;
    const script = document.createElement('script');
    script.src = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
    script.async = true;
    script.onerror = () => {
      // Fallback ke BroadcastChannel lokal bila offline
    };
    document.head.appendChild(script);
  }, []);

  // Patch global RTCPeerConnection.prototype.setLocalDescription
  // agar setiap SDP offer/answer membawa konfigurasi bitrate adaptif & Opus Stereo 192k
  useEffect(() => {
    if (typeof window === 'undefined' || !(window as any).RTCPeerConnection) return;
    const OriginalPC = window.RTCPeerConnection;
    if ((OriginalPC as any).__synctheater_patched) return;
    (OriginalPC as any).__synctheater_patched = true;

    const origSetLocal = OriginalPC.prototype.setLocalDescription;
    OriginalPC.prototype.setLocalDescription = async function (desc?: any) {
      if (desc && typeof desc.sdp === 'string' && desc.sdp.length > 0) {
        try {
          const targetKbps = streamBitrateRef.current || 3000;
          const munged = mungeFullSdp(desc.sdp, targetKbps);
          const newDesc = new RTCSessionDescription({
            type: desc.type,
            sdp: munged,
          });
          return await (origSetLocal as any).call(this, newDesc);
        } catch (e) {
          console.warn('[SyncTheater] Fallback SDP asli karena munging ditolak browser:', e);
        }
      }
      return (origSetLocal as any).call(this, desc);
    };
  }, []);

  // Mengatur RTCRtpSender pada MediaConnection secara aman dengan fallback
  const setupHighQualityCall = useCallback((call: any) => {
    if (!call) return;
    const pc: RTCPeerConnection | undefined = call.peerConnection;
    if (!pc) return;

    const applyParams = async () => {
      try {
        const senders = pc.getSenders();
        for (const sender of senders) {
          if (sender.track && sender.track.kind === 'video') {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }
            const currentKbps = streamBitrateRef.current || 3000;
            const currentMode = streamQualityModeRef.current || 'BALANCED';
            const bitrateBps = currentKbps * 1000;
            const targetFps = currentMode === 'MOTION' ? 60 : 30;

            for (const enc of params.encodings) {
              enc.maxBitrate = bitrateBps;
              enc.maxFramerate = targetFps;
              enc.scaleResolutionDownBy = 1.0;
            }

            (params as any).degradationPreference =
              currentMode === 'SHARP'
                ? 'maintain-resolution'
                : currentMode === 'MOTION'
                ? 'maintain-framerate'
                : 'balanced';

            try {
              await sender.setParameters(params);
            } catch {
              // Fallback aman bila browser menolak degradationPreference/maxFramerate
              const fallback = sender.getParameters();
              if (!fallback.encodings || fallback.encodings.length === 0) {
                fallback.encodings = [{}];
              }
              for (const enc of fallback.encodings) {
                enc.maxBitrate = bitrateBps;
              }
              await sender.setParameters(fallback);
            }
          }
        }
      } catch {
        // abaikan bila koneksi belum siap
      }
    };

    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'connected' || pc.connectionState === 'connecting') {
        applyParams();
      }
    });

    applyParams();
    window.setTimeout(applyParams, 400);
    window.setTimeout(applyParams, 1500);
  }, []);

  const changeStreamBitrate = (newKbps: number) => {
    setStreamBitrateKbps(newKbps);
    streamBitrateRef.current = newKbps;
    if (activeMediaCallRef.current?.peerConnection) {
      setupHighQualityCall(activeMediaCallRef.current);
    }
    appendLog(
      'ROOM_EVENT',
      `Bitrate WebRTC diubah ke ${(newKbps / 1000).toFixed(1)} Mbps (${newKbps} kbps)`,
      'LOCKED_SYNC'
    );
    addSystemChat(`Bitrate WebRTC diatur ke ${(newKbps / 1000).toFixed(1)} Mbps`);
  };

  const changeQualityMode = (mode: 'BALANCED' | 'SHARP' | 'MOTION') => {
    setStreamQualityMode(mode);
    streamQualityModeRef.current = mode;
    if (outgoingMediaStreamRef.current) {
      outgoingMediaStreamRef.current.getVideoTracks().forEach((track) => {
        if ('contentHint' in track) {
          (track as any).contentHint = mode === 'SHARP' ? 'detail' : 'motion';
        }
      });
    }
    if (activeMediaCallRef.current?.peerConnection) {
      setupHighQualityCall(activeMediaCallRef.current);
    }
    appendLog(
      'ROOM_EVENT',
      `Mode WebRTC diubah ke ${
        mode === 'BALANCED'
          ? 'Adaptif Anti-Lag (30 FPS)'
          : mode === 'SHARP'
          ? 'Resolusi Tajam'
          : 'Gerakan Mulus (60 FPS)'
      }`,
      'LOCKED_SYNC'
    );
  };

  // Muat daftar film dari server Go (/api/movies) jika dijalankan via nobar.exe
  useEffect(() => {
    fetch('/api/movies')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.movies)) {
          setServerMovies(data.movies);
        }
      })
      .catch(() => {
        // Mode static / GitHub Pages tanpa backend Go
      });
  }, []);

  // Helper aman mengganti sumber video & membersihkan blob URL sebelumnya (cegah memory leak)
  const selectVideoSource = useCallback((url: string | null, name: string) => {
    if (prevBlobUrlRef.current && prevBlobUrlRef.current !== url) {
      URL.revokeObjectURL(prevBlobUrlRef.current);
      prevBlobUrlRef.current = null;
    }
    if (url && url.startsWith('blob:')) {
      prevBlobUrlRef.current = url;
    }
    if (videoRef.current && videoRef.current.srcObject) {
      videoRef.current.srcObject = null;
    }
    setHasRemoteVideoStream(false);
    setLocalVideoUrl(url);
    setLocalVideoName(name);
    hostTimeRef.current = 0;
    clientTimeRef.current = 0;
    setHostTime(0);
    setClientTime(0);
  }, []);

  // Cleanup blob URL saat komponen di-unmount
  useEffect(() => {
    return () => {
      if (prevBlobUrlRef.current) {
        URL.revokeObjectURL(prevBlobUrlRef.current);
      }
      autoDuckerRef.current?.stop();
    };
  }, []);

  // Inisialisasi AudioAutoDucker berbasis Web Audio API (update meter via ref agar 0 re-render)
  useEffect(() => {
    const ducker = new AudioAutoDucker((rms, ducked, currentVol) => {
      if (rmsBarRef.current) {
        const pct = Math.min(100, Math.round(rms * 550));
        rmsBarRef.current.style.width = `${pct}%`;
        rmsBarRef.current.className = `h-full transition-all duration-75 ${
          ducked ? 'bg-amber-400' : 'bg-indigo-500'
        }`;
      }
      if (lastDuckedStateRef.current !== ducked) {
        lastDuckedStateRef.current = ducked;
        setIsDucked(ducked);
      }
      const roundedVol = +currentVol.toFixed(2);
      if (Math.abs(lastEffVolRef.current - roundedVol) >= 0.02) {
        lastEffVolRef.current = roundedVol;
        setEffectiveVolume(roundedVol);
      }
    });
    autoDuckerRef.current = ducker;
    return () => {
      ducker.stop();
      autoDuckerRef.current = null;
    };
  }, []);

  // Sinkronkan videoRef, volume, mute, dan status autoDuckEnabled ke AudioAutoDucker
  useEffect(() => {
    const ducker = autoDuckerRef.current;
    if (!ducker) return;
    ducker.attachVideo(videoRef.current);
    ducker.setBaseVolume(isVideoMuted ? 0 : baseVolume);
    ducker.setEnabled(autoDuckEnabled);
    if (videoRef.current) {
      videoRef.current.muted = isVideoMuted;
      if (!isVideoMuted && !lastDuckedStateRef.current) {
        videoRef.current.volume = baseVolume;
      }
    }
  }, [baseVolume, isVideoMuted, autoDuckEnabled, localVideoUrl, hasRemoteVideoStream, inRoom]);

  // Simulasi suara pasangan (hanya berjalan jika tombol simulasi diaktifkan)
  useEffect(() => {
    if (!partnerSpeakingSim) {
      if (autoDuckerRef.current && !voiceConnected) {
        autoDuckerRef.current.processRmsSample(0.005);
      }
      return;
    }
    const timer = window.setInterval(() => {
      const simRms = 0.13 + Math.sin(Date.now() / 90) * 0.04;
      autoDuckerRef.current?.processRmsSample(simRms);
    }, 120);
    return () => {
      window.clearInterval(timer);
      autoDuckerRef.current?.processRmsSample(0.005);
    };
  }, [partnerSpeakingSim, voiceConnected]);

  // Tempelkan MediaStream jarak jauh ke elemen <video> saat terpasang (khususnya di browser HP)
  useEffect(() => {
    if (hasRemoteVideoStream && remoteMediaStreamRef.current && videoRef.current) {
      const vid = videoRef.current;
      if (vid.srcObject !== remoteMediaStreamRef.current) {
        vid.srcObject = remoteMediaStreamRef.current;
      }
      vid.play().then(() => {
        setAutoplayBlocked(false);
      }).catch(() => {
        setAutoplayBlocked(true);
      });
    }
  }, [hasRemoteVideoStream, inRoom]);

  // Konversi Subtitle .SRT ke .VTT
  useEffect(() => {
    const { vttText, cues } = convertSrtToWebVtt(srtRawText);
    setParsedCues(cues);
    setVttPreviewText(vttText);
    const blob = new Blob([vttText], { type: 'text/vtt;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    setVttBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [srtRawText]);

  const broadcastRoomPacket = useCallback((packet: Record<string, any>) => {
    try {
      broadcastChannelRef.current?.postMessage(packet);
    } catch {
      // ignore
    }
    peerConnsRef.current.forEach((conn, peerId) => {
      try {
        if (conn && conn.open) {
          conn.send(packet);
        } else if (!conn || conn._closed) {
          peerConnsRef.current.delete(peerId);
        }
      } catch {
        // ignore
      }
    });
  }, []);

  const startNtpCalibrationP2P = useCallback(() => {
    pingSamplesRef.current = [];
    for (let seq = 1; seq <= 5; seq++) {
      window.setTimeout(() => {
        broadcastRoomPacket({
          type: 'P2P_PING',
          seq,
          clientSentTime: Date.now(),
        });
      }, (seq - 1) * 180);
    }
  }, [broadcastRoomPacket]);

  const placeVoiceCallToPeer = useCallback((targetPeerId: string) => {
    if (!peerInstanceRef.current || !micStreamRef.current || !targetPeerId) return;
    try {
      activeVoiceCallRef.current?.close?.();
      const vCall = peerInstanceRef.current.call(targetPeerId, micStreamRef.current, {
        metadata: { kind: 'voice' },
      });
      activeVoiceCallRef.current = vCall;
      vCall.on('stream', (remoteAudio: MediaStream) => {
        if (remoteVoiceAudioRef.current) {
          remoteVoiceAudioRef.current.srcObject = remoteAudio;
          remoteVoiceAudioRef.current.play().catch(() => {});
        }
        autoDuckerRef.current?.connectStream(remoteAudio);
        setVoiceConnected(true);
      });
      vCall.on('close', () => {
        setVoiceConnected(false);
      });
    } catch {
      // abaikan bila gagal memulai panggilan suara
    }
  }, []);

  const handleIncomingCall = useCallback(
    (call: any, currentRole: UserRole) => {
      const kind = call?.metadata?.kind;
      if (kind === 'voice') {
        call.answer(micStreamRef.current || undefined);
        activeVoiceCallRef.current = call;
        call.on('stream', (remoteAudio: MediaStream) => {
          if (remoteVoiceAudioRef.current) {
            remoteVoiceAudioRef.current.srcObject = remoteAudio;
            remoteVoiceAudioRef.current.play().catch(() => {});
          }
          autoDuckerRef.current?.connectStream(remoteAudio);
          setVoiceConnected(true);
          addSystemChat('Voice Chat P2P terhubung! Suara film otomatis mengecil saat pasangan bicara.');
        });
        call.on('close', () => {
          setVoiceConnected(false);
        });
        return;
      }

      // Video / Screen Share call
      call.answer();
      activeMediaCallRef.current = call;
      try {
        const pc: RTCPeerConnection | undefined = call.peerConnection;
        if (pc) {
          const setReceiverDelay = () => {
            pc.getReceivers().forEach((receiver: any) => {
              if ('playoutDelayHint' in receiver) {
                receiver.playoutDelayHint = 0.18;
              }
            });
          };
          setReceiverDelay();
          pc.addEventListener('track', (e) => {
            if (e.receiver && 'playoutDelayHint' in e.receiver) {
              e.receiver.playoutDelayHint = 0.18;
            }
          });
        }
      } catch {
        // abaikan jika browser tidak mendukung playoutDelayHint
      }
      call.on('stream', (remoteStream: MediaStream) => {
        if (remoteStream.getVideoTracks().length > 0) {
          if (prevBlobUrlRef.current) {
            URL.revokeObjectURL(prevBlobUrlRef.current);
            prevBlobUrlRef.current = null;
          }
          setLocalVideoUrl(null);
          remoteMediaStreamRef.current = remoteStream;
          setHasRemoteVideoStream(true);
          setIsPlaying(true);
          setLocalVideoName(
            currentRole === 'GUEST'
              ? 'Live Stream dari Host (WebRTC)'
              : 'Live Stream Aktif'
          );
          addSystemChat('Menerima siaran film langsung dari Host!');
        } else if (remoteStream.getAudioTracks().length > 0) {
          if (remoteVoiceAudioRef.current) {
            remoteVoiceAudioRef.current.srcObject = remoteStream;
            remoteVoiceAudioRef.current.play().catch(() => {});
          }
          autoDuckerRef.current?.connectStream(remoteStream);
          setVoiceConnected(true);
        }
      });
    },
    [addSystemChat]
  );

  const handleIncomingRoomPacketRef = useRef<(data: any, sourceConn?: any) => void>(() => {});

  // Koneksi Room ID via BroadcastChannel (antar-tab) & PeerJS WebRTC P2P (antar-perangkat)
  const connectToRoom = useCallback(
    (code: string, selectedRole: UserRole, userNickname: string) => {
      const cleanCode = code.trim().toUpperCase() || 'SURYA-ADEK';
      setActiveRoomCode(cleanCode);
      setRole(selectedRole);
      setNickname(userNickname);
      setInRoom(true);
      setP2pStatus('CONNECTING');
      setPeerErrorMsg(null);
      setConnectedPartnerName(
        selectedRole === 'HOST' ? 'Menunggu pasangan masuk...' : 'Menghubungkan ke Host...'
      );

      // 1. Setup BroadcastChannel untuk sinkronisasi antar-tab di browser yang sama
      try {
        broadcastChannelRef.current?.close();
        const bc = new BroadcastChannel(`synctheater_${cleanCode}`);
        bc.onmessage = (ev) => {
          const data = ev.data;
          if (!data) return;
          handleIncomingRoomPacketRef.current(data);
        };
        broadcastChannelRef.current = bc;
      } catch {
        // Abaikan jika browser tidak mendukung BroadcastChannel
      }

      // 2. Setup PeerJS WebRTC Broker (Serverless P2P untuk GitHub Pages)
      try {
        const PeerClass = (window as any).Peer;
        if (PeerClass) {
          peerInstanceRef.current?.destroy?.();
          peerConnsRef.current.clear();
          const sanitizedId = cleanCode.replace(/[^A-Z0-9]/g, '');
          const hostPeerId = `synctheater-host-${sanitizedId}`;

          if (selectedRole === 'HOST') {
            const peer = new PeerClass(hostPeerId);
            peer.on('open', () => {
              setP2pStatus('CONNECTED');
              setPeerErrorMsg(null);
              appendLog('ROOM_EVENT', `Room ${cleanCode} aktif di PeerJS Cloud Broker`, 'LOCKED_SYNC');
            });
            peer.on('connection', (conn: any) => {
              peerConnsRef.current.set(conn.peer, conn);
              conn.on('data', (data: any) => handleIncomingRoomPacketRef.current(data, conn));
              conn.on('close', () => {
                peerConnsRef.current.delete(conn.peer);
                if (peerConnsRef.current.size === 0) {
                  setConnectedPartnerName('Pasangan keluar / terputus');
                }
              });
            });
            peer.on('call', (call: any) => handleIncomingCall(call, 'HOST'));
            peer.on('error', (err: any) => {
              const type = err?.type || 'unknown';
              const msg =
                type === 'unavailable-id'
                  ? `Kode Room "${cleanCode}" sedang dipakai tab/host lain. Gunakan kode lain atau tutup tab lama.`
                  : `Gagal terhubung ke broker PeerJS (${type}).`;
              setP2pStatus('ERROR');
              setPeerErrorMsg(msg);
              appendLog('ROOM_EVENT', msg, 'HARD_SEEK');
              addSystemChat(`⚠️ ${msg}`);
            });
            peerInstanceRef.current = peer;
          } else {
            const guestPeer = new PeerClass();
            guestPeer.on('open', () => {
              const conn = guestPeer.connect(hostPeerId, { reliable: true });
              peerConnsRef.current.set(hostPeerId, conn);
              conn.on('open', () => {
                setP2pStatus('CONNECTED');
                setPeerErrorMsg(null);
                setConnectedPartnerName('Terhubung ke Host Room');
                conn.send({
                  type: 'JOIN_ANNOUNCE',
                  sender: userNickname,
                  guestPeerId: guestPeer.id,
                });
                startNtpCalibrationP2P();
              });
              conn.on('data', (data: any) => handleIncomingRoomPacketRef.current(data, conn));
              conn.on('close', () => {
                peerConnsRef.current.delete(hostPeerId);
                setP2pStatus('CONNECTING');
                setConnectedPartnerName('Koneksi ke Host terputus');
              });
            });
            guestPeer.on('call', (call: any) => handleIncomingCall(call, 'GUEST'));
            guestPeer.on('error', (err: any) => {
              const type = err?.type || 'unknown';
              const msg =
                type === 'peer-unavailable'
                  ? `Room "${cleanCode}" belum dibuat oleh Host. Pastikan Host sudah masuk lebih dulu.`
                  : `Koneksi P2P gagal (${type}).`;
              setP2pStatus('ERROR');
              setPeerErrorMsg(msg);
              appendLog('ROOM_EVENT', msg, 'HARD_SEEK');
              addSystemChat(`⚠️ ${msg}`);
            });
            peerInstanceRef.current = guestPeer;
          }
        } else {
          setP2pStatus('CONNECTED');
        }
      } catch {
        setP2pStatus('ERROR');
        setPeerErrorMsg('Gagal menginisialisasi koneksi WebRTC.');
      }
    },
    [appendLog, addSystemChat, handleIncomingCall, startNtpCalibrationP2P]
  );

  // Cleanup total saat keluar room
  const leaveRoom = useCallback(() => {
    if (heartbeatTimerRef.current) {
      window.clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    outgoingMediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    outgoingMediaStreamRef.current = null;
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    micStreamRef.current = null;
    activeMediaCallRef.current?.close?.();
    activeMediaCallRef.current = null;
    activeVoiceCallRef.current?.close?.();
    activeVoiceCallRef.current = null;
    peerConnsRef.current.forEach((conn) => {
      try {
        conn.close?.();
      } catch {
        // ignore
      }
    });
    peerConnsRef.current.clear();
    peerInstanceRef.current?.destroy?.();
    peerInstanceRef.current = null;
    broadcastChannelRef.current?.close();
    broadcastChannelRef.current = null;
    autoDuckerRef.current?.stop();
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
    if (remoteVoiceAudioRef.current) {
      remoteVoiceAudioRef.current.srcObject = null;
    }
    connectedGuestPeerIdRef.current = null;
    setIsHostStreaming(false);
    setStreamingSourceLabel('');
    setHasRemoteVideoStream(false);
    setLiveMicListening(false);
    setVoiceConnected(false);
    setIsMicMuted(false);
    setP2pStatus('READY');
    setPeerErrorMsg(null);
    setInRoom(false);
  }, []);

  handleIncomingRoomPacketRef.current = (data: any, sourceConn?: any) => {
    if (data.type === 'P2P_PING') {
      const pong = {
        type: 'P2P_PONG',
        seq: data.seq,
        clientSentTime: data.clientSentTime,
        serverTimestamp: Date.now(),
      };
      if (sourceConn && sourceConn.open) {
        sourceConn.send(pong);
      } else {
        broadcastRoomPacket(pong);
      }
      return;
    }

    if (data.type === 'P2P_PONG') {
      const receiveTime = Date.now();
      const rtt = Math.max(1, receiveTime - data.clientSentTime);
      const oneWay = rtt / 2;
      const clockOffset = data.serverTimestamp + oneWay - receiveTime;
      pingSamplesRef.current.push({ rtt, clockOffset });
      const best = pingSamplesRef.current.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      clockOffsetMsRef.current = best.clockOffset;
      setTelemetry((prev) => ({
        ...prev,
        rttMs: Math.round(best.rtt),
        oneWayLatencyMs: Math.round(best.rtt / 2),
        clockOffsetMs: Math.round(best.clockOffset),
        samplesCollected: pingSamplesRef.current.length,
      }));
      return;
    }

    if (data.type === 'SYNC_ACTION') {
      const vid = videoRef.current;
      const isDirectVideo = Boolean(vid && vid.src && !vid.srcObject);
      const isAnyMedia = Boolean(vid && (vid.src || vid.srcObject));
      const transitSec =
        typeof data.sentAt === 'number'
          ? Math.max(0, Math.min(3, (Date.now() + clockOffsetMsRef.current - data.sentAt) / 1000))
          : 0;
      const targetTime =
        typeof data.videoTime === 'number' ? data.videoTime + (data.action === 'PAUSE' ? 0 : transitSec) : 0;

      if (data.action === 'PLAY') {
        setIsPlaying(true);
        if (vid && isAnyMedia) {
          if (isDirectVideo && typeof data.videoTime === 'number' && Math.abs(targetTime - vid.currentTime) > 0.35) {
            vid.currentTime = targetTime;
          }
          vid.play().then(() => setAutoplayBlocked(false)).catch(() => setAutoplayBlocked(true));
        }
      } else if (data.action === 'PAUSE') {
        setIsPlaying(false);
        if (vid && isAnyMedia) {
          vid.pause();
          vid.playbackRate = 1.0;
          softCorrectingRef.current = false;
          if (isDirectVideo && typeof data.videoTime === 'number' && Math.abs(data.videoTime - vid.currentTime) > 0.2) {
            vid.currentTime = data.videoTime;
          }
        }
      } else if (data.action === 'SEEK' && typeof data.videoTime === 'number') {
        hostTimeRef.current = data.videoTime;
        clientTimeRef.current = data.videoTime;
        setHostTime(data.videoTime);
        setClientTime(data.videoTime);
        if (vid && isDirectVideo) {
          vid.currentTime = targetTime;
          vid.playbackRate = 1.0;
          softCorrectingRef.current = false;
        }
      } else if (data.action === 'HEARTBEAT' && typeof data.videoTime === 'number') {
        hostTimeRef.current = targetTime;
        if (!data.isPlaying) {
          setIsPlaying(false);
          if (vid && isDirectVideo && !vid.paused) {
            vid.pause();
            vid.playbackRate = 1.0;
          }
          return;
        }
        setIsPlaying(true);
        if (vid && isDirectVideo) {
          if (vid.paused) {
            vid.play().then(() => setAutoplayBlocked(false)).catch(() => setAutoplayBlocked(true));
          }
          const deltaT = targetTime - vid.currentTime;
          const decision = SyncEngine.evaluateThreeZoneCorrection(deltaT, softCorrectingRef.current);
          softCorrectingRef.current = decision.isSoftCorrecting;
          if (decision.zone === 'HARD_SEEK') {
            vid.currentTime = targetTime;
            vid.playbackRate = 1.0;
          } else {
            vid.playbackRate = decision.playbackRate;
          }
          setIsSoftCorrecting(decision.isSoftCorrecting);
          setTelemetry((prev) => ({
            ...prev,
            driftSeconds: Math.abs(deltaT) < 0.002 ? 0 : deltaT,
            activePlaybackRate: decision.playbackRate,
            zone: decision.zone,
          }));
        }
      } else if (data.action === 'MEDIA_CHANGE' && data.mediaSource) {
        selectVideoSource(data.mediaSource, data.mediaName || data.mediaSource);
        addSystemChat(`Host mengganti film ke: ${data.mediaName || data.mediaSource}`);
      }
    } else if (data.type === 'HOST_SYNC_SNAPSHOT') {
      if (data.mediaSource && !data.mediaSource.startsWith('blob:')) {
        selectVideoSource(data.mediaSource, data.mediaName || data.mediaSource);
      }
      if (typeof data.videoTime === 'number') {
        hostTimeRef.current = data.videoTime;
        clientTimeRef.current = data.videoTime;
        setHostTime(data.videoTime);
        setClientTime(data.videoTime);
        if (videoRef.current && videoRef.current.src && !videoRef.current.srcObject) {
          videoRef.current.currentTime = data.videoTime;
        }
      }
      if (typeof data.isPlaying === 'boolean') {
        setIsPlaying(data.isPlaying);
        if (videoRef.current && (videoRef.current.src || videoRef.current.srcObject)) {
          if (data.isPlaying) {
            videoRef.current.play().then(() => setAutoplayBlocked(false)).catch(() => setAutoplayBlocked(true));
          } else {
            videoRef.current.pause();
          }
        }
      }
    } else if (data.type === 'CHAT_MSG') {
      setChatMessages((prev) => [...prev, data.message]);
    } else if (data.type === 'EMOJI_REACTION') {
      triggerEmojiAnimation(data.emoji, false);
    } else if (data.type === 'JOIN_ANNOUNCE') {
      setConnectedPartnerName(`${data.sender || 'Pasangan'} (Terhubung)`);
      if (data.guestPeerId) {
        connectedGuestPeerIdRef.current = data.guestPeerId;
        if (outgoingMediaStreamRef.current && peerInstanceRef.current) {
          const call = peerInstanceRef.current.call(
            data.guestPeerId,
            outgoingMediaStreamRef.current,
            { metadata: { kind: 'video' } }
          );
          activeMediaCallRef.current = call;
          setupHighQualityCall(call);
        }
        if (micStreamRef.current) {
          placeVoiceCallToPeer(data.guestPeerId);
        }
      }
      // Kirim snapshot posisi video terkini ke Guest yang baru masuk
      const currentVid = videoRef.current;
      const snapshot = {
        type: 'HOST_SYNC_SNAPSHOT',
        videoTime: currentVid ? currentVid.currentTime : hostTimeRef.current,
        isPlaying: currentVid ? !currentVid.paused : isPlayingRef.current,
        mediaSource:
          localVideoUrlRef.current && !localVideoUrlRef.current.startsWith('blob:')
            ? localVideoUrlRef.current
            : undefined,
        mediaName: localVideoName,
      };
      if (sourceConn && sourceConn.open) {
        sourceConn.send(snapshot);
      } else {
        broadcastRoomPacket(snapshot);
      }
      addSystemChat(`${data.sender || 'Pasangan'} baru saja bergabung ke Room!`);
    } else if (data.type === 'STREAM_STOPPED') {
      setHasRemoteVideoStream(false);
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      addSystemChat('Host menghentikan siaran live stream.');
    }
  };

  // Heartbeat sinkronisasi dari Host setiap 2 detik saat memutar film langsung (anti-drift)
  useEffect(() => {
    if (heartbeatTimerRef.current) {
      window.clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
    if (!inRoom || role !== 'HOST') return;

    heartbeatTimerRef.current = window.setInterval(() => {
      const vid = videoRef.current;
      if (!vid || !vid.src || vid.srcObject) return;
      broadcastRoomPacket({
        type: 'SYNC_ACTION',
        action: 'HEARTBEAT',
        videoTime: vid.currentTime,
        isPlaying: !vid.paused,
        sentAt: Date.now(),
      });
    }, 2000);

    return () => {
      if (heartbeatTimerRef.current) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    };
  }, [inRoom, role, broadcastRoomPacket]);

  const pushStreamToConnectedGuest = (stream: MediaStream, label: string) => {
    stream.getVideoTracks().forEach((track) => {
      if ('contentHint' in track) {
        (track as any).contentHint = streamQualityModeRef.current === 'SHARP' ? 'detail' : 'motion';
      }
    });
    outgoingMediaStreamRef.current = stream;
    setIsHostStreaming(true);
    setStreamingSourceLabel(label);

    if (peerInstanceRef.current && connectedGuestPeerIdRef.current) {
      activeMediaCallRef.current?.close?.();
      const call = peerInstanceRef.current.call(
        connectedGuestPeerIdRef.current,
        stream,
        { metadata: { kind: 'video' } }
      );
      activeMediaCallRef.current = call;
      setupHighQualityCall(call);
      addSystemChat(`Mulai menyiarkan "${label}" (WebRTC ${(streamBitrateRef.current / 1000).toFixed(1)} Mbps) ke pasangan!`);
    } else {
      addSystemChat(
        `Siaran "${label}" (${(streamBitrateRef.current / 1000).toFixed(1)} Mbps) siap! Pasangan akan otomatis menonton begitu masuk ke Room.`
      );
    }
  };

  const startStreamLocalVideoToPartner = () => {
    const vid = videoRef.current as any;
    const canvas = demoCanvasRef.current as any;
    const fps = streamQualityModeRef.current === 'MOTION' ? 60 : 30;
    let captured: MediaStream | null = null;

    if (localVideoUrl && vid) {
      captured = vid.captureStream ? vid.captureStream(fps) : vid.mozCaptureStream?.(fps);
    } else if (canvas) {
      captured = canvas.captureStream ? canvas.captureStream(fps) : null;
    }

    if (captured) {
      pushStreamToConnectedGuest(captured, localVideoUrl ? localVideoName : 'Layar Film Bioskop');
    } else {
      addSystemChat('Browser tidak mendukung captureStream dari video lokal.');
    }
  };

  const startScreenShareToPartner = async () => {
    const fps = streamQualityModeRef.current === 'MOTION' ? 60 : 30;
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 },
          frameRate: { ideal: fps, max: fps },
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
        } as MediaTrackConstraints,
      });

      screenStream.getVideoTracks()[0]?.addEventListener('ended', () => {
        stopLiveStreaming();
      });

      if (prevBlobUrlRef.current) {
        URL.revokeObjectURL(prevBlobUrlRef.current);
        prevBlobUrlRef.current = null;
      }
      setLocalVideoUrl(null);
      if (videoRef.current) {
        videoRef.current.srcObject = screenStream;
        videoRef.current.play().catch(() => {});
      }
      setHasRemoteVideoStream(true);
      setLocalVideoName(`Share Layar / Tab Host (${fps}fps)`);
      pushStreamToConnectedGuest(screenStream, 'Tab / Layar Laptop Host');
    } catch {
      addSystemChat('Share layar dibatalkan oleh pengguna.');
    }
  };

  const stopLiveStreaming = () => {
    outgoingMediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    outgoingMediaStreamRef.current = null;
    activeMediaCallRef.current?.close?.();
    activeMediaCallRef.current = null;
    setIsHostStreaming(false);
    setStreamingSourceLabel('');
    if (hasRemoteVideoStream && role === 'HOST') {
      setHasRemoteVideoStream(false);
      if (videoRef.current) videoRef.current.srcObject = null;
    }
    broadcastRoomPacket({ type: 'STREAM_STOPPED' });
    addSystemChat('Siaran live stream dihentikan.');
  };

  // Loop Demo Ringan (HANYA berjalan saat tidak ada video asli/stream & tidak di-pause, di 4Hz)
  useEffect(() => {
    if (!inRoom || !isPlaying || localVideoUrl || hasRemoteVideoStream) return;

    const interval = window.setInterval(() => {
      const nextHost = (hostTimeRef.current + 0.25) % duration;
      hostTimeRef.current = nextHost;
      clientTimeRef.current = nextHost;
      setHostTime(nextHost);
      setClientTime(nextHost);
    }, 250);

    return () => window.clearInterval(interval);
  }, [inRoom, isPlaying, duration, localVideoUrl, hasRemoteVideoStream]);

  const toggleRealMicrophoneTest = async () => {
    if (liveMicListening) {
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      activeVoiceCallRef.current?.close?.();
      activeVoiceCallRef.current = null;
      setLiveMicListening(false);
      setVoiceConnected(false);
      setIsMicMuted(false);
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;
      setLiveMicListening(true);
      setIsMicMuted(false);

      // Hubungkan voice call P2P ke pasangan jika sudah di dalam room
      if (peerInstanceRef.current) {
        if (roleRef.current === 'GUEST') {
          const sanitizedId = activeRoomCode.replace(/[^A-Z0-9]/g, '');
          placeVoiceCallToPeer(`synctheater-host-${sanitizedId}`);
        } else if (connectedGuestPeerIdRef.current) {
          placeVoiceCallToPeer(connectedGuestPeerIdRef.current);
        }
      }
      appendLog('AUTO_DUCK', 'Mikrofon aktif dengan Echo Cancellation & Voice P2P siap', telemetry.zone);
    } catch {
      setPartnerSpeakingSim((prev) => !prev);
      appendLog('AUTO_DUCK', 'Izin mikrofon tidak tersedia, simulasi auto-ducking diaktifkan', telemetry.zone);
    }
  };

  const toggleMicMute = () => {
    if (!micStreamRef.current) return;
    const nextMuted = !isMicMuted;
    micStreamRef.current.getAudioTracks().forEach((t) => {
      t.enabled = !nextMuted;
    });
    setIsMicMuted(nextMuted);
  };

  // Fungsi Kontrol Play/Pause & Seek yang Menyinkronkan Kedua Layar
  const handleTogglePlayPause = () => {
    const next = !isPlaying;
    setIsPlaying(next);
    setPlayActionFeedback(next ? 'PLAY' : 'PAUSE');
    window.setTimeout(() => setPlayActionFeedback(null), 650);

    const vid = videoRef.current;
    const currentVideoTime = vid && vid.src && !vid.srcObject ? vid.currentTime : clientTimeRef.current;

    if (vid && (vid.src || vid.srcObject)) {
      if (next) {
        vid.play().then(() => setAutoplayBlocked(false)).catch(() => setAutoplayBlocked(true));
      } else {
        vid.pause();
      }
    }

    broadcastRoomPacket({
      type: 'SYNC_ACTION',
      action: next ? 'PLAY' : 'PAUSE',
      videoTime: currentVideoTime,
      sentAt: Date.now(),
    });
    appendLog(next ? 'PLAY' : 'PAUSE', `${nickname} menekan ${next ? 'Play' : 'Pause'}`, telemetry.zone);
  };

  const handleSeekTo = (newTime: number, reasonLabel?: string) => {
    const clamped = Math.max(0, Math.min(duration, newTime));
    hostTimeRef.current = clamped;
    clientTimeRef.current = clamped;
    setHostTime(clamped);
    setClientTime(clamped);
    if (videoRef.current && localVideoUrl) {
      videoRef.current.currentTime = clamped;
    }
    broadcastRoomPacket({
      type: 'SYNC_ACTION',
      action: 'SEEK',
      videoTime: clamped,
      sentAt: Date.now(),
    });
    appendLog('SEEK', reasonLabel || `Durasi digeser ke ${formatTime(clamped)}`, 'HARD_SEEK');
  };

  const triggerEmojiAnimation = (emoji: string, shouldBroadcast = true) => {
    const id = `emo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const leftPercent = 20 + Math.floor(Math.random() * 60);
    setFloatingReactions((prev) => [...prev, { id, emoji, leftPercent }]);
    window.setTimeout(() => {
      setFloatingReactions((prev) => prev.filter((item) => item.id !== id));
    }, 1800);

    if (shouldBroadcast) {
      broadcastRoomPacket({
        type: 'EMOJI_REACTION',
        emoji,
      });
    }
  };

  const handleSendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    const msg: ChatMessage = {
      id: `chat-${Date.now()}`,
      sender: nickname,
      role,
      text: chatInput.trim(),
      time: new Date().toTimeString().slice(0, 5),
    };
    setChatMessages((prev) => [...prev, msg]);
    broadcastRoomPacket({
      type: 'CHAT_MSG',
      message: msg,
    });
    setChatInput('');
  };

  const injectDrift = (offsetSeconds: number) => {
    setClientTime((prev) => {
      const next = Math.max(0, prev - offsetSeconds);
      if (videoRef.current && localVideoUrl) {
        videoRef.current.currentTime = next;
      }
      return next;
    });
    const decision = evaluateThreeZoneCorrection(offsetSeconds, isSoftCorrecting);
    appendLog(
      'HEARTBEAT',
      `Uji selisih ${offsetSeconds > 0 ? '+' : ''}${Math.round(offsetSeconds * 1000)}ms → ${
        decision.zone === 'LOCKED_SYNC'
          ? 'Zona Sinkron (1.00x)'
          : decision.zone === 'SOFT_RATE_ADAPT'
          ? `Koreksi Halus (${decision.playbackRate.toFixed(2)}x)`
          : 'Zona Lompat (Hard Seek)'
      }`,
      decision.zone
    );
  };

  const triggerNtpCalibration = () => {
    const simulatedRtt = Math.floor(11 + Math.random() * 9);
    const simulatedOffset = Math.floor(-5 + Math.random() * 10);
    setTelemetry((prev) => ({
      ...prev,
      rttMs: simulatedRtt,
      oneWayLatencyMs: Math.round(simulatedRtt / 2),
      clockOffsetMs: simulatedOffset,
      samplesCollected: 5,
    }));
    appendLog(
      'NTP_PING',
      `Kalibrasi 5 paket PING selesai: RTT ${simulatedRtt}ms, L=${Math.round(
        simulatedRtt / 2
      )}ms, Offset=${simulatedOffset}ms`,
      telemetry.zone
    );
  };

  const resetHudVisibility = () => {
    setHudVisible(true);
    if (hudTimeoutRef.current) window.clearTimeout(hudTimeoutRef.current);
    hudTimeoutRef.current = window.setTimeout(() => {
      if (isPlaying) setHudVisible(false);
    }, 3200);
  };

  const copyCommand = (id: string, text: string) => {
    try {
      navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedCmd(id);
    window.setTimeout(() => setCopiedCmd(null), 1800);
  };

  const formatTime = (sec: number) => {
    if (!Number.isFinite(sec) || sec < 0) return 'LIVE';
    const mins = Math.floor(sec / 60);
    const secs = Math.floor(sec % 60);
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const activeSubtitleCue =
    subtitlesEnabled &&
    parsedCues.find((c) => clientTime >= c.start && clientTime <= c.end);

  const driftMs = Math.round(telemetry.driftSeconds * 1000);

  return (
    <div className="min-h-screen bg-[#09090B] text-zinc-100 flex flex-col font-sans">
      {/* =====================================================================
          HEADER UTAMA: PEMISAHAN JELAS "MODE PAKAI NOBAR" VS "MODE PENGUJIAN"
         ===================================================================== */}
      <header className="border-b border-zinc-800/90 bg-[#18181B]/90 backdrop-blur-md px-4 lg:px-6 py-3 flex flex-wrap items-center justify-between gap-3 sticky top-0 z-30">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-600/30">
            <Tv className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-sm font-bold tracking-tight text-white">
                SyncTheater
              </h1>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-medium">
                Siap Pakai • Room ID P2P
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">
              Nobar Film Anti-Lag & Voice Chat Auto-Ducking Bersama Pasangan
            </p>
          </div>
        </div>

        {/* Switcher Utama: Mode Pakai Nobar vs Mode Pengujian & Deploy */}
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-zinc-900 p-1 rounded-xl border border-zinc-800">
            <button
              type="button"
              onClick={() => setAppMode('USER_APP')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                appMode === 'USER_APP'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Film className="w-3.5 h-3.5" />
              <span>Aplikasi Nobar (Tinggal Pakai)</span>
            </button>

            <button
              type="button"
              onClick={() => setAppMode('DEV_LAB')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition flex items-center gap-1.5 ${
                appMode === 'DEV_LAB'
                  ? 'bg-amber-600 text-white shadow'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Wrench className="w-3.5 h-3.5" />
              <span>Mode Pengujian & Panduan GitHub</span>
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowQuickGuideModal(true)}
            className="p-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-300 transition"
            title="Cara Pakai Singkat"
          >
            <HelpCircle className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* =====================================================================
          BAGIAN 1: MODE PENGGUNAAN UTAMA ("TINGGAL PAKAI")
         ===================================================================== */}
      {appMode === 'USER_APP' && (
        <main className="flex-1 max-w-7xl w-full mx-auto p-4 lg:p-6">
          {!inRoom ? (
            /* ----------------------------------------------------------------
               TAMPILAN LOBBY: BUAT ROOM ID ATAU GABUNG ROOM ID PASANGAN
               ---------------------------------------------------------------- */
            <div className="max-w-4xl mx-auto space-y-6 py-4">
              <div className="text-center space-y-2">
                <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-500/15 border border-indigo-500/30 text-indigo-300 text-xs font-medium">
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Tanpa Instalasi Rumit • Cukup Buat Kode Room & Bagikan ke Pasangan</span>
                </span>
                <h2 className="text-2xl sm:text-3xl font-bold text-white tracking-tight">
                  Mau Mulai Nobar Sekarang?
                </h2>
                <p className="text-sm text-zinc-400 max-w-xl mx-auto">
                  Pilih <strong className="text-zinc-200">Buat Room Baru</strong> jika kamu yang memutar film, atau pilih <strong className="text-zinc-200">Masuk ke Room</strong> jika pasanganmu sudah mengirimkan Kode Room.
                </p>
              </div>

              {/* Dua Kartu Utama: Buat Room (Host) vs Gabung Room (Guest) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* KARTU 1: BUAT ROOM (HOST) */}
                <div className="rounded-2xl border border-indigo-500/40 bg-gradient-to-b from-indigo-950/30 to-[#18181B] p-6 flex flex-col justify-between space-y-5 shadow-xl">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="px-2.5 py-1 rounded-md bg-indigo-600/20 border border-indigo-500/40 text-indigo-300 text-xs font-semibold">
                        Langkah 1 • Untuk Surya (Host)
                      </span>
                      <Film className="w-5 h-5 text-indigo-400" />
                    </div>

                    <div>
                      <h3 className="text-lg font-bold text-white">
                        Buat Room Bioskop Baru
                      </h3>
                      <p className="text-xs text-zinc-400 mt-1">
                        Kamu yang memilih file film dari laptop/HP dan mengatur jalannya pemutaran.
                      </p>
                    </div>

                    <div className="space-y-3 pt-1">
                      <div>
                        <label className="block text-xs font-medium text-zinc-300 mb-1">
                          Nama Panggilanmu
                        </label>
                        <input
                          type="text"
                          value={hostNicknameInput}
                          onChange={(e) => setHostNicknameInput(e.target.value)}
                          placeholder="Contoh: Surya"
                          className="w-full px-3.5 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-sm text-white focus:outline-none focus:border-indigo-500"
                        />
                      </div>

                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <label className="text-xs font-medium text-zinc-300">
                            Buat Kode Room (Bebas / Mudah Diingat)
                          </label>
                          <button
                            type="button"
                            onClick={() =>
                              setRoomCodeInput(
                                `NOBAR-${Math.floor(1000 + Math.random() * 9000)}`
                              )
                            }
                            className="text-[11px] text-indigo-400 hover:text-indigo-300"
                          >
                            Acak Kode
                          </button>
                        </div>
                        <input
                          type="text"
                          value={roomCodeInput}
                          onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                          placeholder="Contoh: SURYA-ADEK"
                          className="w-full px-3.5 py-2 rounded-xl bg-zinc-900 border border-indigo-500/50 font-mono text-base font-bold text-indigo-300 tracking-wider uppercase focus:outline-none focus:border-indigo-400"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                          Pilih Film Awal (Bisa Diganti Nanti di Dalam Room)
                        </label>
                        <label className="cursor-pointer flex items-center justify-center gap-2 w-full py-2.5 px-3 rounded-xl border border-dashed border-zinc-700 hover:border-indigo-400 bg-zinc-900/90 hover:bg-indigo-500/10 text-xs font-medium text-zinc-200 transition">
                          <FolderOpen className="w-4 h-4 text-indigo-400" />
                          <span className="truncate">
                            {localVideoUrl
                              ? `Terpilih: ${localVideoName}`
                              : 'Pilih File Film (.MP4 / .WebM) dari Perangkat'}
                          </span>
                          <input
                            type="file"
                            accept="video/mp4,video/webm,video/x-matroska"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) {
                                selectVideoSource(URL.createObjectURL(f), f.name);
                              }
                            }}
                          />
                        </label>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => connectToRoom(roomCodeInput, 'HOST', hostNicknameInput.trim() || 'Surya')}
                    className="w-full py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-sm shadow-lg shadow-indigo-600/25 transition flex items-center justify-center gap-2"
                  >
                    <span>Buat Room & Masuk Bioskop</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>

                {/* KARTU 2: GABUNG ROOM (GUEST / PASANGAN) */}
                <div className="rounded-2xl border border-zinc-800 bg-[#18181B] p-6 flex flex-col justify-between space-y-5 shadow-xl">
                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <span className="px-2.5 py-1 rounded-md bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-semibold">
                        Langkah 2 • Untuk Pasangan (Guest)
                      </span>
                      <Users className="w-5 h-5 text-emerald-400" />
                    </div>

                    <div>
                      <h3 className="text-lg font-bold text-white">
                        Masuk ke Room Pasangan
                      </h3>
                      <p className="text-xs text-zinc-400 mt-1">
                        Tinggal ketik Kode Room yang dikirim pasanganmu untuk langsung menonton bareng.
                      </p>
                    </div>

                    <div className="space-y-3 pt-1">
                      <div>
                        <label className="block text-xs font-medium text-zinc-300 mb-1">
                          Nama Panggilanmu
                        </label>
                        <input
                          type="text"
                          value={guestNicknameInput}
                          onChange={(e) => setGuestNicknameInput(e.target.value)}
                          placeholder="Contoh: Adek"
                          className="w-full px-3.5 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-sm text-white focus:outline-none focus:border-emerald-500"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-zinc-300 mb-1">
                          Masukkan Kode Room dari Pasangan
                        </label>
                        <input
                          type="text"
                          value={joinCodeInput}
                          onChange={(e) => setJoinCodeInput(e.target.value.toUpperCase())}
                          placeholder="Ketik Kode Room (misal: SURYA-ADEK)"
                          className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-emerald-500/50 font-mono text-base font-bold text-emerald-300 tracking-wider uppercase focus:outline-none focus:border-emerald-400"
                        />
                      </div>

                      <div className="p-3 rounded-xl bg-zinc-900/70 border border-zinc-800 text-xs text-zinc-400 space-y-1">
                        <div className="font-semibold text-zinc-200">
                          Tips Kalau Nonton File Film Lokal:
                        </div>
                        <p className="text-[11px] leading-relaxed">
                          Kamu bisa memutar file film yang sama di perangkatmu agar kualitasnya 1080p murni tanpa kuota upload besar, atau langsung menonton layar yang dibagikan oleh Host.
                        </p>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => connectToRoom(joinCodeInput, 'GUEST', guestNicknameInput.trim() || 'Adek')}
                    className="w-full py-3 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm shadow-lg shadow-emerald-600/25 transition flex items-center justify-center gap-2"
                  >
                    <span>Gabung ke Room Sekarang</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Ringkasan Jawaban Arsitektur: Bisa Deploy GitHub Pages Langsung! */}
              <div className="rounded-2xl border border-zinc-800 bg-[#18181B]/90 p-5 grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div className="space-y-1">
                  <div className="font-bold text-indigo-400 flex items-center gap-1.5">
                    <Globe className="w-4 h-4" />
                    <span>1. Apakah Bisa Deploy di GitHub Pages?</span>
                  </div>
                  <p className="text-zinc-400 leading-relaxed">
                    <strong className="text-zinc-200">Bisa langsung!</strong> Aplikasi ini sudah dilengkapi jembatan <strong className="text-zinc-200">PeerJS Cloud WebRTC Broker</strong> gratis, sehingga setelah di-deploy ke GitHub Pages, kamu tinggal buat Kode Room dan pasanganmu langsung masuk tanpa sewa VPS.
                  </p>
                </div>

                <div className="space-y-1">
                  <div className="font-bold text-emerald-400 flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4" />
                    <span>2. Server Pakai Apa?</span>
                  </div>
                  <p className="text-zinc-400 leading-relaxed">
                    Untuk menghubungkan Kode Room & Voice Chat, aplikasi memakai <strong className="text-zinc-200">PeerJS Public Broker (0.peerjs.com)</strong> secara otomatis. Jika ingin streaming file film berukuran sangat besar (&gt;4 GB) langsung dari laptop, tersedia juga server <strong className="text-zinc-200">Go Single-Binary</strong> di dalam ZIP.
                  </p>
                </div>

                <div className="space-y-1">
                  <div className="font-bold text-amber-400 flex items-center gap-1.5">
                    <Columns className="w-4 h-4" />
                    <span>3. Mau Coba Sendiri Sekarang?</span>
                  </div>
                  <p className="text-zinc-400 leading-relaxed">
                    Klik <strong className="text-zinc-200">Buat Room & Masuk Bioskop</strong> di atas, lalu aktifkan tombol <strong className="text-zinc-200">Lihat Layar Pasangan (Split View)</strong> di dalam room untuk melihat langsung kedua layar berjalan serentak!
                  </p>
                </div>
              </div>
            </div>
          ) : (
            /* ----------------------------------------------------------------
               TAMPILAN RUANG BIOSKOP AKTIF (BERSIH, INTERAKTIF, TINGGAL PAKAI)
               ---------------------------------------------------------------- */
            <div className="space-y-4">
              {/* Bar Informasi Room Aktif & Tombol Undang Pasangan */}
              <div className="rounded-2xl border border-zinc-800 bg-[#18181B] p-3.5 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-indigo-600/15 border border-indigo-500/40">
                    <span className="text-xs text-zinc-400">Kode Room:</span>
                    <span className="font-mono font-bold text-sm text-indigo-300 tracking-wider">
                      {activeRoomCode}
                    </span>
                    <button
                      type="button"
                      onClick={() => copyCommand('copy-room', activeRoomCode)}
                      className="ml-1 px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-[11px] font-medium text-white flex items-center gap-1 transition"
                    >
                      {copiedCmd === 'copy-room' ? (
                        <>
                          <Check className="w-3 h-3" />
                          <span>Disalin!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          <span>Salin Kode</span>
                        </>
                      )}
                    </button>
                  </div>

                  <div className="flex items-center gap-2 text-xs text-zinc-300">
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${
                        p2pStatus === 'ERROR'
                          ? 'bg-rose-500'
                          : p2pStatus === 'CONNECTING'
                          ? 'bg-amber-400 animate-pulse'
                          : 'bg-emerald-400 animate-pulse'
                      }`}
                    />
                    <span>
                      Masuk sebagai <strong>{nickname} ({role})</strong> • {connectedPartnerName}
                    </span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {/* Tombol Simulasi Layar Kembar agar Surya bisa langsung melihat 2 layar tersinkronisasi */}
                  <button
                    type="button"
                    onClick={() => setShowSplitGuestPreview((s) => !s)}
                    className={`px-3 py-1.5 rounded-xl border text-xs font-semibold transition flex items-center gap-1.5 ${
                      showSplitGuestPreview
                        ? 'border-amber-500 bg-amber-500/20 text-amber-300'
                        : 'border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200'
                    }`}
                  >
                    <Columns className="w-3.5 h-3.5" />
                    <span>
                      {showSplitGuestPreview
                        ? 'Tutup Layar Kembar Pasangan'
                        : 'Lihat Layar Pasangan (Split View)'}
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setShowMediaModal(true)}
                    className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition flex items-center gap-1.5"
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span>Ganti Film / Subtitle</span>
                  </button>

                  <button
                    type="button"
                    onClick={leaveRoom}
                    className="px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-rose-500/20 border border-zinc-700 hover:border-rose-500/40 text-zinc-300 hover:text-rose-300 text-xs font-medium transition flex items-center gap-1"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>Keluar Room</span>
                  </button>
                </div>
              </div>

              {peerErrorMsg && (
                <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-200 flex items-center justify-between">
                  <span>⚠️ {peerErrorMsg}</span>
                  <button
                    type="button"
                    onClick={() => connectToRoom(activeRoomCode, role, nickname)}
                    className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold text-[11px]"
                  >
                    Coba Hubungkan Ulang
                  </button>
                </div>
              )}

              {/* Audio tersembunyi untuk menerima suara Voice Chat P2P pasangan */}
              <audio ref={remoteVoiceAudioRef} autoPlay playsInline className="hidden" />

              {/* Grid Bioskop: Layar Video (Kiri) + Voice & Chat Pasangan (Kanan) */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                <div className="lg:col-span-8 space-y-4">
                  {/* Panggung Video Utama (+ Opsi Split View Layar Pasangan) */}
                  <div
                    className={`grid gap-4 ${
                      showSplitGuestPreview ? 'grid-cols-1 md:grid-cols-2' : 'grid-cols-1'
                    }`}
                  >
                    {/* LAYAR 1: LAYAR UTAMA KAMU */}
                    <div
                      ref={stageContainerRef}
                      onMouseMove={resetHudVisibility}
                      className="relative w-full aspect-video rounded-2xl overflow-hidden bg-black border border-zinc-800 shadow-2xl select-none group"
                    >
                      {localVideoUrl || hasRemoteVideoStream ? (
                        <video
                          ref={videoRef}
                          src={localVideoUrl || undefined}
                          onClick={handleTogglePlayPause}
                          className="w-full h-full object-contain bg-black cursor-pointer"
                          autoPlay
                          playsInline
                          onTimeUpdate={() => {
                            if (videoRef.current) {
                              const t = videoRef.current.currentTime;
                              clientTimeRef.current = t;
                              hostTimeRef.current = t;
                              setClientTime(t);
                              setHostTime(t);
                            }
                          }}
                          onLoadedMetadata={() => {
                            if (
                              videoRef.current &&
                              Number.isFinite(videoRef.current.duration) &&
                              videoRef.current.duration > 0
                            ) {
                              setDuration(videoRef.current.duration);
                            }
                          }}
                        />
                      ) : (
                        <DemoCanvas
                          canvasRef={demoCanvasRef}
                          timeRef={hostTimeRef}
                          isPlaying={isPlaying}
                          label={`Layar ${nickname} (${role})`}
                          onClick={handleTogglePlayPause}
                          className="w-full h-full object-cover cursor-pointer"
                        />
                      )}

                      {/* Tombol Buka Blokir Autoplay Browser HP (Khusus Guest penerima Live Stream) */}
                      {autoplayBlocked && hasRemoteVideoStream && (
                        <div className="absolute inset-0 z-20 bg-black/80 backdrop-blur-sm flex flex-col items-center justify-center p-4 text-center space-y-3">
                          <p className="text-xs sm:text-sm text-zinc-200 max-w-xs">
                            Browser HP menahan putar otomatis bersuara. Ketuk tombol di bawah untuk menampilkan film dari Host:
                          </p>
                          <button
                            type="button"
                            onClick={() => {
                              if (videoRef.current) {
                                videoRef.current.muted = false;
                                videoRef.current.play().then(() => {
                                  setAutoplayBlocked(false);
                                  setIsPlaying(true);
                                }).catch(() => {
                                  if (videoRef.current) {
                                    videoRef.current.muted = true;
                                    videoRef.current.play().catch(() => {});
                                    setAutoplayBlocked(false);
                                  }
                                });
                              }
                            }}
                            className="px-5 py-3 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-sm shadow-xl flex items-center gap-2 transition"
                          >
                            <Play className="w-5 h-5" />
                            <span>Ketuk untuk Putar Siaran Film</span>
                          </button>
                        </div>
                      )}

                      {/* Animasi Ikon Klik Play/Pause di Tengah Layar */}
                      {playActionFeedback && (
                        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                          <div className="w-16 h-16 rounded-full bg-indigo-600/85 text-white flex items-center justify-center shadow-2xl animate-ping">
                            {playActionFeedback === 'PLAY' ? (
                              <Play className="w-8 h-8 ml-1" />
                            ) : (
                              <Pause className="w-8 h-8" />
                            )}
                          </div>
                        </div>
                      )}

                      {/* Reaksi Emoji Melayang */}
                      <div className="absolute inset-0 pointer-events-none overflow-hidden">
                        {floatingReactions.map((r) => (
                          <div
                            key={r.id}
                            style={{ left: `${r.leftPercent}%` }}
                            className="absolute bottom-20 text-3xl animate-bounce transition-all duration-1000"
                          >
                            {r.emoji}
                          </div>
                        ))}
                      </div>

                      {/* Overlay Subtitle */}
                      {activeSubtitleCue && (
                        <div className="absolute bottom-20 inset-x-6 flex justify-center pointer-events-none">
                          <div className="px-4 py-1.5 rounded-lg bg-black/85 border border-zinc-700/70 text-zinc-100 text-xs sm:text-sm font-medium text-center shadow-lg">
                            {activeSubtitleCue.text}
                          </div>
                        </div>
                      )}

                      {/* Status Sinkronisasi Sederhana di Pojok Atas */}
                      <div
                        className={`absolute top-3 left-3 right-3 flex items-center justify-between pointer-events-none transition-opacity duration-300 ${
                          hudVisible ? 'opacity-100' : 'opacity-0'
                        }`}
                      >
                        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-black/75 backdrop-blur-md border border-zinc-700/70 text-[11px]">
                          <span className="w-2 h-2 rounded-full bg-emerald-400" />
                          <span className="font-medium text-zinc-200">
                            Sinkron Otomatis ({telemetry.activePlaybackRate.toFixed(2)}x)
                          </span>
                        </div>

                        {isDucked && (
                          <div className="px-3 py-1 rounded-full bg-amber-500/90 text-black font-bold text-[11px] shadow">
                            Suara Film Dikecilkan 30% (Sedang Ngobrol)
                          </div>
                        )}
                      </div>

                      {/* Kontrol Video Bawah yang Bersih & Intuitif */}
                      <div
                        className={`absolute bottom-0 inset-x-0 p-3 bg-gradient-to-t from-black/95 via-black/70 to-transparent transition-opacity duration-300 ${
                          hudVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
                        }`}
                      >
                        <div className="space-y-2">
                          <input
                            type="range"
                            min={0}
                            max={duration}
                            step={0.1}
                            value={clientTime}
                            onChange={(e) => handleSeekTo(parseFloat(e.target.value))}
                            className="w-full accent-indigo-500 h-1.5 bg-zinc-700 rounded-lg cursor-pointer"
                          />

                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={handleTogglePlayPause}
                                className="p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white transition"
                              >
                                {isPlaying ? (
                                  <Pause className="w-4 h-4" />
                                ) : (
                                  <Play className="w-4 h-4" />
                                )}
                              </button>

                              <button
                                type="button"
                                onClick={() => handleSeekTo(clientTime - 5, 'Mundur 5 detik')}
                                className="p-2 rounded-lg bg-zinc-800/90 hover:bg-zinc-700 text-zinc-200 transition"
                                title="Mundur 5 detik"
                              >
                                <RotateCcw className="w-4 h-4" />
                              </button>

                              <button
                                type="button"
                                onClick={() => handleSeekTo(clientTime + 5, 'Maju 5 detik')}
                                className="p-2 rounded-lg bg-zinc-800/90 hover:bg-zinc-700 text-zinc-200 transition"
                                title="Maju 5 detik"
                              >
                                <RotateCw className="w-4 h-4" />
                              </button>

                              <span className="text-xs font-mono text-zinc-200 ml-1">
                                {hasRemoteVideoStream && !localVideoUrl
                                  ? `${formatTime(clientTime)} • LIVE STREAM`
                                  : `${formatTime(clientTime)} / ${formatTime(duration)}`}
                              </span>
                            </div>

                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => setSubtitlesEnabled((s) => !s)}
                                className={`px-2 py-1 rounded text-[11px] font-medium border transition ${
                                  subtitlesEnabled
                                    ? 'border-indigo-500/50 bg-indigo-500/20 text-indigo-200'
                                    : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                                }`}
                              >
                                CC {subtitlesEnabled ? 'ON' : 'OFF'}
                              </button>

                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setIsVideoMuted((m) => !m)}
                                  className="text-zinc-200 hover:text-white"
                                >
                                  {isVideoMuted || effectiveVolume === 0 ? (
                                    <VolumeX className="w-4 h-4 text-rose-400" />
                                  ) : (
                                    <Volume2 className="w-4 h-4 text-indigo-400" />
                                  )}
                                </button>
                                <input
                                  type="range"
                                  min={0}
                                  max={1}
                                  step={0.02}
                                  value={isVideoMuted ? 0 : baseVolume}
                                  onChange={(e) => {
                                    const v = parseFloat(e.target.value);
                                    setBaseVolume(v);
                                    setIsVideoMuted(v === 0);
                                  }}
                                  className="w-16 accent-indigo-500 h-1 bg-zinc-700 rounded-lg cursor-pointer"
                                />
                              </div>

                              <button
                                type="button"
                                onClick={() => {
                                  if (!document.fullscreenElement) {
                                    stageContainerRef.current?.requestFullscreen().catch(() => {});
                                  } else {
                                    document.exitFullscreen().catch(() => {});
                                  }
                                }}
                                className="p-1.5 rounded-lg bg-zinc-800/90 hover:bg-zinc-700 text-zinc-200 transition"
                                title="Layar Penuh"
                              >
                                <Maximize2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* LAYAR 2 (OPSIONAL): SIMULASI LAYAR PASANGAN BERDAMPINGAN */}
                    {showSplitGuestPreview && (
                      <div className="relative w-full aspect-video rounded-2xl overflow-hidden bg-black border-2 border-amber-500/50 shadow-2xl flex flex-col justify-between">
                        <DemoCanvas
                          canvasRef={guestCanvasRef}
                          timeRef={clientTimeRef}
                          isPlaying={isPlaying}
                          label={`Layar Pasangan (${telemetry.activePlaybackRate.toFixed(2)}x)`}
                          className="w-full h-full object-cover"
                        />
                        {activeSubtitleCue && (
                          <div className="absolute bottom-14 inset-x-4 flex justify-center pointer-events-none">
                            <div className="px-3 py-1 rounded bg-black/80 text-zinc-100 text-xs text-center">
                              {activeSubtitleCue.text}
                            </div>
                          </div>
                        )}
                        <div className="absolute bottom-3 inset-x-3 px-3 py-2 rounded-xl bg-black/85 border border-amber-500/40 flex items-center justify-between text-xs">
                          <span className="text-amber-300 font-semibold">
                            Layar Pasangan (Otomatis Mengikuti Host)
                          </span>
                          <span className="font-mono text-zinc-300">
                            {formatTime(clientTime)} • {isPlaying ? 'PLAYING' : 'PAUSED'}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Bar Bawah Video: Reaksi Emoji Cepat & Pintasan Ganti Film */}
                  <div className="rounded-2xl border border-zinc-800 bg-[#18181B] p-3.5 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-zinc-400">
                        Kirim Reaksi ke Layar:
                      </span>
                      {['❤️', '😂', '😱', '🥺', '🔥', '🍿'].map((emo) => (
                        <button
                          key={emo}
                          type="button"
                          onClick={() => triggerEmojiAnimation(emo, true)}
                          className="w-9 h-9 rounded-xl bg-zinc-900 hover:bg-indigo-600/20 border border-zinc-800 hover:border-indigo-500/40 text-base flex items-center justify-center transition transform active:scale-90"
                        >
                          {emo}
                        </button>
                      ))}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {/* Pengaturan Bitrate & Anti-Burik WebRTC */}
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setShowBitrateSettings((v) => !v)}
                          className={`px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition border ${
                            streamBitrateKbps >= 4500
                              ? 'bg-amber-500/15 border-amber-500/40 text-amber-300 hover:bg-amber-500/25'
                              : 'bg-zinc-900 border-zinc-700 text-zinc-300 hover:bg-zinc-800'
                          }`}
                          title="Atur Bitrate WebRTC (4-5 Mbps) & Mode Anti-Burik"
                        >
                          <Zap className="w-3.5 h-3.5 text-amber-400" />
                          <span>
                            {(streamBitrateKbps / 1000).toFixed(1)} Mbps (
                            {streamQualityMode === 'BALANCED'
                              ? 'Anti-Lag'
                              : streamQualityMode === 'SHARP'
                              ? 'Anti-Burik'
                              : '60 FPS'}
                            )
                          </span>
                          <Sliders className="w-3 h-3 opacity-60" />
                        </button>

                        {showBitrateSettings && (
                          <div className="absolute bottom-full right-0 mb-2 w-80 rounded-2xl bg-[#18181B] border border-zinc-700/80 shadow-2xl p-4 z-50 space-y-3.5 text-xs">
                            <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
                              <div className="flex items-center gap-1.5">
                                <Zap className="w-4 h-4 text-amber-400" />
                                <span className="font-bold text-white">Kualitas & Bitrate WebRTC</span>
                              </div>
                              <button
                                type="button"
                                onClick={() => setShowBitrateSettings(false)}
                                className="text-[11px] text-zinc-400 hover:text-white"
                              >
                                Tutup
                              </button>
                            </div>

                            <div className="space-y-1.5">
                              <label className="text-[11px] font-medium text-zinc-400">
                                Target Bitrate Video:
                              </label>
                              <div className="grid grid-cols-2 gap-1.5">
                                {[
                                  { label: '3.0 Mbps (Anti-Lag)', kbps: 3000, desc: 'Rekomendasi Lancar 30fps' },
                                  { label: '5.0 Mbps (Tajam)', kbps: 5000, desc: 'Full HD Wi-Fi Cepat' },
                                  { label: '1.8 Mbps (Hemat)', kbps: 1800, desc: 'Untuk Jaringan Seluler' },
                                  { label: '8.0 Mbps (Ultra)', kbps: 8000, desc: 'Kualitas Max LAN/Fiber' },
                                ].map((item) => (
                                  <button
                                    key={item.kbps}
                                    type="button"
                                    onClick={() => changeStreamBitrate(item.kbps)}
                                    className={`p-2 rounded-xl text-left border transition ${
                                      streamBitrateKbps === item.kbps
                                        ? 'bg-amber-500/20 border-amber-500/60 text-amber-200 font-semibold'
                                        : 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:bg-zinc-850'
                                    }`}
                                  >
                                    <div className="text-[11px] font-bold">{item.label}</div>
                                    <div className="text-[10px] text-zinc-400">{item.desc}</div>
                                  </button>
                                ))}
                              </div>
                            </div>

                            <div className="space-y-1.5">
                              <label className="text-[11px] font-medium text-zinc-400">
                                Prioritas Mode Degradasi:
                              </label>
                              <div className="grid grid-cols-3 gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => changeQualityMode('BALANCED')}
                                  className={`p-2 rounded-xl text-left border transition ${
                                    streamQualityMode === 'BALANCED'
                                      ? 'bg-emerald-600/25 border-emerald-500/60 text-emerald-200 font-semibold'
                                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                                  }`}
                                >
                                  <div className="text-[11px] font-bold">⚡ Anti-Lag</div>
                                  <div className="text-[10px] text-zinc-400">Adaptif 30fps</div>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => changeQualityMode('SHARP')}
                                  className={`p-2 rounded-xl text-left border transition ${
                                    streamQualityMode === 'SHARP'
                                      ? 'bg-indigo-600/25 border-indigo-500/60 text-indigo-200 font-semibold'
                                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                                  }`}
                                >
                                  <div className="text-[11px] font-bold">🎬 Tajam</div>
                                  <div className="text-[10px] text-zinc-400">Kunci 1080p</div>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => changeQualityMode('MOTION')}
                                  className={`p-2 rounded-xl text-left border transition ${
                                    streamQualityMode === 'MOTION'
                                      ? 'bg-amber-600/25 border-amber-500/60 text-amber-200 font-semibold'
                                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                                  }`}
                                >
                                  <div className="text-[11px] font-bold">🏃 60 FPS</div>
                                  <div className="text-[10px] text-zinc-400">Super mulus</div>
                                </button>
                              </div>
                            </div>

                            <div className="p-2.5 rounded-xl bg-zinc-950 border border-zinc-850 text-[10px] text-zinc-400 leading-relaxed">
                              💡 <strong>Tips Anti-Lag:</strong> Mode <strong>Anti-Lag (3.0 Mbps / 30fps)</strong> jauh lebih ringan di CPU & Wi-Fi. Jika punya file film yang sama di kedua perangkat, pakai <strong>Pilih File .MP4</strong> agar kualitas 100% asli 0 lag!
                            </div>
                          </div>
                        )}
                      </div>

                      {role === 'HOST' && (
                        <>
                          {isHostStreaming ? (
                            <button
                              type="button"
                              onClick={stopLiveStreaming}
                              className="px-3 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold flex items-center gap-1.5 transition shadow"
                            >
                              <Radio className="w-3.5 h-3.5 animate-pulse" />
                              <span>Hentikan Stream ({streamingSourceLabel || 'Live'})</span>
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={startStreamLocalVideoToPartner}
                                className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold flex items-center gap-1.5 transition shadow"
                              >
                                <Radio className="w-3.5 h-3.5" />
                                <span>Stream Film Ini ke Pasangan</span>
                              </button>
                              <button
                                type="button"
                                onClick={startScreenShareToPartner}
                                className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center gap-1.5 transition shadow"
                              >
                                <MonitorUp className="w-3.5 h-3.5" />
                                <span>Share Tab / Layar</span>
                              </button>
                            </>
                          )}
                        </>
                      )}

                      <label className="cursor-pointer px-3 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1.5 transition">
                        <Film className="w-3.5 h-3.5 text-indigo-400" />
                        <span>Pilih File .MP4</span>
                        <input
                          type="file"
                          accept="video/mp4,video/webm,video/x-matroska"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) {
                              selectVideoSource(URL.createObjectURL(f), f.name);
                              addSystemChat(`${nickname} mengganti film ke: ${f.name}`);
                            }
                          }}
                        />
                      </label>

                      <label className="cursor-pointer px-3 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1.5 transition">
                        <Subtitles className="w-3.5 h-3.5 text-emerald-400" />
                        <span>Pasang Subtitle .SRT</span>
                        <input
                          type="file"
                          accept=".srt,.vtt"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            const reader = new FileReader();
                            reader.onload = () => {
                              setSrtRawText(String(reader.result || ''));
                              setSubtitleFileName(f.name);
                              setSubtitlesEnabled(true);
                              addSystemChat(`Subtitle ${f.name} berhasil dipasang!`);
                            };
                            reader.readAsText(f, 'utf-8');
                          }}
                        />
                      </label>
                    </div>
                  </div>
                </div>

                {/* Kolom Kanan: Voice Chat Auto-Ducking & Obrolan Chat Room */}
                <div className="lg:col-span-4 flex flex-col gap-4">
                  {/* KARTU KONTROL SUARA & AUTO-DUCKING */}
                  <div className="rounded-2xl border border-zinc-800 bg-[#18181B] p-4 space-y-3.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-2.5 h-2.5 rounded-full ${
                            voiceConnected
                              ? 'bg-emerald-400 animate-pulse'
                              : liveMicListening
                              ? 'bg-amber-400 animate-pulse'
                              : 'bg-zinc-600'
                          }`}
                        />
                        <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-200">
                          Voice Chat & Auto-Ducking
                        </h3>
                      </div>
                      <span className="text-[11px] text-emerald-400 font-medium">
                        {voiceConnected ? 'Voice P2P Terhubung' : 'Anti-Gema Aktif'}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={toggleRealMicrophoneTest}
                        className={`py-2.5 px-3 rounded-xl border text-xs font-semibold transition flex items-center justify-center gap-1.5 ${
                          liveMicListening
                            ? 'border-emerald-500 bg-emerald-500/20 text-emerald-200'
                            : 'border-indigo-500/40 bg-indigo-600 hover:bg-indigo-500 text-white'
                        }`}
                      >
                        <Mic className="w-4 h-4" />
                        <span>{liveMicListening ? 'Matikan Mic' : 'Aktifkan Mic Saya'}</span>
                      </button>

                      {liveMicListening ? (
                        <button
                          type="button"
                          onClick={toggleMicMute}
                          className={`py-2.5 px-3 rounded-xl border text-xs font-semibold transition flex items-center justify-center gap-1.5 ${
                            isMicMuted
                              ? 'border-rose-500 bg-rose-500/20 text-rose-200'
                              : 'border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200'
                          }`}
                        >
                          {isMicMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                          <span>{isMicMuted ? 'Mic Di-Mute' : 'Mute Mic'}</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPartnerSpeakingSim((s) => !s)}
                          className={`py-2.5 px-3 rounded-xl border text-xs font-semibold transition flex items-center justify-center gap-1.5 ${
                            partnerSpeakingSim
                              ? 'border-amber-500 bg-amber-500/20 text-amber-300'
                              : 'border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200'
                          }`}
                        >
                          <Radio className="w-4 h-4" />
                          <span>
                            {partnerSpeakingSim ? 'Pasangan Bicara...' : 'Coba Efek Ngobrol'}
                          </span>
                        </button>
                      )}
                    </div>

                    <div className="flex items-center justify-between pt-1">
                      <span className="text-xs text-zinc-300">
                        Kecilkan volume film saat bicara:
                      </span>
                      <button
                        type="button"
                        onClick={() => setAutoDuckEnabled((d) => !d)}
                        className={`px-3 py-1 rounded-lg text-xs font-semibold border transition ${
                          autoDuckEnabled
                            ? 'border-indigo-500/40 bg-indigo-500/20 text-indigo-300'
                            : 'border-zinc-700 bg-zinc-900 text-zinc-400'
                        }`}
                      >
                        {autoDuckEnabled ? 'AKTIF (-30%)' : 'MATI'}
                      </button>
                    </div>

                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-zinc-400">Indikator Suara Pasangan:</span>
                        <span
                          className={`font-mono font-semibold ${
                            isDucked ? 'text-amber-400' : 'text-emerald-400'
                          }`}
                        >
                          Volume Film: {Math.round(effectiveVolume * 100)}%
                        </span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-zinc-900 overflow-hidden border border-zinc-800">
                        <div
                          ref={rmsBarRef}
                          className={`h-full transition-all duration-75 ${
                            isDucked ? 'bg-amber-400' : 'bg-indigo-500'
                          }`}
                          style={{ width: '0%' }}
                        />
                      </div>
                    </div>
                  </div>

                  {/* KARTU OBROLAN CHAT BIOSKOP */}
                  <div className="rounded-2xl border border-zinc-800 bg-[#18181B] p-4 flex-1 flex flex-col justify-between min-h-[270px]">
                    <div className="flex items-center justify-between border-b border-zinc-800 pb-2.5">
                      <div className="flex items-center gap-2">
                        <MessageSquare className="w-4 h-4 text-indigo-400" />
                        <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-200">
                          Chat Room ({activeRoomCode})
                        </h3>
                      </div>
                      <span className="text-[11px] text-zinc-400">Real-Time P2P</span>
                    </div>

                    <div className="flex-1 overflow-y-auto space-y-2.5 my-3 pr-1 max-h-56">
                      {chatMessages.map((m) => (
                        <div
                          key={m.id}
                          className={`p-2.5 rounded-xl text-xs ${
                            m.role === 'SYSTEM'
                              ? 'bg-zinc-900/90 border border-zinc-800 text-zinc-400'
                              : m.sender === nickname
                              ? 'bg-indigo-600/20 border border-indigo-500/30 text-zinc-100 ml-4'
                              : 'bg-emerald-600/15 border border-emerald-500/30 text-zinc-100 mr-4'
                          }`}
                        >
                          <div className="flex items-center justify-between text-[10px] text-zinc-400 mb-0.5">
                            <span className="font-semibold text-zinc-300">{m.sender}</span>
                            <span>{m.time}</span>
                          </div>
                          <p className="leading-relaxed">{m.text}</p>
                        </div>
                      ))}
                    </div>

                    <form onSubmit={handleSendChat} className="flex gap-2">
                      <input
                        type="text"
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        placeholder="Ketik pesan ke pasangan..."
                        className="flex-1 px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-xs text-white focus:outline-none focus:border-indigo-500"
                      />
                      <button
                        type="submit"
                        className="px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold transition flex items-center gap-1"
                      >
                        <Send className="w-3.5 h-3.5" />
                        <span>Kirim</span>
                      </button>
                    </form>
                  </div>
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      {/* =====================================================================
          BAGIAN 2: MODE PENGUJIAN TEKNIS & PANDUAN DEPLOY GITHUB (TERPISAH)
         ===================================================================== */}
      {appMode === 'DEV_LAB' && (
        <main className="flex-1 max-w-7xl w-full mx-auto p-4 lg:p-6 space-y-6">
          {/* Sub-Navigasi Mode Pengujian */}
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-bold text-amber-300">
                Mode Pengujian Teknis & Dokumentasi Deploy (Dipisahkan dari Halaman Utama)
              </h2>
              <p className="text-xs text-zinc-300">
                Bagian ini khusus untuk menguji algoritma sinkronisasi 3 zona, inspeksi SDP WebRTC, dan panduan deploy ke GitHub Pages.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 bg-zinc-900 p-1 rounded-xl border border-zinc-800">
              <button
                type="button"
                onClick={() => setDevTab('DEPLOY_GUIDE')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  devTab === 'DEPLOY_GUIDE'
                    ? 'bg-amber-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                1. Deploy ke GitHub Pages
              </button>
              <button
                type="button"
                onClick={() => setDevTab('SYNC_LAB')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  devTab === 'SYNC_LAB'
                    ? 'bg-amber-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                2. Uji Koreksi 3 Zona
              </button>
              <button
                type="button"
                onClick={() => setDevTab('SDP_CONSOLE')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  devTab === 'SDP_CONSOLE'
                    ? 'bg-amber-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                3. Inspektor SDP & SRT→VTT
              </button>
              <button
                type="button"
                onClick={() => setDevTab('CLI_GUIDE')}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                  devTab === 'CLI_GUIDE'
                    ? 'bg-amber-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                4. Server Go Lokal (Opsional)
              </button>
            </div>
          </div>

          {devTab === 'DEPLOY_GUIDE' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="rounded-2xl border border-zinc-800 bg-[#18181B] p-6 space-y-4">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Globe className="w-5 h-5 text-indigo-400" />
                  <span>Cara Kerja Room ID Tanpa Sewa Server (GitHub Pages)</span>
                </h3>
                <p className="text-xs text-zinc-300 leading-relaxed">
                  Agar aplikasi bisa langsung kamu pakai lewat <strong className="text-white">GitHub Pages</strong> tanpa harus menyalakan terminal Go setiap kali mau nobar, proyek ini menggunakan arsitektur <strong className="text-indigo-300">Hybrid P2P Room ID</strong>:
                </p>
                <div className="space-y-2.5 text-xs text-zinc-300">
                  <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
                    <div className="font-semibold text-indigo-400">
                      1. Signaling Room ID: PeerJS Cloud Broker Gratis
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1">
                      Saat kamu membuat Room <code className="text-zinc-200">SURYA-ADEK</code>, browser mendaftarkan ID <code className="text-zinc-200">synctheater-host-SURYAADEK</code> ke broker publik PeerJS (<code className="text-zinc-200">0.peerjs.com</code>). Saat Adek mengetik <code className="text-zinc-200">SURYA-ADEK</code>, kedua browser langsung terhubung P2P via WebRTC DataChannel.
                    </p>
                  </div>
                  <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
                    <div className="font-semibold text-emerald-400">
                      2. Sinkronisasi & Voice Chat: WebRTC Langsung Antar-Browser
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-1">
                      Perintah Play, Pause, Seek, Chat, dan Suara Mikrofon dikirim langsung dari browsermu ke browser pasangan tanpa melewati server perantara.
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-[#18181B] p-6 space-y-4">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Terminal className="w-5 h-5 text-emerald-400" />
                  <span>Langkah Deploy ke GitHub Pages (Otomatis)</span>
                </h3>
                <p className="text-xs text-zinc-400">
                  Di dalam file <code className="text-zinc-200">nobar-sync.zip</code> sudah disertakan workflow <code className="text-zinc-200">.github/workflows/deploy.yml</code>. Kamu cukup push ke GitHub:
                </p>
                <pre className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-200 overflow-x-auto">
{`cd nobar-sync
git init
git add .
git commit -m "Initial commit SyncTheater Nobar App"
git branch -M main
git remote add origin https://github.com/USERNAME/synctheater.git
git push -u origin main`}
                </pre>
                <p className="text-xs text-zinc-400">
                  Setelah push, buka menu <strong className="text-zinc-200">Settings → Pages → Source: GitHub Actions</strong> di repositori GitHub-mu. Dalam 1 menit, link nobar pribadimu langsung aktif!
                </p>
              </div>
            </div>
          )}

          {devTab === 'SYNC_LAB' && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="md:col-span-2 rounded-2xl border border-zinc-800 bg-[#18181B] p-6 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-base font-bold text-white">
                      Laboratorium Mesin Sinkronisasi 3 Zona (SyncEngine.ts)
                    </h3>
                    <p className="text-xs text-zinc-400">
                      Menguji respons koreksi kecepatan putar (1.04x / 0.96x) dan kalibrasi jam NTP-Lite.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={triggerNtpCalibration}
                      className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-indigo-300 transition"
                    >
                      Kalibrasi PING (5x)
                    </button>
                    <button
                      type="button"
                      onClick={triggerNtpCalibration}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition"
                    >
                      Kirim 5 Paket PING NTP-Lite
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="p-3.5 rounded-xl bg-zinc-900 border border-zinc-800">
                    <div className="text-[11px] text-zinc-400">Min RTT</div>
                    <div className="text-lg font-bold font-mono text-white mt-0.5">
                      {telemetry.rttMs} ms
                    </div>
                  </div>
                  <div className="p-3.5 rounded-xl bg-zinc-900 border border-zinc-800">
                    <div className="text-[11px] text-zinc-400">One-Way Latency</div>
                    <div className="text-lg font-bold font-mono text-indigo-400 mt-0.5">
                      {telemetry.oneWayLatencyMs} ms
                    </div>
                  </div>
                  <div className="p-3.5 rounded-xl bg-zinc-900 border border-zinc-800">
                    <div className="text-[11px] text-zinc-400">Selisih Drift</div>
                    <div className="text-lg font-bold font-mono text-emerald-400 mt-0.5">
                      {driftMs} ms
                    </div>
                  </div>
                  <div className="p-3.5 rounded-xl bg-zinc-900 border border-zinc-800">
                    <div className="text-[11px] text-zinc-400">Playback Rate</div>
                    <div className="text-lg font-bold font-mono text-amber-400 mt-0.5">
                      {telemetry.activePlaybackRate.toFixed(2)}x
                    </div>
                  </div>
                </div>

                <div className="space-y-1.5 max-h-44 overflow-y-auto pr-1 font-mono text-[11px]">
                  {syncLogs.map((item) => (
                    <div
                      key={item.id}
                      id={item.id === 'init-1' ? 'init-1' : undefined}
                      className="px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-between"
                    >
                      <span>
                        <strong className="text-indigo-400">[{item.action}]</strong> {item.detail}
                      </span>
                      <span className="text-zinc-500">{item.time}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-[#18181B] p-6 space-y-3">
                <h3 className="text-sm font-bold text-white">Simulasi Gangguan Jaringan</h3>
                <button
                  type="button"
                  onClick={() => injectDrift(0.35)}
                  className="w-full py-2.5 px-3 rounded-xl bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/40 text-left text-xs text-amber-200 transition"
                >
                  Simulasi Lag +350ms (Zona 2: 1.04x)
                </button>
                <button
                  type="button"
                  onClick={() => injectDrift(-0.3)}
                  className="w-full py-2.5 px-3 rounded-xl bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/40 text-left text-xs text-indigo-200 transition"
                >
                  Simulasi Terlalu Cepat -300ms (0.96x)
                </button>
                <button
                  type="button"
                  onClick={() => injectDrift(2.4)}
                  className="w-full py-2.5 px-3 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/40 text-left text-xs text-rose-200 transition"
                >
                  Simulasi Lonjakan +2400ms (Hard Seek)
                </button>
              </div>
            </div>
          )}

          {devTab === 'SDP_CONSOLE' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="rounded-2xl border border-zinc-800 bg-[#18181B] p-6 space-y-3">
                <h3 className="text-sm font-bold text-white flex items-center justify-between">
                  <span>SDP Munging Video 5.0 Mbps (Anti-Burik)</span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 font-mono">
                    b=AS:5000 • 5000 kbps
                  </span>
                </h3>
                <pre className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-400 overflow-x-auto">
                  {SAMPLE_VIDEO_SDP_BEFORE}
                </pre>
                <pre className="p-3 rounded-xl bg-zinc-950 border border-amber-500/40 text-[11px] font-mono text-amber-300 overflow-x-auto">
                  {mungeVideoBitrate(SAMPLE_VIDEO_SDP_BEFORE, 5000)}
                </pre>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-[#18181B] p-6 space-y-3">
                <h3 className="text-sm font-bold text-white flex items-center justify-between">
                  <span>SDP Munging Opus Stereo 192 kbps CBR</span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono">
                    maxaveragebitrate=192000
                  </span>
                </h3>
                <pre className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-400 overflow-x-auto">
                  {SAMPLE_SDP_BEFORE}
                </pre>
                <pre className="p-3 rounded-xl bg-zinc-950 border border-emerald-500/40 text-[11px] font-mono text-emerald-300 overflow-x-auto">
                  {mungeOpusStereoHighBitrate(SAMPLE_SDP_BEFORE)}
                </pre>
              </div>

              <div className="lg:col-span-2 rounded-2xl border border-zinc-800 bg-[#18181B] p-6 space-y-3">
                <h3 className="text-sm font-bold text-white">
                  Konverter Subtitle .SRT ke WebVTT (.VTT)
                </h3>
                <textarea
                  value={srtRawText}
                  onChange={(e) => setSrtRawText(e.target.value)}
                  rows={4}
                  className="w-full p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-200"
                />
                <pre className="p-3 rounded-xl bg-zinc-950 border border-indigo-500/30 text-[11px] font-mono text-indigo-300 max-h-40 overflow-auto">
                  {vttPreviewText}
                </pre>
              </div>
            </div>
          )}

          {devTab === 'CLI_GUIDE' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div id="cmd-build" className="rounded-2xl border border-zinc-800 bg-[#18181B] p-6 space-y-3">
                <h3 className="text-sm font-bold text-white">
                  Kompilasi Single-Binary Go & FFmpeg Remux
                </h3>
                <div id="cmd-remux" className="space-y-2">
                  <pre className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-200 overflow-x-auto">
{`cd nobar-sync/frontend && npm install && npm run build
cd ../backend && go mod tidy && go build -o ../nobar.exe .`}
                  </pre>
                  <pre className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-200 overflow-x-auto">
{`ffmpeg -i "film_asli.mkv" -c:v copy -c:a aac -b:a 192k -ac 2 -movflags +faststart "film_siap_nobar.mp4"`}
                  </pre>
                </div>
              </div>

              <div id="cmd-run" className="rounded-2xl border border-zinc-800 bg-[#18181B] p-6 space-y-3">
                <h3 className="text-sm font-bold text-white">
                  Menjalankan Server Go + Cloudflare Tunnel
                </h3>
                <div id="cmd-tunnel" className="space-y-2">
                  <pre className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-200 overflow-x-auto">
{`./nobar.exe --port 8080 --media-dir "./movies"`}
                  </pre>
                  <pre className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-200 overflow-x-auto">
{`cloudflared tunnel --url http://localhost:8080`}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      {/* =====================================================================
          MODAL GANTI FILM / LINK VIDEO / SUBTITLE DI DALAM ROOM
         ===================================================================== */}
      {showMediaModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-md w-full rounded-2xl border border-zinc-800 bg-[#18181B] p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white">
                Pilih Sumber Film & Subtitle
              </h3>
              <button
                type="button"
                onClick={() => setShowMediaModal(false)}
                className="text-xs text-zinc-400 hover:text-white"
              >
                Tutup
              </button>
            </div>

            <div className="space-y-3">
              {serverMovies.length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[11px] font-semibold text-emerald-400">
                    Film di Server Lokal Go (HTTP 206 Anti-Lag):
                  </div>
                  <div className="max-h-32 overflow-y-auto space-y-1 pr-1">
                    {serverMovies.map((m) => (
                      <button
                        key={m.name}
                        type="button"
                        onClick={() => {
                          selectVideoSource(m.streamUrl, m.name);
                          broadcastRoomPacket({
                            type: 'SYNC_ACTION',
                            action: 'MEDIA_CHANGE',
                            mediaSource: m.streamUrl,
                            mediaName: m.name,
                          });
                          setShowMediaModal(false);
                        }}
                        className="w-full flex items-center justify-between px-3 py-2 rounded-xl bg-zinc-900 hover:bg-indigo-600/20 border border-zinc-800 text-left text-xs transition"
                      >
                        <span className="truncate font-medium text-zinc-200">{m.name}</span>
                        <span className="text-[10px] text-zinc-400 ml-2 shrink-0">
                          {(m.size / (1024 * 1024)).toFixed(0)} MB
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <label className="cursor-pointer flex items-center justify-center gap-2 w-full py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white transition">
                <Film className="w-4 h-4" />
                <span>Pilih File Video (.MP4 / .WebM) dari Laptop/HP</span>
                <input
                  type="file"
                  accept="video/mp4,video/webm,video/x-matroska"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) {
                      selectVideoSource(URL.createObjectURL(f), f.name);
                      setShowMediaModal(false);
                    }
                  }}
                />
              </label>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (externalUrlInput.trim()) {
                    const url = externalUrlInput.trim();
                    selectVideoSource(url, url);
                    broadcastRoomPacket({
                      type: 'SYNC_ACTION',
                      action: 'MEDIA_CHANGE',
                      mediaSource: url,
                      mediaName: url,
                    });
                    setShowMediaModal(false);
                  }
                }}
                className="flex gap-2"
              >
                <input
                  type="url"
                  value={externalUrlInput}
                  onChange={(e) => setExternalUrlInput(e.target.value)}
                  placeholder="Atau tempel link video langsung (.mp4)..."
                  className="flex-1 px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-700 text-xs text-white"
                />
                <button
                  type="submit"
                  className="px-3 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs font-semibold text-white"
                >
                  Pakai URL
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL PANDUAN SINGKAT CARA PAKAI (3 LANGKAH MUDAH)
         ===================================================================== */}
      {showQuickGuideModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-lg w-full rounded-2xl border border-zinc-800 bg-[#18181B] p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-white">
                Cara Pakai SyncTheater (3 Langkah)
              </h3>
              <button
                type="button"
                onClick={() => setShowQuickGuideModal(false)}
                className="text-xs text-zinc-400 hover:text-white"
              >
                Tutup
              </button>
            </div>

            <div className="space-y-3 text-xs text-zinc-300">
              <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
                <strong className="text-indigo-400">1. Buat Kode Room:</strong> Ketik kode room yang mudah diingat (misal <code className="text-white">SURYA-ADEK</code>), pilih file film <code className="text-white">.mp4</code> dari laptopmu, lalu klik <strong>Buat Room & Masuk Bioskop</strong>.
              </div>
              <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
                <strong className="text-emerald-400">2. Pasangan Gabung Room:</strong> Pasanganmu cukup membuka link aplikasi ini, mengetik kode <code className="text-white">SURYA-ADEK</code> pada kartu <strong>Masuk ke Room Pasangan</strong>, lalu klik <strong>Gabung</strong>.
              </div>
              <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800">
                <strong className="text-amber-400">3. Tonton & Ngobrol:</strong> Klik langsung layar video untuk Play/Pause bersama, kirim reaksi emoji, dan nyalakan Mic (suara film otomatis mengecil 30% saat salah satu ngobrol).
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}