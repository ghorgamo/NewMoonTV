/* eslint-disable no-console */
// 播放源优选逻辑：并发测速 + 综合评分选出最佳播放源
// 从 app/play/page.tsx 抽出，便于复用与单测

import { SearchResult } from '@/lib/types';
import { getVideoResolutionFromM3u8 } from '@/lib/utils';

export interface SpeedTestResult {
  quality: string;
  loadSpeed: string;
  pingTime: number;
  hasError?: boolean;
}

// 播放源优选函数
export async function preferBestSource(
  sources: SearchResult[],
  onTested: (info: Map<string, SpeedTestResult>) => void
): Promise<SearchResult> {
  if (sources.length === 1) return sources[0];

  // 将播放源均分为两批，并发测速各批，避免一次性过多请求
  const batchSize = Math.ceil(sources.length / 2);
  const allResults: Array<{
    source: SearchResult;
    testResult: { quality: string; loadSpeed: string; pingTime: number };
  } | null> = [];

  for (let start = 0; start < sources.length; start += batchSize) {
    const batchSources = sources.slice(start, start + batchSize);
    const batchResults = await Promise.all(
      batchSources.map(async (source) => {
        try {
          // 检查是否有第一集的播放地址
          if (!source.episodes || source.episodes.length === 0) {
            console.warn(`播放源 ${source.source_name} 没有可用的播放地址`);
            return null;
          }

          const episodeUrl =
            source.episodes.length > 1 ? source.episodes[1] : source.episodes[0];
          const testResult = await getVideoResolutionFromM3u8(episodeUrl);

          return {
            source,
            testResult,
          };
        } catch (error) {
          return null;
        }
      })
    );
    allResults.push(...batchResults);
  }

  // 等待所有测速完成，包含成功和失败的结果
  // 保存所有测速结果到 precomputedVideoInfo，供 EpisodeSelector 使用（包含错误结果）
  const newVideoInfoMap = new Map<string, SpeedTestResult>();
  allResults.forEach((result, index) => {
    const source = sources[index];
    const sourceKey = `${source.source}-${source.id}`;

    if (result) {
      // 成功的结果
      newVideoInfoMap.set(sourceKey, result.testResult);
    }
  });

  // 过滤出成功的结果用于优选计算
  const successfulResults = allResults.filter(Boolean) as Array<{
    source: SearchResult;
    testResult: { quality: string; loadSpeed: string; pingTime: number };
  }>;

  onTested(newVideoInfoMap);

  if (successfulResults.length === 0) {
    console.warn('所有播放源测速都失败，使用第一个播放源');
    return sources[0];
  }

  // 找出所有有效速度的最大值，用于线性映射
  const validSpeeds = successfulResults
    .map((result) => {
      const speedStr = result.testResult.loadSpeed;
      if (speedStr === '未知' || speedStr === '测量中...') return 0;

      const match = speedStr.match(/^([\d.]+)\s*(KB\/s|MB\/s)$/);
      if (!match) return 0;

      const value = parseFloat(match[1]);
      const unit = match[2];
      return unit === 'MB/s' ? value * 1024 : value; // 统一转换为 KB/s
    })
    .filter((speed) => speed > 0);

  const maxSpeed = validSpeeds.length > 0 ? Math.max(...validSpeeds) : 1024; // 默认1MB/s作为基准

  // 找出所有有效延迟的最小值和最大值，用于线性映射
  const validPings = successfulResults
    .map((result) => result.testResult.pingTime)
    .filter((ping) => ping > 0);

  const minPing = validPings.length > 0 ? Math.min(...validPings) : 50;
  const maxPing = validPings.length > 0 ? Math.max(...validPings) : 1000;

  // 计算每个结果的评分
  const resultsWithScore = successfulResults.map((result) => ({
    ...result,
    score: calculateSourceScore(result.testResult, maxSpeed, minPing, maxPing),
  }));

  // 按综合评分排序，选择最佳播放源
  resultsWithScore.sort((a, b) => b.score - a.score);

  console.log('播放源评分排序结果:');
  resultsWithScore.forEach((result, index) => {
    console.log(
      `${index + 1}. ${
        result.source.source_name
      } - 评分: ${result.score.toFixed(2)} (${result.testResult.quality}, ${
        result.testResult.loadSpeed
      }, ${result.testResult.pingTime}ms)`
    );
  });

  return resultsWithScore[0].source;
}

// 计算播放源综合评分
export function calculateSourceScore(
  testResult: {
    quality: string;
    loadSpeed: string;
    pingTime: number;
  },
  maxSpeed: number,
  minPing: number,
  maxPing: number
): number {
  let score = 0;

  // 分辨率评分 (40% 权重)
  const qualityScore = (() => {
    switch (testResult.quality) {
      case '4K':
        return 100;
      case '2K':
        return 85;
      case '1080p':
        return 75;
      case '720p':
        return 60;
      case '480p':
        return 40;
      case 'SD':
        return 20;
      default:
        return 0;
    }
  })();
  score += qualityScore * 0.4;

  // 下载速度评分 (40% 权重) - 基于最大速度线性映射
  const speedScore = (() => {
    const speedStr = testResult.loadSpeed;
    if (speedStr === '未知' || speedStr === '测量中...') return 30;

    // 解析速度值
    const match = speedStr.match(/^([\d.]+)\s*(KB\/s|MB\/s)$/);
    if (!match) return 30;

    const value = parseFloat(match[1]);
    const unit = match[2];
    const speedKBps = unit === 'MB/s' ? value * 1024 : value;

    // 基于最大速度线性映射，最高100分
    const speedRatio = speedKBps / maxSpeed;
    return Math.min(100, Math.max(0, speedRatio * 100));
  })();
  score += speedScore * 0.4;

  // 网络延迟评分 (20% 权重) - 基于延迟范围线性映射
  const pingScore = (() => {
    const ping = testResult.pingTime;
    if (ping <= 0) return 0; // 无效延迟给默认分

    // 如果所有延迟都相同，给满分
    if (maxPing === minPing) return 100;

    // 线性映射：最低延迟=100分，最高延迟=0分
    const pingRatio = (maxPing - ping) / (maxPing - minPing);
    return Math.min(100, Math.max(0, pingRatio * 100));
  })();
  score += pingScore * 0.2;

  return Math.round(score * 100) / 100; // 保留两位小数
}
