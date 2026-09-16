import { registerPlugin } from '@capacitor/core';
import type { CastPlayerPlugin } from './definitions';

const CastPlayer = registerPlugin<CastPlayerPlugin>('CastPlayer', {
  web: () => import('./web').then((m) => new m.CastPlayerWeb()),
});

export * from './definitions';
export { CastPlayer };
export { readCastPlayerCapacitorConfig } from './capacitor-config';
