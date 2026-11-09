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
// The timeline slider stores the *center* of the visible range. Reusing it
// as a right edge here shifted a normal 0–60 ms view to −30–30 ms whenever a
// user chose a different plotted variable.
document.querySelectorAll("#signal1, #signal2, #signal3").forEach((input) => input.addEventListener("change", () => draw(state.history, state.viewEnd)));
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
