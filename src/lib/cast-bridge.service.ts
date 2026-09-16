import { Inject, Injectable, Optional } from '@angular/core';
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
import { BehaviorSubject } from 'rxjs';
import { CAST_PLAYER_CONFIG, CastPlayerConfig } from './cast-player.config';
import { CastPlayer, readCastPlayerCapacitorConfig } from '../plugin';
import type { CastLoadMediaOptions, CastMediaStateEvent } from '../plugin/definitions';

@Injectable({ providedIn: 'root' })
export class CastBridgeService {
  readonly available$ = new BehaviorSubject(false);
  readonly connected$ = new BehaviorSubject(false);
  readonly mediaState$ = new BehaviorSubject<CastMediaStateEvent | null>(null);

  private initialized = false;
  private listeners: PluginListenerHandle[] = [];
  private initiator: object | null = null;

  constructor(@Optional() @Inject(CAST_PLAYER_CONFIG) private readonly config: CastPlayerConfig | null) {}

  get plugin() {
    return CastPlayer;
  }

  get enabled(): boolean {
    return Capacitor.isNativePlatform() && !!this.receiverAppId;
  }

  private get receiverAppId(): string | undefined {
    return this.config?.receiverAppId?.trim() || readCastPlayerCapacitorConfig().receiverAppId;
  }

  async init(): Promise<void> {
    if (this.initialized || !this.enabled) {
      return;
    }
    this.initialized = true;

    try {
      await CastPlayer.initialize({ receiverAppId: this.receiverAppId });

      this.listeners.push(
        await CastPlayer.addListener('availabilityChanged', (data) => {
          this.available$.next(!!data.available);
        }),
        await CastPlayer.addListener('sessionStateChanged', (data) => {
          this.connected$.next(data.state === 'connected');
        }),
        await CastPlayer.addListener('mediaStateChanged', (data) => {
          this.mediaState$.next(data);
        }),
      );

      const state = await CastPlayer.getState();
      this.available$.next(!!state.available);
      this.connected$.next(!!state.connected);
    } catch (err) {
      console.warn('[CastPlayer] init failed', err);
      this.initialized = false;
    }
  }

  setInitiator(owner: object): void {
    this.initiator = owner;
  }

  isInitiator(owner: object): boolean {
    return this.initiator === owner;
  }

  async requestSession(): Promise<void> {
    await CastPlayer.requestSession();
  }

  async endSession(): Promise<void> {
    await CastPlayer.endSession();
  }

  async loadMedia(options: CastLoadMediaOptions): Promise<void> {
    await CastPlayer.loadMedia(options);
  }

  async play(): Promise<void> {
    await CastPlayer.play();
  }

  async pause(): Promise<void> {
    await CastPlayer.pause();
  }

  async seek(position: number): Promise<void> {
    await CastPlayer.seek({ position });
  }

  async restartDiscovery(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    try {
      const result = await CastPlayer.restartDiscovery();
      this.available$.next(result.castState > 1);
    } catch (err) {
      console.warn('[CastPlayer] restartDiscovery failed', err);
    }
  }
}
