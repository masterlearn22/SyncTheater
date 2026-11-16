import { SyncEngine } from './SyncEngine';

export class WebRTCManager {
  private pc: RTCPeerConnection | null = null;
  private syncEngine: SyncEngine;
  private localVoiceStream: MediaStream | null = null;
  private localScreenStream: MediaStream | null = null;

  private onRemoteVoiceStream?: (stream: MediaStream) => void;
  private onRemoteScreenStream?: (stream: MediaStream) => void;
  private onConnectionStateChange?: (state: RTCPeerConnectionState) => void;

  constructor(
    syncEngine: SyncEngine,
    callbacks?: {
      onRemoteVoice?: (stream: MediaStream) => void;
      onRemoteScreen?: (stream: MediaStream) => void;
      onStateChange?: (state: RTCPeerConnectionState) => void;
    }
  ) {
    this.syncEngine = syncEngine;
    this.onRemoteVoiceStream = callbacks?.onRemoteVoice;
    this.onRemoteScreenStream = callbacks?.onRemoteScreen;
    this.onConnectionStateChange = callbacks?.onStateChange;
  }

  private createPeerConnection(): RTCPeerConnection {
    if (this.pc) {
      return this.pc;
    }

    this.pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.syncEngine.sendWebRTCSignal({
          signalType: 'ICE_CANDIDATE',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    this.pc.onconnectionstatechange = () => {
      if (this.pc) {
        this.onConnectionStateChange?.(this.pc.connectionState);
      }
    };

    this.pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;

      // Optimasi buffer penerima (180ms) agar tidak terjadi stutter/lag akibat packet jitter
      if (event.receiver && 'playoutDelayHint' in event.receiver) {
        try {
          (event.receiver as any).playoutDelayHint = 0.18;
        } catch {
          // abaikan bila tidak didukung
        }
      }

      if (stream.getVideoTracks().length > 0) {
        this.onRemoteScreenStream?.(stream);
      } else {
        this.onRemoteVoiceStream?.(stream);
      }
    };

    return this.pc;
  }

  /**
   * Profil Mikrofon (Obrolan):
   * Mengaktifkan echoCancellation, noiseSuppression, dan autoGainControl
   * agar suara film dari speaker tidak bocor kembali ke mikrofon (echo loop).
   */
  public async startVoiceChat(): Promise<MediaStream> {
    const pc = this.createPeerConnection();

    this.localVoiceStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });

    this.localVoiceStream.getTracks().forEach((track) => {
      pc.addTrack(track, this.localVoiceStream!);
    });

    await this.negotiateConnection(false);
    return this.localVoiceStream;
  }

  /**
   * Profil Audio Media & Layar Film (Mode Cadangan Screen/Tab Share):
   * Mematikan filter pemrosesan suara mic, mengunci resolusi Full HD 60fps,
   * menerapkan contentHint='detail' (anti-burik), bitrate video 5 Mbps (5000 kbps),
   * serta SDP munging Opus Stereo High-Bitrate 192 kbps CBR.
   */
  public async startRawTabShare(): Promise<MediaStream> {
    const pc = this.createPeerConnection();

    this.localScreenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 60, max: 60 },
        width: { ideal: 1920, max: 1920 },
        height: { ideal: 1080, max: 1080 },
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      } as MediaTrackConstraints,
    });

    this.localScreenStream.getVideoTracks().forEach((track) => {
      if ('contentHint' in track) {
        (track as any).contentHint = 'detail';
      }
    });

    this.localScreenStream.getTracks().forEach((track) => {
      pc.addTrack(track, this.localScreenStream!);
    });

    await this.applySenderVideoBitrate(pc, 5000000, 'maintain-resolution');
    await this.negotiateConnection(true);
    return this.localScreenStream;
  }

  /**
   * Mengatur parameter RTCRtpSender untuk mengunci bitrate WebRTC ke 4-5 Mbps,
   * framerate 60 FPS, dan degradationPreference 'maintain-resolution' agar video tidak burik.
   */
  public async applySenderVideoBitrate(
    pc: RTCPeerConnection,
    targetBitrateBps = 5000000,
    preference: 'maintain-resolution' | 'balanced' = 'maintain-resolution'
  ): Promise<void> {
    try {
      const senders = pc.getSenders();
      for (const sender of senders) {
        if (sender.track && sender.track.kind === 'video') {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          for (const enc of params.encodings) {
            enc.maxBitrate = targetBitrateBps;
            (enc as any).minBitrate = Math.min(2500000, targetBitrateBps);
            enc.maxFramerate = 60;
            enc.scaleResolutionDownBy = 1.0;
          }
          (params as any).degradationPreference = preference;
          await sender.setParameters(params);
        }
      }
    } catch (err) {
      console.warn('[WebRTCManager] Gagal menerapkan video sender parameters:', err);
    }
  }

  /**
   * Memodifikasi baris SDP Video untuk menetapkan batas bandwidth WebRTC ke 4-5 Mbps:
   * - Menambahkan b=AS:5000 (5000 kbps) & b=TIAS:5000000 (5 Mbps)
   * - Menambahkan parameter x-google-min-bitrate=2500;x-google-max-bitrate=5000;x-google-start-bitrate=4500
   */
  public static mungeVideoBitrate(sdp: string, targetBitrateKbps = 5000): string {
    const lines = sdp.split(/\r?\n/);
    const minKbps = Math.max(1000, Math.floor(targetBitrateKbps * 0.5));
    const startKbps = Math.max(minKbps, Math.floor(targetBitrateKbps * 0.85));
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

  /**
   * Memodifikasi baris a=fmtp Opus pada SDP menjadi:
   * minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=192000;cbr=1
   */
  public static mungeOpusStereoHighBitrate(sdp: string): string {
    const lines = sdp.split('\r\n');
    let opusPayloadType: string | null = null;

    for (const line of lines) {
      const match = line.match(/^a=rtpmap:(\d+) opus\/48000\/2/i);
      if (match) {
        opusPayloadType = match[1];
        break;
      }
    }

    if (!opusPayloadType) return sdp;

    const targetParams =
      'minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=192000;cbr=1';
    let fmtpFound = false;

    const updatedLines = lines.map((line) => {
      if (line.startsWith(`a=fmtp:${opusPayloadType} `)) {
        fmtpFound = true;
        return `a=fmtp:${opusPayloadType} ${targetParams}`;
      }
      return line;
    });

    if (!fmtpFound) {
      const rtpmapIdx = updatedLines.findIndex((l) =>
        l.startsWith(`a=rtpmap:${opusPayloadType} `)
      );
      if (rtpmapIdx !== -1) {
        updatedLines.splice(
          rtpmapIdx + 1,
          0,
          `a=fmtp:${opusPayloadType} ${targetParams}`
        );
      }
    }

    return updatedLines.join('\r\n');
  }

  private async negotiateConnection(isScreenShare: boolean) {
    if (!this.pc) return;
    const offer = await this.pc.createOffer();
    let mungedSdp = WebRTCManager.mungeOpusStereoHighBitrate(offer.sdp || '');
    if (isScreenShare) {
      mungedSdp = WebRTCManager.mungeVideoBitrate(mungedSdp, 5000);
    }
    const mungedOffer: RTCSessionDescriptionInit = {
      type: offer.type,
      sdp: mungedSdp,
    };

    await this.pc.setLocalDescription(mungedOffer);
    this.syncEngine.sendWebRTCSignal({
      signalType: 'SDP_OFFER',
      sdp: mungedOffer,
      isScreenShare,
    });
  }

  public async handleSignal(msg: any) {
    const pc = this.createPeerConnection();

    if (msg.signalType === 'SDP_OFFER' && msg.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      const answer = await pc.createAnswer();
      let mungedSdp = WebRTCManager.mungeOpusStereoHighBitrate(answer.sdp || '');
      if (msg.isScreenShare) {
        mungedSdp = WebRTCManager.mungeVideoBitrate(mungedSdp, 5000);
      }
      const mungedAnswer: RTCSessionDescriptionInit = {
        type: answer.type,
        sdp: mungedSdp,
      };
      await pc.setLocalDescription(mungedAnswer);
      this.syncEngine.sendWebRTCSignal({
        signalType: 'SDP_ANSWER',
        sdp: mungedAnswer,
        targetPeerId: msg.senderPeerId,
      });
    } else if (msg.signalType === 'SDP_ANSWER' && msg.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } else if (msg.signalType === 'ICE_CANDIDATE' && msg.candidate) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      } catch (err) {
        console.warn('[WebRTCManager] Gagal menambahkan ICE candidate:', err);
      }
    }
  }

  public setMicMuted(muted: boolean) {
    this.localVoiceStream?.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
  }

  public stopAll() {
    this.localVoiceStream?.getTracks().forEach((t) => t.stop());
    this.localScreenStream?.getTracks().forEach((t) => t.stop());
    this.pc?.close();
    this.pc = null;
  }
}
