/*
 * Reproducible core-solver benchmark for the default HHsim configuration.
 * It measures numerical integration only; browser chart drawing and animation
 * are intentionally excluded. Run with: node benchmark_hhsim_solver.js
 */
const { performance } = require("node:perf_hooks");

const rate = (form, c, threshold, slope, voltage) => {
  const x = Math.abs(voltage - threshold) < 1e-12 ? .01 : voltage - threshold;
  if (form === "exp") return c * Math.exp(x * slope);
  if (form === "sigmoid") return c / (1 + Math.exp(x * slope));
  return c * x / (1 - Math.exp((slope === 0 ? .0001 : x) * slope));
};
const alphaM = (v) => rate("linear", .1, -40, -.1, v);
const betaM = (v) => rate("exp", 4, -65, -1 / 18, v);
const alphaH = (v) => rate("exp", .07, -65, -.05, v);
const betaH = (v) => rate("sigmoid", 1, -35, -.1, v);
const alphaN = (v) => rate("linear", .01, -55, -.1, v);
const betaN = (v) => rate("exp", .125, -65, -1 / 80, v);

const factor = 8.31451 * (6.3 + 273.16) / 96485.3 * 1000;
const reversals = {
  na: factor * Math.log(440 / 50),
  k: factor * Math.log(20 / 400),
  cl: -factor * Math.log(560 / 52)
};
const clamp = (number) => Math.min(1, Math.max(0, number));

function simulate(duration = 60, { stimulus = false, ttx = 0 } = {}) {
  let v = -63.39, m = .068775, h = .515186, n = .35286656;
  let time = 0, dt = .1, steps = 0;
  const timer = stimulus ? [
    { current: 0, remaining: 0 }, { current: 10, remaining: 1 },
    { current: 0, remaining: 1 }, { current: 0, remaining: 1 },
    { current: 0, remaining: Infinity }
  ] : null;

  while (time < duration - 1e-9) {
    let step = Math.min(dt, duration - time);
    for (;;) {
      const injected = timer?.[0]?.current ?? 0;
      const advance = (gateState) => ({
        m: clamp(gateState.m + step * (alphaM(v) * (1 - gateState.m) - betaM(v) * gateState.m)),
        h: clamp(gateState.h + step * (alphaH(v) * (1 - gateState.h) - betaH(v) * gateState.h)),
        n: clamp(gateState.n + step * (alphaN(v) * (1 - gateState.n) - betaN(v) * gateState.n))
      });
      const dV = (gateState) => {
        const passive = .0265 * (v - reversals.na) + .07 * (v - reversals.k) + .1 * (v - reversals.cl);
        const sodium = 120 * gateState.m ** 3 * gateState.h * (1 - ttx / 100) * (v - reversals.na);
        const potassium = 36 * gateState.n ** 4 * (v - reversals.k);
        return injected - passive - sodium - potassium;
      };
      const predictor = advance({ m, h, n });
      const predictorDV = step * dV(predictor);
      const correctedProbe = advance(predictor);
      const correctedDV = (predictorDV + step * dV(correctedProbe)) / 2;
      const voltageError = Math.abs(predictorDV - correctedDV) / step;
      const gateError = Math.abs(predictor.n - (predictor.n + correctedProbe.n) / 2);
      if ((voltageError > 30 || gateError > .01) && step > 1e-8) {
        step /= 2;
        continue;
      }
      v += correctedDV;
      m = (predictor.m + correctedProbe.m) / 2;
      h = (predictor.h + correctedProbe.h) / 2;
      n = (predictor.n + correctedProbe.n) / 2;
      time += step;
      steps += 1;
      dt = voltageError < 10 && gateError < .003 ? Math.min(.1, step * 2) : step;
      if (timer) {
        timer[0].remaining -= step;
        if (timer[0].remaining <= 0 && timer.length > 1) timer.shift();
      }
      break;
    }
  }
  return { steps, voltage: v };
}

const cases = [
  ["rest", {}],
  ["Stim1", { stimulus: true }],
  ["50% TTX", { ttx: 50 }]
];
for (const [, settings] of cases) for (let i = 0; i < 250; i += 1) simulate(60, settings);
for (const [name, settings] of cases) {
  const samples = [];
  let result;
  for (let i = 0; i < 2000; i += 1) {
    const start = performance.now();
    result = simulate(60, settings);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.floor(samples.length * .95)];
  console.log(`${name}: median ${median.toFixed(3)} ms; p95 ${p95.toFixed(3)} ms; ${(60 / median).toFixed(0)}x real-time; ${result.steps} accepted steps`);
}
