/**
 * dsh-code-review — client stylesheet.
 *
 * The complete stylesheet for the review panel, its dialogs and the composer
 * entry, written exclusively against DSH theme custom properties so the
 * plugin follows light/dark themes. It lives in its own bundle module so the
 * component code stays readable; every client source follows the same plain
 * script contract (`__def(name, function (exports, require, React) { ... })`).
 */
__def('styles', function (exports) {
  'use strict';

  var STYLE_TEXT = `
/* ---------- base + utilities (all scoped under .gr-) ---------- */
.gr-root, .gr-root *, .gr-root *::before, .gr-root *::after { box-sizing: border-box; }
/* app.js does not wrap the overlay in .gr-root; make every owned surface
 * border-box regardless of where the slot is mounted. */
.gr-topbar, .gr-topbar *, .gr-files, .gr-files *, .gr-diff, .gr-diff *, .gr-modal, .gr-modal *, .gr-modal-backdrop, .gr-modal-backdrop *, .gr-menu, .gr-menu *, .gr-commit, .gr-commit *, .gr-statusbar, .gr-statusbar *, .gr-settings, .gr-settings *, .gr-empty, .gr-empty *, .gr-panel-body, .gr-panel-body *, .gr-panel-main, .gr-panel-main *, .gr-workspace, .gr-workspace *, .gr-nav-column, .gr-nav-column *, .gr-diff-column, .gr-diff-column *, .gr-window-layer, .gr-window-layer *, .gr-window, .gr-window *, .gr-splitter, .gr-panel-placeholder { box-sizing: border-box; }
.gr-root { font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); line-height: 1.45; }
.gr-panel-body { font: inherit; font-size: 13px; color: var(--dsw-alias-label-primary); line-height: 1.45; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-alias-bg-base); }
.gr-review-title { display: inline-flex; align-items: center; gap: 10px; min-width: 0; }
.gr-review-title-name { min-width: 0; max-width: min(560px, 60vw); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-panel-placeholder { display: flex; align-items: center; justify-content: center; padding: 32px; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.gr-splitter { position: relative; background: transparent; outline: none; }
.gr-splitter::after { content: ""; position: absolute; top: 0; bottom: 0; left: 2px; width: 1px; background: var(--dsw-alias-border-l2); }
/* Softer than the near-black brand fill: still clearly visible while dragging,
 * without reading as a hard black divider. */
.gr-splitter:hover::after { left: 1px; width: 2px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 30%, transparent); }
.gr-splitter:focus-visible::after { left: 1px; width: 2px; background: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.gr-workspace, .gr-nav-column, .gr-diff-column, .gr-panel-main { min-height: 0; }
/* The navigation column can never take the whole workspace: the diff column
 * keeps at least 200px (plus the 6px splitter). app.js clamps the drag against
 * the measured workspace too; this rule is the safety net after panel resizes. */
.gr-nav-column { max-width: calc(100% - 246px); }
.gr-ico { display: block; flex: 0 0 auto; }
.gr-dim { color: var(--dsw-alias-label-secondary); }
.gr-mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace; }
.gr-grow { flex: 1 1 auto; min-width: 0; min-height: 0; }
.gr-scroll { min-height: 0; overflow: auto; }
.gr-sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.gr-add { color: var(--dsw-alias-state-success-primary); }
.gr-del { color: var(--dsw-alias-state-error-primary); }
.gr-kbd { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-xs, 4px); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; line-height: 1; }
.gr-linkbtn { align-self: flex-start; border: 0; border-radius: var(--dsw-radius-xs, 4px); background: transparent; padding: 0; color: var(--dsw-alias-brand-text, var(--dsw-alias-brand-primary)); font: inherit; font-size: 12px; cursor: pointer; }
.gr-linkbtn:hover:not(:disabled) { text-decoration: underline; }
.gr-linkbtn:focus-visible { outline-style: solid; outline-width: var(--dsw-focus-ring-width, 2px); outline-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.gr-linkbtn:disabled { opacity: .4; cursor: not-allowed; text-decoration: none; }

/* ---------- buttons, icon buttons, spinner, badge ---------- */
/* DSH button language (reference: the client UI primitives button rules):
 * 36px base / 28px small, no border; the outline variant paints a hairline
 * shadow and primary is a solid fill. Hover is variant-specific on purpose —
 * a neutral hover must never repaint the primary fill, or the foreground label
 * loses contrast against the changed background. */
.gr-btn { display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 36px; padding: 0 14px; border: 0; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; cursor: pointer; white-space: nowrap; user-select: none; transition: background-color var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease), color var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease), opacity var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease); }
.gr-btn-sm { height: 28px; padding: 0 10px; font-size: 12px; line-height: 18px; border-radius: var(--dsw-radius-sm, 6px); }
.gr-btn:disabled { opacity: .4; cursor: not-allowed; }
.gr-btn:focus-visible { outline-style: solid; outline-width: var(--dsw-focus-ring-width, 2px); outline-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.gr-btn-default { border: .5px solid transparent; background: transparent; color: var(--dsw-alias-label-primary); box-shadow: inset 0 0 0 var(--dsh-hairline-width, .5px) var(--dsh-button-outline-color, var(--dsw-alias-border-l3)); }
.gr-btn-default:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.gr-btn-default:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-bg-layer-2)); }
.gr-btn-primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base)); }
.gr-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, color-mix(in srgb, var(--dsw-alias-brand-primary) 82%, var(--dsw-alias-bg-base))); }
.gr-btn-ghost { background: transparent; color: var(--dsw-alias-label-secondary); }
.gr-btn-ghost:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); }
.gr-btn-ghost:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-bg-layer-2)); }
.gr-btn-danger { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); color: var(--dsw-alias-state-error-primary); }
.gr-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger, color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent)); }
.gr-btn-toggled { border-color: transparent; background: var(--dsw-alias-button-ghost-active-fill, color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent)); color: var(--dsw-alias-brand-primary); box-shadow: inset 0 0 0 var(--dsh-hairline-width, .5px) var(--dsw-alias-button-ghost-active-border, color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent)); }
.gr-btn-toggled:hover:not(:disabled) { background: var(--dsw-alias-button-ghost-active-hover, color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)); color: var(--dsw-alias-brand-primary); }
.gr-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer; flex: 0 0 auto; transition: background-color var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease), color var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease); }
.gr-iconbtn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); }
.gr-iconbtn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-bg-layer-2)); }
.gr-iconbtn:focus-visible { outline-style: solid; outline-width: var(--dsw-focus-ring-width, 2px); outline-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.gr-iconbtn:disabled { opacity: 0.4; cursor: default; }
.gr-iconbtn.gr-active { color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent); }
.gr-iconbtn.gr-review-button { width: 28px !important; height: 28px !important; padding: 0 !important; border: 0 !important; border-radius: 50% !important; background: var(--dsw-specific-selector, var(--dsw-alias-bg-layer-2)) !important; color: var(--dsw-alias-label-primary) !important; margin-left: 0 !important; display: inline-grid !important; place-items: center !important; appearance: none; -webkit-appearance: none; box-shadow: none !important; }
.gr-iconbtn.gr-review-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-bg-layer-2)) !important; color: var(--dsw-alias-label-primary) !important; }
.gr-iconbtn.gr-review-button:disabled { opacity: 0.5; }
.gr-review-button:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 0; }
/* Esc restores focus to the trigger for keyboard continuity, but that
 * programmatic focus must not paint the loud entry ring; the class is removed on
 * the first keyboard/pointer interaction. */
.gr-focus-silent:focus-visible { outline: none !important; box-shadow: none !important; }
.gr-iconbtn.gr-review-button .gr-ico { display: block; }
.gr-spinner { display: inline-block; flex: 0 0 auto; border-radius: 50%; border: 1.5px solid color-mix(in srgb, var(--dsw-alias-label-secondary) 35%, transparent); border-top-color: var(--dsw-alias-brand-primary); animation: gr-spin 800ms linear infinite; }
.gr-badge { display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1; white-space: nowrap; }
.gr-badge-add { color: var(--dsw-alias-state-success-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 35%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.gr-badge-del { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.gr-badge-staged { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.gr-badge-unstaged { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.gr-badge-untracked { color: var(--dsw-alias-label-secondary); border-color: var(--dsw-alias-border-l2); background: color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent); }
.gr-badge-conflict { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent); }
.gr-badge-neutral { color: var(--dsw-alias-label-secondary); }

/* ---------- floating review windows ---------- */
/* The review window deliberately follows the DSH window frame radius, not the
 * larger --dsw-radius-panel used by DSH dialogs/cards: it reads as a desktop
 * window, so it uses the frame's own content radius (16px on the Windows
 * frame) with the shared --dsw-radius-lg step as the web fallback. */
/* The layer starts below the DSH frame title strip (Electron caption / macOS
 * traffic lights), so a maximized review window covers the whole work area and
 * can never slide under the DSH chrome. The JS geometry reads the same token. */
.gr-window-layer { position: fixed; left: 0; right: 0; top: var(--dsh-frame-top-clearance, 0px); bottom: 0; z-index: 200; pointer-events: none; }
.gr-window { position: absolute; display: flex; flex-direction: column; pointer-events: auto; overflow: hidden; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsh-windows-content-radius, var(--dsw-radius-lg, 12px)); background: var(--dsw-alias-bg-base); box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv3, 0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent))); outline: none; min-width: 320px; min-height: 240px; }
.gr-window:focus { outline: none; }
/* Inactive windows sit one elevation step below the active one. */
.gr-window:not(.gr-window-focused) { box-shadow: var(--dsw-shadow-lv2, 0 6px 20px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent)); }
.gr-window-focused { box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv3, 0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent))); }
.gr-window-moving { user-select: none; cursor: grabbing; }
/* Title bar: doubles as the drag handle (touch-action keeps touch drags from
 * scrolling the page underneath). */
.gr-window-head { display: flex; align-items: center; gap: 8px; height: 42px; padding: 0 8px 0 14px; flex: 0 0 auto; min-width: 0; background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l2); cursor: grab; touch-action: none; }
.gr-window-head:active, .gr-window-moving .gr-window-head { cursor: grabbing; }
.gr-window-ident { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; }
.gr-window .gr-review-title-name { max-width: min(420px, 40vw); }
/* The open-project split control lives in the title bar, between the repository
 * identity and the window buttons; it yields space before the title does. */
.gr-window-head .gr-open-target { max-width: 230px; margin-right: 6px; }
.gr-window-head .gr-open-main { max-width: 190px; }
.gr-window-actions { display: inline-flex; align-items: center; gap: 2px; margin-left: auto; flex-shrink: 0; }
/* Window controls reuse the shared .gr-iconbtn language at 26px. */
.gr-window-btn { width: 26px; height: 26px; border-radius: var(--dsw-radius-sm, 6px); }
.gr-window-btn-close:hover:not(:disabled) { color: var(--dsw-alias-state-error-primary); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.gr-window-body { position: relative; flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.gr-window .gr-panel-body { border: 0; border-radius: 0; flex: 1 1 auto; min-height: 0; }
/* Minimized: collapse to the title bar; JS clamps the restored geometry. */
.gr-window-minimized { min-height: 0; }
.gr-window-minimized .gr-window-body { display: none; }
.gr-window-minimized .gr-window-resize-s,
.gr-window-minimized .gr-window-resize-se { display: none; }
/* A maximized window fills the work area: resize handles would be a no-op. */
.gr-window-maximized .gr-window-resize { display: none; }
/* Resize handles are invisible edges around the window; the -se corner sits
 * above the two edges so the corner gesture always wins. */
.gr-window-resize { position: absolute; z-index: 30; touch-action: none; }
.gr-window-resize-e { top: 0; right: 0; bottom: 0; width: 6px; cursor: ew-resize; }
.gr-window-resize-s { left: 0; right: 0; bottom: 0; height: 6px; cursor: ns-resize; }
.gr-window-resize-se { right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize; z-index: 31; }
.gr-window-resize-e:hover, .gr-window-resize-s:hover, .gr-window-resize-se:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent); }
/* Scoped dialogs (confirm / push / shortcuts) cover only their own window: the
 * absolute backdrop must beat the base fixed one. */
.gr-modal-backdrop.gr-modal-backdrop-scoped { position: absolute; inset: 0; z-index: 40; padding: 16px; }
.gr-push-layer.gr-modal-backdrop-scoped { position: absolute; inset: 0; z-index: 40; }

/* ---------- top bar ---------- */
/* One line on wide panels; when the panel gets narrow the action cluster wraps
 * onto a second row instead of squeezing the identity/summary or clipping the
 * actions. Height is auto (min 54px) so the toolbar grows rather than truncating
 * content. Overflow stays visible because the toolbar is a size container: its
 * grouping selector anchors its listbox below the trigger (see
 * .gr-combo-menu-anchor), and a clipped container would hide it. */
.gr-topbar { container-type: inline-size; container-name: gr-topbar; position: relative; z-index: 5; flex: 0 0 auto; display: flex; align-items: center; flex-wrap: wrap; align-content: center; column-gap: 12px; row-gap: 6px; height: auto; min-height: 54px; padding: 8px 16px; border-bottom: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 12.5px; overflow: visible; }
.gr-topbar-repo { display: flex; align-items: center; gap: 8px; flex: 0 1 auto; min-width: 0; max-width: 46%; }
/* An empty identity slot (branch chip / tracking hidden) must not claim a flex
 * row or a gap on narrow panels. */
.gr-topbar-repo:empty { display: none; }
.gr-repo-icon { display: inline-grid; place-items: center; flex: 0 0 auto; width: 30px; height: 30px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent); color: var(--dsw-alias-label-primary); }
.gr-chip { display: inline-flex; align-items: center; gap: 4px; max-width: 170px; height: 20px; padding: 0 8px; border: .5px solid var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1; white-space: nowrap; flex: 0 0 auto; }
.gr-chip-icon { display: inline-flex; flex: 0 0 auto; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.gr-chip-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.gr-chip-warn { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); }
/* The branch chip is a button (information popover), not a static label. */
.gr-branch-trigger { font-family: inherit; cursor: pointer; text-align: left; }
.gr-branch-trigger:hover, .gr-branch-trigger-open { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); }
.gr-branch-trigger:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.gr-chip-chevron { display: inline-flex; flex: 0 0 auto; margin-left: -2px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.gr-tag { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border-radius: var(--dsw-radius-sm, 6px); background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, transparent); color: var(--dsw-alias-label-secondary); font-size: 11px; letter-spacing: 0.02em; white-space: nowrap; flex: 0 0 auto; }
.gr-tracking { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.gr-ahead { display: inline-flex; align-items: center; gap: 2px; color: var(--dsw-alias-state-success-primary); }
.gr-behind { display: inline-flex; align-items: center; gap: 2px; color: var(--dsw-alias-state-warn-primary); }
.gr-topbar-sep { flex: 0 0 auto; width: 1px; height: 18px; margin: 0 2px; background: var(--dsw-alias-border-l2); }
.gr-topbar-mid { display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0; overflow: hidden; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.gr-sum-files { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.gr-sum-item { display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; font-size: 11.5px; }
.gr-sum-item b { color: var(--dsw-alias-label-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
/* Semantic summary shapes (✓ staged / ○ unstaged / ◌ untracked / ⚠ conflict).
 * Every shape owns the same 14px slot so the marks keep one visual rhythm. */
.gr-sum-icon { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; flex: 0 0 auto; }
.gr-sum-icon-staged { border-radius: 50%; color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); }
.gr-sum-icon-unstaged::after, .gr-sum-icon-untracked::after { content: ""; width: 9px; height: 9px; border-radius: 50%; }
.gr-sum-icon-unstaged::after { border: 1.5px solid var(--dsw-alias-state-warn-primary); }
.gr-sum-icon-untracked::after { border: 1.5px dashed var(--dsw-alias-state-idle-primary); }
.gr-sum-icon-conflict { color: var(--dsw-alias-state-error-primary); }
.gr-sum-sep { flex: 0 0 auto; width: 1px; height: 12px; background: var(--dsw-alias-border-l2); }
.gr-sum-stats { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; font-size: 11.5px; font-variant-numeric: tabular-nums; }
.gr-topbar-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; margin-left: auto; }
.gr-topbar-actions .gr-iconbtn, .gr-topbar-actions .gr-btn { flex: 0 0 auto; }
.gr-topbar-actions .gr-iconbtn { width: 30px; height: 30px; }
.gr-topbar-actions .gr-topbar-sep { margin: 0 4px; }
/* Grouping selector (Git status / AI role / AI logic): a compact DSH-menu
 * trigger that fits the action row without pushing the push/settings controls
 * out of the toolbar. The listbox is anchored inside the combo rather than
 * viewport-fixed because the toolbar's size container would contain and clip a
 * fixed-position descendant. */
.gr-topbar .gr-topbar-grouping { width: auto; max-width: 200px; flex: 0 0 auto; }
.gr-topbar .gr-topbar-grouping .gr-combo-trigger { width: auto; max-width: 200px; height: 28px; gap: 6px; padding: 0 8px; border-radius: var(--dsw-radius-sm, 6px); font-size: 12px; line-height: 16px; }
.gr-topbar .gr-topbar-grouping .gr-combo-value { flex: 0 1 auto; }
.gr-topbar .gr-topbar-grouping .gr-combo-chevron .gr-ico { width: 12px; height: 12px; }
.gr-topbar-push { min-width: 64px; }
/* AI grouping state rides after the change summary inside the shrinkable
 * toolbar middle. It is part of the summary row, so it never claims a row of
 * its own; long notices truncate and stay available in full through the title
 * tooltip. */
.gr-ai-row { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: min(420px, 38%); padding: 3px 8px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 3%, transparent); color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.gr-ai-row .gr-ico { flex: 0 0 auto; color: var(--dsw-alias-brand-primary); }
.gr-ai-row-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The status list was truncated: global writes are disabled, so this warning is
 * persistent (not a toast) and sits directly under the toolbar. */
.gr-truncation-warning { flex: 0 0 auto; padding: 7px 12px; border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); color: var(--dsw-alias-state-warn-primary); font-size: 11.5px; line-height: 1.5; }
@container gr-topbar (max-width: 1280px) {
  .gr-topbar-mid .gr-sum-stats { display: none; }
}
/* Narrow panels switch the toolbar to two rows instead of hiding the summary:
 * row 1 keeps the branch chip + change summary + AI status, row 2 the actions.
 * Nothing informational disappears. */
@container gr-topbar (max-width: 920px) {
  .gr-topbar-repo .gr-chip { max-width: 100px; }
  .gr-ai-row { max-width: 40%; }
}
@container gr-topbar (max-width: 820px) {
  .gr-topbar-repo { max-width: 100%; }
  .gr-topbar .gr-tag { display: none; }
  .gr-topbar-actions { flex: 1 1 100%; justify-content: flex-end; margin-left: 0; }
  .gr-ai-row { max-width: 55%; }
}
@container gr-topbar (max-width: 700px) {
  .gr-topbar-repo .gr-tracking { display: none; }
  .gr-topbar-actions { gap: 2px; }
  .gr-topbar-actions .gr-topbar-sep { margin: 0 1px; }
  .gr-topbar-push { min-width: 0; padding: 0 8px; }
  .gr-topbar .gr-topbar-grouping .gr-combo-trigger { padding: 0 7px; }
}

/* ---------- modal / dialogs ---------- */
.gr-modal-backdrop { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px; background: var(--dsw-alias-bg-mask-1, color-mix(in srgb, var(--dsw-alias-label-primary) 24%, transparent)); backdrop-filter: var(--dsw-mask-blur, blur(2px)); }
.gr-push-layer { z-index: 1100; }
/* DSH dialog geometry: panel radius, layer-2 surface, prominent elevation. */
.gr-modal { display: flex; flex-direction: column; max-width: 100%; max-height: 100%; border-radius: var(--dsw-radius-panel, 12px); border: 0; background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv3, 0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent))); overflow: hidden; outline: none; }
.gr-modal-head { display: flex; align-items: center; gap: 8px; padding: 22px 24px 12px; background: transparent; flex: 0 0 auto; }
.gr-modal-titles { min-width: 0; flex: 1 1 auto; }
.gr-modal-actions { display: inline-flex; align-items: center; gap: 8px; flex: 0 0 auto; margin-left: 4px; }
/* DSH-style split open-target control: primary launch + application menu. */
.gr-open-target { display: inline-flex; align-items: stretch; height: 28px; flex: 0 0 auto; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-base); overflow: hidden; }
.gr-open-main { display: inline-flex; align-items: center; gap: 6px; max-width: 220px; padding: 0 8px; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 11.5px; line-height: 1; cursor: pointer; }
.gr-open-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-open-chevron { display: inline-flex; align-items: center; justify-content: center; padding: 0 5px; border: 0; border-left: .5px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.gr-open-chevron .gr-ico { width: 11px; height: 11px; }
.gr-open-main:hover:not(:disabled), .gr-open-chevron:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.gr-open-main:disabled, .gr-open-chevron:disabled { opacity: .5; cursor: default; }
.gr-open-main:focus-visible, .gr-open-chevron:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 0; }
.gr-app-icon { display: block; flex: 0 0 auto; object-fit: contain; border-radius: 2px; }
.gr-menu-icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex: 0 0 auto; color: var(--dsw-alias-label-secondary); }
.gr-modal-title { margin: 0; font-size: 16px; font-weight: 500; line-height: 24px; letter-spacing: normal; color: var(--dsw-alias-label-primary); }
.gr-modal-subtitle { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.gr-modal-close { margin-left: auto; width: 28px; height: 28px; border-radius: var(--dsw-radius-sm, 6px); }
.gr-modal-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; padding: 0 24px; }
.gr-modal-body > * { flex: 1 1 auto; min-height: 0; }
.gr-modal-foot { flex: 0 0 auto; display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 16px 24px 24px; background: transparent; }
.gr-dialog-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.gr-confirm-body { padding: 16px 0 8px; flex: 0 1 auto !important; }
.gr-confirm-text { margin: 0; font-size: 13px; line-height: 1.6; color: var(--dsw-alias-label-primary); }
.gr-shortcuts { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 10px 20px; padding: 16px 0 20px; flex: 0 1 auto !important; }
.gr-shortcut-keys { display: flex; justify-content: flex-end; gap: 4px; }
.gr-shortcut-label { color: var(--dsw-alias-label-primary); font-size: 12.5px; }

/* ---------- file navigation ---------- */
/* Tinted sidebar surface. In light theme the DSH bg layers are all white, so a
 * 2.5% ink mix is what creates the quiet sidebar/panel separation. */
.gr-files { container-type: inline-size; container-name: gr-files; display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: color-mix(in srgb, var(--dsw-alias-label-primary) 2%, var(--dsw-alias-bg-base)); }
.gr-files-head { position: relative; z-index: 3; flex: 0 0 auto; border-bottom: 1px solid var(--dsw-alias-border-l1); background: inherit; }
/* The header row shares the file rows' content box: 14px leading inset (list
 * padding 6 + row padding 8). On the trailing side the row background ends at
 * list padding + scrollbar gutter; the last bulk control's glyph sits ~7.5px
 * inside its 22px button, so the padding subtracts that inset (gutter - 2) to
 * put the icon's visible right edge on the row's right edge. The gutter is
 * measured from the list (--gr-files-scrollbar) instead of hardcoding it. */
.gr-files-head-row { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 max(0px, calc(var(--gr-files-scrollbar, 0px) - 2px)) 0 14px; overflow: hidden; }
.gr-files-title { flex: 0 0 auto; white-space: nowrap; font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
/* Tri-state "select all listed files" checkbox; it replaces the old toolbar
 * stage-all / unstage-all pair and sits on the row's leading edge like the
 * per-file and per-group checkboxes. */
.gr-files-select-all { margin-right: 1px; }
.gr-files-count { display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 17px; padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); color: var(--dsw-alias-label-secondary); font-size: 10.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
/* Right cluster: the bulk view controls. */
.gr-files-head-right { display: flex; align-items: center; gap: 8px; margin-left: auto; min-width: 0; }
/* Bulk group actions (locate / expand all / collapse all) sit next to the file
 * count in the leading group; icon-only keeps the 44px header compact in both
 * locales. */
.gr-files-bulk { display: inline-flex; align-items: center; gap: 2px; flex: 0 0 auto; }
.gr-files-bulk-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); cursor: pointer; flex: 0 0 auto; }
.gr-files-bulk-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); }
.gr-files-bulk-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 0; }
.gr-files-bulk-btn:disabled { opacity: 0.35; cursor: default; }
.gr-search { flex: 0 0 auto; padding: 12px; background: inherit; }
.gr-search-field { position: relative; display: flex; align-items: center; }
.gr-search-icon { position: absolute; left: 8px; display: inline-flex; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); pointer-events: none; }
.gr-search-input { width: 100%; height: 32px; padding: 0 26px 0 28px; border: .5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; transition: border-color var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease); }
.gr-search-input:hover { border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); }
.gr-search-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.gr-search-input::placeholder { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.gr-search-clear { position: absolute; right: 4px; display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.gr-search-clear:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); color: var(--dsw-alias-label-primary); }
.gr-search-clear:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 0; }
.gr-files-list { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0 6px 12px; scrollbar-width: thin; scrollbar-gutter: stable; scrollbar-color: var(--dsw-alias-scrollbar-hover-l1, var(--dsw-alias-border-l2)) transparent; }
.gr-files-list:focus-visible { outline: none; }
.gr-group { display: flex; flex-direction: column; min-width: 0; }
/* Sticky headers are opaque mixes — a scrolled row can never show through or
 * bleed above the group label. */
.gr-group-head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 6px; width: 100%; height: 32px; padding: 0 8px; border-radius: var(--dsw-radius-sm, 6px); background: color-mix(in srgb, var(--dsw-alias-label-primary) 2%, var(--dsw-alias-bg-base)); color: var(--dsw-alias-label-secondary); }
.gr-group + .gr-group { margin-top: 8px; }
.gr-group-head:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 6%, var(--dsw-alias-bg-base)); }
.gr-group-head-btn { display: flex; align-items: center; gap: 6px; flex: 1 1 auto; min-width: 0; height: 100%; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer; text-align: left; }
.gr-group-head-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; border-radius: var(--dsw-radius-sm, 6px); }
.gr-group-chevron { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex: 0 0 auto; color: var(--dsw-alias-label-secondary); transform: rotate(0deg); transition: transform var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease), color var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease); }
.gr-group-chevron .gr-ico { display: block; }
.gr-group-chevron-open { transform: rotate(90deg); }
.gr-group-head:hover .gr-group-chevron { color: var(--dsw-alias-label-primary); }
.gr-group-dot { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
.gr-group-head[data-tone="staged"] .gr-group-dot { background: var(--dsw-alias-brand-primary); }
.gr-group-head[data-tone="unstaged"] .gr-group-dot { background: var(--dsw-alias-state-warn-primary); }
.gr-group-head[data-tone="untracked"] .gr-group-dot { background: var(--dsw-alias-state-idle-primary); }
.gr-group-head[data-tone="conflict"] .gr-group-dot { background: var(--dsw-alias-state-error-primary); }
.gr-group-head[data-tone="ai"] .gr-group-dot { background: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.gr-group-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-group-count { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; min-width: 20px; height: 17px; padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); color: var(--dsw-alias-label-secondary); font-size: 10.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
.gr-group-body { padding: 2px 0; }
.gr-file-row { position: relative; display: flex; align-items: center; gap: 8px; min-height: 38px; margin: 2px 0; padding: 7px 8px; border-radius: var(--dsw-radius-sm, 6px); cursor: pointer; }
.gr-file-row:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.gr-file-row[aria-selected="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 9%, transparent); }
.gr-file-row[aria-selected="true"]::before { content: ""; position: absolute; left: 0; top: 8px; bottom: 8px; width: 2px; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.gr-file-row[aria-selected="true"]:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); }
.gr-file-row:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }
/* Checkbox = "will be committed" (staged). Native control, theme accent. */
.gr-checkbox { flex: 0 0 auto; width: 14px; height: 14px; margin: 0; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; }
.gr-checkbox:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.gr-checkbox:disabled { cursor: default; opacity: .45; }
.gr-file-glyph { flex: 0 0 auto; width: 13px; text-align: center; font-size: 10.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
.gr-file-name-wrap { display: flex; flex-direction: column; justify-content: center; gap: 2px; flex: 1 1 auto; min-width: 0; line-height: 16px; }
.gr-file-name { min-width: 0; max-width: 100%; color: var(--dsw-alias-label-primary); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-file-name-wrap .gr-file-dir { min-width: 0; font-size: 10.5px; line-height: 14px; }
.gr-file-stats { display: inline-flex; align-items: center; justify-content: flex-end; gap: 5px; flex: 0 0 auto; min-width: 52px; font-size: 10.5px; font-variant-numeric: tabular-nums; }
.gr-file-chg { flex: 0 0 auto; width: 11px; text-align: center; font-size: 10.5px; font-weight: 700; }
.gr-chg-added { color: var(--dsw-alias-state-success-primary); }
.gr-chg-modified { color: var(--dsw-alias-state-warn-primary); }
.gr-chg-deleted { color: var(--dsw-alias-state-error-primary); }
.gr-chg-renamed, .gr-chg-copied { color: var(--dsw-alias-brand-primary); }
.gr-chg-typechange { color: var(--dsw-alias-state-warn-primary); }
.gr-chg-conflict { color: var(--dsw-alias-state-error-primary); }
.gr-file-names { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
.gr-file-base { color: var(--dsw-alias-label-primary); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-file-dir { color: var(--dsw-alias-label-secondary); font-size: 10.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-empty-nav { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 28px 16px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.gr-empty-nav-icon { display: inline-flex; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); opacity: 0.7; }
.gr-empty-nav-title { color: var(--dsw-alias-label-primary); font-size: 12.5px; font-weight: 500; }
.gr-empty-nav-hint { font-size: 11.5px; line-height: 1.5; }
.gr-empty-nav-action { align-self: center; margin-top: 2px; }
@container gr-files (max-width: 250px) {
  .gr-file-name-wrap .gr-file-dir { display: none; }
}
@container gr-files (max-width: 218px) {
  .gr-file-stats { display: none; }
}

/* ---------- context menu ---------- */
/* DSH menu surface: 4px padding, one hairline stroke, prominent elevation,
 * 34px items with radius-md hover fill and 11px group labels. */
.gr-menu { position: fixed; z-index: 1200; min-width: 200px; max-width: 340px; padding: 4px; border-radius: var(--dsw-radius-lg, 10px); border: .5px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv2, 0 4px 12px color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent))); font-size: 13px; }
.gr-menu-header { padding: 6px 8px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 11px; line-height: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-menu-item { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 34px; padding: 6px 8px; border: 0; border-radius: var(--dsw-radius-md, 8px); background: transparent; color: inherit; font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer; }
.gr-menu-item:hover:not([aria-disabled="true"]), .gr-menu-item:focus-visible { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-4, var(--dsw-alias-bg-layer-2))); outline: none; }
.gr-menu-item[aria-disabled="true"] { opacity: 0.4; cursor: default; }
.gr-menu-item-danger { color: var(--dsw-alias-state-error-primary); }
.gr-menu-sep { height: .5px; margin: 3px 8px; background: var(--dsw-alias-border-l2); }

/* ---------- commit drawer ---------- */
.gr-commit { flex: 0 0 auto; display: flex; flex-direction: column; min-height: 0; max-height: 48%; border-top: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); }
.gr-commit-toggle { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; width: 100%; height: 40px; padding: 0 16px; border: 0; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; cursor: pointer; text-align: left; }
.gr-commit-toggle:hover { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.gr-commit-toggle:focus-visible { outline-style: solid; outline-width: var(--dsw-focus-ring-width, 2px); outline-color: var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }
.gr-commit-chevron { display: inline-flex; align-items: center; justify-content: center; width: 14px; color: var(--dsw-alias-label-secondary); }
.gr-commit-title { font-weight: 600; }
.gr-commit-count { color: var(--dsw-alias-label-secondary); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.gr-commit-spacer { flex: 1 1 auto; }
.gr-commit-hint { font-size: 11.5px; }
.gr-commit-body { display: flex; flex-direction: column; gap: 8px; min-height: 0; padding: 2px 16px 14px; overflow: auto; scrollbar-width: thin; }
.gr-commit-label { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.gr-commit .gr-textarea { min-height: 84px; }
.gr-commit-actions { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
.gr-commit-shortcut { display: inline-flex; align-items: center; gap: 3px; }
.gr-commit .gr-warn-box, .gr-commit .gr-error-box { margin: 0; }
.gr-textarea { width: 100%; min-height: 92px; resize: vertical; padding: 8px 12px; border-radius: var(--dsw-radius-md, 8px); border: .5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-base)); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 1.6; transition: border-color var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease); }
.gr-textarea:hover:not(:disabled):not(:focus):not(:focus-visible) { border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); }
.gr-textarea:focus, .gr-textarea:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.gr-textarea::placeholder, .gr-input::placeholder { color: var(--dsw-alias-label-secondary); opacity: 1; }
.gr-warn-box, .gr-error-box, .gr-info-box, .gr-success-box { border-radius: 8px; padding: 7px 10px; font-size: 11.5px; line-height: 1.5; }
.gr-warn-box, .gr-error-box { white-space: pre-wrap; }
.gr-warn-box { border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); color: var(--dsw-alias-state-warn-primary); }
.gr-error-box { border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); color: var(--dsw-alias-state-error-primary); }
.gr-info-box { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); }
.gr-success-box { border: 1px solid color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent); background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent); color: var(--dsw-alias-state-success-primary); }

/* ---------- remote dialog ---------- */
.gr-remote-form { display: flex; flex-direction: column; gap: 6px; }
.gr-remote-existing { display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px; }
.gr-remote-label { color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.gr-remote-row { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 6px 8px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.gr-remote-row:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2)); }
.gr-remote-row:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.gr-remote-row:disabled { opacity: 0.55; cursor: default; }
.gr-remote-row-active { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, transparent); }
.gr-remote-row-name { flex: 0 0 auto; font-weight: 600; }
.gr-remote-row-url { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary); font-size: 11px; }
.gr-remote-form .gr-input { width: 100%; }
.gr-remote-form .gr-error-box { margin: 2px 0 0; }

/* ---------- push dialog ---------- */
.gr-push-panel { max-width: 100%; }
.gr-push-body { display: flex; flex-direction: column; gap: 16px; padding: 16px 0 8px; overflow: auto; min-height: 0; }
.gr-push-loading { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 32px; color: var(--dsw-alias-label-secondary); }
/* Preview failed: an explicit error state (message + retry), never a spinner. */
.gr-push-failed { align-items: stretch; justify-content: flex-start; padding: 20px 0; }
.gr-push-error { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; width: 100%; }
.gr-push-flow { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 10px; }
.gr-push-arrow { display: inline-flex; align-items: center; color: var(--dsw-alias-label-secondary); padding-bottom: 4px; }
.gr-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.gr-field-label { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 12px; font-weight: 500; line-height: 18px; }
.gr-field-value { font-size: 13px; line-height: 20px; padding-bottom: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-input, .gr-select { height: 34px; min-width: 120px; padding: 0 12px; border-radius: var(--dsw-radius-md, 8px); border: .5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-base)); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; transition: border-color var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease); }
.gr-input:hover:not(:disabled):not(:focus):not(:focus-visible), .gr-select:hover:not(:disabled):not(:focus):not(:focus-visible) { border-color: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); }
.gr-input:focus, .gr-input:focus-visible, .gr-select:focus, .gr-select:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.gr-push-ahead { font-size: 11.5px; }
.gr-push-empty { font-size: 12px; padding: 6px 2px; }
.gr-commit-list { border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; max-height: 200px; overflow: auto; background: var(--dsw-alias-bg-base); }
.gr-commit-item { display: flex; align-items: baseline; gap: 8px; padding: 4px 8px; border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 55%, transparent); font-size: 12px; }
.gr-commit-item:last-child { border-bottom: 0; }
.gr-sha { color: var(--dsw-alias-label-secondary); font-size: 11px; flex: 0 0 auto; }
.gr-commit-subject { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---------- status bar ---------- */
/* Persistent footer (from the cover): report state on the left, repository
 * summary on the right. The bar is a container so the summary drops the least
 * important segments before it can squeeze the state text. */
.gr-statusbar { container-type: inline-size; container-name: gr-statusbar; flex: 0 0 auto; display: flex; align-items: center; gap: 12px; min-height: 28px; padding: 4px 12px; border-top: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-label-primary) 2%, var(--dsw-alias-bg-base)); color: var(--dsw-alias-label-secondary); font-size: 11px; }
.gr-statusbar-main { display: inline-flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0; overflow: hidden; }
.gr-statusbar-ready { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.gr-statusbar-dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; background: var(--dsw-alias-state-success-primary); }
.gr-statusbar-summary { display: inline-flex; align-items: center; gap: 8px; flex: 0 0 auto; min-width: 0; overflow: hidden; white-space: nowrap; font-variant-numeric: tabular-nums; }
.gr-statusbar-seg { display: inline-flex; align-items: center; flex: 0 0 auto; }
.gr-statusbar-branch { display: inline-block; max-width: 160px; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-primary); }
.gr-statusbar-staged { color: var(--dsw-alias-brand-primary); }
.gr-statusbar-unstaged { color: var(--dsw-alias-state-warn-primary); }
.gr-statusbar-conflict { color: var(--dsw-alias-state-error-primary); }
.gr-statusbar-sep { flex: 0 0 auto; width: 1px; height: 10px; background: var(--dsw-alias-border-l2); }
@container gr-statusbar (max-width: 620px) { .gr-statusbar-extra { display: none; } }
@container gr-statusbar (max-width: 460px) { .gr-statusbar-branch { max-width: 110px; } }
@container gr-statusbar (max-width: 380px) { .gr-statusbar-summary { display: none; } }
.gr-statusbar-busy { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); }
.gr-statusbar-error { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-state-error-primary); min-width: 0; }
.gr-statusbar-error > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-statusbar-notice { color: var(--dsw-alias-state-success-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-statusbar-dismiss { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: inherit; cursor: pointer; }
.gr-statusbar-dismiss:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 16%, transparent); }

/* ---------- empty states ---------- */
.gr-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 40px 24px; text-align: center; }
.gr-empty-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.gr-empty-hint { max-width: 460px; font-size: 12.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.gr-tone-warn .gr-empty-title { color: var(--dsw-alias-state-warn-primary); }
.gr-tone-error .gr-empty-title { color: var(--dsw-alias-state-error-primary); }

/* The settings dialog follows the DSH settings shell: a slightly larger head
 * title aligned with the page's own gutter. */
.gr-modal-settings .gr-modal-head { padding: 22px 24px 18px; border-bottom: .5px solid var(--dsw-alias-border-l2); }
.gr-modal-settings .gr-modal-title { font-size: 16px; line-height: 24px; }
.gr-modal-settings .gr-modal-subtitle { margin-top: 4px; font-size: 12px; line-height: 18px; }
/* The settings body owns its own 24px horizontal rhythm inside the scroll area. */
.gr-modal-settings .gr-modal-body { padding: 0; }
/* Dialog actions use the DSH control height (32px), independent of toolbar density. */
.gr-modal-foot .gr-btn, .gr-dialog-actions .gr-btn, .gr-commit .gr-btn { height: 32px; padding: 0 14px; }
/* ---------- settings page ---------- */
/* The Modal shell fixes head/footer and the page height; this page owns the
 * scroll. It follows the DSH settings language: roomy section titles, quiet
 * descriptive copy, full-width controls stacked under their labels (never a
 * cramped two-column form), one hairline between sections. */
.gr-settings { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; width: 100%; overflow: hidden; color: var(--dsw-alias-label-primary); font-size: 13px; }
.gr-settings-scroll { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 20px 24px; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-scrollbar-hover-l1, var(--dsw-alias-border-l2)) transparent; }
.gr-settings-content { width: 100%; max-width: none; margin: 0 auto; }
.gr-settings .gr-error-box { margin-top: 12px; }
.gr-settings-section { display: flex; flex-direction: column; padding: 0; }
.gr-settings-section + .gr-settings-section { margin-top: 12px; padding-top: 24px; border-top: .5px solid var(--dsw-alias-border-l2); }
.gr-settings-section-head { display: flex; flex-direction: column; gap: 6px; padding-bottom: 4px; }
.gr-settings-section-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 600; line-height: 20px; }
.gr-settings-section-desc { margin: 0; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 12px; line-height: 18px; }
.gr-settings-note { margin: 12px 0 4px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); background: color-mix(in srgb, var(--dsw-alias-label-primary) 2.5%, transparent); }
.gr-settings-note-summary { display: flex; align-items: center; gap: 6px; padding: 10px 12px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; cursor: pointer; list-style: none; }
.gr-settings-note-summary::-webkit-details-marker { display: none; }
.gr-settings-note-summary::marker { content: ''; }
.gr-settings-note-summary:hover { color: var(--dsw-alias-label-primary); }
.gr-settings-note-summary:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; border-radius: var(--dsw-radius-md, 8px); }
.gr-settings-note-chevron { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; color: inherit; transition: transform var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease); }
.gr-settings-note[open] .gr-settings-note-chevron { transform: rotate(90deg); }
.gr-settings-note-label { min-width: 0; }
.gr-settings-note-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0 16px 12px 28px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
/* DSH settings row: label + description left, control right, 16px rhythm and
 * one hairline between rows; long-form fields stack below their label. */
.gr-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 32px; padding: 16px 0; border-bottom: .5px solid var(--dsw-alias-border-l2); }
.gr-setting-row:last-of-type { border-bottom: 0; }
.gr-setting-row-full { flex-direction: column; align-items: stretch; gap: 10px; }
.gr-setting-main { display: flex; flex-direction: column; min-width: 0; flex: 1 1 auto; }
.gr-setting-title { color: var(--dsw-alias-label-primary); font-size: 14px; font-weight: 500; line-height: 20px; }
.gr-setting-desc { margin: 4px 0 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.gr-setting-help { margin: 0; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 12px; line-height: 18px; overflow-wrap: anywhere; }
.gr-setting-help-error { color: var(--dsw-alias-state-error-primary); }
.gr-setting-control { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex: 0 0 auto; min-width: 44px; max-width: 62%; padding-left: 8px; text-align: right; }
.gr-setting-control-switch { min-width: 60px; }
/* Settings dropdowns size to their selected label, matching DSH's inline
 * language selector; a max width keeps long model names from stretching the row. */
.gr-settings .gr-combo { display: inline-flex; width: auto; max-width: min(320px, 100%); }
.gr-settings .gr-combo-trigger { width: auto; max-width: 100%; }
.gr-settings .gr-combo-value { flex: 0 1 auto; }
/* Boolean switch: DSH geometry (36x20, 2px inset, 16px thumb, 16px travel). */
.gr-switch { box-sizing: border-box; position: relative; display: inline-flex; align-items: center; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px; background: var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)); cursor: pointer; flex: 0 0 auto; transition: background-color var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease); }
.gr-switch:hover:not(:disabled) { background: color-mix(in srgb, var(--dsw-alias-border-l3, var(--dsw-alias-border-l2)) 70%, var(--dsw-alias-label-secondary)); }
.gr-switch:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.gr-switch:disabled { opacity: 0.5; cursor: default; }
.gr-switch-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-switch-thumb, var(--dsw-alias-bg-base)); box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent); transition: transform .12s ease, background-color .12s ease; }
.gr-switch-on { background: var(--dsw-alias-brand-primary); }
.gr-switch-on .gr-switch-thumb { transform: translateX(16px); background: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base)); }
/* Custom select: themed trigger + fixed-position listbox (native selects are
 * OS-drawn and show a black focus box that cannot match the DSH theme). */
.gr-combo { position: relative; width: 100%; min-width: 0; }
/* Trigger mirrors DSH's language-selector pill (ui-locale LanguageRow):
 * 36px tall, no border, module-platform fill, 14px label and a 16px chevron. */
.gr-combo-trigger { display: inline-flex; align-items: center; gap: 12px; width: 100%; height: 36px; padding: 0 14px; border: 0; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-module-platform, var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-base))); color: var(--dsw-alias-label-primary); font: inherit; font-size: 14px; line-height: 22px; text-align: left; cursor: pointer; position: relative; transition: background-color var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease); }
.gr-combo-trigger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-4, var(--dsw-alias-bg-layer-2))); }
.gr-combo-trigger:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.gr-combo-trigger:disabled { opacity: 0.5; cursor: default; }
.gr-combo-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-combo-chevron { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; color: currentColor; }
/* Menu mirrors DSH's Menu primitive: translucent surface material, 4px padding,
 * 14/360px width bounds, elevation-prominent shadow with a hairline stroke,
 * 34px items and a 14px label-primary check. */
.gr-combo-menu { position: fixed; z-index: 1300; display: flex; flex-direction: column; box-sizing: border-box; min-width: 0; width: auto; max-width: min(360px, calc(100vw - 16px)); max-height: min(320px, calc(100vh - 24px)); overflow: auto; padding: 4px; border: 0; border-radius: var(--dsw-radius-lg, 10px); background: var(--dsw-menu-surface-fill, var(--dsw-alias-bg-layer-2)); backdrop-filter: var(--dsw-menu-backdrop-filter, blur(12px)); box-shadow: var(--dsw-elevation-prominent, var(--dsw-shadow-lv3, 0 12px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 14%, transparent))); --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); outline: none; font-size: 13px; color: var(--dsw-alias-label-primary); scrollbar-width: thin; }
/* Anchored listbox: some triggers (the toolbar grouping selector) live inside a
 * size container, which makes a viewport-fixed layer both contained and
 * clipped. This placement hangs the menu off the trigger root instead. */
.gr-combo-menu-anchor { position: absolute; top: calc(100% + 4px); right: 0; bottom: auto; min-width: max(100%, 168px); max-width: min(320px, calc(100vw - 16px)); }
.gr-combo-option { display: flex; align-items: center; gap: 6px; min-height: 34px; padding: 6px 8px; border-radius: var(--dsw-radius-md, 8px); font-size: 13px; line-height: 20px; cursor: pointer; }
.gr-combo-option-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-combo-option-active { background: var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-4, var(--dsw-alias-bg-layer-2))); }
.gr-combo-option-selected { color: var(--dsw-alias-label-primary); }
.gr-combo-option-disabled { opacity: 0.4; cursor: not-allowed; }
.gr-combo-check { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 14px; height: 14px; color: var(--dsw-alias-label-primary); }
/* Model picker — DSH composer-style popover: two submenu rows + summary. */
.gr-model-picker { display: inline-flex; max-width: min(320px, 100%); }
.gr-model-picker .gr-combo-trigger { width: auto; max-width: 100%; }
.gr-model-menu { min-width: min(260px, calc(100vw - 16px)); }
.gr-model-row { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 36px; padding: 6px 8px; border: 0; border-radius: var(--dsw-radius-md, 12px); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer; }
.gr-model-row:hover:not(:disabled), .gr-model-row:focus-visible { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.gr-model-row:disabled { opacity: 0.4; cursor: not-allowed; }
.gr-model-row-label { flex: 0 0 auto; color: var(--dsw-alias-label-primary); }
.gr-model-row-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; color: var(--dsw-alias-label-secondary); }
.gr-model-row-chevron { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); }
.gr-model-summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 4px; padding: 8px 8px 6px; border-top: .5px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }
.gr-model-summary-model { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-model-summary-effort { flex: 0 0 auto; }
.gr-model-back { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 32px; padding: 4px 8px; border: 0; border-radius: var(--dsw-radius-md, 12px); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.gr-model-back:hover, .gr-model-back:focus-visible { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); outline: none; }
.gr-model-back-icon { display: inline-flex; transform: rotate(180deg); }
.gr-model-group { padding: 6px 8px 3px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 11px; line-height: 15px; text-align: left; }
.gr-model-option { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 34px; padding: 6px 8px; border: 0; border-radius: var(--dsw-radius-md, 12px); background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer; }
.gr-model-option:hover, .gr-model-option:focus-visible { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.gr-model-option-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-model-empty { padding: 10px 8px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 12px; }
/* Text controls: the DSH focus language is a business border, never the UA ring. */
.gr-settings .gr-input:focus,
.gr-settings .gr-input:focus-visible,
.gr-settings .gr-textarea:focus,
.gr-settings .gr-textarea:focus-visible { outline: none; border-color: var(--dsw-alias-state-business-primary, var(--dsw-alias-brand-primary)); }
.gr-num-field { display: flex; align-items: center; gap: 8px; }
.gr-settings .gr-num-input { width: 108px; height: 34px; border-radius: var(--dsw-radius-md, 8px); padding: 0 10px; text-align: left; font-size: 13px; font-variant-numeric: tabular-nums; appearance: textfield; -webkit-appearance: textfield; }
.gr-settings .gr-num-input::-webkit-outer-spin-button, .gr-settings .gr-num-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.gr-num-unit { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 12px; white-space: nowrap; }
.gr-textarea-wrap { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.gr-settings .gr-textarea { min-height: 96px; padding: 8px 12px; border-radius: var(--dsw-radius-md, 8px); border: .5px solid var(--dsw-alias-border-l4, var(--dsw-alias-border-l2)); background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-base)); font-size: 13px; line-height: 1.6; resize: vertical; }
.gr-textarea-meta { display: flex; align-items: center; justify-content: flex-end; }
.gr-char-count { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary)); font-size: 11px; line-height: 16px; font-variant-numeric: tabular-nums; }
.gr-char-count-near { color: var(--dsw-alias-state-warn-primary); }

/* ---------- empty / notice helpers ---------- */
.gr-skeleton { color: var(--dsw-alias-label-secondary); }

/* ---------- diff pane ---------- */
.gr-diff { container-type: inline-size; container-name: gr-diff; display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: var(--dsw-alias-bg-base); }
.gr-diff-head { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 12px; min-height: 46px; padding: 8px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); flex: 0 0 auto; }
.gr-diff-head-main { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 320px; }
.gr-diff-path-wrap { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1 1 auto; flex-wrap: wrap; }
/* The path never wraps into a vertical letter stack; it truncates instead. */
.gr-diff-path { flex: 0 1 auto; min-width: 0; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-diff-path-old { color: var(--dsw-alias-label-secondary); }
.gr-diff-path-new { color: var(--dsw-alias-label-primary); }
.gr-diff-head-badges { display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.gr-gap-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-diff-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; margin-left: auto; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
/* Narrow diff column: the path gets its own row and the meta row (counter +
 * change navigation) moves below it, so nothing is squeezed into a vertical
 * stack. */
@container gr-diff (max-width: 560px) {
  .gr-diff-head { padding: 8px 10px; gap: 4px 8px; }
  .gr-diff-head-main { flex: 1 1 100%; }
  .gr-diff-path-wrap { flex-wrap: nowrap; }
  .gr-diff-meta { flex: 1 1 100%; margin-left: 0; justify-content: space-between; }
  .gr-diff-sources { padding-left: 0; }
  .gr-diff-source { padding: 6px 8px; }
}
@container gr-diff (max-width: 380px) {
  .gr-diff-path { font-size: 11.5px; }
  .gr-diff-hint { display: none; }
  .gr-diff-meta { gap: 2px 6px; }
}
.gr-diff-sources { flex: 0 0 auto; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); padding-left: 18px; overflow-y: auto; scrollbar-gutter: stable; scrollbar-width: thin; border-bottom: 1px solid var(--dsw-alias-border-l2); background: color-mix(in srgb, var(--dsw-alias-label-primary) 2%, var(--dsw-alias-bg-base)); }
.gr-diff-source { padding: 6px 12px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-diff-source + .gr-diff-source { border-left: 1px solid var(--dsw-alias-border-l2); }
.gr-diff-counter { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary); }
.gr-diff-hint { white-space: nowrap; opacity: 0.85; }
.gr-diff-hint-warn { color: var(--dsw-alias-state-warn-primary); opacity: 1; }
.gr-diff-actions { display: inline-flex; align-items: center; gap: 2px; }
.gr-diff-banners { display: flex; flex-direction: column; gap: 6px; padding: 8px 12px 0; flex: 0 0 auto; }
.gr-diff-main { flex: 1 1 auto; display: flex; flex-direction: column; min-height: 0; min-width: 0; position: relative; }
.gr-diff-body { flex: 1 1 auto; display: flex; min-height: 0; min-width: 0; }
.gr-minimap { position: relative; flex: 0 0 18px; width: 18px; height: 100%; border-right: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); cursor: ns-resize; touch-action: none; outline: none; overflow: hidden; }
.gr-minimap:focus-visible { box-shadow: inset 0 0 0 var(--dsw-focus-ring-width, 2px) var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.gr-mm-marker { position: absolute; left: 3px; right: 3px; min-height: 2px; border-radius: 2px; pointer-events: none; box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-bg-base) 45%, transparent); }
.gr-mm-add { background: var(--dsw-alias-state-success-primary); opacity: 0.82; }
.gr-mm-del { background: var(--dsw-alias-state-error-primary); opacity: 0.82; }
.gr-mm-both { background: linear-gradient(to right, var(--dsw-alias-state-error-primary) 0 50%, var(--dsw-alias-state-success-primary) 50% 100%); opacity: 0.86; }
.gr-mm-view { position: absolute; left: 0; right: 0; border-radius: 2px; background: color-mix(in srgb, var(--dsw-alias-label-primary) 12%, transparent); border-top: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 25%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-label-primary) 25%, transparent); pointer-events: none; min-height: 2px; }
.gr-diff-scroll { flex: 1 1 auto; min-width: 0; min-height: 0; overflow-y: auto; overflow-x: hidden; position: relative; outline: none; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: var(--dsw-alias-scrollbar-hover-l1, var(--dsw-alias-border-l2)) transparent; }
.gr-diff-scroll:focus-visible { box-shadow: inset 0 0 0 var(--dsw-focus-ring-width, 2px) var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); }
.gr-diff-content { position: relative; width: 100%; }
.gr-diff-row { position: absolute; left: 0; right: 0; height: 20px; display: flex; align-items: stretch; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; line-height: 20px; }
/* The row is focusable so a click can continue with arrow-key line walking,
 * but the ring belongs to keyboard navigation only: a pointer click must not
 * leave a selection-looking box behind. The ring is painted by an overlay so
 * the opaque sticky gutters (z-index 1) cannot clip it into stray segments. */
.gr-diff-row:focus { outline: none; }
.gr-diff-row:focus-visible::after { content: ""; position: absolute; inset: 0; z-index: 2; pointer-events: none; outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }
.gr-hunk-active { box-shadow: inset 2px 0 0 0 var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent); }
/* The row matching the change counter keeps a persistent soft selection, so the
 * counter and the line it refers to stay visually connected; clicking a change
 * row moves it, manual scrolling hands it back to the viewport. */
.gr-change-current::before { content: ""; position: absolute; inset: 0; z-index: 1; pointer-events: none; background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
.gr-half { display: flex; width: 50%; min-width: 0; overflow: hidden; }
.gr-half + .gr-half { border-left: 1px solid var(--dsw-alias-border-l1); }
/* The gutter must stay a fully opaque mask: horizontal scrolling moves the code
 * under it with a transform, so any transparency here makes the scrolled text
 * show through and overlap the line numbers. Dim only the number glyphs. */
.gr-gutter { flex: 0 0 54px; padding-right: 8px; text-align: right; color: color-mix(in srgb, var(--dsw-alias-label-secondary) 72%, transparent); user-select: none; position: sticky; left: 0; z-index: 1; background: var(--dsw-alias-bg-base); border-right: 1px solid color-mix(in srgb, var(--dsw-alias-border-l1) 60%, transparent); font-variant-numeric: tabular-nums; }
.gr-line-empty { background: color-mix(in srgb, var(--dsw-alias-label-primary) 2%, var(--dsw-alias-bg-base)); }
.gr-gutter-empty { background: color-mix(in srgb, var(--dsw-alias-label-primary) 2%, var(--dsw-alias-bg-base)); }
.gr-code { flex: 0 0 auto; width: max-content; min-width: 100%; padding: 0 8px; white-space: pre; tab-size: 4; will-change: transform; }
.gr-half-left .gr-code { transform: translateX(calc(var(--gr-hx-left, 0px) * -1)); }
.gr-half-right .gr-code { transform: translateX(calc(var(--gr-hx-right, 0px) * -1)); }
.gr-diff-hscrolls { flex: 0 0 auto; display: flex; height: 12px; margin-left: 18px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-base); }
.gr-hscroll { flex: 1 1 50%; min-width: 0; height: 12px; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
.gr-hscroll-inner { height: 1px; }
.gr-hscroll::-webkit-scrollbar { height: 10px; }
.gr-hscroll::-webkit-scrollbar-track { background: transparent; }
.gr-hscroll::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--dsw-alias-label-secondary) 45%, transparent); border-radius: 999px; }
.gr-line-del { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.gr-line-add { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.gr-line-add .gr-gutter { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, var(--dsw-alias-bg-base)); }
.gr-line-del .gr-gutter { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, var(--dsw-alias-bg-base)); }
.gr-tok-kw { color: var(--dsw-alias-brand-primary); }
.gr-tok-str { color: var(--dsw-alias-state-success-primary); }
.gr-tok-num { color: var(--dsw-alias-state-warn-primary); }
.gr-tok-com { color: var(--dsw-alias-label-secondary); font-style: italic; }
.gr-tok-id { color: var(--dsw-alias-label-primary); }
.gr-tok-punc { color: var(--dsw-alias-label-secondary); }
.gr-diff-gap { position: absolute; left: 0; right: 0; height: 20px; }
.gr-diff-truncation { position: absolute; left: 0; right: 0; height: 20px; display: flex; align-items: center; justify-content: center; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent); border-top: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent); border-bottom: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent); color: var(--dsw-alias-state-warn-primary); }
.gr-diff-truncation-text { padding: 0 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.gr-gap-btn { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; height: 100%; padding: 0 12px; border: 0; border-top: 1px solid var(--dsw-alias-border-l1); border-bottom: 1px solid var(--dsw-alias-border-l1); background: color-mix(in srgb, var(--dsw-alias-bg-layer-2) 65%, transparent); color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11px; cursor: pointer; }
.gr-gap-btn:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.gr-gap-btn:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: -2px; }
.gr-gap-chevron { display: inline-flex; align-items: center; justify-content: center; color: inherit; }
.gr-gap-expand { color: var(--dsw-alias-brand-primary); }
.gr-diff-notice { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 36px 24px; text-align: center; }
.gr-diff-notice-title { color: var(--dsw-alias-label-primary); font-size: 13.5px; font-weight: 600; max-width: 560px; }
.gr-diff-notice-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; max-width: 560px; line-height: 1.55; }
.gr-diff-loading { display: flex; flex-direction: column; gap: 10px; padding: 18px 16px; }
.gr-diff-loading-label { display: inline-flex; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary); font-size: 12px; }
.gr-diff-skeleton { display: flex; flex-direction: column; gap: 7px; }
.gr-skel { height: 9px; border-radius: 3px; background: color-mix(in srgb, var(--dsw-alias-label-secondary) 14%, transparent); }
.gr-diff-empty { flex: 1 1 auto; }

/* ---------- split container helpers used by app.js ---------- */
.gr-app-body { flex: 1 1 auto; display: flex; min-height: 0; min-width: 0; }
.gr-app-side { flex: 0 0 auto; min-width: 0; min-height: 0; display: flex; }
.gr-app-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }

/* ---------- responsive settings form ---------- */
@media (max-width: 560px) {
  .gr-setting-row { flex-direction: column; align-items: stretch; gap: 8px; }
  .gr-setting-control { align-items: flex-start; max-width: 100%; text-align: left; }
  .gr-settings .gr-combo { width: auto; max-width: 100%; }
}

/* ---------- keyframes / motion ---------- */
@keyframes gr-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .gr-spinner { animation: none; }
  .gr-btn, .gr-iconbtn, .gr-search-input, .gr-group-chevron, .gr-switch, .gr-switch-thumb { transition: none; }
}
`;

  exports.STYLE_TEXT = STYLE_TEXT;
});
