export type UserRole = 'HOST' | 'GUEST';

export type SyncAction = 'PLAY' | 'PAUSE' | 'SEEK' | 'HEARTBEAT' | 'MEDIA_CHANGE';

export type MediaMode = 'LOCAL_HTTP' | 'EXTERNAL_URL' | 'WEBRTC_SCREEN';

export interface SyncStateMessage {
  type: 'SYNC_STATE';
  senderRole: UserRole;
  action: SyncAction;
  videoTime: number;
  serverTimestamp: number;
  playbackRate: number;
  mediaSource?: string;
  isPlaying?: boolean;
}

export interface PingMessage {
  type: 'PING';
  seq: number;
  clientSentTime: number;
}

export interface PongMessage {
  type: 'PONG';
  seq: number;
  clientSentTime: number;
  serverTimestamp: number;
}

export interface RoomPeer {
  peerId: string;
  role: UserRole;
}

export interface RoomPresenceMessage {
  type: 'ROOM_PRESENCE';
  roomId: string;
  peers: RoomPeer[];
  serverTimestamp: number;
}

export interface WebRTCSignalMessage {
  type: 'WEBRTC_SIGNAL';
  signalType: 'SDP_OFFER' | 'SDP_ANSWER' | 'ICE_CANDIDATE';
  senderPeerId?: string;
  senderRole?: UserRole;
  targetPeerId?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  isScreenShare?: boolean;
}

export type SyncZone = 'LOCKED_SYNC' | 'SOFT_RATE_ADAPT' | 'HARD_SEEK';

export interface SyncTelemetry {
  rttMs: number;
  oneWayLatencyMs: number;
  clockOffsetMs: number;
  driftSeconds: number;
  activePlaybackRate: number;
  zone: SyncZone;
  samplesCollected: number;
}
