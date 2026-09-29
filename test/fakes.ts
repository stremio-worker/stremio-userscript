// Test doubles for the page surface the hooks touch. Deliberately minimal: only
// what the code under test actually calls, so a missing dependency shows up as a
// failure instead of a silently untested branch.

export class FakeEvent {
  readonly type: string;
  defaultPrevented = false;
  target: unknown = null;
  currentTarget: unknown = null;

  constructor(type: string) {
    this.type = type;
  }

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {}
}

export class FakeProgressEvent extends FakeEvent {
  loaded = 0;
  total = 0;
  lengthComputable = false;

  constructor(type: string) {
    super(type);
  }
}

type Listener = (event: unknown) => void;

export class FakeEventTarget {
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: FakeEvent): boolean {
    event.target = this;
    event.currentTarget = this;
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) listener(event);
    const handler = (this as unknown as Record<string, Listener | undefined>)[`on${event.type}`];
    if (handler) handler(event);
    return true;
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

export interface FakeXhrRecord {
  method: string;
  url: string;
  sent: boolean;
  body: unknown;
  headers: Record<string, string>;
  responseType: string;
  withCredentials: boolean;
  timeout: number;
}

export class FakeXMLHttpRequest extends FakeEventTarget {
  static instances: FakeXMLHttpRequest[] = [];

  readonly record: FakeXhrRecord = {
    method: '',
    url: '',
    sent: false,
    body: null,
    headers: {},
    responseType: '',
    withCredentials: false,
    timeout: 0,
  };

  readyState = 0;
  status = 0;
  statusText = '';
  response: unknown = null;
  responseText = '';
  responseURL = '';
  responseXML: unknown = null;
  /** What the native XHR would have reported; the hook replaces both accessors. */
  responseHeaders: Record<string, string> = {};

  onreadystatechange: ((event: unknown) => void) | null = null;
  onprogress: ((event: unknown) => void) | null = null;
  onload: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onabort: ((event: unknown) => void) | null = null;
  ontimeout: ((event: unknown) => void) | null = null;
  onloadend: ((event: unknown) => void) | null = null;

  constructor() {
    super();
    FakeXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string, _async?: boolean): void {
    this.record.method = method;
    this.record.url = url;
    this.readyState = 1;
    this.status = 0;
    this.response = null;
    this.responseText = '';
  }

  setRequestHeader(name: string, value: string): void {
    this.record.headers[name.toLowerCase()] = value;
  }

  send(body?: unknown): void {
    this.record.sent = true;
    this.record.body = body;
  }

  abort(): void {}

  getAllResponseHeaders(): string {
    return Object.entries(this.responseHeaders)
      .map(([name, value]) => `${name}: ${value}`)
      .join('\r\n');
  }

  /** Only reached when the hook is off: the script answers through GM instead. */
  getResponseHeader(name: string): string | null {
    return this.responseHeaders[name.toLowerCase()] ?? null;
  }

  get responseType(): string {
    return this.record.responseType;
  }

  set responseType(value: string) {
    this.record.responseType = value;
  }

  get withCredentials(): boolean {
    return this.record.withCredentials;
  }

  set withCredentials(value: boolean) {
    this.record.withCredentials = value;
  }

  get timeout(): number {
    return this.record.timeout;
  }

  set timeout(value: number) {
    this.record.timeout = value;
  }
}

export class FakeMediaElement extends FakeEventTarget {
  readonly tagName = 'VIDEO';
  isConnected = true;
  playCount = 0;
  parent: FakeElement | null = null;
  private attributes = new Map<string, string>();

  get currentSrc(): string {
    return this.getAttribute('src') ?? '';
  }

  closest(selector: string): FakeElement | null {
    return selector.toUpperCase() === this.tagName ? this : null;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  play(): Promise<void> {
    this.playCount += 1;
    return Promise.resolve();
  }
}

/** `HTMLMediaElement.prototype.src` before the script touches it. */
export function mediaSrcDescriptor(): PropertyDescriptor {
  return {
    configurable: true,
    enumerable: true,
    get(this: FakeMediaElement): string {
      return this.getAttribute('src') ?? '';
    },
    set(this: FakeMediaElement, value: unknown): void {
      this.setAttribute('src', String(value));
    },
  };
}

// The patched descriptor lands on the class prototype, so instances have to see
// it: every media element in a test has to go through the same property.
Object.defineProperty(FakeMediaElement.prototype, 'src', mediaSrcDescriptor());

export interface FakeElement extends FakeEventTarget {
  tagName: string;
  parent: FakeElement | null;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  closest(selector: string): FakeElement | null;
}

export class FakeElementImpl extends FakeEventTarget implements FakeElement {
  tagName: string;
  attributes = new Map<string, string>();
  parent: FakeElement | null = null;

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  closest(selector: string): FakeElement | null {
    const wanted = selector.toUpperCase();
    let node: FakeElement | null = this;
    while (node) {
      if (node.tagName === wanted) return node;
      node = node.parent;
    }
    return null;
  }
}

export class FakeSourceElement extends FakeElementImpl {
  constructor(readonly owner: FakeMediaElement) {
    super('source');
    this.parent = owner;
  }
}

export class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];

  callback: (records: unknown[]) => void;
  targets: Array<{ root: unknown; options: unknown }> = [];
  disconnected = false;

  constructor(callback: (records: unknown[]) => void) {
    this.callback = callback;
    FakeMutationObserver.instances.push(this);
  }

  observe(root: unknown, options: unknown): void {
    this.targets.push({ root, options });
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /** The last observer the code under test installed. */
  static last(): FakeMutationObserver | undefined {
    return FakeMutationObserver.instances[FakeMutationObserver.instances.length - 1];
  }

  /** Drives the callback the way a real attribute mutation would. */
  fire(records: unknown[]): void {
    this.callback(records);
  }
}

/** A MediaSource constructor, so `typeof page.MediaSource === 'function'` holds. */
export function fakeMediaSource(isTypeSupported: (type: string) => boolean = () => true): unknown {
  const ctor = function FakeMediaSource(): void {
    /* the script never constructs one itself */
  };
  Object.assign(ctor, { isTypeSupported });
  return ctor;
}

/** Page object handed to the code under test through configureEnv(). */
export function fakePage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const page: Record<string, unknown> = {
    HTMLMediaElement: { prototype: FakeMediaElement.prototype },
    XMLHttpRequest: FakeXMLHttpRequest,
    MutationObserver: FakeMutationObserver,
    Event: FakeEvent,
    ProgressEvent: FakeProgressEvent,
    Response: undefined,
    ReadableStream,
    MediaSource: fakeMediaSource(),
    TextDecoder,
    DOMException: typeof DOMException === 'function' ? DOMException : undefined,
    queueMicrotask,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    document: { documentElement: new FakeElementImpl('html') },
    setTimeout,
    clearTimeout,
    ...overrides,
  };
  return page;
}
