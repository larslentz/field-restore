export interface LbprChannel {
  samplePeakDbfs: number;
  loudBlockRmsDbfs: number;
  differenceDb: number;
}

export interface LbprResult {
  valueDb: number;
  channels: LbprChannel[];
}

export function peakToLoudnessRatio(truePeakDbtp: number, integratedLufs: number): number {
  return Number.isFinite(truePeakDbtp) && Number.isFinite(integratedLufs)
    ? truePeakDbtp - integratedLufs
    : NaN;
}

/**
 * Each measured range starts its own non-overlapping three-second blocks.
 * The final partial block is included if it contains at least one frame.
 * Original samples, not K-weighted samples, supply the RMS and sample peaks.
 */
export function createLbprAccumulator(channelCount: number, sampleRate: number) {
  const blockSize = Math.max(1, Math.round(3 * sampleRate));
  const blockSquares = new Float64Array(channelCount);
  const samplePeaks = new Float64Array(channelCount);
  const blockLevels = Array.from({ length: channelCount }, () => [] as number[]);
  let blockFrames = 0;

  const finishBlock = () => {
    if (!blockFrames) return;
    for (let c = 0; c < channelCount; c += 1) {
      if (blockSquares[c] > 0) {
        // 10 log10(mean square) equals 20 log10(RMS).
        blockLevels[c].push(10 * Math.log10(blockSquares[c] / blockFrames));
      }
      blockSquares[c] = 0;
    }
    blockFrames = 0;
  };

  return {
    addSample(channel: number, sample: number) {
      blockSquares[channel] += sample * sample;
      samplePeaks[channel] = Math.max(samplePeaks[channel], Math.abs(sample));
    },
    finishFrame() {
      blockFrames += 1;
      if (blockFrames === blockSize) finishBlock();
    },
    result(): LbprResult {
      finishBlock();
      const channels = blockLevels.map((levels, c) => {
        levels.sort((a, b) => b - a);
        const selected = Math.ceil(levels.length * 0.2);
        const loudBlockRmsDbfs = selected
          ? levels.slice(0, selected).reduce((sum, value) => sum + value, 0) / selected
          : -Infinity;
        const samplePeakDbfs = samplePeaks[c] > 0 ? 20 * Math.log10(samplePeaks[c]) : -Infinity;
        return {
          samplePeakDbfs,
          loudBlockRmsDbfs,
          differenceDb: Number.isFinite(samplePeakDbfs) && Number.isFinite(loudBlockRmsDbfs)
            ? samplePeakDbfs - loudBlockRmsDbfs
            : NaN,
        };
      });
      return {
        valueDb: channels.length && channels.every((channel) => Number.isFinite(channel.differenceDb))
          ? channels.reduce((sum, channel) => sum + channel.differenceDb, 0) / channels.length
          : NaN,
        channels,
      };
    },
  };
}