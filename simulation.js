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
  state.autoScrollRight = true;
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

