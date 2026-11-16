import React, { useState } from 'react';
import { Subtitles, Upload, CheckCircle2 } from 'lucide-react';

interface SubtitleDropProps {
  onSubtitleReady: (vttBlobUrl: string, fileName: string, cueCount: number) => void;
  activeSubtitleName: string | null;
}

/**
 * Mengonversi isi teks subtitle .srt menjadi format WebVTT (.vtt)
 * Mengubah koma penanda milidetik menjadi titik (00:12:34,500 -> 00:12:34.500)
 * dan menambahkan header WEBVTT.
 */
export function convertSrtToWebVtt(srtContent: string): { vttText: string; cueCount: number } {
  const normalized = srtContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const timestampRegex = /(\d{2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}),(\d{3})/g;
  let cueCount = 0;

  const convertedBody = normalized.replace(
    timestampRegex,
    (_match, startHms, startMs, endHms, endMs) => {
      cueCount++;
      return `${startHms}.${startMs} --> ${endHms}.${endMs}`;
    }
  );

  const vttText = `WEBVTT\n\n${convertedBody}\n`;
  return { vttText, cueCount };
}

export const SubtitleDrop: React.FC<SubtitleDropProps> = ({
  onSubtitleReady,
  activeSubtitleName,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [cueCount, setCueCount] = useState<number>(0);

  const processSubtitleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const rawText = String(reader.result || '');
      const { vttText, cueCount: count } = convertSrtToWebVtt(rawText);
      const blob = new Blob([vttText], { type: 'text/vtt;charset=utf-8' });
      const vttUrl = URL.createObjectURL(blob);
      setCueCount(count);
      onSubtitleReady(vttUrl, file.name, count);
    };
    reader.readAsText(file, 'utf-8');
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      processSubtitleFile(file);
    }
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      className={`rounded-xl border p-3.5 transition-all ${
        isDragging
          ? 'border-indigo-500 bg-indigo-500/10'
          : 'border-zinc-800 bg-[#18181B]/80'
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-zinc-800 text-indigo-400">
            <Subtitles className="w-4 h-4" />
          </div>
          <div>
            <p className="text-xs font-semibold text-zinc-200">
              Konverter Subtitle Instan (.SRT → .VTT)
            </p>
            <p className="text-[11px] text-zinc-400">
              {activeSubtitleName
                ? `${activeSubtitleName} (${cueCount} dialog aktif)`
                : 'Tarik & jatuhkan file .srt ke sini atau pilih file'}
            </p>
          </div>
        </div>

        <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 transition">
          {activeSubtitleName ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
          ) : (
            <Upload className="w-3.5 h-3.5 text-indigo-400" />
          )}
          <span>Pilih .SRT</span>
          <input
            type="file"
            accept=".srt,.vtt"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) processSubtitleFile(f);
            }}
          />
        </label>
      </div>
    </div>
  );
};
