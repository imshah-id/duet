import { test } from "node:test";
import assert from "node:assert/strict";
import { changeView, initialView } from "./view-mode";

test("focus view can hide controls and restores the viewer’s panel preference on exit", () => {
  const withoutSidebar = changeView(initialView, "toggle-sidebar");
  const focused = changeView(withoutSidebar, "enter-focus");
  const hidden = changeView(focused, "toggle-controls");
  assert.deepEqual(hidden, { sidebar: false, focus: true, controls: false });
  assert.deepEqual(changeView(hidden, "exit-focus"), {
    sidebar: false,
    focus: false,
    controls: true,
  });
  assert.equal(changeView(initialView, "toggle-controls").controls, true);
});
