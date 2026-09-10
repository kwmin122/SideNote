import { formatClock, wrapTextByWidth } from '../shared/export';

export interface ComposeInput {
  blob: Blob;
  title: string;
  videoTimeSec?: number;
  memo: string;
}

const FONT = 'system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

/**
 * 캡처 이미지 아래에 제목·재생 위치·메모를 그려 PNG 한 장으로 합친다.
 * 클립보드와 파일 저장이 같은 결과물을 쓰므로, 붙여넣는 곳이 어디든 캡처와 메모가 함께 간다.
 */
export async function composeCaptureImage(input: ComposeInput): Promise<Blob> {
  const bitmap = await createImageBitmap(input.blob);
  const width = Math.max(bitmap.width, 560);
  const scale = width / bitmap.width;
  const imageHeight = Math.round(bitmap.height * scale);

  const pad = Math.round(width * 0.035);
  const titleSize = Math.max(15, Math.round(width * 0.024));
  const memoSize = Math.max(14, Math.round(width * 0.021));
  const titleLead = Math.round(titleSize * 1.45);
  const memoLead = Math.round(memoSize * 1.55);

  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) {
    bitmap.close();
    return input.blob;
  }
  const inner = width - pad * 2;
  measure.font = `600 ${titleSize}px ${FONT}`;
  const titleLines = wrapTextByWidth(input.title, inner, (s) => measure.measureText(s).width).slice(0, 2);
  measure.font = `${memoSize}px ${FONT}`;
  const memoText = input.memo.trim() || '(메모 없음)';
  const memoLines = wrapTextByWidth(memoText, inner, (s) => measure.measureText(s).width);

  const panelHeight = pad + titleLines.length * titleLead + Math.round(memoLead * 0.4) + memoLines.length * memoLead + pad;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = imageHeight + panelHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return input.blob;
  }

  ctx.drawImage(bitmap, 0, 0, width, imageHeight);
  bitmap.close();

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, imageHeight, width, panelHeight);
  ctx.fillStyle = '#e3e8f0';
  ctx.fillRect(0, imageHeight, width, 1);

  let y = imageHeight + pad + titleSize;
  ctx.textBaseline = 'alphabetic';
  ctx.font = `600 ${titleSize}px ${FONT}`;
  ctx.fillStyle = '#1b2333';
  for (const line of titleLines) {
    ctx.fillText(line, pad, y);
    y += titleLead;
  }

  if (input.videoTimeSec != null) {
    const label = `재생 위치 ${formatClock(input.videoTimeSec)}`;
    ctx.font = `600 ${memoSize}px ${FONT}`;
    ctx.fillStyle = '#2563eb';
    ctx.textAlign = 'right';
    ctx.fillText(label, width - pad, imageHeight + pad + titleSize);
    ctx.textAlign = 'left';
  }

  y += Math.round(memoLead * 0.2);
  ctx.font = `${memoSize}px ${FONT}`;
  ctx.fillStyle = input.memo.trim() ? '#333c4f' : '#8a93a6';
  for (const line of memoLines) {
    y += memoLead;
    ctx.fillText(line, pad, y);
  }

  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return out ?? input.blob;
}

/** Blob 을 파일로 내려받는다. 사이드패널에서도 a[download] 는 동작하므로 downloads 권한이 필요 없다. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 클릭 직후 해제하면 다운로드가 취소될 수 있다.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('이미지를 읽지 못했습니다.'));
    reader.readAsDataURL(blob);
  });
}
