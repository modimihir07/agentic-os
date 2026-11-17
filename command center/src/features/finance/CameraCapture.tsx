import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { Camera, ImageUp, QrCode, ScanLine, SwitchCamera } from "lucide-react";

/**
 * Webcam / phone camera with two modes:
 *   document → capture a sharp still (receipts, invoices, cheques)
 *   qr       → continuous QR decoding (jsQR, fully offline)
 * Falls back to the OS camera / file picker when live video isn't available
 * (e.g. the PWA on plain http, where browsers block getUserMedia).
 */
export function CameraCapture({ mode, onCapture, onQr }: { mode: "document" | "qr"; onCapture: (blob: Blob) => void; onQr: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [live, setLive] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastQr, setLastQr] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    setLive(false);
    setErr(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setErr(window.isSecureContext ? "No camera API here." : "Live camera needs HTTPS on phones — use “Take photo” instead.");
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
          setLive(true);
        }
      })
      .catch((e) => setErr(e?.name === "NotAllowedError" ? "Camera permission denied." : "No camera available."));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [facing]);

  // QR loop: decode a downscaled frame ~4×/s.
  useEffect(() => {
    if (mode !== "qr" || !live) return;
    const ctx = canvas.current?.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const t = setInterval(() => {
      const v = video.current;
      if (!v || v.readyState < 2) return;
      const w = 640;
      const h = Math.round((v.videoHeight / v.videoWidth) * w) || 480;
      canvas.current!.width = w;
      canvas.current!.height = h;
      ctx.drawImage(v, 0, 0, w, h);
      const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "attemptBoth" });
      if (code?.data && code.data !== lastQr) {
        setLastQr(code.data);
        navigator.vibrate?.(40);
        onQr(code.data);
      }
    }, 250);
    return () => clearInterval(t);
  }, [mode, live, lastQr, onQr]);

  const snap = () => {
    const v = video.current;
    const c = canvas.current;
    if (!v || !c) return;
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    c.toBlob((b) => b && onCapture(b), "image/jpeg", 0.92);
  };

  const fromFile = (f: File) => {
    if (mode === "qr") {
      // Decode a QR from a photo.
      const img = new Image();
      img.onload = () => {
        const c = canvas.current!;
        const w = Math.min(1200, img.width);
        const h = Math.round((img.height / img.width) * w);
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d")!;
        ctx.drawImage(img, 0, 0, w, h);
        const code = jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "attemptBoth" });
        onQr(code?.data ?? "");
        URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(f);
    } else onCapture(f);
  };

  return (
    <div className="space-y-3">
      <div className="relative aspect-[4/3] w-full overflow-hidden rounded-[16px] border border-white/10 bg-black sm:aspect-video">
        <video ref={video} playsInline muted className={`size-full object-cover ${live ? "" : "hidden"}`} />
        {!live && (
          <div className="grid size-full place-items-center p-6 text-center text-sm text-ink-3">
            <div>
              <Camera size={28} className="mx-auto mb-2 opacity-60" />
              {err ?? "Starting camera…"}
            </div>
          </div>
        )}
        {live && mode === "document" && <div aria-hidden className="pointer-events-none absolute inset-[7%] rounded-[12px] border-2 border-dashed border-amber/60" />}
        {live && mode === "qr" && (
          <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/2 size-[46%] -translate-x-1/2 -translate-y-1/2 rounded-[18px] border-2 border-teal/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]">
            <ScanLine className="absolute inset-x-0 top-1/2 mx-auto -translate-y-1/2 animate-pulse text-teal" size={28} />
          </div>
        )}
      </div>
      <canvas ref={canvas} hidden />
      <div className="flex flex-wrap items-center gap-2">
        {mode === "document" && (
          <button onClick={snap} disabled={!live} className="pill-primary">
            <Camera size={15} /> Capture
          </button>
        )}
        {mode === "qr" && <span className="flex items-center gap-1.5 text-sm text-teal"><QrCode size={15} /> Point at a QR code</span>}
        <button onClick={() => fileIn.current?.click()} className="pill-glass">
          <ImageUp size={15} /> {live ? "Upload image" : "Take photo / upload"}
        </button>
        {live && (
          <button onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))} className="pill-glass !w-10 !px-0" aria-label="Switch camera">
            <SwitchCamera size={15} />
          </button>
        )}
        <input
          ref={fileIn}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) fromFile(f);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
