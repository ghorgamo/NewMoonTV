/* eslint-disable no-console */

import { NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';

export const runtime = 'edge';

/**
 * OrionTV 直播源接口（登录后调用）。
 * 返回 config.json 里 live_sources 配置的 M3U 播放列表地址与 UA。
 * OrionTV 取 data[0] 当作直播源；中间件已要求登录态，未登录返回 401。
 */
export async function GET() {
  const config = await getConfig();
  const data = (config.LiveSources || []).map((s) => ({
    key: s.key,
    name: s.name,
    url: s.url,
    ua: s.ua || '',
  }));
  return NextResponse.json({ success: true, data });
}
