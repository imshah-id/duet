export const initialView = { sidebar: true, focus: false, controls: true };
export type ViewMode = typeof initialView;
export type ViewAction =
  "toggle-sidebar" | "enter-focus" | "exit-focus" | "toggle-controls";

export function changeView(view: ViewMode, action: ViewAction): ViewMode {
  switch (action) {
    case "toggle-sidebar":
      return { ...view, sidebar: !view.sidebar };
    case "enter-focus":
      return { ...view, focus: true, controls: true };
    case "exit-focus":
      return { ...view, focus: false, controls: true };
    case "toggle-controls":
      return view.focus ? { ...view, controls: !view.controls } : view;
  }
}
