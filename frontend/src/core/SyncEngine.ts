import {
  PingMessage,
  PongMessage,
  SyncAction,
  SyncStateMessage,
  SyncTelemetry,
  SyncZone,
  UserRole,
} from '../types/protocol';

interface PingSample {
  rtt: number;
  clockOffset: number;
}

export class SyncEngine {
  private ws: WebSocket | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private role: UserRole;
  private roomId: string;
  private peerId: string;

  private pingSamples: PingSample[] = [];
  private bestRttMs = 0;
  private clockOffsetMs = 0;
  private isSoftCorrecting = false;
  private heartbeatTimer: number | null = null;

  private onTelemetryCallback?: (telemetry: SyncTelemetry) => void;
  private onSignalCallback?: (payload: any) => void;
  private onPresenceCallback?: (peers: Array<{ peerId: string; role: UserRole }>) => void;
  private onMediaChangeCallback?: (sourceUrl: string) => void;

  constructor(
    roomId: string,
    role: UserRole,
    peerId: string,
    callbacks?: {
      onTelemetry?: (t: SyncTelemetry) => void;
      onSignal?: (payload: any) => void;
      onPresence?: (peers: Array<{ peerId: string; role: UserRole }>) => void;
      onMediaChange?: (sourceUrl: string) => void;
    }
  ) {
    this.roomId = roomId;
    this.role = role;
    this.peerId = peerId;
    this.onTelemetryCallback = callbacks?.onTelemetry;
    this.onSignalCallback = callbacks?.onSignal;
    this.onPresenceCallback = callbacks?.onPresence;
    this.onMediaChangeCallback = callbacks?.onMediaChange;
  }

  public attachVideo(video: HTMLVideoElement | null) {
    this.videoElement = video;
  }

  public setRole(role: UserRole) {
    this.role = role;
    this.setupHeartbeat();
  }

  public connect(customWsUrl?: string) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const baseUrl = customWsUrl || `${protocol}//${window.location.host}/ws`;
    const url = `${baseUrl}?room=${encodeURIComponent(this.roomId)}&role=${this.role}&peerId=${encodeURIComponent(this.peerId)}`;

    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.runNtpCalibration();
      this.setupHeartbeat();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleIncomingMessage(msg);
      } catch (err) {
        console.error('[SyncEngine] Gagal mem-parsing pesan WebSocket:', err);
      }
    };

    this.ws.onclose = () => {
      if (this.heartbeatTimer) {
        window.clearInterval(this.heartbeatTimer);
      }
    };
  }

  /**
   * 1. Kalibrasi Selisih Jam (NTP-Lite):
   * Mengirim 5 paket PING secara berurutan ke server dan mengambil RTT terendah
   * untuk menghitung one-way latency (L = RTT / 2) dan clockOffset perangkat.
   */
  public runNtpCalibration() {
    this.pingSamples = [];
    for (let seq = 1; seq <= 5; seq++) {
      window.setTimeout(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          const ping: PingMessage = {
            type: 'PING',
            seq,
            clientSentTime: Date.now(),
          };
          this.ws.send(JSON.stringify(ping));
        }
      }, (seq - 1) * 180);
    }
  }

  private handlePong(pong: PongMessage) {
    const clientReceiveTime = Date.now();
    const rtt = Math.max(1, clientReceiveTime - pong.clientSentTime);
    const oneWayLatency = rtt / 2;
    // Estimasi waktu server saat paket diterima klien = serverTimestamp + L
    const estimatedServerNow = pong.serverTimestamp + oneWayLatency;
    const clockOffset = estimatedServerNow - clientReceiveTime;

    this.pingSamples.push({ rtt, clockOffset });

    // Pilih sampel dengan RTT terendah (paling bebas jitter jaringan)
    const bestSample = this.pingSamples.reduce((prev, curr) =>
      curr.rtt < prev.rtt ? curr : prev
    );

    this.bestRttMs = bestSample.rtt;
    this.clockOffsetMs = bestSample.clockOffset;

    this.emitTelemetry(0, this.videoElement?.playbackRate || 1.0, 'LOCKED_SYNC');
  }

  private setupHeartbeat() {
    if (this.heartbeatTimer) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.role === 'HOST') {
      // Setiap 2 detik, Host mengirim paket HEARTBEAT
      this.heartbeatTimer = window.setInterval(() => {
        if (this.videoElement && !this.videoElement.paused) {
          this.sendSyncAction('HEARTBEAT', this.videoElement.currentTime);
        }
      }, 2000);
    }
  }

  public sendSyncAction(action: SyncAction, videoTime: number, mediaSource?: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const payload: SyncStateMessage = {
      type: 'SYNC_STATE',
      senderRole: this.role,
      action,
      videoTime,
      serverTimestamp: Date.now() + this.clockOffsetMs,
      playbackRate: 1.0,
      mediaSource,
      isPlaying: this.videoElement ? !this.videoElement.paused : false,
    };

    this.ws.send(JSON.stringify(payload));
  }

  public sendWebRTCSignal(signalPayload: Record<string, any>) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: 'WEBRTC_SIGNAL',
        ...signalPayload,
      })
    );
  }

  private handleIncomingMessage(msg: any) {
    switch (msg.type) {
      case 'PONG':
        this.handlePong(msg as PongMessage);
        break;
      case 'SYNC_STATE':
        this.applySyncState(msg as SyncStateMessage);
        break;
      case 'WEBRTC_SIGNAL':
        this.onSignalCallback?.(msg);
        break;
      case 'ROOM_PRESENCE':
        this.onPresenceCallback?.(msg.peers || []);
        break;
    }
  }

  /**
   * 2. Perhitungan Waktu Target & 3. Algoritma Koreksi 3 Zona
   * t_target = t_host + (t_client_now - t_server_sent + clockOffset) / 1000
   */
  public applySyncState(state: SyncStateMessage) {
    if (state.action === 'MEDIA_CHANGE' && state.mediaSource) {
      this.onMediaChangeCallback?.(state.mediaSource);
      return;
    }

    if (!this.videoElement) return;

    const clientNow = Date.now();
    const networkTransitSec =
      state.action === 'PAUSE'
        ? 0
        : Math.max(0, (clientNow - state.serverTimestamp + this.clockOffsetMs) / 1000);

    const targetTime = state.videoTime + networkTransitSec;

    if (state.action === 'PAUSE') {
      this.videoElement.pause();
      this.videoElement.playbackRate = 1.0;
      this.isSoftCorrecting = false;
      if (Math.abs(targetTime - this.videoElement.currentTime) > 0.05) {
        this.videoElement.currentTime = targetTime;
      }
      this.emitTelemetry(0, 1.0, 'LOCKED_SYNC');
      return;
    }

    if (state.action === 'PLAY') {
      if (this.videoElement.paused) {
        this.videoElement.play().catch(() => {});
      }
    }

    if (state.action === 'SEEK') {
      this.videoElement.currentTime = targetTime;
      this.videoElement.playbackRate = 1.0;
      this.isSoftCorrecting = false;
      this.emitTelemetry(0, 1.0, 'HARD_SEEK');
      return;
    }

    const currentTime = this.videoElement.currentTime;
    const deltaT = targetTime - currentTime;
    const absDelta = Math.abs(deltaT);

    const decision = SyncEngine.evaluateThreeZoneCorrection(
      deltaT,
      this.isSoftCorrecting
    );

    this.isSoftCorrecting = decision.isSoftCorrecting;

    if (decision.zone === 'HARD_SEEK') {
      this.videoElement.currentTime = targetTime;
      this.videoElement.playbackRate = 1.0;
    } else {
      this.videoElement.playbackRate = decision.playbackRate;
    }

    this.emitTelemetry(
      absDelta < 0.001 ? 0 : deltaT,
      decision.playbackRate,
      decision.zone
    );
  }

  /**
   * Fungsi murni Algoritma Koreksi 3 Zona:
   * - Zona Sinkron (|deltaT| < 0.05s, atau selesai koreksi halus saat |deltaT| < 0.03s): playbackRate = 1.0x
   * - Zona Koreksi Halus (0.05s <= |deltaT| <= 1.0s): playbackRate = 1.04x (tertinggal) atau 0.96x (terlalu cepat)
   * - Zona Lompat (|deltaT| > 1.0s): Hard seek langsung ke t_target
   */
  public static evaluateThreeZoneCorrection(
    deltaT: number,
    currentlySoftCorrecting: boolean
  ): {
    zone: SyncZone;
    playbackRate: number;
    isSoftCorrecting: boolean;
  } {
    const absDelta = Math.abs(deltaT);

    // Zona Lompat (> 1.0 detik)
    if (absDelta > 1.0) {
      return {
        zone: 'HARD_SEEK',
        playbackRate: 1.0,
        isSoftCorrecting: false,
      };
    }

    // Jika sedang dalam Zona Koreksi Halus, pertahankan hingga |deltaT| < 0.03 detik (histeresis anti-osilasi)
    const syncThreshold = currentlySoftCorrecting ? 0.03 : 0.05;

    if (absDelta < syncThreshold) {
      return {
        zone: 'LOCKED_SYNC',
        playbackRate: 1.0,
        isSoftCorrecting: false,
      };
    }

    // Zona Koreksi Halus (0.05s <= |deltaT| <= 1.0s)
    const rate = deltaT > 0 ? 1.04 : 0.96;
    return {
      zone: 'SOFT_RATE_ADAPT',
      playbackRate: rate,
      isSoftCorrecting: true,
    };
  }

  private emitTelemetry(driftSeconds: number, rate: number, zone: SyncZone) {
    this.onTelemetryCallback?.({
      rttMs: Math.round(this.bestRttMs),
      oneWayLatencyMs: Math.round(this.bestRttMs / 2),
      clockOffsetMs: Math.round(this.clockOffsetMs),
      driftSeconds,
      activePlaybackRate: rate,
      zone,
      samplesCollected: this.pingSamples.length,
    });
  }

  public disconnect() {
    if (this.heartbeatTimer) {
      window.clearInterval(this.heartbeatTimer);
    }
    this.ws?.close();
  }
}
