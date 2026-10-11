import { NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { fillAllScores, ScoreTarget } from '@/lib/scores';
import { normalizeTitleForMatch } from '@/lib/utils';

export const runtime = 'edge';

// 评分补查接口：前端渲染出卡片后分批（每批 ≤8 条）POST 过来补豆瓣/IMDb 分。
// 独立成单独调用是为了避开 Cloudflare 单次函数调用的子请求上限——
// 塞在 /api/latest 里时回填会被源站拉取挤占额度而整批失败（已实测定位）。
interface ScoreRequestItem {
  title?: string;
  year?: string;
  douban_id?: number;
}

export async function POST(request: Request) {
  let body: { items?: ScoreRequestItem[]; category?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }
  const rawItems = Array.isArray(body.items) ? body.items.slice(0, 8) : [];
  const category = body.category || 'tv';
  const targets: ScoreTarget[] = rawItems
    .map((it) => ({
      title: (it.title || '').trim(),
      year: it.year || '',
      douban_id: it.douban_id,
    }))
    .filter((t) => t.title);
  if (targets.length === 0) {
    return NextResponse.json({ scores: {} });
  }

  const config = await getConfig();
  // 豆瓣代理：优先站点的豆瓣代理配置，为空回退图片代理（同为 ?url= 型 Worker）
  const doubanProxy =
    (config.SiteConfig?.DoubanProxy || '').trim() ||
    (config.SiteConfig?.ImageProxy || '').trim();

  await fillAllScores(targets, category, doubanProxy);

  const scores: Record<string, { douban_score?: string; imdb_score?: string }> =
    {};
  for (const t of targets) {
    if (t.douban_score || t.imdb_score) {
      scores[normalizeTitleForMatch(t.title)] = {
        douban_score: t.douban_score,
        imdb_score: t.imdb_score,
      };
    }
  }
  return NextResponse.json(
    { scores },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
