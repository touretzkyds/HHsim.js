/* HHsim membrane + editable Hodgkin-Huxley fast Na and delayed K channels. */
const $ = (id) => document.getElementById(id);
const value = (id) => {
  const control = $(id);
  // setup_channels.m supplies -1/18 for the fast-sodium m beta slope.  The
  // MATLAB value box rounds its visible default to -0.0556; retain that UI
  // text but feed the solver the original full-precision constant until the
  // user explicitly edits the field.
  if (id === "mBetaS" && control.value === control.defaultValue) return -1 / 18;
  return Number(control.value);
};
const fixed = (v, n = 2) => Number(v).toFixed(n);

const state = {
  stimulus: null,
  stimulusStart: 0,
  // MATLAB first integrates to the resting state.  A stimulus begins at that
  // actual endpoint rather than after a synthetic fixed delay.
  stimulusLeadIn: 0,
  stimulusTimerLead: 0,
  stimulusTimer: null,
  time: 0,
  voltage: -65,
  m: 0,
  h: 0,
  n: 0,
  p: 0,
  q: 0,
  history: [],
  animation: null,
  completionTimer: null,
  continuationTimer: null,
  drugUpdateTimer: null,
  runId: 0,
  running: false,
  continuousRun: false,
  continuousDrugRun: false,
  stimulusSettling: false,
  nudgeSettling: false,
  nudgeTargetTime: 0,
  adaptiveStep: .1,
  stimulusRunLock: { which: null, time: -Infinity },
  userCopySource: "none",
  applyingUserCopy: false,
  applyingDrugReset: false,
  // MATLAB displays a rounded percent in the drug box after a curve click,
  // but retains the unrounded curve value for gmult and the cyan cursor.
  drugInhibition: { ttx: 0, tea: 0 },
  duration: 60,
  viewSpan: 60,
  viewEnd: 60,
  mode: "cursor",
  skipZoomClick: false,
  zoomConstraint: "unconstrained",
  zoomMenuTime: 0,
  voltageY: { min: -100, max: 60 },
  signalY: { min: 0, max: 1 },
  // Pan deliberately translates the traces while the physical axis labels
  // remain fixed, as requested for the recording view.
  plotOffset: { voltage: 0, signal: 0 },
  recordingMode: "voltage",
  vcSelected: 2,
  vcCurves: [],
  vcCursor: null,
  cursor: null,
  savedCursorState: null,
  baselineRecallState: null,
  // Solver-only timings; chart animation and browser scheduling are excluded
  // so repeated simulations can be compared across interaction types.
  solverMetrics: { samples: [], simulatedMs: 0 }
};

function recordSolverTiming(wallMs, simulatedMs) {
  const metrics = state.solverMetrics;
  metrics.samples.push({ wallMs, simulatedMs });
  if (metrics.samples.length > 100) metrics.samples.shift();
  metrics.simulatedMs += simulatedMs;
}

// Accessible from browser developer tools as HHsimPerformance(). This is a
// lightweight, reproducible performance record rather than an inferred UI
// animation time.
globalThis.HHsimPerformance = () => {
  const samples = state.solverMetrics.samples.map((sample) => sample.wallMs).sort((a, b) => a - b);
  if (!samples.length) return { runs: 0 };
  const median = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * .95))];
  const simulated = state.solverMetrics.samples.reduce((sum, sample) => sum + sample.simulatedMs, 0);
  const wall = state.solverMetrics.samples.reduce((sum, sample) => sum + sample.wallMs, 0);
  return {
    runs: samples.length,
    medianSolverMs: Number(median.toFixed(3)),
    p95SolverMs: Number(p95.toFixed(3)),
    realTimeMultiple: Number((simulated / wall).toFixed(1))
  };
};

const lineColors = ["#e7e800", "#12d61d", "#00b8ff"];

// Match the original HHsim rate panes: only the graphing rectangle is yellow.
// Chart.js keeps the title, axis labels, and tick labels outside that rectangle.
const ratePlotBackground = {
  id: "ratePlotBackground",
  beforeDraw(chart, _args, options) {
    if (!options?.color || !chart.chartArea) return;
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.fillStyle = options.color;
    ctx.fillRect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
    ctx.restore();
  }
};
const cursorMarker = {
  id: "cursorMarker",
  afterDatasetsDraw(chart) {
    const clampCursor = state.recordingMode === "clamp";
    const cursor = clampCursor ? state.vcCursor : state.cursor;
    if (!cursor || cursor.chart !== chart || !chart.chartArea) return;
    const data = chart.data.datasets[cursor.datasetIndex]?.data;
    const point = clampCursor ? data?.[cursor.index] : state.history[cursor.index];
    if (!data?.length || !point) return;
    const sample = clampCursor
      ? point
      : data.reduce((closest, candidate) =>
        !closest || Math.abs(candidate.x - point.time) < Math.abs(closest.x - point.time) ? candidate : closest, null);
    if (!sample || !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) return;
    const x = chart.scales.x.getPixelForValue(sample.x);
    const y = chart.scales.y.getPixelForValue(sample.y);
    const { ctx, chartArea } = chart;
    const rx = Math.max(4, (chartArea.right - chartArea.left) * .005);
    const ry = Math.max(8, (chartArea.bottom - chartArea.top) * (chart === signalChart ? .06 : .03));
    ctx.save();
    ctx.fillStyle = cursor.color;
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
};
// MATLAB creates boxed axes for each dose-response graph.  Chart.js draws
// individual scale borders, but the explicit frame preserves the complete
// top/right edge when gridlines are disabled.
const dosePlotFrame = {
  id: "dosePlotFrame",
  afterDraw(chart, _args, options) {
    if (!options || !chart.chartArea) return;
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.strokeStyle = options.color || "#eeeeee";
    ctx.lineWidth = options.width || 1;
    ctx.strokeRect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top);
    ctx.restore();
  }
};
Chart.register(ratePlotBackground, cursorMarker, dosePlotFrame);

// Chart.js normally adds the exact min/max as ticks. During Pan those can be
// arbitrary view edges (for example -4 or 56), unlike HHsim's clean major
// time marks. Keep its geometry intact, but label only major time marks so an
// edge value never masquerades as a real scale division.
function timeTickStep(span = state.viewSpan) {
  if (span >= 40) return 10;
  if (span >= 20) return 5;
  if (span >= 10) return 2;
  if (span >= 5) return 1;
  if (span >= 2) return .5;
  return .25;
}

function cleanTimeLabel(rawValue) {
  const time = Number(rawValue);
  const step = timeTickStep();
  if (!Number.isFinite(time) || Math.abs(time / step - Math.round(time / step)) > 1e-8) return "";
  const rounded = Math.round(time * 100) / 100;
  return String(rounded);
}

function xScale(maximum = 60) {
  return {
    type: "linear", min: 0, max: maximum,
    grid: { color: "rgba(220,225,235,.2)" }, ticks: { color: "#eee", callback: cleanTimeLabel },
    title: { display: true, text: "Time (msec)", color: "#eee" }
  };
}

function lineChart(canvas, yOptions) {
  return new Chart($(canvas), {
    type: "line",
    data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 0 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      interaction: { intersect: false, mode: "nearest" },
      scales: { x: xScale(), y: yOptions }
    }
  });
}

const voltageChart = lineChart("voltageChart", {
  min: -100, max: 60, grid: { color: "rgba(220,225,235,.2)" }, ticks: { color: "#eee" },
  title: { display: true, text: "Membrane Voltage (mV)", color: "#eee" }
});
const signalChart = lineChart("signalChart", {
  min: 0, max: 1, grid: { color: "rgba(220,225,235,.2)" }, ticks: { color: "#eee" },
  title: { display: false, text: "", color: "#eee" }
});
signalChart.options.layout = { padding: { left: 46 } };

function smallChart(canvas) {
  const chart = lineChart(canvas, {
    min: -12, max: 18, grid: { color: "rgba(220,225,235,.2)" }, ticks: { color: "#eee" },
    title: { display: true, text: "Current (nA)", color: "#eee" }
  });
  chart.options.scales.x.min = 0;
  chart.options.scales.x.max = 10;
  chart.options.scales.x.ticks.stepSize = 1;
  return chart;
}
const stimulusCharts = [smallChart("stimChart1"), smallChart("stimChart2")];
const vcProtocolChart = lineChart("vcProtocolChart", {
  min: -72, max: 72, grid: { color: "rgba(220,225,235,.2)" }, ticks: { color: "#eee" },
  title: { display: true, text: "voltage (mV)", color: "#eee" }
});
vcProtocolChart.options.scales.x.title.text = "Time (msec)";
vcProtocolChart.options.plugins.legend.display = false;

const doseCharts = {};
function inhibitionForDose(concentration) {
  // HHsim's MATLAB drug editor uses the direct IC50 relationship
  // inhibition = 100 * concentration / (IC50 + concentration), IC50 = 10.
  return 100 * concentration / (10 + concentration);
}

function doseForInhibition(inhibition) {
  if (inhibition <= 0) return null;
  if (inhibition >= 100) return 1000;
  return Math.min(1000, Math.max(1, 10 * inhibition / (100 - inhibition)));
}

function logDecadeLabel(rawValue) {
  const value = Number(rawValue);
  const exponent = Math.round(Math.log10(value));
  if (!Number.isFinite(exponent) || Math.abs(value - Math.pow(10, exponent)) > 1e-8) return "";
  return `10${String(exponent).replace(/-/g, "⁻").replace(/0/g, "⁰").replace(/1/g, "¹").replace(/2/g, "²").replace(/3/g, "³")}`;
}

function updateDoseChart(drug) {
  const inhibition = Math.min(100, Math.max(0, state.drugInhibition[drug] ?? value(drug)));
  const concentration = doseForInhibition(inhibition);
  const chart = doseCharts[drug];
  chart.data.datasets = [
    { data: chart.$dosePoints, borderColor: "#e7e800", borderWidth: 2, pointRadius: 0 },
    // MATLAB's make_drug.m uses a 0--100% cyan guide line. It is dotted at
    // an interior concentration and solid only at the 1 nM/mM and 1000
    // nM/mM endpoints.
    {
      data: concentration ? [{ x: concentration, y: 0 }, { x: concentration, y: 100 }] : [],
      borderColor: "#00c7ce", borderWidth: 2,
      // MATLAB's ':' line style is dotted—not a long dashed guide.
      borderDash: Math.abs(concentration - 1) < 1e-8 || Math.abs(concentration - 1000) < 12 ? [] : [1, 3],
      borderCapStyle: "round", pointRadius: 0
    }
  ];
  $(drug + "Drug").classList.toggle("applied", inhibition > 0);
  chart.update("none");
  positionDrugInstruction(drug);
}

function positionDrugInstruction(drug) {
  const chart = doseCharts[drug];
  const label = document.querySelector(`.apply-drug[data-drug="${drug}"] span`);
  if (!chart?.chartArea || !label) return;
  // Exact make_drug.m placement: text(20,45,...).  Chart.js returns the
  // same coordinates in pixels for the logarithmic concentration axis and
  // 0--100% inhibition axis.
  label.style.left = `${chart.scales.x.getPixelForValue(20)}px`;
  label.style.top = `${chart.scales.y.getPixelForValue(45)}px`;
}

function applyDrugValue(drug, requestedInhibition, { preserveText = false } = {}) {
  const control = $(drug);
  const rawValue = String(requestedInhibition).trim();
  const numericValue = Number(rawValue);
  // Keep an emptied text field empty while the user is replacing (for
  // example) 1 with 50. MATLAB's text callback runs on commit, not on every
  // backspace; treating an empty transient value as a new zero dose made the
  // browser restart the plot and immediately reinsert the old digit.
  if (rawValue === "" || !Number.isFinite(numericValue)) return false;
  const inhibition = Math.min(100, Math.max(0, numericValue));
  const changed = Math.abs(inhibition - state.drugInhibition[drug]) > 1e-10;
  // graph_select.m calls set_valbox(round(gmax)) then set_drug(gmax,xloc).
  // Preserve that distinction so an x-axis click has exactly the same
  // inhibition and cyan cursor location as the MATLAB implementation.
  if (!preserveText) control.value = String(Math.round(inhibition));
  state.drugInhibition[drug] = inhibition;
  refreshChangedState($("drugs"));
  updateDrugToolbarIndicator();
  updateDoseChart(drug);
  preserveStateForParameterChange();
  // A graph click is a committed value. A typed value is committed by the
  // change/Enter event below. In either case, do not restart the membrane
  // trace when the effective inhibition has not changed.
  if (changed && !state.applyingDrugReset) redrawTraceForDrugChange();
  return changed;
}

function doseChart(canvas, drug) {
  // make_drug.m samples every integer concentration from 1 through 1000.
  // Retaining that density prevents visible chords on the logarithmic curve.
  const points = Array.from({ length: 1000 }, (_, index) => index + 1)
    .map((x) => ({ x, y: inhibitionForDose(x) }));
  const chart = new Chart($(canvas), {
    type: "line", data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, dosePlotFrame: { color: "#eeeeee", width: 1 } },
      onClick: (event) => {
        const area = chart.chartArea;
        if (!area || event.x < area.left || event.x > area.right || event.y < area.top || event.y > area.bottom) {
          // graph_select.m clears the drug when a user clicks outside its
          // plot rectangle.
          applyDrugValue(drug, 0);
          return;
        }
        const x = chart.scales.x.getValueForPixel(event.x);
        if (!Number.isFinite(x)) return;
        applyDrugValue(drug, inhibitionForDose(x));
      },
      scales: {
        x: { type: "logarithmic", min: 1, max: 1000, grid: { drawOnChartArea: false, color: "rgba(220,225,235,.6)" }, border: { color: "#eee", width: 2 }, ticks: { color: "#eee", autoSkip: false, callback: logDecadeLabel }, title: { display: true, text: `concentration (${drug === "ttx" ? "nM" : "mM"})`, color: "#eee" } },
        y: { min: 0, max: 100, grid: { drawOnChartArea: false, color: "rgba(220,225,235,.6)" }, border: { color: "#eee", width: 2 }, ticks: { color: "#eee", autoSkip: false }, afterBuildTicks: (axis) => { axis.ticks = [0, 50, 100].map((value) => ({ value })); }, title: { display: true, text: "% inhibition", color: "#eee" } }
      }
    }
  });
  chart.$dosePoints = points;
  doseCharts[drug] = chart;
  updateDoseChart(drug);
}
doseChart("ttxChart", "ttx"); doseChart("teaChart", "tea");

// Keep the cyan instruction above the chart while making it a real graph
// target.  A click on the text maps to the exact same log-scale dose as a
// click at that x-coordinate on the underlying MATLAB-style curve.
document.querySelectorAll(".apply-drug").forEach((button) => {
  button.addEventListener("click", (event) => {
    const chart = doseCharts[button.dataset.drug];
    if (!chart) return;
    const bounds = chart.canvas.getBoundingClientRect();
    const x = chart.scales.x.getValueForPixel(event.clientX - bounds.left);
    if (Number.isFinite(x)) applyDrugValue(button.dataset.drug, inhibitionForDose(x));
  });
});

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

// ---- Voltage clamp -------------------------------------------------------
// Direct port of setup_vclamp.m/make_voltage.m's four protocol segments.
// Values are in mV and ms at the UI boundary, as in the MATLAB controls.
const vcControlDefinitions = [
  ["vcHoldVoltage", "Holding voltage (mV)", -60, -90, 100, "voltage"],
  ["vcHoldDuration", "Hold time (msec)", 10, 0, 40, "duration"],
  ["vcStep1Voltage", "Step 1 voltage (mV)", -40, -90, 100, "voltage"],
  ["vcStep1Duration", "Step 1 duration (msec)", 20, 0, 40, "duration"],
  ["vcStep2Voltage", "Step 2 voltage (mV)", -60, -90, 100, "voltage"],
  ["vcStep2Duration", "Step 2 duration (msec)", 10, 0, 40, "duration"],
  ["vcStep3Voltage", "Step 3 voltage (mV)", 0, -90, 100, "voltage"],
  ["vcStep3Duration", "Step 3 duration (msec)", 0, 0, 40, "duration"]
];
const vcCurveColors = ["#ed1717", "#7678d6", "#12d61d", "#e7e800", "#00b8ff", "#ff4ee7", "#ff9400", "#00c7ce"];

function buildVoltageClampControls() {
  const container = $("vcControls");
  container.innerHTML = vcControlDefinitions.map(([id, label, initial, min, max, kind], index) => `
    <div class="vc-control ${kind}" aria-label="${label}">
      <span class="vc-control-label">${label.replace(/ \(.*/, "")}</span>
      <output data-vc-value="${id}">${initial}</output>
      <input id="${id}" class="vc-input" type="hidden" value="${initial}" min="${min}" max="${max}" step="1">
      ${kind === "voltage"
        ? `<button type="button" data-vc-adjust="${id}" data-step="1">▲</button><div class="vc-vertical-wrap"><input class="vc-range" data-vc-range="${id}" type="range" value="${initial}" min="${min}" max="${max}" step="1" aria-label="${label}"></div><button type="button" data-vc-adjust="${id}" data-step="-1">▼</button>`
        : `<div class="vc-click-scroll"><button type="button" data-vc-adjust="${id}" data-step="-1">◀</button><input class="vc-range" data-vc-range="${id}" type="range" value="${initial}" min="${min}" max="${max}" step="1" aria-label="${label}"><button type="button" data-vc-adjust="${id}" data-step="1">▶</button></div>`}
      <input class="vc-select" type="radio" name="vc-selected" value="${index}" aria-label="Vary ${label}" ${index === 2 ? "checked" : ""}>
    </div>`).join("");
  const syncControl = (id) => {
    const input = $(id);
    const range = container.querySelector(`[data-vc-range="${input.id}"]`);
    const current = Number(input.value);
    const bounded = Math.max(Number(input.min), Math.min(Number(input.max), Number.isFinite(current) ? current : 0));
    input.value = String(bounded);
    range.value = String(bounded);
    container.querySelector(`[data-vc-value="${id}"]`).textContent = String(bounded);
    const verticalTrack = range.closest(".vc-vertical-wrap");
    if (verticalTrack) {
      const fraction = (bounded - Number(input.min)) / (Number(input.max) - Number(input.min));
      const trackHeight = verticalTrack.clientHeight || 56;
      const thumbHeight = 8;
      verticalTrack.style.setProperty("--vc-thumb-top", `${(1 - fraction) * (trackHeight - thumbHeight)}px`);
    }
  };
  container.querySelectorAll(".vc-input").forEach((input) => input.addEventListener("input", () => {
    syncControl(input.id);
    updateVoltageClampProtocol();
  }));
  container.querySelectorAll("[data-vc-range]").forEach((range) => range.addEventListener("input", () => {
    $(range.dataset.vcRange).value = range.value;
    $(range.dataset.vcRange).dispatchEvent(new Event("input", { bubbles: true }));
  }));
  container.querySelectorAll("[data-vc-adjust]").forEach((button) => button.addEventListener("click", () => {
    const input = $(button.dataset.vcAdjust);
    input.value = String(Math.max(Number(input.min), Math.min(Number(input.max), Number(input.value) + Number(button.dataset.step))));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }));
  container.querySelectorAll(".vc-input").forEach((input) => syncControl(input.id));
  container.querySelectorAll(".vc-select").forEach((radio) => radio.addEventListener("change", () => {
    state.vcSelected = Number(radio.value);
    const [, label] = vcControlDefinitions[state.vcSelected];
    $("vcParameterLabel").textContent = `${label}:`;
    $("vcVarValues").value = $(vcControlDefinitions[state.vcSelected][0]).value;
    updateVoltageClampProtocol();
  }));
  $("vcVarValues").addEventListener("input", updateVoltageClampProtocol);
  $("vcVarValues").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    updateVoltageClampProtocol();
    event.currentTarget.blur();
  });
}

function vcControlValue(index, override) {
  const [id, , initial, min, max] = vcControlDefinitions[index];
  const raw = index === state.vcSelected && Number.isFinite(override) ? override : Number($(id).value);
  return Math.max(min, Math.min(max, Number.isFinite(raw) ? raw : initial));
}

function vcVariantValues() {
  const field = $("vcVarValues");
  const values = (field.value.match(/[-+]?(?:\d*\.?\d+)/g) || []).map(Number).filter(Number.isFinite);
  return (values.length ? values : [vcControlValue(state.vcSelected)]).slice(0, 8);
}

function updateClampSweepLabel(variants = vcVariantValues()) {
  const selected = vcControlDefinitions[state.vcSelected];
  if (!selected) return;
  const label = $("clampParameter");
  label.replaceChildren(`${selected[1]}: `);
  variants.forEach((entry, index) => {
    const value = document.createElement("span");
    value.className = "clamp-sweep-value";
    value.style.color = vcCurveColors[index % vcCurveColors.length];
    value.textContent = Number.isInteger(entry) ? String(entry) : String(Number(entry.toFixed(3)));
    label.append(value);
  });
}

function vcSegments(override) {
  const controls = vcControlDefinitions.map((_, index) => vcControlValue(index, override));
  return [[controls[0], controls[1]], [controls[2], controls[3]], [controls[4], controls[5]], [controls[6], controls[7]]]
    .filter(([, duration]) => duration > 0);
}

function vcProtocolPoints(override) {
  const segments = vcSegments(override);
  if (!segments.length) return [{ x: -.2, y: 0 }, { x: 0, y: 0 }];
  const points = [{ x: -.2, y: segments[0][0] }];
  let time = 0;
  segments.forEach(([voltage, duration], index) => {
    if (index) points.push({ x: time, y: voltage });
    points.push({ x: time + duration, y: voltage });
    time += duration;
  });
  return points;
}

function updateVoltageClampProtocol() {
  const variants = vcVariantValues();
  const traces = variants.map(vcProtocolPoints);
  const last = Math.max(0, ...traces.flat().map((point) => point.x));
  const timeStops = [0, 10.9, 20.9, 25.9, 50.9, 100.9, 150.9, 200.9];
  const axisEnd = timeStops.find((stop) => stop >= last) ?? timeStops.at(-1);
  const magnitude = Math.max(10, ...traces.flat().map((point) => Math.abs(point.y)));
  const axisLimit = Math.ceil(magnitude * 1.2 / 10) * 10;
  vcProtocolChart.data.datasets = [
    { data: [{ x: -1, y: 0 }, { x: axisEnd + 1, y: 0 }], borderColor: "rgba(178,178,178,.7)", borderWidth: 1.5, borderDash: [1, 3], pointRadius: 0 },
    ...traces.map((data, index) => ({ data, borderColor: vcCurveColors[index], borderWidth: 2.5, pointRadius: 0, stepped: true }))
  ];
  vcProtocolChart.options.scales.x.min = -.2;
  vcProtocolChart.options.scales.x.max = axisEnd;
  vcProtocolChart.options.scales.x.afterBuildTicks = (axis) => { axis.ticks = Array.from({ length: Math.floor(axisEnd) + 1 }, (_, value) => ({ value })); };
  vcProtocolChart.options.scales.y.min = -axisLimit;
  vcProtocolChart.options.scales.y.max = axisLimit;
  vcProtocolChart.update("none");
  updateClampSweepLabel(variants);
}

function vcGateSteady(gate, voltage, fallback) {
  const alpha = rate(gate, "Alpha", voltage), beta = rate(gate, "Beta", voltage);
  return alpha + beta > 0 ? alpha / (alpha + beta) : fallback;
}

function simulateVoltageClamp(override) {
  const segments = vcSegments(override);
  if (!segments.length) return { current: [], voltage: [], end: 0 };
  const e = reversals();
  const pronase = $("pronase").checked;
  const userFastClone = state.userCopySource === "fast" && $("userChannel").checked;
  const userDelayedClone = state.userCopySource === "delayed" && $("userChannel").checked;
  const clamp = (value) => Math.max(0, Math.min(1, value));
  let [holding] = segments[0];
  let model = {
    m: vcGateSteady("m", holding, state.m), h: pronase ? 1 : vcGateSteady("h", holding, state.h),
    n: vcGateSteady("n", holding, state.n), p: vcGateSteady("p", holding, state.p), q: vcGateSteady("q", holding, state.q)
  };
  if (userFastClone) { model.p = model.m; model.q = model.h; }
  if (userDelayedClone) { model.p = model.n; model.q = 1; }
  const current = [], voltage = [];
  let time = 0;
  const capacitance = Math.max(.1, value("cm")); // nF
  const ionicCurrent = (v, source) => {
    const passiveNa = $("passiveNa").checked ? value("gNaLeak") * (v - e.na) : 0;
    const passiveK = $("passiveK").checked ? value("gKLeak") * (v - e.k) : 0;
    const leak = $("passiveCl").checked ? value("gClLeak") * (v - e.cl) : 0;
    const gNa = $("fastNa").checked ? value("naGmax") * source.m ** value("mExponent") * source.h ** value("hExponent") * (1 - state.drugInhibition.ttx / 100) : 0;
    const gK = $("delayedK").checked ? value("kGmax") * source.n ** value("nExponent") * (1 - state.drugInhibition.tea / 100) : 0;
    const gUser = $("userChannel").checked && $("userIon").value !== "none" ? value("userGmax") * source.p ** value("pExponent") * source.q ** value("qExponent") : 0;
    return gNa * (v - ionReversal($("naIon").value, e)) + gK * (v - ionReversal($("kIon").value, e)) + passiveNa + passiveK + leak + gUser * (v - ionReversal($("userIon").value, e));
  };
  const advance = (v, dt) => {
    const step = (gate, currentValue) => clamp(currentValue + dt * (rate(gate, "Alpha", v) * (1 - currentValue) - rate(gate, "Beta", v) * currentValue));
    model.m = step("m", model.m); model.h = pronase ? 1 : step("h", model.h); model.n = step("n", model.n);
    model.p = userFastClone ? model.m : userDelayedClone ? model.n : step("p", model.p);
    model.q = userFastClone ? model.h : userDelayedClone ? 1 : step("q", model.q);
  };
  let priorClampVoltage = segments[0][0];
  segments.forEach(([v, duration]) => {
    const end = time + duration;
    let firstPointInSegment = true;
    while (time < end - 1e-9) {
      const dt = Math.min(.02, end - time);
      // find_I.m includes a capacitive current during each voltage transition.
      // vc_iterate.m clamps its denominator at 5e-5 s (0.05 ms), so a change
      // of mV across a nF capacitance naturally yields nA here.
      const capacitiveCurrent = firstPointInSegment
        ? capacitance * (v - priorClampVoltage) / Math.max(.05, dt)
        : 0;
      current.push({
        x: time,
        y: ionicCurrent(v, model) + capacitiveCurrent,
        capacitiveTransient: firstPointInSegment && Math.abs(v - priorClampVoltage) > 1e-9
      });
      voltage.push({ x: time, y: v });
      advance(v, dt); time += dt;
      firstPointInSegment = false;
    }
    current.push({ x: time, y: ionicCurrent(v, model) }); voltage.push({ x: time, y: v });
    priorClampVoltage = v;
  });
  return { current, voltage, end: time };
}

function voltageClampCurrentBounds(curves, visibleThrough = Infinity) {
  // vc_clear.m initializes [-12, 12] nA. vc_iterate.m then grows the current
  // axis only when a *drawn* sample crosses its retained min/max threshold.
  let trackedMin = -10;
  let trackedMax = 10;
  curves.forEach((curve) => curve.current.forEach((point) => {
    if (point.x > visibleThrough + 1e-9) return;
    // Keep step transients in the visible range. In particular, the default
    // −60 to −40 mV transition has the ~400 nA capacitive peak shown by HHsim.
    if (point.y > trackedMax) trackedMax = point.y * 1.2;
    else if (point.y < trackedMin) trackedMin = point.y * 1.2;
  }));
  return { min: trackedMin * 1.2, max: trackedMax * 1.2 };
}

function renderVoltageClampCurves(visibleThrough = Infinity) {
  const curves = state.vcCurves;
  if (!curves.length) {
    voltageChart.data.datasets = [];
    voltageChart.options.scales.x.min = 0; voltageChart.options.scales.x.max = 60;
    voltageChart.options.scales.y.min = -12; voltageChart.options.scales.y.max = 12;
    voltageChart.options.scales.y.title.text = "Current (nA)"; voltageChart.options.scales.y.title.display = true;
    voltageChart.options.scales.y.afterBuildTicks = (axis) => { axis.ticks = [-10, -5, 0, 5, 10].map((value) => ({ value })); };
    voltageChart.options.scales.y.ticks.callback = cleanAxisLabel;
    signalChart.data.datasets = [];
    signalChart.options.layout = { padding: { left: 0 } };
    signalChart.options.scales.x.min = 0; signalChart.options.scales.x.max = 60;
    signalChart.options.scales.y.min = -90; signalChart.options.scales.y.max = 60;
    signalChart.options.scales.y.title.text = "Voltage (mV)"; signalChart.options.scales.y.title.display = true;
    signalChart.options.scales.y.afterBuildTicks = (axis) => { axis.ticks = [-90, -60, -30, 0, 30, 60].map((value) => ({ value })); };
    signalChart.options.scales.y.ticks.callback = cleanAxisLabel;
    voltageChart.update("none"); signalChart.update("none");
    return;
  }
  const end = Math.max(10, ...curves.map((curve) => curve.end));
  const currentBounds = voltageClampCurrentBounds(curves, visibleThrough);
  const visible = (points) => points.filter((point) => point.x <= visibleThrough + 1e-9);
  voltageChart.data.datasets = curves.map((curve, index) => ({ data: visible(curve.current), borderColor: vcCurveColors[index], borderWidth: 2, pointRadius: 0 }));
  voltageChart.options.scales.x.min = 0; voltageChart.options.scales.x.max = Math.ceil(end / 10) * 10;
  voltageChart.options.scales.y.min = currentBounds.min; voltageChart.options.scales.y.max = currentBounds.max;
  voltageChart.options.scales.y.title.text = "Current (nA)"; voltageChart.options.scales.y.title.display = true;
  // Keep the exact simulation range, while displaying HHsim-style rounded
  // axis marks instead of raw extrema such as 613.805 or -570.018.
  setCleanYAxisTicks(voltageChart, currentBounds.min, currentBounds.max);
  signalChart.data.datasets = curves.map((curve, index) => ({ data: visible(curve.voltage), borderColor: vcCurveColors[index], borderWidth: 2, pointRadius: 0, stepped: true }));
  signalChart.options.layout = { padding: { left: 0 } };
  signalChart.options.scales.x.min = 0; signalChart.options.scales.x.max = Math.ceil(end / 10) * 10;
  signalChart.options.scales.y.min = -90; signalChart.options.scales.y.max = 60;
  signalChart.options.scales.y.title.text = "Voltage (mV)"; signalChart.options.scales.y.title.display = true;
  setCleanYAxisTicks(signalChart, -90, 60);
  voltageChart.update("none"); signalChart.update("none");
  $("signalKey").innerHTML = "";
}

function runVoltageClamp() {
  cancelActiveRun();
  state.vcCursor = null;
  state.vcCurves = vcVariantValues().map(simulateVoltageClamp);
  const end = Math.max(10, ...state.vcCurves.map((curve) => curve.end));
  const runId = ++state.runId;
  const started = performance.now();
  // Let the plotting pace visibly follow the experiment without making a
  // standard 40 ms protocol feel sluggish. MATLAB's splot_single is called
  // once per integration step; this batches those calls into animation frames.
  const animationMs = Math.max(800, Math.min(2200, end * 35));
  let complete = false;
  state.running = true;
  $("run").classList.add("running");
  const finish = () => {
    if (complete || runId !== state.runId) return;
    complete = true;
    cancelAnimationFrame(state.animation);
    clearTimeout(state.completionTimer);
    state.running = false;
    $("run").classList.remove("running");
    renderVoltageClampCurves();
    $("hint").textContent = `Voltage clamp complete: ${state.vcCurves.length} curve${state.vcCurves.length === 1 ? "" : "s"}.`;
  };
  const animate = (now) => {
    if (complete || runId !== state.runId) return;
    const fraction = Math.min(1, (now - started) / animationMs);
    renderVoltageClampCurves(fraction * end);
    if (fraction < 1) {
      state.animation = requestAnimationFrame(animate);
    } else {
      finish();
    }
  };
  renderVoltageClampCurves(0);
  state.completionTimer = setTimeout(finish, animationMs + 120);
  state.animation = requestAnimationFrame(animate);
}

function chosenSignals() {
  const library = {
    m: { key: "m", label: "m", low: 0, high: 1, unit: "" }, h: { key: "h", label: "h", low: 0, high: 1, unit: "" }, n: { key: "n", label: "n", low: 0, high: 1, unit: "" },
    iNa: { key: "iNa", label: "I_Na", low: -0.75, high: 0.75, unit: "µA", convert: (v) => v / 1000 }, iK: { key: "iK", label: "I_K", low: -0.75, high: 0.75, unit: "µA", convert: (v) => v / 1000 },
    gNa: { key: "gNa", label: "g_Na", low: 0, high: 30, unit: "µS" }, gK: { key: "gK", label: "g_K", low: 0, high: 30, unit: "µS" },
    iLeak: { key: "iLeak", label: "I_leak", low: -0.05, high: 0.05, unit: "µA", convert: (v) => v / 1000 },
    p: { key: "p", label: "p", low: 0, high: 1, unit: "" }, q: { key: "q", label: "q", low: 0, high: 1, unit: "" },
    iUser: { key: "iUser", label: "I_user", low: 0, high: 1, unit: "" }, gUser: { key: "gUser", label: "g_user", low: 0, high: 1, unit: "" },
    blank: { key: "blank", label: "blank", low: 0, high: 1, unit: "", blank: true }
  };
  return ["signal1", "signal2", "signal3"].map((id, index) => ({ ...library[$(id).value], color: lineColors[index] }));
}

function displayValue(point, signal) {
  if (signal.blank) return "—";
  const raw = signal.convert ? signal.convert(point[signal.key]) : point[signal.key];
  return `${fixed(raw, 3)}${signal.unit ? ` ${signal.unit}` : ""}`;
}

function updateSignalChart(points, viewEnd) {
  const signals = chosenSignals();
  const visibleSignals = signals.filter((signal) => !signal.blank);
  const chartValue = (point, signal) => {
    const raw = signal.convert ? signal.convert(point[signal.key]) : point[signal.key];
    return (raw - signal.low) / (signal.high - signal.low);
  };
  signalChart.data.datasets = visibleSignals.map((signal) => ({
    data: points.map((p) => ({ x: p.time, y: chartValue(p, signal) + state.plotOffset.signal })),
    borderColor: signal.color, borderWidth: 2, pointRadius: 0
  }));
  signalChart.options.scales.y.min = state.signalY.min;
  signalChart.options.scales.y.max = state.signalY.max;
  setCleanYAxisTicks(signalChart, state.signalY.min, state.signalY.max);
  signalChart.options.scales.y.title.display = false;
  // Pan is allowed to expose empty negative/future time space, exactly as
  // the MATLAB axes do.  Do not coerce the view back to 0 or 60 ms here.
  signalChart.options.scales.x.min = viewEnd - state.viewSpan;
  signalChart.options.scales.x.max = viewEnd;
  ["na", "k", "leak"].forEach((prefix, index) => {
    const signal = signals[index];
    $(`${prefix}High`).textContent = signal.blank ? "—" : `${signal.high}${signal.unit ? ` ${signal.unit}` : ""}`;
    $(`${prefix}Low`).textContent = signal.blank ? "—" : `${signal.low}${signal.unit ? ` ${signal.unit}` : ""}`;
  });
  $("signalKey").innerHTML = visibleSignals.map((signal) => `<span style="color:${signal.color}">${signal.label}</span>`).join("");
  signalChart.update("none");
}

function niceAxisStep(span) {
  const raw = Math.max(Number.EPSILON, span / 8);
  const power = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / power;
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return multiplier * power;
}

function cleanAxisLabel(raw) {
  const number = Number(raw);
  if (!Number.isFinite(number)) return "";
  const rounded = Math.round(number);
  return Math.abs(number - rounded) < 1e-8 ? String(rounded) : String(Number(number.toFixed(3)));
}

function setCleanYAxisTicks(chart, minimum, maximum) {
  const step = niceAxisStep(maximum - minimum);
  const epsilon = Math.abs(step) * 1e-8;
  const first = Math.ceil((minimum - epsilon) / step) * step;
  const ticks = [];
  for (let value = first; value <= maximum + epsilon; value += step) ticks.push({ value: Number(value.toFixed(10)) });
  chart.options.scales.y.afterBuildTicks = (axis) => { axis.ticks = ticks; };
  chart.options.scales.y.ticks.callback = cleanAxisLabel;
}

function draw(points, viewEnd) {
  const resolvedEnd = Number.isFinite(viewEnd) ? viewEnd : state.viewEnd;
  state.viewEnd = resolvedEnd;
  const start = resolvedEnd - state.viewSpan;
  voltageChart.data.datasets = [
    { data: points.map((p) => ({ x: p.time, y: p.voltage + state.plotOffset.voltage })), borderColor: "#ed1717", borderWidth: 2.5, pointRadius: 0 },
    { data: points.map((p) => ({ x: p.time, y: -85 + p.stimulus * .8 + state.plotOffset.voltage })), borderColor: "#7678d6", borderWidth: 2, pointRadius: 0, stepped: true }
  ];
  voltageChart.options.scales.x.min = start;
  voltageChart.options.scales.x.max = resolvedEnd;
  voltageChart.options.scales.y.min = state.voltageY.min;
  voltageChart.options.scales.y.max = state.voltageY.max;
  setCleanYAxisTicks(voltageChart, state.voltageY.min, state.voltageY.max);
  voltageChart.options.scales.y.title.text = "Membrane Voltage (mV)";
  voltageChart.options.scales.y.title.display = true;
  voltageChart.update("none");
  updateSignalChart(points, resolvedEnd);
}

// A completed short run should not turn the default 0--60 ms display into a
// negative-time viewport merely because its last calculated sample is before
// 60 ms.  MATLAB retains the opening view until the user deliberately pans or
// zooms; after a trace exceeds that view, it can extend normally.
function automaticViewEnd(time) {
  const isOpeningView = Math.abs(state.viewSpan - state.duration) < .001
    && Math.abs(state.viewEnd - state.duration) < .001;
  return isOpeningView ? Math.max(state.duration, time) : state.viewEnd;
}

function panVertically(which, sourceBounds, shift) {
  // Vertical Pan moves the scale itself, preserving its current range. This
  // lets the user travel smoothly above or below the original limits while
  // each plotted voltage/gate value stays mathematically unchanged.
  const bounds = which === "voltage" ? state.voltageY : state.signalY;
  bounds.min = sourceBounds.min + shift;
  bounds.max = sourceBounds.max + shift;
}

function pointAt(time) {
  return state.history.reduce((closest, point) => !closest || Math.abs(point.time - time) < Math.abs(closest.time - time) ? point : closest, null);
}

function syncTimeline(viewEnd) {
  const lastTime = state.history.at(-1)?.time ?? state.duration;
  const halfSpan = state.viewSpan / 2;
  const center = viewEnd - halfSpan;
  // MATLAB's moveslider.m uses the slider as the midpoint of the visible
  // x-window.  Using the right edge causes the next tick to appear offset.
  const minimum = Math.min(-halfSpan, center);
  const maximum = Math.max(state.duration + halfSpan, lastTime + halfSpan, center);
  const windowControl = $("timeWindow");
  windowControl.min = minimum;
  windowControl.max = maximum;
  windowControl.value = Math.min(maximum, Math.max(minimum, center));
  updateTimelineViewport(minimum, maximum, Number(windowControl.value));
}

function updateTimelineViewport(minimum = Number($("timeWindow").min), maximum = Number($("timeWindow").max), center = value("timeWindow")) {
  const total = Math.max(.25, maximum - minimum);
  const span = Math.min(total, Math.max(.25, state.viewSpan));
  const start = center - span / 2;
  const viewport = $("timeViewport");
  viewport.style.left = `${((start - minimum) / total) * 100}%`;
  viewport.style.width = `${Math.max(2, (span / total) * 100)}%`;
}

function setZoomWindow(start, end, render = true) {
  if (!state.history.length) return;
  const safeStart = Math.min(start, end);
  const safeEnd = Math.max(safeStart + .25, Math.max(start, end));
  state.viewSpan = safeEnd - safeStart;
  state.viewEnd = safeEnd;
  syncTimeline(safeEnd);
  if (render) draw(state.history, safeEnd);
}

function setVoltageClampXWindow(center) {
  // The normal timeline renderer calls draw(), which is intentionally not
  // valid for clamp traces. Keep the two clamp axes synchronized instead.
  const traceEnd = Math.max(60, ...state.vcCurves.map((curve) => curve.end || 0));
  const currentStart = Number(voltageChart.options.scales.x.min) || 0;
  const currentEnd = Number(voltageChart.options.scales.x.max) || traceEnd;
  const span = Math.max(.25, currentEnd - currentStart);
  const start = Math.max(0, Math.min(traceEnd - span, center - span / 2));
  const end = start + span;
  [voltageChart, signalChart].forEach((chart) => {
    chart.options.scales.x.min = start;
    chart.options.scales.x.max = end;
    chart.update("none");
  });
}

function horizontalZoomMaximum() {
  // The MATLAB viewer can zoom back out to the available trace, not merely
  // to the 60 ms opening viewport.  Keep a previously panned view reachable
  // as well, even when no newer samples have been calculated yet.
  return Math.max(state.duration, state.history.at(-1)?.time || 0, state.viewEnd);
}

function setHorizontalZoomAround(center, requestedSpan, render = true) {
  const maximum = horizontalZoomMaximum();
  const span = Math.min(maximum, Math.max(.25, requestedSpan));
  const start = Math.max(0, Math.min(maximum - span, center - span / 2));
  setZoomWindow(start, start + span, render);
}

function zoomVerticalAt(chart, event, voltage, multiplier = .5) {
  const clickedValue = chart.scales.y.getValueForPixel(event.y);
  if (!Number.isFinite(clickedValue)) return;
  const bounds = voltage ? state.voltageY : state.signalY;
  const original = voltage ? { min: -100, max: 60 } : { min: 0, max: 1 };
  const minimumSpan = voltage ? 2 : .05;
  const span = Math.max(minimumSpan, (bounds.max - bounds.min) * multiplier);
  const half = span / 2;
  bounds.min = Math.max(original.min, clickedValue - half);
  bounds.max = Math.min(original.max, clickedValue + half);
  if (bounds.max - bounds.min < minimumSpan) {
    bounds.min = Math.max(original.min, bounds.max - minimumSpan);
    bounds.max = Math.min(original.max, bounds.min + minimumSpan);
  }
}

function zoomAt(chart, event, voltage) {
  const clickedTime = chart.scales.x.getValueForPixel(event.x);
  if (!Number.isFinite(clickedTime) || !state.history.length) return;
  // MATLAB's click zoom is intentionally coarse; each click halves the time
  // range down to a useful ten-millisecond inspection window.
  if (state.zoomConstraint !== "vertical") {
    const span = Math.max(10, state.viewSpan / 2);
    setHorizontalZoomAround(clickedTime, span, false);
  }
  if (state.zoomConstraint !== "horizontal") zoomVerticalAt(chart, event, voltage);
  draw(state.history, state.viewEnd);
}

function zoomOutAt(chart, event, voltage) {
  const clickedTime = chart.scales.x.getValueForPixel(event.x);
  if (!Number.isFinite(clickedTime) || !state.history.length) return;
  if (state.zoomConstraint !== "vertical") {
    setHorizontalZoomAround(clickedTime, state.viewSpan * 2, false);
  }
  if (state.zoomConstraint !== "horizontal") zoomVerticalAt(chart, event, voltage, 2);
  draw(state.history, state.viewEnd);
}

function resetOriginalView() {
  state.viewSpan = state.duration;
  state.viewEnd = state.duration;
  state.voltageY = { min: -100, max: 60 };
  state.signalY = { min: 0, max: 1 };
  state.plotOffset = { voltage: 0, signal: 0 };
  syncTimeline(state.viewEnd);
  draw(state.history, state.viewEnd);
}

function expandVerticalBounds(bounds, original) {
  const center = (bounds.min + bounds.max) / 2;
  const half = Math.min((original.max - original.min) / 2, (bounds.max - bounds.min));
  bounds.min = Math.max(original.min, center - half);
  bounds.max = Math.min(original.max, center + half);
}

function zoomOutFromMenu() {
  if (!state.history.length) return;
  if (state.zoomConstraint !== "vertical") {
    // Keep the current viewport centered while expanding it. Centering on the
    // context-menu pointer can make a Zoom Out look like a new zoom-in.
    const center = state.viewEnd - state.viewSpan / 2;
    setHorizontalZoomAround(center, state.viewSpan * 2, false);
  }
  if (state.zoomConstraint !== "horizontal") {
    expandVerticalBounds(state.voltageY, { min: -100, max: 60 });
    expandVerticalBounds(state.signalY, { min: 0, max: 1 });
  }
  draw(state.history, state.viewEnd);
}

function updateZoomMenuCheckmark() {
  document.querySelectorAll("[data-zoom-constraint]").forEach((button) => {
    button.querySelector("b").textContent = button.dataset.zoomConstraint === state.zoomConstraint ? "✓" : "";
  });
}

function hideZoomMenu() { $("zoomMenu").hidden = true; }

function showZoomMenu(clientX, clientY) {
  const menu = $("zoomMenu");
  updateZoomMenuCheckmark();
  menu.hidden = false;
  menu.style.left = `${Math.max(4, Math.min(clientX, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(clientY, window.innerHeight - menu.offsetHeight - 4))}px`;
}

function cursorLines() {
  const signalLines = chosenSignals().filter((signal) => !signal.blank).map((signal, datasetIndex) => ({
    chart: signalChart, datasetIndex, label: signal.label, unit: signal.unit,
    color: datasetIndex === 0 ? "#ffff80" : datasetIndex === 1 ? "#80ff80" : "#80ffff",
    value: (point) => displayValue(point, signal)
  }));
  return [
    { chart: voltageChart, datasetIndex: 0, label: "Memb. Voltage", unit: "mV", color: "#ff8080", value: (point) => `${fixed(point.voltage, 3)} mV` },
    { chart: voltageChart, datasetIndex: 1, label: "Stimulus", unit: "nA", color: "#b98aff", value: (point) => `${fixed(point.stimulus, 3)} nA` },
    ...signalLines
  ];
}

function cursorLine() {
  if (!state.cursor) return null;
  return cursorLines().find((line) => line.chart === state.cursor.chart && line.datasetIndex === state.cursor.datasetIndex) || null;
}

function cursorMessage(point, line) {
  return `t = ${fixed(point.time)} ms  •  ${line.label} = ${line.value(point)}`;
}

function redrawCursor() {
  voltageChart.draw();
  signalChart.draw();
}

function bringCursorIntoView(point) {
  const start = Math.max(0, state.viewEnd - state.viewSpan);
  const end = state.viewEnd;
  if (point.time > start && point.time < end) return;
  state.viewEnd = point.time <= start ? Math.max(state.viewSpan, point.time + state.viewSpan * .9) : point.time + state.viewSpan * .1;
  syncTimeline(state.viewEnd);
}

function updateCursorReadout(reveal = true) {
  const cursor = state.cursor;
  const point = cursor && state.history[cursor.index];
  const line = cursorLine();
  if (!point || !line) return;
  const message = cursorMessage(point, line);
  $("readout").textContent = message;
  $("cursorPopupValue").textContent = line.value(point);
  $("cursorPopupTime").textContent = `${fixed(point.time)} msec`;
  $("cursorPopupLabel").textContent = line.label;
  // reset_cursor_values.m applies the selected trace's color to the cursor
  // readout itself; keep voltage, stimulus, and each gate visibly distinct.
  $("cursorPopup").style.setProperty("--cursor-color", line.color);
  if (reveal) $("cursorPopup").hidden = false;
  redrawCursor();
}

function setCursor(chart, datasetIndex, index, reveal = true) {
  // Clamp cursors are backed by the clamp datasets, never membrane history.
  // Guarding this path prevents a stale ordinary cursor event from redrawing
  // the voltage-recording workspace over a clamp experiment.
  if (state.recordingMode === "clamp") return;
  const line = cursorLines().find((candidate) => candidate.chart === chart && candidate.datasetIndex === datasetIndex);
  if (!line || !state.history.length) return;
  const safeIndex = Math.max(0, Math.min(state.history.length - 1, index));
  state.cursor = { chart, datasetIndex, index: safeIndex, color: line.color };
  bringCursorIntoView(state.history[safeIndex]);
  draw(state.history, state.viewEnd);
  updateCursorReadout(reveal);
}

function moveCursor(amount) {
  const cursor = state.cursor;
  if (!cursor || !state.history.length) return;
  if (amount === 0) {
    const lines = cursorLines();
    const current = lines.findIndex((line) => line.chart === cursor.chart && line.datasetIndex === cursor.datasetIndex);
    const next = lines[(current + 1) % lines.length];
    setCursor(next.chart, next.datasetIndex, cursor.index);
    return;
  }
  const data = cursor.chart.data.datasets[cursor.datasetIndex]?.data;
  if (!data?.length) return;
  const direction = Math.sign(amount);
  let index = cursor.index;
  if (Math.abs(amount) < 2) {
    index = Math.max(0, Math.min(data.length - 1, index + direction));
  } else if (index + direction >= 0 && index + direction < data.length) {
    const slope = (left, right) => Math.sign((data[right]?.y ?? 0) - (data[left]?.y ?? 0));
    const originalSlope = direction * slope(index, index + direction);
    while (index + direction >= 0 && index + direction < data.length) {
      index += direction;
      if (index + direction < 0 || index + direction >= data.length) break;
      if (direction * slope(index, index + direction) !== originalSlope) break;
    }
  }
  setCursor(cursor.chart, cursor.datasetIndex, index);
}

function installClickReadout(chart, voltage) {
  chart.options.onClick = (event, entries) => {
    if (state.mode === "pan") return;
    if (state.mode === "zoom") {
      if (state.skipZoomClick) {
        state.skipZoomClick = false;
        return;
      }
      if (event.native?.shiftKey) zoomOutAt(chart, event, voltage);
      else zoomAt(chart, event, voltage);
      return;
    }
    if (!entries.length) return;
    const dataset = chart.data.datasets[entries[0].datasetIndex];
    if (state.recordingMode === "clamp") {
      const index = entries[0].index;
      const sample = dataset?.data?.[index];
      if (!sample) return;
      state.vcCursor = {
        chart,
        datasetIndex: entries[0].datasetIndex,
        index,
        color: dataset.borderColor || "#ff8080"
      };
      const label = chart === voltageChart ? "Current" : "Voltage";
      const unit = chart === voltageChart ? "nA" : "mV";
      $("clampStatus").lastElementChild.textContent = `t = ${fixed(sample.x)} msec  •  ${label} = ${fixed(sample.y, 3)} ${unit}`;
      $("cursorPopup").hidden = true;
      redrawCursor();
      return;
    }
    const point = pointAt(dataset.data[entries[0].index].x);
    if (!point) return;
    setCursor(chart, entries[0].datasetIndex, state.history.indexOf(point));
  };
}
installClickReadout(voltageChart, true); installClickReadout(signalChart, false);

function installPanDrag(chart, voltage) {
  let drag = null;
  const endDrag = (event) => {
    if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
    try {
      if (chart.canvas.hasPointerCapture?.(drag.pointerId)) chart.canvas.releasePointerCapture(drag.pointerId);
    } catch {
      // The browser can release capture before it delivers pointerup.
    }
    drag = null;
    chart.canvas.style.cursor = state.mode === "pan" ? "grab" : "default";
  };
  chart.canvas.addEventListener("pointerdown", (event) => {
    if (state.mode !== "pan" || event.button !== 0 || !state.history.length) return;
    // A new press always replaces an interrupted prior gesture.
    endDrag();
    drag = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      width: Math.max(1, chart.chartArea.right - chart.chartArea.left),
      height: Math.max(1, chart.chartArea.bottom - chart.chartArea.top),
      start: state.viewEnd - state.viewSpan,
      end: state.viewEnd,
      yBounds: { ...(voltage ? state.voltageY : state.signalY) }
    };
    chart.canvas.setPointerCapture?.(event.pointerId);
    chart.canvas.style.cursor = "grabbing";
    event.preventDefault();
  });
  chart.canvas.addEventListener("pointermove", (event) => {
    if (!drag) return;
    // Never treat hover as a drag. Pointer capture can be lost when a quick
    // drag ends outside the canvas, so also use the primary-button state as a
    // reliable final guard.
    if (state.mode !== "pan" || event.pointerId !== drag.pointerId || (event.buttons & 1) === 0) {
      endDrag(event);
      return;
    }
    // Compute from the original pointer position, not the redrawn scale. This
    // avoids feedback that made each small drag jump far too dramatically.
    const xShift = ((event.clientX - drag.clientX) / drag.width) * state.viewSpan * .35;
    const shiftedStart = drag.start - xShift;
    // MATLAB Pan changes the scales, not the trace.  Empty space is a valid
    // result when the scales move before t=0 or beyond the calculated trace.
    state.viewEnd = Math.round(shiftedStart + state.viewSpan);
    const span = drag.yBounds.max - drag.yBounds.min;
    // An upward hand motion raises the viewport's numeric range, which makes
    // unchanged traces travel downward on screen; downward is the inverse.
    // A three-quarter-range sweep per plot-height keeps vertical Pan fluid
    // on trackpads without the slow, repeated full-height drags of the
    // original one-quarter sensitivity.
    const yShift = ((drag.clientY - event.clientY) / drag.height) * span * .75;
    if (Math.abs(event.clientY - drag.clientY) > 2) {
      panVertically(voltage ? "voltage" : "signal", drag.yBounds, yShift);
    }
    syncTimeline(state.viewEnd);
    draw(state.history, state.viewEnd);
  });
  chart.canvas.addEventListener("pointerup", endDrag);
  chart.canvas.addEventListener("pointercancel", endDrag);
  chart.canvas.addEventListener("lostpointercapture", endDrag);
  window.addEventListener("pointerup", endDrag, true);
  window.addEventListener("pointercancel", endDrag, true);
  window.addEventListener("blur", () => endDrag());
}
installPanDrag(voltageChart, true); installPanDrag(signalChart, false);

function installZoomDrag(chart) {
  let startTime = null;
  chart.canvas.addEventListener("pointerdown", (event) => {
    if (state.mode !== "zoom" || state.zoomConstraint === "vertical" || event.button !== 0 || !state.history.length) return;
    startTime = chart.scales.x.getValueForPixel(event.offsetX);
    chart.canvas.setPointerCapture?.(event.pointerId);
  });
  chart.canvas.addEventListener("pointerup", (event) => {
    if (state.mode !== "zoom" || startTime === null) return;
    const endTime = chart.scales.x.getValueForPixel(event.offsetX);
    chart.canvas.releasePointerCapture?.(event.pointerId);
    const width = Math.abs(endTime - startTime);
    if (Number.isFinite(endTime) && width >= .25) {
      state.skipZoomClick = true;
      setZoomWindow(startTime, endTime);
      // Some browsers omit the subsequent click after a drag; do not let a
      // later ordinary click be consumed by that stale guard.
      setTimeout(() => { state.skipZoomClick = false; }, 0);
    }
    startTime = null;
  });
  chart.canvas.addEventListener("pointercancel", () => { startTime = null; });
  chart.canvas.addEventListener("contextmenu", (event) => {
    if (state.mode !== "zoom" && state.mode !== "pan") return;
    event.preventDefault();
    state.zoomMenuTime = chart.scales.x.getValueForPixel(event.offsetX);
    showZoomMenu(event.clientX, event.clientY);
  });
}
installZoomDrag(voltageChart); installZoomDrag(signalChart);
$("zoomMenu").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.zoomAction === "out") zoomOutFromMenu();
  if (button.dataset.zoomAction === "reset") resetOriginalView();
  if (button.dataset.zoomConstraint) {
    state.zoomConstraint = button.dataset.zoomConstraint;
    updateZoomMenuCheckmark();
  }
  hideZoomMenu();
});
document.addEventListener("pointerdown", (event) => {
  if (!event.target.closest("#zoomMenu")) hideZoomMenu();
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") hideZoomMenu(); });

function resetSimulation() {
  cancelAnimationFrame(state.animation);
  clearTimeout(state.completionTimer);
  clearTimeout(state.continuationTimer);
  state.runId += 1;
  state.running = false; state.time = 0; state.history = [];
  state.stimulus = null;
  state.stimulusSettling = false;
  state.nudgeSettling = false;
  state.nudgeTargetTime = 0;
  state.stimulusStart = 0;
  state.stimulusTimerLead = 0;
  state.stimulusTimer = null;
  // HHsim opens at a quiescent, no-stimulus holding state. The first Run then
  // evolves the full membrane/channel equations from this visible baseline.
  // HHsim initializes its membrane at -63.39 mV.
  state.voltage = -63.39;
  // setup_channels.m seeds the original simulator with these values rather
  // than recomputing a steady state at -63.39 mV.  That intentional offset
  // affects the timing of the very first action potential.
  state.m = 0.068775;
  state.h = 0.515186;
  state.n = 0.35286656;
  state.p = 0; state.q = 0;
  state.adaptiveStep = .1;
  state.viewSpan = state.duration;
  state.viewEnd = state.duration;
  state.voltageY = { min: -100, max: 60 };
  state.signalY = { min: 0, max: 1 };
  state.plotOffset = { voltage: 0, signal: 0 };
  state.cursor = null;
  $("cursorPopup").hidden = true;
  syncTimeline(state.duration);
}

function cancelActiveRun() {
  state.runId += 1;
  cancelAnimationFrame(state.animation);
  clearTimeout(state.completionTimer);
  clearTimeout(state.continuationTimer);
  clearTimeout(state.drugUpdateTimer);
  state.animation = null;
  state.completionTimer = null;
  state.continuationTimer = null;
  state.drugUpdateTimer = null;
  state.running = false;
  $("run")?.classList.remove("running");
}

function stopContinuousDrugRun() {
  state.continuousDrugRun = false;
  clearTimeout(state.continuationTimer);
  state.continuationTimer = null;
}

function stopContinuousRun() {
  state.continuousRun = false;
  clearTimeout(state.continuationTimer);
  state.continuationTimer = null;
}

function hasUsableSimulationState() {
  return [state.time, state.voltage, state.m, state.h, state.n, state.p, state.q]
    .every((entry) => Number.isFinite(entry));
}

function restoreStateFromPoint(point) {
  if (!point) return;
  state.time = point.time;
  state.voltage = point.voltage;
  state.m = point.m;
  state.h = point.h;
  state.n = point.n;
  state.p = point.p;
  state.q = point.q;
}

// store_state.m / recall_state.m preserve more than a rendered point: the
// point's dynamic HH variables must agree with the controls that produced it.
// Keeping this explicit browser snapshot makes Save useful for fair
// stimulus/drug comparisons, rather than merely rewinding the chart image.
function snapshotControls() {
  return Array.from(document.querySelectorAll("input[id], select[id]"))
    .filter((control) => control.id !== "timeWindow")
    .map((control) => ({
      id: control.id,
      value: control.value,
      checked: control.type === "checkbox" ? control.checked : undefined
    }));
}

function restoreControls(snapshot) {
  (snapshot.controls || []).forEach(({ id, value: savedValue, checked }) => {
    const control = $(id);
    if (!control) return;
    if (control.type === "checkbox") control.checked = Boolean(checked);
    else control.value = savedValue;
  });
  state.userCopySource = snapshot.userCopySource || "none";
  state.drugInhibition = { ...(snapshot.drugInhibition || { ttx: 0, tea: 0 }) };
  document.querySelectorAll("[data-stim-slider]").forEach((slider) => {
    const input = $(slider.dataset.stimSlider);
    if (!input) return;
    slider.value = input.value;
    syncVerticalStimulusSlider(slider);
  });
  refreshStimulusCharts();
  refreshChangedState();
  updateDrugToolbarIndicator();
  updateMembrane();
  updateRatePlots();
  Object.keys(doseCharts).forEach(updateDoseChart);
}

function snapshotRecallState(point, history, cursor = null) {
  return {
    point: { ...point },
    history: history.map((entry) => ({ ...entry })),
    adaptiveStep: state.adaptiveStep,
    stimulusTimer: state.stimulusTimer?.map((entry) => ({ ...entry })) ?? null,
    controls: snapshotControls(),
    userCopySource: state.userCopySource,
    drugInhibition: { ...state.drugInhibition },
    cursor: cursor ? {
      chart: cursor.chart === voltageChart ? "voltage" : "signal",
      datasetIndex: cursor.datasetIndex
    } : null
  };
}

function restoreRecallState(snapshot, label) {
  cancelActiveRun();
  restoreControls(snapshot);
  state.history = snapshot.history.map((entry) => ({ ...entry }));
  restoreStateFromPoint(snapshot.point);
  state.adaptiveStep = snapshot.adaptiveStep;
  state.stimulusTimer = snapshot.stimulusTimer?.map((entry) => ({ ...entry })) ?? null;
  state.stimulus = null;
  state.stimulusSettling = false;
  state.nudgeSettling = false;
  state.time = snapshot.point.time;
  state.cursor = snapshot.cursor ? {
    chart: snapshot.cursor.chart === "voltage" ? voltageChart : signalChart,
    datasetIndex: snapshot.cursor.datasetIndex,
    index: Math.max(0, state.history.length - 1),
    // The saved cursor only needs an identity; derive its display color from
    // the currently restored variable. Leaving this null painted a black
    // cursor oval over the trace after Recall, which looked like a break.
    color: "#ff8080"
  } : null;
  if (state.cursor) state.cursor.color = cursorLine()?.color || "#ff8080";
  const displayEnd = automaticViewEnd(state.time);
  draw(state.history, displayEnd);
  syncTimeline(displayEnd);
  if (state.cursor) updateCursorReadout(false);
  else $("cursorPopup").hidden = true;
  $("hint").textContent = label;
}

function stopSimulation() {
  stopContinuousRun();
  stopContinuousDrugRun();
  state.stimulusSettling = false;
  state.nudgeSettling = false;
  cancelActiveRun();
  restoreStateFromPoint(state.history.at(-1));
  $("hint").textContent = "Simulation stopped.";
}

function animateInitialPreview() {
  // hhsim.m calls run_system(0) during startup.  It does not simply draw a
  // five-ms flat line: it integrates the initial gates and membrane until the
  // normal five-ms stability test succeeds.  Preserving those computed gate
  // values is important because Stim1 begins from this state.
  const initialPoint = {
    time: 0, voltage: state.voltage, stimulus: 0,
    m: state.m, h: state.h, n: state.n,
    iNa: 0, iK: 0, iLeak: 0,
    gNa: 0, gK: 0, p: state.p, q: state.q, iUser: 0, gUser: 0, blank: null
  };
  state.history = [initialPoint];
  const solverStarted = performance.now();
  const settled = calculateRun(80, { stopWhenSettled: true });
  recordSolverTiming(performance.now() - solverStarted, settled.elapsed ?? 0);
  const preview = [...state.history, ...settled];
  state.history = preview;
  state.time = settled.elapsed ?? preview.at(-1).time;
  // Before a user has saved a cursor point, MATLAB Recall returns this
  // completed no-stimulus resting state. Capture it once; Clear may replay
  // its animation, but it must not silently replace the reference state.
  if (!state.baselineRecallState) {
    state.baselineRecallState = snapshotRecallState(state.history.at(-1), state.history);
  }
  const previewRunId = state.runId;
  // The resting trace only contains a few ms of samples, but its displayed
  // opening window is still 0--60 ms; the timeline must use that viewport.
  syncTimeline(state.duration);
  const started = performance.now();
  const duration = 450;
  const render = (now) => {
    // Any button action/reset invalidates this resting-state animation.
    if (previewRunId !== state.runId) return;
    const fraction = Math.min(1, (now - started) / duration);
    const count = Math.max(2, Math.floor(preview.length * fraction));
    draw(preview.slice(0, count), state.duration);
    if (fraction < 1) requestAnimationFrame(render);
  };
  // Draw a very short first piece immediately, then visibly extend it to the
  // stationary five-millisecond baseline.
  draw(preview.slice(0, 2), state.duration);
  requestAnimationFrame(render);
}

function calculateRun(runDuration = state.duration, { stopWhenSettled = false, settleAfter = -Infinity } = {}) {
  // Port of the integration scheme in HHsim's iterate.m: a predictor step,
  // a second derivative from that predicted state, and their average.  The
  // timestep starts at 0.1 ms, is halved for a large voltage/gate error, and
  // grows back toward that maximum when the step is quiet.
  const capacitance = Math.max(.1, value("cm"));
  const e = reversals();
  const boundGate = (gate) => Math.min(1, Math.max(0, gate));
  const pronase = $("pronase").checked;
  const userFastClone = state.userCopySource === "fast" && $("userChannel").checked;
  const userDelayedClone = state.userCopySource === "delayed" && $("userChannel").checked;
  const maxStep = pronase ? .01 : .1;
  // iterate.m has no artificial integration-step floor: it keeps halving
  // until predictor and corrector agree.  Keep only a machine-safety floor
  // far below any physiologically relevant HHsim step.
  const minStep = 1e-8;
  let dt = Math.min(maxStep, Math.max(minStep, state.adaptiveStep || maxStep));
  let local = 0;
  let model = { v: state.voltage, m: state.m, h: state.h, n: state.n, p: state.p, q: state.q };
  const points = [];
  // begin_stimulus.m builds a small timer matrix.  Its value is held for an
  // entire accepted solver step, then its duration is decremented and at most
  // one column is removed.  Do not replace this with elapsed-time ranges:
  // adaptive steps would otherwise shift the stimulus edge and spike peak.
  let stimulusTimer = state.stimulusTimer?.map((entry) => ({ ...entry })) ?? null;
  // iterate.m evaluates its stopping condition after *every accepted step*.
  // Retain the preceding display samples here so an animated browser run uses
  // exactly the same five-ms voltage-history test rather than appending
  // arbitrary two-ms continuation chunks.
  const settleSamples = state.history.slice();
  let settled = false;

  const normalizeModel = (source) => {
    const normalized = {
      v: source.v,
      m: boundGate(source.m), h: pronase ? 1 : boundGate(source.h), n: boundGate(source.n),
      p: boundGate(source.p), q: boundGate(source.q)
    };
    if (userFastClone) { normalized.p = normalized.m; normalized.q = normalized.h; }
    if (userDelayedClone) { normalized.p = normalized.n; normalized.q = 1; }
    return normalized;
  };

  const sample = (source, time, injected = 0) => {
    const current = normalizeModel(source);
    const { v, m, h, n, p, q } = current;
    const passiveNa = $("passiveNa").checked ? value("gNaLeak") * (v - e.na) : 0;
    const passiveK = $("passiveK").checked ? value("gKLeak") * (v - e.k) : 0;
    const iLeak = $("passiveCl").checked ? value("gClLeak") * (v - e.cl) : 0;
    const gNa = $("fastNa").checked
      ? value("naGmax") * Math.pow(m, value("mExponent")) * Math.pow(h, value("hExponent")) * (1 - state.drugInhibition.ttx / 100)
      : 0;
    const gK = $("delayedK").checked
      ? value("kGmax") * Math.pow(n, value("nExponent")) * (1 - state.drugInhibition.tea / 100)
      : 0;
    const activeNa = gNa * (v - ionReversal($("naIon").value, e));
    const activeK = gK * (v - ionReversal($("kIon").value, e));
    // set_drug.m assigns gmult1 only to HH_Na and gmult2 only to HH_K.
    // A user channel may copy those gate parameters, but it remains an
    // independent channel in MATLAB and must not inherit a TTX/TEA multiplier.
    const gUser = $("userChannel").checked && $("userIon").value !== "none"
      ? value("userGmax") * Math.pow(p, value("pExponent")) * Math.pow(q, value("qExponent"))
      : 0;
    const iUser = gUser * (v - ionReversal($("userIon").value, e));
    const iNa = passiveNa + activeNa;
    const iK = passiveK + activeK;
    return {
      dv: (injected - iNa - iK - iLeak - iUser) / capacitance,
      point: { time, voltage: v, stimulus: injected, m, h, n, iNa, iK, iLeak, gNa, gK, p, q, iUser, gUser, blank: null }
    };
  };

  const advanceGates = (source, step) => {
    // update_gate.m advances each gate with explicit Euler at the *current*
    // voltage.  iterate.m then calls find_dV a second time before changing
    // voltage, and averages those two gate states.  This is intentionally
    // not a conventional Heun gate update; reproducing it eliminates the
    // small but visible action-potential timing offset.
    const { v, m, h, n, p, q } = normalizeModel(source);
    const dm = alphaM(v) * (1 - m) - betaM(v) * m;
    const dh = pronase ? 0 : alphaH(v) * (1 - h) - betaH(v) * h;
    const dn = alphaN(v) * (1 - n) - betaN(v) * n;
    const dp = userFastClone ? dm : userDelayedClone ? dn : alphaP(v) * (1 - p) - betaP(v) * p;
    const dq = userFastClone ? dh : userDelayedClone ? 0 : alphaQ(v) * (1 - q) - betaQ(v) * q;
    return normalizeModel({ v, m: m + step * dm, h: h + step * dh, n: n + step * dn, p: p + step * dp, q: q + step * dq });
  };

  const findStep = (source, time, step, injected) => {
    const gates = advanceGates(source, step);
    const measured = sample(gates, time, injected);
    return { model: gates, deltaV: step * measured.dv, measured };
  };

  while (local < runDuration - 1e-9 && !settled) {
    let step = Math.min(dt, runDuration - local);
    let accepted = false;
    while (!accepted) {
      const initial = model;
      const injected = stimulusTimer?.[0]?.current ?? 0;
      const predictor = findStep(initial, state.time + local, step, injected);
      // MATLAB's second find_dV sees the first gate prediction but the
      // unchanged membrane voltage; only after both calls is V corrected.
      const correctorProbe = findStep({ ...predictor.model, v: initial.v }, state.time + local, step, injected);
      const correctedDeltaV = (predictor.deltaV + correctorProbe.deltaV) / 2;
      const corrected = normalizeModel({
        v: initial.v + correctedDeltaV,
        m: (predictor.model.m + correctorProbe.model.m) / 2,
        h: (predictor.model.h + correctorProbe.model.h) / 2,
        n: (predictor.model.n + correctorProbe.model.n) / 2,
        p: (predictor.model.p + correctorProbe.model.p) / 2,
        q: (predictor.model.q + correctorProbe.model.q) / 2
      });
      const voltageError = Math.abs(predictor.deltaV - correctedDeltaV) / step;
      const gateError = Math.abs(predictor.model.n - corrected.n);
      if ((voltageError > 30 || gateError > .01) && step > minStep) {
        step = Math.max(minStep, step / 2);
        continue;
      }
      model = corrected;
      local += step;
      // iterate.m records the current timer value before decrementing its
      // duration, so the displayed purple trace uses the same step-held
      // amplitude as the voltage update above.
      const point = sample(model, state.time + local, injected).point;
      points.push(point);
      settleSamples.push(point);
      dt = voltageError < 10 && gateError < .003 ? Math.min(maxStep, step * 2) : step;
      accepted = true;

      // This is the MATLAB iterate.m terminal condition in this port's mV
      // units: after the stimulus timer finishes, the current V_m must be
      // within 1 mV of every saved value in the preceding five milliseconds.
      // It intentionally happens inside the integration loop—not after a
      // fixed browser animation segment.
      const sampleTime = state.time + local;
      const timerComplete = !stimulusTimer
        || (stimulusTimer.length === 1 && stimulusTimer[0].current === 0);
      if (stopWhenSettled && sampleTime >= settleAfter && timerComplete) {
        const windowStart = sampleTime - 5;
        let first = 0;
        while (first < settleSamples.length && settleSamples[first].time < windowStart) first += 1;
        const window = settleSamples.slice(first);
        if (window.length >= 2 && window[0].time <= windowStart + .1) {
          const maxVoltageDrift = Math.max(...window.map((entry) => Math.abs(entry.voltage - point.voltage)));
          const maxStimulus = Math.max(...window.map((entry) => Math.abs(entry.stimulus)));
          settled = maxVoltageDrift < 1 && maxStimulus < 1e-8;
        }
      }

      // MATLAB removes no more than one expired timer entry per accepted
      // integration step—even a zero-duration lead entry—so mirror that
      // legacy behavior exactly.
      if (stimulusTimer?.length) {
        stimulusTimer[0].remaining -= step;
        if (stimulusTimer[0].remaining <= 0 && stimulusTimer.length > 1) stimulusTimer.shift();
      }
    }
  }
  state.adaptiveStep = dt;
  state.voltage = model.v; state.m = model.m; state.h = model.h; state.n = model.n; state.p = model.p; state.q = model.q;
  state.stimulusTimer = stimulusTimer;
  // Callers animate only the samples actually integrated. A stimulus that
  // reaches equilibrium at 22.6 ms therefore ends there rather than at the
  // requested safety horizon.
  points.elapsed = local;
  return points;
}

function runSimulation(runDuration = state.duration, options = {}) {
  // A throttled embedded browser can leave an old animation pending. Never
  // discard a new Run/Stim click because of that stale frame. Resume from the
  // last drawn point, rather than from calculateRun's hidden final state.
  if (state.running) {
    const visiblePoint = state.history.at(-1);
    cancelActiveRun();
    restoreStateFromPoint(visiblePoint);
  }
  if (!hasUsableSimulationState()) resetSimulation();
  // The startup/clear resting trace is already drawn through 5 ms while the
  // simulator is still at t = 0. Begin any real run at that endpoint so it
  // extends, rather than overwriting the baseline.
  const existingEndpoint = state.history.at(-1);
  if (existingEndpoint && existingEndpoint.time > state.time) restoreStateFromPoint(existingEndpoint);
  state.running = true;
  const runId = ++state.runId;
  const before = state.history.slice();
  let segment;
  try {
    const solverStarted = performance.now();
    segment = calculateRun(runDuration, options);
    recordSolverTiming(performance.now() - solverStarted, segment.elapsed ?? 0);
  } catch (error) {
    console.error("HHsim could not start the simulation.", error);
    state.running = false;
    return;
  }
  if (!segment.length) { state.running = false; return; }

  const started = performance.now();
  // The first, user-initiated pass remains slow enough to inspect.  HHsim's
  // subsequent iterate.m passes are computational rather than animations;
  // render those brief settling passes quickly so a one-click stimulus does
  // not look like an endless run.
  const actualDuration = segment.elapsed ?? runDuration;
  const ms = options.animationMs ?? Math.max(400, actualDuration * 15);
  let completed = false;
  const complete = () => {
    if (completed || runId !== state.runId) return;
    completed = true;
    cancelAnimationFrame(state.animation);
    clearTimeout(state.completionTimer);
    state.history = [...before, ...segment];
    state.time += actualDuration;
    state.running = false;
    const displayEnd = automaticViewEnd(state.history.at(-1).time);
    draw(state.history, displayEnd);
    syncTimeline(displayEnd);
    $("hint").textContent = `Simulation complete: ${fixed(state.time)} ms.`;
    if ((state.continuousDrugRun || state.stimulusSettling || state.nudgeSettling) && runId === state.runId) {
      const stimulusTimerComplete = !state.stimulusTimer
        || (state.stimulusTimer.length === 1 && state.stimulusTimer[0].current === 0);
      // iterate.m stops as soon as its five-millisecond voltage history is
      // stable *and* the stimulus timer has only its final zero-current
      // entry.  drugTraceIsSettled already tests that five-ms window, so do
      // not append another five quiet milliseconds here.
      const traceIsSettled = drugTraceIsSettled(state.history);
      const stimulusReady = !state.stimulusSettling || (stimulusTimerComplete && traceIsSettled);
      const drugReady = !state.continuousDrugRun || traceIsSettled;
      const nudgeReady = !state.nudgeSettling || (state.time >= state.nudgeTargetTime && traceIsSettled);
      if (stimulusReady && drugReady && nudgeReady) {
        const settledDrug = state.continuousDrugRun;
        const settledStimulus = state.stimulusSettling;
        const settledNudge = state.nudgeSettling;
        state.continuousDrugRun = false;
        state.stimulusSettling = false;
        state.nudgeSettling = false;
        state.stimulus = null;
        state.stimulusTimer = null;
        $("hint").textContent = settledDrug
          ? `Drug adjustment settled at ${fixed(state.time)} ms.`
          : settledStimulus
            ? `Stimulus settled at ${fixed(state.time)} ms.`
            : settledNudge
              ? `Nudge settled at ${fixed(state.time)} ms.`
              : `Simulation settled at ${fixed(state.time)} ms.`;
      } else {
        state.continuationTimer = setTimeout(() => {
          state.continuationTimer = null;
          if ((state.continuousDrugRun || state.stimulusSettling || state.nudgeSettling) && !state.running) {
            runSimulation(2, { animationMs: 35, quick: true });
          }
        }, 0);
      }
    } else if (state.continuousRun && runId === state.runId) {
      state.continuationTimer = setTimeout(() => {
        state.continuationTimer = null;
        if (state.continuousRun && !state.running) runSimulation(state.duration);
      }, 0);
    }
  };
  // Show a trace synchronously. This makes the first button press responsive
  // even in a browser that delays its first animation frame.
  // A meaningful initial slice makes the very first click visibly respond,
  // including the default one-millisecond Stim1/Stim2 pulse.
  const initialCount = Math.min(segment.length, Math.max(2, Math.ceil(segment.length * .2)));
  const initial = [...before, ...segment.slice(0, initialCount)];
  state.history = initial;
  draw(initial, automaticViewEnd(initial.at(-1).time));
  const animate = (now) => {
    if (completed || runId !== state.runId) return;
    const fraction = Math.min(1, (now - started) / ms);
    const count = Math.max(initialCount, Math.floor(segment.length * fraction));
    const visible = [...before, ...segment.slice(0, count)];
    const end = visible.at(-1).time;
    // Keep the click-readout data current while the animated trace is drawn.
    state.history = visible;
    const displayEnd = automaticViewEnd(end);
    draw(visible, displayEnd);
    syncTimeline(displayEnd);
    if (fraction < 1) { state.animation = requestAnimationFrame(animate); return; }
    complete();
  };
  // Some embedded local-file views throttle requestAnimationFrame until after
  // the initial click. Always commit the completed run as a safe fallback.
  state.completionTimer = setTimeout(complete, ms + (options.quick ? 30 : 120));
  try {
    state.animation = requestAnimationFrame(animate);
  } catch (error) {
    console.warn("HHsim animation frame unavailable; displaying the completed run.", error);
    complete();
  }
}

function drugTraceIsSettled(points) {
  const latest = points.at(-1);
  if (!latest) return false;
  // Match HHsim's iterate.m stopping rule: compare V_m against every sample
  // in the preceding five milliseconds and require that no stimulus remains.
  // MATLAB stores V in volts, so its Vchange < 1e-3 is a *one-millivolt*
  // condition.  This port stores V in millivolts; using .001 here made the
  // browser demand a thousand-times tighter convergence and could keep a
  // one-click stimulus stepping beyond 100 ms.
  const windowStart = latest.time - 5;
  const sample = points.filter((point) => point.time >= windowStart);
  if (sample.length < 8 || sample[0].time > windowStart + .1) return false;
  const maxVoltageDrift = Math.max(...sample.map((point) => Math.abs(point.voltage - latest.voltage)));
  const maxStimulus = Math.max(...sample.map((point) => Math.abs(point.stimulus)));
  return maxVoltageDrift < 1 && maxStimulus < 1e-8;
}

function redrawTraceForDrugChange() {
  const lastPoint = state.history.at(-1);
  stopContinuousRun();
  stopContinuousDrugRun();
  state.nudgeSettling = false;
  cancelActiveRun();
  // Drug changes take effect immediately at the current endpoint and advance
  // in short segments until the new membrane state reaches equilibrium.
  if (lastPoint) restoreStateFromPoint(lastPoint);
  else resetSimulation();
  state.continuousDrugRun = true;
  // graph_select.m (and a committed drug text box) calls run_system(1), not
  // run_system(0): MATLAB therefore advances for *at least* two milliseconds
  // before it is even allowed to use the five-ms equilibrium test. Without
  // that nudge_time floor, an old stable history lets the browser terminate
  // after one 0.1-ms step and barely show the drug response.
  const nudgeCompleteAt = state.time + 2;
  runSimulation(80, {
    stopWhenSettled: true,
    settleAfter: nudgeCompleteAt,
    animationMs: 650
  });
}

function queueDrugRedraw() {
  if (state.applyingDrugReset) return;
  clearTimeout(state.drugUpdateTimer);
  state.drugUpdateTimer = setTimeout(() => {
    state.drugUpdateTimer = null;
    redrawTraceForDrugChange();
  }, 0);
}

function selectStimulus(which) {
  state.stimulus = which;
  state.stimulusStart = state.time;
  // Exact begin_stimulus.m timer sequence: current in the first row and its
  // duration in the second.  calculateRun advances it after accepted steps.
  state.stimulusTimerLead = 0;
  state.stimulusTimer = [
    { current: 0, remaining: value(`s${which}start`) },
    { current: value(`s${which}amp`), remaining: value(`s${which}dur`) },
    { current: 0, remaining: value(`s${which}repeat`) },
    { current: value(`s${which}amp2`), remaining: value(`s${which}dur2`) },
    { current: 0, remaining: Infinity }
  ];
  state.stimulusSettling = true;
  const waveform = stimulusPatternLength(which);
  $("hint").textContent = `Stim${which} selected — ${fixed(waveform)} ms waveform, then settling.`;
}

function continueStimulus(which) {
  // A browser can occasionally emit a duplicated click as focus changes on
  // the footer control. Treat that as the same press; a later deliberate
  // click still creates one new, independent stimulus segment.
  const now = performance.now();
  if (state.stimulusRunLock.which === which && now - state.stimulusRunLock.time < 120) return;
  state.stimulusRunLock = { which, time: now };
  stopContinuousRun();
  stopContinuousDrugRun();
  state.stimulusSettling = false;
  state.nudgeSettling = false;
  // During an active animation, calculateRun has already advanced the hidden
  // model. Continue from the visible endpoint instead of replaying its start.
  if (state.running) {
    const visiblePoint = state.history.at(-1);
    cancelActiveRun();
    restoreStateFromPoint(visiblePoint);
  }
  if (!hasUsableSimulationState()) resetSimulation();
  selectStimulus(which);
  // MATLAB does not run a preset post-pulse interval. Its iterate loop checks
  // the five-ms voltage-history criterion after every accepted solver step
  // and stops immediately once it has settled. Give the web solver a generous
  // safety horizon, but let that source-matched condition choose the endpoint.
  runSimulation(80, { stopWhenSettled: true, animationMs: 650 });
}

function preserveStateForParameterChange() {
  // Do not jump the membrane to the new equilibrium. The next Run starts from
  // its present V_m and integrates C_m dV/dt = −Σg_i(V_m−E_i) + I_stim.
  // This makes channel/concentration changes visible as a voltage transient.
  const target = equilibrium();
  $("hint").textContent = Number.isFinite(target)
    ? `${state.running ? "New settings will apply on the next Run" : "New passive equilibrium"}: ${fixed(target)} mV.`
    : "No passive channels selected. Press Run to hold the current voltage.";
}

const rateCharts = {};
function makeRateChart(canvasId) {
  return new Chart($(canvasId), {
    type: "line",
    data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { ratePlotBackground: { color: "#d7d900" }, title: { display: true, text: "alpha, beta", color: "#eee", font: { size: 14, weight: "bold" } }, legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { type: "linear", min: -90, max: 80, grid: { color: "rgba(255,255,255,.38)" }, border: { color: "#eee", width: 2 }, ticks: { color: "#eee", autoSkip: false }, afterBuildTicks: (axis) => { axis.ticks = [-50, 0, 50].map((value) => ({ value })); }, title: { display: true, text: "Vₘ", color: "#eee", font: { weight: "bold" } } },
        y: { min: -.1, max: 2, grid: { color: "rgba(255,255,255,.38)" }, border: { color: "#eee", width: 2 }, ticks: { color: "#eee", autoSkip: false }, afterBuildTicks: (axis) => { axis.ticks = [0, .5, 1, 1.5, 2].map((value) => ({ value })); }, title: { display: true, text: "msec⁻¹", color: "#eee", font: { weight: "bold" } } }
      }
    }
  });
}

function updateRatePlots() {
  ["m", "h", "n", "p", "q"].forEach((gate) => {
    const chart = rateCharts[gate];
    if (!chart) return;
    const alpha = [], beta = [];
    for (let v = -90; v <= 80; v += 1) {
      alpha.push({ x: v, y: rate(gate, "Alpha", v) });
      beta.push({ x: v, y: rate(gate, "Beta", v) });
    }
    // HHsim's alpha/beta panes retain the same visible 0--2 msec^-1 scale.
    // Values outside it are intentionally clipped at the plot edge.
    chart.options.scales.y.min = -.1;
    chart.options.scales.y.max = 2;
    chart.data.datasets = [
      { data: alpha, borderColor: "#ed1717", borderWidth: 2, pointRadius: 0 },
      { data: beta, borderColor: "#3457de", borderWidth: 2, pointRadius: 0 }
    ];
    chart.update("none");
  });
}

function addClickSteppers() {
  document.querySelectorAll("input.number").forEach((input) => {
    if (input.parentElement.classList.contains("stepper")) return;
    const wrapper = document.createElement("span");
    wrapper.className = "stepper";
    input.before(wrapper); wrapper.append(input);
    if (input.id.endsWith("Th")) input.step = "1";
    if (input.id.endsWith("S") || input.id.endsWith("C")) input.step = "0.01";
    const up = document.createElement("button"), down = document.createElement("button");
    up.type = down.type = "button";
    up.className = "step-up"; down.className = "step-down";
    up.textContent = "▲"; down.textContent = "▼";
    const step = (direction) => {
      const increment = Number(input.step) || (Math.abs(Number(input.value)) < 1 ? 0.001 : 1);
      try { direction > 0 ? input.stepUp() : input.stepDown(); }
      catch { input.value = String(Number(input.value || 0) + direction * increment); }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    up.onclick = () => step(1); down.onclick = () => step(-1);
    wrapper.append(up, down);
  });
}

function hasChangedFromDefault(control) {
  if (control.type === "checkbox") return control.checked !== control.defaultChecked;
  if (control.type === "number") return Number(control.value) !== Number(control.defaultValue);
  // An HTML select's first option is its default even when it does not carry
  // a `selected` attribute. Compare against that option (or an explicitly
  // selected default) so default alpha/beta functions stay unhighlighted.
  if (control.tagName === "SELECT") {
    const defaultOption = Array.from(control.options).find((option) => option.defaultSelected) || control.options[0];
    return control.value !== defaultOption.value;
  }
  return control.value !== control.defaultValue;
}

function refreshChangedState(scope = document) {
  scope.querySelectorAll("input, select").forEach((control) => {
    // The original User Channel editor keeps its editable controls neutral;
    // changed-value red highlighting applies to the other panels only.
    const isUserChannelControl = Boolean(control.closest("#userChannelDetails"));
    control.classList.toggle("changed", !isUserChannelControl && hasChangedFromDefault(control));
  });
}

function updateDrugToolbarIndicator() {
  const changed = Array.from($("drugs").querySelectorAll("input, select"))
    .some((control) => hasChangedFromDefault(control));
  document.querySelector('[data-dialog="drugs"]').classList.toggle("has-changes", changed);
}

function formatMembraneNumbers() {
  document.querySelectorAll(".membrane-sidebar input.number").forEach((input) => {
    if (Number.isFinite(Number(input.value))) input.value = fixed(Number(input.value), 1);
  });
}

document.querySelectorAll("[data-dialog]").forEach((button, index) => button.onclick = () => {
  const dialog = $(button.dataset.dialog);
  // Toolbar buttons are the check marks in the original app: clicking a
  // checked one hides its corresponding editor instead of leaving a detached
  // floating panel behind.
  if (dialog.open) { dialog.close(); return; }
  dialog.style.left = `${28 + index * 34}px`;
  dialog.style.top = `${72 + index * 26}px`;
  dialog.show();
  button.classList.add("panel-open");
  dialog.style.zIndex = String(10 + index);
  if (dialog.classList.contains("channel-details")) requestAnimationFrame(updateRatePlots);
  if (dialog.id === "drugs") {
    // Charts are initialized while their dialog is hidden. Resize after the
    // browser has laid the fixed MATLAB-sized panel out, otherwise Chart.js
    // can retain a small hidden-canvas plot rectangle.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      Object.entries(doseCharts).forEach(([drug, chart]) => {
        chart.resize();
        updateDoseChart(drug);
      });
    }));
  }
});
document.querySelectorAll(".close").forEach((button) => button.onclick = () => button.closest("dialog").close());
$("closeCursorPopup").onclick = () => {
  $("cursorPopup").hidden = true;
  state.cursor = null;
  $("readout").textContent = "Click any line to set the cursor and measure that point.";
  redrawCursor();
};
$("cursorVar").onclick = () => moveCursor(0);
$("cursorFarLeft").onclick = () => moveCursor(-2);
$("cursorLeft").onclick = () => moveCursor(-1);
$("cursorRight").onclick = () => moveCursor(1);
$("cursorFarRight").onclick = () => moveCursor(2);
$("cursorSave").onclick = () => {
  const point = state.cursor && state.history[state.cursor.index];
  if (!point) return;
  // Match store_state.m: Save records the selected gates/membrane point and
  // the active experimental controls, not just the visible graph location.
  state.savedCursorState = snapshotRecallState(
    point,
    state.history.slice(0, state.cursor.index + 1),
    state.cursor
  );
  $("hint").textContent = `Saved state at ${fixed(point.time)} ms for Recall.`;
};
document.querySelectorAll(".hide-panel").forEach((button) => button.onclick = () => button.closest("dialog").close());
document.querySelectorAll("dialog").forEach((dialog) => dialog.addEventListener("close", () => {
  document.querySelector(`[data-dialog="${dialog.id}"]`)?.classList.remove("panel-open");
}));
document.querySelectorAll(".reset-panel").forEach((button) => button.onclick = () => {
  const panel = button.closest("dialog");
  if (panel.id === "drugs") {
    state.applyingDrugReset = true;
    stopContinuousDrugRun();
    cancelActiveRun();
  }
  const panels = panel.id === "channels"
    ? [panel, $("fastSodiumDetails"), $("delayedKDetails"), $("userChannelDetails")]
    : [panel];
  panels.forEach((target) => target.querySelectorAll("input, select").forEach((control) => {
    if (control.type === "checkbox") {
      control.checked = control.defaultChecked;
    } else if (control.tagName === "SELECT") {
      const defaultOption = Array.from(control.options).find((option) => option.defaultSelected) || control.options[0];
      control.value = defaultOption.value;
    } else {
      control.value = control.defaultValue;
    }
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }));
  if (panel.id === "voltageClamp") {
    state.vcSelected = 2;
    panel.querySelector(`.vc-select[value="${state.vcSelected}"]`).checked = true;
    $("vcParameterLabel").textContent = `${vcControlDefinitions[state.vcSelected][1]}:`;
    $("vcVarValues").value = $(vcControlDefinitions[state.vcSelected][0]).value;
    state.vcCurves = [];
    state.vcCursor = null;
    updateVoltageClampProtocol();
    if (state.recordingMode === "clamp") renderVoltageClampCurves();
  }
  panels.forEach((target) => {
    if (target.id === "membrane") formatMembraneNumbers();
    refreshChangedState(target);
  });
  if (panels.some((target) => target.id === "userChannelDetails")) state.userCopySource = "none";
  state.applyingDrugReset = false;
  updateDrugToolbarIndicator();
  updateMembrane(); updateRatePlots();
});

// Floating panels stay open while the plot animates and can be repositioned
// by dragging their title bars.
document.querySelectorAll("dialog").forEach((dialog) => {
  const title = dialog.querySelector(".dialog-title");
  let startX, startY, originLeft, originTop;
  title.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".close")) return;
    startX = event.clientX; startY = event.clientY;
    originLeft = dialog.offsetLeft; originTop = dialog.offsetTop;
    title.setPointerCapture(event.pointerId);
  });
  title.addEventListener("pointermove", (event) => {
    if (startX === undefined) return;
    dialog.style.left = `${Math.max(0, originLeft + event.clientX - startX)}px`;
    dialog.style.top = `${Math.max(0, originTop + event.clientY - startY)}px`;
  });
  title.addEventListener("pointerup", () => { startX = undefined; });
});
document.querySelectorAll(".concentration, #temperature, #passiveNa, #passiveK, #passiveCl, #gNaLeak, #gKLeak, #gClLeak").forEach((input) => {
  input.addEventListener("input", () => { refreshChangedState($("membrane")); refreshChangedState($("channels")); updateMembrane(); if (input.id === "temperature") updateRatePlots(); preserveStateForParameterChange(); });
  input.addEventListener("change", () => { formatMembraneNumbers(); refreshChangedState($("membrane")); refreshChangedState($("channels")); updateMembrane(); if (input.id === "temperature") updateRatePlots(); preserveStateForParameterChange(); });
});
buildPulseControls(1); buildPulseControls(2);
buildVoltageClampControls();
updateVoltageClampProtocol();
document.querySelectorAll(".stimulus-input").forEach((input) => input.addEventListener("input", () => { refreshStimulusCharts(); preserveStateForParameterChange(); }));
document.querySelectorAll("[data-stim-adjust]").forEach((button) => button.addEventListener("click", () => changeStimulusControl(button)));
document.querySelectorAll("[data-stim-slider]").forEach((slider) => slider.addEventListener("input", () => {
  syncVerticalStimulusSlider(slider);
  const input = $(slider.dataset.stimSlider);
  input.value = slider.value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}));
document.querySelectorAll("#ttx, #tea").forEach((input) => {
  // Input is deliberately presentation-only: it lets users erase a digit
  // and type a multi-digit percentage without advancing the simulation.
  input.addEventListener("input", () => {
    refreshChangedState($("drugs"));
    updateDrugToolbarIndicator();
  });
  input.addEventListener("change", () => {
    applyDrugValue(input.id, input.value, { preserveText: true });
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyDrugValue(input.id, input.value, { preserveText: true });
      input.blur();
    }
  });
});
document.querySelectorAll("#signal1, #signal2, #signal3").forEach((input) => input.addEventListener("change", () => draw(state.history, Number($("timeWindow").value))));
document.querySelectorAll("[data-mode]").forEach((button) => button.onclick = () => {
  document.querySelectorAll("[data-mode]").forEach((b) => b.classList.remove("active"));
  button.classList.add("active");
  state.mode = button.dataset.mode;
  [voltageChart, signalChart].forEach((chart) => {
    chart.canvas.style.cursor = state.mode === "zoom" ? "crosshair" : state.mode === "pan" ? "grab" : "default";
  });
  $("zoomHint").hidden = state.mode !== "zoom";
  $("panHint").hidden = state.mode !== "pan";
  if (state.mode !== "zoom") hideZoomMenu();
  if (state.mode === "pan") {
    // Clear an old fixed-ruler translation: Pan now moves the numeric axes.
    state.plotOffset = { voltage: 0, signal: 0 };
    if (state.history.length) draw(state.history, state.viewEnd);
    $("hint").textContent = "Drag up or down to pan the y-axis values smoothly.";
  }
  if (state.mode === "zoom") $("hint").textContent = "Click either graph to zoom in around that time.";
});
document.querySelectorAll(".channel-param, .rate-form, #naIon, #kIon, #userIon, #pronase, #fastNa, #delayedK").forEach((input) => {
  const detachUserCopyIfEdited = () => {
    if (state.applyingUserCopy || !input.closest("#userChannelDetails")) return;
    state.userCopySource = "none";
    $("copyUserParameters").value = "none";
  };
  input.addEventListener("input", () => { detachUserCopyIfEdited(); refreshChangedState(input.closest("dialog") || document); updateDrugToolbarIndicator(); if (input.id === "pronase") queueDrugRedraw(); updateRatePlots(); preserveStateForParameterChange(); });
  input.addEventListener("change", () => { detachUserCopyIfEdited(); refreshChangedState(input.closest("dialog") || document); updateDrugToolbarIndicator(); if (input.id === "pronase") queueDrugRedraw(); updateRatePlots(); preserveStateForParameterChange(); });
});
$("userChannel").addEventListener("change", () => {
  console.info(`[HHsim] User Channel: ${$("userChannel").checked ? "selected" : "deselected"}.`);
  preserveStateForParameterChange();
});

function copyGate(source, destination) {
  ["Exponent", "AlphaForm", "AlphaC", "AlphaTh", "AlphaS", "BetaForm", "BetaC", "BetaTh", "BetaS"].forEach((suffix) => {
    $(`${destination}${suffix}`).value = $(`${source}${suffix}`).value;
  });
}

function notifyCopiedControls() {
  $("userChannel").checked = true;
  $("userChannel").dispatchEvent(new Event("change", { bubbles: true }));
  $("userChannelDetails").querySelectorAll(".channel-param, .rate-form, #userIon").forEach((control) => {
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

$("copyUserParameters").addEventListener("change", () => {
  const preset = $("copyUserParameters").value;
  state.userCopySource = preset;
  state.applyingUserCopy = true;
  if (preset === "fast") {
    $("userIon").value = $("naIon").value;
    $("userGmax").value = $("naGmax").value;
    copyGate("m", "p"); copyGate("h", "q");
    state.p = state.m;
    state.q = state.h;
  } else if (preset === "delayed") {
    $("userIon").value = $("kIon").value;
    $("userGmax").value = $("kGmax").value;
    copyGate("n", "p");
    $("qExponent").value = "0";
    ["Alpha", "Beta"].forEach((direction) => {
      $(`q${direction}Form`).value = "none";
      ["C", "Th", "S"].forEach((suffix) => { $(`q${direction}${suffix}`).value = "0"; });
    });
    state.p = state.n;
    state.q = 1;
  }
  if (preset !== "none") {
    notifyCopiedControls();
    refreshChangedState($("userChannelDetails"));
    updateRatePlots(); preserveStateForParameterChange();
  }
  state.applyingUserCopy = false;
});

$("run").addEventListener("click", (event) => {
  event.preventDefault();
  if (state.recordingMode === "clamp") {
    runVoltageClamp();
    return;
  }
  stopContinuousDrugRun();
  state.nudgeSettling = false;
  state.stimulusSettling = false;
  state.continuousRun = true;
  runSimulation();
});
$("stim1").addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); continueStimulus(1); });
$("stim2").addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); continueStimulus(2); });
$("nudge").addEventListener("click", (event) => {
  event.preventDefault();
  // run_system(1) advances at least 2 ms, then continues only until the
  // trace is stable.  It always starts at the visible endpoint.
  stopContinuousRun();
  stopContinuousDrugRun();
  state.stimulusSettling = false;
  state.nudgeSettling = true;
  state.nudgeTargetTime = Math.max(state.time, state.history.at(-1)?.time || 0) + 2;
  runSimulation(2);
});
$("stop").addEventListener("click", (event) => { event.preventDefault(); stopSimulation(); });
$("clear").onclick = () => {
  if (state.recordingMode === "clamp") {
    state.vcCurves = [];
    state.vcCursor = null;
    renderVoltageClampCurves();
    $("hint").textContent = "Cleared voltage-clamp curves.";
    return;
  }
  stopContinuousRun();
  stopContinuousDrugRun();
  cancelActiveRun();
  resetSimulation();
  // Clearing returns HHsim to the same visible resting-state animation used
  // on a fresh load without integrating an extra, spurious spike.
  animateInitialPreview();
  $("hint").textContent = "Cleared to the resting state.";
};
$("recall").onclick = () => {
  stopContinuousRun(); stopContinuousDrugRun();
  if (state.savedCursorState) {
    restoreRecallState(state.savedCursorState, `Recalled saved state at ${fixed(state.savedCursorState.point.time)} ms.`);
  } else if (state.baselineRecallState) {
    restoreRecallState(state.baselineRecallState, "Recalled the baseline resting state.");
  }
};

function printWithWhiteBackground() {
  const charts = [voltageChart, signalChart];
  const snapshots = charts.map((chart) => ({
    chart,
    tickX: chart.options.scales.x.ticks.color,
    tickY: chart.options.scales.y.ticks.color,
    titleX: chart.options.scales.x.title.color,
    titleY: chart.options.scales.y.title.color,
    gridX: chart.options.scales.x.grid.color,
    gridY: chart.options.scales.y.grid.color,
    borderX: chart.options.scales.x.border.color,
    borderY: chart.options.scales.y.border.color,
    colors: chart.data.datasets.map((dataset) => dataset.borderColor)
  }));
  const restore = () => {
    document.body.classList.remove("print-mode");
    snapshots.forEach(({ chart, tickX, tickY, titleX, titleY, gridX, gridY, borderX, borderY, colors }) => {
      chart.options.scales.x.ticks.color = tickX; chart.options.scales.y.ticks.color = tickY;
      chart.options.scales.x.title.color = titleX; chart.options.scales.y.title.color = titleY;
      chart.options.scales.x.grid.color = gridX; chart.options.scales.y.grid.color = gridY;
      chart.options.scales.x.border.color = borderX; chart.options.scales.y.border.color = borderY;
      chart.data.datasets.forEach((dataset, index) => { dataset.borderColor = colors[index]; });
      chart.update("none");
    });
  };
  document.body.classList.add("print-mode");
  charts.forEach((chart) => {
    chart.options.scales.x.ticks.color = "#111"; chart.options.scales.y.ticks.color = "#111";
    chart.options.scales.x.title.color = "#111"; chart.options.scales.y.title.color = "#111";
    chart.options.scales.x.grid.color = "rgba(0,0,0,.18)"; chart.options.scales.y.grid.color = "rgba(0,0,0,.18)";
    chart.options.scales.x.border.color = "#111"; chart.options.scales.y.border.color = "#111";
    chart.data.datasets.forEach((dataset) => {
      if (dataset.borderColor === "#e7e800") dataset.borderColor = "#777500";
    });
    chart.update("none");
  });
  window.addEventListener("afterprint", restore, { once: true });
  requestAnimationFrame(() => window.print());
}

function csvNumber(number) {
  return Number.isFinite(number) ? String(Number(number.toFixed(6))) : "";
}

function exportSimulationCsv() {
  const signals = chosenSignals();
  const colorNames = ["yellow", "green", "blue"];
  const signalColumns = signals.map((signal, index) => ({
    name: `${colorNames[index]}_${signal.label.replace(/[^a-zA-Z0-9]+/g, "_")}${signal.unit ? `_${signal.unit.replace(/[^a-zA-Z0-9]+/g, "_")}` : ""}`,
    value: (point) => signal.blank ? "" : csvNumber(signal.convert ? signal.convert(point[signal.key]) : point[signal.key])
  }));
  // Chart order is retained in the export: red membrane voltage, purple
  // stimulus, then the yellow/green/blue selected signal curves.
  const header = ["time_msec", "red_membrane_voltage_mV", "purple_stimulus_nA", ...signalColumns.map((column) => column.name)];
  const rows = state.history.map((point) => [
    csvNumber(point.time), csvNumber(point.voltage), csvNumber(point.stimulus),
    ...signalColumns.map((column) => column.value(point))
  ].join(","));
  const blob = new Blob([[header.join(","), ...rows].join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = "hhsim-curves.csv";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  $("hint").textContent = `Exported ${state.history.length} samples as hhsim-curves.csv.`;
}

$("print").onclick = printWithWhiteBackground;
$("export").onclick = exportSimulationCsv;
$("help").onclick = () => window.open("https://www.cs.cmu.edu/~dst/HHsim/", "_blank", "noopener");

function updateProtocolPanelButton(clampMode) {
  const button = $("protocolPanelButton");
  if (!button) return;
  button.dataset.dialog = clampMode ? "voltageClamp" : "stimuli";
  const label = Array.from(button.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.nodeValue.trim());
  if (label) label.nodeValue = clampMode ? "VClamp" : "Stimuli";
  if (!clampMode) button.classList.remove("panel-open");
}

function setRecordingMode() {
  const clampMode = $("record").value === "clamp";
  state.recordingMode = clampMode ? "clamp" : "voltage";
  document.body.classList.toggle("clamp-mode", clampMode);
  $("clampStatus").hidden = !clampMode;
  updateProtocolPanelButton(clampMode);
  ["stim1", "stim2", "nudge", "recall"].forEach((id) => { $(id).disabled = clampMode; });
  if (clampMode) {
    stopContinuousRun();
    stopContinuousDrugRun();
    cancelActiveRun();
    $("cursorPopup").hidden = true;
    state.cursor = null;
    state.vcCurves = [];
    state.vcCursor = null;
    updateVoltageClampProtocol();
    renderVoltageClampCurves();
    requestAnimationFrame(() => {
      voltageChart.resize(); signalChart.resize();
      voltageChart.update("none"); signalChart.update("none");
    });
    const dialog = $("voltageClamp");
    if (!dialog.open) {
      dialog.style.left = "max(12px, calc(50vw - 300px))";
      dialog.style.top = "18px";
      dialog.show();
    }
    $("protocolPanelButton").classList.add("panel-open");
    $("hint").textContent = "Voltage Clamp selected. Choose a protocol parameter and press Run.";
    return;
  }
  if ($("voltageClamp").open) $("voltageClamp").close();
  state.vcCursor = null;
  signalChart.options.layout = { padding: { left: 46 } };
  state.plotOffset = { voltage: 0, signal: 0 };
  resetSimulation();
  animateInitialPreview();
  $("hint").textContent = "Voltage Recording selected.";
}
$("record").addEventListener("change", setRecordingMode);
$("timeWindow").oninput = () => {
  const center = value("timeWindow");
  if (state.recordingMode === "clamp") {
    setVoltageClampXWindow(center);
    return;
  }
  if (!state.history.length) return;
  setZoomWindow(center - state.viewSpan / 2, center + state.viewSpan / 2);
};
$("timelineBack").addEventListener("click", () => {
  if (!state.history.length) return;
  const nextEnd = state.viewEnd - state.viewSpan * .2;
  setZoomWindow(nextEnd - state.viewSpan, nextEnd);
});
$("timelineForward").addEventListener("click", () => {
  if (!state.history.length) return;
  const nextEnd = state.viewEnd + state.viewSpan * .2;
  setZoomWindow(nextEnd - state.viewSpan, nextEnd);
});

// Pan mode supports both direct graph dragging and dragging the timeline
// viewport.  The timeline implementation moves only the x-scale window, so
// it has the same "move the scale" feel as the MATLAB slider.
function installTimelinePan() {
  const track = $("timeTrack");
  let drag = null;
  const end = (event) => {
    if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
    try {
      if (track.hasPointerCapture?.(drag.pointerId)) track.releasePointerCapture(drag.pointerId);
    } catch {
      // Capture may have been released outside the timeline.
    }
    drag = null;
  };
  const move = (event) => {
    if (!drag) return;
    if (state.mode !== "pan" || event.pointerId !== drag.pointerId || (event.buttons & 1) === 0) {
      end(event);
      return;
    }
    const shift = ((event.clientX - drag.clientX) / drag.width) * state.viewSpan * .35;
    const center = Math.round(drag.center - shift);
    setZoomWindow(center - state.viewSpan / 2, center + state.viewSpan / 2);
  };
  track.addEventListener("pointerdown", (event) => {
    if (state.mode !== "pan" || event.button !== 0 || !state.history.length) return;
    end();
    const bounds = track.getBoundingClientRect();
    drag = { pointerId: event.pointerId, clientX: event.clientX, width: Math.max(1, bounds.width), center: state.viewEnd - state.viewSpan / 2 };
    track.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    move(event);
  });
  track.addEventListener("pointermove", move);
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);
  track.addEventListener("lostpointercapture", end);
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
  window.addEventListener("blur", () => end());
}
installTimelinePan();

addClickSteppers();
formatMembraneNumbers();
refreshChangedState();
rateCharts.m = makeRateChart("mRateChart");
rateCharts.h = makeRateChart("hRateChart");
rateCharts.n = makeRateChart("nRateChart");
rateCharts.p = makeRateChart("pRateChart");
rateCharts.q = makeRateChart("qRateChart");
refreshStimulusCharts(); updateRatePlots(); updateMembrane(); resetSimulation();
// Fresh loads visibly extend to the resting baseline. The pre-run model clock
// stays at zero, preserving original Stim1/Stim2 timing.
animateInitialPreview();
updateDrugToolbarIndicator();
