import { WebPlugin } from '@capacitor/core';
import type { CastPlayerPlugin, CastLoadMediaOptions, CastPlayerInitializeOptions } from './definitions';

export class CastPlayerWeb extends WebPlugin implements CastPlayerPlugin {
  async initialize(_options?: CastPlayerInitializeOptions): Promise<void> {
    return;
  }

  async isAvailable(): Promise<{ available: boolean }> {
    return { available: false };
  }

  async restartDiscovery(): Promise<{ success: boolean; castState: number }> {
    return { success: true, castState: 1 };
  }

  async requestSession(): Promise<{ sessionId: string; deviceName: string }> {
    throw this.unimplemented('Chromecast n\'est pas disponible sur le web.');
  }

  async endSession(): Promise<void> {
    return;
  }

  async loadMedia(_options: CastLoadMediaOptions): Promise<void> {
    throw this.unimplemented('Chromecast n\'est pas disponible sur le web.');
  }

  async play(): Promise<void> {
    return;
  }

  async pause(): Promise<void> {
    return;
  }

  async seek(_options: { position: number }): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    return;
  }

  async setVolume(_options: { volume: number }): Promise<void> {
    return;
  }

  async getState() {
    return {
      available: false,
      connected: false,
      initialized: false,
      castState: 1,
      castStateName: 'WEB',
    };
  }

  async getDiagnostics(): Promise<Record<string, unknown>> {
    return { platform: 'web', available: false };
  }
}
