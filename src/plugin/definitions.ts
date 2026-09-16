export interface CastPlayerInitializeOptions {
  /** Surcharge optionnelle. Sinon : `plugins.CastPlayer.receiverAppId` dans capacitor.config.ts. */
  receiverAppId?: string;
}

export interface CastLoadMediaOptions {
  url: string;
  contentType?: string;
  title?: string;
  description?: string;
  posterUrl?: string;
  startPosition?: number;
  autoplay?: boolean;
  customData?: Record<string, unknown>;
}

export interface CastAvailabilityEvent {
  available: boolean;
}

export interface CastSessionStateEvent {
  state: 'starting' | 'connected' | 'failed' | 'ending' | 'disconnected' | 'resuming' | 'suspended';
  deviceName?: string;
}

export interface CastMediaStateEvent {
  playerState: string;
  idleReason?: string;
  currentTime?: number;
  duration?: number;
  volume?: number;
  muted?: boolean;
  error?: string;
  message?: string;
}

export interface CastPlayerPlugin {
  initialize(options?: CastPlayerInitializeOptions): Promise<void>;
  isAvailable(): Promise<{ available: boolean }>;
  restartDiscovery(): Promise<{ success: boolean; castState: number }>;
  requestSession(): Promise<{ sessionId: string; deviceName: string }>;
  endSession(): Promise<void>;
  loadMedia(options: CastLoadMediaOptions): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { position: number }): Promise<void>;
  stop(): Promise<void>;
  setVolume(options: { volume: number }): Promise<void>;
  getState(): Promise<{
    available: boolean;
    connected: boolean;
    initialized: boolean;
    castState?: number;
    castStateName?: string;
    deviceName?: string;
    sessionId?: string;
  }>;
  getDiagnostics(): Promise<Record<string, unknown>>;
  addListener(
    eventName: 'availabilityChanged',
    listenerFunc: (event: CastAvailabilityEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: 'sessionStateChanged',
    listenerFunc: (event: CastSessionStateEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  addListener(
    eventName: 'mediaStateChanged',
    listenerFunc: (event: CastMediaStateEvent) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}
