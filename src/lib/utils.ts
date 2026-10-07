/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

/**
 * 获取图片代理 URL 设置
 */
export function getImageProxyUrl(): string | null {
  if (typeof window === 'undefined') return null;

  // 本地未开启图片代理，则不使用代理
  const enableImageProxy = localStorage.getItem('enableImageProxy');
  if (enableImageProxy !== null) {
    if (!JSON.parse(enableImageProxy) as boolean) {
      return null;
    }
  }

  const localImageProxy = localStorage.getItem('imageProxyUrl');
  if (localImageProxy != null) {
    return localImageProxy.trim() ? localImageProxy.trim() : null;
  }

  // 如果未设置，则使用全局对象
  const serverImageProxy = (window as any).RUNTIME_CONFIG?.IMAGE_PROXY;
  return serverImageProxy && serverImageProxy.trim()
    ? serverImageProxy.trim()
    : null;
}

/**
 * 处理图片 URL，如果设置了图片代理则使用代理
 */
export function processImageUrl(originalUrl: string): string {
  if (!originalUrl) return originalUrl;

  const proxyUrl = getImageProxyUrl();
  if (!proxyUrl) return originalUrl;

  return `${proxyUrl}${encodeURIComponent(originalUrl)}`;
}

/**
 * 获取豆瓣代理 URL 设置
 */
export function getDoubanProxyUrl(): string | null {
  if (typeof window === 'undefined') return null;

  // 本地未开启豆瓣代理，则不使用代理
  const enableDoubanProxy = localStorage.getItem('enableDoubanProxy');
  if (enableDoubanProxy !== null) {
    if (!JSON.parse(enableDoubanProxy) as boolean) {
      return null;
    }
  }

  const localDoubanProxy = localStorage.getItem('doubanProxyUrl');
  if (localDoubanProxy != null) {
    return localDoubanProxy.trim() ? localDoubanProxy.trim() : null;
  }

  // 如果未设置，则使用全局对象
  const serverDoubanProxy = (window as any).RUNTIME_CONFIG?.DOUBAN_PROXY;
  return serverDoubanProxy && serverDoubanProxy.trim()
    ? serverDoubanProxy.trim()
    : null;
}

/**
 * 处理豆瓣 URL，如果设置了豆瓣代理则使用代理
 */
export function processDoubanUrl(originalUrl: string): string {
  if (!originalUrl) return originalUrl;

  const proxyUrl = getDoubanProxyUrl();
  if (!proxyUrl) return originalUrl;

  return `${proxyUrl}${encodeURIComponent(originalUrl)}`;
}

export function cleanHtmlTags(text: string): string {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, '\n') // 将 HTML 标签替换为换行
    .replace(/\n+/g, '\n') // 将多个连续换行合并为一个
    .replace(/[ \t]+/g, ' ') // 将多个连续空格和制表符合并为一个空格，但保留换行符
    .replace(/^\n+|\n+$/g, '') // 去掉首尾换行
    .replace(/&nbsp;/g, ' ') // 将 &nbsp; 替换为空格
    .trim(); // 去掉首尾空格
}

/**
 * 从m3u8地址获取视频质量等级和网络信息
 * @param m3u8Url m3u8播放列表的URL
 * @returns Promise<{quality: string, loadSpeed: string, pingTime: number}> 视频质量等级和网络信息
 */
export async function getVideoResolutionFromM3u8(m3u8Url: string): Promise<{
  quality: string; // 如720p、1080p等
  loadSpeed: string; // 自动转换为KB/s或MB/s
  pingTime: number; // 网络延迟（毫秒）
}> {
  // hls.js 体积较大，动态导入避免进入首屏 bundle（仅在实际测速时加载）
  const { default: Hls } = await import('hls.js');
  try {
    // 直接使用m3u8 URL作为视频源，避免CORS问题
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'metadata';

      // 测量网络延迟（ping时间） - 使用m3u8 URL而不是ts文件
      const pingStart = performance.now();
      let pingTime = 0;

      // 测量ping时间（使用m3u8 URL）
      fetch(m3u8Url, { method: 'HEAD', mode: 'no-cors' })
        .then(() => {
          pingTime = performance.now() - pingStart;
        })
        .catch(() => {
          pingTime = performance.now() - pingStart; // 记录到失败为止的时间
        });

      // 固定使用hls.js加载
      const hls = new Hls();

      // 设置超时处理
      const timeout = setTimeout(() => {
        hls.destroy();
        video.remove();
        reject(new Error('Timeout loading video metadata'));
      }, 4000);

      video.onerror = () => {
        clearTimeout(timeout);
        hls.destroy();
        video.remove();
        reject(new Error('Failed to load video metadata'));
      };

      let actualLoadSpeed = '未知';
      let hasSpeedCalculated = false;
      let hasMetadataLoaded = false;

      let fragmentStartTime = 0;

      // 检查是否可以返回结果
      const checkAndResolve = () => {
        if (
          hasMetadataLoaded &&
          (hasSpeedCalculated || actualLoadSpeed !== '未知')
        ) {
          clearTimeout(timeout);
          const width = video.videoWidth;
          if (width && width > 0) {
            hls.destroy();
            video.remove();

            // 根据视频宽度判断视频质量等级，使用经典分辨率的宽度作为分割点
            const quality =
              width >= 3840
                ? '4K' // 4K: 3840x2160
                : width >= 2560
                ? '2K' // 2K: 2560x1440
                : width >= 1920
                ? '1080p' // 1080p: 1920x1080
                : width >= 1280
                ? '720p' // 720p: 1280x720
                : width >= 854
                ? '480p'
                : 'SD'; // 480p: 854x480

            resolve({
              quality,
              loadSpeed: actualLoadSpeed,
              pingTime: Math.round(pingTime),
            });
          } else {
            // webkit 无法获取尺寸，直接返回
            resolve({
              quality: '未知',
              loadSpeed: actualLoadSpeed,
              pingTime: Math.round(pingTime),
            });
          }
        }
      };

      // 监听片段加载开始
      hls.on(Hls.Events.FRAG_LOADING, () => {
        fragmentStartTime = performance.now();
      });

      // 监听片段加载完成，只需首个分片即可计算速度
      hls.on(Hls.Events.FRAG_LOADED, (event: any, data: any) => {
        if (
          fragmentStartTime > 0 &&
          data &&
          data.payload &&
          !hasSpeedCalculated
        ) {
          const loadTime = performance.now() - fragmentStartTime;
          const size = data.payload.byteLength || 0;

          if (loadTime > 0 && size > 0) {
            const speedKBps = size / 1024 / (loadTime / 1000);

            // 立即计算速度，无需等待更多分片
            const avgSpeedKBps = speedKBps;

            if (avgSpeedKBps >= 1024) {
              actualLoadSpeed = `${(avgSpeedKBps / 1024).toFixed(1)} MB/s`;
            } else {
              actualLoadSpeed = `${avgSpeedKBps.toFixed(1)} KB/s`;
            }
            hasSpeedCalculated = true;
            checkAndResolve(); // 尝试返回结果
          }
        }
      });

      hls.loadSource(m3u8Url);
      hls.attachMedia(video);

      // 监听hls.js错误
      hls.on(Hls.Events.ERROR, (event: any, data: any) => {
        console.error('HLS错误:', data);
        if (data.fatal) {
          clearTimeout(timeout);
          hls.destroy();
          video.remove();
          reject(new Error(`HLS播放失败: ${data.type}`));
        }
      });

      // 监听视频元数据加载完成
      video.onloadedmetadata = () => {
        hasMetadataLoaded = true;
        checkAndResolve(); // 尝试返回结果
      };
    });
  } catch (error) {
    throw new Error(
      `Error getting video resolution: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * 标题数字写法归一化工具。
 *
 * 同一部剧在不同源站的标题数字写法不统一：
 * 「流人 第六季」/「流人第6季」/「流人 第06季」/「流人 第６季」，
 * 而上游搜索是整串包含匹配、按标题找源是全等比较，写法不同就会漏检/误判。
 * 下列函数用于生成补搜变体与归一化比较。
 */

const CN_DIGIT_VALUES: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const CN_NUM_CHARS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 解析汉字数字（支持 0-999，如 六 / 十 / 十二 / 二十三 / 一百零五），解析不了返回 null */
export function parseChineseNumber(text: string): number | null {
  if (!text) return null;
  let total = 0;
  let current = 0;
  let hasAny = false;
  for (const ch of text) {
    if (ch in CN_DIGIT_VALUES) {
      current = CN_DIGIT_VALUES[ch];
      hasAny = true;
    } else if (ch === '十') {
      total += (current === 0 ? 1 : current) * 10;
      current = 0;
      hasAny = true;
    } else if (ch === '百') {
      total += (current === 0 ? 1 : current) * 100;
      current = 0;
      hasAny = true;
    } else {
      return null;
    }
  }
  return hasAny ? total + current : null;
}

/** 阿拉伯数字转汉字写法（0-100，如 6→六、12→十二、20→二十），超出范围返回原数字字符串 */
export function toChineseNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 100) return String(n);
  if (n < 10) return CN_NUM_CHARS[n];
  if (n < 20) return '十' + (n % 10 ? CN_NUM_CHARS[n % 10] : '');
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const ones = n % 10;
    return CN_NUM_CHARS[tens] + '十' + (ones ? CN_NUM_CHARS[ones] : '');
  }
  return '一百';
}

export type TitleNumberMode = 'arabic' | 'arabicPadded' | 'chinese';

/**
 * 转换字符串中所有数字片段的写法（全角数字先转半角）：
 * - arabic：汉字数字→阿拉伯，阿拉伯数字去掉前导零（六→6、06→6）
 * - arabicPadded：同上，但 1-9 补零成两位（六→06、6→06）
 * - chinese：阿拉伯数字→汉字（6→六，4 位年份等大数字保持不变），汉字数字保持原样
 */
export function convertTitleNumbers(
  text: string,
  mode: TitleNumberMode
): string {
  const halfWidth = text.replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
  const convertArabicRun = (run: string): string => {
    const n = parseInt(run, 10);
    if (mode === 'chinese') {
      // 4 位及以上（年份等）不转汉字
      return run.length >= 4 ? run : toChineseNumber(n);
    }
    if (mode === 'arabicPadded') {
      return n < 10 ? String(n).padStart(2, '0') : String(n);
    }
    return String(n);
  };
  const convertChineseRun = (run: string): string => {
    if (mode === 'chinese') return run;
    const n = parseChineseNumber(run);
    if (n === null) return run;
    if (mode === 'arabicPadded') {
      return n < 10 ? String(n).padStart(2, '0') : String(n);
    }
    return String(n);
  };
  return halfWidth
    .replace(/\d+/g, convertArabicRun)
    .replace(/[零〇一二三四五六七八九十百]+/g, convertChineseRun);
}

/**
 * 标题匹配归一化：全角转半角、数字统一为阿拉伯写法并去掉前导零、去掉全部空白。
 * 「流人 第六季」「流人第6季」「流人 第06季」归一化后完全一致。
 */
export function normalizeTitleForMatch(title: string): string {
  return convertTitleNumbers(title, 'arabic').replace(/[\s\u3000]+/g, '');
}

/**
 * 生成「最新更新」角标文案：从标题解析季数、从备注解析集数/完结状态。
 * 例：标题「流人 第六季」+ 备注「更新至第24集」→「第6季 · 更新至第24集」；
 * 解析不出任何内容时返回空字符串（不显示角标）。
 */
export function buildUpdateBadge(title: string, remarks?: string): string {
  const parts: string[] = [];
  const seasonMatch = title.match(
    /第\s*([0-9]+|[零一二三四五六七八九十]+)\s*季/
  );
  if (seasonMatch) {
    const raw = seasonMatch[1];
    const n = /^\d+$/.test(raw)
      ? parseInt(raw, 10)
      : parseChineseNumber(raw);
    if (n) parts.push(`第${n}季`);
  }
  const r = (remarks || '').trim();
  if (r) {
    const epMatch =
      r.match(/更新至\s*第?\s*([0-9]+)\s*集/) || r.match(/第\s*([0-9]+)\s*集/);
    if (epMatch) {
      parts.push(`更新至第${parseInt(epMatch[1], 10)}集`);
    } else if (r.includes('已完结') || r.includes('全集')) {
      parts.push('已完结');
    }
  }
  return parts.join(' · ');
}
