(() => {
  const OPEN = "{{";
  const CLOSE = "}}";
  const PLACEHOLDER = "A {{quorum}} is any majority of the cluster.";

  /** True when `s` is exactly one outer {{…}} pair (closing braces only at the end). */
  function isWrappedSpan(s) {
    return s.length >= OPEN.length + CLOSE.length
      && s.startsWith(OPEN)
      && s.endsWith(CLOSE)
      && s.indexOf(CLOSE) === s.length - CLOSE.length;
  }

  /** If start..end sits inside a single {{…}} span, return that span's bounds. */
  function enclosingSpan(value, start, end) {
    const openIdx = value.lastIndexOf(OPEN, Math.max(0, start));
    if (openIdx < 0) return null;
    const closeIdx = value.indexOf(CLOSE, end);
    if (closeIdx < 0) return null;
    const spanEnd = closeIdx + CLOSE.length;
    if (start < openIdx || end > spanEnd) return null;
    const span = value.slice(openIdx, spanEnd);
    if (!isWrappedSpan(span)) return null;
    // Reject if another {{ opens between this open and the selection (nested / adjacent).
    const nextOpen = value.indexOf(OPEN, openIdx + OPEN.length);
    if (nextOpen >= 0 && nextOpen < start) return null;
    return { openIdx, spanEnd, span };
  }

  /**
   * Wrap the textarea selection in {{…}}, unwrap if it is already a single
   * outer pair (or sits inside one), or insert {{}} with the caret inside
   * when nothing is selected.
   */
  function wrapClozeSelection(textarea) {
    if (!textarea || typeof textarea.value !== "string") return;
    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? start;
    const value = textarea.value;
    const selected = value.slice(start, end);

    let next;
    let selStart;
    let selEnd;

    if (start === end) {
      const enc = enclosingSpan(value, start, end);
      if (enc) {
        const inner = enc.span.slice(OPEN.length, enc.span.length - CLOSE.length);
        next = value.slice(0, enc.openIdx) + inner + value.slice(enc.spanEnd);
        selStart = enc.openIdx;
        selEnd = enc.openIdx + inner.length;
      } else {
        next = value.slice(0, start) + OPEN + CLOSE + value.slice(end);
        selStart = start + OPEN.length;
        selEnd = selStart;
      }
    } else if (isWrappedSpan(selected)) {
      const inner = selected.slice(OPEN.length, selected.length - CLOSE.length);
      next = value.slice(0, start) + inner + value.slice(end);
      selStart = start;
      selEnd = start + inner.length;
    } else {
      const enc = enclosingSpan(value, start, end);
      if (enc) {
        const inner = enc.span.slice(OPEN.length, enc.span.length - CLOSE.length);
        next = value.slice(0, enc.openIdx) + inner + value.slice(enc.spanEnd);
        selStart = enc.openIdx;
        selEnd = enc.openIdx + inner.length;
      } else {
        next = value.slice(0, start) + OPEN + selected + CLOSE + value.slice(end);
        selStart = start;
        selEnd = start + OPEN.length + selected.length + CLOSE.length;
      }
    }

    textarea.value = next;
    textarea.focus();
    textarea.setSelectionRange(selStart, selEnd);
  }

  window.wrapClozeSelection = wrapClozeSelection;
  window.CLOZE_PLACEHOLDER = PLACEHOLDER;
})();
