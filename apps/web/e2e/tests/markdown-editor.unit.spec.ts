import { expect, test } from '@playwright/test';
import { applyMarkdownFormat } from '../../src/components/markdownFormatter';

test.describe('markdownFormatter', () => {
  test('applies formatting around selected text', () => {
    const result = applyMarkdownFormat('test', '**', '**', 0, 4);
    expect(result.newValue).toBe('**test**');
    expect(result.newSelectionStart).toBe(2);
    expect(result.newSelectionEnd).toBe(6);
  });

  test('applies formatting when no text is selected', () => {
    const result = applyMarkdownFormat('hello world', '_', '_', 6, 6);
    expect(result.newValue).toBe('hello __world');
    const result2 = applyMarkdownFormat('test', '**', '**', 4, 4);
    expect(result2.newValue).toBe('test****');
    expect(result2.newSelectionStart).toBe(6);
    expect(result2.newSelectionEnd).toBe(6);
  });
});
