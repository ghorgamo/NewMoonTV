import { NextResponse } from 'next/server';
import { getCacheTime } from '@/lib/config';
import { DoubanItem, DoubanResult } from '@/lib/types';

export const runtime = 'edge';

interface DoubanApiResponse {
  subjects: Array<{
    id: string;
    title: string;
    cover: string;
    rate: string;
  }>;
}

// 提取公共请求头
const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  Referer: 'https://movie.douban.com/',
};

// 提取通用的带有超时控制的 Fetch 方法
async function fetchWithTimeout(url: string, options: RequestInit, timeout = 10000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    return response;
  } finally {
    // 无论成功还是异常，都在 finally 中清理定时器，防止内存泄漏
    clearTimeout(timeoutId);
  }
}

// 提取通用的缓存 Headers 获取逻辑，引入 stale-while-revalidate 策略
async function getCacheHeaders() {
  const cacheTime = await getCacheTime();
  // 增加 stale-while-revalidate 以提升用户体验 (缓存过期时先返回旧数据，后台静默更新)
  const swrTime = 86400; 
  return {
    'Cache-Control': `public, max-age=${cacheTime}, s-maxage=${cacheTime}, stale-while-revalidate=${swrTime}`,
    'CDN-Cache-Control': `public, s-maxage=${cacheTime}, stale-while-revalidate=${swrTime}`,
    'Vercel-CDN-Cache-Control': `public, s-maxage=${cacheTime}, stale-while-revalidate=${swrTime}`,
  };
}

async function fetchDoubanData(url: string): Promise<DoubanApiResponse> {
  const response = await fetchWithTimeout(url, {
    headers: {
      ...COMMON_HEADERS,
      Accept: 'application/json, text/plain, */*',
    },
  });
  return response.json();
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const type = searchParams.get('type');
  const tag = searchParams.get('tag');
  const pageSize = parseInt(searchParams.get('pageSize') || '16');
  const pageStart = parseInt(searchParams.get('pageStart') || '0');

  // 参数校验
  if (!type || !tag) {
    return NextResponse.json({ error: '缺少必要参数: type 或 tag' }, { status: 400 });
  }

  if (!['tv', 'movie'].includes(type)) {
    return NextResponse.json({ error: 'type 参数必须是 tv 或 movie' }, { status: 400 });
  }

  if (pageSize < 1 || pageSize > 100) {
    return NextResponse.json({ error: 'pageSize 必须在 1-100 之间' }, { status: 400 });
  }

  if (pageStart < 0) {
    return NextResponse.json({ error: 'pageStart 不能小于 0' }, { status: 400 });
  }

  // 路由分发
  if (tag === 'top250') {
    return handleTop250(pageStart);
  }

  const target = `https://movie.douban.com/j/search_subjects?type=${type}&tag=${tag}&sort=recommend&page_limit=${pageSize}&page_start=${pageStart}`;

  try {
    const doubanData = await fetchDoubanData(target);

    const list: DoubanItem[] = doubanData.subjects.map((item) => ({
      id: item.id,
      title: item.title,
      poster: item.cover,
      rate: item.rate,
      year: '',
    }));

    const response: DoubanResult = {
      code: 200,
      message: '获取成功',
      list,
    };

    const headers = await getCacheHeaders();
    return NextResponse.json(response, { headers });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: '获取豆瓣数据失败', details: errorMessage },
      { status: 500 }
    );
  }
}

async function handleTop250(pageStart: number) {
  const target = `https://movie.douban.com/top250?start=${pageStart}&filter=`;

  try {
    const response = await fetchWithTimeout(target, {
      headers: {
        ...COMMON_HEADERS,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
    });

    const html = await response.text();

    const moviePattern =
      /<div class="item">[\s\S]*?<a[^>]+href="https?:\/\/movie\.douban\.com\/subject\/(\d+)\/"[\s\S]*?<img[^>]+alt="([^"]+)"[^>]*src="([^"]+)"[\s\S]*?<span class="rating_num"[^>]*>([^<]*)<\/span>[\s\S]*?<\/div>/g;
    const movies: DoubanItem[] = [];
    let match;

    while ((match = moviePattern.exec(html)) !== null) {
      movies.push({
        id: match[1],
        title: match[2],
        poster: match[3].replace(/^http:/, 'https:'),
        rate: match[4] || '',
        year: '',
      });
    }

    const apiResponse: DoubanResult = {
      code: 200,
      message: '获取成功',
      list: movies,
    };

    const headers = await getCacheHeaders();
    return NextResponse.json(apiResponse, { headers });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: '获取豆瓣 Top250 数据失败', details: errorMessage },
      { status: 500 }
    );
  }
}
