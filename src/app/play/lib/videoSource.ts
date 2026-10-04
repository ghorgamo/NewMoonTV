// 播放页视频源相关纯函数
// 从 app/play/page.tsx 抽出，便于复用与单测

// 确保 video 元素挂载唯一的 source 子节点，并允许远程播放（AirPlay / Cast）
export function ensureVideoSource(
  video: HTMLVideoElement | null,
  url: string
): void {
  if (!video || !url) return;
  const sources = Array.from(video.getElementsByTagName('source'));
  const existed = sources.some((s) => s.src === url);
  if (!existed) {
    // 移除旧的 source，保持唯一
    sources.forEach((s) => s.remove());
    const sourceEl = document.createElement('source');
    sourceEl.src = url;
    video.appendChild(sourceEl);
  }

  // 始终允许远程播放（AirPlay / Cast）
  video.disableRemotePlayback = false;
  // 如果曾经有禁用属性，移除之
  if (video.hasAttribute('disableRemotePlayback')) {
    video.removeAttribute('disableRemotePlayback');
  }
}

// 秒数格式化为 HH:MM:SS / MM:SS
export function formatTime(seconds: number): string {
  if (seconds === 0) return '00:00';

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.round(seconds % 60);

  if (hours === 0) {
    // 不到一小时，格式为 00:00
    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds
      .toString()
      .padStart(2, '0')}`;
  } else {
    // 超过一小时，格式为 00:00:00
    return `${hours.toString().padStart(2, '0')}:${minutes
      .toString()
      .padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
}
