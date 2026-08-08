/**
 * Organizations, and the people in them.
 *
 * A thin front for what the database already decides — who may make one, who
 * may hand one out, what a link is worth, and who is in it. None of that is
 * enforced here; the policies, `org_role()` and the two definer functions are
 * the enforcement, and this would be a second, weaker copy of them.
 *
 * The shape is `platform/sharing.js` on purpose. An organization is the same
 * bargain as a shared board — a link, a role, and a list of who took it up —
 * made once for everything inside instead of once per board, so the calls a
 * dialog makes are the calls it already made.
 *
 * Total, like the repository and like sharing: a call that cannot be made
 * comes back as null or false. The one exception is `list()`, below, and it is
 * an exception for the same reason the repository's is.
 */

const NOBODY = [];

/**
 * What a row means for the person asking, which is not stored anywhere.
 *
 * `role` is `org_role()`'s answer, so both owners are 'owner' — every caller
 * asking "may they do this to a board, or to the people" gets the right answer
 * from that one word, and none of them has to learn there are two kinds.
 *
 * `primary` is the one distinction that matters above this file: renaming,
 * deleting, handing the organization on and appointing the second owner belong
 * to `owner_id` alone. A second owner runs the organization; they do not own
 * the row.
 */
const standingIn = (org, me, memberships) => {
  if (org.owner_id === me) return { role: 'owner', primary: true };
  if (org.co_owner_id === me) return { role: 'owner', primary: false };
  return { role: memberships.get(org.id) ?? null, primary: false };
};

export function createOrganizations({ client, auth }) {
  const orgs = () => client.from('organizations');
  const members = () => client.from('organization_members');
  const invites = () => client.from('organization_invites');

  return {
    /**
     * Every organization the caller can see, with their role in it.
     *
     * Rejects when either query fails, where everything else here answers.
     * The board list partitions boards by which organizations you are in, so
     * an empty answer is not a harmless "no organizations" — it is a claim
     * that every board in a team is a personal one, made on the strength of a
     * request that never arrived. The repository's `list()` rejects for the
     * same reason and the callers say what actually happened.
     *
     * Two queries rather than a join: the caller's role lives in
     * `organization_members` for a member and in `organizations.owner_id` for
     * an owner, and an owner has no membership row at all. Asking for both and
     * merging is one round trip either way, and it is the same shape the
     * repository uses to work out `owned`.
     */
    async list() {
      const me = auth.current()?.id;
      if (!me) return [];

      const [visible, mine] = await Promise.all([
        orgs().select('id, name, owner_id, co_owner_id').order('name'),
        members().select('org_id, role').eq('user_id', me),
      ]);

      if (visible.error) {
        throw new Error(`could not list organizations: ${visible.error.message}`, {
          cause: visible.error,
        });
      }
      if (mine.error) {
        throw new Error(`could not read your memberships: ${mine.error.message}`, {
          cause: mine.error,
        });
      }

      const memberships = new Map(mine.data.map((row) => [row.org_id, row.role]));
      return visible.data.map((org) => ({
        id: org.id,
        name: org.name,
        ...standingIn(org, me, memberships),
      }));
    },

    /**
     * Make one. Null when it could not be made — which is the answer a guest
     * gets, because `organizations_insert` wants a real account and an
     * anonymous session is not one.
     *
     * The id is minted by the caller, in the shape boards use. Nothing is
     * navigated to before this resolves, so the id could have come from the
     * server; it comes from here so there is one id scheme in the app.
     */
    async create(id, name) {
      const ownerId = auth.current()?.id;
      if (!ownerId) return null;

      const { data, error } = await orgs()
        .insert({ id, owner_id: ownerId, name })
        .select('id, name')
        .maybeSingle();

      return error || !data ? null : { ...data, role: 'owner', primary: true };
    },

    /**
     * Appoint a second owner, or clear the appointment with `null`.
     *
     * A plain update, because `organizations_update` already limits this table
     * to the owner of the row — the second owner is not somebody a member can
     * appoint, and that is the policy's doing rather than this file's. What
     * the policy cannot see is *who* is being named, so
     * `check_organization_co_owner` refuses anyone who is not already a member
     * or is not a real account.
     *
     * That trigger raises rather than matching no rows, so a refusal arrives
     * as a PostgREST error and not as an empty result — false covers both,
     * like `move()` on the repository, and neither is worth telling apart from
     * a screen that only offers this for members it can see.
     */
    async setCoOwner(orgId, userId) {
      const { data, error } = await orgs()
        .update({ co_owner_id: userId })
        .eq('id', orgId)
        .select('id');

      return !error && data.length > 0;
    },

    /** False when nothing was renamed — it is not yours, or it is not there. */
    async rename(id, name) {
      const { data, error } = await orgs().update({ name }).eq('id', id).select('id');
      return !error && data.length > 0;
    },

    /**
     * Delete it. The boards inside are not deleted with it — `on delete set
     * null` hands each one back to whoever created it — so this ends the
     * sharing, not the work.
     *
     * The deleted rows are asked for rather than just the absence of an error,
     * for the reason `sharing.revoke` spells out: a delete the policies refuse
     * matches nothing and reports no error, so "no error" would have a member
     * being told they had deleted somebody else's organization.
     */
    async remove(id) {
      const { data, error } = await orgs().delete().eq('id', id).select('id');
      return !error && data.length > 0;
    },

    /** The organization's live link, or null if it has never been shared. */
    async invite(orgId) {
      const { data, error } = await invites()
        .select('token, role')
        .eq('org_id', orgId)
        .maybeSingle();

      return error || !data ? null : data;
    },

    /**
     * Create the link, or change what it grants — the same call for both,
     * because they are the same row. The token survives a role change, so a
     * link already pasted into a chat starts granting the new role rather than
     * quietly dying.
     */
    async share(orgId, role) {
      const ownerId = auth.current()?.id;
      if (!ownerId) return null;

      const { data, error } = await invites()
        .upsert({ org_id: orgId, role, created_by: ownerId }, { onConflict: 'org_id' })
        .select('token, role')
        .maybeSingle();

      return error || !data ? null : data;
    },

    /** Stop the link working. Everyone who has already joined stays. */
    async revoke(orgId) {
      const { data, error } = await invites().delete().eq('org_id', orgId).select('org_id');
      return !error && data.length > 0;
    },

    /**
     * Everyone in it, owner first. Only the owner gets an answer — the
     * function resolves addresses, so it is deliberately not something a
     * member can ask.
     */
    async people(orgId) {
      const { data, error } = await client.rpc('organization_people', { org: orgId });
      if (error || !data) return NOBODY;

      return data.map((row) => ({ id: row.user_id, email: row.email ?? null, role: row.role }));
    },

    /**
     * Take someone out. They lose every board the organization was giving
     * them; a board shared with them directly is not one of those, and stays.
     */
    async removeMember(orgId, userId) {
      const { data, error } = await members()
        .delete()
        .eq('org_id', orgId)
        .eq('user_id', userId)
        .select('org_id');

      return !error && data.length > 0;
    },

    /**
     * Hand the organization to one of its members.
     *
     * Everything this involves is the database's: only the owner may do it,
     * the recipient has to already be a member and a real account, the new
     * owner's membership row goes, and the outgoing owner keeps access as an
     * editor. All of it lands together or not at all, which is why it is one
     * call rather than this file doing the bookkeeping in three.
     *
     * False for every refusal, and they are not worth telling apart here: the
     * dialog only offers this for members it can see, so a false is either a
     * race — they left while the dialog was open — or a guest, and the message
     * is the same either way.
     */
    async transfer(orgId, userId) {
      const { data, error } = await client.rpc('transfer_organization', {
        org: orgId,
        to_user: userId,
      });
      return !error && data === true;
    },

    /**
     * Walk out. The same delete as `removeMember`, allowed by the same policy
     * — an owner may remove anyone, and anyone may remove themselves. Separate
     * because it is a separate thing to want, and because nobody should have
     * to look up their own id to do it.
     *
     * The owner cannot leave: they have no membership row, and an organization
     * with no owner is one nobody can rename, share or delete. Deleting it is
     * what the owner does instead.
     */
    async leave(orgId) {
      const me = auth.current()?.id;
      if (!me) return false;

      const { data, error } = await members()
        .delete()
        .eq('org_id', orgId)
        .eq('user_id', me)
        .select('org_id');

      return !error && data.length > 0;
    },

    /**
     * Join with a token. Answers the organization id, or null when the token
     * buys nothing — revoked, mistyped, or never real. The caller cannot tell
     * those apart, which is the point.
     */
    async redeem(token) {
      const { data, error } = await client.rpc('redeem_organization_invite', {
        invite_token: token,
      });
      return error ? null : (data ?? null);
    },
  };
}
