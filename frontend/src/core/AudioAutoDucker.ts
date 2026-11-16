/**
 * Web Audio API Auto-Ducking:
 * Menghubungkan aliran audio mikrofon pasangan ke AnalyserNode (fftSize = 256).
 * Ketika amplitudo suara (RMS) melewati ambang batas bicara selama > 100 ms,
 * volume elemen <video> diturunkan secara halus sebesar 30% (ke 70% dari baseVolume)
 * dalam rentang 150 ms, lalu dikembalikan ke 100% secara perlahan dalam 450 ms
 * setelah pasangan selesai berbicara.
 */
export class AudioAutoDucker {
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private rafId: number | null = null;

  private videoElement: HTMLVideoElement | null = null;
  private baseVolume = 1.0;
  private enabled = true;
  private rmsThreshold = 0.045; // Ambang batas deteksi suara bicara

  private speechStartTimestamp: number | null = null;
  private isCurrentlyDucked = false;
  private rampAnimationId: number | null = null;

  private onRmsUpdate?: (rms: number, isDucked: boolean, currentVideoVolume: number) => void;

  constructor(
    onRmsUpdate?: (rms: number, isDucked: boolean, currentVideoVolume: number) => void
  ) {
    this.onRmsUpdate = onRmsUpdate;
  }

  public attachVideo(video: HTMLVideoElement | null) {
    this.videoElement = video;
    if (video) {
      this.baseVolume = video.volume;
    }
  }

  public setBaseVolume(vol: number) {
    this.baseVolume = Math.max(0, Math.min(1, vol));
    if (this.videoElement && !this.isCurrentlyDucked) {
      this.videoElement.volume = this.baseVolume;
    }
  }

  public setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled && this.isCurrentlyDucked) {
      this.isCurrentlyDucked = false;
      this.rampVideoVolume(this.baseVolume, 450);
    }
  }

  public setThreshold(threshold: number) {
    this.rmsThreshold = threshold;
  }

  public connectStream(stream: MediaStream) {
    this.stop();

    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    this.audioCtx = new AudioCtx();
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.6;

    this.sourceNode = this.audioCtx.createMediaStreamSource(stream);
    this.sourceNode.connect(this.analyser);

    const bufferLength = this.analyser.fftSize;
    const dataArray = new Float32Array(bufferLength);

    const monitorLoop = () => {
      if (!this.analyser) return;
      this.analyser.getFloatTimeDomainData(dataArray);

      let sumSquares = 0;
      for (let i = 0; i < bufferLength; i++) {
        sumSquares += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sumSquares / bufferLength);
      this.processRmsSample(rms);

      this.rafId = window.requestAnimationFrame(monitorLoop);
    };

    this.rafId = window.requestAnimationFrame(monitorLoop);
  }

  public processRmsSample(rms: number) {
    const now = performance.now();

    if (this.enabled && rms >= this.rmsThreshold) {
      if (this.speechStartTimestamp === null) {
        this.speechStartTimestamp = now;
      } else if (now - this.speechStartTimestamp >= 100 && !this.isCurrentlyDucked) {
        // Melewati ambang batas bicara selama > 100 ms -> turunkan volume sebesar 30% dalam 150 ms
        this.isCurrentlyDucked = true;
        const targetDuckedVol = +(this.baseVolume * 0.7).toFixed(3);
        this.rampVideoVolume(targetDuckedVol, 150);
      }
    } else {
      this.speechStartTimestamp = null;
      if (this.isCurrentlyDucked) {
        // Selesai berbicara -> kembalikan ke 100% baseVolume dalam 450 ms
        this.isCurrentlyDucked = false;
        this.rampVideoVolume(this.baseVolume, 450);
      }
    }

    const currentVol = this.videoElement ? this.videoElement.volume : this.baseVolume;
    this.onRmsUpdate?.(rms, this.isCurrentlyDucked, currentVol);
  }

  private rampVideoVolume(targetVolume: number, durationMs: number) {
    if (!this.videoElement) return;
    if (this.rampAnimationId !== null) {
      window.cancelAnimationFrame(this.rampAnimationId);
    }

    const startVolume = this.videoElement.volume;
    const startTime = performance.now();

    const step = (now: number) => {
      if (!this.videoElement) return;
      const progress = Math.min(1, (now - startTime) / durationMs);
      const interpolated = startVolume + (targetVolume - startVolume) * progress;
      this.videoElement.volume = Math.max(0, Math.min(1, interpolated));

      if (progress < 1) {
        this.rampAnimationId = window.requestAnimationFrame(step);
      } else {
        this.rampAnimationId = null;
      }
    };

    this.rampAnimationId = window.requestAnimationFrame(step);
  }

  public stop() {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.sourceNode?.disconnect();
    this.analyser?.disconnect();
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => {});
    }
  }
}
