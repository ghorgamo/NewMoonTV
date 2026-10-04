import { NextResponse } from 'next/server';

export const runtime = 'edge';

// 允许代理的图片域名白名单（可通过环境变量 IMAGE_PROXY_ALLOWLIST 追加，逗号分隔）
// 默认仅允许豆瓣图片域；子域名通过后缀匹配放行
const DEFAULT_ALLOWLIST = ['doubanio.com'];

function getAllowlist(): string[] {
  const extra = (process.env.IMAGE_PROXY_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...DEFAULT_ALLOWLIST, ...extra];
}

function isHostnameAllowed(hostname: string, allowlist: string[]): boolean {
  const host = hostname.toLowerCase();
  // 拒绝 IP 字面量（IPv4 / IPv6），防止指向内网或云元数据服务
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    return false;
  }
  return allowlist.some((d) => host === d || host.endsWith(`.${d}`));
}

// 校验目标 URL：仅 http/https、无 userinfo、域名在白名单内
function validateTargetUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  if (url.username || url.password) {
    return null;
  }
  if (!isHostnameAllowed(url.hostname, getAllowlist())) {
    return null;
  }
  return url;
}

async function fetchImage(url: URL): Promise<Response> {
  // 手动处理重定向，每一跳都重新做白名单校验，防止开放重定向绕过
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    const imageResponse = await fetch(current.toString(), {
      redirect: 'manual',
      headers: {
        Referer: 'https://movie.douban.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      },
    });

    const location = imageResponse.headers.get('location');
    if (
      imageResponse.status >= 300 &&
      imageResponse.status < 400 &&
      location
    ) {
      const next = validateTargetUrl(
        new URL(location, current.toString()).toString()
      );
      if (!next) {
        throw new Error('Redirect target not allowed');
      }
      current = next;
      continue;
    }
    return imageResponse;
  }
  throw new Error('Too many redirects');
}

// OrionTV 兼容接口
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  if (!imageUrl) {
    return NextResponse.json({ error: 'Missing image URL' }, { status: 400 });
  }

  const target = validateTargetUrl(imageUrl);
  if (!target) {
    return NextResponse.json(
      { error: 'URL not allowed by image proxy allowlist' },
      { status: 403 }
    );
  }

  try {
    const imageResponse = await fetchImage(target);

    if (!imageResponse.ok) {
      return NextResponse.json(
        { error: imageResponse.statusText },
        { status: imageResponse.status }
      );
    }

    const contentType = imageResponse.headers.get('content-type') || '';
    // 仅允许代理图片内容，防止被用作任意内容跳板
    if (!contentType.startsWith('image/')) {
      return NextResponse.json(
        { error: 'Not an image' },
        { status: 415 }
      );
    }

    if (!imageResponse.body) {
      return NextResponse.json(
        { error: 'Image response has no body' },
        { status: 500 }
      );
    }

    // 创建响应头
    const headers = new Headers();
    headers.set('Content-Type', contentType);

    // 设置缓存头（可选）
    headers.set('Cache-Control', 'public, max-age=15720000, s-maxage=15720000'); // 缓存半年
    headers.set('CDN-Cache-Control', 'public, s-maxage=15720000');
    headers.set('Vercel-CDN-Cache-Control', 'public, s-maxage=15720000');

    // 直接返回图片流
    return new Response(imageResponse.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Error fetching image' },
      { status: 500 }
    );
  }
}
