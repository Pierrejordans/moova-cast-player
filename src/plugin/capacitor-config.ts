import { Capacitor } from '@capacitor/core';

interface CapacitorConfigShape {
  plugins?: {
    CastPlayer?: {
      receiverAppId?: string;
    };
  };
}

interface CapacitorWithConfig {
  getConfig?: () => CapacitorConfigShape;
  config?: CapacitorConfigShape;
}

export function readCastPlayerCapacitorConfig(): { receiverAppId?: string } {
  const cap = Capacitor as CapacitorWithConfig;
  const plugins = (typeof cap.getConfig === 'function' ? cap.getConfig()?.plugins : undefined)
    ?? cap.config?.plugins
    ?? {};
  const receiverAppId = plugins.CastPlayer?.receiverAppId?.trim();
  return receiverAppId ? { receiverAppId } : {};
}
