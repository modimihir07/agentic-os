import { useEffect, useRef } from "react";
import { useSettings } from "@/stores/settings";
import { usePrefersReducedMotion } from "@/lib/use-media-query";
import { voiceLevel, type VoiceState } from "./voice-store";

const ANIMATED: VoiceState[] = ["listening", "transcribing", "speaking", "thinking", "holding"];

/**
 * Transparent floating voice orb (Gemini / Claude style).
 *
 *   active (listening / speaking) → a free-flowing, audio-reactive blob:
 *     the outline is a sum of slowly drifting harmonics whose amplitude
 *     follows the live mic / TTS level
 *   thinking   → slow breathing shimmer
 *   idle/muted → drawn once and left completely still (no animation loop)
 */
export function VoiceOrb({ state, size = 64 }: { state: VoiceState; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const colors = useSettings((s) => s.waveColors);
  const reduced = usePrefersReducedMotion();
  const animate = ANIMATED.includes(state) && !reduced;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pad = size * 0.35; // room for the glow and for the blob to swell
    const full = size + pad * 2;
    canvas.width = full * dpr;
    canvas.height = full * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = full / 2;
    const cy = full / 2;
    const R = size * 0.36;
    let t = 0;
    let amp = 0;
    let raf = 0;

    const harmonics = [
      { k: 2, w: 0.9, p: 0 },
      { k: 3, w: -1.3, p: 1.1 },
      { k: 5, w: 1.7, p: 2.3 },
      { k: 7, w: -2.1, p: 0.6 },
    ];

    const draw = () => {
      const level = state === "thinking" ? 0.18 + 0.1 * Math.sin(t * 2) : voiceLevel.current;
      const target = animate ? 0.08 + level * 0.9 : 0;
      amp += (target - amp) * 0.15;
      ctx.clearRect(0, 0, full, full);

      // Outer glow halo.
      const halo = ctx.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * (1.9 + amp));
      halo.addColorStop(0, hexA(colors[1], animate ? 0.35 : 0.12));
      halo.addColorStop(1, hexA(colors[1], 0));
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, full, full);

      // Flowing blob: three translucent layers, slightly out of phase.
      for (let layer = 2; layer >= 0; layer--) {
        ctx.beginPath();
        const steps = 96;
        for (let i = 0; i <= steps; i++) {
          const th = (i / steps) * Math.PI * 2;
          let r = R * (1 - layer * 0.08);
          for (const h of harmonics) r += Math.sin(th * h.k + t * h.w * (1 + layer * 0.2) + h.p + layer) * R * 0.11 * amp;
          const x = cx + Math.cos(th) * r;
          const y = cy + Math.sin(th) * r;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
        const g = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
        g.addColorStop(0, hexA(colors[0], 0.55 - layer * 0.12));
        g.addColorStop(0.5, hexA(colors[1], 0.5 - layer * 0.12));
        g.addColorStop(1, hexA(colors[2], 0.55 - layer * 0.12));
        ctx.fillStyle = g;
        ctx.fill();
      }

      // Glass rim + specular highlight.
      ctx.beginPath();
      ctx.arc(cx, cy, R * 1.02, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255,255,255,0.22)";
      ctx.lineWidth = 1;
      ctx.stroke();
      const spec = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.4, 0, cx - R * 0.35, cy - R * 0.4, R * 0.7);
      spec.addColorStop(0, "rgba(255,255,255,0.35)");
      spec.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = spec;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.fill();

      t += 0.016;
      if (animate || amp > 0.002) raf = requestAnimationFrame(draw); // settle, then stop entirely
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [state, animate, colors, size]);

  const full = size * 1.7;
  return <canvas ref={ref} aria-hidden style={{ width: full, height: full, margin: -(full - size) / 2 }} className="pointer-events-none block" />;
}

function hexA(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}
