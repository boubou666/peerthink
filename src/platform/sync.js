import { createIdGenerator } from '../core/ids.js';
import { isSheetChange } from '../core/sheets.js';
import { LOCAL, isOp } from '../core/store.js';

/**
 * Live collaboration: the op log, on a wire.
 *
 * The store was built so that every change is a list of plain, serialisable
 * ops. This is the layer that takes that literally — what a client applies
 * locally is exactly what it sends, and what it receives is applied through
 * the same `apply()` the local UI uses. There is no second representation of a
 * change, and so no second implementation to keep honest.
 *
 * Broadcast, not database replication. These messages never touch a table:
 * Postgres holds the settled snapshot that `hydrate()` reads, and the ops
 * between two snapshots are traffic. Replicating per-op through the database
 * would be a write, a WAL record and a fan-out for every frame of a drag.
 *
 * The channel is **private**, so joining it is authorised by row level
 * security on `realtime.messages` — the same `board_role()` that guards the
 * table. A public channel would have made the board's contents readable by
 * anyone who could guess its id, which is the protection the rest of this
 * branch exists to provide.
 *
 * What this does not do is make concurrent editing correct. Ops are applied in
 * arrival order with no transform, so two people dragging the same object
 * settle on whoever's message landed last. That is the honest limit of an op
 * log without a CRDT, and it is fine for the case this is for: several people
 * on one board, mostly working in different corners of it.
 */

export const EVENT = 'ops';

/**
 * Changes to the set of sheets, as opposed to changes on one of them.
 *
 * A separate event because it is a separate vocabulary — `isOp` answers for
 * what happens to objects, `isSheetChange` for what happens to sheets — and
 * because a client that does not know this event simply ignores it, which is
 * the right thing for one to do with a message about sheets it has not got.
 */
export const SHEET_EVENT = 'sheet';

/**
 * Pointers travel as broadcast, not as presence updates.
 *
 * Presence answers "who is on this board" — it diffs state and fans the whole
 * set out to everyone on every change, which is the right shape for a list of
 * people and the wrong shape for something that moves at pointer rate. A
 * cursor is a fact with a short life; it does not need to be reconciled, only
 * delivered.
 */
export const CURSOR_EVENT = 'cursor';

/** Stands in for a position, so one queue carries "here" and "gone". */
const GONE = Symbol('gone');

/** A board's topic. The id shape excludes ':', so this parses unambiguously. */
export const topicFor = (boardId) => `board:${boardId}`;

/**
 * Who, of everyone on the board, writes the snapshot.
 *
 * Ops keep the live documents identical, but the row in Postgres is written by
 * whole-document save, and every editor autosaving one is every editor able to
 * overwrite the others. So exactly one of them does it, and the rest stop.
 *
 * The rule is earliest joiner, ties broken by id: every client computes it
 * from the same presence state and reaches the same answer without anyone
 * deciding, and someone arriving does not take the job from whoever is already
 * doing it. The clocks are self-reported and need not agree — this is a total
 * order, not a measurement, and choosing the wrong writer is not a failure.
 */
export function electWriter(members) {
  return [...members].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))[0] ?? null;
}

export function createBoardSync({
  client,
  boardId,
  // Where local ops come from — always the sheet on screen — and where remote
  // ones go, which is whichever sheet they were made on. Two objects because
  // they are two questions: `store` is the canvas, `sheets` is the board.
  store,
  sheets,
  scheduler,
  onStatus,
  onWriter,
  onCursor,
  onMembers,
  identity = {},
  // Resolves when this client has a document to apply remote ops to. Absent,
  // there is nothing to wait for and they are applied as they arrive.
  heldUntil = null,
  sendEvery = 50,
  cursorEvery = 60,
  clientId = createIdGenerator()(),
  now = () => Date.now(),
}) {
  const topic = topicFor(boardId);
  const queue = [];
  let stopped = false;

  /**
   * Whether this client has a document yet — see the held-ops block below,
   * which explains what that is for. Declared up here because both directions
   * now consult it: inbound ops are held until there is a document to apply
   * them to, and outbound ones until there is a sheet to address them by.
   */
  const held = [];
  let holding = Boolean(heldUntil);

  // True until presence says otherwise — a board nobody else is on is a board
  // this client writes, and so is one where the channel never came up. The
  // version guard in the repository is what covers the case where that is
  // wrong, which is exactly the case presence cannot see.
  // What presence says: true until it says otherwise — a board nobody else is
  // on is a board this client writes.
  let elected = true;

  /**
   * Whether the channel is up *now*, rather than whether it ever came up.
   *
   * This is the difference between deferring to another writer and merely
   * hoping there is one. `channel.send` for a broadcast without `ack` resolves
   * `'ok'` the moment it is called — before the socket has been written to,
   * never mind the server reached — so a send that went nowhere is
   * indistinguishable from one that landed. Nothing in a single message can
   * tell us. The connection can.
   */
  let live = false;

  /**
   * Whether this client should write the snapshot.
   *
   * Elected, or unable to be sure anyone else is receiving what it sends. The
   * second half is the point: standing down is a promise that somebody *else*
   * is saving these edits, and that promise is only as good as the channel
   * carrying them. A client whose channel has dropped holds ops the elected
   * writer has never seen, and is the only one that can store them.
   *
   * Two clients writing at once is the case the version guard in the
   * repository already exists for — and it is much the better failure. One is
   * a refused write that retries; the other is work that was never anywhere.
   */
  const shouldWrite = () => elected || !live;

  // What `onWriter` was last told, so a change is reported once.
  let announced = shouldWrite();

  /**
   * Ops go out immediately, and then at most every `sendEvery` ms while they
   * keep coming — a drag emits a `set` per pointer move per object, and one
   * message per op would be a burst nobody needs at that resolution. The first
   * op of any gesture is not delayed, so the latency a person notices is the
   * network's rather than this.
   *
   * A timer rather than a frame, deliberately: `requestAnimationFrame` stops
   * in a tab that is not being drawn, which would leave a switched-away tab
   * sitting on ops it had already applied locally.
   *
   * The queue holds *batches*, each naming the sheet its ops were made on. The
   * sheet is taken when the ops arrive rather than when the batch is sent: the
   * two are up to `sendEvery` apart, and switching sheets in that window is one
   * click — the ops would go out addressed to the sheet the person moved to,
   * and land there on everyone else's screen.
   *
   * `sheet: null` is "not settled yet". Before the board has loaded there is a
   * sheet on screen, but it is the empty one this client started with, and the
   * load is about to replace it with the board's own. Those ops are the same
   * ops on what is about to be the same canvas, so they are addressed when they
   * go out — which, while `holding`, is after the load.
   */
  const flush = scheduler.throttle(() => {
    // Nothing goes out unaddressed. Inbound is held until there is a document
    // to apply it to; outbound is held until there is one to name.
    if (stopped || holding) return;

    const batches = queue.splice(0, queue.length);
    for (const batch of batches) {
      const payload = { ops: batch.ops, sheet: batch.sheet ?? sheets.activeId };
      // A send that fails is a dropped frame of somebody else's view, not a
      // reason to take this session down: the snapshot is still being written.
      Promise.resolve(channel.send({ type: 'broadcast', event: EVENT, payload })).catch(
        () => {},
      );
    }
  }, sendEvery);

  /**
   * A sheet added, renamed or removed here, sent as it happens.
   *
   * Not queued or throttled, unlike ops: these come from a click rather than
   * from a gesture, so there is never a burst of them to coalesce, and a sheet
   * that exists on one screen and not another for 50ms is a sheet somebody
   * else's ops can arrive for. Held before hydration for the same reason
   * everything else is — there is no board yet to change.
   */
  const unsubscribeSheets = sheets.onChanges((changes, origin) => {
    if (stopped || origin !== LOCAL || holding) return;
    Promise.resolve(
      channel.send({ type: 'broadcast', event: SHEET_EVENT, payload: { changes } }),
    ).catch(() => {});
  });

  const unsubscribeStore = store.onOps((ops, origin) => {
    if (stopped || origin !== LOCAL) return;

    const sheet = holding ? null : sheets.activeId;
    const last = queue[queue.length - 1];
    // Ops made in a row on one sheet stay one message — a drag is a `set` per
    // pointer move, and a message each is the burst this throttle exists to
    // avoid.
    if (last && last.sheet === sheet) last.ops.push(...ops);
    else queue.push({ sheet, ops: [...ops] });

    flush();
  });

  // One sync per client per board. `client.channel()` hands back the channel
  // it already has for a topic rather than a second one, and a channel that
  // has been subscribed refuses new listeners — so building two of these for
  // the same board on one client throws here rather than quietly sharing.
  const channel = client.channel(topic, {
    config: { private: true, broadcast: { self: false } },
  });

  /**
   * Someone else's ops, on the sheet they were made on.
   *
   * `sheet` is absent from a client that predates sheets, and from one whose
   * board has only ever had the one. Both mean the same thing — the canvas
   * they are looking at — and the active sheet is this client's best and only
   * reading of that. A sheet this client has not got is dropped by `sheets`
   * rather than guessed at.
   */
  const receive = (sheet, ops) => {
    // record: false — someone else's edit does not belong in this user's undo
    // stack, and REMOTE is what stops it being sent straight back out. Both
    // are `sheets`' to apply, since it is the one that knows which document
    // the ops are for.
    sheets.applyRemote(sheet ?? sheets.activeId, ops);
  };

  /**
   * Ops that arrived before this client had a document to apply them to.
   *
   * The channel is joined before the snapshot is read, so that the window
   * between the two stops being a window in which other people's edits are
   * lost. What arrives in it cannot be applied yet — `store.load()` replaces
   * the document, so anything applied first would be overwritten by a
   * snapshot that predates it — so it is held and replayed afterwards.
   *
   * Safe to replay for the same reason the local edits made during a load are:
   * `add` is idempotent, `del` and `set` ignore what is not there, and `order`
   * merges. An op already contained in the snapshot lands on top of itself.
   *
   * A load that failed resolves nothing: there is no document to replay onto,
   * the board is not saveable, and holding the ops would only pretend
   * otherwise.
   */
  // Terminal. A load that failed does not fail only for the ops already in
  // hand: there is no document for the next one either, and letting later
  // batches through would drip other people's work into a board that cannot be
  // saved — while before this client joined early, a failed load meant no
  // channel at all and so no remote ops ever.
  let abandoned = false;

  const release = () => {
    holding = false;
    // What this client made while it was waiting, which could not be addressed
    // until now — the sheet it was made on is the one the load just put on
    // screen.
    flush();

    const waiting = held.splice(0, held.length);
    if (stopped) return;
    /**
     * Batch by batch, in the order they arrived. Each ops batch names the
     * sheet it was made on — a flattened list would have to guess, and
     * guessing means one editor's work landing on another editor's canvas —
     * and the two kinds are replayed through one queue because their order is
     * the point: a sheet being added and then drawn on is two messages, and
     * the ops mean nothing until the sheet they name exists.
     */
    for (const batch of waiting) {
      if (batch.changes) sheets.applyChanges(batch.changes);
      else receive(batch.sheet, batch.ops);
    }
  };

  if (heldUntil) {
    Promise.resolve(heldUntil).then(release, () => {
      holding = false;
      abandoned = true;
      held.length = 0;
    });
  }

  channel.on('broadcast', { event: EVENT }, (message) => {
    const ops = message?.payload?.ops;
    if (stopped || !Array.isArray(ops)) return;

    // The whole batch is dropped rather than the bad op filtered out of it.
    // Everyone on this channel is an authorised editor, so this is not a
    // security boundary — it is a version boundary. A sender emitting one op
    // this client cannot read is a sender whose other ops mean something it
    // does not understand either, and half-applying that is worse than
    // ignoring it.
    if (!ops.every(isOp)) return;

    if (abandoned) return;

    // Checked after validation, so nothing is held that would have been
    // dropped on arrival — a replay is not the place to discover that.
    if (holding) {
      held.push({ sheet: message?.payload?.sheet, ops });
      return;
    }

    receive(message?.payload?.sheet, ops);
  });

  /**
   * Somebody added, renamed, duplicated or removed a sheet.
   *
   * Its own event rather than more `ops`, because it is a change to the board
   * rather than to a canvas: the ops vocabulary addresses objects within one
   * sheet, and stretching it to cover the set of sheets would leave `isOp`
   * answering for two different kinds of thing.
   *
   * Held with the ops rather than beside them, in the one queue, so a sheet
   * that was added and then drawn on is replayed in that order.
   */
  channel.on('broadcast', { event: SHEET_EVENT }, (message) => {
    const changes = message?.payload?.changes;
    if (stopped || !Array.isArray(changes)) return;

    // The whole batch, for the reason the ops batch is dropped whole: a sender
    // emitting one change this client cannot read is a sender whose other
    // changes mean something it does not understand either.
    if (!changes.every(isSheetChange)) return;
    if (abandoned) return;

    if (holding) {
      held.push({ changes });
      return;
    }

    sheets.applyChanges(changes);
  });

  channel.on('broadcast', { event: CURSOR_EVENT }, (message) => {
    const { id, x, y, gone } = message?.payload ?? {};
    if (stopped || typeof id !== 'string') return;

    // Never draw this client's own pointer. `broadcast: { self: false }` is
    // supposed to make this unreachable, and it is the transport's promise
    // rather than ours — one that costs nothing to keep ourselves and that
    // fails invisibly if it is ever broken. Invisibly, because presence
    // excludes self from `onMembers`, so a self-echoed pointer arrives with no
    // label and draws as an anonymous stranger on a board with nobody else on
    // it: the receiver has no way to recognise its own cursor.
    if (id === clientId) return;
    if (gone) return void onCursor?.({ id, gone: true });
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    onCursor?.({ id, x, y });
  });

  /**
   * Everyone currently on the board — what the election needs, and what tells
   * a cursor layer whose pointers to stop drawing. `label` is carried here
   * rather than on every cursor message: it is a property of the person, and
   * repeating it at pointer rate would be paying for it hundreds of times.
   */
  const members = () =>
    Object.values(channel.presenceState())
      .flat()
      .filter((meta) => typeof meta?.id === 'string' && Number.isFinite(meta.at))
      .map(({ id, at, label }) => ({ id, at, label }));

  /** Report a change in who writes, whatever caused it. */
  const announce = () => {
    if (stopped) return;
    const next = shouldWrite();
    if (next === announced) return;
    announced = next;
    onWriter?.(next);
  };

  const settleWriter = () => {
    if (stopped) return;
    const present = members();
    onMembers?.(present.filter((member) => member.id !== clientId));
    const winner = electWriter(present);
    // No presence state yet is not "somebody else writes" — it is nobody
    // having reported in, which leaves this client as the only one it knows.
    elected = winner ? winner.id === clientId : true;
    announce();
  };

  channel.on('presence', { event: 'sync' }, settleWriter);

  /**
   * Resolves with the subscription status rather than rejecting. A board that
   * cannot be joined — offline, or a policy that says no — still opens, still
   * edits and still saves; it is a board without other people in it.
   */
  const ready = new Promise((resolve) => {
    // Every status this callback can report is a settled one — SUBSCRIBED, or
    // one of the three ways it did not happen — so the first call is the
    // answer. Waiting for a *particular* status is how you wait forever: a
    // join the policy refuses reports CLOSED, not an error.
    channel.subscribe((status) => {
      onStatus?.(status);

      // Called again on every rejoin and every drop, not only the first time —
      // which is what makes it a connection state rather than a record of how
      // the join went. A client that stood down for an elected writer and then
      // lost the channel takes the job back here, because its ops are no
      // longer reaching whoever it stood down for.
      live = status === 'SUBSCRIBED';

      // Announcing presence is what makes this client electable — and what
      // tells the incumbent it is no longer alone. Until it lands, everyone
      // already here has an answer that does not include us, which is the
      // right answer for a client that has not arrived.
      if (status === 'SUBSCRIBED') channel.track({ ...identity, id: clientId, at: now() });

      // After track(), so a rejoin does not report itself as the writer for
      // the moment before presence has been told this client is back.
      announce();
      resolve(status);
    });
  });

  /**
   * Where this client's pointer is, in world coordinates — throttled, and
   * dropped rather than queued. An old position is not worth sending: whoever
   * receives it would draw a pointer that is no longer there.
   */
  let pending = null;
  const sendCursor = scheduler.throttle(() => {
    const next = pending;
    pending = null;
    if (!next || stopped) return;

    const payload = next === GONE ? { id: clientId, gone: true } : { id: clientId, ...next };
    Promise.resolve(
      channel.send({ type: 'broadcast', event: CURSOR_EVENT, payload }),
    ).catch(() => {});
  }, cursorEvery);

  return {
    topic,
    ready,
    clientId,

    /**
     * Whether this client is the one that writes the snapshot.
     *
     * True when elected, and also when the channel is down — see
     * `shouldWrite`. Standing down is a promise that somebody else is storing
     * these edits, and a client with no channel cannot keep it.
     */
    isWriter: () => shouldWrite(),

    /**
     * Whether the channel is up right now.
     *
     * Separate from `isWriter()` because they answer different questions, and
     * a caller that wants to say something to the person at the keyboard needs
     * this one: "saved" while disconnected is a different claim from "saved".
     */
    isLive: () => live,

    /**
     * Everyone else presence currently reports, with their labels — the same
     * list `onMembers` delivers. For tests and for the console, alongside
     * `app.cursors.list()`: between the two, "who is here" and "whose pointer
     * is drawn" can be compared, which is the question a cursor nobody can
     * account for actually poses.
     */
    members: () => members().filter((member) => member.id !== clientId),

    /** A point in world coordinates, or null for "my pointer has left". */
    moveCursor(point) {
      if (stopped) return;
      pending = point ?? GONE;
      sendCursor();
    },

    async destroy() {
      stopped = true;
      // A load that never settles leaves `heldUntil` pending for ever, and the
      // reaction waiting on it keeps every op it collected alive with it.
      // Nothing is going to apply them now, so they go with the channel.
      holding = false;
      abandoned = true;
      held.length = 0;
      unsubscribeStore();
      unsubscribeSheets();
      await client.removeChannel(channel);
    },
  };
}
