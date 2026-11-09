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

