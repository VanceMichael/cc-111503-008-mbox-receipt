// 授权字节区间账本。
// 所有区间均为含端点的闭区间 [start, end]，单位是整个交接包内的字节偏移。
// 账本只信任通过授权覆盖、包大小、ETag 与重叠一致性校验的部分。

export function mergeIntervals(intervals) {
  const sorted = intervals
    .map(([start, end]) => [start, end])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const [start, end] of sorted) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

// 判断 [start, end] 是否完全落在已合并区间集合内（区间外空隙返回 false）。
export function isWithin(intervals, start, end) {
  let cursor = start;
  for (const [lo, hi] of intervals) {
    if (lo > cursor) return false;
    if (hi >= cursor) {
      cursor = hi + 1;
      if (cursor > end) return true;
    }
  }
  return cursor > end;
}

// 计算 covered（已合并区间）在 [start, end] 内尚未覆盖的缺口。
export function missingIntervals(covered, start, end) {
  const gaps = [];
  let cursor = start;
  for (const [lo, hi] of covered) {
    if (hi < cursor) continue;
    if (lo > end) break;
    if (lo > cursor) gaps.push([cursor, Math.min(lo - 1, end)]);
    if (hi >= end) {
      cursor = end + 1;
      break;
    }
    cursor = hi + 1;
  }
  if (cursor <= end) gaps.push([cursor, end]);
  return gaps;
}

export class CoverageLedger {
  constructor(authorizedIntervals) {
    this.authorized = mergeIntervals(authorizedIntervals);
    this.parts = [];
    this.coverage = [];
  }

  covers(start, end) {
    return isWithin(this.coverage, start, end);
  }

  // 登记一个服务端声明的实际字节部分。任何校验失败都抛出带 code 的错误，
  // 调用方负责记录诊断并且不得接纳该部分。
  add(start, end, data) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      throw Object.assign(new Error('part declares an invalid byte range'), { code: 'invalid-range' });
    }
    if (data.length !== end - start + 1) {
      throw Object.assign(new Error('part body length does not match its declared range'), { code: 'length-mismatch' });
    }
    if (!isWithin(this.authorized, start, end)) {
      throw Object.assign(new Error('part extends beyond the authorized index'), { code: 'outside-authorization' });
    }
    for (const part of this.parts) {
      const lo = Math.max(start, part.start);
      const hi = Math.min(end, part.end);
      if (lo <= hi) {
        const incoming = data.subarray(lo - start, hi - start + 1);
        const existing = part.data.subarray(lo - part.start, hi - part.start + 1);
        if (!incoming.equals(existing)) {
          throw Object.assign(new Error('overlapping parts carry inconsistent bytes'), { code: 'overlap-conflict' });
        }
      }
    }
    this.parts.push({ start, end, data: Buffer.from(data) });
    this.coverage = mergeIntervals(this.parts.map(part => [part.start, part.end]));
  }

  // 重组一个已被可信覆盖完全闭合的区间；调用前应先用 missingIntervals 确认无缺口。
  slice(start, end) {
    const output = Buffer.alloc(end - start + 1);
    for (const part of this.parts) {
      if (part.end < start || part.start > end) continue;
      const from = Math.max(start, part.start);
      const to = Math.min(end, part.end);
      part.data.copy(output, from - start, from - part.start, to - part.start + 1);
    }
    return output;
  }
}
