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
// 60 ms. Once the trace grows past the current right edge, MATLAB keeps that
// edge in view unless the user has intentionally scrolled away from it.
function automaticViewEnd(time) {
  if (!state.autoScrollRight) return state.viewEnd;
  return Math.max(state.viewSpan, time);
}

function updateAutoScrollState(viewEnd) {
  const latest = state.history.at(-1)?.time ?? state.time;
  // A small tolerance permits a user to land just before the final point
  // without unexpectedly disabling follow mode, while a meaningful scroll
  // toward earlier data leaves the view exactly where the user placed it.
  const tolerance = Math.max(.25, state.viewSpan * .05);
  state.autoScrollRight = viewEnd >= latest - tolerance;
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
  // The timeline represents elapsed experiment time, so its visible window
  // may grow to the right but never exposes negative milliseconds.
  const minimum = halfSpan;
  const maximum = Math.max(state.duration + halfSpan, lastTime + halfSpan, center, minimum);
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
  const requestedStart = Math.min(start, end);
  const requestedEnd = Math.max(requestedStart + .25, Math.max(start, end));
  const span = requestedEnd - requestedStart;
  const safeStart = Math.max(0, requestedStart);
  const safeEnd = safeStart + span;
  state.viewSpan = safeEnd - safeStart;
  state.viewEnd = safeEnd;
  if (state.recordingMode !== "clamp") updateAutoScrollState(safeEnd);
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
  state.autoScrollRight = true;
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
    // Panning can reveal future empty space, but an experiment has no
    // negative time. Keep the left side of every normal recording at 0 ms.
    state.viewEnd = Math.max(state.viewSpan, Math.round(shiftedStart + state.viewSpan));
    updateAutoScrollState(state.viewEnd);
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

