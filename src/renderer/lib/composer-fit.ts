/**
 * The width a Claude chat needs so its composer's buttons all fit: the chat's narrowest width
 * (useChatMinWidth.ts), which the browser drawer and the sidebars beside the chat keep.
 *
 * The composer's tool row is marked `data-composer-row`. Each of its children counts at its own
 * full width (whatever room the row has now: the model's label may be truncated), except those
 * marked `data-composer-shrinks` (text that may truncate to nothing), so a button added to the row
 * later is counted without anything else to change.
 */

const px = (value: string): number => Number.parseFloat(value) || 0;

/** Horizontal padding and border of an element */
function insets(element: Element): number {
  const style = getComputedStyle(element);
  return px(style.paddingLeft) + px(style.paddingRight) + px(style.borderLeftWidth) + px(style.borderRightWidth);
}

let scrollbarSize: number | null = null;
/** A vertical scrollbar's width (0 where scrollbars overlay the content) */
function scrollbarWidth(): number {
  if (scrollbarSize !== null) return scrollbarSize;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;top:-9999px;width:100px;height:100px;overflow-y:scroll';
  document.body.append(probe);
  scrollbarSize = Math.max(0, probe.offsetWidth - probe.clientWidth);
  probe.remove();
  return scrollbarSize;
}

/** The children that count, each at its own full width (laid out once, at max-content, then put back) */
function partWidths(row: HTMLElement): number[] {
  const parts = Array.from(row.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement && getComputedStyle(child).display !== 'none'
  );
  const saved = parts.map((part) => part.style.cssText);
  for (const part of parts) {
    if (part.hasAttribute('data-composer-shrinks')) continue;
    part.style.width = 'max-content';
    part.style.minWidth = 'max-content';
    part.style.maxWidth = 'none';
    part.style.flexShrink = '0';
  }
  const widths = parts.map((part) => {
    if (part.hasAttribute('data-composer-shrinks')) return 0;
    const style = getComputedStyle(part);
    return part.getBoundingClientRect().width + px(style.marginLeft) + px(style.marginRight);
  });
  parts.forEach((part, index) => {
    part.style.cssText = saved[index];
  });
  return widths;
}

/** What the row needs: its parts' own widths (shrinking ones none), the gaps between them, its padding */
export function rowContentWidth(row: HTMLElement): number {
  const widths = partWidths(row);
  const gap = px(getComputedStyle(row).columnGap);
  return insets(row) + widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
}

/**
 * The chat column's width at which the row just fits: the row's needs plus the padding, borders and
 * scrollbar room of what holds it, up to the column (a scrolling container counts its scrollbar
 * whether or not it shows one now; centering margins grow with the column, so they don't count)
 */
export function chatWidthForRow(row: HTMLElement, column: HTMLElement): number {
  let width = rowContentWidth(row);
  for (let element = row.parentElement; element; element = element.parentElement) {
    width += insets(element);
    const overflowY = getComputedStyle(element).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') width += scrollbarWidth();
    if (element === column) break;
  }
  return Math.ceil(width);
}
