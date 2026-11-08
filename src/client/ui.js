/**
 * dsh-code-review — internal UI primitives ("design kit").
 *
 * One module owns the basic interactive and layout elements so every panel
 * surface (toolbar, dialogs, settings, menus) shares the same geometry, states
 * and theme tokens. `components` and `app` consume these instead of growing
 * their own copies; visual adjustments happen here once.
 *
 * Plain-script contract: no ESM/JSX/top-level await; `require` may resolve
 * earlier client modules (util) or the host-provided react module.
 */
__def('ui', function (exports, require, React) {
  'use strict';

  var h = React.createElement;
  var util = {};
  try {
    util = require('util') || {};
  } catch (error) {
    util = {};
  }

  var useLayoutEffect = React.useLayoutEffect || React.useEffect || function () {};

  function identityT(key) {
    return String(key);
  }

  /** Components receive `t`; fall back to a key echo when isolated in tests. */
  function makeT(t) {
    return typeof t === 'function' ? t : identityT;
  }

  function cx() {
    if (typeof util.cx === 'function') return util.cx.apply(null, arguments);
    var out = [];
    for (var index = 0; index < arguments.length; index += 1) {
      var value = arguments[index];
      if (!value) continue;
      if (typeof value === 'string') out.push(value);
      else if (Array.isArray(value)) {
        var nested = cx.apply(null, value);
        if (nested) out.push(nested);
      } else if (typeof value === 'object') {
        for (var key in value) {
          if (Object.prototype.hasOwnProperty.call(value, key) && value[key]) out.push(key);
        }
      }
    }
    return out.join(' ');
  }

  /* ------------------------------------------------------------------ */
  /* Spinner                                                              */
  /* ------------------------------------------------------------------ */

  function Spinner(props) {
    var size = Number(props && props.size);
    if (!Number.isFinite(size) || size <= 0) size = 12;
    return h('span', {
      className: 'gr-spinner',
      style: { width: size + 'px', height: size + 'px' },
      'aria-hidden': 'true',
    });
  }

  /* ------------------------------------------------------------------ */
  /* Buttons                                                              */
  /* ------------------------------------------------------------------ */

  function IconButton(props) {
    var t = makeT(props.t);
    var label = props.label ? String(props.label) : t('common.more');
    var title = props.title ? String(props.title) : label;
    var busy = !!props.busy;
    return h('button', {
      type: 'button',
      className: cx('gr-iconbtn', props.active && 'gr-active', props.className),
      title: title,
      'aria-label': label,
      'aria-pressed': typeof props.active === 'boolean' ? props.active : undefined,
      'aria-busy': busy ? 'true' : undefined,
      disabled: props.disabled || busy ? true : undefined,
      onClick: props.onClick,
      onContextMenu: props.onContextMenu,
    }, busy ? h(Spinner, { size: 11 }) : props.children);
  }

  function Button(props) {
    var t = makeT(props.t);
    var variant = props.variant || 'default';
    var size = props.size === 'sm' ? 'sm' : 'md';
    var busy = !!props.busy;
    var label = busy && props.busyLabel ? props.busyLabel : props.children;
    return h('button', {
      type: 'button',
      className: cx('gr-btn', 'gr-btn-' + variant, size === 'sm' && 'gr-btn-sm', props.className),
      title: props.title || undefined,
      'aria-busy': busy ? 'true' : undefined,
      'aria-label': props.ariaLabel || undefined,
      'aria-pressed': typeof props.active === 'boolean' ? props.active : undefined,
      disabled: props.disabled || busy ? true : undefined,
      onClick: props.onClick,
    }, busy ? h(Spinner, { size: size === 'sm' ? 10 : 12 }) : props.leading || null, label);
  }

  /**
   * Native checkbox on the shared control tier. `mixed` paints the
   * indeterminate tri-state used by group headers (a click then checks the
   * whole group). `tabIndex` is forwarded so list rows keep a single tab stop.
   */
  function Checkbox(props) {
    var checked = !!props.checked;
    var mixed = !!props.mixed;
    return h('input', {
      type: 'checkbox',
      className: cx('gr-checkbox', props.className),
      checked: checked,
      tabIndex: props.tabIndex,
      title: props.title || undefined,
      'aria-label': props.ariaLabel || undefined,
      disabled: props.disabled ? true : undefined,
      onClick: function (event) {
        event.stopPropagation();
      },
      onChange: function (event) {
        event.stopPropagation();
        if (typeof props.onChange === 'function') props.onChange(event.target.checked);
      },
      ref: function (node) {
        if (node) node.indeterminate = mixed;
      },
    });
  }

  /**
   * Inline text action (the `.gr-linkbtn` tier): no chrome until hover/focus.
   */
  function LinkButton(props) {
    return h('button', {
      type: 'button',
      className: cx('gr-linkbtn', props.className),
      title: props.title || undefined,
      'aria-label': props.ariaLabel || undefined,
      disabled: props.disabled ? true : undefined,
      onClick: props.onClick,
    }, props.children);
  }

  function Badge(props) {
    var tone = props.tone || 'neutral';
    return h('span', {
      className: cx('gr-badge', 'gr-badge-' + tone, props.className),
      title: props.title || undefined,
    }, props.children);
  }

  /* ------------------------------------------------------------------ */
  /* Switch                                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Contract props: { checked, onChange(checked), disabled, label }.
   * A themed boolean switch; button + role="switch" keeps it keyboard operable.
   */
  function Switch(props) {
    var checked = !!props.checked;
    var disabled = !!props.disabled;
    return h('button', {
      type: 'button',
      role: 'switch',
      className: cx('gr-switch', checked && 'gr-switch-on'),
      'aria-checked': checked ? 'true' : 'false',
      'aria-label': props.label || undefined,
      disabled: disabled ? true : undefined,
      onClick: function () {
        if (disabled) return;
        if (typeof props.onChange === 'function') props.onChange(!checked);
      },
    }, h('span', { className: 'gr-switch-thumb', 'aria-hidden': 'true' }));
  }

  /* ------------------------------------------------------------------ */
  /* Text fields                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Contract props: { value, onChange(event), type, className, ariaLabel,
   * placeholder, disabled, maxLength, min, max, step, onBlur, onKeyDown }.
   */
  function TextField(props) {
    return h('input', {
      type: props.type || 'text',
      id: props.id || undefined,
      ref: props.inputRef || undefined,
      className: cx('gr-input', props.className),
      value: props.value === undefined || props.value === null ? '' : String(props.value),
      placeholder: props.placeholder || undefined,
      disabled: props.disabled ? true : undefined,
      maxLength: props.maxLength === undefined ? undefined : props.maxLength,
      min: props.min === undefined ? undefined : props.min,
      max: props.max === undefined ? undefined : props.max,
      step: props.step === undefined ? undefined : props.step,
      spellCheck: props.spellCheck === undefined ? false : !!props.spellCheck,
      autoFocus: props.autoFocus ? true : undefined,
      'aria-label': props.ariaLabel || undefined,
      onChange: props.onChange,
      onBlur: props.onBlur,
      onKeyDown: props.onKeyDown,
    });
  }

  /**
   * Contract props: { value, onChange(event), className, ariaLabel, placeholder,
   * rows, maxLength, disabled, onBlur }.
   */
  function Textarea(props) {
    return h('textarea', {
      id: props.id || undefined,
      ref: props.inputRef || undefined,
      className: cx('gr-textarea', props.className),
      rows: props.rows === undefined ? undefined : props.rows,
      value: props.value === undefined || props.value === null ? '' : String(props.value),
      placeholder: props.placeholder || undefined,
      disabled: props.disabled ? true : undefined,
      maxLength: props.maxLength === undefined ? undefined : props.maxLength,
      spellCheck: false,
      'aria-label': props.ariaLabel || undefined,
      onChange: props.onChange,
      onBlur: props.onBlur,
      onKeyDown: props.onKeyDown,
    });
  }

  /* ------------------------------------------------------------------ */
  /* Select                                                               */
  /* ------------------------------------------------------------------ */

  /** Inline Lucide `chevron-down` glyph (ISC; see README third-party notices). */
  function chevronGlyph(size) {
    return h('svg', {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      className: 'gr-ico',
      'aria-hidden': 'true',
      focusable: 'false',
    }, h('path', { d: 'm6 9 6 6 6-6' }));
  }

  /** Inline Lucide `check` glyph (ISC; see README third-party notices). The
   * primitive layer owns this one because the dropdown renders it itself. */
  function checkGlyph(size) {
    return h('svg', {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      className: 'gr-ico',
      'aria-hidden': 'true',
      focusable: 'false',
    }, h('path', { d: 'M20 6 9 17l-5-5' }));
  }

  /**
   * Contract props: { value, options: [{ value, label, title?, disabled? }],
   * onChange(value), ariaLabel, disabled, placeholder, className, anchorMenu }.
   *
   * A custom dropdown instead of a native <select>: the native popup and its
   * focus ring are rendered by the OS and can only look like a big black box,
   * which breaks the DSH settings look. This one is themed with tokens, has a
   * soft focus ring and a real listbox keyboard model.
   *
   * `anchorMenu` renders the listbox as an absolutely positioned child of the
   * trigger root instead of a viewport-fixed layer. Use it for triggers inside a
   * size container (`.gr-topbar`): layout containment would contain — and the
   * container's overflow could clip — a fixed-position descendant.
   */
  function Select(props) {
    var openState = React.useState(false);
    var open = openState[0];
    var setOpen = openState[1];
    var activeState = React.useState(-1);
    var active = activeState[0];
    var setActive = activeState[1];
    var positionState = React.useState(null);
    var position = positionState[0];
    var setPosition = positionState[1];
    var rootRef = React.useRef(null);
    var menuRef = React.useRef(null);

    var options = Array.isArray(props.options) ? props.options : [];
    var disabled = !!props.disabled;
    var anchorMenu = !!props.anchorMenu;
    var selectedIndex = -1;
    var selectedOption = null;
    for (var index = 0; index < options.length; index += 1) {
      if (options[index] && options[index].value === props.value) {
        selectedIndex = index;
        selectedOption = options[index];
        break;
      }
    }
    var label = selectedOption ? String(selectedOption.label) : String(props.placeholder || '');

    useLayoutEffect(function () {
      if (!open) return undefined;
      function measure() {
        /* Anchored menus are positioned by their CSS class and the trigger
         * root, so they never need viewport measurement. */
        if (anchorMenu) return;
        var node = rootRef.current;
        if (!node) return;
        var rect = node.getBoundingClientRect();
        var count = options.length;
        var estimated = Math.min(320, count * 34 + 8);
        var below = window.innerHeight - rect.bottom - 8;
        var above = rect.top - 12;
        var placement = below >= estimated + 4 ? 'below' : 'above';
        var next = {
          right: Math.round(Math.max(8, window.innerWidth - rect.right)),
          /* DSH menus never get narrower than their anchor, but the anchor is
           * content-sized now, so 144px only applies to wide triggers. */
          minWidth: Math.min(Math.round(rect.width), 144),
          placement: placement,
          maxHeight: Math.max(120, Math.min(320, placement === 'below' ? below : above)),
        };
        if (placement === 'below') next.top = Math.round(rect.bottom + 4);
        else next.bottom = Math.round(window.innerHeight - rect.top + 4);
        setPosition(next);
      }
      measure();
      function onPointerDown(event) {
        var root = rootRef.current;
        var menu = menuRef.current;
        if (root !== null && root.contains(event.target)) return;
        if (menu !== null && menu.contains(event.target)) return;
        setOpen(false);
      }
      function onReposition() { measure(); }
      document.addEventListener('pointerdown', onPointerDown, true);
      window.addEventListener('scroll', onReposition, true);
      window.addEventListener('resize', onReposition);
      return function () {
        document.removeEventListener('pointerdown', onPointerDown, true);
        window.removeEventListener('scroll', onReposition, true);
        window.removeEventListener('resize', onReposition);
      };
    }, [open, anchorMenu]);

    React.useEffect(function () {
      if (!open) return;
      var menu = menuRef.current;
      if (menu !== null && typeof menu.focus === 'function') menu.focus();
    }, [open]);
    function openMenu() {
      if (disabled || open) return;
      setActive(selectedIndex >= 0 ? selectedIndex : (options.length > 0 ? 0 : -1));
      setOpen(true);
    }

    function closeMenu(focusTrigger) {
      setOpen(false);
      setActive(-1);
      setPosition(null);
      if (focusTrigger && rootRef.current !== null) {
        var trigger = rootRef.current.querySelector('.gr-combo-trigger');
        if (trigger !== null && typeof trigger.focus === 'function') trigger.focus();
      }
    }

    function commit(at) {
      var option = options[at];
      if (!option || option.disabled) return;
      closeMenu(true);
      if (typeof props.onChange === 'function' && option.value !== props.value) props.onChange(option.value);
    }

    function onTriggerKeyDown(event) {
      if (disabled || open) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openMenu();
      }
    }

    function onMenuKeyDown(event) {
      var key = event.key;
      if (key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeMenu(true);
        return;
      }
      if (key === 'Tab') {
        closeMenu(false);
        return;
      }
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        if (options.length === 0) return;
        var next = active + (key === 'ArrowDown' ? 1 : -1);
        if (next < 0) next = options.length - 1;
        if (next >= options.length) next = 0;
        setActive(next);
        return;
      }
      if (key === 'Home') {
        event.preventDefault();
        if (options.length > 0) setActive(0);
        return;
      }
      if (key === 'End') {
        event.preventDefault();
        if (options.length > 0) setActive(options.length - 1);
        return;
      }
      if (key === 'Enter' || key === ' ') {
        event.preventDefault();
        commit(active);
      }
    }

    var menu = open && (anchorMenu || position !== null)
      ? h('div', {
        className: cx('gr-combo-menu', anchorMenu && 'gr-combo-menu-anchor'),
        role: 'listbox',
        tabIndex: -1,
        ref: menuRef,
        'aria-label': props.ariaLabel || undefined,
        style: anchorMenu
          ? undefined
          : {
            top: position.top === undefined ? undefined : position.top + 'px',
            bottom: position.bottom === undefined ? undefined : position.bottom + 'px',
            right: position.right + 'px',
            minWidth: position.minWidth + 'px',
            maxHeight: position.maxHeight + 'px',
          },
        onKeyDown: onMenuKeyDown,
      }, options.map(function (option, optionIndex) {
        return h('div', {
          key: String(option.value),
          role: 'option',
          'aria-selected': option.value === props.value,
          'aria-disabled': option.disabled ? 'true' : undefined,
          className: cx(
            'gr-combo-option',
            option.value === props.value && 'gr-combo-option-selected',
            optionIndex === active && 'gr-combo-option-active',
            option.disabled && 'gr-combo-option-disabled',
          ),
          title: option.title ? String(option.title) : undefined,
          onMouseEnter: function () { setActive(optionIndex); },
          onClick: function () { commit(optionIndex); },
        },
          h('span', { className: 'gr-combo-option-label' }, String(option.label)),
          option.value === props.value
            ? h('span', { className: 'gr-combo-check', 'aria-hidden': 'true' }, checkGlyph(14))
            : null);
      }))
      : null;

    return h('div', {
      className: cx('gr-combo', props.className, open && 'gr-combo-open'),
      ref: rootRef,
      'data-gr-combo': 'true',
      'data-gr-combo-open': open ? 'true' : undefined,
    },
      h('button', {
        type: 'button',
        className: 'gr-combo-trigger',
        role: 'combobox',
        'aria-haspopup': 'listbox',
        'aria-expanded': open ? 'true' : 'false',
        'aria-label': props.ariaLabel || undefined,
        disabled: disabled ? true : undefined,
        onClick: function () { if (open) closeMenu(false); else openMenu(); },
        onKeyDown: onTriggerKeyDown,
      },
        h('span', { className: 'gr-combo-value' }, label),
        h('span', { className: 'gr-combo-chevron', 'aria-hidden': 'true' }, chevronGlyph(16))),
      menu);
  }

  /* ------------------------------------------------------------------ */
  /* Settings layout helpers                                              */
  /* ------------------------------------------------------------------ */

  /**
   * A settings section: DSH-style 14/20 heading plus a 12/18 description.
   * Contract props: { title, description, children }.
   */
  function SettingSection(props) {
    return h('section', { className: 'gr-settings-section' },
      props.title || props.description
        ? h('div', { className: 'gr-settings-section-head' },
          props.title ? h('h3', { className: 'gr-settings-section-title' }, props.title) : null,
          props.description ? h('p', { className: 'gr-settings-section-desc' }, props.description) : null)
        : null,
      props.children);
  }

  /**
   * One DSH settings row: title + description on the left, a right-aligned
   * control column; `full` stacks long-form children below the label instead.
   * Contract props: { title, description, full, controlClassName, children }.
   */
  function SettingRow(props) {
    return h('div', { className: cx('gr-setting-row', props.full && 'gr-setting-row-full') },
      h('div', { className: 'gr-setting-main' },
        props.title ? h('div', { className: 'gr-setting-title' }, props.title) : null,
        props.description ? h('p', { className: 'gr-setting-desc' }, props.description) : null),
      props.full
        ? props.children
        : h('div', { className: cx('gr-setting-control', props.controlClassName) }, props.children));
  }

  /** A 12/18 field hint; tone="error" switches to the error state colour. */
  function Hint(props) {
    return h('p', {
      className: cx('gr-setting-help', props.tone === 'error' && 'gr-setting-help-error'),
    }, props.children);
  }


  /* ------------------------------------------------------------------ */
  /* Dialog                                                               */
  /* ------------------------------------------------------------------ */

  var FOCUSABLE = 'a[href], summary, button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  var dialogStack = [];
  var ESC_DEFER_SELECTOR = '[data-gr-combo][data-gr-combo-open="true"], [data-gr-menu="true"]';

  function dialogEscapeDeferred(event) {
    if (!event) return false;
    if (event.defaultPrevented) return true;
    var target = event.target;
    if (target && typeof target.closest === 'function' && target.closest(ESC_DEFER_SELECTOR)) return true;
    return false;
  }

  function focusNode(node) {
    if (!node || typeof node.focus !== 'function') return;
    try {
      node.focus({ preventScroll: true });
    } catch (error) {
      try {
        node.focus();
      } catch (ignored) {
        /* focus is best effort */
      }
    }
  }

  function focusableElements(root) {
    if (!root || typeof root.querySelectorAll !== 'function') return [];
    var nodes = root.querySelectorAll(FOCUSABLE);
    var out = [];
    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index];
      if (node.disabled) continue;
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') continue;
      if (typeof node.getClientRects === 'function' && node.getClientRects().length === 0) continue;
      out.push(node);
    }
    return out;
  }

  function requestFrame(callback) {
    if (typeof requestAnimationFrame === 'function') return { raf: true, id: requestAnimationFrame(callback) };
    return { raf: false, id: setTimeout(callback, 0) };
  }

  function cancelFrame(handle) {
    if (!handle) return;
    if (handle.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle.id);
    else clearTimeout(handle.id);
  }

  /**
   * Dialog focus contract: move focus into the panel, trap Tab, close on Escape
   * (unless busy) and restore focus on close. Only the topmost dialog reacts.
   */
  function useDialogFocus(open, busy, onClose, panelRef) {
    var onCloseRef = React.useRef(onClose);
    var busyRef = React.useRef(busy);
    var tokenRef = React.useRef(null);
    if (!tokenRef.current) tokenRef.current = {};
    onCloseRef.current = onClose;
    busyRef.current = busy;

    React.useEffect(function () {
      if (!open) return undefined;
      var doc = typeof document !== 'undefined' ? document : null;
      if (!doc) return undefined;
      var token = tokenRef.current;
      dialogStack.push(token);
      var previous = doc.activeElement;
      /* Escape is a keyboard close: focus is restored to the trigger for
       * keyboard continuity, but the ring painted on that programmatic focus is
       * noise. Track it here and silence it during the cleanup below. */
      var escapeClosed = false;
      var frame = requestFrame(function () {
        var panel = panelRef && panelRef.current;
        if (!panel) return;
        var preferred = panel.querySelector('[data-gr-autofocus]');
        var candidates = focusableElements(panel);
        focusNode(preferred || candidates[0] || panel);
      });

      function isTopDialog() {
        return dialogStack.length > 0 && dialogStack[dialogStack.length - 1] === token;
      }

      function handleKey(event) {
        if (!isTopDialog()) return;
        if (event.key === 'Escape') {
          if (dialogEscapeDeferred(event)) return;
          event.preventDefault();
          if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
          event.stopPropagation();
          if (busyRef.current) return;
          escapeClosed = true;
          if (typeof onCloseRef.current === 'function') onCloseRef.current();
          return;
        }
        if (event.key !== 'Tab') return;
        var panel = panelRef && panelRef.current;
        if (!panel) return;
        var candidates = focusableElements(panel);
        if (candidates.length === 0) {
          event.preventDefault();
          focusNode(panel);
          return;
        }
        var first = candidates[0];
        var last = candidates[candidates.length - 1];
        var active = doc.activeElement;
        if (event.shiftKey) {
          if (active === first || !panel.contains(active)) {
            event.preventDefault();
            focusNode(last);
          }
        } else if (active === last || !panel.contains(active)) {
          event.preventDefault();
          focusNode(first);
        }
      }

      doc.addEventListener('keydown', handleKey, true);
      return function () {
        var at = dialogStack.indexOf(token);
        if (at !== -1) dialogStack.splice(at, 1);
        cancelFrame(frame);
        doc.removeEventListener('keydown', handleKey, true);
        if (previous && typeof previous.focus === 'function' && doc.contains(previous)) {
          focusNode(previous);
          if (escapeClosed && previous !== doc.body
            && previous.classList && typeof previous.classList.add === 'function') {
            previous.classList.add('gr-focus-silent');
            var clearSilent = function () {
              previous.classList.remove('gr-focus-silent');
              doc.removeEventListener('keydown', clearSilent, true);
              doc.removeEventListener('pointerdown', clearSilent, true);
            };
            doc.addEventListener('keydown', clearSilent, true);
            doc.addEventListener('pointerdown', clearSilent, true);
          }
        }
      };
    }, [open, panelRef]);
  }

  /**
   * Contract props: { open, title, subtitle, onClose, busy, children, footer,
   * t, width, height, className, closeIcon, scoped }. The close icon is
   * injectable so the component kit stays icon-agnostic; callers pass their own
   * glyph. `scoped` makes the backdrop absolute inside the nearest positioned
   * ancestor (a floating review window) instead of fixed over the whole page.
   */
  function Modal(props) {
    var t = makeT(props.t);
    var open = !!props.open;
    var busy = !!props.busy;
    var panelRef = React.useRef(null);
    useDialogFocus(open, busy, props.onClose, panelRef);
    if (!open) return null;
    var dialogLabel = props.ariaLabel
      ? String(props.ariaLabel)
      : (typeof props.title === 'string' && props.title ? props.title : t('app.title'));
    var style = {
      width: props.width || 'min(94vw, 1600px)',
      height: props.height || 'min(92vh, 1000px)',
    };
    return h('div', {
      className: cx('gr-modal-backdrop', props.scoped && 'gr-modal-backdrop-scoped'),
      onMouseDown: function (event) {
        if (event.target !== event.currentTarget || busy) return;
        if (typeof props.onClose === 'function') props.onClose();
      },
    }, h('div', {
      className: cx('gr-modal', props.className),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': dialogLabel,
      ref: panelRef,
      tabIndex: -1,
      style: style,
    },
      h('div', { className: 'gr-modal-head' },
        h('div', { className: 'gr-modal-titles' },
          h('h2', { className: 'gr-modal-title' }, props.title || ''),
          props.subtitle ? h('p', { className: 'gr-modal-subtitle' }, props.subtitle) : null
        ),
        props.actions ? h('div', { className: 'gr-modal-actions' }, props.actions) : null,
        h(IconButton, {
          label: t('app.close'),
          className: 'gr-modal-close',
          onClick: busy ? undefined : props.onClose,
          disabled: busy,
          t: t,
        }, props.closeIcon || h('span', { 'aria-hidden': 'true' }, '\u00d7'))
      ),
      h('div', { className: 'gr-modal-body' }, props.children),
      props.footer ? h('div', { className: 'gr-modal-foot' }, props.footer) : null
    ));
  }

  /* ------------------------------------------------------------------ */
  /* Leaf primitives                                                      */
  /* ------------------------------------------------------------------ */

  /** A single keyboard-key cap. */
  function Kbd(props) {
    return h('kbd', { className: cx('gr-kbd', props.className) }, props.children);
  }

  /** A pill with an optional leading icon; tone maps to .gr-chip-<tone>. */
  function Chip(props) {
    return h('span', {
      className: cx('gr-chip', props.tone && 'gr-chip-' + props.tone, props.className),
      title: props.title || undefined,
    },
      props.icon ? h('span', { className: 'gr-chip-icon', 'aria-hidden': 'true' }, props.icon) : null,
      h('span', { className: 'gr-chip-label' }, props.children));
  }

  /** A quiet inline tag. */
  function Tag(props) {
    return h('span', {
      className: cx('gr-tag', props.className),
      title: props.title || undefined,
    }, props.children);
  }

  /** A file search field: leading icon, themed input and optional clear button. */
  function SearchInput(props) {
    var value = props.value === undefined || props.value === null ? '' : String(props.value);
    return h('div', { className: cx('gr-search-field', props.className) },
      h('span', { className: 'gr-search-icon', 'aria-hidden': 'true' }, props.icon),
      h('input', {
        type: 'text',
        className: 'gr-search-input',
        value: value,
        placeholder: props.placeholder || undefined,
        'aria-label': props.ariaLabel || undefined,
        spellCheck: false,
        autoComplete: 'off',
        onChange: function (event) {
          if (typeof props.onChange === 'function') props.onChange(event.target.value);
        },
      }),
      value && typeof props.onClear === 'function'
        ? h('button', {
          type: 'button',
          className: 'gr-search-clear',
          title: props.clearLabel || undefined,
          'aria-label': props.clearLabel || undefined,
          onClick: props.onClear,
        }, props.clearIcon)
        : null);
  }


  exports.makeT = makeT;
  exports.cx = cx;
  exports.Spinner = Spinner;
  exports.IconButton = IconButton;
  exports.Button = Button;
  exports.Badge = Badge;
  exports.Checkbox = Checkbox;
  exports.LinkButton = LinkButton;
  exports.Switch = Switch;
  exports.TextField = TextField;
  exports.Textarea = Textarea;
  exports.Select = Select;
  exports.SettingSection = SettingSection;
  exports.SettingRow = SettingRow;
  exports.Hint = Hint;
  exports.Modal = Modal;
  exports.useDialogFocus = useDialogFocus;
  exports.focusNode = focusNode;
  exports.dialogEscapeDeferred = dialogEscapeDeferred;
  exports.ESC_DEFER_SELECTOR = ESC_DEFER_SELECTOR;
  exports.Kbd = Kbd;
  exports.Chip = Chip;
  exports.Tag = Tag;
  exports.SearchInput = SearchInput;
});
