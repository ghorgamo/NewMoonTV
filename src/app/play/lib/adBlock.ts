/* eslint-disable @typescript-eslint/no-explicit-any */
// 去广告相关：hls.js 自定义 loader 与 m3u8 过滤逻辑
// 从 app/play/page.tsx 抽出，便于复用与单测

// ---------------------------------------------------------------------------
// m3u8 广告过滤
//
// 资源站的插播广告在播放列表里的典型形态：被 #EXT-X-DISCONTINUITY 包围的一小
// 段分片，且这段分片来自与众不同的域名/目录（广告分发路径），总时长很短。
// 原实现只删 DISCONTINUITY 标记行、广告分片照播，等于没过滤；这里换成真正的
// 分段识别，判定信号（同时成立才删，宁可漏删不可误杀正片）：
//   1. 该段被 DISCONTINUITY 分隔（或整表无标记时，为连续异常分片序列）；
//   2. 段内全部分片的「域名+目录」都与正片主导来源不同；
//   3. 段总时长 ≤ 90 秒（正片分段不会这么短）。
// 主播放列表（EXT-X-STREAM-INF 变体列表）不处理，原样返回；
// 子列表会被 loader 单独拦截过滤。
// ---------------------------------------------------------------------------

interface SegmentItem {
  // 该分片前紧贴的标签行（EXTINF / KEY / MAP 等），随分片一起保留或删除
  tags: string[];
  duration: number;
  url: string;
  // 与前一个分片之间是否有 DISCONTINUITY 分隔
  discontinuityBefore: boolean;
}

// 分片的「来源身份」：域名 + 所在目录。广告与正片通常至少有一项不同。
function segmentIdentity(url: string): string {
  let host = '';
  let path = url;
  const m = url.match(/^https?:\/\/([^/]+)(\/.*)?$/i);
  if (m) {
    host = m[1].toLowerCase();
    path = m[2] || '/';
  }
  const dir = path.slice(0, path.lastIndexOf('/') + 1);
  return `${host}${dir}`;
}

function parseExtinfDuration(line: string): number {
  const m = line.match(/#EXTINF:([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

const AD_SEGMENT_MAX_SECONDS = 90;

export function filterAdsFromM3U8(m3u8Content: string): string {
  if (!m3u8Content) return '';

  // 主播放列表不处理（没有分片时长可供判断，子列表会被单独过滤）
  if (m3u8Content.includes('#EXT-X-STREAM-INF')) return m3u8Content;

  const lines = m3u8Content.split('\n');
  const headerLines: string[] = []; // 第一个分片之前的全局标签
  const footerLines: string[] = []; // ENDLIST 等尾部标签
  const segments: SegmentItem[] = [];
  let pendingTags: string[] = [];
  let pendingDuration = 0;
  let discontinuityPending = false;
  let seenFirstSegment = false;
  let inFooter = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-ENDLIST')) {
      inFooter = true;
      footerLines.push(line);
      continue;
    }
    if (inFooter) {
      footerLines.push(line);
      continue;
    }

    if (line.startsWith('#EXT-X-DISCONTINUITY')) {
      discontinuityPending = true;
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      pendingDuration = parseExtinfDuration(line);
      pendingTags.push(line);
      continue;
    }
    if (line.startsWith('#')) {
      // 全局标签归 header；分片级标签（KEY/MAP 等）归到紧随的分片
      if (!seenFirstSegment && pendingTags.length === 0) {
        headerLines.push(line);
      } else {
        pendingTags.push(line);
      }
      continue;
    }

    // 分片 URL 行
    segments.push({
      tags: pendingTags,
      duration: pendingDuration,
      url: line,
      discontinuityBefore: discontinuityPending,
    });
    pendingTags = [];
    pendingDuration = 0;
    discontinuityPending = false;
    seenFirstSegment = true;
  }

  if (segments.length === 0) return m3u8Content;

  // 正片主导来源：出现次数最多的「域名+目录」
  const identityCount = new Map<string, number>();
  for (const seg of segments) {
    const id = segmentIdentity(seg.url);
    identityCount.set(id, (identityCount.get(id) || 0) + 1);
  }
  let mainIdentity = '';
  let mainCount = 0;
  identityCount.forEach((count, id) => {
    if (count > mainCount) {
      mainIdentity = id;
      mainCount = count;
    }
  });
  // 主导来源占比太低说明来源混杂（多 CDN 轮换等），判定不可靠，整表放行
  if (mainCount < segments.length * 0.4) return m3u8Content;

  const isAlien = (seg: SegmentItem) =>
    segmentIdentity(seg.url) !== mainIdentity;

  // 按 DISCONTINUITY 切段
  interface SegGroup {
    items: SegmentItem[];
    startsWithDiscontinuity: boolean;
  }
  const groups: SegGroup[] = [];
  for (const seg of segments) {
    if (seg.discontinuityBefore || groups.length === 0) {
      groups.push({
        items: [seg],
        startsWithDiscontinuity: seg.discontinuityBefore,
      });
    } else {
      groups[groups.length - 1].items.push(seg);
    }
  }

  const hasDiscontinuity = groups.some((g) => g.startsWithDiscontinuity);
  const groupDuration = (g: SegGroup) =>
    g.items.reduce((sum, s) => sum + (s.duration || 0), 0);

  const keptGroups: SegGroup[] = [];
  if (hasDiscontinuity) {
    // 有分段标记时，只处理「标记段」：全员异常来源 + 短时长
    for (const g of groups) {
      const isAdGroup =
        g.startsWithDiscontinuity &&
        g.items.every(isAlien) &&
        groupDuration(g) <= AD_SEGMENT_MAX_SECONDS;
      if (!isAdGroup) keptGroups.push(g);
    }
  } else {
    // 整表无标记：找连续异常来源的短序列（总时长达标才删，避免误伤整段外链正片）
    let run: SegmentItem[] = [];
    const flush = () => {
      if (run.length === 0) return;
      const total = run.reduce((sum, s) => sum + (s.duration || 0), 0);
      if (total > AD_SEGMENT_MAX_SECONDS) {
        keptGroups.push({ items: run, startsWithDiscontinuity: false });
      }
      run = [];
    };
    for (const seg of segments) {
      if (isAlien(seg)) {
        run.push(seg);
      } else {
        flush();
        const last = keptGroups[keptGroups.length - 1];
        if (last && !last.startsWithDiscontinuity) {
          last.items.push(seg);
        } else {
          keptGroups.push({ items: [seg], startsWithDiscontinuity: false });
        }
      }
    }
    flush();
    // 若删完什么都不剩，说明判定有误，整表放行
    if (keptGroups.length === 0) return m3u8Content;
  }

  const removedCount =
    segments.length - keptGroups.reduce((sum, g) => sum + g.items.length, 0);
  if (removedCount === 0) return m3u8Content;

  // 重组：header + 保留段（原有 DISCONTINUITY 的段间恢复一个标记）+ footer
  const out: string[] = [...headerLines];
  keptGroups.forEach((g, idx) => {
    if (idx > 0 && g.startsWithDiscontinuity) {
      out.push('#EXT-X-DISCONTINUITY');
    }
    for (const seg of g.items) {
      out.push(...seg.tags, seg.url);
    }
  });
  out.push(...footerLines);
  return out.join('\n') + '\n';
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
            // 如果是m3u8文件，过滤其中的广告段
            if (response.data && typeof response.data === 'string') {
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
