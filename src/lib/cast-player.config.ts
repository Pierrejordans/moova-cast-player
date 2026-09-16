import { InjectionToken, Provider } from '@angular/core';

export interface CastPlayerConfig {
  /**
   * Surcharge optionnelle de `plugins.CastPlayer.receiverAppId` (capacitor.config.ts).
   * Absent = le plugin lit la config Capacitor.
   */
  receiverAppId?: string;
}

export const CAST_PLAYER_CONFIG = new InjectionToken<CastPlayerConfig>('CAST_PLAYER_CONFIG');

export function provideCastPlayer(config: CastPlayerConfig): Provider[] {
  return [{ provide: CAST_PLAYER_CONFIG, useValue: config }];
}
