export function applyMarkdownFormat(
  value: string,
  prefix: string,
  suffix: string,
  selectionStart: number,
  selectionEnd: number
) {
  const text = typeof value === 'string' ? value : String(value);
  const before = text.substring(0, selectionStart);
  const selected = text.substring(selectionStart, selectionEnd);
  const after = text.substring(selectionEnd);

  return {
    newValue: before + prefix + selected + suffix + after,
    newSelectionStart: selectionStart + prefix.length,
    newSelectionEnd: selectionEnd + prefix.length,
  };
}
