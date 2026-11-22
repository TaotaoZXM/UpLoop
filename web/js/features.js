/* Server-injected capabilities; raw/static shells also default to suspended. */
(function () {
  "use strict";
  const B = window.Task = window.Task || {};
  B.features = Object.freeze({ wellness: window.Task_FEATURES?.wellness === true, taskReflection: window.Task_FEATURES?.taskReflection === true });
  document.documentElement.dataset.wellness = String(B.features.wellness);
  document.documentElement.dataset.taskReflection = String(B.features.taskReflection);
})();
