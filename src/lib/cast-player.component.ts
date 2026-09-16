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
import { Capacitor, PluginListenerHandle } from '@capacitor/core';
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
  @Input()
  set autoPlay(value: boolean) {
    this.autoplay = !!value;
  }
  @Input() muted = false;
  @Input() loop = false;
  @Input() startPosition = 0;
  @Input() startProgress = 0;
  @Input() startRewindSeconds = 0;
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
  showPoster = true;
  isCasting = false;
  castAvailable = false;
  fullscreen = false;
  controlsVisible = false;
  progressPercent = 0;
  bufferedPercent = 0;
  isWeb = Capacitor.getPlatform() === 'web';
  isIos = Capacitor.getPlatform() === 'ios';
  private autoplayBlocked = false;
  private userInitiatedPlay = false;

  private hls: Hls | null = null;
  private playerReady = false;
  private seeking = false;
  private duration = 0;
  private lastPosition = 0;
  private hideControlTimeout: ReturnType<typeof setTimeout> | null = null;
  private subscriptions: Subscription[] = [];
  private fullscreenListener: (() => void) | null = null;
  private onOrientationChange: (() => void) | null = null;
  private screenOrientationHandle: PluginListenerHandle | null = null;
  private enteringFullscreen = false;
  private veilHideTimeout: ReturnType<typeof setTimeout> | null = null;
  private fullscreenHasSeenLandscape = false;
  private fullscreenHasSeenPhysicalLandscape = false;
  private suppressAutoFullscreenUntilPortrait = false;
  private hasSetStartPosition = false;
  private pendingInitialSeek = false;
  private resolvedStartSeconds = 0;
  private initialSeekTimeout: ReturnType<typeof setTimeout> | null = null;
  private revealFailsafeTimeout: ReturnType<typeof setTimeout> | null = null;
  private mediaBound = false;

  constructor(
    private readonly castBridge: CastBridgeService,
    @Optional() private readonly routerOutlet?: IonRouterOutlet,
  ) {}

  get video(): HTMLVideoElement | null {
    return this.videoEl?.nativeElement ?? null;
  }

  get chromeVisible(): boolean {
    if (this.controlsVisible) {
      return true;
    }
    if (this.isPlaying) {
      return false;
    }
    if (this.autoplay && !this.hasActuallyPlayed && !this.autoplayBlocked) {
      return false;
    }
    return true;
  }

  get showInitialLoader(): boolean {
    return this.autoplay && this.showPoster && !this.autoplayBlocked;
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
      this.pendingInitialSeek = false;
      this.resolvedStartSeconds = 0;
      this.showPoster = true;
      this.hasActuallyPlayed = false;
      this.autoplayBlocked = false;
      this.userInitiatedPlay = false;
      this.controlsVisible = false;
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
      document.removeEventListener('webkitfullscreenchange', this.fullscreenListener);
    }
    if (this.veilHideTimeout) {
      clearTimeout(this.veilHideTimeout);
    }
    if (this.initialSeekTimeout) {
      clearTimeout(this.initialSeekTimeout);
    }
    if (this.revealFailsafeTimeout) {
      clearTimeout(this.revealFailsafeTimeout);
    }
    this.hideVeil();
    if (this.rotationFullscreen && Capacitor.isNativePlatform() && this.isPhone()) {
      void ScreenOrientation.lock({ orientation: 'portrait' });
    } else if (this.fullscreen) {
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
      this.userInitiatedPlay = true;
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
    if (!host || this.fullscreen || this.enteringFullscreen) {
      return;
    }

    this.enteringFullscreen = true;
    this.showVeil();
    await this.applyEnterOrientation();

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
    this.enteringFullscreen = false;
  }

  async exitFullscreen(): Promise<void> {
    this.showVeil();
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
    video.playsInline = true;
    video.preload = this.autoplay ? 'auto' : 'metadata';
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
      void this.unlockOrientation('player-visible');
      void this.setupOrientationFullscreenListener();
    }

    if (this.autoplay && !this.needsInitialStart()) {
      this.requestAutoplay(video);
    }
    if (this.autoplay) {
      this.armRevealFailsafe();
    }
  }

  private needsInitialStart(): boolean {
    return this.startPosition > 0 || this.startProgress > 0;
  }

  private requestAutoplay(video: HTMLVideoElement): void {
    if (this.pendingInitialSeek) {
      return;
    }
    video.autoplay = true;
    const tryPlay = () => {
      if (this.pendingInitialSeek) {
        return;
      }
      void video.play().catch((err) => {
        this.autoplayBlocked = true;
        this.error.emit(err);
      });
    };
    if (video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      tryPlay();
      return;
    }
    video.addEventListener('canplay', tryPlay, { once: true });
    tryPlay();
  }

  private attachMedia(video: HTMLVideoElement, mediaUrl: string): void {
    const isIos = Capacitor.getPlatform() === 'ios';
    const hls = this.isHls(mediaUrl);

    if (!isIos && hls && Hls.isSupported()) {
      this.hls?.destroy();
      this.hls = new Hls({
        enableWorker: true,
        startLevel: -1,
        autoStartLoad: false,
      });
      this.hls.loadSource(mediaUrl);
      this.hls.attachMedia(video);
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (this.hls) {
          this.hls.currentLevel = -1;
        }
        this.applyStartPosition();
        this.hls?.startLoad(this.resolvedStartSeconds > 0 ? this.resolvedStartSeconds : -1);
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
      if (this.pendingInitialSeek || this.showPoster) {
        return;
      }
      this.onPlaybackVisible();
    };
    video.onplaying = () => {
      if (!this.canRevealPlayback(video)) {
        return;
      }
      this.onPlaybackVisible();
    };
    video.onpause = () => {
      this.isPlaying = false;
      if (this.showPoster) {
        return;
      }
      this.controlsVisible = true;
      this.pause.emit();
    };
    video.addEventListener('webkitbeginfullscreen', () => this.fullscreenListener?.());
    video.addEventListener('webkitendfullscreen', () => this.fullscreenListener?.());
    video.onended = () => this.ended.emit();
    video.onerror = () => this.error.emit(video.error);
    video.onloadedmetadata = () => {
      this.duration = video.duration || 0;
      this.applyStartPosition();
      this.emitPlayingStarted();
    };
    video.ontimeupdate = () => {
      if (this.showPoster && this.autoplay && !video.paused && this.canRevealPlayback(video)) {
        this.onPlaybackVisible();
      }
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

  private canRevealPlayback(video: HTMLVideoElement): boolean {
    if (this.pendingInitialSeek) {
      return false;
    }
    if (this.resolvedStartSeconds <= 1) {
      return true;
    }
    return video.currentTime >= this.resolvedStartSeconds - 1.5;
  }

  private armRevealFailsafe(): void {
    if (this.revealFailsafeTimeout) {
      return;
    }
    this.revealFailsafeTimeout = setTimeout(() => {
      const video = this.video;
      if (!this.showPoster || !video || video.paused) {
        return;
      }
      this.pendingInitialSeek = false;
      this.onPlaybackVisible();
    }, 8000);
  }

  private onPlaybackVisible(): void {
    if (this.revealFailsafeTimeout) {
      clearTimeout(this.revealFailsafeTimeout);
      this.revealFailsafeTimeout = null;
    }
    this.showPoster = false;
    this.pendingInitialSeek = false;
    this.isPlaying = true;
    if (this.hasActuallyPlayed) {
      return;
    }
    this.hasActuallyPlayed = true;
    this.play.emit();
    this.emitPlayingStarted();
    if (this.autoplay && !this.userInitiatedPlay) {
      this.controlsVisible = false;
      return;
    }
    this.controlsVisible = true;
    this.onUserActivity();
  }

  private computeStartSeconds(duration: number): number {
    let seconds = 0;
    if (this.startPosition > 0) {
      seconds = this.startPosition;
    } else if (this.startProgress > 0 && duration > 0 && Number.isFinite(duration)) {
      seconds = (this.startProgress / 100) * duration - (this.startRewindSeconds || 0);
    }
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return 0;
    }
    if (duration > 0 && Number.isFinite(duration)) {
      return Math.min(seconds, Math.max(0, duration - 0.5));
    }
    return seconds;
  }

  private applyStartPosition(): void {
    const video = this.video;
    if (!video || this.hasSetStartPosition) {
      return;
    }
    const duration = video.duration || this.duration || 0;
    if (this.startProgress > 0 && this.startPosition <= 0 && !(duration > 0 && Number.isFinite(duration))) {
      return;
    }

    const seconds = this.computeStartSeconds(duration);
    this.resolvedStartSeconds = seconds;
    this.hasSetStartPosition = true;
    if (seconds <= 0 || Math.abs(video.currentTime - seconds) < 0.35) {
      this.pendingInitialSeek = false;
      if (this.autoplay) {
        this.requestAutoplay(video);
      }
      return;
    }

    this.pendingInitialSeek = true;
    const onSeeked = () => {
      if (this.initialSeekTimeout) {
        clearTimeout(this.initialSeekTimeout);
        this.initialSeekTimeout = null;
      }
      this.pendingInitialSeek = false;
      if (this.autoplay) {
        this.requestAutoplay(video);
      }
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.currentTime = seconds;
    this.initialSeekTimeout = setTimeout(() => {
      if (!this.pendingInitialSeek) {
        return;
      }
      onSeeked();
    }, 2500);
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
    if (this.initialSeekTimeout) {
      clearTimeout(this.initialSeekTimeout);
      this.initialSeekTimeout = null;
    }
    if (this.revealFailsafeTimeout) {
      clearTimeout(this.revealFailsafeTimeout);
      this.revealFailsafeTimeout = null;
    }
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
    this.hasSetStartPosition = false;
    this.pendingInitialSeek = false;
    this.showPoster = true;
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
      void this.handleFullscreenChange();
    };
    document.addEventListener('fullscreenchange', this.fullscreenListener);
    document.addEventListener('webkitfullscreenchange', this.fullscreenListener);
  }

  private async handleFullscreenChange(): Promise<void> {
    const wasFullscreen = this.fullscreen;
    this.fullscreen = this.isFullscreen();
    if (this.routerOutlet) {
      this.routerOutlet.swipeGesture = !this.fullscreen;
    }
    if (this.fullscreen && !wasFullscreen) {
      this.fullscreenHasSeenLandscape = window.innerWidth > window.innerHeight;
      this.fullscreenHasSeenPhysicalLandscape = false;
      this.suppressAutoFullscreenUntilPortrait = false;
      this.showVeil();
      await this.applyEnterOrientation();
    } else if (!this.fullscreen && wasFullscreen) {
      this.fullscreenHasSeenLandscape = false;
      this.fullscreenHasSeenPhysicalLandscape = false;
      if (this.isPhone()) {
        this.suppressAutoFullscreenUntilPortrait = window.innerWidth > window.innerHeight;
      }
      this.showVeil();
      await this.applyExitOrientation();
      this.hideVeil(450);
    }
    this.fullscreenChange.emit({ fullscreen: this.fullscreen });
  }

  private isFullscreen(): boolean {
    const doc = document as Document & { webkitFullscreenElement?: Element | null };
    const webkitVideo = this.video as (HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }) | null;
    return !!(document.fullscreenElement ?? doc.webkitFullscreenElement ?? webkitVideo?.webkitDisplayingFullscreen);
  }

  private showVeil(): void {
    if (this.veilHideTimeout) {
      clearTimeout(this.veilHideTimeout);
      this.veilHideTimeout = null;
    }
    document.body.classList.add('cast-player-veil');
  }

  private hideVeil(delayMs = 0): void {
    if (this.veilHideTimeout) {
      clearTimeout(this.veilHideTimeout);
      this.veilHideTimeout = null;
    }
    const hide = () => {
      if (this.fullscreen || this.enteringFullscreen) {
        return;
      }
      document.body.classList.remove('cast-player-veil');
    };
    if (delayMs > 0) {
      this.veilHideTimeout = setTimeout(hide, delayMs);
      return;
    }
    hide();
  }

  private isPhone(): boolean {
    return Math.min(window.innerWidth, window.innerHeight) < 600;
  }

  private async applyEnterOrientation(): Promise<void> {
    if (!Capacitor.isNativePlatform() || this.isWeb) {
      return;
    }
    if (!this.isPhone()) {
      await this.unlockOrientation('fs-enter');
      return;
    }
    try {
      await ScreenOrientation.lock({ orientation: 'landscape' });
    } catch (err) {
      console.warn('[CastPlayer] landscape lock failed', err);
    }
  }

  private async applyExitOrientation(): Promise<void> {
    if (!Capacitor.isNativePlatform() || this.isWeb) {
      return;
    }
    if (!this.isPhone()) {
      await this.unlockOrientation('fs-exit');
      return;
    }
    try {
      await ScreenOrientation.lock({ orientation: 'portrait' });
    } catch (err) {
      console.warn('[CastPlayer] portrait lock failed', err);
    }
    if (!this.rotationFullscreen) {
      return;
    }
    const stillLandscape = window.innerWidth > window.innerHeight;
    this.suppressAutoFullscreenUntilPortrait = stillLandscape;
    if (!stillLandscape) {
      await this.unlockOrientation('fs-exit-ready');
    }
  }

  private async allowRotateAfterPortrait(): Promise<void> {
    if (!this.rotationFullscreen || this.isFullscreen() || !this.isPhone()) {
      return;
    }
    this.suppressAutoFullscreenUntilPortrait = false;
    await this.unlockOrientation('portrait-ready');
  }

  private async unlockOrientation(origin: string): Promise<void> {
    try {
      await ScreenOrientation.unlock();
    } catch (err) {
      console.warn('[CastPlayer] unlock failed', origin, err);
    }
  }

  private async setupOrientationFullscreenListener(): Promise<void> {
    this.teardownOrientationListeners();
    if (!this.rotationFullscreen || !Capacitor.isNativePlatform()) {
      return;
    }

    this.onOrientationChange = () => this.syncFullscreenToLayout();
    window.addEventListener('orientationchange', this.onOrientationChange);
    window.addEventListener('resize', this.onOrientationChange);
    screen.orientation?.addEventListener?.('change', this.onOrientationChange);

    this.screenOrientationHandle = await ScreenOrientation.addListener('screenOrientationChange', ({ type }) => {
      if (type.startsWith('landscape')) {
        this.syncFullscreenToPhysical('landscape');
      } else if (type.startsWith('portrait')) {
        this.syncFullscreenToPhysical('portrait');
      }
    });
  }

  private syncFullscreenToLayout(): void {
    if (!this.isPhone()) {
      return;
    }
    const landscape = window.innerWidth > window.innerHeight;
    if (this.isFullscreen()) {
      if (landscape) {
        this.fullscreenHasSeenLandscape = true;
      } else if (this.fullscreenHasSeenLandscape) {
        void this.exitFullscreen();
      }
      return;
    }
    if (!landscape) {
      void this.allowRotateAfterPortrait();
      return;
    }
    if (!this.suppressAutoFullscreenUntilPortrait) {
      void this.enterFullscreen();
    }
  }

  private syncFullscreenToPhysical(physical: 'portrait' | 'landscape'): void {
    if (!this.isPhone()) {
      return;
    }
    if (physical === 'landscape') {
      if (this.isFullscreen()) {
        this.fullscreenHasSeenPhysicalLandscape = true;
        this.fullscreenHasSeenLandscape = true;
        return;
      }
      if (!this.suppressAutoFullscreenUntilPortrait) {
        this.fullscreenHasSeenPhysicalLandscape = true;
        void this.enterFullscreen();
      }
      return;
    }
    this.suppressAutoFullscreenUntilPortrait = false;
    if (this.isFullscreen() && this.fullscreenHasSeenPhysicalLandscape) {
      void this.exitFullscreen();
      return;
    }
    void this.allowRotateAfterPortrait();
  }

  private teardownOrientationListeners(): void {
    if (this.onOrientationChange) {
      window.removeEventListener('orientationchange', this.onOrientationChange);
      window.removeEventListener('resize', this.onOrientationChange);
      screen.orientation?.removeEventListener?.('change', this.onOrientationChange);
      this.onOrientationChange = null;
    }
    void this.screenOrientationHandle?.remove();
    this.screenOrientationHandle = null;
  }
}
