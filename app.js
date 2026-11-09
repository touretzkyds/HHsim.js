/*
 * HHsim browser bootstrap.
 *
 * Application code is organized into dependency-ordered files referenced by
 * index.html. Keep this file last: it creates the charts and starts the
 * initial resting-state animation after all controls and event handlers exist.
 */

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
