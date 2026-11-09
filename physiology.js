function rate(gate, direction, voltage) {
  const prefix = `${gate}${direction}`;
  const form = $(`${prefix}Form`).value;
  if (form === "none") return 0;
  const c = value(`${prefix}C`), threshold = value(`${prefix}Th`), slope = value(`${prefix}S`);
  // evalrate.m applies Bard's squid-axon Q10 correction to every gate rate.
  // Its legacy zero-division guard evaluates the linear rate at th + .01 mV.
  const x = Math.abs(voltage - threshold) < 1e-12 ? .01 : voltage - threshold;
  const q10 = Math.pow(3, (value("temperature") - 6.3) / 10);
  if (form === "exp") return c * Math.exp(x * slope) * q10;
  if (form === "sigmoid") return c / (1 + Math.exp(x * slope)) * q10;
  const denominator = 1 - Math.exp(slope === 0 ? .0001 : x * slope);
  return c * x / denominator * q10;
}

function alphaM(v) { return rate("m", "Alpha", v); }
function betaM(v) { return rate("m", "Beta", v); }
function alphaH(v) { return rate("h", "Alpha", v); }
function betaH(v) { return rate("h", "Beta", v); }
function alphaN(v) { return rate("n", "Alpha", v); }
function betaN(v) { return rate("n", "Beta", v); }
function alphaP(v) { return rate("p", "Alpha", v); }
function betaP(v) { return rate("p", "Beta", v); }
function alphaQ(v) { return rate("q", "Alpha", v); }
function betaQ(v) { return rate("q", "Beta", v); }

function ionReversal(ion, e) { return e[ion] ?? e.na; }

function reversals() {
  // equilib.m constants, retaining millivolt output in the web port.
  const factor = 8.31451 * (value("temperature") + 273.16) / 96485.3 * 1000;
  const nernst = (out, inside, charge = 1) => factor / charge * Math.log(Math.max(out, .001) / Math.max(inside, .001));
  return { na: nernst(value("nao"), value("nai")), k: nernst(value("ko"), value("ki")), cl: nernst(value("clo"), value("cli"), -1) };
}

function equilibrium(e = reversals()) {
  const channels = [
    ["passiveNa", "gNaLeak", e.na], ["passiveK", "gKLeak", e.k], ["passiveCl", "gClLeak", e.cl]
  ].filter(([selected, conductance]) => $(selected).checked && value(conductance) > 0);
  const gTotal = channels.reduce((sum, [, g]) => sum + value(g), 0);
  return gTotal ? channels.reduce((sum, [, g, reversal]) => sum + value(g) * reversal, 0) / gTotal : NaN;
}

function updateMembrane() {
  const e = reversals();
  $("ena").textContent = `${fixed(e.na, 1)} mV`;
  $("ek").textContent = `${fixed(e.k, 1)} mV`;
  $("ecl").textContent = `${fixed(e.cl, 1)} mV`;
  const v = equilibrium(e);
  $("restingPotential").textContent = Number.isFinite(v) ? `${fixed(v, 1)} mV` : "— (no passive channels)";
}

function stimulusValue(which, time) {
  const amplitude = value(`s${which}amp`), start = value(`s${which}start`), duration = value(`s${which}dur`), repeat = value(`s${which}repeat`);
  const amplitude2 = value(`s${which}amp2`), duration2 = value(`s${which}dur2`);
  const elapsed = time - start;
  if (elapsed < 0) return 0;
  // A duration is an interval, not an extra integration sample.  This keeps
  // the editor trace and the applied HH stimulus aligned at its right edge.
  if (elapsed < duration) return amplitude;
  const secondStart = duration + repeat;
  // The right-side amplitude/duration controls always define the second
  // segment. With amplitude 0 it extends the flat baseline; otherwise it is
  // drawn as a second peak, matching HHsim's stimulus editor.
  return elapsed >= secondStart && elapsed < secondStart + duration2 ? amplitude2 : 0;
}

function stimulusPatternLength(which) {
  return value(`s${which}start`) + value(`s${which}dur`) + value(`s${which}repeat`) + value(`s${which}dur2`);
}

function stimulusPreviewPoints(which) {
  // Direct port of redisplay_stim.m. Constructing the polyline from each
  // segment (rather than a sampled approximation) makes every transition
  // land exactly at the sum of the preceding lag/duration/gap lengths.
  const lag = value(`s${which}start`);
  const amplitude1 = value(`s${which}amp`);
  const duration1 = value(`s${which}dur`);
  const gap = value(`s${which}repeat`);
  const amplitude2 = value(`s${which}amp2`);
  const duration2 = value(`s${which}dur2`);
  const points = lag > 0 ? [{ x: -.2, y: 0 }, { x: lag, y: 0 }] : [{ x: -.2, y: 0 }, { x: 0, y: 0 }];
  let end = lag;
  if (duration1 > 0) {
    points.push({ x: end, y: amplitude1 }, { x: end + duration1, y: amplitude1 });
    end += duration1;
  }
  if (gap > 0) {
    points.push({ x: end, y: 0 }, { x: end + gap, y: 0 });
    end += gap;
  }
  if (duration2 > 0) {
    points.push({ x: end, y: amplitude2 }, { x: end + duration2, y: amplitude2 });
    end += duration2;
  }
  points.push({ x: end, y: 0 }, { x: end + .7, y: 0 });
  return points;
}

function refreshStimulusReadouts() {
  document.querySelectorAll("[data-stim-value]").forEach((output) => {
    output.textContent = $(output.dataset.stimValue).value;
  });
  document.querySelectorAll("[data-stim-slider]").forEach((slider) => {
    slider.value = $(slider.dataset.stimSlider).value;
    syncVerticalStimulusSlider(slider);
  });
}

function syncVerticalStimulusSlider(slider) {
  const track = slider.closest(".vertical-range-wrap");
  if (!track) return;
  const minimum = Number(slider.min);
  const maximum = Number(slider.max);
  const fraction = maximum === minimum ? .5 : Math.min(1, Math.max(0, (Number(slider.value) - minimum) / (maximum - minimum)));
  // A larger value belongs nearer the upward arrow.  Keep the overlay thumb
  // aligned with whichever compact MATLAB-style track is currently rendered.
  const trackHeight = track.clientHeight || 68;
  const thumbHeight = trackHeight <= 52 ? 8 : 10;
  track.style.setProperty("--stim-thumb-top", `${(1 - fraction) * (trackHeight - thumbHeight)}px`);
}

function refreshStimulusCharts() {
  stimulusCharts.forEach((chart, index) => {
    const id = index + 1;
    const points = stimulusPreviewPoints(id);
    const timeStops = [0, 10.9, 20.9, 25.9, 50.9, 100.9, 110.9, 120.9, 130.9, 140.9, 150.9, 160.9, 170.9, 180.9, 190.9, 200.9, 210.9, 220.9, 230.9];
    const previewEnd = timeStops.find((stop) => stop >= points.at(-1).x) ?? timeStops.at(-1);
    const magnitude = Math.max(10, ...points.map((point) => Math.abs(point.y)));
    // redisplay_stim.m rounds the magnitude first, then gives the trace 20%
    // headroom.  Rounding after the expansion made this JS plot too tall.
    const axisLimit = Math.round(magnitude * 1.2);
    const labeledMagnitude = Math.round(magnitude);
    chart.data.datasets = [
      { data: [{ x: -1, y: 0 }, { x: 500, y: 0 }], borderColor: "rgba(178,178,178,.7)", borderWidth: 1.5, borderDash: [1, 3], borderCapStyle: "round", pointRadius: 0 },
      { data: points, borderColor: "#7678d6", borderWidth: 2, pointRadius: 0 }
    ];
    chart.options.scales.x.min = -.2;
    chart.options.scales.x.max = previewEnd;
    // redisplay_stim.m uses a 10.9 ms (and then 20.9 ms, …) right edge to
    // leave breathing room after a pulse.  MATLAB's automatic ticks remain
    // the whole-millisecond marks, however; never expose the padding value
    // itself as a misleading "10.9" tick in the editor.
    chart.options.scales.x.afterBuildTicks = (axis) => {
      axis.ticks = Array.from({ length: Math.floor(previewEnd) + 1 }, (_, value) => ({ value }));
    };
    chart.options.scales.y.min = -axisLimit;
    chart.options.scales.y.max = axisLimit;
    chart.options.scales.y.afterBuildTicks = (axis) => { axis.ticks = [-labeledMagnitude, 0, labeledMagnitude].map((value) => ({ value })); };
    chart.update("none");
  });
  refreshStimulusReadouts();
}

const pulseControlDefinitions = [
  ["start", "Peak start", 0, 0, 50],
  ["amp", "First-peak amplitude", 10, -100, 100],
  ["dur", "First-peak duration", 1, 0, 50],
  ["repeat", "Flat-region duration", 1, 0, 50],
  ["amp2", "Second-peak amplitude", 0, -100, 100],
  ["dur2", "Second-peak duration", 1, 0, 50]
];

function buildPulseControls(which) {
  const controls = $("stimControls" + which);
  controls.innerHTML = pulseControlDefinitions.map(([key, label, initial, min, max]) => {
    const id = `s${which}${key}`;
    const current = which === 2 && key === "amp" ? -10 : which === 2 && key === "dur" ? 2 : initial;
    const input = `<input class="stimulus-input" id="${id}" type="hidden" value="${current}" min="${min}" max="${max}">`;
    const output = `<output data-stim-value="${id}">${current}</output>`;
    const slider = `<input class="stim-scroll-range" data-stim-slider="${id}" type="range" value="${current}" min="${min}" max="${max}" step="1" aria-label="${label}">`;
    return key === "amp" || key === "amp2"
      ? `<div class="click-control vertical-click" aria-label="${label}"><button type="button" data-stim-adjust="${id}" data-step="1">▲</button><div class="vertical-range-wrap">${slider}</div>${output}${input}<button type="button" data-stim-adjust="${id}" data-step="-1">▼</button></div>`
      : `<div class="click-control" aria-label="${label}">${output}${input}<div class="click-scroll"><button type="button" data-stim-adjust="${id}" data-step="-1">◀</button>${slider}<button type="button" data-stim-adjust="${id}" data-step="1">▶</button></div></div>`;
  }).join("");
  controls.querySelectorAll("[data-stim-slider]").forEach(syncVerticalStimulusSlider);
}

function changeStimulusControl(button) {
  const input = $(button.dataset.stimAdjust);
  const next = Math.min(Number(input.max), Math.max(Number(input.min), Number(input.value) + Number(button.dataset.step)));
  input.value = String(next);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

