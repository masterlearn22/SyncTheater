import React, { useEffect, useRef } from 'react';

interface DemoCanvasProps {
  canvasRef?: React.RefObject<HTMLCanvasElement>;
  timeRef: React.MutableRefObject<number>;
  isPlaying: boolean;
  label: string;
  onClick?: () => void;
  className?: string;
}

export const DemoCanvas: React.FC<DemoCanvasProps> = React.memo(
  ({ canvasRef, timeRef, isPlaying, label, onClick, className }) => {
    const internalRef = useRef<HTMLCanvasElement | null>(null);
    const targetRef = canvasRef || internalRef;

    useEffect(() => {
      const canvas = targetRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const drawScene = (timeSec: number) => {
        const w = canvas.width;
        const h = canvas.height;

        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, '#070913');
        grad.addColorStop(0.55, '#131629');
        grad.addColorStop(1, '#09090B');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);

        const sunY = h * 0.4;
        const sunGrad = ctx.createRadialGradient(w * 0.5, sunY, 10, w * 0.5, sunY, 85);
        sunGrad.addColorStop(0, '#A5B4FC');
        sunGrad.addColorStop(0.5, '#6366F1');
        sunGrad.addColorStop(1, 'rgba(99, 102, 241, 0)');
        ctx.fillStyle = sunGrad;
        ctx.beginPath();
        ctx.arc(w * 0.5, sunY, 85, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        for (let s = 0; s < 18; s++) {
          const sx = (s * 97) % w;
          const sy = (s * 43) % (h * 0.45);
          ctx.fillRect(sx, sy, 2, 2);
        }

        const horizonY = h * 0.56;
        ctx.strokeStyle = 'rgba(99, 102, 241, 0.34)';
        ctx.lineWidth = 1.2;

        for (let i = -9; i <= 9; i++) {
          ctx.beginPath();
          ctx.moveTo(w * 0.5 + i * 18, horizonY);
          ctx.lineTo(w * 0.5 + i * 105, h);
          ctx.stroke();
        }

        const speedOffset = (timeSec * 2.4) % 1;
        for (let row = 0; row < 9; row++) {
          const p = (row + speedOffset) / 9;
          const y = horizonY + Math.pow(p, 2.1) * (h - horizonY);
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }

        ctx.fillStyle = 'rgba(24, 24, 27, 0.82)';
        ctx.fillRect(16, 16, 280, 34);
        ctx.strokeStyle = 'rgba(99, 102, 241, 0.45)';
        ctx.strokeRect(16, 16, 280, 34);
        ctx.fillStyle = '#E4E4E7';
        ctx.font = '600 12px sans-serif';
        ctx.fillText(`${label} • ${timeSec.toFixed(2)} dtk`, 28, 37);
      };

      drawScene(timeRef.current);

      if (!isPlaying) return;

      let animId = 0;
      let lastTs = performance.now();
      const loop = (now: number) => {
        const dt = Math.min(0.1, (now - lastTs) / 1000);
        lastTs = now;
        // Gunakan timeRef.current secara langsung tanpa memicu re-render React
        drawScene(timeRef.current + dt);
        animId = window.requestAnimationFrame(loop);
      };
      animId = window.requestAnimationFrame(loop);
      return () => window.cancelAnimationFrame(animId);
    }, [targetRef, timeRef, isPlaying, label]);

    return (
      <canvas
        ref={targetRef}
        width={960}
        height={540}
        onClick={onClick}
        className={className}
      />
    );
  }
);
