/* eslint-disable @typescript-eslint/no-explicit-any */
// 去广告相关：hls.js 自定义 loader 与 m3u8 过滤逻辑
// 从 app/play/page.tsx 抽出，便于复用与单测

// 过滤 m3u8 中的广告分段标识（纯函数）
export function filterAdsFromM3U8(m3u8Content: string): string {
  if (!m3u8Content) return '';

  // 按行分割M3U8内容
  const lines = m3u8Content.split('\n');
  const filteredLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 只过滤#EXT-X-DISCONTINUITY标识
    if (!line.includes('#EXT-X-DISCONTINUITY')) {
      filteredLines.push(line);
    }
  }

  return filteredLines.join('\n');
}

// 去广告 loader 工厂：hls.js 懒加载后传入构造器，避免首屏 bundle 膨胀
export function createAdBlockHlsLoader(HlsCtor: any) {
  return class CustomHlsJsLoader extends HlsCtor.DefaultConfig.loader {
    constructor(config: any) {
      super(config);
      const load = this.load.bind(this);
      this.load = function (context: any, config: any, callbacks: any) {
        // 拦截manifest和level请求
        if (
          (context as any).type === 'manifest' ||
          (context as any).type === 'level'
        ) {
          const onSuccess = callbacks.onSuccess;
          callbacks.onSuccess = function (
            response: any,
            stats: any,
            context: any
          ) {
            // 如果是m3u8文件，处理内容以移除广告分段
            if (response.data && typeof response.data === 'string') {
              // 过滤掉广告段 - 实现更精确的广告过滤逻辑
              response.data = filterAdsFromM3U8(response.data);
            }
            return onSuccess(response, stats, context, null);
          };
        }
        // 执行原始load方法
        load(context, config, callbacks);
      };
    }
  };
}
