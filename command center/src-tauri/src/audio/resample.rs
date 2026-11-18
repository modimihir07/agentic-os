//! Streaming mono resampler: 4th-order Butterworth low-pass (when downsampling) + linear
//! interpolation.
//!
//! Allocation-free and O(1) per sample, so it can run inside the cpal input callback. Good
//! enough for VAD and speech STT input; swap for a windowed-sinc resampler (e.g. `rubato`) if
//! STT accuracy measurably suffers.

/// RBJ low-pass biquad, transposed direct form II.
#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn lowpass(fs: f64, fc: f64, q: f64) -> Self {
        let w0 = 2.0 * std::f64::consts::PI * fc / fs;
        let (sin, cos) = w0.sin_cos();
        let alpha = sin / (2.0 * q);
        let a0 = 1.0 + alpha;
        let b1 = (1.0 - cos) / a0;
        Self {
            b0: (b1 / 2.0) as f32,
            b1: b1 as f32,
            b2: (b1 / 2.0) as f32,
            a1: (-2.0 * cos / a0) as f32,
            a2: ((1.0 - alpha) / a0) as f32,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[inline]
    fn run(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

pub struct Resampler {
    /// Input samples advanced per output sample (in_rate / out_rate).
    step: f64,
    /// Next output position, in input samples, relative to `prev`.
    t: f64,
    prev: f32,
    primed: bool,
    /// Anti-alias cascade; None when not downsampling.
    lowpass: Option<[Biquad; 2]>,
}

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        let (in_rate, out_rate) = (in_rate.max(1) as f64, out_rate.max(1) as f64);
        let step = in_rate / out_rate;
        // Downsampling: Butterworth (Q 0.541 + 1.307) at 0.45 × the output rate, ~-24 dB/octave.
        let lowpass = (step > 1.0).then(|| {
            let fc = 0.45 * out_rate;
            [Biquad::lowpass(in_rate, fc, 0.541_196), Biquad::lowpass(in_rate, fc, 1.306_563)]
        });
        Self { step, t: 0.0, prev: 0.0, primed: false, lowpass }
    }

    /// Feed input samples; `emit` is called once per output sample.
    #[inline]
    pub fn process(&mut self, input: &[f32], mut emit: impl FnMut(f32)) {
        for &raw in input {
            let x = match &mut self.lowpass {
                Some([a, b]) => b.run(a.run(raw)),
                None => raw,
            };
            if !self.primed {
                self.prev = x;
                self.primed = true;
                continue;
            }
            while self.t < 1.0 {
                emit(self.prev + (x - self.prev) * self.t as f32);
                self.t += self.step;
            }
            self.t -= 1.0;
            self.prev = x;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(in_rate: u32, out_rate: u32, n: usize) -> Vec<f32> {
        let mut r = Resampler::new(in_rate, out_rate);
        let input: Vec<f32> = (0..n).map(|i| (i as f32 * 0.001).sin()).collect();
        let mut out = Vec::new();
        r.process(&input, |s| out.push(s));
        out
    }

    #[test]
    fn output_length_tracks_rate_ratio() {
        for (a, b) in [(48_000, 16_000), (44_100, 16_000), (24_000, 48_000), (16_000, 16_000)] {
            let n = a as usize; // one second
            let got = run(a, b, n).len() as i64;
            assert!((got - b as i64).abs() <= 2, "{a}->{b}: {got}");
        }
    }

    #[test]
    fn passthrough_preserves_samples_after_priming() {
        let mut r = Resampler::new(16_000, 16_000);
        let mut out = Vec::new();
        r.process(&[0.1, 0.2, 0.3, 0.4], |s| out.push(s));
        assert_eq!(out, vec![0.1, 0.2, 0.3]); // one-sample latency
    }

    #[test]
    fn decimation_rejects_content_above_new_nyquist() {
        let rms = |v: &[f32]| (v.iter().map(|s| s * s).sum::<f32>() / v.len() as f32).sqrt();
        let pass = run_tone(48_000, 16_000, 1_000.0);
        let stop = run_tone(48_000, 16_000, 12_000.0); // would alias to 4 kHz
        assert!(rms(&pass) > 0.6, "1 kHz passes: {}", rms(&pass));
        assert!(rms(&stop) < 0.08, "12 kHz attenuated: {}", rms(&stop));
    }

    fn run_tone(in_rate: u32, out_rate: u32, hz: f32) -> Vec<f32> {
        let input: Vec<f32> = (0..in_rate as usize).map(|i| (2.0 * std::f32::consts::PI * hz * i as f32 / in_rate as f32).sin()).collect();
        let mut out = Vec::new();
        Resampler::new(in_rate, out_rate).process(&input, |s| out.push(s));
        out.split_off(out.len() / 4) // skip filter settling
    }

    #[test]
    fn chunked_input_matches_single_call() {
        let input: Vec<f32> = (0..4_800).map(|i| (i as f32 * 0.01).sin()).collect();
        let mut whole = Vec::new();
        Resampler::new(48_000, 16_000).process(&input, |s| whole.push(s));
        let mut parts = Vec::new();
        let mut r = Resampler::new(48_000, 16_000);
        for chunk in input.chunks(441) {
            r.process(chunk, |s| parts.push(s));
        }
        assert_eq!(whole, parts);
    }
}
