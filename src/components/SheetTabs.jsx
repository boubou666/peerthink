import { useEffect, useReducer, useRef, useState } from 'react';

import { useAsk } from './AskDialog.jsx';

/**
 * The board's sheets, along the bottom.
 *
 * Where every tool that has sheets puts them, which is the whole argument: a
 * tab strip is not a thing anybody needs explaining, and putting it anywhere
 * else would make it one.
 *
 * It renders in screen space over the stage rather than in the world layer,
 * for the reason the toolbar and the format bar do — chrome that scales with
 * the zoom is unreadable at 30% and absurd at 300%.
 *
 * Who may add or remove one is not asked here, and deliberately: nothing else
 * on this canvas asks either. A viewer can drag a card about all day; what
 * stops it being everyone else's problem is that the write is refused at the
 * database. Sheets are part of the document and follow the document's rule.
 */
export function SheetTabs({ app }) {
  const { sheets, commands } = app;

  const [, bump] = useReducer((n) => n + 1, 0);
  useEffect(() => sheets.on(bump), [sheets, bump]);

  const [dialog, ask] = useAsk();
  const [menu, setMenu] = useState(null);
  const strip = useRef(null);

  // The menu is a popover over the canvas: it closes when the next thing
  // happens somewhere else, the same way the colour picker's panel does.
  useEffect(() => {
    if (!menu) return;

    const dismiss = (event) => {
      if (!strip.current?.contains(event.target)) setMenu(null);
    };
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setMenu(null);
    };

    /**
     * The position was measured once, when the button was clicked, and the
     * menu is fixed — so anything that moves the button afterwards leaves the
     * menu pointing at where it used to be. Two things do that without a
     * pointer going down anywhere: a wheel scroll over the strip, and the
     * window being resized.
     *
     * Closing is the honest answer. Following would mean re-measuring on every
     * frame of a scroll to keep open a menu the person has already left.
     */
    const stale = () => setMenu(null);

    // Captured now, because the effect's cleanup runs after a render in which
    // the ref may already point somewhere else.
    const scroller = strip.current;

    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', stale);
    scroller?.addEventListener('scroll', stale);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', stale);
      scroller?.removeEventListener('scroll', stale);
    };
  }, [menu]);

  const list = sheets.list();

  const rename = async (sheet) => {
    setMenu(null);
    const name = await ask.prompt({
      title: 'Rename sheet',
      label: 'Name',
      value: sheet.name,
      confirmLabel: 'Rename',
    });
    if (name !== null) commands.renameSheet(sheet.id, name);
  };

  const remove = async (sheet) => {
    setMenu(null);
    const sure = await ask.confirm({
      title: `Delete “${sheet.name}”?`,
      message: 'Everything on this sheet goes with it. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (sure) commands.removeSheet(sheet.id);
  };

  return (
    <>
      {dialog}
      <div
        ref={strip}
        className="sheet-tabs"
        data-sheet-tabs
        role="tablist"
        aria-label="Sheets"
        // The strip is chrome over the canvas: a pointerdown that reached the
        // stage would start a marquee on the sheet being left.
        onPointerDown={(event) => event.stopPropagation()}
      >
        {list.map((sheet) => {
          const current = sheet.id === sheets.activeId;
          return (
            <div key={sheet.id} className="sheet-tab" data-sheet={sheet.id} data-current={current ? '' : undefined}>
              <button
                type="button"
                className="sheet-name"
                role="tab"
                aria-selected={current}
                title={sheet.name}
                onClick={() => commands.selectSheet(sheet.id)}
                // Double-click renames, which is what a tab does everywhere
                // else. The menu is for the same thing, for anyone who does
                // not know that or cannot double-click.
                onDoubleClick={() => rename(sheet)}
              >
                {sheet.name}
              </button>

              {current && sheets.settled && (
                <button
                  type="button"
                  className="sheet-more"
                  data-action="sheet-menu"
                  aria-label={`${sheet.name}: more`}
                  aria-haspopup="menu"
                  aria-expanded={menu?.id === sheet.id}
                  title="More"
                  /*
                   * The menu is positioned from this button's box rather than
                   * hung off the tab, because the strip scrolls: an absolutely
                   * positioned child of a scroll container is clipped by it,
                   * and a menu that opens upwards is entirely outside the box
                   * doing the clipping. Measured here, drawn fixed.
                   */
                  onClick={(event) => {
                    if (menu?.id === sheet.id) return setMenu(null);
                    const at = event.currentTarget.getBoundingClientRect();
                    setMenu({ id: sheet.id, left: at.left, bottom: window.innerHeight - at.top + 6 });
                  }}
                >
                  ⋯
                </button>
              )}

              {menu?.id === sheet.id && (
                <div
                  className="sheet-menu"
                  role="menu"
                  aria-label={`${sheet.name}: actions`}
                  style={{ left: `${menu.left}px`, bottom: `${menu.bottom}px` }}
                >
                  <button type="button" role="menuitem" data-action="rename-sheet" onClick={() => rename(sheet)}>
                    Rename
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-action="duplicate-sheet"
                    onClick={() => { setMenu(null); commands.duplicateSheet(sheet.id); }}
                  >
                    Duplicate
                  </button>
                  {/*
                    A board with no sheets has no canvas, so the last one
                    cannot go. The control is absent rather than disabled: a
                    disabled Delete invites a second click and explains
                    nothing, and there is nothing here to explain.
                  */}
                  {list.length > 1 && (
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      data-action="delete-sheet"
                      onClick={() => remove(sheet)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/*
          Absent until the board has arrived. The sheets on screen before that
          are a placeholder the load replaces, so a sheet added to them would
          be wiped a moment later — and on a fast load nobody sees this at all.
        */}
        {sheets.settled && (
          <button
            type="button"
            className="sheet-add"
            data-action="add-sheet"
            aria-label="New sheet"
            title="New sheet"
            onClick={() => commands.addSheet()}
          >
            +
          </button>
        )}
      </div>
    </>
  );
}
