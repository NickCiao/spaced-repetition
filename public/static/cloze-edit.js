(() => {
  const OPEN = "{{";
  const CLOSE = "}}";
  const PLACEHOLDER = "A {{quorum}} is any majority of the cluster.";

  /** True when `s` is exactly one outer {{…}} pair (no nested requirement). */
  function isWrappedSpan(s) {
    return s.length >= OPEN.length + CLOSE.length
      && s.startsWith(OPEN)
      && s.endsWith(CLOSE)
      && s.indexOf(CLOSE) === s.length - CLOSE.length;
  }

  /**
   * Wrap the textarea selection in {{…}}, unwrap if it is already a single
   * outer pair, or insert {{}} with the caret inside when nothing is selected.
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
      next = value.slice(0, start) + OPEN + CLOSE + value.slice(end);
      selStart = start + OPEN.length;
      selEnd = selStart;
    } else if (isWrappedSpan(selected)) {
      const inner = selected.slice(OPEN.length, selected.length - CLOSE.length);
      next = value.slice(0, start) + inner + value.slice(end);
      selStart = start;
      selEnd = start + inner.length;
    } else {
      next = value.slice(0, start) + OPEN + selected + CLOSE + value.slice(end);
      selStart = start;
      selEnd = start + OPEN.length + selected.length + CLOSE.length;
    }

    textarea.value = next;
    textarea.focus();
    textarea.setSelectionRange(selStart, selEnd);
  }

  window.wrapClozeSelection = wrapClozeSelection;
  window.CLOZE_PLACEHOLDER = PLACEHOLDER;
})();
