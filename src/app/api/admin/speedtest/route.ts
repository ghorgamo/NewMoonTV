/* eslint-disable @typescript-eslint/no-explicit-any,no-console */

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';

export const runtime = 'edge';

// 测速：从服务端（边缘节点）向每个源发一次 videolist 请求并计时，
// 测的是聚合链路（/api/latest、/api/search）实际走的那条路，不是浏览器直连的速度。
// 每个源单独 8 秒超时，全部并行测；失败（超时/断连/非 2xx）记为不通，排序时沉底。
const PROBE_TIMEOUT_MS = 8000;

async function probe(api: string): Promise<{ ms: number | null; ok: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const start = Date.now();
  try {
    const resp = await fetch(`${api}?ac=videolist&pg=1`, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });
    return { ms: Date.now() - start, ok: resp.ok };
  } catch {
    return { ms: null, ok: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    if (!authInfo || !authInfo.username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const username = authInfo.username;
    const adminConfig = await getConfig();
    if (username !== process.env.USERNAME) {
      const userEntry = adminConfig.UserConfig.Users.find(
        (u) => u.username === username
      );
      if (!userEntry || userEntry.role !== 'admin') {
        return NextResponse.json({ error: '权限不足' }, { status: 401 });
      }
    }
    // 注意：这里不拦本地存储模式——测速只读不写，文件源也能测。
    const sources = adminConfig.SourceConfig || [];
    const settled = await Promise.allSettled(
      sources.map(async (s) => ({ key: s.key, ...(await probe(s.api)) }))
    );
    const results = settled.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : { key: sources[i].key, ms: null, ok: false }
    );
    return NextResponse.json(
      { results },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('视频源测速失败:', error);
    return NextResponse.json({ error: '测速失败' }, { status: 500 });
  }
}
