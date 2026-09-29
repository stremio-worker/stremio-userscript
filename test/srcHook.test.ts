import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';

import { detectCapabilities, resetCapabilities } from '../src/capabilities';
import { HLS_CONFIG, LOCAL_ORIGIN } from '../src/config';
import { configureEnv, destroyAllSessions, type HlsConstructor } from '../src/env';
import { buildProxyUrl } from '../src/proxyUrl';
import { getActiveSession, hasPlayableLevel } from '../src/session';
import { installSrcHook, isSrcHookInstalled, uninstallSrcHook, withBypass } from '../src/srcHook';
import { resetTransportState, setStreamsSupported } from '../src/transport';
import { createFakeGm, respond, type FakeGm } from './fakeGm';
import {
  fakeMediaSource,
  fakePage,
  FakeMediaElement,
  FakeMutationObserver,
  FakeSourceElement,
} from './fakes';

const UPSTREAM = 'https://cdn.example.com/stream/index.m3u8';

const PLAYLIST_RESPONSE = {
  status: 200,
  headers: { 'content-type': 'application/vnd.apple.mpegurl' },
};

function proxyUrl(upstream = UPSTREAM): string {
  return buildProxyUrl(upstream);
}

interface FakeHlsOptions {
  supported?: boolean;
  events?: Record<string, string>;
}

class FakeHls {
  static instances: FakeHls[] = [];
  static supported = true;
  static Events: Record<string, string>;

  loaded: string | null = null;
  attached: unknown = null;
  destroyed = false;
  private readonly listeners = new Map<string, Array<(event: string, data: unknown) => void>>();

  constructor(readonly config?: unknown) {
    FakeHls.instances.push(this);
  }

  static configure(options: FakeHlsOptions = {}): void {
    FakeHls.supported = options.supported ?? true;
    FakeHls.Events = options.events ?? { ERROR: 'hlsError', MANIFEST_PARSED: 'hlsManifestParsed' };
  }

  static isSupported(): boolean {
    return FakeHls.supported;
  }

  on(event: string, listener: (event: string, data: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  emit(event: string, data: unknown = {}): void {
    for (const listener of this.listeners.get(event) ?? []) listener(event, data);
  }

  loadSource(url: string): void {
    this.loaded = url;
  }

  attachMedia(media: unknown): void {
    this.attached = media;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

let gm: FakeGm;

/** Waits for the sniff round trip and the hls.js construction that follows it. */
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function media(): FakeMediaElement {
  return new FakeMediaElement();
}

function usePage(overrides: Record<string, unknown> = {}): void {
  configureEnv({ page: fakePage(overrides) });
  resetCapabilities();
  setStreamsSupported(false);
}

/** `video.src = url`, the way the page and hls.js both do it. */
function start(video: FakeMediaElement, url: string): void {
  (video as unknown as { src: string }).src = url;
}

/** The transport retries a failed HEAD after a backoff delay. */
async function settleSlow(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 800));
}

function srcOf(video: FakeMediaElement): string {
  return (video as unknown as { src: string }).src;
}

beforeEach(() => {
  FakeHls.instances = [];
  FakeHls.configure();
  gm = createFakeGm();
  resetTransportState();
  configureEnv({ gmRequest: gm.fn, hls: FakeHls as unknown as HlsConstructor, page: fakePage() });
  resetCapabilities();
  setStreamsSupported(false);
  destroyAllSessions('test-setup');
});

afterEach(() => {
  destroyAllSessions('test-teardown');
  uninstallSrcHook();
  resetTransportState();
});

test('a local playlist is played by hls.js and never assigned to the element', async () => {
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  assert.equal(installSrcHook(), true);
  assert.equal(isSrcHookInstalled(), true);

  const video = media();
  start(video, proxyUrl());
  await settle();

  const hls = FakeHls.instances[0];
  assert.ok(hls, 'hls.js was constructed');
  assert.equal(hls.loaded, proxyUrl(), 'hls.js loads the local URL through the XHR hook');
  assert.equal(hls.attached, video);
  assert.equal(hls.config, HLS_CONFIG, 'the stremio-video hls config is used verbatim');
  assert.equal(getActiveSession(video as unknown as HTMLMediaElement)?.status, 'attaching');

  // The element was never given the local URL: the getter reports it, the
  // attribute stays empty until hls.js assigns its own blob.
  assert.equal(video.getAttribute('src'), null);
  assert.equal(srcOf(video), proxyUrl());
  assert.equal(gm.calls.length, 1, 'only the HEAD probe, hls.js does the rest');
  assert.equal(gm.calls[0]?.details.method, 'HEAD');
  assert.equal(gm.calls[0]?.details.url, UPSTREAM);
});

test('the src attribute path starts a session and drops the source attribute', async () => {
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  assert.equal(installSrcHook(), true);

  const video = media();
  const source = new FakeSourceElement(video);
  source.setAttribute('src', proxyUrl());
  FakeMutationObserver.last()?.fire([
    { type: 'attributes', attributeName: 'src', target: source },
  ]);

  assert.equal(source.getAttribute('src'), null, 'the browser must not start its own request');
  await settle();

  const hls = FakeHls.instances[0];
  assert.ok(hls);
  assert.equal(hls.attached, video);
  assert.equal(srcOf(video), proxyUrl());
});

test('the observer ignores an attribute the script itself wrote', async () => {
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, proxyUrl());
  await settle();
  const observer = FakeMutationObserver.last();
  assert.ok(observer);

  observer.fire([{ type: 'attributes', attributeName: 'src', target: video }]);
  await settle();

  assert.equal(FakeHls.instances.length, 1, 'no second session for our own fallback');
});

test('a dead local service hands the element back to the page', async () => {
  gm.setResponder(respond({ error: 'ECONNREFUSED' }));
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, proxyUrl());
  await settle();

  // Nothing is playing, which is the truth: the service is not there. What
  // matters is that the page gets its own element and its own load back, the way
  // it would if this script were not installed, and quickly.
  assert.equal(video.getAttribute('src'), proxyUrl(), 'the page runs its own load');
  assert.equal(video.currentSrc, proxyUrl(), 'and the getter tells the page the same thing');
  assert.equal(FakeHls.instances.length, 0, 'no player for a service that is not there');
  assert.equal(video.listenerCount('play'), 0, 'no listener left behind');
  assert.equal(getActiveSession(video as unknown as HTMLMediaElement), undefined);
});

test('two dead services in a row and the script stops interfering for good', async () => {
  gm.setResponder(respond({ error: 'ECONNREFUSED' }));
  assert.equal(installSrcHook(), true);

  const first = media();
  start(first, proxyUrl());
  await settle();
  assert.equal(first.getAttribute('src'), proxyUrl(), 'handed back after one fast failure');

  const second = media();
  start(second, proxyUrl('https://cdn.example.com/second/index.m3u8'));
  await settle();
  assert.equal(second.getAttribute('src'), proxyUrl('https://cdn.example.com/second/index.m3u8'));

  // The service has now failed to answer twice, so the third title is not even
  // probed: the page keeps its own behaviour, and we cost it nothing.
  const third = media();
  const before = gm.calls.length;
  start(third, proxyUrl('https://cdn.example.com/third/index.m3u8'));
  await settle();

  assert.equal(third.getAttribute('src'), proxyUrl('https://cdn.example.com/third/index.m3u8'));
  assert.equal(gm.calls.length, before, 'a service that is not there is not probed again');
  assert.equal(getActiveSession(third as unknown as HTMLMediaElement), undefined);
});

test('a recovered service is used again, on a new source and after a success', async () => {
  // A service that answers but with something that is not HLS: the page is handed
  // back its load, and the fallback budget is spent, without the local service
  // ever looking unreachable.
  gm.setResponder(
    respond({ status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '90000000' } }),
  );
  assert.equal(installSrcHook(), true);

  const video = media();
  const refused = proxyUrl('https://cdn.example.com/stream/clip.mp4');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    start(video, refused);
    await settle();
  }
  assert.equal(video.getAttribute('src'), refused, 'the page still ends up with its own load');

  // Now the same element gets a real playlist. The budget was for the URL we
  // could not play, not a life sentence for the element React reuses.
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  const playable = proxyUrl('https://cdn.example.com/stream/index.m3u8');
  start(video, playable);
  await settle();

  assert.equal(FakeHls.instances.length, 1, 'the new source is played');
  // The element itself is left for hls.js to attach its own blob: URL to, the
  // proxy URL is what the page is told, and that is the session's source.
  assert.equal(getActiveSession(video as unknown as HTMLMediaElement)?.sourceUrl, playable);
});

test('a plain mp4 is left to the browser untouched', async () => {
  gm.setResponder(
    respond({ status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '90000000' } }),
  );
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, proxyUrl('https://cdn.example.com/movie.mp4'));
  await settle();

  assert.equal(FakeHls.instances.length, 0, 'hls.js was never involved');
  assert.equal(
    video.getAttribute('src'),
    proxyUrl('https://cdn.example.com/movie.mp4'),
    'the element gets back the exact URL the page assigned',
  );
  assert.equal(gm.calls.length, 1, 'a single probe decided it, and the page takes over');
});

test('a local server that is down leaves the page its own load', async () => {
  gm.setResponder(respond({ error: 'ECONNREFUSED' }));
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, proxyUrl());
  await settleSlow();

  assert.equal(FakeHls.instances.length, 0);
  assert.equal(video.getAttribute('src'), proxyUrl(), 'the browser gets the original URL back');
  assert.equal(srcOf(video), proxyUrl(), 'and the getter still reports the URL it was given');
});

test('a HEAD answer that is not ok never reaches the page twice', async () => {
  gm.setResponder(respond({ status: 404, headers: { 'content-type': 'text/html' } }));
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, proxyUrl());
  await settle();

  assert.equal(gm.calls.length, 1, 'a 404 is an answer, not something to probe further');
  assert.equal(video.getAttribute('src'), proxyUrl());
});

test('a local proxy URL aimed at the local network is handed back untouched', async () => {
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  assert.equal(installSrcHook(), true);

  for (const upstream of [
    'http://192.168.0.1/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://nas.local/x.m3u8',
  ]) {
    const video = media();
    start(video, proxyUrl(upstream));
    await settle();

    assert.equal(FakeHls.instances.length, 0, `${upstream} never reached hls.js`);
    assert.equal(video.getAttribute('src'), proxyUrl(upstream), 'the page gets its own load');
    assert.equal(
      getActiveSession(video as unknown as HTMLMediaElement),
      undefined,
      'no session is even built for a target we refuse',
    );
  }
  assert.equal(gm.calls.length, 0, 'no probe, no request, nothing to abuse');
});

test('another local route is not our video source at all', async () => {
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  assert.equal(installSrcHook(), true);

  for (const url of [
    `${LOCAL_ORIGIN}/version`,
    `${LOCAL_ORIGIN}/hlsv2/stream.m3u8`,
    `${LOCAL_ORIGIN}/proxy/`,
    `${LOCAL_ORIGIN}/proxy/?d=`,
    `${LOCAL_ORIGIN}/proxy/version`,
    `${LOCAL_ORIGIN}/proxy/?d=not%20a%20url`,
  ]) {
    const video = media();
    start(video, url);
    await settle();

    assert.equal(FakeHls.instances.length, 0, `${url} never reached hls.js`);
    assert.equal(video.getAttribute('src'), url, `${url} was passed straight through`);
    assert.equal(getActiveSession(video as unknown as HTMLMediaElement), undefined);
  }
  assert.equal(gm.calls.length, 0);
});

test('the observer ignores a src attribute we would refuse', async () => {
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  assert.equal(installSrcHook(), true);

  const video = media();
  const source = new FakeSourceElement(video);
  source.setAttribute('src', `${LOCAL_ORIGIN}/proxy/`);
  FakeMutationObserver.last()?.fire([
    { type: 'attributes', attributeName: 'src', target: source },
  ]);
  await settle();

  assert.equal(source.getAttribute('src'), `${LOCAL_ORIGIN}/proxy/`, 'we did not touch it');
  assert.equal(FakeHls.instances.length, 0);
});

test('a non-local URL goes straight to the browser', async () => {
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, 'https://example.com/video.mp4');

  assert.equal(srcOf(video), 'https://example.com/video.mp4');
  assert.equal(gm.calls.length, 0);
  assert.equal(FakeHls.instances.length, 0);
});

test('an https page URL is not ours to intercept', async () => {
  assert.equal(installSrcHook(), true);
  const video = media();

  start(video, buildProxyUrl(UPSTREAM).replace('http://', 'https://'));
  start(video, buildProxyUrl(UPSTREAM).replace('11470', '11471'));
  start(video, `http://127.0.0.1:11470/hlsv2/stream.m3u8`);

  assert.equal(gm.calls.length, 0);
  assert.equal(FakeHls.instances.length, 0);
  assert.equal(video.getAttribute('src'), `http://127.0.0.1:11470/hlsv2/stream.m3u8`);
});

test('hls.js assigning its own blob URL does not tear the session down', async () => {
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, proxyUrl());
  await settle();
  const hls = FakeHls.instances[0];
  assert.ok(hls);

  // This is what attachMedia() does on the page's element.
  start(video, 'blob:https://web.stremio.com/1234');

  assert.equal(video.getAttribute('src'), 'blob:https://web.stremio.com/1234');
  assert.equal(
    srcOf(video),
    proxyUrl(),
    'the getter keeps reporting the local URL while the element holds the blob',
  );
  assert.equal(hls.destroyed, false, 'the session survived its own blob assignment');
  assert.ok(getActiveSession(video as unknown as HTMLMediaElement));
});

test('the attach window closes once the manifest is parsed', async () => {
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, proxyUrl());
  await settle();
  const hls = FakeHls.instances[0];
  assert.ok(hls);

  hls.emit('hlsManifestParsed', { levels: [{ videoCodec: 'avc1.42e01e' }] });
  await settle();

  // A blob: URL the page assigns now is its own, not ours.
  start(video, 'blob:https://web.stremio.com/page');

  assert.equal(hls.destroyed, true);
  assert.equal(video.getAttribute('src'), 'blob:https://web.stremio.com/page');
  assert.equal(getActiveSession(video as unknown as HTMLMediaElement), undefined);
});

test('the page changing the source to something else stops the session', async () => {
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, proxyUrl());
  await settle();
  const hls = FakeHls.instances[0];
  assert.ok(hls);

  start(video, 'https://example.com/other.mp4');

  assert.equal(hls.destroyed, true, 'even mid-attach, a page URL is not taken for a blob');
  assert.equal(video.getAttribute('src'), 'https://example.com/other.mp4');
  assert.equal(srcOf(video), 'https://example.com/other.mp4', 'the spoof is gone, the real value is back');
  assert.equal(getActiveSession(video as unknown as HTMLMediaElement), undefined);
});

test('a second local URL replaces the session', async () => {
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, proxyUrl());
  await settle();
  const first = FakeHls.instances[0];
  assert.ok(first);

  start(video, proxyUrl('https://cdn.example.com/other.m3u8'));
  await settle();

  assert.equal(first.destroyed, true);
  assert.equal(FakeHls.instances.length, 2);
  assert.equal(FakeHls.instances[1]?.loaded, proxyUrl('https://cdn.example.com/other.m3u8'));
});

test('withBypass is the escape hatch used for internal assignments', () => {
  const video = media();
  withBypass(video as unknown as HTMLMediaElement, () => {
    start(video, 'blob:internal');
  });
  assert.equal(video.getAttribute('src'), 'blob:internal');
});

test('uninstall puts the native descriptor back', () => {
  const before = Object.getOwnPropertyDescriptor(FakeMediaElement.prototype, 'src');
  assert.equal(installSrcHook(), true);
  assert.notEqual(Object.getOwnPropertyDescriptor(FakeMediaElement.prototype, 'src'), before);

  uninstallSrcHook();

  assert.deepEqual(Object.getOwnPropertyDescriptor(FakeMediaElement.prototype, 'src'), before);
  assert.equal(isSrcHookInstalled(), false);
  assert.equal(FakeMutationObserver.last()?.disconnected, true);
});

test('the descriptor is patched once', () => {
  assert.equal(installSrcHook(), true);
  const first = Object.getOwnPropertyDescriptor(FakeMediaElement.prototype, 'src');
  assert.equal(installSrcHook(), true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(FakeMediaElement.prototype, 'src'), first);
});

test('without GM_xmlhttpRequest nothing is patched', () => {
  configureEnv({ gmRequest: null });
  usePage();
  const before = Object.getOwnPropertyDescriptor(FakeMediaElement.prototype, 'src');

  assert.equal(installSrcHook(), false);
  assert.equal(isSrcHookInstalled(), false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(FakeMediaElement.prototype, 'src'), before);
});

test('without hls.js the src hook stays off', () => {
  configureEnv({ hls: null });
  usePage();
  const before = Object.getOwnPropertyDescriptor(FakeMediaElement.prototype, 'src');

  assert.equal(detectCapabilities().srcHook, false);
  assert.equal(installSrcHook(), false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(FakeMediaElement.prototype, 'src'), before);
});

test('a browser hls.js does not support is left alone', () => {
  FakeHls.configure({ supported: false });
  usePage();
  assert.equal(detectCapabilities().srcHook, false);
  assert.equal(installSrcHook(), false);
});

test('a fatal hls.js error hands playback back to the browser', async () => {
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, proxyUrl());
  await settle();
  const hls = FakeHls.instances[0];
  assert.ok(hls);

  hls.emit('hlsError', { fatal: true, type: 'networkError', details: 'manifestLoadError' });
  await settle();

  assert.equal(hls.destroyed, true);
  assert.equal(video.getAttribute('src'), proxyUrl());
  assert.equal(getActiveSession(video as unknown as HTMLMediaElement), undefined);
});

test('a non-fatal hls.js error is ignored', async () => {
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, proxyUrl());
  await settle();
  const hls = FakeHls.instances[0];
  assert.ok(hls);

  hls.emit('hlsError', { fatal: false, type: 'networkError' });
  await settle();

  assert.equal(hls.destroyed, false);
  assert.equal(video.getAttribute('src'), null);
  assert.equal(getActiveSession(video as unknown as HTMLMediaElement)?.status, 'attaching');
});

test('hls.js is driven by the event names it publishes', async () => {
  FakeHls.configure({ events: { ERROR: 'ERR', MANIFEST_PARSED: 'MANIFEST' } });
  usePage();
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, proxyUrl());
  await settle();

  FakeHls.instances[0]?.emit('ERR', { fatal: true });
  await settle();

  assert.equal(FakeHls.instances[0]?.destroyed, true, 'the custom error name was honoured');
});

test('a manifest this browser cannot decode falls back to the browser', async () => {
  usePage({ MediaSource: fakeMediaSource((type) => !type.includes('hev1')) });
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, proxyUrl());
  await settle();
  const hls = FakeHls.instances[0];
  assert.ok(hls);

  hls.emit('hlsManifestParsed', {
    levels: [{ videoCodec: 'hev1.2.4.L153.B0', audioCodec: 'mp4a.40.2', type: 'main' }],
  });
  await settle();

  assert.equal(hls.destroyed, true);
  assert.equal(video.getAttribute('src'), proxyUrl());
});

test('a playable manifest keeps hls.js in charge', async () => {
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, proxyUrl());
  await settle();
  const hls = FakeHls.instances[0];
  assert.ok(hls);

  hls.emit('hlsManifestParsed', { levels: [{ videoCodec: 'avc1.42e01e', audioCodec: 'mp4a.40.2' }] });
  await settle();

  assert.equal(hls.destroyed, false);
  assert.equal(getActiveSession(video as unknown as HTMLMediaElement)?.status, 'playing');
  assert.equal(video.getAttribute('src'), null);
});

test('the play event resumes a stream the page autoplay-blocked', async () => {
  gm.setResponder(respond(PLAYLIST_RESPONSE));
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, proxyUrl());
  await settle();
  assert.equal(video.playCount, 0);

  video.dispatchEvent({ type: 'play' } as never);

  assert.equal(video.playCount, 1);
});

test('the play listener is gone once the session stopped', async () => {
  gm.setResponder(respond({ error: 'ECONNREFUSED' }));
  assert.equal(installSrcHook(), true);

  const video = media();
  start(video, proxyUrl());
  assert.equal(video.listenerCount('play'), 1, 'the session is listening for the play event');
  await settleSlow();
  assert.equal(video.listenerCount('play'), 0, 'fallback removed it');
  video.dispatchEvent({ type: 'play' } as never);
  assert.equal(video.playCount, 0);
});

test('hasPlayableLevel: an empty manifest is the browser problem to solve', () => {
  usePage({ MediaSource: fakeMediaSource(() => false) });
  assert.equal(hasPlayableLevel(undefined), true);
  assert.equal(hasPlayableLevel({ levels: [] }), true);
});

test('hasPlayableLevel: any playable level is enough', () => {
  usePage({ MediaSource: fakeMediaSource((type) => type.includes('avc1')) });
  assert.equal(
    hasPlayableLevel({ levels: [{ videoCodec: 'hev1.2.4.L153.B0' }, { videoCodec: 'avc1.42e01e' }] }),
    true,
  );
  assert.equal(
    hasPlayableLevel({ levels: [{ audioCodec: 'mp4a.40.2', type: 'audio' }] }),
    false,
    'audio-only levels are checked as audio/mp4',
  );
});

test('hasPlayableLevel: a page without MediaSource is trusted', () => {
  usePage({ MediaSource: undefined });
  assert.equal(hasPlayableLevel({ levels: [{ videoCodec: 'hev1.2.4.L153.B0' }] }), true);
});
