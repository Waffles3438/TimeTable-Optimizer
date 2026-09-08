/*
 * Dedicated browser worker for the shared exact timetable optimizer.
 *
 * The worker deliberately contains no candidate construction, objective
 * calculation, or result validation. It is only an execution boundary around
 * the synchronous API exported by optimizer.js.
 */
(function (root) {
  "use strict";

  function errorShape(error) {
    return {
      name: String(error && error.name || "Error"),
      message: String(error && error.message || error || "Optimizer worker failed"),
      stack: error && error.stack ? String(error.stack) : "",
    };
  }

  function optimizer() {
    if (!root.TimetableOptimizer && typeof importScripts === "function")
      importScripts("optimizer.js");
    return root.TimetableOptimizer;
  }

  function handleMessage(message) {
    const request = message && typeof message === "object" ? message : {};
    const input = request.input && typeof request.input === "object"
      ? request.input : request;
    const metadata = {
      requestId: request.requestId,
      generation: request.generation,
      key: request.key,
    };

    try {
      const shared = optimizer();
      if (!shared || typeof shared.findBestPlan !== "function")
        throw new Error("shared optimizer module is unavailable");

      const result = shared.findBestPlan(input.plans, input.options, {
        onProgress(progress) {
          const combinationsSearched = Number(progress && progress.combinationsSearched);
          root.postMessage({
            type: "progress",
            requestId: metadata.requestId,
            generation: metadata.generation,
            key: metadata.key,
            combinationsSearched: Number.isFinite(combinationsSearched)
              ? combinationsSearched : 0,
            done: !!(progress && progress.done),
          });
        },
      });
      // Only completed results cross the worker boundary. The page performs
      // its own renderer/input/objective validation before touching the DOM.
      if (!result || result.complete !== true || result.optimal !== true ||
        (result.status !== "OPTIMAL" && result.status !== "NO_SOLUTION")) {
        throw new Error("shared optimizer returned an incomplete result");
      }

      root.postMessage({
        type: "result",
        requestId: metadata.requestId,
        generation: metadata.generation,
        key: metadata.key,
        result,
      });
    } catch (error) {
      root.postMessage({
        type: "error",
        requestId: metadata.requestId,
        generation: metadata.generation,
        key: metadata.key,
        error: errorShape(error),
      });
    }
  }

  if (typeof root.addEventListener === "function") {
    root.addEventListener("message", event => handleMessage(event && event.data));
  } else {
    root.onmessage = event => handleMessage(event && event.data);
  }
})(
  (typeof self !== "undefined" && self) ||
  (typeof globalThis !== "undefined" && globalThis) ||
  this,
);
