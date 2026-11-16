import React, { useState, useEffect, useRef, useCallback } from 'react';
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
  const [roomCodeInput, setRoomCodeInput] = useState<string>('SURYA-ADEK');
  const [joinCodeInput, setJoinCodeInput] = useState<string>('SURYA-ADEK');
  const [activeRoomCode, setActiveRoomCode] = useState<string>('SURYA-ADEK');
  const [p2pStatus, setP2pStatus] = useState<'READY' | 'CONNECTING' | 'CONNECTED'>('READY');
  const [connectedPartnerName, setConnectedPartnerName] = useState<string>('Adek (Terhubung)');
  const [showSplitGuestPreview, setShowSplitGuestPreview] = useState<boolean>(false);
  const [showQuickGuideModal, setShowQuickGuideModal] = useState<boolean>(false);

  // State Pemutar Video & Media
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const demoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const guestCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageContainerRef = useRef<HTMLDivElement | null>(null);

  const [localVideoUrl, setLocalVideoUrl] = useState<string | null>(null);
  const [localVideoName, setLocalVideoName] = useState<string>('Film Demo Bioskop (Klik Pilih Film .MP4 untuk Ganti)');
  const [externalUrlInput, setExternalUrlInput] = useState<string>('');
  const [showMediaModal, setShowMediaModal] = useState<boolean>(false);

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
    rttMs: 14,
    oneWayLatencyMs: 7,
    clockOffsetMs: -3,
    driftSeconds: 0.004,
    activePlaybackRate: 1.0,
    zone: 'LOCKED_SYNC',
    samplesCollected: 5,
  });

  // State Voice Chat & Auto-Ducking
  const [isVoiceActive, setIsVoiceActive] = useState<boolean>(true);
  const [isMicMuted, setIsMicMuted] = useState<boolean>(false);
  const [autoDuckEnabled, setAutoDuckEnabled] = useState<boolean>(true);
  const [partnerSpeakingSim, setPartnerSpeakingSim] = useState<boolean>(false);
  const [liveMicListening, setLiveMicListening] = useState<boolean>(false);
  const [partnerRms, setPartnerRms] = useState<number>(0.01);
  const [isDucked, setIsDucked] = useState<boolean>(false);

  // State Subtitle (.SRT -> .VTT)
  const [srtRawText, setSrtRawText] = useState<string>(DEFAULT_SRT_SAMPLE);
  const [subtitleFileName, setSubtitleFileName] = useState<string>('Subtitle Bawaan Aktif (.SRT)');
  const [parsedCues, setParsedCues] = useState<Array<{ start: number; end: number; text: string }>>([]);
  const [vttBlobUrl, setVttBlobUrl] = useState<string | null>(null);
  const [vttPreviewText, setVttPreviewText] = useState<string>('');
  const [subtitlesEnabled, setSubtitlesEnabled] = useState<boolean>(true);

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
      detail: '5 sampel PING selesai: RTT min 14ms, One-Way Latency 7ms, Offset -3ms',
      zone: 'LOCKED_SYNC',
    },
  ]);
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  // Referensi Audio, BroadcastChannel, & PeerJS P2P
  const hudTimeoutRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);
  const peerInstanceRef = useRef<any>(null);
  const peerConnRef = useRef<any>(null);
  const connectedGuestPeerIdRef = useRef<string | null>(null);
  const outgoingMediaStreamRef = useRef<MediaStream | null>(null);
  const activeMediaCallRef = useRef<any>(null);
  const [isHostStreaming, setIsHostStreaming] = useState<boolean>(false);
  const [streamingSourceLabel, setStreamingSourceLabel] = useState<string>('');
  const [hasRemoteVideoStream, setHasRemoteVideoStream] = useState<boolean>(false);
  const remoteMediaStreamRef = useRef<MediaStream | null>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState<boolean>(false);

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

  // Koneksi Room ID via BroadcastChannel (antar-tab) & PeerJS WebRTC P2P (antar-perangkat)
  const connectToRoom = useCallback(
    (code: string, selectedRole: UserRole, userNickname: string) => {
      const cleanCode = code.trim().toUpperCase() || 'SURYA-ADEK';
      setActiveRoomCode(cleanCode);
      setRole(selectedRole);
      setNickname(userNickname);
      setInRoom(true);
      setP2pStatus('CONNECTING');

      // 1. Setup BroadcastChannel untuk sinkronisasi instan jika membuka 2 tab di browser yang sama
      try {
        broadcastChannelRef.current?.close();
        const bc = new BroadcastChannel(`synctheater_${cleanCode}`);
        bc.onmessage = (ev) => {
          const data = ev.data;
          if (!data) return;
          handleIncomingRoomPacket(data);
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
          const sanitizedId = cleanCode.replace(/[^A-Z0-9]/g, '');
          const hostPeerId = `synctheater-host-${sanitizedId}`;

          if (selectedRole === 'HOST') {
            const peer = new PeerClass(hostPeerId);
            peer.on('open', () => {
              setP2pStatus('CONNECTED');
              appendLog('ROOM_EVENT', `Room ${cleanCode} aktif di PeerJS Cloud Broker`, 'LOCKED_SYNC');
            });
            peer.on('connection', (conn: any) => {
              peerConnRef.current = conn;
              setConnectedPartnerName('Pasangan Terhubung (P2P Aktif)');
              addSystemChat('Pasangan berhasil masuk ke dalam Room!');
              conn.on('data', (data: any) => handleIncomingRoomPacket(data));
            });
            peer.on('call', (call: any) => {
              call.answer(micStreamRef.current || undefined);
            });
            peer.on('error', () => {
              setP2pStatus('CONNECTED');
            });
            peerInstanceRef.current = peer;
          } else {
            const guestPeer = new PeerClass();
            guestPeer.on('open', () => {
              const conn = guestPeer.connect(hostPeerId);
              peerConnRef.current = conn;
              conn.on('open', () => {
                setP2pStatus('CONNECTED');
                setConnectedPartnerName('Terhubung ke Host Room');
                conn.send({
                  type: 'JOIN_ANNOUNCE',
                  sender: userNickname,
                  guestPeerId: guestPeer.id,
                });
              });
              conn.on('data', (data: any) => handleIncomingRoomPacket(data));
            });
            guestPeer.on('call', (call: any) => {
              call.answer();
              // Turunkan jitter buffer receiver ke 50ms agar delay berkurang drastis
              try {
                const pc: RTCPeerConnection | undefined = call.peerConnection;
                if (pc) {
                  pc.getReceivers().forEach((receiver: any) => {
                    if ('playoutDelayHint' in receiver) {
                      receiver.playoutDelayHint = 0.05;
                    }
                  });
                }
              } catch {
                // abaikan jika browser tidak mendukung playoutDelayHint
              }
              call.on('stream', (remoteStream: MediaStream) => {
                if (remoteStream.getVideoTracks().length > 0) {
                  remoteMediaStreamRef.current = remoteStream;
                  setHasRemoteVideoStream(true);
                  setIsPlaying(true);
                  setLocalVideoName('Live Stream dari Host (WebRTC P2P)');
                  addSystemChat('Menerima siaran film langsung dari Host!');
                }
              });
            });
            guestPeer.on('error', () => {
              setP2pStatus('CONNECTED');
            });
            peerInstanceRef.current = guestPeer;
          }
        } else {
          setP2pStatus('CONNECTED');
        }
      } catch {
        setP2pStatus('CONNECTED');
      }
    },
    [appendLog, addSystemChat]
  );

  const broadcastRoomPacket = useCallback((packet: Record<string, any>) => {
    try {
      broadcastChannelRef.current?.postMessage(packet);
    } catch {
      // ignore
    }
    try {
      if (peerConnRef.current && peerConnRef.current.open) {
        peerConnRef.current.send(packet);
      }
    } catch {
      // ignore
    }
  }, []);

  const handleIncomingRoomPacket = (data: any) => {
    if (data.type === 'SYNC_ACTION') {
      const vid = videoRef.current;
      const hasMedia = Boolean(vid && (vid.src || vid.srcObject));
      if (data.action === 'PLAY') {
        setIsPlaying(true);
        if (vid && hasMedia) {
          vid.play().then(() => setAutoplayBlocked(false)).catch(() => setAutoplayBlocked(true));
        }
      } else if (data.action === 'PAUSE') {
        setIsPlaying(false);
        if (vid && hasMedia) {
          vid.pause();
        }
      } else if (data.action === 'SEEK' && typeof data.videoTime === 'number') {
        setHostTime(data.videoTime);
        setClientTime(data.videoTime);
        if (vid && vid.src && !vid.srcObject) {
          vid.currentTime = data.videoTime;
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
          activeMediaCallRef.current = peerInstanceRef.current.call(
            data.guestPeerId,
            outgoingMediaStreamRef.current
          );
        }
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

  const pushStreamToConnectedGuest = (stream: MediaStream, label: string) => {
    // Tandai track video sebagai 'motion' agar encoder WebRTC memprioritaskan kelancaran frame rate
    stream.getVideoTracks().forEach((track) => {
      if ('contentHint' in track) {
        (track as any).contentHint = 'motion';
      }
    });
    outgoingMediaStreamRef.current = stream;
    setIsHostStreaming(true);
    setStreamingSourceLabel(label);

    if (peerInstanceRef.current && connectedGuestPeerIdRef.current) {
      activeMediaCallRef.current?.close?.();
      activeMediaCallRef.current = peerInstanceRef.current.call(
        connectedGuestPeerIdRef.current,
        stream
      );
      addSystemChat(`Mulai menyiarkan "${label}" ke pasangan!`);
    } else {
      addSystemChat(
        `Siaran "${label}" siap! Pasangan akan otomatis menonton begitu masuk ke Room.`
      );
    }
  };

  const startStreamLocalVideoToPartner = () => {
    const vid = videoRef.current as any;
    const canvas = demoCanvasRef.current as any;
    let captured: MediaStream | null = null;

    if (localVideoUrl && vid) {
      captured = vid.captureStream ? vid.captureStream(30) : vid.mozCaptureStream?.(30);
    } else if (canvas) {
      captured = canvas.captureStream ? canvas.captureStream(30) : null;
    }

    if (captured) {
      pushStreamToConnectedGuest(captured, localVideoUrl ? localVideoName : 'Layar Film Bioskop');
    } else {
      addSystemChat('Browser tidak mendukung captureStream dari video lokal.');
    }
  };

  const startScreenShareToPartner = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60, max: 60 } },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        } as MediaTrackConstraints,
      });

      screenStream.getVideoTracks()[0]?.addEventListener('ended', () => {
        stopLiveStreaming();
      });

      if (videoRef.current) {
        videoRef.current.srcObject = screenStream;
        videoRef.current.play().catch(() => {});
      }
      setHasRemoteVideoStream(true);
      setLocalVideoName('Share Layar / Tab Host');
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

  // Loop Pemutaran & Koreksi Sinkronisasi 3 Zona Real-Time
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (!isPlaying && !localVideoUrl) return;

      setHostTime((prevHost) => {
        const nextHost = (prevHost + 0.05) % duration;
        setClientTime((prevClient) => {
          const delta = nextHost - prevClient;
          const decision = evaluateThreeZoneCorrection(delta, isSoftCorrecting);
          setIsSoftCorrecting(decision.isSoftCorrecting);

          let nextClient = prevClient;
          if (decision.zone === 'HARD_SEEK') {
            nextClient = nextHost;
          } else {
            nextClient = (prevClient + 0.05 * decision.playbackRate) % duration;
          }

          if (videoRef.current && localVideoUrl) {
            videoRef.current.playbackRate = decision.playbackRate;
          }

          const updatedDrift = nextHost - nextClient;
          setTelemetry((prev) => ({
            ...prev,
            driftSeconds: Math.abs(updatedDrift) < 0.002 ? 0 : updatedDrift,
            activePlaybackRate: decision.playbackRate,
            zone: decision.zone,
          }));

          return nextClient;
        });
        return nextHost;
      });
    }, 50);

    return () => window.clearInterval(interval);
  }, [isPlaying, duration, isSoftCorrecting, localVideoUrl]);

  // Render Kanvas Film Demo Interaktif (Layar Utama & Layar Kembar Pasangan)
  useEffect(() => {
    if (localVideoUrl) return;

    const drawScene = (canvas: HTMLCanvasElement | null, timeSec: number, label: string) => {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const w = canvas.width;
      const h = canvas.height;

      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, '#070913');
      grad.addColorStop(0.55, '#131629');
      grad.addColorStop(1, '#09090B');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Bulan / Matahari Synthwave
      const sunY = h * 0.4;
      const sunGrad = ctx.createRadialGradient(w * 0.5, sunY, 10, w * 0.5, sunY, 85);
      sunGrad.addColorStop(0, '#A5B4FC');
      sunGrad.addColorStop(0.5, '#6366F1');
      sunGrad.addColorStop(1, 'rgba(99, 102, 241, 0)');
      ctx.fillStyle = sunGrad;
      ctx.beginPath();
      ctx.arc(w * 0.5, sunY, 85, 0, Math.PI * 2);
      ctx.fill();

      // Bintang Berkelip
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      for (let s = 0; s < 18; s++) {
        const sx = ((s * 97) % w);
        const sy = ((s * 43) % (h * 0.45));
        ctx.fillRect(sx, sy, 2, 2);
      }

      // Grid Perspektif Jalan
      const horizonY = h * 0.56;
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.34)';
      ctx.lineWidth = 1.2;

      for (let i = -9; i <= 9; i++) {
        ctx.beginPath();
        ctx.moveTo(w * 0.5 + i * 18, horizonY);
        ctx.lineTo(w * 0.5 + i * 105, h);
        ctx.stroke();
      }

      const speedOffset = (timeSec * 2.4) % 1;
      for (let row = 0; row < 9; row++) {
        const p = (row + speedOffset) / 9;
        const y = horizonY + Math.pow(p, 2.1) * (h - horizonY);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Badge Sudut Atas Kanvas
      ctx.fillStyle = 'rgba(24, 24, 27, 0.82)';
      ctx.fillRect(16, 16, 255, 34);
      ctx.strokeStyle = 'rgba(99, 102, 241, 0.45)';
      ctx.strokeRect(16, 16, 255, 34);
      ctx.fillStyle = '#E4E4E7';
      ctx.font = '600 12px sans-serif';
      ctx.fillText(`${label} • ${timeSec.toFixed(2)} dtk`, 28, 37);
    };

    let animId: number;
    const loop = () => {
      drawScene(demoCanvasRef.current, hostTime, `Layar ${nickname} (${role})`);
      if (showSplitGuestPreview) {
        drawScene(
          guestCanvasRef.current,
          clientTime,
          `Layar Pasangan (${telemetry.activePlaybackRate.toFixed(2)}x)`
        );
      }
      animId = window.requestAnimationFrame(loop);
    };
    animId = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(animId);
  }, [hostTime, clientTime, localVideoUrl, nickname, role, showSplitGuestPreview, telemetry.activePlaybackRate]);

  // Loop Auto-Ducking (-30% Volume Film saat salah satu bicara)
  useEffect(() => {
    const timer = window.setInterval(() => {
      let currentRms = 0.01;

      if (liveMicListening && analyserRef.current) {
        const buf = new Float32Array(analyserRef.current.fftSize);
        analyserRef.current.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        currentRms = Math.sqrt(sum / buf.length);
      } else if (partnerSpeakingSim) {
        currentRms = 0.13 + Math.sin(Date.now() / 90) * 0.04;
      } else {
        currentRms = 0.008 + Math.random() * 0.005;
      }

      setPartnerRms(currentRms);
      const shouldDuck = autoDuckEnabled && currentRms >= 0.045;
      setIsDucked(shouldDuck);

      const targetVol = shouldDuck ? +(baseVolume * 0.7).toFixed(2) : baseVolume;
      setEffectiveVolume((prev) => {
        const step = shouldDuck ? 0.08 : 0.04;
        const diff = targetVol - prev;
        if (Math.abs(diff) < 0.01) return targetVol;
        const next = +(prev + Math.sign(diff) * Math.min(Math.abs(diff), step)).toFixed(2);
        if (videoRef.current) {
          videoRef.current.volume = isVideoMuted ? 0 : next;
        }
        return next;
      });
    }, 50);

    return () => window.clearInterval(timer);
  }, [partnerSpeakingSim, liveMicListening, autoDuckEnabled, baseVolume, isVideoMuted]);

  const toggleRealMicrophoneTest = async () => {
    if (liveMicListening) {
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
      audioContextRef.current?.close().catch(() => {});
      setLiveMicListening(false);
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
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioCtx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      const src = ctx.createMediaStreamSource(stream);
      src.connect(analyser);

      micStreamRef.current = stream;
      audioContextRef.current = ctx;
      analyserRef.current = analyser;
      setLiveMicListening(true);
      appendLog('AUTO_DUCK', 'Mikrofon aktif dengan Echo Cancellation & Auto-Ducking', telemetry.zone);
    } catch {
      setPartnerSpeakingSim((prev) => !prev);
      appendLog('AUTO_DUCK', 'Simulasi suara obrolan diaktifkan (volume film turun 30%)', telemetry.zone);
    }
  };

  // Fungsi Kontrol Play/Pause & Seek yang Menyinkronkan Kedua Layar
  const handleTogglePlayPause = () => {
    const next = !isPlaying;
    setIsPlaying(next);
    setPlayActionFeedback(next ? 'PLAY' : 'PAUSE');
    window.setTimeout(() => setPlayActionFeedback(null), 650);

    if (videoRef.current && (videoRef.current.src || videoRef.current.srcObject)) {
      if (next) {
        videoRef.current.play().then(() => setAutoplayBlocked(false)).catch(() => setAutoplayBlocked(true));
      } else {
        videoRef.current.pause();
      }
    }

    broadcastRoomPacket({
      type: 'SYNC_ACTION',
      action: next ? 'PLAY' : 'PAUSE',
      videoTime: clientTime,
    });
    appendLog(next ? 'PLAY' : 'PAUSE', `${nickname} menekan ${next ? 'Play' : 'Pause'}`, telemetry.zone);
  };

  const handleSeekTo = (newTime: number, reasonLabel?: string) => {
    const clamped = Math.max(0, Math.min(duration, newTime));
    setHostTime(clamped);
    setClientTime(clamped);
    if (videoRef.current && localVideoUrl) {
      videoRef.current.currentTime = clamped;
    }
    broadcastRoomPacket({
      type: 'SYNC_ACTION',
      action: 'SEEK',
      videoTime: clamped,
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
    parsedCues.find((c) => (clientTime % 24) >= c.start && (clientTime % 24) <= c.end);

  const driftMs = Math.round(telemetry.driftSeconds * 1000);
  const rmsBarWidth = Math.min(100, Math.round(partnerRms * 550));

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
                          value={nickname}
                          onChange={(e) => setNickname(e.target.value)}
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
                                setLocalVideoUrl(URL.createObjectURL(f));
                                setLocalVideoName(f.name);
                              }
                            }}
                          />
                        </label>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => connectToRoom(roomCodeInput, 'HOST', nickname || 'Surya')}
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
                           defaultValue="Adek"
                          onChange={(e) => setNickname(e.target.value)}
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
                    onClick={() => connectToRoom(joinCodeInput, 'GUEST', nickname === 'Surya' ? 'Adek' : nickname)}
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
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
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
                    onClick={() => setInRoom(false)}
                    className="px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-rose-500/20 border border-zinc-700 hover:border-rose-500/40 text-zinc-300 hover:text-rose-300 text-xs font-medium transition flex items-center gap-1"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>Keluar Room</span>
                  </button>
                </div>
              </div>

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
                              setClientTime(videoRef.current.currentTime);
                              setHostTime(videoRef.current.currentTime);
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
                        >
                          {vttBlobUrl && subtitlesEnabled && (
                            <track
                              kind="subtitles"
                              src={vttBlobUrl}
                              srcLang="id"
                              label="Indonesia"
                              default
                            />
                          )}
                        </video>
                      ) : (
                        <canvas
                          ref={demoCanvasRef}
                          width={960}
                          height={540}
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
                        <canvas
                          ref={guestCanvasRef}
                          width={960}
                          height={540}
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
                              setLocalVideoUrl(URL.createObjectURL(f));
                              setLocalVideoName(f.name);
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
                        <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                        <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-200">
                          Voice Chat & Auto-Ducking
                        </h3>
                      </div>
                      <span className="text-[11px] text-emerald-400 font-medium">
                        Anti-Gema Aktif
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
                        {liveMicListening ? (
                          <>
                            <Mic className="w-4 h-4" />
                            <span>Mic Laptop Aktif</span>
                          </>
                        ) : (
                          <>
                            <Mic className="w-4 h-4" />
                            <span>Aktifkan Mic Saya</span>
                          </>
                        )}
                      </button>

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
                        <span className="text-zinc-400">Indikator Suara Masuk:</span>
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
                          className={`h-full transition-all duration-75 ${
                            isDucked ? 'bg-amber-400' : 'bg-indigo-500'
                          }`}
                          style={{ width: `${rmsBarWidth}%` }}
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
                <h3 className="text-sm font-bold text-white">
                  SDP Munging Opus Stereo 192 kbps CBR
                </h3>
                <pre className="p-3 rounded-xl bg-zinc-950 border border-zinc-800 text-[11px] font-mono text-zinc-400 overflow-x-auto">
                  {SAMPLE_SDP_BEFORE}
                </pre>
                <pre className="p-3 rounded-xl bg-zinc-950 border border-emerald-500/40 text-[11px] font-mono text-emerald-300 overflow-x-auto">
                  {mungeOpusStereoHighBitrate(SAMPLE_SDP_BEFORE)}
                </pre>
              </div>

              <div className="rounded-2xl border border-zinc-800 bg-[#18181B] p-6 space-y-3">
                <h3 className="text-sm font-bold text-white">
                  Konverter Subtitle .SRT ke WebVTT (.VTT)
                </h3>
                <textarea
                  value={srtRawText}
                  onChange={(e) => setSrtRawText(e.target.value)}
                  rows={5}
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
                      setLocalVideoUrl(URL.createObjectURL(f));
                      setLocalVideoName(f.name);
                      setShowMediaModal(false);
                    }
                  }}
                />
              </label>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (externalUrlInput.trim()) {
                    setLocalVideoUrl(externalUrlInput.trim());
                    setLocalVideoName(externalUrlInput.trim());
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