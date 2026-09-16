import { CommonModule } from '@angular/common';
import { ModuleWithProviders, NgModule } from '@angular/core';
import { CAST_PLAYER_CONFIG, CastPlayerConfig } from './cast-player.config';
import { CastPlayerComponent } from './cast-player.component';

@NgModule({
  declarations: [CastPlayerComponent],
  imports: [CommonModule],
  exports: [CastPlayerComponent],
})
export class CastPlayerModule {
  static forRoot(config: CastPlayerConfig): ModuleWithProviders<CastPlayerModule> {
    return {
      ngModule: CastPlayerModule,
      providers: [{ provide: CAST_PLAYER_CONFIG, useValue: config }],
    };
  }
}
