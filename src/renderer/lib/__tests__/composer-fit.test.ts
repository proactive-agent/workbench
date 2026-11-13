/**
 * The chat's narrowest width: the composer's tool row's parts at their own widths, the gaps
 * between them and the padding up to the chat column (text that may truncate counts nothing)
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { chatWidthForRow, rowContentWidth } from '../composer-fit';

function el(style: Partial<CSSStyleDeclaration>, width = 0, attrs: Record<string, string> = {}): HTMLElement {
  const element = document.createElement('div');
  Object.assign(element.style, style);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  element.getBoundingClientRect = () => ({ width } as DOMRect);
  return element;
}

describe('composer fit', () => {
  it("adds the parts' widths, the gaps and the row's padding; truncating text and hidden parts count nothing", () => {
    const row = el({ columnGap: '8px', paddingLeft: '10px', paddingRight: '10px' });
    row.append(el({}, 200), el({}, 999, { 'data-composer-shrinks': '' }), el({ display: 'none' }, 50), el({ marginLeft: '4px' }, 120));
    // 200 + 0 + 4 + 120, two gaps between three shown parts, 20 of padding
    expect(rowContentWidth(row)).toBe(360);
  });

  it('counts each part at its full width, also while the row has squeezed it (a truncated model label)', () => {
    const row = el({});
    const model = el({ minWidth: '0px' });
    // Squeezed to 80 now; 180 at its own width
    model.getBoundingClientRect = () => ({ width: model.style.width === 'max-content' ? 180 : 80 } as DOMRect);
    row.append(model);
    expect(rowContentWidth(row)).toBe(180);
    // Put back as it was
    expect(model.style.width).toBe('');
    expect(model.style.minWidth).toBe('0px');
  });

  it('counts the padding and borders of what holds the row, up to the chat column', () => {
    const column = el({ paddingLeft: '16px', paddingRight: '16px' });
    const box = el({ borderLeftWidth: '1px', borderRightWidth: '1px', borderStyle: 'solid' });
    const row = el({}, 0);
    row.append(el({}, 300.4));
    box.append(row);
    column.append(box);
    document.body.append(el({ paddingLeft: '100px' }));
    expect(chatWidthForRow(row, column)).toBe(Math.ceil(300.4 + 2 + 32));
  });
});
