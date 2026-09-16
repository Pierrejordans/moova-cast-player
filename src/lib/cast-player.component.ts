import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  Optional,
  Output,
  SimpleChanges,
  ViewChild,
  ViewEncapsulation,
} from '@angular/core';
import { SafeResourceUrl } from '@angular/platform-browser';
import { Capacitor } from '@capacitor/core';
import { ScreenOrientation } from '@capacitor/screen-orientation';
import { IonRouterOutlet } from '@ionic/angular';
import Hls from 'hls.js';
import { Subscription } from 'rxjs';
import { CastBridgeService } from './cast-bridge.service';
import {
  FullscreenChangeEvent,
  ObjectFitMode,
  PlayingStartedEvent,
  TimeUpdateEvent,
} from './cast-player.types';

@Component({
  selector: 'moova-cast-player',
  templateUrl: './cast-player.component.html',
  styleUrls: ['./cast-player.component.scss'],
  encapsulation: ViewEncapsulation.None,
  standalone: false,
})
export class CastPlayerComponent implements OnInit, AfterViewInit, OnChanges, OnDestroy {
  @Input() src: string | SafeResourceUrl = '';
  @Input() poster: string | SafeResourceUrl = '';
  @Input() title = '';
  @Input() autoplay = false;
  @Input() muted = false;
  @Input() loop = false;
  @Input() startPosition = 0;
  @Input() isVisible = true;
  @Input() rotationFullscreen = false;
  @Input() enableCast = true;
  @Input() objectFit: ObjectFitMode = 'contain';
  @Input() customData: Record<string, unknown> | null = null;
  @Input() contentType?: string;

  @Output() play = new EventEmitter<void>();
  @Output() pause = new EventEmitter<void>();
  @Output() ended = new EventEmitter<void>();
  @Output() error = new EventEmitter<unknown>();
  @Output() timeupdate = new EventEmitter<TimeUpdateEvent>();
  @Output() playingStarted = new EventEmitter<PlayingStartedEvent>();
  @Output() fullscreenChange = new EventEmitter<FullscreenChangeEvent>();
  @Output() castStart = new EventEmitter<void>();
  @Output() castEnd = new EventEmitter<void>();
  @Output() ready = new EventEmitter<void>();

  @ViewChild('videoEl') videoEl: ElementRef<HTMLVideoElement>;
  @ViewChild('hostEl') hostEl: ElementRef<HTMLElement>;

  isPlaying = false;
  hasActuallyPlayed = false;
  isCasting = false;
  castAvailable = false;
  fullscreen = false;
  controlsVisible = false;
  progressPercent = 0;
  bufferedPercent = 0;
  isWeb = Capacitor.getPlatform() === 'web';

  private hls: Hls | null = null;
  private playerReady = false;
  private seeking = false;
  private duration = 0;
  private lastPosition = 0;
  private hideControlTimeout: ReturnType<typeof setTimeout> | null = null;
  private subscriptions: Subscription[] = [];
  private fullscreenListener: (() => void) | null = null;
  private onOrientationChange: (() => void) | null = null;
  private onPhysicalOrientationChange: ((event: DeviceOrientationEvent) => void) | null = null;
  private fullscreenHasSeenLandscape = false;
  private fullscreenHasSeenPhysicalLandscape = false;
  private suppressAutoFullscreenUntilPortrait = false;
  private hasSetStartPosition = false;
  private mediaBound = false;

  constructor(
    private readonly castBridge: CastBridgeService,
    @Optional() private readonly routerOutlet?: IonRouterOutlet,
  ) {}

  get video(): HTMLVideoElement | null {
    return this.videoEl?.nativeElement ?? null;
  }

  ngOnInit(): void {
    this.watchFullscreen();
    if (this.enableCast) {
      void this.castBridge.init();
    }
    this.subscriptions.push(
      this.castBridge.available$.subscribe((available) => (this.castAvailable = available)),
      this.castBridge.connected$.subscribe((connected) => this.onCastConnection(connected)),
      this.castBridge.mediaState$.subscribe((state) => {
        if (!state || !this.isCasting) {
          return;
        }
        const currentTime = Number(state.currentTime);
        if (Number.isFinite(currentTime) && currentTime >= 0) {
          this.lastPosition = currentTime;
          if (this.duration > 0) {
            this.progressPercent = (currentTime / this.duration) * 100;
          }
        }
      }),
    );
  }

  ngAfterViewInit(): void {
    if (this.isVisible) {
      setTimeout(() => this.setupPlayer(), 50);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['isVisible'] && !this.isVisible) {
      this.teardownMedia(false);
      return;
    }

    if (!this.isVisible || !this.videoEl) {
      return;
    }

    const srcChanged = !!changes['src'] && !changes['src'].firstChange;
    if (srcChanged) {
      this.teardownMedia(true);
      this.hasSetStartPosition = false;
    }

    if (!changes['src']?.firstChange && !changes['isVisible']?.firstChange) {
      setTimeout(() => this.setupPlayer(), 50);
    }
  }

  ngOnDestroy(): void {
    this.teardownOrientationListeners();
    this.teardownMedia(true);
    this.subscriptions.forEach((s) => s.unsubscribe());
    if (this.fullscreenListener) {
      document.removeEventListener('fullscreenchange', this.fullscreenListener);
    }
    if (this.fullscreen) {
      void this.applyExitOrientation();
    }
  }

  async togglePlay(): Promise<void> {
    if (this.isCasting) {
      try {
        if (this.isPlaying) {
          await this.castBridge.pause();
          this.isPlaying = false;
        } else {
          await this.castBridge.play();
          this.isPlaying = true;
        }
      } catch (err) {
        this.error.emit(err);
      }
      this.onUserActivity();
      return;
    }

    const video = this.video;
    if (!video) {
      return;
    }
    if (this.isPlaying) {
      video.pause();
    } else {
      await video.play().catch((err) => this.error.emit(err));
    }
    this.onUserActivity();
  }

  onVideoClick(): void {
    if (this.isWeb && this.hasActuallyPlayed) {
      void this.togglePlay();
    } else {
      this.onUserActivity();
    }
  }

  onUserActivity(): void {
    this.controlsVisible = true;
    if (this.hideControlTimeout) {
      clearTimeout(this.hideControlTimeout);
    }
    if (this.isPlaying && !this.isWeb) {
      this.hideControlTimeout = setTimeout(() => {
        this.controlsVisible = false;
      }, 1500);
    }
  }

  onMouseLeave(): void {
    if (!this.isWeb) {
      return;
    }
    if (this.hideControlTimeout) {
      clearTimeout(this.hideControlTimeout);
    }
    if (this.isPlaying) {
      this.controlsVisible = false;
    }
  }

  async toggleFullscreen(): Promise<void> {
    if (this.fullscreen) {
      await this.exitFullscreen();
    } else {
      await this.enterFullscreen();
    }
    this.onUserActivity();
  }

  async enterFullscreen(): Promise<void> {
    const host = this.hostEl?.nativeElement;
    const video = this.video;
    if (!host) {
      return;
    }

    if (this.rotationFullscreen) {
      await this.unlockOrientation('enter-fs');
    }

    const webkitVideo = video as HTMLVideoElement & {
      webkitEnterFullscreen?: () => void;
      webkitRequestFullscreen?: () => void;
    };

    try {
      if (host.requestFullscreen) {
        await host.requestFullscreen();
      } else if (webkitVideo?.webkitEnterFullscreen) {
        webkitVideo.webkitEnterFullscreen();
      } else if (webkitVideo?.webkitRequestFullscreen) {
        webkitVideo.webkitRequestFullscreen();
      }
    } catch (err) {
      console.warn('[CastPlayer] requestFullscreen failed', err);
    }
  }

  async exitFullscreen(): Promise<void> {
    const doc = document as Document & { webkitExitFullscreen?: () => void };
    const webkitVideo = this.video as (HTMLVideoElement & { webkitExitFullscreen?: () => void }) | undefined;
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (doc.webkitExitFullscreen) {
        doc.webkitExitFullscreen();
      } else if (webkitVideo?.webkitExitFullscreen) {
        webkitVideo.webkitExitFullscreen();
      }
    } catch (err) {
      console.warn('[CastPlayer] exitFullscreen failed', err);
    }
  }

  onSeekStart(event: PointerEvent): void {
    this.seeking = true;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    void this.seekFromEvent(event);
    this.onUserActivity();
  }

  onSeekMove(event: PointerEvent): void {
    if (!this.seeking) {
      return;
    }
    void this.seekFromEvent(event);
  }

  onSeekEnd(event: PointerEvent): void {
    if (!this.seeking) {
      return;
    }
    this.seeking = false;
    void this.seekFromEvent(event);
    this.onUserActivity();
  }

  async onCastClick(): Promise<void> {
    try {
      if (this.isCasting) {
        this.syncLocalFromCast();
        await this.castBridge.endSession();
      } else {
        this.castBridge.setInitiator(this);
        await this.castBridge.requestSession();
      }
    } catch (err) {
      this.error.emit(err);
    }
  }

  playMedia(): Promise<void> {
    return this.togglePlay();
  }

  pauseMedia(): void {
    this.video?.pause();
  }

  seek(seconds: number): void {
    const video = this.video;
    if (!video) {
      return;
    }
    video.currentTime = Math.max(0, seconds);
    this.lastPosition = video.currentTime;
    if (this.isCasting) {
      void this.castBridge.seek(seconds);
    }
  }

  getCurrentTime(): number {
    return this.lastPosition;
  }

  getDuration(): number {
    return this.duration;
  }

  private resolveSrc(): string {
    const value = this.src as unknown;
    if (!value) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    return (value as { changingThisBreaksApplicationSecurity?: string }).changingThisBreaksApplicationSecurity || '';
  }

  private resolvePoster(): string {
    const value = this.poster as unknown;
    if (!value) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    return (value as { changingThisBreaksApplicationSecurity?: string }).changingThisBreaksApplicationSecurity || '';
  }

  private setupPlayer(): void {
    const video = this.video;
    const mediaUrl = this.resolveSrc();
    if (!video || !mediaUrl) {
      return;
    }

    video.muted = this.muted;
    video.loop = this.loop;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('webkit-playsinline', 'true');

    if (!this.mediaBound) {
      this.bindVideoEvents(video);
      this.mediaBound = true;
    }

    if (!this.playerReady) {
      this.attachMedia(video, mediaUrl);
      this.playerReady = true;
      this.ready.emit();
    }

    if (this.rotationFullscreen) {
      this.setupOrientationFullscreenListener();
    }

    if (this.autoplay) {
      video.play().catch((err) => this.error.emit(err));
    }
  }

  private attachMedia(video: HTMLVideoElement, mediaUrl: string): void {
    const isIos = Capacitor.getPlatform() === 'ios';
    const hls = this.isHls(mediaUrl);

    if (!isIos && hls && Hls.isSupported()) {
      this.hls?.destroy();
      this.hls = new Hls({ enableWorker: true, startLevel: -1 });
      this.hls.loadSource(mediaUrl);
      this.hls.attachMedia(video);
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (this.hls) {
          this.hls.currentLevel = -1;
        }
      });
      this.hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data?.fatal) {
          this.error.emit(data);
        }
      });
    } else {
      video.src = mediaUrl;
    }
  }

  private isHls(url: string): boolean {
    const lower = url.toLowerCase();
    return lower.includes('.m3u8') || lower.includes('mpegurl') || this.contentType?.toLowerCase().includes('mpegurl');
  }

  private inferredContentType(url: string): string {
    if (this.contentType) {
      return this.contentType;
    }
    return this.isHls(url) ? 'application/x-mpegURL' : 'video/mp4';
  }

  private bindVideoEvents(video: HTMLVideoElement): void {
    video.onplay = () => {
      this.isPlaying = true;
      this.hasActuallyPlayed = true;
      this.controlsVisible = true;
      this.play.emit();
      this.emitPlayingStarted();
      this.onUserActivity();
    };
    video.onpause = () => {
      this.isPlaying = false;
      this.controlsVisible = true;
      this.pause.emit();
    };
    video.onended = () => this.ended.emit();
    video.onerror = () => this.error.emit(video.error);
    video.onloadedmetadata = () => {
      this.duration = video.duration || 0;
      this.applyStartPosition();
      this.emitPlayingStarted();
    };
    video.ontimeupdate = () => {
      if (this.seeking || this.isCasting) {
        return;
      }
      this.lastPosition = video.currentTime;
      if (this.duration > 0) {
        this.progressPercent = (video.currentTime / this.duration) * 100;
      }
      this.updateBuffered(video);
      this.timeupdate.emit({
        currentTime: video.currentTime,
        duration: this.duration,
        progress: this.progressPercent,
      });
    };
  }

  private emitPlayingStarted(): void {
    const video = this.video;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      return;
    }
    this.playingStarted.emit({
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    });
  }

  private applyStartPosition(): void {
    const video = this.video;
    if (!video || this.hasSetStartPosition || this.startPosition <= 0) {
      return;
    }
    video.currentTime = this.startPosition;
    this.hasSetStartPosition = true;
  }

  private updateBuffered(video: HTMLVideoElement): void {
    if (!video.buffered?.length || !this.duration) {
      this.bufferedPercent = 0;
      return;
    }
    try {
      const end = video.buffered.end(video.buffered.length - 1);
      this.bufferedPercent = Math.min(100, (end / this.duration) * 100);
    } catch {
      this.bufferedPercent = 0;
    }
  }

  private async seekFromEvent(event: PointerEvent): Promise<void> {
    if (!this.duration) {
      return;
    }
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const seconds = ratio * this.duration;
    this.progressPercent = ratio * 100;
    this.lastPosition = seconds;
    if (this.isCasting) {
      await this.castBridge.seek(seconds);
      return;
    }
    if (this.video) {
      this.video.currentTime = seconds;
    }
  }

  private teardownMedia(resetSrc: boolean): void {
    if (this.hideControlTimeout) {
      clearTimeout(this.hideControlTimeout);
    }
    this.hls?.destroy();
    this.hls = null;
    const video = this.video;
    if (video) {
      video.pause();
      if (resetSrc) {
        video.removeAttribute('src');
        video.load();
      }
    }
    this.playerReady = false;
    this.isPlaying = false;
  }

  private async onCastConnection(connected: boolean): Promise<void> {
    if (connected && this.castBridge.isInitiator(this) && !this.isCasting) {
      this.isCasting = true;
      this.castStart.emit();
      await this.loadOnCast();
    } else if (connected && !this.castBridge.isInitiator(this)) {
      this.video?.pause();
    } else if (!connected && this.isCasting) {
      this.isCasting = false;
      this.syncLocalFromCast();
      this.castEnd.emit();
    }
  }

  private async loadOnCast(): Promise<void> {
    const url = this.resolveSrc();
    if (!url) {
      return;
    }
    try {
      await this.castBridge.loadMedia({
        url,
        contentType: this.inferredContentType(url),
        title: this.title || 'Video',
        posterUrl: this.resolvePoster() || undefined,
        startPosition: Math.floor(this.lastPosition || this.startPosition || 0),
        autoplay: true,
        customData: this.customData || undefined,
      });
      this.video?.pause();
    } catch (err) {
      this.error.emit(err);
    }
  }

  private syncLocalFromCast(): void {
    if (this.lastPosition <= 0 || !this.video) {
      return;
    }
    this.video.currentTime = this.lastPosition;
    if (this.duration > 0) {
      this.progressPercent = (this.lastPosition / this.duration) * 100;
    }
  }

  private watchFullscreen(): void {
    if (this.fullscreenListener) {
      return;
    }
    this.fullscreenListener = () => {
      const wasFullscreen = this.fullscreen;
      this.fullscreen = this.isFullscreen();
      if (this.routerOutlet) {
        this.routerOutlet.swipeGesture = !this.fullscreen;
      }
      if (this.fullscreen && !wasFullscreen) {
        this.fullscreenHasSeenLandscape = window.innerWidth > window.innerHeight;
        this.fullscreenHasSeenPhysicalLandscape = false;
        this.suppressAutoFullscreenUntilPortrait = false;
        void this.applyEnterOrientation();
      } else if (!this.fullscreen && wasFullscreen) {
        this.fullscreenHasSeenLandscape = false;
        this.fullscreenHasSeenPhysicalLandscape = false;
        if (this.isPhone()) {
          this.suppressAutoFullscreenUntilPortrait = window.innerWidth > window.innerHeight;
        }
        void this.applyExitOrientation();
      }
      this.fullscreenChange.emit({ fullscreen: this.fullscreen });
    };
    document.addEventListener('fullscreenchange', this.fullscreenListener);
  }

  private isFullscreen(): boolean {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const webkitVideo = this.video as (HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }) | null;
    return !!(document.fullscreenElement ?? doc.webkitFullscreenElement ?? webkitVideo?.webkitDisplayingFullscreen);
  }

  private isPhone(): boolean {
    return Math.min(window.innerWidth, window.innerHeight) < 600;
  }

  private async applyEnterOrientation(): Promise<void> {
    if (!Capacitor.isNativePlatform() || this.isWeb) {
      return;
    }
    if (this.rotationFullscreen && (Capacitor.getPlatform() === 'ios' || !this.isPhone())) {
      await this.unlockOrientation('fs-enter');
      return;
    }
    try {
      await ScreenOrientation.lock({ orientation: 'landscape' });
    } catch {
      /* ignore */
    }
  }

  private async applyExitOrientation(): Promise<void> {
    if (!Capacitor.isNativePlatform() || this.isWeb) {
      return;
    }
    if (this.rotationFullscreen) {
      await this.unlockOrientation('fs-exit');
      return;
    }
    try {
      await ScreenOrientation.lock({ orientation: 'portrait' });
    } catch {
      /* ignore */
    }
  }

  private async unlockOrientation(origin: string): Promise<void> {
    try {
      await ScreenOrientation.unlock();
    } catch (err) {
      console.warn('[CastPlayer] unlock failed', origin, err);
    }
  }

  private setupOrientationFullscreenListener(): void {
    this.teardownOrientationListeners();
    if (!this.rotationFullscreen || !Capacitor.isNativePlatform() || Capacitor.getPlatform() === 'ios') {
      return;
    }

    this.onOrientationChange = () => {
      if (!this.isPhone()) {
        return;
      }
      if (this.isFullscreen()) {
        if (window.innerWidth > window.innerHeight) {
          this.fullscreenHasSeenLandscape = true;
        } else if (this.fullscreenHasSeenLandscape) {
          void this.exitFullscreen();
        }
        return;
      }
      if (window.innerHeight > window.innerWidth) {
        this.suppressAutoFullscreenUntilPortrait = false;
      }
      if (window.innerWidth > window.innerHeight && !this.suppressAutoFullscreenUntilPortrait) {
        void this.enterFullscreen();
      }
    };

    this.onPhysicalOrientationChange = (event: DeviceOrientationEvent) => {
      if (!this.isPhone() || !this.isFullscreen()) {
        return;
      }
      const physical = this.getPhysicalOrientation(event);
      if (physical === 'landscape') {
        this.fullscreenHasSeenPhysicalLandscape = true;
        this.fullscreenHasSeenLandscape = true;
        return;
      }
      if (physical === 'portrait' && this.fullscreenHasSeenPhysicalLandscape) {
        void this.exitFullscreen();
      }
    };

    window.addEventListener('orientationchange', this.onOrientationChange);
    screen.orientation?.addEventListener?.('change', this.onOrientationChange);
    window.addEventListener('deviceorientation', this.onPhysicalOrientationChange);
  }

  private teardownOrientationListeners(): void {
    if (this.onOrientationChange) {
      window.removeEventListener('orientationchange', this.onOrientationChange);
      screen.orientation?.removeEventListener?.('change', this.onOrientationChange);
      this.onOrientationChange = null;
    }
    if (this.onPhysicalOrientationChange) {
      window.removeEventListener('deviceorientation', this.onPhysicalOrientationChange);
      this.onPhysicalOrientationChange = null;
    }
  }

  private getPhysicalOrientation(event: DeviceOrientationEvent): 'portrait' | 'landscape' | null {
    if (event.beta == null || event.gamma == null) {
      return null;
    }
    const beta = Math.abs(event.beta);
    const gamma = Math.abs(event.gamma);
    if (gamma > 45 && gamma > beta * 0.65) {
      return 'landscape';
    }
    if (beta > 45 && beta > gamma * 0.65) {
      return 'portrait';
    }
    return null;
  }
}
