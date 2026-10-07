import { filterAdsFromM3U8 } from '../adBlock';

const HEAD = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:0\n';
const seg = (url: string, dur = 8) => `#EXTINF:${dur},\n${url}\n`;
const mainSegs = (n: number) =>
  Array.from({ length: n }, (_, i) => seg(`seg${i}.ts`)).join('');

describe('filterAdsFromM3U8', () => {
  it('删除 DISCONTINUITY 包围的异域名广告段', () => {
    const input =
      HEAD + mainSegs(5) +
      '#EXT-X-DISCONTINUITY\n' +
      seg('https://ad.example.com/xx/ad1.ts', 5) +
      seg('https://ad.example.com/xx/ad2.ts', 5) +
      '#EXT-X-DISCONTINUITY\n' + mainSegs(5).replace(/seg(\d)/g, 'segB$1') +
      '#EXT-X-ENDLIST\n';
    const out = filterAdsFromM3U8(input);
    expect(out).not.toContain('ad.example.com');
    expect(out).toContain('seg0.ts');
    expect(out).toContain('segB0.ts');
    expect(out).toContain('#EXT-X-ENDLIST');
  });

  it('删除同域名不同目录的广告段', () => {
    const input =
      HEAD +
      Array.from({ length: 6 }, (_, i) => seg(`https://v.cdn.com/20261007/show/seg${i}.ts`)).join('') +
      '#EXT-X-DISCONTINUITY\n' +
      seg('https://v.cdn.com/ads/promo/p1.ts', 6) +
      seg('https://v.cdn.com/ads/promo/p2.ts', 6) +
      '#EXT-X-DISCONTINUITY\n' +
      Array.from({ length: 4 }, (_, i) => seg(`https://v.cdn.com/20261007/show/part${i}.ts`)).join('') +
      '#EXT-X-ENDLIST\n';
    const out = filterAdsFromM3U8(input);
    expect(out).not.toContain('/ads/promo/');
    expect(out).toContain('part0.ts');
  });

  it('正片自身的 DISCONTINUITY（来源未变）不误删', () => {
    const input =
      HEAD + mainSegs(4) +
      '#EXT-X-DISCONTINUITY\n' + mainSegs(4).replace(/seg(\d)/g, 'segC$1') +
      '#EXT-X-ENDLIST\n';
    expect(filterAdsFromM3U8(input)).toBe(input);
  });

  it('主播放列表原样返回', () => {
    const input =
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nhttps://v.cdn.com/hd/index.m3u8\n';
    expect(filterAdsFromM3U8(input)).toBe(input);
  });

  it('无标记时删除中间的异域名短序列', () => {
    const input =
      HEAD + mainSegs(5) +
      seg('https://gg.other.net/a/1.ts', 4) +
      seg('https://gg.other.net/a/2.ts', 4) +
      mainSegs(5).replace(/seg(\d)/g, 'segD$1') +
      '#EXT-X-ENDLIST\n';
    const out = filterAdsFromM3U8(input);
    expect(out).not.toContain('gg.other.net');
    expect(out).toContain('segD0.ts');
  });

  it('异域名但时长很长的一段（正片换 CDN）不删', () => {
    const input =
      HEAD + mainSegs(6) +
      '#EXT-X-DISCONTINUITY\n' +
      Array.from({ length: 40 }, (_, i) => seg(`https://v2.cdn.com/show/s${i}.ts`, 10)).join('') +
      '#EXT-X-ENDLIST\n';
    const out = filterAdsFromM3U8(input);
    expect(out).toContain('v2.cdn.com');
    expect(out).toContain('s39.ts');
  });

  it('空内容与无分片列表原样处理', () => {
    expect(filterAdsFromM3U8('')).toBe('');
    expect(filterAdsFromM3U8(HEAD)).toBe(HEAD);
  });
});
