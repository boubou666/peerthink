/**
 * The board a first-time visitor lands on. It doubles as a tour: every object
 * type is present, and the copy explains the gestures that are not obvious.
 */
export function seedBoard(board) {
  const objects = [
    board.make('envelope', { x: -40, y: -60, w: 520, h: 380, title: 'Discovery' }),
    board.make('card', { x: 0, y: 0, text: 'What problem are we actually solving?', color: 'yellow' }),
    board.make('card', { x: 230, y: 20, text: 'Who feels it most?', color: 'blue' }),
    board.make('card', { x: 40, y: 160, text: 'Drag me. Double-click to edit.', color: 'green' }),
    board.make('card', { x: 250, y: 190, w: 200, h: 100, text: 'Drop cards inside an envelope — it carries them.', color: 'pink' }),
    board.make('list', {
      x: 560,
      y: -20,
      title: 'Next up',
      items: [board.newItem('Pick a sync strategy'), board.newItem('Presence cursors'), board.newItem('Share links')],
    }),
    board.make('card', { x: 560, y: 240, w: 240, h: 90, text: 'Alt-drag disables snapping.', color: 'white' }),
  ];

  // record:false — there is nothing to undo back to on a fresh board
  board.store.apply(objects.map((obj) => ({ t: 'add', obj })), false);
  return objects;
}
