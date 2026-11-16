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
   * Profil Audio Media (Mode Cadangan Screen/Tab Share):
   * Mematikan seluruh filter pemrosesan suara (false) dan menerapkan SDP munging
   * Opus Stereo High-Bitrate 192 kbps CBR.
   */
  public async startRawTabShare(): Promise<MediaStream> {
    const pc = this.createPeerConnection();

    this.localScreenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 60, max: 60 },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      } as MediaTrackConstraints,
    });

    this.localScreenStream.getTracks().forEach((track) => {
      pc.addTrack(track, this.localScreenStream!);
    });

    await this.negotiateConnection(true);
    return this.localScreenStream;
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
    const mungedSdp = WebRTCManager.mungeOpusStereoHighBitrate(offer.sdp || '');
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
      const mungedSdp = WebRTCManager.mungeOpusStereoHighBitrate(answer.sdp || '');
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
