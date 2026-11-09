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
  // Keep a growing trace pinned to its right edge until the user deliberately
  // moves the viewport back to inspect earlier data.
  autoScrollRight: true,
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

