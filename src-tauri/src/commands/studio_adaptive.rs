//! Deterministic admission controller. No clocks, OS calls or subprocesses here.
//! The caller supplies monotonic seconds and comparable, interval throughput.
use std::collections::VecDeque;

#[derive(Clone, Copy, Debug)]
pub(super) struct Observation {
    pub now: u64,
    pub cpu: Option<f64>,
    pub monitoring_ready: bool,
    pub memory_pressure: bool,
    pub gpu_pressure: bool,
    pub active: usize,
    pub completions: u64,
    pub waiting: bool,
    /// None for mixed phases/settings, stale progress or untracked workers.
    pub rate: Option<(u64, f64)>,
}

#[derive(Debug)]
struct Trial {
    previous: usize,
    profile: u64,
    baseline: f64,
    deadline: u64,
    completions: u64,
}

#[derive(Debug)]
pub(super) struct Controller {
    base: usize,
    ceiling: usize,
    cpu_target: f64,
    pub target: usize,
    pub reason: &'static str,
    last_tick: Option<u64>,
    population: (usize, Option<u64>, u64),
    settle_until: u64,
    cooldown_until: u64,
    cpu: Option<f64>,
    rates: VecDeque<f64>,
    trial: Option<Trial>,
}

impl Controller {
    pub fn new(base: usize, ceiling: usize, max: bool) -> Self {
        let ceiling = ceiling.max(1);
        let base = base.clamp(1, ceiling);
        Self {
            base,
            ceiling,
            cpu_target: if max { 94. } else { 82. },
            target: base,
            reason: "Measuring workload before adjusting concurrency",
            last_tick: None,
            population: (0, None, 0),
            settle_until: 0,
            cooldown_until: 0,
            cpu: None,
            rates: VecDeque::new(),
            trial: None,
        }
    }

    fn back_off(&mut self, now: u64, reason: &'static str) {
        self.target = self
            .trial
            .take()
            .map(|t| t.previous)
            .unwrap_or_else(|| self.target.saturating_sub(1).max(1));
        self.rates.clear();
        self.cooldown_until = now + 30;
        self.reason = reason;
    }

    pub fn observe(&mut self, o: Observation) {
        // Every caller uses the same controller. More waiters must not make
        // smoothing, trial windows or backoff run more frequently.
        if self
            .last_tick
            .is_some_and(|last| o.now.saturating_sub(last) < 2)
        {
            return;
        }
        self.last_tick = Some(o.now);
        let cpu = o.cpu.filter(|v| v.is_finite() && (0. ..=100.).contains(v));
        if !o.monitoring_ready || cpu.is_none() {
            self.target = self.base;
            self.trial = None;
            self.rates.clear();
            self.cpu = None;
            self.settle_until = o.now + 8;
            self.reason = "Monitoring unavailable or warming up; using fixed safe limits";
            return;
        }
        let cpu = cpu.unwrap();
        self.cpu = Some(self.cpu.map_or(cpu, |old| old * 0.65 + cpu * 0.35));
        if o.memory_pressure || o.gpu_pressure {
            if o.now >= self.cooldown_until || self.trial.is_some() {
                self.back_off(
                    o.now,
                    if o.memory_pressure {
                        "Memory pressure: waiting for capacity; active steps finish normally"
                    } else {
                        "GPU pressure: holding new work; active steps finish normally"
                    },
                );
            }
            return;
        }
        if self.cpu.unwrap() > self.cpu_target + 3. && o.now >= self.cooldown_until {
            self.back_off(o.now, "CPU busy: reducing future concurrency");
            return;
        }
        let rate = o.rate.filter(|(_, v)| v.is_finite() && *v > 0.);
        let population = (o.active, rate.map(|(key, _)| key), o.completions);
        if population != self.population {
            self.population = population;
            self.rates.clear();
            self.settle_until = o.now + 8;
        }
        if let Some(trial) = &self.trial {
            let changed = rate.is_some_and(|(key, _)| key != trial.profile)
                || o.completions != trial.completions;
            if changed || o.now >= trial.deadline {
                self.back_off(
                    o.now,
                    "No comparable gain confirmed; restored previous concurrency",
                );
                return;
            }
        }
        if o.now < self.settle_until {
            self.reason = "Letting workers settle before comparing throughput";
            return;
        }
        if let Some((_, fps)) = rate {
            self.rates.push_back(fps);
            if self.rates.len() > 6 {
                self.rates.pop_front();
            }
        } else {
            self.rates.clear();
            self.reason = "Mixed phases or insufficient progress: holding concurrency";
            return;
        }
        if self.rates.len() < 6 {
            return;
        }
        let mean = self.rates.iter().sum::<f64>() / self.rates.len() as f64;
        // Do not compare a scene cut / startup burst with a stable baseline.
        let stable = self.rates.iter().all(|v| (v - mean).abs() <= mean * 0.20);
        if !stable {
            self.reason = "Throughput varies: collecting a stable comparison";
            return;
        }
        if let Some(trial) = &self.trial {
            if o.active != self.target {
                return;
            }
            if mean > trial.baseline * 1.05 {
                self.trial = None;
                self.rates.clear();
                self.cooldown_until = o.now + 20;
                self.reason = "Higher concurrency improved measured throughput";
            } else {
                self.back_off(
                    o.now,
                    "Extra worker did not improve throughput; backing off",
                );
            }
            return;
        }
        if o.now < self.cooldown_until {
            return;
        }
        if o.waiting
            && o.active == self.target
            && self.target < self.ceiling
            && self.cpu.unwrap() < self.cpu_target - 8.
        {
            self.trial = Some(Trial {
                previous: self.target,
                profile: rate.unwrap().0,
                baseline: mean,
                deadline: o.now + 50,
                completions: o.completions,
            });
            self.target += 1;
            self.rates.clear();
            self.settle_until = o.now + 8;
            self.reason = "Testing one extra worker against measured throughput";
        } else {
            self.reason = if !o.waiting {
                "No additional ready work"
            } else {
                "Holding concurrency within measured CPU and worker limits"
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample(now: u64, active: usize, fps: f64) -> Observation {
        Observation {
            now,
            cpu: Some(45.),
            monitoring_ready: true,
            memory_pressure: false,
            gpu_pressure: false,
            active,
            completions: 0,
            waiting: true,
            rate: Some((42, fps)),
        }
    }
    fn baseline(c: &mut Controller) {
        for t in (0..=18).step_by(2) {
            c.observe(sample(t, 3, 30.));
        }
    }
    #[test]
    fn sustained_headroom_trials_one_extra_worker_and_keeps_real_gain() {
        let mut c = Controller::new(3, 6, true);
        baseline(&mut c);
        assert_eq!(
            c.target, 4,
            "spare CPU with queued work must not stay at fixed three"
        );
        for t in (20..=38).step_by(2) {
            c.observe(sample(t, 4, 40.));
        }
        assert_eq!(c.target, 4);
        assert!(c.trial.is_none());
        assert!(c.reason.contains("improved"));
    }
    #[test]
    fn no_speedup_reverts_without_killing_workers() {
        let mut c = Controller::new(3, 6, true);
        baseline(&mut c);
        for t in (20..=38).step_by(2) {
            c.observe(sample(t, 4, 30.));
        }
        assert_eq!(c.target, 3);
        assert!(c.reason.contains("did not improve"));
    }
    #[test]
    fn missing_telemetry_never_means_idle() {
        let mut c = Controller::new(3, 6, true);
        baseline(&mut c);
        let mut o = sample(20, 4, 40.);
        o.cpu = None;
        c.observe(o);
        assert_eq!(c.target, 3);
        assert!(c.trial.is_none());
        assert!(c.reason.contains("fixed safe"));
    }
    #[test]
    fn pressure_backs_off_and_cannot_oscillate_per_waiter() {
        let mut c = Controller::new(3, 6, true);
        baseline(&mut c);
        for _ in 0..100 {
            let mut o = sample(20, 4, 40.);
            o.memory_pressure = true;
            c.observe(o);
        }
        assert_eq!(c.target, 3);
        for t in (22..=48).step_by(2) {
            c.observe(sample(t, 3, 30.));
        }
        assert_eq!(c.target, 3);
    }
    #[test]
    fn mixed_work_or_changed_profile_cannot_justify_gain() {
        let mut c = Controller::new(3, 6, true);
        baseline(&mut c);
        let mut o = sample(20, 4, 100.);
        o.rate = Some((99, 100.));
        c.observe(o);
        assert_eq!(c.target, 3);
        for t in (22..100).step_by(2) {
            o.now = t;
            o.rate = None;
            c.observe(o);
        }
        assert_eq!(c.target, 3);
    }
    #[test]
    fn waiting_for_admission_trial_times_out_and_small_machines_stay_bounded() {
        let mut c = Controller::new(3, 6, true);
        baseline(&mut c);
        c.observe(sample(70, 3, 30.));
        assert_eq!(c.target, 3);
        let mut single = Controller::new(3, 1, true);
        for t in (0..100).step_by(2) {
            single.observe(sample(t, 1, 30.));
        }
        assert_eq!(single.target, 1);
    }
    #[test]
    fn no_backlog_and_noisy_samples_do_not_ramp() {
        let mut c = Controller::new(3, 6, true);
        for t in (0..100).step_by(2) {
            let mut o = sample(t, 3, 30.);
            o.waiting = false;
            c.observe(o);
        }
        assert_eq!(c.target, 3);
        for t in (100..200).step_by(2) {
            c.observe(sample(t, 3, if t % 4 == 0 { 10. } else { 80. }));
        }
        assert_eq!(c.target, 3);
    }
    #[test]
    fn replacing_workers_with_easier_clips_is_not_a_concurrency_gain() {
        let mut c = Controller::new(3, 6, true);
        baseline(&mut c);
        let mut o = sample(20, 4, 90.);
        o.completions = 1;
        c.observe(o);
        assert_eq!(c.target, 3);
        assert!(c.trial.is_none());
    }
}
