import React from 'react';

function Formula({ children }: { children: React.ReactNode }) {
  return <div className="font-mono-value text-[11px] leading-relaxed bg-[hsl(var(--muted))] rounded p-3 whitespace-pre-wrap break-words">{children}</div>;
}

export function LbprMethodology() {
  return (
    <section className="panel" aria-labelledby="lbpr-method-heading" data-testid="lbpr-methodology">
      <div className="panel-header"><h2 id="lbpr-method-heading" className="section-title">How LBPR is calculated</h2></div>
      <div className="panel-body space-y-5 text-[12px] leading-relaxed">
        <p>
          Loud-Block Peak-to-RMS (LBPR) compares each channel’s highest sample peak with the average
          RMS level of its loudest 20% of non-silent three-second blocks, then averages the channel results.
          It is calculated independently for each measured range: the full Original recording, the Edited
          kept range, or a selection (intersected with the kept range for Edited).
        </p>
        <div>
          <h3 className="section-title mb-2">1. Define the samples and blocks</h3>
          <p className="mb-2">
            Let x_c[n] be the unweighted audio sample in channel c, with amplitude 1 representing digital
            full scale. N is the number of frames in the measured range, f_s is the sample rate in frames
            per second, and C is the number of channels. Frame indices start at zero within that range.
            Blocks do not overlap and restart at the range’s beginning.
          </p>
          <Formula>{'B = max(1, round(3 × f_s))\nJ = ceil(N / B)\nN_j = min(B, N − j × B),  j = 0, …, J − 1'}</Formula>
          <p className="mt-2 text-muted-foreground">
            B is the full block length in frames; J is the number of blocks; N_j is the actual length of
            block j. Include the final partial block whenever it has at least one frame.
          </p>
        </div>
        <div>
          <h3 className="section-title mb-2">2. Calculate each block’s RMS level</h3>
          <Formula>{'E_c,j = Σ[n = j×B to j×B + N_j − 1] x_c[n]²\nM_c,j = E_c,j / N_j\nR_c,j = √M_c,j\nL_c,j = 10 × log10(M_c,j) = 20 × log10(R_c,j)'}</Formula>
          <p className="mt-2">
            E is the sum of squared samples, M is mean square, R is RMS amplitude, and L is the block
            level in dBFS. Divide a partial block by its own frame count, not by B. Keep only blocks
            with E_c,j &gt; 0, independently for each channel. Only exact-zero blocks are excluded:
            there is no quiet-sound threshold, K-weighting, or loudness gate in LBPR.
          </p>
        </div>
        <div>
          <h3 className="section-title mb-2">3. Average the loudest 20% of blocks</h3>
          <p className="mb-2">
            Let m_c be the number of retained non-silent blocks in channel c. Sort their levels from
            highest to lowest, L_c,(1) ≥ L_c,(2) ≥ … ≥ L_c,(m_c).
          </p>
          <Formula>{'k_c = ceil(0.20 × m_c)\nA_c = (1 / k_c) × Σ[i = 1 to k_c] L_c,(i)'}</Formula>
          <p className="mt-2">
            A_c is the arithmetic average of the selected block levels in dBFS, not an average of their
            linear RMS amplitudes or powers. Every selected block has equal weight, including a partial
            block. Rounding the block count upward ensures at least one is selected when m_c &gt; 0.
            For example, six non-silent blocks select two.
          </p>
        </div>
        <div>
          <h3 className="section-title mb-2">4. Find the channel’s peak and difference</h3>
          <Formula>{'p_c = max[n = 0 to N − 1] |x_c[n]|\nP_c = 20 × log10(p_c)\nD_c = P_c − A_c'}</Formula>
          <p className="mt-2">
            P_c is the sample peak in dBFS across the entire measured range, not just the selected
            loud blocks. It uses actual samples, without true-peak interpolation. D_c is the
            channel’s LBPR result. Original uses the original samples; Edited uses the rendered
            samples after the edit chain.
          </p>
        </div>
        <div>
          <h3 className="section-title mb-2">5. Combine channels and display the result</h3>
          <Formula>{'LBPR = (1 / C) × Σ[c = 1 to C] D_c\nStereo LBPR = (D_Left + D_Right) / 2\nInteger readout = round(LBPR)'}</Formula>
          <p className="mt-2">
            Channels have equal weight; stereo channels are not mixed together before analysis.
            The combined result and individual channel results are displayed as numbers without a unit
            suffix, to two decimal places. The combined result also shows the nearest integer in
            parentheses. Averaging uses unrounded values.
          </p>
          <p className="mt-2 text-muted-foreground">
            Empty ranges and fully silent channels show N/A. Internally, a channel with no non-silent
            blocks has A_c = −∞, and a zero sample peak has P_c = −∞; their difference is unavailable.
            The combined LBPR is available only when every channel has a finite D_c. A valid channel
            can still show its individual result when another channel is silent.
          </p>
        </div>
        <div>
          <h3 className="section-title mb-2">PLR is a separate measurement</h3>
          <Formula>{'PLR = true peak (dBTP) − integrated loudness (LUFS)'}</Formula>
          <p className="mt-2">
            Peak-to-loudness ratio (PLR) uses the estimated true peak and integrated loudness for the
            same measured range and is displayed in LU. Unlike LBPR, it does not use the loud-block
            RMS average. It shows N/A if either input is unavailable.
          </p>
        </div>
      </div>
    </section>
  );
}