// Read-only rendered-layout assertions, usable with browser evaluate() in the
// settings preview or native WebView. No fixture state or provider calls.
// Keep this function self-contained so runners can serialize it into the page.
export function inspectSettingsLayout({ requireProviders = false } = {}) {
  const failures = [];
  let checks = 0;
  const visible = (element) => {
    const closed = element.closest('details:not([open])');
    return (!closed || closed.querySelector('summary')?.contains(element)) &&
      getComputedStyle(element).visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const check = (condition, message) => {
    checks += 1;
    if (!condition) failures.push(message);
  };
  const bounds = (element) => element.getBoundingClientRect();
  const label = (element) =>
    `${element.className}: ${element.textContent.trim().slice(0, 70)}`;
  const inside = (child, parent, inset = 0) =>
    child.left >= parent.left + inset - 1 &&
    child.right <= parent.right - inset + 1;
  const surfaces = [...document.querySelectorAll(
    '.gyro-settings-disclosure-body, .gyro-settings-group-rows, .gyro-settings-row, .gyro-provider-table, .gyro-provider-row',
  )].filter(visible);
  check(surfaces.length > 0, 'No settings content rendered');
  for (const surface of surfaces) {
    check(surface.scrollWidth <= surface.clientWidth + 1,
      `Horizontal overflow: ${label(surface)}`);
  }
  const tables = [...document.querySelectorAll('.gyro-provider-table')].filter(visible);
  if (requireProviders) check(tables.length > 0, 'No provider table rendered');
  for (const table of tables) {
    const council = table.nextElementSibling;
    if (council?.classList.contains('gyro-model-council-disclosure')) {
      check(bounds(council).top - bounds(table).bottom >= 6,
        'Council touches the rounded provider panel edge');
    }
    const title = table.previousElementSibling;
    if (title?.classList.contains('gyro-provider-connect-help') && title.previousElementSibling) {
      check(bounds(title).top - bounds(title.previousElementSibling).bottom >= 16,
        'Provider heading crowds the preceding account panel');
    }
    for (const menu of table.querySelectorAll('.gyro-provider-details[open] > div')) {
      check(inside(bounds(menu), bounds(table), 8), 'Open provider menu escapes its table');
      check(menu.scrollWidth <= menu.clientWidth + 1, 'Open provider menu clips its contents horizontally');
    }
    const head = table.querySelector('.gyro-provider-table-head');
    const rows = [...table.querySelectorAll(':scope > .gyro-provider-row')];
    check(rows.length > 0, 'Provider table has no rows');
    if (!visible(head) && rows.length) {
      check(+getComputedStyle(rows[0]).borderTopLeftRadius.replace('px', '') >=
        +getComputedStyle(table).borderTopLeftRadius.replace('px', '') - 1,
      'First provider hover row has square corners inside a rounded panel');
    }
    for (const row of rows) {
      const rowBounds = bounds(row);
      const cells = [...row.children].filter(visible);
      for (const cell of cells) {
        check(inside(bounds(cell), rowBounds, 16), `Cell outside row gutter: ${label(cell)}`);
        for (const control of cell.querySelectorAll('button, summary')) {
          // Popover contents float independently; the summary trigger must fit.
          if (!visible(control) || (control.closest('.gyro-provider-details') && control.tagName !== 'SUMMARY')) continue;
          check(inside(bounds(control), rowBounds, 16), `Control outside row: ${label(control)}`);
        }
      }
      for (let a = 0; a < cells.length; a += 1) {
        for (let b = a + 1; b < cells.length; b += 1) {
          const x = bounds(cells[a]);
          const y = bounds(cells[b]);
          check(Math.min(x.right, y.right) - Math.max(x.left, y.left) <= 1 ||
            Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) <= 1,
          `Overlapping provider cells: ${label(cells[a])} / ${label(cells[b])}`);
        }
      }
      if (visible(head)) {
        check(getComputedStyle(head).gridTemplateColumns === getComputedStyle(row).gridTemplateColumns,
          'Provider header and row columns differ');
      }
    }
  }
  return { checks, failures, tables: tables.map((table) => ({
    width: table.clientWidth, scrollWidth: table.scrollWidth,
    rows: table.querySelectorAll(':scope > .gyro-provider-row').length,
    columns: getComputedStyle(table.querySelector('.gyro-provider-row')).gridTemplateColumns,
  })) };
}
