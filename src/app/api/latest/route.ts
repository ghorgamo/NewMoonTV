import { NextResponse } from 'next/server';

import { API_CONFIG, ApiSite, getConfig } from '@/lib/config';
import { SearchResult } from '@/lib/types';
import { cleanHtmlTags, normalizeTitleForMatch } from '@/lib/utils';

export const runtime = 'edge';

// 首页「最新更新」栏目接口。
// 数据来源是资源站自身的分类列表：苹果CMS 官方接口按 vod_time（更新时间）倒序，
// 天然满足「最新季、最新集排前面」。服务端负责：按分类表把子分类一并纳入拉取、
// 多源归并、按归一化标题去重、最终统一按更新时间倒序，绕开个别站分类顺序异常的问题。

// 首选数据源（更新最密的两个第一梯队源）；配置中缺失时自动用其他启用源补位
const PREFERRED_SOURCE_KEYS = ['lzcaiji', 'feifanapi'];
const MAX_SOURCES = 2;
const FETCH_TIMEOUT_MS = 6000;

// 栏目 → 大类名关键词（按 maccms 分类表的 type_name 匹配 pid=0 的大类）
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  movie: ['电影'],
  tv: ['连续剧', '电视剧'],
  variety: ['综艺'],
  anime: ['动漫', '动画'],
};

// 不纳入任何栏目的子分类（成人向等）
const EXCLUDED_CLASS_KEYWORDS = ['伦理'];

// 不作为大类的分类名（名字含栏目关键词但并非该栏目，如「电影解说」是独立大类）
const EXCLUDED_PARENT_KEYWORDS = ['解说'];

interface ClassItem {
  type_id: number | string;
  type_pid: number | string;
  type_name: string;
}

interface VodListItem {
  vod_id: string | number;
  vod_name: string;
  vod_pic: string;
  vod_remarks?: string;
  vod_time?: string;
  vod_play_url?: string;
  vod_class?: string;
  vod_year?: string;
  vod_content?: string;
  vod_douban_id?: number;
  type_name?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fetchJson(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: API_CONFIG.search.headers,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// 解析某栏目在该源下的全部分类 id：大类本身 + 其全部子分类（排除名单除外）。
// 内容大多挂在子分类下（国产剧/韩剧等），只拉大类会漏掉绝大部分。
function resolveCategoryTypeIds(
  classes: ClassItem[],
  keywords: string[]
): number[] {
  const parents = classes.filter(
    (c) =>
      Number(c.type_pid) === 0 &&
      keywords.some((k) => (c.type_name || '').includes(k)) &&
      !EXCLUDED_PARENT_KEYWORDS.some((k) => (c.type_name || '').includes(k))
  );
  const ids = new Set<number>();
  for (const parent of parents) {
    ids.add(Number(parent.type_id));
    for (const c of classes) {
      if (
        Number(c.type_pid) === Number(parent.type_id) &&
        !EXCLUDED_CLASS_KEYWORDS.some((k) => (c.type_name || '').includes(k))
      ) {
        ids.add(Number(c.type_id));
      }
    }
  }
  return Array.from(ids);
}

// 与 searchFromApi 相同的 m3u8 集数提取逻辑
function parseEpisodes(vodPlayUrl?: string): string[] {
  if (!vodPlayUrl) return [];
  const m3u8Regex = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
  let episodes: string[] = [];
  vodPlayUrl.split('$$$').forEach((part) => {
    const matches = part.match(m3u8Regex) || [];
    if (matches.length > episodes.length) {
      episodes = matches;
    }
  });
  return Array.from(new Set(episodes)).map((link) => {
    const l = link.substring(1);
    const parenIndex = l.indexOf('(');
    return parenIndex > 0 ? l.substring(0, parenIndex) : l;
  });
}

function mapItem(item: VodListItem, site: ApiSite): SearchResult {
  return {
    id: item.vod_id.toString(),
    title: (item.vod_name || '').trim().replace(/\s+/g, ' '),
    poster: item.vod_pic,
    episodes: parseEpisodes(item.vod_play_url),
    source: site.key,
    source_name: site.name,
    class: item.vod_class,
    year: item.vod_year ? item.vod_year.match(/\d{4}/)?.[0] || '' : 'unknown',
    desc: cleanHtmlTags(item.vod_content || ''),
    type_name: item.type_name,
    douban_id: item.vod_douban_id,
    remarks: item.vod_remarks,
    update_time: item.vod_time,
  };
}

async function fetchLatestFromSite(
  site: ApiSite,
  keywords: string[],
  page: number
): Promise<SearchResult[]> {
  const classData = await fetchJson(`${site.api}?ac=list`);
  const classes: ClassItem[] = Array.isArray(classData?.class)
    ? classData.class
    : [];
  if (classes.length === 0) return [];

  const typeIds = resolveCategoryTypeIds(classes, keywords);
  if (typeIds.length === 0) return [];

  const pages = await Promise.allSettled(
    typeIds.map((tid) =>
      fetchJson(`${site.api}?ac=videolist&t=${tid}&pg=${page}`)
    )
  );

  const results: SearchResult[] = [];
  for (const page of pages) {
    if (page.status !== 'fulfilled' || !Array.isArray(page.value?.list)) {
      continue;
    }
    for (const item of page.value.list as VodListItem[]) {
      results.push(mapItem(item, site));
    }
  }
  return results;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const category = searchParams.get('category') || '';
  const keywords = CATEGORY_KEYWORDS[category];
  if (!keywords) {
    return NextResponse.json(
      { error: '不支持的栏目 category（可选 movie/tv/variety/anime）' },
      { status: 400 }
    );
  }
  const limitParam = parseInt(searchParams.get('limit') || '18', 10);
  const limit = Math.min(Math.max(Number.isNaN(limitParam) ? 18 : limitParam, 1), 60);
  // pg：第几页（每个子分类各拉一页后归并）；上限防滥用，首页不传即第 1 页
  const pageParam = parseInt(searchParams.get('pg') || '1', 10);
  const page = Math.min(Math.max(Number.isNaN(pageParam) ? 1 : pageParam, 1), 5);

  const config = await getConfig();
  const enabledSites = config.SourceConfig.filter((s) => !s.disabled);

  // 选源：首选名单优先，其余启用源补位
  const picked: ApiSite[] = [];
  for (const key of PREFERRED_SOURCE_KEYS) {
    const site = enabledSites.find((s) => s.key === key);
    if (site) picked.push(site);
  }
  for (const site of enabledSites) {
    if (picked.length >= MAX_SOURCES) break;
    if (!picked.some((s) => s.key === site.key)) picked.push(site);
  }
  if (picked.length === 0) {
    return NextResponse.json({ results: [] });
  }

  const batches = await Promise.allSettled(
    picked.map((site) => fetchLatestFromSite(site, keywords, page))
  );

  // 双源归并：按归一化标题去重，同一作品保留更新时间较新的一条
  const byTitle = new Map<string, SearchResult>();
  for (const batch of batches) {
    if (batch.status !== 'fulfilled') continue;
    for (const item of batch.value) {
      const key = normalizeTitleForMatch(item.title);
      const prev = byTitle.get(key);
      if (!prev || (item.update_time || '') > (prev.update_time || '')) {
        byTitle.set(key, item);
      }
    }
  }

  // 统一按更新时间倒序（vod_time 为 'YYYY-MM-DD HH:mm:ss'，字符串序即时间序）
  const merged = Array.from(byTitle.values()).sort((a, b) =>
    (b.update_time || '').localeCompare(a.update_time || '')
  );

  return NextResponse.json(
    { results: merged.slice(0, limit) },
    {
      headers: {
        // 更新栏目要新鲜：5 分钟短缓存
        'Cache-Control': 'public, max-age=300, s-maxage=300',
        'CDN-Cache-Control': 'public, s-maxage=300',
        'Vercel-CDN-Cache-Control': 'public, s-maxage=300',
      },
    }
  );
}
