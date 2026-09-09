"use client";

import { useEffect, useRef, useState } from "react";

import { Spinner } from "~/components/ui/spinner";

/**
 * The generated alphabet. `JKM-N` rather than `J-N`: the range spelling
 * silently included L, which the generator never issues.
 */
const ISSUED_CODE = /^[2-9A-HJKM-NP-TV-Z]{6,12}$/i;

/**
 * A full check-in URL or a bare code, held to the same alphabet either way.
 * Anything else is a miss rather than a guess fired at the server.
 */
function codeFromHash(hash: string): string | null {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!body) return null;
  const params = new URLSearchParams(
    body.includes("=") ? body : `code=${body}`,
  );
  const fromHash = params.get("code") ?? (ISSUED_CODE.test(body) ? body : null);
  return fromHash && ISSUED_CODE.test(fromHash) ? fromHash.toUpperCase() : null;
}

export function codeFromScan(raw: string): string | null {
  const text = raw.trim();

  try {
    const url = new URL(text);
    const fromHash = codeFromHash(url.hash);
    if (fromHash) return fromHash;
    const fromQuery = url.searchParams.get("code");
    if (fromQuery && ISSUED_CODE.test(fromQuery))
      return fromQuery.toUpperCase();
  } catch {
    // Not a URL. Falls through to the bare-code case below.
  }

  return ISSUED_CODE.test(text) ? text.toUpperCase() : null;
}

/** ~10 decodes a second. Faster buys nothing a hand can hold still for. */
const SCAN_INTERVAL_MS = 100;

/** Frames are decoded at this long edge. jsQR is ~4x slower at 1080p. */
const DECODE_EDGE = 960;
const MAX_ZOOM = 4;

interface DetectedBarcode {
  rawValue: string;
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
}

type Decoder = (
  video: HTMLVideoElement,
  zoom: number,
) => Promise<string | null>;

function pinchDistance(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
) {
  const dx = a.clientX - b.clientX;
  const dy = a.clientY - b.clientY;
  return Math.hypot(dx, dy);
}

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(1, value));
}

/** Hardware decode where it exists — Android Chrome, Edge, recent Safari. */
async function nativeDecoder(): Promise<Decoder | null> {
  const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
    .BarcodeDetector;
  if (!Ctor) return null;

  try {
    const formats = await Ctor.getSupportedFormats?.();
    if (formats && !formats.includes("qr_code")) return null;
    const detector = new Ctor({ formats: ["qr_code"] });
    // One probe now rather than a viewfinder that silently never reads: the
    // constructor succeeds on platforms where the backing service is absent.
    const probe = document.createElement("canvas");
    probe.width = 8;
    probe.height = 8;
    await detector.detect(probe);
    return async (video, zoom) => {
      // Native detect reads the whole frame. A zoomed crop is decoded by jsQR.
      if (zoom > 1.05) return null;
      return (await detector.detect(video))[0]?.rawValue ?? null;
    };
  } catch {
    return null;
  }
}

function binarize(data: Uint8ClampedArray) {
  let min = 255;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = (data[i]! * 54 + data[i + 1]! * 183 + data[i + 2]! * 19) >> 8;
    data[i] = y;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < data.length; i += 4) {
    const stretched = ((data[i]! - min) * 255) / range;
    const v = stretched > 127 ? 255 : 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
  }
}

async function jsQrDecoder(): Promise<Decoder> {
  const { default: jsQR } = await import("jsqr");
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("no-2d-context");

  return (video, zoom) => {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw < 8 || vh < 8) return Promise.resolve(null);

    const cropW = vw / zoom;
    const cropH = vh / zoom;
    const sx = (vw - cropW) / 2;
    const sy = (vh - cropH) / 2;
    const edge = Math.max(cropW, cropH);
    const scale = edge > DECODE_EDGE ? DECODE_EDGE / edge : 1;
    canvas.width = Math.max(1, Math.round(cropW * scale));
    canvas.height = Math.max(1, Math.round(cropH * scale));
    context.drawImage(
      video,
      sx,
      sy,
      cropW,
      cropH,
      0,
      0,
      canvas.width,
      canvas.height,
    );

    const frame = context.getImageData(0, 0, canvas.width, canvas.height);
    const found = jsQR(frame.data, frame.width, frame.height, {
      inversionAttempts: "attemptBoth",
    });
    if (found?.data) return Promise.resolve(found.data);

    binarize(frame.data);
    const stark = jsQR(frame.data, frame.width, frame.height, {
      inversionAttempts: "dontInvert",
    });
    return Promise.resolve(stark?.data ?? null);
  };
}

/**
 * The viewfinder. Starts on mount, decodes continuously, and hands back the
 * first issued code it reads. Anything that stops it from running at all —
 * no camera, a blocked prompt, an insecure origin — is reported through
 * `onUnavailable`, since this is the only way in.
 */
export function Scanner({
  onDetect,
  onUnavailable,
}: {
  onDetect: (code: string) => void;
  onUnavailable: (reason: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const zoomRef = useRef(1);
  const pinchRef = useRef<number | null>(null);
  const [live, setLive] = useState(false);
  const [zoom, setZoom] = useState(1);

  const bumpZoom = (next: number) => {
    const value = clampZoom(next);
    zoomRef.current = value;
    setZoom(value);
  };

  // Held in refs so an inline callback from the caller cannot restart the
  // camera on every render.
  const detectRef = useRef(onDetect);
  const unavailableRef = useRef(onUnavailable);

  // Declared before the camera effect so the refs are current by the time it
  // runs on mount.
  useEffect(() => {
    detectRef.current = onDetect;
    unavailableRef.current = onUnavailable;
  });

  useEffect(() => {
    // Set by teardown and by a hit. Startup re-checks it after every await,
    // because a member can leave the page while the prompt is still open.
    let stopped = false;
    const cancelled = () => stopped;

    const release = () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };

    // Absent on http origins other than localhost, so name that rather than
    // showing a permission error nobody can act on.
    if (!navigator.mediaDevices?.getUserMedia) {
      unavailableRef.current(
        "This browser will not open the camera on an insecure connection.",
      );
      return;
    }

    let stream: MediaStream | undefined;

    const startup = async () => {
      try {
        // Held separately from the pair so a rejected decoder still releases a
        // camera the member already granted.
        const [native, fallback] = await Promise.all([
          nativeDecoder(),
          jsQrDecoder(),
          navigator.mediaDevices
            .getUserMedia({
              video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 1920 },
                height: { ideal: 1080 },
              },
            })
            .then((granted) => {
              stream = granted;
            }),
        ]);

        const decoder: Decoder = async (video, zoom) => {
          if (native) {
            const hit = await native(video, zoom);
            if (hit) return hit;
          }
          return fallback(video, zoom);
        };

        const video = videoRef.current;
        if (!stream || !video || cancelled()) {
          stream?.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        const capabilities = track?.getCapabilities?.() as
          | { torch?: boolean }
          | undefined;
        if (track && capabilities?.torch) {
          await track
            .applyConstraints({
              advanced: [{ torch: false } as MediaTrackConstraintSet],
            })
            .catch(() => undefined);
        }
        video.srcObject = stream;
        video.setAttribute("playsinline", "true");
        video.setAttribute("webkit-playsinline", "true");
        await video.play();
        if (cancelled()) return;
        setLive(true);

        const tick = async () => {
          timerRef.current = null;
          if (cancelled() || !streamRef.current) return;

          if (video.readyState >= video.HAVE_CURRENT_DATA) {
            let raw: string | null = null;
            try {
              raw = await decoder(video, zoomRef.current);
            } catch {
              // A dropped frame. The next one is 100ms away.
            }
            if (cancelled()) return;

            const code = raw ? codeFromScan(raw) : null;
            if (code) {
              stopped = true;
              release();
              navigator.vibrate?.(60);
              detectRef.current(code);
              return;
            }
          }

          timerRef.current = window.setTimeout(
            () => void tick(),
            SCAN_INTERVAL_MS,
          );
        };

        void tick();
      } catch (error) {
        stream?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;

        // Silence after teardown: dismissing the prompt is exactly how leaving
        // the page makes getUserMedia reject.
        if (cancelled()) return;

        const name = error instanceof Error ? error.name : "";
        unavailableRef.current(
          name === "NotAllowedError"
            ? "Camera access is blocked. Allow it for this site in your browser settings, then reload."
            : name === "NotFoundError"
              ? "This device has no camera."
              : "The camera would not start.",
        );
      }
    };

    void startup();

    return () => {
      stopped = true;
      release();
    };
  }, []);

  return (
    <div>
      <div
        className="bg-navy relative mx-auto aspect-square w-full max-w-[min(22rem,calc(100dvh-14rem))] touch-none overflow-hidden rounded-lg"
        onTouchStart={(event) => {
          if (event.touches.length !== 2) {
            pinchRef.current = null;
            return;
          }
          pinchRef.current = pinchDistance(
            event.touches[0]!,
            event.touches[1]!,
          );
        }}
        onTouchMove={(event) => {
          if (event.touches.length !== 2 || pinchRef.current === null) return;
          event.preventDefault();
          const distance = pinchDistance(event.touches[0]!, event.touches[1]!);
          bumpZoom(zoomRef.current * (distance / pinchRef.current));
          pinchRef.current = distance;
        }}
        onTouchEnd={() => {
          pinchRef.current = null;
        }}
      >
        {/* Labelled rather than hidden: a screen reader user still has to know
            the camera is live and what it is pointed at. The status line below
            is the same element's description. */}
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          aria-label="Camera viewfinder for scanning the check-in QR code"
          aria-describedby="scanner-status"
          className="h-full w-full object-cover"
          style={{ transform: `scale(${zoom})` }}
        />

        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-8"
        >
          <span className="border-gold-bright absolute top-0 left-0 size-10 border-t-4 border-l-4" />
          <span className="border-gold-bright absolute top-0 right-0 size-10 border-t-4 border-r-4" />
          <span className="border-gold-bright absolute bottom-0 left-0 size-10 border-b-4 border-l-4" />
          <span className="border-gold-bright absolute right-0 bottom-0 size-10 border-r-4 border-b-4" />
        </div>

        {!live && (
          <div className="bg-navy absolute inset-0 grid place-items-center">
            <Spinner className="text-gold-bright" />
          </div>
        )}
      </div>

      <p
        id="scanner-status"
        aria-live="polite"
        className={live ? "sr-only" : "text-ink-muted text-body-sm mt-3"}
      >
        {live
          ? "Camera is scanning the check-in code. Pinch to zoom."
          : "Starting the camera..."}
      </p>
      {live && (
        <p className="text-ink-muted text-body-sm mt-3 text-center">
          Pinch to zoom in on the QR.
        </p>
      )}
    </div>
  );
}
