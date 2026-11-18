//! VAD seam. The engine drives any [`Vad`] with 16 kHz mono hops of [`CAPTURE_HOP`](super::ring::CAPTURE_HOP) samples.
//!
//! [`EnergyVad`] is a placeholder: RMS against an adaptive noise floor, with onset debounce and a
//! hangover for endpointing. TEN VAD (16 kHz, 160/256-sample hops) replaces it by implementing
//! the same trait over its C API / ONNX model; nothing else in the engine changes.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VadEvent {
    Silence,
    /// First hop of confirmed speech: the barge-in trigger point.
    SpeechOnset,
    Speech,
    /// Speech ended after the hangover elapsed: the endpoint for STT.
    SpeechEnd,
}

/// Fed one [`CAPTURE_HOP`](super::ring::CAPTURE_HOP)-sample hop of 16 kHz mono per call; a fresh instance per engine start.
pub trait Vad: Send {
    fn process(&mut self, hop: &[f32]) -> VadEvent;
    /// Level of the last hop in dBFS, for status/metering.
    fn last_level_db(&self) -> f32;
}

#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EnergyVadConfig {
    /// Absolute floor: hops quieter than this are never speech.
    pub min_speech_db: f32,
    /// How far above the tracked noise floor a hop must be to count as speech.
    pub margin_db: f32,
    /// Consecutive speech hops before onset (debounce clicks). 3 × 10 ms = 30 ms.
    pub onset_hops: u32,
    /// Consecutive non-speech hops before end. 12 × 10 ms = 120 ms endpointing (handoff target
    /// is sub-150 ms; raise to 30–50 if natural pauses split sentences).
    pub hangover_hops: u32,
    /// Longest speech run before a forced end + noise re-baseline (3000 × 10 ms = 30 s). Stops
    /// loud steady noise (fan, music) from pinning the VAD in speech forever.
    pub max_speech_hops: u32,
}

impl Default for EnergyVadConfig {
    fn default() -> Self {
        Self { min_speech_db: -45.0, margin_db: 12.0, onset_hops: 3, hangover_hops: 12, max_speech_hops: 3_000 }
    }
}

impl EnergyVadConfig {
    /// Clamp values from the webview to sane ranges.
    pub fn sanitized(self) -> Self {
        Self {
            min_speech_db: self.min_speech_db.clamp(-90.0, -10.0),
            margin_db: self.margin_db.clamp(0.0, 40.0),
            onset_hops: self.onset_hops.clamp(1, 50),
            hangover_hops: self.hangover_hops.clamp(1, 200),
            max_speech_hops: self.max_speech_hops.clamp(100, 6_000),
        }
    }
}

pub struct EnergyVad {
    cfg: EnergyVadConfig,
    noise_db: f32,
    level_db: f32,
    speech_run: u32,
    quiet_run: u32,
    in_speech: bool,
    speech_len: u32,
}

impl EnergyVad {
    pub fn new(cfg: EnergyVadConfig) -> Self {
        Self { cfg: cfg.sanitized(), noise_db: -60.0, level_db: -100.0, speech_run: 0, quiet_run: 0, in_speech: false, speech_len: 0 }
    }
}

fn rms_db(hop: &[f32]) -> f32 {
    if hop.is_empty() {
        return -100.0;
    }
    let mean_sq = hop.iter().map(|s| s * s).sum::<f32>() / hop.len() as f32;
    (10.0 * mean_sq.max(1e-10).log10()).max(-100.0)
}

impl Vad for EnergyVad {
    fn process(&mut self, hop: &[f32]) -> VadEvent {
        let db = rms_db(hop);
        self.level_db = db;
        let threshold = self.cfg.min_speech_db.max(self.noise_db + self.cfg.margin_db);
        let loud = db >= threshold;

        if !self.in_speech && !loud {
            // Track the floor only outside speech; fall fast, rise slowly.
            let rate = if db < self.noise_db { 0.2 } else { 0.01 };
            self.noise_db += rate * (db - self.noise_db);
        }

        if self.in_speech {
            self.speech_len += 1;
            if self.speech_len >= self.cfg.max_speech_hops {
                // Too long to be one utterance: treat the current level as the new floor.
                self.noise_db = db - self.cfg.margin_db + 1.0;
                self.in_speech = false;
                self.speech_run = 0;
                self.quiet_run = 0;
                return VadEvent::SpeechEnd;
            }
            if loud {
                self.quiet_run = 0;
                VadEvent::Speech
            } else {
                self.quiet_run += 1;
                if self.quiet_run >= self.cfg.hangover_hops {
                    self.in_speech = false;
                    self.speech_run = 0;
                    self.quiet_run = 0;
                    VadEvent::SpeechEnd
                } else {
                    VadEvent::Speech
                }
            }
        } else if loud {
            self.speech_run += 1;
            if self.speech_run >= self.cfg.onset_hops {
                self.in_speech = true;
                self.quiet_run = 0;
                self.speech_len = 0;
                VadEvent::SpeechOnset
            } else {
                VadEvent::Silence
            }
        } else {
            self.speech_run = 0;
            VadEvent::Silence
        }
    }

    fn last_level_db(&self) -> f32 {
        self.level_db
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::ring::CAPTURE_HOP;

    fn tone(amp: f32) -> Vec<f32> {
        (0..CAPTURE_HOP).map(|i| amp * (i as f32 * 0.2).sin()).collect()
    }

    fn feed(vad: &mut EnergyVad, hop: &[f32], n: usize) -> Vec<VadEvent> {
        (0..n).map(|_| vad.process(hop)).collect()
    }

    #[test]
    fn onset_after_debounce_then_end_after_hangover() {
        let mut vad = EnergyVad::new(EnergyVadConfig::default());
        let quiet = tone(0.0005); // ~ -69 dBFS
        let loud = tone(0.3); // ~ -13 dBFS
        assert!(feed(&mut vad, &quiet, 50).iter().all(|e| *e == VadEvent::Silence));
        let ev = feed(&mut vad, &loud, 4);
        assert_eq!(ev, vec![VadEvent::Silence, VadEvent::Silence, VadEvent::SpeechOnset, VadEvent::Speech]);
        let ev = feed(&mut vad, &quiet, 12);
        assert_eq!(ev[..11], [VadEvent::Speech; 11]);
        assert_eq!(ev[11], VadEvent::SpeechEnd);
    }

    #[test]
    fn single_click_does_not_trigger_onset() {
        let mut vad = EnergyVad::new(EnergyVadConfig::default());
        let quiet = tone(0.0005);
        feed(&mut vad, &quiet, 20);
        assert_eq!(vad.process(&tone(0.5)), VadEvent::Silence);
        assert!(feed(&mut vad, &quiet, 10).iter().all(|e| *e == VadEvent::Silence));
    }

    #[test]
    fn noise_floor_follows_steady_hum() {
        let mut vad = EnergyVad::new(EnergyVadConfig { min_speech_db: -70.0, ..Default::default() });
        let hum = tone(0.003); // ~ -53 dBFS, under the initial floor + margin
        assert!(feed(&mut vad, &hum, 600).iter().all(|e| *e == VadEvent::Silence));
        assert!(vad.noise_db > -54.0 && vad.noise_db < -52.0, "floor converged near the hum: {}", vad.noise_db);
    }

    #[test]
    fn sanitize_clamps_webview_values() {
        let c = EnergyVadConfig { min_speech_db: 5.0, margin_db: -3.0, onset_hops: 0, hangover_hops: 10_000, max_speech_hops: 1 }.sanitized();
        assert_eq!((c.min_speech_db, c.margin_db, c.onset_hops, c.hangover_hops, c.max_speech_hops), (-10.0, 0.0, 1, 200, 100));
    }

    #[test]
    fn loud_steady_noise_is_forced_out_of_speech_and_rebaselined() {
        let mut vad = EnergyVad::new(EnergyVadConfig { max_speech_hops: 100, ..Default::default() });
        let fan = tone(0.05); // ~ -29 dBFS, well above the default threshold
        let ev = feed(&mut vad, &fan, 300);
        assert_eq!(ev.iter().filter(|e| **e == VadEvent::SpeechOnset).count(), 1);
        assert_eq!(ev.iter().filter(|e| **e == VadEvent::SpeechEnd).count(), 1);
        assert!(ev[110..].iter().all(|e| *e == VadEvent::Silence), "fan is now the floor");
        // Real speech over the fan still registers.
        assert!(feed(&mut vad, &tone(0.5), 5).contains(&VadEvent::SpeechOnset));
    }
}
