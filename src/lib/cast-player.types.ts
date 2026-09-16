export interface PlayingStartedEvent {
  videoWidth: number;
  videoHeight: number;
}

export interface TimeUpdateEvent {
  currentTime: number;
  duration: number;
  progress: number;
}

export interface FullscreenChangeEvent {
  fullscreen: boolean;
}

export type ObjectFitMode = 'contain' | 'cover';
